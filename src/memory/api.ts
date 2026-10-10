// Shared user-facing tool logic for both adapters (V1 and V2). The adapters
// keep the tool DEFINITIONS (schemas, descriptions) and delegate every
// execute() here, so the nine tools behave byte-identically regardless of the
// runtime that hosts them.
//
// Persistence goes through the VaultIO boundary (io.withLock / getStore /
// writeStore); the scope & privacy policy stays in core.ts — every read and
// every mutation below operates on readableEntries()/readQuery() output, so
// project isolation and the local-only exclusion cannot drift between
// adapters. Secrets are refused on explicit writes/updates (findSecret); the
// refusal message carries the pattern LABEL only, never the value.

import {
  addEntry,
  applyIrrelevantFeedback,
  applyUsefulFeedback,
  clearProjectEntries,
  DAY,
  findSimilar,
  findWritableTarget,
  KEYWORD_BONUS,
  prune,
  readQuery,
  readableEntries,
  score,
  type Entry,
  type RankedMemory,
} from "../core.ts"
import type { MemoryConfig } from "../config.ts"
import type { VaultIO } from "../vault/vaultStore.ts"
import { findSecret } from "./redaction.ts"

export type ToolContext = {
  directory?: string
  sessionID?: string
  lastSurface?: Map<string, RankedMemory[]>
}

function now() {
  return Date.now()
}

function refused(label: string): string {
  return `Refused: this fact appears to contain a secret (${label}). Secrets are never stored in long-term memory.`
}

export async function memoryRead(
  io: VaultIO,
  config: MemoryConfig,
  ctx: ToolContext,
  args: { query?: string; category?: string; scope?: "global" | "project" },
): Promise<string> {
  const store = await io.getStore()
  const hits = readQuery(store, ctx.directory, {
    query: args.query ? String(args.query) : undefined,
    category: args.category ? String(args.category) : undefined,
    scope: args.scope === "project" ? "project" : args.scope === "global" ? "global" : undefined,
  })
  if (hits.length === 0) return "No memory entries found."
  return [
    config.summary && store.summary ? `Summary: ${store.summary}` : null,
    ...hits.map((e) => `- [${e.id}] (${e.scope}/${e.category}, ${e.source}) ${e.text}`),
  ]
    .filter(Boolean)
    .join("\n")
}

export async function memoryWrite(
  io: VaultIO,
  config: MemoryConfig,
  ctx: ToolContext,
  args: {
    fact: string
    category?: string
    scope?: "global" | "project"
    tier?: "core" | "archival" | "temporary"
    ttlHours?: number
    pinned?: boolean
    sensitivity?: "normal" | "private" | "local-only"
  },
): Promise<string> {
  const text = String(args.fact ?? "").trim()
  if (!text) return "No fact provided."
  const secret = findSecret(text)
  if (secret) return refused(secret)
  const scope: Entry["scope"] = args.scope === "project" ? "project" : "global"
  const tier: Entry["tier"] = args.tier === "temporary" || args.tier === "archival" || args.tier === "core" ? args.tier : undefined
  const sensitivity: Entry["sensitivity"] =
    args.sensitivity === "private" || args.sensitivity === "local-only" ? args.sensitivity : undefined
  const expiresAt =
    tier === "temporary"
      ? now() + Number(args.ttlHours ?? 24) * 60 * 60 * 1000
      : undefined
  let status = ""
  await io.withLock(async () => {
    const fresh = await io.getStore()
    // Rewrite targeting is scoped: a write can only refresh an entry
    // in the SAME scope (and same project). Cross-scope equivalents
    // coexist by design. Normal writes never target local-only
    // entries; a local-only write may refresh a previous local-only
    // one (prevents duplicate accumulation without exposing them).
    const existing = findWritableTarget(fresh.entries, text, scope, ctx.directory, sensitivity === "local-only")
    if (existing) {
      existing.text = text
      existing.source = "explicit"
      existing.weight = Math.min(4, existing.weight + 0.5)
      existing.lastSeen = now()
      existing.createdBy = "memory_write"
      existing.confidence = 1
      if (tier) existing.tier = tier
      if (existing.tier !== "temporary") existing.expiresAt = undefined
      if (args.pinned === true) existing.pinned = true
      if (args.pinned === false) existing.pinned = false
      if (sensitivity) existing.sensitivity = sensitivity
      if (args.category) existing.category = String(args.category)
      if (scope === "project" && !existing.projectID) existing.projectID = ctx.directory
      if (existing.status === "CONFLICTED") {
        existing.status = "ACTIVE"
        existing.conflictEvidence = undefined
        existing.conflictAt = undefined
        status = " (conflict resolved)"
      }
    } else {
      addEntry(fresh, {
        text,
        category: String(args.category ?? "other"),
        scope,
        projectID: scope === "project" ? ctx.directory : undefined,
        weight: 3,
        lastSeen: now(),
        source: "explicit",
        created: now(),
        createdBy: "memory_write",
        confidence: 1,
        tier: tier ?? (String(args.category ?? "other") === "other" ? "archival" : "core"),
        pinned: args.pinned === true ? true : undefined,
        expiresAt,
        sensitivity: sensitivity ?? "normal",
      })
    }
    fresh.updatedAt = now()
    prune(fresh, now(), config.maxEntries)
    await io.writeStore(fresh)
  })
  return `Remembered (${scope})${status}: ${text}`
}

export async function memoryUpdate(
  io: VaultIO,
  _config: MemoryConfig,
  ctx: ToolContext,
  args: { id?: string; match?: string; fact: string },
): Promise<string> {
  const fact = String(args.fact ?? "").trim()
  if (!fact) return "No fact provided."
  const secret = findSecret(fact)
  if (secret) return refused(secret)
  let updated = 0
  let resolvedConflict = false
  await io.withLock(async () => {
    const fresh = await io.getStore()
    const visible = readableEntries(fresh, ctx.directory)
    const target = args.id
      ? visible.find((e) => e.id === args.id)
      : args.match
        ? findSimilar(visible, String(args.match))
        : undefined
    if (target) {
      target.text = fact
      target.weight = Math.min(4, target.weight + 0.5)
      target.lastSeen = now()
      if (target.status === "CONFLICTED") {
        target.status = "ACTIVE"
        target.conflictEvidence = undefined
        target.conflictAt = undefined
        resolvedConflict = true
      }
      updated = 1
    }
    fresh.updatedAt = now()
    await io.writeStore(fresh)
  })
  return updated ? `Updated: ${fact}${resolvedConflict ? " (conflict resolved)" : ""}` : "No matching entry found."
}

export async function memoryWhy(
  io: VaultIO,
  _config: MemoryConfig,
  ctx: ToolContext,
  args: { id: string },
): Promise<string> {
  const store = await io.getStore()
  const e = readableEntries(store, ctx.directory).find((x) => x.id === args.id)
  if (!e) return "No memory entry with this id."
  const t = now()
  const days = Math.max(0, (t - e.lastSeen) / DAY)
  const decay = Math.exp(-days / 45)
  const base = score(e, t)
  const lines: string[] = []
  lines.push(`Text: ${e.text}`)
  lines.push(`Source: ${e.source}${e.createdBy ? ` (via ${e.createdBy})` : ""}`)
  lines.push(`Category: ${e.category} | Scope: ${e.scope}${e.projectID ? ` | project: ${e.projectID}` : ""}`)
  if (e.source === "dreamed") {
    lines.push(`Extracted: ${e.extractedAt ? new Date(e.extractedAt).toISOString() : "unknown"}`)
    if (e.sourceSessionID) lines.push(`From session: ${e.sourceSessionID}`)
    if (e.sourceMessageIDs?.length) lines.push(`From messages: ${e.sourceMessageIDs.join(", ")}`)
    if (e.confidence !== undefined) lines.push(`Confidence: ${(e.confidence * 100).toFixed(0)}%`)
  } else {
    lines.push(`Stated directly by the user (${e.created ? new Date(e.created).toISOString() : "date unknown"})`)
  }
  lines.push(
    `Lifecycle: ${e.status ?? "ACTIVE"}${e.pinned ? " | pinned (no decay)" : ""}${e.tier ? ` | tier ${e.tier}` : ""}${
      e.expiresAt ? ` | expires ${new Date(e.expiresAt).toISOString()}` : ""
    }`,
  )
  if (e.status === "CONFLICTED") {
    lines.push(`Conflict: flagged on ${e.conflictAt ? new Date(e.conflictAt).toISOString() : "?"}`)
    lines.push(`Evidence: ${e.conflictEvidence ?? "—"}`)
    lines.push("Resolve it with memory_update (new fact) or memory_write (rewrite).")
  }
  lines.push(`Weight: ${e.weight.toFixed(2)} (base importance, never decayed in place)`)
  lines.push(
    `Usage: surfaced ${e.surfacedCount ?? 0}x (last ${e.lastSurfaced ? new Date(e.lastSurfaced).toISOString() : "never"}), helpful ${e.helpfulCount ?? 0}, irrelevant ${e.irrelevantCount ?? 0}`,
  )
  lines.push(
    `Score (now): ${base.toFixed(3)} = (${e.weight.toFixed(2)} + source bonus + utilization) × decay ${decay.toFixed(3)} (age since last confirmation ${Math.round(days)}d)`,
  )
  for (const [sid, ranked] of ctx.lastSurface ?? []) {
    const hit = ranked.find((r) => r.entry.id === e.id)
    if (hit) {
      lines.push(`Last surfacing (session ${sid}):`)
      lines.push(`  Base score: ${hit.base.toFixed(2)}`)
      lines.push(`  Keyword match: ${hit.keywordHits > 0 ? `+${hit.keywordHits * KEYWORD_BONUS} (${hit.keywordHits} hits)` : "+0"}`)
      lines.push(`  Core slot: ${hit.core ? "yes" : "no"}`)
      lines.push(`  Final rank: #${hit.rank}`)
    }
  }
  lines.push(`Sensitivity: ${e.sensitivity ?? "normal"}`)
  return lines.join("\n")
}

export async function memoryInspect(
  io: VaultIO,
  config: MemoryConfig,
  ctx: ToolContext,
  args: { show?: "stats" | "recent" | "conflicts" | "project" | "surfaced"; limit?: number },
): Promise<string> {
  const store = await io.getStore()
  // Every view operates on the readable subset: global + current
  // project, never local-only, never another project's entries.
  const s = readableEntries(store, ctx.directory)
  const show = args.show ?? "stats"
  const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10)))
  const out: string[] = []
  if (show === "stats") {
    const explicit = s.filter((e) => e.source === "explicit").length
    const dreamed = s.filter((e) => e.source === "dreamed").length
    const global = s.filter((e) => e.scope === "global").length
    const project = s.filter((e) => e.scope === "project").length
    const core = s.filter((e) => e.tier === "core").length
    const archival = s.filter((e) => e.tier === "archival").length
    const temporary = s.filter((e) => e.tier === "temporary").length
    const pinned = s.filter((e) => e.pinned).length
    const conflicted = s.filter((e) => e.status === "CONFLICTED").length
    const superseded = s.filter((e) => e.status === "SUPERSEDED").length
    const privateCount = s.filter((e) => e.sensitivity === "private").length
    const avgChars = s.length ? Math.round(s.reduce((a, e) => a + e.text.length, 0) / s.length) : 0
    const catCounts = new Map<string, number>()
    for (const e of s) catCounts.set(e.category, (catCounts.get(e.category) ?? 0) + 1)
    out.push("OpenCode Memory (visible in this project)")
    out.push("")
    out.push(`Stored: ${s.length}   Explicit: ${explicit}   Dreamed: ${dreamed}`)
    out.push(`Global: ${global}   Project: ${project}`)
    out.push(`Tier: core ${core} | archival ${archival} | temporary ${temporary} | pinned ${pinned}`)
    out.push(`Status: conflicted ${conflicted} | superseded (tombstones) ${superseded}`)
    out.push(`Sensitivity: private ${privateCount}`)
    out.push(`Categories: ${[...catCounts.entries()].map(([c, n]) => `${c} ${n}`).join(", ")}`)
    const summaryChars = config.summary ? store.summary.length : 0
    out.push(`Summary: ${config.summary ? `${summaryChars} chars` : "disabled"}   Avg fact: ${avgChars} chars   Est. full context cost: ${Math.round((summaryChars + s.reduce((a, e) => a + e.text.length, 0)) / 4)} tokens`)
    const totalSurface = [...(ctx.lastSurface?.values() ?? [])].reduce((a, r) => a + r.length, 0)
    out.push(`Surfaced in last prompts: ${totalSurface}/${s.length}`)
    out.push("(local-only entries are never listed here; manage them via the files in the memory dir)")
  } else if (show === "recent") {
    const list = [...s].sort((a, b) => b.created - a.created).slice(0, limit)
    out.push(`Recent ${list.length} entries:`)
    for (const e of list) {
      out.push(`- [${e.id}] (${e.scope}/${e.category}, ${e.source}${e.status === "CONFLICTED" ? ", conflicted" : ""}) ${e.text}`)
    }
  } else if (show === "conflicts") {
    const list = s.filter((e) => e.status === "CONFLICTED")
    if (list.length === 0) {
      out.push("No conflicts awaiting resolution.")
    } else {
      out.push(`${list.length} conflicted explicit memor${list.length === 1 ? "y" : "ies"} (resolve with memory_update):`)
      for (const e of list) {
        out.push(`- [${e.id}] ${e.text}`)
        out.push(`  evidence: ${e.conflictEvidence ?? "—"} (flagged ${e.conflictAt ? new Date(e.conflictAt).toISOString() : "?"})`)
      }
    }
  } else if (show === "project") {
    const dir = ctx.directory
    const list = s.filter((e) => e.scope === "project" && e.projectID === dir).slice(0, limit)
    out.push(`Project entries (directory: ${dir ?? "unknown"}) — ${list.length}/${s.filter((e) => e.scope === "project").length}:`)
    for (const e of list) {
      out.push(`- [${e.id}] (${e.category}, ${e.source}) ${e.text}`)
    }
  } else if (show === "surfaced") {
    const sid = ctx.sessionID ?? ""
    const ranked = ctx.lastSurface?.get(sid)
    if (!ranked || ranked.length === 0) {
      out.push("No memory surfaced for this session yet. Send a message to trigger retrieval.")
    } else {
      out.push(`Why was this memory surfaced? (session ${sid}, latest retrieval)`)
      out.push("")
      for (const r of ranked) {
        const e = r.entry
        out.push(`Memory: "${e.text}"`)
        out.push(`  Base score:      ${r.base.toFixed(2)}`)
        out.push(`  Keyword match:   ${r.keywordHits > 0 ? `+${(r.keywordHits * KEYWORD_BONUS).toFixed(2)} (${r.keywordHits} hits)` : "+0.00"}`)
        out.push(`  Core bonus:      ${r.core ? "yes" : "no"}`)
        out.push(`  Final rank:      #${r.rank}`)
        out.push("")
      }
    }
  }
  return out.join("\n")
}

export async function memoryUseful(
  io: VaultIO,
  _config: MemoryConfig,
  ctx: ToolContext,
  args: { id: string },
): Promise<string> {
  let ok = false
  await io.withLock(async () => {
    const fresh = await io.getStore()
    const visible = readableEntries(fresh, ctx.directory)
    if (!visible.some((e) => e.id === args.id)) return
    ok = applyUsefulFeedback(fresh, args.id, now())
    if (ok) {
      fresh.updatedAt = now()
      await io.writeStore(fresh)
    }
  })
  return ok ? "Noted as useful." : "No memory entry with this id."
}

export async function memoryIrrelevant(
  io: VaultIO,
  _config: MemoryConfig,
  ctx: ToolContext,
  args: { id: string },
): Promise<string> {
  let ok = false
  await io.withLock(async () => {
    const fresh = await io.getStore()
    const visible = readableEntries(fresh, ctx.directory)
    if (!visible.some((e) => e.id === args.id)) return
    ok = applyIrrelevantFeedback(fresh, args.id, now())
    if (ok) {
      fresh.updatedAt = now()
      await io.writeStore(fresh)
    }
  })
  return ok ? "Noted as irrelevant." : "No memory entry with this id."
}

// Removal = entry retraction + writeStore: the vault layer moves the orphaned
// note under Archives/ with status ARCHIVED (nothing is ever silently
// deleted). The user-visible message is unchanged.
export async function memoryForget(
  io: VaultIO,
  _config: MemoryConfig,
  ctx: ToolContext,
  args: { id?: string; match?: string },
): Promise<string> {
  let removed = 0
  await io.withLock(async () => {
    const fresh = await io.getStore()
    const forgettable = new Set(readableEntries(fresh, ctx.directory).map((e) => e.id))
    const before = fresh.entries.length
    fresh.entries = fresh.entries.filter((e) => {
      if (!forgettable.has(e.id)) return true
      if (args.id && e.id === args.id) return false
      if (args.match) {
        const m = String(args.match).toLowerCase()
        if (m.length > 3 && e.text.toLowerCase().includes(m)) return false
      }
      return true
    })
    removed = before - fresh.entries.length
    if (removed) fresh.summary = ""
    fresh.updatedAt = now()
    await io.writeStore(fresh)
  })
  return removed ? `Forgot ${removed} entr${removed === 1 ? "y" : "ies"}.` : "No matching entry found."
}

export async function memoryClear(
  io: VaultIO,
  _config: MemoryConfig,
  ctx: ToolContext,
  args: { scope?: "global" | "project"; summaryOnly?: boolean },
): Promise<string> {
  if (args.summaryOnly && args.scope) return "The summary is shared; omit scope when using summaryOnly."
  let removed = 0
  await io.withLock(async () => {
    const fresh = await io.getStore()
    const before = fresh.entries.length
    if (args.summaryOnly) {
      fresh.summary = ""
    } else if (args.scope === "project") {
      removed = clearProjectEntries(fresh, ctx.directory)
    } else if (args.scope === "global") {
      fresh.entries = fresh.entries.filter((e) => e.scope !== "global")
      removed = before - fresh.entries.length
    } else {
      fresh.entries = []
      removed = before
    }
    if (removed || (!args.scope && !args.summaryOnly)) fresh.summary = ""
    fresh.updatedAt = now()
    await io.writeStore(fresh)
  })
  if (args.summaryOnly) return "Cleared memory summary; retained all facts."
  return removed ? `Cleared ${removed} memory entr${removed === 1 ? "y" : "ies"}.` : "Memory already empty."
}
