import type { DatabaseConnectionFormSchema, DatabaseConnectionOptions, DatabaseConnectionFieldSchema, DatabaseConnectionFieldType, DatabaseConnectionFieldOption, DatabaseConnectionOptionValue } from './connectionForm';
import type { DatabaseMetadataProvider, DatabaseColumnQueryOptions, DatabaseColumnsWithKeysQuerySet, DatabaseColumnLookupParams, DatabaseMirroredSystemCatalog, DatabaseSourceSearchQueryOptions } from './metadataProvider';
import type { DatabaseDialectTraits, DatabaseIdentifierTraits, DatabaseQualificationTraits, DatabaseCompletionTraits, DatabaseObjectSupportTraits, DatabaseDialectTraitsOverrides, DatabaseThreePartNamePrefix } from './dialectTraits';
import type { DatabaseConnection, DatabaseConnectionConfig, DatabaseConnectionConstructor, DatabaseConnectionStaticConstructor, DatabaseCommand, DatabaseDataReader } from './connection';
import type { DatabaseAdvancedFeatures, DatabaseDdlProvider, DatabaseDdlColumnInfo, DatabaseDdlKeyInfo, DatabaseDdlResult, DatabaseTableDefinitionMetadata, DatabaseProcedureInfo, DatabaseExternalTableInfo, DatabaseDdlGenerationMode, DatabaseBatchDDLOptions, DatabaseBatchDDLResult, DatabaseImportDataType, DatabaseColumnTypeChooser, DatabaseImportTypeMapper, DatabaseTuningAdvisor, DatabaseTuningAdvisorInput, DatabaseMaintenanceProvider, DatabaseMaintenanceTarget, DatabaseMaintenanceServices, DatabasePartitionInfo, DatabaseCreatePartitionOptions, DatabaseAttachPartitionOptions, DatabaseIndexInfo, DatabaseCreateIndexOptions, DatabaseSessionMonitorServices, DatabaseSessionMonitorProvider, DatabaseCopilotReferenceProvider, DatabaseReferenceTopic } from './advancedFeatures';
import { UnsupportedDesignerOperationError } from './designerCapabilities';
import type { DatabaseDesignerCapabilities, DatabaseDesignerCapability, DatabaseDesignerCapabilityKey, DatabaseDesignerColumn, DatabaseDesignerConstraint, DatabaseDesignerDefinition, DatabaseDesignerDiagnostic, DatabaseDesignerIndex, DatabaseDesignerNativeDefinition, DatabaseDesignerPartition, DatabaseDesignerProvider, DatabaseDesignerRelationalIndex, DatabaseDesignerRequirement, DatabaseDesignerRuntimeContext, DatabaseDesignerTarget, DatabaseDesignerTrigger, DatabaseDesignerTriggerCapability, DatabaseDesignerViewCapability, DatabaseDesignerRoutineCapability, DatabaseObjectSnapshot, DatabaseSchemaChangePlan, DatabaseSchemaChangeStatement, DatabaseViewDesignerDefinition, DatabaseTableDesignerDefinition, DesignerCapabilityReasonCode, DesignerNativeFeature, DesignerOperation, DesignerSupportLevel, DesignerRoutineBodyStyle, DesignerTriggerBodyStyle, DesignerTriggerEvent, DesignerTriggerLevel, DesignerTriggerTiming, DesignerViewReplaceStyle } from './designerCapabilities';

import type { DatabaseKind } from './kind';
export type { DatabaseKind } from './kind';

export const DEFAULT_DATABASE_KIND: DatabaseKind = 'netezza';

const DATABASE_KIND_ALIASES: Readonly<Record<string, DatabaseKind>> = {
  netezza: 'netezza',
  netezzasql: 'netezza',
  nps: 'netezza',
  oracle: 'oracle',
  postgres: 'postgresql',
  postgresql: 'postgresql',
  vertica: 'vertica',
  verticadb: 'vertica',
  snowflake: 'snowflake',
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  duckdb: 'duckdb',
  'duck db': 'duckdb',
  'duck-db': 'duckdb',
  duck_db: 'duckdb',
  file: 'file',
  files: 'file',
  'file sql': 'file',
  // File extensions are accepted here only as aliases at the File SQL
  // adapter boundary; they are not additional database dialects.
  xlsx: 'file',
  xlsb: 'file',
  csv: 'file',
  parquet: 'file',
  avro: 'file',
  db2: 'db2',
  db2luw: 'db2',
  ibmdb2: 'db2',
  mssql: 'mssql',
  sqlserver: 'mssql',
  'sql server': 'mssql',
  mysql: 'mysql',
  clickhouse: 'clickhouse',
  'click-house': 'clickhouse',
  access: 'access',
  mdb: 'access',
  accdb: 'access',
  msaccess: 'access',
  'ms access': 'access',
};

export function tryNormalizeDatabaseKind(
  value?: string,
): DatabaseKind | undefined {
  if (!value) {
    return undefined;
  }

  return DATABASE_KIND_ALIASES[value.trim().toLowerCase()];
}

export function normalizeDatabaseKind(value?: string): DatabaseKind {
  if (value === undefined || value.trim().length === 0) {
    return DEFAULT_DATABASE_KIND;
  }

  const normalizedKind = tryNormalizeDatabaseKind(value);
  if (!normalizedKind) {
    throw new Error(`Unsupported database kind '${value}'.`);
  }
  return normalizedKind;
}

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
  'clickhouse',
  'access',
] as const;

export const DATABASE_KIND_DISPLAY_NAMES: Readonly<Partial<Record<DatabaseKind, string>>> = {
  netezza: 'Netezza',
  oracle: 'Oracle',
  postgresql: 'PostgreSQL',
  vertica: 'Vertica',
  snowflake: 'Snowflake',
  sqlite: 'SQLite',
  duckdb: 'DuckDB',
  file: 'File SQL (DuckDB)',
  db2: 'Db2',
  mssql: 'MS SQL Server',
  mysql: 'MySQL',
  clickhouse: 'ClickHouse',
  access: 'Microsoft Access',
};

export { DatabaseConnection, DatabaseCommand, DatabaseDataReader };
export type { DatabaseConnectionConfig, DatabaseConnectionConstructor, DatabaseConnectionStaticConstructor };
export type { DatabaseConnectionFormSchema, DatabaseConnectionOptions, DatabaseConnectionFieldSchema, DatabaseConnectionFieldType, DatabaseConnectionFieldOption, DatabaseConnectionOptionValue };
export type { DatabaseMetadataProvider, DatabaseColumnQueryOptions, DatabaseColumnsWithKeysQuerySet, DatabaseColumnLookupParams, DatabaseMirroredSystemCatalog, DatabaseSourceSearchQueryOptions };
export type { DatabaseDialectTraits, DatabaseIdentifierTraits, DatabaseQualificationTraits, DatabaseCompletionTraits, DatabaseObjectSupportTraits, DatabaseDialectTraitsOverrides, DatabaseThreePartNamePrefix };
export type { DatabaseAdvancedFeatures, DatabaseDdlProvider, DatabaseDdlColumnInfo, DatabaseDdlKeyInfo, DatabaseDdlResult, DatabaseTableDefinitionMetadata, DatabaseProcedureInfo, DatabaseExternalTableInfo, DatabaseDdlGenerationMode, DatabaseBatchDDLOptions, DatabaseBatchDDLResult, DatabaseImportDataType, DatabaseColumnTypeChooser, DatabaseImportTypeMapper, DatabaseTuningAdvisor, DatabaseTuningAdvisorInput, DatabaseMaintenanceProvider, DatabaseMaintenanceTarget, DatabaseMaintenanceServices, DatabasePartitionInfo, DatabaseCreatePartitionOptions, DatabaseAttachPartitionOptions, DatabaseIndexInfo, DatabaseCreateIndexOptions, DatabaseSessionMonitorServices, DatabaseSessionMonitorProvider, DatabaseCopilotReferenceProvider, DatabaseReferenceTopic };
export type { DatabaseDesignerCapabilities, DatabaseDesignerCapability, DatabaseDesignerCapabilityKey, DatabaseDesignerColumn, DatabaseDesignerConstraint, DatabaseDesignerDefinition, DatabaseDesignerDiagnostic, DatabaseDesignerIndex, DatabaseDesignerNativeDefinition, DatabaseDesignerPartition, DatabaseDesignerProvider, DatabaseDesignerRelationalIndex, DatabaseDesignerRequirement, DatabaseDesignerRuntimeContext, DatabaseDesignerTarget, DatabaseDesignerTrigger, DatabaseDesignerTriggerCapability, DatabaseDesignerViewCapability, DatabaseDesignerRoutineCapability, DatabaseObjectSnapshot, DatabaseSchemaChangePlan, DatabaseSchemaChangeStatement, DatabaseViewDesignerDefinition, DatabaseTableDesignerDefinition, DesignerCapabilityReasonCode, DesignerNativeFeature, DesignerOperation, DesignerSupportLevel, DesignerRoutineBodyStyle, DesignerTriggerBodyStyle, DesignerTriggerEvent, DesignerTriggerLevel, DesignerTriggerTiming, DesignerViewReplaceStyle };
export { UnsupportedDesignerOperationError };
export { DATABASE_DESIGNER_CAPABILITY_MANIFESTS, DESIGNER_CAPABILITY_KEYS, DESIGNER_OPERATIONS, getDatabaseDesignerCapabilities, getDesignerCapability, resolveDatabaseDesignerCapabilities } from './designerCapabilities';

export interface DatabaseCapabilities {
  supportsExplainPlan: boolean;
  supportsExplainGraph: boolean;
  supportsTuningAdvisor: boolean;
  supportsExternalTables: boolean;
  supportsProcedures: boolean;
  supportsTableMaintenance: boolean;
  supportsSessionMonitor: boolean;
  /** Whether SPU/data-slice distribution and skew metrics are meaningful. */
  supportsDistributionMetrics: boolean;
}

export interface DatabaseSqlFunctionSignature {
  name: string;
  parameters: readonly string[];
  description: string;
  /** Optional example shown by authoring clients. */
  example?: string;
}

export interface DatabaseSqlTypeSpec {
  canonical: string;
  paramsMin: number;
  paramsMax: number;
  warnIfNoLength?: boolean;
}

export interface DatabaseSqlValidationProfile {
  /** Dialect identity used when semantic validation resolves ambiguous names. */
  databaseKind?: DatabaseKind;
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

/** Shared serializable shape for lint results without a VS Code dependency. */
export interface DatabaseSqlLintIssue {
  ruleId: string;
  message: string;
  severity: 0 | 1 | 2 | 3;
  startOffset: number;
  endOffset: number;
  suggestedFix?: string;
}

/** A portable SQL quality rule implemented by a database dialect. */
export interface DatabaseSqlQualityRule {
  id: string;
  name: string;
  description: string;
  defaultSeverity: 0 | 1 | 2 | 3;
  onDemandOnly?: boolean;
  check(sql: string): DatabaseSqlLintIssue[];
}

export interface DatabaseSqlAuthoring {
  completionKeywords: readonly string[];
  signatures: ReadonlyMap<string, readonly DatabaseSqlFunctionSignature[]>;
  formatter: DatabaseSqlFormatterProfile;
  validation: DatabaseSqlValidationProfile;
  qualityRules: readonly DatabaseSqlQualityRule[];
  parsing?: DatabaseSqlParsingProfile;
  staticAssets?: DatabaseSqlStaticAssetProfile;
}

export interface DatabaseDialect {
  kind: DatabaseKind;
  displayName: string;
  defaultPort?: number;
  capabilities: DatabaseCapabilities;
  /** Static baseline; providers may refine this after runtime introspection. */
  designerCapabilities?: DatabaseDesignerCapabilities;
  connectionForm?: DatabaseConnectionFormSchema;
  traits: DatabaseDialectTraits;
  metadataProvider: DatabaseMetadataProvider;
  sqlAuthoring: DatabaseSqlAuthoring;
  advancedFeatures?: DatabaseAdvancedFeatures;
  /** Whether the driver speaks a transparent TCP protocol suitable for a core tunnel. */
  supportsRawTcpTunnel?: boolean;
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
    supportsDistributionMetrics: false,
    ...overrides,
  };
}

export { createDatabaseDialectTraits } from './dialectTraits';
