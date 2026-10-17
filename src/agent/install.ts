// Installation create-only du fichier de l'agent `memory`. Un plugin V2 ne
// peut pas enregistrer d'agent (ctx.agent.transform n'expose pas d'add) ; sur
// le modèle d'opencode-design/designer, le plugin installe LUI-MÊME le
// fichier dans `<config>/opencode/agents/` — sans jamais écraser une version
// existante ou personnalisée par l'utilisateur.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const AGENT_FILE = "memory.md"

/** Dossier des agents : surcharge de test, sinon XDG/`~/.config`. */
export function agentsDir(): string {
  if (process.env.OPENCODE_MEMORY_AGENTS_DIR) return process.env.OPENCODE_MEMORY_AGENTS_DIR
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return join(configHome, "opencode", "agents")
}

/**
 * Résout la source `agents/memory.md` du paquet selon la disposition du
 * module chargé : `dist/index.js` (paquet npm installé) ou `src/agent/`
 * (module source chargé tel quel).
 */
export function resolveAgentSource(
  moduleDir = dirname(fileURLToPath(import.meta.url)),
): string | undefined {
  for (const candidate of [join(moduleDir, "..", "agents"), join(moduleDir, "..", "..", "agents")]) {
    const source = join(candidate, AGENT_FILE)
    if (existsSync(source)) return source
  }
  return undefined
}

/**
 * Crée le fichier dans `dir` s'il manque ; ne touche JAMAIS à une version
 * existante. Retourne "created" ou "exists" (pour les logs d'adaptateur).
 */
export function installAgent(
  options: { agentsDir?: string; moduleDir?: string } = {},
): "created" | "exists" {
  const dir = options.agentsDir ?? agentsDir()
  const target = join(dir, AGENT_FILE)
  if (existsSync(target)) return "exists"

  const source = resolveAgentSource(options.moduleDir)
  if (!source) throw new Error(`agent source ${AGENT_FILE} not found near plugin module`)

  mkdirSync(dir, { recursive: true })
  writeFileSync(target, readFileSync(source, "utf8"), "utf8")
  return "created"
}
