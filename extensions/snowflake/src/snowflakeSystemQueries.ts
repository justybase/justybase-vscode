import type { DatabaseColumnLookupParams, DatabaseSourceSearchQueryOptions } from '@justybase/contracts';
import { normalizeCatalogIdentifier } from '../../../src/core/connectionUtils';

const SNOWFLAKE_DEFAULT_OBJECT_TYPES = [
    'TABLE',
    'VIEW',
    'PROCEDURE',
    'FUNCTION',
    'SEQUENCE',
    'STAGE',
    'STREAM',
    'TASK',
    'FILE FORMAT',
    'DYNAMIC TABLE',
    'WAREHOUSE',
] as const;
const SNOWFLAKE_DEFAULT_COLUMN_OBJECT_TYPES = ['TABLE', 'VIEW', 'DYNAMIC TABLE'] as const;

function quoteLiteral(value: string | undefined): string {
    return `'${(value ?? '').replace(/'/g, "''")}'`;
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

function normalizeOptionalName(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? normalizeCatalogIdentifier(trimmed) : undefined;
}

function buildInfoSchemaView(database: string | undefined, viewName: string): string {
    const normalizedDatabase = normalizeOptionalName(database);
    return normalizedDatabase
        ? `${quoteIdentifier(normalizedDatabase)}.INFORMATION_SCHEMA.${viewName}`
        : `INFORMATION_SCHEMA.${viewName}`;
}

function buildSchemaPredicate(schema?: string, alias = 'TABLE_SCHEMA'): string {
    const normalizedSchema = normalizeOptionalName(schema);
    return normalizedSchema ? ` AND ${alias} = ${quoteLiteral(normalizedSchema)}` : '';
}

function buildDatabasePredicate(database?: string, alias = 'TABLE_CATALOG'): string {
    const normalizedDatabase = normalizeOptionalName(database);
    return normalizedDatabase ? ` AND ${alias} = ${quoteLiteral(normalizedDatabase)}` : '';
}

function buildEmptyObjectQuery(): string {
    return `
        SELECT
            CAST(NULL AS VARCHAR) AS "OBJNAME",
            CAST(NULL AS VARCHAR) AS "SCHEMA",
            CAST(NULL AS NUMBER) AS "OBJID",
            CAST(NULL AS VARCHAR) AS "OBJTYPE",
            CAST(NULL AS VARCHAR) AS "DESCRIPTION",
            CAST(NULL AS VARCHAR) AS "OWNER",
            CAST(NULL AS VARCHAR) AS "DATABASE"
        WHERE 1 = 0
    `;
}

function buildShowResultQuery(showSql: string, selectSql: string): string {
    return `${showSql}\n->> ${selectSql}`;
}

function buildDynamicTableDescriptionExpression(alias = ''): string {
    const prefix = alias ? `${alias}.` : '';
    return `RTRIM(
                CONCAT(
                    'State: ', COALESCE(${prefix}"scheduling_state", 'UNKNOWN'),
                    ' | Target Lag: ', COALESCE(${prefix}"target_lag", CASE WHEN COALESCE(${prefix}"scheduler", 'ENABLE') = 'DISABLE' THEN 'DISABLED' ELSE 'N/A' END),
                    ' | Warehouse: ', COALESCE(${prefix}"warehouse", 'N/A'),
                    ' | Refresh Mode: ', COALESCE(${prefix}"refresh_mode", 'N/A'),
                    CASE
                        WHEN COALESCE(${prefix}"comment", '') <> '' THEN CONCAT('\n\n', ${prefix}"comment")
                        ELSE ''
                    END
                )
            )`;
}

function buildShowWarehousesQuery(database: string): string {
    return buildShowResultQuery(
        'SHOW WAREHOUSES',
        `
            SELECT
                "name" AS "OBJNAME",
                "name" AS "label",
                CAST(NULL AS VARCHAR) AS "SCHEMA",
                0 AS "OBJID",
                'WAREHOUSE' AS "OBJTYPE",
                COALESCE("comment", '') AS "DESCRIPTION",
                "owner" AS "OWNER",
                ${quoteLiteral(database)} AS "DATABASE"
            FROM $1
            ORDER BY "name"
        `,
    );
}

function buildShowStagesQuery(database: string): string {
    return buildShowResultQuery(
        `SHOW STAGES IN DATABASE ${quoteIdentifier(database)}`,
        `
            SELECT
                "name" AS "OBJNAME",
                "name" AS "label",
                "schema_name" AS "SCHEMA",
                0 AS "OBJID",
                'STAGE' AS "OBJTYPE",
                COALESCE("comment", '') AS "DESCRIPTION",
                "owner" AS "OWNER",
                "database_name" AS "DATABASE"
            FROM $1
            ORDER BY "schema_name", "name"
        `,
    );
}

function buildShowStreamsQuery(database: string): string {
    return buildShowResultQuery(
        `SHOW STREAMS IN DATABASE ${quoteIdentifier(database)}`,
        `
            SELECT
                "name" AS "OBJNAME",
                "name" AS "label",
                "schema_name" AS "SCHEMA",
                0 AS "OBJID",
                'STREAM' AS "OBJTYPE",
                COALESCE("comment", '') AS "DESCRIPTION",
                "owner" AS "OWNER",
                "database_name" AS "DATABASE"
            FROM $1
            ORDER BY "schema_name", "name"
        `,
    );
}

function buildShowTasksQuery(database: string): string {
    return buildShowResultQuery(
        `SHOW TASKS IN DATABASE ${quoteIdentifier(database)}`,
        `
            SELECT
                "name" AS "OBJNAME",
                "name" AS "label",
                "schema_name" AS "SCHEMA",
                0 AS "OBJID",
                'TASK' AS "OBJTYPE",
                COALESCE("comment", '') AS "DESCRIPTION",
                "owner" AS "OWNER",
                "database_name" AS "DATABASE"
            FROM $1
            ORDER BY "schema_name", "name"
        `,
    );
}

function buildShowFileFormatsQuery(database: string): string {
    return buildShowResultQuery(
        `SHOW FILE FORMATS IN DATABASE ${quoteIdentifier(database)}`,
        `
            SELECT
                "name" AS "OBJNAME",
                "name" AS "label",
                "schema_name" AS "SCHEMA",
                0 AS "OBJID",
                'FILE FORMAT' AS "OBJTYPE",
                COALESCE("comment", '') AS "DESCRIPTION",
                "owner" AS "OWNER",
                "database_name" AS "DATABASE"
            FROM $1
            ORDER BY "schema_name", "name"
        `,
    );
}

function buildShowDynamicTablesQuery(database: string): string {
    return buildShowResultQuery(
        `SHOW DYNAMIC TABLES IN DATABASE ${quoteIdentifier(database)}`,
        `
            SELECT
                "name" AS "OBJNAME",
                "name" AS "label",
                "schema_name" AS "SCHEMA",
                0 AS "OBJID",
                'DYNAMIC TABLE' AS "OBJTYPE",
                ${buildDynamicTableDescriptionExpression()} AS "DESCRIPTION",
                "owner" AS "OWNER",
                "scheduling_state" AS "SCHEDULING_STATE",
                "scheduler" AS "SCHEDULER",
                "target_lag" AS "TARGET_LAG",
                "warehouse" AS "WAREHOUSE",
                "refresh_mode" AS "REFRESH_MODE",
                "refresh_mode_reason" AS "REFRESH_MODE_REASON",
                "last_suspended_on" AS "LAST_SUSPENDED_ON",
                "data_timestamp" AS "DATA_TIMESTAMP",
                "database_name" AS "DATABASE"
            FROM $1
            ORDER BY "schema_name", "name"
        `,
    );
}

export function buildDynamicTableStatusQuery(database: string, schema: string, tableName: string): string {
    return buildShowResultQuery(
        `SHOW DYNAMIC TABLES LIKE ${quoteLiteral(tableName)} IN SCHEMA ${quoteIdentifier(database)}.${quoteIdentifier(schema)}`,
        `
            SELECT
                "name" AS "NAME",
                "database_name" AS "DATABASE",
                "schema_name" AS "SCHEMA",
                "owner" AS "OWNER",
                "scheduling_state" AS "SCHEDULING_STATE",
                "scheduler" AS "SCHEDULER",
                "target_lag" AS "TARGET_LAG",
                "warehouse" AS "WAREHOUSE",
                "refresh_mode" AS "REFRESH_MODE",
                "refresh_mode_reason" AS "REFRESH_MODE_REASON",
                "last_suspended_on" AS "LAST_SUSPENDED_ON",
                "data_timestamp" AS "DATA_TIMESTAMP",
                COALESCE("comment", '') AS "COMMENT",
                ${buildDynamicTableDescriptionExpression()} AS "DESCRIPTION"
            FROM $1
            LIMIT 1
        `,
    );
}

export function buildListDatabasesQuery(): string {
    return buildShowResultQuery(
        'SHOW DATABASES',
        `
            SELECT
                "name" AS "DATABASE",
                "name" AS "label",
                COALESCE("comment", '') AS "detail"
            FROM $1
            ORDER BY "name"
        `,
    );
}

export function buildListSchemasQuery(database?: string): string {
    const normalizedDatabase = normalizeOptionalName(database);
    const showSql = normalizedDatabase ? 'SHOW SCHEMAS IN ACCOUNT' : 'SHOW SCHEMAS';
    const databaseFilter = normalizedDatabase ? `WHERE "database_name" = ${quoteLiteral(normalizedDatabase)}` : '';

    return buildShowResultQuery(
        showSql,
        `
            SELECT
                "name" AS "SCHEMA",
                "name" AS "label",
                COALESCE("comment", '') AS "detail"
            FROM $1
            ${databaseFilter}
            ORDER BY "database_name", "name"
        `,
    );
}

export function buildListTablesQuery(database: string, schema?: string): string {
    return `
        SELECT
            TABLE_NAME AS "OBJNAME",
            TABLE_NAME AS "label",
            TABLE_SCHEMA AS "SCHEMA",
            0 AS "OBJID",
            'TABLE' AS "OBJTYPE",
            COALESCE(COMMENT, '') AS "DESCRIPTION",
            TABLE_OWNER AS "OWNER",
            TABLE_CATALOG AS "DATABASE"
        FROM ${buildInfoSchemaView(database, 'TABLES')}
        WHERE TABLE_TYPE IN ('BASE TABLE', 'TEMPORARY TABLE', 'EXTERNAL TABLE', 'EVENT TABLE')
          ${buildDatabasePredicate(database)}
          ${buildSchemaPredicate(schema)}
        ORDER BY TABLE_SCHEMA, TABLE_NAME
    `;
}

export function buildListViewsQuery(database: string, schema?: string): string {
    return `
        SELECT
            TABLE_NAME AS "OBJNAME",
            TABLE_NAME AS "label",
            TABLE_SCHEMA AS "SCHEMA",
            0 AS "OBJID",
            'VIEW' AS "OBJTYPE",
            COALESCE(COMMENT, '') AS "DESCRIPTION",
            TABLE_OWNER AS "OWNER",
            TABLE_CATALOG AS "DATABASE"
        FROM ${buildInfoSchemaView(database, 'VIEWS')}
        WHERE 1 = 1
          ${buildDatabasePredicate(database, 'TABLE_CATALOG')}
          ${buildSchemaPredicate(schema, 'TABLE_SCHEMA')}
        ORDER BY TABLE_SCHEMA, TABLE_NAME
    `;
}

export function buildListProceduresQuery(database: string, schema?: string): string {
    return `
        SELECT
            PROCEDURE_NAME AS "PROCEDURE",
            PROCEDURE_NAME || '(' || COALESCE(ARGUMENT_SIGNATURE, '') || ')' AS "PROCEDURESIGNATURE",
            PROCEDURE_NAME || '(' || COALESCE(ARGUMENT_SIGNATURE, '') || ')' AS "OBJNAME",
            PROCEDURE_NAME || '(' || COALESCE(ARGUMENT_SIGNATURE, '') || ')' AS "label",
            PROCEDURE_SCHEMA AS "SCHEMA",
            0 AS "OBJID",
            'PROCEDURE' AS "OBJTYPE",
            COALESCE(COMMENT, '') AS "DESCRIPTION",
            PROCEDURE_OWNER AS "OWNER",
            PROCEDURE_CATALOG AS "DATABASE"
        FROM ${buildInfoSchemaView(database, 'PROCEDURES')}
        WHERE 1 = 1
          ${buildDatabasePredicate(database, 'PROCEDURE_CATALOG')}
          ${buildSchemaPredicate(schema, 'PROCEDURE_SCHEMA')}
        ORDER BY PROCEDURE_SCHEMA, PROCEDURE_NAME
    `;
}

function buildFunctionsQuery(database: string): string {
    return `
        SELECT
            FUNCTION_NAME AS "OBJNAME",
            FUNCTION_NAME AS "label",
            FUNCTION_SCHEMA AS "SCHEMA",
            0 AS "OBJID",
            'FUNCTION' AS "OBJTYPE",
            COALESCE(COMMENT, '') AS "DESCRIPTION",
            FUNCTION_OWNER AS "OWNER",
            FUNCTION_CATALOG AS "DATABASE"
        FROM ${buildInfoSchemaView(database, 'FUNCTIONS')}
        WHERE 1 = 1
          ${buildDatabasePredicate(database, 'FUNCTION_CATALOG')}
        ORDER BY FUNCTION_SCHEMA, FUNCTION_NAME
    `;
}

function buildSequencesQuery(database: string): string {
    return `
        SELECT
            SEQUENCE_NAME AS "OBJNAME",
            SEQUENCE_NAME AS "label",
            SEQUENCE_SCHEMA AS "SCHEMA",
            0 AS "OBJID",
            'SEQUENCE' AS "OBJTYPE",
            '' AS "DESCRIPTION",
            '' AS "OWNER",
            SEQUENCE_CATALOG AS "DATABASE"
        FROM ${buildInfoSchemaView(database, 'SEQUENCES')}
        WHERE 1 = 1
          ${buildDatabasePredicate(database, 'SEQUENCE_CATALOG')}
        ORDER BY SEQUENCE_SCHEMA, SEQUENCE_NAME
    `;
}

export function buildObjectTypeQuery(database: string, objectType: string): string {
    const normalizedType = objectType.trim().toUpperCase();
    if (normalizedType === 'TABLE') {
        return buildListTablesQuery(database);
    }

    if (normalizedType === 'VIEW') {
        return buildListViewsQuery(database);
    }

    if (normalizedType === 'PROCEDURE') {
        return buildListProceduresQuery(database);
    }

    if (normalizedType === 'FUNCTION') {
        return buildFunctionsQuery(database);
    }

    if (normalizedType === 'SEQUENCE') {
        return buildSequencesQuery(database);
    }

    if (normalizedType === 'STAGE') {
        return buildShowStagesQuery(database);
    }

    if (normalizedType === 'STREAM') {
        return buildShowStreamsQuery(database);
    }

    if (normalizedType === 'TASK') {
        return buildShowTasksQuery(database);
    }

    if (normalizedType === 'FILE FORMAT') {
        return buildShowFileFormatsQuery(database);
    }

    if (normalizedType === 'DYNAMIC TABLE') {
        return buildShowDynamicTablesQuery(database);
    }

    if (normalizedType === 'WAREHOUSE') {
        return buildShowWarehousesQuery(database);
    }

    return buildEmptyObjectQuery();
}

export function buildTypeGroupsQuery(): string {
    return `
        SELECT COLUMN1 AS "OBJTYPE"
        FROM VALUES ${SNOWFLAKE_DEFAULT_OBJECT_TYPES.map((type) => `(${quoteLiteral(type)})`).join(', ')}
    `;
}

export function buildColumnsWithKeysQuery(
    database: string,
    schema?: string,
    tableName?: string,
    objectTypes?: readonly string[],
): string {
    const normalizedTable = normalizeOptionalName(tableName);
    const tablePredicate = normalizedTable ? ` AND c.TABLE_NAME = ${quoteLiteral(normalizedTable)}` : '';
    const normalizedObjectTypes = (objectTypes ?? SNOWFLAKE_DEFAULT_COLUMN_OBJECT_TYPES)
        .map((type) => type.trim().toUpperCase())
        .filter((type) => type === 'TABLE' || type === 'VIEW' || type === 'DYNAMIC TABLE');
    const objectTypePredicate =
        normalizedObjectTypes.length > 0
            ? ` AND t.TABLE_TYPE IN (${normalizedObjectTypes.map((type) =>
                quoteLiteral(type === 'VIEW' ? 'VIEW' : type === 'DYNAMIC TABLE' ? 'DYNAMIC TABLE' : 'BASE TABLE'),
            ).join(', ')})`
            : '';

    return `
        SELECT
            c.TABLE_SCHEMA AS SCHEMA_NAME,
            c.TABLE_NAME AS TABLENAME,
            c.COLUMN_NAME AS ATTNAME,
            c.DATA_TYPE AS DATA_TYPE,
            c.DATA_TYPE AS FORMAT_TYPE,
            c.DATA_TYPE AS FULL_TYPE,
            CASE WHEN UPPER(c.IS_NULLABLE) = 'NO' THEN 1 ELSE 0 END AS IS_NOT_NULL,
            CASE WHEN UPPER(c.IS_NULLABLE) = 'NO' THEN 1 ELSE 0 END AS ATTNOTNULL,
            c.COLUMN_DEFAULT AS COLDEFAULT,
            COALESCE(c.COMMENT, '') AS DESCRIPTION,
            c.ORDINAL_POSITION AS ATTNUM,
            CASE WHEN pk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS IS_PK,
            0 AS IS_FK
        FROM ${buildInfoSchemaView(database, 'COLUMNS')} c
        INNER JOIN ${buildInfoSchemaView(database, 'TABLES')} t
            ON t.TABLE_CATALOG = c.TABLE_CATALOG
           AND t.TABLE_SCHEMA = c.TABLE_SCHEMA
           AND t.TABLE_NAME = c.TABLE_NAME
        LEFT JOIN (
            SELECT
                ku.TABLE_CATALOG,
                ku.TABLE_SCHEMA,
                ku.TABLE_NAME,
                ku.COLUMN_NAME
            FROM ${buildInfoSchemaView(database, 'TABLE_CONSTRAINTS')} tc
            INNER JOIN ${buildInfoSchemaView(database, 'KEY_COLUMN_USAGE')} ku
                ON ku.CONSTRAINT_CATALOG = tc.CONSTRAINT_CATALOG
               AND ku.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
               AND ku.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
            WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
        ) pk
            ON pk.TABLE_CATALOG = c.TABLE_CATALOG
           AND pk.TABLE_SCHEMA = c.TABLE_SCHEMA
           AND pk.TABLE_NAME = c.TABLE_NAME
           AND pk.COLUMN_NAME = c.COLUMN_NAME
        WHERE 1 = 1
          ${buildDatabasePredicate(database, 'c.TABLE_CATALOG')}
          ${buildSchemaPredicate(schema, 'c.TABLE_SCHEMA')}
          ${tablePredicate}
          ${objectTypePredicate}
        ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
    `;
}

export function buildTableColumnsQuery(database: string, schema: string, tableName: string): string {
    return buildColumnsWithKeysQuery(database, schema, tableName, ['TABLE', 'VIEW']);
}

export function buildColumnMetadataQuery(database: string, schema: string, tableName: string): string {
    return `
        SELECT
            COLUMN_NAME AS ATTNAME,
            DATA_TYPE AS DATA_TYPE,
            DATA_TYPE AS FORMAT_TYPE,
            DATA_TYPE AS FULL_TYPE,
            CASE WHEN UPPER(IS_NULLABLE) = 'NO' THEN 1 ELSE 0 END AS ATTNOTNULL,
            COLUMN_DEFAULT AS COLDEFAULT,
            COMMENT AS DESCRIPTION,
            ORDINAL_POSITION AS ATTNUM
        FROM ${buildInfoSchemaView(database, 'COLUMNS')}
        WHERE TABLE_CATALOG = ${quoteLiteral(database)}
          AND TABLE_SCHEMA = ${quoteLiteral(schema)}
          AND TABLE_NAME = ${quoteLiteral(tableName)}
        ORDER BY ORDINAL_POSITION
    `;
}

export function buildLookupColumnsQuery(params: DatabaseColumnLookupParams): string {
    const databaseName = normalizeOptionalName(params.database);
    const databasePredicate = databaseName
        ? `TABLE_CATALOG = ${quoteLiteral(databaseName)}`
        : 'TABLE_CATALOG = CURRENT_DATABASE()';
    const schemaPredicate = normalizeOptionalName(params.schema)
        ? `AND TABLE_SCHEMA = ${quoteLiteral(params.schema)}`
        : '';

    return `
        SELECT
            COLUMN_NAME AS "COLUMN_NAME",
            TABLE_NAME AS "TABLE_NAME",
            TABLE_SCHEMA AS "SCHEMA",
            TABLE_CATALOG AS "DATABASE"
        FROM ${buildInfoSchemaView(databaseName, 'COLUMNS')}
        WHERE ${databasePredicate}
          ${schemaPredicate}
          AND TABLE_NAME = ${quoteLiteral(params.tableName)}
        ORDER BY ORDINAL_POSITION
    `;
}

export function buildTableCommentQuery(database: string, schema: string, tableName: string): string {
    return `
        SELECT COALESCE(COMMENT, '') AS "DESCRIPTION"
        FROM ${buildInfoSchemaView(database, 'TABLES')}
        WHERE TABLE_CATALOG = ${quoteLiteral(database)}
          AND TABLE_SCHEMA = ${quoteLiteral(schema)}
          AND TABLE_NAME = ${quoteLiteral(tableName)}
    `;
}

export function buildObjectSearchQuery(database: string, likePattern: string): string {
    return `
        SELECT * FROM (
            SELECT
                1 AS "PRIORITY",
                TABLE_NAME AS "NAME",
                TABLE_SCHEMA AS "SCHEMA",
                TABLE_CATALOG AS "DATABASE",
                CASE WHEN TABLE_TYPE = 'VIEW' THEN 'VIEW' WHEN TABLE_TYPE = 'DYNAMIC TABLE' THEN 'DYNAMIC TABLE' ELSE 'TABLE' END AS "TYPE",
                '' AS "PARENT",
                COALESCE(COMMENT, '') AS "DESCRIPTION",
                'NAME' AS "MATCH_TYPE"
            FROM ${buildInfoSchemaView(database, 'TABLES')}
            WHERE TABLE_CATALOG = ${quoteLiteral(database)}
              AND UPPER(TABLE_NAME) LIKE ${quoteLiteral(likePattern)} ESCAPE '\\'
            UNION ALL
            SELECT
                1 AS "PRIORITY",
                PROCEDURE_NAME AS "NAME",
                PROCEDURE_SCHEMA AS "SCHEMA",
                PROCEDURE_CATALOG AS "DATABASE",
                'PROCEDURE' AS "TYPE",
                '' AS "PARENT",
                COALESCE(COMMENT, '') AS "DESCRIPTION",
                'NAME' AS "MATCH_TYPE"
            FROM ${buildInfoSchemaView(database, 'PROCEDURES')}
            WHERE PROCEDURE_CATALOG = ${quoteLiteral(database)}
              AND UPPER(PROCEDURE_NAME) LIKE ${quoteLiteral(likePattern)} ESCAPE '\\'
            UNION ALL
            SELECT
                1 AS "PRIORITY",
                FUNCTION_NAME AS "NAME",
                FUNCTION_SCHEMA AS "SCHEMA",
                FUNCTION_CATALOG AS "DATABASE",
                'FUNCTION' AS "TYPE",
                '' AS "PARENT",
                COALESCE(COMMENT, '') AS "DESCRIPTION",
                'NAME' AS "MATCH_TYPE"
            FROM ${buildInfoSchemaView(database, 'FUNCTIONS')}
            WHERE FUNCTION_CATALOG = ${quoteLiteral(database)}
              AND UPPER(FUNCTION_NAME) LIKE ${quoteLiteral(likePattern)} ESCAPE '\\'
            UNION ALL
            SELECT
                1 AS "PRIORITY",
                SEQUENCE_NAME AS "NAME",
                SEQUENCE_SCHEMA AS "SCHEMA",
                SEQUENCE_CATALOG AS "DATABASE",
                'SEQUENCE' AS "TYPE",
                '' AS "PARENT",
                '' AS "DESCRIPTION",
                'NAME' AS "MATCH_TYPE"
            FROM ${buildInfoSchemaView(database, 'SEQUENCES')}
            WHERE SEQUENCE_CATALOG = ${quoteLiteral(database)}
              AND UPPER(SEQUENCE_NAME) LIKE ${quoteLiteral(likePattern)} ESCAPE '\\'
            UNION ALL
            SELECT
                1 AS "PRIORITY",
                STAGE_NAME AS "NAME",
                STAGE_SCHEMA AS "SCHEMA",
                STAGE_CATALOG AS "DATABASE",
                'STAGE' AS "TYPE",
                '' AS "PARENT",
                COALESCE(COMMENT, '') AS "DESCRIPTION",
                'NAME' AS "MATCH_TYPE"
            FROM ${buildInfoSchemaView(database, 'STAGES')}
            WHERE STAGE_CATALOG = ${quoteLiteral(database)}
              AND UPPER(STAGE_NAME) LIKE ${quoteLiteral(likePattern)} ESCAPE '\\'
            UNION ALL
            SELECT
                1 AS "PRIORITY",
                FILE_FORMAT_NAME AS "NAME",
                FILE_FORMAT_SCHEMA AS "SCHEMA",
                FILE_FORMAT_CATALOG AS "DATABASE",
                'FILE FORMAT' AS "TYPE",
                '' AS "PARENT",
                COALESCE(COMMENT, '') AS "DESCRIPTION",
                'NAME' AS "MATCH_TYPE"
            FROM ${buildInfoSchemaView(database, 'FILE_FORMATS')}
            WHERE FILE_FORMAT_CATALOG = ${quoteLiteral(database)}
              AND UPPER(FILE_FORMAT_NAME) LIKE ${quoteLiteral(likePattern)} ESCAPE '\\'
            UNION ALL
            SELECT
                2 AS "PRIORITY",
                COLUMN_NAME AS "NAME",
                TABLE_SCHEMA AS "SCHEMA",
                TABLE_CATALOG AS "DATABASE",
                'COLUMN' AS "TYPE",
                TABLE_NAME AS "PARENT",
                COALESCE(COMMENT, '') AS "DESCRIPTION",
                'NAME' AS "MATCH_TYPE"
            FROM ${buildInfoSchemaView(database, 'COLUMNS')}
            WHERE TABLE_CATALOG = ${quoteLiteral(database)}
              AND UPPER(COLUMN_NAME) LIKE ${quoteLiteral(likePattern)} ESCAPE '\\'
        ) matches
        ORDER BY "PRIORITY", "SCHEMA", "NAME"
        LIMIT 200
    `;
}

export function buildViewSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string {
    return `
        SELECT
            TABLE_NAME AS "NAME",
            TABLE_SCHEMA AS "SCHEMA",
            TABLE_CATALOG AS "DATABASE",
            'VIEW' AS "TYPE",
            CASE
                WHEN UPPER(COALESCE(VIEW_DEFINITION, '')) LIKE ${quoteLiteral(options.likePattern)} ESCAPE '\\' THEN 'SOURCE'
                ELSE 'NAME'
            END AS "MATCH_TYPE",
            COALESCE(VIEW_DEFINITION, '') AS "SOURCE"
        FROM ${buildInfoSchemaView(database, 'VIEWS')}
        WHERE TABLE_CATALOG = ${quoteLiteral(database)}
          AND (
              UPPER(TABLE_NAME) LIKE ${quoteLiteral(options.likePattern)} ESCAPE '\\'
              OR UPPER(COALESCE(VIEW_DEFINITION, '')) LIKE ${quoteLiteral(options.likePattern)} ESCAPE '\\'
          )
        ORDER BY TABLE_SCHEMA, TABLE_NAME
    `;
}

export function buildProcedureSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string {
    return `
        SELECT
            PROCEDURE_NAME AS "NAME",
            PROCEDURE_SCHEMA AS "SCHEMA",
            PROCEDURE_CATALOG AS "DATABASE",
            'PROCEDURE' AS "TYPE",
            CASE
                WHEN UPPER(COALESCE(PROCEDURE_DEFINITION, '')) LIKE ${quoteLiteral(options.likePattern)} ESCAPE '\\' THEN 'SOURCE'
                ELSE 'NAME'
            END AS "MATCH_TYPE",
            COALESCE(PROCEDURE_DEFINITION, '') AS "SOURCE"
        FROM ${buildInfoSchemaView(database, 'PROCEDURES')}
        WHERE PROCEDURE_CATALOG = ${quoteLiteral(database)}
          AND (
              UPPER(PROCEDURE_NAME) LIKE ${quoteLiteral(options.likePattern)} ESCAPE '\\'
              OR UPPER(COALESCE(PROCEDURE_DEFINITION, '')) LIKE ${quoteLiteral(options.likePattern)} ESCAPE '\\'
          )
        ORDER BY PROCEDURE_SCHEMA, PROCEDURE_NAME
    `;
}

export { SNOWFLAKE_DEFAULT_OBJECT_TYPES, SNOWFLAKE_DEFAULT_COLUMN_OBJECT_TYPES, quoteIdentifier };
