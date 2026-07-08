export type DiagnosticOwner = "parser" | "quality" | "procedure";
export type DiagnosticQuickFixSafety = "safe" | "unsafe" | "none";

export interface DiagnosticOwnership {
  owner: DiagnosticOwner;
  parserCode?: string;
  quickFix: DiagnosticQuickFixSafety;
}

/**
 * Quality rules whose diagnostics are owned by the SQL parser / LSP.
 * They stay exported for tests/settings but are excluded from active NZ rules.
 */
export const DIAGNOSTIC_OWNERSHIP: Record<string, DiagnosticOwnership> = {
  NZ002: { owner: "parser", parserCode: "SQL043", quickFix: "unsafe" },
  NZ003: { owner: "parser", parserCode: "SQL044", quickFix: "unsafe" },
  NZ011: { owner: "parser", parserCode: "SQL045", quickFix: "unsafe" },
  NZ012: { owner: "parser", parserCode: "SQL046", quickFix: "safe" },
  NZ019: { owner: "parser", parserCode: "PAR005", quickFix: "none" },
  NZ021: { owner: "parser", parserCode: "PAR002", quickFix: "safe" },
  NZ022: { owner: "parser", parserCode: "SQL042", quickFix: "none" },
  NZ023: { owner: "parser", parserCode: "SQL048", quickFix: "safe" },
};

export const PARSER_OWNED_QUALITY_RULE_IDS = new Set<string>(
  Object.entries(DIAGNOSTIC_OWNERSHIP)
    .filter(([, ownership]) => ownership.owner === "parser")
    .map(([ruleId]) => ruleId),
);

export function isParserOwnedQualityRule(ruleId: string): boolean {
  return PARSER_OWNED_QUALITY_RULE_IDS.has(ruleId);
}

export function getDiagnosticOwnership(
  ruleId: string,
): DiagnosticOwnership | undefined {
  return DIAGNOSTIC_OWNERSHIP[ruleId];
}

const PARSER_CODE_TO_QUALITY_RULE_ID = new Map<string, string>(
  Object.entries(DIAGNOSTIC_OWNERSHIP)
    .filter(([, ownership]) => ownership.parserCode)
    .map(([ruleId, ownership]) => [ownership.parserCode!, ruleId]),
);

/** Maps parser diagnostic codes (e.g. SQL048) to quality rule ids (e.g. NZ023). */
export function getQualityRuleIdForParserCode(
  parserCode: string,
): string | undefined {
  return PARSER_CODE_TO_QUALITY_RULE_ID.get(parserCode);
}
