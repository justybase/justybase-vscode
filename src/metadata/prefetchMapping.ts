import type { DatabaseTableDefinitionMetadata } from '@justybase/contracts';
import type { MetadataPrefetchTarget } from './cache/MetadataPrefetchTarget';
import { buildColumnCacheKey, normalizeCatalogPart, type RawColumnRowWithKeys } from './columnRowMapping';
import { buildNetezzaCacheDatabasePart } from './helpers';
import type { TableMetadata } from './types';
import type { QueryResult } from '../types';
import { normalizeCompletionDescription } from '../utils/completionDescriptionUtils';

export function queryResultToRows<T extends Record<string, unknown>>(result: QueryResult): T[] {
    if (!result.columns || !result.data || result.data.length === 0) {
        return [];
    }

    return result.data.map(row => {
        const obj: Record<string, unknown> = {};
        result.columns.forEach((col, index) => {
            obj[col.name] = row[index];
        });
        return obj as T;
    });
}

export interface RawObjectRow {
    OBJNAME: string;
    OBJID: number;
    SCHEMA: string;
    DBNAME: string;
    OBJTYPE?: string;
    REFOBJNAME?: string;
    OWNER?: string;
    DESCRIPTION?: string;
    [key: string]: unknown;
}

function getRawObjectString(row: RawObjectRow, key: string): string | undefined {
    const value = row[key];
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
}

function mapNativeTableDefinition(row: RawObjectRow): DatabaseTableDefinitionMetadata | undefined {
    const engine = getRawObjectString(row, 'CLICKHOUSE_ENGINE');
    if (!engine) {
        return undefined;
    }

    const definition: DatabaseTableDefinitionMetadata = { engine };
    const fields: Array<[keyof DatabaseTableDefinitionMetadata, string]> = [
        ['engineClause', 'CLICKHOUSE_ENGINE_FULL'],
        ['partitionBy', 'CLICKHOUSE_PARTITION_BY'],
        ['primaryKey', 'CLICKHOUSE_PRIMARY_KEY'],
        ['orderBy', 'CLICKHOUSE_ORDER_BY'],
        ['sampleBy', 'CLICKHOUSE_SAMPLE_BY'],
        ['ttl', 'CLICKHOUSE_TTL'],
        ['settings', 'CLICKHOUSE_SETTINGS'],
    ];
    for (const [target, source] of fields) {
        const value = getRawObjectString(row, source);
        if (value) {
            definition[target] = value;
        }
    }
    return definition;
}

export interface RawSchemaRow {
    SCHEMA: string;
    [key: string]: unknown;
}

export interface RawDatabaseRow {
    DATABASE: string;
    [key: string]: unknown;
}

export interface RawProcedureRow {
    SCHEMA?: string | null;
    PROCEDURE?: string | null;
    PROCEDURESIGNATURE?: string | null;
    OWNER?: string | null;
    DATABASE?: string | null;
    [key: string]: unknown;
}

export interface RawTypeGroupRow {
    OBJTYPE: string;
    [key: string]: unknown;
}

export function mapPrefetchObjectRow(row: RawObjectRow, preserveCatalogIdentity = false): TableMetadata {
    const normalizedObjectType = row.OBJTYPE?.trim().toUpperCase() || 'TABLE';
    const identityOptions = preserveCatalogIdentity ? { preserveWhitespace: true } : undefined;
    const objectName = normalizeCatalogPart(row.OBJNAME, identityOptions);
    const schemaName = normalizeCatalogPart(row.SCHEMA, identityOptions);
    const databaseName = normalizeCatalogPart(row.DBNAME, identityOptions);
    const isViewLike =
        normalizedObjectType === 'VIEW'
        || normalizedObjectType === 'MATERIALIZED VIEW'
        || normalizedObjectType === 'SYSTEM VIEW';
    const typeLabelByObjType: Record<string, string> = {
        SYNONYM: 'Synonym',
        VIEW: 'View',
        'MATERIALIZED VIEW': 'Materialized View',
        'SYSTEM VIEW': 'System View',
        'SYSTEM TABLE': 'System Table',
        SEQUENCE: 'Sequence',
        TABLE: 'Table',
        'EXTERNAL TABLE': 'External Table',
    };
    const typeLabel = typeLabelByObjType[normalizedObjectType] ?? normalizedObjectType;
    const tableDefinition = mapNativeTableDefinition(row);

    return {
        OBJNAME: objectName,
        label: objectName,
        kind: isViewLike ? 18 : 6,
        detail: schemaName ? typeLabel : `${typeLabel} (${schemaName})`,
        objType: normalizedObjectType,
        OBJID: row.OBJID,
        SCHEMA: schemaName,
        DBNAME: databaseName,
        OWNER: normalizeCatalogPart(row.OWNER, identityOptions),
        DESCRIPTION: normalizeCompletionDescription(row.DESCRIPTION),
        REFOBJNAME: normalizeCatalogPart(row.REFOBJNAME, identityOptions),
        ...(tableDefinition ? { tableDefinition } : {}),
    };
}

function normalizeRawObjectRow(row: RawObjectRow, preserveCatalogIdentity = false): RawObjectRow {
    const identityOptions = preserveCatalogIdentity ? { preserveWhitespace: true } : undefined;
    return {
        ...row,
        OBJNAME: normalizeCatalogPart(row.OBJNAME, identityOptions),
        SCHEMA: normalizeCatalogPart(row.SCHEMA, identityOptions),
        DBNAME: normalizeCatalogPart(row.DBNAME, identityOptions),
        OBJTYPE: normalizeCatalogPart(row.OBJTYPE).toUpperCase(),
        OWNER: normalizeCatalogPart(row.OWNER),
        REFOBJNAME: normalizeCatalogPart(row.REFOBJNAME),
        DESCRIPTION: normalizeCompletionDescription(row.DESCRIPTION),
    };
}

function objectMergeKey(row: RawObjectRow, preserveCatalogIdentity = false): string {
    const normalized = normalizeRawObjectRow(row, preserveCatalogIdentity);
    const identity = normalized.OBJID !== undefined
        ? `id:${String(normalized.OBJID)}`
        : `type:${normalized.OBJTYPE ?? ''}`;
    const parts = [normalized.DBNAME, normalized.SCHEMA, normalized.OBJNAME, identity];
    return preserveCatalogIdentity
        ? parts.join('|')
        : parts.map((part) => String(part ?? '').toUpperCase()).join('|');
}

export function mergeObjectRows(
    primaryRows: RawObjectRow[],
    fallbackRows: RawObjectRow[],
    preserveCatalogIdentity = false,
): RawObjectRow[] {
    const rowsByKey = new Map<string, RawObjectRow>();
    for (const row of [...primaryRows, ...fallbackRows]) {
        const normalized = normalizeRawObjectRow(row, preserveCatalogIdentity);
        const key = objectMergeKey(normalized, preserveCatalogIdentity);
        if (!rowsByKey.has(key)) {
            rowsByKey.set(key, normalized);
        }
    }
    return [...rowsByKey.values()];
}

function tableMetadataMergeKey(
    table: TableMetadata,
    fallbackDatabase: string,
    preserveCatalogIdentity = false,
): string {
    const label = typeof table.label === 'string'
        ? table.label
        : table.label?.label;
    const parts = [
        normalizeCatalogPart(String(table.DBNAME ?? fallbackDatabase), { preserveWhitespace: preserveCatalogIdentity }),
        normalizeCatalogPart(table.SCHEMA, { preserveWhitespace: preserveCatalogIdentity }),
        normalizeCatalogPart(table.OBJNAME ?? table.TABLENAME ?? label, { preserveWhitespace: preserveCatalogIdentity }),
        String(table.OBJID ?? table.objType ?? table.TYPE ?? ''),
    ];
    return preserveCatalogIdentity
        ? parts.join('|')
        : parts.map((part) => String(part ?? '').toUpperCase()).join('|');
}

/**
 * Add newly discovered external objects to a hydrated cache without replacing
 * unrelated objects already present in the schema/DB layer.
 */
export function mergeCachedObjectRows(
    existingRows: TableMetadata[],
    discoveredRows: TableMetadata[],
    fallbackDatabase: string,
    preserveCatalogIdentity = false,
): TableMetadata[] {
    const rowsByKey = new Map<string, TableMetadata>();
    for (const row of existingRows) {
        rowsByKey.set(tableMetadataMergeKey(row, fallbackDatabase, preserveCatalogIdentity), row);
    }
    for (const row of discoveredRows) {
        const key = tableMetadataMergeKey(row, fallbackDatabase, preserveCatalogIdentity);
        const existing = rowsByKey.get(key);
        // An external row is a compatibility supplement. It may refresh an
        // old EXTERNAL TABLE entry, but it must never replace a regular object
        // with the same normalized name from the primary catalog.
        if (!existing || String(existing.objType ?? existing.TYPE ?? '').trim().toUpperCase() === 'EXTERNAL TABLE') {
            rowsByKey.set(key, row);
        }
    }
    return [...rowsByKey.values()];
}

export function buildObjectIdMap(
    database: string,
    rows: TableMetadata[],
    preserveCatalogIdentity = false,
): Map<string, number> {
    const idMap = new Map<string, number>();
    for (const row of rows) {
        const objectName = normalizeCatalogPart(row.OBJNAME ?? row.TABLENAME ?? (
            typeof row.label === 'string' ? row.label : row.label?.label
        ), { preserveWhitespace: preserveCatalogIdentity });
        if (!objectName || typeof row.OBJID !== 'number') {
            continue;
        }
        idMap.set(
            buildColumnCacheKey(
                normalizeCatalogPart(String(row.DBNAME ?? database), { preserveWhitespace: preserveCatalogIdentity }),
                normalizeCatalogPart(row.SCHEMA, { preserveWhitespace: preserveCatalogIdentity }) || undefined,
                objectName,
                preserveCatalogIdentity
                    ? { preserveCase: true, exactNetezza: true }
                    : undefined,
            ),
            row.OBJID,
        );
    }
    return idMap;
}

function normalizeRawColumnRow(row: RawColumnRowWithKeys, preserveCatalogIdentity = false): RawColumnRowWithKeys {
    const identityOptions = preserveCatalogIdentity ? { preserveWhitespace: true } : undefined;
    return {
        ...row,
        TABLENAME: normalizeCatalogPart(row.TABLENAME, identityOptions),
        SCHEMA: normalizeCatalogPart(row.SCHEMA, identityOptions),
        DBNAME: normalizeCatalogPart(row.DBNAME, identityOptions),
        ATTNAME: normalizeCatalogPart(row.ATTNAME, identityOptions),
    };
}

function columnMergeKey(row: RawColumnRowWithKeys, preserveCatalogIdentity = false): string {
    const normalized = normalizeRawColumnRow(row, preserveCatalogIdentity);
    const parts = [normalized.DBNAME, normalized.SCHEMA, normalized.TABLENAME, normalized.ATTNAME];
    return preserveCatalogIdentity
        ? parts.join('|')
        : parts.map((part) => (part ?? '').toUpperCase()).join('|');
}

export function mergeColumnRows(
    primaryRows: RawColumnRowWithKeys[],
    fallbackRows: RawColumnRowWithKeys[],
    preserveCatalogIdentity = false,
): RawColumnRowWithKeys[] {
    const rowsByKey = new Map<string, RawColumnRowWithKeys>();
    for (const row of [...primaryRows, ...fallbackRows]) {
        const normalized = normalizeRawColumnRow(row, preserveCatalogIdentity);
        const key = columnMergeKey(normalized, preserveCatalogIdentity);
        if (!rowsByKey.has(key)) {
            rowsByKey.set(key, normalized);
        }
    }
    return [...rowsByKey.values()];
}

export function hasExternalTableForDatabase(
    cache: MetadataPrefetchTarget,
    connectionName: string,
    dbName: string,
    schemaName?: string,
): boolean {
    const preserveCatalogIdentity = cache.isNetezzaConnection?.(connectionName) === true;
    const normalizedDb = preserveCatalogIdentity
        ? buildNetezzaCacheDatabasePart(dbName)
        : dbName.trim().toUpperCase();
    const normalizedSchema = preserveCatalogIdentity
        ? schemaName
        : schemaName?.trim().toUpperCase();
    const prefix = `${connectionName}|${normalizedDb}.`;

    for (const [key, entry] of cache.tableCache) {
        if (!key.startsWith(prefix)) {
            continue;
        }
        for (const table of entry.data) {
            if (String(table.objType ?? table.TYPE ?? '').trim().toUpperCase() !== 'EXTERNAL TABLE') {
                continue;
            }
            if (!normalizedSchema || String(table.SCHEMA ?? '').trim().toUpperCase() === normalizedSchema) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Handles background prefetching of metadata for cache population
 */
