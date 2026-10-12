// Store I/O boundary: every persistence read/write goes through the
// Obsidian-style markdown vault (src/vault). createStore keeps its historical
// signature and StoreIO shape — the adapters and tools are unchanged — but it
// delegates to the vault, and a legacy JSON store (store.json + state.json +
// SUMMARY.md at the root of the directory) is migrated automatically on first
// use, once per directory AND per process (module-level Map of promises so
// concurrent first calls share one migration; a failed attempt is dropped so
// the next call can retry after a repair).
//
// Like before, getStore/writeStore do not lock themselves: callers wrap
// multi-step mutations in withLock. The lockfile moved with the vault
// (<dir>/.memory/.lock) and is shared across instances of the same directory.
// The one-shot conversion itself (backup, notes, state, legacy moves) lives
// in src/vault/migrate.ts; scripts/migrate-vault.ts documents the rollback.

import path from "path"
import { resolveConfig } from "./config.ts"
import type { Store } from "./core.ts"
import { migrateLegacyJson } from "./vault/migrate.ts"
import { createVaultStore, type State } from "./vault/vaultStore.ts"

export type { InProgress, State } from "./vault/vaultStore.ts"

const migrations = new Map<string, Promise<void>>()

function migrateOnce(dataDir: string): Promise<void> {
  const existing = migrations.get(dataDir)
  if (existing) return existing
  const pending = migrateLegacyJson(dataDir).then(
    () => undefined,
    (error) => {
      migrations.delete(dataDir)
      throw error
    },
  )
  migrations.set(dataDir, pending)
  return pending
}

export function createStore(dataDir: string) {
  dataDir = path.resolve(dataDir)
  const vault = createVaultStore(dataDir)
  return {
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      await migrateOnce(dataDir)
      return vault.withLock(fn)
    },
    async getStore() {
      await migrateOnce(dataDir)
      return vault.getStore()
    },
    async writeStore(store: Store) {
      await migrateOnce(dataDir)
      await vault.writeStore(store)
    },
    async archiveEntries(ids: string[], reason: string) {
      await migrateOnce(dataDir)
      return vault.archiveEntries(ids, reason)
    },
    async getState() {
      await migrateOnce(dataDir)
      return vault.getState()
    },
    async saveState(state: State) {
      await migrateOnce(dataDir)
      await vault.saveState(state)
    },
  }
}

export type StoreIO = ReturnType<typeof createStore>
// Direct callers retain the default helpers. Resolve their environment only
// when first used, so plugin options can override it during adapter setup.
let defaultStore: StoreIO | undefined
function defaultIO(): StoreIO {
  return defaultStore ??= createStore(resolveConfig().dir)
}

export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  return defaultIO().withLock(fn)
}

export function getStore(): Promise<Store> {
  return defaultIO().getStore()
}

export function writeStore(store: Store): Promise<void> {
  return defaultIO().writeStore(store)
}

export function getState(): Promise<State> {
  return defaultIO().getState()
}

export function saveState(state: State): Promise<void> {
  return defaultIO().saveState(state)
}
