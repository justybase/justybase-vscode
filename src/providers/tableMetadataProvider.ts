import { QueryResult, queryResultToRows } from '../core/queryRunner';
import { DatabaseKind } from '../contracts/database';
import { getDatabaseMetadataProvider } from '../core/connectionFactory';
import { normalizeBooleanFlag } from '../metadata/columnMetadataService';
import { normalizeCompletionDescription } from '../utils/completionDescriptionUtils';
import type { MetadataQueryKind } from '../metadata/metadataQueryDiagnostics';

type TableColumnQueryRunner = (
    query: string,
    kind?: MetadataQueryKind,
) => Promise<QueryResult | undefined>;

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
 * Fetch external-table columns via the provider's separate (non-UNIONed)
 * external query, merged with main columns in code. Best-effort: any failure
 * returns an empty list so main-column results are never discarded.
 */
export async function fetchExternalTableColumnsIfAvailable(
    runQueryFn: TableColumnQueryRunner,
    database: string,
    schema: string,
    tableName: string,
    kind?: string | DatabaseKind
): Promise<ColumnMetadata[]> {
    const provider = getDatabaseMetadataProvider(kind);
    const buildQuery = provider.buildExternalTableColumnsQuery;
    if (typeof buildQuery !== 'function') {
        return [];
    }
    const query = buildQuery(database, schema, tableName);
    if (!query) {
        return [];
    }
    try {
        const result = await runQueryFn(query, 'external-table-columns');
        return parseColumnMetadata(result);
    } catch (e) {
        console.error('[TableMetadataProvider] Error fetching external table columns:', e);
        return [];
    }
}

export interface TableColumnFetchOptions {
    /** Known catalog object type. Unknown objects use an empty-main fallback once. */
    objectType?: string;
}

export function isExternalTableObjectType(objectType: string | undefined): boolean {
    return objectType?.trim().toUpperCase() === 'EXTERNAL TABLE';
}

/**
 * Fetch columns without putting external-table discovery into the main query.
 *
 * A known external table is read only from the external catalog. Known regular
 * objects use the regular catalog query only. If the object type is unknown,
 * the external catalog is probed only after the regular query returns no rows;
 * this keeps the compatibility path bounded while avoiding a second query for
 * normal tables.
 */
export async function fetchTableColumnsWithFallback(
    runQueryFn: TableColumnQueryRunner,
    database: string,
    schema: string,
    tableName: string,
    kind?: string | DatabaseKind,
    options?: TableColumnFetchOptions,
): Promise<ColumnMetadata[]> {
    if (isExternalTableObjectType(options?.objectType)) {
        return fetchExternalTableColumnsIfAvailable(
            runQueryFn,
            database,
            schema,
            tableName,
            kind,
        );
    }

    const mainResult = await runQueryFn(
        buildColumnMetadataQuery(database, schema, tableName, kind),
        'table-columns',
    );
    const mainColumns = parseColumnMetadata(mainResult);
    if (mainColumns.length > 0 || options?.objectType) {
        return mainColumns;
    }

    const externalColumns = await fetchExternalTableColumnsIfAvailable(
        runQueryFn,
        database,
        schema,
        tableName,
        kind,
    );
    const mainNames = new Set(mainColumns.map((column) => column.attname.trim().toUpperCase()));
    return mainColumns.concat(
        externalColumns.filter((column) => !mainNames.has(column.attname.trim().toUpperCase())),
    );
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
        description: normalizeCompletionDescription(row.DESCRIPTION) || '',
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
    const description = normalizeCompletionDescription(rows[0]?.DESCRIPTION);
    if (description) {
        return description;
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
    runQueryFn: TableColumnQueryRunner,
    database: string,
    schema: string,
    tableName: string,
    kind?: string | DatabaseKind,
    options?: TableColumnFetchOptions,
): Promise<TableMetadata> {
    const commentResult = await runQueryFn(
        buildTableCommentQuery(database, schema, tableName, kind),
        'comment',
    );
    const columns = await fetchTableColumnsWithFallback(
        runQueryFn,
        database,
        schema,
        tableName,
        kind,
        options,
    );

    return {
        tableComment: parseTableComment(commentResult),
        columns,
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
