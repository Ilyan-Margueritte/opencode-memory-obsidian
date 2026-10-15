// Deterministic capture of EXPLICIT memory commands ("retiens que…",
// "remember that…"). A hook cannot force a model to call a tool, so the only
// enforceable write path is one the plugin executes itself: when the user
// plainly orders the agent to remember something, the adapters store it here
// without waiting for the model (which often acknowledges without calling
// memory_write). Implicit durable facts still go through DREAM judgment.
//
// Precision over recall: patterns are anchored imperatives (FR + EN). Leading
// politeness ("please", "stp", "s'il te plaît") is accepted; questions
// ("tu te souviens… ?", "do you remember…?") and nostalgia
// ("remember when…", "rappelle-toi quand…") never match.

export type RememberCommand = {
  fact: string
  /** true when the command names the current project ("ce projet", "this project") */
  project: boolean
}

const PATTERNS: RegExp[] = [
  /^(?:s'il te plaît\s+|stp\s+|please\s+)?(?:retiens(?:\s+bien)?|souviens-toi|souviens\s+toi|rappelle-toi|rappelle\s+toi|note(?:\s+bien|\s+que)|n['’]oublie\s+pas)\s+(?:que\s+)?(.+)$/is,
  /^(?:please\s+)?(?:remember|note\s+down|keep\s+in\s+mind|don't\s+forget|do\s+not\s+forget)(?:\s*:\s*|\s+(?:that\s+)?)(.+)$/is,
  /^(?:à\s+retenir|a\s+retenir|à\s+noter|a\s+noter|remember|note)\s*:\s*(.+)$/is,
]

const NOSTALGIA = /^(?:when|quand)\b/i
const DANGLING = /^(?:que|that)$/i
const PROJECT_HINT = /\b(?:ce projet|dans ce projet|pour ce projet|this project)\b/i

export function extractRememberCommand(text: string): RememberCommand | undefined {
  const input = String(text ?? "").trim()
  if (!input) return undefined
  for (const pattern of PATTERNS) {
    const match = pattern.exec(input)
    if (!match) continue
    const fact = match[1].trim().replace(/\s+/g, " ")
    if (!fact || NOSTALGIA.test(fact) || DANGLING.test(fact)) return undefined
    return { fact, project: PROJECT_HINT.test(input) }
  }
  return undefined
}
