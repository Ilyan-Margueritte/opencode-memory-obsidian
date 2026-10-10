# Coffre Obsidian pour opencode-memory — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** transformer le stockage JSON d'opencode-memory en coffre Obsidian Markdown (source de vérité), avec composants Memory/Knowledge/Dream à interfaces documentées, provider de modèle configurable pour Dream, archivage au lieu de suppression, filtre de secrets et migration JSON→Markdown sauvegardée et réversible.

**Architecture :** la logique pure de `src/core.ts` est conservée telle quelle (scoring, retrieval, politique scope/privacy, `applyConsolidation`). Une nouvelle couche `src/vault/` remplace `store.json` par des notes Markdown (une par mémoire, frontmatter YAML plat) sous l'interface de persistance inchangée (`VaultIO` = même forme que l'actuel `StoreIO`). La logique des 9 outils est dédupliquée dans `src/memory/api.ts` partagée par les adaptateurs V1/V2 ; `src/knowledge/notes.ts` génère les vues organisées ; `src/dream/` extrait la consolidation (prompts + journal deux-phases) et ajoute la phase « organisation » (doublons, liens, obsolescence) avec un provider de modèle injectable.

**Tech Stack :** Bun + TypeScript strict (ESM, imports `.ts`), fs/path/crypto de la stdlib Node, aucune nouvelle dépendance runtime. Tests : `bun test`.

**Spec :** `docs/audit-obsidian-memory.md` (audit + mapping des objectifs de la mission ; mission fournie en conversation). Ce plan argumente à partir de l'audit — les exécuteurs lisent les deux.

## Global Constraints

- **Zéro nouvelle dépendance runtime** : les `dependencies` restent `@opencode-ai/plugin` + `@opencode/plugin`. fs/path/crypto viennent de la stdlib. Aucune lib YAML : le frontmatter est un sous-ensemble plat écrit/parsé par nos soins.
- **Compatibilité adaptateurs** : V1 (`server()`, OpenCode ≥ 1.18.29) et V2 (`setup`, OpenCode ≥ 2.0.18) restent fonctionnels en permanence. Chaque tâche se termine par une suite de tests verte.
- **Politique scope/privacy intangible** : toute lecture/écriture/exposition passe par les prédicats de `src/core.ts` (`projectVisible`, `isLocalOnly`, `readableEntries`, `consolidationEntries`). Les entrées `local-only` ne rejoignent jamais un chemin model-visible.
- **Chemins/options existants inchangés** : `dir` (env `OPENCODE_MEMORY_DIR`) devient la racine du coffre ; les ~22 options actuelles et leur validation restent acceptées ; les nouvelles options sont additives.
- **Écritures atomiques** partout (tmp + rename) ; sauvegarde de l'ancienne version dans `.memory/history/` avant toute réécriture de note au contenu différent.
- **Jamais de suppression silencieuse** : prune/forget/clear → archivage (déplacement vers `Archives/`, `status: ARCHIVED`). `SUPERSEDED` conserve sa sémantique actuelle (tombe prunée après 30 j → archivée).
- **Secrets** : jamais persistés — filtre sur chaque chemin d'écriture (`memory_write`, `memory_update`, faits de consolidation).
- **Id des notes** : `crypto.randomUUID()` ; canonique dans le frontmatter (`id:`) ; le nom de fichier est cosmétique (`<slug>-<id8>.md`), l'association se fait toujours par `id`.
- **Textes français/accentués** : aller-retour sans perte (NFC conservé dans le corps).
- **Pas de hook `experimental.*` supplémentaire** (le V1 garde uniquement l'existant `experimental.chat.system.transform`).
- **Idempotence de Dream** : relancer Dream ne crée ni doublon ni dégradation (fusion par paires déjà archivées = no-op ; sections générées régénérées à l'identique ; rapport du même jour réécrit, pas dupliqué).
- **La mémoire reste consultable sans le modèle de Dream** : tout échec provider → phase sautée, lexical + outils intacts.
- **`dreamApiKey` jamais loggée** (ni dans les logs, ni dans les erreurs affichées).

## Review Focus

Modes d'échec implicites par la spec, non couverts ailleurs, les plus susceptibles de mordre un utilisateur :

1. **Édition manuelle dans Obsidian** (corps + frontmatter) → doit être détectée et prise en compte à la lecture suivante. Test : `tests/vault-store.test.ts` « manual body edit is picked up » + « manual frontmatter edit is picked up ».
2. **Renommage manuel d'une note** → l'id frontmatter reste canonique, pas de duplication à l'écriture suivante. Test : `tests/vault-store.test.ts` « manual rename is preserved without duplication ».
3. **Suppression manuelle d'une note avant lecture** → non ressuscitée. Test : `tests/vault-store.test.ts` « manual deletion is not resurrected ».
4. **Frontmatter mal formé édité à la main** → note ignorée sans crash, erreur enregistrée dans l'index. Test : `tests/vault-note.test.ts` « malformed frontmatter is skipped with an error ».
5. **Secret dans une écriture ou un fait Dream** → refusé/ignoré, jamais persisté. Test : `tests/redaction.test.ts`.
6. **Dream interrompu en cours de run** → reprise via le journal `inProgress`, aucun doublon après retry. Test : `tests/dream.test.ts` « interrupted consolidation recovers without duplicates ».
7. **Caractères accentués/multilingues** → aller-retour frontmatter+corps sans corruption. Test : `tests/vault-note.test.ts` « french accents and quotes survive a round trip ».

---

### Task 1 : Corriger les 2 échecs Windows de `tests/config.test.ts` (ligne de base verte)

**Files:**
- Modify: `tests/config.test.ts:10,25` (test « plugin options override environment values… ») et `tests/config.test.ts:35,42` (test « every environment setting… »)

**Interfaces:**
- Consumes : `resolveConfig` (inchangée).
- Produces : ligne de base `bun test` 100 % verte sur Windows, prérequis de toutes les tâches suivantes.

- [ ] **Step 1: Corriger les valeurs attendues**

Les tests affichent `Received: "C:\tmp\memory-from-config"` : `resolveConfig` appelle `path.resolve()`, légitime. Corriger les tests pour attendre la valeur résolue par la plateforme :
- Test 1 : `expect(config.dir).toBe(path.resolve("/tmp/memory-from-config"))` (importer `resolve` de `node:path`).
- Test 2 : construire `const expected = { ...options, dir: path.resolve("/tmp/memory-all-options") }` puis `expect(resolveConfig(options, {})).toEqual(expected)`.

- [ ] **Step 2: Vérifier**

Run: `bun test tests/config.test.ts`
Expected: PASS (4 tests du fichier)

- [ ] **Step 3: Vérifier la ligne de base complète**

Run: `bun test`
Expected: 197+ pass, 0 fail

- [ ] **Step 4: Commit**

```bash
git add tests/config.test.ts
git commit -m "fix(tests): platform-resolved dir expectations in config tests"
```

---

### Task 2 : `src/vault/paths.ts` — layout du coffre

**Files:**
- Create: `src/vault/paths.ts`
- Test: `tests/vault-paths.test.ts`

**Interfaces:**
- Consumes : rien (module autonome).
- Produces (utilisés par T3–T10) :
  - `export type VaultPaths = { root: string; summary: string; global: string; projects: string; knowledge: string; knowledgeProjects: string; dreamReports: string; archives: string; memory: string; state: string; index: string; history: string; lock: string }`
  - `export function vaultPaths(root: string): VaultPaths` — root résolu ; `summary = <root>/SUMMARY.md`, `global = <root>/Global`, `projects = <root>/Projects`, `knowledge = <root>/Knowledge`, `knowledgeProjects = <root>/Knowledge/projects`, `dreamReports = <root>/Dream/reports`, `archives = <root>/Archives`, `memory = <root>/.memory`, `state = <root>/.memory/state.json`, `index = <root>/.memory/index.json`, `history = <root>/.memory/history`, `lock = <root>/.memory/.lock`
  - `export function hash8(value: string): string` — `crypto.createHash("sha256")` hex, 8 premiers caractères.
  - `export function slugify(text: string): string` — NFD + suppression diacritiques, lowercase, `[^a-z0-9]+` → `-`, trim `-`, 5 premiers mots / 40 caractères max, fallback `"memoire"`.
  - `export function projectFolderName(projectID: string): string` — `slugify(basename(projectID))` + `-` + `hash8(path.resolve(projectID))`.
  - `export function projectFolder(paths: VaultPaths, projectID: string): string` — `join(paths.projects, projectFolderName(projectID))`.
  - `export function noteFileName(id: string, text: string): string` — `` `${slugify(text)}-${id.slice(0, 8)}.md` ``.

- [ ] **Step 1: Écrire le test qui échoue** — `tests/vault-paths.test.ts` :
  - `vaultPaths("C:\\v")` produit tous les sous-chemins attendus (assertions sur chaque champ).
  - `hash8("a") === hash8("a")` et `hash8("C:\\a\\proj") !== hash8("C:\\b\\proj")` (même basename, parents différents).
  - `slugify("Préférences du user !!") === "preferences-du-user"` ; `slugify("") === "memoire"` ; `slugify("Une-phrase_avec.tirets") === "une-phrase-avec-tirets"`.
  - `projectFolderName` : deux chemins de même basename → noms de dossier différents.
  - `noteFileName("12345678-abcd-...", "The user likes coffee.") === "the-user-likes-coffee-12345678.md"`.

- [ ] **Step 2: Exécuter** — Run: `bun test tests/vault-paths.test.ts` — Expected: FAIL (module introuvable)

- [ ] **Step 3: Implémenter** `src/vault/paths.ts` selon les signatures ci-dessus.

- [ ] **Step 4: Exécuter** — Run: `bun test tests/vault-paths.test.ts` — Expected: PASS

- [ ] **Step 5: Commit** — `git add src/vault/paths.ts tests/vault-paths.test.ts && git commit -m "feat(vault): vault path layout with deterministic project folders"`

---

### Task 3 : `src/vault/note.ts` — sérialisation frontmatter ↔ Entry

**Files:**
- Create: `src/vault/note.ts`
- Test: `tests/vault-note.test.ts`

**Interfaces:**
- Consumes : `Entry`, `CATEGORIES`, `CORE_CATEGORIES` de `../core.ts` ; `Day` non requis.
- Produces (utilisés par T4, T5) :
  - `export type ParseResult = { entry: Entry } | { error: string }`
  - `export function renderNote(entry: Entry): string` — frontmatter plat dans l'ordre fixe : `id`, `type: memory`, `category`, `scope`, `project` (si défini), `tier`, `pinned` (si défini), `status`, `sensitivity`, `weight`, `confidence` (si défini), `source`, `createdBy` (si défini), `sourceSession` (si défini), `sourceMessages` (tableau inline `"..."` si défini), `created` (ISO), `lastSeen` (ISO), `extractedAt` (si défini), `expiresAt` (si défini), `lastSurfaced` (si défini), `surfacedCount`/`useCount`/`helpfulCount`/`irrelevantCount` (si définis), `related` (tableau inline si défini) ; puis `\n` + texte du corps + `\n`. Chaînes entre guillemets doubles (échapper `\` et `"`), nombres et booléens nus, timestamps en ISO 8601.
  - `export function parseNote(raw: string, fileName: string): ParseResult` — parser ligne à ligne : clôture `---`, paires `clé: valeur` (valeur après le premier `: `, guillemets retirés, `\\"`/`\\` déséchappés), tableaux inline `[a, b]`. Corps = tout après la première ligne vide suivant la clôture, trim. Validation : pas de frontmatter → `{ error }` ; `id` absent → `{ error }` ; corps vide → `{ error }`. Tolérance : clés inconnues ignorées ; `category` invalide ou `general` → `"other"` ; `tier`/`status`/`sensitivity` absents → défauts `normalizeStore` (core si `CORE_CATEGORIES`, sinon archival ; `ACTIVE` ; `normal`) ; dates acceptées en ISO datetime, ISO date (`YYYY-MM-DD`) ou epoch ms numérique ; `weight`/`confidence` numériques ou rejet silencieux (défaut).

- [ ] **Step 1: Écrire les tests qui échouent** — `tests/vault-note.test.ts` :
  - aller-retour complet (Entry avec tous les champs dont `sourceMessages`, `confidence`, `expiresAt`, `pinned`) : `renderNote` → `parseNote` → Entry deep-equal au original (comparer champ par champ) ;
  - aller-retour minimal (champs requis seulement) ;
  - « french accents and quotes survive a round trip » : texte `L'utente préfère le "verde" — café` ;
  - texte multiligne conservé ;
  - « malformed frontmatter is skipped with an error » : sans `---` → error ; `id` manquant → error ; corps vide → error ;
  - `category: "general"` → `"other"` ; catégorie inconnue → `"other"` ;
  - dates : ISO datetime, `2026-10-09`, epoch ms numérique → tous acceptés ;
  - clés inconnues ignorées (frontmatter enrichi par un plugin Obsidian).

- [ ] **Step 2: Exécuter** — Run: `bun test tests/vault-note.test.ts` — Expected: FAIL

- [ ] **Step 3: Implémenter** `src/vault/note.ts`.

- [ ] **Step 4: Exécuter** — Run: `bun test tests/vault-note.test.ts` — Expected: PASS

- [ ] **Step 5: Commit** — `git add src/vault/note.ts tests/vault-note.test.ts && git commit -m "feat(vault): markdown note serialization with flat frontmatter"`

---

### Task 4 : `src/vault/vaultStore.ts` — VaultIO (diff, index, sauvegardes, archivage)

**Files:**
- Create: `src/vault/vaultStore.ts`
- Test: `tests/vault-store.test.ts`

**Interfaces:**
- Consumes : `core.ts` (`Store`, `Entry`, `normalizeStore`, `emptyStore`), `vault/paths.ts` (T2), `vault/note.ts` (T3).
- Produces (consommé par T5–T10, même forme que l'actuel `StoreIO` de `src/store.ts`) :
  - `export type VaultIO = { withLock<T>(fn: () => Promise<T>): Promise<T>; getStore(): Promise<Store>; writeStore(store: Store): Promise<void>; getState(): Promise<State>; saveState(state: State): Promise<void> }` avec `State = { sessions: Record<string, number>; inProgress?: Record<string, InProgress> }`, `InProgress = { targetTs: number; startedAt: number; childID?: string }` (mêmes types que `src/store.ts`).
  - `export function createVaultStore(dataDir: string): VaultIO`

**Algorithme (non évident — à suivre) :**
- `getStore()` : scan récursif `.md` de `paths.global` + `paths.projects/*` ; index lu de `paths.index` (JSON `{ version: 1, files: { [cheminRelatif]: { id, mtimeMs, size, entry, error? } } }`) — corrompu/version autre → vide (rescan complet) ; pour chaque fichier : si l'index connaît le chemin avec même `mtimeMs`+`size` → Entry cachée réutilisée, sinon lecture + `parseNote` → succès mis en cache, erreur enregistrée dans `files[path].error` et fichier ignoré. `summary` = corps de `paths.summary` (ou `""`). Retour `normalizeStore({ version: 2, summary, updatedAt: max(lastSeen) ?? 0, entries })`.
- `writeStore(store)` : ① rescan frais (même mécanique, carte `id → { file, entry }`) ; ② pour chaque entrée du store : présente sur disque avec contenu identique (JSON canonique champ par champ) → no-op ; sinon écriture atomique (tmp+rename) dans `paths.global` ou `projectFolder(paths, projectID)` — si elle remplace un fichier au contenu différent, sauvegarde du brut dans `paths.history/<iso-ts>-<id8>.md` ; id absent du disque → note neuve nommée `noteFileName(id, text)` ; ③ chaque note disque active (`status !== "ARCHIVED"`) absente de `store.entries` → **archivage** : déplacement vers `paths.archives` (collision → suffixe `-2`, `-3`…), frontmatter réécrit `status: ARCHIVED` + `archivedAt: <ISO>`, brut original sauvegardé dans `history` ; ④ `paths.summary` réécrit (frontmatter `type: summary` + `updated` + corps = `store.summary`) ; ⑤ index persisté (fichiers disparus purgés).
- `getState`/`saveState` : JSON à `paths.state`, sous `withLock`, mêmes défauts que `src/store.ts`.
- `withLock` : même mécanique que `src/store.ts` (lockfile `paths.lock` + file d'attente locale par chemin — copier l'implémentation actuelle).
- **Invariant** : l'association fichier↔entrée se fait par `id` du frontmatter, jamais par nom de fichier attendu (les renommages manuels sont préservés) ; les notes neuves seules reçoivent le nom canonique.

- [ ] **Step 1: Écrire les tests qui échouent** — `tests/vault-store.test.ts` (dossiers temporaires via `mkdtemp`) :
  - aller-retour : `writeStore` (2 globales + 1 projet + summary) → `getStore` équivalent (entrées deep-equal, summary) ;
  - write→update→write : texte modifié → relu à jour ; fichier de sauvegarde créé dans `history` ; autres notes intactes ;
  - « prune/forget drops are archived » : `writeStore` sans une entrée → fichier déplacé dans `Archives/` avec `status: ARCHIVED` + `archivedAt` ; `getStore` l'exclut ;
  - archivage idempotent : 2ᵉ `writeStore` identique → un seul fichier dans `Archives/`, aucun doublon ;
  - « manual body edit is picked up » : réécriture manuelle du corps sur disque → `getStore` reflète le nouveau texte ;
  - « manual frontmatter edit is picked up » : `weight` modifié à la main → reflété ;
  - « manual rename is preserved without duplication » : renommage du fichier (contenu identique) → `getStore` rend toujours l'entrée ; `writeStore(store inchangé)` → nombre de fichiers stable ;
  - « manual deletion is not resurrected » : suppression du fichier AVANT `getStore` → entrée absente ; `writeStore` du store amputé → rien de recréé ;
  - isolement disque : entrées des projets A et B → fichiers sous `Projects/<folderA>/` et `Projects/<folderB>/` distincts ;
  - aller-retour `getState`/`saveState` à `.memory/state.json` ;
  - frontmatter corrompu à la main → `getStore` ignore la note sans crash ;
  - summary : écrit dans `SUMMARY.md` puis relu.

- [ ] **Step 2: Exécuter** — Run: `bun test tests/vault-store.test.ts` — Expected: FAIL

- [ ] **Step 3: Implémenter** `src/vault/vaultStore.ts`.

- [ ] **Step 4: Exécuter** — Run: `bun test tests/vault-store.test.ts` — Expected: PASS

- [ ] **Step 5: Exécuter la suite complète** — Run: `bun test` — Expected: les suites existantes passent toujours (rien ne consomme encore le coffre).

- [ ] **Step 6: Commit** — `git add src/vault/vaultStore.ts tests/vault-store.test.ts && git commit -m "feat(vault): markdown-backed store with diffing, index cache, backups and archiving"`

---

### Task 5 : Migration JSON→Markdown — `src/vault/migrate.ts`, délégation `store.ts`, mise à jour des tests épinglant le format

**Files:**
- Create: `src/vault/migrate.ts`
- Create: `scripts/migrate-vault.ts`
- Modify: `src/store.ts` (délégation + auto-migration)
- Modify: `tests/config-instances.test.ts:9`, `tests/e2e.test.ts:55-56`, `tests/fixtures/v2-check.ts:101,125-139`, `tests/fixtures/v1-flags-check.ts:42`
- Test: `tests/vault-migrate.test.ts`

**Interfaces:**
- Consumes : `createVaultStore` (T4), `normalizeStore` (core.ts), `vaultPaths` (T2).
- Produces :
  - `export type MigrationResult = { migrated: number; backup?: string; alreadyMigrated: boolean }`
  - `export async function migrateLegacyJson(dataDir: string, log?: (message: string) => void): Promise<MigrationResult>`
  - `createStore(dataDir)` (signature inchangée dans `src/store.ts`) → délègue à `createVaultStore` + `migrateLegacyJson` une fois par répertoire (garde module-level `Map<string, Promise<void>>`) ; les exports par défaut (`withLock`, `getStore`, `writeStore`, `getState`, `saveState`) restent identiques.
  - Script CLI : `bun run scripts/migrate-vault.ts [--dir <chemin>]` (défaut `resolveConfig().dir`), options `--rollback <backupDir>` (recopie store.json/state.json/SUMMARY.md de la sauvegarde à la racine) et `--verify` (recompte les notes vs `migrated`).

**Algorithme de migration (à suivre) :**
1. `store.json` absent de la racine → `{ migrated: 0, alreadyMigrated: true }` (idempotent).
2. Lire `store.json` → `normalizeStore` ; lire l'ancien `state.json` si présent.
3. Créer la sauvegarde `.memory/backup-<iso-ts>/` et y **copier** `store.json`, `state.json`, `SUMMARY.md` (existants seulement).
4. `createVaultStore(dataDir).writeStore(store)` → crée les notes + le nouveau `SUMMARY.md` + l'index.
5. Écrire l'état hérité dans `.memory/state.json` (même format `State`).
6. **Déplacer** `store.json` et l'ancien `SUMMARY.md` dans la sauvegarde (la racine n'a plus de JSON → 2ᵉ passage no-op). L'ancien `state.json` est déjà copié — le déplacer aussi. Rollback documenté : recopier le contenu de la sauvegarde à la racine.

- [ ] **Step 1: Écrire les tests qui échouent** — `tests/vault-migrate.test.ts` :
  - legacy → notes : répertoire temporaire avec `store.json` (2 globales + 1 projet + summary) et `state.json` → `migrateLegacyJson` → notes sous `Global/`/`Projects/…`, `SUMMARY.md` contient le summary, `store.json` déplacé dans `.memory/backup-…/`, `.memory/state.json` présent, `migrated === 3` ;
  - idempotent : 2ᵉ exécution → `alreadyMigrated === true`, aucun doublon de note ;
  - rollback : recopie de la sauvegarde → `store.json` d'origine relu tel quel ;
  - store.json corrompu → `migrated: 0`, aucun crash, sauvegarde quand même créée ? Non : fichier illisible → erreur explicite, rien déplacé (assertion).

- [ ] **Step 2: Exécuter** — Run: `bun test tests/vault-migrate.test.ts` — Expected: FAIL

- [ ] **Step 3: Implémenter** `src/vault/migrate.ts` + `scripts/migrate-vault.ts` + délégation `src/store.ts`.

- [ ] **Step 4: Mettre à jour les tests épinglant le format JSON**
  - `tests/config-instances.test.ts:9` : remplacer le `readFileSync(store.json)` par `createStore(dir).getStore()` et compter `entries`.
  - `tests/e2e.test.ts:55-56` : `storePath` → lecture via `getStore()` ; `statePath` → `join(E2E_MEMORY_DIR, ".memory", "state.json")`.
  - `tests/fixtures/v2-check.ts` : écriture d'état (l.101) → `.memory/state.json` ; lectures `store.json` (l.125-139) → `createStore(...).getStore()`.
  - `tests/fixtures/v1-flags-check.ts:42` : idem lecture via `getStore()`.
  - Vérifier aussi `scripts/verify-package.ts` : y mettre à jour toute référence à `store.json`/`state.json` (grep avant modification).

- [ ] **Step 5: Exécuter** — Run: `bun test` — Expected: PASS (adaptateurs désormais adossés au coffre, anciens stores migrés automatiquement)

- [ ] **Step 6: Vérifier le build** — Run: `bun run build && bun run typecheck` — Expected: OK

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(vault): JSON->Markdown migration with backup/rollback; store.ts delegates to vault"`

---

### Task 6 : `src/memory/redaction.ts` — filtre de secrets

**Files:**
- Create: `src/memory/redaction.ts`
- Modify: `src/core.ts` (`applyConsolidation` : ignorer les faits contenant un secret)
- Test: `tests/redaction.test.ts`

**Interfaces:**
- Consumes : rien (pur).
- Produces :
  - `export function findSecret(text: string): string | undefined` — retourne le **libellé** du motif détecté (jamais le secret) : clés `sk-…` (≥16 alnum), `ghp_/gho_/ghu_/ghs_/ghr_…` et `github_pat_…`, `AKIA…` (16), `xox[bpars]-…`, `glpat-…`, blocs `-----BEGIN … PRIVATE KEY-----`, et affectations génériques `\b(password|passwd|pwd|api[_-]?key|apikey|secret|token|bearer)\b\s*[:=]\s*["']?[^\s"']{6,}` (insensible à la casse). Le mot seul (« token », « la clé est expirée ») ne déclenche pas.
  - Dans `applyConsolidation` : chaque item de `parsed.new`/`parsed.update` dont `findSecret(item.text)` est défini est **ignoré** avec `log("warn", "dream fact skipped: potential secret", { label })` — aucune rédaction partielle.

- [ ] **Step 1: Écrire les tests qui échouent** — `tests/redaction.test.ts` :
  - positifs : `sk-abc123456789012345678`, `ghp_` + 36 alnum, `AKIAIOSFODNN7EXAMPLE`, PEM, `password: hunter22`, `api_key=xyz123456` → libellés distincts ;
  - négatifs : « The user likes TypeScript. », « The token policy is strict », « api_key rotation is documented » (pas de `:`/`=` + valeur), « The user's password manager is 1Password » (pas de séparateur) ;
  - intégration `applyConsolidation` : `parsed.new` contenant un fait avec `sk-…` → non ajouté au store ; les autres faits du même lot sont ajoutés.

- [ ] **Step 2: Exécuter** — Run: `bun test tests/redaction.test.ts` — Expected: FAIL

- [ ] **Step 3: Implémenter** `src/memory/redaction.ts` + la garde dans `applyConsolidation`.

- [ ] **Step 4: Exécuter** — Run: `bun test tests/redaction.test.ts && bun test tests/dedup.test.ts tests/store.test.ts` — Expected: PASS

- [ ] **Step 5: Commit** — `git add src/memory/redaction.ts src/core.ts tests/redaction.test.ts && git commit -m "feat(memory): secret detection on consolidation facts"`

---

### Task 7 : `src/memory/api.ts` + `src/memory/surface.ts` — logique des 9 outils partagée V1/V2, adaptateurs affinés

**Files:**
- Create: `src/memory/api.ts`, `src/memory/surface.ts`
- Modify: `src/v1.ts`, `src/v2.ts` (corps des outils + surface délégués ; consolidation encore inchangée dans cette tâche)
- Test: `tests/archive-behavior.test.ts` (+ suites existantes `tool-regressions`, `privacy`, `isolation` inchangées)

**Interfaces:**
- Consumes : `VaultIO` (T4), `MemoryConfig`, `core.ts` (toute la logique existante), `findSecret` (T6).
- Produces (consommés par les deux adaptateurs et T10) :
  - `export type ToolContext = { directory?: string; sessionID?: string; lastSurface?: Map<string, RankedMemory[]> }`
  - `export async function memoryRead(io: VaultIO, config: MemoryConfig, ctx: ToolContext, args: { query?: string; category?: string; scope?: "global" | "project" }): Promise<string>`
  - `export async function memoryWrite(io: VaultIO, config: MemoryConfig, ctx: ToolContext, args: { fact: string; category?: string; scope?: "global" | "project"; tier?: "core" | "archival" | "temporary"; ttlHours?: number; pinned?: boolean; sensitivity?: "normal" | "private" | "local-only" }): Promise<string>` — sémantique actuelle exacte (findWritableTarget, refresh, résolution de conflit, défauts de tier, prune) **+ garde `findSecret` → message de refus**.
  - `export async function memoryUpdate(io, config, ctx, args: { id?: string; match?: string; fact: string }): Promise<string>` — + garde `findSecret`.
  - `export async function memoryWhy(io, config, ctx, args: { id: string }): Promise<string>` — sortie identique à l'actuelle.
  - `export async function memoryInspect(io, config, ctx, args: { show?: "stats" | "recent" | "conflicts" | "project" | "surfaced"; limit?: number }): Promise<string>`
  - `export async function memoryUseful(io, config, ctx, args: { id: string }): Promise<string>`
  - `export async function memoryIrrelevant(io, config, ctx, args: { id: string }): Promise<string>`
  - `export async function memoryForget(io, config, ctx, args: { id?: string; match?: string }): Promise<string>` — la suppression passe par le retrait des entrées puis `writeStore` → **archivage automatique** (messages utilisateurs inchangés).
  - `export async function memoryClear(io, config, ctx, args: { scope?: "global" | "project"; summaryOnly?: boolean }): Promise<string>` — idem, archivage.
  - `src/memory/surface.ts` : `export async function buildMemoryBlock(deps: { io: VaultIO; config: MemoryConfig; directory: string | undefined; query: string; rerank?: (candidates: RankedMemory[]) => Promise<RankedMemory[]>; lastSurface: Map<string, RankedMemory[]> }): Promise<string | undefined>` (sélection retrieve → gate → core slot → lignes `<memory>` identiques) et `export async function markSurfaced(io: VaultIO, config: MemoryConfig, ids: string[], t?: number): Promise<void>` (portage direct de l'existant, io-based).
  - Les définitions d'outils (schémas `tool.schema` en V1, JSON Schema en V2) restent dans les adaptateurs ; leurs `execute` appellent `memory/api.ts`. V1 passe `ctx = { directory: ctx.directory, sessionID: ctx.sessionID, lastSurface }` ; V2 passe `{ directory: await this.directoryFor(...), sessionID, lastSurface }`.

- [ ] **Step 1: Écrire le test qui échoue** — `tests/archive-behavior.test.ts` (harness du même pattern que `tool-regressions.test.ts`, major 1 et 2) :
  - `memory_forget` → réponse « Forgot 1 entry. » **et** la note correspondante déplacée dans `Archives/` (vérif disque via `parseNote`) avec `status: ARCHIVED` ;
  - `memory_clear({ scope: "project" })` → seules les notes du projet courant archivées, celles de l'autre projet intactes ;
  - `memory_write` avec `fact: "The api key is sk-abc123456789012345678"` → réponse de refus, aucune note créée ;
  - `memory_update` avec un fait contenant un secret → refus, texte d'origine intact.

- [ ] **Step 2: Exécuter** — Run: `bun test tests/archive-behavior.test.ts` — Expected: FAIL

- [ ] **Step 3: Implémenter** `src/memory/api.ts` + `src/memory/surface.ts`, puis réécrire les corps des outils et de la surface dans `src/v1.ts`/`src/v2.ts` en délégations.

- [ ] **Step 4: Exécuter** — Run: `bun test` — Expected: PASS — notamment `tool-regressions`, `privacy`, `isolation`, `read-query` **sans modification** (messages et sorties identiques).

- [ ] **Step 5: Exécuter typecheck + build** — Run: `bun run typecheck && bun run build` — Expected: OK

- [ ] **Step 6: Commit** — `git add -A && git commit -m "refactor(memory): shared tool logic + surface module; adapters delegate"`

---

### Task 8 : `src/knowledge/notes.ts` — vues organisées Knowledge

**Files:**
- Create: `src/knowledge/notes.ts`
- Test: `tests/knowledge.test.ts`

**Interfaces:**
- Consumes : `VaultIO` (T4), `vaultPaths`/`projectFolderName` (T2), `noteFileName` (T2), `Store`/`readableEntries` (core.ts).
- Produces (consommé par T10 — Dream) :
  - `export type KnowledgeSyncResult = { updated: string[]; links: number }`
  - `export async function syncKnowledgeNotes(io: VaultIO, paths: VaultPaths, store: Store, log?: (level: LogLevel, message: string, extra?: Record<string, unknown>) => void): Promise<KnowledgeSyncResult>`
  - Fichiers générés : `Knowledge/decisions.md` (entrées `category=decisions`), `Knowledge/preferences.md` (entrées `preferences`), `Knowledge/projects/<projectFolderName(projectID)>.md` (entrées `scope=project` de CE projet uniquement). Chaque entrée listée : `` - [[<noteFileName sans .md>]] — <texte> (source: <source>, <ISO created>) `` — lien `[[...]]` vers la note mémoire source.
  - Sections générées délimitées par `<!-- dream:begin:<section> -->` / `<!-- dream:end:<section> -->` (sections `decisions`, `preferences`, `etat` + `decisions` dans les notes projet) ; tout contenu manuel **hors marqueurs est préservé** (lecture du fichier existant, remplacement des seules sections marquées ; en-tête + intro écrits à la création seulement).
  - Exclusion : entrées `local-only` jamais listées ; entrées `CONFLICTED` listées avec mention `(conflit à résoudre)`.
  - Idempotence : mêmes entrées → contenu identique ; aucune écriture si inchangé (`updated` vide au 2ᵉ passage).

- [ ] **Step 1: Écrire les tests qui échouent** — `tests/knowledge.test.ts` :
  - crée les 3 types de fichiers avec les entrées attendues ; le lien cible d'une ligne = `noteFileName(id, text)` de la note source (fichier réellement présent dans le coffre) ;
  - idempotent : 2ᵉ `syncKnowledgeNotes` → `updated: []` et contenu identique octet par octet ;
  - « manual content outside markers is preserved » : texte manuel ajouté hors marqueurs → encore présent après sync ;
  - isolement : note projet A contient uniquement les entrées de A ;
  - `local-only` jamais listée ; `CONFLICTED` mentionnée.

- [ ] **Step 2: Exécuter** — Run: `bun test tests/knowledge.test.ts` — Expected: FAIL

- [ ] **Step 3: Implémenter** `src/knowledge/notes.ts`.

- [ ] **Step 4: Exécuter** — Run: `bun test tests/knowledge.test.ts` — Expected: PASS

- [ ] **Step 5: Commit** — `git add src/knowledge/notes.ts tests/knowledge.test.ts && git commit -m "feat(knowledge): derived Obsidian notes with dream-marked sections and [[links]]"`

---

### Task 9 : `src/dream/provider.ts` + options de configuration Dream

**Files:**
- Create: `src/dream/provider.ts`
- Modify: `src/config.ts` (5 nouvelles options)
- Test: `tests/dream-provider.test.ts` (+ `tests/config.test.ts` étendu)

**Interfaces:**
- Consumes : `MemoryConfig`.
- Produces :
  - `export type DreamModel = { complete(req: { prompt: string; timeoutMs?: number }): Promise<string> }`
  - `export type DreamProviderConfig = { kind: "opencode" } | { kind: "openai-compatible"; baseUrl: string; apiKey?: string; model: string; extraHeaders?: Record<string, string> }`
  - `export function dreamProviderConfig(config: MemoryConfig): DreamProviderConfig`
  - `export function createOpenAICompatibleModel(cfg: Extract<DreamProviderConfig, { kind: "openai-compatible" }>): DreamModel` — `fetch(\`${baseUrl}/chat/completions\`)` POST, headers `content-type` + `authorization: Bearer` si `apiKey` + `extraHeaders`, corps `{ model, messages: [{ role: "user", content: prompt }], stream: false }`, `AbortSignal.timeout(timeoutMs ?? 120_000)` ; retourne `choices[0].message.content` ; statut non-2xx → throw avec le statut (jamais le corps, jamais la clé).
  - Config (`src/config.ts`) : `OPTION_ENV` + `dreamProvider: "OPENCODE_MEMORY_DREAM_PROVIDER"`, `dreamModel: "OPENCODE_MEMORY_DREAM_MODEL"`, `dreamBaseUrl: "OPENCODE_MEMORY_DREAM_BASE_URL"`, `dreamApiKey: "OPENCODE_MEMORY_DREAM_API_KEY"`, `staleDays: "OPENCODE_MEMORY_STALE_DAYS"` ; `MemoryConfig` + `dreamProvider: "opencode" | "openai-compatible"` (défaut `"opencode"`), `dreamModel?: string`, `dreamBaseUrl?: string`, `dreamApiKey?: string`, `staleDays: number` (défaut 90, min 1). Validation : `dreamProvider` hors enum → throw en listant les valeurs valides ; `kind === "openai-compatible"` sans `dreamBaseUrl` → throw `dreamBaseUrl` ; chaînes vides rejetées. **`dreamApiKey` n'apparaît dans aucun log.**

- [ ] **Step 1: Écrire les tests qui échouent** — `tests/dream-provider.test.ts` (mock endpoint `Bun.serve` sur port 0, pattern de `scripts/verify-runtime.ts`) :
  - serveur mock OpenAI-compatible → `createOpenAICompatibleModel(...).complete({ prompt })` renvoie le contenu fixé ;
  - statut 500 → throw ;
  - timeout → throw ;
  - `dreamProviderConfig` : défaut → `{ kind: "opencode" }` ; options complets → config attendue ;
  - `tests/config.test.ts` : étendre le test « every environment setting… » avec les 5 nouveaux champs, et ajouter les cas invalides (`dreamProvider: "mistral"` → throw ; `dreamProvider: "openai-compatible"` sans `dreamBaseUrl` → throw `dreamBaseUrl`).

- [ ] **Step 2: Exécuter** — Run: `bun test tests/dream-provider.test.ts tests/config.test.ts` — Expected: FAIL

- [ ] **Step 3: Implémenter** `src/dream/provider.ts` + options `src/config.ts`.

- [ ] **Step 4: Exécuter** — Run: `bun test tests/dream-provider.test.ts tests/config.test.ts && bun test tests/config-instances.test.ts` — Expected: PASS

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(dream): configurable model provider (opencode | openai-compatible) + staleDays option"`

---

### Task 10 : `src/dream/prompts.ts` + `src/dream/dream.ts` — consolidation partagée + phase organisation ; adaptateurs branchés sur Dream

**Files:**
- Create: `src/dream/prompts.ts`, `src/dream/dream.ts`
- Modify: `src/v1.ts`, `src/v2.ts` (consolidation déléguée ; organisation déclenchée après consolidation réussie et après sweep)
- Test: `tests/dream.test.ts`

**Interfaces:**
- Consumes : `VaultIO` (T4), `vaultPaths` (T2), `findSecret` via `applyConsolidation` (T6), `syncKnowledgeNotes` (T8), `DreamModel` (T9), `applyConsolidation`/`prune`/`consolidationEntries`/`extractJson` (core.ts).
- Produces :
  - `src/dream/prompts.ts` : `export function consolidationPrompt(input: { entriesBlock: string; transcript: string; sessionTitle?: string; summary: boolean }): string` (texte canonique = prompt actuel de `src/v2.ts` l.352-385, tâches new/update/delete/conflicts/summary, hiérarchie de sources, règle « same language ») ; `export function dedupPrompt(input: { entryLines: string; candidateLines: string }): string` (texte actuel) ; `export function enrichmentPrompt(input: { projectName: string; facts: string[] }): string` (nouveau : « 3-6 phrases sur l'état du projet en n'utilisant QUE les faits ci-dessous, aucune invention, texte brut »).
  - `src/dream/dream.ts` :
    - `export type DreamSession = { id: string; directory?: string; title?: string }`
    - `export type ConsolidationInput = { transcript: string; messageIDs: string[]; lastTs: number }`
    - `export type OrganizationReport = { duplicatesArchived: number; staleProposed: number; knowledgeUpdated: string[]; enriched: boolean }`
    - `export async function runConsolidation(io: VaultIO, config: MemoryConfig, model: DreamModel, session: DreamSession, input: ConsolidationInput, log: Log): Promise<"committed" | "skipped" | "failed">` — portage exact du two-phase commit existant : gardes (`lastTs <= sessions[sessionID]` → skipped ; `inProgress` frais → skipped ; staleness → recovery), `entriesBlock` via `consolidationEntries(store, session.directory)`, `model.complete(consolidationPrompt(...))`, `extractJson` (validation `Array.isArray(parsed.new)`), second passage dedup via `model.complete(dedupPrompt(...))`, `withLock` → `applyConsolidation(fresh, parsed, session.directory, now, log, { sessionID, messageIDs })` + `prune` + `writeStore`, puis commit `sessions[sessionID] = lastTs` et retrait de `inProgress`.
    - `export async function runDreamOrganization(io: VaultIO, config: MemoryConfig, paths: VaultPaths, model: DreamModel | undefined, log: Log): Promise<OrganizationReport>` — ① doublons dreamed : paires `ACTIVE`/`dreamed` avec `topicClash` OU `similarity ≥ 0.8` → la moins bien notée retirée des entrées puis `writeStore` (archivage) — les explicites jamais touchées ; ② `syncKnowledgeNotes` ; ③ enrichissement (si `model`) : par projet ≥ 3 entrées, `model.complete(enrichmentPrompt(...))` → section `<!-- dream:begin:synthese -->` de la note Knowledge projet (échec → skip, `enriched: false`) ; ④ obsolescence : entrées `ACTIVE`, non `pinned`, `tier !== "core"`, `lastSeen < now - staleDays*Day` → listées dans `Dream/reports/<YYYY-MM-DD>.md` (section « Propositions d'archivage » : id, texte, âge) — **proposition seule, pas d'archivage automatique**, réécriture du rapport du même jour (idempotent) ; ⑤ retour du rapport.
  - Adaptateurs : V1 construit le `DreamModel` en enveloppant son flux actuel (create child → promptAsync → waitForReply → delete) dans `complete()` ; V2 enveloppe `ctx.generate.text`. V1 extrait messages/transcript (shape `{info, parts}`) puis appelle `runConsolidation` ; V2 idem (shape V2). Après consolidation « committed » et après le sweep de recovery, déclencher `runDreamOrganization` (sous `CONFIG.dream`, try/catch, échecs loggés sans casser le tour).

- [ ] **Step 1: Écrire les tests qui échouent** — `tests/dream.test.ts` (fake `DreamModel` retournant des JSON figés, coffres temporaires) :
  - consolidation : JSON valide → notes créées dans le coffre, `sessions[sessionID]` committé ; 2ᵉ appel même `lastTs` → `"skipped"`, aucun doublon ;
  - « interrupted consolidation recovers without duplicates » : modèle qui throw après l'écriture de `inProgress` → 1ᵉʳ appel `"failed"` ; retry avec modèle valide → `"committed"`, exactement une note par fait, `inProgress` vidé ;
  - « memory remains usable without the dream model » : modèle qui throw → `"failed"`, store intact, `getStore()` fonctionne ;
  - faits avec secrets ignorés (via la garde T6) ;
  - organisation : 2 dreamed quasi-doublons → 1 archivé dans `Archives/`, l'autre conservé ; paire d'explicites équivalente **intacte** ;
  - organisation idempotent : 2ᵉ exécution → `duplicatesArchived: 0`, `knowledgeUpdated: []` ;
  - obsolescence : entrée `lastSeen` à 120 j (`staleDays: 90`) → présente dans `Dream/reports/<aujourd'hui>.md` et **toujours `ACTIVE`** dans `getStore` ; entrée `pinned` et entrée `tier: core` de même âge absentes du rapport ;
  - rapport du même jour réécrit sans duplication ;
  - enrichissement : modèle mock → section `synthese` insérée dans la note Knowledge projet ; modèle throw → section absente, rapport rendu quand même.

- [ ] **Step 2: Exécuter** — Run: `bun test tests/dream.test.ts` — Expected: FAIL

- [ ] **Step 3: Implémenter** `src/dream/prompts.ts` + `src/dream/dream.ts`, puis brancher `src/v1.ts`/`src/v2.ts`.

- [ ] **Step 4: Exécuter** — Run: `bun test` — Expected: PASS (suites e2e/tool-regressions/v2-adapter comprises)

- [ ] **Step 5: Vérifier le banc** — Run: `bun run bench` — Expected: scénarios exécutés sans erreur (retrieval inchangé).

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(dream): shared consolidation + organization phase (duplicates, knowledge, staleness) with injectable model"`

---

### Task 11 : Documentation + vérification finale

**Files:**
- Modify: `README.md`, `CHANGELOG.md`
- Modify: `package.json` (version `2.0.0`)

**Interfaces:**
- Consumes : tout le reste.
- Produces : documentation à jour + vérification complète verte.

- [ ] **Step 1: Mettre à jour `README.md`**
  - Section « Stockage Obsidian » : layout du coffre (D2), format de note (D3), invariants (id canonique, renommages manuels préservés, éditions détectées).
  - Section « Configuration » : tableau des nouvelles options (`dreamProvider`, `dreamModel`, `dreamBaseUrl`, `dreamApiKey` (env seulement — ne pas committer de clé), `staleDays`) avec exemples pour un Mistral local (`baseUrl: http://127.0.0.1:11434/v1`).
  - Section « Migration depuis 1.x » : migration automatique au premier démarrage, script `bun run scripts/migrate-vault.ts` (`--dir`, `--verify`, `--rollback`), procédure de retour arrière.
  - Sections « Dream » (provider configurable, obsolescence en propositions, idempotence, mémoire consultable sans modèle) et « Knowledge » (notes dérivées, marqueurs, liens).
  - Mettre à jour la liste des fonctionnalités (JSON → coffre Obsidian, archivage, secrets).

- [ ] **Step 2: Mettre à jour `CHANGELOG.md`** — entrée `## [2.0.0]` : breaking (format de stockage Markdown + migration auto), ajouté (Vault, Knowledge, organisation Dream, provider configurable, filtre de secrets, archivage), corrigé (tests Windows).

- [ ] **Step 3: `package.json`** — `"version": "2.0.0"`, description mentionnant le coffre Obsidian.

- [ ] **Step 4: Vérification complète** — Run: `bun run check` (typecheck + test + build) — Expected: tout vert. Puis `bun test` complet : 0 fail.

- [ ] **Step 5: Commit final** — `git add -A && git commit -m "docs: Obsidian vault storage, migration procedure, Dream provider; release 2.0.0"`

---

## Couverture de la spec (auto-revue)

- §2 Objectifs (retenir entre sessions, décisions/préférences/état, séparation global/projet, Dream, Markdown Obsidian, modularité) → T4 (coffre), T7 (outils), T8 (Knowledge), T10 (Dream).
- §3 Architecture Memory/Knowledge/Dream à interfaces documentées → T7 (`memory/api.ts`, `memory/surface.ts`), T8, T10 ; interfaces bloquées dans chaque tâche.
- §4 Obsidian source de vérité (YAML, ids stables, `[[...]]`, provenance, statuts, archives, chemin configurable, cache reconstructible, éditions manuelles) → T2, T3, T4, T5 ; éditions manuelles → Review Focus 1–3.
- §5 WRITE/DREAM/SURFACE → T7 (WRITE/SURFACE conservés), T10 (DREAM enrichi) ; sélectivité conservée (gate + core slot inchangés).
- §6 Provider Dream configurable (Mistral local possible, sans dépendance, mémoire consultable sans modèle) → T9, T10.
- §7 Fiabilité (pas de suppression silencieuse, audit, conflits, isolement, secrets, sauvegarde, récupération, idempotence) → T4 (backups+archivage), T5 (migration), T6 (secrets), T10 (récupération+idempotence) ; conflits et isolement conservés de la base.
- §8 Compatibilité OpenCode → Global Constraints + T7/T10 (adaptateurs conservés, aucun hook expérimental ajouté).
- §9 Méthode → audit produit (`docs/audit-obsidian-memory.md`), migration définie avant écriture, vérifications à chaque tâche.
- §10 Limites v1 → pas de GUI, pas de graphe complexe, pas de synchro multi-appareils : Knowledge minimal (3 types de notes), topics en YAGNI.
