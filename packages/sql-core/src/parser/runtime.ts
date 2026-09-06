import type { CstNode, IRecognitionException } from "chevrotain";
import {
  createSqlParserInstance,
  getSqlParserInstance,
} from "../netezza/parser";
import { SqlLexer } from "../netezza/lexer";

export type NetezzaSqlLexResult = ReturnType<typeof SqlLexer.tokenize>;

export interface NetezzaSqlParsingRuntime {
  readonly id: "netezza";
  readonly SqlLexer: typeof SqlLexer;
  readonly getSqlParserInstance: typeof getSqlParserInstance;
  readonly createSqlParserInstance: typeof createSqlParserInstance;
}

export interface NetezzaSqlParseOptions {
  readonly sql: string;
  readonly ignoreParserError?: (error: IRecognitionException) => boolean;
}

export interface NetezzaSqlParseResult {
  readonly runtime: NetezzaSqlParsingRuntime;
  readonly lexResult: NetezzaSqlLexResult;
  readonly cst?: CstNode;
  readonly parserErrors: IRecognitionException[];
  readonly actionableParserErrors: IRecognitionException[];
  readonly usedIsolatedParser: boolean;
}

export const NETEZZA_SQL_PARSING_RUNTIME: NetezzaSqlParsingRuntime = {
  id: "netezza",
  SqlLexer,
  getSqlParserInstance,
  createSqlParserInstance,
};

function replaceRangeWithSpaces(sql: string, start: number, end: number): string {
  // Parser offsets are UTF-16 code-unit offsets. Keep the replacement regex
  // deliberately non-Unicode so an astral character contributes two spaces,
  // just like the two code units it replaces.
  return sql.slice(0, start) + sql.slice(start, end).replace(/[^\r\n]/g, " ") + sql.slice(end);
}

function replaceRangeWithLiteral(sql: string, start: number, end: number): string {
  const length = end - start;
  if (length <= 0) return sql;
  return sql.slice(0, start) + "0" + " ".repeat(length - 1) + sql.slice(end);
}

function replaceRangeWithPaddedText(
  sql: string,
  start: number,
  end: number,
  text: string,
): string {
  const length = end - start;
  if (length <= 0) return sql;
  return sql.slice(0, start) + text.slice(0, length).padEnd(length, " ") + sql.slice(end);
}

function findDirectiveEnd(sql: string, start: number): number {
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

function skipHorizontalWhitespace(sql: string, start: number): number {
  let offset = start;
  while (offset < sql.length && (sql[offset] === " " || sql[offset] === "\t")) offset += 1;
  return offset;
}

function isAtLineStartAfterWhitespace(sql: string, offset: number): boolean {
  let index = offset - 1;
  while (index >= 0 && (sql[index] === " " || sql[index] === "\t" || sql[index] === "\r")) index -= 1;
  return index < 0 || sql[index] === "\n";
}

function updateLineStartState(atLineStart: boolean, character: string): boolean {
  if (character === "\n") return true;
  if (character === " " || character === "\t" || character === "\r") return atLineStart;
  return false;
}

function readMacroDirectiveRange(
  sql: string,
  start: number,
): { start: number; end: number } | undefined {
  const directiveStart = skipHorizontalWhitespace(sql, start);
  const ifMatch = sql.slice(directiveStart).match(/^%if\s+/iu);
  if (ifMatch) {
    return {
      start: directiveStart,
      end: findMacroIfBlockEnd(sql, findDirectiveEnd(sql, directiveStart + ifMatch[0].length)),
    };
  }

  const directiveMatch = sql.slice(directiveStart).match(
    /^(?:@set\s+[A-Za-z_][A-Za-z0-9_]*\s*=|%let\s+[A-Za-z_][A-Za-z0-9_]*\s*=|%put\s+|%export\b\s*|%include\s+|%python\s+|%do\s*;?|%else\s+%do\b\s*|%end\b\s*)/iu,
  );
  if (!directiveMatch) return undefined;

  return {
    start: directiveStart,
    end: findDirectiveEnd(sql, directiveStart + directiveMatch[0].length),
  };
}

function findMacroIfBlockEnd(sql: string, bodyStart: number): number {
  let offset = bodyStart;
  let atLineStart = isAtLineStartAfterWhitespace(sql, offset);
  let allowChainedDirective = true;
  let depth = 0;

  while (offset < sql.length) {
    if (atLineStart || allowChainedDirective) {
      const directiveStart = skipHorizontalWhitespace(sql, offset);
      const text = sql.slice(directiveStart);
      const ifMatch = text.match(/^%if\s+/iu);
      if (ifMatch) {
        depth += 1;
        offset = findDirectiveEnd(sql, directiveStart + ifMatch[0].length);
        atLineStart = isAtLineStartAfterWhitespace(sql, offset);
        allowChainedDirective = true;
        continue;
      }

      const endMatch = text.match(/^%end\b\s*;?/iu);
      if (endMatch) {
        const end = directiveStart + endMatch[0].length;
        if (depth === 0) return end;
        depth -= 1;
        offset = end;
        atLineStart = isAtLineStartAfterWhitespace(sql, offset);
        allowChainedDirective = true;
        continue;
      }

      const doMatch = text.match(/^%do\s*;?/iu);
      if (doMatch) {
        depth += 1;
        offset = findDirectiveEnd(sql, directiveStart + doMatch[0].length);
        atLineStart = isAtLineStartAfterWhitespace(sql, offset);
        allowChainedDirective = true;
        continue;
      }

      const directiveMatch = text.match(
        /^(?:@set\s+[A-Za-z_][A-Za-z0-9_]*\s*=|%(?:else\s+%do|let\s+[A-Za-z_][A-Za-z0-9_]*\s*=|put\s+|export\b\s*|include\s+|python\s+))/iu,
      );
      if (directiveMatch) {
        offset = findDirectiveEnd(sql, directiveStart + directiveMatch[0].length);
        atLineStart = isAtLineStartAfterWhitespace(sql, offset);
        allowChainedDirective = true;
        continue;
      }
    }

    const character = sql[offset] ?? "";
    offset += 1;
    allowChainedDirective = character === ";";
    atLineStart = updateLineStartState(atLineStart, character);
  }

  return sql.length;
}

function sanitizeMacroDirectives(sql: string): string {
  let sanitized = sql;
  let offset = 0;
  let atLineStart = true;
  let allowChainedDirective = true;

  while (offset < sanitized.length) {
    if (atLineStart || allowChainedDirective) {
      const directive = readMacroDirectiveRange(sanitized, offset);
      if (directive) {
        sanitized = replaceRangeWithSpaces(sanitized, directive.start, directive.end);
        offset = directive.end;
        atLineStart = isAtLineStartAfterWhitespace(sanitized, offset);
        allowChainedDirective = true;
        continue;
      }
    }

    const character = sanitized[offset] ?? "";
    offset += 1;
    allowChainedDirective = character === ";";
    atLineStart = updateLineStartState(atLineStart, character);
  }

  return sanitized;
}

function skipSanitizerQuotedText(sql: string, start: number, quote: "'" | '"'): number {
  let offset = start + 1;
  while (offset < sql.length) {
    if (sql[offset] === quote) {
      if (sql[offset + 1] === quote) {
        offset += 2;
        continue;
      }
      return offset + 1;
    }
    offset += 1;
  }
  return offset;
}

function skipSanitizerTrivia(sql: string, start: number): number | undefined {
  if (sql[start] === "-" && sql[start + 1] === "-") {
    let offset = start + 2;
    while (offset < sql.length && sql[offset] !== "\n") offset += 1;
    return offset;
  }

  if (sql[start] === "/" && sql[start + 1] === "*") {
    let offset = start + 2;
    while (offset + 1 < sql.length && !(sql[offset] === "*" && sql[offset + 1] === "/")) offset += 1;
    return Math.min(offset + 2, sql.length);
  }

  if (sql[start] === "'") return skipSanitizerQuotedText(sql, start, "'");
  if (sql[start] === '"') return skipSanitizerQuotedText(sql, start, '"');
  return undefined;
}

function findMacroQueryFunctionEnd(sql: string, openParen: number): number {
  let depth = 0;
  let offset = openParen;
  while (offset < sql.length) {
    const skipped = skipSanitizerTrivia(sql, offset);
    if (skipped !== undefined) {
      offset = skipped;
      continue;
    }
    if (sql[offset] === "(") depth += 1;
    else if (sql[offset] === ")") {
      depth -= 1;
      if (depth === 0) return offset + 1;
    }
    offset += 1;
  }
  return -1;
}

function readMacroQueryFunctionRange(
  sql: string,
  start: number,
): { start: number; end: number } | undefined {
  const match = sql.slice(start).match(/^%(?:eval|sql|sqllist)\s*\(/iu);
  if (!match) return undefined;
  const openParen = start + match[0].lastIndexOf("(");
  const end = findMacroQueryFunctionEnd(sql, openParen);
  if (end === -1) return undefined;
  return { start, end };
}

function sanitizeMacroQueryFunctions(sql: string): string {
  let sanitized = sql;
  let index = 0;
  while (index < sanitized.length) {
    const skipped = skipSanitizerTrivia(sanitized, index);
    if (skipped !== undefined) {
      index = skipped;
      continue;
    }
    if (sanitized[index] === "%") {
      const range = readMacroQueryFunctionRange(sanitized, index);
      if (range) {
        sanitized = replaceRangeWithLiteral(sanitized, range.start, range.end);
        index = range.end;
        continue;
      }
    }
    index += 1;
  }
  return sanitized;
}

function parseMacroReference(
  sql: string,
  start: number,
): { name: string; end: number } | undefined {
  if (sql[start] === "&" && /[A-Za-z_]/u.test(sql[start + 1] ?? "")) {
    let end = start + 2;
    while (end < sql.length && /[A-Za-z0-9_]/u.test(sql[end] ?? "")) end += 1;
    return { name: sql.slice(start + 1, end), end };
  }

  if (sql[start] === "$" && sql[start + 1] === "{") {
    let nameStart = start + 2;
    while (nameStart < sql.length && /\s/u.test(sql[nameStart] ?? "")) nameStart += 1;
    if (!/[A-Za-z_]/u.test(sql[nameStart] ?? "")) return undefined;
    let nameEnd = nameStart + 1;
    while (nameEnd < sql.length && /[A-Za-z0-9_]/u.test(sql[nameEnd] ?? "")) nameEnd += 1;
    let end = nameEnd;
    while (end < sql.length && /\s/u.test(sql[end] ?? "")) end += 1;
    if (sql[end] !== "}") return undefined;
    return { name: sql.slice(nameStart, nameEnd), end: end + 1 };
  }

  if (sql[start] === "$" && /[A-Za-z_]/u.test(sql[start + 1] ?? "")) {
    let end = start + 2;
    while (end < sql.length && /[A-Za-z0-9_]/u.test(sql[end] ?? "")) end += 1;
    return { name: sql.slice(start + 1, end), end };
  }

  return undefined;
}

function readPreviousWord(sql: string, start: number): string | undefined {
  let index = start - 1;
  while (index >= 0 && /\s/u.test(sql[index] ?? "")) index -= 1;
  if (index < 0 || !/[A-Za-z_]/u.test(sql[index] ?? "")) return undefined;
  const end = index + 1;
  while (index >= 0 && /[A-Za-z0-9_]/u.test(sql[index] ?? "")) index -= 1;
  return sql.slice(index + 1, end).toUpperCase();
}

function readPreviousSignificantChar(sql: string, start: number): string | undefined {
  let index = start - 1;
  while (index >= 0 && /\s/u.test(sql[index] ?? "")) index -= 1;
  return index >= 0 ? sql[index] : undefined;
}

function readNextSignificantChar(sql: string, start: number): string | undefined {
  let index = start;
  while (index < sql.length && /\s/u.test(sql[index] ?? "")) index += 1;
  return index < sql.length ? sql[index] : undefined;
}

function isIdentifierMacroPosition(sql: string, start: number, end: number): boolean {
  if (readPreviousSignificantChar(sql, start) === ".") return true;
  if (readNextSignificantChar(sql, end) === ".") return true;
  const previousWord = readPreviousWord(sql, start);
  return previousWord !== undefined && new Set([
    "CALL", "EXEC", "EXECUTE", "FROM", "GROOM", "INTO", "JOIN", "MERGE", "ON",
    "PROCEDURE", "SEQUENCE", "STATISTICS", "TABLE", "TRUNCATE", "UPDATE", "USING", "VIEW",
  ]).has(previousWord);
}

function sanitizeSqlMacroSyntax(sql: string): string {
  let sanitized = sanitizeMacroQueryFunctions(sanitizeMacroDirectives(sql));
  let index = 0;

  while (index < sanitized.length) {
    if (sanitized[index] === "-" && sanitized[index + 1] === "-") {
      index += 2;
      while (index < sanitized.length && sanitized[index] !== "\n") index += 1;
      continue;
    }
    if (sanitized[index] === "/" && sanitized[index + 1] === "*") {
      index += 2;
      while (index + 1 < sanitized.length && !(sanitized[index] === "*" && sanitized[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (sanitized[index] === "'") {
      index = skipSanitizerQuotedText(sanitized, index, "'");
      continue;
    }
    if (sanitized[index] === '"') {
      index = skipSanitizerQuotedText(sanitized, index, '"');
      continue;
    }
    if (sanitized[index] === "&" || sanitized[index] === "$") {
      const start = index;
      const macroReference = parseMacroReference(sanitized, start);
      if (macroReference) {
        sanitized = isIdentifierMacroPosition(sanitized, start, macroReference.end)
          ? replaceRangeWithPaddedText(sanitized, start, macroReference.end, macroReference.name)
          : replaceRangeWithLiteral(sanitized, start, macroReference.end);
        index = macroReference.end;
        continue;
      }
    }
    index += 1;
  }

  return sanitized;
}

/**
 * Masks product macro syntax without changing offsets. This is the same
 * authoring recovery policy used by the desktop runtime, moved here with the
 * Netezza lexer/parser so package consumers see identical CST positions.
 */
export function sanitizeNetezzaSql(sql: string): string {
  return sanitizeSqlMacroSyntax(sql);
}

let activeParserSessions = 0;

export function parseNetezzaSqlStatements(
  options: NetezzaSqlParseOptions,
): NetezzaSqlParseResult {
  const lexResult = SqlLexer.tokenize(sanitizeNetezzaSql(options.sql));
  if (lexResult.errors.length > 0) {
    return {
      runtime: NETEZZA_SQL_PARSING_RUNTIME,
      lexResult,
      parserErrors: [],
      actionableParserErrors: [],
      usedIsolatedParser: false,
    };
  }

  const usedIsolatedParser = activeParserSessions > 0;
  activeParserSessions += 1;
  let cst: CstNode | undefined;
  let parserErrors: IRecognitionException[];
  try {
    const parser = usedIsolatedParser ? createSqlParserInstance() : getSqlParserInstance();
    parser.input = lexResult.tokens;
    parser.errors = [];
    cst = parser.statements();
    parserErrors = [...parser.errors];
  } finally {
    activeParserSessions -= 1;
  }

  const ignoreParserError = options.ignoreParserError ?? (() => false);
  return {
    runtime: NETEZZA_SQL_PARSING_RUNTIME,
    lexResult,
    cst,
    parserErrors,
    actionableParserErrors: parserErrors.filter((error) => !ignoreParserError(error)),
    usedIsolatedParser,
  };
}
