import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStore } from "../src/store.ts"
import { migrateLegacyJson, rollbackFromBackup } from "../src/vault/migrate.ts"
import { noteFileName, projectFolderName, vaultPaths } from "../src/vault/paths.ts"

// Legacy JSON layout pinned by the pre-vault releases: store.json + state.json
// + SUMMARY.md at the root of the memory directory.
const legacyEntries = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    text: "The user likes tea in the morning.",
    category: "preferences",
    scope: "global",
    weight: 3,
    created: 1730000000000,
    lastSeen: 1730000000000,
    source: "explicit",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    text: "The user deploys on Bun every day.",
    category: "workflow",
    scope: "global",
    weight: 1,
    created: 1730000001000,
    lastSeen: 1730000001000,
    source: "explicit",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    text: "Project alpha ships on Fridays.",
    category: "status",
    scope: "project",
    projectID: "/work/alpha",
    weight: 1,
    created: 1730000002000,
    lastSeen: 1730000002000,
    source: "explicit",
  },
]
const legacyStore = { version: 1, summary: "Alpha ships weekly.", updatedAt: 1730000009000, entries: legacyEntries }
const legacyState = { sessions: { "session-1": 1730000000000 }, inProgress: {} }
const legacySummaryFile = "# opencode memory summary\n\nUpdated: 2026-01-01T00:00:00.000Z\n\nAlpha ships weekly.\n"

function seedLegacy(root: string) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "store.json"), JSON.stringify(legacyStore))
  writeFileSync(join(root, "state.json"), JSON.stringify(legacyState))
  writeFileSync(join(root, "SUMMARY.md"), legacySummaryFile)
}

function backupDirs(root: string) {
  const memory = join(root, ".memory")
  return existsSync(memory) ? readdirSync(memory).filter((name) => name.startsWith("backup-")) : []
}

async function withTemp(fn: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "memory-migrate-"))
  try {
    await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("migrateLegacyJson", () => {
  test("legacy JSON becomes notes, a full backup and .memory/state.json", async () => {
    await withTemp(async (root) => {
      seedLegacy(root)

      const result = await migrateLegacyJson(root)

      expect(result.alreadyMigrated).toBe(false)
      expect(result.migrated).toBe(3)
      expect(result.backup).toBeTruthy()
      expect(result.backup).toContain(join(".memory", "backup-"))

      const paths = vaultPaths(root)
      // Notes: two globals + one project note in its deterministic folder.
      const globalNotes = readdirSync(paths.global)
      expect(globalNotes).toHaveLength(2)
      expect(globalNotes).toContain(noteFileName(legacyEntries[0].id, legacyEntries[0].text))
      expect(globalNotes).toContain(noteFileName(legacyEntries[1].id, legacyEntries[1].text))
      const folder = join(paths.projects, projectFolderName("/work/alpha"))
      expect(readdirSync(folder)).toEqual([noteFileName(legacyEntries[2].id, legacyEntries[2].text)])
      // The note files carry the entry ids and text bodies.
      const projectNote = readFileSync(join(folder, noteFileName(legacyEntries[2].id, legacyEntries[2].text)), "utf8")
      expect(projectNote).toContain('id: "33333333-3333-4333-8333-333333333333"')
      expect(projectNote).toContain("Project alpha ships on Fridays.")

      // The new vault SUMMARY.md carries the legacy summary.
      expect(readFileSync(paths.summary, "utf8")).toContain("Alpha ships weekly.")

      // store.json left the root and lives in the backup, with the other
      // legacy files copied alongside it.
      expect(existsSync(join(root, "store.json"))).toBe(false)
      expect(existsSync(join(root, "state.json"))).toBe(false)
      const backup = readdirSync(join(paths.memory, backupDirs(root)[0]!)).sort()
      expect(backup).toEqual(["SUMMARY.md", "state.json", "store.json"])

      // Inherited state keeps the same State format.
      expect(JSON.parse(readFileSync(paths.state, "utf8"))).toEqual(legacyState)

      // The migrated vault reads back through the vault layer.
      const store = await createStore(root).getStore()
      expect(store.entries.map((entry) => entry.text).sort()).toEqual(
        legacyEntries.map((entry) => entry.text).sort(),
      )
      expect(store.summary).toBe("Alpha ships weekly.")
    })
  })

  test("a second run is a no-op: no duplicate notes, no new backup", async () => {
    await withTemp(async (root) => {
      seedLegacy(root)
      const first = await migrateLegacyJson(root)
      const paths = vaultPaths(root)

      const second = await migrateLegacyJson(root)

      expect(second.alreadyMigrated).toBe(true)
      expect(second.migrated).toBe(0)
      expect(second.backup).toBeUndefined()
      expect(backupDirs(root)).toHaveLength(1)
      expect(readdirSync(paths.global)).toHaveLength(2)
      const store = await createStore(root).getStore()
      expect(store.entries).toHaveLength(3)
      expect(first.backup).toBeTruthy()
    })
  })

  test("rollback restores the original JSON files byte-for-byte", async () => {
    await withTemp(async (root) => {
      seedLegacy(root)
      const result = await migrateLegacyJson(root)

      await rollbackFromBackup(result.backup!, root)

      expect(JSON.parse(readFileSync(join(root, "store.json"), "utf8"))).toEqual(legacyStore)
      expect(JSON.parse(readFileSync(join(root, "state.json"), "utf8"))).toEqual(legacyState)
      expect(readFileSync(join(root, "SUMMARY.md"), "utf8")).toBe(legacySummaryFile)
    })
  })

  test("an unreadable store.json fails explicitly and moves nothing", async () => {
    await withTemp(async (root) => {
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, "store.json"), "{ this is not valid json")
      writeFileSync(join(root, "SUMMARY.md"), "legacy summary marker\n")

      await expect(migrateLegacyJson(root)).rejects.toThrow(/store\.json/)

      // Nothing was converted, moved or backed up.
      expect(existsSync(join(root, "store.json"))).toBe(true)
      expect(readFileSync(join(root, "SUMMARY.md"), "utf8")).toBe("legacy summary marker\n")
      expect(backupDirs(root)).toEqual([])
      expect(existsSync(join(root, "Global"))).toBe(false)
      expect(existsSync(vaultPaths(root).state)).toBe(false)
    })
  })

  test("createStore auto-migrates a legacy directory once per process", async () => {
    await withTemp(async (root) => {
      seedLegacy(root)

      const io = createStore(root)
      const store = await io.getStore()

      expect(store.entries.map((entry) => entry.text).sort()).toEqual(
        legacyEntries.map((entry) => entry.text).sort(),
      )
      expect(existsSync(join(root, "store.json"))).toBe(false)
      expect(JSON.parse(readFileSync(vaultPaths(root).state, "utf8"))).toEqual(legacyState)

      // From now on writes land in the vault (markdown + .memory), never in a
      // root JSON file.
      await io.withLock(async () => {
        const fresh = await io.getStore()
        fresh.summary = "Updated through the vault."
        await io.writeStore(fresh)
      })
      expect(readFileSync(vaultPaths(root).summary, "utf8")).toContain("Updated through the vault.")
      expect(existsSync(join(root, "store.json"))).toBe(false)
      expect(backupDirs(root)).toHaveLength(1)
    })
  })
})
