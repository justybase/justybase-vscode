# Analytical view contract

The Analytical result view groups the rows of a result and scores each group against a baseline. This document is the behavioural contract: what persists, what each mode computes, and what evidence a flag must carry. The user-facing guide is `docs/guide/user/analytical-view.md`; the rule catalogue there is generated from `media/resultPanel/analytical/anomalyRules.ts`.

## Identity and persistence

- The state owner is the result identity: source URI plus the host-issued result set id, falling back to the execution timestamp and index.
- State is kept in webview host state under `_analyticalStates`, capped at 50 entries. It is excluded from the grid-state parser.
- State version 2 holds the grouping columns, sort, sensitivity, minimum group size, the detection choice with the reference group key, disabled rules and excluded columns. Version 1 migrates to the defaults for the new fields and is written back as version 2. Version 2 states written before the new modes read as the defaults for them.
- Changing the grouping columns clears the selected group and the reference group, because group keys depend on the grouping.
- Every persisted field is validated against the current schema before use. Unknown rule ids are dropped, and an excluded column must still exist with the same name and must not be a grouping column.

## Data boundaries

- In memory, results up to 500,000 rows are analysed; larger results must be moved to disk first.
- On disk, every spilled row is analysed exactly. Analysis is batched by column (eight per request) and never sampled. Quartiles for measure columns ride in the same batch request as the other statistics, so one batch is one host round trip and the host can be cancelled between batches.
- Quartiles are computed only up to 500,000 rows on disk (`ANALYTICAL_QUANTILE_MAX_DISK_ROWS`), the measured budget for one numeric column (about 1.1 s of database time at that size). Above it, robust mode runs as the whole result and says so.
- Grid filters and the global search are never applied.
- At most 500 groups are listed. Rows in unlisted groups are counted and reported.
- Distinct and top-value counts are exact on disk. In memory they are capped per group and marked approximate beyond the cap.
- On disk, per-group top values are computed only when the column has at most 50 distinct values (`GROUP_TOP_CROSS_TAB_MAX_DISTINCT`) and the result has at most 5,000 groups (`GROUP_TOP_CROSS_TAB_MAX_GROUPS`); a full category distribution (`categories`) uses the same 50 distinct values bound. Outside those bounds `TOP_VALUE_DOMINANCE` and `MIX_SHIFT` are not evaluated.
- On disk, quartiles need numeric storage (`INTEGER` or `REAL`). A measure column stored as text gets no robust statistics, so `MEAN_SHIFT`, `RANGE_OUTLIER` and `HIGH_VARIABILITY` are not evaluated for it.
- Empty strings are treated as null-like on both paths: they are excluded from counts, extremes, top values and category shares, exactly as in memory.
- When a rule is not evaluated for one of the reasons above, the view reports the affected rules and columns in a notice instead of showing it as "no anomaly".

## Detection modes

- **Whole result (default).** The baseline is the population, the group included.
- **Rest of result.** The baseline is the population minus the group, computed exactly from the population moments. Mean, standard deviation and CV are exact. Category counts are subtracted per value, so the category rules run too; top values of a truncated list cannot be subtracted, so top-value rules see no baseline. The rest baseline is unavailable when fewer than 10 rows remain outside the group, or when the subtraction is numerically unstable.
- **Robust.** The baseline is the population, but the statistics are medians and the IQR. Quartiles are type 7 (linear interpolation) and both the memory and the disk paths compute them from the same ranks, so they agree exactly. Robust sigma is IQR / 1.349. A zero IQR yields no robust scale, so no numeric rule runs for that column.
- **Peer groups.** Each group is compared with the qualifying groups (at least the minimum group size). Peer statistics are group summaries: means, extremes, CV, null rate, top share, date window and the category distribution. A metric's centre is the median across peers and its scale is 1.4826 times the median absolute deviation, floored at 5% of the centre (absolute floor 0.02 for shares). Peer mode needs at least 8 qualifying groups.
- **Reference group.** One listed group is the baseline for every other group. The reference group is never scored (`isReference`, no flags, never anomalous). Means use Welch's test. The reference group needs at least 10 non-null values per column.
- **Auto.** Peer groups when there are at least 8 qualifying groups; otherwise the whole result. The header shows `auto` next to the mode that ran.
- The mode actually run is resolved before scoring, and the fallbacks are reported: rest of result needs two listed groups, peer needs eight, robust needs quartiles, and reference needs a listed reference group (without one, nothing is scored).

## Rules and evidence

- Every flag carries evidence: method, baseline (the mode that produced it), observed value, expected value, threshold, effect and effect unit, and sample sizes. The **Why?** panel, the documentation and any export read the same fields.
- MIX_SHIFT measures the total variation distance between category shares and subtracts the expected noise for the group size, `½ Σ √(2 p (1 − p) / (π n))`, so a small group is not flagged for sampling noise alone. Its threshold is 0.25 (scaled).
- Strength in 0 to 1 maps to severity: high at 0.7 and above, warn at 0.35 and above, info below.
- A group's score is `100 × (1 − e^(−Σ weight × strength / 6))`, with weights info 1, warn 2 and high 3. A group is anomalous at 25 or above.
- Rare values never make a group anomalous on their own: their strength is capped below the warn threshold.
- Rules are listed in the rule catalogue in `anomalyRules.ts`, which is the single source for the documentation. The rule for each mode is in its `support` field. Mode-specific rule families live in `modeRules.ts` and the shared helpers in `ruleHelpers.ts`. The rule identifiers are:

  `MEAN_SHIFT`, `RANGE_OUTLIER`, `HIGH_VARIABILITY`, `NULL_RATE_DELTA`, `CONSTANT_IN_GROUP`, `TOP_VALUE_DOMINANCE`, `RARE_VALUE`, `DATE_WINDOW_SHIFT`, `SMALL_GROUP`, `LARGE_GROUP`, `MIX_SHIFT`.

## Execution and recovery

- Computation runs in cooperative slices and stops when superseded; a superseded result is never painted.
- Re-scoring (sensitivity, minimum size, rule switches, excluded columns, detection mode) reuses the cached raw result and starts no computation.
- Only robust mode needs quartiles, so its cache key carries the quartile flag; switching other modes never starts a computation.
- A failed or cancelled computation is not retried automatically; the user retries explicitly.
- Streaming results recompute on a trailing debounce while rows arrive.

## Verification

- Pure tests: `media/resultPanel/__tests__/analytical*.test.tsx`, including the golden characterisation of the original rules (run with MIX_SHIFT disabled), the rest-of-result brute-force comparison, the type-7 quartile oracle, and each mode's rule family.
- DOM tests: the options panel and the orchestrator in jsdom.
- Root tests: `src/__tests__/core/resultDataProvider/groupStats.test.ts`, `analyticalDiskEquivalence.test.ts` and `rareValueEquivalence.test.ts`, which compare disk and in-memory results, including quartiles, category distributions and the flags of robust and category rules.
- Documentation sync: `src/__tests__/docs/analyticalDocsSync.test.ts` checks that the guide's rule table matches the catalogue and that this contract names every rule.
