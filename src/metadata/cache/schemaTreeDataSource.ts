/**
 * Shared metadata cache read/write helpers for schema explorer and completion.
 */

import { buildColumnCacheKey } from '../columnRowMapping';
import { buildDbSchemaCacheKey } from '../helpers';
import type { ColumnMetadata, TableMetadata } from '../types';
import type { MetadataCache } from './MetadataCache';
import { mergeAndSetTables } from './tableLikeMerge';

/** Above this count, skip loading entire per-DB column files from disk (use per-table fetch). */
export const LARGE_DB_TABLE_LIKE_OBJECT_THRESHOLD = 500;

/** Object types stored in tableCache and eligible for schema-tree cache-first reads. */
export const TABLE_CACHE_OBJECT_TYPES = new Set<string>([
  'TABLE',
  'VIEW',
  'NICKNAME',
  'ALIAS',
  'SYNONYM',
  'EXTERNAL TABLE',
  'DYNAMIC TABLE',
  'SEQUENCE',
  'MATERIALIZED VIEW',
  'SYSTEM VIEW',
  'SYSTEM TABLE',
  'GLOBAL TEMP TABLE',
]);

export function isTableCacheObjectType(objType: string | undefined): boolean {
  return objType ? TABLE_CACHE_OBJECT_TYPES.has(objType.toUpperCase()) : false;
}

export function buildObjectsCatalogLoadedKey(
  connectionName: string,
  layerKey: string,
  objType: string,
): string {
  return `${connectionName}|${layerKey}|${objType.toUpperCase()}`;
}

export function buildProcedureCatalogLoadedKey(
  connectionName: string,
  dbName: string,
): string {
  return `${connectionName}|${dbName.toUpperCase()}|PROCEDURE`;
}

export function buildSchemaCacheKey(
  dbName: string,
  schemaName?: string,
): string {
  return buildDbSchemaCacheKey(dbName, schemaName);
}

/**
 * Read table-like objects for a schema-specific or all-schemas (DB..) scope.
 */
export function getTablesForScope(
  cache: MetadataCache,
  connectionName: string,
  dbName: string,
  schemaName?: string,
): TableMetadata[] | undefined {
  const cacheKey = buildSchemaCacheKey(dbName, schemaName);
  if (schemaName) {
    return cache.getTables(connectionName, cacheKey);
  }

  const direct = cache.getTables(connectionName, cacheKey);
  if (direct !== undefined && direct.length > 0) {
    return direct;
  }
  return cache.getTablesAllSchemas(connectionName, dbName);
}

/**
 * Explorer refresh: merge one object type into the schema cache key.
 */
export function refreshTableLikeTypeForSchema(
  cache: MetadataCache,
  connectionName: string,
  dbName: string,
  schemaName: string | undefined,
  objType: string,
  tables: readonly TableMetadata[],
  buildIdMap: (merged: TableMetadata[]) => Map<string, number>,
): TableMetadata[] {
  const schemaKey = buildSchemaCacheKey(dbName, schemaName);
  return mergeAndSetTables(
    cache,
    connectionName,
    schemaKey,
    tables,
    objType,
    buildIdMap,
  );
}

/**
 * Ensure column layers are loaded from disk (when enabled) and return cached columns.
 */
/** Column cache is usable in the schema tree (PK flags present). */
export function hasTreeReadyColumnCache(
  columns: ColumnMetadata[] | undefined,
): columns is ColumnMetadata[] {
  return Boolean(columns?.length && columns[0].isPk !== undefined);
}

/** Normalize column rows before writing to cache (avoids stale-cache refetch loops). */
export function normalizeColumnCacheEntry(
  col: Pick<
    ColumnMetadata,
    | 'ATTNAME'
    | 'FORMAT_TYPE'
    | 'label'
    | 'kind'
    | 'detail'
    | 'documentation'
    | 'isPk'
    | 'isFk'
    | 'isDistributionKey'
  >,
): ColumnMetadata {
  return {
    ATTNAME: col.ATTNAME,
    FORMAT_TYPE: col.FORMAT_TYPE,
    label: col.label,
    kind: col.kind,
    detail: col.detail,
    documentation: col.documentation,
    isPk: col.isPk ?? false,
    isFk: col.isFk ?? false,
    isDistributionKey: col.isDistributionKey ?? false,
  };
}

export async function getColumnsForTableObject(
  cache: MetadataCache,
  connectionName: string,
  dbName: string,
  schemaName: string | undefined,
  tableName: string,
): Promise<ColumnMetadata[] | undefined> {
  const columnKey = buildColumnCacheKey(dbName, schemaName, tableName);
  await cache.ensureColumnsLoadedForTableKey(connectionName, columnKey);
  return cache.getColumns(connectionName, columnKey);
}

/**
 * Write column metadata for a table object into the cache.
 */
export function setColumnsForTableObject(
  cache: MetadataCache,
  connectionName: string,
  dbName: string,
  schemaName: string | undefined,
  tableName: string,
  columns: ColumnMetadata[],
): void {
  const columnKey = buildColumnCacheKey(dbName, schemaName, tableName);
  cache.setColumns(connectionName, columnKey, columns);
}
