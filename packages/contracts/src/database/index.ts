import type { DatabaseConnectionFormSchema, DatabaseConnectionOptions, DatabaseConnectionFieldSchema, DatabaseConnectionFieldType, DatabaseConnectionFieldOption, DatabaseConnectionOptionValue } from './connectionForm';
import type { DatabaseMetadataProvider, DatabaseColumnQueryOptions, DatabaseColumnLookupParams, DatabaseMirroredSystemCatalog, DatabaseSourceSearchQueryOptions } from './metadataProvider';
import type { DatabaseDialectTraits, DatabaseIdentifierTraits, DatabaseQualificationTraits, DatabaseCompletionTraits, DatabaseObjectSupportTraits, DatabaseDialectTraitsOverrides } from './dialectTraits';
import type { DatabaseConnection, DatabaseConnectionConfig, DatabaseConnectionConstructor, DatabaseConnectionStaticConstructor, DatabaseCommand, DatabaseDataReader } from './connection';
import type { DatabaseAdvancedFeatures, DatabaseDdlProvider, DatabaseDdlColumnInfo, DatabaseDdlKeyInfo, DatabaseDdlResult, DatabaseProcedureInfo, DatabaseExternalTableInfo, DatabaseBatchDDLOptions, DatabaseBatchDDLResult, DatabaseImportDataType, DatabaseColumnTypeChooser, DatabaseImportTypeMapper, DatabaseTuningAdvisor, DatabaseTuningAdvisorInput, DatabaseMaintenanceProvider, DatabaseMaintenanceTarget, DatabaseMaintenanceServices, DatabasePartitionInfo, DatabaseCreatePartitionOptions, DatabaseAttachPartitionOptions, DatabaseIndexInfo, DatabaseCreateIndexOptions, DatabaseSessionMonitorProvider, DatabaseCopilotReferenceProvider, DatabaseReferenceTopic } from './advancedFeatures';

export type DatabaseKind =
  | 'netezza'
  | 'oracle'
  | 'postgresql'
  | 'vertica'
  | 'snowflake'
  | 'sqlite'
  | 'duckdb'
  | 'db2'
  | 'mssql'
  | 'mysql'
  | (string & {});

export const DEFAULT_DATABASE_KIND: DatabaseKind = 'netezza';

export const SUPPORTED_DATABASE_KINDS = [
  'netezza',
  'oracle',
  'postgresql',
  'vertica',
  'snowflake',
  'sqlite',
  'duckdb',
  'db2',
  'mssql',
  'mysql',
] as const;

export const DATABASE_KIND_DISPLAY_NAMES: Readonly<Partial<Record<DatabaseKind, string>>> = {
  netezza: 'Netezza',
  oracle: 'Oracle',
  postgresql: 'PostgreSQL',
  vertica: 'Vertica',
  snowflake: 'Snowflake',
  sqlite: 'SQLite',
  duckdb: 'DuckDB',
  db2: 'Db2',
  mssql: 'MS SQL Server',
  mysql: 'MySQL',
};

export { DatabaseConnection, DatabaseCommand, DatabaseDataReader };
export type { DatabaseConnectionConfig, DatabaseConnectionConstructor, DatabaseConnectionStaticConstructor };
export type { DatabaseConnectionFormSchema, DatabaseConnectionOptions, DatabaseConnectionFieldSchema, DatabaseConnectionFieldType, DatabaseConnectionFieldOption, DatabaseConnectionOptionValue };
export type { DatabaseMetadataProvider, DatabaseColumnQueryOptions, DatabaseColumnLookupParams, DatabaseMirroredSystemCatalog, DatabaseSourceSearchQueryOptions };
export type { DatabaseDialectTraits, DatabaseIdentifierTraits, DatabaseQualificationTraits, DatabaseCompletionTraits, DatabaseObjectSupportTraits, DatabaseDialectTraitsOverrides };
export type { DatabaseAdvancedFeatures, DatabaseDdlProvider, DatabaseDdlColumnInfo, DatabaseDdlKeyInfo, DatabaseDdlResult, DatabaseProcedureInfo, DatabaseExternalTableInfo, DatabaseBatchDDLOptions, DatabaseBatchDDLResult, DatabaseImportDataType, DatabaseColumnTypeChooser, DatabaseImportTypeMapper, DatabaseTuningAdvisor, DatabaseTuningAdvisorInput, DatabaseMaintenanceProvider, DatabaseMaintenanceTarget, DatabaseMaintenanceServices, DatabasePartitionInfo, DatabaseCreatePartitionOptions, DatabaseAttachPartitionOptions, DatabaseIndexInfo, DatabaseCreateIndexOptions, DatabaseSessionMonitorProvider, DatabaseCopilotReferenceProvider, DatabaseReferenceTopic };

export interface DatabaseCapabilities {
  supportsExplainPlan: boolean;
  supportsExplainGraph: boolean;
  supportsTuningAdvisor: boolean;
  supportsExternalTables: boolean;
  supportsProcedures: boolean;
  supportsTableMaintenance: boolean;
  supportsSessionMonitor: boolean;
}

export interface DatabaseSqlFunctionSignature {
  name: string;
  parameters: readonly string[];
  description: string;
}

export interface DatabaseSqlTypeSpec {
  canonical: string;
  paramsMin: number;
  paramsMax: number;
  warnIfNoLength?: boolean;
}

export interface DatabaseSqlValidationProfile {
  builtinFunctions: ReadonlySet<string>;
  systemColumns: ReadonlySet<string>;
  specialBuiltinValues: ReadonlySet<string>;
  getTypeSpec(typeName: string): DatabaseSqlTypeSpec | undefined;
  supportsProcedureAnySizeArgument(typeName: string): boolean;
  syntaxValidationMode?: 'strict' | 'bestEffort';
}

export interface DatabaseSqlFormatterProfile {
  keywords: ReadonlySet<string>;
  clauseKeywords: ReadonlySet<string>;
  newlineBeforeKeywords: ReadonlySet<string>;
  joinModifiers: ReadonlySet<string>;
  commaNewlineClauses: ReadonlySet<string>;
  logicalBreakKeywords: ReadonlySet<string>;
}

export interface DatabaseSqlParsingProfile {
  lexerModulePath: string;
  parserModulePath: string;
}

export interface DatabaseSqlStaticAssetProfile {
  snippetsPath?: string;
  grammarPath?: string;
  grammarScopeName?: string;
}

export interface DatabaseSqlAuthoring {
  completionKeywords: readonly string[];
  signatures: ReadonlyMap<string, readonly DatabaseSqlFunctionSignature[]>;
  formatter: DatabaseSqlFormatterProfile;
  validation: DatabaseSqlValidationProfile;
  qualityRules: readonly any[];
  parsing?: DatabaseSqlParsingProfile;
  staticAssets?: DatabaseSqlStaticAssetProfile;
}

export interface DatabaseDialect {
  kind: DatabaseKind;
  displayName: string;
  defaultPort?: number;
  capabilities: DatabaseCapabilities;
  connectionForm?: DatabaseConnectionFormSchema;
  traits: DatabaseDialectTraits;
  metadataProvider: DatabaseMetadataProvider;
  sqlAuthoring: DatabaseSqlAuthoring;
  advancedFeatures?: DatabaseAdvancedFeatures;
  getConnectionConstructor(): DatabaseConnectionStaticConstructor;
  createConnection(config: DatabaseConnectionConfig): DatabaseConnection;
}

export function createDatabaseCapabilities(
  overrides: Partial<DatabaseCapabilities> = {},
): DatabaseCapabilities {
  return {
    supportsExplainPlan: false,
    supportsExplainGraph: false,
    supportsTuningAdvisor: false,
    supportsExternalTables: false,
    supportsProcedures: false,
    supportsTableMaintenance: false,
    supportsSessionMonitor: false,
    ...overrides,
  };
}

export { createDatabaseDialectTraits } from './dialectTraits';
