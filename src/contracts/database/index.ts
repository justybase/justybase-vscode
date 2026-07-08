import type { DatabaseSqlAuthoring } from "../../sql/authoring/types";
import type {
  DatabaseKind as DatabaseKindType,
  DatabaseDialectTraits,
  DatabaseAdvancedFeatures,
  DatabaseMetadataProvider,
  DatabaseConnectionFormSchema,
  DatabaseCapabilities,
} from "@justybase/contracts";

export {
  DatabaseConnection,
  DatabaseCommand,
  DatabaseDataReader,
  DEFAULT_DATABASE_KIND,
  DATABASE_KIND_DISPLAY_NAMES,
  SUPPORTED_DATABASE_KINDS,
  createDatabaseCapabilities,
  createDatabaseDialectTraits,
} from "@justybase/contracts";

export type {
  DatabaseKind,
  DatabaseCapabilities,
  DatabaseConnectionConfig,
  DatabaseConnectionConstructor,
  DatabaseConnectionStaticConstructor,
  DatabaseConnectionFormSchema,
  DatabaseConnectionOptions,
  DatabaseConnectionFieldSchema,
  DatabaseConnectionFieldType,
  DatabaseConnectionFieldOption,
  DatabaseConnectionOptionValue,
  DatabaseMetadataProvider,
  DatabaseColumnQueryOptions,
  DatabaseColumnLookupParams,
  DatabaseMirroredSystemCatalog,
  DatabaseSourceSearchQueryOptions,
  DatabaseDialectTraits,
  DatabaseIdentifierTraits,
  DatabaseQualificationTraits,
  DatabaseCompletionTraits,
  DatabaseObjectSupportTraits,
  DatabaseDialectTraitsOverrides,
  DatabaseAdvancedFeatures,
  DatabaseDdlProvider,
  DatabaseDdlColumnInfo,
  DatabaseDdlKeyInfo,
  DatabaseDdlResult,
  DatabaseProcedureInfo,
  DatabaseExternalTableInfo,
  DatabaseBatchDDLOptions,
  DatabaseBatchDDLResult,
  DatabaseImportDataType,
  DatabaseColumnTypeChooser,
  DatabaseImportTypeMapper,
  DatabaseTuningAdvisor,
  DatabaseTuningAdvisorInput,
  DatabaseMaintenanceProvider,
  DatabaseMaintenanceTarget,
  DatabaseMaintenanceServices,
  DatabasePartitionInfo,
  DatabaseCreatePartitionOptions,
  DatabaseAttachPartitionOptions,
  DatabaseIndexInfo,
  DatabaseCreateIndexOptions,
  DatabaseSessionMonitorProvider,
  DatabaseCopilotReferenceProvider,
  DatabaseReferenceTopic,
} from "@justybase/contracts";

const DATABASE_KIND_ALIASES: Readonly<Record<string, DatabaseKindType>> = {
  netezza: "netezza",
  netezzasql: "netezza",
  nps: "netezza",
  oracle: "oracle",
  postgres: "postgresql",
  postgresql: "postgresql",
  vertica: "vertica",
  verticadb: "vertica",
  snowflake: "snowflake",
  sqlite: "sqlite",
  sqlite3: "sqlite",
  duckdb: "duckdb",
  "duck db": "duckdb",
  "duck-db": "duckdb",
  duck_db: "duckdb",
  db2: "db2",
  db2luw: "db2",
  ibmdb2: "db2",
  mssql: "mssql",
  sqlserver: "mssql",
  "sql server": "mssql",
  mysql: "mysql",
};

export function normalizeDatabaseKind(value?: string): DatabaseKindType {
  return tryNormalizeDatabaseKind(value) ?? "netezza";
}

export function tryNormalizeDatabaseKind(
  value?: string,
): DatabaseKindType | undefined {
  if (!value) {
    return undefined;
  }

  const normalizedValue = value.trim().toLowerCase();
  return DATABASE_KIND_ALIASES[normalizedValue];
}

export interface DatabaseDialect {
  kind: DatabaseKindType;
  displayName: string;
  defaultPort?: number;
  capabilities: DatabaseCapabilities;
  connectionForm?: DatabaseConnectionFormSchema;
  traits: DatabaseDialectTraits;
  metadataProvider: DatabaseMetadataProvider;
  sqlAuthoring: DatabaseSqlAuthoring;
  advancedFeatures?: DatabaseAdvancedFeatures;
  getConnectionConstructor(): import("@justybase/contracts").DatabaseConnectionStaticConstructor;
  createConnection(
    config: import("@justybase/contracts").DatabaseConnectionConfig,
  ): import("@justybase/contracts").DatabaseConnection;
}
