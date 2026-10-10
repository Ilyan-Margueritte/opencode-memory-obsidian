// Derived Obsidian views ("Knowledge notes"): organized, regenerable notes
// built FROM the memory notes — never a second source of truth (the memory
// notes stay canonical; deleting a Knowledge note is always safe). Three file
// types, one syncKnowledgeNotes call:
//
//   Knowledge/decisions.md    — global-scope entries, category=decisions
//   Knowledge/preferences.md  — global-scope entries, category=preferences
//   Knowledge/projects/<projectFolderName(projectID)>.md — THIS project's
//       project-scoped entries only, split into an "etat" section (the
//       project's living state) and a "decisions" section, so every project
//       entry appears exactly once.
//
// Scope/privacy policy goes through readableEntries() (single source of
// truth): project facts stay in their project note (strict project
// isolation) and local-only entries are NEVER listed anywhere. SUPERSEDED
// tombstones (replaced facts awaiting prune) are excluded as they are not
// current knowledge; CONFLICTED entries stay visible with a
// "(conflit à résoudre)" mention so the user resolves them.
//
// Generated content lives exclusively between
//   <!-- dream:begin:<section> --> / <!-- dream:end:<section> -->
// markers. Manual content outside markers is preserved byte-for-byte (the
// existing file is read and only the marked sections are spliced); header +
// intro are written at creation only. Missing markers on an existing file
// are re-appended (with a warning) so Dream can always regenerate.
//
// Idempotence: the same store produces byte-identical files, and unchanged
// files are not rewritten at all (second sync → updated: []).
//
// Writes are atomic (tmp + rename), like vaultStore. The vault lock is
// deliberately NOT taken here: Dream organization calls this after (or
// while) holding io.withLock for the store commit, and re-entering withLock
// would deadlock; derived views are safe with atomic last-writer-wins.
// The `io` parameter stays in the signature for interface stability (callers
// may wrap the call in io.withLock when they know they don't hold it).
// Stdlib only (fs/path); no new dependency.

import { mkdir, readFile, rename, writeFile } from "fs/promises"
import path from "path"
import { readableEntries, type Entry, type LogLevel, type Store } from "../core.ts"
import { noteFileName, projectFolderName, type VaultPaths } from "../vault/paths.ts"
import type { VaultIO } from "../vault/vaultStore.ts"

export type KnowledgeSyncResult = { updated: string[]; links: number }

export type KnowledgeLog = (level: LogLevel, message: string, extra?: Record<string, unknown>) => void

const DECISIONS = "decisions"
const PREFERENCES = "preferences"
const ETAT = "etat"

// One list item per entry: "[[note-file-stem]] — text (source: <source>,
// <ISO created>)". The [[...]] target is the canonical file name (without
// extension) of the source memory note, so the link resolves inside the
// vault. Text is flattened to one line so the list structure survives
// multi-line memories.
function line(entry: Entry): string {
  const stem = noteFileName(entry.id, entry.text).replace(/\.md$/i, "")
  const text = entry.text.replace(/\s*\r?\n\s*/g, " ").trim()
  const mention = entry.status === "CONFLICTED" ? " (conflit à résoudre)" : ""
  return `- [[${stem}]] — ${text} (source: ${entry.source}, ${new Date(entry.created).toISOString()})${mention}`
}

// Deterministic section order: oldest first, id as tie-break, so the same
// entries always render identically regardless of store order.
function sectionEntries(entries: Entry[]): Entry[] {
  return entries
    .filter((e) => e.status !== "SUPERSEDED")
    .sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1))
}

function sectionBody(entries: Entry[]): string {
  return entries.map(line).join("\n") + (entries.length ? "\n" : "")
}

function sectionBlock(section: string, entries: Entry[]): string {
  return `<!-- dream:begin:${section} -->\n${sectionBody(entries)}<!-- dream:end:${section} -->`
}

// Fresh file: header + intro, then the marked sections. Written once; later
// syncs only splice the marked sections and never touch this scaffold.
function renderCreated(title: string, intro: string, sections: { section: string; entries: Entry[] }[]): string {
  let content = `# ${title}\n\n${intro}\n`
  for (const s of sections) content += `\n${sectionBlock(s.section, s.entries)}\n`
  return content
}

// Splice one marked section into existing content, preserving every byte
// outside the markers. A missing section is (re-)appended at the end behind
// exactly one blank line; an unterminated begin marker runs to end of file.
function spliceSection(raw: string, section: string, entries: Entry[]): string {
  const begin = `<!-- dream:begin:${section} -->`
  const end = `<!-- dream:end:${section} -->`
  const block = sectionBlock(section, entries)
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

// Tmp names carry a pid + module-level counter suffix so concurrent writers
// (two syncs, or another atomic writer on the same note) never share one tmp
// file — with a bare fixed name the second rename fails with ENOENT.
const atomicWriteSeq = { n: 0 }
async function atomicWrite(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true }).catch(() => {})
  const tmp = `${file}.${process.pid}.${++atomicWriteSeq.n}.tmp`
  await writeFile(tmp, content, "utf8")
  await rename(tmp, file)
}

// Write one knowledge note if (and only if) its content changed. Returns the
// number of [[...]] links the note now lists.
async function syncNote(
  abs: string,
  rel: string,
  title: string,
  intro: string,
  sections: { section: string; entries: Entry[] }[],
  updated: string[],
  log?: KnowledgeLog,
): Promise<number> {
  const raw = await readFile(abs, "utf8").catch(() => undefined)
  const links = sections.reduce((n, s) => n + s.entries.length, 0)
  let content: string
  if (raw === undefined) {
    content = renderCreated(title, intro, sections)
  } else {
    content = raw
    for (const s of sections) {
      if (!raw.includes(`<!-- dream:begin:${s.section} -->`)) {
        log?.("warn", "knowledge section markers missing; appended", {
          file: path.basename(abs),
          section: s.section,
        })
      }
      content = spliceSection(content, s.section, s.entries)
    }
  }
  if (content === raw) return links
  await atomicWrite(abs, content)
  updated.push(rel)
  log?.("debug", raw === undefined ? "knowledge note created" : "knowledge note updated", { file: rel, links })
  return links
}

export async function syncKnowledgeNotes(
  io: VaultIO,
  paths: VaultPaths,
  store: Store,
  log?: KnowledgeLog,
): Promise<KnowledgeSyncResult> {
  void io
  const updated: string[] = []
  const rel = (abs: string) => path.relative(paths.root, abs)

  // Global views: readableEntries(store, undefined) keeps global entries
  // only and applies the local-only exclusion — project facts stay in the
  // project notes (strict project isolation).
  const globalEntries = readableEntries(store, undefined)
  const intro =
    "Vue dérivée régénérée par le Dream ; les notes mémoire restent la source de vérité. " +
    "Contenu généré uniquement entre les marqueurs — le texte manuel hors marqueurs est préservé."
  const links =
    (await syncNote(
      path.join(paths.knowledge, "decisions.md"),
      rel(path.join(paths.knowledge, "decisions.md")),
      "Décisions",
      `Décisions mémorisées à portée globale. ${intro}`,
      [{ section: DECISIONS, entries: sectionEntries(globalEntries.filter((e) => e.category === DECISIONS)) }],
      updated,
      log,
    )) +
    (await syncNote(
      path.join(paths.knowledge, "preferences.md"),
      rel(path.join(paths.knowledge, "preferences.md")),
      "Préférences",
      `Préférences mémorisées à portée globale. ${intro}`,
      [{ section: PREFERENCES, entries: sectionEntries(globalEntries.filter((e) => e.category === PREFERENCES)) }],
      updated,
      log,
    ))

  // Project views: one note per project with project-scoped entries (even if
  // every entry is filtered out — the note structure stays stable). Only THIS
  // project's entries, via the same visibility policy; "etat" carries the
  // living project state, "decisions" the project's decisions.
  const byProject = new Map<string, Entry[]>()
  for (const e of store.entries) {
    if (e.scope !== "project" || !e.projectID) continue
    const list = byProject.get(e.projectID) ?? []
    list.push(e)
    byProject.set(e.projectID, list)
  }
  let projectLinks = 0
  for (const projectID of [...byProject.keys()].sort()) {
    const listed = sectionEntries(
      readableEntries(store, projectID).filter((e) => e.scope === "project"),
    )
    const abs = path.join(paths.knowledgeProjects, `${projectFolderName(projectID)}.md`)
    projectLinks += await syncNote(
      abs,
      rel(abs),
      path.basename(projectID) || projectID,
      `État et décisions du projet. ${intro}`,
      [
        { section: ETAT, entries: listed.filter((e) => e.category !== DECISIONS) },
        { section: DECISIONS, entries: listed.filter((e) => e.category === DECISIONS) },
      ],
      updated,
      log,
    )
  }

  return { updated, links: links + projectLinks }
}
