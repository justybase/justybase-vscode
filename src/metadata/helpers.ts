/**
 * Metadata Cache - Helper Functions
 * Extracted utility functions to reduce MetadataCache class complexity
 */

import type { TableMetadata } from './types';

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
    const dbName = dbParts[0];
    const schemaName = dbParts.length > 1 && dbParts[1] !== '' ? dbParts[1] : undefined;

    return { connectionName, dbName, schemaName };
}

/**
 * Build DB.SCHEMA or DB.. lookup key for table/procedure cache.
 */
export function buildDbSchemaCacheKey(dbName: string, schemaName?: string): string {
    const db = dbName.toUpperCase();
    if (schemaName && schemaName.length > 0) {
        return `${db}.${schemaName.toUpperCase()}`;
    }
    return `${db}..`;
}

/**
 * Normalize DB.SCHEMA or DB.. lookup key for table/procedure cache.
 */
export function normalizeDbSchemaLookupKey(key: string): string {
    if (key.endsWith('..')) {
        return buildDbSchemaCacheKey(key.slice(0, -2));
    }

    const dotIndex = key.indexOf('.');
    if (dotIndex < 0) {
        return key.toUpperCase();
    }

    return buildDbSchemaCacheKey(key.slice(0, dotIndex), key.slice(dotIndex + 1));
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
