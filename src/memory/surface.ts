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
  retrieve,
  score,
  type RankedMemory,
} from "../core.ts"
import type { MemoryConfig } from "../config.ts"
import type { VaultIO } from "../vault/vaultStore.ts"

function now() {
  return Date.now()
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
  if (store.entries.length === 0 && !(config.summary && store.summary)) return undefined
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
  if (block.length > config.maxChars) block = block.slice(0, config.maxChars - 1) + "…"
  return block
}
