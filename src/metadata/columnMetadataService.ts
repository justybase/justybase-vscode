import {
    DatabaseColumnQueryOptions,
    DatabaseKind,
    DatabaseMetadataProvider,
    normalizeDatabaseKind,
} from '../contracts/database';
import { getDatabaseDialectByKind } from '../core/factories/databaseDialectRegistry';
import { ResultFormatter } from '../core/streaming/ResultFormatter';
import {
    ColumnsWithKeysQueryRole,
    loadNetezzaColumnsWithKeysRows,
} from '../dialects/netezza/metadata/columnsWithKeys';
import { QueryResult } from '../types';
import { ColumnMetadata as CacheColumnMetadata } from './types';
import { normalizeCompletionDescription } from '../utils/completionDescriptionUtils';

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
    joinReferences?: import('../contracts/database').DatabaseForeignKeyColumnReference[];
}

export interface RawColumnsWithKeysRow {
    OBJID?: unknown;
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
    IS_DISTRIBUTION_KEY?: boolean | number | string | null;
    ATTNUM?: number;
    [key: string]: unknown;
}

export type ColumnsWithKeysRowReader = (
    sql: string,
    role: ColumnsWithKeysQueryRole | 'relations',
) => Promise<Record<string, unknown>[]>;

function getMetadataProvider(kind?: string | DatabaseKind) {
    const dialect = getDatabaseDialectByKind(normalizeDatabaseKind(kind));
    if (!dialect) {
        throw new Error(`No database dialect registered for '${normalizeDatabaseKind(kind)}'`);
    }
    return dialect.metadataProvider;
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
    return getMetadataProvider(kind).buildColumnsWithKeysQuery(database, options);
}

/** Execute a dialect's complete columns-with-keys operation. */
export async function loadColumnsWithKeysRows(
    database: string,
    options: DatabaseColumnQueryOptions | undefined,
    kind: string | DatabaseKind | undefined,
    readRows: ColumnsWithKeysRowReader,
    metadataProvider?: DatabaseMetadataProvider,
): Promise<RawColumnsWithKeysRow[]> {
    const provider = metadataProvider ?? getMetadataProvider(kind);
    const querySet = provider.buildColumnsWithKeysQueries?.(database, options);
    let rows: RawColumnsWithKeysRow[];
    if (querySet) {
        rows = await loadNetezzaColumnsWithKeysRows(querySet, readRows) as RawColumnsWithKeysRow[];
    } else {
        rows = await readRows(provider.buildColumnsWithKeysQuery(database, options), 'columns') as RawColumnsWithKeysRow[];
    }
    const relationQuery = provider.buildForeignKeyRelationshipsQuery?.(database, options);
    if (!relationQuery) return rows;
    try {
        const relationships = await readRows(relationQuery, 'relations');
        mergeForeignKeyReferencesIntoColumnRows(rows, relationships, database);
    } catch {
        // Relationship metadata is an optional completion enhancement. A
        // catalog permission/version gap must not prevent column-cache refresh.
    }
    return rows;
}

function normalizeRelationPart(value: unknown): string {
    return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

export function mergeForeignKeyReferencesIntoColumnRows(
    rows: RawColumnsWithKeysRow[],
    relationshipRows: readonly Record<string, unknown>[],
    fallbackDatabase: string,
): void {
    const byColumn = new Map<string, RawColumnsWithKeysRow[]>();
    for (const row of rows) {
        const key = [
            normalizeRelationPart(row.DBNAME || row.DATABASE || fallbackDatabase),
            normalizeRelationPart(row.SCHEMA),
            normalizeRelationPart(row.TABLENAME || row.TABLE_NAME),
            normalizeRelationPart(row.ATTNAME || row.COLUMN_NAME),
        ].map(part => part.toUpperCase()).join('|');
        const matching = byColumn.get(key) ?? [];
        matching.push(row);
        byColumn.set(key, matching);
    }

    for (const relationship of relationshipRows) {
        const fromSchema = normalizeRelationPart(relationship.FROM_SCHEMA);
        const fromTable = normalizeRelationPart(relationship.FROM_TABLE);
        const fromColumn = normalizeRelationPart(relationship.FROM_COLUMN);
        const toSchema = normalizeRelationPart(relationship.TO_SCHEMA);
        const toTable = normalizeRelationPart(relationship.TO_TABLE);
        const toColumn = normalizeRelationPart(relationship.TO_COLUMN);
        if (!fromSchema || !fromTable || !fromColumn || !toSchema || !toTable || !toColumn) continue;
        const fromDatabase = normalizeRelationPart(relationship.FROM_DATABASE || fallbackDatabase);
        const key = [fromDatabase, fromSchema, fromTable, fromColumn]
            .map(part => part.toUpperCase()).join('|');
        const sourceRows = byColumn.get(key);
        if (!sourceRows?.length) continue;
        const reference: import('../contracts/database').DatabaseForeignKeyColumnReference = {
            fromDatabase,
            fromSchema,
            fromTable,
            fromColumn,
            toDatabase: normalizeRelationPart(relationship.TO_DATABASE || fromDatabase),
            toSchema,
            toTable,
            toColumn,
            constraintName: normalizeRelationPart(relationship.CONSTRAINT_NAME) || undefined,
            ordinalPosition: Number.isFinite(Number(relationship.ORDINAL_POSITION))
                ? Number(relationship.ORDINAL_POSITION)
                : undefined,
        };
        for (const row of sourceRows) {
            const existing = Array.isArray(row.JOIN_REFERENCES)
                ? row.JOIN_REFERENCES as import('../contracts/database').DatabaseForeignKeyColumnReference[]
                : [];
            const identity = `${reference.toDatabase}|${reference.toSchema}|${reference.toTable}|${reference.toColumn}|${reference.constraintName ?? ''}|${reference.ordinalPosition ?? ''}`.toUpperCase();
            if (!existing.some(item => `${item.toDatabase}|${item.toSchema}|${item.toTable}|${item.toColumn}|${item.constraintName ?? ''}|${item.ordinalPosition ?? ''}`.toUpperCase() === identity)) {
                row.JOIN_REFERENCES = [...existing, reference];
            }
        }
    }
}

export function buildTableColumnsQuery(
    database: string,
    schema: string,
    tableName: string,
    kind?: string | DatabaseKind
): string {
    return getMetadataProvider(kind).buildTableColumnsQuery(database, schema, tableName);
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
            description: normalizeCompletionDescription(row.DESCRIPTION) || '',
            defaultValue: null,
            isNotNull: false,
            isPk: normalizeBooleanFlag(row.IS_PK),
            isFk: normalizeBooleanFlag(row.IS_FK),
            ordinalPosition: typeof row.ATTNUM === 'number' ? row.ATTNUM : undefined,
            joinReferences: Array.isArray(row.JOIN_REFERENCES)
                ? row.JOIN_REFERENCES as import('../contracts/database').DatabaseForeignKeyColumnReference[]
                : undefined
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
            description: normalizeCompletionDescription(row.DESCRIPTION) || '',
            defaultValue: row.COLDEFAULT ? String(row.COLDEFAULT) : null,
            isNotNull: normalizeBooleanFlag(row.ATTNOTNULL),
            isPk: normalizeBooleanFlag(row.IS_PK),
            isFk: normalizeBooleanFlag(row.IS_FK),
            ordinalPosition: typeof row.ATTNUM === 'number' ? row.ATTNUM : undefined,
            joinReferences: Array.isArray(row.JOIN_REFERENCES)
                ? row.JOIN_REFERENCES as import('../contracts/database').DatabaseForeignKeyColumnReference[]
                : undefined
        });
    }

    return mapped.sort(compareOrdinalPosition);
}

export function parseColumnsWithKeysResult(result: QueryResult | undefined, fallbackDatabase?: string): CanonicalColumnMetadata[] {
    if (!result) {
        return [];
    }

    const rows = ResultFormatter.queryResultToRows<RawColumnsWithKeysRow>(result);
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
        isFk: column.isFk,
        joinReferences: column.joinReferences
    };
}

export function buildCopilotDefaultObjectTypes(kind?: string | DatabaseKind): string[] {
    return [...getMetadataProvider(kind).defaultColumnObjectTypes];
}

function compareOrdinalPosition(a: CanonicalColumnMetadata, b: CanonicalColumnMetadata): number {
    const aPos = a.ordinalPosition ?? Number.MAX_SAFE_INTEGER;
    const bPos = b.ordinalPosition ?? Number.MAX_SAFE_INTEGER;
    return aPos - bPos;
}
