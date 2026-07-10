import type {
  DatabaseCapabilities,
  DatabaseCommand,
  DatabaseConnection,
  DatabaseConnectionConfig,
  DatabaseConnectionConstructor,
  DatabaseConnectionOptions,
  DatabaseDataReader,
  DatabaseKind,
} from "@justybase/contracts";

export type {
  DatabaseCapabilities,
  DatabaseCommand,
  DatabaseConnection,
  DatabaseConnectionConfig,
  DatabaseConnectionConstructor,
  DatabaseConnectionOptions,
  DatabaseDataReader,
  DatabaseKind,
};

export interface EditSource {
  db?: string;
  schema?: string;
  table: string;
}

export interface QueryResult {
  columns: ColumnDefinition[];
  data: unknown[][];
  rowsAffected?: number;
  message?: string;
  limitReached?: boolean;
  /**
   * SQL payload associated with this result.
   */
  sql?: string;
  /**
   * Direct SQL payload used to re-run this result.
   */
  refreshSql?: string;
  /**
   * Full macro-expanded SQL passed to the driver. Present when
   * {@link executeRawQuery} preprocesses directives.
   */
  expandedSql?: string;
  isLog?: boolean;
  isError?: boolean;
  isCancelled?: boolean;
  isTextContent?: boolean;
  executionTimestamp?: number;
  name?: string;
  isEditable?: boolean;
  editSource?: EditSource;
}

export type ResultSetStorageMode = 'memory' | 'sqlite';

export interface ResultSetRefreshFailure {
  message: string;
  sql?: string;
  failedAt: number;
}

export type { DiskQuerySpec } from '../core/resultDataProvider/types';

export type ResultSet = QueryResult & {
  /** Present when rows live in SqliteResultStore instead of data[][]. */
  diskStoreId?: string;
  /** Authoritative count when disk-backed; data.length may be 0 or window-only in webview. */
  totalRowCount?: number;
  storageMode?: ResultSetStorageMode;
  /** Active SQL-backed filter/sort spec for disk-backed export and host queries. */
  diskQuerySpec?: import('../core/resultDataProvider/types').DiskQuerySpec;
  /** Active database-side filter spec applied by wrapping refreshSql without its trailing LIMIT. */
  databaseFilterSpec?: import('../core/resultDataProvider/types').DiskQuerySpec;
  /** Non-destructive refresh failure; previous grid data remains visible. */
  refreshFailure?: ResultSetRefreshFailure;
  /** Row count after applying diskQuerySpec filters (sort does not change count). */
  diskFilteredCount?: number;
  /** JSON key of the spec used for the cached diskFilteredCount. */
  diskQueryCountSpecKey?: string;
  /** Rows already streamed to the webview during an in-flight large result. */
  webviewStreamedRows?: number;
};

export interface ColumnDefinition {
  name: string;
  type?: string;
  scale?: number;
}

export interface ConnectionDetails {
  name?: string;
  host: string;
  port?: number;
  database: string;
  user: string;
  password?: string;
  options?: DatabaseConnectionOptions;
  dbType?: DatabaseKind;
  accentColor?: string;
  schema?: string;
}

export type NamedConnectionDetails = ConnectionDetails & { name: string };

export type NzConnectionConfig = DatabaseConnectionConfig;
export type NzConnection = DatabaseConnection;
export type NzCommand = DatabaseCommand;
export type NzDataReader = DatabaseDataReader;
export type NzConnectionConstructor = DatabaseConnectionConstructor;

export interface LocalDefinition {
  name: string;
  type: "CTE" | "Temp Table" | "Subquery";
  columns: string[];
}

export interface ParsedContext {
  version: number;
  cleanText: string;
  localDefs: LocalDefinition[];
  variables: string[];
}

export interface AliasInfo {
  db?: string;
  schema?: string;
  table: string;
}

export interface TableReference {
  db?: string;
  schema?: string;
  table: string;
  alias?: string;
}

export interface JoinOnMatch {
  tableRef: string;
  alias?: string;
  typedPrefix?: string;
}

export interface DbMatch {
  dbName: string;
  partial: string;
}

export interface SchemaMatch {
  dbName: string;
  schemaName: string;
  partial: string;
}

export interface TableMatch {
  dbName: string;
  partial: string;
}
