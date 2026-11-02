# Stage 3 — Knowledge Manager (starts only after Stage 2 gate)

Scope:

- A dedicated JOIN Knowledge section in JustyBase Settings opens the manager as an editor tab;
  do not add a persistent Explorer sidebar view. Two tabs (JOIN relations / SQL objects), one
  bundle `media/joinKnowledge.ts`.
- Append-onlgeneray decision logs (`overrides.json`, `object-overrides.json`) with undo; delete-evidence vs
  block vs confirm (+priority Low/Normal/High/Custom) and delete-evidence vs pin/boost/demote/exclude
  write to different places with different semantics (§13.1).
- Explainability renders `explainRelation()` / `explainObjectPreference()` from `packages/sql-core`
  (same functions as the engines; webview never re-derives reasons).
- Manual-relation CRUD writes `justybase.sql.joinRelations` at workspace scope behind a confirmed diff;
  objects are never invented (identity comes from metadata).
- Filters, detail, bulk rules (bulk = Exclude + Delete evidence only), empty/disabled states, hide/reopen
  rehydration without `retainContextWhenHidden`.

Dependencies: Stage 1 model + Stage 2 real data (a manager over empty tables is not reviewable).
Learning/AI sources are picked up automatically later — no new UI expected for them.

## Implementation record

Status: **implemented 2026-10-25; automated Gate 3 checks green, maintainer UI round-trip pending**.

Code paths:

- `src/views/joinKnowledgeManagerView.ts` — editor `WebviewPanel` plus the pure
  `buildManagerState()` builder. It merges configured relations, active manual overrides and the
  workspace index snapshot, then renders `explainRelationDecision()` / `explainObjectPreference()`
  reasons from `packages/sql-core`; the webview never re-derives ranking.
- `src/contracts/joinKnowledgeManager.ts` — identifier/counter-only row, source, rank and message
  contracts (no SQL text, literals, hosts or fingerprints).
- `media/joinKnowledge.ts` / `media/joinKnowledge.css` — two tabs, search and source/status filters,
  detail with sources and "why this rank", confirm/block/favorite, per-relation Raise/Lower score
  controls (plus Reset in the detail), pin/move (explicit order), boost/demote/exclude, revert undo,
  delete observed evidence, bulk Exclude + Delete evidence, and manual-relation add/edit/remove behind
  a diff confirmation. A heart button on each relation row applies/removes the favorite preference
  without opening its details. Tab, query, filter and selection are persisted with
  `vscode.setState()` and restored without `retainContextWhenHidden`.
- `src/knowledge/workspaceIndexEngine.ts` / `workspaceIndexCoordinator.ts` — observed-evidence
  deletion and manager change notifications; manual overrides stay in their own append-only store.
- `src/views/settingsView.ts` + `media/settingsView.js` — a dedicated JOIN Knowledge settings
  section with understandable controls and a link to the manager.
- `src/activation/activateExplorerViews.ts` + `package.json` — `netezza.openJoinKnowledge` opens the
  manager in an editor tab; the `media/joinKnowledge.ts` bundle entry remains shared.

Semantics kept from the normative model:

- Manual configured relations stay `0_0_`; confirmation is the only `0_1_` path; favorite/acceptance
  is `0_3_`; workspace evidence `0_5_`; below-threshold rows are visible but never ranked; a block is
  applied before tiering and hides the relation.
- Delete evidence removes observed workspace contributions only; confirm/block/favorite and object
  preferences are untouched and are reverted through the append-only history.
- Raise/Lower writes one bounded `-5..+5` score override per relation. The score only changes the
  tie-break suffix inside the relation's existing `sortText` tier: it never creates a relation,
  never confirms one, and never moves it across manual, confirmed, FK or evidence tiers. Reset
  reverts the active score record (it does not append a zero), so the next snapshot has no score
  segment and the standard ordering returns. A relation that only retains a score stays visible in
  the manager with an explicit "no active suggestion source" rank. The record stores the dialect
  used for canonicalization, so a restart keeps the same relation key outside Netezza as well;
  manager actions reuse that stored dialect instead of assuming Netezza.
- Webview messages are validated before the action switch. An unknown relation/object action,
  revert kind, evidence kind or bulk action is reported as an error and never falls through to a
  different mutation (previously an unknown object action would have been treated as `exclude`).
- The relations tab keeps manual decisions available when `justybase.sql.joinKnowledgeIndex` is off;
  evidence-only actions are disabled then. The objects tab is read-only when
  `justybase.sql.personalizeFromObjects` is off. This avoids making Stage 1 decisions depend on the
  index switch.

Known gaps: the pre-split test matrix (`JOIN_KNOWLEDGE_PLAN.md` §14) is no longer in the repository,
so test numbers 22–29/42/44–45/48 cannot be mapped one-to-one; coverage is by behavior instead
(`99-tests-gates.md` lists the suites per gate). The maintainer end-to-end round-trip through the
rendered view and the manual-correction half of calibration still need a human pass with real data.

Acceptance:

- Tests 22–29, 42, 44–45, 48 green; tests 8–9 + 36 re-run (source independence, domain isolation).
- Each tab read-only when its master switch is off; every destructive action confirmed + reversible.
- Maintainer round-trip from Settings: explain "why first?", favorite, confirm/block/undo, pin/move/exclude/undo,
  hide/reopen without state loss. No JSON editing.
- Doc-compliance check: view actions match `01-ranking-model.md` precedence
  (manual > confirmed > FK > observed > heuristics; exclude > pin > boost > learned > neutral > demote).

## Gate 3 record (2026-10-25)

Automated evidence:

- `npx playwright test --config=test-harness/playwright.config.ts join-knowledge.spec.ts` — 7/7:
  ranks and badges for every source, blocked filter, detail sources/explanation, confirm + undo,
  inline favorite, persisted tab/query/filter/selection rehydration, bulk exclude, manual form payload,
  disabled-index banner and read-only object actions.
- `npm run test:extension-host:authoring` — 4 scenarios / 14 checks, including the
  `knowledge-manager` scenario: manager command registered, editor panel opened, and no Explorer
  sidebar contribution.
- `NODE_ENV=test npx jest src/__tests__/knowledge` — 47 tests, including the manager state builder
  (configured/confirmed/favorite/workspace/blocked/below, object pin/boost/learned/exclude) and
  observed-evidence deletion.
- `npm run test:extension-host:knowledge-index` — still passes after the manager wiring (5 files,
  3 relations, 4 objects, real branch switch).
- `npm run check-types`, targeted ESLint, `npm run build` — green.

Pending before the gate can be called passed end-to-end:

1. Maintainer round-trip from the rendered view (confirm/block/undo, pin/move/exclude/undo,
   hide/reopen) against a real workspace and a stable metadata connection.
2. Re-run source-independence and domain-isolation checks after real decisions exist.
3. Manual-correction calibration half (`08-stage-2-calibration.md`).
