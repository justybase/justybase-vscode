# JOIN Knowledge — normative ranking model (sole source of truth)

This file is **the only normative definition** of ranking, identity and evidence rules.
Stage files and code must link here. If another doc contradicts this file, this file wins.

Origin: §4–§5 of the pre-split plan (`JOIN_KNOWLEDGE_PLAN.md`, no longer in the repository). This
file replaced it as the only normative text; executable constants live in
`packages/sql-core/src/joinKnowledge/model.ts`.

## 1. JOIN tiers (targets)

`sortText`: `TIER[_SUBKEY][_SCORE]_LABEL`, lexicographic.

| Prefix | Source |
|---|---|
| `0_0_` | `justybase.sql.joinRelations` (manual, authoritative) |
| `0_1_` | user-confirmed (explicit per-relation action, incl. approved AI proposal) — only tier allowed above FK |
| `0_2_` | catalog FK |
| `0_3_` | persistent favorite preference (not correctness) |
| `0_4_` | executed SQL, success only, ≥ 2 distinct executions or ≥ 2 distinct days |
| `0_5_` | workspace `.sql` evidence or accepted selections; ≥ 2 files or file queries + 0.5 × accepted selections ≥ 3 |
| `2_` | heuristic targets: equal key names, self-named keys, role-playing keys |
| `3_` | any target whose exact relation (table pair + column pairs) is already written in the statement |

ON predicates mirror the same source order: `0_0_` manual, `0_1_` confirmed, `0_2_` FK,
`0_3_` favorite, `0_4_` executed, `0_5_` workspace/accepted evidence, `0_6_` cached key match,
`0_7_` name match.
The tier of every pre-existing item is unchanged when no knowledge is present. Inside a tier the
order comes from the score below; the label is only the final tie-break (implemented 2026-10-26,
replacing the previous alphabetical order).

### Within-tier score (`_NN_`, implemented)

Every JOIN target and ON predicate carries `TIER_NN_LABEL`. `NN` is a bounded 2-digit score, lower
sorts first, and it never changes the tier prefix (`JOIN_SCORE_MODEL`, `scoreJoinCandidate`):

```
strength = 0.30·exactness + 0.15·schemaAgreement + 0.20·breadth + 0.15·context + 0.10·freshness + 0.10·grain
NN       = clamp(25 + round(50·(1 − strength)) + (alreadyJoined ? 20 : 0) − 10·userAdjustment, 0, 99)
```

| Factor | Definition | Computed |
|---|---|---|
| exactness | per column pair: identical names `1`, key-style (`CUSTOMER_ID = ID` on `CUSTOMERS`) `0.85`, containment `0.6`, other `0.35`; averaged | per candidate, string compares |
| schemaAgreement | source/target in the same database and schema `1`, same database `0.5`, otherwise `0` (missing parts use the effective scope) | per candidate |
| breadth | `0.6·ln(1+files|days)/ln(17) + 0.4·ln(1+queries|executions)/ln(33)`, clamped to `[0,1]`; workspace (files, weighted queries) and executed (days, executions) merge by `max`, never summed; only eligible, unblocked evidence counts | snapshot build |
| context | proximity of the source table to the cursor: last written source `1`, the one before `1/2`, … ; `0` when the target table is already in the statement (`alreadyJoined`, a self-relation needs two occurrences) | per request, in-memory |
| freshness | `0.5^(ageDays/90)` from `lastSeenAt` to the injected `now`; `0` without evidence | snapshot build |
| grain | target role: parent (referenced by the source, keeps the grain) `1`, peer/unknown `0.5`, child (references the source, fans out) `0`. Catalog FK matches carry the role; other relations infer it from self-named keys (`DIMPRODUCT.PRODUCTKEY`) | per candidate |

Breadth/freshness are precomputed in `buildJoinKnowledgeIndex` (`relationEvidenceStrength`). The
context factors are per-request comparisons on the already tokenized statement prefix: no I/O,
parsing, git or network on the completion path. Evidence is looked up under the scoped relation key
and, because workspace/executed SQL is stored as written, under the unscoped key of the same tables.
The user adjustment (`-5..+5`) moves a relation 10 points per step inside its tier. Breadth uses a
log scale so ranking keeps separating relations above the eligibility thresholds; the thresholds
themselves still use the raw counters below.

Gating (inviolable):

- Learned never overrides manual for the same pair (`suppressedBy: manual` in diagnostics).
- Observed (`0_3_`–`0_5_`) never outranks FK. Only per-relation confirmation promotes to `0_1_`.
- Acceptance ≠ confirmation. A favorite is also a preference, never confirmation. Execution success ≠ semantic correctness (fan-out / wrong grain execute fine).
- Block is applied before tiering: blocked relations never reach ranking, including a relation that is both favorite and blocked.
- Favorite is a persistent per-relation display preference (`0_3_`). It never promotes to `0_1_`, never outranks catalog FK, and is stored append-only so reverting a block can restore it.
- Accepting a JOIN completion records one selection with weight `0.5` in workspace evidence.
  The selection does not create a favorite or a confirmation; it contributes to the shared
  three-query eligibility threshold and remains in tier `0_5_`. Two accepted selections equal
  one independent workspace query; six selections without file evidence meet the three-query
  threshold.
- Per-relation user score adjustments range from `-5` to `+5` and only reorder suggestions within
  the same tier; they cannot move a relation across manual, confirmation, FK, or evidence tiers.
- Single observations are stored but marked `belowThreshold`, never ranked.
- An executed observation is one successful statement execution. Its identity is the execution
  key (`executionId:statementIndex`); a repeated delivery of the same key adds nothing. Thresholds
  are unchanged: 2 executions or 2 distinct UTC days (`0_4_`, §1 table).
- `joinNameHeuristics: false` suppresses only heuristic buckets.
- Heuristic keys (no catalog FK): equal normalized names where one side is a PK/FK, a `PK_`/`FK_`
  name, or a *self-named key* (a column named after its own table: `PRODUCTKEY` on `DIMPRODUCT`,
  `BRANCH_ID` on `MIS_DIM_BRANCH`); and *role-playing keys*, where a column ends with the other
  table's self-named key (`ORDERDATEKEY` → `DIMDATE.DATEKEY`, stem ≥ 3 characters). Each
  role-playing pair is a separate suggestion. Two aliases of one table never key-match through a
  self-named key. Measurements: `09-live-catalog-replay.md`.
- The `3_` bucket only demotes a relation already written in the current statement; the same
  target through other columns keeps its tier.
- **Ghost text** (`isConfidentJoinSuggestion`, `JOIN_GHOST_MODEL`): the top item of the ordinary
  list becomes inline ghost text only when its tier qualifies and no other item shares that tier.
  Targets: `0_0_`, `0_1_`, `0_3_`. ON conditions: `0_0_`–`0_6_`. Catalog FK, executed, workspace
  and heuristic targets never become target ghosts (calibration: `10-ghost-text-and-history.md`).
  Ghost text never changes ranking; accepting it counts as an accepted selection.

Executed evidence dedupe and retention (normative): one successful execution is identified by
`executionId:statementIndex` and counted once, including after a restart, through a bounded ledger of
1,024 opaque keys. `distinctDays` is derived from a bounded explicit UTC-day set (64 per record), so
a clock that returns to an already-counted day does not create a new day. History backfill (normative): successful entries of the extension's query history are recorded
as executions with the key `history:<entryId>` and their original time. Only entries strictly older
than the oldest executed evidence are replayed, so live captures are never counted twice and a
repeated backfill adds nothing; executed records keep `firstSeenAt` as the minimum and
`lastSeenAt` as the maximum of their executions. Executed records are capped
at 2,000 relations and 2,000 objects. Reaching any cap stops growth (under-count) and sets an explicit
`truncated` diagnostic; evidence is never silently evicted or aged out. Statement fingerprints remain
session-local and are never persisted.

## 2. Relation identity and canonicalization (normative)

A relation is identified by the **whole unordered table pair plus fully-qualified column pairs**.
Canonicalization must never sort tables and columns independently.

Definitions:

- `TableRef = (database?, schema?, table)` normalized per dialect (Netezza: unquoted → UPPER, quoted → byte-exact).
- `ColumnPair = (leftTableRef, leftColumn, rightTableRef, rightColumn)` where each column is bound to its table.
- `RelationKey = sort([TableRefA, TableRefB]) + sort(columnPairs by (leftKey, leftCol, rightKey, rightCol))`
  **after** orienting every pair so the lexicographically smaller table is on the left. Orientation flips the
  whole pair (table + column together), never columns alone.

Examples (must be the same key):

```
A.CUSTOMER_ID = B.ID   ≡   B.ID = A.CUSTOMER_ID
```

Both bind `CUSTOMER_ID→A`, `ID→B`. The stored direction keeps the first-observed writing order for SQL
generation, but ranking uses the canonical key.

Composite + AND-order (must be the same key):

```
A.X = B.X AND A.Y = B.Y   ≡   A.Y = B.Y AND A.X = B.X
```

Required tests: both directions, composite pairs, AND-order permutation, `DB..TABLE` vs `DB.SCHEMA.TABLE`
normalization, quoted identifiers. `OR` at top level, subqueries, derived tables, CTEs, `USING` without
columns, non-equality and parse errors disqualify the clause (skip, never guess).

## 3. Object (FROM) ranking (normative)

Current key `3_<scope><kind>_` is extended, never replaced:

```
3_<scope><kind>_<matchRank><band>_NAME   # learned / neutral / demoted
2_<pinOrder><matchRank>_NAME             # manual pin only
```

- `scope`: `0` effective schema, `1` other schema. `kind`: `00` table, `10` view, `20`/`30` synonyms, `40` procedure, `90` other; `_V_*` stays `9_`.
- `matchRank` always present (`0`–`4`). Empty knowledge ⇒ today's labels/order (regression-locked).
- `band`: `00`–`09` boost, `10`–`49` learned, `50` neutral, `90` demote. Bands are emitted **after**
  match rank, scope and kind: **boost/learned/demote never cross those boundaries**. Only pin (`2_`) may.
- Pin changes `sortText` only, never `insertText`/qualification; a pinned object invalid in the current clause is not offered.
- Exclude scope (v1): FROM sources only (`ranking.role === "source"` + `personalizeFromObjects === true`).
  INSERT/UPDATE/DELETE targets, ALTER TABLE, JOIN target lists, DB/schema/location lists are untouched.

Usage kinds with weights and best-band caps: `select` 1.0 → `10`, `insert` 0.5 → `25`,
`update` 0.25 → `35`, `delete` 0.25 → `35`. Inside a cap the band is `cap + round((49 − cap)·(1 − breadth))`
with the shared log breadth of §1 (`joinEvidenceBreadth`; files/days and queries/executions), so
objects keep separating up to 16 files / 32 queries (measured: `11-column-object-ranking.md`). Only FROM sources and
DML targets are object usage; a JOIN target is not (it ranks as a relation, §1). Only unambiguous parser-resolved references count; DDL/ambiguous
are `skipped` in diagnostics. Workspace + executed merge with `max` per kind, never summed.

Accepted FROM selections are a third object source (`source: "accepted"`): selecting a personalized
FROM completion runs `netezza.recordSqlObjectAcceptance`, and each selection counts as half a
`select` query (`acceptedObjectBand`), so six selections reach the shared three-query threshold.
Workspace, executed and accepted bands merge by the better band, never summed. Acceptance never
creates a pin/boost/demote/exclude and never a JOIN relation.

Unqualified evidence (`FROM ORDERS`, `DB..ORDERS`) is stored without schema. It applies only to the
catalog object that the unqualified name resolves to, i.e. the object in the effective
database/schema (`objectEvidenceKeys`); an object in another schema never inherits it.

All weights, caps, `40`-band range, thresholds (`minDistinctFiles 2`, `minDistinctQueries 3`,
`minExecutions 2`) live in one exported `OBJECT_RANKING_MODEL` / thresholds object in
`packages/sql-core` and are boundary-tested. They are starting parameters; changes require a
calibration pass with the ranking replay (`08-stage-2-calibration.md`).

## 3a. Column ranking (third domain, implemented 2026-10-26)

Column completions are ordered by learned usage, independently of JOIN and FROM ranking:

- Evidence: a column referenced through an unambiguous binding inside a `SELECT` (`alias.COLUMN`, or
  an unqualified column when the scope has exactly one table and nothing else). CTE, derived-table,
  ambiguous and wildcard references are skipped. Workspace files and successful executions both
  contribute; each is one record per `(object, column, source)`.
- Thresholds: the workspace (`≥ 2` files or `≥ 3` queries) and executed (`≥ 2` executions or `≥ 2`
  days) thresholds apply unchanged. Below threshold is never ranked; workspace records below the
  threshold are not even published.
- Band: `10 + round(39·(1 − breadth))` with the log breadth above; workspace and executed merge by the
  better band. Executed column bands are Netezza-only like executed objects.
- Placement: after `alias.` the key becomes `3_NN_NAME`; for unqualified scoped columns
  `2_[matchRank_]NN_NAME`. Columns without usage sort as neutral `50`. The band follows the match
  rank, so usage only reorders equally good prefix matches. When a table has no learned columns the
  previous `sortText` is emitted unchanged.
- Clause prior (`COLUMN_CLAUSE_PRIOR`, catalog-only, no knowledge needed): after `alias.` a `0_`/`1_`
  segment follows the usage band (`3_[NN_]P_NAME`). Key-like columns (PK/FK flag or `PK_`/`FK_`
  name, self-named key, or a name ending in `ID`/`KEY`/`SK`) get `0_` in `ON` and `1_` in
  `SELECT`/`GROUP BY`/`ORDER BY`/`HAVING`. As the first argument of `SUM(`/`AVG(` (`aggregate`)
  non-key columns of a numeric or unknown catalog type get `0_`, keys and other types `1_`.
  Other clauses (including `WHERE`) emit no segment.
  The prior never outranks learned usage and is not switched off by `personalizeColumns`
  (measured: `11-column-object-ranking.md`).
- Switch: `justybase.sql.personalizeColumns` (default on). Column evidence never creates a JOIN
  relation and never changes FROM-object order.
- Caps: `WORKSPACE_COLUMN_LIMIT` 20,000 published workspace columns (broadest kept, `truncated` set),
  `EXECUTED_EVIDENCE_LIMITS.maxColumnRecords` 8,000 executed records (growth stops, `truncated` set).

## 4. Fingerprint normalization (normative, deterministic)

Before hashing a statement:

1. strip `--` and `/* … */` comments;
2. replace every string / numeric / date-time literal with `?` (typed Netezza literals such as `DATE`, `TIME`, `TIMESTAMP`, `INTERVAL`, `N`, `E`, `X` and `B` count as literals; quoted identifiers are not literals and are handled in step 4);
3. collapse each whitespace run to one ASCII space, trim;
4. case-fold unquoted identifiers + keywords to UPPER; quoted identifiers keep byte content.

Consequences (test-locked): whitespace/comment/case/literal variants ⇒ 1 fingerprint; alias rename ⇒
2 fingerprints (conservative, no false dedupe). Salted SHA-256 truncated to 128 bits; salt local-only,
never exported. SQL text never stored.

## 5. Sources, overrides, privacy

- One record per `(identity, source)`. Sources merge only at ranking time. Clearing one source removes
  only that source's records and never touches the others; executed and accepted evidence share the
  local relation-evidence file, while manual overrides stay in their own append-only files.
- `JoinKnowledgeOverride` (`confirm`/`block`/`favorite`) and `ObjectPreferenceOverride`
  (`pin`/`boost`/`demote`/`exclude`) are append-only with `revertedAt`/`replacedBy`; re-index, branch switch
  and AI never rewrite them. Exclude outranks pin/boost/demote; `confirm`+`block` ⇒ block wins (applied first).
  At most one active override per object; pin has explicit `pinOrder`.
- Stored/exported/sent data: identifiers, counters, timestamps, workspace-relative paths only.
  Column usage stores normalized column names (identifiers); predicates and literals are never
  stored.
  Local index/evidence files may additionally store salted statement fingerprints and opaque
  execution-event keys solely for dedupe; those values are never exported or sent. Never SQL,
  literals, hosts, connection names, history or salts.
- Import is a transaction: whole-file validation → diff + conflicts → explicit
  `keep-local` (default for active manual decisions) / `keep-import` / per-item → atomic write → one-step
  undo. Histories from different installs are never concatenated. Only active manual decisions are
  exported; observed evidence (workspace, executed, accepted) stays local (`05-stage-4-portability.md`).
