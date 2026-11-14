import { buildSqlScanIndex } from "../../providers/sqlCommentScanUtils";
import { shouldUseProcedureRegexFallback } from "./procedureParseGate";
export {
  hasMatchingSqlCaseEnd,
  indexOfStatementSemicolon,
} from "../caseExpressionUtils";

export function removeCommentsAndStrings(sql: string): string {
  return buildSqlScanIndex(sql).sanitized;
}

export function extractProcedureBody(
  sql: string,
): { body: string; startOffset: number; endOffset: number } | null {
  const procedureMatch = /CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\b/i.exec(sql);
  if (!procedureMatch) return null;

  const searchFrom = procedureMatch.index + procedureMatch[0].length;

  const beginProcRegex = /\bBEGIN_PROC\b/gi;
  beginProcRegex.lastIndex = searchFrom;
  const startBeginMatch = beginProcRegex.exec(sql);

  if (startBeginMatch) {
    const endProcRegex = /\bEND_PROC\b/gi;
    endProcRegex.lastIndex = startBeginMatch.index + startBeginMatch[0].length;
    const endProcMatch = endProcRegex.exec(sql);

    if (!endProcMatch) return null;

    return {
      body: sql.substring(
        startBeginMatch.index,
        endProcMatch.index + endProcMatch[0].length,
      ),
      startOffset: startBeginMatch.index,
      endOffset: endProcMatch.index + endProcMatch[0].length,
    };
  }

  const asStringRegex = /\bAS\s+'((?:[^']|'')*)'\s*;?/i;
  asStringRegex.lastIndex = searchFrom;
  const stringBodyMatch = asStringRegex.exec(sql);
  if (stringBodyMatch) {
    const quoteStart =
      stringBodyMatch.index + stringBodyMatch[0].indexOf("'") + 1;
    const body = stringBodyMatch[1].replace(/''/g, "'");
    const quoteEnd = quoteStart + stringBodyMatch[1].length;
    return {
      body,
      startOffset: quoteStart,
      endOffset: quoteEnd,
    };
  }

  return null;
}

export function statementPrefixBefore(sql: string, offset: number): string {
  const preceding = sql.substring(0, offset);
  return preceding.split(";").pop() ?? "";
}

export function parenthesisDepthBefore(sql: string, offset: number): number {
  let depth = 0;
  for (let i = 0; i < offset; i++) {
    if (sql[i] === "(") {
      depth++;
    } else if (sql[i] === ")") {
      depth = Math.max(0, depth - 1);
    }
  }
  return depth;
}

export function isEmbeddedDmlSelect(sql: string, selectOffset: number): boolean {
  if (parenthesisDepthBefore(sql, selectOffset) > 0) {
    return true;
  }

  const prefix = statementPrefixBefore(sql, selectOffset);
  if (/\bINSERT\s+INTO\b/i.test(prefix)) {
    return true;
  }
  if (/\bCREATE\s+(?:TEMP\s+)?TABLE\b[\s\S]*\bAS\s*\(\s*$/i.test(prefix)) {
    return true;
  }
  if (/\bCURSOR\s+FOR\s*$/i.test(prefix)) {
    return true;
  }
  if (/\bWITH\b[\s\S]*\bAS\s*\(\s*$/i.test(prefix)) {
    return true;
  }
  return false;
}

/**
 * Tokens that participate in NZPLSQL block/CASE nesting.
 *
 * `END IF`, `END LOOP`, `END CASE`, `END TRANSACTION`, `END WORK`,
 * `BEGIN TRANSACTION` and `BEGIN WORK` are matched as a single token so they
 * never close a plain `BEGIN … END` block. `BEGIN_PROC`/`END_PROC` do not match
 * `\bBEGIN\b`/`\bEND\b` because `_` is a word character.
 */
const PROCEDURAL_BLOCK_TOKEN_PATTERN =
  /\bEND\s+(?:IF|LOOP|CASE|TRANSACTION|WORK)\b|\bBEGIN\s+(?:TRANSACTION|WORK)\b|\bBEGIN\b|\bEND\b|\bCASE\b/gi;

export interface ProceduralBlockBalance {
  begins: number;
  ends: number;
  /** CASE expressions still open at the end of the scanned text. */
  unmatchedCases: number;
}

/**
 * Count procedural `BEGIN … END` blocks against SQL `CASE … END` expressions.
 *
 * Netezza has no `CASE` *statement* (live-verified), so every `CASE` token opens
 * an expression that a bare `END` closes. A bare `END` therefore closes the
 * innermost open CASE before it can close a `BEGIN` block.
 *
 * Callers must pass sanitized text (comments and string literals removed).
 */
export function measureProceduralBlocks(body: string): ProceduralBlockBalance {
  let begins = 0;
  let ends = 0;
  let unmatchedCases = 0;

  // A CASE expression cannot span a statement terminator, so CASE depth is
  // resolved per statement. Without this, a missing CASE END would silently
  // consume the next block's END and hide the real imbalance. The input is
  // sanitized, so a plain split cannot cut through a string or comment.
  for (const statement of body.split(";")) {
    let openCases = 0;
    for (const match of statement.matchAll(
      new RegExp(PROCEDURAL_BLOCK_TOKEN_PATTERN.source, "gi"),
    )) {
      const token = match[0].toUpperCase().replace(/\s+/g, " ");
      if (token === "CASE") {
        openCases += 1;
        continue;
      }
      if (token === "BEGIN") {
        begins += 1;
        continue;
      }
      if (token.startsWith("END ")) {
        if (token === "END CASE" && openCases > 0) {
          openCases -= 1;
        }
        continue;
      }
      // Bare END: close the innermost CASE expression first; only a block
      // terminator when no CASE is open.
      if (openCases > 0) {
        openCases -= 1;
        continue;
      }
      ends += 1;
    }
    unmatchedCases += openCases;
  }

  return { begins, ends, unmatchedCases };
}

export { shouldUseProcedureRegexFallback } from "./procedureParseGate";

export const CST_MIGRATED_PROCEDURE_RULE_IDS = new Set([
  "NZP004",
  "NZP005",
  "NZP006",
  "NZP008",
  "NZP011",
  "NZP013",
  "NZP017",
  "NZP022",
  "NZP024",
]);

export function isCstMigratedProcedureRule(ruleId: string): boolean {
  return CST_MIGRATED_PROCEDURE_RULE_IDS.has(ruleId);
}

/** Skip regex NZP checks superseded by Chevrotain CST when parse succeeds. */
export function shouldSkipCstMigratedProcedureRule(
  sql: string,
  ruleId: string,
): boolean {
  return (
    isCstMigratedProcedureRule(ruleId) && !shouldUseProcedureRegexFallback(sql)
  );
}
