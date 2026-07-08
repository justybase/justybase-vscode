/**
 * Cache layer get/set operations (database through object lookup).
 */

import type { ConnectionManager } from '../../core/connectionManager';
import { getDatabaseMetadataProvider } from '../../core/connectionFactory';
import { Logger } from '../../utils/logger';
import type { CacheStatsTracker } from '../cacheStats';
import {
  extractLabel,
  buildIdLookupKey,
  normalizeDbSchemaLookupKey,
} from '../helpers';
import { normalizeTableNameForColumnCacheKey } from '../columnRowMapping';
import type {
  CachedObjectInfo,
  ColumnMetadata,
  DatabaseMetadata,
  ObjectWithSchema,
  ProcedureMetadata,
  SchemaMetadata,
  TableMetadata,
} from '../types';
import { invalidateObjectsByTypeForDb, removeProcedureCacheEntry } from './invalidation';
import type { MetadataStore } from './MetadataStore';
import {
  addTableIndexes,
  ensureTableIndexesBuilt,
  evictStaleTableCacheEntries,
  removeTableCacheEntry as removeTableCacheEntryCore,
  removeTableIndexes,
  resolveTableSchemaName,
  restoreTableNameOnlyIndexes,
} from './tableIndexes';
import { LARGE_DB_TABLE_LIKE_OBJECT_THRESHOLD, buildObjectsCatalogLoadedKey, buildProcedureCatalogLoadedKey } from './schemaTreeDataSource';
import { NZ_PREFETCH_CATALOG_OBJECT_TYPES } from '../../dialects/netezza/metadata/systemQueries';

export interface LayerAccessDeps {
  store: MetadataStore;
  stats: CacheStatsTracker;
  viewsCatalogLoaded: Set<string>;
  objectsCatalogLoaded: Set<string>;
  deferredIndexConnections: Set<string>;
  connectionManager: ConnectionManager | undefined;
  isEntryValid: (timestamp: number) => boolean;
}

function reviveDatabasesFromCatalog(
  store: MetadataStore,
  connectionName: string,
  databases: DatabaseMetadata[],
): void {
  const deadSet = store.deadDatabases.get(connectionName);
  if (!deadSet || deadSet.size === 0) {
    return;
  }

  for (const db of databases) {
    const dbName = db.DATABASE || extractLabel(db);
    if (dbName) {
      deadSet.delete(dbName.toUpperCase());
    }
  }

  if (deadSet.size === 0) {
    store.deadDatabases.delete(connectionName);
  }
}

function getDefaultTypeGroups(
  connectionManager: ConnectionManager | undefined,
  connectionName?: string,
): string[] {
  const kind =
    connectionManager?.getConnectionDatabaseKind(connectionName);
  return [...getDatabaseMetadataProvider(kind).defaultObjectTypes];
}

function mergeTypeGroupsWithDefaults(
  connectionManager: ConnectionManager | undefined,
  connectionName: string,
  types: readonly string[],
): string[] {
  const merged = getDefaultTypeGroups(connectionManager, connectionName);
  const seen = new Set(merged.map((type) => type.toUpperCase()));

  for (const type of types) {
    const normalizedType = type.trim().toUpperCase();
    if (!normalizedType || seen.has(normalizedType)) {
      continue;
    }
    seen.add(normalizedType);
    merged.push(normalizedType);
  }

  return merged;
}

export class MetadataLayerAccess {
  constructor(private readonly deps: LayerAccessDeps) {}

  private removeTableCacheEntry(fullKey: string): void {
    removeTableCacheEntryCore(
      this.deps.store,
      this.deps.stats,
      this.deps.viewsCatalogLoaded,
      this.deps.objectsCatalogLoaded,
      this.deps.isEntryValid,
      fullKey,
    );
  }

  private evictStaleTableCacheEntries(
    connectionName: string,
    staleKeys: Iterable<string>,
  ): void {
    evictStaleTableCacheEntries(
      this.deps.stats,
      connectionName,
      staleKeys,
      (key) => this.removeTableCacheEntry(key),
    );
  }

  // ========== Database Operations ==========

  getDatabases(connectionName: string): DatabaseMetadata[] | undefined {
    const entry = this.deps.store.dbCache.get(connectionName);
    if (!entry) {
      this.deps.stats.recordMiss(connectionName, "database");
      return undefined;
    }
    if (!this.deps.isEntryValid(entry.timestamp)) {
      this.deps.store.dbCache.delete(connectionName);
      this.deps.stats.recordTtlEviction(connectionName, "database");
      return undefined;
    }
    this.deps.stats.recordHit(connectionName, "database");
    return entry.data;
  }

  setDatabases(connectionName: string, data: DatabaseMetadata[]): void {
    const startMs = Date.now();
    reviveDatabasesFromCatalog(this.deps.store, connectionName, data);
    this.deps.store.dbCache.set(connectionName, { data, timestamp: startMs });
    this.deps.stats.recordRefresh(
      connectionName,
      "database",
      connectionName,
      Date.now() - startMs,
      data.length,
    );
  }

  // ========== Schema Operations ==========

  getSchemas(
    connectionName: string,
    dbName: string,
  ): SchemaMetadata[] | undefined {
    const key = `${connectionName}|${dbName}`;
    const entry = this.deps.store.schemaCache.get(key);
    if (!entry) {
      this.deps.stats.recordMiss(connectionName, "schema");
      return undefined;
    }
    if (!this.deps.isEntryValid(entry.timestamp)) {
      this.deps.store.schemaCache.delete(key);
      this.deps.stats.recordTtlEviction(connectionName, "schema");
      return undefined;
    }
    this.deps.stats.recordHit(connectionName, "schema");
    return entry.data;
  }

  setSchemas(
    connectionName: string,
    dbName: string,
    data: SchemaMetadata[],
  ): void {
    const startMs = Date.now();
    const key = `${connectionName}|${dbName}`;
    this.deps.store.schemaCache.set(key, { data, timestamp: startMs });
    this.deps.stats.recordRefresh(
      connectionName,
      "schema",
      dbName,
      Date.now() - startMs,
      data.length,
    );
  }

  // ========== Procedure Operations ==========

  getProcedures(
    connectionName: string,
    key: string,
  ): ProcedureMetadata[] | undefined {
    // incoming key is DB.SCHEMA or DB..
    const fullKey = `${connectionName}|${key}`;
    const entry = this.deps.store.procedureCache.get(fullKey);
    if (!entry) {
      this.deps.stats.recordMiss(connectionName, "procedure");
      return undefined;
    }
    if (!this.deps.isEntryValid(entry.timestamp)) {
      this.deps.store.procedureCache.delete(fullKey);
      this.deps.stats.recordTtlEviction(connectionName, "procedure");
      return undefined;
    }
    this.deps.stats.recordHit(connectionName, "procedure");
    return entry.data;
  }

  getProceduresAllSchemas(
    connectionName: string,
    dbName: string,
  ): ProcedureMetadata[] | undefined {
    const prefix = `${connectionName}|${dbName}.`;
    const allProcedures: ProcedureMetadata[] = [];
    const seenLabels = new Set<string>();

    for (const [key, entry] of this.deps.store.procedureCache) {
      if (key.startsWith(prefix)) {
        if (!this.deps.isEntryValid(entry.timestamp)) {
          this.deps.store.procedureCache.delete(key);
          this.deps.stats.recordTtlEviction(connectionName, "procedure");
          continue;
        }

        for (const item of entry.data) {
          const label =
            typeof item.label === "string"
              ? item.label
              : item.PROCEDURESIGNATURE || item.PROCEDURE;
          if (label && !seenLabels.has(label.toUpperCase())) {
            seenLabels.add(label.toUpperCase());
            allProcedures.push(item);
          }
        }
      }
    }

    return allProcedures.length > 0 ? allProcedures : undefined;
  }

  /**
   * Database-level procedure list for schema tree / completion.
   * Prefers the aggregate `DB..` key, then falls back to per-schema layers.
   */
  getProceduresForDatabase(
    connectionName: string,
    dbName: string,
  ): ProcedureMetadata[] | undefined {
    const aggregate = this.getProcedures(connectionName, `${dbName}..`);
    if (aggregate !== undefined) {
      return aggregate;
    }
    return this.getProceduresAllSchemas(connectionName, dbName);
  }

  setProcedures(
    connectionName: string,
    key: string,
    data: ProcedureMetadata[],
  ): void {
    const startMs = Date.now();
    const fullKey = `${connectionName}|${key}`;
    const keyParts = key.split(".");
    const dbName = keyParts[0];
    const schemaName = keyParts[1] || "";

    if (schemaName) {
      const allSchemasKey = `${connectionName}|${dbName}..`;
      if (allSchemasKey !== fullKey) {
        removeProcedureCacheEntry(this.deps.store, allSchemasKey);
      }
    }

    this.deps.store.procedureCache.set(fullKey, { data, timestamp: startMs });
    this.deps.stats.recordRefresh(
      connectionName,
      "procedure",
      key,
      Date.now() - startMs,
      data.length,
    );
  }

  // ========== Table Operations ==========

  getTables(connectionName: string, key: string): TableMetadata[] | undefined {
    // incoming key is DB.SCHEMA or DB..
    const fullKey = `${connectionName}|${normalizeDbSchemaLookupKey(key)}`;
    const entry = this.deps.store.tableCache.get(fullKey);
    if (!entry) {
      this.deps.stats.recordMiss(connectionName, "table");
      return undefined;
    }
    if (!this.deps.isEntryValid(entry.timestamp)) {
      this.removeTableCacheEntry(fullKey);
      this.deps.stats.recordTtlEviction(connectionName, "table");
      return undefined;
    }
    this.deps.stats.recordHit(connectionName, "table");
    return entry.data;
  }

  isViewsCatalogLoaded(connectionName: string, cacheKey: string): boolean {
    return this.deps.viewsCatalogLoaded.has(
      `${connectionName}|${normalizeDbSchemaLookupKey(cacheKey)}`,
    );
  }

  markViewsCatalogLoaded(connectionName: string, cacheKey: string): void {
    this.deps.viewsCatalogLoaded.add(
      `${connectionName}|${normalizeDbSchemaLookupKey(cacheKey)}`,
    );
  }

  isObjectsCatalogLoaded(
    connectionName: string,
    layerKey: string,
    objType: string,
  ): boolean {
    return this.deps.objectsCatalogLoaded.has(
      buildObjectsCatalogLoadedKey(
        connectionName,
        normalizeDbSchemaLookupKey(layerKey),
        objType,
      ),
    );
  }

  markObjectsCatalogLoaded(
    connectionName: string,
    layerKey: string,
    objType: string,
  ): void {
    this.deps.objectsCatalogLoaded.add(
      buildObjectsCatalogLoadedKey(
        connectionName,
        normalizeDbSchemaLookupKey(layerKey),
        objType,
      ),
    );
  }

  markPrefetchObjectTypesCatalogLoaded(
    connectionName: string,
    layerKey: string,
  ): void {
    const normalizedLayerKey = normalizeDbSchemaLookupKey(layerKey);
    for (const objType of NZ_PREFETCH_CATALOG_OBJECT_TYPES) {
      this.deps.objectsCatalogLoaded.add(
        buildObjectsCatalogLoadedKey(connectionName, normalizedLayerKey, objType),
      );
    }
    this.markViewsCatalogLoaded(connectionName, layerKey);
  }

  isProcedureCatalogLoaded(
    connectionName: string,
    dbName: string,
  ): boolean {
    return this.deps.objectsCatalogLoaded.has(
      buildProcedureCatalogLoadedKey(connectionName, dbName),
    );
  }

  markProcedureCatalogLoaded(
    connectionName: string,
    dbName: string,
  ): void {
    this.deps.objectsCatalogLoaded.add(
      buildProcedureCatalogLoadedKey(connectionName, dbName),
    );
  }

  areObjectsCatalogLoadedForDatabase(
    connectionName: string,
    dbName: string,
    objType: string,
  ): boolean {
    const upperDb = dbName.toUpperCase();
    const normalizedType = objType.toUpperCase();
    const connPrefix = `${connectionName}|`;
    const dbPrefix = `${connPrefix}${upperDb}.`;
    let foundPerSchemaKey = false;

    for (const key of this.deps.store.tableCache.keys()) {
      if (!key.startsWith(dbPrefix)) {
        continue;
      }
      const layerKey = key.slice(connPrefix.length);
      if (layerKey.endsWith('..')) {
        if (this.isObjectsCatalogLoaded(connectionName, layerKey, normalizedType)) {
          return true;
        }
        continue;
      }
      foundPerSchemaKey = true;
      if (!this.isObjectsCatalogLoaded(connectionName, layerKey, normalizedType)) {
        return false;
      }
    }

    return foundPerSchemaKey;
  }

  deriveTypeGroupsFromCache(
    connectionName: string,
    dbName: string,
  ): string[] | undefined {
    const types = new Set<string>();
    const upperDb = dbName.toUpperCase();
    const prefix = `${connectionName}|${upperDb}.`;

    for (const [key, entry] of this.deps.store.tableCache) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      if (!this.deps.isEntryValid(entry.timestamp)) {
        continue;
      }
      for (const item of entry.data) {
        const objType = (item.objType || '').trim().toUpperCase();
        if (objType) {
          types.add(objType);
        }
      }
    }

    const aggregateProcedures = this.getProcedures(connectionName, `${upperDb}..`);
    if (aggregateProcedures !== undefined) {
      types.add('PROCEDURE');
    } else if (this.isProcedureCatalogLoaded(connectionName, upperDb)) {
      types.add('PROCEDURE');
    }

    return types.size > 0 ? [...types].sort((a, b) => a.localeCompare(b)) : undefined;
  }

  /**
   * True when every per-schema table layer for {@link dbName} has had its view
   * catalog enumerated (possibly empty). Used for DB.. completion without a
   * separate views query when prefetch/hydrate already loaded table-like objects.
   */
  areViewsCatalogLoadedForDatabase(
    connectionName: string,
    dbName: string,
  ): boolean {
    const upperDb = dbName.toUpperCase();
    const connPrefix = `${connectionName}|`;
    const dbPrefix = `${connPrefix}${upperDb}.`;
    let foundPerSchemaKey = false;

    for (const key of this.deps.store.tableCache.keys()) {
      if (!key.startsWith(dbPrefix)) {
        continue;
      }
      const layerKey = key.slice(connPrefix.length);
      if (layerKey.endsWith("..")) {
        if (this.isViewsCatalogLoaded(connectionName, layerKey)) {
          return true;
        }
        continue;
      }
      foundPerSchemaKey = true;
      if (!this.isViewsCatalogLoaded(connectionName, layerKey)) {
        return false;
      }
    }

    return foundPerSchemaKey;
  }

  /**
   * Get tables from all schemas for a given database.
   * Used for double-dot pattern (DB..) where schema is not specified.
   */
  getTablesAllSchemas(
    connectionName: string,
    dbName: string,
  ): TableMetadata[] | undefined {
    const prefix = `${connectionName}|${dbName.toUpperCase()}.`;
    const allTables: TableMetadata[] = [];
    const seenNames = new Set<string>();
    const staleKeys: string[] = [];

    for (const [key, entry] of this.deps.store.tableCache) {
      if (key.startsWith(prefix)) {
        if (!this.deps.isEntryValid(entry.timestamp)) {
          staleKeys.push(key);
          continue;
        }
        for (const item of entry.data) {
          const name = extractLabel(item);
          if (name && !seenNames.has(name.toUpperCase())) {
            seenNames.add(name.toUpperCase());
            allTables.push(item);
          }
        }
      }
    }

    this.evictStaleTableCacheEntries(connectionName, staleKeys);

    return allTables.length > 0 ? allTables : undefined;
  }

  /**
   * Cache tables for a database or schema.
   *
   * Performs **complete replacement** for the target key — not an incremental merge.
   * Explorer partial refreshes must use {@link mergeTableLikeObjectsForSchema} or
 * {@link mergeAndSetTables} before calling this method. For `DB..` keys,
 * {@link mergeAndSetTables} aggregates per-schema cache entries when the aggregate
 * key is not yet materialized.
   *
   * @remarks See `docs/METADATA_CACHE_CONTRACT.md` — Table cache write policy.
   *
   * @param connectionName - Connection identifier
   * @param key - Cache key in format "DB.SCHEMA" or "DB.." (all schemas)
   * @param data - Complete array of table metadata (will replace existing)
   * @param idMap - Map of "DB.SCHEMA.TABLE" lookup keys to object IDs
   *
   * Side effects:
   * - Removes old lookup index entries for replaced tables
   * - Adds new lookup index entries for provided tables
   * - Invalidates objectsByType cache for the database (lazy rebuild on next read)
   * - Restores name-only index entries for tables removed from this schema but present in others
   */
  setTables(
    connectionName: string,
    key: string,
    data: TableMetadata[],
    idMap: Map<string, number>,
    options?: { deferIndexes?: boolean },
  ): void {
    const startMs = Date.now();
    const normalizedKey = normalizeDbSchemaLookupKey(key);
    const fullKey = `${connectionName}|${normalizedKey}`;
    const keyParts = normalizedKey.split(".");
    const dbName = keyParts[0];
    const schemaName = keyParts[1] || "";

    if (schemaName) {
      const allSchemasKey = `${connectionName}|${dbName}..`;
      if (allSchemasKey !== fullKey && this.deps.store.tableCache.has(allSchemasKey)) {
        this.removeTableCacheEntry(allSchemasKey);
      }
    }

    const existingEntry = this.deps.store.tableCache.get(fullKey);
    const replacedNames = existingEntry
      ? removeTableIndexes(this.deps.store, 
          connectionName,
          dbName,
          schemaName || undefined,
          existingEntry.data,
        )
      : new Set<string>();

    this.deps.store.tableCache.set(fullKey, { data, timestamp: startMs });
    this.deps.store.tableIdMap.set(fullKey, { data: idMap, timestamp: startMs });
    invalidateObjectsByTypeForDb(this.deps.store, connectionName, dbName);
    if (options?.deferIndexes) {
      this.deps.deferredIndexConnections.add(connectionName);
    } else {
      addTableIndexes(this.deps.store, 
        connectionName,
        dbName,
        schemaName || undefined,
        data,
        idMap,
      );
    }
    restoreTableNameOnlyIndexes(this.deps.store, this.deps.stats, connectionName, dbName, replacedNames, this.deps.isEntryValid, (key) => this.removeTableCacheEntry(key));

    this.deps.stats.recordRefresh(
      connectionName,
      "table",
      normalizedKey,
      Date.now() - startMs,
      data.length,
    );
    if (
      data.some((item) => (item.objType || "").toUpperCase() === "VIEW")
    ) {
      this.markViewsCatalogLoaded(connectionName, normalizedKey);
    }
  }

  /**
   * Get all cached table-like objects across schemas in a database.
   * Prunes stale table-cache entries while iterating (TTL eviction).
   */
  getObjectsWithSchema(
    connectionName: string,
    dbName: string,
  ): ObjectWithSchema[] {
    const upperDbName = dbName.toUpperCase();
    const prefix = `${connectionName}|${upperDbName}.`;
    const allSchemasKey = `${connectionName}|${upperDbName}..`;
    const results: ObjectWithSchema[] = [];
    const seenKeys = new Set<string>();
    const staleKeys: string[] = [];

    for (const [key, entry] of this.deps.store.tableCache) {
      if (key.startsWith(prefix) || key === allSchemasKey) {
        if (!this.deps.isEntryValid(entry.timestamp)) {
          staleKeys.push(key);
          continue;
        }

        const parts = key.split("|");
        if (parts.length < 2) continue;

        const dbKey = parts[1];
        const dbParts = dbKey.split(".");
        const entrySchemaName = (dbParts.length > 1 ? dbParts[1] : "") || "";
        const idMapEntry = this.deps.store.tableIdMap.get(key);

        for (const item of entry.data) {
          const label = extractLabel(item);
          const resolvedSchemaName =
            resolveTableSchemaName(item, entrySchemaName || undefined) ||
            "";
          const uniqueKey = `${resolvedSchemaName}.${label}`;

          if (label && !seenKeys.has(uniqueKey)) {
            seenKeys.add(uniqueKey);

            let objId: number | undefined;
            if (idMapEntry) {
              const lookupKey = buildIdLookupKey(
                upperDbName,
                resolvedSchemaName || undefined,
                label,
              );
              objId = idMapEntry.data.get(lookupKey);
            }
            objId ??= typeof item.OBJID === "number" ? item.OBJID : undefined;

            results.push({
              item,
              schema: resolvedSchemaName,
              objId,
              owner: item.OWNER,
              description: item.DESCRIPTION,
            });
          }
        }
      }
    }

    this.evictStaleTableCacheEntries(connectionName, staleKeys);

    return results;
  }

  /**
   * Get cached objects for a specific type from all schemas in a database.
   * Returns undefined when table cache for this DB is not populated yet.
   */
  getObjectsByType(
    connectionName: string,
    dbName: string,
    objType: string,
  ): ObjectWithSchema[] | undefined {
    const normalizedType = objType.toUpperCase();
    const cacheKey = `${connectionName}|${dbName}|${normalizedType}`;
    const startMs = Date.now();
    const cachedEntry = this.deps.store.objectsByTypeCache.get(cacheKey);
    if (cachedEntry) {
      if (!this.deps.isEntryValid(cachedEntry.timestamp)) {
        this.deps.store.objectsByTypeCache.delete(cacheKey);
        this.deps.stats.recordTtlEviction(connectionName, "objectsByType");
      } else {
        this.deps.stats.recordHit(connectionName, "objectsByType");
        return cachedEntry.data;
      }
    }

    this.deps.stats.recordMiss(connectionName, "objectsByType");

    const upperDbName = dbName.toUpperCase();
    const prefix = `${connectionName}|${upperDbName}.`;
    const allSchemasKey = `${connectionName}|${upperDbName}..`;
    const results: ObjectWithSchema[] = [];
    const seenKeys = new Set<string>();
    const staleKeys: string[] = [];
    let hasTableCacheForDb = false;

    for (const [key, entry] of this.deps.store.tableCache) {
      if (key.startsWith(prefix) || key === allSchemasKey) {
        hasTableCacheForDb = true;
        if (!this.deps.isEntryValid(entry.timestamp)) {
          staleKeys.push(key);
          continue;
        }

        const parts = key.split("|");
        if (parts.length < 2) continue;
        const dbKey = parts[1];
        const dbParts = dbKey.split(".");
        const entrySchemaName = (dbParts.length > 1 ? dbParts[1] : "") || "";
        const idMapEntry = this.deps.store.tableIdMap.get(key);

        for (const item of entry.data) {
          const label = extractLabel(item);
          if (!label) continue;

          const itemObjType = (
            item.objType || (item.kind === 18 ? "VIEW" : "TABLE")
          ).toUpperCase();
          if (itemObjType !== normalizedType) continue;

          const resolvedSchemaName =
            resolveTableSchemaName(item, entrySchemaName || undefined) ||
            "";
          const uniqueKey = `${resolvedSchemaName}.${label}`;
          if (seenKeys.has(uniqueKey)) continue;
          seenKeys.add(uniqueKey);

          let objId: number | undefined;
          if (idMapEntry) {
            const lookupKey = buildIdLookupKey(
              upperDbName,
              resolvedSchemaName || undefined,
              label,
            );
            objId = idMapEntry.data.get(lookupKey);
          }
          objId ??= typeof item.OBJID === "number" ? item.OBJID : undefined;

          results.push({
            item,
            schema: resolvedSchemaName,
            objId,
            owner: item.OWNER,
            description: item.DESCRIPTION,
          });
        }
      }
    }

    this.evictStaleTableCacheEntries(connectionName, staleKeys);

    if (!hasTableCacheForDb) {
      return undefined;
    }

    this.deps.store.objectsByTypeCache.set(cacheKey, {
      data: results,
      timestamp: Date.now(),
    });
    this.deps.stats.recordRefresh(
      connectionName,
      "objectsByType",
      `${dbName}|${normalizedType}`,
      Date.now() - startMs,
      results.length,
    );
    return results;
  }

  /**
   * True when the table catalog is large enough that loading an entire per-DB
   * column file from disk would block the UI (schema tree / completion).
   */
  isLargeTableCatalog(
    connectionName: string,
    dbName: string,
    threshold: number = LARGE_DB_TABLE_LIKE_OBJECT_THRESHOLD,
  ): boolean {
    const dbPrefix = `${connectionName}|${dbName.toUpperCase()}.`;
    let count = 0;

    for (const [key, entry] of this.deps.store.tableCache) {
      if (!key.startsWith(dbPrefix)) {
        continue;
      }
      const layerKey = key.slice(dbPrefix.length);
      if (layerKey === ".." || layerKey === "") {
        continue;
      }
      count += entry.data.length;
      if (count >= threshold) {
        return true;
      }
    }

    return false;
  }

  // ========== Column Operations ==========

  getColumns(
    connectionName: string,
    key: string,
  ): ColumnMetadata[] | undefined {
    const fullKey = `${connectionName}|${key}`;
    const entry = this.deps.store.columnCache.get(fullKey);
    if (!entry) {
      this.deps.stats.recordMiss(connectionName, "column");
      return undefined;
    }
    if (!this.deps.isEntryValid(entry.timestamp)) {
      this.deps.store.columnCache.delete(fullKey);
      this.deps.stats.recordTtlEviction(connectionName, "column");
      return undefined;
    }
    this.deps.stats.recordHit(connectionName, "column");
    return entry.data;
  }

  setColumns(
    connectionName: string,
    key: string,
    data: ColumnMetadata[],
  ): void {
    const startMs = Date.now();
    const fullKey = `${connectionName}|${key}`;
    const keyParts = key.split(".");
    const dbName = keyParts[0];
    const schemaName = keyParts[1] || "";
    const tableName = keyParts.slice(2).join(".");

    if (schemaName && tableName) {
      const allSchemasKey = `${connectionName}|${dbName}..${tableName}`;
      if (allSchemasKey !== fullKey && this.deps.store.columnCache.delete(allSchemasKey)) {
        Logger.getInstance().info(
          `[MetadataCache] Invalidated aggregated column cache for ${allSchemasKey}`,
        );
      }
    }

    this.deps.store.columnCache.set(fullKey, { data, timestamp: startMs });
    this.deps.stats.recordRefresh(
      connectionName,
      "column",
      key,
      Date.now() - startMs,
      data.length,
    );
  }

  /**
   * Get columns for a table from any schema.
   * Used for double-dot pattern (DB..TABLE) where schema is not specified.
   * Returns the first matching columns found for the table name.
   */
  getColumnsAnySchema(
    connectionName: string,
    dbName: string,
    tableName: string,
  ): ColumnMetadata[] | undefined {
    const prefix = `${connectionName}|${dbName.toUpperCase()}.`;
    const normalizedTableName = normalizeTableNameForColumnCacheKey(tableName);
    const staleKeys: string[] = [];
    let firstMatchingColumns: ColumnMetadata[] | undefined;

    for (const [key, entry] of this.deps.store.columnCache) {
      if (key.startsWith(prefix)) {
        // Key format: "CONN|DB.SCHEMA.TABLE"
        const parts = key.split(".");
        if (parts.length >= 3) {
          const keyTableName = parts[parts.length - 1];
          if (keyTableName !== normalizedTableName) {
            continue;
          }

          if (!this.deps.isEntryValid(entry.timestamp)) {
            staleKeys.push(key);
            continue;
          }

          firstMatchingColumns ??= entry.data;
        }
      }
    }

    for (const staleKey of staleKeys) {
      this.deps.store.columnCache.delete(staleKey);
      this.deps.stats.recordTtlEviction(connectionName, "column");
    }

    return firstMatchingColumns;
  }

  // ========== ID Lookup ==========

  findTableId(connectionName: string, lookupKey: string): number | undefined {
    ensureTableIndexesBuilt(this.deps.store, this.deps.deferredIndexConnections, connectionName);
    // lookupKey format: "DB.SCHEMA.TABLE" or "DB..TABLE" (upper case)
    const upperConn = connectionName.toUpperCase();
    const indexKey = `${upperConn}|${lookupKey}`;

    // Try full lookup first (with schema)
    const cached = this.deps.store.objectLookupIndex.get(indexKey);
    if (cached) {
      return cached.objId;
    }

    // For DB..TABLE pattern (no schema), try table-name-only index
    if (lookupKey.includes("..")) {
      const tableNameOnlyKey = `${upperConn}|${lookupKey}`;
      const cachedNoSchema = this.deps.store.tableNameOnlyIndex.get(tableNameOnlyKey);
      if (cachedNoSchema) {
        return cachedNoSchema.objId;
      }
    }

    return undefined;
  }

  // ========== TypeGroup Operations ==========



  /**
   * Get type groups for a database.
   * Returns cached types if available and valid.
   * Falls back to NZ_DEFAULT_OBJECT_TYPES if not cached (enables instant revealInSchema).
   * Use hasCachedTypeGroups() to check if real data is cached.
   */
  getTypeGroups(connectionName: string, dbName: string): string[] | undefined {
    const key = `${connectionName}|${dbName}`;
    const entry = this.deps.store.typeGroupCache.get(key);
    if (!entry) {
      this.deps.stats.recordMiss(connectionName, "typeGroup");
      // Return default types for instant revealInSchema without DB query
      return getDefaultTypeGroups(this.deps.connectionManager, connectionName);
    }
    if (!this.deps.isEntryValid(entry.timestamp)) {
      this.deps.store.typeGroupCache.delete(key);
      this.deps.stats.recordTtlEviction(connectionName, "typeGroup");
      this.deps.stats.recordMiss(connectionName, "typeGroup");
      // Return default types for expired cache
      return getDefaultTypeGroups(this.deps.connectionManager, connectionName);
    }
    this.deps.stats.recordHit(connectionName, "typeGroup");
    return mergeTypeGroupsWithDefaults(this.deps.connectionManager, connectionName, entry.data);
  }

  /**
   * Check if real typeGroups are cached (not defaults).
   * Used to determine if background refresh is needed.
   */
  hasCachedTypeGroups(connectionName: string, dbName: string): boolean {
    const key = `${connectionName}|${dbName}`;
    const entry = this.deps.store.typeGroupCache.get(key);
    return entry !== undefined && this.deps.isEntryValid(entry.timestamp);
  }

  setTypeGroups(connectionName: string, dbName: string, types: string[]): void {
    const startMs = Date.now();
    const key = `${connectionName}|${dbName}`;
    const mergedTypes = mergeTypeGroupsWithDefaults(this.deps.connectionManager, connectionName, types);
    this.deps.store.typeGroupCache.set(key, { data: mergedTypes, timestamp: startMs });
    this.deps.stats.recordRefresh(
      connectionName,
      "typeGroup",
      dbName,
      Date.now() - startMs,
      mergedTypes.length,
    );
  }

  // ========== Object Lookup with Type ==========

  /**
   * Find object in cache with type information.
   * Returns objId, objType and schema if found, undefined otherwise.
   * Uses O(1) lookup when schema is specified, O(n) when searching across all schemas.
   */
  findObjectWithType(
    connectionName: string,
    dbName: string,
    schemaName: string | undefined,
    objectName: string,
  ): CachedObjectInfo | undefined {
    ensureTableIndexesBuilt(this.deps.store, this.deps.deferredIndexConnections, connectionName);
    const upperConn = connectionName.toUpperCase();
    const upperDbName = dbName.toUpperCase();
    const upperObjName = objectName.toUpperCase();

    // O(1) lookup when schema is specified
    if (schemaName != null && schemaName !== "") {
      const indexKey = `${upperConn}|${upperDbName}.${schemaName.toUpperCase()}.${upperObjName}`;
      const cached = this.deps.store.objectLookupIndex.get(indexKey);
      if (cached) {
        this.deps.stats.recordHit(connectionName, "objectLookup");
        return cached;
      }
      this.deps.stats.recordMiss(connectionName, "objectLookup");
      return undefined;
    }

    // Schema not specified - use table-name-only index for O(1) lookup
    const tableNameOnlyKey = `${upperConn}|${upperDbName}..${upperObjName}`;
    const cached = this.deps.store.tableNameOnlyIndex.get(tableNameOnlyKey);
    if (cached) {
      this.deps.stats.recordHit(connectionName, "objectLookup");
      return cached;
    }

    this.deps.stats.recordMiss(connectionName, "objectLookup");
    return undefined;
  }

}
