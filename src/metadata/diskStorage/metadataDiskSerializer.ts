/**
 * Convert between in-memory MetadataCache maps and SerializedCache JSON.
 */

import type { MetadataCache } from '../../metadataCache';
import { buildIdLookupKey, extractLabel, matchesConnection, parseCacheKey } from '../helpers';
import type {
    ColumnMetadata,
    DatabaseMetadata,
    PerKeyEntry,
    ProcedureMetadata,
    SchemaMetadata,
    TableMetadata,
} from '../types';
import { encodeColumnLayers, decodeColumnFile } from './metadataColumnCodec';
import { extractDatabaseFromLayerKey } from './metadataDiskPaths';
import { forEachWithYield, METADATA_HYDRATE_BATCH_SIZE } from '../hydrateScheduler';
import {
    DOCUMENTATION_MAX_LENGTH,
    type SerializedColumnFile,
    type SerializedConnectionCache,
    type SerializedConnectionMetadata,
    type SerializedLayerEntry,
    type SerializedStringLayerEntry,
} from './metadataDiskTypes';

const KNOWN_DATABASE_KEYS = new Set(['DATABASE', 'label', 'detail', 'kind']);
const KNOWN_SCHEMA_KEYS = new Set([
    'SCHEMA', 'OWNER', 'label', 'detail', 'kind', 'insertText', 'sortText', 'filterText',
]);
const KNOWN_TABLE_KEYS = new Set([
    'OBJNAME', 'TABLENAME', 'OBJID', 'SCHEMA', 'OWNER', 'DESCRIPTION', 'REFOBJNAME',
    'kind', 'objType', 'TYPE', 'label', 'detail', 'sortText',
]);
const KNOWN_PROCEDURE_KEYS = new Set([
    'PROCEDURE', 'PROCEDURESIGNATURE', 'SCHEMA', 'OWNER', 'DATABASE',
    'kind', 'label', 'detail', 'sortText',
]);
const KNOWN_COLUMN_KEYS = new Set([
    'ATTNAME', 'FORMAT_TYPE', 'label', 'detail', 'kind', 'documentation',
    'isPk', 'isFk', 'isDistributionKey',
]);

function stripUnknownKeys<T extends Record<string, unknown>>(
    item: T,
    allowedKeys: Set<string>,
): T {
    const result: Record<string, unknown> = {};
    for (const key of allowedKeys) {
        if (key in item && item[key] !== undefined) {
            result[key] = item[key];
        }
    }
    return result as T;
}

function truncateDocumentation(column: ColumnMetadata): ColumnMetadata {
    if (
        typeof column.documentation === 'string'
        && column.documentation.length > DOCUMENTATION_MAX_LENGTH
    ) {
        return {
            ...column,
            documentation: column.documentation.slice(0, DOCUMENTATION_MAX_LENGTH),
        };
    }
    return column;
}

function layerMapToRecord<T>(
    cache: Map<string, PerKeyEntry<T[]>>,
    connectionName: string,
    stripFn: (item: T) => T,
    keyExtractor: (fullKey: string) => string | undefined,
): Record<string, SerializedLayerEntry<T>> {
    const result: Record<string, SerializedLayerEntry<T>> = {};
    for (const [fullKey, entry] of cache) {
        if (!matchesConnection(fullKey, connectionName)) {
            continue;
        }
        const layerKey = keyExtractor(fullKey);
        if (!layerKey) {
            continue;
        }
        result[layerKey] = {
            timestamp: entry.timestamp,
            data: entry.data.map(stripFn),
        };
    }
    return result;
}

function serializeConnectionMetadataLayers(
    cache: MetadataCache,
    connectionName: string,
    connectionFingerprint: string,
    prefetchCompletedAt: number,
): SerializedConnectionMetadata | undefined {
    const dbEntry = cache.getRawDatabaseEntry(connectionName);
    if (!dbEntry || dbEntry.data.length === 0) {
        return undefined;
    }

    return {
        prefetchCompletedAt,
        connectionFingerprint,
        database: {
            timestamp: dbEntry.timestamp,
            data: dbEntry.data.map((item) =>
                stripUnknownKeys(item as DatabaseMetadata, KNOWN_DATABASE_KEYS),
            ),
        },
        schema: layerMapToRecord(
            cache._schemaCache,
            connectionName,
            (item) => stripUnknownKeys(item as SchemaMetadata, KNOWN_SCHEMA_KEYS),
            (fullKey) => {
                const parsed = parseCacheKey(fullKey);
                return parsed?.dbName;
            },
        ),
        table: layerMapToRecord(
            cache._tableCache,
            connectionName,
            (item) => stripUnknownKeys(item as TableMetadata, KNOWN_TABLE_KEYS),
            (fullKey) => fullKey.split('|')[1],
        ),
        procedure: layerMapToRecord(
            cache._procedureCache,
            connectionName,
            (item) => stripUnknownKeys(item as ProcedureMetadata, KNOWN_PROCEDURE_KEYS),
            (fullKey) => fullKey.split('|')[1],
        ),
        typeGroup: serializeTypeGroups(cache, connectionName),
    };
}

function serializeColumnLayersForConnection(
    cache: MetadataCache,
    connectionName: string,
): Record<string, SerializedLayerEntry<ColumnMetadata>> {
    return layerMapToRecord(
        cache._columnCache,
        connectionName,
        (item) => stripUnknownKeys(truncateDocumentation(item as ColumnMetadata), KNOWN_COLUMN_KEYS),
        (fullKey) => fullKey.split('|')[1],
    );
}

export function serializeConnectionMetadataFromCache(
    cache: MetadataCache,
    connectionName: string,
    connectionFingerprint: string,
    prefetchCompletedAt: number,
): SerializedConnectionMetadata | undefined {
    const metadata = serializeConnectionMetadataLayers(
        cache,
        connectionName,
        connectionFingerprint,
        prefetchCompletedAt,
    );
    if (!metadata || !isConnectionMetadataComplete(metadata)) {
        return undefined;
    }
    return metadata;
}

export function serializeColumnsByDatabase(
    cache: MetadataCache,
    connectionName: string,
): Map<string, SerializedColumnFile> {
    const columnLayers = serializeColumnLayersForConnection(cache, connectionName);
    const byDatabase = new Map<string, Record<string, SerializedLayerEntry<ColumnMetadata>>>();

    for (const [layerKey, entry] of Object.entries(columnLayers)) {
        const dbName = extractDatabaseFromLayerKey(layerKey);
        let dbColumns = byDatabase.get(dbName);
        if (!dbColumns) {
            dbColumns = {};
            byDatabase.set(dbName, dbColumns);
        }
        dbColumns[layerKey] = entry;
    }

    const result = new Map<string, SerializedColumnFile>();
    for (const [database, columnLayers] of byDatabase) {
        if (Object.keys(columnLayers).length === 0) {
            continue;
        }
        result.set(database, encodeColumnLayers(database, columnLayers));
    }
    return result;
}

export function mergeMetadataWithColumnFiles(
    metadata: SerializedConnectionMetadata,
    columnFiles: SerializedColumnFile[],
): SerializedConnectionCache {
    const column: Record<string, SerializedLayerEntry<ColumnMetadata>> = {};
    for (const file of columnFiles) {
        const expanded = decodeColumnFile(file);
        for (const [layerKey, entry] of Object.entries(expanded)) {
            column[layerKey] = entry;
        }
    }
    return { ...metadata, column };
}

export function serializeConnectionFromCache(
    cache: MetadataCache,
    connectionName: string,
    connectionFingerprint: string,
    prefetchCompletedAt: number,
): SerializedConnectionCache | undefined {
    const metadata = serializeConnectionMetadataFromCache(
        cache,
        connectionName,
        connectionFingerprint,
        prefetchCompletedAt,
    );
    if (!metadata) {
        return undefined;
    }

    const columnLayers = serializeColumnLayersForConnection(cache, connectionName);
    const serialized: SerializedConnectionCache = {
        ...metadata,
        column: columnLayers,
    };

    if (!isConnectionCacheComplete(serialized)) {
        return undefined;
    }

    return serialized;
}

function serializeTypeGroups(
    cache: MetadataCache,
    connectionName: string,
): Record<string, SerializedStringLayerEntry> {
    const result: Record<string, SerializedStringLayerEntry> = {};
    for (const [fullKey, entry] of cache._typeGroupCache) {
        if (!matchesConnection(fullKey, connectionName)) {
            continue;
        }
        const dbName = fullKey.split('|')[1];
        if (dbName) {
            result[dbName] = { timestamp: entry.timestamp, data: entry.data };
        }
    }
    return result;
}

export function isConnectionMetadataComplete(data: SerializedConnectionMetadata): boolean {
    return (
        data.database.data.length > 0
        && Object.keys(data.schema).length > 0
        && Object.keys(data.table).length > 0
    );
}

export function isConnectionCacheComplete(data: SerializedConnectionCache): boolean {
    return (
        isConnectionMetadataComplete(data)
        && Object.keys(data.column).length > 0
    );
}

export function buildTableIdMap(
    layerKey: string,
    tables: TableMetadata[],
): Map<string, number> {
    const keyParts = layerKey.split('.');
    const dbName = keyParts[0];
    const schemaName = keyParts.length > 1 && keyParts[1] !== '' ? keyParts[1] : undefined;
    const idMap = new Map<string, number>();

    for (const table of tables) {
        const objectName = table.OBJNAME ?? table.TABLENAME ?? extractLabel(table);
        const schema = table.SCHEMA ?? schemaName;
        if (table.OBJID !== undefined && objectName && schema) {
            const lookupKey = buildIdLookupKey(dbName, schema, objectName);
            idMap.set(lookupKey.toUpperCase(), table.OBJID);
        }
    }
    return idMap;
}

export interface HydrateMetadataOptions {
    deferIndexes?: boolean;
    /** When set, hydrate stops writing if MetadataCache generation changed (e.g. clearCache). */
    cacheGeneration?: number;
}

function isHydrateStillValid(
    cache: MetadataCache,
    options?: HydrateMetadataOptions,
): boolean {
    if (options?.cacheGeneration === undefined) {
        return true;
    }
    return cache.isCacheGenerationCurrent(options.cacheGeneration);
}

export function hydrateConnectionMetadataIntoCache(
    cache: MetadataCache,
    connectionName: string,
    data: SerializedConnectionMetadata,
    options?: HydrateMetadataOptions,
): void {
    cache.setDatabases(connectionName, data.database.data as DatabaseMetadata[]);

    for (const [dbName, entry] of Object.entries(data.schema)) {
        cache.setSchemas(connectionName, dbName, entry.data);
    }

    const tableOptions = options?.deferIndexes ? { deferIndexes: true } : undefined;
    const procedureDatabases = new Set<string>();
    const procedureEntries = Object.entries(data.procedure).sort(([layerKeyA], [layerKeyB]) => {
        const aggregateRank = (key: string): number => (key.endsWith('..') ? 1 : 0);
        return aggregateRank(layerKeyA) - aggregateRank(layerKeyB);
    });
    for (const [layerKey, entry] of Object.entries(data.table)) {
        const idMap = buildTableIdMap(layerKey, entry.data);
        cache.setTables(connectionName, layerKey, entry.data, idMap, tableOptions);
        cache.markPrefetchObjectTypesCatalogLoaded(connectionName, layerKey);
    }

    for (const [layerKey, entry] of procedureEntries) {
        cache.setProcedures(connectionName, layerKey, entry.data);
        const dbName = layerKey.split('.')[0];
        if (dbName) {
            procedureDatabases.add(dbName);
        }
    }
    for (const dbName of procedureDatabases) {
        cache.markProcedureCatalogLoaded(connectionName, dbName);
    }

    for (const [dbName, entry] of Object.entries(data.typeGroup)) {
        cache.setTypeGroups(connectionName, dbName, entry.data);
    }
}

export async function hydrateConnectionMetadataChunked(
    cache: MetadataCache,
    connectionName: string,
    data: SerializedConnectionMetadata,
    options?: HydrateMetadataOptions,
): Promise<void> {
    if (!isHydrateStillValid(cache, options)) {
        return;
    }

    cache.setDatabases(connectionName, data.database.data as DatabaseMetadata[]);

    await forEachWithYield(
        Object.entries(data.schema),
        METADATA_HYDRATE_BATCH_SIZE,
        ([dbName, entry]) => {
            if (!isHydrateStillValid(cache, options)) {
                return;
            }
            cache.setSchemas(connectionName, dbName, entry.data);
        },
    );
    if (!isHydrateStillValid(cache, options)) {
        return;
    }

    const tableOptions = options?.deferIndexes ? { deferIndexes: true } : undefined;
    await forEachWithYield(
        Object.entries(data.table),
        METADATA_HYDRATE_BATCH_SIZE,
        ([layerKey, entry]) => {
            if (!isHydrateStillValid(cache, options)) {
                return;
            }
            const idMap = buildTableIdMap(layerKey, entry.data);
            cache.setTables(connectionName, layerKey, entry.data, idMap, tableOptions);
            cache.markPrefetchObjectTypesCatalogLoaded(connectionName, layerKey);
        },
    );
    if (!isHydrateStillValid(cache, options)) {
        return;
    }

    const procedureDatabases = new Set<string>();
    const procedureEntries = Object.entries(data.procedure).sort(([layerKeyA], [layerKeyB]) => {
        const aggregateRank = (key: string): number => (key.endsWith('..') ? 1 : 0);
        return aggregateRank(layerKeyA) - aggregateRank(layerKeyB);
    });
    await forEachWithYield(
        procedureEntries,
        METADATA_HYDRATE_BATCH_SIZE,
        ([layerKey, entry]) => {
            if (!isHydrateStillValid(cache, options)) {
                return;
            }
            cache.setProcedures(connectionName, layerKey, entry.data);
            const dbName = layerKey.split('.')[0];
            if (dbName) {
                procedureDatabases.add(dbName);
            }
        },
    );
    for (const dbName of procedureDatabases) {
        cache.markProcedureCatalogLoaded(connectionName, dbName);
    }
    if (!isHydrateStillValid(cache, options)) {
        return;
    }

    await forEachWithYield(
        Object.entries(data.typeGroup),
        METADATA_HYDRATE_BATCH_SIZE,
        ([dbName, entry]) => {
            if (!isHydrateStillValid(cache, options)) {
                return;
            }
            cache.setTypeGroups(connectionName, dbName, entry.data);
        },
    );
}

export function hydrateColumnsFromDatabase(
    cache: MetadataCache,
    connectionName: string,
    columnFile: SerializedColumnFile,
): void {
    const expanded = decodeColumnFile(columnFile);
    for (const [layerKey, entry] of Object.entries(expanded)) {
        cache.setColumns(connectionName, layerKey, entry.data);
    }
}

export function hydrateConnectionIntoCache(
    cache: MetadataCache,
    connectionName: string,
    data: SerializedConnectionCache,
): void {
    hydrateConnectionMetadataIntoCache(cache, connectionName, data);

    for (const [layerKey, entry] of Object.entries(data.column)) {
        cache.setColumns(connectionName, layerKey, entry.data);
    }
}

export function collectConnectionNamesFromCache(cache: MetadataCache): string[] {
    const names = new Set<string>();
    for (const key of cache.getAllCacheKeys()) {
        const parsed = parseCacheKey(key);
        if (parsed) {
            names.add(parsed.connectionName);
            continue;
        }
        const delimiter = key.indexOf('|');
        if (delimiter < 0) {
            names.add(key);
        } else {
            names.add(key.slice(0, delimiter));
        }
    }
    return [...names];
}
