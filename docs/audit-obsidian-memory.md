# Audit technique — transformation d'opencode-memory en système de mémoire Obsidian

*Date : 2026-10-09 · Base auditée : cioffiAI/opencode-memory @ 22e5744 (v1.7.2)*

## 1. Vue d'ensemble de la base existante

Plugin OpenCode unique, deux adaptateurs runtime délibérément séparés partageant le même
modèle de données :

| Module | Taille | Rôle |
|---|---|---|
| `src/index.ts` | 17 l. | Entrypoint : V2 via `Plugin.define({id, setup})`, V1 ≥ 1.18.29 via `server()` |
| `src/core.ts` | 878 l. | **Logique pure** (zéro dépendance runtime) : types `Entry`/`Store`, scoring (décroissance exp. + bonus d'utilisation), tokens/similarity, `topicClash`, politique scope/privacy (`projectVisible`, `isLocalOnly`, `readableEntries`, `consolidationEntries`, `findWritableTarget`), grammaire de requête `memory_read`, `readQuery`, feedback (surface/useful/irrelevant), parsing JSON structuré, `addEntry`, `prune`, `applyConsolidation`, synonymes bilingues, pipeline de retrieval (`retrieve`, `classifyMatch`, `passesRelevanceGate`, `coreSlot`) |
| `src/store.ts` | 145 l. | I/O : `store.json` (écriture atomique tmp+rename), `state.json` (journal `inProgress` + `sessions`), `SUMMARY.md`, lockfile inter-processus + file d'attente locale |
| `src/config.ts` | 148 l. | `resolveConfig` (options/env, validation stricte, ~22 options), `SESSION_TOOLS_DENY_ALL` |
| `src/v1.ts` | 1059 l. | Adaptateur V1 : consolidation headless (session enfant `SESSION_TOOLS_DENY_ALL`), sweep, GC des orphelins, injection `<memory>` via `experimental.chat.system.transform`, 9 tools `memory_*` |
| `src/v2.ts` | 929 l. | Adaptateur V2 (`V2MemoryRuntime`) : `ctx.tool.transform`, `ctx.session.hook("context")`, `ctx.generate.text` (zéro session helper), events `session.execution.*`, recovery par journal, 9 tools `memory_*` |
| `src/rerank.ts` | 151 l. | Rerank sémantique optionnel (client injecté, cache, abstention, fallback lexical déterministe) |
| `bench/` | — | Scénarios + held-out + fichiers de preuve (`evidence/v1.5.1-fp-taxonomy.json`) |
| `scripts/` | — | `verify-package.ts` (contrats runtime clean-install), `verify-runtime.ts` (CLI réel + modèle mock) |

**Tests** : 201 tests, 16 fichiers. Ligne de base mesurée sur cette machine (Bun 1.4.2,
Windows) : **197 pass, 2 fail, 2 skip**. Les 2 échecs sont pré-existants et spécifiques
Windows : `tests/config.test.ts` utilise des chemins `/tmp/...` que `path.resolve()`
convertit en `C:\tmp\...` (la logique de config est correcte, les tests ne sont pas
portables). Les 2 skip sont des tests conditionnels (`isolation`).

## 2. Fonctionnalités fiables réutilisables (à conserver)

1. **Logique pure de `core.ts`** — entièrement testée unitairement ; scoring, retrieval,
   grammaire de requête, `applyConsolidation` avec hiérarchie de sources explicite > dreamed.
2. **Politique scope/privacy single-source-of-truth** (`core.ts`) — couverte par
   `tests/containment.test.ts`, `isolation.test.ts`, `privacy.test.ts`.
3. **Journal `inProgress` à deux phases** (at-least-once sans doublon, récupérable après
   crash) + lockfile inter-processus + écritures atomiques.
4. **Provenance complète** : `createdBy`, `sourceSessionID`, `sourceMessageIDs`,
   `extractedAt`, `confidence` — exposée par `memory_why`.
5. **Cycle de vie** : `ACTIVE`/`CONFLICTED`/`SUPERSEDED`, tiers core/archival/temporary,
   `pinned`, `expiresAt`, feedback usage.
6. **Rerank avec abstention + fallback déterministe** (jamais de devinette).
7. **Contrats de sécurité vérifiés** : `SESSION_TOOLS_DENY_ALL` (allow-none true),
   exclusion `local-only` de tout chemin model-visible (défense en profondeur).
8. **Bancs d'essai falsifiables** avec fichiers de preuve et scénarios held-out.

## 3. Limites & risques pour la transformation Obsidian

| # | Limite | Impact |
|---|---|---|
| L1 | Stockage JSON mono-fichier (`store.json`) | Illisible/ineditable dans Obsidian ; c'est le point central de la mission |
| L2 | Aucun composant Knowledge | Pas de notes structurées (décisions, état projet), pas de liens `[[...]]` |
| L3 | Dream = consolidation transcript→faits uniquement | Pas d'organisation de fichiers, de liens, de détection d'obsolescence à l'échelle du coffre, pas d'enrichissement |
| L4 | Modèle de Dream non configurable | V2 utilise `ctx.generate.text` (modèle de session), V1 des sessions enfants ; pas d'interface provider (Mistral local impossible) |
| L5 | Aucune détection des modifications manuelles du store | Avec des notes Markdown, les éditions Obsidian doivent être relues (mtime/hash) |
| L6 | Pas de sauvegarde/historique des modifications | Tombstones oui, mais aucune copie de secours des fichiers |
| L7 | Pas de détection de secrets | Le prompt demande de ne pas en stocker, mais aucun filtre ne refuse une fuite |
| L8 | `memory_forget`/`memory_clear` suppriment dur | Mission : « ne jamais supprimer silencieusement ; archiver » |
| L9 | 2 tests échouent sous Windows | À corriger pour obtenir une ligne de base verte |
| L10 | Duplication massive v1/v2 (~600 l. de logique de tools dupliquée) | Tout changement de logique doit être fait deux fois — frein direct à la modularité demandée |
| L11 | Tests épinglant le format JSON (`store.json`/`state.json` lus directement) | Devront être mis à jour avec la migration (c'est attendu) |

## 4. Écarts par rapport aux objectifs de la mission

| Objectif mission | État actuel | Action |
|---|---|---|
| Obsidian source de vérité (Markdown, YAML, ids stables, `[[...]]`, provenance, statuts) | JSON privé | **Nouveau composant Vault** (T1–T4) |
| Mémoire globale / par projet séparées | `projectID` = répertoire absolu, isolation vérifiée | Conservé + dossiers `Projects/<nom>-<hash8>/` déterministes |
| Composants Memory / Knowledge / Dream à interfaces documentées | core+store+v1+v2 entrelacés | **Refactoring modulaire** (T6–T9) |
| Dream améliore la mémoire (doublons, contradictions, liens, obsolescence, provenance, idempotent) | consolidation seule | **Phase « organisation » dans Dream** (T9) |
| Provider de modèle configurable (Mistral local possible, pas de dépendance) | hardcodé par adaptateur | **`dream/provider.ts`** : `opencode` \| `openai-compatible` (T8) |
| Mémoire consultable sans le modèle de Dream | déjà vrai (lexical + tools indépendants) | Conservé + testé |
| Ne jamais supprimer silencieusement ; archive | suppressions dures | **Archivage** (forget/clear/prune → `Archives/`) (T3, T6) |
| Secrets jamais stockés | filtre absent | **Filtre lexical de secrets** sur les écritures (T5) |
| Sauvegarde / historique | absent | **`.memory/history/` + backups de migration** (T3, T4) |
| Migration JSON→Markdown avec retour arrière | n/a (JSON = format actuel) | **`scripts/migrate-vault.ts` + auto-migration** idempotente (T4) |
| Modifications manuelles détectées | n/a | **Re-scan incrémental (mtime+taille) à chaque lecture** (T3) |
| Cache reconstructible, pas 2ᵉ source de vérité | n/a | **`.memory/index.json`** cache de parse uniquement, invalide → rescan complet (T3) |
| Compatibilité API OpenCode (V1 ≥ 1.18.29, V2 ≥ 2.0.18) | vérifiée, testée | Conservée ; pas de hook expérimental supplémentaire |

## 5. Décisions de conception proposées

- **D1 — Chemin du coffre** : l'option existante `dir` (env `OPENCODE_MEMORY_DIR`) devient
  la racine du coffre Obsidian. Un seul concept de chemin, config rétrocompatible, défaut
  inchangé (`~/.local/share/opencode/memory`) et configurable.
- **D2 — Layout du coffre** :
  ```
  <vault>/
    SUMMARY.md              # synthèse globale (note Home/MOC ; format existant conservé)
    Global/                 # mémoires scope=global — une note par mémoire
    Projects/<nom>-<hash8>/ # mémoires scope=project (hash8 = SHA-256 tronqué du répertoire)
    Knowledge/              # notes structurées Dream (decisions.md, preferences.md, projects/…)
    Dream/reports/          # rapports Dream (doublons, obsolescence, propositions)
    Archives/               # mémoires archivées (forget/clear/expire/superseded)
    .memory/                # state.json (journal), index.json (cache), history/ (backups)
  ```
  Le nom de dossier projet = basename assaini + hash8 du chemin absolu (déterministe,
  anti-collision) ; chaque note porte le `projectID` complet en frontmatter.
- **D3 — Format de note mémoire** : frontmatter YAML plat écrit par nos soins (aucune
  dépendance — le projet affiche « zero external database », on garde zéro dépendance
  externe) : `id` (UUID stable, canonique), `type`, `category`, `scope`, `project`, `tier`,
  `pinned`, `status` (+ `ARCHIVED`), `sensitivity`, `weight`, `confidence`, `source`,
  `createdBy`, `sourceSession`, `sourceMessages`, `created`, `lastSeen`, `extractedAt`,
  `expiresAt`, `lastSurfaced`, `related`. Corps = texte de la mémoire (les éditions
  manuelles du corps sont donc reprises). Liens de relations dans `related:` (frontmatter)
  et sections générées des notes Knowledge (pas d'injection `[[...]]` dans les prompts).
- **D4 — Interface de persistance inchangée** : `VaultIO` expose exactement l'interface
  actuelle (`withLock`, `getStore`, `writeStore`, `getState`, `saveState`) → adaptateurs et
  tests conservent leurs points d'entrée ; seul le stockage change dessous.
- **D5 — `writeStore` par diff** : compare aux notes sur disque (relecture fraîche sous
  lock) — créations/changes → écriture atomique + sauvegarde de l'ancienne version dans
  `.memory/history/` ; entrées actives absentes du nouveau store (prune/forget/clear) →
  **archivage** (déplacement vers `Archives/`, `status: ARCHIVED`), jamais suppression.
  Une note supprimée manuellement dans Obsidian n'est pas ressuscitée (la suppression
  manuelle gagne).
- **D6 — Filtre de secrets** : motifs lexicaux (clés `sk-…`, `ghp_…`, `AKIA…`, PEM,
  `password=/api_key=/token=…`) ; `memory_write` refuse avec message clair ; Dream ignore
  un fait contenant un secret (pas de rédaction partielle).
- **D7 — Provider Dream** : `kind: "opencode"` (défaut : comportement actuel de chaque
  adaptateur) ou `kind: "openai-compatible"` (POST `{baseUrl}/chat/completions`, options
  `dreamModel`, `dreamBaseUrl`, `dreamApiKey` — compatible Ollama/LM Studio/vLLM pour un
  Mistral local). Indisponibilité du modèle → phase Dream sautée, mémoire intacte.
- **D8 — Dream organisation** (idempotente par construction) : détection de doublons
  dreamed (fusion, jamais les explicites), rafraîchissement des notes Knowledge (sections
  générées entre marqueurs `<!-- dream:begin/end -->`, contenu manuel préservé),
  détection d'obsolescence (> `staleDays` jours, non épinglée/non core) → **proposition**
  dans `Dream/reports/<date>.md` (pas d'archivage automatique).
- **D9 — Composant Memory** : `core.ts` conservé comme noyau pur + nouveau
  `memory/api.ts` (logique des 9 tools partagée V1/V2, contexte neutre
  `{directory, sessionID, lastSurface}`) + `memory/redaction.ts`. Les adaptateurs
  s'affinent (fin de la duplication L10).
- **D10 — Composant Knowledge** : `knowledge/notes.ts` — vues organisées régénérables
  (decisions, preferences, état par projet avec liens `[[...]]` vers les notes sources).
  Les notes mémoire restent canoniques ; Knowledge n'est pas une 2ᵉ source de vérité.

## 6. Recommandation de stratégie de migration

1. Corriger d'abord les 2 échecs Windows (ligne de base verte).
2. Construire la couche Vault **sous l'interface existante** (`VaultIO`) — les adaptateurs
   V1/V2 continuent de fonctionner pendant toute la migration (chaque phase se termine
   par une suite verte).
3. Migration des données : à la première utilisation du coffre, si `store.json` hérité
   existe → sauvegarde complète dans `.memory/backup-<iso-ts>/` (store.json, state.json,
   SUMMARY.md), conversion entrée→note par id, déplacement des fichiers hérités vers la
   sauvegarde. Idempotent (2ᵉ passage = no-op). Retour arrière : recopier le contenu de la
   sauvegarde à la racine du coffre et repasser à l'ancienne version du plugin (le format
   JSON est préservé tel quel dans la sauvegarde).
4. Mettre à jour les tests épinglant le format JSON (L11) au fur et à mesure.

## 7. Points non vérifiables dans cette session

- Les vérifications CLI réelles (`scripts/verify-runtime.ts`) exigent `OPENCODE_TEST_BIN`
  (binaire opencode local) et un profil isolé — à exécuter par l'utilisateur si souhaité.
- Le comportement en conditions réelles Obsidian (editing concurrent, plugins communautaires
  d'Obsidian qui réécrivent le frontmatter) ne peut être qu'estimé ; le format plat et la
  relecture par mtime limitent le risque.
