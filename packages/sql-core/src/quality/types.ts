import type {
  DatabaseSqlLintIssue,
  DatabaseSqlQualityRule,
} from "@justybase/contracts";
import type {
  NetezzaSqlSemanticValidationResult,
} from "../validation/semanticValidator";
import type { ValidationError } from "../validation/types";

export type QualitySeverity = 0 | 1 | 2 | 3;
export type QualitySeverityConfig = "error" | "warning" | "information" | "hint" | "off";

export interface QualityValidationResultShape {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

export interface QualityResult<
  TResult extends QualityValidationResultShape = NetezzaSqlSemanticValidationResult,
> {
  parserResult: TResult;
  issues: DatabaseSqlLintIssue[];
}

export interface QualityAnalyzeOptions<
  TResult extends QualityValidationResultShape = NetezzaSqlSemanticValidationResult,
> {
  rulesConfig?: Record<string, QualitySeverityConfig>;
  includeOnDemandRules?: boolean;
  includeParserDiagnostics?: boolean;
  /** A caller may provide a parse/validation result obtained from a session. */
  parserResult?: TResult;
}

export interface QualityValidationEngine<
  TResult extends QualityValidationResultShape = NetezzaSqlSemanticValidationResult,
> {
  validate(sql: string): TResult;
  validateIncrementalFromStatements?(
    fullSql: string,
    statements: readonly {
      index: number;
      startOffset: number;
      endOffset: number;
      sql: string;
    }[],
    dirtyIndices: readonly number[],
    cachedDiagnostics: Map<number, ValidationError[]>,
  ): TResult;
}

export type NetezzaSqlQualityRule = DatabaseSqlQualityRule;
