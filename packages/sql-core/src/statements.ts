import type { StatementBoundary } from "./validation/types";

/** Compatibility name for the shared validation statement boundary. */
export type CoreStatementBoundary = StatementBoundary;

export interface StatementAtPosition {
  sql: string;
  start: number;
  end: number;
}

/** Split a Netezza script without treating comments, literals or procedure bodies as boundaries. */
export function splitSqlStatements(sql: string): StatementBoundary[] {
  const statements: StatementBoundary[] = [];
  let statementStart = 0;
  let index = 0;
  let procedureDepth = 0;
  let lineComment = false;
  let blockCommentDepth = 0;
  let quote: "'" | '"' | undefined;

  const addStatement = (endOffset: number): void => {
    const raw = sql.slice(statementStart, endOffset);
    const leading = raw.search(/\S/);
    if (leading < 0) {
      statementStart = endOffset + 1;
      return;
    }
    const startOffset = statementStart + leading;
    const content = sql.slice(startOffset, endOffset).trim();
    if (content) {
      const contentStart = startOffset;
      const contentEnd = contentStart + content.length;
      statements.push({
        index: statements.length,
        startOffset: contentStart,
        endOffset: contentEnd,
        sql: content,
      });
    }
    statementStart = endOffset + 1;
  };

  while (index < sql.length) {
    const character = sql[index];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      index += 1;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (character === "/" && sql[index + 1] === "*") {
        blockCommentDepth += 1;
        index += 2;
      } else if (character === "*" && sql[index + 1] === "/") {
        blockCommentDepth -= 1;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === quote) {
        if (sql[index + 1] === quote) index += 2;
        else {
          quote = undefined;
          index += 1;
        }
      } else {
        index += 1;
      }
      continue;
    }
    if (character === "-" && sql[index + 1] === "-") {
      lineComment = true;
      index += 2;
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      blockCommentDepth = 1;
      index += 2;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      index += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const wordStart = index;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index])) index += 1;
      const word = sql.slice(wordStart, index).toUpperCase();
      if (word === "BEGIN_PROC") procedureDepth += 1;
      if (word === "END_PROC" && procedureDepth > 0) procedureDepth -= 1;
      continue;
    }
    if (character === ";" && procedureDepth === 0) addStatement(index);
    index += 1;
  }

  const trailing = sql.slice(statementStart);
  if (/\S/.test(trailing)) {
    const leading = trailing.search(/\S/);
    const startOffset = statementStart + leading;
    const content = sql.slice(startOffset).trim();
    if (content) {
      statements.push({
        index: statements.length,
        startOffset,
        endOffset: startOffset + content.length,
        sql: content,
      });
    }
  }
  return statements;
}

export function getSqlStatementAtPosition(
  sql: string,
  offset: number,
): StatementAtPosition | null {
  const safeOffset = Math.max(0, Math.min(offset, sql.length));
  const statement = splitSqlStatements(sql).find(
    ({ startOffset, endOffset }) => safeOffset >= startOffset && safeOffset <= endOffset,
  );
  return statement
    ? { sql: statement.sql, start: statement.startOffset, end: statement.endOffset }
    : null;
}
