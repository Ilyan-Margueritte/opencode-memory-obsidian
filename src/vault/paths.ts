// Vault layout: every path of the Obsidian-style markdown vault, plus the
// deterministic helpers (hash, slug) that keep project folders and note file
// names stable across runs. Autonomous module: path + crypto from the Node
// stdlib only — no YAML package, no opencode runtime dependency.

import { createHash } from "crypto"
import path from "path"

export type VaultPaths = {
  root: string
  summary: string
  global: string
  projects: string
  knowledge: string
  knowledgeProjects: string
  dreamReports: string
  archives: string
  memory: string
  state: string
  index: string
  history: string
  lock: string
}

export function vaultPaths(root: string): VaultPaths {
  const r = path.resolve(root)
  const memory = path.join(r, ".memory")
  return {
    root: r,
    summary: path.join(r, "SUMMARY.md"),
    global: path.join(r, "Global"),
    projects: path.join(r, "Projects"),
    knowledge: path.join(r, "Knowledge"),
    knowledgeProjects: path.join(r, "Knowledge", "projects"),
    dreamReports: path.join(r, "Dream", "reports"),
    archives: path.join(r, "Archives"),
    memory,
    state: path.join(memory, "state.json"),
    index: path.join(memory, "index.json"),
    history: path.join(memory, "history"),
    lock: path.join(memory, ".lock"),
  }
}

export function hash8(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8)
}

export function slugify(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const words = slug.split("-").filter(Boolean).slice(0, 5).join("-")
  return (words.length > 40 ? words.slice(0, 40) : words).replace(/-+$/g, "") || "memoire"
}

export function projectFolderName(projectID: string): string {
  return `${slugify(path.basename(projectID))}-${hash8(path.resolve(projectID))}`
}

export function projectFolder(paths: VaultPaths, projectID: string): string {
  return path.join(paths.projects, projectFolderName(projectID))
}

export function noteFileName(id: string, text: string): string {
  return `${slugify(text)}-${id.slice(0, 8)}.md`
}
