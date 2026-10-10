// Task 10 acceptance tests: shared Dream consolidation (two-phase commit,
// injectable DreamModel) and the organization phase (dreamed-duplicate
// archiving, knowledge sync, per-project enrichment, staleness proposals).
// Fake models return frozen JSON; every test runs against a temporary vault.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createVaultStore, type VaultIO } from "../src/vault/vaultStore.ts"
import { projectFolderName, vaultPaths } from "../src/vault/paths.ts"
import { parseNote } from "../src/vault/note.ts"
import { runConsolidation, runDreamOrganization } from "../src/dream/dream.ts"
import type { DreamModel } from "../src/dream/provider.ts"
import { resolveConfig } from "../src/config.ts"
import { DAY, emptyStore, type Entry, type LogLevel } from "../src/core.ts"

let seq = 0
function uid(): string {
  return `${String(++seq).padStart(8, "0")}-2222-4222-8222-222222222222`
}

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: uid(),
    text: "The user likes coffee.",
    category: "preferences",
    scope: "global",
    weight: 3,
    created: Date.now(),
    lastSeen: Date.now(),
    source: "dreamed",
    tier: "archival",
    status: "ACTIVE",
    sensitivity: "normal",
    ...overrides,
  }
}

type Step = { json?: unknown; text?: string; fail?: () => Error }

function fakeModel(steps: Step[], prompts: string[] = []): DreamModel {
  let i = 0
  return {
    async complete(request) {
      prompts.push(request.prompt)
      const step = steps[Math.min(i, steps.length - 1)]!
      i++
      const failure = step.fail?.()
      if (failure) throw failure
      if (step.text !== undefined) return step.text
      return JSON.stringify(step.json)
    },
  }
}

const NOOP_LOG = () => {}

function configFor(root: string, extra: Record<string, unknown> = {}) {
  return resolveConfig({ dir: root, staleDays: 90, ...extra }, {})
}

async function withVault(fn: (io: VaultIO, root: string) => Promise<void>) {
  const root = join(tmpdir(), `memory-dream-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  try {
    await fn(createVaultStore(root), root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function seed(io: VaultIO, entries: Entry[]) {
  const store = emptyStore()
  store.entries = entries
  store.updatedAt = Date.now()
  await io.withLock(() => io.writeStore(store))
}

function archivedEntries(root: string) {
  const dir = vaultPaths(root).archives
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .map((file) => parseNote(readFileSync(join(dir, file), "utf8"), file))
    .filter((r) => "entry" in r)
    .map((r) => r.entry)
}

const CONSOLIDATION_JSON = {
  new: [
    { text: "The user prefers concise answers.", category: "preferences", scope: "global", confidence: 0.9 },
  ],
  update: [],
  delete: [],
  conflicts: [],
  summary: "The user prefers concise answers.",
}

describe("runConsolidation (two-phase commit, injectable model)", () => {
  test("commits valid JSON as vault notes and marks the session; a second call with the same lastTs is skipped", async () => {
    await withVault(async (io, root) => {
      const prompts: string[] = []
      const model = fakeModel([{ json: CONSOLIDATION_JSON }], prompts)
      const config = configFor(root)
      const outcome = await runConsolidation(io, config, model, { id: "s1" }, { transcript: "user: hello", messageIDs: ["m1"], lastTs: 100 }, NOOP_LOG)
      expect(outcome).toBe("committed")

      const store = await io.getStore()
      expect(store.entries.map((e) => e.text)).toEqual(["The user prefers concise answers."])
      expect(store.summary).toBe("The user prefers concise answers.")
      const state = await io.getState()
      expect(state.sessions.s1).toBe(100)
      expect(Object.keys(state.inProgress ?? {})).toHaveLength(0)
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain("TRANSCRIPT")

      const outcome2 = await runConsolidation(io, config, model, { id: "s1" }, { transcript: "user: hello", messageIDs: ["m1"], lastTs: 100 }, NOOP_LOG)
      expect(outcome2).toBe("skipped")
      expect((await io.getStore()).entries).toHaveLength(1)
      // The guard short-circuits before any model call: no duplicate, no call.
      expect(prompts).toHaveLength(1)
    })
  })

  test("an interrupted consolidation recovers without duplicates", async () => {
    await withVault(async (io, root) => {
      let inProgressDuringFailure: Record<string, unknown> | undefined
      const model: DreamModel = {
        async complete() {
          inProgressDuringFailure = (await io.getState()).inProgress
          throw new Error("model died mid-flight")
        },
      }
      const config = configFor(root)
      const input = { transcript: "user: hello", messageIDs: ["m1"], lastTs: 200 }
      const first = await runConsolidation(io, config, model, { id: "s1" }, input, NOOP_LOG)
      expect(first).toBe("failed")
      // The inProgress marker WAS written before the model ran (phase 1), and
      // the failure removed it again so the sweep can retry immediately.
      expect(inProgressDuringFailure?.s1).toBeDefined()

      const valid = fakeModel([{
        json: {
          new: [
            { text: "The user prefers morning runs.", category: "preferences", scope: "global" },
            { text: "The deployment target is staging.", category: "status", scope: "global" },
          ],
          update: [],
          delete: [],
          conflicts: [],
        },
      }])
      const second = await runConsolidation(io, config, valid, { id: "s1" }, input, NOOP_LOG)
      expect(second).toBe("committed")

      const store = await io.getStore()
      expect(store.entries.map((e) => e.text).sort()).toEqual([
        "The deployment target is staging.",
        "The user prefers morning runs.",
      ])
      const state = await io.getState()
      expect(state.sessions.s1).toBe(200)
      expect(Object.keys(state.inProgress ?? {})).toHaveLength(0)
    })
  })

  test("memory remains usable without the dream model", async () => {
    await withVault(async (io, root) => {
      const model = fakeModel([{ fail: () => new Error("provider down") }])
      const outcome = await runConsolidation(io, configFor(root), model, { id: "s1" }, { transcript: "user: hello", messageIDs: [], lastTs: 5 }, NOOP_LOG)
      expect(outcome).toBe("failed")
      const store = await io.getStore()
      expect(store.entries).toHaveLength(0)
      expect(store.summary).toBe("")
      const state = await io.getState()
      expect(state.sessions.s1 ?? 0).toBe(0)
    })
  })

  test("facts that look like secrets are ignored, the rest of the batch is kept", async () => {
    await withVault(async (io, root) => {
      const model = fakeModel([{
        json: {
          new: [
            { text: "The api key is sk-abc123456789012345678", category: "environment", scope: "global" },
            { text: "The user likes tea.", category: "preferences", scope: "global" },
          ],
          update: [],
          delete: [],
          conflicts: [],
        },
      }])
      const warnings: string[] = []
      const outcome = await runConsolidation(io, configFor(root), model, { id: "s1" }, { transcript: "user: hello", messageIDs: [], lastTs: 10 }, (_l, message) => {
        if (message.includes("secret")) warnings.push(message)
      })
      expect(outcome).toBe("committed")
      const store = await io.getStore()
      expect(store.entries.map((e) => e.text)).toEqual(["The user likes tea."])
      expect(warnings).toHaveLength(1)
    })
  })
})

describe("runDreamOrganization (duplicates, knowledge, enrichment, staleness)", () => {
  test("archives the lower-scored of two dreamed near-duplicates and never touches explicit pairs", async () => {
    await withVault(async (io, root) => {
      const kept = entry({ text: "The user prefers TypeScript for backend work.", weight: 3 })
      const dropped = entry({ text: "The user prefers TypeScript for backend tasks.", weight: 1 })
      const explicitA = entry({ text: "The user prefers Bun for scripts.", weight: 3, source: "explicit" })
      const explicitB = entry({ text: "The user prefers Bun for scripting.", weight: 1, source: "explicit" })
      await seed(io, [kept, dropped, explicitA, explicitB])

      const report = await runDreamOrganization(io, configFor(root), vaultPaths(root), undefined, NOOP_LOG)
      expect(report.duplicatesArchived).toBe(1)

      const store = await io.getStore()
      expect(store.entries.map((e) => e.id).sort()).toEqual([kept.id, explicitA.id, explicitB.id].sort())
      const archived = archivedEntries(root)
      expect(archived.map((e) => e.id)).toEqual([dropped.id])
      expect(archived[0]!.status as string).toBe("ARCHIVED")
    })
  })

  test("is idempotent: a second run archives nothing and rewrites no knowledge note", async () => {
    await withVault(async (io, root) => {
      const kept = entry({ text: "The user prefers TypeScript for backend work.", weight: 3 })
      const dropped = entry({ text: "The user prefers TypeScript for backend tasks.", weight: 1 })
      await seed(io, [kept, dropped])
      const config = configFor(root)
      const paths = vaultPaths(root)

      const first = await runDreamOrganization(io, config, paths, undefined, NOOP_LOG)
      expect(first.duplicatesArchived).toBe(1)
      expect(first.knowledgeUpdated.length).toBeGreaterThan(0)

      const second = await runDreamOrganization(io, config, paths, undefined, NOOP_LOG)
      expect(second.duplicatesArchived).toBe(0)
      expect(second.knowledgeUpdated).toEqual([])
    })
  })

  test("staleness: old unpinned archival facts are PROPOSED (never archived), pinned and core facts are ignored; the same-day report is rewritten without duplication", async () => {
    await withVault(async (io, root) => {
      const old = Date.now() - 120 * DAY
      const stale = entry({ text: "The user used Vim in 2024.", lastSeen: old, created: old })
      const pinned = entry({ text: "The user's name is Ada.", lastSeen: old, created: old, pinned: true })
      const core = entry({ text: "The user works on compilers.", lastSeen: old, created: old, tier: "core" })
      await seed(io, [stale, pinned, core])
      const config = configFor(root)
      const paths = vaultPaths(root)
      const today = new Date().toISOString().slice(0, 10)
      const reportFile = join(paths.dreamReports, `${today}.md`)

      const report = await runDreamOrganization(io, config, paths, undefined, NOOP_LOG)
      expect(report.staleProposed).toBe(1)
      const raw = readFileSync(reportFile, "utf8")
      expect(raw).toContain("Propositions d'archivage")
      expect(raw).toContain(stale.id)
      expect(raw).not.toContain(pinned.id)
      expect(raw).not.toContain(core.id)

      // Proposal only: the entry stays ACTIVE in the store.
      const store = await io.getStore()
      const stillThere = store.entries.find((e) => e.id === stale.id)
      expect(stillThere?.status).toBe("ACTIVE")

      // Second run the same day: the report is rewritten, never duplicated.
      const again = await runDreamOrganization(io, config, paths, undefined, NOOP_LOG)
      expect(again.staleProposed).toBe(1)
      const raw2 = readFileSync(reportFile, "utf8")
      expect(raw2.split(stale.id).length - 1).toBe(1)
    })
  })

  test("enrichment: the model's project synthesis is spliced into the Knowledge note; a failing model skips it and the report is still rendered", async () => {
    await withVault(async (io, root) => {
      const old = Date.now() - 120 * DAY
      const projectID = "/work/alpha"
      const facts = [
        // Explicit facts: the organization's dreamed-duplicate pass never
        // touches them, so the project keeps its three readable facts.
        entry({ text: "Alpha ships on Fridays.", category: "status", scope: "project", projectID, source: "explicit" }),
        entry({ text: "The stack compiles with Bun.", category: "workflow", scope: "project", projectID, source: "explicit" }),
        entry({ text: "The team meets on Tuesdays.", category: "decisions", scope: "project", projectID, source: "explicit" }),
        entry({ text: "Stale global fact.", lastSeen: old, created: old }),
      ]
      await seed(io, facts)
      const config = configFor(root)
      const paths = vaultPaths(root)
      const notePath = join(paths.knowledgeProjects, `${projectFolderName(projectID)}.md`)
      const prompts: string[] = []
      const model = fakeModel([{ text: "Synthèse: alpha livre le vendredi et stocke ses données dans SQLite." }], prompts)

      const report = await runDreamOrganization(io, config, paths, model, NOOP_LOG)
      expect(report.enriched).toBe(true)
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain("Alpha ships on Fridays.")
      const note = readFileSync(notePath, "utf8")
      expect(note).toContain("<!-- dream:begin:synthese -->")
      expect(note).toContain("Synthèse: alpha livre le vendredi")

      // A failing model skips enrichment but the rest of the organization
      // (knowledge sync + staleness report) still runs.
      const failing = fakeModel([{ fail: () => new Error("enrichment down") }])
      const degraded = await runDreamOrganization(io, config, paths, failing, NOOP_LOG)
      expect(degraded.enriched).toBe(false)
      const noteAfterFailure = readFileSync(notePath, "utf8")
      expect(noteAfterFailure).not.toContain("enrichment down")
      const today = new Date().toISOString().slice(0, 10)
      expect(existsSync(join(paths.dreamReports, `${today}.md`))).toBe(true)
    })
  })
})
