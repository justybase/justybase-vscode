/**
 * Schema-level cache invalidation and derived-cache cleanup.
 */

import { Logger } from '../../utils/logger';
import type { MetadataStore } from './MetadataStore';
import {
  removeTableCacheEntry,
} from './tableIndexes';
import {
  buildProcedureCatalogLoadedKey,
} from './schemaTreeDataSource';
import type { CacheStatsTracker } from '../cacheStats';

export function invalidateObjectsByTypeForDb(
  store: MetadataStore,
  connectionName: string,
  dbName: string,
): void {
  const prefix = `${connectionName}|${dbName}|`;
  const keysToDelete: string[] = [];
  for (const key of store.objectsByTypeCache.keys()) {
    if (key.startsWith(prefix)) {
      keysToDelete.push(key);
    }
  }

  for (const key of keysToDelete) {
    store.objectsByTypeCache.delete(key);
  }
}

export function removeProcedureCacheEntry(
  store: MetadataStore,
  fullKey: string,
): void {
  if (store.procedureCache.has(fullKey)) {
    store.procedureCache.delete(fullKey);
    Logger.getInstance().info(
      `[MetadataCache] Invalidated procedure cache for ${fullKey}`,
    );
  }
}

export function removeColumnCacheEntriesForSchema(
  store: MetadataStore,
  connectionName: string,
  dbName: string,
  schemaName?: string,
): void {
  const keysToDelete: string[] = [];
  const schemaPrefix = schemaName
    ? `${connectionName}|${dbName}.${schemaName}.`
    : undefined;
  const allSchemasPrefix = `${connectionName}|${dbName}..`;

  for (const key of store.columnCache.keys()) {
    if (schemaPrefix && key.startsWith(schemaPrefix)) {
      keysToDelete.push(key);
      continue;
    }

    if (key.startsWith(allSchemasPrefix)) {
      keysToDelete.push(key);
    }
  }

  for (const key of keysToDelete) {
    store.columnCache.delete(key);
    Logger.getInstance().info(
      `[MetadataCache] Invalidated column cache for ${key}`,
    );
  }
}

export interface InvalidateSchemaDeps {
  store: MetadataStore;
  stats: CacheStatsTracker;
  viewsCatalogLoaded: Set<string>;
  objectsCatalogLoaded: Set<string>;
  isEntryValid: (timestamp: number) => boolean;
  onInvalidated: () => void;
}

export function invalidateSchema(
  deps: InvalidateSchemaDeps,
  connectionName: string,
  dbName: string,
  schemaName?: string,
): void {
  const targetSuffix = schemaName ? `${dbName}.${schemaName}` : `${dbName}..`;
  const fullKey = `${connectionName}|${targetSuffix}`;
  const allSchemasKey = `${connectionName}|${dbName}..`;

  const removeEntry = (key: string): void => {
    removeTableCacheEntry(
      deps.store,
      deps.stats,
      deps.viewsCatalogLoaded,
      deps.objectsCatalogLoaded,
      deps.isEntryValid,
      key,
    );
  };

  if (deps.store.tableCache.has(fullKey)) {
    removeEntry(fullKey);
    Logger.getInstance().info(
      `[MetadataCache] Invalidated table cache for ${fullKey}`,
    );
  }

  if (schemaName && deps.store.tableCache.has(allSchemasKey)) {
    removeEntry(allSchemasKey);
    Logger.getInstance().info(
      `[MetadataCache] Invalidated aggregated table cache for ${allSchemasKey}`,
    );
  }

  removeProcedureCacheEntry(deps.store, fullKey);
  if (schemaName) {
    removeProcedureCacheEntry(deps.store, allSchemasKey);
  }
  deps.objectsCatalogLoaded.delete(
    buildProcedureCatalogLoadedKey(connectionName, dbName),
  );

  removeColumnCacheEntriesForSchema(
    deps.store,
    connectionName,
    dbName,
    schemaName,
  );

  deps.onInvalidated();
}
