import * as vscode from 'vscode';
import { buildIdLookupKey, extractLabel, inferCachedTableLikeType } from '../helpers';
import type { TableMetadata } from '../types';
import type { MetadataCache } from './MetadataCache';
import { buildSchemaCacheKey } from './schemaTreeDataSource';

function getObjectName(item: TableMetadata): string | undefined {
    return extractLabel(item) || item.OBJNAME || item.TABLENAME;
}

function buildIdMap(
    database: string,
    defaultSchema: string,
    tables: readonly TableMetadata[],
): Map<string, number> {
    const result = new Map<string, number>();
    for (const table of tables) {
        const name = getObjectName(table);
        if (!name || typeof table.OBJID !== 'number') {
            continue;
        }
        const schema = table.SCHEMA || defaultSchema;
        result.set(buildIdLookupKey(database, schema, name), table.OBJID);
    }
    return result;
}

function sameName(left: string | undefined, right: string): boolean {
    return left?.toUpperCase() === right.toUpperCase();
}

function compareTableObjectNames(left: TableMetadata, right: TableMetadata): number {
    return (getObjectName(left) || '').localeCompare(getObjectName(right) || '');
}

/** Insert/replace one object using the same type-group + OBJNAME order as type refresh. */
function mergeUpsertedTableObject(
    existing: readonly TableMetadata[],
    table: TableMetadata,
): TableMetadata[] {
    const tableName = getObjectName(table);
    if (!tableName) {
        return [...existing];
    }

    const objectType = inferCachedTableLikeType(table).toUpperCase();
    const remaining = existing.filter(item => !sameName(getObjectName(item), tableName));
    const retained = remaining.filter(
        item => inferCachedTableLikeType(item).toUpperCase() !== objectType,
    );
    const sameType = remaining.filter(
        item => inferCachedTableLikeType(item).toUpperCase() === objectType,
    );
    sameType.push(table);
    sameType.sort(compareTableObjectNames);
    return [...retained, ...sameType];
}

export function toTableMetadata(row: {
    OBJNAME: string;
    SCHEMA?: string;
    OBJID?: number;
    OBJTYPE?: string;
    OWNER?: string;
    DESCRIPTION?: string;
}): TableMetadata {
    const objectType = row.OBJTYPE?.toUpperCase() || 'TABLE';
    return {
        OBJNAME: row.OBJNAME,
        OBJID: row.OBJID,
        SCHEMA: row.SCHEMA,
        OWNER: row.OWNER,
        DESCRIPTION: row.DESCRIPTION,
        label: row.OBJNAME,
        kind: vscode.CompletionItemKind.Class,
        objType: objectType,
        detail: row.SCHEMA ? `${objectType} (${row.SCHEMA})` : objectType,
        sortText: row.OBJNAME,
    };
}

/** Upsert one catalog table without replacing unrelated objects in the schema layer. */
export function upsertTableObject(
    cache: MetadataCache,
    connectionName: string,
    database: string,
    schema: string,
    table: TableMetadata,
): void {
    const cacheKey = buildSchemaCacheKey(database, schema);
    const tableName = getObjectName(table);
    if (!tableName) {
        return;
    }
    const existing = cache.getTables(connectionName, cacheKey) ?? [];
    const merged = mergeUpsertedTableObject(existing, table);
    cache.setTables(connectionName, cacheKey, merged, buildIdMap(database, schema, merged));
}

/** Remove one table identity without invalidating the rest of the schema layer. */
export function removeTableObject(
    cache: MetadataCache,
    connectionName: string,
    database: string,
    schema: string,
    tableName: string,
): boolean {
    const cacheKey = buildSchemaCacheKey(database, schema);
    const existing = cache.getTables(connectionName, cacheKey);
    if (!existing) {
        return false;
    }
    const remaining = existing.filter(item => !sameName(getObjectName(item), tableName));
    if (remaining.length === existing.length) {
        return false;
    }
    cache.setTables(connectionName, cacheKey, remaining, buildIdMap(database, schema, remaining));
    return true;
}

/** Replace one object type across a database while preserving every other cached type. */
export function replaceTableObjectTypeForDatabase(
    cache: MetadataCache,
    connectionName: string,
    database: string,
    objectType: string,
    rows: readonly TableMetadata[],
): void {
    const schemas = new Set<string>();
    for (const cached of cache.getTablesAllSchemas(connectionName, database) ?? []) {
        if (cached.SCHEMA) {
            schemas.add(cached.SCHEMA);
        }
    }
    for (const row of rows) {
        if (row.SCHEMA) {
            schemas.add(row.SCHEMA);
        }
    }

    for (const schema of schemas) {
        const cacheKey = buildSchemaCacheKey(database, schema);
        const existing = cache.getTables(connectionName, cacheKey) ?? [];
        const retained = existing.filter(item => item.objType?.toUpperCase() !== objectType.toUpperCase());
        const replacements = rows.filter(row => row.SCHEMA?.toUpperCase() === schema.toUpperCase());
        const merged = [...retained, ...replacements];
        cache.setTables(connectionName, cacheKey, merged, buildIdMap(database, schema, merged));
        cache.markObjectsCatalogLoaded(connectionName, cacheKey, objectType);
    }
}
