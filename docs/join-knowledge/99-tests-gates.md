# JOIN Knowledge — tests and blocking gates per stage

The pre-split numbered matrix (`JOIN_KNOWLEDGE_PLAN.md` §14) is no longer in the repository. Numbers
quoted in stage files are historical; each gate below lists the suites that cover it by behavior.

## Gate 1 (after Stage 1)

`completionEngine | joinKnowledgeRanking | joinKnowledgePriority | objectPreferenceRanking |
objectPreferenceOverrides | objectQualification` — existing behaviour locked, configured > FK,
pin order/exclude precedence, priority levels, qualification incl. Stage 1a source-layer fix.
Plus `sqlParser` suite (`--runInBand --no-cache`) and MSSQL/Oracle cold-construction < 2000 ms.

## Gate 2 (after Stage 2)

**Passed 2026-10-25.** Index on ≥ 1 real workspace + `showJoinKnowledgeStatus` review + calibration
report (`08-stage-2-calibration.md`). Mandatory consistency checklist (§03): modified / deleted /
untracked / branch-switch / interrupted-restart / rebuild — no ghost evidence, manual decisions intact.

Commands:

```bash
NODE_ENV=test npx jest src/__tests__/knowledge/workspaceIndexEngine.test.ts \
  src/__tests__/knowledge/workspaceIndexPersistence.test.ts \
  src/__tests__/knowledge/joinKnowledgeCalibration.test.ts --runInBand --no-cache
npm run test:extension-host:knowledge-index
```

The real-workspace scenario verifies `0_5_`, favorite `0_3_`, block precedence, block revert, the
status counters/skip reasons/truncation/Git mode, and a **real branch switch** in a two-branch Git
fixture (stale `0_5_` evidence removed, new relation exposed, HEAD persisted, manual decisions
intact, switching back restores the original relation). Index caps (2,000 files / 2 MB per file /
64 MB total) are covered by `workspaceIndexEngine.test.ts` #7. `npm run benchmark:join-knowledge`
measures a 2,000-file index (full, snapshot and single-file incremental). Real labelled Top-1/Top-5
and the manual-correction half remain unmeasured; the report states why.

## Gate 3 (after Stage 3)

Status: **implemented 2026-10-25; automated checks green; maintainer round-trip pending**.

Commands:

```bash
npx playwright test --config=test-harness/playwright.config.ts join-knowledge.spec.ts
npm run test:extension-host:authoring
NODE_ENV=test npx jest src/__tests__/knowledge --runInBand
npm run test:extension-host:knowledge-index
```

Playwright covers ranks/sources/explanation, blocked filter, confirm + undo, inline favorite,
persisted tab/query/filter/selection rehydration, bulk exclude, the manual-relation payload and
disabled/read-only states. The authoring `knowledge-manager` scenario checks the Settings command,
editor panel, and absence of an Explorer sidebar contribution. The maintainer round-trip from
Settings (favorite, confirm/block/undo, pin/move/exclude/undo, hide/reopen),
source-independence (8–9), domain-isolation (36) and the manual-correction calibration half still need
a human pass with real data before Gate 3 is recorded as passed.

## Gate 4 (after Stage 4)

Status: **implemented 2026-10-26; automated checks green; two-install maintainer round-trip pending.**

Clean-profile export → import round-trip; diff preview; payload-level privacy; unknown version rejected
with zero writes (test 46).

```bash
NODE_ENV=test npx jest packages/sql-core/__tests__/joinKnowledgePortability.test.ts \
  src/__tests__/knowledge/joinKnowledgeService.test.ts \
  src/__tests__/knowledge/joinKnowledgePortabilityCommands.test.ts --runInBand
```

## Ranking quality gate (every ranking change)

The leave-one-file-out replay must not regress below the recorded values: labelled corpus
Top-1 ≥ 19/34, Top-3 ≥ 32/34, MRR ≥ 0.73 (`08-stage-2-calibration.md`); star catalog snapshot
cold start 71/71 covered, Top-1 ≥ 33, tie-averaged MRR ≥ 0.60, ON conditions 71/71 covered,
tie-averaged MRR ≥ 0.94 (`09-live-catalog-replay.md`); ON-condition ghost precision ≥ 0.95 with
coverage ≥ 0.90 (labelled), ≥ 0.75 (star cold) and ≥ 0.80 (star combined), and no target or
new-line JOIN ghost from catalog, workspace or executed evidence (`10-ghost-text-and-history.md`); columns after `alias.` (306 cases,
24 of them `SUM(`/`AVG(` arguments) tie-averaged MRR ≥ 0.48 (catalog), ≥ 0.55 (usage), ≥ 0.82 (one
typed character) and FROM sources Top-1 ≥ 14/40, MRR ≥ 0.48 (`11-column-object-ranking.md`); GROUP BY
ghost exact at 30/30 (star) and 4/4 (labelled) positions; saved keystrokes ≥ 83% columns, ≥ 41% /
63% FROM (catalog / with usage), ≥ 77% JOIN targets, ≥ 94% ON conditions:

```bash
NODE_ENV=test npx jest src/__tests__/knowledge/joinRankingReplay.test.ts \
  packages/sql-core/__tests__/joinKnowledgeScore.test.ts \
  src/__tests__/knowledge/columnUsageRanking.test.ts \
  src/__tests__/knowledge/catalogJoinRanking.test.ts src/__tests__/joinTargetMatcher.test.ts \
  src/__tests__/server/joinGhostSuggestion.test.ts src/__tests__/providers/joinGhostTextProvider.test.ts \
  src/__tests__/server/columnClausePrior.test.ts src/__tests__/server/groupByGhost.test.ts \
  src/__tests__/knowledge/joinKnowledgeHistoryBackfill.test.ts --runInBand
npm run test:extension-host:knowledge-index   # real provider: JOIN ghost text, counters, acceptance
npm run benchmark:join-ranking   # optional: JOIN_REPLAY_DIR=/path/to/sql for a real workspace
npm run benchmark:join-ranking:live   # optional, read-only: NZ_DEV_* against the dev Netezza
#   JOIN_REPLAY_HISTORY=<query-history.msgpack.gz> also replays the local query history
#   and its worksheets (statements of one connection < 30 min apart)
```

## Gate 5 (after Stage 5)

Status: **implemented 2026-10-26; automated checks green; `npm run test:extension-host:netezza`
passes since 2026-10-27 (a background schema query no longer makes a new tab's first query fail as
busy); an Extension Host assertion of recorded executed JOINs and manual sign-off pending.**

Executed-query evidence is recorded only for successful user queries; accepted evidence is recorded
only when a user selects a JOIN completion. Privacy re-run; object usage never becomes a relation
(tests 17–19, 39).

Commands:

```bash
NODE_ENV=test npx jest \
  packages/sql-core/__tests__/joinKnowledgeExecution.test.ts \
  src/__tests__/knowledge/joinKnowledgeExecution.test.ts \
  src/__tests__/knowledge/joinKnowledgeManagerView.test.ts \
  src/__tests__/knowledge/workspaceIndexEngine.test.ts \
  src/__tests__/server/joinKnowledgeExecutedRanking.test.ts \
  src/__tests__/knowledge/columnUsageRanking.test.ts \
  src/__tests__/completionEngine.test.ts \
  src/__tests__/completionRenderer.test.ts \
  src/__tests__/desktopExecutionBackend.test.ts \
  --runInBand --no-cache
npm run check-types && npm run lint && npm run build
```

Covered: success/error/cancellation; 1 vs 2 observations and 2 days; the same event delivered again
(including after restore); multi-statement batches; ambiguous/unsupported syntax and DDL; JOIN
direction and composite/AND order; SELECT source vs DML target; block/FK/manual/favorite precedence;
retention caps and `truncated`; per-item and global clearing without touching manual decisions,
accepted/workspace evidence or score adjustments; restart, workspace isolation and branch/workspace
snapshot changes; `0_4_` target/predicate and executed object bands; payload privacy. The manager
renders `0_4_` rows, executed object bands, an executed filter and clear actions. The remaining
end-to-end gap is an Extension Host assertion that a real `runQuery` JOIN is recorded; the Netezza
result-panel scenario runs real queries but does not inspect JOIN knowledge.

Execution capture tests are listed in `06-stage-5-learning.md`.

## Gates 6–7

Nothing without approval; tool contract green; object preferences untouched by AI (tests 20–21).

## Doc-compliance check (every gate, mandatory)

Beyond green tests: diff implementation against `01-ranking-model.md` —

- manual > confirmed > FK > observed > heuristics preserved;
- execution success never treated as semantic correctness;
- boost/learned/demote never cross match rank/scope/kind; only pin does;
- FROM-only scope of personalization/exclude respected;
- canonicalization orients whole column pairs (no independent table/column sort);
- fingerprint normalization exactly §4 (comments → `?` literals → whitespace → case-fold).

A stage is done only when tests + consistency checklist + doc-compliance all pass.
