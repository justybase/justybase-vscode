import type { DatabaseSqlValidationProfile } from "@justybase/contracts";

export type SqlCoreDiagnosticSeverity = "error" | "warning" | "information" | "hint";
export interface SqlCorePosition {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  offset: number;
}
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
export interface SqlCoreSchemaProvider {
  getTable(database: string | undefined, schema: string | undefined, tableName: string): SqlCoreTableInfo | undefined;
  tableExists(database: string | undefined, schema: string | undefined, tableName: string): boolean;
  proposeTableQualification?(request: SqlCoreTableQualificationRequest): SqlCoreQualificationProposal[];
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
  scope?: unknown;
}
export interface NetezzaSqlValidationBackend {
  parse?(sql: string, options: NetezzaSqlValidationOptions): unknown;
  validate(sql: string, options: NetezzaSqlValidationOptions): SqlCoreValidationResult;
  validateParsed?(sql: string, parseResult: unknown, options: NetezzaSqlValidationOptions): SqlCoreValidationResult;
}
export declare class NetezzaSqlValidationCore {
  private readonly backend;
  constructor(backend: NetezzaSqlValidationBackend);
  parse(sql: string, options?: NetezzaSqlValidationOptions): unknown;
  validate(sql: string, options?: NetezzaSqlValidationOptions): SqlCoreValidationResult;
  validateParsed(sql: string, parseResult: unknown, options?: NetezzaSqlValidationOptions): SqlCoreValidationResult;
}
