/**
 * Metadata Cache - Main Facade
 * Orchestrates layer access, indexes, invalidation, disk lifecycle, and prefetch.
 */

import * as vscode from 'vscode';
import { CachePrefetcher, QueryRunnerRawFn } from '../prefetch';
import type { MetadataPrefetchProgress } from '../prefetch';
import type { ConnectionManager } from '../../core/connectionManager';
import { searchMetadataIndex, type SearchIndexOptions } from '../searchIndex';
import {
  PerKeyEntry,
  SearchResult,
  CachedObjectInfo,
  ObjectWithSchema,
  DatabaseMetadata,
  SchemaMetadata,
  TableMetadata,
  ProcedureMetadata,
  ColumnMetadata,
} from '../types';
import { getExtensionConfiguration } from '../../compatibility/configuration';
import { Logger } from '../../utils/logger';
import { CacheStatsTracker } from '../cacheStats';
import { buildColumnCacheKey } from '../columnRowMapping';
import { extractLabel } from '../helpers';
import type { CacheStatsSnapshot, CacheLayer } from '../cacheStats';
import {
  MetadataDiskStorage,
  MetadataDiskIndexWatcher,
} from '../diskStorage';
import { supportsLegacyMetadataPrefetch } from '../prefetchSupport';
import type { MetadataPrefetchTarget } from './MetadataPrefetchTarget';
import { DEFAULT_CACHE_TTL_HOURS, MetadataStore } from './MetadataStore';
import { MetadataLayerAccess } from './layerAccess';
import {
  rebuildTableIndexesForConnection,
  ensureTableIndexesBuilt,
} from './tableIndexes';
import { invalidateSchema as invalidateSchemaCore } from './invalidation';
import {
  type ColumnLoaderDeps,
  type ColumnLoaderState,
  ensureColumnsLoaded,
  ensureColumnsLoadedForTableKey,
  preloadColumnsForConnection,
  whenEagerPreloadComplete,
  hasColumnsOnDisk,
  isColumnsLoaded,
  eagerPreloadColumnsIfEnabled,
} from './columnLoader';
import {
  type DiskLifecycleDeps,
  type DiskLifecycleState,
  initializeDiskCache,
  onExternalCacheUpdate,
  startDiskWatcherAfterInit,
} from './diskLifecycle';
import * as prefetchDelegation from './prefetchDelegation';

export type { CacheStatsSnapshot, CacheLayer } from '../cacheStats';
export { PerKeyEntry, CacheType, DatabaseMetadata } from '../types';

export class MetadataCache implements MetadataPrefetchTarget {
  private readonly _store: MetadataStore;
  private readonly _stats = new CacheStatsTracker();
  private readonly _layers: MetadataLayerAccess;

  private readonly _columnLoaderState: ColumnLoaderState = {
    columnsOnDisk: new Map(),
    columnsLoadedDatabases: new Map(),
    columnLoadPromises: new Map(),
    columnLayerLoadPromises: new Map(),
    parsedColumnFileCache: new Map(),
    eagerPreloadPromise: undefined,
    cacheGeneration: 0,
  };

  private readonly _diskLifecycleState: DiskLifecycleState = {
    cacheGeneration: 0,
    columnsOnDisk: this._columnLoaderState.columnsOnDisk,
    deferredIndexConnections: new Set(),
    diskInitPromise: undefined,
    metadataHydratingConnections: new Set(),
    metadataHydratePromises: new Map(),
  };

  private readonly _viewsCatalogLoaded = new Set<string>();
  private readonly _objectsCatalogLoaded = new Set<string>();
  private readonly _invalidatedColumnLayerKeys = new Set<string>();
  private prefetcher: CachePrefetcher;
  private readonly _diskPersistenceEnabled: boolean;
  private readonly _crossWindowSyncEnabled: boolean;
  private _diskStorage: MetadataDiskStorage | undefined;
  private _diskWatcher: MetadataDiskIndexWatcher | undefined;

  private _onDidPrefetchProgress =
    new vscode.EventEmitter<MetadataPrefetchProgress>();
  readonly onDidPrefetchProgress: vscode.Event<MetadataPrefetchProgress> =
    this._onDidPrefetchProgress.event;
  private _onDidInvalidate = new vscode.EventEmitter<void>();
  readonly onDidInvalidate: vscode.Event<void> = this._onDidInvalidate.event;
  private _onDidNeedColumnRecovery = new vscode.EventEmitter<string>();
  readonly onDidNeedColumnRecovery: vscode.Event<string> =
    this._onDidNeedColumnRecovery.event;
  private _onDidExternalRefresh = new vscode.EventEmitter<string>();
  readonly onDidExternalRefresh: vscode.Event<string> =
    this._onDidExternalRefresh.event;

  constructor(
    context: vscode.ExtensionContext,
    private readonly _connectionManager?: ConnectionManager,
  ) {
    const config = getExtensionConfiguration();
    const ttlHours =
      config.get<number>('cacheTTL', DEFAULT_CACHE_TTL_HOURS) ??
      DEFAULT_CACHE_TTL_HOURS;
    this._store = new MetadataStore(ttlHours);

    this._diskPersistenceEnabled =
      config.get<boolean>('metadataCache.diskPersistence', true) ?? true;
    this._crossWindowSyncEnabled =
      config.get<boolean>('metadataCache.crossWindowSync', true) ?? true;

    if (this._diskPersistenceEnabled && context.globalStorageUri) {
      this._diskStorage = new MetadataDiskStorage(
        context.globalStorageUri.fsPath,
        _connectionManager,
      );

      if (this._crossWindowSyncEnabled) {
        this._diskWatcher = new MetadataDiskIndexWatcher(
          context.globalStorageUri.fsPath,
          (changedConnections) =>
            void this.onExternalCacheUpdate(changedConnections),
          (error) => {
            Logger.getInstance().warn(
              `[MetadataDisk] Watcher error: ${error.message}`,
            );
          },
        );
      }
    }

    this._layers = new MetadataLayerAccess({
      store: this._store,
      stats: this._stats,
      viewsCatalogLoaded: this._viewsCatalogLoaded,
      objectsCatalogLoaded: this._objectsCatalogLoaded,
      deferredIndexConnections: this._diskLifecycleState.deferredIndexConnections,
      connectionManager: this._connectionManager,
      isEntryValid: (timestamp) => this._store.isEntryValid(timestamp),
    });

    this.prefetcher = new CachePrefetcher(this, (progress) => {
      this._onDidPrefetchProgress.fire(progress);
    });
  }

  private get columnLoaderDeps(): ColumnLoaderDeps {
    return {
      state: this._columnLoaderState,
      diskStorage: this._diskStorage,
      prefetcher: this.prefetcher,
      cache: this,
      isCacheGenerationCurrent: (generation) =>
        this.isCacheGenerationCurrent(generation),
      onNeedColumnRecovery: (connectionName) =>
        this._onDidNeedColumnRecovery.fire(connectionName),
    };
  }

  private get diskLifecycleDeps(): DiskLifecycleDeps {
    return {
      state: this._diskLifecycleState,
      columnLoaderState: this._columnLoaderState,
      store: this._store,
      diskStorage: this._diskStorage,
      diskWatcher: this._diskWatcher,
      prefetcher: this.prefetcher,
      cache: this,
      connectionManager: this._connectionManager,
      columnLoaderDeps: this.columnLoaderDeps,
      isDiskPersistenceEnabled: () => this.isDiskPersistenceEnabled(),
      isCacheGenerationCurrent: (generation) =>
        this.isCacheGenerationCurrent(generation),
      onExternalRefresh: (connectionName) =>
        this._onDidExternalRefresh.fire(connectionName),
      hasConnectionPrefetchInProgress: (connectionName) =>
        this.hasConnectionPrefetchInProgress(connectionName),
      loadColumnsForDatabase: (connectionName, databaseName) =>
        ensureColumnsLoaded(this.columnLoaderDeps, connectionName, databaseName),
      columnsLoadedDatabases: this._columnLoaderState.columnsLoadedDatabases,
    };
  }

  private get prefetchDeps(): prefetchDelegation.PrefetchDelegationDeps {
    return {
      prefetcher: this.prefetcher,
      store: this._store,
      diskStorage: this._diskStorage,
      isDiskPersistenceEnabled: () => this.isDiskPersistenceEnabled(),
    };
  }

  getCacheTTL(): number {
    return this._store.cacheTtl;
  }

  markDatabaseDead(connectionName: string, dbName: string): void {
    const upper = dbName.toUpperCase();
    let set = this._store.deadDatabases.get(connectionName);
    if (!set) {
      set = new Set();
      this._store.deadDatabases.set(connectionName, set);
    }
    if (!set.has(upper)) {
      set.add(upper);
      Logger.getInstance().info(
        `[MetadataCache] Database marked as non-existent: ${dbName} (connection: ${connectionName})`,
      );
    }
  }

  isDatabaseDead(connectionName: string, dbName: string | undefined): boolean {
    if (!dbName) return false;
    return (
      this._store.deadDatabases.get(connectionName)?.has(dbName.toUpperCase()) ??
      false
    );
  }

  private getTotalEntryCount(): number {
    return this._store.getTotalEntryCount();
  }

  isCacheGenerationCurrent(expectedGeneration: number): boolean {
    return this._diskLifecycleState.cacheGeneration === expectedGeneration;
  }

  isDiskPersistenceEnabled(): boolean {
    return (
      this._diskPersistenceEnabled
      && this._diskStorage !== undefined
      && !this._diskStorage.isSessionDisabled()
    );
  }

  isCrossWindowSyncEnabled(): boolean {
    return this._crossWindowSyncEnabled;
  }

  async initialize(): Promise<void> {
    if (!this._diskLifecycleState.diskInitPromise) {
      this._diskLifecycleState.diskInitPromise = initializeDiskCache(
        this.diskLifecycleDeps,
      );
    }
    startDiskWatcherAfterInit(
      this._diskWatcher,
      this._diskLifecycleState.diskInitPromise,
    );
    return this._diskLifecycleState.diskInitPromise;
  }

  whenDiskReady(): Promise<void> {
    return this.initialize();
  }

  isConnectionMetadataHydrating(connectionName: string): boolean {
    return this._diskLifecycleState.metadataHydratingConnections.has(connectionName);
  }

  async whenConnectionMetadataHydrated(connectionName: string): Promise<void> {
    await this._diskLifecycleState.metadataHydratePromises.get(connectionName);
  }

  hasColumnsOnDisk(connectionName: string, databaseName: string): boolean {
    return hasColumnsOnDisk(this._columnLoaderState, connectionName, databaseName);
  }

  isColumnsLoaded(connectionName: string, databaseName: string): boolean {
    return isColumnsLoaded(this._columnLoaderState, connectionName, databaseName);
  }

  async ensureColumnsLoaded(
    connectionName: string,
    databaseName: string,
  ): Promise<void> {
    return ensureColumnsLoaded(
      this.columnLoaderDeps,
      connectionName,
      databaseName,
    );
  }

  isLargeTableCatalog(connectionName: string, dbName: string): boolean {
    return this._layers.isLargeTableCatalog(connectionName, dbName);
  }

  async ensureColumnsLoadedForTableKey(
    connectionName: string,
    layerKey: string,
  ): Promise<void> {
    if (this._invalidatedColumnLayerKeys.has(`${connectionName}|${layerKey}`)) {
      return;
    }
    return ensureColumnsLoadedForTableKey(
      this.columnLoaderDeps,
      connectionName,
      layerKey,
    );
  }

  async preloadColumnsForConnection(
    connectionName: string,
    options?: { concurrency?: number },
  ): Promise<void> {
    return preloadColumnsForConnection(
      this.columnLoaderDeps,
      connectionName,
      options,
    );
  }

  async eagerPreloadColumnsIfEnabled(): Promise<void> {
    return eagerPreloadColumnsIfEnabled(this.columnLoaderDeps);
  }

  async whenEagerPreloadComplete(): Promise<void> {
    return whenEagerPreloadComplete(this._columnLoaderState);
  }

  rebuildTableIndexesForConnection(connectionName: string): void {
    rebuildTableIndexesForConnection(
      this._store,
      this._diskLifecycleState.deferredIndexConnections,
      connectionName,
    );
  }

  hasTableCacheForConnection(connectionName: string): boolean {
    const prefix = `${connectionName}|`;
    for (const [key, entry] of this._store.tableCache) {
      if (key.startsWith(prefix) && entry.data.length > 0) {
        return true;
      }
    }
    return false;
  }

  async dispose(): Promise<void> {
    if (this._diskWatcher) {
      this._diskWatcher.stop();
    }

    if (this.isDiskPersistenceEnabled() && this._diskStorage) {
      await this._diskStorage.lock.releaseAllOwned();
      try {
        await this._diskStorage.saveAll(
          this,
          this.prefetcher.getConnectionPrefetchTimestamps(),
        );
      } catch (error: unknown) {
        Logger.getInstance().warn(
          '[MetadataCache] Failed to save cache on dispose',
          error,
        );
      } finally {
        await this._diskStorage.lock.releaseAllOwned();
        await this._diskStorage.lock.deleteAllLockFiles();
      }
    }

    this._onDidPrefetchProgress.dispose();
    this._onDidInvalidate.dispose();
    this._onDidNeedColumnRecovery.dispose();
    this._onDidExternalRefresh.dispose();
    this._stats.clearAll();
  }

  async clearCache(): Promise<void> {
    this._diskLifecycleState.cacheGeneration++;
    this._columnLoaderState.cacheGeneration =
      this._diskLifecycleState.cacheGeneration;
    const entryCount = this.getTotalEntryCount();
    Logger.getInstance().info(
      `[MetadataCache] Clearing all caches (${entryCount} entries across all maps)`,
    );
    this._store.clearLayerMaps();
    this._columnLoaderState.columnsOnDisk.clear();
    this._columnLoaderState.columnsLoadedDatabases.clear();
    this._columnLoaderState.columnLoadPromises.clear();
    this._columnLoaderState.columnLayerLoadPromises.clear();
    this._columnLoaderState.parsedColumnFileCache.clear();
    this._diskLifecycleState.deferredIndexConnections.clear();
    this._diskLifecycleState.metadataHydratingConnections.clear();
    this._diskLifecycleState.metadataHydratePromises.clear();
    this._viewsCatalogLoaded.clear();
    this._objectsCatalogLoaded.clear();
    this._invalidatedColumnLayerKeys.clear();
    this.prefetcher.reset();
    this._stats.clearAll();
    this._onDidInvalidate.fire();

    if (this.isDiskPersistenceEnabled() && this._diskStorage) {
      await this._diskStorage.deleteCacheFile();
    }
  }

  getDatabases(connectionName: string): DatabaseMetadata[] | undefined {
    return this._layers.getDatabases(connectionName);
  }

  setDatabases(connectionName: string, data: DatabaseMetadata[]): void {
    this._layers.setDatabases(connectionName, data);
  }

  getSchemas(
    connectionName: string,
    dbName: string,
  ): SchemaMetadata[] | undefined {
    return this._layers.getSchemas(connectionName, dbName);
  }

  setSchemas(
    connectionName: string,
    dbName: string,
    data: SchemaMetadata[],
  ): void {
    this._layers.setSchemas(connectionName, dbName, data);
  }

  getCurrentSchema(
    connectionName: string,
    dbName: string,
  ): string | undefined {
    const key = `${connectionName}|${dbName.toUpperCase()}`;
    const entry = this._store.currentSchemaCache.get(key);
    if (!entry) {
      this._stats.recordMiss(connectionName, "schema");
      return undefined;
    }
    if (!this._store.isEntryValid(entry.timestamp)) {
      this._store.currentSchemaCache.delete(key);
      this._stats.recordTtlEviction(connectionName, "schema");
      return undefined;
    }
    this._stats.recordHit(connectionName, "schema");
    return entry.data;
  }

  setCurrentSchema(
    connectionName: string,
    dbName: string,
    schemaName: string,
  ): void {
    const normalizedSchema = schemaName.trim();
    if (!normalizedSchema) {
      return;
    }
    this._store.currentSchemaCache.set(
      `${connectionName}|${dbName.toUpperCase()}`,
      { data: normalizedSchema, timestamp: Date.now() },
    );
  }

  invalidateCurrentSchema(connectionName: string, dbName?: string): void {
    if (dbName) {
      this._store.currentSchemaCache.delete(
        `${connectionName}|${dbName.toUpperCase()}`,
      );
      return;
    }

    const prefix = `${connectionName}|`;
    for (const key of Array.from(this._store.currentSchemaCache.keys())) {
      if (key.startsWith(prefix)) {
        this._store.currentSchemaCache.delete(key);
      }
    }
  }

  getDefaultSchema(
    connectionName: string,
    dbName: string,
  ): string | undefined {
    const key = `${connectionName}|${dbName.toUpperCase()}`;
    const entry = this._store.defaultSchemaCache.get(key);
    if (!entry) {
      this._stats.recordMiss(connectionName, "schema");
      return undefined;
    }
    if (!this._store.isEntryValid(entry.timestamp)) {
      this._store.defaultSchemaCache.delete(key);
      this._stats.recordTtlEviction(connectionName, "schema");
      return undefined;
    }
    this._stats.recordHit(connectionName, "schema");
    return entry.data;
  }

  setDefaultSchema(
    connectionName: string,
    dbName: string,
    schemaName: string,
  ): void {
    const normalizedSchema = schemaName.trim();
    if (!normalizedSchema) {
      return;
    }
    this._store.defaultSchemaCache.set(
      `${connectionName}|${dbName.toUpperCase()}`,
      { data: normalizedSchema, timestamp: Date.now() },
    );
  }

  getNetezzaSchemasEnabled(connectionName: string): boolean | undefined {
    const entry = this._store.netezzaSchemasEnabledCache.get(connectionName);
    if (!entry) {
      this._stats.recordMiss(connectionName, "schema");
      return undefined;
    }
    if (!this._store.isEntryValid(entry.timestamp)) {
      this._store.netezzaSchemasEnabledCache.delete(connectionName);
      this._stats.recordTtlEviction(connectionName, "schema");
      return undefined;
    }
    this._stats.recordHit(connectionName, "schema");
    return entry.data;
  }

  setNetezzaSchemasEnabled(connectionName: string, enabled: boolean): void {
    this._store.netezzaSchemasEnabledCache.set(connectionName, {
      data: enabled,
      timestamp: Date.now(),
    });
  }

  invalidateNetezzaSchemasEnabled(connectionName: string): void {
    this._store.netezzaSchemasEnabledCache.delete(connectionName);
  }

  getProcedures(
    connectionName: string,
    key: string,
  ): ProcedureMetadata[] | undefined {
    return this._layers.getProcedures(connectionName, key);
  }

  getProceduresAllSchemas(
    connectionName: string,
    dbName: string,
  ): ProcedureMetadata[] | undefined {
    return this._layers.getProceduresAllSchemas(connectionName, dbName);
  }

  getProceduresForDatabase(
    connectionName: string,
    dbName: string,
  ): ProcedureMetadata[] | undefined {
    return this._layers.getProceduresForDatabase(connectionName, dbName);
  }

  setProcedures(
    connectionName: string,
    key: string,
    data: ProcedureMetadata[],
  ): void {
    this._layers.setProcedures(connectionName, key, data);
  }

  getTables(connectionName: string, key: string): TableMetadata[] | undefined {
    return this._layers.getTables(connectionName, key);
  }

  isViewsCatalogLoaded(connectionName: string, cacheKey: string): boolean {
    return this._layers.isViewsCatalogLoaded(connectionName, cacheKey);
  }

  markViewsCatalogLoaded(connectionName: string, cacheKey: string): void {
    this._layers.markViewsCatalogLoaded(connectionName, cacheKey);
  }

  areViewsCatalogLoadedForDatabase(
    connectionName: string,
    dbName: string,
  ): boolean {
    return this._layers.areViewsCatalogLoadedForDatabase(
      connectionName,
      dbName,
    );
  }

  isObjectsCatalogLoaded(
    connectionName: string,
    layerKey: string,
    objType: string,
  ): boolean {
    return this._layers.isObjectsCatalogLoaded(connectionName, layerKey, objType);
  }

  markObjectsCatalogLoaded(
    connectionName: string,
    layerKey: string,
    objType: string,
  ): void {
    this._layers.markObjectsCatalogLoaded(connectionName, layerKey, objType);
  }

  markPrefetchObjectTypesCatalogLoaded(
    connectionName: string,
    layerKey: string,
  ): void {
    this._layers.markPrefetchObjectTypesCatalogLoaded(connectionName, layerKey);
  }

  isProcedureCatalogLoaded(
    connectionName: string,
    dbName: string,
  ): boolean {
    return this._layers.isProcedureCatalogLoaded(connectionName, dbName);
  }

  markProcedureCatalogLoaded(
    connectionName: string,
    dbName: string,
  ): void {
    this._layers.markProcedureCatalogLoaded(connectionName, dbName);
  }

  areObjectsCatalogLoadedForDatabase(
    connectionName: string,
    dbName: string,
    objType: string,
  ): boolean {
    return this._layers.areObjectsCatalogLoadedForDatabase(
      connectionName,
      dbName,
      objType,
    );
  }

  deriveTypeGroupsFromCache(
    connectionName: string,
    dbName: string,
  ): string[] | undefined {
    return this._layers.deriveTypeGroupsFromCache(connectionName, dbName);
  }

  getTablesAllSchemas(
    connectionName: string,
    dbName: string,
  ): TableMetadata[] | undefined {
    return this._layers.getTablesAllSchemas(connectionName, dbName);
  }

  setTables(
    connectionName: string,
    key: string,
    data: TableMetadata[],
    idMap: Map<string, number>,
    options?: { deferIndexes?: boolean },
  ): void {
    this._layers.setTables(connectionName, key, data, idMap, options);
  }

  getObjectsWithSchema(
    connectionName: string,
    dbName: string,
  ): ObjectWithSchema[] {
    return this._layers.getObjectsWithSchema(connectionName, dbName);
  }

  getObjectsByType(
    connectionName: string,
    dbName: string,
    objType: string,
  ): ObjectWithSchema[] | undefined {
    return this._layers.getObjectsByType(connectionName, dbName, objType);
  }

  getColumns(
    connectionName: string,
    key: string,
  ): ColumnMetadata[] | undefined {
    return this._layers.getColumns(connectionName, key);
  }

  setColumns(
    connectionName: string,
    key: string,
    data: ColumnMetadata[],
  ): void {
    this._invalidatedColumnLayerKeys.delete(`${connectionName}|${key}`);
    this._layers.setColumns(connectionName, key, data);
  }

  invalidateTableColumns(
    connectionName: string,
    database: string,
    schema: string,
    tableName: string,
  ): void {
    const directKey = buildColumnCacheKey(database, schema, tableName);
    const aggregateKey = buildColumnCacheKey(database, undefined, tableName);
    this._store.columnCache.delete(`${connectionName}|${directKey}`);
    this._store.columnCache.delete(`${connectionName}|${aggregateKey}`);
    this._invalidatedColumnLayerKeys.add(`${connectionName}|${directKey}`);
    this._invalidatedColumnLayerKeys.add(`${connectionName}|${aggregateKey}`);
  }

  /** Notify tree/LSP subscribers after a precise cache mutation. */
  notifyMetadataChanged(): void {
    this._onDidInvalidate.fire();
  }

  getColumnsAnySchema(
    connectionName: string,
    dbName: string,
    tableName: string,
  ): ColumnMetadata[] | undefined {
    return this._layers.getColumnsAnySchema(connectionName, dbName, tableName);
  }

  findTableId(connectionName: string, lookupKey: string): number | undefined {
    ensureTableIndexesBuilt(
      this._store,
      this._diskLifecycleState.deferredIndexConnections,
      connectionName,
    );
    return this._layers.findTableId(connectionName, lookupKey);
  }

  getTypeGroups(connectionName: string, dbName: string): string[] | undefined {
    return this._layers.getTypeGroups(connectionName, dbName);
  }

  hasCachedTypeGroups(connectionName: string, dbName: string): boolean {
    return this._layers.hasCachedTypeGroups(connectionName, dbName);
  }

  setTypeGroups(connectionName: string, dbName: string, types: string[]): void {
    this._layers.setTypeGroups(connectionName, dbName, types);
  }

  findObjectWithType(
    connectionName: string,
    dbName: string,
    schemaName: string | undefined,
    objectName: string,
  ): CachedObjectInfo | undefined {
    ensureTableIndexesBuilt(
      this._store,
      this._diskLifecycleState.deferredIndexConnections,
      connectionName,
    );
    return this._layers.findObjectWithType(
      connectionName,
      dbName,
      schemaName,
      objectName,
    );
  }

  invalidateSchema(
    connectionName: string,
    dbName: string,
    schemaName?: string,
  ): void {
    invalidateSchemaCore(
      {
        store: this._store,
        stats: this._stats,
        viewsCatalogLoaded: this._viewsCatalogLoaded,
        objectsCatalogLoaded: this._objectsCatalogLoaded,
        isEntryValid: (timestamp) => this._store.isEntryValid(timestamp),
        onInvalidated: () => this._onDidInvalidate.fire(),
      },
      connectionName,
      dbName,
      schemaName,
    );
    this.invalidateCurrentSchema(connectionName, dbName);
  }

  search(term: string, connectionName?: string, options?: SearchIndexOptions): SearchResult[] {
    return searchMetadataIndex(this, term, { ...options, connectionName: connectionName ?? options?.connectionName });
  }

  private getEntriesByLayer(): Record<CacheLayer, number> {
    return {
      database: this._store.dbCache.size,
      schema: this._store.schemaCache.size,
      table: this._store.tableCache.size,
      column: this._store.columnCache.size,
      procedure: this._store.procedureCache.size,
      typeGroup: this._store.typeGroupCache.size,
      objectsByType: this._store.objectsByTypeCache.size,
      objectLookup: this._store.objectLookupIndex.size,
    };
  }

  getStatsSnapshot(connectionName: string): CacheStatsSnapshot | undefined {
    const entriesByLayer = this.getEntriesByLayer();
    for (const [layer, count] of Object.entries(entriesByLayer)) {
      this._stats.recordEntriesByLayer(connectionName, layer as CacheLayer, count);
    }
    const snapshot = this._stats.getSnapshot(connectionName, this.getTotalEntryCount());
    if (!snapshot) {
      return snapshot;
    }

    const config = getExtensionConfiguration();
    const memoryBudget =
      config.get<number>('metadataCache.memoryWarningBytes', 268_435_456) ??
      268_435_456;
    if (
      memoryBudget > 0 &&
      snapshot.estimatedMemoryBytes > memoryBudget
    ) {
      Logger.getInstance().warn(
        `[MetadataCache] Estimated memory ${snapshot.estimatedMemoryBytes} bytes exceeds budget ${memoryBudget} for ${connectionName}`,
      );
    }
    return snapshot;
  }

  logStats(connectionName: string): void {
    const entriesByLayer = this.getEntriesByLayer();
    for (const [layer, count] of Object.entries(entriesByLayer)) {
      this._stats.recordEntriesByLayer(connectionName, layer as CacheLayer, count);
    }
    this._stats.logSummary(connectionName, this.getTotalEntryCount());
  }

  async prefetchColumnsForSchema(
    connectionName: string,
    dbName: string,
    schemaName: string | undefined,
    runQueryFn: QueryRunnerRawFn,
  ): Promise<void> {
    return prefetchDelegation.prefetchColumnsForSchema(
      this.prefetchDeps,
      connectionName,
      dbName,
      schemaName,
      runQueryFn,
    );
  }

  async prefetchAllObjects(
    connectionName: string,
    runQueryFn: QueryRunnerRawFn,
    databases?: string[],
  ): Promise<void> {
    return prefetchDelegation.prefetchAllObjects(
      this.prefetchDeps,
      connectionName,
      runQueryFn,
      databases,
    );
  }

  hasAllObjectsPrefetchTriggered(connectionName: string): boolean {
    return prefetchDelegation.hasAllObjectsPrefetchTriggered(
      this.prefetchDeps,
      connectionName,
    );
  }

  hasConnectionPrefetchTriggered(connectionName: string): boolean {
    return prefetchDelegation.hasConnectionPrefetchTriggered(
      this.prefetchDeps,
      connectionName,
    );
  }

  isConnectionPrefetchFresh(connectionName: string): boolean {
    return prefetchDelegation.isConnectionPrefetchFresh(
      this.prefetchDeps,
      connectionName,
    );
  }

  async tryAcquirePrefetchLock(connectionName: string): Promise<boolean> {
    return prefetchDelegation.tryAcquirePrefetchLock(
      this.prefetchDeps,
      connectionName,
    );
  }

  hasConnectionPrefetchInProgress(connectionName: string): boolean {
    return prefetchDelegation.hasConnectionPrefetchInProgress(
      this.prefetchDeps,
      connectionName,
    );
  }

  async releasePrefetchLock(connectionName: string): Promise<void> {
    return prefetchDelegation.releasePrefetchLock(
      this.prefetchDeps,
      connectionName,
    );
  }

  private async onExternalCacheUpdate(
    connectionNames: string[],
  ): Promise<void> {
    return onExternalCacheUpdate(this.diskLifecycleDeps, connectionNames);
  }

  verifyStagesComplete(connectionName: string): boolean {
    const dbEntry = this._store.dbCache.get(connectionName);
    if (!dbEntry || dbEntry.data.length === 0) {
      return false;
    }

    const prefix = `${connectionName}|`;
    const hasLayer = (
      cache: Map<string, PerKeyEntry<readonly unknown[]>>,
    ): boolean => {
      for (const [key, entry] of cache) {
        if (key.startsWith(prefix) && entry.data.length > 0) {
          return true;
        }
      }
      return false;
    };

    const hasProcedureLayer = (): boolean => {
      for (const [key] of this._store.procedureCache) {
        if (key.startsWith(prefix)) {
          return true;
        }
      }
      return false;
    };

    return (
      hasLayer(this._store.schemaCache)
      && hasLayer(this._store.tableCache)
      && hasProcedureLayer()
    );
  }

  verifyCompleteSnapshot(connectionName: string): boolean {
    if (!this.verifyStagesComplete(connectionName)) {
      return false;
    }

    const prefix = `${connectionName}|`;
    for (const [fullKey, entry] of this._store.tableCache) {
      if (!fullKey.startsWith(prefix)) {
        continue;
      }
      const layerKey = fullKey.slice(prefix.length);
      const [dbName, schemaName = ''] = layerKey.split('.');
      if (!dbName) {
        continue;
      }

      for (const table of entry.data) {
        const objType = String(table.objType ?? table.TYPE ?? '').toUpperCase();
        if (
          objType !== 'TABLE'
          && objType !== 'VIEW'
          && objType !== 'EXTERNAL TABLE'
        ) {
          continue;
        }
        const tableName = extractLabel(table);
        if (!tableName) {
          continue;
        }
        const schema = typeof table.SCHEMA === 'string' && table.SCHEMA.trim().length > 0
          ? table.SCHEMA
          : schemaName;
        const columnKey = buildColumnCacheKey(dbName, schema || undefined, tableName);
        if (!this._store.columnCache.has(`${connectionName}|${columnKey}`)) {
          Logger.getInstance().warn(
            `[MetadataCache] Snapshot incomplete for ${connectionName}: missing columns for ${columnKey}`,
          );
          return false;
        }
      }
    }

    return true;
  }

  async checkpointSave(connectionName: string): Promise<void> {
    if (!this.isDiskPersistenceEnabled() || !this._diskStorage) {
      return;
    }

    const prefetchCompletedAt = Date.now();
    this._diskWatcher?.markConnection(connectionName, prefetchCompletedAt);
    await this._diskStorage.saveConnection(
      this,
      connectionName,
      prefetchCompletedAt,
      { isComplete: false },
    );
    Logger.getInstance().debug(
      `[MetadataCache] Checkpoint saved for ${connectionName}`,
    );
  }

  async saveConnectionToDiskAfterPrefetch(
    connectionName: string,
    hadError: boolean,
  ): Promise<void> {
    if (
      hadError
      || !this.isDiskPersistenceEnabled()
      || !this._diskStorage
      || !supportsLegacyMetadataPrefetch(
        this._connectionManager?.getConnectionDatabaseKind(connectionName),
      )
    ) {
      return;
    }

    if (!this.verifyCompleteSnapshot(connectionName)) {
      return;
    }

    const prefetchCompletedAt =
      this.prefetcher.getConnectionPrefetchTimestamp(connectionName) ??
      Date.now();
    this._diskWatcher?.markConnection(connectionName, prefetchCompletedAt);
    this._diskStorage.scheduleSave(
      this,
      connectionName,
      prefetchCompletedAt,
      { isComplete: true },
    );
  }

  triggerConnectionPrefetch(
    connectionName: string,
    runQueryFn: QueryRunnerRawFn,
  ): void {
    prefetchDelegation.triggerConnectionPrefetch(
      this.prefetchDeps,
      connectionName,
      runQueryFn,
    );
  }

  triggerFullColumnPrefetch(
    connectionName: string,
    runQueryFn: QueryRunnerRawFn,
  ): void {
    this.prefetcher.triggerFullColumnPrefetch(connectionName, runQueryFn);
  }

  getRawDatabaseEntry(
    connectionName: string,
  ): { data: DatabaseMetadata[]; timestamp: number } | undefined {
    return this._store.dbCache.get(connectionName);
  }

  getAllCacheKeys(): string[] {
    const keys = new Set<string>();
    for (const key of this._store.dbCache.keys()) {
      keys.add(key);
    }
    for (const key of this._store.schemaCache.keys()) {
      keys.add(key);
    }
    for (const key of this._store.tableCache.keys()) {
      keys.add(key);
    }
    for (const key of this._store.columnCache.keys()) {
      keys.add(key);
    }
    for (const key of this._store.procedureCache.keys()) {
      keys.add(key);
    }
    for (const key of this._store.typeGroupCache.keys()) {
      keys.add(key);
    }
    return [...keys];
  }

  async prefetchColumnsForDatabase(
    connectionName: string,
    dbName: string,
    runQueryFn: QueryRunnerRawFn,
  ): Promise<void> {
    return prefetchDelegation.prefetchColumnsForDatabase(
      this.prefetchDeps,
      connectionName,
      dbName,
      runQueryFn,
    );
  }

  public get _typeGroupCache(): Map<string, PerKeyEntry<string[]>> {
    return this._store.typeGroupCache;
  }

  public get _objectsByTypeCache(): Map<
    string,
    PerKeyEntry<ObjectWithSchema[]>
  > {
    return this._store.objectsByTypeCache;
  }

  public get _schemaCache(): Map<string, PerKeyEntry<SchemaMetadata[]>> {
    return this._store.schemaCache;
  }

  public get _tableCache(): Map<string, PerKeyEntry<TableMetadata[]>> {
    return this._store.tableCache;
  }

  public get _columnCache(): Map<string, PerKeyEntry<ColumnMetadata[]>> {
    return this._store.columnCache;
  }

  public get _procedureCache(): Map<string, PerKeyEntry<ProcedureMetadata[]>> {
    return this._store.procedureCache;
  }

  public get _tableIdMap(): Map<string, PerKeyEntry<Map<string, number>>> {
    return this._store.tableIdMap;
  }

  get dbCache(): Map<string, { data: DatabaseMetadata[]; timestamp: number }> {
    return this._store.dbCache;
  }

  get schemaCache(): Map<string, PerKeyEntry<SchemaMetadata[]>> {
    return this._store.schemaCache;
  }

  get tableCache(): Map<string, PerKeyEntry<TableMetadata[]>> {
    return this._store.tableCache;
  }

  get procedureCache(): Map<string, PerKeyEntry<ProcedureMetadata[]>> {
    return this._store.procedureCache;
  }

  get columnCache(): Map<string, PerKeyEntry<ColumnMetadata[]>> {
    return this._store.columnCache;
  }

  get tableIdMap(): Map<string, PerKeyEntry<Map<string, number>>> {
    return this._store.tableIdMap;
  }

  get typeGroupCache(): Map<string, PerKeyEntry<string[]>> {
    return this._store.typeGroupCache;
  }
}
