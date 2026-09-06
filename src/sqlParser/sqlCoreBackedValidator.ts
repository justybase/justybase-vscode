import {
  NetezzaSqlValidationCore,
  parseNetezzaSqlStatements,
  type NetezzaSqlValidationOptions,
  type NetezzaSqlParseResult,
  type SqlCoreDiagnostic,
  type SqlCoreValidationResult,
} from "@justybase/sql-core/validation";
import type { DatabaseSqlValidationProfile } from "../sql/authoring/types";
import type { SchemaProvider } from "./schemaProvider";
import {
  SqlValidator,
  type ScopeSeed,
} from "./validator";
import { isIgnorableTrailingDotParserError } from "./parserErrorUtils";
import type {
  SqlStatementsParseResult,
} from "./parsingRuntime";
import type {
  Scope,
  ValidationError,
  ValidationResult,
} from "./types";
import type { StatementBoundary } from "./statementIndex";

/**
 * Compatibility validator used during the first strangler migration step.
 *
 * The public validator shape remains the existing desktop shape, while the
 * parser call crosses the platform-neutral sql-core boundary. Semantic
 * visitor validation is deliberately kept behind the desktop compatibility
 * facade until its own dependency closure is extracted; this keeps the first
 * parser move reversible and makes parity failures attributable to parsing.
 */
export class SqlCoreBackedValidator extends SqlValidator {
  private readonly validationCore: NetezzaSqlValidationCore;
  private readonly validationOptions: NetezzaSqlValidationOptions;

  public constructor(
    schemaProvider?: SchemaProvider,
    validationProfile?: DatabaseSqlValidationProfile,
  ) {
    super(schemaProvider, validationProfile);
    this.validationOptions = {};
    this.validationCore = new NetezzaSqlValidationCore({
      parse: (sql) =>
        parseNetezzaSqlStatements({
          sql,
          ignoreParserError: isIgnorableTrailingDotParserError,
        }),
      validate: (sql) => {
        if (/^\s*;+\s*$/.test(sql)) {
          return this.toCoreResult(this.validateLegacy(sql));
        }
        const parseResult = parseNetezzaSqlStatements({
          sql,
          ignoreParserError: isIgnorableTrailingDotParserError,
        });
        return this.toCoreResult(
          this.validateLegacyFromParseResult(
            sql,
            parseResult as unknown as SqlStatementsParseResult,
          ),
        );
      },
      validateParsed: (sql, parseResult) =>
        this.toCoreResult(
          this.validateLegacyFromParseResult(
            sql,
            parseResult as SqlStatementsParseResult,
          ),
        ),
    });
  }

  public override validate(sql: string): ValidationResult {
    return this.fromCoreResult(this.validationCore.validate(sql, this.validationOptions));
  }

  public override validateFromParseResult(
    sql: string,
    parseResult: SqlStatementsParseResult,
  ): ValidationResult {
    return this.fromCoreResult(
      this.validationCore.validateParsed(
        sql,
        parseResult,
        this.validationOptions,
      ),
    );
  }

  /** Keep incremental validation state and cache semantics unchanged. */
  public override validateIncrementalFromStatements(
    fullSql: string,
    statements: readonly StatementBoundary[],
    dirtyIndices: readonly number[],
    cachedDiagnostics: Map<number, ValidationError[]>,
  ): ValidationResult {
    return super.validateIncrementalFromStatements(
      fullSql,
      statements,
      dirtyIndices,
      cachedDiagnostics,
    );
  }

  /** Keep the existing statement-scope API available to later migration steps. */
  public override validateIncremental(
    sql: string,
    parseResult: SqlStatementsParseResult,
    dirtyIndices: number[],
    cachedDiagnostics: Map<number, ValidationError[]>,
    scopeSeeds: Map<number, ScopeSeed> = new Map(),
  ): ValidationResult {
    return super.validateIncremental(
      sql,
      parseResult,
      dirtyIndices,
      cachedDiagnostics,
      scopeSeeds,
    );
  }

  private validateLegacy(sql: string): ValidationResult {
    return super.validate(sql);
  }

  private validateLegacyFromParseResult(
    sql: string,
    parseResult: SqlStatementsParseResult | NetezzaSqlParseResult,
  ): ValidationResult {
    return super.validateFromParseResult(
      sql,
      parseResult as unknown as SqlStatementsParseResult,
    );
  }

  private toCoreResult(result: ValidationResult): SqlCoreValidationResult {
    return {
      valid: result.valid,
      errors: result.errors.map((issue) => this.toCoreDiagnostic(issue)),
      warnings: result.warnings.map((issue) => this.toCoreDiagnostic(issue)),
      scope: result.scope,
    };
  }

  private toCoreDiagnostic(issue: ValidationError): SqlCoreDiagnostic {
    return {
      message: issue.message,
      severity: issue.severity,
      code: issue.code,
      position: { ...issue.position },
      suggestedFix: issue.suggestedFix,
    };
  }

  private fromCoreResult(result: SqlCoreValidationResult): ValidationResult {
    return {
      valid: result.valid,
      errors: result.errors.map((issue) => this.fromCoreDiagnostic(issue)),
      warnings: result.warnings.map((issue) => this.fromCoreDiagnostic(issue)),
      scope: (result.scope ?? { tables: new Map(), ctes: new Map(), level: 0 }) as Scope,
    };
  }

  private fromCoreDiagnostic(issue: SqlCoreDiagnostic): ValidationError {
    return {
      message: issue.message,
      severity: issue.severity,
      code: issue.code,
      position: { ...issue.position },
      suggestedFix: issue.suggestedFix,
    };
  }
}
