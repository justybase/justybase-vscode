# Stage 5 — learning from executed/accepted

Status: **implemented (2026-10-26) — automated checks green; real Extension Host
executed-query round-trip and manual-sign-off remain pending.**

Execution-learning scope (implemented before Stage 4; the order deviation is recorded in
`00-overview.md`):

- `learned-executed` (JOIN + object usage, same parse pass, `status === success` user queries only,
  per-kind counters, persisted execution-event dedupe across restarts) capped below FK / inside tie groups.
- **Implemented:** selecting a JOIN completion runs
  `netezza.recordJoinKnowledgeAcceptance` and increments a persistent accepted-selection counter.
  Each selection contributes `0.5` to shared workspace query evidence. It is not a favorite or a
  confirmation, and it ranks in the workspace evidence tier (`0_5_`). The manager shows the count,
  weighted total, and per-relation score controls.
- User score adjustments range from `-5` to `+5`, are append-only, and reorder suggestions only
  within their current tier. Reset reverts the active score record, which restores the unadjusted
  `sortText` instead of leaving a zero-valued override in the snapshot.
- Explicit confirmation path (`netezza.confirmJoinKnowledgeRelation`) — the only promotion to `0_1_`.
- Manual-correction diffing stays deferred; the accepted record is the documented seam.

Dependencies: deterministic index proven useful (Stage 2). If Stage 2 did not prove value, reconsider
instead of piling on execution learning.

Executed-learning acceptance gate: tests 8–11, 17–19, 39 green; both switches default off; privacy
re-run; object usage from executions never creates a JOIN relation.

Automated coverage for execution capture: `packages/sql-core/__tests__/joinKnowledgeExecution.test.ts`
(thresholds, two days, duplicate day sets, event-ledger dedupe across restore, repeated input,
direction and composite identity, object caps, retention truncation, per-item deletion, blocks and
FK precedence, clearing, persistence, privacy), `src/__tests__/knowledge/joinKnowledgeExecution.test.ts`
(success, duplicate, switch off, dialect skip, DDL, INSERT target, failed write, capture error,
byte cap, privacy, restart, same event after restart, multi-statement batch events, ambiguous
JOIN/parse-error skips, workspace/branch isolation, clearing),
`src/__tests__/server/joinKnowledgeExecutedRanking.test.ts` (tier precedence, dialect isolation,
band merge), `src/__tests__/completionEngine.test.ts` / `completionRenderer.test.ts` (`0_4_` target
and predicate, executed object bands, below-threshold hiding, workspace merge) and
`src/__tests__/desktopExecutionBackend.test.ts` (success reports once with its key; failure and
cancellation never report).

## Evidence sources and stage ownership (A/B/C/D/E)

The distinction below is normative for what may rank. Stage 2 implements only case A; the other
cases must not be inferred from file text or from the fact that a statement was typed.

| Case | What it is | Owner | Evidence class |
|---|---|---|---|
| **A. JOIN in a workspace `.sql` file** | Existing project code, including an open/dirty buffer that is saved or belongs to a workspace file | Stage 2 (live) | workspace `0_5_`, threshold ≥ 2 files or ≥ 3 independent queries |
| **B. JOIN explicitly confirmed in the editor** | User asserts the relation is correct; independent of whether the query was saved or executed | Stage 1 (live command) | confirmed `0_1_`, persists immediately |
| **C. JOIN from a successfully executed user query** | User ran a statement; success is observed, not proof of semantic correctness | Stage 5 | executed `0_4_`, threshold ≥ 2 executions or ≥ 2 distinct days |
| **D. JOIN typed but not executed, selected or confirmed** | Editor text only; may be wrong or incomplete | never | no record, no ranking |
| **E. JOIN completion explicitly selected** | User chose a generated suggestion; evidence of preference, not correctness | completion command | accepted counter at weight `0.5`, merged into workspace tier `0_5_` |

Consequences:

- An unsaved `untitled:` document never contributes evidence. A dirty workspace file contributes
  because its buffer *is* the current state of that file, not because the user typed it.
- A saved query is case A even if it was never run. Running a query is case C even if it was never
  saved. Selecting a completion is case E. None implies case B.
- Stage 5 must not reuse the Stage 2 threshold for executed evidence; execution has its own counters
  and its own tier (`0_4_`), and it never outranks catalog FK.

## Capture seams

- **Confirmation (B).** `JoinKnowledgeService.confirmRelation` appends a `confirm` override
  (`overrides.json`). This is the only path to `0_1_`. Neither acceptance nor execution calls it.
- **Acceptance (explicit completion selection).** JOIN completion items carry stable relation
  identity and attach `CompletionItem.command` → `netezza.recordJoinKnowledgeAcceptance`. The
  handler increments accepted-selection evidence; it does not create a favorite or `confirm`
  override.
- **Execution (C) — implemented.** The batch success hook (`onStatementSucceeded`, called by
  `DesktopExecutionBackend` only after the statement's result is delivered without error) forwards
  one event per successful statement to `JoinKnowledgeExecutionCapture`
  (`src/knowledge/joinKnowledgeExecution.ts`). Cancelled and failed statements never reach it.
  Only the two user run paths (`coreCommands`, `querySmartSequentialRun`) pass the hook, so
  automation and task execution record nothing. The text is parsed once with the workspace
  extractor (`extractWorkspaceSql`) and only identifiers and counters are kept.

## Execution capture (implemented)

| Aspect | Decision |
|---|---|
| Switch | `justybase.sql.learnFromExecutedQueries` (on by default since 2026-10-27; before that `justybase.sql.joinKnowledgeIndex`). Off means nothing new is observed; stored evidence stays until cleared. |
| Dialect | Netezza only (`CAPTURED_DIALECTS`). Other dialects are skipped as `unsupported-dialect`. |
| Event identity | `executionId:statementIndex` from the execution context. The same key delivered twice counts once (`duplicate`), including after a restart. |
| Dedupe ledger | Bounded to 1,024 opaque event keys, persisted in `overrides.json` as `executedEvents`. Clearing evidence keeps the ledger so an already-counted event cannot reappear. |
| Roles | Every role from the extractor counts: `select`, `insert`, `update`, `delete`, with the caps in `01-ranking-model.md` §3. A DML target is counted as its own usage kind, never as a `select` source (test: `INSERT … SELECT`). |
| Relations | Counted once per execution, canonicalized with the same `canonicalizeRelation` as the workspace index (both directions and composite pairs identical). |
| Thresholds | Eligible at 2 executions **or** 2 distinct UTC days (`isExecutedEvidenceEligible`). `distinctDays` is derived from a bounded explicit day set (max 64), so an A→B→A clock sequence still counts as two days. Below threshold is stored, flagged `belowThreshold`, and never ranked. |
| Retention | `EXECUTED_EVIDENCE_LIMITS`: 2,000 relation records, 2,000 object records, 64 days per record, 1,024 event keys. Reaching a limit stops growth (under-count) and sets `executed.truncated`; nothing is silently evicted. |
| Object bands | `executedObjectBandForUsage` uses the executed thresholds and the same per-kind caps. Executed and workspace bands for one object are merged by the better band, never summed. |
| Ranking | Executed relations rank in `0_4_`. A workspace relation keeps `0_5_` only when no eligible executed record exists for that relation. Blocks, confirmations, favorites and FK keep their precedence (the tier resolver is unchanged). |
| Persistence | Records live in `overrides.json` (`relationEvidence`/`objectEvidence`, `source: "executed"`) with the event ledger and truncation flag. Writes use an atomic temp file with a random suffix. A failed write is reported as `not saved`; the count stays in memory and the next successful save writes it. |
| Privacy | No SQL, literals, hosts, connection names, salts, fingerprints or result values are stored or logged. Day sets and opaque event keys are local-only and are stripped from `JoinKnowledgeSnapshot`; errors are reduced to a reason code (`capture-error`). |
| Clearing | `JoinKnowledgeService.clearExecutedEvidence()` (all) and the two per-item delete methods remove only `source: "executed"` records. The manager exposes both the per-row and the global action, each behind a modal confirmation. Manual decisions, favorites, score adjustments, accepted and workspace evidence are untouched. |
| Diagnostics | `netezza.showJoinKnowledgeStatus` shows executed eligible/below-threshold counts, retention truncation and capture counters (observed, recorded, duplicate, not saved, skip reasons). The manager shows the same counters and a `0_4_` row/filter. |

Known gaps (explicit, not silent):

- Executed capture is Netezza-only (`CAPTURED_DIALECTS`); other dialects are skipped as
  `unsupported-dialect` so differently folded identities never mix.
- Retention uses fixed caps only; there is no time-based aging. Once a cap is reached, newer evidence
  is under-counted and `truncated` is reported.
- ~~No intra-tier score for executed relations~~ — resolved 2026-10-26: every tier now uses the
  within-tier score (`01-ranking-model.md` §1). Executed breadth (days, executions) and freshness
  merge with workspace evidence by `max`; the `0_4_` label shows both sources.
- The real Extension Host suite still exercises workspace indexing only. Executed capture is covered
  by the batch hook, capture/store, LSP-ranking and completion suites; a live Extension Host
  `runQuery` round-trip is the remaining end-to-end gate.
- **Observed vs confirmed.** Confirmation is a manual record in `overrides.json`; acceptance is a
  counter source, not a manual decision. Both remain separate from execution, and block precedence
  applies before tiering.

## Column usage and accepted FROM selections (2026-10-26)

- The same extraction pass records column usage (`01-ranking-model.md` §3a). Executed column records
  live in `overrides.json` (`columnEvidence`), use the executed thresholds and day set, are capped at
  8,000 records, are cleared with the rest of the executed evidence, and are removed together with
  their object by the per-object executed delete. The published snapshot carries counters only.
- Selecting a personalized FROM completion records an accepted object selection
  (`netezza.recordSqlObjectAcceptance`, half a query each, `select` only). It is stored as
  `objectEvidence` with `source: "accepted"` and published as `acceptedObjects`.

## Durability, undo and weights

- Evidence and score history are append-only and workspace-scoped; a full or incremental re-index never
  rewrites them. Clearing executed/accepted evidence removes only that source's records; manual
  overrides, the other source and the workspace index stay. Score and accepted-evidence records store
  the dialect used for canonicalization; records written before this field existed keep the previous
  Netezza-style folding, so the change is backward compatible and never rewrites stored history.
- Retracted confirmation uses the existing `revertedAt`/`replacedBy` history; reverting restores the
  underlying preference or observed evidence if present, otherwise the relation leaves the list.
- Executed evidence: eligible at ≥ 2 executions or ≥ 2 distinct days, `0_4_`, never above FK.
- Accepted evidence: `0.5` per completion selection, added to file query counts for the shared
  workspace threshold. It does not increase distinct file count and stays in `0_5_`. The manager
  can clear this counter separately from indexed SQL evidence and score adjustments.
- Executed and workspace object usage merge with `max` per kind, never summed (see
  `01-ranking-model.md` §3). Execution success is never treated as semantic correctness.

## Stage 2 prerequisites already satisfied

- Salted statement fingerprints with the §4 normalization (comments → `?`, literals → `?`,
  whitespace collapse, case-fold), so executed/accepted dedupe can reuse the same function without
  storing SQL.
- One parse pass per statement producing relations, objects, per-kind counters and skip reasons.
- Per-source persistence under the workspace storage root, full snapshot + affected-key delta
  publication to the LSP, and deterministic rebuild.
- Append-only manual overrides with undo; re-index and branch switches never touch them.

## Stage 5 decisions (status)

1. **Salt ownership — resolved for dedupe.** Executed statement fingerprints remain session-local
   (random per host session) and are never persisted; they only dedupe contributions inside one
   parsed statement. Cross-restart event dedupe uses a bounded ledger of opaque
   `executionId:statementIndex` keys. The workspace salt is unchanged and is now rebuilt from the
   persisted value on restart.
2. **User-origin filter — resolved by wiring.** Only the user run paths
   (the batch run options in `coreCommands` and `querySmartSequentialRun`) pass the success hook; `runQueryRaw`
   automation, notebooks, ETL and data-edit execution do not.
3. **Retention — resolved with explicit caps.** `EXECUTED_EVIDENCE_LIMITS` bounds relation/object
   records, per-record days and the event ledger. Caps under-count and set `truncated`; there is no
   time-based aging and no silent eviction.
4. **Manager surface — resolved.** Executed relations and objects are visible with their counters,
   have an executed filter, and can be cleared per item or globally without touching manual
   decisions, favorites, score adjustments, accepted selections or workspace evidence.
