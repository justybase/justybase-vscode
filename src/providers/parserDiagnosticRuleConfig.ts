import type { RuleSeverityConfig } from "./linterRules";
import { parseSeverity } from "./linterRules";
import { getQualityRuleIdForParserCode } from "./qualityRuleRegistry";

/**
 * Returns false when a parser-owned quality rule (e.g. NZ023 → SQL048) is set to "off".
 */
export function isParserDiagnosticEnabled(
  parserCode: string,
  rulesConfig: Record<string, RuleSeverityConfig>,
): boolean {
  const qualityRuleId = getQualityRuleIdForParserCode(parserCode);
  if (!qualityRuleId) {
    return true;
  }
  const configured = rulesConfig[qualityRuleId];
  if (!configured) {
    return true;
  }
  return parseSeverity(configured) !== null;
}
