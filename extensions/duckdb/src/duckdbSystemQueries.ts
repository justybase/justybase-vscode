import * as path from 'path';
import type { DatabaseColumnLookupParams, DatabaseSourceSearchQueryOptions } from '@justybase/contracts';

function quoteLiteral(value: string | undefined): string {
    return `'${(value ?? '').replace(/'/g, "''")}'`;
}

function quoteAlias(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

function normalizeOptionalName(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function unquoteValue(value: string): string {
    const trimmed = value.trim();
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
    ) {
        return trimmed.slice(1, -1).replace(/""/g, '"').replace(/''/g, '\'');
    }

    return trimmed;
}

function normalizeDuckDbCatalogName(database: string | undefined): string | undefined {
    const normalized = normalizeOptionalName(database);
    if (!normalized) {
        return undefined;
    }

    const unquoted = unquoteValue(normalized);
    if (unquoted === ':memory:') {
        return 'memory';
    }

    const fileLikeValue = unquoted.startsWith('file://') ? unquoted.replace(/^file:\/\//i, '') : unquoted;
    if (/[\\/]/.test(fileLikeValue) || /\.(duckdb|ddb|db)$/i.test(fileLikeValue)) {
        const parsed = path.win32.parse(fileLikeValue);
        return parsed.name || parsed.base || fileLikeValue;
    }

    return fileLikeValue;
}

function buildCatalogPredicate(alias: string, database?: string): string {
    const normalizedDatabase = normalizeDuckDbCatalogName(database);
    return normalizedDatabase ? `${alias} = ${quoteLiteral(normalizedDatabase)}` : `${alias} = current_catalog()`;
}

function buildSchemaPredicate(alias: string, schema?: string): string {
    const normalizedSchema = normalizeOptionalName(schema);
    return normalizedSchema ? ` AND ${alias} = ${quoteLiteral(normalizedSchema)}` : '';
}

function buildUserSchemaPredicate(alias: string): string {
    return `${alias} <> 'information_schema' AND ${alias} <> 'pg_catalog'`;
}

function buildTableTypeFilter(alias: string, objectTypes?: readonly string[]): string {
    const normalizedTypes = (objectTypes ?? [])
        .map(type => type.trim().toUpperCase())
        .filter(type => type === 'TABLE' || type === 'VIEW');

    if (normalizedTypes.length === 0) {
        return '';
    }

    const tableTypes = normalizedTypes.map(type => (type === 'VIEW' ? 'VIEW' : 'BASE TABLE'));
    return ` AND ${alias} IN (${tableTypes.map(type => quoteLiteral(type)).join(', ')})`;
}

function buildEmptyObjectTypeQuery(): string {
    return `
        SELECT
            NULL AS ${quoteAlias('OBJNAME')},
            NULL AS ${quoteAlias('SCHEMA')},
            0 AS ${quoteAlias('OBJID')},
            NULL AS ${quoteAlias('OBJTYPE')},
            NULL AS ${quoteAlias('DESCRIPTION')},
            NULL AS ${quoteAlias('OWNER')},
            NULL AS ${quoteAlias('DATABASE')}
        WHERE 1 = 0
    `;
}

function buildEmptyProcedureQuery(): string {
    return `
        SELECT
            NULL AS ${quoteAlias('SCHEMA')},
            NULL AS ${quoteAlias('PROCEDURE')},
            NULL AS ${quoteAlias('PROCEDURESIGNATURE')},
            NULL AS ${quoteAlias('OWNER')},
            NULL AS ${quoteAlias('DATABASE')}
        WHERE 1 = 0
    `;
}

function buildEmptySourceQuery(): string {
    return `
        SELECT
            NULL AS ${quoteAlias('NAME')},
            NULL AS ${quoteAlias('SCHEMA')},
            NULL AS ${quoteAlias('DATABASE')},
            NULL AS ${quoteAlias('SOURCE')},
            NULL AS ${quoteAlias('TYPE')},
            NULL AS ${quoteAlias('MATCH_TYPE')}
        WHERE 1 = 0
    `;
}

function buildTableLikeQuery(
    tableType: 'BASE TABLE' | 'VIEW',
    objectType: 'TABLE' | 'VIEW',
    database?: string,
    schema?: string
): string {
    return `
        SELECT
            t.table_name AS ${quoteAlias('OBJNAME')},
            0 AS ${quoteAlias('OBJID')},
            ${quoteLiteral(objectType)} AS ${quoteAlias('OBJTYPE')},
            t.table_schema AS ${quoteAlias('SCHEMA')},
            CASE
                WHEN ${quoteLiteral(objectType)} = 'VIEW' THEN COALESCE(v.view_definition, '')
                ELSE ''
            END AS ${quoteAlias('DESCRIPTION')},
            '' AS ${quoteAlias('OWNER')},
            t.table_catalog AS ${quoteAlias('DATABASE')}
        FROM information_schema.tables t
        LEFT JOIN information_schema.views v
            ON v.table_catalog = t.table_catalog
           AND v.table_schema = t.table_schema
           AND v.table_name = t.table_name
        WHERE ${buildCatalogPredicate('t.table_catalog', database)}
          AND ${buildUserSchemaPredicate('t.table_schema')}
          AND t.table_type = ${quoteLiteral(tableType)}
          ${buildSchemaPredicate('t.table_schema', schema)}
        ORDER BY t.table_schema, t.table_name
    `;
}

function buildColumnsBaseQuery(database: string, schema: string, tableName: string): string {
    return `
        SELECT
            c.table_catalog AS ${quoteAlias('DATABASE')},
            c.table_schema AS SCHEMA_NAME,
            c.table_name AS TABLENAME,
            c.column_name AS ATTNAME,
            c.data_type AS DATA_TYPE,
            c.data_type AS FORMAT_TYPE,
            c.data_type AS FULL_TYPE,
            CASE WHEN c.is_nullable = 'NO' THEN 1 ELSE 0 END AS IS_NOT_NULL,
            CASE WHEN c.is_nullable = 'NO' THEN 1 ELSE 0 END AS ATTNOTNULL,
            c.column_default AS COLDEFAULT,
            '' AS DESCRIPTION,
            c.ordinal_position AS ATTNUM,
            CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM information_schema.key_column_usage kcu
                    INNER JOIN information_schema.table_constraints tc
                        ON tc.constraint_catalog = kcu.constraint_catalog
                       AND tc.constraint_schema = kcu.constraint_schema
                       AND tc.constraint_name = kcu.constraint_name
                    WHERE kcu.table_catalog = c.table_catalog
                      AND kcu.table_schema = c.table_schema
                      AND kcu.table_name = c.table_name
                      AND kcu.column_name = c.column_name
                      AND tc.constraint_type = 'PRIMARY KEY'
                ) THEN 1
                ELSE 0
            END AS IS_PK,
            CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM information_schema.key_column_usage kcu
                    INNER JOIN information_schema.table_constraints tc
                        ON tc.constraint_catalog = kcu.constraint_catalog
                       AND tc.constraint_schema = kcu.constraint_schema
                       AND tc.constraint_name = kcu.constraint_name
                    WHERE kcu.table_catalog = c.table_catalog
                      AND kcu.table_schema = c.table_schema
                      AND kcu.table_name = c.table_name
                      AND kcu.column_name = c.column_name
                      AND tc.constraint_type = 'FOREIGN KEY'
                ) THEN 1
                ELSE 0
            END AS IS_FK
        FROM information_schema.columns c
        WHERE ${buildCatalogPredicate('c.table_catalog', database)}
          AND ${buildUserSchemaPredicate('c.table_schema')}
          AND c.table_schema = ${quoteLiteral(schema)}
          AND c.table_name = ${quoteLiteral(tableName)}
        ORDER BY c.ordinal_position
    `;
}

export function buildListDatabasesQuery(): string {
    return `
        SELECT
            database_name AS ${quoteAlias('DATABASE')}
        FROM duckdb_databases()
        WHERE internal = false
        ORDER BY CASE WHEN database_name = current_catalog() THEN 0 ELSE 1 END, database_name
    `;
}

export function buildListSchemasQuery(database?: string): string {
    return `
        SELECT
            schema_name AS ${quoteAlias('SCHEMA')}
        FROM information_schema.schemata
        WHERE ${buildCatalogPredicate('catalog_name', database)}
          AND ${buildUserSchemaPredicate('schema_name')}
        ORDER BY CASE WHEN schema_name = current_schema() THEN 0 ELSE 1 END, schema_name
    `;
}

export function buildListTablesQuery(database: string, schema?: string): string {
    return buildTableLikeQuery('BASE TABLE', 'TABLE', database, schema);
}

export function buildListViewsQuery(database: string, schema?: string): string {
    return buildTableLikeQuery('VIEW', 'VIEW', database, schema);
}

export function buildListProceduresQuery(): string {
    return buildEmptyProcedureQuery();
}

export function buildObjectTypeQuery(database: string, objectType: string): string {
    const normalizedType = objectType.trim().toUpperCase();

    if (normalizedType === 'TABLE') {
        return buildListTablesQuery(database);
    }

    if (normalizedType === 'VIEW') {
        return buildListViewsQuery(database);
    }

    return buildEmptyObjectTypeQuery();
}

export function buildTypeGroupsQuery(): string {
    return `
        SELECT 'TABLE' AS ${quoteAlias('OBJTYPE')}
        UNION ALL
        SELECT 'VIEW' AS ${quoteAlias('OBJTYPE')}
    `;
}

export function buildColumnsWithKeysQuery(
    database: string,
    schema?: string,
    tableName?: string,
    objTypes?: readonly string[]
): string {
    return `
        SELECT
            c.table_catalog AS ${quoteAlias('DATABASE')},
            c.table_schema AS SCHEMA_NAME,
            c.table_name AS TABLENAME,
            c.column_name AS ATTNAME,
            c.data_type AS DATA_TYPE,
            c.data_type AS FORMAT_TYPE,
            c.data_type AS FULL_TYPE,
            CASE WHEN c.is_nullable = 'NO' THEN 1 ELSE 0 END AS IS_NOT_NULL,
            CASE WHEN c.is_nullable = 'NO' THEN 1 ELSE 0 END AS ATTNOTNULL,
            c.column_default AS COLDEFAULT,
            '' AS DESCRIPTION,
            c.ordinal_position AS ATTNUM,
            CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM information_schema.key_column_usage kcu
                    INNER JOIN information_schema.table_constraints tc
                        ON tc.constraint_catalog = kcu.constraint_catalog
                       AND tc.constraint_schema = kcu.constraint_schema
                       AND tc.constraint_name = kcu.constraint_name
                    WHERE kcu.table_catalog = c.table_catalog
                      AND kcu.table_schema = c.table_schema
                      AND kcu.table_name = c.table_name
                      AND kcu.column_name = c.column_name
                      AND tc.constraint_type = 'PRIMARY KEY'
                ) THEN 1
                ELSE 0
            END AS IS_PK,
            CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM information_schema.key_column_usage kcu
                    INNER JOIN information_schema.table_constraints tc
                        ON tc.constraint_catalog = kcu.constraint_catalog
                       AND tc.constraint_schema = kcu.constraint_schema
                       AND tc.constraint_name = kcu.constraint_name
                    WHERE kcu.table_catalog = c.table_catalog
                      AND kcu.table_schema = c.table_schema
                      AND kcu.table_name = c.table_name
                      AND kcu.column_name = c.column_name
                      AND tc.constraint_type = 'FOREIGN KEY'
                ) THEN 1
                ELSE 0
            END AS IS_FK
        FROM information_schema.columns c
        INNER JOIN information_schema.tables t
            ON t.table_catalog = c.table_catalog
           AND t.table_schema = c.table_schema
           AND t.table_name = c.table_name
        WHERE ${buildCatalogPredicate('c.table_catalog', database)}
          AND ${buildUserSchemaPredicate('c.table_schema')}
          ${buildSchemaPredicate('c.table_schema', schema)}
          ${tableName ? `AND c.table_name = ${quoteLiteral(tableName)}` : ''}
          ${buildTableTypeFilter('t.table_type', objTypes)}
        ORDER BY c.table_schema, c.table_name, c.ordinal_position
    `;
}

export function buildTableColumnsQuery(database: string, schema: string, tableName: string): string {
    return buildColumnsBaseQuery(database, schema, tableName);
}

export function buildColumnMetadataQuery(database: string, schema: string, tableName: string): string {
    return buildColumnsBaseQuery(database, schema, tableName);
}

export function buildLookupColumnsQuery(params: DatabaseColumnLookupParams): string {
    const schema = normalizeOptionalName(params.schema) ?? 'main';
    return `
        SELECT
            table_schema AS SCHEMA_NAME,
            table_name AS TABLENAME,
            column_name AS ATTNAME,
            data_type AS FORMAT_TYPE,
            ordinal_position AS ATTNUM
        FROM information_schema.columns
        WHERE ${buildCatalogPredicate('table_catalog', params.database)}
          AND table_schema = ${quoteLiteral(schema)}
          AND table_name = ${quoteLiteral(params.tableName)}
        ORDER BY table_schema, table_name, ordinal_position
    `;
}

export function buildTableCommentQuery(): string {
    return `SELECT '' AS ${quoteAlias('DESCRIPTION')}`;
}

export function buildObjectSearchQuery(database: string, likePattern: string): string {
    return `
        SELECT * FROM (
            SELECT
                1 AS ${quoteAlias('PRIORITY')},
                t.table_name AS ${quoteAlias('NAME')},
                t.table_schema AS ${quoteAlias('SCHEMA')},
                t.table_catalog AS ${quoteAlias('DATABASE')},
                CASE WHEN t.table_type = 'VIEW' THEN 'VIEW' ELSE 'TABLE' END AS ${quoteAlias('TYPE')},
                '' AS ${quoteAlias('PARENT')},
                CASE WHEN t.table_type = 'VIEW' THEN COALESCE(v.view_definition, '') ELSE '' END AS ${quoteAlias('DESCRIPTION')},
                'NAME' AS ${quoteAlias('MATCH_TYPE')}
            FROM information_schema.tables t
            LEFT JOIN information_schema.views v
                ON v.table_catalog = t.table_catalog
               AND v.table_schema = t.table_schema
               AND v.table_name = t.table_name
            WHERE ${buildCatalogPredicate('t.table_catalog', database)}
              AND ${buildUserSchemaPredicate('t.table_schema')}
              AND UPPER(t.table_name) LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                2 AS ${quoteAlias('PRIORITY')},
                c.column_name AS ${quoteAlias('NAME')},
                c.table_schema AS ${quoteAlias('SCHEMA')},
                c.table_catalog AS ${quoteAlias('DATABASE')},
                'COLUMN' AS ${quoteAlias('TYPE')},
                c.table_name AS ${quoteAlias('PARENT')},
                '' AS ${quoteAlias('DESCRIPTION')},
                'NAME' AS ${quoteAlias('MATCH_TYPE')}
            FROM information_schema.columns c
            WHERE ${buildCatalogPredicate('c.table_catalog', database)}
              AND ${buildUserSchemaPredicate('c.table_schema')}
              AND UPPER(c.column_name) LIKE '${likePattern}' ESCAPE '\\'
        ) AS SEARCH_RESULTS
        ORDER BY ${quoteAlias('PRIORITY')}, ${quoteAlias('SCHEMA')}, ${quoteAlias('PARENT')}, ${quoteAlias('NAME')}
        LIMIT 200
    `;
}

export function buildViewSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string {
    if (options.useServerSideFilter) {
        return `
            SELECT
                table_name AS ${quoteAlias('NAME')},
                table_schema AS ${quoteAlias('SCHEMA')},
                table_catalog AS ${quoteAlias('DATABASE')}
            FROM information_schema.views
            WHERE ${buildCatalogPredicate('table_catalog', database)}
              AND ${buildUserSchemaPredicate('table_schema')}
              AND UPPER(view_definition) LIKE '${options.likePattern}' ESCAPE '\\'
        `;
    }

    return `
        SELECT
            table_name AS ${quoteAlias('NAME')},
            table_schema AS ${quoteAlias('SCHEMA')},
            table_catalog AS ${quoteAlias('DATABASE')},
            view_definition AS ${quoteAlias('SOURCE')},
            'VIEW' AS ${quoteAlias('TYPE')},
            'SOURCE' AS ${quoteAlias('MATCH_TYPE')}
        FROM information_schema.views
        WHERE ${buildCatalogPredicate('table_catalog', database)}
          AND ${buildUserSchemaPredicate('table_schema')}
    `;
}

export function buildProcedureSourceSearchQuery(): string {
    return buildEmptySourceQuery();
}
