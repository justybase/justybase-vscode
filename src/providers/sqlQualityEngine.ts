import * as vscode from "vscode";
import { getDatabaseSqlAuthoring } from "../core/connectionFactory";
import { SqlValidator } from "../sqlParser";
import type { ValidationError, ValidationResult } from "../sqlParser";
import type {
  DocumentParseRequest,
  DocumentParseSession,
} from "../sqlParser/documentParseSession";
import type { StatementIndex } from "../sqlParser/statementIndex";
import { DocumentValidationSession } from "../sqlParser/documentValidationSession";
import {
  beginProcedureRuleEvaluation,
  endProcedureRuleEvaluation,
  isProcedureSql,
  warmProcedureParseGate,
} from "../sqlParser/procedure/procedureParseGate";
import {
  LintIssue,
  LintRule,
  RuleSeverityConfig,
  parseSeverity,
} from "./linterRules";
import { isParserOwnedQualityRule } from "./qualityRuleRegistry";
import { isParserDiagnosticEnabled } from "./parserDiagnosticRuleConfig";

const EMPTY_VALIDATION_SCOPE: ValidationResult["scope"] = {
  tables: new Map(),
  ctes: new Map(),
  level: 0,
};

let _unifiedSqlQualityRules: readonly LintRule[] | undefined;

/**
 * Get the unified SQL quality rules for the default database dialect.
 * Uses lazy initialization to ensure dialects are registered before access.
 */
export function getUnifiedSqlQualityRules(): readonly LintRule[] {
  if (!_unifiedSqlQualityRules) {
    _unifiedSqlQualityRules = getDatabaseSqlAuthoring().qualityRules;
  }
  return _unifiedSqlQualityRules;
}

/**
 * @deprecated Use getUnifiedSqlQualityRules() instead for lazy initialization.
 */
export const unifiedSqlQualityRules: readonly LintRule[] = [];

export interface SqlQualityResult {
  parserResult: ValidationResult;
  issues: LintIssue[];
}

export interface SqlQualityAnalyzeOptions {
  rulesConfig?: Record<string, RuleSeverityConfig>;
  includeOnDemandRules?: boolean;
  /** When false, only NZ/NZP quality rules run (parser diagnostics come from LSP). */
  includeParserDiagnostics?: boolean;
  /** When true, skip eager procedure parse warm-up (LSP already validates procedures). */
  skipProcedureParseWarmup?: boolean;
  parseSession?: DocumentParseSession;
  parseRequest?: DocumentParseRequest;
  /** When provided, use incremental (per-statement) validation instead of full CST walk. */
  incrementalValidation?: {
    statementIndex: StatementIndex;
    dirtyIndices: readonly number[];
    cachedDiagnostics: Map<number, ValidationError[]>;
  };
  /** Document validation session for persisting per-statement diagnostic caches. */
  validationSession?: DocumentValidationSession;
  /** Document URI for per-statement diagnostic cache key. */
  documentUri?: string;
}

const PARSER_RULE_ID_PATTERN = /^(SQL|PAR|LEX|PARW)\d+$/i;

function isProcedureQualityRule(ruleId: string): boolean {
  return ruleId.startsWith("NZP");
}

export function isParserDiagnosticRuleId(ruleId: string): boolean {
  return PARSER_RULE_ID_PATTERN.test(ruleId);
}

export class SqlQualityEngine {
  constructor(
    private readonly validator: SqlValidator,
    private readonly rules: readonly LintRule[] = getUnifiedSqlQualityRules(),
  ) {}

  public analyze(
    sql: string,
    rulesConfig: Record<string, RuleSeverityConfig> = {},
    includeOnDemandRules: boolean = false,
  ): SqlQualityResult {
    return this.analyzeWithOptions(sql, {
      rulesConfig,
      includeOnDemandRules,
      includeParserDiagnostics: true,
    });
  }

  /** Quality-rules-only analysis for extension linter (LSP owns SQL/PAR diagnostics). */
  public analyzeQualityRulesOnly(
    sql: string,
    rulesConfig: Record<string, RuleSeverityConfig> = {},
    includeOnDemandRules: boolean = false,
  ): SqlQualityResult {
    return this.analyzeWithOptions(sql, {
      rulesConfig,
      includeOnDemandRules,
      includeParserDiagnostics: false,
    });
  }

  public analyzeWithOptions(
    sql: string,
    options: SqlQualityAnalyzeOptions = {},
  ): SqlQualityResult {
    const {
      rulesConfig = {},
      includeOnDemandRules = false,
      includeParserDiagnostics = true,
      parseSession,
      parseRequest,
      skipProcedureParseWarmup = false,
    } = options;

    const parserResult = includeParserDiagnostics
      ? this.validateWithOptionalParseSession(sql, options)
      : {
          valid: true,
          errors: [],
          warnings: [],
          scope: EMPTY_VALIDATION_SCOPE,
        };
    const parserIssues = includeParserDiagnostics
      ? [...parserResult.errors, ...parserResult.warnings]
          .filter((issue) =>
            isParserDiagnosticEnabled(issue.code, rulesConfig),
          )
          .map((issue) => this.toLintIssue(issue))
      : [];
    const ruleIssues: LintIssue[] = [];
    const includeProcedureRules = isProcedureSql(sql);

    if (includeProcedureRules && !skipProcedureParseWarmup) {
      beginProcedureRuleEvaluation();
      warmProcedureParseGate(sql, parseSession, parseRequest);
    } else if (includeProcedureRules) {
      beginProcedureRuleEvaluation();
    }

    try {
      for (const rule of this.rules) {
        if (!includeProcedureRules && isProcedureQualityRule(rule.id)) {
          continue;
        }

        if (isParserOwnedQualityRule(rule.id)) {
          continue;
        }

        if (!includeOnDemandRules && rule.onDemandOnly) {
          continue;
        }

        const configuredSeverity = rulesConfig[rule.id];
        const severityOverride = configuredSeverity
          ? parseSeverity(configuredSeverity)
          : undefined;
        if (severityOverride === null) {
          continue;
        }

        const issuesForRule = rule.check(sql).map((issue) => ({
          ...issue,
          severity: severityOverride ?? issue.severity,
        }));
        ruleIssues.push(...issuesForRule);
      }
    } finally {
      if (includeProcedureRules) {
        endProcedureRuleEvaluation();
      }
    }

    const issues = [...parserIssues, ...ruleIssues].sort((a, b) => {
      if (a.startOffset !== b.startOffset) {
        return a.startOffset - b.startOffset;
      }

      if (a.endOffset !== b.endOffset) {
        return a.endOffset - b.endOffset;
      }

      return a.ruleId.localeCompare(b.ruleId);
    });

    return {
      parserResult,
      issues,
    };
  }

  private validateWithOptionalParseSession(
    sql: string,
    options: SqlQualityAnalyzeOptions = {},
  ): ValidationResult {
    const {
      parseSession,
      parseRequest,
      incrementalValidation,
      validationSession,
      documentUri,
    } = options;

    if (incrementalValidation && validationSession && documentUri) {
      const result = this.validator.validateIncrementalFromStatements(
        sql,
        incrementalValidation.statementIndex.statements,
        incrementalValidation.dirtyIndices,
        incrementalValidation.cachedDiagnostics,
      );
      const allDiagnostics = [...result.errors, ...result.warnings];
      const dirty = new Set(incrementalValidation.dirtyIndices);
      for (const stmt of incrementalValidation.statementIndex.statements) {
        if (!dirty.has(stmt.index)) {
          continue;
        }
        const stmtDiags = allDiagnostics.filter(
          (d) =>
            d.position.offset >= stmt.startOffset &&
            d.position.offset <= stmt.endOffset,
        );
        validationSession.storeStatementDiagnostics(documentUri, stmt, stmtDiags);
      }
      // Note: validationSession.commitDocumentIndex is called by the caller
      // (SqlLinterProvider) so it advances unconditionally on every lint pass,
      // not just incremental ones.
      return result;
    }

    if (incrementalValidation) {
      return this.validator.validateIncrementalFromStatements(
        sql,
        incrementalValidation.statementIndex.statements,
        incrementalValidation.dirtyIndices,
        incrementalValidation.cachedDiagnostics,
      );
    }

    if (!parseSession || !parseRequest) {
      return this.validator.validate(sql);
    }

    const parseResult = parseSession.getParseResult({
      ...parseRequest,
      sql,
    });
    return this.validator.validateFromParseResult(sql, parseResult);
  }

  private toLintIssue(issue: ValidationError): LintIssue {
    const lineLength = issue.position.endColumn - issue.position.startColumn;
    const span =
      issue.position.endLine === issue.position.startLine
        ? Math.max(1, lineLength)
        : Math.max(1, lineLength);

    return {
      ruleId: issue.code,
      message: `${issue.code}: ${issue.message}`,
      severity: this.toDiagnosticSeverity(issue.severity),
      startOffset: issue.position.offset,
      endOffset: issue.position.offset + span,
      suggestedFix: issue.suggestedFix,
    };
  }

  private toDiagnosticSeverity(
    severity: ValidationError["severity"],
  ): vscode.DiagnosticSeverity {
    switch (severity) {
      case "error":
        return vscode.DiagnosticSeverity.Error;
      case "warning":
        return vscode.DiagnosticSeverity.Warning;
      case "information":
        return vscode.DiagnosticSeverity.Information;
      case "hint":
        return vscode.DiagnosticSeverity.Hint;
      default:
        return vscode.DiagnosticSeverity.Warning;
    }
  }
}
