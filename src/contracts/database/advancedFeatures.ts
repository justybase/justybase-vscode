import type { ExtensionContext } from 'vscode';
import type { ConnectionDetails } from '../../types';
import type { TuningReport } from '../../services/tuning/types';
import type { DatabaseConnection } from './index';

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

export interface DatabaseBatchDDLOptions {
    connectionDetails: ConnectionDetails;
    database: string;
    schema?: string;
    objectTypes?: string[];
}

export interface DatabaseBatchDDLResult {
    success: boolean;
    ddlCode?: string;
    objectCount: number;
    errors: string[];
    skipped: number;
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

/**
 * Represents the target table for a maintenance operation.
 */
export interface DatabaseMaintenanceTarget {
    /** The connection name identifier */
    connectionName: string;
    /** The database name */
    databaseName: string;
    /** The schema name */
    schemaName: string;
    /** The table name */
    tableName: string;
    /** The fully qualified table name (e.g., "database.schema.table") */
    qualifiedName: string;
}

/**
 * Services available to maintenance providers for executing operations.
 */
export interface DatabaseMaintenanceServices {
  /** The VS Code extension context */
  context: ExtensionContext;
  /**
   * Execute a SQL statement with progress indication.
   * @param sql The SQL statement to execute
   * @param connectionName The connection to use
   * @param progressTitle The title to show in the progress indicator
   */
  executeSql(sql: string, connectionName: string, progressTitle: string): Promise<void>;
  /**
   * Get connection details for a named connection.
   * @param connectionName The connection name
   * @returns The connection details or undefined if not found
   */
  getConnectionDetails(connectionName: string): Promise<ConnectionDetails | undefined>;
  /**
   * Open a SQL document in the editor.
   * @param content The document content
   * @param language The language identifier (default: 'sql')
   */
  openSqlDocument(content: string, language?: string): Promise<void>;
  /**
   * Execute a task with a progress indicator.
   * @param title The progress title
   * @param task The task to execute
   */
  executeWithProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
  /**
   * Execute a SQL statement and show success/error notification.
   * @param target The target table
   * @param sql The SQL statement to execute
   * @param progressTitle The progress title
   * @param successMessage The success message template
   * @param errorPrefix The error message prefix
   */
  executeAndReport(
    target: DatabaseMaintenanceTarget,
    sql: string,
    progressTitle: string,
    successMessage: string,
    errorPrefix: string
  ): Promise<void>;
  /**
   * Execute a raw SQL query and return typed rows.
   * This is the preferred way to run queries in maintenance providers.
   * @param sql The SQL query to execute
   * @param connectionName The connection to use
   * @returns Array of typed rows from the query result
   */
  executeQuery<T extends Record<string, unknown>>(sql: string, connectionName: string): Promise<T[]>;
}

/**
 * Represents a table partition.
 */
export interface DatabasePartitionInfo {
  /** Partition schema name */
  schema: string;
  /** Partition table name */
  name: string;
  /** Parent table name */
  parentTable: string;
  /** Partition bound expression (e.g., "FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')") */
  partitionBound: string;
  /** Partition strategy: RANGE, LIST, HASH */
  partitionStrategy: 'RANGE' | 'LIST' | 'HASH';
  /** Estimated row count */
  rowCount?: number;
  /** Total size in bytes */
  totalSize?: number;
}

/**
 * Options for creating a new partition.
 */
export interface DatabaseCreatePartitionOptions {
  /** Partition table name */
  partitionName: string;
  /** Schema for the new partition (defaults to parent schema) */
  partitionSchema?: string;
  /** Partition bound expression */
  partitionBound: string;
  /** Tablespace for the partition */
  tablespace?: string;
  /** Whether to create default partition */
  isDefault?: boolean;
}

/**
 * Options for attaching an existing table as partition.
 */
export interface DatabaseAttachPartitionOptions {
  /** Name of table to attach */
  tableName: string;
  /** Schema of table to attach */
  schema?: string;
  /** Partition bound expression */
  partitionBound: string;
}

/**
 * Represents a database index.
 */
export interface DatabaseIndexInfo {
  /** Index schema name */
  schema: string;
  /** Index name */
  name: string;
  /** Table the index belongs to */
  tableName: string;
  /** Table schema */
  tableSchema: string;
  /** Index type: btree, hash, gist, gin, etc. */
  indexType: string;
  /** Whether index is unique */
  isUnique: boolean;
  /** Whether index is primary key */
  isPrimary: boolean;
  /** Columns in the index */
  columns: string[];
  /** Index definition SQL */
  definition?: string;
  /** Index size in bytes */
  indexSize?: number;
  /** Whether index is valid */
  isValid?: boolean;
}

/**
 * Options for creating a new index.
 */
export interface DatabaseCreateIndexOptions {
  /** Index name (optional, auto-generated if not provided) */
  indexName?: string;
  /** Index type: btree, hash, gist, gin, spgist, brin */
  indexType?: 'btree' | 'hash' | 'gist' | 'gin' | 'spgist' | 'brin';
  /** Columns to index */
  columns: string[];
  /** Whether to create unique index */
  isUnique?: boolean;
  /** WHERE clause for partial index */
  whereClause?: string;
  /** INCLUDE columns for covering index */
  includeColumns?: string[];
  /** Tablespace for the index */
  tablespace?: string;
  /** Whether to create index concurrently */
  concurrent?: boolean;
  /** Whether to use IF NOT EXISTS */
  ifNotExists?: boolean;
}

/**
 * Provider interface for database-specific table maintenance operations.
 * Each dialect can implement the operations it supports.
 */
export interface DatabaseMaintenanceProvider {
    /** Groom/reclaim space in a table (Netezza-specific) */
    groomTable?(
        target: DatabaseMaintenanceTarget,
        services: DatabaseMaintenanceServices
    ): Promise<void>;
    /** Generate statistics for a table */
    generateStatistics?(
        target: DatabaseMaintenanceTarget,
        services: DatabaseMaintenanceServices
    ): Promise<void>;
    /** Check data distribution/skew across dataslices */
    checkSkew?(
        target: DatabaseMaintenanceTarget,
        services: DatabaseMaintenanceServices
    ): Promise<void>;
    /** Generate a script to recreate a table */
    recreateTable?(
        target: DatabaseMaintenanceTarget,
        services: DatabaseMaintenanceServices
    ): Promise<void>;
    /** Vacuum a table to reclaim space (PostgreSQL) */
    vacuumTable?(
        target: DatabaseMaintenanceTarget,
        services: DatabaseMaintenanceServices
    ): Promise<void>;
    /** Analyze a table to update statistics (PostgreSQL) */
    analyzeTable?(
        target: DatabaseMaintenanceTarget,
        services: DatabaseMaintenanceServices
    ): Promise<void>;
  /** Reindex a table (PostgreSQL) */
  reindexTable?(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices
  ): Promise<void>;

  // =====================
  // PARTITION MANAGEMENT
  // =====================

  /** List all partitions of a table */
  listPartitions?(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices
  ): Promise<DatabasePartitionInfo[]>;

  /** Create a new partition */
  createPartition?(
    target: DatabaseMaintenanceTarget,
    options: DatabaseCreatePartitionOptions,
    services: DatabaseMaintenanceServices
  ): Promise<void>;

  /** Drop a partition */
  dropPartition?(
    target: DatabaseMaintenanceTarget,
    partitionName: string,
    services: DatabaseMaintenanceServices,
    cascade?: boolean,
    partitionSchema?: string
  ): Promise<void>;

  /** Detach a partition (keep as standalone table) */
  detachPartition?(
    target: DatabaseMaintenanceTarget,
    partitionName: string,
    services: DatabaseMaintenanceServices,
    concurrently?: boolean,
    partitionSchema?: string
  ): Promise<void>;

  /** Attach an existing table as a partition */
  attachPartition?(
    target: DatabaseMaintenanceTarget,
    options: DatabaseAttachPartitionOptions,
    services: DatabaseMaintenanceServices
  ): Promise<void>;

  // =====================
  // INDEX MANAGEMENT
  // =====================

  /** List all indexes on a table */
  listIndexes?(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices
  ): Promise<DatabaseIndexInfo[]>;

  /** Create a new index */
  createIndex?(
    target: DatabaseMaintenanceTarget,
    options: DatabaseCreateIndexOptions,
    services: DatabaseMaintenanceServices
  ): Promise<void>;

  /** Drop an index */
  dropIndex?(
    target: DatabaseMaintenanceTarget,
    indexName: string,
    services: DatabaseMaintenanceServices,
    cascade?: boolean,
    concurrently?: boolean
  ): Promise<void>;

  /** Reindex a specific index */
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

  /** Reindex with options */
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
        context: ExtensionContext,
        connectionManager: unknown,
        database?: string
    ): Promise<Record<string, unknown>[]>;
    getQueries(
        context: ExtensionContext,
        connectionManager: unknown,
        database?: string
    ): Promise<Record<string, unknown>[]>;
    getStorage(
        context: ExtensionContext,
        connectionManager: unknown
    ): Promise<Record<string, unknown>[]>;
    getResources(
        context: ExtensionContext,
        connectionManager: unknown
    ): Promise<{ gra: unknown[]; systemUtil: unknown[]; sysUtilSummary: unknown }>;
    killSession(
        context: ExtensionContext,
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
