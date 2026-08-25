import { unquoteIdentifier } from '../utils/identifierUtils';
import type { ColumnMetadata } from './types';
import { normalizeCompletionDescription } from '../utils/completionDescriptionUtils';
import {
    buildNetezzaCacheDatabasePart,
    isNetezzaExactCachePart,
} from './helpers';

export interface RawColumnRowWithKeys {
    TABLENAME: string;
    ATTNAME: string;
    FORMAT_TYPE: string;
    SCHEMA?: string;
    DBNAME?: string;
    DESCRIPTION?: string | null;
    IS_PK?: number | string;
    IS_FK?: number | string;
    IS_DISTRIBUTION_KEY?: number | string;
    [key: string]: unknown;
}

/** Normalize fixed-width catalog values before they participate in cache keys. */
export function normalizeCatalogPart(
    value: string | undefined | null,
    options?: { preserveWhitespace?: boolean },
): string {
    const stringValue = String(value ?? '');
    return options?.preserveWhitespace ? stringValue : stringValue.trim();
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
    options?: { preserveCase?: boolean; exactNetezza?: boolean },
): string {
    const preserveCase = options?.preserveCase === true;
    const normalizedDatabase = normalizeCatalogPart(dbName, { preserveWhitespace: preserveCase });
    const database = options?.exactNetezza
        ? (isNetezzaExactCachePart(normalizedDatabase)
            ? normalizedDatabase
            : buildNetezzaCacheDatabasePart(normalizedDatabase))
        : normalizedDatabase;
    const schema = normalizeCatalogPart(schemaName, { preserveWhitespace: preserveCase });
    const table = normalizeCatalogPart(tableName, { preserveWhitespace: preserveCase });
    if (preserveCase) {
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

    const exactNetezza = isNetezzaExactCachePart(parts[0]);
    return buildColumnCacheKey(
        parts[0],
        parts[1],
        parts.slice(2).join('.'),
        exactNetezza ? { preserveCase: true } : undefined,
    );
}

export function groupColumnRowsByTableKey(
    rows: RawColumnRowWithKeys[],
    defaults?: { dbName?: string; schemaName?: string },
    options?: { preserveCase?: boolean; exactNetezza?: boolean },
): Map<string, ColumnMetadata[]> {
    const columnsByKey = new Map<string, ColumnMetadata[]>();

    for (const row of rows) {
        const preserveCase = options?.preserveCase === true;
        const databaseName = normalizeCatalogPart(row.DBNAME, { preserveWhitespace: preserveCase }) || normalizeCatalogPart(defaults?.dbName, { preserveWhitespace: preserveCase });
        const schemaName = normalizeCatalogPart(row.SCHEMA, { preserveWhitespace: preserveCase }) || normalizeCatalogPart(defaults?.schemaName, { preserveWhitespace: preserveCase });
        const tableName = normalizeCatalogPart(row.TABLENAME, { preserveWhitespace: preserveCase });
        const key = buildColumnCacheKey(
            databaseName,
            schemaName,
            tableName,
            options,
        );

        if (!columnsByKey.has(key)) {
            columnsByKey.set(key, []);
        }
        columnsByKey.get(key)!.push(mapRawColumnRowToMetadata(row));
    }

    return columnsByKey;
}
