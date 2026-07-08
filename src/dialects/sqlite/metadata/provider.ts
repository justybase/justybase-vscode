import type {
    DatabaseColumnLookupParams,
    DatabaseColumnQueryOptions,
    DatabaseMetadataProvider,
    DatabaseSourceSearchQueryOptions
} from '../../../contracts/database';

function quoteLiteral(value: string | undefined): string {
    return `'${(value ?? '').replace(/'/g, "''")}'`;
}

function quoteIdentifier(value: string | undefined): string {
    return `"${(value ?? '').replace(/"/g, '""')}"`;
}

function normalizeDatabaseName(database: string | undefined): string {
    return database?.trim() || 'main';
}

function resolveLookupDatabase(database: string | undefined, schema?: string): string {
    const schemaOverride = schema?.trim();
    return normalizeDatabaseName(schemaOverride && schemaOverride.length > 0 ? schemaOverride : database);
}

function normalizeObjectType(objectType: string): 'table' | 'view' {
    return objectType.trim().toLowerCase() === 'view' ? 'view' : 'table';
}

function buildTableInfoQuery(database: string | undefined, tableName: string | undefined, schema?: string): string {
    const databaseName = quoteIdentifier(resolveLookupDatabase(database, schema));
    return `SELECT * FROM ${databaseName}.pragma_table_info(${quoteLiteral(tableName)})`;
}

function buildColumnsProjection(database: string, schema?: string, tableName?: string, objectTypes?: readonly string[]): string {
    const lookupDatabase = resolveLookupDatabase(database, schema);
    const databaseIdentifier = quoteIdentifier(lookupDatabase);
    const tableFilter = tableName?.trim()
        ? `AND tbl.name = ${quoteLiteral(tableName.trim())}`
        : '';
    const normalizedTypes = (objectTypes ?? ['TABLE', 'VIEW'])
        .map(type => type.trim().toUpperCase())
        .filter(type => type === 'TABLE' || type === 'VIEW');
    const objectTypeFilter = normalizedTypes.length > 0
        ? `AND tbl.type IN (${normalizedTypes.map(type => quoteLiteral(type.toLowerCase())).join(', ')})`
        : '';

    return `
        SELECT
            ${quoteLiteral(lookupDatabase.toUpperCase())} AS DATABASE,
            '' AS SCHEMA,
            tbl.name AS TABLENAME,
            col.name AS ATTNAME,
            COALESCE(NULLIF(col.type, ''), 'TEXT') AS FORMAT_TYPE,
            '' AS DESCRIPTION,
            CASE WHEN col.pk > 0 THEN 1 ELSE 0 END AS IS_PK,
            0 AS IS_FK,
            col.cid + 1 AS ATTNUM
        FROM ${databaseIdentifier}.sqlite_master AS tbl
        JOIN ${databaseIdentifier}.pragma_table_info(tbl.name) AS col
        WHERE tbl.name NOT LIKE 'sqlite_%'
          AND tbl.type IN ('table', 'view')
          ${tableFilter}
          ${objectTypeFilter}
        ORDER BY tbl.name, col.cid
    `;
}

function buildDetailedColumnQuery(
    database: string | undefined,
    tableName: string,
    includeMetadataFlag: boolean,
    schema?: string
): string {
    const baseQuery = buildTableInfoQuery(database, tableName, schema);
    const notNullAlias = includeMetadataFlag ? 'IS_NOT_NULL' : 'ATTNOTNULL';

    return `
        SELECT
            name AS ATTNAME,
            COALESCE(NULLIF(type, ''), 'TEXT') AS FORMAT_TYPE,
            COALESCE(NULLIF(type, ''), 'TEXT') AS FULL_TYPE,
            "notnull" AS ${notNullAlias},
            "notnull" AS IS_NOT_NULL,
            dflt_value AS COLDEFAULT,
            '' AS DESCRIPTION,
            CASE WHEN pk > 0 THEN 1 ELSE 0 END AS IS_PK,
            0 AS IS_FK,
            cid + 1 AS ATTNUM
        FROM (${baseQuery}) AS col_info
        ORDER BY cid
    `;
}

function buildObjectSearchQuery(database: string, likePattern: string): string {
    const databaseName = normalizeDatabaseName(database);
    const databaseIdentifier = quoteIdentifier(databaseName);
    const databaseLiteral = quoteLiteral(databaseName);

    return `
        SELECT * FROM (
            SELECT
                1 AS PRIORITY,
                name AS NAME,
                '' AS SCHEMA,
                ${databaseLiteral} AS DATABASE,
                CASE type WHEN 'view' THEN 'VIEW' ELSE 'TABLE' END AS TYPE,
                '' AS PARENT,
                COALESCE(sql, '') AS DESCRIPTION,
                'NAME' AS MATCH_TYPE
            FROM ${databaseIdentifier}.sqlite_master
            WHERE type IN ('table', 'view')
              AND name NOT LIKE 'sqlite_%'
              AND UPPER(name) LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                1 AS PRIORITY,
                name AS NAME,
                '' AS SCHEMA,
                ${databaseLiteral} AS DATABASE,
                CASE type WHEN 'view' THEN 'VIEW' ELSE 'TABLE' END AS TYPE,
                '' AS PARENT,
                COALESCE(sql, '') AS DESCRIPTION,
                'DDL' AS MATCH_TYPE
            FROM ${databaseIdentifier}.sqlite_master
            WHERE type IN ('table', 'view')
              AND name NOT LIKE 'sqlite_%'
              AND UPPER(COALESCE(sql, '')) LIKE '${likePattern}' ESCAPE '\\'
              AND UPPER(name) NOT LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                2 AS PRIORITY,
                col.name AS NAME,
                '' AS SCHEMA,
                ${databaseLiteral} AS DATABASE,
                'COLUMN' AS TYPE,
                tbl.name AS PARENT,
                COALESCE(master.sql, '') AS DESCRIPTION,
                'NAME' AS MATCH_TYPE
            FROM ${databaseIdentifier}.pragma_table_list AS tbl
            JOIN ${databaseIdentifier}.pragma_table_info(tbl.name) AS col
            LEFT JOIN ${databaseIdentifier}.sqlite_master AS master
              ON master.name = tbl.name
             AND master.type = tbl.type
            WHERE tbl.schema = ${databaseLiteral}
              AND tbl.type IN ('table', 'view')
              AND tbl.name NOT LIKE 'sqlite_%'
              AND UPPER(col.name) LIKE '${likePattern}' ESCAPE '\\'
        ) AS R
        ORDER BY PRIORITY, NAME
        LIMIT 200
    `;
}

function buildViewSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string {
    const databaseName = normalizeDatabaseName(database);
    const databaseIdentifier = quoteIdentifier(databaseName);
    const databaseLiteral = quoteLiteral(databaseName);

    if (options.useServerSideFilter) {
        return `
            SELECT name AS NAME, '' AS SCHEMA, ${databaseLiteral} AS DATABASE
            FROM ${databaseIdentifier}.sqlite_master
            WHERE type = 'view' AND UPPER(COALESCE(sql, '')) LIKE '${options.likePattern}' ESCAPE '\\'
        `;
    }

    return `
        SELECT name AS NAME, '' AS SCHEMA, ${databaseLiteral} AS DATABASE, COALESCE(sql, '') AS SOURCE
        FROM ${databaseIdentifier}.sqlite_master
        WHERE type = 'view'
    `;
}

function buildProcedureSourceSearchQuery(): string {
    return 'SELECT NULL AS NAME, NULL AS SCHEMA, NULL AS DATABASE WHERE 1 = 0';
}

export const sqliteMetadataProvider: DatabaseMetadataProvider = {
    defaultObjectTypes: ['TABLE', 'VIEW'],
    defaultColumnObjectTypes: ['TABLE', 'VIEW'],
    buildListDatabasesQuery(): string {
        return `
            SELECT name AS DATABASE
            FROM pragma_database_list
            ORDER BY
                CASE name
                    WHEN 'main' THEN 0
                    WHEN 'temp' THEN 1
                    ELSE 2
                END,
                name
        `;
    },
    buildListSchemasQuery(): string {
        return 'SELECT NULL AS SCHEMA WHERE 1 = 0;';
    },
    buildListTablesQuery(database: string): string {
        const databaseName = normalizeDatabaseName(database);
        const databaseIdentifier = quoteIdentifier(databaseName);
        return `
            SELECT
                name AS OBJNAME,
                rootpage AS OBJID,
                'TABLE' AS OBJTYPE,
                NULL AS SCHEMA,
                COALESCE(sql, '') AS DESCRIPTION
            FROM ${databaseIdentifier}.sqlite_master
            WHERE type = 'table'
              AND name NOT LIKE 'sqlite_%'
            ORDER BY name
        `;
    },
    buildListViewsQuery(database: string): string {
        const databaseName = normalizeDatabaseName(database);
        const databaseIdentifier = quoteIdentifier(databaseName);
        return `
            SELECT
                name AS OBJNAME,
                rootpage AS OBJID,
                'VIEW' AS OBJTYPE,
                NULL AS SCHEMA,
                COALESCE(sql, '') AS DESCRIPTION
            FROM ${databaseIdentifier}.sqlite_master
            WHERE type = 'view'
              AND name NOT LIKE 'sqlite_%'
            ORDER BY name
        `;
    },
    buildListProceduresQuery(): string {
        return 'SELECT NULL AS OBJNAME WHERE 1 = 0;';
    },
    buildObjectTypeQuery(database: string, objectType: string): string {
        const databaseName = normalizeDatabaseName(database);
        const databaseIdentifier = quoteIdentifier(databaseName);
        const normalizedType = normalizeObjectType(objectType);
        return `
            SELECT
                name AS OBJNAME,
                rootpage AS OBJID,
                COALESCE(sql, '') AS DESCRIPTION,
                NULL AS OWNER
            FROM ${databaseIdentifier}.sqlite_master
            WHERE type = ${quoteLiteral(normalizedType)}
              AND name NOT LIKE 'sqlite_%'
            ORDER BY name
        `;
    },
    buildTypeGroupsQuery(_database: string): string {
        return "SELECT 'TABLE' AS OBJTYPE UNION ALL SELECT 'VIEW' AS OBJTYPE;";
    },
    buildColumnsWithKeysQuery(database: string, options?: DatabaseColumnQueryOptions): string {
        return buildColumnsProjection(database, options?.schema, options?.tableName, options?.objTypes);
    },
    buildTableColumnsQuery(database: string, schema: string, tableName: string): string {
        return buildDetailedColumnQuery(database, tableName, false, schema);
    },
    buildColumnMetadataQuery(database: string, schema: string, tableName: string): string {
        return buildDetailedColumnQuery(database, tableName, true, schema);
    },
    buildLookupColumnsQuery(params: DatabaseColumnLookupParams): string {
        return buildColumnsProjection(params.database ?? 'main', params.schema, params.tableName, ['TABLE', 'VIEW']);
    },
    buildTableCommentQuery(database: string, schema: string, tableName: string): string {
        const databaseIdentifier = quoteIdentifier(resolveLookupDatabase(database, schema));
        return `
            SELECT COALESCE(sql, '') AS DESCRIPTION
            FROM ${databaseIdentifier}.sqlite_master
            WHERE name = ${quoteLiteral(tableName)}
              AND type IN ('table', 'view')
            LIMIT 1
        `;
    },
    buildObjectSearchQuery(database: string, likePattern: string): string {
        return buildObjectSearchQuery(database, likePattern);
    },
    buildViewSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string {
        return buildViewSourceSearchQuery(database, options);
    },
    buildProcedureSourceSearchQuery(_database: string, _options: DatabaseSourceSearchQueryOptions): string {
        return buildProcedureSourceSearchQuery();
    }
};
