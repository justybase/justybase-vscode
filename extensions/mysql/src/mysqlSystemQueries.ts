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
            COALESCE(c.GENERATION_EXPRESSION, '') AS GENERATION_EXPRESSION,
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
            COALESCE(c.GENERATION_EXPRESSION, '') AS GENERATION_EXPRESSION,
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

export function buildForeignKeyRelationshipsQuery(database: string, schema?: string, tableName?: string): string {
    const sourceSchema = normalizeOptionalName(schema) ?? normalizeOptionalName(database) ?? '';
    return `
        SELECT
            kcu.TABLE_SCHEMA AS FROM_DATABASE,
            kcu.TABLE_SCHEMA AS FROM_SCHEMA,
            kcu.TABLE_NAME AS FROM_TABLE,
            kcu.COLUMN_NAME AS FROM_COLUMN,
            kcu.REFERENCED_TABLE_SCHEMA AS TO_DATABASE,
            kcu.REFERENCED_TABLE_SCHEMA AS TO_SCHEMA,
            kcu.REFERENCED_TABLE_NAME AS TO_TABLE,
            kcu.REFERENCED_COLUMN_NAME AS TO_COLUMN,
            kcu.CONSTRAINT_NAME AS CONSTRAINT_NAME,
            kcu.ORDINAL_POSITION AS ORDINAL_POSITION
        FROM information_schema.KEY_COLUMN_USAGE kcu
        WHERE kcu.REFERENCED_TABLE_NAME IS NOT NULL
          AND kcu.TABLE_SCHEMA = ${quoteLiteral(sourceSchema)}
          ${tableName ? `AND kcu.TABLE_NAME = ${quoteLiteral(tableName)}` : ''}
        ORDER BY kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
    `;
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

export function buildTablePropertiesQuery(schema: string, tableName: string): string {
    return `
        SELECT
            t.ENGINE AS ENGINE,
            VERSION() AS SERVER_VERSION
        FROM information_schema.tables t
        WHERE t.TABLE_SCHEMA = ${quoteLiteral(schema)}
          AND t.TABLE_NAME = ${quoteLiteral(tableName)}
          AND t.TABLE_TYPE = 'BASE TABLE'
    `;
}

export function buildAlterTablePropertiesQuery(schema: string, tableName: string): string {
    return `
        SELECT
            t.ENGINE AS ENGINE,
            t.TABLE_COLLATION AS TABLE_COLLATION,
            t.AUTO_INCREMENT AS AUTO_INCREMENT,
            COALESCE(t.TABLE_COMMENT, '') AS TABLE_COMMENT,
            VERSION() AS SERVER_VERSION
        FROM information_schema.tables t
        WHERE t.TABLE_SCHEMA = ${quoteLiteral(schema)}
          AND t.TABLE_NAME = ${quoteLiteral(tableName)}
          AND t.TABLE_TYPE = 'BASE TABLE'
    `;
}

export function buildListCharacterSetsQuery(): string {
    return `
        SELECT CHARACTER_SET_NAME AS CHARACTER_SET_NAME
        FROM information_schema.character_sets
        ORDER BY CHARACTER_SET_NAME
    `;
}

export function buildListCollationsQuery(): string {
    return `
        SELECT
            COLLATION_NAME AS COLLATION_NAME,
            CHARACTER_SET_NAME AS CHARACTER_SET_NAME
        FROM information_schema.collations
        ORDER BY CHARACTER_SET_NAME, COLLATION_NAME
    `;
}

export function buildListIndexesQuery(schema: string, tableName: string): string {
    return `
        SELECT
            s.TABLE_SCHEMA AS TABLE_SCHEMA,
            s.TABLE_NAME AS TABLE_NAME,
            s.INDEX_SCHEMA AS INDEX_SCHEMA,
            s.INDEX_NAME AS INDEX_NAME,
            s.SEQ_IN_INDEX AS SEQ_IN_INDEX,
            s.COLUMN_NAME AS COLUMN_NAME,
            s.COLLATION AS COLLATION,
            s.SUB_PART AS SUB_PART,
            s.NON_UNIQUE AS NON_UNIQUE,
            s.INDEX_TYPE AS INDEX_TYPE,
            s.COMMENT AS INDEX_COMMENT,
            s.INDEX_COMMENT AS INDEX_DEFINITION_COMMENT,
            s.CARDINALITY AS CARDINALITY,
            s.IS_VISIBLE AS IS_VISIBLE,
            s.EXPRESSION AS EXPRESSION
        FROM information_schema.statistics s
        WHERE s.TABLE_SCHEMA = ${quoteLiteral(schema)}
          AND s.TABLE_NAME = ${quoteLiteral(tableName)}
        ORDER BY s.INDEX_NAME, s.SEQ_IN_INDEX
    `;
}

export function buildListPartitionsQuery(schema: string, tableName: string): string {
    return `
        SELECT
            p.TABLE_SCHEMA AS TABLE_SCHEMA,
            p.TABLE_NAME AS TABLE_NAME,
            p.PARTITION_NAME AS PARTITION_NAME,
            p.SUBPARTITION_NAME AS SUBPARTITION_NAME,
            p.PARTITION_ORDINAL_POSITION AS PARTITION_ORDINAL_POSITION,
            p.SUBPARTITION_ORDINAL_POSITION AS SUBPARTITION_ORDINAL_POSITION,
            p.PARTITION_METHOD AS PARTITION_METHOD,
            p.SUBPARTITION_METHOD AS SUBPARTITION_METHOD,
            p.PARTITION_EXPRESSION AS PARTITION_EXPRESSION,
            p.SUBPARTITION_EXPRESSION AS SUBPARTITION_EXPRESSION,
            p.PARTITION_DESCRIPTION AS PARTITION_DESCRIPTION,
            p.TABLE_ROWS AS TABLE_ROWS,
            p.DATA_LENGTH AS DATA_LENGTH,
            p.INDEX_LENGTH AS INDEX_LENGTH,
            p.TABLESPACE_NAME AS TABLESPACE_NAME,
            p.PARTITION_COMMENT AS PARTITION_COMMENT
        FROM information_schema.partitions p
        WHERE p.TABLE_SCHEMA = ${quoteLiteral(schema)}
          AND p.TABLE_NAME = ${quoteLiteral(tableName)}
        ORDER BY p.PARTITION_ORDINAL_POSITION, p.SUBPARTITION_ORDINAL_POSITION
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

export type MysqlTableDetailKind = 'keys' | 'indexes' | 'triggers';

/** Keys/constraints, indexes or triggers of one table for the schema tree (NAME, KIND, DETAIL). */
export function buildTableDetailQuery(
    database: string,
    schema: string,
    tableName: string,
    detail: MysqlTableDetailKind,
): string {
    // MySQL databases are schemas; the tree reports the same name in both fields.
    const owner = quoteLiteral(schema || database);
    const table = quoteLiteral(tableName);
    if (detail === 'keys') {
        return `
            SELECT
                tc.CONSTRAINT_NAME AS ${quoteAlias('NAME')},
                tc.CONSTRAINT_TYPE AS ${quoteAlias('KIND')},
                CONCAT(
                    COALESCE(GROUP_CONCAT(kcu.COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION SEPARATOR ', '), ''),
                    CASE WHEN tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
                         THEN CONCAT(' -> ', MAX(kcu.REFERENCED_TABLE_SCHEMA), '.', MAX(kcu.REFERENCED_TABLE_NAME)) ELSE '' END
                ) AS ${quoteAlias('DETAIL')}
            FROM information_schema.TABLE_CONSTRAINTS tc
            LEFT JOIN information_schema.KEY_COLUMN_USAGE kcu
                ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
               AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
               AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
               AND kcu.TABLE_NAME = tc.TABLE_NAME
            WHERE tc.TABLE_SCHEMA = ${owner} AND tc.TABLE_NAME = ${table}
            GROUP BY tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE
            ORDER BY FIELD(tc.CONSTRAINT_TYPE, 'PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY', 'CHECK'), tc.CONSTRAINT_NAME
        `;
    }
    if (detail === 'indexes') {
        return `
            SELECT
                s.INDEX_NAME AS ${quoteAlias('NAME')},
                CASE WHEN s.INDEX_NAME = 'PRIMARY' THEN 'PRIMARY KEY' WHEN MAX(s.NON_UNIQUE) = 0 THEN 'UNIQUE' ELSE 'INDEX' END AS ${quoteAlias('KIND')},
                CONCAT(LOWER(MAX(s.INDEX_TYPE)), ' (',
                       GROUP_CONCAT(COALESCE(s.COLUMN_NAME, s.EXPRESSION) ORDER BY s.SEQ_IN_INDEX SEPARATOR ', '), ')') AS ${quoteAlias('DETAIL')}
            FROM information_schema.STATISTICS s
            WHERE s.TABLE_SCHEMA = ${owner} AND s.TABLE_NAME = ${table}
            GROUP BY s.INDEX_NAME
            ORDER BY s.INDEX_NAME <> 'PRIMARY', MAX(s.NON_UNIQUE), s.INDEX_NAME
        `;
    }
    return `
        SELECT
            t.TRIGGER_NAME AS ${quoteAlias('NAME')},
            'TRIGGER' AS ${quoteAlias('KIND')},
            CONCAT(t.ACTION_TIMING, ' ', t.EVENT_MANIPULATION) AS ${quoteAlias('DETAIL')}
        FROM information_schema.TRIGGERS t
        WHERE t.EVENT_OBJECT_SCHEMA = ${owner} AND t.EVENT_OBJECT_TABLE = ${table}
        ORDER BY t.ACTION_ORDER, t.TRIGGER_NAME
    `;
}

export type MysqlTableReportKind = 'size' | 'privileges' | 'maintenance';
export type MysqlDatabaseReportKind = 'locks' | 'invalidObjects';

/** Read-only table reports shown in SQL Results (size, privileges, fragmentation). */
export function buildTableReportQuery(
    database: string,
    schema: string,
    tableName: string,
    report: MysqlTableReportKind,
): string {
    // MySQL databases are schemas; the tree reports the same name in both fields.
    const owner = quoteLiteral(schema || database);
    const table = quoteLiteral(tableName);
    const a = quoteAlias;
    if (report === 'size') {
        return `
            SELECT
                t.TABLE_SCHEMA AS ${a('SCHEMA_NAME')},
                t.TABLE_NAME AS ${a('TABLE_NAME')},
                t.ENGINE AS ${a('ENGINE')},
                t.TABLE_ROWS AS ${a('ESTIMATED_ROWS')},
                ROUND((t.DATA_LENGTH + t.INDEX_LENGTH) / 1048576, 2) AS ${a('TOTAL_MB')},
                ROUND(t.DATA_LENGTH / 1048576, 2) AS ${a('DATA_MB')},
                ROUND(t.INDEX_LENGTH / 1048576, 2) AS ${a('INDEXES_MB')},
                ROUND(t.DATA_FREE / 1048576, 2) AS ${a('FREE_MB')},
                t.AVG_ROW_LENGTH AS ${a('AVG_ROW_LENGTH')},
                t.ROW_FORMAT AS ${a('ROW_FORMAT')},
                t.CREATE_TIME AS ${a('CREATED')},
                t.UPDATE_TIME AS ${a('LAST_UPDATED')}
            FROM information_schema.TABLES t
            WHERE t.TABLE_SCHEMA = ${owner} AND t.TABLE_NAME = ${table}
        `;
    }
    if (report === 'privileges') {
        return `
            SELECT
                p.GRANTEE AS ${a('GRANTEE')},
                'TABLE' AS ${a('LEVEL')},
                GROUP_CONCAT(p.PRIVILEGE_TYPE ORDER BY p.PRIVILEGE_TYPE SEPARATOR ', ') AS ${a('PRIVILEGES')},
                MAX(p.IS_GRANTABLE) AS ${a('WITH_GRANT_OPTION')}
            FROM information_schema.TABLE_PRIVILEGES p
            WHERE p.TABLE_SCHEMA = ${owner} AND p.TABLE_NAME = ${table}
            GROUP BY p.GRANTEE
            UNION ALL
            SELECT
                p.GRANTEE,
                'SCHEMA (inherited)',
                GROUP_CONCAT(p.PRIVILEGE_TYPE ORDER BY p.PRIVILEGE_TYPE SEPARATOR ', '),
                MAX(p.IS_GRANTABLE)
            FROM information_schema.SCHEMA_PRIVILEGES p
            WHERE p.TABLE_SCHEMA = ${owner}
            GROUP BY p.GRANTEE
            ORDER BY 1, 2
        `;
    }
    return `
        SELECT
            t.TABLE_SCHEMA AS ${a('SCHEMA_NAME')},
            t.TABLE_NAME AS ${a('TABLE_NAME')},
            CASE
                WHEN t.DATA_FREE > 10485760 AND t.DATA_FREE * 100 > (t.DATA_LENGTH + t.INDEX_LENGTH + t.DATA_FREE) * 20
                    THEN 'OPTIMIZE TABLE recommended (free space > 20%)'
                ELSE 'OK'
            END AS ${a('RECOMMENDATION')},
            ROUND(t.DATA_FREE * 100 / NULLIF(t.DATA_LENGTH + t.INDEX_LENGTH + t.DATA_FREE, 0), 2) AS ${a('FREE_SPACE_PCT')},
            ROUND(t.DATA_FREE / 1048576, 2) AS ${a('FREE_MB')},
            t.TABLE_ROWS AS ${a('ESTIMATED_ROWS')},
            t.ENGINE AS ${a('ENGINE')},
            t.UPDATE_TIME AS ${a('LAST_UPDATED')},
            t.CHECK_TIME AS ${a('LAST_CHECKED')}
        FROM information_schema.TABLES t
        WHERE t.TABLE_SCHEMA = ${owner} AND t.TABLE_NAME = ${table}
    `;
}

/** Read-only database reports shown in SQL Results; MySQL has no invalid-object catalog. */
export function buildDatabaseReportQuery(_database: string, report: MysqlDatabaseReportKind): string | undefined {
    if (report !== 'locks') {
        return undefined;
    }
    const a = quoteAlias;
    // MySQL 8 lock waits; INNODB_TRX needs the PROCESS privilege to show other sessions.
    return `
        SELECT
            r.trx_mysql_thread_id AS ${a('WAITING_THREAD')},
            TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()) AS ${a('WAIT_SECONDS')},
            b.trx_mysql_thread_id AS ${a('BLOCKING_THREAD')},
            b.trx_state AS ${a('BLOCKING_STATE')},
            CONCAT(dl.OBJECT_SCHEMA, '.', dl.OBJECT_NAME) AS ${a('LOCKED_OBJECT')},
            dl.LOCK_TYPE AS ${a('LOCK_TYPE')},
            dl.LOCK_MODE AS ${a('LOCK_MODE')},
            LEFT(r.trx_query, 2000) AS ${a('WAITING_SQL')},
            LEFT(b.trx_query, 2000) AS ${a('BLOCKING_SQL')}
        FROM performance_schema.data_lock_waits w
        JOIN information_schema.INNODB_TRX r ON r.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID
        JOIN information_schema.INNODB_TRX b ON b.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID
        LEFT JOIN performance_schema.data_locks dl ON dl.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID
        ORDER BY ${a('WAIT_SECONDS')} DESC
    `;
}
