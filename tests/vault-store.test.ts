import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createVaultStore } from "../src/vault/vaultStore.ts"
import { projectFolderName, vaultPaths } from "../src/vault/paths.ts"
import type { Entry, Store } from "../src/core.ts"

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "12345678-abcd-4321-8765-abcdefabcdef",
    text: "The user likes coffee.",
    category: "preferences",
    scope: "global",
    weight: 3,
    created: 1730000000000,
    lastSeen: 1730000000000,
    source: "explicit",
    tier: "core",
    status: "ACTIVE",
    sensitivity: "normal",
    ...overrides,
  }
}

function storeOf(entries: Entry[], summary = ""): Store {
  return { version: 2, summary, updatedAt: 1730000001000, entries }
}

// Backdate a manually-edited file so its mtime can never collide with the
// mtime recorded in the index by the preceding writeStore.
function backdate(file: string) {
  const past = new Date(Date.now() - 60_000)
  utimesSync(file, past, past)
}

async function withVault(fn: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "memory-vault-"))
  try {
    await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const coffee = () => entry({ id: "aaaaaaaa-1111-4321-8765-abcdefabcdef", text: "The user likes coffee." })
const bun = () => entry({ id: "bbbbbbbb-2222-4321-8765-abcdefabcdef", text: "The user uses Bun daily.", category: "workflow" })

describe("createVaultStore", () => {
  test("writeStore then getStore round-trips entries, summary and folders", async () => {
    await withVault(async (root) => {
      const io = createVaultStore(root)
      const a = coffee()
      const b = bun()
      const c = entry({
        id: "cccccccc-3333-4321-8765-abcdefabcdef",
        text: "Project alpha ships on Fridays.",
        category: "status",
        scope: "project",
        projectID: "C:\\work\\alpha",
      })
      await io.writeStore(storeOf([a, b, c], "Alpha project context."))
      const read = await io.getStore()
      expect(read.entries).toHaveLength(3)
      for (const expected of [a, b, c]) {
        expect(read.entries.find((e) => e.id === expected.id)).toEqual(expected)
      }
      expect(read.summary).toBe("Alpha project context.")
      const paths = vaultPaths(root)
      expect(existsSync(join(paths.global, "the-user-likes-coffee-aaaaaaaa.md"))).toBe(true)
      expect(existsSync(join(paths.global, "the-user-uses-bun-daily-bbbbbbbb.md"))).toBe(true)
      const folder = join(paths.projects, projectFolderName("C:\\work\\alpha"))
      expect(readdirSync(folder)).toEqual(["project-alpha-ships-on-fridays-cccccccc.md"])
    })
  })

  test("rewriting a modified note backs up the raw and leaves other notes intact", async () => {
    await withVault(async (root) => {
      const io = createVaultStore(root)
      const a = coffee()
      const b = bun()
      await io.writeStore(storeOf([a, b]))
      await io.writeStore(storeOf([{ ...a, text: "The user prefers tea now." }, b]))
      const read = await io.getStore()
      expect(read.entries.find((e) => e.id === a.id)?.text).toBe("The user prefers tea now.")
      expect(read.entries.find((e) => e.id === b.id)?.text).toBe("The user uses Bun daily.")
      const paths = vaultPaths(root)
      const history = readdirSync(paths.history)
      expect(history).toHaveLength(1)
      expect(history[0]).toMatch(/-aaaaaaaa\.md$/)
      expect(readFileSync(join(paths.history, history[0]), "utf8")).toContain("The user likes coffee.")
      expect(readdirSync(paths.global)).toHaveLength(2)
    })
  })

  test("prune/forget drops are archived with status ARCHIVED and excluded", async () => {
    await withVault(async (root) => {
      const io = createVaultStore(root)
      const a = coffee()
      const b = bun()
      await io.writeStore(storeOf([a, b]))
      await io.writeStore(storeOf([b]))
      const paths = vaultPaths(root)
      const archived = readdirSync(paths.archives)
      expect(archived).toHaveLength(1)
      const raw = readFileSync(join(paths.archives, archived[0]), "utf8")
      expect(raw).toContain('status: "ARCHIVED"')
      expect(raw).toContain("archivedAt: ")
      expect(existsSync(join(paths.global, "the-user-likes-coffee-aaaaaaaa.md"))).toBe(false)
      const read = await io.getStore()
      expect(read.entries.map((e) => e.id)).toEqual([b.id])
    })
  })

  test("archiving is idempotent: no duplicate on a second identical write", async () => {
    await withVault(async (root) => {
      const io = createVaultStore(root)
      await io.writeStore(storeOf([coffee(), bun()]))
      await io.writeStore(storeOf([bun()]))
      await io.writeStore(storeOf([bun()]))
      const paths = vaultPaths(root)
      expect(readdirSync(paths.archives)).toHaveLength(1)
      expect(readdirSync(paths.global)).toHaveLength(1)
    })
  })

  test("manual body edit is picked up", async () => {
    await withVault(async (root) => {
      const io = createVaultStore(root)
      await io.writeStore(storeOf([coffee()]))
      const paths = vaultPaths(root)
      const file = join(paths.global, "the-user-likes-coffee-aaaaaaaa.md")
      writeFileSync(file, readFileSync(file, "utf8").replace("The user likes coffee.", "The user drinks espresso."), "utf8")
      backdate(file)
      const read = await io.getStore()
      expect(read.entries).toHaveLength(1)
      expect(read.entries[0].text).toBe("The user drinks espresso.")
    })
  })

  test("manual frontmatter edit is picked up", async () => {
    await withVault(async (root) => {
      const io = createVaultStore(root)
      await io.writeStore(storeOf([coffee()]))
      const paths = vaultPaths(root)
      const file = join(paths.global, "the-user-likes-coffee-aaaaaaaa.md")
      writeFileSync(file, readFileSync(file, "utf8").replace("weight: 3", "weight: 4"), "utf8")
      backdate(file)
      const read = await io.getStore()
      expect(read.entries).toHaveLength(1)
      expect(read.entries[0].weight).toBe(4)
    })
  })

  test("manual rename is preserved without duplication", async () => {
    await withVault(async (root) => {
      const io = createVaultStore(root)
      const a = coffee()
      await io.writeStore(storeOf([a]))
      const paths = vaultPaths(root)
      renameSync(join(paths.global, "the-user-likes-coffee-aaaaaaaa.md"), join(paths.global, "renamed-by-hand.md"))
      const read = await io.getStore()
      expect(read.entries.map((e) => e.id)).toEqual([a.id])
      await io.writeStore(storeOf([a]))
      expect(readdirSync(paths.global)).toEqual(["renamed-by-hand.md"])
    })
  })

  test("manual deletion is not resurrected", async () => {
    await withVault(async (root) => {
      const io = createVaultStore(root)
      await io.writeStore(storeOf([coffee()]))
      const paths = vaultPaths(root)
      unlinkSync(join(paths.global, "the-user-likes-coffee-aaaaaaaa.md"))
      const read = await io.getStore()
      expect(read.entries).toHaveLength(0)
      await io.writeStore(read)
      expect(readdirSync(paths.global)).toHaveLength(0)
      expect(existsSync(join(paths.global, "the-user-likes-coffee-aaaaaaaa.md"))).toBe(false)
    })
  })

  test("project entries land in distinct project folders", async () => {
    await withVault(async (root) => {
      const io = createVaultStore(root)
      const pa = entry({ id: "aaaaaaaa-1111-4321-8765-abcdefabcdef", text: "Alpha builds fast.", scope: "project", projectID: "C:\\work\\alpha" })
      const pb = entry({ id: "bbbbbbbb-2222-4321-8765-abcdefabcdef", text: "Beta builds slowly.", scope: "project", projectID: "C:\\work\\beta" })
      await io.writeStore(storeOf([pa, pb]))
      const paths = vaultPaths(root)
      const fa = projectFolderName("C:\\work\\alpha")
      const fb = projectFolderName("C:\\work\\beta")
      expect(fa).not.toBe(fb)
      expect(readdirSync(join(paths.projects, fa))).toEqual(["alpha-builds-fast-aaaaaaaa.md"])
      expect(readdirSync(join(paths.projects, fb))).toEqual(["beta-builds-slowly-bbbbbbbb.md"])
    })
  })

  test("state round-trips through .memory/state.json", async () => {
    await withVault(async (root) => {
      const io = createVaultStore(root)
      await io.saveState({ sessions: { s1: 42 }, inProgress: { s2: { targetTs: 7, startedAt: 8, childID: "c" } } })
      const state = await io.getState()
      expect(state.sessions).toEqual({ s1: 42 })
      expect(state.inProgress).toEqual({ s2: { targetTs: 7, startedAt: 8, childID: "c" } })
      expect(existsSync(join(vaultPaths(root).memory, "state.json"))).toBe(true)
    })
  })

  test("corrupted frontmatter is ignored without crashing, error recorded in the index", async () => {
    await withVault(async (root) => {
      const io = createVaultStore(root)
      const a = coffee()
      await io.writeStore(storeOf([a]))
      const paths = vaultPaths(root)
      writeFileSync(join(paths.global, "broken.md"), "no frontmatter here at all\n", "utf8")
      const read = await io.getStore()
      expect(read.entries.map((e) => e.id)).toEqual([a.id])
      const index = JSON.parse(readFileSync(paths.index, "utf8")) as { files: Record<string, { error?: string }> }
      expect(Object.values(index.files).filter((f) => f.error)).toHaveLength(1)
    })
  })

  test("summary is written to SUMMARY.md and read back", async () => {
    await withVault(async (root) => {
      const io = createVaultStore(root)
      await io.writeStore(storeOf([], "The alpha project context."))
      const raw = readFileSync(vaultPaths(root).summary, "utf8")
      expect(raw).toContain('type: "summary"')
      expect(raw).toContain("The alpha project context.")
      const read = await io.getStore()
      expect(read.summary).toBe("The alpha project context.")
    })
  })
})
