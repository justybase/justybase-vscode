/**
 * Comment- and string-aware scanning helpers for regex-based quality rules.
 */

import {
  buildSqlScanIndex,
  buildSqlSourceScanIndex,
  isInsideStringOrComment,
  type SqlSourceScanIndex,
} from "../sql/sqlSourceScan";

export type { SqlSourceScanIndex };

/** @deprecated Use SqlSourceScanIndex from sql/sqlSourceScan. */
export interface SqlScanIndex {
  sql: string;
  masked: Uint8Array;
  sanitized: string;
  isInsideStringOrComment(position: number): boolean;
}

export {
  buildSqlScanIndex,
  buildSqlSourceScanIndex,
  isInsideStringOrComment,
};

interface MacroDirectiveRange {
  start: number;
  end: number;
}

let cachedMacroDirectiveSql: string | undefined;
let cachedMacroDirectiveRanges: MacroDirectiveRange[] = [];

function skipHorizontalWhitespace(sql: string, start: number): number {
  let offset = start;
  while (offset < sql.length && (sql[offset] === " " || sql[offset] === "\t")) {
    offset++;
  }
  return offset;
}

function updateLineStartState(atLineStart: boolean, char: string): boolean {
  if (char === "\n") {
    return true;
  }
  if (char === " " || char === "\t" || char === "\r") {
    return atLineStart;
  }
  return false;
}

function isAtLineStartAfterWhitespace(sql: string, offset: number): boolean {
  let i = offset - 1;
  while (i >= 0 && (sql[i] === " " || sql[i] === "\t" || sql[i] === "\r")) {
    i--;
  }
  return i < 0 || sql[i] === "\n";
}

function findMacroDirectiveEnd(sql: string, start: number): number {
  let quote: "'" | '"' | undefined;
  let parenDepth = 0;

  for (let i = start; i < sql.length; i++) {
    const char = sql[i];

    if (quote) {
      if (char === quote) {
        if (sql[i + 1] === quote) {
          i++;
        } else {
          quote = undefined;
        }
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "(") {
      parenDepth++;
      continue;
    }

    if (char === ")" && parenDepth > 0) {
      parenDepth--;
      continue;
    }

    if (char === ";" && parenDepth === 0) {
      return i + 1;
    }

    if ((char === "\n" || char === "\r") && parenDepth === 0) {
      return i;
    }
  }

  return sql.length;
}

function readMacroDirectiveRange(
  sql: string,
  start: number,
): MacroDirectiveRange | undefined {
  const directiveStart = skipHorizontalWhitespace(sql, start);
  if (isInsideStringOrComment(sql, directiveStart)) {
    return undefined;
  }

  const directiveMatch = sql.slice(directiveStart).match(
    /^(?:%let\s+[A-Za-z_][A-Za-z0-9_]*\s*=|%put\s+)/i,
  );
  if (!directiveMatch) {
    return undefined;
  }

  return {
    start: directiveStart,
    end: findMacroDirectiveEnd(sql, directiveStart + directiveMatch[0].length),
  };
}

function getMacroDirectiveRanges(sql: string): MacroDirectiveRange[] {
  if (cachedMacroDirectiveSql === sql) {
    return cachedMacroDirectiveRanges;
  }

  const ranges: MacroDirectiveRange[] = [];
  let offset = 0;
  let atLineStart = true;
  let allowChainedDirective = true;

  while (offset < sql.length) {
    if (atLineStart || allowChainedDirective) {
      const directive = readMacroDirectiveRange(sql, offset);
      if (directive) {
        ranges.push(directive);
        offset = directive.end;
        atLineStart = isAtLineStartAfterWhitespace(sql, offset);
        allowChainedDirective = true;
        continue;
      }
    }

    const char = sql[offset] ?? "";
    offset++;
    allowChainedDirective = false;
    atLineStart = updateLineStartState(atLineStart, char);
  }

  cachedMacroDirectiveSql = sql;
  cachedMacroDirectiveRanges = ranges;
  return ranges;
}

function isInsideMacroDirective(
  ranges: readonly MacroDirectiveRange[],
  offset: number,
): boolean {
  return ranges.some((range) => offset >= range.start && offset < range.end);
}

export function findPatternMatches(sql: string, pattern: RegExp): RegExpExecArray[] {
  return findPatternMatchesInRange(sql, 0, sql.length, pattern);
}

export function findPatternMatchesInRange(
  sql: string,
  rangeStart: number,
  rangeEnd: number,
  pattern: RegExp,
): RegExpExecArray[] {
  const matches: RegExpExecArray[] = [];
  const segment = sql.substring(rangeStart, rangeEnd);
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  const macroDirectiveRanges = getMacroDirectiveRanges(sql);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(segment)) !== null) {
    const absoluteIndex = rangeStart + match.index;
    if (
      !isInsideStringOrComment(sql, absoluteIndex) &&
      !isInsideMacroDirective(macroDirectiveRanges, absoluteIndex)
    ) {
      matches.push(match);
    }
  }

  return matches;
}

export function hasKeywordInRange(
  sql: string,
  rangeStart: number,
  rangeEnd: number,
  pattern: RegExp,
): boolean {
  return (
    findPatternMatchesInRange(sql, rangeStart, rangeEnd, pattern).length > 0
  );
}

export function findFirstKeywordInRange(
  sql: string,
  rangeStart: number,
  rangeEnd: number,
  pattern: RegExp,
): RegExpExecArray | undefined {
  return findPatternMatchesInRange(sql, rangeStart, rangeEnd, pattern)[0];
}

function getParenDepthAt(sql: string, position: number): number {
  let depth = 0;
  for (let i = 0; i < position; i++) {
    if (isInsideStringOrComment(sql, i)) {
      continue;
    }
    const ch = sql[i];
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
    }
  }
  return depth;
}

const WHERE_CLAUSE_END_KEYWORD =
  /\b(GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|UNION|INTERSECT|EXCEPT)\b/i;

/**
 * Exclusive end offset for the predicate list following a WHERE keyword.
 * Stops at closing parens that end the containing subquery and at clause
 * keywords at the same parenthesis depth as the WHERE.
 */
export function indexOfWhereClauseEnd(
  sql: string,
  contentStart: number,
  stmtEnd: number,
): number {
  const depthAtWhere = getParenDepthAt(sql, contentStart);
  let depth = depthAtWhere;

  for (let i = contentStart; i < stmtEnd; i++) {
    if (isInsideStringOrComment(sql, i)) {
      continue;
    }

    const ch = sql[i];
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      if (depth < depthAtWhere) {
        return i;
      }
      continue;
    }
    if (depth === depthAtWhere) {
      const keywordMatch = findFirstKeywordInRange(
        sql,
        i,
        stmtEnd,
        WHERE_CLAUSE_END_KEYWORD,
      );
      if (keywordMatch?.index === 0) {
        return i;
      }
    }
  }

  return stmtEnd;
}

export function indexOfStatementSemicolon(sql: string, start: number): number {
  let parenDepth = 0;
  for (let i = start; i < sql.length; i++) {
    if (isInsideStringOrComment(sql, i)) {
      continue;
    }

    const ch = sql[i];
    if (ch === "(") {
      parenDepth++;
    } else if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (ch === ";" && parenDepth === 0) {
      return i;
    }
  }
  return sql.length;
}

export interface SqlStatementSlice {
  startOffset: number;
  endOffset: number;
  sql: string;
}

export function splitSqlStatementsWithOffsets(sql: string): SqlStatementSlice[] {
  const statements: SqlStatementSlice[] = [];
  let start = 0;

  for (let i = 0; i < sql.length; i++) {
    if (sql[i] !== ";" || isInsideStringOrComment(sql, i)) {
      continue;
    }

    const statementSql = sql.substring(start, i);
    if (statementSql.trim().length > 0) {
      statements.push({
        startOffset: start,
        endOffset: i,
        sql: statementSql,
      });
    }
    start = i + 1;
  }

  const tail = sql.substring(start);
  if (tail.trim().length > 0) {
    statements.push({
      startOffset: start,
      endOffset: sql.length,
      sql: tail,
    });
  }

  return statements;
}
