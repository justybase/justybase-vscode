# Column and FROM-object ranking replay (2026-10-27)

Status: **measured; object breadth, FROM usage, clause prior and SUM/AVG prior adopted;
document-local signal measured and not adopted.** Normative rules:
`01-ranking-model.md` §3 and §3a.

## Method

`runJoinRankingReplay` (`src/knowledge/joinRankingReplay.ts`) gained two modes on the same
leave-one-file-out machinery, catalog provider and tie-averaged MRR as `09-live-catalog-replay.md`:

- `mode: "column"`: every `alias.COLUMN` whose qualifier is bound by `FROM`/`JOIN` in the same
  statement. The column is removed and completion runs at `alias.` inside the complete statement,
  so later aliases resolve. Cases carry the clause (`select`, `on`, `group`, `where`, …).
- `mode: "object"`: every `FROM <table>` that the extractor accepts as an object reference;
  completion runs after `FROM `.
- `typed: n`: the first `n` characters of the expected name are typed. The editor's ordering is
  approximated: match rank (prefix, word, acronym, fragment) first, then `sortText`, then label.
  Without typed characters a FROM list is not opened (space is not a trigger there), so object
  results use `typed: 1`.

Corpus: the star corpus (40 files, 282 column references, 40 FROM sources) with the 55-table
catalog snapshot.

## Results (tie-averaged MRR unless noted)

| Columns after `alias.` | Catalog order | With usage bands |
|---|---|---|
| no character typed | 0.312 | 0.456 |
| — `ON` (144) | 0.298 | 0.528 |
| — `SELECT` (82) | 0.322 | 0.372 |
| — `GROUP BY` (50) | 0.325 | 0.391 |
| one character typed | 0.672 | 0.745 |
| **with the clause prior**, no character | **0.499** | **0.549** |
| — `ON` | 0.593 | 0.651 |
| — `SELECT` / `GROUP BY` | 0.401 / 0.418 | 0.436 / 0.461 |
| **with the clause prior**, one character | **0.833** | **0.822** |

| FROM sources, one character typed | Top-1 | MRR | Tie-averaged |
|---|---|---|---|
| Catalog only | 1/40 | 0.147 | 0.237 |
| Usage bands, linear breadth (before) | 0/40 | 0.236 | 0.322 |
| Usage bands, log breadth | 9/40 | 0.356 | 0.377 |
| + JOIN targets are not FROM usage | **14/40** | **0.490** | **0.508** |

## Findings

1. **Object bands saturated (fixed).** The object breadth was linear and reached its maximum at
   4 files or 7 queries, so every regularly used table shared the best band and fell back to
   alphabetical order (`FACTFINANCE`, 3 files, before `FACTINTERNETSALES`, 9 files). Object
   bands now use the shared log breadth of JOIN and column ranking (`joinEvidenceBreadth`);
   caps, thresholds and the band range are unchanged.
2. **Joined dimensions outranked FROM facts (fixed).** Object usage counted JOIN targets too, so
   dimensions joined in every query (`MIS_DIM_BRANCH`) led the FROM list ahead of the facts users
   start from (`MIS_FACT_SALES`, rank 4–6). Object bands rank only FROM sources, so JOIN targets
   are no longer object usage (they rank as relations); no schema change. Executed object
   records stored before this change keep their old counts until cleared.
3. **Column order without a typed character was weak (improved).** SELECT and GROUP BY columns
   barely profited from usage bands (0.32 → 0.37/0.39). A catalog clause prior now puts key-like
   columns first in `ON` and last in `SELECT`/`GROUP BY`/`ORDER BY`/`HAVING`. Variants measured
   (cold, no character): keys first in `ON` 0.298 → 0.618 (flags/self-named) or 0.593 (with the
   `ID`/`KEY`/`SK` suffix); keys last in `SELECT` 0.322 → 0.373 (flags) or 0.401 (suffix). Keys
   first in `WHERE` was worse (0.372 → 0.26, 6 cases), so `WHERE` keeps catalog order. The suffix
   variant is best overall and was adopted.
4. **Legacy object `sortText` (unchanged).** Without preferences a direct prefix match omits its
   match-rank digit (`3_000_FACT_SALES`), so weaker matches (`3_000_3_MIS_FACT_…`) sort first by
   `sortText` alone. VS Code orders by its own filter score first, which hides this; other LSP
   clients would see it. **Closed 2026-10-27:** the language server serves only this VS Code
   extension, so the regression-locked grammar (§3) stays.

5. **`SUM(`/`AVG(` arguments were not measured and used the SELECT prior (improved).** The replay
   skipped every reference inside parentheses. It now evaluates the first argument of `SUM(`/`AVG(`
   (clause `aggregate`, 24 cases), and the prior puts non-key columns of a numeric or unknown type
   first (types from the catalog; the live catalog loader reads `FORMAT_TYPE`). Live star catalog,
   tie-averaged MRR:

   | `SUM(`/`AVG(` argument | Cold | Learned | One character |
   |---|---|---|---|
   | keys last (SELECT prior, before) | 0.362 | 0.686 | 0.729 |
   | measures first | **0.454** | **0.706** | **0.829** |

   Other clauses are unchanged (live: ON 0.593, SELECT 0.401, GROUP BY 0.418, WHERE 0.372 cold).
   The offline snapshot has no types, so there the argument behaves like SELECT (keys last).

## Saved keystrokes: one unit for every position (2026-10-27)

`summarizeKeystrokes` combines replays with 0–3 typed characters: per position the cheapest of
typing the whole expected text, or typing `k` characters, pressing Down `rank − 1` times and
accepting (`k + rank`); a correct confident ghost is one `Tab`. Saved = 1 − with / without
completion. The text inserted with a JOIN target (alias, ON) is not counted, so target savings are
understated.

| Saved keystrokes | Columns after `alias.` | FROM source | JOIN target | ON condition |
|---|---|---|---|---|
| Star snapshot, catalog | 83.8% | 42.3% | 78.2% | 95.1% |
| Star snapshot, catalog + workspace | 84.1% | 64.3% | 78.1% | 95.4% |
| Live catalog (553 tables), catalog | 83.9% | 40.8% | 78.1% | 95.1% |
| Live catalog, catalog + workspace | 84.1% | 63.2% | 78.1% | 95.4% |

FROM sources save the least: without usage the list after `FROM X` is long and alphabetical. This
is where the next ranking work pays most (executed learning is now on by default and closes most
of the gap: 0.129 → 0.833 MRR on the local history).

## JOIN chains (follow-up 5) — evaluated, not adopted (2026-10-27)

Idea: when the user joins a far snowflake dimension (`DIMPRODUCTCATEGORY`) from the fact, insert
the intermediate JOIN as well. Measured on the star corpus with the catalog only:

- 9 of 71 JOIN positions (13%) join a table to an earlier dimension instead of the FROM table.
- At the position where the author wrote them (intermediate already joined) 8 of 9 rank first and
  1 second, so ranking already follows the chain step by step.
- From the fact directly, 8 of 9 are not offered at all; only there would a chain add something,
  saving one intermediate JOIN (a few keystrokes against 196 for all 71 targets, ≈ 1–2%).
- Paths are not unique (`DIMGEOGRAPHY` via `DIMCUSTOMER` or `DIMRESELLER`; name matches such as
  `SALESTERRITORYKEY` suggest many-to-many shortcuts), so a two-JOIN insertion would need its own
  precision gate.

Low gain, real risk of wrong paths: not adopted. A cheaper variant remains possible: when a
written target has no ON candidate at all, offer the path (`via DIMPRODUCTSUBCATEGORY`) only there.

## Worksheets from the query history (2026-10-27)

`loadHistoryReplayCorpus(..., { worksheets: true })` groups successful statements of one
connection that ran less than 30 minutes apart into one file (93 worksheets locally); the replay
option `documentEvidence` indexes the statements before the evaluated one, as the index does for
an open document. Catalog from the live database, tie-averaged MRR:

| Regime | FROM, one character | Columns | Columns, one character |
|---|---|---|---|
| Index off (default) | 0.129 | 0.396 | 0.720 |
| Index off + same worksheet | 0.150 | 0.405 | 0.720 |
| Index on (other worksheets) | **0.833** | **0.632** | **0.850** |
| Index on + same worksheet | 0.833 | 0.632 | 0.850 |

Of 157 FROM sources, 47 (30%) occur earlier in the same worksheet but 137 (87%) in earlier
worksheets. A document-local signal therefore has a low ceiling and is **not adopted**; the large
gain is learning from executions, now on by default (`justybase.sql.learnFromExecutedQueries`)
while workspace file indexing stays opt-in.

## Not adopted (no measurable effect)

- **Copy-table demotion** (`X_TEST`, `X2` next to `X` with the same join columns): a within-tier
  penalty changed no ranking on either corpus because copies never reached the evaluated lists.
  It stays open until a corpus shows the problem (the local query history did, on scratch tables).
- **Document-local usage signal**: measured on history worksheets (above): 0.129 → 0.150 for FROM
  sources with the index off, no change with it on.

## Next steps

None open for column and FROM-object ranking; new signals need a replay gain first.
