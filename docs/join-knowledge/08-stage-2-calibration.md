# Stage 2 — calibration report (2026-10-25)

This report is attached to Gate 2. It is intentionally split into measured
facts, synthetic expectations and unmeasured items. The synthetic corpus is
not a substitute for a labelled production workspace.

## Measured: synthetic maintainer-labelled corpus

Corpus (deterministic, no SQL text stored in the index):

| File | Evidence |
|---|---|
| `sales/orders_a.sql` | `USERS → ORDERS` |
| `sales/orders_b.sql` | `USERS → ORDERS` |
| `sales/customers_a.sql` | `CUSTOMERS → ORDERS` |
| `sales/customers_b.sql` | `CUSTOMERS → ORDERS` |
| `misc/unrelated.sql` | `A → B` (single observation) |

Maintainer expectation for this corpus:

- source `USERS` → target `ORDERS`;
- source `CUSTOMERS` → target `ORDERS`.

Measured with `src/__tests__/knowledge/joinKnowledgeCalibration.test.ts`:

| Metric | Result |
|---|---|
| Expectations | 2 |
| Eligible relations | 2 |
| Top-1 hits | 2 / 2 (100%) |
| Top-5 hits | 2 / 2 (100%) |
| Full rebuild stability | identical serialized labels (100%) |
| Full vs incremental stability | identical aggregate (100%) |

The two eligible relations are exactly the expected pairs; the single
observation `A → B` stays `belowThreshold` and never ranks. These numbers show
the aggregation and threshold mechanics, not real-world suggestion quality.

## Measured: real workspace Extension Host

`npm run test:extension-host:knowledge-index` passed. The temporary workspace
had five SQL files:

- 5 files indexed / 5 selected;
- 3 workspace relations: 2 eligible (`USERS → ORDERS` and `PRODUCTS → ORDERS`,
  each in 2 files) and 1 below threshold (`CUSTOMERS → ORDERS`, 1 file /
  1 query);
- 4 workspace objects: 3 eligible and 1 below threshold;
- no truncation;
- Git mode `all` (window 0) with the `main` HEAD reported by the index; the
  fixture is a real Git repository with a `main` and an `alternate` branch;
- the eligible relation appeared at `0_5_`;
- favoriting the same relation moved it to `0_3_`;
- blocking removed it from completion;
- reverting the block restored the favorite;
- a real branch switch (`alternate`, where `a.sql`/`b.sql` observe
  `ACCOUNTS → ORDERS` and `d.sql`/`e.sql` observe `DEPOTS → ORDERS`) removed
  the stale `USERS → ORDERS` and `PRODUCTS → ORDERS` `0_5_` items, exposed
  `ACCOUNTS → ORDERS` and `DEPOTS → ORDERS` at `0_5_`, persisted the new HEAD,
  and kept the `0_3_` favorite with an unchanged manual-decision count;
- switching back to `main` restored `PRODUCTS → ORDERS` and the original
  relations at `0_5_`, dropped the `alternate` relations, and restored the
  original HEAD;
- `netezza.showJoinKnowledgeStatus` returned the `workspaceIndex` counters,
  skip reasons, truncation state, Git mode and HEAD.

Re-running the Extension Host scenario produced the same counts and labels.
The scenario itself is the real-workspace evidence; the synthetic calibration
above is only a deterministic metric fixture.

## Measured: index caps

`src/__tests__/knowledge/workspaceIndexEngine.test.ts` #7 drives the engine
with declared stat sizes that exceed each documented cap:

| Cap | Input | Result |
|---|---|---|
| Files | 2,001 distinct files | 2,000 indexed; the dropped file's relation leaves no evidence; `truncated` |
| Per file | 2 MB + 1 byte | file skipped; its relation never ranks; `truncated` |
| Total | 65 × 1 MB | 64 indexed; the 65th file is dropped; `truncated` |

The snapshot marks truncation explicitly; no cap is silent.

## Measured: 2,000-file index benchmark

`npm run benchmark:join-knowledge` builds the documented file cap in memory:
2,000 SQL files (8.2 MB total), each a single `USERS → ORDERS` statement with
comment padding. Measured on the development machine (2026-10-25):

| Metric | Result |
|---|---|
| Full index | 562 ms (≈ 3,557 files/s) |
| Snapshot build | 7.3 ms |
| Single-file incremental | 7.3 ms |
| Eligible relations | 1 |

This measures indexing and incremental update, not a 64 MB or production
workspace. The 64 MB total cap is enforced and covered by the cap test above;
its latency was not measured.

## Measured: within-tier ranking replay (2026-10-26)

`src/knowledge/joinRankingReplay.ts` measures suggestion quality the way a user experiences it.
For every `JOIN` the extractor accepts in a `.sql` file, it rebuilds the workspace index from all
**other** files (leave-one-file-out), asks the real LSP completion engine for JOIN targets right
after `JOIN `, and records the rank of the table the author actually wrote. No metadata
connection is used, so only knowledge tiers and their within-tier order are measured.

Labelled corpus: `src/__tests__/knowledge/fixtures/joinRankingCorpus.ts` (25 files, 34 JOIN
positions; uneven breadth and age, several targets reachable from one source, chained joins).
Locked by `src/__tests__/knowledge/joinRankingReplay.test.ts`.

| Order inside a tier | Covered | Top-1 | Top-3 | Top-5 | MRR |
|---|---|---|---|---|---|
| Alphabetical (before 2026-10-26) | 32/34 | 6 (17.6%) | 23 (67.6%) | 28 (82.4%) | 0.451 |
| Score with exactness, schema and query context only (evidence lookup missed unqualified keys) | 32/34 | 11 (32.4%) | 32 (94.1%) | 32 (94.1%) | 0.608 |
| + breadth and freshness via the unscoped evidence key (current) | 32/34 | 16 (47.1%) | 32 (94.1%) | 32 (94.1%) | 0.691 |

Reading the remaining misses:

- 2 positions are not covered: `AUDIT_LOG` appears in only two files, so leaving one out leaves a
  single observation below the threshold (by design).
- The other Top-1 misses are statistically correct choices given only the source table (for
  example `ORDERS → CUSTOMERS` is used in 12 files, `ORDERS → ORDER_ITEMS` in 5). Fixing them
  needs richer query context such as table co-occurrence, which is not implemented.

Run on a real SQL tree (report written to the gitignored `Benchmark/joinRankingReplay.results.md`,
identifiers and counters only):

```bash
JOIN_REPLAY_DIR=/path/to/sql JOIN_REPLAY_DATABASE=DB JOIN_REPLAY_SCHEMA=ADMIN npm run benchmark:join-ranking
```

The score weights are the normative starting parameters from `01-ranking-model.md` §1; they were
not tuned against this corpus. A weight change should be justified by a replay on a real workspace.

## Not measured (and why)

1. **Top-1/Top-5 against a real workspace.** The replay above removes the need
   for hand-written labels (the SQL the author wrote is the label), but no real
   production SQL tree was available in this repository; run
   `npm run benchmark:join-ranking` with `JOIN_REPLAY_DIR`. FK/heuristic tiers
   additionally need a metadata connection and are not covered by the replay.
2. **Manual-correction half of calibration.** The manager UI and manual
   correction workflow are Stage 3; the Stage 2 report cannot measure it
   without implementing Stage 3.
3. **Production-scale latency and memory.** The 2,000-file benchmark above
   covers indexing, but there is no 64 MB or real production-workspace latency/
   memory measurement. The completion path remains map-lookup-only; indexing
   runs in the host.

## Starting parameters (unchanged thresholds)

- Workspace evidence eligible at ≥ 2 distinct files or ≥ 3 independent queries
  in one file.
- Executed evidence eligible at ≥ 2 executions or ≥ 2 distinct days (Stage 5).
- Learned FROM-object caps: select `10`, insert `25`, update/delete `35`;
  breadth moves the band toward the cap, never across match rank, scope or
  kind.
- Index caps: 2,000 files, 2 MB per file, 64 MB total; truncation is shown in
  `netezza.showJoinKnowledgeStatus`.

Changes to these parameters require a later calibration pass, not a silent
edit.

## Stage 5 executed parameters (no threshold changes)

The executed source keeps `minExecutions 2` / `minDistinctDays 2`. Its object
band (`executedObjectBandForUsage`) reuses the same per-kind caps (`select 10`,
`insert 25`, `update/delete 35`) and the same learned range `10–49`; breadth is
derived from distinct executions and distinct days, and executed/workspace bands
merge by the better band, never by summing counters. Retention limits are new
and explicit (`2,000` relation records, `2,000` object records, `64` days per
record, `1,024` event keys); reaching one under-counts and sets `truncated`. No
existing threshold or tier order was changed.
