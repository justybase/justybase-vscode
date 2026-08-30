import type {
    DatabaseColumnLookupParams,
    DatabaseSourceSearchQueryOptions,
} from '@justybase/contracts';

export const CLICKHOUSE_DEFAULT_OBJECT_TYPES = ['TABLE', 'VIEW', 'MATERIALIZED VIEW'] as const;
export const CLICKHOUSE_DEFAULT_COLUMN_OBJECT_TYPES = ['TABLE', 'VIEW', 'MATERIALIZED VIEW'] as const;

type ClickHouseObjectType = 'TABLE' | 'VIEW' | 'MATERIALIZED VIEW';

const CLICKHOUSE_VIEW_ENGINES = "('View', 'MaterializedView', 'LiveView', 'WindowView')";

function quoteLiteral(value: string | undefined): string {
    return `'${(value ?? '').replace(/'/g, "''")}'`;
}

function quoteIdentifier(value: string): string {
    return `\`${value.replace(/`/g, '``')}\``;
}

function normalizeName(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

function effectiveDatabase(database: string | undefined, schema?: string): string {
    return normalizeName(schema) ?? normalizeName(database) ?? '';
}

function emptyObjectQuery(): string {
    return `
        SELECT
            CAST('' AS String) AS ${quoteIdentifier('OBJNAME')},
            CAST('' AS String) AS ${quoteIdentifier('SCHEMA')},
            toUInt64(0) AS ${quoteIdentifier('OBJID')},
            CAST('' AS String) AS ${quoteIdentifier('OBJTYPE')},
            CAST('' AS String) AS ${quoteIdentifier('DESCRIPTION')},
            CAST('' AS String) AS ${quoteIdentifier('OWNER')},
            CAST('' AS String) AS ${quoteIdentifier('DATABASE')}
        WHERE 1 = 0
    `;
}

function tableObjectTypeExpression(alias = ''): string {
    const prefix = alias ? `${alias}.` : '';
    return `multiIf(
        ${prefix}engine = 'MaterializedView', 'MATERIALIZED VIEW',
        ${prefix}engine IN ('View', 'LiveView', 'WindowView'), 'VIEW',
        'TABLE'
    )`;
}

function tableEnginePredicate(objectType: ClickHouseObjectType): string {
    if (objectType === 'TABLE') {
        return `AND engine NOT IN ${CLICKHOUSE_VIEW_ENGINES}`;
    }
    if (objectType === 'MATERIALIZED VIEW') {
        return "AND engine = 'MaterializedView'";
    }
    return `AND engine IN ${CLICKHOUSE_VIEW_ENGINES}`;
}

function tableListQuery(
    database: string,
    schema: string | undefined,
    objectType: ClickHouseObjectType,
): string {
    const effective = effectiveDatabase(database, schema);
    return `
        SELECT
            name AS ${quoteIdentifier('OBJNAME')},
            database AS ${quoteIdentifier('SCHEMA')},
            toUInt64(0) AS ${quoteIdentifier('OBJID')},
            ${objectType === 'VIEW' ? tableObjectTypeExpression() : quoteLiteral(objectType)} AS ${quoteIdentifier('OBJTYPE')},
            ifNull(comment, '') AS ${quoteIdentifier('DESCRIPTION')},
            CAST('' AS String) AS ${quoteIdentifier('OWNER')},
            database AS ${quoteIdentifier('DATABASE')},
            engine AS ${quoteIdentifier('CLICKHOUSE_ENGINE')},
            ifNull(partition_key, '') AS ${quoteIdentifier('CLICKHOUSE_PARTITION_BY')},
            ifNull(primary_key, '') AS ${quoteIdentifier('CLICKHOUSE_PRIMARY_KEY')},
            ifNull(sorting_key, '') AS ${quoteIdentifier('CLICKHOUSE_ORDER_BY')},
            ifNull(sampling_key, '') AS ${quoteIdentifier('CLICKHOUSE_SAMPLE_BY')}
        FROM system.tables
        WHERE 1 = 1
          ${effective ? `AND database = ${quoteLiteral(effective)}` : ''}
          ${tableEnginePredicate(objectType)}
        ORDER BY database, name
    `;
}

function routineEmptyQuery(): string {
    return `
        SELECT
            CAST('' AS String) AS ${quoteIdentifier('SCHEMA')},
            CAST('' AS String) AS ${quoteIdentifier('PROCEDURE')},
            CAST('' AS String) AS ${quoteIdentifier('PROCEDURESIGNATURE')},
            CAST('' AS String) AS ${quoteIdentifier('OWNER')},
            CAST('' AS String) AS ${quoteIdentifier('DATABASE')}
        WHERE 1 = 0
    `;
}

function buildColumnQuery(
    database: string,
    schema: string | undefined,
    tableName: string | undefined,
    objectTypes?: readonly string[],
): string {
    const effective = effectiveDatabase(database, schema);
    const normalizedTypes = objectTypes?.map(type => type.trim().toUpperCase()).filter(Boolean) ?? [];
    const objectPredicate = normalizedTypes.length > 0
        ? `AND ${tableObjectTypeExpression('t')} IN (${normalizedTypes.map(quoteLiteral).join(', ')})`
        : '';
    return `
        SELECT
            c.database AS ${quoteIdentifier('SCHEMA_NAME')},
            c.table AS ${quoteIdentifier('TABLENAME')},
            c.name AS ${quoteIdentifier('ATTNAME')},
            c.type AS ${quoteIdentifier('DATA_TYPE')},
            c.type AS ${quoteIdentifier('FORMAT_TYPE')},
            c.type AS ${quoteIdentifier('FULL_TYPE')},
            if(startsWith(c.type, 'Nullable('), 0, 1) AS ${quoteIdentifier('IS_NOT_NULL')},
            if(startsWith(c.type, 'Nullable('), 0, 1) AS ${quoteIdentifier('ATTNOTNULL')},
            if(c.default_kind = '', NULL, c.default_expression) AS ${quoteIdentifier('COLDEFAULT')},
            ifNull(c.comment, '') AS ${quoteIdentifier('DESCRIPTION')},
            c.position AS ${quoteIdentifier('ATTNUM')},
            c.default_kind AS ${quoteIdentifier('EXTRA')},
            if(c.is_in_primary_key = 1, 1, 0) AS ${quoteIdentifier('IS_PK')},
            ifNull(t.primary_key, '') AS ${quoteIdentifier('PRIMARY_KEY_EXPRESSION')},
            toUInt8(0) AS ${quoteIdentifier('IS_FK')}
        FROM system.columns AS c
        LEFT JOIN system.tables AS t
          ON t.database = c.database AND t.name = c.table
        WHERE 1 = 1
          ${effective ? `AND c.database = ${quoteLiteral(effective)}` : ''}
          ${tableName ? `AND c.table = ${quoteLiteral(tableName)}` : ''}
          ${objectPredicate}
        ORDER BY c.database, c.table, c.position
    `;
}

export function buildFindTableSchemaQuery(_database: string, tableName: string): string {
    return `
        SELECT database AS ${quoteIdentifier('SCHEMA')}
        FROM system.tables
        WHERE name = ${quoteLiteral(tableName)}
        ORDER BY database
    `;
}

export function buildListDatabasesQuery(): string {
    return `
        SELECT
            name AS ${quoteIdentifier('DATABASE')},
            name AS ${quoteIdentifier('label')},
            ifNull(comment, '') AS ${quoteIdentifier('detail')}
        FROM system.databases
        ORDER BY name
    `;
}

export function buildListSchemasQuery(database?: string): string {
    const normalized = normalizeName(database);
    return `
        SELECT
            name AS ${quoteIdentifier('SCHEMA')},
            name AS ${quoteIdentifier('label')},
            ifNull(comment, '') AS ${quoteIdentifier('detail')}
        FROM system.databases
        ${normalized ? `WHERE name = ${quoteLiteral(normalized)}` : ''}
        ORDER BY name
    `;
}

export function buildListTablesQuery(database: string, schema?: string): string {
    return tableListQuery(database, schema, 'TABLE');
}

export function buildListViewsQuery(database: string, schema?: string): string {
    return tableListQuery(database, schema, 'VIEW');
}

export function buildListMaterializedViewsQuery(database: string, schema?: string): string {
    return tableListQuery(database, schema, 'MATERIALIZED VIEW');
}

export function buildListProceduresQuery(_database: string, _schema?: string): string {
    return routineEmptyQuery();
}

export function buildObjectTypeQuery(database: string, objectType: string): string {
    const normalized = objectType.trim().toUpperCase();
    if (normalized === 'TABLE') {
        return tableListQuery(database, undefined, 'TABLE');
    }
    if (normalized === 'VIEW') {
        return tableListQuery(database, undefined, 'VIEW');
    }
    if (normalized === 'MATERIALIZED VIEW') {
        return tableListQuery(database, undefined, 'MATERIALIZED VIEW');
    }
    if (normalized === 'DATABASE') {
        return `
            SELECT
                name AS ${quoteIdentifier('OBJNAME')},
                CAST('' AS String) AS ${quoteIdentifier('SCHEMA')},
                toUInt64(0) AS ${quoteIdentifier('OBJID')},
                'DATABASE' AS ${quoteIdentifier('OBJTYPE')},
                ifNull(comment, '') AS ${quoteIdentifier('DESCRIPTION')},
                CAST('' AS String) AS ${quoteIdentifier('OWNER')},
                name AS ${quoteIdentifier('DATABASE')}
            FROM system.databases
            ORDER BY name
        `;
    }
    return emptyObjectQuery();
}

export function buildTypeGroupsQuery(_database?: string): string {
    return `
        SELECT 'TABLE' AS ${quoteIdentifier('OBJTYPE')}
        UNION ALL SELECT 'VIEW' AS ${quoteIdentifier('OBJTYPE')}
        UNION ALL SELECT 'MATERIALIZED VIEW' AS ${quoteIdentifier('OBJTYPE')}
    `;
}

export function buildColumnsWithKeysQuery(
    database: string,
    schema?: string,
    tableName?: string,
    objTypes?: readonly string[],
): string {
    return buildColumnQuery(database, schema, tableName, objTypes);
}

export function buildTableColumnsQuery(database: string, schema: string, tableName: string): string {
    return buildColumnQuery(database, schema, tableName, ['TABLE', 'VIEW', 'MATERIALIZED VIEW']);
}

export function buildColumnMetadataQuery(database: string, schema: string, tableName: string): string {
    return buildColumnQuery(database, schema, tableName, ['TABLE', 'VIEW', 'MATERIALIZED VIEW']);
}

/**
 * Fetches storage metadata for one table-like object. The full CREATE query is
 * read lazily so a normal catalog refresh does not copy large view bodies.
 */
export function buildTableDefinitionQuery(database: string, schema: string, tableName: string): string {
    const effective = effectiveDatabase(database, schema);
    return `
        SELECT
            engine AS ${quoteIdentifier('CLICKHOUSE_ENGINE')},
            ifNull(partition_key, '') AS ${quoteIdentifier('CLICKHOUSE_PARTITION_BY')},
            ifNull(primary_key, '') AS ${quoteIdentifier('CLICKHOUSE_PRIMARY_KEY')},
            ifNull(sorting_key, '') AS ${quoteIdentifier('CLICKHOUSE_ORDER_BY')},
            ifNull(sampling_key, '') AS ${quoteIdentifier('CLICKHOUSE_SAMPLE_BY')},
            create_table_query AS ${quoteIdentifier('CLICKHOUSE_SOURCE_DDL')}
        FROM system.tables
        WHERE database = ${quoteLiteral(effective)}
          AND name = ${quoteLiteral(tableName)}
        LIMIT 1
    `;
}

export function buildLookupColumnsQuery(params: DatabaseColumnLookupParams): string {
    const database = effectiveDatabase(params.database, params.schema);
    return `
        SELECT
            database AS ${quoteIdentifier('SCHEMA_NAME')},
            table AS ${quoteIdentifier('TABLE_NAME')},
            name AS ${quoteIdentifier('COLUMN_NAME')}
        FROM system.columns
        WHERE table = ${quoteLiteral(params.tableName)}
          ${database ? `AND database = ${quoteLiteral(database)}` : ''}
        ORDER BY database, table, position
    `;
}

export function buildTableCommentQuery(database: string, schema: string, tableName: string): string {
    const effective = effectiveDatabase(database, schema);
    return `
        SELECT ifNull(comment, '') AS ${quoteIdentifier('DESCRIPTION')}
        FROM system.tables
        WHERE database = ${quoteLiteral(effective)}
          AND name = ${quoteLiteral(tableName)}
        LIMIT 1
    `;
}

export function buildObjectSearchQuery(database: string, likePattern: string): string {
    const databaseFilter = database.trim() ? `AND database = ${quoteLiteral(database)}` : '';
    const pattern = quoteLiteral(likePattern);
    return `
        SELECT * FROM (
            SELECT
                1 AS ${quoteIdentifier('PRIORITY')},
                name AS ${quoteIdentifier('NAME')},
                database AS ${quoteIdentifier('SCHEMA')},
                database AS ${quoteIdentifier('DATABASE')},
                ${tableObjectTypeExpression()} AS ${quoteIdentifier('TYPE')},
                CAST('' AS String) AS ${quoteIdentifier('PARENT')},
                ifNull(comment, '') AS ${quoteIdentifier('DESCRIPTION')},
                'NAME' AS ${quoteIdentifier('MATCH_TYPE')}
            FROM system.tables
            WHERE name ILIKE ${pattern} ${databaseFilter}
            UNION ALL
            SELECT
                2 AS ${quoteIdentifier('PRIORITY')},
                c.name AS ${quoteIdentifier('NAME')},
                c.database AS ${quoteIdentifier('SCHEMA')},
                c.database AS ${quoteIdentifier('DATABASE')},
                'COLUMN' AS ${quoteIdentifier('TYPE')},
                c.table AS ${quoteIdentifier('PARENT')},
                ifNull(c.comment, '') AS ${quoteIdentifier('DESCRIPTION')},
                'NAME' AS ${quoteIdentifier('MATCH_TYPE')}
            FROM system.columns AS c
            WHERE c.name ILIKE ${pattern}
              ${database.trim() ? `AND c.database = ${quoteLiteral(database)}` : ''}
        ) AS search_results
        ORDER BY ${quoteIdentifier('PRIORITY')}, ${quoteIdentifier('NAME')}
        LIMIT 200
    `;
}

export function buildViewSourceSearchQuery(
    database: string,
    options: DatabaseSourceSearchQueryOptions,
): string {
    const filter = options.useServerSideFilter ? `AND create_table_query ILIKE ${quoteLiteral(options.likePattern)}` : '';
    return `
        SELECT
            name AS ${quoteIdentifier('NAME')},
            database AS ${quoteIdentifier('SCHEMA')},
            database AS ${quoteIdentifier('DATABASE')},
            create_table_query AS ${quoteIdentifier('SOURCE')}
        FROM system.tables
        WHERE database = ${quoteLiteral(database)}
          AND engine IN ('View', 'MaterializedView', 'LiveView', 'WindowView')
          ${filter}
        ORDER BY name
    `;
}

export function buildProcedureSourceSearchQuery(
    _database: string,
    _options: DatabaseSourceSearchQueryOptions,
): string {
    return `
        SELECT
            CAST('' AS String) AS ${quoteIdentifier('NAME')},
            CAST('' AS String) AS ${quoteIdentifier('SCHEMA')},
            CAST('' AS String) AS ${quoteIdentifier('DATABASE')},
            CAST('' AS String) AS ${quoteIdentifier('TYPE')},
            CAST('' AS String) AS ${quoteIdentifier('SOURCE')}
        WHERE 1 = 0
    `;
}
