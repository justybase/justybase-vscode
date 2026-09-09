import type { DatabaseConnection, DatabaseDialect } from './database';
import type { ConnectionDetails } from './connectionDetails';

/** Options for opening a single-file SQL editor through the core extension. */
export interface OpenFileSqlSessionOptions {
  /** Optional initial SQL content of the opened document. */
  content?: string;
  /** Save the connection profile under this name (defaults to a generated name). */
  connectionName?: string;
  /** Update an existing single-file profile when it points at the same source. */
  updateExisting?: boolean;
}

/** Options for opening a read-only File SQL workspace through the core extension. */
export interface OpenFileSqlWorkspaceSessionOptions {
  /** Optional initial SQL content of the opened document. */
  content?: string;
  /** Save the workspace profile under this name. */
  connectionName?: string;
}

/** Saved connection metadata with credentials deliberately omitted. */
export interface SavedConnectionSummary {
  name: string;
  details: Omit<ConnectionDetails, 'password'>;
}

/** Public metadata for a saved connection profile. */
export interface ConnectionSummary {
  name: string;
  database: string;
  databaseKind: string;
}

/** Tabular result returned by the optional public query methods. */
export interface ConnectionQueryResult {
  columns: string[];
  rows: unknown[][];
}

/**
 * Versioned public surface exposed by the JustyBase core extension.
 *
 * Keep this interface additive. In particular, optional members and their
 * optionality are part of the v1 compatibility contract for companions.
 */
export interface JustyBaseLiteApi {
  readonly version: 1;
  registerDatabaseDialect(dialect: DatabaseDialect): DatabaseDialect;
  listRegisteredDatabaseDialects(): readonly DatabaseDialect[];
  /** Create a connected profile through core, including an optional TCP tunnel. */
  createConnectedDatabaseConnectionFromDetails?(
    details: ConnectionDetails,
    databaseOverride?: string,
  ): Promise<DatabaseConnection>;
  /** Save (or reuse) a connection profile and open a SQL editor bound to it. */
  openFileSqlSession(
    details: ConnectionDetails,
    options?: OpenFileSqlSessionOptions,
  ): Promise<void>;
  /** Save (or reuse) a read-only File SQL profile containing multiple files. */
  openFileSqlWorkspaceSession(
    filePaths: readonly string[],
    options?: OpenFileSqlWorkspaceSessionOptions,
  ): Promise<void>;
  /** List saved connection profiles without exposing passwords. */
  listSavedConnections(): Promise<readonly SavedConnectionSummary[]>;
  /** Metadata for a named profile, without credentials. */
  getConnectionSummary?(connectionName: string): Promise<ConnectionSummary | undefined>;
  /** Details of the active connection (document-bound first, else active). */
  getActiveConnectionDetails(): Promise<{
    name: string;
    details: ConnectionDetails;
    documentUri?: string;
    documentBound: boolean;
  } | undefined>;
  /** Execute SQL on the active editor's persistent connection. */
  executeActiveConnectionSql(sql: string, documentUri?: string): Promise<void>;
  /** Execute SQL on the active editor's persistent connection and return rows. */
  executeActiveConnectionSqlQuery?(
    sql: string,
    documentUri?: string,
  ): Promise<ConnectionQueryResult>;
  /** Execute SQL using a named profile without exposing its credentials. */
  executeConnectionSql?(sql: string, connectionName: string): Promise<void>;
  /** Execute a query using a named profile without exposing its credentials. */
  executeConnectionSqlQuery?(
    sql: string,
    connectionName: string,
  ): Promise<ConnectionQueryResult>;
}
