import type { Plugin } from "@opencode/plugin"
import {
  applyConsolidation,
  applyRerankOrderAnswer,
  consolidationEntries,
  extractJson,
  parseRerankAnswer,
  prune,
  type Entry,
  type RankedMemory,
} from "./core.ts"
import { resolveConfig, type MemoryConfig } from "./config.ts"
import { createStore, type StoreIO } from "./store.ts"
import {
  memoryClear,
  memoryForget,
  memoryInspect,
  memoryIrrelevant,
  memoryRead,
  memoryUpdate,
  memoryUseful,
  memoryWhy,
  memoryWrite,
  type ToolContext,
} from "./memory/api.ts"
import { buildMemoryBlock as buildSurfaceBlock } from "./memory/surface.ts"

type LogLevel = "debug" | "info" | "warn" | "error"
type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>
type SessionMessage = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number]
type ToolArgs = Record<string, unknown>
type JsonSchema = Record<string, unknown>

type MemoryTool = {
  name: string
  description: string
  input: JsonSchema
  execute: (args: ToolArgs, context: { sessionID: string }) => Promise<string>
}

type RerankCacheEntry = { at: number; order: string[]; abstain?: boolean }

const MEMORY_TOOL_NAMES = [
  "memory_read",
  "memory_write",
  "memory_update",
  "memory_why",
  "memory_inspect",
  "memory_useful",
  "memory_irrelevant",
  "memory_forget",
  "memory_clear",
] as const

function now() {
  return Date.now()
}

function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

function messageText(message: SessionMessage): string {
  if (message.type === "user" || message.type === "synthetic" || message.type === "system") return message.text
  if (message.type === "assistant") {
    return message.content
      .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
      .join("\n")
  }
  if (message.type === "compaction") return "summary" in message ? String(message.summary) : "[compaction]"
  return `[${message.type}]`
}

function messageTimestamp(message: SessionMessage): number {
  const time = message.time as { created?: number; completed?: number }
  return Math.max(time.created ?? 0, time.completed ?? 0)
}

class V2MemoryRuntime {
  private readonly queue: string[] = []
  private readonly debounces = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lastSurface = new Map<string, RankedMemory[]>()
  private readonly rerankCache = new Map<string, RerankCacheEntry>()
  private processing = false
  private pumpTask?: Promise<void>
  private readonly controller = new AbortController()
  private eventTask?: Promise<void>
  private sweepStartTimer?: ReturnType<typeof setTimeout>
  private sweepRepeatTimer?: ReturnType<typeof setInterval>
  private readonly registrations: Array<{ dispose: () => Promise<void> }> = []

  private readonly config: MemoryConfig
  private readonly store: StoreIO

  constructor(private readonly ctx: Plugin.Context) {
    this.config = resolveConfig(ctx.options)
    this.store = createStore(this.config.dir)
  }

  private log(level: LogLevel, message: string, extra?: Record<string, unknown>) {
    if (level === "debug" && !this.config.debug) return
    const details = extra ? ` ${JSON.stringify(extra)}` : ""
    const line = `[opencode-memory] ${message}${details}`
    if (level === "error") console.error(line)
    else if (level === "warn") console.warn(line)
    else if (level === "debug") console.debug(line)
    else console.info(line)
  }

  async setup(): Promise<() => Promise<void>> {
    if (this.config.off) {
      this.log("info", "memory disabled via configuration")
      return async () => {}
    }

    const loaded = await this.store.getStore()
    this.log("info", `memory V2 plugin loaded (${loaded.entries.length} entries, summary ${loaded.summary.length} chars)`)

    try {
      await this.registerTools()
      const registered = new Set((await this.ctx.tool.list()).map((tool) => tool.id))
      const missing = MEMORY_TOOL_NAMES.filter((name) => !registered.has(name))
      if (missing.length > 0) throw new Error(`memory V2 tool registration incomplete: ${missing.join(", ")}`)
      this.log("info", `memory V2 tools registered (${MEMORY_TOOL_NAMES.length})`)
      if (this.config.surface) {
        this.registrations.push(await this.ctx.session.hook("context", async (event) => {
          try {
            const block = await this.buildMemoryBlock(String(event.sessionID))
            if (block) event.system.push({ type: "text", text: block })
          } catch (error) {
            this.log("debug", "context hook failed", { error: String(error) })
          }
        }))
      }

      if (this.config.dream) {
        this.eventTask = this.consumeEvents()
        this.sweepStartTimer = setTimeout(() => void this.sweep(), this.config.sweepStartMs)
        this.sweepRepeatTimer = setInterval(() => void this.sweep(), this.config.sweepIntervalMs)
      }

      return () => this.dispose()
    } catch (error) {
      await this.dispose()
      throw error
    }
  }

  private async dispose() {
    this.controller.abort()
    if (this.sweepStartTimer) clearTimeout(this.sweepStartTimer)
    if (this.sweepRepeatTimer) clearInterval(this.sweepRepeatTimer)
    for (const timer of this.debounces.values()) clearTimeout(timer)
    this.debounces.clear()
    this.queue.length = 0
    await this.eventTask?.catch(() => {})
    await this.pumpTask?.catch(() => {})
    for (const registration of this.registrations.splice(0).reverse()) {
      await registration.dispose().catch((error) => {
        this.log("warn", "registration cleanup failed", { error: String(error) })
      })
    }
  }

  private async consumeEvents() {
    try {
      for await (const event of this.ctx.event.subscribe({ signal: this.controller.signal })) {
        // V2 emits durable execution events (without a location); session.idle
        // remains a compatibility event and is not emitted by the native loop.
        if (event.type !== "session.idle" &&
            event.type !== "session.execution.succeeded" &&
            event.type !== "session.execution.failed" &&
            event.type !== "session.execution.interrupted") continue
        const sessionID = String(event.data.sessionID)
        const directory = event.location?.directory ?? (await this.sessionInfo(sessionID))?.location.directory
        if (directory !== this.ctx.location.directory || this.controller.signal.aborted) continue
        this.log("debug", "session completed -> schedule", { sessionID, event: event.type })
        this.scheduleConsolidation(sessionID)
      }
    } catch (error) {
      if (!this.controller.signal.aborted) this.log("warn", "event subscription failed", { error: String(error) })
    }
  }

  private scheduleConsolidation(sessionID: string) {
    const existing = this.debounces.get(sessionID)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.debounces.delete(sessionID)
      if (!this.queue.includes(sessionID)) this.queue.push(sessionID)
      void this.startPump()
    }, this.config.delayMs)
    this.debounces.set(sessionID, timer)
  }

  private enqueue(sessionID: string) {
    if (!this.queue.includes(sessionID)) this.queue.push(sessionID)
    void this.startPump()
  }

  private startPump() {
    if (!this.pumpTask) {
      this.pumpTask = this.pump().finally(() => {
        this.pumpTask = undefined
        if (this.queue.length > 0 && !this.controller.signal.aborted) void this.startPump()
      })
    }
    return this.pumpTask
  }

  // The public V2 plugin session domain intentionally does not expose list().
  // Recovery therefore uses the durable inProgress journal: every DREAM that
  // began but did not commit leaves its session ID here. No helper-session GC
  // is needed because generate.text creates no sessions.
  private async sweep() {
    if (this.controller.signal.aborted) return
    try {
      const state = await this.store.getState()
      const candidates = Object.entries(state.inProgress ?? {})
        .filter(([, marker]) => now() - marker.startedAt >= this.config.inProgressTimeoutMs)
        .filter(([sessionID, marker]) => (state.sessions[sessionID] ?? 0) < marker.targetTs)
        .sort(([, left], [, right]) => right.targetTs - left.targetTs)
        .slice(0, this.config.sweepBatch)
      for (const [sessionID] of candidates) this.enqueue(sessionID)
      if (candidates.length > 0) this.log("debug", "recovery sweep queued", { count: candidates.length })
    } catch (error) {
      this.log("warn", "recovery sweep failed", { error: String(error) })
    }
  }

  private async pump() {
    if (this.processing) return
    this.processing = true
    try {
      while (this.queue.length > 0) {
        const sessionID = this.queue.shift()!
        try {
          await this.consolidate(sessionID)
        } catch (error) {
          this.log("warn", "consolidation failed", { sessionID, error: String(error) })
        }
      }
    } finally {
      this.processing = false
    }
  }

  private async sessionInfo(sessionID: string): Promise<SessionInfo | undefined> {
    try {
      return await this.ctx.session.get({ sessionID })
    } catch (error) {
      this.log("debug", "session.get failed", { sessionID, error: String(error) })
      return undefined
    }
  }

  private async directoryFor(sessionID: string): Promise<string | undefined> {
    const session = await this.sessionInfo(sessionID)
    return session?.location.directory ?? this.ctx.location.directory
  }

  // V2's top-level generate API is intentionally used for all internal model
  // work. Its documented contract creates no session, invokes no tools and
  // writes no history, so DREAM/rerank cannot gain filesystem or network
  // capabilities and leave no helper sessions to delete.
  private async generate(prompt: string, session?: SessionInfo, timeoutMs = 120_000): Promise<string> {
    const request = session?.model ? { prompt, model: session.model } : { prompt }
    const controller = new AbortController()
    const dispose = () => controller.abort()
    if (this.controller.signal.aborted) controller.abort()
    else this.controller.signal.addEventListener("abort", dispose, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return (await this.ctx.generate.text(request, { signal: controller.signal })).text
    } catch (error) {
      if (controller.signal.aborted) return ""
      throw error
    } finally {
      clearTimeout(timer)
      this.controller.signal.removeEventListener("abort", dispose)
    }
  }

  private async dedupCheck(
    session: SessionInfo,
    entries: Entry[],
    candidates: { text: string }[],
  ): Promise<Set<number>> {
    const skip = new Set<number>()
    if (candidates.length === 0 || entries.length === 0) return skip
    const entryLines = entries.map((entry) => `${entry.id} | ${entry.source} | ${entry.category} | ${entry.text}`).join("\n")
    const candidateLines = candidates.map((candidate, index) => `[${index}] ${candidate.text}`).join("\n")
    const prompt = `You are a deduplication checker for a memory store.

EXISTING MEMORY ENTRIES:
${entryLines}

CANDIDATE NEW FACTS:
${candidateLines}

For each candidate that is semantically equivalent to an existing entry (same meaning, ANY language, paraphrase), reply with that candidate's index in "duplicates". An entry with source=explicit always wins over a candidate. Candidates that describe something NEW are not duplicates.

REPLY WITH STRICT JSON ONLY:
{"duplicates":[0,2]}`
    try {
      const answer = await this.generate(prompt, session, 90_000)
      const parsed = extractJson(answer)
      const duplicates = Array.isArray(parsed?.duplicates) ? parsed.duplicates : []
      for (const duplicate of duplicates) {
        const index = Number(duplicate)
        if (Number.isInteger(index) && index >= 0 && index < candidates.length) skip.add(index)
      }
    } catch (error) {
      this.log("debug", "dedup check failed", { error: String(error) })
    }
    return skip
  }

  private async consolidate(sessionID: string) {
    const session = await this.sessionInfo(sessionID)
    if (!session) return
    const messages = await this.ctx.session.context({ sessionID })
    const lastTs = messages.reduce((max, message) => Math.max(max, messageTimestamp(message)), 0)
    const state = await this.store.getState()
    if (lastTs <= (state.sessions[sessionID] ?? 0)) return

    const inProgress = state.inProgress?.[sessionID]
    if (inProgress && now() - inProgress.startedAt < this.config.inProgressTimeoutMs) return

    const transcript = messages
      .map((message) => `${message.type}: ${messageText(message)}`)
      .join("\n\n")
      .slice(-this.config.transcriptChars)
    const messageIDs = messages.map((message) => String(message.id)).slice(-20)
    const directory = session.location.directory
    const store = await this.store.getStore()
    const visible = consolidationEntries(store, directory)
    const entriesBlock =
      visible.length === 0
        ? "(none)"
        : visible
            .map((entry) => `- [${entry.id}] (${entry.scope}/${entry.category}, w=${entry.weight.toFixed(1)}, source=${entry.source}) ${entry.text}`)
            .join("\n")

    const prompt = `You are the memory consolidation module of OpenCode. You silently read a finished conversation and update the long-term memory store.

TASKS:
1. new: facts about the user (preferences, constraints, personal details, decisions, project state) that are NOT already in memory. Be concise, third person ("The user...").
2. update: only entries whose fact genuinely CHANGED in the conversation. Never use update for mere reformulation.
3. delete: ids of entries that are outdated or contradicted.
4. conflicts: if the conversation STRONGLY contradicts an entry tagged source=explicit, report it with the entry id and a short evidence quote. Never modify or delete that entry.
${this.config.summary ? "5. summary: 2-5 sentence summary of who the user is and how they like to work. NEVER include sensitive data in the summary." : ""}

SOURCE HIERARCHY:
- Entries tagged source=explicit were stated directly by the user and ALWAYS win over source=dreamed entries.
- NEVER add a new fact semantically equivalent to an explicit entry, in any language or wording.
- A fact about the same user attribute/topic is a duplicate unless it describes a different attribute.
- NEVER delete or update explicit entries; use conflicts instead.
- If a new fact duplicates a dreamed entry, delete the old dreamed id and add the better formulation.
- If a dreamed entry contradicts an explicit one, delete the dreamed entry.

RULES:
- Do NOT invent facts; extract only what the conversation actually says.
- Skip trivial small talk and one-off actions.
- If nothing is new, return empty arrays${this.config.summary ? ' but still a summary (or "" if unchanged)' : ''}.
- Write facts in the same language the user used.
- Compare meaning across languages before adding a fact.
- Use scope "project" only for facts tied to this codebase; otherwise use "global".
- Optionally attach confidence (0-1) to each new fact.

RESPOND WITH STRICT JSON ONLY:
{"new":[{"text":"...","category":"user|project|workflow|preferences|decisions|status|environment|other","scope":"global|project","confidence":0.9}],"update":[{"id":"...","text":"..."}],"delete":["..."],"conflicts":[{"id":"...","evidence":"..."}]${this.config.summary ? ',"summary":"..."' : ''}}

CURRENT MEMORY ENTRIES:
${entriesBlock}

TRANSCRIPT (session title: ${session.title ?? ""}):
${transcript}`

    state.inProgress![sessionID] = { targetTs: lastTs, startedAt: now() }
    await this.store.saveState(state)
    let completed = false
    try {
      const answer = await this.generate(prompt, session)
      if (!answer) throw new Error("consolidation timed out")
      const parsed = extractJson(answer)
      if (!parsed || !Array.isArray(parsed.new)) throw new Error("consolidation returned no usable JSON")
      if (!this.config.summary) delete parsed.summary

      if (parsed.new.length > 0 && visible.length > 0) {
        const skip = await this.dedupCheck(session, visible, parsed.new)
        parsed.new = parsed.new.filter((_: unknown, index: number) => !skip.has(index))
      }

      await this.store.withLock(async () => {
        const fresh = await this.store.getStore()
        applyConsolidation(fresh, parsed, directory, now(), this.log.bind(this), {
          sessionID,
          messageIDs,
        })
        prune(fresh, now(), this.config.maxEntries)
        await this.store.writeStore(fresh)
      })
      state.sessions[sessionID] = lastTs
      completed = true
      this.log("info", "consolidated session", { sessionID, newFacts: parsed.new.length })
    } finally {
      if (completed) delete state.inProgress![sessionID]
      else state.inProgress![sessionID] = { targetTs: lastTs, startedAt: now() }
      await this.store.saveState(state).catch(() => {})
    }
  }

  private async sessionTopicQuery(sessionID: string): Promise<string> {
    try {
      const messages = await this.ctx.session.context({ sessionID })
      const lastUser = [...messages].reverse().find((message) => message.type === "user")
      return lastUser?.type === "user" ? lastUser.text : ""
    } catch {
      return ""
    }
  }

  private async rerank(
    session: SessionInfo,
    sessionID: string,
    query: string,
    candidates: RankedMemory[],
  ): Promise<RankedMemory[]> {
    if (candidates.length <= 1) return candidates
    const key = query.trim().toLowerCase() || " "
    const cached = this.rerankCache.get(key)
    if (cached && now() - cached.at < this.config.rerankCacheMs) {
      if (cached.abstain) return []
      const positions = new Map(cached.order.map((id, index) => [id, index]))
      return [...candidates].sort((a, b) => {
        const left = positions.get(a.entry.id)
        const right = positions.get(b.entry.id)
        if (left === undefined && right === undefined) return b.base - a.base
        if (left === undefined) return 1
        if (right === undefined) return -1
        return left - right
      })
    }

    const visible = candidates.filter((candidate) => candidate.entry.sensitivity !== "local-only")
    if (visible.length <= 1) return candidates
    const lines = visible.map((candidate, index) => `[${index}] ${candidate.entry.text}`).join("\n")
    const prompt = `You are a memory retrieval judge. Decide which candidate memories actually help answer the user's question, then rank ONLY those, most relevant first. Use semantics, not just keywords. Exclude adjacent topics that do not answer the question.

REPLY WITH STRICT JSON ONLY:
- {"order":[i,j,...]} for relevant candidates, best first
- {"order":[]} if NO candidate answers the question

QUESTION: ${query || "(empty)"}

CANDIDATES:
${lines}`
    try {
      const answer = await this.generate(prompt, session, this.config.rerankTimeoutMs)
      if (!answer) return candidates
      const outcome = parseRerankAnswer(answer, visible.length)
      if (outcome.kind === "abstain") {
        this.rerankCache.set(key, { at: now(), order: [], abstain: true })
        return []
      }
      if (outcome.kind === "invalid") return candidates
      const ordered = applyRerankOrderAnswer(visible, outcome)
      const order = ordered.map((candidate) => candidate.entry.id)
      this.rerankCache.set(key, { at: now(), order })
      const selected = new Set(order)
      return [...ordered, ...candidates.filter((candidate) => !selected.has(candidate.entry.id))]
    } catch (error) {
      this.log("debug", "rerank failed; lexical fallback", { sessionID, error: String(error) })
      return candidates
    }
  }

  private async buildMemoryBlock(sessionID: string): Promise<string | undefined> {
    const session = await this.sessionInfo(sessionID)
    if (!session) return undefined
    const query = await this.sessionTopicQuery(sessionID)
    return buildSurfaceBlock({
      io: this.store,
      config: this.config,
      sessionID,
      directory: session.location.directory,
      query,
      rerank: this.config.rerank ? (candidates) => this.rerank(session, sessionID, query, candidates) : undefined,
      lastSurface: this.lastSurface,
    })
  }

  private async registerTools() {
    const tools = this.tools()
    this.registrations.push(await this.ctx.tool.transform((editor) => {
      for (const definition of tools) {
        editor.add({
          name: definition.name,
          description: definition.description,
          input: definition.input,
          execute: async (input, context) => ({
            content: await definition.execute(input as ToolArgs, { sessionID: String(context.sessionID) }),
          }),
        })
      }
    }))
  }

  private toolCtx(directory: string | undefined, sessionID: string): ToolContext {
    return { directory, sessionID, lastSurface: this.lastSurface }
  }

  private tools(): MemoryTool[] {
    const categoryDescription = "Optional category: user, project, workflow, preferences, decisions, status, environment, other"
    return [
      {
        name: "memory_read",
        description: "Read facts stored in long-term memory. Returns global facts plus the current project's facts; other projects and local-only entries are never visible.",
        input: objectSchema({
          query: { type: "string", description: "Optional text to filter facts by topic" },
          category: { type: "string", description: categoryDescription },
          scope: { type: "string", enum: ["global", "project"], description: "Filter by scope" },
        }),
        execute: async (args, context) =>
          memoryRead(this.store, this.config, this.toolCtx(await this.directoryFor(context.sessionID), context.sessionID), args as any),
      },
      {
        name: "memory_write",
        description: "Store a durable fact about the user or project. Distinct facts are kept separately; repeating the same text refreshes it and resolves any conflict. Use memory_update to correct an existing fact.",
        input: objectSchema({
          fact: { type: "string", description: "The fact to remember, written in third person" },
          category: { type: "string", description: categoryDescription },
          scope: { type: "string", enum: ["global", "project"], description: "Global applies everywhere; project only in this codebase" },
          tier: { type: "string", enum: ["core", "archival", "temporary"], description: "Memory lifecycle tier" },
          ttlHours: { type: "number", description: "Lifetime in hours for a temporary memory (default 24)" },
          pinned: { type: "boolean", description: "Pinned memories never decay" },
          sensitivity: { type: "string", enum: ["normal", "private", "local-only"], description: "local-only is stored on disk and never exposed to a model or tool" },
        }, ["fact"]),
        execute: async (args, context) =>
          memoryWrite(this.store, this.config, this.toolCtx(await this.directoryFor(context.sessionID), context.sessionID), args as any),
      },
      {
        name: "memory_update",
        description: "Correct an existing visible memory by id or matching text. Resolves a conflicted entry.",
        input: objectSchema({
          id: { type: "string", description: "Entry id from memory_read" },
          match: { type: "string", description: "Text of the entry to update" },
          fact: { type: "string", description: "The corrected fact" },
        }, ["fact"]),
        execute: async (args, context) =>
          memoryUpdate(this.store, this.config, this.toolCtx(await this.directoryFor(context.sessionID), context.sessionID), args as any),
      },
      {
        name: "memory_why",
        description: "Explain a memory's provenance, lifecycle status and current score breakdown.",
        input: objectSchema({ id: { type: "string", description: "Entry id from memory_read" } }, ["id"]),
        execute: async (args, context) =>
          memoryWhy(this.store, this.config, this.toolCtx(await this.directoryFor(context.sessionID), context.sessionID), args as any),
      },
      {
        name: "memory_inspect",
        description: "Inspect visible memory statistics, recent facts, conflicts, project facts, or the current session's surfacing breakdown.",
        input: objectSchema({
          show: { type: "string", enum: ["stats", "recent", "conflicts", "project", "surfaced"], description: "View to show (default stats)" },
          limit: { type: "number", description: "Maximum entries in list views (default 10)" },
        }),
        execute: async (args, context) =>
          memoryInspect(this.store, this.config, this.toolCtx(await this.directoryFor(context.sessionID), context.sessionID), args as any),
      },
      {
        name: "memory_useful",
        description: "Mark a surfaced memory useful, improving ranking and confirming that it is still current.",
        input: objectSchema({ id: { type: "string", description: "Entry id from memory_read" } }, ["id"]),
        execute: async (args, context) =>
          memoryUseful(this.store, this.config, this.toolCtx(await this.directoryFor(context.sessionID), context.sessionID), args as any),
      },
      {
        name: "memory_irrelevant",
        description: "Mark a surfaced memory irrelevant to the current task, lowering future ranking without changing factual recency.",
        input: objectSchema({ id: { type: "string", description: "Entry id from memory_read" } }, ["id"]),
        execute: async (args, context) =>
          memoryIrrelevant(this.store, this.config, this.toolCtx(await this.directoryFor(context.sessionID), context.sessionID), args as any),
      },
      {
        name: "memory_forget",
        description: "Remove a visible memory by id or matching text.",
        input: objectSchema({
          id: { type: "string", description: "Entry id from memory_read" },
          match: { type: "string", description: "Text of the entry to delete" },
        }),
        execute: async (args, context) =>
          memoryForget(this.store, this.config, this.toolCtx(await this.directoryFor(context.sessionID), context.sessionID), args as any),
      },
      {
        name: "memory_clear",
        description: "Delete stored memory. summaryOnly=true clears just the shared summary and retains all facts; omit scope in that case. Otherwise project scope clears this project, global clears shared facts, and no arguments wipe everything including local-only entries.",
        input: objectSchema({
          scope: { type: "string", enum: ["global", "project"], description: "Only clear this scope; default clears everything" },
          summaryOnly: { type: "boolean", description: "Clear only the summary, retaining all facts; cannot be combined with scope" },
        }),
        execute: async (args, context) =>
          memoryClear(this.store, this.config, this.toolCtx(await this.directoryFor(context.sessionID), context.sessionID), args as any),
      },
    ]
  }
}

export async function setupV2(ctx: Plugin.Context) {
  const runtime = new V2MemoryRuntime(ctx)
  return runtime.setup()
}
