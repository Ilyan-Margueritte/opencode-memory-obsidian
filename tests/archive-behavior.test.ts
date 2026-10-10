// Task 7 acceptance tests: automatic archiving of removed memories (forget /
// clear go through the vault, so deleted entries become ARCHIVED notes under
// Archives/) and the secret guard on explicit writes/updates (findSecret).
// Harness mirrors tests/tool-regressions.test.ts for both adapter majors.
import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index.ts"
import { createStore } from "../src/store.ts"
import { findSecret } from "../src/memory/redaction.ts"
import { parseNote } from "../src/vault/note.ts"
import { projectFolder, vaultPaths } from "../src/vault/paths.ts"
import { emptyStore, type Entry } from "../src/core.ts"
import { relative } from "node:path"

const directory = "/project-a"

async function harness(major: 1 | 2, dir: string, options: Record<string, unknown> = {}) {
  const config = { dir, dream: false, surface: false, ...options }
  if (major === 1) {
    const instance = await plugin.server({ client: {
      session: {
        get: async () => ({ data: { directory } }),
        messages: async () => ({ data: [] }),
      },
    } }, config) as any
    return {
      call: (name: string, args: Record<string, unknown> = {}) => instance.tool[name].execute(args, { directory, sessionID: "session" }) as Promise<string>,
      dispose: () => instance.dispose(),
    }
  }
  const tools = new Map<string, any>()
  const dispose = await plugin.setup({
    options: config,
    location: { directory },
    tool: {
      transform: async (callback: any) => {
        callback({ add: (tool: any) => tools.set(tool.name, tool) })
        return { dispose: async () => {} }
      },
      list: async () => [...tools.keys()].map((id) => ({ id })),
    },
    session: {
      get: async () => ({ location: { directory } }),
      context: async () => [],
      hook: async (_name: string, callback: any) => callback && { dispose: async () => {} },
    },
  } as any)
  return {
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await tools.get(name).execute(args, { sessionID: "session" })).content as string,
    dispose: async () => { await dispose?.() },
  }
}

async function noteFiles(dir: string, sub: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, sub))).filter((f) => f.toLowerCase().endsWith(".md"))
  } catch {
    return []
  }
}

async function archivedEntries(dir: string) {
  const files = await noteFiles(dir, "Archives")
  const parsed = []
  for (const file of files) {
    const raw = await readFile(join(dir, "Archives", file), "utf8")
    const result = parseNote(raw, join("Archives", file))
    if ("entry" in result) parsed.push(result.entry)
  }
  return parsed
}

for (const major of [1, 2] as const) {
  test(`V${major} memory_forget archives the note under Archives/ with status ARCHIVED`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-archive-forget-"))
    const instance = await harness(major, dir)
    const io = createStore(dir)
    try {
      await instance.call("memory_write", { fact: "The user drinks mate every morning.", category: "preferences" })
      const seeded = await io.getStore()
      const id = seeded.entries[0]!.id
      // The note exists as an active file before the forget.
      expect(await noteFiles(dir, "Global")).toHaveLength(1)

      const answer = await instance.call("memory_forget", { id })
      expect(answer).toBe("Forgot 1 entry.")

      const store = await io.getStore()
      expect(store.entries).toHaveLength(0)
      const archived = await archivedEntries(dir)
      expect(archived).toHaveLength(1)
      expect(archived[0]!.id).toBe(id)
      expect(archived[0]!.text).toBe("The user drinks mate every morning.")
      // "ARCHIVED" is the vault-format marker written on the note (it is
      // deliberately not part of Entry["status"]).
      expect(archived[0]!.status as string).toBe("ARCHIVED")
      expect(await noteFiles(dir, "Global")).toHaveLength(0)
    } finally {
      await instance.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test(`V${major} memory_clear(scope=project) archives only the current project's notes`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-archive-clear-"))
    const instance = await harness(major, dir)
    const io = createStore(dir)
    try {
      // Another project's scoped fact is seeded directly into the vault.
      const other: Entry = {
        id: "bbbbbbbb-2222-4321-8765-abcdefabcdef",
        text: "Project B uses Flask.",
        category: "project",
        scope: "project",
        projectID: "/project-b",
        weight: 3,
        created: Date.now(),
        lastSeen: Date.now(),
        source: "explicit",
        tier: "archival",
        status: "ACTIVE",
        sensitivity: "normal",
      }
      const seed = emptyStore()
      seed.entries = [other]
      seed.updatedAt = Date.now()
      await io.withLock(() => io.writeStore(seed))

      await instance.call("memory_write", { fact: "Project A uses Bun.", category: "project", scope: "project" })
      expect((await io.getStore()).entries).toHaveLength(2)

      const answer = await instance.call("memory_clear", { scope: "project" })
      expect(answer).toBe("Cleared 1 memory entry.")

      const store = await io.getStore()
      expect(store.entries.map((e) => e.text)).toEqual(["Project B uses Flask."])
      const archived = await archivedEntries(dir)
      expect(archived.map((e) => e.text)).toEqual(["Project A uses Bun."])
      expect(archived[0]!.status as string).toBe("ARCHIVED")
      // The other project's note is untouched in its own project folder; the
      // current project's folder no longer holds any active note.
      const paths = vaultPaths(dir)
      const betaNotes = await noteFiles(dir, relative(paths.root, projectFolder(paths, "/project-b")))
      expect(betaNotes).toHaveLength(1)
      expect(betaNotes[0]).toContain("flask")
      const alphaNotes = await noteFiles(dir, relative(paths.root, projectFolder(paths, "/project-a")))
      expect(alphaNotes).toHaveLength(0)
    } finally {
      await instance.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test(`V${major} memory_write refuses a fact that contains a secret`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-archive-secret-"))
    const instance = await harness(major, dir)
    const io = createStore(dir)
    try {
      const answer = await instance.call("memory_write", { fact: "The api key is sk-abc123456789012345678" })
      expect(answer).toMatch(/refused/i)
      // The refusal never echoes the secret back.
      expect(answer).not.toContain("sk-abc123456789012345678")
      const store = await io.getStore()
      expect(store.entries).toHaveLength(0)
      expect(await noteFiles(dir, "Global")).toHaveLength(0)
    } finally {
      await instance.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test(`V${major} memory_update refuses a corrected fact that contains a secret`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-archive-update-"))
    const instance = await harness(major, dir)
    const io = createStore(dir)
    try {
      await instance.call("memory_write", { fact: "Alpha original fact." })
      const answer = await instance.call("memory_update", { match: "Alpha", fact: "password: hunter22" })
      expect(answer).toMatch(/refused/i)
      expect(answer).not.toContain("hunter22")
      const store = await io.getStore()
      expect(store.entries.map((e) => e.text)).toEqual(["Alpha original fact."])
    } finally {
      await instance.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
}

describe("findSecret (secret detection, label only)", () => {
  test("detects every supported credential pattern and returns a distinct label", () => {
    const cases: [string, string][] = [
      ["sk-abc123456789012345678", "api key"],
      [`ghp_${"a".repeat(36)}`, "github token"],
      ["github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234567890", "github token"],
      ["AKIAIOSFODNN7EXAMPLE", "aws access key"],
      ["xoxb-FAKE-TEST-TOKEN-NOT-REAL-0000000000000000000", "slack token"],
      ["glpat-abc123456789012345678", "gitlab token"],
      ["-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----", "private key"],
      ["password: hunter22", "credential assignment"],
      ["api_key=xyz123456", "credential assignment"],
      ["bearer: AbCdEf123456789", "credential assignment"],
    ]
    const labels = new Set<string>()
    for (const [text, kind] of cases) {
      const label = findSecret(text)
      expect(label).toBeDefined()
      expect(label!.toLowerCase()).toContain(kind.split(" ")[0]!)
      expect(label).not.toContain(text)
      labels.add(label!)
    }
    expect(labels.size).toBeGreaterThanOrEqual(6)
  })

  test("never fires on prose that merely mentions credentials", () => {
    for (const text of [
      "The user likes TypeScript.",
      "The token policy is strict",
      "api_key rotation is documented",
      "The user's password manager is 1Password",
      "the access token expires tomorrow",
      "The user rotates their secret regularly",
    ]) {
      expect(findSecret(text)).toBeUndefined()
    }
  })
})
