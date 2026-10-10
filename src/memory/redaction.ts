// Secret detection for user-visible writes (memory_write / memory_update) and
// for Dream-extracted facts (applyConsolidation guard). Pure module: no
// imports, no I/O.
//
// Contract: findSecret returns the LABEL of the detected pattern — never the
// secret itself — so callers can refuse a write without echoing the value
// back into a model-visible message or a log line. A prose mention of the
// words (e.g. "the token policy is strict", "api_key rotation is documented")
// does not trigger: an assignment separator with a value is required.

const PATTERNS: { label: string; re: RegExp }[] = [
  { label: "private key block", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { label: "GitHub personal access token", re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { label: "GitHub personal access token", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { label: "AWS access key ID", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Slack token", re: /\bxox[bpars]-[A-Za-z0-9-]{10,}\b/ },
  { label: "GitLab personal access token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  // Provider API keys of the "sk-…" family (at least 16 alphanumeric chars).
  { label: "API key", re: /\bsk-[A-Za-z0-9]{16,}\b/ },
  {
    label: "credential assignment (password/token)",
    re: /\b(?:password|passwd|pwd|api[_-]?key|apikey|secret|token|bearer)\b\s*[:=]\s*["']?[^\s"']{6,}/i,
  },
]

export function findSecret(text: string): string | undefined {
  for (const { label, re } of PATTERNS) {
    if (re.test(text)) return label
  }
  return undefined
}
