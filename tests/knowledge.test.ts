import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { syncKnowledgeNotes } from "../src/knowledge/notes.ts"
import { createVaultStore } from "../src/vault/vaultStore.ts"
import { noteFileName, projectFolderName, vaultPaths } from "../src/vault/paths.ts"
import type { Entry, LogLevel, Store } from "../src/core.ts"

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

function storeOf(entries: Entry[]): Store {
  return { version: 2, summary: "", updatedAt: 1730000001000, entries }
}

async function withVault(fn: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "memory-knowledge-"))
  try {
    await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// The exact line format the brief mandates for every listed entry:
// - [[<noteFileName sans .md>]] — <texte> (source: <source>, <ISO created>)
function lineOf(e: Entry): string {
  return `- [[${noteFileName(e.id, e.text).replace(/\.md$/, "")}]] — ${e.text} (source: ${e.source}, ${new Date(e.created).toISOString()})`
}

function stemOf(e: Entry): string {
  return noteFileName(e.id, e.text).replace(/\.md$/, "")
}

const decision = () =>
  entry({
    id: "dddddddd-1111-4321-8765-abcdefabcdef",
    text: "We chose Bun over Node for the plugin runtime.",
    category: "decisions",
  })
const preference = () =>
  entry({
    id: "eeeeeeee-2222-4321-8765-abcdefabcdef",
    text: "The user prefers concise answers.",
    category: "preferences",
  })
const statusAlpha = () =>
  entry({
    id: "aaaaaaaa-3333-4321-8765-abcdefabcdef",
    text: "Alpha ships on Fridays.",
    category: "status",
    scope: "project",
    projectID: "C:\\work\\alpha",
  })
const decisionAlpha = () =>
  entry({
    id: "dddddddd-4444-4321-8765-abcdefabcdef",
    text: "Alpha uses SQLite.",
    category: "decisions",
    scope: "project",
    projectID: "C:\\work\\alpha",
  })
const workflowBeta = () =>
  entry({
    id: "bbbbbbbb-5555-4321-8765-abcdefabcdef",
    text: "Beta runs on Docker.",
    category: "workflow",
    scope: "project",
    projectID: "C:\\work\\beta",
  })

// Standard fixture: global + project entries written to the vault so the
// [[...]] link targets point at notes that really exist on disk.
async function setup(root: string) {
  const io = createVaultStore(root)
  const paths = vaultPaths(root)
  const entries = [decision(), preference(), statusAlpha(), decisionAlpha(), workflowBeta()]
  await io.writeStore(storeOf(entries))
  return { io, paths, entries }
}

describe("syncKnowledgeNotes", () => {
  test("creates the three knowledge note types with expected entries and resolvable [[links]]", async () => {
    await withVault(async (root) => {
      const { io, paths, entries } = await setup(root)
      const res = await syncKnowledgeNotes(io, paths, storeOf(entries))

      const decisionsFile = join(paths.knowledge, "decisions.md")
      const preferencesFile = join(paths.knowledge, "preferences.md")
      const noteAlpha = join(paths.knowledgeProjects, `${projectFolderName("C:\\work\\alpha")}.md`)
      const noteBeta = join(paths.knowledgeProjects, `${projectFolderName("C:\\work\\beta")}.md`)
      expect(new Set(res.updated)).toEqual(
        new Set([
          relative(paths.root, decisionsFile),
          relative(paths.root, preferencesFile),
          relative(paths.root, noteAlpha),
          relative(paths.root, noteBeta),
        ]),
      )
      // Every listed entry contributes exactly one [[...]] link; the global
      // category=status entry belongs to no knowledge view.
      expect(res.links).toBe(5)

      const decisions = readFileSync(decisionsFile, "utf8")
      expect(decisions).toContain(lineOf(decision()))
      expect(decisions).toContain("<!-- dream:begin:decisions -->")
      expect(decisions).toContain("<!-- dream:end:decisions -->")
      // Project decisions stay in the project note (strict project isolation).
      expect(decisions).not.toContain("Alpha uses SQLite.")

      expect(readFileSync(preferencesFile, "utf8")).toContain(lineOf(preference()))

      const alpha = readFileSync(noteAlpha, "utf8")
      expect(alpha).toContain("<!-- dream:begin:etat -->")
      expect(alpha).toContain(lineOf(statusAlpha()))
      expect(alpha).toContain("<!-- dream:begin:decisions -->")
      expect(alpha).toContain(lineOf(decisionAlpha()))
      expect(readFileSync(noteBeta, "utf8")).toContain(lineOf(workflowBeta()))

      // The link target of each listed line is the canonical file name of the
      // source memory note — a file actually present in the vault.
      expect(existsSync(join(paths.global, noteFileName(decision().id, decision().text)))).toBe(true)
      expect(existsSync(join(paths.global, noteFileName(preference().id, preference().text)))).toBe(true)
      for (const e of [statusAlpha(), decisionAlpha()]) {
        expect(
          existsSync(
            join(
              paths.projects,
              projectFolderName("C:\\work\\alpha"),
              noteFileName(e.id, e.text),
            ),
          ),
        ).toBe(true)
      }
      expect(existsSync(join(paths.projects, projectFolderName("C:\\work\\beta"), noteFileName(workflowBeta().id, workflowBeta().text)))).toBe(true)
      expect(stemOf(decision())).toBe(noteFileName(decision().id, decision().text).replace(/\.md$/, ""))
    })
  })

  test("second sync is idempotent: updated is empty and content is byte-identical", async () => {
    await withVault(async (root) => {
      const { io, paths, entries } = await setup(root)
      const first = await syncKnowledgeNotes(io, paths, storeOf(entries))
      const decisionsFile = join(paths.knowledge, "decisions.md")
      const preferencesFile = join(paths.knowledge, "preferences.md")
      const noteAlpha = join(paths.knowledgeProjects, `${projectFolderName("C:\\work\\alpha")}.md`)
      const noteBeta = join(paths.knowledgeProjects, `${projectFolderName("C:\\work\\beta")}.md`)
      const before = [decisionsFile, preferencesFile, noteAlpha, noteBeta].map((f) => readFileSync(f, "utf8"))

      const second = await syncKnowledgeNotes(io, paths, storeOf(entries))
      expect(second.updated).toEqual([])
      expect(second.links).toBe(first.links)
      const after = [decisionsFile, preferencesFile, noteAlpha, noteBeta].map((f) => readFileSync(f, "utf8"))
      expect(after).toEqual(before)
      expect(readdirSync(paths.knowledgeProjects)).toHaveLength(2)
    })
  })

  test("manual content outside markers is preserved", async () => {
    await withVault(async (root) => {
      const { io, paths, entries } = await setup(root)
      await syncKnowledgeNotes(io, paths, storeOf(entries))
      const decisionsFile = join(paths.knowledge, "decisions.md")
      const manual = readFileSync(decisionsFile, "utf8")
        .replace("# Décisions\n", "# Décisions\n\nManuel en tête.\n")
      writeFileSync(decisionsFile, `${manual}\n## Notes manuelles\n\nToujours valable.\n`, "utf8")

      const added = entry({
        id: "dddddddd-6666-4321-8765-abcdefabcdef",
        text: "We adopted SQLite for local storage.",
        category: "decisions",
        created: 1730000060000,
      })
      const res = await syncKnowledgeNotes(io, paths, storeOf([...entries, added]))
      expect(res.updated).toContain(relative(paths.root, decisionsFile))

      const content = readFileSync(decisionsFile, "utf8")
      expect(content).toContain("Manuel en tête.")
      expect(content).toContain("Toujours valable.")
      expect(content).toContain(lineOf(decision()))
      expect(content).toContain(lineOf(added))
      expect(content.match(/<!-- dream:begin:decisions -->/g)).toHaveLength(1)
      expect(content.match(/<!-- dream:end:decisions -->/g)).toHaveLength(1)
    })
  })

  test("project isolation: project A note contains only project A entries", async () => {
    await withVault(async (root) => {
      const { io, paths, entries } = await setup(root)
      await syncKnowledgeNotes(io, paths, storeOf(entries))
      const noteAlpha = join(paths.knowledgeProjects, `${projectFolderName("C:\\work\\alpha")}.md`)
      const noteBeta = join(paths.knowledgeProjects, `${projectFolderName("C:\\work\\beta")}.md`)
      const alpha = readFileSync(noteAlpha, "utf8")
      const beta = readFileSync(noteBeta, "utf8")
      expect(alpha).toContain(lineOf(statusAlpha()))
      expect(alpha).toContain(lineOf(decisionAlpha()))
      expect(alpha).not.toContain("Beta runs on Docker.")
      expect(alpha).not.toContain(stemOf(workflowBeta()))
      expect(beta).toContain(lineOf(workflowBeta()))
      expect(beta).not.toContain("Alpha ships on Fridays.")
      expect(beta).not.toContain("Alpha uses SQLite.")
      expect(beta).not.toContain(stemOf(statusAlpha()))
    })
  })

  test("local-only entries are never listed; CONFLICTED entries are mentioned; SUPERSEDED are excluded", async () => {
    await withVault(async (root) => {
      const io = createVaultStore(root)
      const paths = vaultPaths(root)
      const localPref = entry({
        id: "eeeeeeee-7777-4321-8765-abcdefabcdef",
        text: "The user keeps their home address local.",
        category: "preferences",
        sensitivity: "local-only",
      })
      const localAlpha = entry({
        id: "aaaaaaaa-8888-4321-8765-abcdefabcdef",
        text: "Alpha secret env var value.",
        category: "status",
        scope: "project",
        projectID: "C:\\work\\alpha",
        sensitivity: "local-only",
      })
      const conflicted = entry({
        id: "cccccccc-9999-4321-8765-abcdefabcdef",
        text: "We deploy on Thursdays.",
        category: "decisions",
        status: "CONFLICTED",
        created: 1730000050000,
      })
      const superseded = entry({
        id: "cccccccc-aaaa-4321-8765-abcdefabcdef",
        text: "We used Webpack before.",
        category: "decisions",
        status: "SUPERSEDED",
      })
      const normalPref = preference()
      const entries = [localPref, localAlpha, conflicted, superseded, normalPref]
      await io.writeStore(storeOf(entries))
      await syncKnowledgeNotes(io, paths, storeOf(entries))

      const preferences = readFileSync(join(paths.knowledge, "preferences.md"), "utf8")
      expect(preferences).toContain(lineOf(normalPref))
      expect(preferences).not.toContain("home address local")

      const decisions = readFileSync(join(paths.knowledge, "decisions.md"), "utf8")
      expect(decisions).toContain("We deploy on Thursdays.")
      expect(decisions).toContain("(conflit à résoudre)")
      expect(decisions).not.toContain("We used Webpack before.")

      const noteAlpha = join(paths.knowledgeProjects, `${projectFolderName("C:\\work\\alpha")}.md`)
      expect(existsSync(noteAlpha)).toBe(true)
      expect(readFileSync(noteAlpha, "utf8")).not.toContain("Alpha secret env var value.")
    })
  })

  test("empty store creates the two global notes with empty sections and no project notes", async () => {
    await withVault(async (root) => {
      const io = createVaultStore(root)
      const paths = vaultPaths(root)
      const res = await syncKnowledgeNotes(io, paths, storeOf([]))
      expect(res.updated).toEqual([
        relative(paths.root, join(paths.knowledge, "decisions.md")),
        relative(paths.root, join(paths.knowledge, "preferences.md")),
      ])
      expect(res.links).toBe(0)
      const decisions = readFileSync(join(paths.knowledge, "decisions.md"), "utf8")
      expect(decisions).toContain("<!-- dream:begin:decisions -->\n<!-- dream:end:decisions -->")
      expect(existsSync(paths.knowledgeProjects)).toBe(false)
    })
  })

  test("missing section markers are re-appended and manual content survives; a warning is logged", async () => {
    await withVault(async (root) => {
      const { io, paths, entries } = await setup(root)
      await syncKnowledgeNotes(io, paths, storeOf(entries))
      const preferencesFile = join(paths.knowledge, "preferences.md")
      const stripped = readFileSync(preferencesFile, "utf8")
        .replace("<!-- dream:begin:preferences -->\n", "")
        .replace("<!-- dream:end:preferences -->\n", "")
      writeFileSync(preferencesFile, `${stripped}\nManuel au milieu.\n`, "utf8")

      const calls: { level: LogLevel; message: string; extra?: Record<string, unknown> }[] = []
      const log = (level: LogLevel, message: string, extra?: Record<string, unknown>) => {
        calls.push({ level, message, extra })
      }
      const res = await syncKnowledgeNotes(io, paths, storeOf(entries), log)
      expect(res.updated).toContain(relative(paths.root, preferencesFile))

      const content = readFileSync(preferencesFile, "utf8")
      expect(content).toContain("Manuel au milieu.")
      expect(content).toContain(lineOf(preference()))
      expect(content).toContain("<!-- dream:begin:preferences -->")
      expect(content).toContain("<!-- dream:end:preferences -->")
      expect(calls.some((c) => c.level === "warn" && c.extra?.["section"] === "preferences")).toBe(true)
    })
  })
})
