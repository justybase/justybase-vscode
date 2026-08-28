/**
 * Cache surface required by CachePrefetcher (read + write + lifecycle hooks).
 */

import type {
  ColumnMetadata,
  DatabaseMetadata,
  ProcedureMetadata,
  SchemaMetadata,
  TableMetadata,
} from '../types';
import type { MetadataStorageReader } from './MetadataStorageReader';
import type { PrefetchLease } from '../diskStorage/metadataDiskStorage';

/**
 * Read-only completeness diagnosis for a persisted/in-memory metadata snapshot.
 * Missing column layers are capped for presentation; missingColumnCount remains
 * the full count.
 */
export interface MetadataSnapshotCompletenessReport {
  complete: boolean;
  missingStages: readonly string[];
  missingColumnKeys: readonly string[];
  missingColumnCount: number;
}

export interface ConnectionPrefetchOptions {
  /** Explicit user refreshes bypass the automatic retry circuit. */
  manual?: boolean;
}

export interface MetadataPrefetchTarget extends MetadataStorageReader {
  /** Discard an expired connection snapshot before starting a full refresh. */
  discardExpiredConnectionMetadata?(
    connectionName: string,
    lease?: PrefetchLease,
    expectedPrefetchCompletedAt?: number,
  ): Promise<void>;
  /** Identifier case policy for catalog rows; only Netezza uses exact catalog identity here. */
  isNetezzaConnection?(connectionName: string): boolean;
  isDatabaseDead(connectionName: string, dbName: string | undefined): boolean;
  markDatabaseDead(connectionName: string, dbName: string): void;
  getTables(connectionName: string, key: string): TableMetadata[] | undefined;
  setTables(
    connectionName: string,
    key: string,
    data: TableMetadata[],
    idMap: Map<string, number>,
  ): void;
  markViewsCatalogLoaded(connectionName: string, cacheKey: string): void;
  markPrefetchObjectTypesCatalogLoaded(
    connectionName: string,
    cacheKey: string,
  ): void;
  markProcedureCatalogLoaded(connectionName: string, dbName: string): void;
  isProcedureCatalogLoaded(connectionName: string, dbName: string): boolean;
  getColumns(connectionName: string, key: string): ColumnMetadata[] | undefined;
  setColumns(
    connectionName: string,
    key: string,
    data: ColumnMetadata[],
  ): void;
  getColumnsAnySchema(
    connectionName: string,
    dbName: string,
    tableName: string,
  ): ColumnMetadata[] | undefined;
  ensureColumnsLoaded(
    connectionName: string,
    databaseName: string,
  ): Promise<void>;
  hasTableCacheForConnection(connectionName: string): boolean;
  getCacheTTL(): number;
  whenDiskReady(): Promise<void>;
  isConnectionMetadataHydrating(connectionName: string): boolean;
  whenConnectionMetadataHydrated(connectionName: string): Promise<void>;
  tryAcquirePrefetchLock(connectionName: string): Promise<PrefetchLease | undefined>;
  releasePrefetchLock(lease: PrefetchLease | undefined): Promise<void>;
  isDiskPersistenceEnabled(): boolean;
  verifyStagesComplete(connectionName: string): boolean;
  /** True only when every prefetched table-like object has column metadata. */
  verifyCompleteSnapshot?(connectionName: string): boolean;
  /** Detailed form of verifyCompleteSnapshot for refresh observability. */
  getSnapshotCompletenessReport?(
    connectionName: string,
  ): MetadataSnapshotCompletenessReport;
  /** Uncapped exact column keys used by refresh reconciliation. */
  getMissingColumnLayerKeys?(connectionName: string): readonly string[];
  /** Remove one stale table-like object identified by its exact column-layer key. */
  removeTableObjectByColumnKey?(connectionName: string, columnKey: string): boolean;
  saveConnectionToDiskAfterPrefetch(
    connectionName: string,
    hasError: boolean, lease: PrefetchLease,
  ): Promise<void>;
  getDatabases(connectionName: string): DatabaseMetadata[] | undefined;
  setDatabases(connectionName: string, data: DatabaseMetadata[]): void;
  getSchemas(
    connectionName: string,
    dbName: string,
  ): SchemaMetadata[] | undefined;
  setSchemas(
    connectionName: string,
    dbName: string,
    data: SchemaMetadata[],
  ): void;
  getProcedures(
    connectionName: string,
    key: string,
  ): ProcedureMetadata[] | undefined;
  getProceduresAllSchemas(
    connectionName: string,
    dbName: string,
  ): ProcedureMetadata[] | undefined;
  setProcedures(
    connectionName: string,
    key: string,
    data: ProcedureMetadata[],
  ): void;
  getTypeGroups(connectionName: string, dbName: string): string[] | undefined;
  hasCachedTypeGroups(connectionName: string, dbName: string): boolean;
  setTypeGroups(connectionName: string, dbName: string, types: string[]): void;
  checkpointSave(connectionName: string, lease?: PrefetchLease): Promise<void>;
}
