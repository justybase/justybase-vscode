import type { SqlStatementsParseResult } from "./parsingRuntime";
import type { SchemaProvider } from "./schemaProvider";
import type { ScopeSeed, ValidationError, ValidationResult } from "./types";
import type { StatementBoundary } from "./statementIndex";

/**
 * Minimal validation boundary shared by native Netezza and legacy dialects.
 * Dialect-specific helpers remain on their concrete validator classes.
 */
export interface SqlValidationService {
  validate(sql: string): ValidationResult;
  validateFromParseResult(
    sql: string,
    parseResult: SqlStatementsParseResult,
  ): ValidationResult;
  validateIncrementalFromStatements(
    fullSql: string,
    statements: readonly StatementBoundary[],
    dirtyIndices: readonly number[],
    cachedDiagnostics: Map<number, ValidationError[]>,
  ): ValidationResult;
  validateIncremental(
    sql: string,
    parseResult: SqlStatementsParseResult,
    dirtyIndices: readonly number[],
    cachedDiagnostics: Map<number, ValidationError[]>,
    scopeSeeds?: Map<number, ScopeSeed>,
  ): ValidationResult;
  setSchemaProvider(provider: SchemaProvider): void;
}
