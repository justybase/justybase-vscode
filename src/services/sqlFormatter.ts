import type { DatabaseKind } from "../contracts/database";
import { getDatabaseSqlAuthoring } from "../core/connectionFactory";

export type SqlKeywordCase = "upper" | "lower" | "preserve";

export interface SqlFormatterOptions {
  tabWidth?: number;
  keywordCase?: SqlKeywordCase;
  linesBetweenQueries?: number;
  databaseKind?: DatabaseKind;
}

type TokenKind =
  | "word"
  | "number"
  | "string"
  | "quotedIdentifier"
  | "bracketIdentifier"
  | "variable"
  | "lineComment"
  | "blockComment"
  | "comma"
  | "semicolon"
  | "lParen"
  | "rParen"
  | "dot"
  | "doubleDot"
  | "operator"
  | "symbol";

interface Token {
  kind: TokenKind;
  text: string;
  upper?: string;
}

interface ActiveClause {
  keyword: string;
  depth: number;
}

const OPERATOR_CHARS = new Set([
  "=",
  "<",
  ">",
  "!",
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "|",
  "&",
  ":",
]);

const KEYWORDS_WITH_SPACE_BEFORE_PAREN = new Set([
  "FROM",
  "AS",
  "IN",
  "VALUES",
  "EXISTS",
  "OVER",
]);

export function formatSql(
  sql: string,
  options: SqlFormatterOptions = {},
): string {
  if (!sql.trim()) {
    return sql;
  }

  const formatterProfile = getDatabaseSqlAuthoring(
    options.databaseKind,
  ).formatter;
  const SQL_KEYWORDS = formatterProfile.keywords;
  const CLAUSE_KEYWORDS = formatterProfile.clauseKeywords;
  const NEWLINE_BEFORE_KEYWORDS = formatterProfile.newlineBeforeKeywords;
  const JOIN_MODIFIERS = formatterProfile.joinModifiers;
  const COMMA_NEWLINE_CLAUSES = formatterProfile.commaNewlineClauses;
  const LOGICAL_BREAK_KEYWORDS = formatterProfile.logicalBreakKeywords;
  const tabWidth = Math.max(1, options.tabWidth ?? 4);
  const keywordCase = options.keywordCase ?? "upper";
  const linesBetweenQueries = Math.max(1, options.linesBetweenQueries ?? 2);
  const tokens = tokenizeLossless(sql);

  let result = "";
  let lineStart = true;
  let pendingSpace = false;
  let indentLevel = 0;
  let parenDepth = 0;
  let activeClause: ActiveClause | null = null;
  let inJoinOnClause = false;
  let inWithClause = false;
  let pendingCteOpenParen = false;
  let lastKeywordUpper: string | undefined;
  let lastTokenWasIdentifier = false;

  const indentText = (level = indentLevel): string =>
    " ".repeat(level * tabWidth);

  const isJoinModifierKeyword = (keyword: string): boolean =>
    JOIN_MODIFIERS.has(keyword);

  const isJoinChainStart = (start: number): boolean => {
    let cursor = start;
    while (cursor < tokens.length) {
      const candidate = tokens[cursor];
      if (!isKeywordToken(candidate)) {
        return false;
      }
      if (candidate.upper === "JOIN") {
        return true;
      }
      if (isJoinModifierKeyword(candidate.upper)) {
        cursor += 1;
        continue;
      }
      return false;
    }
    return false;
  };

  const markKeywordWritten = (keyword: string): void => {
    lastKeywordUpper = keyword;
    lastTokenWasIdentifier = false;
  };

  const markIdentifierWritten = (): void => {
    lastKeywordUpper = undefined;
    lastTokenWasIdentifier = true;
  };

  const trimLineEndSpaces = (): void => {
    while (result.endsWith(" ") || result.endsWith("\t")) {
      result = result.slice(0, -1);
    }
  };

  const writeNewLine = (count = 1): void => {
    trimLineEndSpaces();
    result += "\n".repeat(Math.max(1, count));
    lineStart = true;
    pendingSpace = false;
  };

  const writeSingleToken = (text: string): void => {
    if (lineStart) {
      result += indentText();
      lineStart = false;
    }
    if (pendingSpace && !result.endsWith(" ") && !result.endsWith("\n")) {
      result += " ";
    }
    result += text;
    pendingSpace = false;
  };

  const writeAtIndent = (level: number, text: string): void => {
    const savedIndent = indentLevel;
    indentLevel = level;
    writeSingleToken(text);
    indentLevel = savedIndent;
  };

  const writeLineComment = (text: string): void => {
    if (lineStart) {
      result += indentText();
      lineStart = false;
    } else if (!result.endsWith(" ") && !result.endsWith("\n")) {
      result += " ";
    }
    result += text;
    writeNewLine(1);
  };

  const writeBlockComment = (text: string): void => {
    if (lineStart) {
      result += indentText();
      lineStart = false;
    } else if (!result.endsWith(" ") && !result.endsWith("\n")) {
      result += " ";
    }
    result += text;
    const trailingNewline = /[\r\n]$/.test(text);
    lineStart = trailingNewline;
    pendingSpace = !trailingNewline;
  };

  const closeActiveClause = (): void => {
    if (!activeClause) {
      return;
    }
    if (activeClause.keyword !== "FROM" && activeClause.keyword !== "CTE_SELECT") {
      indentLevel = Math.max(0, indentLevel - 1);
    }
    activeClause = null;
    inJoinOnClause = false;
  };

  const applyKeywordCase = (token: Token): string => {
    const upper = token.upper ?? token.text.toUpperCase();
    if (keywordCase === "preserve") {
      return token.text;
    }
    if (keywordCase === "lower") {
      return upper.toLowerCase();
    }
    return upper;
  };

  const isKeywordToken = (token: Token): token is Token & { upper: string } => {
    return (
      token.kind === "word" && !!token.upper && SQL_KEYWORDS.has(token.upper)
    );
  };

  const nextNonCommentIndex = (start: number): number => {
    for (let i = start; i < tokens.length; i++) {
      if (
        tokens[i].kind !== "lineComment" &&
        tokens[i].kind !== "blockComment"
      ) {
        return i;
      }
    }
    return -1;
  };

  const hasRemainingTokens = (start: number): boolean => {
    return nextNonCommentIndex(start) >= 0;
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];

    if (token.kind === "lineComment") {
      writeLineComment(token.text);
      continue;
    }

    if (token.kind === "blockComment") {
      writeBlockComment(token.text);
      continue;
    }

    if (token.kind === "semicolon") {
      closeActiveClause();
      pendingSpace = false;
      writeSingleToken(token.text);
      if (hasRemainingTokens(index + 1)) {
        writeNewLine(linesBetweenQueries);
      }
      continue;
    }

    if (token.kind === "lParen") {
      if (pendingCteOpenParen) {
        writeNewLine(1);
        pendingCteOpenParen = false;
      } else if (pendingSpace) {
        const keepSpace =
          !!lastKeywordUpper &&
          KEYWORDS_WITH_SPACE_BEFORE_PAREN.has(lastKeywordUpper);
        if (!keepSpace && (lastTokenWasIdentifier || lastKeywordUpper)) {
          pendingSpace = false;
        }
      }
      writeSingleToken(token.text);
      parenDepth += 1;

      const nextIndex = nextNonCommentIndex(index + 1);
      const nextToken = nextIndex >= 0 ? tokens[nextIndex] : undefined;
      if (
        nextToken &&
        isKeywordToken(nextToken) &&
        (nextToken.upper === "SELECT" || nextToken.upper === "WITH")
      ) {
        indentLevel += 1;
        writeNewLine(1);
      } else {
        indentLevel += 1;
      }
      continue;
    }

    if (token.kind === "rParen") {
      const nextParenDepth = Math.max(0, parenDepth - 1);
      const closingCteBody =
        inWithClause && parenDepth === 1 && nextParenDepth === 0;
      if (activeClause && nextParenDepth < activeClause.depth) {
        closeActiveClause();
      }
      indentLevel = Math.max(0, indentLevel - 1);
      parenDepth = nextParenDepth;
      if (lineStart) {
        result += indentText();
        lineStart = false;
      }
      pendingSpace = false;
      if (closingCteBody && !lineStart) {
        writeNewLine(1);
      }
      writeSingleToken(token.text);
      if (closingCteBody) {
        writeNewLine(2);
      } else {
        pendingSpace = true;
      }
      continue;
    }

    if (activeClause && parenDepth < activeClause.depth) {
      closeActiveClause();
    }

    if (token.kind === "comma") {
      pendingSpace = false;
      if (inWithClause && parenDepth === 0) {
        writeSingleToken(token.text);
        pendingSpace = false;
        continue;
      }
      writeSingleToken(token.text);
      if (
        activeClause &&
        (COMMA_NEWLINE_CLAUSES.has(activeClause.keyword) ||
          activeClause.keyword === "CTE_SELECT") &&
        parenDepth <= activeClause.depth
      ) {
        writeNewLine(1);
      } else {
        pendingSpace = true;
      }
      continue;
    }

    if (token.kind === "dot" || token.kind === "doubleDot") {
      pendingSpace = false;
      writeSingleToken(token.text);
      pendingSpace = false;
      continue;
    }

    if (token.kind === "operator") {
      pendingSpace = true;
      writeSingleToken(token.text);
      pendingSpace = true;
      continue;
    }

    if (isKeywordToken(token)) {
      const upper = token.upper;
      const nextIndex = nextNonCommentIndex(index + 1);
      const nextToken = nextIndex >= 0 ? tokens[nextIndex] : undefined;
      const nextUpper =
        nextToken && isKeywordToken(nextToken) ? nextToken.upper : undefined;

      if (upper === "WITH") {
        writeSingleToken(applyKeywordCase(token));
        inWithClause = true;
        pendingSpace = true;
        continue;
      }

      if (upper === "SELECT" && inWithClause && parenDepth === 0) {
        inWithClause = false;
      }

      if (upper === "AS" && inWithClause && parenDepth === 0) {
        const afterAsIndex = nextNonCommentIndex(index + 1);
        const afterAsToken =
          afterAsIndex >= 0 ? tokens[afterAsIndex] : undefined;
        if (afterAsToken?.kind === "lParen") {
          writeSingleToken(applyKeywordCase(token));
          pendingCteOpenParen = true;
          pendingSpace = false;
          continue;
        }
      }

      if (
        (isJoinModifierKeyword(upper) || upper === "JOIN") &&
        isJoinChainStart(index)
      ) {
        inJoinOnClause = false;
        if (!lineStart) {
          writeNewLine(1);
        }
        let cursor = index;
        while (cursor < tokens.length) {
          const joinToken = tokens[cursor];
          if (!isKeywordToken(joinToken)) {
            break;
          }
          const joinUpper = joinToken.upper;
          if (joinUpper === "JOIN" || isJoinModifierKeyword(joinUpper)) {
            writeSingleToken(applyKeywordCase(joinToken));
            pendingSpace = true;
            cursor += 1;
            if (joinUpper === "JOIN") {
              break;
            }
          } else {
            break;
          }
        }
        index = cursor - 1;
        continue;
      }

      if (upper === "CASE") {
        writeSingleToken(applyKeywordCase(token));
        indentLevel += 1;
        pendingSpace = true;
        continue;
      }

      if (upper === "WHEN" || upper === "ELSE") {
        if (!lineStart) {
          writeNewLine(1);
        }
        writeSingleToken(applyKeywordCase(token));
        pendingSpace = true;
        continue;
      }

      if (upper === "END") {
        indentLevel = Math.max(0, indentLevel - 1);
        if (!lineStart) {
          writeNewLine(1);
        }
        writeSingleToken(applyKeywordCase(token));
        pendingSpace = true;
        continue;
      }

      if (upper === "GROUP" || upper === "ORDER") {
        const atClauseLevel =
          !activeClause || parenDepth <= activeClause.depth;
        if (atClauseLevel) {
          if (activeClause && parenDepth <= activeClause.depth) {
            closeActiveClause();
          }
          if (!lineStart) {
            writeNewLine(1);
          }
          writeSingleToken(applyKeywordCase(token));

          if (nextUpper === "BY" && nextToken) {
            pendingSpace = true;
            writeSingleToken(applyKeywordCase(nextToken));
            index = nextIndex;
          }

          writeNewLine(1);
          indentLevel += 1;
          activeClause = { keyword: upper, depth: parenDepth };
          continue;
        }

        writeSingleToken(applyKeywordCase(token));
        if (nextUpper === "BY" && nextToken) {
          pendingSpace = true;
          writeSingleToken(applyKeywordCase(nextToken));
          index = nextIndex;
        }
        pendingSpace = true;
        continue;
      }

      if (LOGICAL_BREAK_KEYWORDS.has(upper) && inJoinOnClause) {
        if (!lineStart) {
          writeNewLine(1);
        }
        writeAtIndent(1, applyKeywordCase(token));
        pendingSpace = true;
        continue;
      }

      if (
        LOGICAL_BREAK_KEYWORDS.has(upper) &&
        activeClause &&
        (activeClause.keyword === "WHERE" ||
          activeClause.keyword === "HAVING" ||
          activeClause.keyword === "ON" ||
          activeClause.keyword === "SET" ||
          activeClause.keyword === "WHEN")
      ) {
        if (!lineStart) {
          writeNewLine(1);
        }
        writeSingleToken(applyKeywordCase(token));
        pendingSpace = true;
        continue;
      }

      if (
        (upper === "ON" || upper === "USING") &&
        activeClause?.keyword === "FROM"
      ) {
        writeSingleToken(applyKeywordCase(token));
        inJoinOnClause = true;
        pendingSpace = true;
        continue;
      }

      if (upper === "FROM") {
        if (activeClause && parenDepth <= activeClause.depth) {
          closeActiveClause();
        }
        if (!lineStart) {
          writeNewLine(1);
        }
        writeSingleToken(applyKeywordCase(token));
        pendingSpace = true;
        activeClause = { keyword: "FROM", depth: parenDepth };
        markKeywordWritten(upper);
        continue;
      }

      if (NEWLINE_BEFORE_KEYWORDS.has(upper)) {
        if (activeClause && parenDepth <= activeClause.depth) {
          closeActiveClause();
        }
        if (!lineStart) {
          writeNewLine(1);
        }
      }

      if (CLAUSE_KEYWORDS.has(upper)) {
        if (activeClause && parenDepth <= activeClause.depth) {
          closeActiveClause();
        }
        if (upper === "SELECT" && inWithClause && parenDepth >= 1) {
          writeSingleToken(applyKeywordCase(token));
          pendingSpace = true;
          activeClause = { keyword: "CTE_SELECT", depth: parenDepth };
          continue;
        }
        writeSingleToken(applyKeywordCase(token));
        writeNewLine(1);
        indentLevel += 1;
        activeClause = { keyword: upper, depth: parenDepth };
        continue;
      }

      writeSingleToken(applyKeywordCase(token));
      pendingSpace = true;
      markKeywordWritten(upper);
      continue;
    }

    writeSingleToken(token.text);
    pendingSpace = true;
    markIdentifierWritten();
    continue;
  }

  closeActiveClause();
  trimLineEndSpaces();
  const formatted = result.trimEnd();
  if (formatted.length === 0) {
    throw new Error("Formatter produced empty output");
  }
  return alignClauseListColumns(formatted, tabWidth);
}

function tokenizeLossless(sql: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < sql.length) {
    const current = sql[index];
    const next = index + 1 < sql.length ? sql[index + 1] : "";

    if (isWhitespace(current)) {
      index += 1;
      continue;
    }

    if (current === "-" && next === "-") {
      let cursor = index + 2;
      while (
        cursor < sql.length &&
        sql[cursor] !== "\n" &&
        sql[cursor] !== "\r"
      ) {
        cursor += 1;
      }
      tokens.push({ kind: "lineComment", text: sql.slice(index, cursor) });
      index = cursor;
      continue;
    }

    if (current === "/" && next === "*") {
      let cursor = index + 2;
      while (
        cursor < sql.length - 1 &&
        !(sql[cursor] === "*" && sql[cursor + 1] === "/")
      ) {
        cursor += 1;
      }
      cursor = cursor < sql.length - 1 ? cursor + 2 : sql.length;
      tokens.push({ kind: "blockComment", text: sql.slice(index, cursor) });
      index = cursor;
      continue;
    }

    if (current === "'") {
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (
          cursor + 1 < sql.length &&
          sql[cursor] === "'" &&
          sql[cursor + 1] === "'"
        ) {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === "'") {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      tokens.push({ kind: "string", text: sql.slice(index, cursor) });
      index = cursor;
      continue;
    }

    if (current === '"') {
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (
          cursor + 1 < sql.length &&
          sql[cursor] === '"' &&
          sql[cursor + 1] === '"'
        ) {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === '"') {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      tokens.push({ kind: "quotedIdentifier", text: sql.slice(index, cursor) });
      index = cursor;
      continue;
    }

    if (current === "[") {
      let cursor = index + 1;
      while (cursor < sql.length && sql[cursor] !== "]") {
        cursor += 1;
      }
      cursor = cursor < sql.length ? cursor + 1 : sql.length;
      tokens.push({
        kind: "bracketIdentifier",
        text: sql.slice(index, cursor),
      });
      index = cursor;
      continue;
    }

    if (current === "$") {
      if (next === "{") {
        let cursor = index + 2;
        while (cursor < sql.length && sql[cursor] !== "}") {
          cursor += 1;
        }
        cursor = cursor < sql.length ? cursor + 1 : sql.length;
        tokens.push({ kind: "variable", text: sql.slice(index, cursor) });
        index = cursor;
        continue;
      }

      let cursor = index + 1;
      while (cursor < sql.length && isWordPart(sql[cursor])) {
        cursor += 1;
      }
      tokens.push({ kind: "variable", text: sql.slice(index, cursor) });
      index = cursor;
      continue;
    }

    if (isWordStart(current)) {
      let cursor = index + 1;
      while (cursor < sql.length && isWordPart(sql[cursor])) {
        cursor += 1;
      }
      const text = sql.slice(index, cursor);
      tokens.push({ kind: "word", text, upper: text.toUpperCase() });
      index = cursor;
      continue;
    }

    if (isDigit(current)) {
      let cursor = index + 1;
      while (cursor < sql.length && isDigit(sql[cursor])) {
        cursor += 1;
      }
      if (sql[cursor] === "." && isDigit(sql[cursor + 1])) {
        cursor += 1;
        while (cursor < sql.length && isDigit(sql[cursor])) {
          cursor += 1;
        }
      }
      if (sql[cursor] && (sql[cursor] === "e" || sql[cursor] === "E")) {
        const sign = sql[cursor + 1];
        const expStart = sign === "+" || sign === "-" ? cursor + 2 : cursor + 1;
        if (isDigit(sql[expStart])) {
          cursor = expStart + 1;
          while (cursor < sql.length && isDigit(sql[cursor])) {
            cursor += 1;
          }
        }
      }
      tokens.push({ kind: "number", text: sql.slice(index, cursor) });
      index = cursor;
      continue;
    }

    if (current === ".") {
      if (next === ".") {
        tokens.push({ kind: "doubleDot", text: ".." });
        index += 2;
        continue;
      }
      tokens.push({ kind: "dot", text: "." });
      index += 1;
      continue;
    }

    if (current === ",") {
      tokens.push({ kind: "comma", text: "," });
      index += 1;
      continue;
    }

    if (current === ";") {
      tokens.push({ kind: "semicolon", text: ";" });
      index += 1;
      continue;
    }

    if (current === "(") {
      tokens.push({ kind: "lParen", text: "(" });
      index += 1;
      continue;
    }

    if (current === ")") {
      tokens.push({ kind: "rParen", text: ")" });
      index += 1;
      continue;
    }

    if (OPERATOR_CHARS.has(current)) {
      let cursor = index + 1;
      while (cursor < sql.length && OPERATOR_CHARS.has(sql[cursor])) {
        cursor += 1;
      }
      tokens.push({ kind: "operator", text: sql.slice(index, cursor) });
      index = cursor;
      continue;
    }

    tokens.push({ kind: "symbol", text: current });
    index += 1;
  }

  return tokens;
}

function alignClauseListColumns(sql: string, _tabWidth: number): string {
  const lines = sql.split("\n");
  const aligned = [...lines];
  let index = 0;

  while (index < aligned.length) {
    const trimmed = aligned[index]?.trimStart().toUpperCase() ?? "";
    if (!trimmed.startsWith("SELECT ")) {
      index += 1;
      continue;
    }

    if (parenDepthAtLineStart(aligned, index) > 0) {
      index += 1;
      continue;
    }

    const listLines: number[] = [index];
    let cursor = index + 1;
    let scanDepth = parenDepthAtLineStart(aligned, cursor);
    while (cursor < aligned.length) {
      const nextLine = aligned[cursor] ?? "";
      const nextTrimmed = nextLine.trimStart().toUpperCase();
      if (
        scanDepth <= 0 &&
        (nextTrimmed.startsWith("FROM ") ||
          nextTrimmed.startsWith("WHERE ") ||
          nextTrimmed.startsWith("GROUP ") ||
          nextTrimmed.startsWith("ORDER ") ||
          nextTrimmed.startsWith("HAVING ") ||
          nextTrimmed.startsWith("UNION ") ||
          nextTrimmed.startsWith("EXCEPT ") ||
          nextTrimmed.startsWith("INTERSECT "))
      ) {
        break;
      }
      listLines.push(cursor);
      scanDepth += countParenDelta(nextLine);
      cursor += 1;
    }

    if (listLines.length > 1) {
      const contents = listLines.map((lineIndex) => {
        const line = aligned[lineIndex] ?? "";
        const indent = line.length - line.trimStart().length;
        return { lineIndex, indent, content: line.slice(indent) };
      });
      const targetIndent = Math.max(...contents.map((entry) => entry.indent));
      const maxContentLength = Math.max(...contents.map((entry) => entry.content.length));
      for (const entry of contents) {
        const indentPrefix = " ".repeat(
          Math.max(0, targetIndent - entry.indent),
        );
        aligned[entry.lineIndex] =
          indentPrefix + entry.content.padEnd(maxContentLength, " ");
      }
    }

    index = cursor;
  }

  return aligned.join("\n");
}

function countParenDelta(line: string): number {
  let delta = 0;
  for (const char of line) {
    if (char === "(") {
      delta += 1;
    } else if (char === ")") {
      delta -= 1;
    }
  }
  return delta;
}

function parenDepthAtLineStart(lines: string[], lineIndex: number): number {
  let depth = 0;
  for (let i = 0; i < lineIndex; i++) {
    depth += countParenDelta(lines[i] ?? "");
  }
  return depth;
}

function isWhitespace(char: string): boolean {
  return (
    char === " " ||
    char === "\t" ||
    char === "\n" ||
    char === "\r" ||
    char === "\f"
  );
}

function isWordStart(char: string): boolean {
  return /[A-Za-z_]/.test(char);
}

function isWordPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

function isDigit(char: string): boolean {
  return /[0-9]/.test(char);
}
