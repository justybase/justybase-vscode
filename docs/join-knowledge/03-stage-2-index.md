# Stage 2 — workspace SQL index (starts only after Stage 1 gate)

Status: **passed (2026-10-25)**. The index is off by default
(`justybase.sql.joinKnowledgeIndex: false`). Calibration evidence lives in
`08-stage-2-calibration.md`; the six-point gate is recorded below.

Scope:

- One parse pass per statement for JOIN relations + object references (SELECT/INSERT/UPDATE/DELETE,
  per-kind counters, confidence; ambiguous/DDL skipped, never guessed).
- File selection: `**/*.sql` + excludes + `.gitignore` + caps (2000 files, 2 MB/file, 64 MB total).
- Git window as file-selection shortcut only (default 365, `0` = unlimited): log + status + HEAD key,
  dirty/untracked/open files always included, mtime fallback, 10 s timeout, byte cap. Git history itself is
  never parsed as evidence.
- Incremental index: per-file `{relPath, size, mtimeMs, contentHash, relations[], objects[], fingerprints[]}`;
  single-file edit ⇒ one re-parse + affected-keys upsert only, no git call, no full rebuild.
- Persistence per source; snapshot publish (full + upsert groups); truncation explicit.

Dependencies: Stage 1 model + fragment 1a (identity keys and qualification must already be correct,
otherwise the index bakes in wrong keys).

Out of scope: import/export, executed-query learning, AI. Accepted completion
selection was implemented later as a half-weight signal; the A/B/C/D/E evidence
split and remaining Stage 5 capture prerequisites are recorded in
`06-stage-5-learning.md`; Stage 2 stores workspace-file evidence only.

## Mandatory index-consistency gate (Stage 2 is NOT done without it)

Separately tested, not just "incremental re-parse works":

1. modified file ⇒ only that file re-parsed, its old contributions removed;
2. deleted/renamed file ⇒ its evidence gone, relations/objects below threshold disappear from ranking;
3. untracked + dirty + open-in-editor files are indexed despite the git window;
4. branch switch / `.git/HEAD` change ⇒ stale evidence from the previous branch removed, no manual decisions touched;
5. interrupted (killed mid-index) run ⇒ restart resumes from persisted per-file hashes without full re-parse;
6. rebuild command ⇒ deterministic result (sort twice, compare serialized labels).

After 1–6 the ranked output must equal the current source state: no ghost relations, no ghost object bands.
Manual overrides (`overrides.json`, `object-overrides.json`) survive all six.

Acceptance:

- Tests 12–16, 31, 37–39, 43 green; defaults off; `showJoinKnowledgeStatus` reviewed on ≥ 1 real workspace
  (skip reasons, truncation, git mode).
- Calibration report attached: Top-1/Top-5 hit rate vs maintainer expectation + re-index stability.
  Manual-correction half is added after Stage 3, before any default is flipped.
- Doc-compliance check: breadth uses the §1 OR threshold (≥ 2 distinct files or 1 file with ≥ 3
  independent queries) with §4.6 normalization; executed success is not treated as semantic
  correctness; object evidence never creates/promotes a JOIN.

## Implementation record

Code paths:

- `packages/sql-core/src/joinKnowledge/workspaceIndex.ts` — deterministic
  aggregate, object band formula, affected-key diff, skip counters.
- `packages/sql-core/src/joinKnowledge/types.ts` / `store.ts` — workspace
  snapshot/delta types, favorite preference, evidence round-trip parsing.
- `src/knowledge/workspaceSqlExtractor.ts` — one parse pass per statement,
  CST-based JOIN + object extraction.
- `src/knowledge/workspaceIndexEngine.ts` — per-file hash cache, checkpoint,
  interruption resume, caps, deterministic snapshot.
- `src/knowledge/workspaceIndexPersistence.ts` — `workspace-index.json` in the
  workspace storage root; identifiers, paths, hashes and counters only.
- `src/knowledge/workspaceIndexCoordinator.ts` — `**/*.sql` selection,
  `.gitignore`/excludes, Git window/status/HEAD, dirty/open files, watchers,
  debounce, branch refresh, status counters.
- `src/server/completionScopeResolver.ts` / `completionRenderer.ts` — workspace
  JOIN tier `0_5_`, favorite tier `0_3_`, learned FROM bands.
- `src/activation/joinKnowledgeRegistration.ts` — lifecycle, commands and LSP
  full/delta publication.

### Six-point consistency gate

Each scenario has a dedicated test in
`src/__tests__/knowledge/workspaceIndexEngine.test.ts`:

| # | Scenario | Test outcome |
|---|---|---|
| 1 | modified file | only the changed file is re-parsed; its old relation disappears; unchanged file is reused |
| 2 | deleted/renamed file | stale evidence is removed; below-threshold relations are not ranked |
| 3 | untracked/dirty/open files | `isWorkspaceFileSelected` keeps them despite a Git window |
| 4 | branch switch / HEAD change | changed content replaces the previous relation; `head` is persisted; manual decisions are untouched (deterministic engine test + real two-branch Extension Host switch) |
| 5 | interrupted run | per-file checkpoint resumes with reused hashes instead of a full re-parse |
| 6 | rebuild | two full runs produce byte-identical snapshots |

Cap enforcement (2,000 files, 2 MB per file, 64 MB total) is test 7 in the
same file: the dropped entries leave no relation evidence and the snapshot
marks `truncated` explicitly.

The command used for the matrix:

```bash
NODE_ENV=test npx jest src/__tests__/knowledge/workspaceIndexEngine.test.ts \
  src/__tests__/knowledge/workspaceIndexPersistence.test.ts --runInBand --no-cache
```

### Real workspace gate

`npm run test:extension-host:knowledge-index` opens a real VS Code Extension
Host with a temporary workspace containing `a.sql`, `b.sql`, `c.sql`, `d.sql`
and `e.sql` in a real Git repository with `main` and `alternate` branches, then
verifies:

- index status: 5 files, 3 relations (2 eligible, 1 below threshold), 4 objects
  (3 eligible, 1 below threshold), no truncation;
- Git mode `all` (window 0) with the `main` HEAD reported by the index;
- completion returns the eligible relation at `0_5_`;
- the quick favorite action stores the same relation at `0_3_`;
- block hides the relation; reverting the block restores the favorite;
- **real branch switch**: checking out `alternate` (different
  `a.sql`/`b.sql`/`d.sql`/`e.sql` content) removes the stale `USERS → ORDERS`
  and `PRODUCTS → ORDERS` `0_5_` items, exposes `ACCOUNTS → ORDERS` and
  `DEPOTS → ORDERS` at `0_5_`, persists the new HEAD, keeps the `0_3_`
  favorite and leaves the manual-decision counters untouched; checking out
  `main` restores the original relations with the original HEAD;
- `netezza.showJoinKnowledgeStatus` returns diagnostics that include the
  `workspaceIndex` counters, skip reasons, truncation, Git mode and HEAD.

### Intentional Stage 2 delta: favorite quick action

The native Quick Pick opened from the editor context menu or
`netezza.favoriteJoinKnowledgeSuggestion` provides per-item actions: a heart
toggles a separate favorite preference, while the add button writes the
relation to workspace `justybase.sql.joinRelations` after explicit confirmation.
Selecting a completion in the SQL editor is different: it contributes one
half-weight accepted observation to workspace evidence, not a favorite.

For manual ranking adjustments, open **JustyBase Settings → JOIN Knowledge**;
its manager opens in an editor tab, not the Explorer sidebar. Raise/lower
controls change a relation's score only within its existing tier.

### Known limitations

- Top-1/Top-5 is measured on a small synthetic maintainer-labelled corpus, not
  a production labelled workspace; the report states this explicitly.
- The manual-correction half of calibration belongs after Stage 3.
- Caps are enforced at 2,000 files / 2 MB per file / 64 MB total and covered by
  `workspaceIndexEngine.test.ts` #7. `npm run benchmark:join-knowledge` measures
  the 2,000-file index, but not a 64 MB or production workspace.
- Indexing remains opt-in until the Stage 2 calibration is accepted.
