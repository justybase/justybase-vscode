import { getDatabaseSqlAuthoring } from "../core/sqlAuthoringRegistry";
import {
  QualityEngineCore as SharedQualityEngineCore,
  type QualityResult as SharedQualityResult,
} from "@justybase/sql-core";
import type { SqlValidationService } from "./validationService";
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
} from "./procedure/procedureParseGate";
import type {
  LintIssue,
  LintRule,
  RuleSeverityConfig,
} from "../providers/linterRules";

let cachedUnifiedSqlQualityRules: readonly LintRule[] | undefined;

/**
 * Return the registered rules for the active desktop authoring profile.
 * Netezza's registration is an adapter over the platform-neutral sql-core
 * rules; other dialect packs may still provide their desktop rules here.
 */
export function getUnifiedSqlQualityRules(): readonly LintRule[] {
  if (!cachedUnifiedSqlQualityRules) {
    cachedUnifiedSqlQualityRules = getDatabaseSqlAuthoring().qualityRules;
  }
  return cachedUnifiedSqlQualityRules;
}

export interface SqlQualityResult {
  parserResult: ValidationResult;
  issues: LintIssue[];
}

export interface SqlQualityAnalyzeOptions {
  rulesConfig?: Record<string, RuleSeverityConfig>;
  includeOnDemandRules?: boolean;
  /** When false, only quality rules run; parser diagnostics come from LSP. */
  includeParserDiagnostics?: boolean;
  /** When true, skip eager procedure parse warm-up because LSP already parsed. */
  skipProcedureParseWarmup?: boolean;
  parseSession?: DocumentParseSession;
  parseRequest?: DocumentParseRequest;
  incrementalValidation?: {
    statementIndex: StatementIndex;
    dirtyIndices: readonly number[];
    cachedDiagnostics: Map<number, ValidationError[]>;
  };
  validationSession?: DocumentValidationSession;
  documentUri?: string;
}

const PARSER_RULE_ID_PATTERN = /^(SQL|PAR|LEX|PARW)\d+$/i;

function emptyValidationResult(): ValidationResult {
  return {
    valid: true,
    errors: [],
    warnings: [],
    scope: {
      tables: new Map(),
      ctes: new Map(),
      level: 0,
    },
  };
}

export function isParserDiagnosticRuleId(ruleId: string): boolean {
  return PARSER_RULE_ID_PATTERN.test(ruleId);
}

/**
 * Desktop adapter around the platform-neutral quality engine. The adapter is
 * responsible only for desktop parse-session orchestration and the legacy
 * ValidationResult shape. Rule ownership, severity, ordering and parser/
 * quality de-duplication live in @justybase/sql-core.
 */
export class QualityEngineCore {
  private readonly shared: SharedQualityEngineCore<ValidationResult>;

  public constructor(
    private readonly validator: SqlValidationService,
    rules: readonly LintRule[] = getUnifiedSqlQualityRules(),
  ) {
    this.shared = new SharedQualityEngineCore<ValidationResult>({
      validate: (sql) => this.validator.validate(sql),
    }, rules);
  }

  public analyze(
    sql: string,
    rulesConfig: Record<string, RuleSeverityConfig> = {},
    includeOnDemandRules = false,
  ): SqlQualityResult {
    return this.analyzeWithOptions(sql, {
      rulesConfig,
      includeOnDemandRules,
      includeParserDiagnostics: true,
    });
  }

  public analyzeQualityRulesOnly(
    sql: string,
    rulesConfig: Record<string, RuleSeverityConfig> = {},
    includeOnDemandRules = false,
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
    const includeParserDiagnostics = options.includeParserDiagnostics ?? true;
    const parserResult = includeParserDiagnostics
      ? this.validateWithOptionalParseSession(sql, options)
      : emptyValidationResult();

    const includeProcedureRules = isProcedureSql(sql);
    if (includeProcedureRules) {
      beginProcedureRuleEvaluation();
      if (!options.skipProcedureParseWarmup) {
        warmProcedureParseGate(sql, options.parseSession, options.parseRequest);
      }
    }

    try {
      const result: SharedQualityResult<ValidationResult> =
        this.shared.analyzeWithOptions(sql, {
          rulesConfig: options.rulesConfig,
          includeOnDemandRules: options.includeOnDemandRules,
          includeParserDiagnostics,
          parserResult,
        });
      return result;
    } finally {
      if (includeProcedureRules) {
        endProcedureRuleEvaluation();
      }
    }
  }

  private validateWithOptionalParseSession(
    sql: string,
    options: SqlQualityAnalyzeOptions,
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
      for (const statement of incrementalValidation.statementIndex.statements) {
        if (!dirty.has(statement.index)) continue;
        const statementDiagnostics = allDiagnostics.filter(
          (diagnostic) =>
            diagnostic.position.offset >= statement.startOffset &&
            diagnostic.position.offset <= statement.endOffset,
        );
        validationSession.storeStatementDiagnostics(
          documentUri,
          statement,
          statementDiagnostics,
        );
      }
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
}

/** @deprecated Use getUnifiedSqlQualityRules() for lazy initialization. */
export const unifiedSqlQualityRules: readonly LintRule[] = [];
