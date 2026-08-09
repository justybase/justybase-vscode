import * as vscode from "vscode";
import { SqlValidator } from "../sqlParser";
import type { ValidationError } from "../sqlParser";
import {
  QualityEngineCore,
  SqlQualityAnalyzeOptions,
  SqlQualityResult,
  getUnifiedSqlQualityRules,
} from "../sqlParser/qualityEngineCore";
import { LintRule } from "./linterRules";
/**
 * Thin vscode wrapper around the pure QualityEngineCore. The core logic (rule
 * iteration, procedure gate, sorting, suggestedFix extraction) lives in the
 * vscode-free `src/sqlParser/qualityEngineCore.ts` so both the desktop
 * extension and the web LSP core share a single implementation.
 *
 * The only vscode dependency here is mapping the numeric LintSeverity back to
 * `vscode.DiagnosticSeverity` for the desktop diagnostic collection.
 */
export class SqlQualityEngine {
  private readonly core: QualityEngineCore;

  constructor(
    validator: SqlValidator,
    rules: readonly LintRule[] = getUnifiedSqlQualityRules(),
  ) {
    this.core = new QualityEngineCore(validator, rules);
  }

  public analyze(
    sql: string,
    rulesConfig: Record<string, import("./linterRules").RuleSeverityConfig> = {},
    includeOnDemandRules: boolean = false,
  ): SqlQualityResult {
    return this.mapResult(this.core.analyze(sql, rulesConfig, includeOnDemandRules));
  }

  /** Quality-rules-only analysis for extension linter (LSP owns SQL/PAR diagnostics). */
  public analyzeQualityRulesOnly(
    sql: string,
    rulesConfig: Record<string, import("./linterRules").RuleSeverityConfig> = {},
    includeOnDemandRules: boolean = false,
  ): SqlQualityResult {
    return this.mapResult(
      this.core.analyzeQualityRulesOnly(sql, rulesConfig, includeOnDemandRules),
    );
  }

  public analyzeWithOptions(
    sql: string,
    options: SqlQualityAnalyzeOptions = {},
  ): SqlQualityResult {
    return this.mapResult(this.core.analyzeWithOptions(sql, options));
  }

  private mapResult(result: SqlQualityResult): SqlQualityResult {
    return {
      parserResult: result.parserResult,
      issues: result.issues.map((issue) => ({
        ...issue,
        severity: this.toDiagnosticSeverity(issue.severity),
      })),
    };
  }

  private toDiagnosticSeverity(
    severity: number,
  ): vscode.DiagnosticSeverity {
    switch (severity) {
      case 0:
        return vscode.DiagnosticSeverity.Error;
      case 1:
        return vscode.DiagnosticSeverity.Warning;
      case 2:
        return vscode.DiagnosticSeverity.Information;
      case 3:
        return vscode.DiagnosticSeverity.Hint;
      default:
        return vscode.DiagnosticSeverity.Warning;
    }
  }
}

export { getUnifiedSqlQualityRules };

/**
 * @deprecated Use getUnifiedSqlQualityRules() instead for lazy initialization.
 */
export const unifiedSqlQualityRules: readonly LintRule[] = [];

export function isParserDiagnosticRuleId(ruleId: string): boolean {
  return PARSER_RULE_ID_PATTERN.test(ruleId);
}

const PARSER_RULE_ID_PATTERN = /^(SQL|PAR|LEX|PARW)\d+$/i;

// Re-export the vscode-free result types so existing callers keep compiling.
export type {
  SqlQualityResult,
  SqlQualityAnalyzeOptions,
} from "../sqlParser/qualityEngineCore";
export type { ValidationError };
