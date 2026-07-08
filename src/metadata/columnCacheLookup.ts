import type { DatabaseKind } from '../contracts/database';
import type { MetadataCache } from '../metadataCache';
import type { ColumnMetadata } from './types';
import { buildColumnCacheKey } from './columnRowMapping';
import { extractDatabaseFromLayerKey } from './diskStorage/metadataDiskPaths';

/**
 * Reads column metadata from the in-memory cache using normalized cache keys.
 * Netezza unquoted identifiers are uppercased; non-Netezza dialects may preserve case.
 */
export function getCachedColumnsFromMetadataCache(
    metadataCache: MetadataCache,
    connectionName: string,
    database: string,
    schema: string | undefined,
    table: string,
    databaseKind?: DatabaseKind,
): ColumnMetadata[] | undefined {
    const preserveCase =
        databaseKind !== undefined && databaseKind !== 'netezza';
    const directKey = buildColumnCacheKey(database, schema, table, {
        preserveCase,
    });
    const directColumns = metadataCache.getColumns(connectionName, directKey);
    if (directColumns) {
        return directColumns;
    }

    if (!schema) {
        return metadataCache.getColumnsAnySchema(connectionName, database, table);
    }

    return undefined;
}

/**
 * Async variant — ensures lazy-loaded column files are hydrated before cache read.
 */
export async function getCachedColumnsFromMetadataCacheAsync(
    metadataCache: MetadataCache,
    connectionName: string,
    database: string,
    schema: string | undefined,
    table: string,
    databaseKind?: DatabaseKind,
): Promise<ColumnMetadata[] | undefined> {
    const preserveCase =
        databaseKind !== undefined && databaseKind !== 'netezza';
    const directKey = buildColumnCacheKey(database, schema, table, {
        preserveCase,
    });
    if (typeof metadataCache.ensureColumnsLoadedForTableKey === 'function') {
        await metadataCache.ensureColumnsLoadedForTableKey(connectionName, directKey);
    } else if (typeof metadataCache.ensureColumnsLoaded === 'function') {
        await metadataCache.ensureColumnsLoaded(connectionName, database);
    }
    return getCachedColumnsFromMetadataCache(
        metadataCache,
        connectionName,
        database,
        schema,
        table,
        databaseKind,
    );
}

/**
 * Ensures column cache is loaded for a table layer key (`DB.SCHEMA.TABLE`).
 */
export async function ensureColumnCacheForTableKey(
    metadataCache: MetadataCache,
    connectionName: string,
    layerKey: string,
): Promise<void> {
    if (typeof metadataCache.ensureColumnsLoadedForTableKey === 'function') {
        await metadataCache.ensureColumnsLoadedForTableKey(connectionName, layerKey);
        return;
    }
    const database = extractDatabaseFromLayerKey(layerKey);
    await metadataCache.ensureColumnsLoaded(connectionName, database);
}
