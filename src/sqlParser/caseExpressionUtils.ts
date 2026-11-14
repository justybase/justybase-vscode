import {
  indexOfStatementSemicolon as indexOfStatementSemicolonRaw,
  isInsideStringOrComment,
} from "../providers/sqlCommentScanUtils";

export function indexOfStatementSemicolon(sql: string, start: number): number {
  return indexOfStatementSemicolonRaw(sql, start);
}

/**
 * True when the CASE expression that starts at `caseOffset` is closed before
 * the end of its statement.
 *
 * A bare `END` closes the innermost open CASE, so `END WHERE`, `END + 1`,
 * `END::INT`, `END IS NULL` and similar valid expression continuations must not
 * be treated as unmatched. Nested CASE expressions are tracked by depth;
 * `END IF`/`END LOOP`/`END CASE`/`END_PROC` never close a CASE expression.
 */
export function hasMatchingSqlCaseEnd(sql: string, caseOffset: number): boolean {
  const statementEnd = indexOfStatementSemicolon(sql, caseOffset);
  const segment = sql.substring(caseOffset, statementEnd);
  const tokenPattern =
    /\bEND\s+CASE\b|\bEND\s+(?:IF|LOOP|_PROC|TRANSACTION|WORK)\b|\bCASE\b|\bEND\b/gi;
  let depth = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(segment)) !== null) {
    const absoluteIndex = caseOffset + match.index;
    if (isInsideStringOrComment(sql, absoluteIndex)) {
      continue;
    }

    const token = match[0].toUpperCase().replace(/\s+/g, " ");
    if (token === "CASE") {
      depth += 1;
      continue;
    }
    if (token === "END") {
      depth -= 1;
      if (depth === 0) {
        return true;
      }
      continue;
    }
    if (token === "END CASE") {
      depth -= 1;
      if (depth === 0) {
        return true;
      }
    }
  }

  return false;
}
