import type { DatabaseSqlLintIssue, DatabaseSqlQualityRule } from "@justybase/contracts";
import { NetezzaSqlSemanticValidator } from "../validation/semanticValidator";
import type { ValidationError } from "../validation/types";
import {
  netezzaProcedureQualityRules,
  netezzaSqlQualityRules,
  parserOwnedNetezzaQualityRuleIds,
} from "./rules";
import type {
  QualityAnalyzeOptions,
  QualityResult,
  QualitySeverity,
  QualitySeverityConfig,
  QualityValidationEngine,
  QualityValidationResultShape,
} from "./types";

const PARSER_RULE_ID_PATTERN = /^(?:SQL|PAR|LEX|PARW)\d+$/i;
const PARSER_TO_QUALITY_RULE_ID = new Map<string, string>([
  ["SQL043", "NZ002"], ["SQL044", "NZ003"], ["SQL051", "NZ004"],
  ["SQL052", "NZ010"], ["SQL053", "NZ016"], ["PAR005", "NZ019"],
  ["PAR002", "NZ021"], ["SQL042", "NZ022"], ["SQL045", "NZ011"],
  ["SQL046", "NZ012"], ["SQL048", "NZ023"],
  ["SQL037", "NZP011"], ["SQL038", "NZP024"],
  ["SQL039", "NZP008"], ["SQL040", "NZP022"],
]);

export function getQualityRuleIdForParserCode(code: string): string | undefined {
  return PARSER_TO_QUALITY_RULE_ID.get(code);
}

export function isParserDiagnosticRuleId(ruleId: string): boolean {
  return PARSER_RULE_ID_PATTERN.test(ruleId);
}

export function parseQualitySeverity(
  severity: QualitySeverityConfig,
): QualitySeverity | null {
  switch (severity) {
    case "error": return 0;
    case "warning": return 1;
    case "information": return 2;
    case "hint": return 3;
    case "off": return null;
  }
}

export class QualityEngineCore<
  TResult extends QualityValidationResultShape = ReturnType<NetezzaSqlSemanticValidator["validate"]>,
> {
  public constructor(
    private readonly validator: QualityValidationEngine<TResult>,
    private readonly rules: readonly DatabaseSqlQualityRule[] = [
      ...netezzaSqlQualityRules,
      ...netezzaProcedureQualityRules,
    ],
  ) {}

  public analyze(
    sql: string,
    rulesConfig: Record<string, QualitySeverityConfig> = {},
    includeOnDemandRules = false,
  ): QualityResult<TResult> {
    return this.analyzeWithOptions(sql, {
      rulesConfig,
      includeOnDemandRules,
      includeParserDiagnostics: true,
    });
  }

  public analyzeQualityRulesOnly(
    sql: string,
    rulesConfig: Record<string, QualitySeverityConfig> = {},
    includeOnDemandRules = false,
  ): QualityResult<TResult> {
    return this.analyzeWithOptions(sql, {
      rulesConfig,
      includeOnDemandRules,
      includeParserDiagnostics: false,
    });
  }

  public analyzeWithOptions(
    sql: string,
    options: QualityAnalyzeOptions<TResult> = {},
  ): QualityResult<TResult> {
    const includeParserDiagnostics = options.includeParserDiagnostics ?? true;
    const parserResult = includeParserDiagnostics
      ? options.parserResult ?? this.validator.validate(sql)
      : options.parserResult ?? this.validator.validate("");
    const parserIssues = includeParserDiagnostics
      ? [...parserResult.errors, ...parserResult.warnings]
        .filter((diagnostic) => this.isParserDiagnosticEnabled(diagnostic, options.rulesConfig ?? {}))
        .map((diagnostic) => this.toLintIssue(diagnostic))
      : [];
    const includeProcedureRules = /\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\b/i.test(sql);
    const qualityIssues = this.rules
      .filter((rule) => !parserOwnedNetezzaQualityRuleIds.has(rule.id))
      .filter((rule) => includeProcedureRules || !rule.id.startsWith("NZP"))
      .filter((rule) => options.includeOnDemandRules || !rule.onDemandOnly)
      .flatMap((rule) => {
        const configured = options.rulesConfig?.[rule.id];
        if (configured === "off") return [];
        const severity = configured ? parseQualitySeverity(configured) : rule.defaultSeverity;
        if (severity === null) return [];
        return rule.check(sql).map((candidate) => ({ ...candidate, severity }));
      });

    return {
      parserResult,
      issues: [...parserIssues, ...qualityIssues].sort(compareIssues),
    };
  }

  private isParserDiagnosticEnabled(
    diagnostic: ValidationError,
    rulesConfig: Record<string, QualitySeverityConfig>,
  ): boolean {
    const ruleId = getQualityRuleIdForParserCode(diagnostic.code);
    return !ruleId || rulesConfig[ruleId] !== "off";
  }

  private toLintIssue(diagnostic: ValidationError): DatabaseSqlLintIssue {
    const span = diagnostic.position.endLine === diagnostic.position.startLine
      ? Math.max(1, diagnostic.position.endColumn - diagnostic.position.startColumn)
      : 1;
    return {
      ruleId: diagnostic.code,
      message: `${diagnostic.code}: ${diagnostic.message}`,
      severity: diagnostic.severity === "error"
        ? 0
        : diagnostic.severity === "warning"
          ? 1
          : diagnostic.severity === "information"
            ? 2
            : 3,
      startOffset: diagnostic.position.offset,
      endOffset: diagnostic.position.offset + span,
      suggestedFix: diagnostic.suggestedFix,
    };
  }
}

function compareIssues(left: DatabaseSqlLintIssue, right: DatabaseSqlLintIssue): number {
  if (left.startOffset !== right.startOffset) return left.startOffset - right.startOffset;
  if (left.endOffset !== right.endOffset) return left.endOffset - right.endOffset;
  return left.ruleId.localeCompare(right.ruleId);
}

export function createNetezzaQualityEngine(
  validator: NetezzaSqlSemanticValidator = new NetezzaSqlSemanticValidator(),
): QualityEngineCore<ReturnType<NetezzaSqlSemanticValidator["validate"]>> {
  return new QualityEngineCore(validator);
}
