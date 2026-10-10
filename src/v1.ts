import { tool } from "@opencode-ai/plugin"
import type { RankedMemory } from "./core.ts"
import { CONSOLIDATION_TITLE, RERANK_TITLE, SESSION_TOOLS_DENY_ALL, resolveConfig, type MemoryConfig } from "./config.ts"
import { rerankCandidates } from "./rerank.ts"
import { createStore } from "./store.ts"
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
import { runConsolidation, runDreamOrganization } from "./dream/dream.ts"
import { createOpenAICompatibleModel, dreamProviderConfig, type DreamModel } from "./dream/provider.ts"
import { vaultPaths } from "./vault/paths.ts"

// V1 invokes server() once per plugin location. Keep all runtime state and
// storage bindings inside that instance so project options cannot bleed into
// another location served by the same process.
function createLegacyPlugin(CONFIG: MemoryConfig) {
const io = createStore(CONFIG.dir)
const { getState, getStore } = io
const rerankCache = new Map<string, { at: number; order: string[]; abstain?: boolean }>()

// ---------------------------------------------------------------------------
// opencode long-term memory plugin (Dreaming-style)
//
// WRITE  — memory_* tools: the agent stores explicit facts at call time.
//          The tool bodies live in src/memory/api.ts (shared with V2); this
//          adapter only defines the schemas and delegates.
// DREAM  — when a session goes idle, a HEADLESS child session (parentID set,
//          therefore invisible in the session picker) is used to synthesize
//          new facts / update the summary; it is deleted right after. Child
//          sessions run with SESSION_TOOLS_DENY_ALL: no tool of any kind is
//          available to them (see src/config.ts for the verified contract).
// SURFACE— a <memory> block (summary + top facts) is injected into every
//          prompt via the system.transform hook. The selection pipeline
//          lives in src/memory/surface.ts (shared with V2).
//
// Scope & privacy policy lives in core.ts (projectVisible / readableEntries /
// consolidationEntries / readQuery): every tool and every prompt builder goes
// through it. Project-scoped entries never cross project directories; local-
// only entries never reach any model-visible path.
// ---------------------------------------------------------------------------

function now() {
  return Date.now()
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

type LogLevel = "debug" | "info" | "warn" | "error"

function log(
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
): void {
  if (level === "debug" && !CONFIG.debug) return

  const client = clientRef
  if (!client?.app?.log) return

  // Non usare await: il logging non deve mai bloccare il plugin.
  void client.app
    .log({
      body: {
        service: "opencode-memory",
        level,
        message,
        extra,
      },
    })
    .catch(() => {})
}

// ---------------------------------------------------------------------------
// Consolidation (headless: child session, invisible in the session picker)
// ---------------------------------------------------------------------------

let consolidationIDs = new Set<string>()
let queue: string[] = []
let processing = false
let pumpTask: Promise<void> | undefined
let clientRef: any = undefined
const debounces = new Map<string, ReturnType<typeof setTimeout>>()

function enqueue(sessionID: string) {
  if (queue.includes(sessionID)) return
  queue.push(sessionID)
  void startPump()
}

function startPump(): Promise<void> {
  if (!pumpTask) pumpTask = pump().finally(() => { pumpTask = undefined })
  return pumpTask
}

async function waitForReply(
  client: any,
  sessionID: string,
  timeoutMs: number,
  opts: { after?: number } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await client.session.messages({ path: { id: sessionID }, query: { limit: 20 } })
    const msgs: any[] = res?.data ?? []
    let last = ""
    for (const m of msgs) {
      if (m?.info?.role !== "assistant") continue
      const completed = m?.info?.time?.completed ?? m?.info?.time?.created ?? 0
      if (opts.after !== undefined && completed < opts.after) continue
      const texts = (m?.parts ?? []).filter((p: any) => p?.type === "text").map((p: any) => p.text)
      if (texts.length > 0) last = texts[texts.length - 1]
    }
    if (last.trim()) return last
    await sleep(1500)
  }
  return ""
}

// The Dream model: each adapter wraps its own runtime behind the injectable
// DreamModel interface. V1 drives a HEADLESS child session (parentID set —
// invisible in the session picker): create → promptAsync with
// SESSION_TOOLS_DENY_ALL (zero tools for untrusted text) → waitForReply.
// The SAME child serves every complete() of one consolidation (consolidation
// prompt + dedup question, like the historical flow); the adapter deletes it
// only AFTER runConsolidation has settled, so a completed child delete means
// the store is already committed.
function consolidationModel(parentID: string): { model: DreamModel; dispose: () => Promise<void> } {
  let childID: string | undefined
  return {
    model: {
      async complete({ prompt, timeoutMs }) {
        if (!childID) {
          const created = await clientRef.session.create({
            body: { title: CONSOLIDATION_TITLE, parentID },
          })
          childID = created?.data?.id
          if (!childID) throw new Error("failed to create consolidation session")
          consolidationIDs.add(childID)
        }
        await clientRef.session.promptAsync({
          path: { id: childID },
          body: { parts: [{ type: "text", text: prompt }], tools: SESSION_TOOLS_DENY_ALL },
        })
        const answer = await waitForReply(clientRef, childID, timeoutMs ?? 120_000, { after: Date.now() })
        if (!answer) throw new Error("consolidation timed out")
        return answer
      },
    },
    dispose: async () => {
      if (!childID) return
      const id = childID
      childID = undefined
      consolidationIDs.delete(id)
      await clientRef.session.delete({ path: { id } }).catch(() => {})
    },
  }
}

// Self-contained helper model for the organization's enrichment: one throwaway
// child per complete(), deleted right after the answer (nothing pins the
// timing of helper children relative to a commit).
function helperSessionModel(parentID: string): DreamModel {
  return {
    async complete({ prompt, timeoutMs }) {
      const created = await clientRef.session.create({
        body: { title: CONSOLIDATION_TITLE, parentID },
      })
      const childID = created?.data?.id
      if (!childID) throw new Error("failed to create consolidation session")
      consolidationIDs.add(childID)
      try {
        await clientRef.session.promptAsync({
          path: { id: childID },
          body: { parts: [{ type: "text", text: prompt }], tools: SESSION_TOOLS_DENY_ALL },
        })
        const answer = await waitForReply(clientRef, childID, timeoutMs ?? 120_000, { after: Date.now() })
        if (!answer) throw new Error("consolidation timed out")
        return answer
      } finally {
        consolidationIDs.delete(childID)
        await clientRef.session.delete({ path: { id: childID } }).catch(() => {})
      }
    },
  }
}

// Provider dispatch (T9 contract): "openai-compatible" calls the configured
// chat/completions endpoint directly; "opencode" keeps the adapter's native
// path. A misconfigured provider yields no model — the caller skips the round
// and memory stays fully usable.
function buildDreamModel(parentID?: string): DreamModel | undefined {
  if (CONFIG.dreamProvider === "openai-compatible") {
    try {
      const provider = dreamProviderConfig(CONFIG)
      if (provider.kind !== "openai-compatible") return undefined
      return createOpenAICompatibleModel(provider)
    } catch (err) {
      log("warn", "dream model unavailable", { error: String(err) })
      return undefined
    }
  }
  return parentID ? helperSessionModel(parentID) : undefined
}

// Organization phase (duplicates, knowledge sync, enrichment, staleness
// proposals) — fired after a committed consolidation and after a sweep. All
// failures are logged and never break the consolidation round.
async function dreamOrganization(parentID?: string): Promise<void> {
  try {
    const model = buildDreamModel(parentID)
    const report = await runDreamOrganization(io, CONFIG, vaultPaths(CONFIG.dir), model, log)
    log("info", "dream organization", {
      duplicatesArchived: report.duplicatesArchived,
      staleProposed: report.staleProposed,
      knowledgeUpdated: report.knowledgeUpdated.length,
      enriched: report.enriched,
    })
  } catch (err) {
    log("warn", "dream organization failed", { error: String(err) })
  }
}

async function pump() {
  if (processing) return
  processing = true
  try {
    while (queue.length) {
      const id = queue.shift()!
      try {
        await consolidate(id)
      } catch (err) {
        log("warn", "consolidation failed", { sessionID: id, error: String(err) })
      }
    }
  } finally {
    processing = false
  }
}

function scheduleConsolidation(sessionID: string) {
  if (CONFIG.off || !CONFIG.dream) return
  if (consolidationIDs.has(sessionID)) return
  const existing = debounces.get(sessionID)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    debounces.delete(sessionID)
    enqueue(sessionID)
  }, CONFIG.delayMs)
  debounces.set(sessionID, timer)
}

async function sessionInfo(client: any, sessionID: string) {
  const res = await client.session.get({ path: { id: sessionID } })
  log("debug", "session.get response", { sessionID, hasData: !!res?.data, hasError: !!res?.error, error: res?.error ?? undefined })
  return res?.data
}

async function consolidate(sessionID: string): Promise<void> {
  log("debug", "consolidate start", { sessionID })
  const session = await sessionInfo(clientRef, sessionID)
  log("debug", "sessionInfo result", { sessionID, ok: !!session, id: session?.id, title: session?.title, directory: session?.directory })
  if (!session) {
    log("debug", "consolidation skipped: session not found", { sessionID })
    return
  }

  const messagesRes = await clientRef.session.messages({ path: { id: sessionID }, query: { limit: 120 } })
  log("debug", "messages loaded", { sessionID, count: messagesRes?.data?.length ?? -1 })
  const messages: any[] = messagesRes?.data ?? []
  // If the last message is an assistant message still streaming (no
  // time.completed yet), the conversation is not finished: consolidating now
  // would capture a partial transcript and, once the stream completes, the
  // guard would pass again (created < completed), causing a SECOND full
  // consolidation. Skip and let the next sweep pick it up.
  const lastMsg = messages[messages.length - 1]
  if (lastMsg?.info?.role === "assistant" && !lastMsg?.info?.time?.completed) {
    log("debug", "consolidation skipped: response still streaming", { sessionID })
    return
  }
  const lastTs = messages.reduce(
    (max: number, m: any) => Math.max(max, m?.info?.time?.completed ?? m?.info?.time?.created ?? 0),
    0,
  )
  const transcript = messages
    .map((m: any) => {
      const role = m?.info?.role ?? "unknown"
      const text = (m?.parts ?? [])
        .map((p: any) => (p?.type === "text" ? p.text : `[${p?.type ?? "part"}]`))
        .join("\n")
      return `${role}: ${text}`
    })
    .join("\n\n")
    .slice(-CONFIG.transcriptChars)
  const messageIDs = messages
    .filter((m: any) => m?.id || m?.info?.id)
    .map((m: any) => String(m?.id ?? m?.info?.id))
    .slice(-20)

  // Provider dispatch (T9): with "openai-compatible" the consolidation calls
  // the configured chat/completions endpoint directly — no child session to
  // create or delete. The default "opencode" path keeps the headless child
  // model. A misconfigured provider yields no model — the round is skipped
  // and memory stays fully usable (same contract as dreamOrganization).
  const child = CONFIG.dreamProvider === "openai-compatible" ? undefined : consolidationModel(sessionID)
  try {
    const model = child ? child.model : buildDreamModel(sessionID)
    if (!model) {
      log("warn", "consolidation skipped: dream model unavailable", { sessionID })
      return
    }
    // The shared engine owns the two-phase commit (guards, prompt, semantic
    // dedup, locked apply+prune+writeStore, commit), the secret guard and the
    // dedup fallbacks. A failed round leaves memory fully usable.
    const outcome = await runConsolidation(
      io,
      CONFIG,
      model,
      { id: sessionID, directory: session.directory, title: session.title },
      { transcript, messageIDs, lastTs },
      log,
    )
    if (outcome === "committed") void dreamOrganization(sessionID)
  } finally {
    // The helper child is deleted only after the consolidation settled, so
    // its deletion implies the store (and the session marker) are committed.
    // (Only the "opencode" path has a child session to dispose.)
    await child?.dispose()
  }
}

// ---------------------------------------------------------------------------
// Garbage collection of orphaned helper sessions: if the process dies after
// creating a child but before the finally cleanup, the child stays (invisible
// in the picker, but present). Both consolidation AND rerank children are
// covered. A child is removed only when BOTH conditions hold: it is older
// than gcChildAgeMs AND shows no recent activity (updated < cutoff) — a slow
// but live helper must never be killed. inProgress markers no longer carry a
// childID (nothing writes it today), so children are protected by this
// age+inactivity heuristic only.
async function gcConsolidationChildren() {
  try {
    const state = await getState()
    const activeChildren = new Set<string>()
    const cutoff = now() - CONFIG.gcChildAgeMs
    for (const ip of Object.values(state.inProgress ?? {})) {
      if (ip.childID && now() - ip.startedAt < CONFIG.inProgressTimeoutMs) activeChildren.add(ip.childID)
    }
    const res = await clientRef.session.list({ query: {} })
    const sessions: any[] = res?.data ?? []
    let removed = 0
    for (const s of sessions) {
      if (consolidationIDs.has(s.id)) continue
      if (activeChildren.has(s.id)) continue
      if (s?.title !== CONSOLIDATION_TITLE && s?.title !== RERANK_TITLE) continue
      const created = s?.time?.created ?? 0
      const updated = s?.time?.updated ?? 0
      if (created > 0 && created < cutoff && updated < cutoff) {
        await clientRef.session.delete({ path: { id: s.id } }).catch(() => {})
        removed++
      }
    }
    if (removed > 0) log("info", "gc removed orphan helper sessions", { removed })
  } catch (err) {
    log("warn", "gc failed", { error: String(err) })
  }
}

async function sweep() {
  if (CONFIG.off || !CONFIG.dream) return
  await gcConsolidationChildren()
  try {
    const res = await clientRef.session.list({ query: {} })
    const sessions: any[] = res?.data ?? []
    const state = await getState()
    const candidates: any[] = []
    for (const s of sessions) {
      if (consolidationIDs.has(s.id)) continue
      // Helper children (consolidation + rerank) are never consolidated
      // themselves (they are handled by the GC).
      if (s?.title === CONSOLIDATION_TITLE || s?.title === RERANK_TITLE) continue
      const lastTs = state.sessions[s.id] ?? 0
      if (lastTs !== 0) continue
      // A session with a valid (unexpired) inProgress marker is being
      // consolidated right now (possibly by another process): do not re-queue.
      const ip = state.inProgress?.[s.id]
      if (ip && now() - ip.startedAt < CONFIG.inProgressTimeoutMs) continue
      candidates.push(s)
    }
    candidates.sort((a, b) => (b?.time?.updated ?? 0) - (a?.time?.updated ?? 0))
    for (const s of candidates.slice(0, CONFIG.sweepBatch)) {
      enqueue(s.id)
    }
    if (candidates.length > 0) {
      log("debug", "sweep queued", { count: Math.min(candidates.length, CONFIG.sweepBatch) })
      // Organization runs after the queued consolidations settled (never
      // concurrently with them) and after the sweep itself. Without a parent
      // session the opencode provider cannot enrich (the openai-compatible
      // provider still can).
      try {
        await startPump()
      } catch (err) {
        log("warn", "sweep pump failed", { error: String(err) })
      }
      void dreamOrganization()
    }
  } catch (err) {
    log("warn", "sweep failed", { error: String(err) })
  }
}

// ---------------------------------------------------------------------------
// Memory block injection (proactive surfacing) — pipeline in src/memory/surface.ts
// ---------------------------------------------------------------------------

// Last retrieval snapshot per session, for the inspector's "surfaced" view.
const lastSurface = new Map<string, RankedMemory[]>()

async function sessionTopicQuery(client: any, sessionID: string): Promise<string> {
  try {
    const res = await client.session.messages({ path: { id: sessionID }, query: { limit: 8 } })
    const msgs: any[] = res?.data ?? []
    const lastUser = [...msgs].reverse().find((m) => m?.info?.role === "user")
    return (lastUser?.parts ?? [])
      .filter((p: any) => p?.type === "text")
      .map((p: any) => p.text)
      .join(" ")
  } catch {
    return ""
  }
}

// Optional semantic stage lives in src/rerank.ts (injectable client, unit-
// tested mechanism: abstention, invalid-answer and timeout fall back to the
// deterministic lexical order; zero-tool containment; local-only filtering).
async function rerankCandidatesSafe(
  client: any,
  sessionID: string,
  query: string,
  candidates: RankedMemory[],
): Promise<RankedMemory[]> {
  return rerankCandidates(client, sessionID, query, candidates, {
    timeoutMs: CONFIG.rerankTimeoutMs,
    cacheMs: CONFIG.rerankCacheMs,
    cache: rerankCache,
    log,
    onChildCreated: (id) => consolidationIDs.add(id),
  }, async (childID) => {
    consolidationIDs.delete(childID)
    await client.session.delete({ path: { id: childID } }).catch(() => {})
  })
}

async function buildMemoryBlock(client: any, sessionID: string): Promise<string | undefined> {
  const session = await sessionInfo(client, sessionID)
  const query = await sessionTopicQuery(client, sessionID)
  return buildSurfaceBlock({
    io,
    config: CONFIG,
    sessionID,
    directory: session?.directory,
    query,
    rerank: CONFIG.rerank ? (candidates) => rerankCandidatesSafe(client, sessionID, query, candidates) : undefined,
    lastSurface,
  })
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

return async ({ client }: { client: any }) => {
  clientRef = client
  if (CONFIG.off) {
    log("info", "memory disabled via configuration")
    return {}
  }

  const loaded = await getStore()
  log("info", `memory plugin loaded (${loaded.entries.length} entries, summary ${loaded.summary.length} chars)`)

  const timer = CONFIG.dream ? setTimeout(() => void sweep(), CONFIG.sweepStartMs) : undefined
  const interval = CONFIG.dream ? setInterval(() => void sweep(), CONFIG.sweepIntervalMs) : undefined

  const toolCtx = (ctx: { directory?: string; sessionID?: string }): ToolContext => ({
    directory: ctx.directory,
    sessionID: ctx.sessionID,
    lastSurface,
  })

  return {
    dispose: async () => {
      if (timer) clearTimeout(timer)
      if (interval) clearInterval(interval)
      for (const t of debounces.values()) clearTimeout(t)
      debounces.clear()
    },

    event: async ({ event }: { event: any }) => {
      try {
        if (!CONFIG.dream) return
        log("debug", "event received", { type: event?.type })
        if (event?.type === "session.idle" && event?.properties?.sessionID) {
          log("debug", "idle event -> schedule", { sessionID: event.properties.sessionID })
          scheduleConsolidation(event.properties.sessionID)
        } else if (
          event?.type === "session.status" &&
          event?.properties?.status?.type === "idle" &&
          event?.properties?.sessionID
        ) {
          log("debug", "status idle event -> schedule", { sessionID: event.properties.sessionID })
          scheduleConsolidation(event.properties.sessionID)
        }
      } catch (err) {
        log("debug", "event handler error", { error: String(err) })
      }
    },

    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      try {
        if (!CONFIG.surface) return
        log("debug", "system transform called", { sessionID: input.sessionID, systemCount: output.system.length })
        if (!input.sessionID) return
        if (consolidationIDs.has(input.sessionID)) return
        const block = await buildMemoryBlock(client, input.sessionID)
        log("debug", "system transform block", { sessionID: input.sessionID, blockLen: block?.length ?? 0 })
        if (block) output.system.push(block)
      } catch (err) {
        log("debug", "system transform error", { error: String(err) })
      }
    },

    tool: {
      memory_read: tool({
        description:
          "Read facts stored in long-term memory. Use this when you need the user's preferences, constraints, or project decisions from previous sessions (like ChatGPT's memory recall). Returns global facts plus the CURRENT project's facts; project-scoped facts from other projects are never visible.",
        args: {
          query: tool.schema.string().optional().describe("Optional text to filter facts by topic"),
          category: tool.schema.string().optional().describe("Optional category filter: user, project, workflow, preferences, decisions, status, environment, other"),
          scope: tool.schema.enum(["global", "project"]).optional().describe("Filter by scope"),
        },
        async execute(args, ctx) {
          return memoryRead(io, CONFIG, toolCtx(ctx), args as any)
        },
      }),

      memory_write: tool({
        description:
          "Store a durable fact about the user or project. Distinct facts are kept separately; repeating the same text refreshes it and resolves any conflict. Use memory_update to correct an existing fact.",
        args: {
          fact: tool.schema.string().describe("The fact to remember, third person about the user, e.g. 'The user prefers TypeScript over JavaScript'"),
          category: tool.schema.string().optional().describe("Optional category: user, project, workflow, preferences, decisions, status, environment, other"),
          scope: tool.schema.enum(["global", "project"]).optional().describe("'global' applies everywhere; 'project' only in this codebase (default global)"),
          tier: tool.schema.enum(["core", "archival", "temporary"]).optional().describe("core: always surfaced; archival: surfaced on relevance (default for non-critical facts); temporary: expires automatically"),
          ttlHours: tool.schema.number().optional().describe("Lifetime in hours for tier=temporary (default 24)"),
          pinned: tool.schema.boolean().optional().describe("If true the memory never decays (e.g. identity facts)"),
          sensitivity: tool.schema.enum(["normal", "private", "local-only"]).optional().describe("local-only: stored on disk only; never surfaced, never included in any prompt, never returned by any tool (manage via files in the memory dir)"),
        },
        async execute(args, ctx) {
          return memoryWrite(io, CONFIG, toolCtx(ctx), args as any)
        },
      }),

      memory_update: tool({
        description:
          "Correct an existing memory entry (e.g. the user changed jobs, moved, or a preference changed). Provide either id (from memory_read) or match text; the new fact replaces the old one. Resolves a CONFLICTED entry. Can only touch entries visible in this project.",
        args: {
          id: tool.schema.string().optional().describe("Entry id from memory_read"),
          match: tool.schema.string().optional().describe("Text of the entry to update"),
          fact: tool.schema.string().describe("The corrected fact"),
        },
        async execute(args, ctx) {
          return memoryUpdate(io, CONFIG, toolCtx(ctx), args as any)
        },
      }),

      memory_why: tool({
        description:
          "Explain where a memory entry comes from: provenance (session, messages, extraction time, confidence), lifecycle status and score breakdown. Use when the user asks why a memory exists or whether it can be trusted.",
        args: {
          id: tool.schema.string().describe("Entry id from memory_read"),
        },
        async execute(args, ctx) {
          return memoryWhy(io, CONFIG, toolCtx(ctx), args as any)
        },
      }),

      memory_inspect: tool({
        description:
          "Inspect the memory store: stats (counts by source/scope/tier/status, context cost), recent entries, conflicts awaiting resolution, project-scoped entries, or the 'why surfaced' breakdown of the current session's retrieval. All views are limited to entries visible in this project.",
        args: {
          show: tool.schema.enum(["stats", "recent", "conflicts", "project", "surfaced"]).optional().describe("View to show (default stats)"),
          limit: tool.schema.number().optional().describe("Max entries in list views (default 10)"),
        },
        async execute(args, ctx) {
          return memoryInspect(io, CONFIG, toolCtx(ctx), args as any)
        },
      }),

      memory_useful: tool({
        description: "Tell the memory system that a surfaced memory was actually useful. Improves its future ranking, slows its decay and counts as a confirmation that the fact is still current.",
        args: {
          id: tool.schema.string().describe("Entry id from memory_read"),
        },
        async execute(args, ctx) {
          return memoryUseful(io, CONFIG, toolCtx(ctx), args as any)
        },
      }),

      memory_irrelevant: tool({
        description: "Tell the memory system that a surfaced memory was NOT relevant to the current task. Lowers its future ranking. Does not affect factual recency.",
        args: {
          id: tool.schema.string().describe("Entry id from memory_read"),
        },
        async execute(args, ctx) {
          return memoryIrrelevant(io, CONFIG, toolCtx(ctx), args as any)
        },
      }),

      memory_forget: tool({
        description: "Remove a fact from long-term memory. Provide either id (from memory_read) or text to match. Can only remove entries visible in this project.",
        args: {
          id: tool.schema.string().optional().describe("Entry id from memory_read"),
          match: tool.schema.string().optional().describe("Text of the entry to delete"),
        },
        async execute(args, ctx) {
          return memoryForget(io, CONFIG, toolCtx(ctx), args as any)
        },
      }),

      memory_clear: tool({
        description: "Delete stored memory. summaryOnly=true clears just the shared summary and retains all facts; omit scope in that case. Otherwise scope='project' clears this project, scope='global' clears shared facts, and no arguments wipe everything including local-only entries.",
        args: {
          scope: tool.schema.enum(["global", "project"]).optional().describe("Only clear this scope; default clears everything"),
          summaryOnly: tool.schema.boolean().optional().describe("Clear only the summary, retaining all facts; cannot be combined with scope"),
        },
        async execute(args, ctx) {
          return memoryClear(io, CONFIG, toolCtx(ctx), args as any)
        },
      }),
    },
  }
}
}

export default async (input: { client: any }, options?: Record<string, unknown>) =>
  createLegacyPlugin(resolveConfig(options))(input)
