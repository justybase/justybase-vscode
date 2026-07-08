/**
 * Canonical character scanner for SQL source text.
 *
 * Use this module for comment/string-aware **text** operations: semantic-token
 * guards, lint regex filtering, completion prep (`stripComments`), and object
 * search (`stripCommentsAndLiterals`). It classifies every offset as code,
 * line/block comment, or quoted literal (`'` / `"` with doubled-quote escape).
 *
 * **Not** the Chevrotain `SqlLexer` — the lexer remains the source of truth for
 * parsing and AST validation. The lexer uses regex token patterns (e.g.
 * `QuotedIdentifier` as `/"[^"]*"/`) and may disagree with this scanner on
 * extreme edge cases such as `""` inside double-quoted names.
 *
 * `isInsideStringOrComment` / `isInStringOrComment` return true for delimiter
 * characters (`'`, `"`, `--`, `/*`) as well as their content regions. Rules that
 * must still match double-quoted identifiers (e.g. NZ017) should use
 * `isOffsetInSqlComment` + `isOffsetInSingleQuotedString` instead of skipping
 * all of `isInsideStringOrComment`.
 *
 * `stripCommentsAndLiterals` returns `sanitized`: same length as input, with
 * comments and literals replaced by spaces (newlines preserved). This differs
 * from collapsing each comment to a single space but keeps offset alignment for
 * procedure-body and regex-based analysis.
 */

export const enum SqlSourceRegion {
  Code = 0,
  LineComment = 1,
  BlockComment = 2,
  SingleQuoted = 3,
  DoubleQuoted = 4,
}

export interface SqlSourceScanIndex {
  readonly sql: string;
  readonly region: Uint8Array;
  readonly sanitized: string;
  isInComment(offset: number): boolean;
  isInString(offset: number): boolean;
  isInSingleQuotedString(offset: number): boolean;
  isInStringOrComment(offset: number): boolean;
}

let lastScanIndex: SqlSourceScanIndex | undefined;

function isCommentRegion(region: number): boolean {
  return (
    region === SqlSourceRegion.LineComment ||
    region === SqlSourceRegion.BlockComment
  );
}

function isStringRegion(region: number): boolean {
  return (
    region === SqlSourceRegion.SingleQuoted ||
    region === SqlSourceRegion.DoubleQuoted
  );
}

/** Index after the closing star-slash of a block comment starting at startOffset, or undefined. */
export function findNestedBlockCommentEnd(
  sql: string,
  startOffset: number,
): number | undefined {
  if (
    startOffset < 0 ||
    startOffset >= sql.length - 1 ||
    sql[startOffset] !== "/" ||
    sql[startOffset + 1] !== "*"
  ) {
    return undefined;
  }

  let depth = 0;
  let i = startOffset;
  while (i < sql.length - 1) {
    if (sql[i] === "/" && sql[i + 1] === "*") {
      depth++;
      i += 2;
      continue;
    }
    if (sql[i] === "*" && sql[i + 1] === "/") {
      depth--;
      i += 2;
      if (depth === 0) {
        return i;
      }
      continue;
    }
    i++;
  }
  return undefined;
}

export function buildSqlSourceScanIndex(sql: string): SqlSourceScanIndex {
  if (lastScanIndex?.sql === sql) {
    return lastScanIndex;
  }

  const region = new Uint8Array(sql.length);
  const sanitizedChars = sql.split("");
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let blockCommentDepth = 0;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const nextChar = i + 1 < sql.length ? sql[i + 1] : "";

    if (inLineComment) {
      region[i] = SqlSourceRegion.LineComment;
      if (char !== "\n") {
        sanitizedChars[i] = " ";
      }
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (blockCommentDepth > 0) {
      region[i] = SqlSourceRegion.BlockComment;
      if (char !== "\n") {
        sanitizedChars[i] = " ";
      }
      if (char === "/" && nextChar === "*") {
        region[i + 1] = SqlSourceRegion.BlockComment;
        sanitizedChars[i + 1] = " ";
        blockCommentDepth++;
        i++;
      } else if (char === "*" && nextChar === "/") {
        region[i + 1] = SqlSourceRegion.BlockComment;
        sanitizedChars[i + 1] = " ";
        blockCommentDepth--;
        i++;
      }
      continue;
    }

    if (inSingleQuote) {
      region[i] = SqlSourceRegion.SingleQuoted;
      sanitizedChars[i] = " ";
      if (char === "'" && nextChar === "'") {
        region[i + 1] = SqlSourceRegion.SingleQuoted;
        sanitizedChars[i + 1] = " ";
        i++;
        continue;
      }
      if (char === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      region[i] = SqlSourceRegion.DoubleQuoted;
      sanitizedChars[i] = " ";
      if (char === '"' && nextChar === '"') {
        region[i + 1] = SqlSourceRegion.DoubleQuoted;
        sanitizedChars[i + 1] = " ";
        i++;
        continue;
      }
      if (char === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (char === "-" && nextChar === "-") {
      region[i] = SqlSourceRegion.LineComment;
      region[i + 1] = SqlSourceRegion.LineComment;
      sanitizedChars[i] = " ";
      sanitizedChars[i + 1] = " ";
      inLineComment = true;
      i++;
    } else if (char === "/" && nextChar === "*") {
      region[i] = SqlSourceRegion.BlockComment;
      region[i + 1] = SqlSourceRegion.BlockComment;
      sanitizedChars[i] = " ";
      sanitizedChars[i + 1] = " ";
      blockCommentDepth = 1;
      i++;
    } else if (char === "'") {
      region[i] = SqlSourceRegion.SingleQuoted;
      sanitizedChars[i] = " ";
      inSingleQuote = true;
    } else if (char === '"') {
      region[i] = SqlSourceRegion.DoubleQuoted;
      sanitizedChars[i] = " ";
      inDoubleQuote = true;
    } else {
      region[i] = SqlSourceRegion.Code;
    }
  }

  lastScanIndex = {
    sql,
    region,
    sanitized: sanitizedChars.join(""),
    isInComment(offset: number): boolean {
      return (
        offset >= 0 &&
        offset < region.length &&
        isCommentRegion(region[offset])
      );
    },
    isInString(offset: number): boolean {
      return (
        offset >= 0 &&
        offset < region.length &&
        isStringRegion(region[offset])
      );
    },
    isInSingleQuotedString(offset: number): boolean {
      return (
        offset >= 0 &&
        offset < region.length &&
        region[offset] === SqlSourceRegion.SingleQuoted
      );
    },
    isInStringOrComment(offset: number): boolean {
      return (
        offset >= 0 &&
        offset < region.length &&
        region[offset] !== SqlSourceRegion.Code
      );
    },
  };
  return lastScanIndex;
}

/** @deprecated Prefer buildSqlSourceScanIndex — kept for sqlCommentScanUtils shim. */
export function buildSqlScanIndex(sql: string): SqlSourceScanIndex & {
  masked: Uint8Array;
  isInsideStringOrComment(position: number): boolean;
} {
  const index = buildSqlSourceScanIndex(sql);
  const masked = new Uint8Array(index.region.length);
  for (let i = 0; i < index.region.length; i++) {
    masked[i] = index.region[i] === SqlSourceRegion.Code ? 0 : 1;
  }
  return {
    ...index,
    masked,
    isInsideStringOrComment(position: number): boolean {
      return index.isInStringOrComment(position);
    },
  };
}

export function isOffsetInSingleQuotedString(sql: string, offset: number): boolean {
  return buildSqlSourceScanIndex(sql).isInSingleQuotedString(offset);
}

export function isOffsetInSqlComment(sql: string, offset: number): boolean {
  return buildSqlSourceScanIndex(sql).isInComment(offset);
}

export function isInsideStringOrComment(sql: string, position: number): boolean {
  return buildSqlSourceScanIndex(sql).isInStringOrComment(position);
}

/**
 * Removes comments only; preserves string / double-quoted literal text.
 */
export function stripComments(sql: string): string {
  const index = buildSqlSourceScanIndex(sql);
  let result = "";
  for (let i = 0; i < sql.length; i++) {
    if (isCommentRegion(index.region[i])) {
      result += " ";
      continue;
    }
    result += sql[i];
  }
  return result;
}

/**
 * Removes comments and quoted literals (replaced with spaces).
 */
export function stripCommentsAndLiterals(sql: string): string {
  return buildSqlSourceScanIndex(sql).sanitized;
}
