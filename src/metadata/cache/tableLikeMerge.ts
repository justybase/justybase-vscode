/**
 * Unified table-like cache write path for explorer partial refreshes.
 */

import { mergeTableLikeObjectsForSchema } from '../helpers';
import type { TableMetadata } from '../types';

export interface TableLikeCacheWriter {
  getTables(connectionName: string, key: string): TableMetadata[] | undefined;
  /** Required for DB.. merge when the aggregate key is not yet materialized. */
  getTablesAllSchemas?(
    connectionName: string,
    dbName: string,
  ): TableMetadata[] | undefined;
  setTables(
    connectionName: string,
    key: string,
    data: TableMetadata[],
    idMap: Map<string, number>,
    options?: { deferIndexes?: boolean },
  ): void;
}

/**
 * Read existing table-like rows for merge. DB.. keys fall back to per-schema aggregation
 * when the aggregate cache entry does not exist yet (matches getTablesForScope reads).
 */
export function readExistingTablesForMerge(
  cache: TableLikeCacheWriter,
  connectionName: string,
  schemaKey: string,
): TableMetadata[] | undefined {
  const direct = cache.getTables(connectionName, schemaKey);
  if (direct !== undefined) {
    return direct;
  }
  if (schemaKey.endsWith('..') && cache.getTablesAllSchemas) {
    const dbName = schemaKey.slice(0, -2);
    return cache.getTablesAllSchemas(connectionName, dbName);
  }
  return undefined;
}

/**
 * Merge refreshed table-like objects for one type, then replace the schema cache key.
 *
 * @remarks See `docs/METADATA_CACHE_CONTRACT.md` — Table cache write policy.
 */
export function mergeAndSetTables(
  cache: TableLikeCacheWriter,
  connectionName: string,
  schemaKey: string,
  updated: readonly TableMetadata[],
  targetType: string,
  buildIdMap: (merged: TableMetadata[]) => Map<string, number>,
  options?: { deferIndexes?: boolean },
): TableMetadata[] {
  const existingTables = readExistingTablesForMerge(
    cache,
    connectionName,
    schemaKey,
  );
  const mergedTables = mergeTableLikeObjectsForSchema(
    existingTables,
    updated,
    targetType,
  );
  cache.setTables(
    connectionName,
    schemaKey,
    mergedTables,
    buildIdMap(mergedTables),
    options,
  );
  return mergedTables;
}
