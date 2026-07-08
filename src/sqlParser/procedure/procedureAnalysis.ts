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

export const PROCEDURAL_END_PATTERN =
  /\bEND\b(?!\s*(_PROC|IF|LOOP|CASE|TRANSACTION|WORK)\b)(?!\s*(AS|,|\)))/gi;

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
