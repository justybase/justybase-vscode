import {
  DEFAULT_DATABASE_KIND,
  tryNormalizeDatabaseKind,
  type DatabaseKind,
} from "../contracts/database";
import { netezzaSqlAuthoring } from "../dialects/netezza/sql/authoring";
import {
  createSqlParserInstance as createNetezzaSqlParserInstance,
  getSqlParserInstance as getNetezzaSqlParserInstance,
} from "../dialects/netezza/sql/parser";
import { SqlLexer as netezzaSqlLexer } from "../dialects/netezza/sql/lexer";
import type { CstNode, IRecognitionException } from "chevrotain";
import {
  createSqlParserInstance as createBaseSqlParserInstance,
  getSqlParserInstance as getBaseSqlParserInstance,
} from "./parser";
import { SqlLexer as baseSqlLexer } from "./lexer";
import type {
  DatabaseSqlAuthoring,
  DatabaseSqlValidationProfile,
} from "../sql/authoring/types";

type SqlLexResult = ReturnType<typeof baseSqlLexer.tokenize>;
type SqlParserInstance = ReturnType<typeof getBaseSqlParserInstance>;

interface SqlParserMethods {
  statements(): CstNode;
}

export interface SqlParsingRuntime {
  id: string;
  SqlLexer: typeof baseSqlLexer;
  getSqlParserInstance: typeof getBaseSqlParserInstance;
  createSqlParserInstance: typeof createBaseSqlParserInstance;
}

export interface SqlParsingRuntimeOptions {
  authoring?: DatabaseSqlAuthoring;
  validationProfile?: DatabaseSqlValidationProfile;
  databaseKind?: string | DatabaseKind;
}

export interface SqlParserSession {
  runtime: SqlParsingRuntime;
  parser: SqlParserInstance;
  usedIsolatedParser: boolean;
}

export interface SqlStatementsParseOptions extends SqlParsingRuntimeOptions {
  sql: string;
  runtime?: SqlParsingRuntime;
  ignoreParserError?: (error: IRecognitionException) => boolean;
}

export interface SqlStatementsParseResult {
  runtime: SqlParsingRuntime;
  lexResult: SqlLexResult;
  cst?: CstNode;
  parserErrors: IRecognitionException[];
  actionableParserErrors: IRecognitionException[];
  usedIsolatedParser: boolean;
}

function replaceRangeWithSpaces(sql: string, start: number, end: number): string {
  return sql.slice(0, start) + sql.slice(start, end).replace(/[^\r\n]/g, " ") + sql.slice(end);
}

function replaceRangeWithLiteral(sql: string, start: number, end: number): string {
  const length = end - start;
  if (length <= 0) {
    return sql;
  }

  return sql.slice(0, start) + "0" + " ".repeat(length - 1) + sql.slice(end);
}

function replaceRangeWithPaddedText(
  sql: string,
  start: number,
  end: number,
  text: string,
): string {
  const length = end - start;
  if (length <= 0) {
    return sql;
  }

  return sql.slice(0, start) + text.slice(0, length).padEnd(length, " ") + sql.slice(end);
}

function findDirectiveEnd(sql: string, start: number): number {
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

function skipHorizontalWhitespace(sql: string, start: number): number {
  let offset = start;
  while (offset < sql.length && (sql[offset] === " " || sql[offset] === "\t")) {
    offset++;
  }
  return offset;
}

function isAtLineStartAfterWhitespace(sql: string, offset: number): boolean {
  let i = offset - 1;
  while (i >= 0 && (sql[i] === " " || sql[i] === "\t" || sql[i] === "\r")) {
    i--;
  }
  return i < 0 || sql[i] === "\n";
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

function readMacroDirectiveRange(
  sql: string,
  start: number,
): { start: number; end: number } | undefined {
  const directiveStart = skipHorizontalWhitespace(sql, start);
  const ifMatch = sql.slice(directiveStart).match(/^%if\s+/i);
  if (ifMatch) {
    return {
      start: directiveStart,
      end: findMacroIfBlockEnd(sql, findDirectiveEnd(sql, directiveStart + ifMatch[0].length)),
    };
  }

  const directiveMatch = sql.slice(directiveStart).match(
    /^(?:%let\s+[A-Za-z_][A-Za-z0-9_]*\s*=|%put\s+|%export\b\s*|%include\s+|%else\s+%do\b\s*|%end\b\s*)/i,
  );

  if (!directiveMatch) {
    return undefined;
  }

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
      const ifMatch = text.match(/^%if\s+/i);
      if (ifMatch) {
        depth++;
        offset = findDirectiveEnd(sql, directiveStart + ifMatch[0].length);
        atLineStart = isAtLineStartAfterWhitespace(sql, offset);
        allowChainedDirective = true;
        continue;
      }

      const endMatch = text.match(/^%end\b\s*;?/i);
      if (endMatch) {
        const end = directiveStart + endMatch[0].length;
        if (depth === 0) {
          return end;
        }
        depth--;
        offset = end;
        atLineStart = isAtLineStartAfterWhitespace(sql, offset);
        allowChainedDirective = true;
        continue;
      }

      const directiveMatch = text.match(/^%(?:else\s+%do|let\s+[A-Za-z_][A-Za-z0-9_]*\s*=|put\s+|export\b\s*|include\s+)/i);
      if (directiveMatch) {
        offset = findDirectiveEnd(sql, directiveStart + directiveMatch[0].length);
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
        sanitized = replaceRangeWithSpaces(
          sanitized,
          directive.start,
          directive.end,
        );
        offset = directive.end;
        atLineStart = isAtLineStartAfterWhitespace(sanitized, offset);
        allowChainedDirective = true;
        continue;
      }
    }

    const char = sanitized[offset] ?? "";
    offset++;
    allowChainedDirective = false;
    atLineStart = updateLineStartState(atLineStart, char);
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
    offset++;
  }
  return offset;
}

function skipSanitizerTrivia(sql: string, start: number): number | undefined {
  if (sql[start] === "-" && sql[start + 1] === "-") {
    let offset = start + 2;
    while (offset < sql.length && sql[offset] !== "\n") {
      offset++;
    }
    return offset;
  }

  if (sql[start] === "/" && sql[start + 1] === "*") {
    let offset = start + 2;
    while (offset + 1 < sql.length && !(sql[offset] === "*" && sql[offset + 1] === "/")) {
      offset++;
    }
    return Math.min(offset + 2, sql.length);
  }

  if (sql[start] === "'") {
    return skipSanitizerQuotedText(sql, start, "'");
  }

  if (sql[start] === '"') {
    return skipSanitizerQuotedText(sql, start, '"');
  }

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

    if (sql[offset] === "(") {
      depth++;
    } else if (sql[offset] === ")") {
      depth--;
      if (depth === 0) {
        return offset + 1;
      }
    }

    offset++;
  }

  return -1;
}

function readMacroQueryFunctionRange(
  sql: string,
  start: number,
): { start: number; end: number } | undefined {
  const match = sql.slice(start).match(/^%(?:eval|sql|sqllist)\s*\(/i);
  if (!match) {
    return undefined;
  }

  const openParen = start + match[0].lastIndexOf("(");
  const end = findMacroQueryFunctionEnd(sql, openParen);
  if (end === -1) {
    return undefined;
  }

  return { start, end };
}

function sanitizeMacroQueryFunctions(sql: string): string {
  let sanitized = sql;
  let i = 0;

  while (i < sanitized.length) {
    const skipped = skipSanitizerTrivia(sanitized, i);
    if (skipped !== undefined) {
      i = skipped;
      continue;
    }

    if (sanitized[i] === "%") {
      const range = readMacroQueryFunctionRange(sanitized, i);
      if (range) {
        sanitized = replaceRangeWithLiteral(sanitized, range.start, range.end);
        i = range.end;
        continue;
      }
    }

    i++;
  }

  return sanitized;
}

function parseMacroReference(
  sql: string,
  start: number,
): { name: string; end: number } | undefined {
  if (sql[start] === "&" && /[A-Za-z_]/.test(sql[start + 1] ?? "")) {
    let end = start + 2;
    while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end])) {
      end++;
    }
    return { name: sql.slice(start + 1, end), end };
  }

  if (sql[start] === "$" && sql[start + 1] === "{") {
    let nameStart = start + 2;
    while (nameStart < sql.length && /\s/.test(sql[nameStart] ?? "")) {
      nameStart++;
    }
    if (!/[A-Za-z_]/.test(sql[nameStart] ?? "")) {
      return undefined;
    }

    let nameEnd = nameStart + 1;
    while (nameEnd < sql.length && /[A-Za-z0-9_]/.test(sql[nameEnd])) {
      nameEnd++;
    }

    let end = nameEnd;
    while (end < sql.length && /\s/.test(sql[end] ?? "")) {
      end++;
    }
    if (sql[end] !== "}") {
      return undefined;
    }

    return { name: sql.slice(nameStart, nameEnd), end: end + 1 };
  }

  if (sql[start] === "$" && /[A-Za-z_]/.test(sql[start + 1] ?? "")) {
    let end = start + 2;
    while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end])) {
      end++;
    }
    return { name: sql.slice(start + 1, end), end };
  }

  return undefined;
}

function readPreviousWord(sql: string, start: number): string | undefined {
  let i = start - 1;
  while (i >= 0 && /\s/.test(sql[i] ?? "")) {
    i--;
  }
  if (i < 0 || !/[A-Za-z_]/.test(sql[i] ?? "")) {
    return undefined;
  }

  const end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_]/.test(sql[i] ?? "")) {
    i--;
  }
  return sql.slice(i + 1, end).toUpperCase();
}

function readPreviousSignificantChar(sql: string, start: number): string | undefined {
  let i = start - 1;
  while (i >= 0 && /\s/.test(sql[i] ?? "")) {
    i--;
  }
  return i >= 0 ? sql[i] : undefined;
}

function readNextSignificantChar(sql: string, start: number): string | undefined {
  let i = start;
  while (i < sql.length && /\s/.test(sql[i] ?? "")) {
    i++;
  }
  return i < sql.length ? sql[i] : undefined;
}

function isIdentifierMacroPosition(sql: string, start: number, end: number): boolean {
  const previousChar = readPreviousSignificantChar(sql, start);
  if (previousChar === ".") {
    return true;
  }

  const nextChar = readNextSignificantChar(sql, end);
  if (nextChar === ".") {
    return true;
  }

  const previousWord = readPreviousWord(sql, start);
  return previousWord !== undefined && new Set([
    "CALL",
    "EXEC",
    "EXECUTE",
    "FROM",
    "GROOM",
    "INTO",
    "JOIN",
    "MERGE",
    "ON",
    "PROCEDURE",
    "SEQUENCE",
    "STATISTICS",
    "TABLE",
    "TRUNCATE",
    "UPDATE",
    "USING",
    "VIEW",
  ]).has(previousWord);
}

function sanitizeSqlMacroSyntax(sql: string): string {
  let sanitized = sanitizeMacroQueryFunctions(sanitizeMacroDirectives(sql));
  let i = 0;

  while (i < sanitized.length) {
    if (sanitized[i] === "-" && sanitized[i + 1] === "-") {
      i += 2;
      while (i < sanitized.length && sanitized[i] !== "\n") {
        i++;
      }
      continue;
    }

    if (sanitized[i] === "/" && sanitized[i + 1] === "*") {
      i += 2;
      while (
        i + 1 < sanitized.length &&
        !(sanitized[i] === "*" && sanitized[i + 1] === "/")
      ) {
        i++;
      }
      i += 2;
      continue;
    }

    if (sanitized[i] === "'") {
      i++;
      while (i < sanitized.length) {
        if (sanitized[i] === "'") {
          if (sanitized[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (sanitized[i] === '"') {
      i++;
      while (i < sanitized.length) {
        if (sanitized[i] === '"') {
          if (sanitized[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (sanitized[i] === "&" || sanitized[i] === "$") {
      const start = i;
      const macroReference = parseMacroReference(sanitized, start);
      if (macroReference) {
        sanitized = isIdentifierMacroPosition(sanitized, start, macroReference.end)
          ? replaceRangeWithPaddedText(
            sanitized,
            start,
            macroReference.end,
            macroReference.name,
          )
          : replaceRangeWithLiteral(sanitized, start, macroReference.end);
        i = macroReference.end;
        continue;
      }
    }

    i++;
  }

  return sanitized;
}

interface SqlParsingRuntimeRegistration {
  runtime: SqlParsingRuntime;
  kind?: DatabaseKind;
  authoring?: DatabaseSqlAuthoring;
  validationProfile?: DatabaseSqlValidationProfile;
}

export const BASE_SQL_PARSING_RUNTIME: SqlParsingRuntime = {
  id: "base",
  SqlLexer: baseSqlLexer,
  getSqlParserInstance: getBaseSqlParserInstance,
  createSqlParserInstance: createBaseSqlParserInstance,
};

export const NETEZZA_SQL_PARSING_RUNTIME: SqlParsingRuntime = {
  id: "netezza",
  SqlLexer: netezzaSqlLexer,
  getSqlParserInstance: getNetezzaSqlParserInstance,
  createSqlParserInstance: createNetezzaSqlParserInstance,
};

const runtimeByKind = new Map<DatabaseKind, SqlParsingRuntime>();
const runtimeByAuthoring = new WeakMap<object, SqlParsingRuntime>();
const runtimeByValidationProfile = new WeakMap<object, SqlParsingRuntime>();
const activeParserSessionsByRuntimeId = new Map<string, number>();

export function clearActiveParserSessions(): void {
  activeParserSessionsByRuntimeId.clear();
}

export function registerSqlParsingRuntime({
  runtime,
  kind,
  authoring,
  validationProfile,
}: SqlParsingRuntimeRegistration): SqlParsingRuntime {
  if (kind) {
    runtimeByKind.set(kind, runtime);
  }
  if (authoring) {
    runtimeByAuthoring.set(authoring, runtime);
  }
  if (validationProfile) {
    runtimeByValidationProfile.set(validationProfile, runtime);
  }
  return runtime;
}

registerSqlParsingRuntime({
  runtime: NETEZZA_SQL_PARSING_RUNTIME,
  kind: "netezza",
  authoring: netezzaSqlAuthoring,
  validationProfile: netezzaSqlAuthoring.validation,
});

function resolveDatabaseKind(
  databaseKind?: string | DatabaseKind,
): DatabaseKind | undefined {
  if (!databaseKind) {
    return undefined;
  }

  return tryNormalizeDatabaseKind(databaseKind);
}

/**
 * Resolves the lexer/parser pair to use for a given authoring or validation context.
 * Unknown non-Netezza contexts deliberately fall back to the shared base grammar so new
 * dialects are not forced through Netezza-specific parsing until they register a runtime.
 */
export function resolveSqlParsingRuntime(
  options: SqlParsingRuntimeOptions = {},
): SqlParsingRuntime {
  if (options.authoring) {
    const runtime = runtimeByAuthoring.get(options.authoring);
    if (runtime) {
      return runtime;
    }
  }

  if (options.validationProfile) {
    const runtime = runtimeByValidationProfile.get(options.validationProfile);
    if (runtime) {
      return runtime;
    }
  }

  const resolvedKind = resolveDatabaseKind(options.databaseKind);
  if (resolvedKind) {
    return runtimeByKind.get(resolvedKind) ?? BASE_SQL_PARSING_RUNTIME;
  }

  if (options.authoring || options.validationProfile) {
    return BASE_SQL_PARSING_RUNTIME;
  }

  return (
    runtimeByKind.get(DEFAULT_DATABASE_KIND) ?? NETEZZA_SQL_PARSING_RUNTIME
  );
}

export function runWithSqlParserSession<TResult>(
  runtime: SqlParsingRuntime,
  callback: (session: SqlParserSession) => TResult,
): TResult {
  const activeSessionCount =
    activeParserSessionsByRuntimeId.get(runtime.id) ?? 0;
  const entrySessionCount = activeSessionCount + 1;
  activeParserSessionsByRuntimeId.set(runtime.id, entrySessionCount);

  try {
    const usedIsolatedParser = activeSessionCount > 0;
    const parser = usedIsolatedParser
      ? runtime.createSqlParserInstance()
      : runtime.getSqlParserInstance();

    return callback({
      runtime,
      parser,
      usedIsolatedParser,
    });
  } finally {
    const nextSessionCount = entrySessionCount - 1;
    if (nextSessionCount <= 0) {
      activeParserSessionsByRuntimeId.delete(runtime.id);
    } else {
      activeParserSessionsByRuntimeId.set(runtime.id, nextSessionCount);
    }
  }
}

export function parseSqlStatements(
  options: SqlStatementsParseOptions,
): SqlStatementsParseResult {
  const runtime = options.runtime ?? resolveSqlParsingRuntime(options);
  const sqlForParsing = sanitizeSqlMacroSyntax(options.sql);
  const lexResult = runtime.SqlLexer.tokenize(sqlForParsing);
  if (lexResult.errors.length > 0) {
    return {
      runtime,
      lexResult,
      cst: undefined,
      parserErrors: [],
      actionableParserErrors: [],
      usedIsolatedParser: false,
    };
  }

  let cst: CstNode | undefined;
  let parserErrors: IRecognitionException[] = [];
  let usedIsolatedParser = false;

  runWithSqlParserSession(
    runtime,
    ({ parser, usedIsolatedParser: usedIsolated }) => {
      const statementsParser = parser as SqlParserInstance & SqlParserMethods;
      statementsParser.input = lexResult.tokens;
      statementsParser.errors = [];
      cst = statementsParser.statements();
      parserErrors = [...statementsParser.errors];
      usedIsolatedParser = usedIsolated;
    },
  );

  const ignoreParserError = options.ignoreParserError ?? (() => false);
  const actionableParserErrors = parserErrors.filter(
    (error) => !ignoreParserError(error),
  );

  return {
    runtime,
    lexResult,
    cst,
    parserErrors,
    actionableParserErrors,
    usedIsolatedParser,
  };
}
