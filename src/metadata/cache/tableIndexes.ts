/**
 * Table lookup index maintenance (objectLookupIndex, tableNameOnlyIndex).
 */

import { Logger } from '../../utils/logger';
import type { CacheStatsTracker } from '../cacheStats';
import {
  extractLabel,
  buildIdLookupKey,
  buildNetezzaCacheDatabasePart,
  isNetezzaExactCachePart,
  parseCacheKey,
} from '../helpers';
import type { CachedObjectInfo, TableMetadata } from '../types';
import type { MetadataStore } from './MetadataStore';
import { invalidateObjectsByTypeForDb } from './invalidation';

export function resolveTableSchemaName(
  item: TableMetadata,
  fallbackSchema?: string,
  preserveCatalogIdentity = false,
): string | undefined {
  const itemSchemaName =
    typeof item.SCHEMA === 'string'
      ? (preserveCatalogIdentity ? item.SCHEMA : item.SCHEMA.trim())
      : '';
  if (itemSchemaName) {
    return itemSchemaName;
  }

  const normalizedFallbackSchema = preserveCatalogIdentity
    ? fallbackSchema
    : fallbackSchema?.trim();
  return normalizedFallbackSchema ? normalizedFallbackSchema : undefined;
}

export function buildCachedObjectInfo(
  dbName: string,
  fallbackSchema: string | undefined,
  item: TableMetadata,
  idMap?: Map<string, number>,
  preserveCatalogIdentity = false,
): CachedObjectInfo | undefined {
  const itemName = extractLabel(item);
  if (!itemName) {
    return undefined;
  }

  const itemSchemaName = resolveTableSchemaName(
    item,
    fallbackSchema,
    preserveCatalogIdentity,
  );
  const lookupKey = buildIdLookupKey(dbName, itemSchemaName, itemName);
  const objId =
    idMap?.get(lookupKey) ??
    (typeof item.OBJID === 'number' ? item.OBJID : undefined);
  if (objId === undefined) {
    return undefined;
  }

  return {
    objId,
    objType: item.objType || (item.kind === 18 ? 'VIEW' : 'TABLE'),
    schema: itemSchemaName || '',
    name: itemName,
  };
}

export function addTableIndexes(
  store: MetadataStore,
  connectionName: string,
  dbName: string,
  fallbackSchema: string | undefined,
  data: TableMetadata[],
  idMap: Map<string, number>,
  preserveCatalogIdentity = false,
): void {
  for (const item of data) {
    const cachedInfo = buildCachedObjectInfo(
      dbName,
      fallbackSchema,
      item,
      idMap,
      preserveCatalogIdentity,
    );
    if (!cachedInfo) {
      continue;
    }

    const indexKey = preserveCatalogIdentity
      ? `${connectionName.toUpperCase()}|${dbName}.${cachedInfo.schema}.${cachedInfo.name}`
      : `${connectionName}|${dbName}.${cachedInfo.schema}.${cachedInfo.name}`.toUpperCase();
    store.objectLookupIndex.set(indexKey, cachedInfo);

    const tableNameOnlyKey = preserveCatalogIdentity
      ? `${connectionName.toUpperCase()}|${dbName}..${cachedInfo.name}`
      : `${connectionName}|${dbName}..${cachedInfo.name}`.toUpperCase();
    if (!store.tableNameOnlyIndex.has(tableNameOnlyKey)) {
      store.tableNameOnlyIndex.set(tableNameOnlyKey, cachedInfo);
    }
  }
}

export function removeTableIndexes(
  store: MetadataStore,
  connectionName: string,
  dbName: string,
  fallbackSchema: string | undefined,
  data: TableMetadata[],
  preserveCatalogIdentity = false,
): Set<string> {
  const affectedNames = new Set<string>();

  for (const item of data) {
    const itemName = extractLabel(item);
    if (!itemName) {
      continue;
    }

    affectedNames.add(preserveCatalogIdentity ? itemName : itemName.toUpperCase());
    const resolvedSchemaName =
      resolveTableSchemaName(item, fallbackSchema, preserveCatalogIdentity) || '';
    const indexKey = preserveCatalogIdentity
      ? `${connectionName.toUpperCase()}|${dbName}.${resolvedSchemaName}.${itemName}`
      : `${connectionName}|${dbName}.${resolvedSchemaName}.${itemName}`.toUpperCase();
    store.objectLookupIndex.delete(indexKey);

    const tableNameOnlyKey = preserveCatalogIdentity
      ? `${connectionName.toUpperCase()}|${dbName}..${itemName}`
      : `${connectionName}|${dbName}..${itemName}`.toUpperCase();
    const currentNameOnlyEntry =
      store.tableNameOnlyIndex.get(tableNameOnlyKey);
    if (
      currentNameOnlyEntry &&
      (preserveCatalogIdentity
        ? currentNameOnlyEntry.name === itemName
        : currentNameOnlyEntry.name.toUpperCase() === itemName.toUpperCase()) &&
      (preserveCatalogIdentity
        ? (currentNameOnlyEntry.schema || '') === resolvedSchemaName
        : (currentNameOnlyEntry.schema || '').toUpperCase() === resolvedSchemaName.toUpperCase())
    ) {
      store.tableNameOnlyIndex.delete(tableNameOnlyKey);
    }
  }

  return affectedNames;
}

export function parseTableCacheKey(
  fullKey: string,
):
  | { connectionName: string; dbName: string; schemaName: string }
  | undefined {
  const parsed = parseCacheKey(fullKey);
  if (!parsed) {
    return undefined;
  }
  const key = fullKey.slice(fullKey.indexOf('|') + 1);
  if (!key) {
    return undefined;
  }
  return {
    connectionName: parsed.connectionName,
    dbName: parsed.dbName,
    schemaName: parsed.schemaName || '',
  };
}

export function restoreTableNameOnlyIndexes(
  store: MetadataStore,
  stats: CacheStatsTracker,
  connectionName: string,
  dbName: string,
  tableNames: Iterable<string>,
  isEntryValid: (timestamp: number) => boolean,
  removeTableCacheEntryFn: (fullKey: string) => void,
  preserveCatalogIdentity = false,
): void {
  const namesToRestore = new Set(tableNames);
  if (namesToRestore.size === 0) {
    return;
  }

  const cacheDbName = preserveCatalogIdentity
    ? buildNetezzaCacheDatabasePart(dbName)
    : dbName;
  const prefix = `${connectionName}|${cacheDbName}.`;
  const allSchemasKey = `${connectionName}|${cacheDbName}..`;
  const staleKeys: string[] = [];

  for (const [key, entry] of store.tableCache) {
    if (key !== allSchemasKey && !key.startsWith(prefix)) {
      continue;
    }
    if (!isEntryValid(entry.timestamp)) {
      staleKeys.push(key);
      continue;
    }

    const parsedKey = parseTableCacheKey(key);
    if (!parsedKey) {
      continue;
    }

    const idMapEntry = store.tableIdMap.get(key);
    for (const item of entry.data) {
      const itemName = extractLabel(item);
      if (!itemName || !namesToRestore.has(preserveCatalogIdentity ? itemName : itemName.toUpperCase())) {
        continue;
      }

      const tableNameOnlyKey = preserveCatalogIdentity
        ? `${connectionName.toUpperCase()}|${dbName}..${itemName}`
        : `${connectionName}|${dbName}..${itemName}`.toUpperCase();
      if (store.tableNameOnlyIndex.has(tableNameOnlyKey)) {
        continue;
      }

      const cachedInfo = buildCachedObjectInfo(
        dbName,
        parsedKey.schemaName || undefined,
        item,
        idMapEntry?.data,
        preserveCatalogIdentity,
      );
      if (cachedInfo) {
        store.tableNameOnlyIndex.set(tableNameOnlyKey, cachedInfo);
      }
    }
  }

  evictStaleTableCacheEntries(
    stats,
    connectionName,
    staleKeys,
    removeTableCacheEntryFn,
  );
}

export function evictStaleTableCacheEntries(
  stats: CacheStatsTracker,
  connectionName: string,
  staleKeys: Iterable<string>,
  removeTableCacheEntryFn: (fullKey: string) => void,
): void {
  for (const staleKey of staleKeys) {
    removeTableCacheEntryFn(staleKey);
    stats.recordTtlEviction(connectionName, 'table');
  }
}

function clearObjectsCatalogLoadedForLayer(
  objectsCatalogLoaded: Set<string> | undefined,
  layerFullKey: string,
): void {
  if (!objectsCatalogLoaded) {
    return;
  }
  const prefix = `${layerFullKey}|`;
  for (const key of objectsCatalogLoaded) {
    if (key.startsWith(prefix)) {
      objectsCatalogLoaded.delete(key);
    }
  }
}

export function removeTableCacheEntry(
  store: MetadataStore,
  stats: CacheStatsTracker,
  viewsCatalogLoaded: Set<string>,
  objectsCatalogLoaded: Set<string> | undefined,
  isEntryValid: (timestamp: number) => boolean,
  fullKey: string,
): void {
  const entry = store.tableCache.get(fullKey);
  const parsedKey = parseTableCacheKey(fullKey);
  const layerKey = fullKey.slice(fullKey.indexOf('|') + 1);
  const preserveCatalogIdentity = isNetezzaExactCachePart(layerKey);
  if (!entry || !parsedKey) {
    store.tableCache.delete(fullKey);
    store.tableIdMap.delete(fullKey);
    viewsCatalogLoaded.delete(fullKey);
    clearObjectsCatalogLoadedForLayer(objectsCatalogLoaded, fullKey);
    return;
  }

  const affectedNames = removeTableIndexes(
    store,
    parsedKey.connectionName,
    parsedKey.dbName,
    parsedKey.schemaName || undefined,
    entry.data,
    preserveCatalogIdentity,
  );

  store.tableCache.delete(fullKey);
  store.tableIdMap.delete(fullKey);
  invalidateObjectsByTypeForDb(
    store,
    parsedKey.connectionName,
    preserveCatalogIdentity
      ? buildNetezzaCacheDatabasePart(parsedKey.dbName)
      : parsedKey.dbName,
  );
  restoreTableNameOnlyIndexes(
    store,
    stats,
    parsedKey.connectionName,
    parsedKey.dbName,
    affectedNames,
    isEntryValid,
    (key) =>
      removeTableCacheEntry(
        store,
        stats,
        viewsCatalogLoaded,
        objectsCatalogLoaded,
        isEntryValid,
        key,
      ),
    preserveCatalogIdentity,
  );
  viewsCatalogLoaded.delete(fullKey);
  clearObjectsCatalogLoadedForLayer(objectsCatalogLoaded, fullKey);
}

export function rebuildTableIndexesForConnection(
  store: MetadataStore,
  deferredIndexConnections: Set<string>,
  connectionName: string,
): void {
  const rebuildStartMs = Date.now();
  const prefix = `${connectionName}|`;
  for (const [fullKey, entry] of store.tableCache) {
    if (!fullKey.startsWith(prefix)) {
      continue;
    }
    const layerKey = fullKey.slice(prefix.length);
    const parsedKey = parseTableCacheKey(fullKey);
    if (!parsedKey) {
      continue;
    }
    const dbName = parsedKey.dbName;
    const schemaName = parsedKey.schemaName || '';
    const preserveCatalogIdentity = isNetezzaExactCachePart(layerKey);
    const idMapEntry = store.tableIdMap.get(fullKey);
    const idMap = idMapEntry?.data ?? new Map<string, number>();
    addTableIndexes(
      store,
      connectionName,
      dbName,
      schemaName || undefined,
      entry.data,
      idMap,
      preserveCatalogIdentity,
    );
  }
  deferredIndexConnections.delete(connectionName);
  Logger.getInstance().debug(
    `[MetadataCache] rebuildTableIndexes ${connectionName}: ${Date.now() - rebuildStartMs}ms`,
  );
}

export function ensureTableIndexesBuilt(
  store: MetadataStore,
  deferredIndexConnections: Set<string>,
  connectionName: string,
): void {
  if (deferredIndexConnections.has(connectionName)) {
    rebuildTableIndexesForConnection(store, deferredIndexConnections, connectionName);
  }
}
