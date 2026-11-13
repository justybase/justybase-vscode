import type { IToken } from "chevrotain";
import type { ValidationError } from "./types";

/**
 * High-frequency keyword typos that are not one edit away from the intended
 * keyword (for example transpositions such as FORM -> FROM).
 */
export const COMMON_KEYWORD_TYPOS: Readonly<Record<string, string>> = Object.freeze({
  FRM: "FROM",
  FOM: "FROM",
  FRO: "FROM",
  FORM: "FROM",
  OFRM: "FROM",
  FRXM: "FROM",
  SELEC: "SELECT",
  SELCT: "SELECT",
  SELET: "SELECT",
  SELKT: "SELECT",
  SELCET: "SELECT",
  SLEECT: "SELECT",
  SELELCT: "SELECT",
  SELEECT: "SELECT",
});

/**
 * Clause keywords considered by the one-edit fallback. Kept small on purpose:
 * broader lists produce false positives on column and table names.
 */
export const CLAUSE_KEYWORDS: readonly string[] = Object.freeze([
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "INSERT",
  "UPDATE",
  "DELETE",
  "CREATE",
  "DROP",
  "ALTER",
  "TABLE",
  "ORDER",
  "GROUP",
  "HAVING",
  "UNION",
  "LIMIT",
  "OFFSET",
]);

/**
 * Keywords that must never be reported as typos. Shared by the Netezza
 * semantic validator and the legacy multi-dialect validator so both keep the
 * exact same suppression list.
 */
export const SQL_TYPO_KEYWORDS: readonly string[] = Object.freeze([
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER",
  "ON", "AND", "OR", "NOT", "INSERT", "INTO", "UPDATE", "DELETE",
  "CREATE", "DROP", "ALTER", "TABLE", "VIEW", "INDEX", "ORDER", "BY",
  "GROUP", "HAVING", "UNION", "ALL", "DISTINCT", "AS", "SET", "VALUES",
  "NULL", "IN", "BETWEEN", "LIKE", "IS", "EXISTS", "CASE", "WHEN",
  "THEN", "ELSE", "END", "LIMIT", "OFFSET", "FETCH", "FIRST", "ROWS",
  "ONLY", "WITH", "CROSS", "FULL", "NATURAL", "USING",
  "ASC", "DESC", "NULLS", "INTERSECT", "EXCEPT",
  "RECURSIVE", "LATERAL", "DISTRIBUTE", "ORGANIZE", "HASH", "RANDOM",
  "TRUNCATE", "GRANT", "REVOKE", "COMMIT", "ROLLBACK", "BEGIN",
  "EXECUTE", "IMMEDIATE", "RETURN", "RETURNS", "LANGUAGE", "SQL",
  "DECLARE", "CURSOR", "OPEN", "CLOSE", "FETCH", "FOR", "LOOP",
  "WHILE", "REPEAT", "UNTIL", "LEAVE", "ITERATE",
  "RAISE", "NOTICE", "EXCEPTION", "IF", "ELSIF",
  "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "UNIQUE", "CHECK",
  "DEFAULT", "ADD", "COLUMN", "RENAME", "CONSTRAINT",
  "MERGE", "USING", "MATCHED", "NOT", "REPLACE",
  "OVERWRITE", "PARTITION", "CLUSTER", "SORT",
  "COPY", "EXPORT", "IMPORT", "LOAD", "UNLOAD",
  "ANALYZE", "VERBOSE", "EXPLAIN", "DESCRIBE", "SHOW",
  "CALL", "SAVEPOINT", "RELEASE", "LOCK", "UNLOCK",
  "LISTEN", "UNLISTEN", "NOTIFY", "PREPARE", "DEALLOCATE",
  "DISCARD", "RESET", "SET", "SHOW", "CURSOR",
  "MATERIALIZED", "TEMPORARY", "TEMP", "FORCE", "IGNORE",
  "SETOF", "RECORD", "VOID", "TRIGGER", "FUNCTION", "PROCEDURE",
  "RETURNS", "LANGUAGE", "COST", "ROWS", "SUPPORT",
  "STABLE", "VOLATILE", "LEAKPROOF", "CALLED", "INPUT",
  "STRICT", "SECURITY", "DEFINER", "INVOKER",
  "PARALLEL", "UNSAFE", "RESTRICTED", "SAFE",
  "COMMENT", "EXTENSION", "SERVER", "SCHEMA",
  "ROLE", "PUBLICATION", "SUBSCRIPTION",
  "POLICY", "RULE", "SEQUENCE", "TYPE", "DOMAIN",
  "OPERATOR", "AGGREGATE", "FAMILY", "COLLATION",
  "CONVERSION", "TEXT", "SEARCH", "CONFIGURATION",
  "DIRECTORY", "STATISTICS", "MANUAL", "AUTO",
  "IDENTITY", "GENERATED", "ALWAYS", "START", "INCREMENT",
  "CACHE", "CYCLE", "MINVALUE", "MAXVALUE",
  "DEFERRABLE", "INITIALLY", "IMMEDIATE",
  "CASCADE", "RESTRICT", "ACTION",
  "OWNER", "MODE", "VALIDATE", "REINDEX", "REFRESH",
  "CONCURRENTLY", "BUILD", "INCREMENTAL", "COMPACT",
  "ACCESS", "METHOD", "STORAGE", "DISK", "MEMORY",
  "LOGGED", "UNLOGGED",
  "PLAIN", "EXTENDED", "MAIN",
  "SYSTEM", "SESSION", "LOCAL", "CURRENT", "TRANSACTION",
  "ISOLATION", "LEVEL", "SERIALIZABLE", "REPEATABLE", "COMMITTED",
  "UNCOMMITTED", "READ", "WRITE", "ONLY",
  "WORK", "DEFERRABLE",
  "PRIVILEGES", "GRANT", "OPTION",
  "DIAGNOSTICS", "ROW_COUNT", "SQLSTATE", "RESIGNAL",
  "SIGNAL", "OTHERS", "NEW", "OLD",
  "PUBLICATION", "SUBSCRIPTION", "CONNECTION",
  "STATISTICS", "HANDLER", "INLINE", "VALIDATOR",
  "TRANSFORM",
]);

export const SQL_KEYWORD_SET: ReadonlySet<string> = new Set(SQL_TYPO_KEYWORDS);

/**
 * Longest keyword in {@link CLAUSE_KEYWORDS}. An identifier longer than this
 * cannot satisfy the `image.length <= keyword.length` guard, so it is skipped
 * before the per-keyword loop.
 */
const MAX_CLAUSE_KEYWORD_LENGTH = CLAUSE_KEYWORDS.reduce(
  (max, keyword) => Math.max(max, keyword.length),
  0,
);

export interface KeywordTypoOptions {
  /** Exact keywords that must never be reported as typos. Defaults to the shared set. */
  sqlKeywords?: ReadonlySet<string>;
  /** Known typos that need more than one edit. Defaults to the shared table. */
  commonTypos?: Readonly<Record<string, string>>;
  /** Keywords used by the one-edit fallback. Defaults to the shared list. */
  clauseKeywords?: readonly string[];
}

/**
 * True when the Levenshtein distance between `a` and `b` is exactly one.
 *
 * This is the only distance the typo detector needs. It replaces a full DP
 * matrix with a linear scan and no allocations while preserving the exact
 * semantics of `levenshtein(a, b) === 1`.
 */
export function isSingleEditAway(a: string, b: string): boolean {
  const aLength = a.length;
  const bLength = b.length;
  if (Math.abs(aLength - bLength) > 1) {
    return false;
  }

  if (aLength === bLength) {
    let differences = 0;
    for (let index = 0; index < aLength; index += 1) {
      if (a.charCodeAt(index) !== b.charCodeAt(index)) {
        differences += 1;
        if (differences > 1) {
          return false;
        }
      }
    }
    return differences === 1;
  }

  const shorter = aLength < bLength ? a : b;
  const longer = aLength < bLength ? b : a;
  let shorterIndex = 0;
  let longerIndex = 0;
  let skipped = false;

  while (shorterIndex < shorter.length && longerIndex < longer.length) {
    if (shorter.charCodeAt(shorterIndex) === longer.charCodeAt(longerIndex)) {
      shorterIndex += 1;
      longerIndex += 1;
      continue;
    }
    if (skipped) {
      return false;
    }
    skipped = true;
    longerIndex += 1;
  }

  return true;
}

function pushTypoError(
  results: ValidationError[],
  token: IToken,
  image: string,
  fix: string,
): void {
  const startOffset = token.startOffset ?? 0;
  const imageLen = token.image?.length ?? 1;
  const startCol = token.startColumn ?? 1;
  const startLn = token.startLine ?? 1;
  results.push({
    message: `Possible typo: '${image}' looks like keyword '${fix}'. Did you mean '${fix}'?`,
    severity: "error",
    position: {
      startLine: startLn,
      startColumn: startCol,
      endLine: startLn,
      endColumn: startCol + imageLen,
      offset: startOffset,
    },
    code: "PAR004",
    suggestedFix: fix,
  });
}

/**
 * Collect PAR004 keyword-typo diagnostics from lexer tokens.
 *
 * The implementation is a pure performance rewrite of the previous full
 * Levenshtein scan:
 * - one linear edit check instead of an O(n*m) matrix;
 * - one check per distinct token image per validation (procedure variables and
 *   table names repeat thousands of times);
 * - exact keyword membership via a Set;
 * - the shared constants are allocated once at module load.
 *
 * Messages, positions, ordering and the common-typo precedence are unchanged.
 */
export function collectKeywordTypos(
  tokens: readonly IToken[],
  options: KeywordTypoOptions = {},
): ValidationError[] {
  const results: ValidationError[] = [];
  const commonTypos = options.commonTypos ?? COMMON_KEYWORD_TYPOS;
  const clauseKeywords = options.clauseKeywords ?? CLAUSE_KEYWORDS;
  const sqlKeywords = options.sqlKeywords ?? SQL_KEYWORD_SET;
  const cache = new Map<string, string | null>();

  for (const token of tokens) {
    const tokenTypeName = token.tokenType.name;
    if (tokenTypeName !== "Identifier" && tokenTypeName !== "Word") {
      continue;
    }

    const image = token.image;
    if (!image || image.length < 3) {
      continue;
    }

    const cached = cache.get(image);
    if (cached !== undefined) {
      if (cached) {
        pushTypoError(results, token, image, cached);
      }
      continue;
    }

    const upper = image.toUpperCase();
    if (sqlKeywords.has(upper)) {
      cache.set(image, null);
      continue;
    }

    // Common typos win over the one-edit fallback.
    const dictFix = commonTypos[upper];
    if (dictFix) {
      cache.set(image, dictFix);
      pushTypoError(results, token, image, dictFix);
      continue;
    }

    if (image.length < 4) {
      cache.set(image, null);
      continue;
    }

    if (image.length > MAX_CLAUSE_KEYWORD_LENGTH) {
      cache.set(image, null);
      continue;
    }

    let fix: string | null = null;
    for (const keyword of clauseKeywords) {
      // Preserve the previous `image.length <= keyword.length` guard before
      // the edit check. This also skips longer identifiers entirely instead of
      // computing an edit distance that the guard would reject.
      if (
        image.length <= keyword.length &&
        isSingleEditAway(upper, keyword)
      ) {
        fix = keyword;
        break;
      }
    }

    cache.set(image, fix);
    if (fix) {
      pushTypoError(results, token, image, fix);
    }
  }

  return results;
}
