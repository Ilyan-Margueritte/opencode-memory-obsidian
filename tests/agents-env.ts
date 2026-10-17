// Isolation : aucun test ne doit écrire dans le vrai ~/.config/opencode.
// Tous les tests pointent l'installation de l'agent vers un dossier temporaire
// frais (surcharge par variable d'environnement, lue pendant l'exécution).
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const AGENTS_DIR = mkdtempSync(join(tmpdir(), "opencode-memory-agents-"))
process.env.OPENCODE_MEMORY_AGENTS_DIR = AGENTS_DIR
