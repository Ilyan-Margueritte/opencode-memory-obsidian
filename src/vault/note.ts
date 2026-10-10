// Markdown note serialization: one memory = one note, flat YAML frontmatter
// in a fixed key order + the memory text as body. The canonical id lives in
// the frontmatter; the file name is never authoritative. Parsing is tolerant
// (Obsidian may rewrite formats): unknown keys are ignored, dates are accepted
// as ISO datetime, ISO date or epoch-ms numbers, legacy/unknown categories
// fall back to "other" and missing tier/status/sensitivity get the
// normalizeStore defaults. Strings are double-quoted (with \ and " escaped),
// numbers and booleans are bare, timestamps are ISO 8601. Stdlib only — no
// YAML package.

import { CATEGORIES, CORE_CATEGORIES, type Entry } from "../core.ts"

export type ParseResult = { entry: Entry } | { error: string }

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function iso(timestamp: number): string {
  return quote(new Date(timestamp).toISOString())
}

function inlineList(values: string[]): string {
  return `[${values.map(quote).join(", ")}]`
}

export function renderNote(entry: Entry): string {
  const lines: string[] = ["---"]
  lines.push(`id: ${quote(entry.id)}`)
  lines.push(`type: ${quote("memory")}`)
  lines.push(`category: ${quote(entry.category)}`)
  lines.push(`scope: ${quote(entry.scope)}`)
  if (entry.projectID !== undefined) lines.push(`project: ${quote(entry.projectID)}`)
  if (entry.tier !== undefined) lines.push(`tier: ${quote(entry.tier)}`)
  if (entry.pinned !== undefined) lines.push(`pinned: ${entry.pinned}`)
  if (entry.status !== undefined) lines.push(`status: ${quote(entry.status)}`)
  if (entry.sensitivity !== undefined) lines.push(`sensitivity: ${quote(entry.sensitivity)}`)
  lines.push(`weight: ${entry.weight}`)
  if (entry.confidence !== undefined) lines.push(`confidence: ${entry.confidence}`)
  lines.push(`source: ${quote(entry.source)}`)
  if (entry.createdBy !== undefined) lines.push(`createdBy: ${quote(entry.createdBy)}`)
  if (entry.sourceSessionID !== undefined) lines.push(`sourceSession: ${quote(entry.sourceSessionID)}`)
  if (entry.sourceMessageIDs !== undefined) lines.push(`sourceMessages: ${inlineList(entry.sourceMessageIDs)}`)
  lines.push(`created: ${iso(entry.created)}`)
  lines.push(`lastSeen: ${iso(entry.lastSeen)}`)
  if (entry.extractedAt !== undefined) lines.push(`extractedAt: ${iso(entry.extractedAt)}`)
  if (entry.expiresAt !== undefined) lines.push(`expiresAt: ${iso(entry.expiresAt)}`)
  if (entry.lastSurfaced !== undefined) lines.push(`lastSurfaced: ${iso(entry.lastSurfaced)}`)
  if (entry.surfacedCount !== undefined) lines.push(`surfacedCount: ${entry.surfacedCount}`)
  if (entry.useCount !== undefined) lines.push(`useCount: ${entry.useCount}`)
  if (entry.helpfulCount !== undefined) lines.push(`helpfulCount: ${entry.helpfulCount}`)
  if (entry.irrelevantCount !== undefined) lines.push(`irrelevantCount: ${entry.irrelevantCount}`)
  // Knowledge-stage links may be attached to the entry object; render them
  // when present so notes stay forward-compatible.
  const related = (entry as Entry & { related?: string[] }).related
  if (Array.isArray(related)) lines.push(`related: ${inlineList(related)}`)
  lines.push("---")
  return `${lines.join("\n")}\n\n${entry.text}\n`
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  }
  return trimmed
}

function parseTimestamp(value: string): number | undefined {
  if (/^-?\d+$/.test(value)) return Number(value)
  const ts = Date.parse(value)
  return Number.isNaN(ts) ? undefined : ts
}

function parseNumber(value: string): number | undefined {
  if (value === "") return undefined
  const n = Number(value)
  return Number.isNaN(n) ? undefined : n
}

function parseList(value: string): string[] {
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "")
  const out: string[] = []
  for (const m of inner.matchAll(/"((?:[^"\\]|\\.)*)"/g)) out.push(unquote(m[0]))
  return out
}

export function parseNote(raw: string, fileName: string): ParseResult {
  const lines = raw.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return { error: `no frontmatter in ${fileName}` }
  const fields = new Map<string, string>()
  let closed = false
  let i = 1
  for (; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closed = true
      break
    }
    const sep = lines[i].indexOf(": ")
    if (sep === -1) continue
    fields.set(lines[i].slice(0, sep).trim(), lines[i].slice(sep + 2))
  }
  if (!closed) return { error: `unclosed frontmatter in ${fileName}` }
  const id = unquote(fields.get("id") ?? "")
  if (!id) return { error: `missing id in ${fileName}` }
  // Body: everything after the first empty line following the closing fence.
  const rest = lines.slice(i + 1)
  const blank = rest.findIndex((line) => line.trim() === "")
  const bodyLines = blank === -1 ? rest : rest.slice(blank + 1)
  const body = bodyLines.join("\n").trim()
  if (!body) return { error: `empty note body in ${fileName}` }

  const rawCategory = unquote(fields.get("category") ?? "")
  const category = CATEGORIES.includes(rawCategory) ? rawCategory : "other"
  const rawScope = unquote(fields.get("scope") ?? "")
  const scope: Entry["scope"] = rawScope === "project" ? "project" : "global"
  // Missing tier/status/sensitivity get the normalizeStore defaults; invalid
  // values fall back to them too (a hand-edited frontmatter must never
  // produce an ill-typed entry).
  const rawTier = unquote(fields.get("tier") ?? "")
  const tier: Entry["tier"] =
    rawTier === "core" || rawTier === "archival" || rawTier === "temporary"
      ? rawTier
      : CORE_CATEGORIES.has(category)
        ? "core"
        : "archival"
  const rawStatus = unquote(fields.get("status") ?? "")
  const status: Entry["status"] =
    rawStatus === "CONFLICTED" || rawStatus === "SUPERSEDED" ? rawStatus : "ACTIVE"
  const rawSensitivity = unquote(fields.get("sensitivity") ?? "")
  const sensitivity: Entry["sensitivity"] =
    rawSensitivity === "private" || rawSensitivity === "local-only" ? rawSensitivity : "normal"
  const rawSource = unquote(fields.get("source") ?? "")
  const source: Entry["source"] = rawSource === "dreamed" ? "dreamed" : "explicit"
  const rawPinned = unquote(fields.get("pinned") ?? "")
  const pinned = rawPinned === "true" ? true : rawPinned === "false" ? false : undefined
  const number = (key: string) => parseNumber(unquote(fields.get(key) ?? ""))
  const date = (key: string) => parseTimestamp(unquote(fields.get(key) ?? ""))

  const entry: Entry = {
    id,
    text: body,
    category,
    scope,
    weight: number("weight") ?? 1,
    created: date("created") ?? Date.now(),
    lastSeen: date("lastSeen") ?? Date.now(),
    source,
    tier,
    status,
    sensitivity,
  }
  const project = unquote(fields.get("project") ?? "")
  if (project) entry.projectID = project
  if (pinned !== undefined) entry.pinned = pinned
  const confidence = number("confidence")
  if (confidence !== undefined) entry.confidence = confidence
  const createdBy = unquote(fields.get("createdBy") ?? "")
  if (createdBy === "memory_write" || createdBy === "memory_update" || createdBy === "consolidation") {
    entry.createdBy = createdBy
  }
  const session = unquote(fields.get("sourceSession") ?? "")
  if (session) entry.sourceSessionID = session
  const messages = fields.get("sourceMessages")
  if (messages !== undefined) entry.sourceMessageIDs = parseList(messages)
  const extractedAt = date("extractedAt")
  if (extractedAt !== undefined) entry.extractedAt = extractedAt
  const expiresAt = date("expiresAt")
  if (expiresAt !== undefined) entry.expiresAt = expiresAt
  const lastSurfaced = date("lastSurfaced")
  if (lastSurfaced !== undefined) entry.lastSurfaced = lastSurfaced
  const surfacedCount = number("surfacedCount")
  if (surfacedCount !== undefined) entry.surfacedCount = surfacedCount
  const useCount = number("useCount")
  if (useCount !== undefined) entry.useCount = useCount
  const helpfulCount = number("helpfulCount")
  if (helpfulCount !== undefined) entry.helpfulCount = helpfulCount
  const irrelevantCount = number("irrelevantCount")
  if (irrelevantCount !== undefined) entry.irrelevantCount = irrelevantCount
  return { entry }
}
