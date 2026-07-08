import {
  indexOfStatementSemicolon as indexOfStatementSemicolonRaw,
  isInsideStringOrComment,
} from "../providers/sqlCommentScanUtils";

export function indexOfStatementSemicolon(sql: string, start: number): number {
  return indexOfStatementSemicolonRaw(sql, start);
}

export function hasMatchingSqlCaseEnd(sql: string, caseOffset: number): boolean {
  const stmtEnd = indexOfStatementSemicolon(sql, caseOffset);
  const slice = sql.substring(caseOffset, stmtEnd);
  const keywordPattern = /\b(CASE|END\s+CASE|END)\b/gi;
  let depth = 0;
  let match: RegExpExecArray | null;

  while ((match = keywordPattern.exec(slice)) !== null) {
    const absoluteIndex = caseOffset + match.index;
    if (isInsideStringOrComment(sql, absoluteIndex)) {
      continue;
    }

    const token = match[0].toUpperCase().replace(/\s+/g, " ");
    const after = slice.substring(match.index + match[0].length);

    if (token === "CASE") {
      depth++;
      continue;
    }

    if (token === "END CASE") {
      depth--;
      if (depth === 0) {
        return true;
      }
      continue;
    }

    if (token === "END") {
      if (/^\s*(IF|LOOP|CASE|_PROC|TRANSACTION|WORK)\b/i.test(after)) {
        continue;
      }
      if (
        depth === 1 &&
        (/^\s*,/.test(after) ||
          /^\s*\)/.test(after) ||
          /^\s*(AS|FROM)\b/i.test(after) ||
          /^\s*;/.test(after) ||
          /^\s*$/.test(after))
      ) {
        depth--;
        if (depth === 0) {
          return true;
        }
      }
    }
  }

  return false;
}
