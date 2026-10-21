/**
 * Aggregates that make a query grouped: every non-aggregated SELECT item must
 * then appear in GROUP BY. Shared by the grouping validation and by completion
 * (the "all non-aggregated SELECT items" GROUP BY suggestion).
 */
export const GROUPING_AGGREGATE_FUNCTIONS: ReadonlySet<string> = new Set([
  "SUM",
  "COUNT",
  "AVG",
  "MIN",
  "MAX",
  "STDDEV",
  "STDDEV_POP",
  "STDDEV_SAMP",
  "VARIANCE",
  "VAR_POP",
  "VAR_SAMP",
  "GROUP_CONCAT",
  "GROUP_CONCAT_SORT",
  "PERCENTILE_CONT",
  "PERCENTILE_DISC",
]);
