import type { TuningReport } from '../tuning/types';
import type { ConnectionDetails } from '../connectionDetails';
import type { DatabaseConnection } from './connection';

export interface DatabaseDdlColumnInfo {
  name: string;
  description: string | null;
  fullTypeName: string;
  notNull: boolean;
  defaultValue: string | null;
}

export interface DatabaseDdlKeyInfo {
  type: string;
  typeChar: string;
  columns: string[];
  pkDatabase: string | null;
  pkSchema: string | null;
  pkRelation: string | null;
  pkColumns: string[];
  updateType: string;
  deleteType: string;
  enforced?: string;
  trusted?: string;
  comment?: string | null;
}

export interface DatabaseDdlResult {
  success: boolean;
  ddlCode?: string;
  objectInfo?: {
    database: string;
    schema: string;
    objectName: string;
    objectType: string;
  };
  error?: string;
  note?: string;
}

export interface DatabaseProcedureInfo {
  schema: string;
  procedureSource: string;
  objId: number;
  returns: string;
  executeAsOwner: boolean;
  description: string | null;
  procedureSignature: string;
  procedureName: string;
  arguments: string | null;
}

export interface DatabaseExternalTableInfo {
  schema: string;
  tableName: string;
  dataObject: string | null;
  delimiter: string | null;
  encoding: string | null;
  timeStyle: string | null;
  remoteSource: string | null;
  skipRows: number | null;
  maxErrors: number | null;
  escapeChar: string | null;
  logDir: string | null;
  decimalDelim: string | null;
  quotedValue: string | null;
  nullValue: string | null;
  crInString: boolean | null;
  truncString: boolean | null;
  ctrlChars: boolean | null;
  ignoreZero: boolean | null;
  timeExtraZeros: boolean | null;
  y2Base: number | null;
  fillRecord: boolean | null;
  compress: boolean | null;
  includeHeader: boolean | null;
  lfInString: boolean | null;
  dateStyle: string | null;
  dateDelim: string | null;
  timeDelim: string | null;
  boolStyle: string | null;
  format: string | null;
  socketBufSize: number | null;
  recordDelim: string | null;
  maxRows: number | null;
  requireQuotes: boolean | null;
  recordLength: string | null;
  dateTimeDelim: string | null;
  rejectFile: string | null;
}

export type DatabaseDdlGenerationMode = 'objects' | 'schema-migration';

export interface DatabaseBatchDDLOptions {
  connectionDetails: ConnectionDetails;
  database: string;
  schema?: string;
  objectTypes?: string[];
  mode?: DatabaseDdlGenerationMode;
  includeIndexes?: boolean;
  includePartitions?: boolean;
  includeGrants?: boolean;
}

export interface DatabaseBatchDDLResult {
  success: boolean;
  ddlCode?: string;
  objectCount: number;
  errors: string[];
  skipped: number;
  warnings?: string[];
  artifactKind?: DatabaseDdlGenerationMode;
}

export interface DatabaseDdlProvider {
  quoteNameIfNeeded(name: string): string;
  buildFindTableSchemaQuery(database: string, tableName: string): string;
  buildTableStatsQuery(database: string, schema: string, tableName: string): string;
  buildSkewCheckQuery(qualifiedTableName: string): string;
  getColumns(
    connection: DatabaseConnection,
    database: string,
    schema: string,
    tableName: string
  ): Promise<DatabaseDdlColumnInfo[]>;
  getDistributionInfo(
    connection: DatabaseConnection,
    database: string,
    schema: string,
    tableName: string
  ): Promise<string[]>;
  getOrganizeInfo(
    connection: DatabaseConnection,
    database: string,
    schema: string,
    tableName: string
  ): Promise<string[]>;
  getKeysInfo(
    connection: DatabaseConnection,
    database: string,
    schema: string,
    tableName: string
  ): Promise<Map<string, DatabaseDdlKeyInfo>>;
  getTableComment(
    connection: DatabaseConnection,
    database: string,
    schema: string,
    tableName: string
  ): Promise<string | null>;
  getTableOwner(
    connection: DatabaseConnection,
    database: string,
    schema: string,
    tableName: string
  ): Promise<string | null>;
  generateTableDDL(
    connection: DatabaseConnection,
    database: string,
    schema: string,
    tableName: string
  ): Promise<string>;
  buildTableDDLFromCache(
    database: string,
    schema: string,
    tableName: string,
    columns: DatabaseDdlColumnInfo[],
    distributionColumns: string[],
    organizeColumns: string[],
    keysInfo: Map<string, DatabaseDdlKeyInfo>,
    tableComment?: string | null,
    owner?: string | null
  ): string;
  generateViewDDL(
    connection: DatabaseConnection,
    database: string,
    schema: string,
    viewName: string
  ): Promise<string>;
  generateProcedureDDL(
    connection: DatabaseConnection,
    database: string,
    schema: string,
    procSignature: string
  ): Promise<string>;
  generateExternalTableDDL(
    connection: DatabaseConnection,
    database: string,
    schema: string,
    tableName: string
  ): Promise<string>;
  generateSynonymDDL(
    connection: DatabaseConnection,
    database: string,
    schema: string,
    synonymName: string
  ): Promise<string>;
  generateBatchDDL(options: DatabaseBatchDDLOptions): Promise<DatabaseBatchDDLResult>;
  generateDDL(
    connectionDetails: ConnectionDetails,
    database: string,
    schema: string,
    objectName: string,
    objectType: string
  ): Promise<DatabaseDdlResult>;
}

export interface DatabaseImportDataType {
  dbType: string;
  precision?: number;
  scale?: number;
  length?: number;
  toString(): string;
}

export interface DatabaseColumnTypeChooser {
  currentType: DatabaseImportDataType;
  getMaxScale(): number;
  getMaxPrecision(): number;
  refreshCurrentType(strVal: string): DatabaseImportDataType;
}

export interface DatabaseImportTypeMapper {
  createDataType(
    dbType: string,
    precision?: number,
    scale?: number,
    length?: number
  ): DatabaseImportDataType;
  createColumnTypeChooser(decimalDelimiter?: string): DatabaseColumnTypeChooser;
}

export interface DatabaseTuningAdvisorInput {
  sql: string;
  explainPlanText?: string;
  tableStatsText?: string | string[];
}

export interface DatabaseTuningAdvisor {
  analyze(input: DatabaseTuningAdvisorInput): TuningReport;
}

export interface DatabaseMaintenanceTarget {
  connectionName: string;
  databaseName: string;
  schemaName: string;
  tableName: string;
  qualifiedName: string;
}

export interface DatabaseMaintenanceServices {
  context: unknown;
  executeSql(sql: string, connectionName: string, progressTitle: string): Promise<void>;
  getConnectionDetails(connectionName: string): Promise<ConnectionDetails | undefined>;
  openSqlDocument(content: string, language?: string): Promise<void>;
  executeWithProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
  executeAndReport(
    target: DatabaseMaintenanceTarget,
    sql: string,
    progressTitle: string,
    successMessage: string,
    errorPrefix: string
  ): Promise<void>;
  executeQuery<T extends Record<string, unknown>>(sql: string, connectionName: string): Promise<T[]>;
}

export interface DatabasePartitionInfo {
  schema: string;
  name: string;
  parentTable: string;
  partitionBound: string;
  partitionStrategy: 'RANGE' | 'LIST' | 'HASH';
  rowCount?: number;
  totalSize?: number;
}

export interface DatabaseCreatePartitionOptions {
  partitionName: string;
  partitionSchema?: string;
  partitionBound: string;
  tablespace?: string;
  isDefault?: boolean;
}

export interface DatabaseAttachPartitionOptions {
  tableName: string;
  schema?: string;
  partitionBound: string;
}

export interface DatabaseIndexInfo {
  schema: string;
  name: string;
  tableName: string;
  tableSchema: string;
  indexType: string;
  isUnique: boolean;
  isPrimary: boolean;
  columns: string[];
  definition?: string;
  indexSize?: number;
  isValid?: boolean;
}

export interface DatabaseCreateIndexOptions {
  indexName?: string;
  indexType?: 'btree' | 'hash' | 'gist' | 'gin' | 'spgist' | 'brin';
  columns: string[];
  isUnique?: boolean;
  whereClause?: string;
  includeColumns?: string[];
  tablespace?: string;
  concurrent?: boolean;
  ifNotExists?: boolean;
}

export interface DatabaseMaintenanceProvider {
  groomTable?(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices
  ): Promise<void>;
  generateStatistics?(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices
  ): Promise<void>;
  checkSkew?(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices
  ): Promise<void>;
  recreateTable?(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices
  ): Promise<void>;
  vacuumTable?(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices
  ): Promise<void>;
  analyzeTable?(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices
  ): Promise<void>;
  reindexTable?(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices
  ): Promise<void>;
  listPartitions?(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices
  ): Promise<DatabasePartitionInfo[]>;
  createPartition?(
    target: DatabaseMaintenanceTarget,
    options: DatabaseCreatePartitionOptions,
    services: DatabaseMaintenanceServices
  ): Promise<void>;
  dropPartition?(
    target: DatabaseMaintenanceTarget,
    partitionName: string,
    services: DatabaseMaintenanceServices,
    cascade?: boolean,
    partitionSchema?: string
  ): Promise<void>;
  detachPartition?(
    target: DatabaseMaintenanceTarget,
    partitionName: string,
    services: DatabaseMaintenanceServices,
    concurrently?: boolean,
    partitionSchema?: string
  ): Promise<void>;
  attachPartition?(
    target: DatabaseMaintenanceTarget,
    options: DatabaseAttachPartitionOptions,
    services: DatabaseMaintenanceServices
  ): Promise<void>;
  listIndexes?(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices
  ): Promise<DatabaseIndexInfo[]>;
  createIndex?(
    target: DatabaseMaintenanceTarget,
    options: DatabaseCreateIndexOptions,
    services: DatabaseMaintenanceServices
  ): Promise<void>;
  dropIndex?(
    target: DatabaseMaintenanceTarget,
    indexName: string,
    services: DatabaseMaintenanceServices,
    cascade?: boolean,
    concurrently?: boolean
  ): Promise<void>;
  reindexIndex?(
    target: DatabaseMaintenanceTarget,
    indexName: string,
    options: {
      concurrently?: boolean;
      verbose?: boolean;
      tablespace?: string;
    },
    services: DatabaseMaintenanceServices,
    indexSchema?: string
  ): Promise<void>;
  reindexWithOptions?(
    target: DatabaseMaintenanceTarget,
    options: {
      concurrently?: boolean;
      verbose?: boolean;
      tablespace?: string;
    },
    services: DatabaseMaintenanceServices
  ): Promise<void>;
}

export interface DatabaseSessionMonitorProvider {
  getSessions(
    context: unknown,
    connectionManager: unknown,
    database?: string
  ): Promise<Record<string, unknown>[]>;
  getQueries(
    context: unknown,
    connectionManager: unknown,
    database?: string
  ): Promise<Record<string, unknown>[]>;
  getStorage(
    context: unknown,
    connectionManager: unknown
  ): Promise<Record<string, unknown>[]>;
  getResources(
    context: unknown,
    connectionManager: unknown
  ): Promise<{ gra: unknown[]; systemUtil: unknown[]; sysUtilSummary: unknown }>;
  killSession(
    context: unknown,
    connectionManager: unknown,
    sessionId: number
  ): Promise<void>;
}

export type DatabaseReferenceTopic = 'optimization' | 'procedure' | 'all';

export interface DatabaseCopilotReferenceProvider {
  getReference(topic?: DatabaseReferenceTopic): string;
}

export interface DatabaseAdvancedFeatures {
  ddl?: DatabaseDdlProvider;
  importTypeMapper?: DatabaseImportTypeMapper;
  tuningAdvisor?: DatabaseTuningAdvisor;
  maintenance?: DatabaseMaintenanceProvider;
  copilotReferenceProvider?: DatabaseCopilotReferenceProvider;
  sessionMonitor?: DatabaseSessionMonitorProvider;
}
