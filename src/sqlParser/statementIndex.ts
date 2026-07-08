import { simpleHash } from "../providers/parsers/hashUtils";
import { SqlParser } from "../sql/sqlParser";

export interface StatementBoundary {
  index: number;
  startOffset: number;
  endOffset: number;
  sql: string;
  contentHash: string;
}

export interface StatementIndex {
  documentContentHash: string;
  statements: StatementBoundary[];
}

export interface StatementIndexDiff {
  dirtyIndices: number[];
  affectedFromIndex: number;
}

export function buildStatementIndex(fullSql: string): StatementIndex {
  const statements = SqlParser.splitStatementsWithPositions(fullSql).map(
    (statement, index) => ({
      index,
      startOffset: statement.startOffset,
      endOffset: statement.endOffset,
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
