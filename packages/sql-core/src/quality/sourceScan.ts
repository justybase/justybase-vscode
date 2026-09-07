/**
 * Comment-, string-, and macro-aware helpers used by the pure quality rules.
 *
 * The scanner deliberately returns offsets into the original UTF-16 string.
 * Regex matches therefore remain directly usable as diagnostic ranges, even
 * when the source contains astral characters before the match.
 */
import {
  buildSqlSourceScanIndex,
  isInsideStringOrComment,
} from "../sourceScan";

interface MacroDirectiveRange {
  start: number;
  end: number;
}

let cachedMacroDirectiveSql: string | undefined;
let cachedMacroDirectiveRanges: MacroDirectiveRange[] = [];

function skipHorizontalWhitespace(sql: string, start: number): number {
  let offset = start;
  while (offset < sql.length && (sql[offset] === " " || sql[offset] === "\t")) offset += 1;
  return offset;
}

function updateLineStartState(atLineStart: boolean, character: string): boolean {
  if (character === "\n") return true;
  if (character === " " || character === "\t" || character === "\r") return atLineStart;
  return false;
}

function isAtLineStartAfterWhitespace(sql: string, offset: number): boolean {
  let index = offset - 1;
  while (index >= 0 && (sql[index] === " " || sql[index] === "\t" || sql[index] === "\r")) index -= 1;
  return index < 0 || sql[index] === "\n";
}

function findMacroDirectiveEnd(sql: string, start: number): number {
  let quote: "'" | '"' | undefined;
  let parenDepth = 0;
  for (let index = start; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote) {
      if (character === quote) {
        if (sql[index + 1] === quote) index += 1;
        else quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") {
      parenDepth += 1;
      continue;
    }
    if (character === ")" && parenDepth > 0) {
      parenDepth -= 1;
      continue;
    }
    if (character === ";" && parenDepth === 0) return index + 1;
    if ((character === "\n" || character === "\r") && parenDepth === 0) return index;
  }
  return sql.length;
}

function findMacroIfBlockEnd(sql: string, bodyStart: number): number {
  let offset = bodyStart;
  let atLineStart = isAtLineStartAfterWhitespace(sql, offset);
  let allowChainedDirective = true;
  let depth = 0;

  while (offset < sql.length) {
    if (atLineStart || allowChainedDirective) {
      const directiveStart = skipHorizontalWhitespace(sql, offset);
      if (!isInsideStringOrComment(sql, directiveStart)) {
        const text = sql.slice(directiveStart);
        const ifMatch = text.match(/^%if\s+/i);
        if (ifMatch) {
          depth += 1;
          offset = findMacroDirectiveEnd(sql, directiveStart + ifMatch[0].length);
          atLineStart = isAtLineStartAfterWhitespace(sql, offset);
          allowChainedDirective = true;
          continue;
        }
        const endMatch = text.match(/^%end\b\s*;?/i);
        if (endMatch) {
          const end = directiveStart + endMatch[0].length;
          if (depth === 0) return end;
          depth -= 1;
          offset = end;
          atLineStart = isAtLineStartAfterWhitespace(sql, offset);
          allowChainedDirective = true;
          continue;
        }
        const doMatch = text.match(/^%do\s*;?/i);
        if (doMatch) {
          depth += 1;
          offset = findMacroDirectiveEnd(sql, directiveStart + doMatch[0].length);
          atLineStart = isAtLineStartAfterWhitespace(sql, offset);
          allowChainedDirective = true;
          continue;
        }
        const directiveMatch = text.match(
          /^(?:@set\s+[A-Za-z_][A-Za-z0-9_]*\s*=|%else\s+%do\b\s*|%let\s+[A-Za-z_][A-Za-z0-9_]*\s*=|%put\s+|%export\b\s*|%include\s+|%python\s+)/i,
        );
        if (directiveMatch) {
          offset = findMacroDirectiveEnd(sql, directiveStart + directiveMatch[0].length);
          atLineStart = isAtLineStartAfterWhitespace(sql, offset);
          allowChainedDirective = true;
          continue;
        }
      }
    }

    const character = sql[offset] ?? "";
    offset += 1;
    allowChainedDirective = character === ";";
    atLineStart = updateLineStartState(atLineStart, character);
  }
  return sql.length;
}

function readMacroDirectiveRange(sql: string, start: number): MacroDirectiveRange | undefined {
  const directiveStart = skipHorizontalWhitespace(sql, start);
  if (isInsideStringOrComment(sql, directiveStart)) return undefined;

  const ifMatch = sql.slice(directiveStart).match(/^%if\s+/i);
  if (ifMatch) {
    return {
      start: directiveStart,
      end: findMacroIfBlockEnd(sql, findMacroDirectiveEnd(sql, directiveStart + ifMatch[0].length)),
    };
  }

  const directiveMatch = sql.slice(directiveStart).match(
    /^(?:@set\s+[A-Za-z_][A-Za-z0-9_]*\s*=|%let\s+[A-Za-z_][A-Za-z0-9_]*\s*=|%put\s+|%export\b\s*|%include\s+|%python\s+|%do\s*;?|%else\s+%do\b\s*|%end\b\s*)/i,
  );
  if (!directiveMatch) return undefined;
  return {
    start: directiveStart,
    end: findMacroDirectiveEnd(sql, directiveStart + directiveMatch[0].length),
  };
}

function getMacroDirectiveRanges(sql: string): MacroDirectiveRange[] {
  if (cachedMacroDirectiveSql === sql) return cachedMacroDirectiveRanges;

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
    const character = sql[offset] ?? "";
    offset += 1;
    allowChainedDirective = false;
    atLineStart = updateLineStartState(atLineStart, character);
  }

  cachedMacroDirectiveSql = sql;
  cachedMacroDirectiveRanges = ranges;
  return ranges;
}

function isInsideMacroDirective(ranges: readonly MacroDirectiveRange[], offset: number): boolean {
  return ranges.some((range) => offset >= range.start && offset < range.end);
}

export function findPatternMatches(sql: string, pattern: RegExp): RegExpExecArray[] {
  return findPatternMatchesInRange(sql, 0, sql.length, pattern);
}

/** Match code and double-quoted identifiers, while excluding comments/literals. */
export function findPatternMatchesPreservingDoubleQuotedIdentifiers(
  sql: string,
  pattern: RegExp,
): RegExpExecArray[] {
  const matches: RegExpExecArray[] = [];
  const scan = buildSqlSourceScanIndex(sql);
  const macroRanges = getMacroDirectiveRanges(sql);
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sql)) !== null) {
    const start = match.index;
    if (!scan.isInComment(start) && !scan.isInSingleQuotedString(start) && !isInsideMacroDirective(macroRanges, start)) matches.push(match);
  }
  return matches;
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
  const macroRanges = getMacroDirectiveRanges(sql);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(segment)) !== null) {
    const absoluteIndex = rangeStart + match.index;
    if (!isInsideStringOrComment(sql, absoluteIndex) && !isInsideMacroDirective(macroRanges, absoluteIndex)) {
      match.index = absoluteIndex;
      matches.push(match);
    }
  }
  return matches;
}

export function hasKeywordInRange(sql: string, rangeStart: number, rangeEnd: number, pattern: RegExp): boolean {
  return findPatternMatchesInRange(sql, rangeStart, rangeEnd, pattern).length > 0;
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
  for (let index = 0; index < position; index += 1) {
    if (isInsideStringOrComment(sql, index)) continue;
    if (sql[index] === "(") depth += 1;
    else if (sql[index] === ")") depth = Math.max(0, depth - 1);
  }
  return depth;
}

const WHERE_CLAUSE_END_KEYWORD = /\b(GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|UNION|INTERSECT|EXCEPT)\b/i;

export function indexOfWhereClauseEnd(sql: string, contentStart: number, statementEnd: number): number {
  const depthAtWhere = getParenDepthAt(sql, contentStart);
  let depth = depthAtWhere;
  for (let index = contentStart; index < statementEnd; index += 1) {
    if (isInsideStringOrComment(sql, index)) continue;
    const character = sql[index];
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      if (depth < depthAtWhere) return index;
      continue;
    }
    if (depth === depthAtWhere) {
      const keyword = findFirstKeywordInRange(sql, index, statementEnd, WHERE_CLAUSE_END_KEYWORD);
      if (keyword?.index === index) return index;
    }
  }
  return statementEnd;
}

export function indexOfStatementSemicolon(sql: string, start: number): number {
  let parenDepth = 0;
  for (let index = start; index < sql.length; index += 1) {
    if (isInsideStringOrComment(sql, index)) continue;
    if (sql[index] === "(") parenDepth += 1;
    else if (sql[index] === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (sql[index] === ";" && parenDepth === 0) return index;
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
  for (let index = 0; index < sql.length; index += 1) {
    if (sql[index] !== ";" || isInsideStringOrComment(sql, index)) continue;
    const statementSql = sql.substring(start, index);
    if (statementSql.trim().length > 0) statements.push({ startOffset: start, endOffset: index, sql: statementSql });
    start = index + 1;
  }
  const tail = sql.substring(start);
  if (tail.trim().length > 0) statements.push({ startOffset: start, endOffset: sql.length, sql: tail });
  return statements;
}

export function removeCommentsAndStrings(sql: string): string {
  return buildSqlSourceScanIndex(sql).sanitized;
}

export function isOffsetInSingleQuotedString(sql: string, offset: number): boolean {
  return buildSqlSourceScanIndex(sql).isInSingleQuotedString(offset);
}

export function isOffsetInSqlComment(sql: string, offset: number): boolean {
  return buildSqlSourceScanIndex(sql).isInComment(offset);
}
