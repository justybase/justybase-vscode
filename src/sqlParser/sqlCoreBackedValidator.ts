import {
  NetezzaSqlSemanticValidator,
} from "@justybase/sql-core/validation";
import type { DatabaseSqlValidationProfile } from "../sql/authoring/types";
import type { SchemaProvider } from "./schemaProvider";
import type { ScopeSeed, ValidationError, ValidationResult } from "./types";
import type { SqlStatementsParseResult } from "./parsingRuntime";
import type { StatementBoundary } from "./statementIndex";
import type { SqlValidationService } from "./validationService";
import {
  toNetezzaParseResult,
  toNetezzaSchemaProvider,
  toNetezzaScopeSeeds,
  toNetezzaStatementBoundaries,
} from "./sqlCoreAdapter";

/**
 * Desktop-facing adapter for the native Netezza semantic validator.
 *
 * Incremental validation deliberately calls the same native backend as the
 * full-document path. The legacy validator remains available separately for
 * dialects that have not migrated yet.
 */
export class SqlCoreBackedValidator implements SqlValidationService {
  private readonly semanticValidator: NetezzaSqlSemanticValidator;

  public constructor(
    schemaProvider?: SchemaProvider,
    validationProfile?: DatabaseSqlValidationProfile,
  ) {
    this.semanticValidator = new NetezzaSqlSemanticValidator(
      toNetezzaSchemaProvider(schemaProvider),
      validationProfile,
    );
  }

  public validate(sql: string): ValidationResult {
    return this.semanticValidator.validate(sql);
  }

  public validateFromParseResult(
    sql: string,
    parseResult: SqlStatementsParseResult,
  ): ValidationResult {
    return this.semanticValidator.validateFromParseResult(
      sql,
      toNetezzaParseResult(parseResult),
    );
  }

  public setSchemaProvider(provider: SchemaProvider): void {
    this.semanticValidator.setSchemaProvider(toNetezzaSchemaProvider(provider));
  }

  public validateIncrementalFromStatements(
    fullSql: string,
    statements: readonly StatementBoundary[],
    dirtyIndices: readonly number[],
    cachedDiagnostics: Map<number, ValidationError[]>,
  ): ValidationResult {
    return this.semanticValidator.validateIncrementalFromStatements(
      fullSql,
      toNetezzaStatementBoundaries(statements),
      dirtyIndices,
      cachedDiagnostics,
    );
  }

  public validateIncremental(
    sql: string,
    parseResult: SqlStatementsParseResult,
    dirtyIndices: readonly number[],
    cachedDiagnostics: Map<number, ValidationError[]>,
    scopeSeeds: Map<number, ScopeSeed> = new Map(),
  ): ValidationResult {
    return this.semanticValidator.validateIncremental(
      sql,
      toNetezzaParseResult(parseResult),
      dirtyIndices,
      cachedDiagnostics,
      toNetezzaScopeSeeds(scopeSeeds),
    );
  }
}
