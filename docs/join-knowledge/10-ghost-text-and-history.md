# JOIN ghost text and query-history learning (2026-10-27)

Status: **implemented — ghost gate calibrated on the replay corpora; history backfill unit-tested.**
Normative gate and backfill rules live in `01-ranking-model.md` §1 ("Ghost text") and §5
("History backfill"). This file records the design, the measurements and the limits.

## 1. Learning from the query history

The extension already keeps every executed statement in its own query history
(`query-history.msgpack.gz` in global storage, `QueryHistoryEntry`). Executed JOIN evidence
(`0_4_`) used to start empty and grow only from new executions, so existing users got nothing from
their past work.

| Part | Location |
|---|---|
| Backfill (`backfillFromHistory`) | `src/knowledge/joinKnowledgeExecution.ts` |
| History mapping, summary | `src/knowledge/joinKnowledgeHistoryBackfill.ts` |
| One-time automatic run, command **Learn JOINs from Query History** | `src/activation/joinKnowledgeRegistration.ts`, `netezza.learnJoinKnowledgeFromHistory` |
| Batched recording with the original execution time | `JoinKnowledgeService.recordExecutedStatements` |

- Same extraction, thresholds and caps as live capture. Only successful entries of connections
  that are Netezza today are used; entries of removed connections are skipped.
- Each entry is recorded at its original time (`executedAt`), so `distinctDays` and freshness are
  real. Executed records now only widen their seen range (`firstSeenAt` min, `lastSeenAt` max).
- **No double counting, idempotent:** only entries strictly older than the oldest executed
  evidence are replayed. Statements captured live are newer; anything older that produced
  evidence becomes the oldest record, so a repeated run adds nothing. Clearing executed evidence
  makes the whole history eligible again (run the command explicitly).
- Runs once per workspace, 5 s after activation or when `justybase.sql.learnFromExecutedQueries` is
  turned on; batches of 50 statements, one state write each, yielding between batches.
- **Presentation** (`src/activation/joinKnowledgeHistoryLearning.ts`), modelled on background
  indexing in language extensions: the automatic run shows only a status-bar progress
  (`JustyBase: learning from query history`). Only when it made JOINs or tables rank higher, and only
  the first time ever (global state), one notification says what changed in plain words (“Learned
  from 349 past queries: 12 JOINs and 34 tables you use repeatedly now rank higher in suggestions.”)
  with **Show What Was Learned** (opens the manager on the executed-evidence filter) and **Turn
  Off**. Nothing learned means no notification. The command shows a cancellable progress
  notification and the same outcome message.
- Newest statements are learned first, so a cancelled or interrupted run resumes with the older
  ones next time.
- Results are counters only (`scanned`, `eligible`, `learned`, `duplicate`, skip reasons).

**Measurement source.** `JOIN_REPLAY_HISTORY=<file>[:<file>]` adds the local history to
`npm run benchmark:join-ranking:live` (text in memory only). On the development machine the
history held 349 successful statements but only 5 JOIN positions, mostly on scratch tables, so it
is not yet a calibration corpus. It did show that copies of a table (`DIMACCOUNT_TEST`,
`_TMP`, `_LONG`, `DIMACCOUNT2`) crowd the top of catalog-only lists (open question below).

## 2. Ghost text

A JOIN that is near-certain is shown inline; `Tab` accepts it, and acceptance is remembered like a
selected completion (`netezza.recordJoinKnowledgeAcceptance`).

| Position | Ghost |
|---|---|
| `… JOIN ␣` | target, e.g. `DIMPRODUCT P ON F.PRODUCTKEY = P.PRODUCTKEY` |
| `… JOIN DIMDATE D ␣` | `ON F.DATEKEY = D.DATEKEY` |
| `… JOIN DIMDATE D ON ␣` | the condition (usually already previewed by the suggest widget) |
| empty line ending the FROM clause of a top-level SELECT (`afterJoinAndNewLine` only) | `JOIN …` |

Setting `justybase.sql.joinGhostText`: `off` / `afterJoin` (default) / `afterJoinAndNewLine`.
The language server (`netezza/joinGhostSuggestion`, `src/server/joinGhostSuggestion.ts`) asks the
completion engine for the same list as the suggest widget, on a virtual text with `ON ` or `JOIN `
appended where needed; ranking is never re-implemented. The host provider
(`src/providers/joinGhostTextProvider.ts`) stays silent while the suggest widget is open. Positions
are recognised from lexer tokens of the current statement (16 KiB look-behind): nothing is shown
mid-token, with text after the cursor on the line, inside parentheses, or after `WHERE`/`GROUP BY`.

### Calibration (why targets are gated so strictly)

`summarizeJoinGhost` replays the gate: *precision* = shown ghosts that match what the author wrote,
*coverage* = correct ghosts / all positions.

Score-based target gates (top tier `0_2_`/`0_5_`, score ≤ X, lead over the runner-up ≥ G) never
became precise; the best settings gave:

| Corpus | Precision | Coverage |
|---|---|---|
| Labelled corpus | 0.70 | 0.47 |
| Star, catalog + workspace | 0.50 | 0.04 |
| Star, workspace only | ≤ 0.20 | 0.03 |

In a star schema the next dimension is genuinely ambiguous, so a target ghost is offered only for
explicit user decisions: manual `0_0_`, confirmed `0_1_`, favorite `0_3_`, and only when no other
suggestion shares that tier. Executed `0_4_` was dropped on 2026-10-27 (see “Executed evidence and
target ghosts” below).

ON conditions for a written target are a different problem: one condition is usually right.
Gate: top tier `0_0_`–`0_6_` (not name-only `0_7_`), no runner-up in the same tier.

| Corpus | Shown | Precision | Coverage |
|---|---|---|---|
| Labelled corpus (workspace evidence) | 32/34 | **1.000** | 0.941 |
| Star, catalog only | 57/71 | **1.000** | 0.803 |
| Star, catalog + workspace | 62/71 | **0.984** | 0.859 |
| Star, workspace only | 10/71 | 0.800 | 0.113 |

Role-playing alternatives (`ORDERDATEKEY`/`SHIPDATEKEY` → `DATEKEY`) share a tier and therefore
never produce a ghost. Gates: `joinRankingReplay.test.ts`, `joinGhostSuggestion.test.ts`.

### Executed evidence and target ghosts (2026-10-27)

With execution learning on by default, executed `0_4_` targets became common, so the gate was
re-measured with `evidence: "executed"` (every other corpus file is one successful execution on its
own day) and a new-line replay (`runNewLineJoinGhostReplay`: the cursor on an empty line at each of
the 111 ends of a top-level FROM clause in the star corpus, 71 of them followed by a JOIN).

| Star corpus, executed evidence | Shown | Correct |
|---|---|---|
| Target after `JOIN`, `0_4_` in the gate | 3 | 0 |
| JOIN on a new line, `0_4_` in the gate | 5 | 0 (labelled corpus 0/3) |
| Either, `0_4_` removed | 0 | 0 |
| ON condition (unchanged) | 62 | 61 |

A lone executed relation (`FACTRESELLERSALES → DIMRESELLER`) is valid, not the next JOIN: in a star
schema the author joined another dimension each time. Executed targets therefore still rank first
in the list but never become ghosts.

**New-line mode default (follow-up 4): stays opt-in.** Without executed targets it only shows for
starred/confirmed relations, and 40 of the 111 positions end before `WHERE`/`GROUP BY` or the end of
the statement, where any JOIN ghost is wrong. The decision rule (≥ 30 shown, ≥ 60% accepted in the
counters) remains.

### GROUP BY ghost (2026-10-27)

After `GROUP BY ` the non-aggregated expressions of the SELECT at the same parenthesis level are
offered as ghost text (`src/server/groupByGhost.ts`, the same list as the `GROUP BY` completion
item; sub-queries and CTEs included; only auto-closed `)`/`;` may follow on the line; nothing without
an aggregate). It is derived from syntax, not ranked: replay (`runGroupByGhostReplay`) shows it at
30/30 star and 4/4 labelled positions, every one equal to what the author wrote. Setting
`justybase.sql.groupByGhostText` (default on), independent of `joinGhostText`; counted as the
`GROUP BY list` position.

### Real use: counters and Extension Host coverage

- `npm run test:extension-host:knowledge-index` drives the registered inline provider in a real
  Extension Host (test-only command `justybase.test.joinGhostText`, `NODE_ENV=test`): a favorite
  target ghosts after `JOIN ` with its ON condition; the whole `JOIN …` appears on a new line only in
  `afterJoinAndNewLine`; nothing while the suggest widget is open or with `off`; accepting records
  the relation and the counters.
- Accepting runs `netezza.acceptJoinGhostSuggestion` (counts, then records the relation like a
  selected completion). `JoinGhostStats` (`src/knowledge/joinGhostStats.ts`) keeps, per position
  (target after JOIN, ON condition, JOIN on a new line), how often a ghost was shown (once per
  position and text) and accepted, in global state; counters only. **Show JOIN Knowledge Status**
  prints them with the acceptance rate.
- Decision rule for the new-line mode: consider it as default only after ≥ 30 shown new-line ghosts
  with ≥ 60% accepted. Until then it stays opt-in.

## 3. Open questions and next steps

- **Copy tables.** Catalogs contain backup/test copies of a table (`X_TEST`, `X_TMP`, `X_OLD`,
  `X2`); with identical columns they tie with the original. A within-tier demotion for names that
  extend another catalog table needs a replay before it is adopted.
- Target ghost coverage cannot be measured on the corpora (they contain no explicit tiers); the
  ghost counters measure it in real use.
- Executed learning is the strongest signal measured (local history FROM-source MRR 0.129 without
  it, 0.833 with it; `11-column-object-ranking.md`). Since 2026-10-27 it has its own switch,
  `justybase.sql.learnFromExecutedQueries`, **on by default**; workspace file indexing
  (`justybase.sql.joinKnowledgeIndex`) stays off by default.
