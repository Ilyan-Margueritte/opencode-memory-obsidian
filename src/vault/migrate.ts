// One-shot JSON → Markdown migration. A legacy memory directory stores
// store.json + state.json + SUMMARY.md at its root; the vault layout (see
// paths.ts) stores notes under Global/ and Projects/, the summary in
// SUMMARY.md and the state in .memory/state.json.
//
// Contract (idempotent, reversible, atomic):
//   1. no store.json at the root → already migrated (no-op);
//   2. read store.json → normalizeStore, read the legacy state if present;
//   3. copy store.json, state.json, SUMMARY.md into .memory/backup-<ts>/
//      BEFORE anything is converted;
//   4. writeStore → notes + new SUMMARY.md + index;
//   5. write the inherited state into .memory/state.json (same State format);
//   6. MOVE store.json and the legacy state.json into the backup — the root
//      keeps no JSON, so a second run sees step 1 and does nothing. The
//      legacy SUMMARY.md is preserved through the step-3 copy: the root file
//      is now the NEW vault summary written by writeStore and must stay.
//   Rollback: copy the backup content back to the root
//   (rollbackFromBackup / scripts/migrate-vault.ts --rollback). The next run
//   re-migrates the restored store.json.
//
// An unreadable store.json aborts with an explicit error BEFORE any backup or
// move: nothing is touched, the user keeps their file. The conversion runs
// under the vault lockfile so two processes can never migrate concurrently.
// Stdlib only (fs/path); no new dependency.

import { existsSync } from "fs"
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "fs/promises"
import path from "path"
import { normalizeStore, type Store } from "../core.ts"
import { vaultPaths } from "./paths.ts"
import { createVaultStore, type State } from "./vaultStore.ts"

export type MigrationResult = {
  migrated: number
  backup?: string
  alreadyMigrated: boolean
}

function now(): string {
  // Colons are illegal in Windows file names, hence the replacement (same
  // rule as vaultStore.backupName).
  return new Date().toISOString().replace(/:/g, "-")
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true }).catch(() => {})
  const tmp = `${file}.${process.pid}.migrate.tmp`
  await writeFile(tmp, content, "utf8")
  // Same bounded retry as vaultStore.atomicWrite: a concurrent reader of the
  // destination (Windows sharing violation) must not fail the migration.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file)
      return
    } catch (error) {
      if (attempt >= 19 || !existsSync(tmp)) throw error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

async function atomicCopy(from: string, to: string): Promise<void> {
  await atomicWrite(to, await readFile(from, "utf8"))
}

// Move a legacy file into the backup directory. A concurrent migration may
// have moved it already: a vanished source is success, not an error.
async function moveIntoBackup(file: string, backupDir: string): Promise<void> {
  if (!existsSync(file)) return
  const target = path.join(backupDir, path.basename(file))
  try {
    await rename(file, target)
  } catch {
    if (!existsSync(file)) return
    await atomicCopy(file, target)
    await unlink(file).catch(() => {})
  }
}

async function readLegacyState(file: string): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as State
    return { sessions: parsed.sessions ?? {}, inProgress: parsed.inProgress ?? {} }
  } catch {
    return { sessions: {}, inProgress: {} }
  }
}

export async function migrateLegacyJson(
  dataDir: string,
  log?: (message: string) => void,
): Promise<MigrationResult> {
  const paths = vaultPaths(dataDir)
  const legacyStoreFile = path.join(paths.root, "store.json")
  const legacyStateFile = path.join(paths.root, "state.json")
  const legacySummaryFile = path.join(paths.root, "SUMMARY.md")

  // 1. Idempotency fast path (read-only: safe without the lock).
  if (!existsSync(legacyStoreFile)) return { migrated: 0, alreadyMigrated: true }

  const vault = createVaultStore(dataDir)
  return vault.withLock(async () => {
    // Another process may have migrated while we waited for the lock.
    if (!existsSync(legacyStoreFile)) return { migrated: 0, alreadyMigrated: true }

    // 2. Read + parse BEFORE anything is created or moved: an unreadable
    // store.json must abort the whole migration with an explicit error.
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(legacyStoreFile, "utf8"))
    } catch (error) {
      throw new Error(`cannot migrate ${legacyStoreFile}: unreadable JSON (${(error as Error).message})`)
    }
    const version = parsed && typeof parsed === "object" ? (parsed as { version?: unknown }).version : undefined
    if (version !== 1 && version !== 2) {
      throw new Error(`cannot migrate ${legacyStoreFile}: unsupported store version (${String(version)})`)
    }
    const store = normalizeStore(parsed as Store)
    const legacyState = await readLegacyState(legacyStateFile)

    // 3. Full backup before conversion (existing files only).
    const backupDir = path.join(paths.memory, `backup-${now()}`)
    await mkdir(backupDir, { recursive: true })
    for (const file of [legacyStoreFile, legacyStateFile, legacySummaryFile]) {
      if (existsSync(file)) await atomicCopy(file, path.join(backupDir, path.basename(file)))
    }
    log?.(`backup of the legacy files in ${backupDir}`)

    // 4. Notes + new SUMMARY.md + index.
    await vault.writeStore(store)

    // 5. Inherited state, same State format, new location.
    await atomicWrite(paths.state, JSON.stringify(legacyState, null, 2))

    // 6. The root keeps no JSON: move the legacy files into the backup. The
    // root SUMMARY.md is the NEW vault summary — it stays (the legacy one is
    // already copied in step 3).
    await moveIntoBackup(legacyStoreFile, backupDir)
    await moveIntoBackup(legacyStateFile, backupDir)

    log?.(`migrated ${store.entries.length} entries into ${paths.root}`)
    return { migrated: store.entries.length, backup: backupDir, alreadyMigrated: false }
  })
}

// Rollback: restore store.json / state.json / SUMMARY.md from a backup
// directory to the memory root (the vault files are left untouched; the next
// migration re-adopts the restored store.json).
export async function rollbackFromBackup(
  backupDir: string,
  dataDir: string,
  log?: (message: string) => void,
): Promise<void> {
  const root = path.resolve(dataDir)
  if (!existsSync(backupDir)) throw new Error(`backup directory not found: ${backupDir}`)
  for (const name of ["store.json", "state.json", "SUMMARY.md"]) {
    const from = path.join(backupDir, name)
    if (!existsSync(from)) continue
    await atomicWrite(path.join(root, name), await readFile(from, "utf8"))
    log?.(`restored ${name} from ${backupDir}`)
  }
}

// Count the notes of a vault (Global/ + Projects/, recursively). Used by the
// CLI's --verify to compare the disk with the migrated entry count.
export async function countVaultNotes(dataDir: string): Promise<number> {
  const paths = vaultPaths(dataDir)
  let count = 0
  async function walk(dir: string): Promise<void> {
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of dirents) {
      if (d.isDirectory()) await walk(path.join(dir, d.name))
      else if (d.isFile() && d.name.toLowerCase().endsWith(".md")) count++
    }
  }
  await walk(paths.global)
  await walk(paths.projects)
  return count
}
