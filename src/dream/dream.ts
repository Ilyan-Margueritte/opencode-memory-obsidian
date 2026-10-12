// Shared DREAM engine for both adapters.
//
// runConsolidation — the exact two-phase commit previously duplicated in
//   src/v1.ts and src/v2.ts: guards (already-committed session, fresh
//   inProgress marker, stale-marker recovery), the consolidation prompt,
//   the second-pass semantic dedup, then the locked applyConsolidation +
//   prune + writeStore commit followed by an explicit pruneAndArchive (the
//   drops are archived, never left as stale active notes), and only
//   afterwards the session timestamp.
//   The model is INJECTED (DreamModel): each adapter wraps its own runtime
//   (V1: headless child session; V2: ctx.generate.text) or the configured
//   openai-compatible endpoint. Every model failure degrades to "failed"
//   without touching the store — memory stays fully usable without a model.
//
// runDreamOrganization — the new organization phase, triggered by the
//   adapters after a committed consolidation and after the recovery sweep:
//     ① dreamed duplicates: pairs of ACTIVE dreamed entries (same scope and
//       project) with a topic clash or similarity ≥ 0.8 — the lower-scored
//       one is removed then archived EXPLICITLY via io.archiveEntries
//       (writeStore is upsert-only). EXPLICIT entries are never touched.
//     ② syncKnowledgeNotes — called WITHOUT holding the vault lock (it does
//       no locking internally and writes atomically; re-entering the lock
//       would deadlock, see the T8 contract).
//     ③ enrichment (optional model): per project with ≥ 3 readable project
//       facts, the model's plain-text synthesis is spliced into the
//       <!-- dream:begin:synthese --> section of the project's Knowledge
//       note. Any failure skips the section only (enriched: false).
//     ④ staleness: ACTIVE, unpinned, non-core facts untouched for more than
//       staleDays are LISTED in Dream/reports/<YYYY-MM-DD>.md as
//       archiving PROPOSITIONS — nothing is ever archived automatically,
//       and the same-day report is rewritten (idempotent).

import { existsSync } from "fs"
import { mkdir, readFile, rename, writeFile } from "fs/promises"
import path from "path"
import {
  applyConsolidation,
  consolidationEntries,
  DAY,
  extractJson,
  isLocalOnly,
  prune,
  readableEntries,
  score,
  similarity,
  topicClash,
  type Entry,
  type LogLevel,
  type Store,
} from "../core.ts"
import type { MemoryConfig } from "../config.ts"
import { pruneAndArchive } from "../memory/lifecycle.ts"
import { syncKnowledgeNotes } from "../knowledge/notes.ts"
import { projectFolderName, type VaultPaths } from "../vault/paths.ts"
import type { VaultIO } from "../vault/vaultStore.ts"
import type { DreamModel } from "./provider.ts"
import { consolidationPrompt, dedupPrompt, enrichmentPrompt } from "./prompts.ts"

export type Log = (level: LogLevel, message: string, extra?: Record<string, unknown>) => void

export type DreamSession = { id: string; directory?: string; title?: string }

export type ConsolidationInput = { transcript: string; messageIDs: string[]; lastTs: number }

export type OrganizationReport = {
  duplicatesArchived: number
  staleProposed: number
  knowledgeUpdated: string[]
  enriched: boolean
}

function now() {
  return Date.now()
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

// Second-pass semantic dedup: the consolidation model may fail to follow the
// "no duplicate of an explicit entry" rule (weak models, cross-language). A
// focused question is asked through the SAME injected model and only
// candidates NOT reported as duplicates survive. Any failure keeps every
// candidate (deterministic guards in applyConsolidation still apply).
async function dedupPass(
  model: DreamModel,
  entries: Entry[],
  candidates: { text: string }[],
  log: Log,
): Promise<Set<number>> {
  const skip = new Set<number>()
  if (candidates.length === 0 || entries.length === 0) return skip
  const entryLines = entries
    .map((e) => `${e.id} | ${e.source} | ${e.category} | ${e.text}`)
    .join("\n")
  const candidateLines = candidates.map((c, i) => `[${i}] ${c.text}`).join("\n")
  try {
    const answer = await model.complete({ prompt: dedupPrompt({ entryLines, candidateLines }), timeoutMs: 90_000 })
    const parsed = extractJson(answer)
    const dups = Array.isArray(parsed?.duplicates) ? parsed.duplicates : []
    for (const d of dups) {
      const idx = Number(d)
      if (Number.isInteger(idx) && idx >= 0 && idx < candidates.length) skip.add(idx)
    }
    log("debug", "dedup check", { candidates: candidates.length, duplicates: skip.size })
  } catch (err) {
    log("debug", "dedup check failed", { error: String(err) })
  }
  return skip
}

export async function runConsolidation(
  io: VaultIO,
  config: MemoryConfig,
  model: DreamModel,
  session: DreamSession,
  input: ConsolidationInput,
  log: Log,
): Promise<"committed" | "skipped" | "failed"> {
  const state = await io.getState()
  // Guard 1: everything the session produced is already consolidated.
  if (input.lastTs <= (state.sessions[session.id] ?? 0)) {
    log("debug", "consolidation skipped: already committed", { sessionID: session.id })
    return "skipped"
  }
  // Guard 2: a consolidation for this session already in progress (and not
  // stale) is skipped. A stale marker means the previous process died
  // mid-consolidation: recover and retry.
  const ip = state.inProgress?.[session.id]
  if (ip) {
    if (now() - ip.startedAt < config.inProgressTimeoutMs) {
      log("debug", "consolidation skipped: already in progress", { sessionID: session.id })
      return "skipped"
    }
    log("debug", "recovering stale inProgress", { sessionID: session.id, startedAt: ip.startedAt })
  }

  const store = await io.getStore()
  // The DREAM pipeline sees exactly what its project allows: global entries
  // plus this session's own project, never local-only facts. The same list
  // feeds the prompt and the dedup pass.
  const visible = consolidationEntries(store, session.directory)
  const entriesBlock =
    visible.length === 0
      ? "(none)"
      : visible
          .map((e) => `- [${e.id}] (${e.scope}/${e.category}, w=${e.weight.toFixed(1)}, source=${e.source}) ${e.text}`)
          .join("\n")

  // Phase 1 of the two-phase commit: record the intent, but do NOT advance
  // the session timestamp yet. It is committed only after the store has
  // actually been updated (phase 2, below). A crash after this point leaves
  // an inProgress marker that the next sweep recovers and retries.
  state.inProgress![session.id] = { targetTs: input.lastTs, startedAt: now() }
  await io.saveState(state)

  try {
    const answer = await model.complete({
      prompt: consolidationPrompt({
        entriesBlock,
        transcript: input.transcript,
        sessionTitle: session.title,
        summary: config.summary,
      }),
      timeoutMs: 120_000,
    })
    if (!answer) throw new Error("consolidation timed out")
    const parsed = extractJson(answer)
    if (!parsed || !Array.isArray(parsed.new)) throw new Error("consolidation returned no usable JSON")
    if (!config.summary) delete parsed.summary

    if (parsed.new.length > 0 && visible.length > 0) {
      const skip = await dedupPass(model, visible, parsed.new, log)
      if (skip.size > 0) {
        log("debug", "dedup applied", { skipped: skip.size })
        parsed.new = parsed.new.filter((_: unknown, index: number) => !skip.has(index))
      }
    }

    // The diff base is captured BEFORE applyConsolidation: consolidation may
    // itself drop entries (model-requested deletes of dreamed facts), and
    // prune() then drops decayed/expired ones. Both reassign fresh.entries,
    // so the array references survive untouched; the drops are archived
    // EXPLICITLY after the lock (archiveEntries takes the lock itself —
    // writeStore alone never archives).
    const { beforeCommit, afterCommit } = await io.withLock(async () => {
      // Fresh read inside the lock so applyConsolidation dedups against the
      // newest on-disk state (another instance may have written meanwhile).
      const fresh = await io.getStore()
      const beforeCommit = fresh.entries
      applyConsolidation(fresh, parsed, session.directory, now(), log, {
        sessionID: session.id,
        messageIDs: input.messageIDs,
      })
      prune(fresh, now(), config.maxEntries)
      const afterCommit = fresh.entries
      await io.writeStore(fresh)
      return { beforeCommit, afterCommit }
    })
    await pruneAndArchive(io, config, beforeCommit, afterCommit)

    // Phase 2: the store is updated, so commit the session timestamp.
    state.sessions[session.id] = input.lastTs
    delete state.inProgress![session.id]
    await io.saveState(state).catch(() => {})
    log("info", "consolidated session", { sessionID: session.id, newFacts: parsed.new.length })
    return "committed"
  } catch (err) {
    log("warn", "consolidation error", { sessionID: session.id, error: String(err) })
    // Remove the inProgress marker on failure too: the session timestamp was
    // not advanced, so the sweep (or the next event) retries immediately.
    delete state.inProgress![session.id]
    await io.saveState(state).catch(() => {})
    return "failed"
  }
}

// ---------------------------------------------------------------------------
// Organization phase
// ---------------------------------------------------------------------------

// Tmp names carry a pid + module-level counter suffix: concurrent writers
// (two plugin instances, the knowledge sync, a vault write) must never share
// one tmp file, or the second rename fails with ENOENT. The bounded retry is
// the same contract as vaultStore's atomicWrite: a concurrent reader holding
// the destination (Windows sharing violation) surfaces as EPERM and is
// retried briefly before giving up.
const atomicWriteSeq = { n: 0 }
async function atomicWrite(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true }).catch(() => {})
  const tmp = `${file}.${process.pid}.${++atomicWriteSeq.n}.tmp`
  await writeFile(tmp, content, "utf8")
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file)
      return
    } catch (error) {
      if (attempt >= 19 || !existsSync(tmp)) throw error
      await sleep(25)
    }
  }
}

// Splice one dream-marked section into a note, preserving every byte outside
// the markers (same contract as the knowledge notes' own splicer). A missing
// section is appended behind exactly one blank line.
function upsertSection(raw: string, section: string, body: string): string {
  const begin = `<!-- dream:begin:${section} -->`
  const end = `<!-- dream:end:${section} -->`
  const block = `${begin}\n${body.trim()}\n${end}`
  const b = raw.indexOf(begin)
  if (b === -1) {
    let base = raw
    if (base.length && !base.endsWith("\n")) base += "\n"
    if (!base.endsWith("\n\n")) base += "\n"
    return `${base}${block}\n`
  }
  const e = raw.indexOf(end, b)
  if (e === -1) return `${raw.slice(0, b)}${block}\n`
  return `${raw.slice(0, b)}${block}${raw.slice(e + end.length)}`
}

// ① Dreamed near-duplicates: both texts say the same thing about the same
// topic (topic clash or similarity ≥ 0.8) — keep the better-scored entry and
// remove the other, whose note is then archived EXPLICITLY via
// io.archiveEntries (writeStore is upsert-only and never archives on drop).
// Only ACTIVE, dreamed entries are considered, within the same scope and
// project; explicit entries (user-stated) are never touched, whatever their
// wording. Returns the store snapshot read under the lock, so the rest of the
// phase needs NO unlocked store read (concurrent unlocked index persists
// from different VaultIO instances can collide on Windows — see the T5
// concurrency note).
async function removeDreamedDuplicates(io: VaultIO, log: Log): Promise<{ archived: number; store: Store }> {
  let droppedIds: string[] = []
  const store = await io.withLock(async () => {
    const fresh = await io.getStore()
    const dreamed = fresh.entries.filter(
      (e) => e.source === "dreamed" && (e.status ?? "ACTIVE") === "ACTIVE" && !isLocalOnly(e),
    )
    const t = now()
    const remove = new Set<string>()
    for (let i = 0; i < dreamed.length; i++) {
      const a = dreamed[i]!
      if (remove.has(a.id)) continue
      for (let j = i + 1; j < dreamed.length; j++) {
        const b = dreamed[j]!
        if (remove.has(b.id)) continue
        // Never pair entries from different scopes/projects: a global fact
        // and a project fact are distinct by design (same policy as writes).
        if (a.scope !== b.scope || a.projectID !== b.projectID) continue
        if (!topicClash(a.text, b.text) && similarity(a.text, b.text) < 0.8) continue
        // Drop the less well rated one; ties keep the oldest fact.
        const drop =
          score(a, t) !== score(b, t)
            ? score(a, t) < score(b, t) ? a : b
            : a.created !== b.created
              ? a.created > b.created ? a : b
              : a.id > b.id ? a : b
        remove.add(drop.id)
        log("info", "dream duplicate archived", {
          kept: drop.id === a.id ? b.id : a.id,
          removed: drop.id,
        })
      }
    }
    if (remove.size > 0) {
      fresh.entries = fresh.entries.filter((e) => !remove.has(e.id))
      fresh.updatedAt = now()
      await io.writeStore(fresh)
      droppedIds = [...remove]
    }
    return fresh
  })
  // The weaker twins were dropped from the store; archive them explicitly —
  // AFTER the lock, because archiveEntries takes it.
  const archived = droppedIds.length
    ? await io.archiveEntries(droppedIds, "duplicate merged by dream organization")
    : 0
  return { archived, store }
}

// ③ Per-project enrichment: 3+ readable project facts → one plain-text
// synthesis spliced into the project's Knowledge note. Failures skip the
// section only; they never compromise the rest of the organization.
async function enrichProjects(store: Store, paths: VaultPaths, model: DreamModel, log: Log): Promise<boolean> {
  let enriched = false
  const byProject = new Map<string, Entry[]>()
  for (const e of store.entries) {
    if (e.scope !== "project" || !e.projectID) continue
    const list = byProject.get(e.projectID) ?? []
    list.push(e)
    byProject.set(e.projectID, list)
  }
  for (const [projectID] of [...byProject.entries()].sort()) {
    // readableEntries: the project's own entries only, never local-only and
    // never another project's — the same privacy policy as every prompt.
    const facts = readableEntries(store, projectID)
      .filter((e) => e.scope === "project" && e.status !== "SUPERSEDED")
      .map((e) => e.text)
    if (facts.length < 3) continue
    try {
      const answer = await model.complete({
        prompt: enrichmentPrompt({ projectName: path.basename(projectID), facts }),
      })
      const text = answer.trim()
      if (!text) continue
      const notePath = path.join(paths.knowledgeProjects, `${projectFolderName(projectID)}.md`)
      const raw = await readFile(notePath, "utf8").catch(() => undefined)
      if (raw === undefined) {
        log("warn", "dream enrichment skipped: knowledge note missing", { projectID })
        continue
      }
      const updated = upsertSection(raw, "synthese", text)
      if (updated !== raw) await atomicWrite(notePath, updated)
      enriched = true
    } catch (err) {
      log("warn", "dream enrichment failed", { projectID, error: String(err) })
    }
  }
  return enriched
}

// ④ Staleness proposals: facts untouched for more than staleDays are listed
// in Dream/reports/<YYYY-MM-DD>.md. A PROPOSITION only — the store is never
// modified — and the same-day report is rewritten (idempotent).
async function writeStalenessReport(store: Store, paths: VaultPaths, staleDays: number, log: Log): Promise<number> {
  const t = now()
  const cutoff = t - staleDays * DAY
  const stale = store.entries
    .filter(
      (e) =>
        (e.status ?? "ACTIVE") === "ACTIVE" &&
        e.pinned !== true &&
        e.tier !== "core" &&
        !isLocalOnly(e) &&
        e.lastSeen < cutoff,
    )
    .sort((a, b) => a.lastSeen - b.lastSeen || (a.id < b.id ? -1 : 1))
  if (stale.length === 0) return 0

  const date = new Date(t).toISOString().slice(0, 10)
  const lines: string[] = []
  lines.push(`# Rapport Dream — ${date}`)
  lines.push("")
  lines.push("## Propositions d'archivage")
  lines.push("")
  lines.push(
    `Faits sans confirmation depuis plus de ${staleDays} jours. Proposition seulement : rien n'est archivé automatiquement. Résoudre avec memory_forget / memory_update.`,
  )
  lines.push("")
  for (const e of stale) {
    const age = Math.round((t - e.lastSeen) / DAY)
    lines.push(`- [${e.id}] ${e.text.replace(/\s*\r?\n\s*/g, " ")} (âge: ${age} j)`)
  }
  lines.push("")
  const file = path.join(paths.dreamReports, `${date}.md`)
  const content = lines.join("\n")
  const raw = await readFile(file, "utf8").catch(() => undefined)
  if (raw === content) return stale.length
  await atomicWrite(file, content)
  log("info", "dream staleness report", { file: path.relative(paths.root, file), proposed: stale.length })
  return stale.length
}

export async function runDreamOrganization(
  io: VaultIO,
  config: MemoryConfig,
  paths: VaultPaths,
  model: DreamModel | undefined,
  log: Log,
): Promise<OrganizationReport> {
  const report: OrganizationReport = { duplicatesArchived: 0, staleProposed: 0, knowledgeUpdated: [], enriched: false }

  // ① dreamed duplicates (locked mutation; explicit entries never touched).
  // The returned snapshot feeds every later step: this phase performs no
  // unlocked store read of its own.
  const { archived, store } = await removeDreamedDuplicates(io, log)
  report.duplicatesArchived = archived

  // ② knowledge notes — deliberately NOT under the vault lock (T8 contract:
  // the sync does its own atomic writes; re-entering the lock would deadlock).
  const sync = await syncKnowledgeNotes(io, paths, store, log)
  report.knowledgeUpdated = sync.updated

  // ③ optional model enrichment.
  if (model) report.enriched = await enrichProjects(store, paths, model, log)

  // ④ staleness proposals (report file only).
  report.staleProposed = await writeStalenessReport(store, paths, config.staleDays, log)

  return report
}
