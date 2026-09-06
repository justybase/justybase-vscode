import type { DatabaseSqlValidationProfile } from "@justybase/contracts";
export {
  NETEZZA_SQL_PARSING_RUNTIME,
  parseNetezzaSqlStatements,
  sanitizeNetezzaSql,
  type NetezzaSqlLexResult,
  type NetezzaSqlParseOptions,
  type NetezzaSqlParseResult,
  type NetezzaSqlParsingRuntime,
} from "./parser/runtime";

/** The diagnostic severities shared by the SQL validation boundary. */
export type SqlCoreDiagnosticSeverity =
  | "error"
  | "warning"
  | "information"
  | "hint";

/** A source position used by the validation boundary (line/column are 1-based). */
export interface SqlCorePosition {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  offset: number;
}

/** A platform-neutral validation diagnostic. */
export interface SqlCoreDiagnostic {
  message: string;
  severity: SqlCoreDiagnosticSeverity;
  code: string;
  position: SqlCorePosition;
  suggestedFix?: string;
}

export interface SqlCoreColumnInfo {
  name: string;
  alias?: string;
  dataType?: string;
  position?: SqlCorePosition;
  isDistributionKey?: boolean;
}

export interface SqlCoreTableInfo {
  name: string;
  alias?: string;
  schema?: string;
  database?: string;
  isCte: boolean;
  isTempTable: boolean;
  columns: SqlCoreColumnInfo[];
  position?: SqlCorePosition;
}

export interface SqlCoreTableQualificationRequest {
  database?: string;
  schema?: string;
  name: string;
  documentUri?: string;
  databaseKind?: string;
}

export interface SqlCoreQualificationProposal {
  database?: string;
  schema?: string;
  name: string;
  qualifiedText: string;
  isPreferred?: boolean;
}

/**
 * Portable schema access used by the future native validator implementation.
 * Desktop, API and test providers are adapted to this shape at their boundary.
 */
export interface SqlCoreSchemaProvider {
  getTable(
    database: string | undefined,
    schema: string | undefined,
    tableName: string,
  ): SqlCoreTableInfo | undefined;
  tableExists(
    database: string | undefined,
    schema: string | undefined,
    tableName: string,
  ): boolean;
  proposeTableQualification?(
    request: SqlCoreTableQualificationRequest,
  ): SqlCoreQualificationProposal[];
  canValidateUnqualifiedTableReferences?: boolean;
  getTablesInSchema?(database: string | undefined, schema: string): SqlCoreTableInfo[];
  getDatabases?(): string[] | undefined;
  getKnownFunctions?(): ReadonlySet<string> | undefined;
}

export interface NetezzaSqlValidationOptions {
  schemaProvider?: SqlCoreSchemaProvider;
  validationProfile?: DatabaseSqlValidationProfile;
}

export interface SqlCoreValidationResult {
  valid: boolean;
  errors: SqlCoreDiagnostic[];
  warnings: SqlCoreDiagnostic[];
  /** The scope is intentionally opaque until the metadata model is extracted. */
  scope?: unknown;
}

/**
 * Transitional validation backend seam.
 *
 * The parser and parser runtime are package-owned now. The semantic visitor is
 * still injected so desktop consumers can be switched and compared
 * independently before that validation dependency closure is extracted, without
 * changing the desktop/API-facing contract introduced here.
 */
export interface NetezzaSqlValidationBackend {
  parse?(sql: string, options: NetezzaSqlValidationOptions): unknown;
  validate(
    sql: string,
    options: NetezzaSqlValidationOptions,
  ): SqlCoreValidationResult;
  validateParsed?(
    sql: string,
    parseResult: unknown,
    options: NetezzaSqlValidationOptions,
  ): SqlCoreValidationResult;
}

/**
 * Platform-neutral orchestration boundary for Netezza SQL validation.
 *
 * No VS Code, Node runtime, driver or product adapter is reachable from this
 * module. The backend is deliberately injected during the strangler phase so
 * the old and new implementations can be compared in tests before extraction.
 */
export class NetezzaSqlValidationCore {
  public constructor(private readonly backend: NetezzaSqlValidationBackend) {}

  public parse(
    sql: string,
    options: NetezzaSqlValidationOptions = {},
  ): unknown {
    if (!this.backend.parse) {
      throw new Error(
        "The configured Netezza validation backend does not expose parsing yet.",
      );
    }
    return this.backend.parse(sql, options);
  }

  public validate(
    sql: string,
    options: NetezzaSqlValidationOptions = {},
  ): SqlCoreValidationResult {
    return this.backend.validate(sql, options);
  }

  public validateParsed(
    sql: string,
    parseResult: unknown,
    options: NetezzaSqlValidationOptions = {},
  ): SqlCoreValidationResult {
    return this.backend.validateParsed
      ? this.backend.validateParsed(sql, parseResult, options)
      : this.backend.validate(sql, options);
  }
}
