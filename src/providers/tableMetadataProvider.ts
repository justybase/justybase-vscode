import { QueryResult, queryResultToRows } from '../core/queryRunner';
import { DatabaseKind } from '../contracts/database';
import { getDatabaseMetadataProvider } from '../core/connectionFactory';
import { normalizeBooleanFlag } from '../metadata/columnMetadataService';

/**
 * Column metadata structure
 */
export interface ColumnMetadata {
    attname: string;
    formatType: string;
    isNotNull: boolean;
    colDefault: string | null;
    description: string;
    isPk: boolean;
    isFk: boolean;
    isDistributionKey?: boolean;
}

/**
 * Complete table metadata structure
 */
export interface TableMetadata {
    tableComment: string | null;
    columns: ColumnMetadata[];
}

/**
 * Raw column data as returned from SQL query (uppercase keys)
 */
export interface RawColumnRow {
    ATTNAME: string;
    FORMAT_TYPE: string;
    IS_NOT_NULL: number | string | boolean;
    COLDEFAULT: string | null;
    DESCRIPTION: string;
    IS_PK: number | string;
    IS_FK: number | string;
    IS_DISTRIBUTION_KEY?: number | string;
    [key: string]: unknown;
}

/**
 * Build SQL query to fetch table comment/description
 */
export function buildTableCommentQuery(
    database: string,
    schema: string,
    tableName: string,
    kind?: string | DatabaseKind
): string {
    return getDatabaseMetadataProvider(kind).buildTableCommentQuery(database, schema, tableName);
}

/**
 * Build SQL query to fetch column metadata with PK/FK indicators
 *
 * This is the canonical query that should be used everywhere when fetching
 * full column metadata including primary/foreign key status.
 */
export function buildColumnMetadataQuery(
    database: string,
    schema: string,
    tableName: string,
    kind?: string | DatabaseKind
): string {
    return getDatabaseMetadataProvider(kind).buildColumnMetadataQuery(database, schema, tableName);
}

/**
 * Convert raw SQL row to normalized ColumnMetadata
 */
export function parseColumnRow(row: RawColumnRow): ColumnMetadata {
    const isNotNull = normalizeBooleanFlag(row.IS_NOT_NULL);

    return {
        attname: row.ATTNAME,
        formatType: row.FORMAT_TYPE,
        isNotNull,
        colDefault: row.COLDEFAULT || null,
        description: row.DESCRIPTION || '',
        isPk: normalizeBooleanFlag(row.IS_PK),
        isFk: normalizeBooleanFlag(row.IS_FK),
        isDistributionKey: row.IS_DISTRIBUTION_KEY !== undefined 
            ? normalizeBooleanFlag(row.IS_DISTRIBUTION_KEY) 
            : undefined
    };
}

/**
 * Parse table comment from query result
 */
/**
 * Parse table comment from query result
 */
export function parseTableComment(result: QueryResult | undefined): string | null {
    if (!result) return null;
    const rows = queryResultToRows<{ DESCRIPTION: string }>(result);
    if (rows.length > 0 && rows[0].DESCRIPTION) {
        return rows[0].DESCRIPTION;
    }
    return null;
}

/**
 * Parse column metadata from query result
 */
/**
 * Parse column metadata from query result
 */
export function parseColumnMetadata(result: QueryResult | undefined): ColumnMetadata[] {
    if (!result) return [];
    try {
        const rows = queryResultToRows<RawColumnRow>(result);
        return rows.map(parseColumnRow);
    } catch (e) {
        console.error('[TableMetadataProvider] Error parsing column metadata:', e);
        return [];
    }
}

/**
 * Fetch complete table metadata (comment + columns with PK/FK info)
 *
 * @param runQueryFn - Query execution function that returns JSON string
 * @param database - Database name
 * @param schema - Schema name
 * @param tableName - Table name
 * @returns TableMetadata object with normalized data
 */
export async function getTableMetadata(
    runQueryFn: (query: string) => Promise<QueryResult | undefined>,
    database: string,
    schema: string,
    tableName: string,
    kind?: string | DatabaseKind
): Promise<TableMetadata> {
    const commentQuery = buildTableCommentQuery(database, schema, tableName, kind);
    const columnQuery = buildColumnMetadataQuery(database, schema, tableName, kind);

    const [commentResult, columnResult] = await Promise.all([runQueryFn(commentQuery), runQueryFn(columnQuery)]);

    return {
        tableComment: parseTableComment(commentResult),
        columns: parseColumnMetadata(columnResult)
    };
}

/**
 * Convert ColumnMetadata to the format expected by webview (uppercase keys for compatibility)
 */
export function toWebviewFormat(columns: ColumnMetadata[]): RawColumnRow[] {
    return columns.map(col => ({
        ATTNAME: col.attname,
        FORMAT_TYPE: col.formatType,
        IS_NOT_NULL: col.isNotNull ? 1 : 0,
        COLDEFAULT: col.colDefault,
        DESCRIPTION: col.description,
        IS_PK: col.isPk ? 1 : 0,
        IS_FK: col.isFk ? 1 : 0
    }));
}
