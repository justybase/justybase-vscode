import { unquoteIdentifier } from '../utils/identifierUtils';
import type { ColumnMetadata } from './types';

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

export function mapRawColumnRowToMetadata(row: RawColumnRowWithKeys): ColumnMetadata {
    return {
        ATTNAME: row.ATTNAME,
        FORMAT_TYPE: row.FORMAT_TYPE,
        label: row.ATTNAME,
        kind: 5,
        detail: row.FORMAT_TYPE,
        documentation: row.DESCRIPTION || '',
        isPk: Number(row.IS_PK) === 1,
        isFk: Number(row.IS_FK) === 1,
        isDistributionKey:
            row.IS_DISTRIBUTION_KEY !== undefined
                ? Number(row.IS_DISTRIBUTION_KEY) === 1
                : false,
    };
}

export function normalizeTableNameForColumnCacheKey(tableName: string): string {
    const trimmed = tableName.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return unquoteIdentifier(trimmed);
    }
    return unquoteIdentifier(tableName).toUpperCase();
}

export function buildColumnCacheKey(
    dbName: string,
    schemaName: string | undefined,
    tableName: string,
    options?: { preserveCase?: boolean },
): string {
    const schema = schemaName ?? '';
    if (options?.preserveCase) {
        return `${dbName}.${schema}.${tableName}`;
    }

    const normalizedTable = normalizeTableNameForColumnCacheKey(tableName);
    return `${dbName.toUpperCase()}.${schema.toUpperCase()}.${normalizedTable}`;
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
        const key = buildColumnCacheKey(
            row.DBNAME || defaults?.dbName || '',
            row.SCHEMA ?? defaults?.schemaName,
            row.TABLENAME,
        );

        if (!columnsByKey.has(key)) {
            columnsByKey.set(key, []);
        }
        columnsByKey.get(key)!.push(mapRawColumnRowToMetadata(row));
    }

    return columnsByKey;
}
