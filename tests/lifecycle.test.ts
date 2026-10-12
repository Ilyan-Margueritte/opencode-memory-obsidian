// 2.0.2 lifecycle tests: entries leave the ACTIVE vault only through the
// EXPLICIT archive API. pruneAndArchive turns a prune diff into archive
// calls — pure before/after inputs, so the diff logic is trivially testable —
// while writeStore itself is upsert-only and never archives on drop (see the
// stale-writer regression in tests/vault-store.test.ts).
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createVaultStore, type VaultIO } from "../src/vault/vaultStore.ts"
import { vaultPaths } from "../src/vault/paths.ts"
import { pruneAndArchive, PRUNE_REASON } from "../src/memory/lifecycle.ts"
import { resolveConfig } from "../src/config.ts"
import { emptyStore, type Entry } from "../src/core.ts"

function entry(id: string, text: string): Entry {
  return {
    id,
    text,
    category: "other",
    scope: "global",
    weight: 3,
    created: 1730000000000,
    lastSeen: 1730000000000,
    source: "dreamed",
    tier: "archival",
    status: "ACTIVE",
    sensitivity: "normal",
  }
}

const A = entry("aaaaaaaa-1111-4321-8765-abcdefabcdef", "Fact A stays.")
const B = entry("bbbbbbbb-2222-4321-8765-abcdefabcdef", "Fact B stays.")
const C = entry("cccccccc-3333-4321-8765-abcdefabcdef", "Fact C is pruned away.")

async function withVault(fn: (io: VaultIO, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "memory-lifecycle-"))
  try {
    await fn(createVaultStore(root), root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("pruneAndArchive", () => {
  test("archives exactly the ids dropped between before and after, with the prune reason", async () => {
    await withVault(async (io, root) => {
      const store = emptyStore()
      store.entries = [A, B, C]
      store.updatedAt = Date.now()
      await io.withLock(() => io.writeStore(store))
      const config = resolveConfig({ dir: root }, {})

      // The caller pruned C from its store (before=[A,B,C] → after=[A,B]).
      expect(await pruneAndArchive(io, config, [A, B, C], [A, B])).toBe(1)

      const paths = vaultPaths(root)
      const files = readdirSync(paths.archives)
      expect(files).toHaveLength(1)
      const raw = readFileSync(join(paths.archives, files[0]!), "utf8")
      expect(raw).toContain(`id: "${C.id}"`)
      expect(raw).toContain('status: "ARCHIVED"')
      expect(raw).toContain(`archivedReason: ${JSON.stringify(PRUNE_REASON)}`)
      // The survivors stay ACTIVE on disk.
      expect((await io.getStore()).entries.map((e) => e.id).sort()).toEqual([A.id, B.id].sort())
    })
  })

  test("is idempotent: a second call over the same diff archives nothing", async () => {
    await withVault(async (io, root) => {
      const store = emptyStore()
      store.entries = [A, B, C]
      store.updatedAt = Date.now()
      await io.withLock(() => io.writeStore(store))
      const config = resolveConfig({ dir: root }, {})

      expect(await pruneAndArchive(io, config, [A, B, C], [A, B])).toBe(1)
      expect(await pruneAndArchive(io, config, [A, B, C], [A, B])).toBe(0)
      expect(readdirSync(vaultPaths(root).archives)).toHaveLength(1)
    })
  })

  test("an empty diff archives nothing and touches no directory", async () => {
    await withVault(async (io, root) => {
      const config = resolveConfig({ dir: root }, {})
      expect(await pruneAndArchive(io, config, [], [])).toBe(0)
      expect(await pruneAndArchive(io, config, [A], [A])).toBe(0)
      expect(existsSync(vaultPaths(root).archives)).toBe(false)
    })
  })
})
