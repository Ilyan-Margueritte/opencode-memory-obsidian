// Explicit lifecycle (2.0.2): entries leave the ACTIVE vault only through
// this module's callers. writeStore is upsert-only — a stale snapshot from
// another concurrent desktop instance never archives anything — so every
// deletion site (memory_write / memory_update / memory_clear / memory_forget,
// Dream consolidation and duplicate fusion) archives what it dropped,
// explicitly. pruneAndArchive keeps that one step pure: it just turns a
// before/after diff into archive calls (the callers own the prune call
// itself), so the diff logic stays trivially testable.

import type { Entry } from "../core.ts"
import type { MemoryConfig } from "../config.ts"
import type { VaultIO } from "../vault/vaultStore.ts"

export const PRUNE_REASON = "pruned (score decay, superseded or expired)"

// Ids present in `before` and absent from `after` — what a prune just
// dropped from the store while the notes are still active on disk.
export function droppedIds(before: Entry[], after: Entry[]): string[] {
  const afterIds = new Set(after.map((e) => e.id))
  return before.map((e) => e.id).filter((id) => !afterIds.has(id))
}

export async function pruneAndArchive(
  io: VaultIO,
  config: MemoryConfig,
  before: Entry[],
  after: Entry[],
): Promise<number> {
  void config
  const ids = droppedIds(before, after)
  if (ids.length === 0) return 0
  return io.archiveEntries(ids, PRUNE_REASON)
}
