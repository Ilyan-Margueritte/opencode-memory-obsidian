// VaultIO: markdown-backed persistence with the same shape as src/store.ts's
// StoreIO. One memory = one note; the canonical id lives in the frontmatter
// and file↔entry association always goes through it, so manual renames are
// preserved and only brand-new notes receive the canonical file name.
//
// writeStore is UPSERT-ONLY (2.0.2): every write diffs the passed store
// against a fresh disk scan:
//   - identical content        → no-op (manual edits/enrichments are never
//                                clobbered)
//   - content-signature change → previous raw backed up under
//                                .memory/history, then rewritten atomically
//                                (tmp + rename) in place
//   - counter-only change      → rewritten in place, NO backup (exposure
//                                counters churn on every surfacing round
//                                and must never flood the history)
//   - id absent on disk        → new note named noteFileName(id, text)
//   - active disk note absent from the passed store → LEFT UNTOUCHED. With N
//     concurrent instances holding different snapshots, a stale one must
//     never archive the others' entries. Archiving is an EXPLICIT action:
//     archiveEntries(ids, reason), called by the deletion sites only
//     (forget, clear, prune after write/update/consolidation, dream dedup).
//
// A JSON index (.memory/index.json, keyed by path relative to the root with
// mtimeMs + size) caches parsed entries so unchanged files are not re-parsed;
// corrupt or foreign-version indexes fall back to a full rescan. Unparseable
// notes are recorded in files[path].error and ignored.
//
// Cross-instance safety uses the same lockfile + local-queue mechanism as
// src/store.ts, on <root>/.memory/.lock. Like StoreIO, getStore/writeStore do
// not lock themselves: callers wrap multi-step mutations in withLock — and
// archiveEntries takes the lock itself, so it must never be called INSIDE
// another withLock. Stdlib only (fs/path); no YAML package.

import { existsSync } from "fs"
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "fs/promises"
import path from "path"
import { normalizeStore, type Entry, type Store } from "../core.ts"
import { noteFileName, projectFolder, vaultPaths } from "./paths.ts"
import { parseNote, renderNote } from "./note.ts"

export type InProgress = {
  targetTs: number
  startedAt: number
  childID?: string
}

export type State = {
  sessions: Record<string, number>
  inProgress?: Record<string, InProgress>
}

export type VaultIO = {
  withLock<T>(fn: () => Promise<T>): Promise<T>
  getStore(): Promise<Store>
  writeStore(store: Store): Promise<void>
  // Explicit archiving — the ONLY way an active note leaves the vault
  // (writeStore is upsert-only and never archives on drop).
  archiveEntries(ids: string[], reason: string): Promise<number>
  getState(): Promise<State>
  saveState(state: State): Promise<void>
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T
  } catch {
    return fallback
  }
}

// One index entry per scanned note: a parsed entry (cache) or, when the note
// could not be parsed, the recorded error. Missing id/entry on an error line
// is expected.
type IndexedFile = { id?: string; mtimeMs: number; size: number; entry?: Entry; error?: string }

type VaultIndex = { version: 1; files: Record<string, IndexedFile> }

type DiskFile = { abs: string; rel: string; mtimeMs: number; size: number }

type DiskNote = { file: DiskFile; entry: Entry }

// Share a queue across instances using the same vault. The filesystem lock
// still protects against other processes; local callers wait their turn
// without consuming the cross-process lock timeout. (Same mechanism as
// src/store.ts.)
const lockQueues = new Map<string, Promise<void>>()

// Process-wide tmp-name sequence shared by every VaultIO instance: tmp file
// names must be unique across instances, not just within one (see
// atomicWrite below).
const tmpSeqCounter = { n: 0 }

// Stable JSON stringify: object keys sorted recursively and undefined-valued
// keys dropped, so two index maps built in different scan orders (or one
// freshly parsed, the other round-tripped through JSON) still compare equal.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

export function createVaultStore(dataDir: string): VaultIO {
  const paths = vaultPaths(dataDir)

  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = lockQueues.get(paths.lock) ?? Promise.resolve()
    let release!: () => void
    const turn = new Promise<void>((resolve) => { release = resolve })
    lockQueues.set(paths.lock, turn)
    await previous
    try {
      await mkdir(paths.memory, { recursive: true }).catch(() => {})
      let fd: Awaited<ReturnType<typeof open>> | undefined
      for (let i = 0; i < 40; i++) {
        try {
          fd = await open(paths.lock, "wx")
          break
        } catch {
          await sleep(50)
        }
      }
      if (!fd) throw new Error("memory store lock timeout")
      try {
        return await fn()
      } finally {
        await fd.close().catch(() => {})
        await unlink(paths.lock).catch(() => {})
      }
    } finally {
      release()
      if (lockQueues.get(paths.lock) === turn) lockQueues.delete(paths.lock)
    }
  }

  // Unique tmp name: bare getStore() persists the index without taking the
  // lock, so concurrent readers/writers must never share one tmp file (two
  // writers on the same fixed name made the second rename fail with ENOENT).
  // The counter lives at module level: two createVaultStore instances on one
  // directory in the same process would otherwise mint IDENTICAL names
  // (same pid, same per-instance sequence number) and the second rename
  // would fail with ENOENT.
  async function atomicWrite(file: string, content: string) {
    await mkdir(path.dirname(file), { recursive: true }).catch(() => {})
    const tmp = `${file}.${process.pid}.${++tmpSeqCounter.n}.tmp`
    await writeFile(tmp, content, "utf8")
    // Windows: the destination can be momentarily held open by a concurrent
    // reader (bare getStore re-reads index.json/state.json), which surfaces
    // as an EPERM sharing violation on rename. A bounded retry turns that
    // transient case into "last writer wins" without weakening atomicity.
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

  async function writeJson(file: string, value: unknown) {
    await atomicWrite(file, JSON.stringify(value, null, 2))
  }

  // ------------------------------------------------------------------
  // Disk scan + index
  // ------------------------------------------------------------------

  async function scanDir(dir: string, out: DiskFile[]): Promise<void> {
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of dirents) {
      const abs = path.join(dir, d.name)
      if (d.isDirectory()) {
        await scanDir(abs, out)
      } else if (d.isFile() && d.name.toLowerCase().endsWith(".md")) {
        const st = await stat(abs).catch(() => undefined)
        if (!st) continue
        out.push({ abs, rel: path.relative(paths.root, abs), mtimeMs: st.mtimeMs, size: st.size })
      }
    }
  }

  async function scanVault(): Promise<DiskFile[]> {
    const out: DiskFile[] = []
    await scanDir(paths.global, out)
    await scanDir(paths.projects, out)
    return out
  }

  function emptyIndex(): VaultIndex {
    return { version: 1, files: {} }
  }

  async function loadIndex(): Promise<VaultIndex> {
    try {
      const parsed = JSON.parse(await readFile(paths.index, "utf8")) as VaultIndex
      if (parsed && parsed.version === 1 && parsed.files && typeof parsed.files === "object") return parsed
    } catch {
      /* fall through to a full rescan */
    }
    return emptyIndex()
  }

  async function persistIndex(files: Record<string, IndexedFile>) {
    await writeJson(paths.index, { version: 1, files })
  }

  // Fresh recursive scan with index-cached entries reused for unchanged files
  // (same mtimeMs + size). Returns the id→note map and the updated index;
  // files that disappeared are simply absent, so persisting purges them.
  // The loaded index is returned too, so getStore can skip the rewrite when
  // the scan changed nothing.
  async function rescan(): Promise<{
    notes: Map<string, DiskNote>
    index: Record<string, IndexedFile>
    cached: VaultIndex
  }> {
    const disk = await scanVault()
    const cached = await loadIndex()
    const index: Record<string, IndexedFile> = {}
    const notes = new Map<string, DiskNote>()
    for (const file of disk) {
      const hit = cached.files[file.rel]
      if (hit && hit.entry && hit.mtimeMs === file.mtimeMs && hit.size === file.size) {
        index[file.rel] = hit
        notes.set(hit.entry.id, { file, entry: hit.entry })
        continue
      }
      const raw = await readFile(file.abs, "utf8").catch(() => undefined)
      if (raw === undefined) continue
      const parsed = parseNote(raw, file.rel)
      if ("error" in parsed) {
        index[file.rel] = { mtimeMs: file.mtimeMs, size: file.size, error: parsed.error }
        continue
      }
      index[file.rel] = { id: parsed.entry.id, mtimeMs: file.mtimeMs, size: file.size, entry: parsed.entry }
      notes.set(parsed.entry.id, { file, entry: parsed.entry })
    }
    return { notes, index, cached }
  }

  // ------------------------------------------------------------------
  // Store read/write
  // ------------------------------------------------------------------

  function summaryBody(raw: string): string {
    const lines = raw.split(/\r?\n/)
    if (lines[0]?.trim() !== "---") return raw.trim()
    let i = 1
    for (; i < lines.length; i++) if (lines[i].trim() === "---") break
    const rest = lines.slice(i + 1)
    const blank = rest.findIndex((line) => line.trim() === "")
    return (blank === -1 ? rest : rest.slice(blank + 1)).join("\n").trim()
  }

  async function getStore(): Promise<Store> {
    const { notes, index, cached } = await rescan()
    // SURFACE reads run getStore constantly; rewriting the index would mint a
    // tmp file + rename on every read. Persist only when the fresh scan
    // differs from the loaded cache (deep equality through stable JSON).
    if (stableStringify(index) !== stableStringify(cached.files)) await persistIndex(index)
    const entries = [...notes.values()].map((n) => n.entry)
    const raw = await readFile(paths.summary, "utf8").catch(() => undefined)
    const summary = raw === undefined ? "" : summaryBody(raw)
    const updatedAt = entries.length ? Math.max(...entries.map((e) => e.lastSeen)) : 0
    return normalizeStore({ version: 2, summary, updatedAt, entries })
  }

  // The store side is normalized through the same defaults parseNote applies,
  // so a note written earlier is not rewritten forever just because an
  // in-memory entry still carries undefined optional fields. Both sides are
  // then compared field by field with canonical JSON.
  function canonical(entry: Entry): Entry {
    return normalizeStore({ version: 2, summary: "", updatedAt: 0, entries: [{ ...entry }] }).entries[0]
  }

  function sameEntry(disk: Entry, store: Entry): boolean {
    const a = canonical(disk)
    const b = canonical(store)
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) {
      if (JSON.stringify(a[key as keyof Entry]) !== JSON.stringify(b[key as keyof Entry])) return false
    }
    return true
  }

  // Exposure counters (surfacing + usage-feedback bookkeeping) churn on every
  // retrieval round — SURFACE bumps them every few seconds — so they are
  // metadata about RETRIEVAL, not content. A rewrite that only moves them is
  // refreshed in place and never mints a history backup (2.0.2: the backups
  // were the .memory/history flood — one file per counter bump per note).
  // Everything else a note serializes IS content.
  const EXPOSURE_COUNTER_KEYS = new Set([
    "useCount",
    "lastSurfaced",
    "surfacedCount",
    "lastUsed",
    "helpfulCount",
    "irrelevantCount",
  ])

  function contentSignature(entry: Entry): string {
    const c = canonical(entry) as unknown as Record<string, unknown>
    const content: Record<string, unknown> = {}
    for (const key of Object.keys(c)) {
      if (EXPOSURE_COUNTER_KEYS.has(key)) continue
      content[key] = c[key]
    }
    return stableStringify(content)
  }

  // Colons are illegal in Windows file names, hence the replacement.
  function backupName(id: string): string {
    return `${new Date().toISOString().replace(/:/g, "-")}-${id.slice(0, 8)}.md`
  }

  async function backup(raw: string, id: string) {
    if (!raw) return
    await atomicWrite(path.join(paths.history, backupName(id)), raw)
  }

  async function writeNoteFile(entry: Entry, abs: string, index: Record<string, IndexedFile>) {
    const content = renderNote(entry)
    await atomicWrite(abs, content)
    const st = await stat(abs)
    const rel = path.relative(paths.root, abs)
    const parsed = parseNote(content, rel)
    index[rel] =
      "entry" in parsed
        ? { id: parsed.entry.id, mtimeMs: st.mtimeMs, size: st.size, entry: parsed.entry }
        : { id: entry.id, mtimeMs: st.mtimeMs, size: st.size, error: parsed.error }
  }

  async function archiveNote(note: DiskNote, index: Record<string, IndexedFile>, reason: string) {
    const raw = await readFile(note.file.abs, "utf8").catch(() => undefined)
    if (raw === undefined) {
      delete index[note.file.rel]
      return
    }
    await backup(raw, note.entry.id)
    await mkdir(paths.archives, { recursive: true }).catch(() => {})
    const base = path.basename(note.file.abs)
    const stem = base.replace(/\.md$/i, "")
    let target = path.join(paths.archives, base)
    for (let n = 2; existsSync(target); n++) target = path.join(paths.archives, `${stem}-${n}.md`)
    await rename(note.file.abs, target).catch(async () => {
      await atomicWrite(target, raw)
      await unlink(note.file.abs).catch(() => {})
    })
    // The status line is swapped at the NOTE level: ARCHIVED is a
    // vault-format marker (see note.ts NoteStatus), not an Entry status, and
    // the parsed entry always carries a status line to swap. The reason (who
    // archived this and why) is recorded next to the timestamp.
    const archived = renderNote(note.entry).replace(
      /^status: .*$/m,
      `status: "ARCHIVED"\narchivedAt: "${new Date().toISOString()}"\narchivedReason: ${JSON.stringify(reason)}`,
    )
    await atomicWrite(target, archived)
    delete index[note.file.rel]
  }

  async function writeStore(store: Store): Promise<void> {
    const { notes, index } = await rescan()
    for (const entry of store.entries) {
      const existing = notes.get(entry.id)
      if (existing && sameEntry(existing.entry, entry)) continue
      // Updates are written back to the EXISTING file (whatever its name, so
      // manual renames survive); brand-new notes get the canonical name.
      const dir = entry.scope === "project" && entry.projectID ? projectFolder(paths, entry.projectID) : paths.global
      const abs = path.join(dir, existing ? path.basename(existing.file.abs) : noteFileName(entry.id, entry.text))
      if (existing) {
        const raw = await readFile(existing.file.abs, "utf8").catch(() => undefined)
        // Backup only on a CONTENT change: a rewrite that merely moved the
        // exposure counters is refreshed in place (no history backup).
        if (raw !== undefined && contentSignature(existing.entry) !== contentSignature(entry)) {
          await backup(raw, entry.id)
        }
        if (path.relative(existing.file.abs, abs) !== "") {
          // A scope change moved the note to another folder: remove the old
          // file so the id never lives in two places.
          await unlink(existing.file.abs).catch(() => {})
          delete index[existing.file.rel]
        }
      }
      await writeNoteFile(entry, abs, index)
    }
    // UPSERT-ONLY: on-disk active notes absent from the passed store are left
    // untouched. With several instances sharing one vault (one OpenCode
    // project each), any snapshot can be stale; the old archive-on-drop let a
    // stale instance archive the other instances' fresh entries. Archiving
    // now happens exclusively through archiveEntries, at the deletion sites.
    await atomicWrite(
      paths.summary,
      `---\ntype: "summary"\nupdated: "${new Date(store.updatedAt).toISOString()}"\n---\n\n${store.summary}\n`,
    )
    await persistIndex(index)
  }

  // Explicit archiving — the only path from an ACTIVE note to Archives/.
  // Takes the lock itself (never call it inside another withLock) and
  // re-reads fresh from disk, so it archives what is actually on disk now,
  // not what some caller's snapshot happened to contain. Missing or
  // already-archived ids are skipped silently; returns how many notes moved.
  async function archiveEntries(ids: string[], reason: string): Promise<number> {
    if (ids.length === 0) return 0
    return withLock(async () => {
      const { notes, index } = await rescan()
      const wanted = new Set(ids)
      let archived = 0
      for (const note of notes.values()) {
        if (!wanted.has(note.entry.id)) continue
        // Widen to string so the vault-format ARCHIVED marker (never part of
        // Entry's type) can be compared: a manually-moved-back archived note
        // is never archived twice.
        const diskStatus: string | undefined = note.entry.status
        if (diskStatus === "ARCHIVED") continue
        await archiveNote(note, index, reason)
        archived++
      }
      if (archived > 0) await persistIndex(index)
      return archived
    })
  }

  async function getState(): Promise<State> {
    const state = await withLock(() => readJson<State>(paths.state, { sessions: {}, inProgress: {} }))
    state.sessions = state.sessions ?? {}
    state.inProgress = state.inProgress ?? {}
    return state
  }

  async function saveState(state: State) {
    await withLock(() => writeJson(paths.state, state))
  }

  return { withLock, getStore, writeStore, archiveEntries, getState, saveState }
}
