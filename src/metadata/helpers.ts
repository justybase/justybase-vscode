/**
 * Metadata Cache - Helper Functions
 * Extracted utility functions to reduce MetadataCache class complexity
 */

import type { TableMetadata } from './types';
import {
    createNetezzaUserIdentifier,
    isNetezzaQuotedIdentifier,
    unquoteNetezzaIdentifier,
} from '../dialects/netezza/metadata/identifierUtils';

/** Prefix for Netezza cache keys whose identifier case is significant. */
export const NETEZZA_EXACT_CACHE_KEY_PREFIX = '@NZEX@';

function encodeNetezzaCachePart(value: string): string {
    return encodeURIComponent(value).replace(/\./g, '%2E');
}

function decodeNetezzaCachePart(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export function buildNetezzaCacheDatabasePart(databaseName: string): string {
    if (isNetezzaExactCachePart(databaseName)) {
        return databaseName;
    }
    return `${NETEZZA_EXACT_CACHE_KEY_PREFIX}${encodeNetezzaCachePart(databaseName)}`;
}

export function isNetezzaExactCachePart(value: string): boolean {
    return value.startsWith(NETEZZA_EXACT_CACHE_KEY_PREFIX);
}

export function decodeNetezzaCacheDatabasePart(value: string): string {
    return isNetezzaExactCachePart(value)
        ? decodeNetezzaCachePart(value.slice(NETEZZA_EXACT_CACHE_KEY_PREFIX.length))
        : value;
}

/**
 * Parse cache key to extract connection name and DB/Schema parts
 * Key formats: "CONN|DBNAME.SCHEMA" or "CONN|DBNAME.."
 */
export function parseCacheKey(key: string): {
    connectionName: string;
    dbName: string;
    schemaName: string | undefined;
} | null {
    const parts = key.split('|');
    if (parts.length < 2) return null;

    const connectionName = parts[0];
    const dbKey = parts[1];
    const dbParts = dbKey.split('.');
    const dbName = decodeNetezzaCacheDatabasePart(dbParts[0]);
    const schemaName = dbParts.length > 1 && dbParts[1] !== ''
        ? decodeNetezzaCachePart(dbParts[1])
        : undefined;

    return { connectionName, dbName, schemaName };
}

/**
 * Build DB.SCHEMA or DB.. lookup key for table/procedure cache.
 */
export function buildDbSchemaCacheKey(
    dbName: string,
    schemaName?: string,
    options?: { preserveCase?: boolean; exactNetezza?: boolean },
): string {
    if (isNetezzaExactCachePart(dbName)) {
        const encodedSchema = schemaName === undefined ? '' : encodeNetezzaCachePart(schemaName);
        return `${dbName}.${encodedSchema}`;
    }
    if (options?.exactNetezza) {
        const exactDatabase = buildNetezzaCacheDatabasePart(dbName);
        const encodedSchema = schemaName === undefined ? '' : encodeNetezzaCachePart(schemaName);
        return `${exactDatabase}.${encodedSchema}`;
    }
    if (options?.preserveCase) {
        const schema = schemaName ?? '';
        return schema.length > 0 ? `${dbName}.${schema}` : `${dbName}..`;
    }
    const db = dbName.trim().toUpperCase();
    const schema = schemaName?.trim();
    if (schema && schema.length > 0) {
        return `${db}.${schema.toUpperCase()}`;
    }
    return `${db}..`;
}

/**
 * Normalize DB.SCHEMA or DB.. lookup key for table/procedure cache.
 */
export function normalizeDbSchemaLookupKey(key: string): string {
    if (isNetezzaExactCachePart(key)) {
        return key;
    }
    if (key.endsWith('..')) {
        return buildDbSchemaCacheKey(key.slice(0, -2));
    }

    const dotIndex = key.indexOf('.');
    if (dotIndex < 0) {
        return key.toUpperCase();
    }

    return buildDbSchemaCacheKey(key.slice(0, dotIndex), key.slice(dotIndex + 1));
}

export function parseDbSchemaCacheKey(key: string): {
    dbName: string;
    schemaName?: string;
} {
    const parts = key.split('.');
    return {
        dbName: decodeNetezzaCacheDatabasePart(parts[0]),
        schemaName: parts.length > 1 && parts[1] !== ''
            ? decodeNetezzaCachePart(parts[1])
            : undefined,
    };
}

/**
 * Convert a user-supplied Netezza database name to its exact cache identity.
 * The returned value is a cache-only marker, never SQL text.
 */
export function buildNetezzaDatabaseCacheKey(databaseName: string): string {
    return buildNetezzaCacheDatabasePart(
        createNetezzaUserIdentifier(databaseName).value,
    );
}

/**
 * Build a Netezza DB.SCHEMA/DB.. cache layer key from user identifiers.
 * Catalog-prefetch code should pass a database marker directly when it already
 * has an exact catalog value.
 */
export function buildNetezzaDbSchemaCacheKey(
    databaseName: string,
    schemaName?: string,
): string {
    const databaseKey = isNetezzaExactCachePart(databaseName)
        ? databaseName
        : buildNetezzaDatabaseCacheKey(databaseName);
    const schema = schemaName === undefined
        ? undefined
        : isNetezzaQuotedIdentifier(schemaName)
            ? unquoteNetezzaIdentifier(schemaName)
            : createNetezzaUserIdentifier(schemaName).value;
    return buildDbSchemaCacheKey(databaseKey, schema);
}

/**
 * Normalize a Netezza cache layer key. Existing non-Netezza keys retain the
 * legacy normalization path in normalizeDbSchemaLookupKey().
 */
export function normalizeNetezzaDbSchemaLookupKey(key: string): string {
    if (isNetezzaExactCachePart(key)) {
        return key;
    }

    const doubleDotIndex = key.indexOf('..');
    if (doubleDotIndex > 0) {
        return buildNetezzaDbSchemaCacheKey(key.slice(0, doubleDotIndex));
    }

    const dotIndex = key.indexOf('.');
    if (dotIndex < 0) {
        return buildNetezzaDbSchemaCacheKey(key);
    }
    return buildNetezzaDbSchemaCacheKey(
        key.slice(0, dotIndex),
        key.slice(dotIndex + 1),
    );
}

/**
 * Build a full cache key from components
 */
export function buildCacheKey(connectionName: string, dbName: string, schemaName?: string): string {
    const dbKey = buildDbSchemaCacheKey(dbName, schemaName);
    return `${connectionName}|${dbKey}`;
}

/**
 * Check if a cache key belongs to a specific connection
 */
export function matchesConnection(key: string, connectionName: string | undefined): boolean {
    if (!connectionName) return true;

    const delimiterIndex = key.indexOf('|');
    const keyConnectionName = delimiterIndex >= 0 ? key.slice(0, delimiterIndex) : key;
    return keyConnectionName.toUpperCase() === connectionName.toUpperCase();
}

/**
 * Extract label text from cache item (handles both string and object labels)
 */
export function extractLabel(item: unknown): string | undefined {
    if (!item || typeof item !== 'object') return undefined;
    const it = item as { label?: string | { label: string } };
    if (!it.label) return undefined;
    return typeof it.label === 'string' ? it.label : it.label.label;
}

/**
 * Infer object type from VS Code completion item kind
 */
export function inferObjectType(item: unknown): string {
    const it = item as { objType?: string; kind?: number };
    if (it.objType) return it.objType;
    // CompletionItemKind: 18 = Interface (used for VIEW), 6/7 = Class (used for TABLE)
    return it.kind === 18 ? 'VIEW' : 'TABLE';
}

/**
 * Infer cached table-like object type from explicit metadata or completion kind.
 */
export function inferCachedTableLikeType(item: TableMetadata): string {
    if (item.objType) {
        return item.objType.toUpperCase();
    }
    return item.kind === 18 ? 'VIEW' : 'TABLE';
}

/**
 * Merge shared table-like cache entries while replacing only the requested object type.
 *
 * Use before `MetadataCache.setTables` when refreshing a single object type (TABLE, VIEW,
 * NICKNAME, ALIAS) so other types in the same schema key are preserved.
 *
 * @remarks See `docs/METADATA_CACHE_CONTRACT.md` — Table cache write policy.
 */
export function mergeTableLikeObjectsForSchema(
    existingTables: readonly TableMetadata[] | undefined,
    updatedTables: readonly TableMetadata[],
    targetType: string
): TableMetadata[] {
    const normalizedTargetType = targetType.toUpperCase();
    const merged = new Map<string, TableMetadata>();

    const buildMergeKey = (table: TableMetadata): string | undefined => {
        const label = extractLabel(table) || table.OBJNAME || table.TABLENAME;
        if (!label) {
            return undefined;
        }

        const objectType = inferCachedTableLikeType(table);
        const schemaName = typeof table.SCHEMA === 'string' ? table.SCHEMA.toUpperCase() : '';
        return `${objectType}|${schemaName}|${label.toUpperCase()}`;
    };

    for (const table of existingTables ?? []) {
        const objectType = inferCachedTableLikeType(table);
        if (objectType === normalizedTargetType) {
            continue;
        }

        const mergeKey = buildMergeKey(table);
        if (mergeKey) {
            merged.set(mergeKey, table);
        }
    }

    for (const table of updatedTables) {
        const mergeKey = buildMergeKey(table);
        if (mergeKey) {
            merged.set(mergeKey, table);
        }
    }

    return Array.from(merged.values()).sort((left, right) => {
        const leftType = inferCachedTableLikeType(left);
        const rightType = inferCachedTableLikeType(right);
        if (leftType !== rightType) {
            return leftType.localeCompare(rightType);
        }

        const leftSchema = typeof left.SCHEMA === 'string' ? left.SCHEMA : '';
        const rightSchema = typeof right.SCHEMA === 'string' ? right.SCHEMA : '';
        if (leftSchema !== rightSchema) {
            return leftSchema.localeCompare(rightSchema);
        }

        const leftLabel = extractLabel(left) || left.OBJNAME || left.TABLENAME || '';
        const rightLabel = extractLabel(right) || right.OBJNAME || right.TABLENAME || '';
        return leftLabel.localeCompare(rightLabel);
    });
}

/**
 * Build lookup key for ID map
 */
export function buildIdLookupKey(dbName: string, schemaName: string | undefined, objectName: string): string {
    return schemaName ? `${dbName}.${schemaName}.${objectName}` : `${dbName}..${objectName}`;
}
