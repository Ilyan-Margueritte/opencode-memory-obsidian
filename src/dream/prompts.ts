// Canonical Dream prompts. The consolidation and dedup texts are the ones
// already shipped by the V2 adapter (they become the single source used by
// BOTH adapters); enrichment is new. Keep the wording stable: the model
// contract (strict JSON shapes, source hierarchy, "same language" rule) is
// pinned by the e2e/v2-check/tool-regressions suites.

export function consolidationPrompt(input: {
  entriesBlock: string
  transcript: string
  sessionTitle?: string
  summary: boolean
}): string {
  const { entriesBlock, transcript, sessionTitle, summary } = input
  return `You are the memory consolidation module of OpenCode. You silently read a finished conversation and update the long-term memory store.

TASKS:
1. new: DURABLE facts about the user (preferences, constraints, personal details, decisions, project state) that are NOT already in memory and will still be useful in a later session (roughly 30 days from now). Be concise, third person ("The user...").
   - Do NOT add session logs, progress updates, completed milestones/task reports, transient troubleshooting, plans, or one-off results.
   - For project work, prefer updating an existing living project-state entry${summary ? " (or the summary)" : ""} instead of adding another dated completion fact. Add a dated release/version fact only when it establishes a durable constraint, decision, dependency, architecture, command, behavior, or limitation.
2. update: only entries whose fact genuinely CHANGED in the conversation. Never use update for mere reformulation.
3. delete: ids of entries that are outdated or contradicted.
4. conflicts: if the conversation STRONGLY contradicts an entry tagged source=explicit, report it with the entry id and a short evidence quote. Never modify or delete that entry.
${summary ? "5. summary: 2-5 sentence summary of who the user is and how they like to work. NEVER include sensitive data in the summary." : ""}

SOURCE HIERARCHY:
- Entries tagged source=explicit were stated directly by the user and ALWAYS win over source=dreamed entries.
- NEVER add a new fact semantically equivalent to an explicit entry, in any language or wording.
- A fact about the same user attribute/topic is a duplicate unless it describes a different attribute.
- NEVER delete or update explicit entries; use conflicts instead.
- If a new fact duplicates a dreamed entry, delete the old dreamed id and add the better formulation.
- If a dreamed entry contradicts an explicit one, delete the dreamed entry.

RULES:
- Do NOT invent facts; extract only what the conversation actually says.
- Skip trivial small talk and one-off actions.
- If nothing is new, return empty arrays${summary ? ' but still a summary (or "" if unchanged)' : ''}.
- Write facts in the same language the user used.
- Compare meaning across languages before adding a fact.
- Use scope "project" only for facts tied to this codebase; otherwise use "global".
- Optionally attach confidence (0-1) to each new fact.

RESPOND WITH STRICT JSON ONLY:
{"new":[{"text":"...","category":"user|project|workflow|preferences|decisions|status|environment|other","scope":"global|project","confidence":0.9}],"update":[{"id":"...","text":"..."}],"delete":["..."],"conflicts":[{"id":"...","evidence":"..."}]${summary ? ',"summary":"..."' : ''}}

CURRENT MEMORY ENTRIES:
${entriesBlock}

TRANSCRIPT (session title: ${sessionTitle ?? ""}):
${transcript}`
}

export function dedupPrompt(input: { entryLines: string; candidateLines: string }): string {
  const { entryLines, candidateLines } = input
  return `You are a deduplication checker for a memory store.

EXISTING MEMORY ENTRIES:
${entryLines}

CANDIDATE NEW FACTS:
${candidateLines}

For each candidate that is semantically equivalent to an existing entry (same meaning, ANY language, paraphrase), reply with that candidate's index in "duplicates". An entry with source=explicit always wins over a candidate. Candidates that describe something NEW are not duplicates.

REPLY WITH STRICT JSON ONLY:
{"duplicates":[0,2]}`
}

export function enrichmentPrompt(input: { projectName: string; facts: string[] }): string {
  const { projectName, facts } = input
  return `You are the project-knowledge writer of OpenCode. Write 3-6 sentences about the current state of the project "${projectName}" using ONLY the facts below. No invention, no outside knowledge, no speculation. Plain text only (no markdown, no lists, no headers).

FACTS:
${facts.map((fact) => `- ${fact}`).join("\n")}`
}
