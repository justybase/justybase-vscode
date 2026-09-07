import type {
  DatabaseSqlAuthoring,
  DatabaseSqlFunctionSignature,
} from "@justybase/contracts";
import {
  NETEZZA_BUILTIN_FUNCTIONS,
  NETEZZA_SPECIAL_BUILTIN_VALUES,
  NETEZZA_SYSTEM_COLUMNS,
} from "./validation/builtins";
import { getNetezzaTypeSpec, supportsProcedureAnySizeArgument } from "./validation/dataTypes";
import { netezzaProcedureQualityRules, netezzaSqlQualityRules } from "./quality/rules";

const NETEZZA_COMPLETION_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "JOIN", "INNER JOIN", "LEFT JOIN", "RIGHT JOIN",
  "FULL JOIN", "ON", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET",
  "UNION", "UNION ALL", "EXCEPT", "INTERSECT", "WITH", "AS", "DISTINCT",
  "CASE", "WHEN", "THEN", "ELSE", "END", "AND", "OR", "NOT", "NULL",
  "IS NULL", "IS NOT NULL", "IN", "EXISTS", "LIKE", "BETWEEN", "ASC", "DESC",
  "INSERT INTO", "UPDATE", "DELETE FROM", "MERGE INTO", "CREATE TABLE",
  "ALTER TABLE", "DROP TABLE", "CALL", "EXPLAIN",
] as const;

// Formatter tokens deliberately use single words. Completion can offer compound
// phrases, but the lossless formatter sees `GROUP` and `BY` as separate tokens.
const NETEZZA_FORMATTER_KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "OFFSET",
  "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "ALTER", "DROP",
  "TRUNCATE", "TABLE", "VIEW", "DATABASE", "SCHEMA", "SEQUENCE", "PROCEDURE", "REPLACE",
  "TEMP", "TEMPORARY", "EXPLAIN", "VERBOSE", "WITH", "RECURSIVE", "JOIN", "INNER",
  "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "NATURAL", "ONLY", "ON", "USING", "AND",
  "OR", "NOT", "NULL", "NULLS", "IS", "IN", "BETWEEN", "LIKE", "ILIKE", "EXISTS", "AS",
  "DISTINCT", "ALL", "ANY", "SOME", "UNION", "INTERSECT", "EXCEPT", "CASE", "WHEN",
  "THEN", "ELSE", "END", "FETCH", "FIRST", "ROW", "ROWS", "RANGE", "OVER", "PARTITION",
  "ASC", "DESC", "BEGIN", "DECLARE", "EXCEPTION", "RETURN", "IF", "ELSIF", "LOOP", "WHILE",
  "EXIT", "RAISE", "CALL", "EXECUTE", "EXEC", "LANGUAGE", "RETURNS", "COMMENT", "ADD",
  "CONSTRAINT", "PRIMARY", "FOREIGN", "REFERENCES", "UNIQUE", "CHECK", "GRANT", "REVOKE",
  "TO", "PUBLIC", "OWNER", "MERGE", "MATCHED", "VIEWS", "BEGIN_PROC", "END_PROC", "GROOM",
  "GENERATE", "NEXT", "STATISTICS", "VALUE", "FOR", "SESSION",
]);

const BASE_SQL_FUNCTION_SIGNATURES: ReadonlyMap<string, readonly DatabaseSqlFunctionSignature[]> = new Map([
  ["COUNT", [
    { name: "COUNT", parameters: ["expression"], description: "Count non-null values" },
    { name: "COUNT", parameters: ["*"], description: "Count all rows" },
    { name: "COUNT", parameters: ["DISTINCT expression"], description: "Count distinct non-null values" },
  ]],
  ["SUM", [
    { name: "SUM", parameters: ["expression"], description: "Sum of values" },
    { name: "SUM", parameters: ["DISTINCT expression"], description: "Sum of distinct values" },
  ]],
  ["AVG", [
    { name: "AVG", parameters: ["expression"], description: "Average of values" },
    { name: "AVG", parameters: ["DISTINCT expression"], description: "Average of distinct values" },
  ]],
  ["MIN", [{ name: "MIN", parameters: ["expression"], description: "Minimum value" }]],
  ["MAX", [{ name: "MAX", parameters: ["expression"], description: "Maximum value" }]],
  ["SUBSTRING", [
    { name: "SUBSTRING", parameters: ["string", "start", "length"], description: "Extract substring" },
    { name: "SUBSTRING", parameters: ["string FROM start FOR length"], description: "Extract substring (SQL standard)" },
  ]],
  ["SUBSTR", [
    { name: "SUBSTR", parameters: ["string", "start"], description: "Extract substring from start" },
    { name: "SUBSTR", parameters: ["string", "start", "length"], description: "Extract substring" },
  ]],
  ["CONCAT", [{ name: "CONCAT", parameters: ["string1", "string2", "..."], description: "Concatenate strings" }]],
  ["LPAD", [{ name: "LPAD", parameters: ["string", "length", "fill"], description: "Left-pad string" }]],
  ["RPAD", [{ name: "RPAD", parameters: ["string", "length", "fill"], description: "Right-pad string" }]],
  ["TRIM", [
    { name: "TRIM", parameters: ["string"], description: "Remove leading/trailing whitespace" },
    { name: "TRIM", parameters: ["LEADING characters FROM string"], description: "Remove leading characters" },
    { name: "TRIM", parameters: ["TRAILING characters FROM string"], description: "Remove trailing characters" },
    { name: "TRIM", parameters: ["BOTH characters FROM string"], description: "Remove leading and trailing characters" },
  ]],
  ["REPLACE", [{ name: "REPLACE", parameters: ["string", "from", "to"], description: "Replace all occurrences" }]],
  ["SPLIT_PART", [{ name: "SPLIT_PART", parameters: ["string", "delimiter", "field"], description: "Split string and return part" }]],
  ["TO_DATE", [{ name: "TO_DATE", parameters: ["value", "format"], description: "Convert a value to date using the specified format mask." }]],
  ["TO_TIMESTAMP", [{ name: "TO_TIMESTAMP", parameters: ["string", "format"], description: "Convert string to timestamp" }]],
  ["TO_CHAR", [{ name: "TO_CHAR", parameters: ["value", "format"], description: "Convert a value to formatted string using the specified format mask." }]],
  ["DATE_PART", [{ name: "DATE_PART", parameters: ["field", "source"], description: "Extract date part" }]],
  ["DATE_TRUNC", [{ name: "DATE_TRUNC", parameters: ["field", "source"], description: "Truncate to precision" }]],
  ["EXTRACT", [{ name: "EXTRACT", parameters: ["field FROM source"], description: "Extract date/time field" }]],
  ["COALESCE", [{ name: "COALESCE", parameters: ["value1", "value2", "..."], description: "Return first non-null value" }]],
  ["NULLIF", [{ name: "NULLIF", parameters: ["value1", "value2"], description: "Return NULL if values are equal" }]],
  ["ROUND", [
    { name: "ROUND", parameters: ["value"], description: "Round to integer" },
    { name: "ROUND", parameters: ["value", "decimals"], description: "Round to specified decimals" },
  ]],
  ["TRUNC", [
    { name: "TRUNC", parameters: ["value"], description: "Truncate to integer" },
    { name: "TRUNC", parameters: ["value", "decimals"], description: "Truncate to specified decimals" },
  ]],
  ["POWER", [{ name: "POWER", parameters: ["base", "exponent"], description: "Raise to power" }]],
  ["MOD", [{ name: "MOD", parameters: ["dividend", "divisor"], description: "Modulo operation" }]],
  ["WIDTH_BUCKET", [{ name: "WIDTH_BUCKET", parameters: ["value", "min", "max", "buckets"], description: "Assign to bucket" }]],
  ["ROW_NUMBER", [{ name: "ROW_NUMBER", parameters: ["OVER (ORDER BY ...)"], description: "Row number in partition" }]],
  ["RANK", [{ name: "RANK", parameters: ["OVER (ORDER BY ...)"], description: "Rank with gaps" }]],
  ["DENSE_RANK", [{ name: "DENSE_RANK", parameters: ["OVER (ORDER BY ...)"], description: "Rank without gaps" }]],
  ["LAG", [{ name: "LAG", parameters: ["expression", "offset", "default"], description: "Previous row value" }]],
  ["LEAD", [{ name: "LEAD", parameters: ["expression", "offset", "default"], description: "Next row value" }]],
  ["FIRST_VALUE", [{ name: "FIRST_VALUE", parameters: ["expression OVER (ORDER BY ...)"], description: "First value in window" }]],
  ["LAST_VALUE", [{ name: "LAST_VALUE", parameters: ["expression OVER (ORDER BY ...)"], description: "Last value in window" }]],
  ["NTH_VALUE", [{ name: "NTH_VALUE", parameters: ["expression", "n"], description: "Nth value in window" }]],
  ["CAST", [{ name: "CAST", parameters: ["expression AS type"], description: "Convert type" }]],
]);

const NETEZZA_FUNCTION_SIGNATURE_OVERLAYS: ReadonlyMap<string, readonly DatabaseSqlFunctionSignature[]> = new Map([
  ["NVL", [{ name: "NVL", parameters: ["value", "replacement"], description: "Returns the first argument when it is not NULL; otherwise returns the second argument." }]],
  ["NVL2", [{ name: "NVL2", parameters: ["value", "if_not_null", "if_null"], description: "Returns the second argument when the first is not NULL; otherwise returns the third argument." }]],
  ["DECODE", [{ name: "DECODE", parameters: ["expression", "search1", "result1", "...", "default"], description: "Compares expression to search values and returns the matching result, or default when no match is found." }]],
  ["GROUP_CONCAT", [
    { name: "GROUP_CONCAT", parameters: ["expression"], description: "Concatenate group values with comma separator" },
    { name: "GROUP_CONCAT", parameters: ["DISTINCT expression"], description: "Concatenate distinct group values" },
    { name: "GROUP_CONCAT", parameters: ["expression SEPARATOR delimiter"], description: "Concatenate group values with custom separator" },
  ]],
  ["GROUP_CONCAT_SORT", [
    { name: "GROUP_CONCAT_SORT", parameters: ["expression"], description: "Concatenate group values sorted alphabetically" },
    { name: "GROUP_CONCAT_SORT", parameters: ["expression SEPARATOR delimiter"], description: "Concatenate sorted group values with custom separator" },
    { name: "GROUP_CONCAT_SORT", parameters: ["expression ORDER BY sort_expr"], description: "Concatenate group values sorted by expression" },
  ]],
  ["PERCENTILE_CONT", [{ name: "PERCENTILE_CONT", parameters: ["fraction WITHIN GROUP (ORDER BY sort_expr)"], description: "Continuous inverse distribution (interpolated percentile)." }]],
  ["PERCENTILE_DISC", [{ name: "PERCENTILE_DISC", parameters: ["fraction WITHIN GROUP (ORDER BY sort_expr)"], description: "Discrete inverse distribution (actual percentile value)." }]],
  ["LE_DST", [{ name: "LE_DST", parameters: ["string1", "string2"], description: "Levenshtein edit distance between two strings." }]],
  ["DLE_DST", [{ name: "DLE_DST", parameters: ["string1", "string2"], description: "Damerau-Levenshtein edit distance." }]],
  ["NYSIIS", [{ name: "NYSIIS", parameters: ["string"], description: "Soundex NYSIIS phonetic encoding." }]],
  ["DBL_MP", [{ name: "DBL_MP", parameters: ["string"], description: "Double Metaphone composite key." }]],
  ["PRI_MP", [{ name: "PRI_MP", parameters: ["dbl_mp_value"], description: "Extracts the primary Double Metaphone key." }]],
  ["SEC_MP", [{ name: "SEC_MP", parameters: ["dbl_mp_value"], description: "Extracts the secondary Double Metaphone key." }]],
  ["SCORE_MP", [{ name: "SCORE_MP", parameters: ["dbl_mp_value1", "dbl_mp_value2", "strong_match", "normal_match", "minor_match", "no_match"], description: "Compares two Double Metaphone keys and returns a score." }]],
]);

export const NETEZZA_FUNCTION_SIGNATURES = mergeFunctionSignatures(
  BASE_SQL_FUNCTION_SIGNATURES,
  NETEZZA_FUNCTION_SIGNATURE_OVERLAYS,
);

function mergeFunctionSignatures(
  ...sources: ReadonlyArray<ReadonlyMap<string, readonly DatabaseSqlFunctionSignature[]>>
): ReadonlyMap<string, readonly DatabaseSqlFunctionSignature[]> {
  const merged = new Map<string, readonly DatabaseSqlFunctionSignature[]>();
  for (const source of sources) {
    for (const [name, entries] of source) {
      merged.set(name, [...(merged.get(name) ?? []), ...entries]);
    }
  }
  return merged;
}

export const NETEZZA_SQL_AUTHORING: DatabaseSqlAuthoring = {
  completionKeywords: NETEZZA_COMPLETION_KEYWORDS,
  signatures: NETEZZA_FUNCTION_SIGNATURES,
  formatter: {
    keywords: NETEZZA_FORMATTER_KEYWORDS,
    clauseKeywords: new Set(["SELECT", "FROM", "WHERE", "HAVING", "SET", "VALUES", "ON", "USING"]),
    newlineBeforeKeywords: new Set(["SELECT", "FROM", "WHERE", "HAVING", "SET", "VALUES", "ON", "USING", "UNION", "INTERSECT", "EXCEPT", "LIMIT", "OFFSET"]),
    joinModifiers: new Set(["INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "NATURAL"]),
    commaNewlineClauses: new Set(["SELECT", "FROM", "SET", "GROUP", "ORDER", "VALUES"]),
    logicalBreakKeywords: new Set(["AND", "OR"]),
  },
  validation: {
    builtinFunctions: NETEZZA_BUILTIN_FUNCTIONS,
    systemColumns: NETEZZA_SYSTEM_COLUMNS,
    specialBuiltinValues: NETEZZA_SPECIAL_BUILTIN_VALUES,
    getTypeSpec: getNetezzaTypeSpec,
    supportsProcedureAnySizeArgument,
  },
  qualityRules: [...netezzaSqlQualityRules, ...netezzaProcedureQualityRules],
};
