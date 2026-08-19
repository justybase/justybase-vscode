import { unquoteIdentifier } from '../utils/identifierUtils';
import type { ColumnMetadata } from './types';
import { normalizeCompletionDescription } from '../utils/completionDescriptionUtils';

export interface RawColumnRowWithKeys {
    TABLENAME: string;
    ATTNAME: string;
    FORMAT_TYPE: string;
    SCHEMA?: string;
    DBNAME?: string;
    DESCRIPTION?: string;
    IS_PK?: number | string;
    IS_FK?: number | string;
    IS_DISTRIBUTION_KEY?: number | string;
    [key: string]: unknown;
}

/** Normalize fixed-width catalog values before they participate in cache keys. */
export function normalizeCatalogPart(value: string | undefined | null): string {
    return String(value ?? '').trim();
}

export function mapRawColumnRowToMetadata(row: RawColumnRowWithKeys): ColumnMetadata {
    return {
        ATTNAME: row.ATTNAME,
        FORMAT_TYPE: row.FORMAT_TYPE,
        label: row.ATTNAME,
        kind: 5,
        detail: row.FORMAT_TYPE,
        documentation: normalizeCompletionDescription(row.DESCRIPTION) || '',
        isPk: Number(row.IS_PK) === 1,
        isFk: Number(row.IS_FK) === 1,
        isDistributionKey:
            row.IS_DISTRIBUTION_KEY !== undefined
                ? Number(row.IS_DISTRIBUTION_KEY) === 1
                : false,
    };
}

export function normalizeTableNameForColumnCacheKey(tableName: string): string {
    const trimmed = normalizeCatalogPart(tableName);
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return unquoteIdentifier(trimmed);
    }
    return unquoteIdentifier(trimmed).toUpperCase();
}

export function buildColumnCacheKey(
    dbName: string,
    schemaName: string | undefined,
    tableName: string,
    options?: { preserveCase?: boolean },
): string {
    const database = normalizeCatalogPart(dbName);
    const schema = normalizeCatalogPart(schemaName);
    const table = normalizeCatalogPart(tableName);
    if (options?.preserveCase) {
        return `${database}.${schema}.${table}`;
    }

    const normalizedTable = normalizeTableNameForColumnCacheKey(table);
    return `${database.toUpperCase()}.${schema.toUpperCase()}.${normalizedTable}`;
}

/** Normalize DB.SCHEMA.TABLE column cache lookup key (Netezza catalog semantics). */
export function normalizeColumnLookupKey(key: string): string {
    const parts = key.split('.');
    if (parts.length < 3) {
        return key;
    }

    return buildColumnCacheKey(parts[0], parts[1], parts.slice(2).join('.'));
}

export function groupColumnRowsByTableKey(
    rows: RawColumnRowWithKeys[],
    defaults?: { dbName?: string; schemaName?: string },
): Map<string, ColumnMetadata[]> {
    const columnsByKey = new Map<string, ColumnMetadata[]>();

    for (const row of rows) {
        const databaseName = normalizeCatalogPart(row.DBNAME) || normalizeCatalogPart(defaults?.dbName);
        const schemaName = normalizeCatalogPart(row.SCHEMA) || normalizeCatalogPart(defaults?.schemaName);
        const tableName = normalizeCatalogPart(row.TABLENAME);
        const key = buildColumnCacheKey(
            databaseName,
            schemaName,
            tableName,
        );

        if (!columnsByKey.has(key)) {
            columnsByKey.set(key, []);
        }
        columnsByKey.get(key)!.push(mapRawColumnRowToMetadata(row));
    }

    return columnsByKey;
}
