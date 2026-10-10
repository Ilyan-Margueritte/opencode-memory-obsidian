# opencode-memory

<video src="https://github.com/user-attachments/assets/b3b06cb6-0b63-4b18-a401-37964fe9e322" controls muted></video>

Local-first persistent memory for OpenCode.

opencode-memory gives OpenCode durable memory across sessions through a
WRITE → DREAM → SURFACE lifecycle:

- WRITE: explicit memory tools
- DREAM: headless conversation consolidation
- SURFACE: selective memory injection into future prompts

## Features

- **Obsidian vault storage**: one memory = one Markdown note with flat YAML
  frontmatter, in a plain vault you can open, search, edit and sync; file
  locking included, **zero external database**
- Explicit and inferred memory hierarchy with **auditable provenance**
  (each dreamed fact knows its source session, messages and confidence)
- **Archiving instead of deletion**: forgotten, superseded and duplicate notes
  move to `Archives/` with an `ARCHIVED` marker — nothing is ever silently
  deleted
- **Secret filter**: `memory_write` / `memory_update` and Dream-extracted
  facts are screened for credentials (API keys, GitHub/Slack/AWS/GitLab
  tokens, private key blocks, `password: …` assignments); refusals carry the
  pattern label, never the value
- **Knowledge notes**: derived, regenerable Obsidian views (decisions,
  preferences, per-project state) with `[[wiki links]]` back to the source
  memory notes
- **Dream organization phase**: dreamed-duplicate cleanup, knowledge sync,
  optional per-project model synthesis and staleness PROPOSALS (nothing is
  archived automatically)
- **Configurable Dream provider**: the OpenCode session model (default) or
  any OpenAI-compatible endpoint (local Ollama/Mistral, vLLM, cloud) — memory
  stays fully consultable without any model
- **Automatic 1.x migration**: the first use converts a legacy `store.json`
  into the vault after backing it up; the rollback is documented and scripted
- **Memory Inspector**: `/memory` stats, conflicts, "why was this surfaced"
- **Contradiction lifecycle**: CONFLICTED explicit facts are flagged and
  resolved, never silently overwritten
- **Memory tiers**: core (always surfaced) / archival (on relevance) /
  temporary (auto-expiry) / pinned (never decays)
- **Hybrid retrieval**: lexical keyword pipeline + optional semantic
  reranking stage with abstention, relevance-gated surfacing
- **Retrieval feedback**: `memory_useful` / `memory_irrelevant` tune
  ranking from real usage
- **Per-memory privacy**: `local-only` facts stay on disk, out of every
  model-visible path (see [Privacy](#privacy) for the exact threat model)
- Global and project-scoped memories with enforced per-directory isolation,
  cross-language semantic deduplication
- Tool-free internal generation for DREAM, dedup and reranking (V2), plus
  allow-none headless helper sessions with orphan GC (V1)

## Project scope semantics

A project-scoped memory belongs to exactly one project directory
(`projectID` = the OpenCode session directory). The rules, enforced by a
single policy in `src/core.ts` (`projectVisible`, `readableEntries`,
`consolidationEntries`, `readQuery`) and covered by regression tests:

- Every model-facing tool (`memory_read`, `memory_update`, `memory_forget`,
  `memory_why`, `memory_useful`, `memory_irrelevant`, `memory_inspect`) sees
  global entries plus the CURRENT project's entries — never another
  project's.
- `memory_write` refreshes identical text only in the same scope (and
  the same project). A global fact and an equivalent project fact may coexist;
  neither suppresses the other. In that project both are retrievable,
  elsewhere only the global one.
- `memory_clear` with `scope: "project"` removes ONLY the current project's
  memories; other projects keep theirs. Without a scope it wipes everything
  (all projects, including local-only entries).
- DREAM consolidation for a session in project A can never suppress, merge
  with, rewrite, supersede or flag entries of project B (or local-only
  entries), even if the consolidation output references their ids.

## Storage: the Obsidian vault

Memories are plain Markdown notes inside one Obsidian-style vault located at
`dir` (default `~/.local/share/opencode/memory`). Everything is
human-readable and editable in Obsidian; no external database is involved.

```text
<memory dir>/
├── SUMMARY.md                     # shared summary (frontmatter + body)
├── Global/                        # global-scope memories, one note each
├── Projects/<slug>-<hash8>/       # per-project memories, deterministic folder
├── Knowledge/                     # DERIVED views (regenerable, see below)
│   ├── decisions.md
│   ├── preferences.md
│   └── projects/<slug>-<hash8>.md
├── Dream/reports/<YYYY-MM-DD>.md  # staleness proposals, one report per day
├── Archives/                      # removed/replaced notes (status ARCHIVED)
└── .memory/
    ├── state.json                 # consolidation journal (same format as 1.x)
    ├── index.json                 # note parse cache (mtimeMs + size)
    ├── history/                   # raw copy of a note before each rewrite
    ├── backup-<timestamp>/        # pre-migration backup (see Migration)
    └── .lock                      # cross-process lockfile
```

### Note format

One memory = one note: flat YAML frontmatter in a fixed key order, then the
fact text as body. No YAML package is used; strings are double-quoted,
timestamps are ISO 8601.

```markdown
---
id: "e6f10a2b-1111-4321-8765-abcdefabcdef"
type: "memory"
category: "preferences"
scope: "global"
tier: "core"
status: "ACTIVE"
sensitivity: "normal"
weight: 3
source: "explicit"
createdBy: "memory_write"
created: "2026-10-10T09:00:00.000Z"
lastSeen: "2026-10-10T09:00:00.000Z"
---

The user prefers Bun over npm.
```

Optional keys (`project`, `pinned`, `confidence`, `sourceSession`,
`sourceMessages`, `extractedAt`, `expiresAt`, the surfacing/feedback
counters, `related`) appear only when set.

### Invariants

- **The canonical id lives in the frontmatter; the file name never decides.**
  Renaming a note in Obsidian is safe: updates are written back to the
  existing file whatever its name, and only brand-new notes receive the
  canonical `<slugified-text>-<id8>.md` name.
- **Manual edits are detected, never clobbered.** Every write diffs the store
  against a fresh disk scan (content equality through normalized parsing);
  identical notes are left untouched, and a note that does change is backed
  up under `.memory/history/` before being rewritten atomically (tmp +
  rename).
- **Nothing is silently deleted.** A note still on disk but absent from the
  store is moved to `Archives/` with `status: "ARCHIVED"` and an `archivedAt`
  timestamp. `Archives/` is never scanned back into the store.
- **Tolerant parsing.** Obsidian may reformat files: unknown frontmatter keys
  are ignored, dates are accepted as ISO datetime, ISO date or epoch-ms
  numbers, unknown categories fall back to `other`, and missing
  tier/status/sensitivity get the documented defaults. Unparseable notes are
  recorded (with their error) in `.memory/index.json` and skipped — they
  never break the store.
- **Project isolation survives on disk.** Project-scoped notes live under
  `Projects/<slug-of-basename>-<hash8-of-path>/`; the folder is derived
  deterministically from the project directory, so the same project always
  maps to the same folder.

## Installation

Add the package to your OpenCode configuration (`~/.config/opencode/opencode.json`
or `opencode.jsonc`). OpenCode V2 uses `plugins`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "@cioffi_ai/opencode-memory"
  ]
}
```

OpenCode V1 uses the singular `plugin` key instead. The npm package exposes
separate V1 and V2 runtime adapters from one entrypoint; both use the same
store format and memory model. The V1 compatibility adapter requires OpenCode
1.18.29 or newer. Version 1.7.0 adds V2 support and targets OpenCode 2.0.18+.
Older V1 installations should upgrade OpenCode before upgrading this plugin.

V2 exposes plugin tools through its Code Mode catalog by default (for example,
`tools.memory_read(...)` inside `execute`). This is normal: the nine memory
tools need not appear as nine standalone model tool definitions.

OpenCode installs npm plugins automatically via Bun on startup and caches them
in `~/.cache/opencode/node_modules/`. Restart OpenCode after adding the entry.

### Optional: `/memory` command

The npm package does not copy `commands/memory.md` into your user directory
(plugin package installs do not run lifecycle scripts). To enable the `/memory`
command, copy it manually from this repository:

```bash
mkdir -p ~/.config/opencode/commands

curl -o ~/.config/opencode/commands/memory.md \
  https://raw.githubusercontent.com/cioffiAI/opencode-memory/main/commands/memory.md
```

The plugin works without `/memory`: the tools are registered directly by the
plugin, and the automatic DREAM cycle runs regardless.

## Tools

| Tool | Purpose |
| --- | --- |
| `memory_read` | Search facts (query / category / scope); multi-word queries match all terms; global + current project only |
| `memory_write` | Store an explicit fact; identical text refreshes it (`tier`, `ttlHours`, `pinned`, `sensitivity`) |
| `memory_update` | Correct a fact, by `id` or match — resolves CONFLICTED entries |
| `memory_forget` / `memory_clear` | Remove facts; `memory_clear({ summaryOnly: true })` clears only the shared summary |
| `memory_why` | Audit a memory: provenance, lifecycle, score breakdown |
| `memory_inspect` | `stats` \| `recent` \| `conflicts` \| `project` \| `surfaced` |
| `memory_useful` / `memory_irrelevant` | Feedback on retrieval quality |

Removal is archiving, not deletion: `memory_forget` / `memory_clear` retract
entries from the store, and the vault layer then moves the orphaned notes to
`Archives/` with `status: "ARCHIVED"` (the user-visible tool messages are
unchanged). Conversely, `memory_write` and `memory_update` refuse facts that
look like credentials — the refusal names the detected pattern, never the
value.

`memory_write` retains distinct facts even when they share similar wording or
are submitted together with `Promise.all`. Repeating the same text (ignoring
case and whitespace) refreshes the existing entry; punctuation and technical
symbols remain significant. Use `memory_update` with the entry's `id` to
correct a fact. DREAM still checks inferred facts for semantic duplicates.

`memory_read` uses its own conservative lexical search: the historical
contiguous substring match is preserved, plus an all-terms path where every
term of a multi-word query must appear as a whole token (any order,
non-contiguous) in the text or category. Query and memory go through the same
identifier grammar: a camelCase word matches either its compact or its
separated spelling (`JavaScript` ↔ `javascript` / `java script`, never one
half alone). Short and technical terms are kept (`AI`, `UI`, `DB`, `C`, `R`,
`no`, `C++`, `C#`, `Node.js`, `.NET`); no stemming, synonyms or accent
folding. Scope/category filters, score ordering and privacy rules are
identical to the rest of the plugin.

Example of `memory_why`:

```text
Text:    The user prefers Bun over npm.
Source:  explicit (via memory_write)
Lifecycle: ACTIVE | tier core | pinned (no decay)
Score (now): 3.512 = (3.00 + source bonus + utilization) × decay 1.000
Last surfacing (session abc):
  Base score:   3.51
  Keyword match: +3.00 (1 hits)
  Core bonus:    yes
  Final rank:    #2
```

## Recency, exposure and feedback

Time-based decay is computed from `lastSeen` — the last time a fact was
CONFIRMED (explicit write/update, consolidation refresh, or positive feedback
via `memory_useful`). Automatic surfacing updates only exposure counters
(`lastSurfaced`, `surfacedCount`): being shown to the model is not evidence
that a fact is still true, so exposure never resets decay and cannot make a
frequently-surfaced memory immortal under pruning. Negative feedback
(`memory_irrelevant`) lowers ranking without touching recency.

## Configuration

In OpenCode V2, configure the plugin in `opencode.jsonc` with an object entry:

```jsonc
{
  "plugins": [{
    "package": "@cioffi_ai/opencode-memory",
    "options": {
      "dream": false,
      "surface": false,
      "summary": false
    }
  }]
}
```

OpenCode V1 1.18.29+ uses a package/options pair instead:

```jsonc
{
  "plugin": [["@cioffi_ai/opencode-memory", {
    "dream": false,
    "surface": false,
    "summary": false
  }]]
}
```

Every setting below accepts a typed plugin option. An option takes precedence
over its environment variable; otherwise the environment variable or default
applies. Environment booleans use `1`/`0`, while JSONC options use `true`/`false`.
Numeric options must be integers. Unknown or invalid options fail plugin setup
with the offending name instead of silently falling back.

| Option | Environment variable | Default | Effect |
| --- | --- | --- | --- |
| `off` | `OPENCODE_MEMORY_OFF` | false | Disable the entire plugin. |
| `dream` | `OPENCODE_MEMORY_DREAM` | true | Automatic conversation consolidation and recovery sweep. |
| `surface` | `OPENCODE_MEMORY_SURFACE` | true | Automatic memory injection and semantic reranking. |
| `summary` | `OPENCODE_MEMORY_SUMMARY` | true | Generate and expose the shared summary in automatic context and `memory_read`. |
| `dir` | `OPENCODE_MEMORY_DIR` | `~/.local/share/opencode/memory` | Vault root — memory notes, Knowledge, Archives, state and summary directory. |
| `debug` | `OPENCODE_MEMORY_DEBUG` | false | Trace logging. |
| `delayMs` | `OPENCODE_MEMORY_DELAY_MS` | 90000 | Idle debounce before DREAM. |
| `maxEntries` | `OPENCODE_MEMORY_MAX_ENTRIES` | 400 | Maximum retained memories. |
| `maxFacts` | `OPENCODE_MEMORY_MAX_FACTS` | 18 | Maximum relevance-ranked facts in a prompt. |
| `maxChars` | `OPENCODE_MEMORY_MAX_CHARS` | 2400 | Maximum memory-block characters. |
| `transcriptChars` | `OPENCODE_MEMORY_TRANSCRIPT_CHARS` | 12000 | Maximum transcript characters sent to DREAM. |
| `sweepIntervalMs` | `OPENCODE_MEMORY_SWEEP_MS` | 600000 | Recovery sweep interval. |
| `sweepStartMs` | `OPENCODE_MEMORY_SWEEP_START_MS` | 20000 | Delay before first recovery sweep. |
| `sweepBatch` | `OPENCODE_MEMORY_SWEEP_BATCH` | 8 | Maximum sessions processed per sweep. |
| `gcChildAgeMs` | `OPENCODE_MEMORY_GC_CHILD_AGE_MS` | 600000 | V1 orphan helper-session age; V2 creates no helper sessions. |
| `inProgressTimeoutMs` | `OPENCODE_MEMORY_INPROGRESS_TIMEOUT_MS` | 600000 | Expiry of a DREAM in-progress marker. |
| `rerank` | `OPENCODE_MEMORY_RERANK` | false | Optional model-based relevance reranking. |
| `rerankCandidates` | `OPENCODE_MEMORY_RERANK_CANDIDATES` | 30 | Candidate window for reranking. |
| `rerankTimeoutMs` | `OPENCODE_MEMORY_RERANK_TIMEOUT_MS` | 4000 | Rerank timeout before lexical fallback. |
| `rerankCacheMs` | `OPENCODE_MEMORY_RERANK_CACHE_MS` | 60000 | Rerank cache lifetime. |
| `coreSlot` | `OPENCODE_MEMORY_CORE_SLOT` | 3 | Core-tier entries injected beyond relevance matches. |
| `surfaceRefreshMs` | `OPENCODE_MEMORY_SURFACE_REFRESH_MS` | 900000 | Minimum interval between persisted exposure updates. |
| `dreamProvider` | `OPENCODE_MEMORY_DREAM_PROVIDER` | `opencode` | Model used by DREAM: `opencode` (the session's model) or `openai-compatible` (direct `POST <baseUrl>/chat/completions`). |
| `dreamModel` | `OPENCODE_MEMORY_DREAM_MODEL` | — | Model name for the `openai-compatible` provider (required with it). |
| `dreamBaseUrl` | `OPENCODE_MEMORY_DREAM_BASE_URL` | — | Base URL of the OpenAI-compatible endpoint (required with `openai-compatible`). |
| `dreamApiKey` | `OPENCODE_MEMORY_DREAM_API_KEY` | — | Optional bearer token for that endpoint. Secret: never logged, never quoted in an error. Pass it through the environment variable — never commit a key in a config file. |
| `staleDays` | `OPENCODE_MEMORY_STALE_DAYS` | 90 | Days without confirmation before a fact becomes an archiving PROPOSITION in the Dream report. |

Use an absolute `dir` path when overriding the store location. Each plugin
instance uses its own resolved options and store path. Changing `dir` selects a
different store; it does not move data from the old directory.

Set `OPENCODE_MEMORY_DREAM=0` to stop automatic consolidation and its model calls. Set
`OPENCODE_MEMORY_SURFACE=0` to stop automatic prompt injection; this also prevents
semantic reranking even if `OPENCODE_MEMORY_RERANK=1`. Either setting leaves the
explicit memory tools available. `OPENCODE_MEMORY_OFF=1` disables the entire plugin.
These switches do not prevent OpenCode itself or explicit tool calls from sending
conversation content to the configured model provider.

### Dream on a local OpenAI-compatible endpoint

`dreamProvider: "openai-compatible"` calls any `POST <baseUrl>/chat/completions`
endpoint directly with `fetch` — no vendor SDK, no new dependency. Example for
a local Ollama serving Mistral:

```jsonc
{
  "plugins": [{
    "package": "@cioffi_ai/opencode-memory",
    "options": {
      "dreamProvider": "openai-compatible",
      "dreamBaseUrl": "http://127.0.0.1:11434/v1",
      "dreamModel": "mistral",
      "staleDays": 60
    }
  }]
}
```

`dreamBaseUrl` and `dreamModel` are required in that mode; `dreamApiKey` is
optional (a local Ollama needs none) and can be supplied through the
environment instead: `OPENCODE_MEMORY_DREAM_PROVIDER`,
`OPENCODE_MEMORY_DREAM_BASE_URL`, `OPENCODE_MEMORY_DREAM_MODEL`,
`OPENCODE_MEMORY_DREAM_API_KEY`. The API key is resolved by the provider but
never logged and never included in an error message — failures quote the HTTP
status only. When the model is unreachable, the DREAM round is skipped and
every memory tool keeps working.

### Disable or clear the summary

Set `summary: false` (or `OPENCODE_MEMORY_SUMMARY=0`) to hide the summary from
automatic context and `memory_read`, and stop DREAM from generating or updating
it. Facts remain available through the tools and, when enabled, SURFACE.
Disabling the summary preserves it on disk, so re-enabling the option restores
it. This option is useful when DREAM is disabled and the summary becomes stale.

To erase the stored summary while keeping every fact, call:

```js
await tools.memory_clear({ summaryOnly: true })
```

The summary is shared across projects, so `summaryOnly` cannot be combined with
`scope`. If `summary` remains enabled, a later DREAM can generate it again.

## Migration from 1.x

Version 2.0 stores memories as Markdown notes instead of a single
`store.json`. The migration is automatic, idempotent and reversible.

- **When it runs.** On the first store access after upgrading, the plugin
  converts a legacy directory (root-level `store.json` + `state.json` +
  `SUMMARY.md`) into the vault layout. It runs once per directory and
  process; a second run is a no-op, because the root keeps no JSON afterwards.
- **Safety first.** `store.json` is read and validated BEFORE anything is
  created: an unreadable or unsupported store aborts with an explicit error
  and nothing is touched. The conversion itself runs under the vault lockfile,
  so two processes can never migrate concurrently.
- **Backup.** `store.json`, `state.json` and `SUMMARY.md` are copied to
  `<memory dir>/.memory/backup-<timestamp>/` before the conversion; the
  legacy JSON files are then MOVED into that backup (the root `SUMMARY.md`
  becomes the new vault summary). Timestamps use dashes instead of colons so
  the backup name is a valid Windows directory name.

### Migration CLI

The same migration can be run or checked by hand:

```bash
bun run scripts/migrate-vault.ts                        # migrate the default dir
bun run scripts/migrate-vault.ts --dir <memory dir>     # migrate a specific dir
bun run scripts/migrate-vault.ts --dir <memory dir> --verify
bun run scripts/migrate-vault.ts --rollback <backup dir>
```

`--dir` defaults to the configured memory directory. `--verify` recounts the
notes on disk (`Global/` + `Projects/`) and exits non-zero when the count
does not match the migrated entries (or, on an already-migrated directory,
the live vault).

### Rollback procedure (back to 1.x)

1. Quit OpenCode so nothing writes to the vault during the rollback.
2. Locate the backup created during migration:
   `<memory dir>/.memory/backup-<timestamp>/`.
3. Restore it to the memory root:

   ```bash
   bun run scripts/migrate-vault.ts --rollback "<memory dir>/.memory/backup-<timestamp>"
   ```

   This copies `store.json`, `state.json` and `SUMMARY.md` from the backup
   back to `<memory dir>`. The vault notes are left untouched.
4. Downgrade the plugin to the previous 1.x release: the 1.x store reads the
   restored root `store.json` again. The rollback is itself reversible —
   re-upgrading re-migrates the restored `store.json` (a fresh backup is made
   first).

## Retrieval semantics (v1.6)

The lexical pipeline is a small, independently testable chain:

tokenizer → keyword extraction → alias expansion → candidate generation
(scope/status/sensitivity filter) → boundary-safe matching → scoring →
**relevance gate** → surface (+ optional semantic rerank with abstention).

Matching rules, enforced in `src/core.ts` and covered by regression tests:

- **Token boundaries are sacred.** A keyword matches whole normalized tokens
  only. `use` never matches `user`, `test` never matches `pytest`/
  `greatest`, `red` never matches `redesign`. Bare substring and open-ended
  prefix matching were removed in v1.6.
- **Identifiers are first-class.** camelCase/PascalCase split at case
  boundaries (`userStore` → `user` + `store`); snake_case, kebab-case,
  dotted names and paths split on their separators. Both the whole compound
  (`javascript`) and its parts match.
- **Morphology is explicit and small**: plural (`deploy`↔`deploys`), gerund
  (`network`↔`networking`) and participle (`test`↔`tested`) forms match in
  both directions. Nothing else.
- **Synonym groups contain only substitutable terms** (translations,
  aliases, abbreviations of the SAME concept: `colore`↔`color`,
  `job`↔`lavoro`, `db`↔`database`). Opinion verbs (`like`, `prefer`,
  `favorite`…) are not synonyms of anything and no longer bridge domains.
- The **relevance gate** is a named single-source predicate
  (`passesRelevanceGate`): candidates without at least one boundary-safe
  match never enter the injected block; the core slot stays contractual.
- Every surfacing decision is explainable: `retrieve()` returns per-keyword
  provenance (`keyword:kind via query-term`), and
  `bun run bench --explain-negatives` dumps it machine-readably.

## Retrieval benchmark

Two scenario sets, one harness (`bench/lib.ts`):

- **DEV/REGRESSION set** (115 scenarios: 77 positive / 38 negative across six
  negative categories) — used while developing; its positives are frozen
  since v1.5.0 and must never be edited to flatter the algorithm.
- **HELD-OUT set** (20 scenarios) — written once from the feature contract
  BEFORE the v1.6 fixes were implemented and not iterated against. It
  includes identifier/package-name/path traps, bilingual weak associations,
  related-tech-wrong-fact and declared CEILING-MEASURE cases.

Metrics (identical in human and `--json` output): Recall@1, Recall@5, MRR
(candidate quality, before any gate), macro and entry-level surface
precision, false-abstention rate on positives, query-level false-positive
rate with memory-level counts, abstention breakdown for negatives (fully
abstained / core-slot only / irrelevant non-core surfaced), Wilson 95%
confidence intervals, average surfaced memories and context overhead.

Current results (lexical pipeline, reranker disabled):

```text
DEV set     Recall@5 100% · MRR 95.2% · surface precision 63.2% macro /
            81.8% entry-level (54/66) · FPR 34.2% (13/38) · overhead 9.1 tok
HELD-OUT    Recall@5 100% · MRR 100%  · FPR 26.7% (4/15) · 0 false abstentions
            (v1.5.1 algorithm measured on the same held-out set: FPR 46.7%,
             7/15, including every identifier/substring trap)
```

Interpretation: all remaining negative-scenario failures are exact-token or
true-translation matches whose INTENT differs ("test account" vs test
framework question, "server in the basement" vs MCP server configuration,
relational facts like "the brother repairs phones"). No mechanical matching
bug remains in either set. This is the honest ceiling of zero-dependency
lexical retrieval; the mitigation path already shipped is the optional
semantic reranker with abstention (`OPENCODE_MEMORY_RERANK=1`). Embeddings
are NOT yet justified by this evidence: the residual errors are intent/attribution
problems, which bag-of-embeddings only partially addresses.

## Privacy

Memory files are always stored locally (Markdown vault plus the JSON
state/index and lockfile under `.memory/`; no external database, no plugin
cloud service).

Since 2.0, fact text that looks like a credential is refused before it can
reach the vault: `memory_write` / `memory_update` return a refusal naming the
detected pattern (label only, never the value), and Dream-extracted facts
matching the same patterns are skipped with a warning. Secrets therefore
never enter the vault through either path; `local-only` remains the tool for
sensitive NON-credential facts.

During DREAM consolidation, the conversation transcript is processed by the
model provider configured in OpenCode. That provider may be local (e.g.
Ollama) or remote (a cloud API): if remote, conversation text is sent to that
provider through the same channels OpenCode already uses — this plugin cannot
change that. For sensitive conversations use a local provider or set
`OPENCODE_MEMORY_OFF=1`.

### `local-only` memories: exact guarantee

Facts written with `sensitivity: "local-only"` are stored on disk only. The
plugin never includes them in ANY model-visible path:

- not in the automatic `<memory>` block (SURFACE injection),
- not among DREAM prompt entries nor the semantic dedup prompt,
- not among semantic rerank candidates,
- not returned by `memory_read`, `memory_why` or any `memory_inspect` view,
- not mutable through `memory_update`, `memory_forget`, `memory_useful`,
  `memory_irrelevant` (they are invisible to all of them).

They are therefore inaccessible to the model in every later session; the only
supported access path is direct file inspection by the human user (the notes
under `Global/` and `Projects/`, and `SUMMARY.md`, in `OPENCODE_MEMORY_DIR`).
Use them as a durable local record of sensitive facts that must never
propagate to new contexts.

Two limitations remain, by architecture rather than by omission:

1. The WRITE call itself necessarily passes through the model (it is a tool
   call), and if the fact was typed in the conversation, the transcript has
   already reached the provider. `local-only` prevents RE-exposure in future
   sessions; it cannot retract what already left the machine.
2. The generated summary is derived from the transcript by the provider; the
   DREAM prompt forbids sensitive data in summaries, but the plugin cannot
   technically guarantee what a remote model writes there.

## Dream: provider and organization phase

### Configurable provider

`dreamProvider` chooses how DREAM reaches a model (see
[Configuration](#configuration)):

- `opencode` (default): the session's model through OpenCode — V2 uses
  isolated `ctx.generate.text()`, V1 an allow-none headless session.
- `openai-compatible`: any `POST <baseUrl>/chat/completions` endpoint called
  with `fetch` — a local Mistral/Ollama, vLLM or a cloud API. No vendor SDK.

Every model failure degrades to a skipped consolidation round without
touching the store: reads, writes and all memory tools keep working with no
model at all (`dream: false` removes even the option of model calls).

### Organization phase

After each committed consolidation and after the recovery sweep, an
organization phase runs over the vault:

1. **Dreamed duplicates.** Pairs of ACTIVE dreamed entries (same scope and
   project) whose texts clash on topic or reach similarity ≥ 0.8 are merged:
   the better-scored entry is kept, the other is removed and its note is
   archived. EXPLICIT entries are never touched.
2. **Knowledge sync.** The derived Knowledge notes are regenerated (see
   [Knowledge notes](#knowledge-notes)).
3. **Enrichment (optional model).** Each project with 3+ readable project
   facts gets a plain-text model synthesis spliced into the
   `<!-- dream:begin:synthese -->` section of its project Knowledge note. A
   failure skips that section only.
4. **Staleness proposals.** ACTIVE, unpinned, non-core facts untouched for
   more than `staleDays` days are listed in `Dream/reports/<YYYY-MM-DD>.md`
   as archiving PROPOSITIONS. Nothing is ever archived automatically: resolve
   a proposal with `memory_forget` / `memory_update`.

Idempotence: the same-day report is rewritten (never appended to), and
Knowledge notes whose content did not change are not rewritten at all.

## Knowledge notes

`Knowledge/` holds DERIVED, regenerable views built FROM the memory notes —
never a second source of truth. The memory notes stay canonical; deleting any
Knowledge note is always safe, and the next sync regenerates it:

- `Knowledge/decisions.md` — global-scope decisions,
- `Knowledge/preferences.md` — global-scope preferences,
- `Knowledge/projects/<project folder>.md` — one note per project with an
  `etat` section (the project's living state) and a `decisions` section, so
  every project entry appears exactly once.

Each item links back to its source note with an Obsidian wiki link:
`[[<memory note stem>]] — text (source, created)`. CONFLICTED entries are
listed with a "(conflit à résoudre)" mention; SUPERSEDED tombstones and
local-only facts are never listed; project facts stay in their project note.

Generated content lives exclusively between
`<!-- dream:begin:<section> -->` and `<!-- dream:end:<section> -->` markers:
manual text outside the markers is preserved byte-for-byte, the header and
intro are written at creation only, and missing markers on an edited file are
re-appended (with a warning) so Dream can always regenerate. The same store
always produces byte-identical notes.

## DREAM containment

On OpenCode V2, consolidation, semantic dedup and semantic rerank use
`ctx.generate.text()`. The V2 API performs an isolated text generation without
creating a session, exposing tools, or writing conversation history. There are
therefore no helper sessions to hide or garbage-collect. A periodic recovery
pass uses the durable two-phase `inProgress` journal to retry interrupted
consolidations after the configured timeout.

On OpenCode V1, the same jobs run in headless child sessions created with a
single wildcard tool denial (`tools: { "*": false }`). This removes shell,
file, network, MCP, subagent, memory and third-party plugin tools from the
model-visible toolset. Crash recovery, orphan GC and at-least-once
consolidation semantics remain enabled for V1.

## Roadmap

- Shared / agent-scoped memory, graph memory with entity relationships,
  encrypted multi-device sync, import/export.

## Development

```bash
bun install
bun run check           # typecheck + tests + build
bun run verify:package  # pack + clean install + V1/V2 tool/runtime checks
bun run bench           # retrieval benchmark
npm pack --dry-run
```

To check the actual packaged artifact in both CLI generations, point the check
at existing CLI binaries (it never downloads or replaces a CLI):

```bash
OPENCODE_TEST_BIN_V1=/path/to/opencode-v1 \
OPENCODE_TEST_BIN_V2=/path/to/opencode-v2 \
  bun run verify:package
```

The runtime check uses separate temporary profiles and a deterministic model
served on localhost; no AI credentials or paid model calls are needed. It checks
loading, all nine tool registrations, write/read, context injection, automatic
DREAM, store migration and local-only privacy. Logs and request evidence stay in
the printed temporary directory. The default unit test suite does not replace
these opt-in runtime checks.

## License

MIT — see [LICENSE](LICENSE).
