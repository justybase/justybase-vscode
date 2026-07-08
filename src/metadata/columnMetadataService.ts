import { queryResultToRows } from '../core/queryRunner';
import { DatabaseKind } from '../contracts/database';
import { getDatabaseMetadataProvider } from '../core/connectionFactory';
import { QueryResult } from '../types';
import { ColumnMetadata as CacheColumnMetadata } from './types';

export interface CanonicalColumnMetadata {
    database: string;
    schema: string;
    tableName: string;
    columnName: string;
    dataType: string;
    description: string;
    defaultValue: string | null;
    isNotNull: boolean;
    isPk: boolean;
    isFk: boolean;
    ordinalPosition?: number;
}

export interface RawColumnsWithKeysRow {
    DBNAME?: string;
    DATABASE?: string;
    SCHEMA?: string;
    TABLENAME?: string;
    TABLE_NAME?: string;
    ATTNAME?: string;
    COLUMN_NAME?: string;
    FORMAT_TYPE?: string;
    DATA_TYPE?: string;
    DESCRIPTION?: string | null;
    IS_PK?: boolean | number | string | null;
    IS_FK?: boolean | number | string | null;
    ATTNUM?: number;
    [key: string]: unknown;
}

export interface RawTableColumnsRow {
    ATTNAME: string;
    DESCRIPTION?: string | null;
    FULL_TYPE?: string;
    FORMAT_TYPE?: string;
    ATTNOTNULL?: boolean | number | string | null;
    COLDEFAULT?: string | null;
    ATTNUM?: number;
    IS_PK?: boolean | number | string | null;
    IS_FK?: boolean | number | string | null;
    [key: string]: unknown;
}

export interface ColumnLocation {
    database: string;
    schema: string;
    tableName: string;
}

export interface GroupedCanonicalColumns extends ColumnLocation {
    columns: CanonicalColumnMetadata[];
}

export function normalizeBooleanFlag(value: unknown): boolean {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'number') {
        return value !== 0;
    }

    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return normalized === '1' || normalized === 't' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
    }

    return false;
}

export function buildColumnsWithKeysQuery(
    database: string,
    options?: {
        schema?: string;
        tableName?: string;
        objTypes?: string[];
    },
    kind?: string | DatabaseKind
): string {
    return getDatabaseMetadataProvider(kind).buildColumnsWithKeysQuery(database, options);
}

export function buildTableColumnsQuery(
    database: string,
    schema: string,
    tableName: string,
    kind?: string | DatabaseKind
): string {
    return getDatabaseMetadataProvider(kind).buildTableColumnsQuery(database, schema, tableName);
}

export function mapColumnsWithKeysRows(rows: RawColumnsWithKeysRow[], fallbackDatabase?: string): CanonicalColumnMetadata[] {
    const fallbackDbUpper = fallbackDatabase ? fallbackDatabase.toUpperCase() : '';
    const mapped: CanonicalColumnMetadata[] = [];

    for (const row of rows) {
        const tableName = String(row.TABLENAME || row.TABLE_NAME || '').trim();
        const columnName = String(row.ATTNAME || row.COLUMN_NAME || '').trim();
        if (!tableName || !columnName) {
            continue;
        }

        mapped.push({
            database: String(row.DBNAME || row.DATABASE || fallbackDbUpper).trim().toUpperCase(),
            schema: String(row.SCHEMA || '').trim().toUpperCase(),
            tableName: tableName.toUpperCase(),
            columnName,
            dataType: String(row.FORMAT_TYPE || row.DATA_TYPE || '').trim(),
            description: String(row.DESCRIPTION || ''),
            defaultValue: null,
            isNotNull: false,
            isPk: normalizeBooleanFlag(row.IS_PK),
            isFk: normalizeBooleanFlag(row.IS_FK),
            ordinalPosition: typeof row.ATTNUM === 'number' ? row.ATTNUM : undefined
        });
    }

    return mapped.sort(compareOrdinalPosition);
}

export function mapTableColumnsRows(rows: RawTableColumnsRow[], location: ColumnLocation): CanonicalColumnMetadata[] {
    const mapped: CanonicalColumnMetadata[] = [];
    const database = location.database.toUpperCase();
    const schema = location.schema.toUpperCase();
    const tableName = location.tableName.toUpperCase();

    for (const row of rows) {
        const columnName = String(row.ATTNAME || '').trim();
        if (!columnName) {
            continue;
        }

        mapped.push({
            database,
            schema,
            tableName,
            columnName,
            dataType: String(row.FULL_TYPE || row.FORMAT_TYPE || '').trim(),
            description: String(row.DESCRIPTION || ''),
            defaultValue: row.COLDEFAULT ? String(row.COLDEFAULT) : null,
            isNotNull: normalizeBooleanFlag(row.ATTNOTNULL),
            isPk: normalizeBooleanFlag(row.IS_PK),
            isFk: normalizeBooleanFlag(row.IS_FK),
            ordinalPosition: typeof row.ATTNUM === 'number' ? row.ATTNUM : undefined
        });
    }

    return mapped.sort(compareOrdinalPosition);
}

export function parseColumnsWithKeysResult(result: QueryResult | undefined, fallbackDatabase?: string): CanonicalColumnMetadata[] {
    if (!result) {
        return [];
    }

    const rows = queryResultToRows<RawColumnsWithKeysRow>(result);
    return mapColumnsWithKeysRows(rows, fallbackDatabase);
}

export function groupCanonicalColumnsByTable(columns: CanonicalColumnMetadata[]): GroupedCanonicalColumns[] {
    const grouped = new Map<string, GroupedCanonicalColumns>();

    for (const column of columns) {
        const key = `${column.database}.${column.schema}.${column.tableName}`;
        if (!grouped.has(key)) {
            grouped.set(key, {
                database: column.database,
                schema: column.schema,
                tableName: column.tableName,
                columns: []
            });
        }
        grouped.get(key)!.columns.push(column);
    }

    for (const item of grouped.values()) {
        item.columns.sort(compareOrdinalPosition);
    }

    return Array.from(grouped.values());
}

export function toCacheColumnMetadata(column: CanonicalColumnMetadata): CacheColumnMetadata {
    return {
        ATTNAME: column.columnName,
        FORMAT_TYPE: column.dataType,
        label: column.columnName,
        detail: column.dataType,
        kind: 5,
        documentation: column.description || '',
        isPk: column.isPk,
        isFk: column.isFk
    };
}

export function buildCopilotDefaultObjectTypes(kind?: string | DatabaseKind): string[] {
    return [...getDatabaseMetadataProvider(kind).defaultColumnObjectTypes];
}

function compareOrdinalPosition(a: CanonicalColumnMetadata, b: CanonicalColumnMetadata): number {
    const aPos = a.ordinalPosition ?? Number.MAX_SAFE_INTEGER;
    const bPos = b.ordinalPosition ?? Number.MAX_SAFE_INTEGER;
    return aPos - bPos;
}
