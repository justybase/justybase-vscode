import type { StatementIndex } from "./statementIndex";

export const SCRIPT_SCOPE_CREATE_STATEMENT_PATTERN =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|VIEW|(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP(?:ORARY)?\s+)?TABLE|EXTERNAL\s+TABLE)\b/i;

export const SCRIPT_SCOPE_DROP_STATEMENT_PATTERN =
  /\bDROP\s+(?:TABLE|VIEW|PROCEDURE)(?:\s+IF\s+EXISTS)?\b/i;

export const SCRIPT_SCOPE_ALTER_TABLE_STATEMENT_PATTERN =
  /\bALTER\s+TABLE\b/i;

export function isScriptScopeAffectingStatement(statementSql: string): boolean {
  return (
    SCRIPT_SCOPE_CREATE_STATEMENT_PATTERN.test(statementSql) ||
    SCRIPT_SCOPE_DROP_STATEMENT_PATTERN.test(statementSql) ||
    SCRIPT_SCOPE_ALTER_TABLE_STATEMENT_PATTERN.test(statementSql)
  );
}

export function expandDirtyIndicesForScriptContext(
  previousIndex: StatementIndex | undefined,
  nextIndex: StatementIndex,
  dirtyIndices: readonly number[],
): number[] {
  if (dirtyIndices.length === 0) {
    return [];
  }

  let firstContextDirtyIndex: number | undefined;
  for (const index of dirtyIndices) {
    const previousSql = previousIndex?.statements[index]?.sql ?? "";
    const nextSql = nextIndex.statements[index]?.sql ?? "";
    if (
      isScriptScopeAffectingStatement(previousSql) ||
      isScriptScopeAffectingStatement(nextSql)
    ) {
      firstContextDirtyIndex =
        firstContextDirtyIndex === undefined
          ? index
          : Math.min(firstContextDirtyIndex, index);
    }
  }

  if (firstContextDirtyIndex === undefined) {
    return [...dirtyIndices];
  }

  const expanded = new Set(dirtyIndices);
  for (
    let index = firstContextDirtyIndex;
    index < nextIndex.statements.length;
    index += 1
  ) {
    expanded.add(index);
  }

  return Array.from(expanded).sort((left, right) => left - right);
}
