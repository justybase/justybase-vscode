import type {
  ColumnMetadata,
  DatabaseMetadata,
  PerKeyEntry,
  ProcedureMetadata,
  SchemaMetadata,
  TableMetadata,
} from '../types';
import type { MetadataStorageReader } from './MetadataStorageReader';

/**
 * Cache surface shared by orchestration helpers, disk codecs, and the
 * MetadataCache facade. It deliberately contains no facade import so those
 * helpers remain below the owner in the dependency graph.
 */
export interface MetadataCachePort extends MetadataStorageReader {
  readonly _typeGroupCache: Map<string, PerKeyEntry<string[]>>;
  readonly _schemaCache: Map<string, PerKeyEntry<SchemaMetadata[]>>;
  readonly _tableCache: Map<string, PerKeyEntry<TableMetadata[]>>;
  readonly _columnCache: Map<string, PerKeyEntry<ColumnMetadata[]>>;
  readonly _procedureCache: Map<string, PerKeyEntry<ProcedureMetadata[]>>;

  getRawDatabaseEntry(
    connectionName: string,
  ): PerKeyEntry<DatabaseMetadata[]> | undefined;
  getAllCacheKeys(): string[];
  isNetezzaConnection(connectionName: string): boolean;
  isLargeTableCatalog(connectionName: string, dbName: string): boolean;
  isCacheGenerationCurrent(generation: number): boolean;

  getDatabases(connectionName: string): DatabaseMetadata[] | undefined;
  setDatabases(connectionName: string, data: DatabaseMetadata[]): void;
  getSchemas(connectionName: string, dbName: string): SchemaMetadata[] | undefined;
  setSchemas(connectionName: string, dbName: string, data: SchemaMetadata[]): void;
  getProcedures(connectionName: string, key: string): ProcedureMetadata[] | undefined;
  setProcedures(connectionName: string, key: string, data: ProcedureMetadata[]): void;
  getTables(connectionName: string, key: string): TableMetadata[] | undefined;
  getTablesAllSchemas(connectionName: string, dbName: string): TableMetadata[] | undefined;
  setTables(
    connectionName: string,
    key: string,
    data: TableMetadata[],
    idMap: Map<string, number>,
    options?: { deferIndexes?: boolean },
  ): void;
  getColumns(connectionName: string, key: string): ColumnMetadata[] | undefined;
  setColumns(connectionName: string, key: string, data: ColumnMetadata[]): void;
  getColumnsAnySchema(
    connectionName: string,
    dbName: string,
    tableName: string,
  ): ColumnMetadata[] | undefined;
  ensureColumnsLoadedForTableKey(connectionName: string, layerKey: string): Promise<void>;
  markPrefetchObjectTypesCatalogLoaded(connectionName: string, cacheKey: string): void;
  markProcedureCatalogLoaded(connectionName: string, dbName: string): void;
  markObjectsCatalogLoaded(connectionName: string, layerKey: string, objType: string): void;
  markTableObjectCatalogLoaded?(connectionName: string, layerKey: string, objType: string): void;
  hasCachedTypeGroups(connectionName: string, dbName: string): boolean;
  deriveTypeGroupsFromCache(connectionName: string, dbName: string): string[] | undefined;
  setTypeGroups(connectionName: string, dbName: string, types: string[]): void;
  markDatabaseDead(connectionName: string, dbName: string): void;
  isDatabaseDead(connectionName: string, dbName: string | undefined): boolean;
  hasTableCacheForConnection(connectionName: string): boolean;
  getCacheTTL(): number;
}
