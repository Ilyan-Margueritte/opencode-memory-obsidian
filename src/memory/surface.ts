// Shared SURFACE pipeline for both adapters: retrieve → relevance gate → core
// slot → the <memory> block lines. The adapters resolve the session's
// directory and topic query (their own runtime APIs) and inject their optional
// semantic reranker as a callback; everything downstream — including the
// lastSurface snapshot the inspector tools read and the exposure
// bookkeeping — lives here so V1 and V2 behave identically.

import {
  applySurfaceFeedback,
  coreSlot,
  passesRelevanceGate,
  readableEntries,
  retrieve,
  score,
  type RankedMemory,
} from "../core.ts"
import type { MemoryConfig } from "../config.ts"
import type { Store } from "../core.ts"
import type { VaultIO } from "../vault/vaultStore.ts"

function now() {
  return Date.now()
}

// Usage guidance injected with EVERY surfacing round. On the OpenCode V2
// runtime the memory tools are exposed through the Code Mode tools catalog,
// so the model never sees them as direct tools and will not reach for them
// unprompted — without this static policy, proactive memory use only happens
// when the user explicitly asks. Always appended whole (never truncated by
// maxChars), even on an empty store: the first session is exactly when the
// user states facts worth remembering.
const MEMORY_TOOLS_HINT = [
  "<memory-tools>",
  "Persistent memory tools are available in your tools catalog (Code Mode): tools.memory_write, tools.memory_read, tools.memory_update, tools.memory_forget, tools.memory_why, tools.memory_useful, tools.memory_irrelevant, tools.memory_inspect, tools.memory_clear.",
  "Use them proactively, without waiting to be asked:",
  "- tools.memory_write the moment the user states a durable fact: preference, decision, project setup or tooling, constraint, correction. Use scope \"project\" for facts tied to the current codebase, \"global\" otherwise. Never store secrets (passwords, API keys, tokens).",
  "- tools.memory_read when past context would help (user habits, prior decisions, why the code is the way it is).",
  "- tools.memory_update when the user corrects a stored fact.",
  "Skip trivial small talk and one-off actions.",
  "- The <memory-index> section lists everything currently in memory. Call tools.memory_read (optionally with a query) for the full text of any item before answering questions that touch the user's preferences, decisions or project state.",
  "</memory-tools>",
].join("\n")

// Compact table of contents of the vault, injected after the <memory> facts
// block and exempt from the maxChars truncation budget. Without it the agent
// only ever sees facts that match its current query plus the core slot — it
// cannot ask for what it does not know exists. Sorted by score, capped by
// config.indexLines (0 disables), local-only and non-active entries excluded.
function memoryIndexSection(store: Store, directory: string | undefined, config: MemoryConfig, t: number): string {
  if (config.indexLines <= 0) return ""
  const entries = readableEntries(store, directory)
    .filter((e) => e.status === "ACTIVE" && (e.expiresAt === undefined || e.expiresAt > t))
    .sort((a, b) => score(b, t) - score(a, t))
    .slice(0, config.indexLines)
  if (entries.length === 0) return ""
  const lines = entries.map((e) => {
    const text = e.text.replace(/\s+/g, " ").trim().slice(0, 70)
    return `- ${text}${e.scope === "project" ? " [project]" : ""}`
  })
  return `\n<memory-index>\n${lines.join("\n")}\n</memory-index>`
}

// Persist surface EXPOSURE (lastSurfaced/surfacedCount/useCount) at most once
// per entry per interval. Deliberately does NOT touch lastSeen: automatic
// exposure is not evidence that a fact is still current, and refreshing
// recency on every surfacing would create a self-reinforcing loop (frequently
// surfaced memories stay artificially fresh and immortal under prune()).
// Only explicit positive feedback (memory_useful) refreshes lastSeen.
export async function markSurfaced(io: VaultIO, config: MemoryConfig, ids: string[], t = now()): Promise<void> {
  if (ids.length === 0) return
  try {
    await io.withLock(async () => {
      const s = await io.getStore()
      const due = ids.some((id) => {
        const e = s.entries.find((x) => x.id === id)
        return !!e && t - (e.lastUsed ?? 0) >= config.surfaceRefreshMs
      })
      if (!due) return
      applySurfaceFeedback(s, ids, t, config.surfaceRefreshMs)
      await io.writeStore(s)
    })
  } catch {
    // Exposure bookkeeping must never break the surfacing round.
  }
}

export async function buildMemoryBlock(deps: {
  io: VaultIO
  config: MemoryConfig
  sessionID: string
  directory: string | undefined
  query: string
  rerank?: (candidates: RankedMemory[]) => Promise<RankedMemory[]>
  lastSurface: Map<string, RankedMemory[]>
}): Promise<string | undefined> {
  const { io, config, sessionID, directory, query, lastSurface } = deps
  const store = await io.getStore()
  const t = now()
  // retrieve() enforces scope isolation (global + this directory only) and
  // excludes local-only entries via excludeSensitivity.
  const ranked = retrieve(store, directory, query, t, {
    excludeSensitivity: new Set(["local-only"]),
    candidateCount: config.rerankCandidates,
  })
  const reranked = deps.rerank ? await deps.rerank(ranked) : ranked
  // Relevance floor: without RERANK, only memories passing the lexical
  // relevance gate enter the relevance tier — a query that matches nothing
  // surfaces nothing but the core slot (no noise for off-topic prompts).
  // With RERANK, an explicit abstention returns [] here (same outcome,
  // semantic gate instead). Single-source policy: passesRelevanceGate().
  const qualified = config.rerank ? reranked : reranked.filter(passesRelevanceGate)
  const top = qualified.slice(0, config.maxFacts)
  const selectedIds = new Set(top.map((r) => r.entry.id))
  const core = coreSlot(store, directory, selectedIds, t, config.coreSlot)
  const surfaced: RankedMemory[] = [
    ...top,
    ...core.map((e, i) => ({
      entry: e,
      base: score(e, t),
      keywordHits: 0,
      matches: [],
      core: true,
      rank: top.length + i + 1,
      final: score(e, t),
    })),
  ]
  lastSurface.set(sessionID, surfaced)
  void markSurfaced(io, config, surfaced.map((r) => r.entry.id), t)

  const lines: string[] = []
  lines.push("<memory>")
  lines.push("The following is long-term memory from previous conversations with this user. Use it to personalize responses and follow established preferences. If something contradicts newer information, trust the newer information.")
  if (config.summary && store.summary) {
    lines.push(`<summary>${store.summary}</summary>`)
  }
  if (surfaced.length > 0) {
    lines.push("<facts>")
    for (const r of surfaced) {
      const e = r.entry
      const status = e.status === "CONFLICTED" ? ", conflicted" : ""
      lines.push(`- [${e.source}] (${e.category}${status}) ${e.text}`)
    }
    lines.push("</facts>")
  }
  lines.push("</memory>")
  let block = lines.join("\n")
  const budget = Math.max(0, config.maxChars - MEMORY_TOOLS_HINT.length - 1)
  if (block.length > budget) block = block.slice(0, budget - 1) + "…"
  const index = memoryIndexSection(store, directory, config, t)
  return block + index + "\n" + MEMORY_TOOLS_HINT
}
