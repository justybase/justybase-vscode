import * as vscode from 'vscode';
import { buildIdLookupKey, extractLabel, inferCachedTableLikeType } from '../helpers';
import type { TableMetadata } from '../types';
import type { MetadataCache } from './MetadataCache';
import { buildSchemaCacheKey } from './schemaTreeDataSource';
import { normalizeCompletionDescription } from '../../utils/completionDescriptionUtils';

function getObjectName(item: TableMetadata): string | undefined {
    return extractLabel(item) || item.OBJNAME || item.TABLENAME;
}

function buildIdMap(
    database: string,
    defaultSchema: string | undefined,
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

function sameSchema(left: string | undefined, right: string | undefined): boolean {
    return (left?.trim().toUpperCase() || '') === (right?.trim().toUpperCase() || '');
}

function compareTableObjectNames(left: TableMetadata, right: TableMetadata): number {
    return (getObjectName(left) || '').localeCompare(getObjectName(right) || '');
}

function nativeTableDefinitionFromRow(
    row: Record<string, unknown>,
): TableMetadata['tableDefinition'] | undefined {
    const engine = typeof row.CLICKHOUSE_ENGINE === 'string'
        ? row.CLICKHOUSE_ENGINE.trim()
        : '';
    if (!engine) {
        return undefined;
    }

    const definition: NonNullable<TableMetadata['tableDefinition']> = { engine };
    const fields: Array<[keyof NonNullable<TableMetadata['tableDefinition']>, string]> = [
        ['partitionBy', 'CLICKHOUSE_PARTITION_BY'],
        ['primaryKey', 'CLICKHOUSE_PRIMARY_KEY'],
        ['orderBy', 'CLICKHOUSE_ORDER_BY'],
        ['sampleBy', 'CLICKHOUSE_SAMPLE_BY'],
        ['ttl', 'CLICKHOUSE_TTL'],
        ['settings', 'CLICKHOUSE_SETTINGS'],
        ['sourceDdl', 'CLICKHOUSE_SOURCE_DDL'],
    ];
    for (const [target, source] of fields) {
        const value = row[source];
        if (typeof value === 'string' && value.trim()) {
            definition[target] = value.trim();
        }
    }
    return definition;
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

function mergeUpsertedTableObjectForSchema(
    existing: readonly TableMetadata[],
    table: TableMetadata,
    schema: string | undefined,
): TableMetadata[] {
    const schemaRows = existing.filter(item => sameSchema(item.SCHEMA, schema));
    const otherSchemaRows = existing.filter(item => !sameSchema(item.SCHEMA, schema));
    return [
        ...otherSchemaRows,
        ...mergeUpsertedTableObject(schemaRows, table),
    ];
}

export function toTableMetadata(row: {
    OBJNAME: string;
    SCHEMA?: string | null;
    OBJID?: number;
    OBJTYPE?: string;
    OWNER?: string;
    DESCRIPTION?: string;
    tableDefinition?: TableMetadata['tableDefinition'];
    [key: string]: unknown;
}): TableMetadata {
    const objectType = row.OBJTYPE?.trim().toUpperCase() || 'TABLE';
    const tableDefinition = row.tableDefinition ?? nativeTableDefinitionFromRow(row);
    const isViewLike = objectType === 'VIEW' || objectType === 'MATERIALIZED VIEW';
    const typeLabel = objectType === 'MATERIALIZED VIEW' ? 'Materialized View' : objectType;
    return {
        OBJNAME: row.OBJNAME,
        OBJID: row.OBJID,
        SCHEMA: row.SCHEMA || undefined,
        OWNER: row.OWNER,
        DESCRIPTION: normalizeCompletionDescription(row.DESCRIPTION),
        label: row.OBJNAME,
        kind: isViewLike ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Class,
        objType: objectType,
        detail: row.SCHEMA ? `${typeLabel} (${row.SCHEMA})` : typeLabel,
        sortText: row.OBJNAME,
        ...(tableDefinition ? { tableDefinition } : {}),
    };
}

/** Upsert one catalog table without replacing unrelated objects in the schema layer. */
export function upsertTableObject(
    cache: MetadataCache,
    connectionName: string,
    database: string,
    schema: string | undefined,
    table: TableMetadata,
): void {
    const cacheKey = buildSchemaCacheKey(database, schema);
    const tableName = getObjectName(table);
    if (!tableName) {
        return;
    }
    const existing = cache.getTables(connectionName, cacheKey);
    if (existing) {
        const merged = mergeUpsertedTableObject(existing, table);
        cache.setTables(connectionName, cacheKey, merged, buildIdMap(database, schema, merged));
        return;
    }

    // A full DB.. aggregate may be the only materialized layer after disk
    // hydration. Update it in place instead of replacing it with one schema
    // and silently dropping every other cached object.
    const aggregateKey = buildSchemaCacheKey(database);
    const aggregate = cache.getTables(connectionName, aggregateKey);
    if (aggregate && schema) {
        const merged = mergeUpsertedTableObjectForSchema(aggregate, table, schema);
        cache.setTables(
            connectionName,
            aggregateKey,
            merged,
            buildIdMap(database, undefined, merged),
        );
        return;
    }

    const merged = mergeUpsertedTableObject([], table);
    cache.setTables(connectionName, cacheKey, merged, buildIdMap(database, schema, merged));
}

/** Remove one table identity without invalidating the rest of the schema layer. */
export function removeTableObject(
    cache: MetadataCache,
    connectionName: string,
    database: string,
    schema: string | undefined,
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
    options?: { flatCatalog?: boolean },
): void {
    const aggregateKey = buildSchemaCacheKey(database);
    const aggregate = cache.getTables(connectionName, aggregateKey);
    const cachedTables = aggregate ?? cache.getTablesAllSchemas(connectionName, database) ?? [];
    const cachedBySchema = new Map<string, TableMetadata[]>();
    for (const cached of cachedTables) {
        const schema = cached.SCHEMA?.trim().toUpperCase() || '';
        const entries = cachedBySchema.get(schema) ?? [];
        entries.push(cached);
        cachedBySchema.set(schema, entries);
    }

    const schemas = new Set<string>();
    if (options?.flatCatalog) {
        schemas.add('');
    }
    for (const cached of cachedTables) {
        const schema = cached.SCHEMA?.trim().toUpperCase();
        if (schema || options?.flatCatalog) {
            schemas.add(schema || '');
        }
    }
    for (const row of rows) {
        const schema = row.SCHEMA?.trim().toUpperCase();
        if (schema || options?.flatCatalog) {
            schemas.add(schema || '');
        }
    }

    for (const schema of schemas) {
        const schemaName = schema || undefined;
        const cacheKey = buildSchemaCacheKey(database, schemaName);
        const existing = cache.getTables(connectionName, cacheKey)
            ?? cachedBySchema.get(schema)
            ?? [];
        const retained = existing.filter(item => inferCachedTableLikeType(item).toUpperCase() !== objectType.toUpperCase());
        const replacements = rows.filter(row => (row.SCHEMA?.trim().toUpperCase() || '') === schema);
        const merged = [...retained, ...replacements];
        cache.setTables(connectionName, cacheKey, merged, buildIdMap(database, schemaName, merged));
        cache.markObjectsCatalogLoaded(connectionName, cacheKey, objectType);
    }
}
