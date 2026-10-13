// TEMPORARY vault audit: structure, note consistency, archive provenance,
// backup rate since 2.0.2, index cache accuracy, Dream journal state.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const V = "C:/Users/ordi2525778/Documents/obsidian/opencode-memory"

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith(".md")) out.push(p)
  }
  return out
}

function parseFront(raw: string): { fm: Record<string, any>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { fm: {}, body: raw }
  const fm: Record<string, any> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":")
    if (i < 1) continue
    const k = line.slice(0, i).trim()
    let v: any = line.slice(i + 1).trim()
    if (/^".*"$/.test(v)) v = v.slice(1, -1)
    else if (v === "true") v = true
    else if (v === "false") v = false
    else if (v !== "" && !isNaN(Number(v))) v = Number(v)
    fm[k] = v
  }
  return { fm, body: m[2].trim() }
}

const iso = (t: any) => (t ? new Date(t).toISOString() : "?")
const num = (v: any) => (typeof v === "number" ? v : typeof v === "string" && v !== "" && !isNaN(Number(v)) ? Number(v) : undefined)

// 1. Active notes (Global + Projects)
const activeFiles = [...walk(join(V, "Global")), ...walk(join(V, "Projects"))]
const notes: any[] = []
const idSeen = new Map<string, string>()
const problems: string[] = []
for (const f of activeFiles) {
  const raw = readFileSync(f, "utf8")
  const { fm, body } = parseFront(raw)
  const rel = relative(V, f)
  if (!fm.id) problems.push(`${rel}: PAS D'ID`)
  else if (idSeen.has(fm.id)) problems.push(`ID DOUBLON ${fm.id}: ${idSeen.get(fm.id)} ET ${rel}`)
  else idSeen.set(fm.id, rel)
  if (fm.status && fm.status !== "ACTIVE") problems.push(`${rel}: status ${fm.status} dans un dossier actif`)
  if (!body) problems.push(`${rel}: corps vide`)
  notes.push({
    rel, id: fm.id, status: fm.status ?? "?", category: fm.category, scope: fm.scope,
    project: fm.project, tier: fm.tier, source: fm.source, weight: fm.weight,
    created: num(fm.created) ?? (Date.parse(fm.created ?? "") || undefined),
    lastSeen: num(fm.lastSeen) ?? (Date.parse(fm.lastSeen ?? "") || undefined),
    useCount: num(fm.useCount) ?? 0, surfacedCount: num(fm.surfacedCount) ?? 0,
    text: body.slice(0, 90).replace(/\n/g, " "),
  })
}

// 2. Archives
const archFiles = walk(join(V, "Archives"))
const archives = archFiles.map((f) => {
  const { fm } = parseFront(readFileSync(f, "utf8"))
  return { rel: relative(V, f), id: fm.id, status: fm.status, archivedAt: fm.archivedAt, reason: fm.archivedReason ?? "(pas de raison)" }
})

// 3. History: rate by day + post-fix window
const histDir = join(V, ".memory", "history")
const hist = existsSync(histDir) ? readdirSync(histDir).filter((f) => f.endsWith(".md")) : []
const byDay = new Map<string, number>()
let postFix = 0
for (const f of hist) {
  const day = f.slice(0, 10)
  byDay.set(day, (byDay.get(day) ?? 0) + 1)
  if (f >= "2026-10-12T20") postFix++ // 2.0.2 pushed ~2026-10-12 evening
}
const histIds = new Map<string, number>()
for (const f of hist) {
  const id = f.replace(/^[\dTZ:.-]+-/, "").replace(/\.md$/, "")
  histIds.set(id, (histIds.get(id) ?? 0) + 1)
}
const topChurn = [...histIds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)

// 4. Index cache accuracy (keys are RELATIVE FILE PATHS, not ids)
const idxPath = join(V, ".memory", "index.json")
let idx: any = null
let idxIssues: string[] = []
if (existsSync(idxPath)) {
  try {
    idx = JSON.parse(readFileSync(idxPath, "utf8"))
    const files = idx.files ?? {}
    const tracked = new Set(Object.keys(files).map((p: string) => p.replace(/\\/g, "/")))
    const disk = new Set(notes.map((n) => n.rel.replace(/\\/g, "/")))
    for (const n of notes) if (!tracked.has(n.rel.replace(/\\/g, "/"))) idxIssues.push(`note active absente de l'index: ${n.rel}`)
    for (const t of tracked) if (!disk.has(t)) idxIssues.push(`entrée d'index sans note active: ${t}`)
    if (Object.keys(idx.parseErrors ?? {}).length) idxIssues.push(`erreurs de parse: ${JSON.stringify(idx.parseErrors)}`)
  } catch (e) { idxIssues.push("index illisible: " + String(e).slice(0, 80)) }
} else idxIssues.push("index.json ABSENT")

// 3b. Post-fix backup churn per id
const postFixFiles = hist.filter((f) => f >= "2026-10-12T20")
const postChurn = new Map<string, number>()
for (const f of postFixFiles) {
  const id = f.replace(/^[\dTZ:.-]+-/, "").replace(/\.md$/, "")
  postChurn.set(id, (postChurn.get(id) ?? 0) + 1)
}

// 5. Dream journal (state.json)
const stPath = join(V, ".memory", "state.json")
let journal = "ABSENT"
if (existsSync(stPath)) {
  try {
    const st = JSON.parse(readFileSync(stPath, "utf8"))
    const ip = Object.entries(st.inProgress ?? {})
    const sessions = Object.keys(st.sessions ?? {}).length
    const stale = ip.filter(([, v]: any) => Date.now() - v.startedAt > 11 * 60 * 1000)
    journal = `sessions consolidées: ${sessions} · inProgress: ${ip.length}${stale.length ? ` (DONT ${stale.length} STALE > 11min: ${stale.map(([k]) => k).join(", ")})` : ""}`
  } catch (e) { journal = "illisible: " + String(e).slice(0, 80) }
}

// 6. Reports + summary
const reports = existsSync(join(V, "Dream", "reports")) ? readdirSync(join(V, "Dream", "reports")) : []
const summary = existsSync(join(V, "SUMMARY.md")) ? readFileSync(join(V, "SUMMARY.md"), "utf8").trim() : "(absent)"

// ---- Report ----
console.log("=== NOTES ACTIVES (" + notes.length + ") ===")
for (const n of notes.sort((a, b) => (a.scope + a.rel).localeCompare(b.scope + b.rel))) {
  console.log(`[${n.status}] ${n.rel}`)
  console.log(`   (${n.scope}/${n.category}, tier=${n.tier}, source=${n.source}, w=${n.weight}) use=${n.useCount} surf=${n.surfacedCount} vu=${iso(n.lastSeen)}`)
  console.log(`   « ${n.text} »`)
}
console.log("\n=== ARCHIVES (" + archives.length + ") ===")
for (const a of archives) console.log(`${a.rel} · statut=${a.status} · ${a.archivedAt ? iso(a.archivedAt) : "?"} · raison: ${a.reason}`)
console.log("\n=== BACKUPS .memory/history ===")
console.log(`total: ${hist.length} · par jour: ${[...byDay.entries()].sort().map(([d, n]) => `${d}: ${n}`).join(" · ")} · depuis 2.0.2 (≥2026-10-12T20Z): ${postFix}`)
console.log(`churn post-fix par id: ${[...postChurn.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id.slice(0, 8)}: ${n}×`).join(" · ") || "(aucun)"}`)
console.log(`top churn global par id: ${topChurn.map(([id, n]) => `${id.slice(0, 8)}: ${n}×`).join(" · ")}`)
console.log("\n=== INDEX CACHE ===")
console.log(idx ? `version: ${idx.version} · fichiers suivis: ${Object.keys(idx.files ?? {}).length}` : "absent")
console.log(idxIssues.length ? "PROBLÈMES:\n- " + idxIssues.join("\n- ") : "cohérent avec le disque")
console.log("\n=== JOURNAL DREAM ===")
console.log(journal)
console.log("\n=== RAPPORTS DREAM ===")
console.log(reports.length ? reports.join(", ") : "(aucun)")
console.log("\n=== SUMMARY ===")
console.log(summary.slice(0, 500))
console.log("\n=== PROBLÈMES DE COHÉRENCE DES NOTES ===")
console.log(problems.length ? "- " + problems.join("\n- ") : "(aucun)")
