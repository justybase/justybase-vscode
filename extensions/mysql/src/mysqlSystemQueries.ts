import type { DatabaseColumnLookupParams, DatabaseSourceSearchQueryOptions } from '@justybase/contracts';

function quoteLiteral(value: string | undefined): string {
    return `'${(value ?? '').replace(/'/g, "''")}'`;
}

function quoteAlias(identifier: string): string {
    return `\`${identifier.replace(/`/g, '``')}\``;
}

function normalizeOptionalName(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function effectiveSchema(database: string, schema?: string): string {
    return normalizeOptionalName(schema) ?? normalizeOptionalName(database) ?? '';
}

function buildSchemaPredicate(alias: string, database: string, schema?: string): string {
    const normalizedSchema = effectiveSchema(database, schema);
    return normalizedSchema ? ` AND ${alias} = ${quoteLiteral(normalizedSchema)}` : '';
}

function buildRoutineParametersCte(): string {
    return `
        WITH ROUTINE_PARAMETERS AS (
            SELECT
                p.SPECIFIC_SCHEMA,
                p.SPECIFIC_NAME,
                GROUP_CONCAT(
                    TRIM(
                        CONCAT(
                            CASE UPPER(COALESCE(p.PARAMETER_MODE, 'IN'))
                                WHEN 'OUT' THEN 'OUT '
                                WHEN 'INOUT' THEN 'IN OUT '
                                ELSE ''
                            END,
                            COALESCE(p.PARAMETER_NAME, ''),
                            CASE WHEN p.PARAMETER_NAME IS NOT NULL THEN ' ' ELSE '' END,
                            p.DTD_IDENTIFIER
                        )
                    )
                    ORDER BY p.ORDINAL_POSITION SEPARATOR ', '
                ) AS PARAMETER_SIGNATURE
            FROM information_schema.parameters p
            WHERE p.PARAMETER_MODE IS NOT NULL
            GROUP BY p.SPECIFIC_SCHEMA, p.SPECIFIC_NAME
        )
    `;
}

function buildRoutineSignatureExpression(routineAlias: string, paramsAlias: string): string {
    return `CONCAT(${routineAlias}.ROUTINE_NAME, '(', COALESCE(${paramsAlias}.PARAMETER_SIGNATURE, ''), ')')`;
}

export function buildFindTableSchemaQuery(_database: string, tableName: string): string {
    return `
        SELECT TABLE_SCHEMA AS ${quoteAlias('SCHEMA')}
        FROM information_schema.tables
        WHERE TABLE_NAME = ${quoteLiteral(tableName)}
        ORDER BY CASE WHEN TABLE_SCHEMA = DATABASE() THEN 0 ELSE 1 END, TABLE_SCHEMA
    `;
}

function buildTableLikeQuery(tableType: 'BASE TABLE' | 'VIEW', objectType: 'TABLE' | 'VIEW', database: string, schema?: string): string {
    return `
        SELECT
            TABLE_NAME AS ${quoteAlias('OBJNAME')},
            TABLE_SCHEMA AS ${quoteAlias('SCHEMA')},
            0 AS ${quoteAlias('OBJID')},
            ${quoteLiteral(objectType)} AS ${quoteAlias('OBJTYPE')},
            COALESCE(TABLE_COMMENT, '') AS ${quoteAlias('DESCRIPTION')},
            TABLE_SCHEMA AS ${quoteAlias('OWNER')},
            ${quoteLiteral(database)} AS ${quoteAlias('DATABASE')}
        FROM information_schema.tables
        WHERE TABLE_TYPE = ${quoteLiteral(tableType)}
          ${buildSchemaPredicate('TABLE_SCHEMA', database, schema)}
        ORDER BY TABLE_SCHEMA, TABLE_NAME
    `;
}

function buildRoutineObjectQuery(
    routineType: 'PROCEDURE' | 'FUNCTION',
    database: string,
    schema?: string
): string {
    return `
        ${buildRoutineParametersCte()}
        SELECT
            ${buildRoutineSignatureExpression('r', 'rp')} AS ${quoteAlias('OBJNAME')},
            r.ROUTINE_SCHEMA AS ${quoteAlias('SCHEMA')},
            r.ROUTINE_NAME AS ${quoteAlias('ROUTINENAME')},
            r.ROUTINE_NAME AS ${quoteAlias('PROCEDURE')},
            0 AS ${quoteAlias('OBJID')},
            ${quoteLiteral(routineType)} AS ${quoteAlias('OBJTYPE')},
            COALESCE(r.ROUTINE_COMMENT, '') AS ${quoteAlias('DESCRIPTION')},
            COALESCE(r.DEFINER, '') AS ${quoteAlias('OWNER')},
            ${quoteLiteral(database)} AS ${quoteAlias('DATABASE')}
        FROM information_schema.routines r
        LEFT JOIN ROUTINE_PARAMETERS rp
            ON rp.SPECIFIC_SCHEMA = r.SPECIFIC_SCHEMA
           AND rp.SPECIFIC_NAME = r.SPECIFIC_NAME
        WHERE r.ROUTINE_TYPE = ${quoteLiteral(routineType)}
          ${buildSchemaPredicate('r.ROUTINE_SCHEMA', database, schema)}
        ORDER BY r.ROUTINE_SCHEMA, r.ROUTINE_NAME
    `;
}

function buildTriggerQuery(database: string, schema?: string): string {
    return `
        SELECT
            TRIGGER_NAME AS ${quoteAlias('OBJNAME')},
            EVENT_OBJECT_SCHEMA AS ${quoteAlias('SCHEMA')},
            0 AS ${quoteAlias('OBJID')},
            'TRIGGER' AS ${quoteAlias('OBJTYPE')},
            COALESCE(ACTION_STATEMENT, '') AS ${quoteAlias('DESCRIPTION')},
            COALESCE(DEFINER, '') AS ${quoteAlias('OWNER')},
            ${quoteLiteral(database)} AS ${quoteAlias('DATABASE')}
        FROM information_schema.triggers
        WHERE 1 = 1
          ${buildSchemaPredicate('EVENT_OBJECT_SCHEMA', database, schema)}
        ORDER BY EVENT_OBJECT_SCHEMA, TRIGGER_NAME
    `;
}

function buildEventQuery(database: string, schema?: string): string {
    return `
        SELECT
            EVENT_NAME AS ${quoteAlias('OBJNAME')},
            EVENT_SCHEMA AS ${quoteAlias('SCHEMA')},
            0 AS ${quoteAlias('OBJID')},
            'EVENT' AS ${quoteAlias('OBJTYPE')},
            COALESCE(EVENT_DEFINITION, '') AS ${quoteAlias('DESCRIPTION')},
            COALESCE(DEFINER, '') AS ${quoteAlias('OWNER')},
            ${quoteLiteral(database)} AS ${quoteAlias('DATABASE')}
        FROM information_schema.events
        WHERE 1 = 1
          ${buildSchemaPredicate('EVENT_SCHEMA', database, schema)}
        ORDER BY EVENT_SCHEMA, EVENT_NAME
    `;
}

function buildColumnBaseQuery(database: string, schema: string, tableName: string): string {
    return `
        SELECT
            c.TABLE_SCHEMA AS SCHEMA_NAME,
            c.TABLE_NAME AS TABLENAME,
            c.COLUMN_NAME AS ATTNAME,
            c.DATA_TYPE AS DATA_TYPE,
            c.COLUMN_TYPE AS FORMAT_TYPE,
            c.COLUMN_TYPE AS FULL_TYPE,
            CASE WHEN UPPER(c.IS_NULLABLE) = 'NO' THEN 1 ELSE 0 END AS IS_NOT_NULL,
            CASE WHEN UPPER(c.IS_NULLABLE) = 'NO' THEN 1 ELSE 0 END AS ATTNOTNULL,
            c.COLUMN_DEFAULT AS COLDEFAULT,
            c.COLUMN_COMMENT AS DESCRIPTION,
            c.ORDINAL_POSITION AS ATTNUM,
            c.EXTRA AS EXTRA,
            CASE WHEN tc.CONSTRAINT_TYPE = 'PRIMARY KEY' THEN 1 ELSE 0 END AS IS_PK,
            CASE WHEN tc.CONSTRAINT_TYPE = 'FOREIGN KEY' THEN 1 ELSE 0 END AS IS_FK
        FROM information_schema.columns c
        LEFT JOIN information_schema.key_column_usage kcu
            ON kcu.TABLE_SCHEMA = c.TABLE_SCHEMA
           AND kcu.TABLE_NAME = c.TABLE_NAME
           AND kcu.COLUMN_NAME = c.COLUMN_NAME
        LEFT JOIN information_schema.table_constraints tc
            ON tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
           AND tc.TABLE_NAME = kcu.TABLE_NAME
           AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        WHERE c.TABLE_SCHEMA = ${quoteLiteral(effectiveSchema(database, schema))}
          AND c.TABLE_NAME = ${quoteLiteral(tableName)}
        ORDER BY c.ORDINAL_POSITION
    `;
}

function buildColumnsWithKeysBaseQuery(database: string, schema?: string, tableName?: string, objectTypes?: readonly string[]): string {
    const normalizedSchema = effectiveSchema(database, schema);
    const typeFilter = objectTypes && objectTypes.length > 0
        ? ` AND t.TABLE_TYPE IN (${objectTypes.map(type => quoteLiteral(type.trim().toUpperCase() === 'VIEW' ? 'VIEW' : 'BASE TABLE')).join(', ')})`
        : '';

    return `
        SELECT
            c.TABLE_SCHEMA AS SCHEMA_NAME,
            c.TABLE_NAME AS TABLENAME,
            c.COLUMN_NAME AS ATTNAME,
            c.DATA_TYPE AS DATA_TYPE,
            c.COLUMN_TYPE AS FORMAT_TYPE,
            c.COLUMN_TYPE AS FULL_TYPE,
            CASE WHEN UPPER(c.IS_NULLABLE) = 'NO' THEN 1 ELSE 0 END AS IS_NOT_NULL,
            CASE WHEN UPPER(c.IS_NULLABLE) = 'NO' THEN 1 ELSE 0 END AS ATTNOTNULL,
            c.COLUMN_DEFAULT AS COLDEFAULT,
            c.COLUMN_COMMENT AS DESCRIPTION,
            c.ORDINAL_POSITION AS ATTNUM,
            c.EXTRA AS EXTRA,
            CASE WHEN tc.CONSTRAINT_TYPE = 'PRIMARY KEY' THEN 1 ELSE 0 END AS IS_PK,
            CASE WHEN tc.CONSTRAINT_TYPE = 'FOREIGN KEY' THEN 1 ELSE 0 END AS IS_FK
        FROM information_schema.columns c
        INNER JOIN information_schema.tables t
            ON t.TABLE_SCHEMA = c.TABLE_SCHEMA
           AND t.TABLE_NAME = c.TABLE_NAME
        LEFT JOIN information_schema.key_column_usage kcu
            ON kcu.TABLE_SCHEMA = c.TABLE_SCHEMA
           AND kcu.TABLE_NAME = c.TABLE_NAME
           AND kcu.COLUMN_NAME = c.COLUMN_NAME
        LEFT JOIN information_schema.table_constraints tc
            ON tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
           AND tc.TABLE_NAME = kcu.TABLE_NAME
           AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        WHERE c.TABLE_SCHEMA = ${quoteLiteral(normalizedSchema)}
          ${tableName ? `AND c.TABLE_NAME = ${quoteLiteral(tableName)}` : ''}
          ${typeFilter}
        ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
    `;
}

export function buildListDatabasesQuery(): string {
    return `SELECT SCHEMA_NAME AS ${quoteAlias('DATABASE')} FROM information_schema.schemata ORDER BY SCHEMA_NAME`;
}

export function buildListSchemasQuery(database?: string): string {
    return `
        SELECT SCHEMA_NAME AS ${quoteAlias('SCHEMA')}
        FROM information_schema.schemata
        ${normalizeOptionalName(database) ? `WHERE SCHEMA_NAME = ${quoteLiteral(database)}` : ''}
        ORDER BY SCHEMA_NAME
    `;
}

export function buildListTablesQuery(database: string, schema?: string): string {
    return buildTableLikeQuery('BASE TABLE', 'TABLE', database, schema);
}

export function buildListViewsQuery(database: string, schema?: string): string {
    return buildTableLikeQuery('VIEW', 'VIEW', database, schema);
}

export function buildListProceduresQuery(database: string, schema?: string): string {
    return `
        ${buildRoutineParametersCte()}
        SELECT
            r.ROUTINE_SCHEMA AS ${quoteAlias('SCHEMA')},
            r.ROUTINE_NAME AS ${quoteAlias('PROCEDURE')},
            ${buildRoutineSignatureExpression('r', 'rp')} AS ${quoteAlias('PROCEDURESIGNATURE')},
            COALESCE(r.DEFINER, '') AS ${quoteAlias('OWNER')},
            ${quoteLiteral(database)} AS ${quoteAlias('DATABASE')}
        FROM information_schema.routines r
        LEFT JOIN ROUTINE_PARAMETERS rp
            ON rp.SPECIFIC_SCHEMA = r.SPECIFIC_SCHEMA
           AND rp.SPECIFIC_NAME = r.SPECIFIC_NAME
        WHERE r.ROUTINE_TYPE = 'PROCEDURE'
          ${buildSchemaPredicate('r.ROUTINE_SCHEMA', database, schema)}
        ORDER BY r.ROUTINE_SCHEMA, r.ROUTINE_NAME
    `;
}

export function buildObjectTypeQuery(database: string, objectType: string): string {
    const normalizedType = objectType.trim().toUpperCase();
    if (normalizedType === 'TABLE') {
        return buildTableLikeQuery('BASE TABLE', 'TABLE', database);
    }
    if (normalizedType === 'VIEW') {
        return buildTableLikeQuery('VIEW', 'VIEW', database);
    }
    if (normalizedType === 'PROCEDURE') {
        return buildRoutineObjectQuery('PROCEDURE', database);
    }
    if (normalizedType === 'FUNCTION') {
        return buildRoutineObjectQuery('FUNCTION', database);
    }
    if (normalizedType === 'TRIGGER') {
        return buildTriggerQuery(database);
    }
    if (normalizedType === 'EVENT') {
        return buildEventQuery(database);
    }
    return `SELECT NULL AS ${quoteAlias('OBJNAME')}, NULL AS ${quoteAlias('SCHEMA')}, 0 AS ${quoteAlias('OBJID')}, NULL AS ${quoteAlias('OBJTYPE')}, NULL AS ${quoteAlias('DESCRIPTION')}, NULL AS ${quoteAlias('OWNER')}, NULL AS ${quoteAlias('DATABASE')} WHERE 1 = 0`;
}

export function buildTypeGroupsQuery(): string {
    return `
        SELECT 'TABLE' AS OBJTYPE
        UNION ALL SELECT 'VIEW' AS OBJTYPE
        UNION ALL SELECT 'PROCEDURE' AS OBJTYPE
        UNION ALL SELECT 'FUNCTION' AS OBJTYPE
        UNION ALL SELECT 'TRIGGER' AS OBJTYPE
        UNION ALL SELECT 'EVENT' AS OBJTYPE
    `;
}

export function buildColumnsWithKeysQuery(database: string, schema?: string, tableName?: string, objTypes?: readonly string[]): string {
    return buildColumnsWithKeysBaseQuery(database, schema, tableName, objTypes);
}

export function buildTableColumnsQuery(database: string, schema: string, tableName: string): string {
    return buildColumnBaseQuery(database, schema, tableName);
}

export function buildColumnMetadataQuery(database: string, schema: string, tableName: string): string {
    return buildColumnBaseQuery(database, schema, tableName);
}

export function buildLookupColumnsQuery(params: DatabaseColumnLookupParams): string {
    const schema = normalizeOptionalName(params.schema) ?? normalizeOptionalName(params.database) ?? '';
    return `
        SELECT
            TABLE_SCHEMA AS SCHEMA_NAME,
            TABLE_NAME,
            COLUMN_NAME
        FROM information_schema.columns
        WHERE TABLE_SCHEMA = ${quoteLiteral(schema)}
          AND TABLE_NAME = ${quoteLiteral(params.tableName)}
        ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
    `;
}

export function buildTableCommentQuery(database: string, schema: string, tableName: string): string {
    return `
        SELECT TABLE_COMMENT AS DESCRIPTION
        FROM information_schema.tables
        WHERE TABLE_SCHEMA = ${quoteLiteral(effectiveSchema(database, schema))}
          AND TABLE_NAME = ${quoteLiteral(tableName)}
    `;
}

export function buildObjectSearchQuery(database: string, likePattern: string): string {
    const databaseLiteral = quoteLiteral(database);
    return `
        SELECT * FROM (
            SELECT
                1 AS ${quoteAlias('PRIORITY')},
                t.TABLE_NAME AS ${quoteAlias('NAME')},
                t.TABLE_SCHEMA AS ${quoteAlias('SCHEMA')},
                ${databaseLiteral} AS ${quoteAlias('DATABASE')},
                CASE WHEN t.TABLE_TYPE = 'VIEW' THEN 'VIEW' ELSE 'TABLE' END AS ${quoteAlias('TYPE')},
                '' AS ${quoteAlias('PARENT')},
                COALESCE(t.TABLE_COMMENT, '') AS ${quoteAlias('DESCRIPTION')},
                'NAME' AS ${quoteAlias('MATCH_TYPE')}
            FROM information_schema.tables t
            WHERE UPPER(t.TABLE_NAME) LIKE '${likePattern}' ESCAPE '\\'
              ${buildSchemaPredicate('t.TABLE_SCHEMA', database)}
            UNION ALL
            SELECT
                1 AS ${quoteAlias('PRIORITY')},
                t.TABLE_NAME AS ${quoteAlias('NAME')},
                t.TABLE_SCHEMA AS ${quoteAlias('SCHEMA')},
                ${databaseLiteral} AS ${quoteAlias('DATABASE')},
                CASE WHEN t.TABLE_TYPE = 'VIEW' THEN 'VIEW' ELSE 'TABLE' END AS ${quoteAlias('TYPE')},
                '' AS ${quoteAlias('PARENT')},
                COALESCE(t.TABLE_COMMENT, '') AS ${quoteAlias('DESCRIPTION')},
                'DESC' AS ${quoteAlias('MATCH_TYPE')}
            FROM information_schema.tables t
            WHERE UPPER(COALESCE(t.TABLE_COMMENT, '')) LIKE '${likePattern}' ESCAPE '\\'
              ${buildSchemaPredicate('t.TABLE_SCHEMA', database)}
              AND UPPER(t.TABLE_NAME) NOT LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                2 AS ${quoteAlias('PRIORITY')},
                r.ROUTINE_NAME AS ${quoteAlias('NAME')},
                r.ROUTINE_SCHEMA AS ${quoteAlias('SCHEMA')},
                ${databaseLiteral} AS ${quoteAlias('DATABASE')},
                r.ROUTINE_TYPE AS ${quoteAlias('TYPE')},
                '' AS ${quoteAlias('PARENT')},
                COALESCE(r.ROUTINE_COMMENT, '') AS ${quoteAlias('DESCRIPTION')},
                'NAME' AS ${quoteAlias('MATCH_TYPE')}
            FROM information_schema.routines r
            WHERE UPPER(r.ROUTINE_NAME) LIKE '${likePattern}' ESCAPE '\\'
              ${buildSchemaPredicate('r.ROUTINE_SCHEMA', database)}
            UNION ALL
            SELECT
                2 AS ${quoteAlias('PRIORITY')},
                c.COLUMN_NAME AS ${quoteAlias('NAME')},
                c.TABLE_SCHEMA AS ${quoteAlias('SCHEMA')},
                ${databaseLiteral} AS ${quoteAlias('DATABASE')},
                'COLUMN' AS ${quoteAlias('TYPE')},
                c.TABLE_NAME AS ${quoteAlias('PARENT')},
                COALESCE(c.COLUMN_COMMENT, '') AS ${quoteAlias('DESCRIPTION')},
                'NAME' AS ${quoteAlias('MATCH_TYPE')}
            FROM information_schema.columns c
            WHERE UPPER(c.COLUMN_NAME) LIKE '${likePattern}' ESCAPE '\\'
              ${buildSchemaPredicate('c.TABLE_SCHEMA', database)}
            UNION ALL
            SELECT
                3 AS ${quoteAlias('PRIORITY')},
                tr.TRIGGER_NAME AS ${quoteAlias('NAME')},
                tr.EVENT_OBJECT_SCHEMA AS ${quoteAlias('SCHEMA')},
                ${databaseLiteral} AS ${quoteAlias('DATABASE')},
                'TRIGGER' AS ${quoteAlias('TYPE')},
                tr.EVENT_OBJECT_TABLE AS ${quoteAlias('PARENT')},
                COALESCE(tr.ACTION_STATEMENT, '') AS ${quoteAlias('DESCRIPTION')},
                'NAME' AS ${quoteAlias('MATCH_TYPE')}
            FROM information_schema.triggers tr
            WHERE UPPER(tr.TRIGGER_NAME) LIKE '${likePattern}' ESCAPE '\\'
              ${buildSchemaPredicate('tr.EVENT_OBJECT_SCHEMA', database)}
            UNION ALL
            SELECT
                4 AS ${quoteAlias('PRIORITY')},
                ev.EVENT_NAME AS ${quoteAlias('NAME')},
                ev.EVENT_SCHEMA AS ${quoteAlias('SCHEMA')},
                ${databaseLiteral} AS ${quoteAlias('DATABASE')},
                'EVENT' AS ${quoteAlias('TYPE')},
                '' AS ${quoteAlias('PARENT')},
                COALESCE(ev.EVENT_DEFINITION, '') AS ${quoteAlias('DESCRIPTION')},
                'NAME' AS ${quoteAlias('MATCH_TYPE')}
            FROM information_schema.events ev
            WHERE UPPER(ev.EVENT_NAME) LIKE '${likePattern}' ESCAPE '\\'
              ${buildSchemaPredicate('ev.EVENT_SCHEMA', database)}
        ) AS SEARCH_RESULTS
        ORDER BY ${quoteAlias('PRIORITY')}, ${quoteAlias('NAME')}
        LIMIT 200
    `;
}

export function buildViewSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string {
    const databaseLiteral = quoteLiteral(database);
    const schemaPredicate = normalizeOptionalName(database) ? `AND TABLE_SCHEMA = ${quoteLiteral(database)}` : '';
    const filter = options.useServerSideFilter ? `AND UPPER(VIEW_DEFINITION) LIKE '${options.likePattern}' ESCAPE '\\'` : '';
    return `
        SELECT
            TABLE_NAME AS ${quoteAlias('NAME')},
            TABLE_SCHEMA AS ${quoteAlias('SCHEMA')},
            ${databaseLiteral} AS ${quoteAlias('DATABASE')},
            VIEW_DEFINITION AS ${quoteAlias('SOURCE')}
        FROM information_schema.views
        WHERE 1 = 1
          ${schemaPredicate}
          ${filter}
    `;
}

export function buildProcedureSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string {
    const databaseLiteral = quoteLiteral(database);
    const schemaPredicate = normalizeOptionalName(database) ? `AND ROUTINE_SCHEMA = ${quoteLiteral(database)}` : '';
    const filter = options.useServerSideFilter ? `AND UPPER(ROUTINE_DEFINITION) LIKE '${options.likePattern}' ESCAPE '\\'` : '';
    return `
        SELECT
            ROUTINE_NAME AS ${quoteAlias('NAME')},
            ROUTINE_SCHEMA AS ${quoteAlias('SCHEMA')},
            ${databaseLiteral} AS ${quoteAlias('DATABASE')},
            ROUTINE_TYPE AS ${quoteAlias('TYPE')},
            ROUTINE_DEFINITION AS ${quoteAlias('SOURCE')}
        FROM information_schema.routines
        WHERE ROUTINE_TYPE IN ('PROCEDURE', 'FUNCTION')
          ${schemaPredicate}
          ${filter}
    `;
}
