import { simpleHash } from "../providers/parsers/hashUtils";
import { SqlParser } from "../sql/sqlParser";
import {
  createSqlLineIndex,
  type StatementBoundary as CoreStatementBoundary,
} from "@justybase/sql-core/validation";
import type { ValidationError } from "./types";

export interface StatementBoundary extends CoreStatementBoundary {
  contentHash: string;
  /** 1-based line of `startOffset`; used to remap cached diagnostics. */
  startLine: number;
  /** 1-based column of `startOffset`; used to remap cached diagnostics. */
  startColumn: number;
}

export interface StatementIndex {
  documentContentHash: string;
  statements: StatementBoundary[];
}

export interface StatementIndexDiff {
  dirtyIndices: number[];
  affectedFromIndex: number;
}

export function buildStatementIndex(fullSql: string, databaseKind?: string): StatementIndex {
  const lineIndex = createSqlLineIndex(fullSql);
  const statements = SqlParser.splitStatementsWithPositions(fullSql, databaseKind).map(
    (statement, index) => ({
      index,
      startOffset: statement.startOffset,
      endOffset: statement.endOffset,
      startLine: lineIndex.lineAt(statement.startOffset),
      startColumn: lineIndex.columnAt(statement.startOffset),
      sql: statement.sql,
      contentHash: simpleHash(statement.sql),
    }),
  );

  return {
    documentContentHash: simpleHash(fullSql),
    statements,
  };
}

export function diffStatementIndexes(
  previous: StatementIndex | undefined,
  next: StatementIndex,
): StatementIndexDiff {
  if (!previous) {
    return {
      dirtyIndices: next.statements.map((statement) => statement.index),
      affectedFromIndex: 0,
    };
  }

  if (previous.documentContentHash === next.documentContentHash) {
    return {
      dirtyIndices: [],
      affectedFromIndex: next.statements.length,
    };
  }

  const dirty = new Set<number>();
  const maxLength = Math.max(previous.statements.length, next.statements.length);
  let firstDirty = next.statements.length;

  for (let index = 0; index < maxLength; index += 1) {
    const previousStatement = previous.statements[index];
    const nextStatement = next.statements[index];
    if (!nextStatement) {
      firstDirty = Math.min(firstDirty, index);
      continue;
    }
    if (
      !previousStatement ||
      previousStatement.contentHash !== nextStatement.contentHash
    ) {
      dirty.add(index);
      firstDirty = Math.min(firstDirty, index);
    }
  }

  // Statement insertions/deletions shift downstream semantic context. Mark the
  // remaining current statements dirty so cached diagnostics cannot drift.
  if (previous.statements.length !== next.statements.length) {
    for (let index = firstDirty; index < next.statements.length; index += 1) {
      dirty.add(index);
    }
  }

  return {
    dirtyIndices: Array.from(dirty).sort((a, b) => a - b),
    affectedFromIndex: firstDirty,
  };
}

/**
 * Assigns diagnostics to statements with a binary search instead of filtering
 * the whole diagnostic list for every statement. Statement ranges are ordered
 * and non-overlapping, so each diagnostic belongs to at most one statement.
 */
export function groupDiagnosticsByStatement(
  statements: readonly StatementBoundary[],
  diagnostics: readonly ValidationError[],
): Map<number, ValidationError[]> {
  const grouped = new Map<number, ValidationError[]>();
  if (statements.length === 0) {
    return grouped;
  }

  for (const diagnostic of diagnostics) {
    const offset = diagnostic.position.offset;
    let low = 0;
    let high = statements.length - 1;
    let candidate = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (statements[middle].startOffset <= offset) {
        candidate = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (candidate < 0 || offset > statements[candidate].endOffset) {
      continue;
    }

    const statementIndex = statements[candidate].index;
    const bucket = grouped.get(statementIndex);
    if (bucket) {
      bucket.push(diagnostic);
    } else {
      grouped.set(statementIndex, [diagnostic]);
    }
  }

  return grouped;
}
