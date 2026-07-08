import type { DatabaseSourceSearchQueryOptions } from '@justybase/contracts';

type PostgreSqlTableLikeType = 'TABLE' | 'VIEW';
type PostgreSqlCatalogObjectType = PostgreSqlTableLikeType | 'SEQUENCE' | 'FUNCTION' | 'PROCEDURE';

const TABLE_RELKINDS = ['r', 'p', 'f'] as const;
const VIEW_RELKINDS = ['v', 'm'] as const;
const SEQUENCE_RELKINDS = ['S'] as const;
const DEFAULT_TYPE_GROUPS = ['TABLE', 'VIEW', 'SEQUENCE', 'FUNCTION', 'PROCEDURE'] as const;

function quoteLiteral(value: string | undefined): string {
    return `'${(value ?? '').replace(/'/g, "''")}'`;
}

function normalizeOptionalName(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function buildSchemaPredicate(alias: string, schema?: string): string {
    const normalizedSchema = normalizeOptionalName(schema);
    return normalizedSchema ? ` AND ${alias} = ${quoteLiteral(normalizedSchema)}` : '';
}

function buildNamePredicate(alias: string, objectName?: string): string {
    const normalizedName = normalizeOptionalName(objectName);
    return normalizedName ? ` AND ${alias} = ${quoteLiteral(normalizedName)}` : '';
}

function buildInList(values: readonly string[]): string {
    return values.map(value => quoteLiteral(value)).join(', ');
}

function buildUserSchemaPredicate(alias: string): string {
    return `
        ${alias} <> 'information_schema'
        AND ${alias} <> 'pg_catalog'
        AND ${alias} NOT LIKE 'pg_toast%'
        AND ${alias} NOT LIKE 'pg_temp_%'
    `.trim();
}

function buildRelkindList(objectTypes?: readonly string[], fallback: readonly PostgreSqlTableLikeType[] = ['TABLE', 'VIEW']): string {
    const normalizedTypes = (objectTypes ?? fallback)
        .map(type => type.trim().toUpperCase())
        .filter((type): type is PostgreSqlTableLikeType => type === 'TABLE' || type === 'VIEW');

    const relkinds = new Set<string>();
    for (const type of normalizedTypes.length > 0 ? normalizedTypes : fallback) {
        const source = type === 'VIEW' ? VIEW_RELKINDS : TABLE_RELKINDS;
        for (const relkind of source) {
            relkinds.add(relkind);
        }
    }

    return buildInList(Array.from(relkinds.values()));
}

function buildRoutineSignatureExpression(alias: string): string {
    return `
        RTRIM(${alias}.proname) || '(' || COALESCE(pg_get_function_identity_arguments(${alias}.oid), '') || ')'
    `.trim();
}

function buildRelationObjectQuery(relkinds: readonly string[], objectType: string, schema?: string): string {
    return `
        SELECT
            c.relname AS "OBJNAME",
            c.oid::INT AS "OBJID",
            ${quoteLiteral(objectType)} AS "OBJTYPE",
            n.nspname AS "SCHEMA",
            COALESCE(obj_description(c.oid, 'pg_class'), '') AS "DESCRIPTION",
            pg_get_userbyid(c.relowner) AS "OWNER",
            current_database() AS "DATABASE"
        FROM pg_catalog.pg_class c
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = c.relnamespace
        WHERE c.relkind IN (${buildInList(relkinds)})
          AND ${buildUserSchemaPredicate('n.nspname')}
          ${buildSchemaPredicate('n.nspname', schema)}
        ORDER BY n.nspname, c.relname
    `;
}

function buildRoutineObjectQuery(prokind: 'f' | 'p', objectType: 'FUNCTION' | 'PROCEDURE', schema?: string): string {
    return `
        SELECT
            ${buildRoutineSignatureExpression('p')} AS "OBJNAME",
            p.oid::INT AS "OBJID",
            ${quoteLiteral(objectType)} AS "OBJTYPE",
            n.nspname AS "SCHEMA",
            COALESCE(obj_description(p.oid, 'pg_proc'), '') AS "DESCRIPTION",
            pg_get_userbyid(p.proowner) AS "OWNER",
            current_database() AS "DATABASE"
        FROM pg_catalog.pg_proc p
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = p.pronamespace
        WHERE p.prokind = ${quoteLiteral(prokind)}
          AND ${buildUserSchemaPredicate('n.nspname')}
          ${buildSchemaPredicate('n.nspname', schema)}
        ORDER BY n.nspname, ${buildRoutineSignatureExpression('p')}
    `;
}

function buildColumnsBaseWhereClause(schema?: string, tableName?: string, objectTypes?: readonly string[]): string {
    return `
        c.relkind IN (${buildRelkindList(objectTypes)})
        AND ${buildUserSchemaPredicate('n.nspname')}
        ${buildSchemaPredicate('n.nspname', schema)}
        ${buildNamePredicate('c.relname', tableName)}
    `.trim();
}

export function buildListDatabasesQuery(): string {
    return 'SELECT current_database() AS "DATABASE"';
}

export function buildListSchemasQuery(): string {
    return `
        SELECT nspname AS "SCHEMA"
        FROM pg_catalog.pg_namespace
        WHERE ${buildUserSchemaPredicate('nspname')}
        ORDER BY nspname
    `;
}

export function buildListTablesQuery(schema?: string): string {
    return buildRelationObjectQuery(TABLE_RELKINDS, 'TABLE', schema);
}

export function buildListViewsQuery(schema?: string): string {
    return buildRelationObjectQuery(VIEW_RELKINDS, 'VIEW', schema);
}

export function buildListProceduresQuery(schema?: string): string {
    return `
        SELECT
            n.nspname AS "SCHEMA",
            p.proname AS "PROCEDURE",
            ${buildRoutineSignatureExpression('p')} AS "PROCEDURESIGNATURE",
            pg_get_userbyid(p.proowner) AS "OWNER",
            current_database() AS "DATABASE"
        FROM pg_catalog.pg_proc p
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = p.pronamespace
        WHERE p.prokind = 'p'
          AND ${buildUserSchemaPredicate('n.nspname')}
          ${buildSchemaPredicate('n.nspname', schema)}
        ORDER BY n.nspname, ${buildRoutineSignatureExpression('p')}
    `;
}

export function buildObjectTypeQuery(objectType: string): string {
    const normalizedType = objectType.trim().toUpperCase() as PostgreSqlCatalogObjectType;

    if (normalizedType === 'TABLE') {
        return buildRelationObjectQuery(TABLE_RELKINDS, 'TABLE');
    }

    if (normalizedType === 'VIEW') {
        return buildRelationObjectQuery(VIEW_RELKINDS, 'VIEW');
    }

    if (normalizedType === 'SEQUENCE') {
        return buildRelationObjectQuery(SEQUENCE_RELKINDS, 'SEQUENCE');
    }

    if (normalizedType === 'FUNCTION') {
        return buildRoutineObjectQuery('f', 'FUNCTION');
    }

    if (normalizedType === 'PROCEDURE') {
        return buildRoutineObjectQuery('p', 'PROCEDURE');
    }

    return 'SELECT NULL AS "OBJNAME", 0 AS "OBJID", NULL AS "OBJTYPE", NULL AS "SCHEMA", NULL AS "DESCRIPTION", NULL AS "OWNER", NULL AS "DATABASE" WHERE 1 = 0';
}

export function buildObjectSearchQuery(database: string, likePattern: string): string {
    const databaseLiteral = quoteLiteral(database);
    const relationRelkinds = buildInList([...TABLE_RELKINDS, ...VIEW_RELKINDS, ...SEQUENCE_RELKINDS]);
    const tableLikeRelkinds = buildInList([...TABLE_RELKINDS, ...VIEW_RELKINDS]);

    return `
        SELECT * FROM (
            SELECT
                1 AS "PRIORITY",
                c.relname AS "NAME",
                n.nspname AS "SCHEMA",
                ${databaseLiteral} AS "DATABASE",
                CASE
                    WHEN c.relkind IN (${buildInList(VIEW_RELKINDS)}) THEN 'VIEW'
                    WHEN c.relkind IN (${buildInList(SEQUENCE_RELKINDS)}) THEN 'SEQUENCE'
                    ELSE 'TABLE'
                END AS "TYPE",
                '' AS "PARENT",
                COALESCE(obj_description(c.oid, 'pg_class'), '') AS "DESCRIPTION",
                'NAME' AS "MATCH_TYPE"
            FROM pg_catalog.pg_class c
            INNER JOIN pg_catalog.pg_namespace n
                ON n.oid = c.relnamespace
            WHERE c.relkind IN (${relationRelkinds})
              AND ${buildUserSchemaPredicate('n.nspname')}
              AND UPPER(c.relname) LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                1 AS "PRIORITY",
                c.relname AS "NAME",
                n.nspname AS "SCHEMA",
                ${databaseLiteral} AS "DATABASE",
                CASE
                    WHEN c.relkind IN (${buildInList(VIEW_RELKINDS)}) THEN 'VIEW'
                    WHEN c.relkind IN (${buildInList(SEQUENCE_RELKINDS)}) THEN 'SEQUENCE'
                    ELSE 'TABLE'
                END AS "TYPE",
                '' AS "PARENT",
                COALESCE(obj_description(c.oid, 'pg_class'), '') AS "DESCRIPTION",
                'OBJ_DESC' AS "MATCH_TYPE"
            FROM pg_catalog.pg_class c
            INNER JOIN pg_catalog.pg_namespace n
                ON n.oid = c.relnamespace
            WHERE c.relkind IN (${relationRelkinds})
              AND ${buildUserSchemaPredicate('n.nspname')}
              AND UPPER(COALESCE(obj_description(c.oid, 'pg_class'), '')) LIKE '${likePattern}' ESCAPE '\\'
              AND UPPER(c.relname) NOT LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                1 AS "PRIORITY",
                ${buildRoutineSignatureExpression('p')} AS "NAME",
                n.nspname AS "SCHEMA",
                ${databaseLiteral} AS "DATABASE",
                CASE WHEN p.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS "TYPE",
                '' AS "PARENT",
                COALESCE(obj_description(p.oid, 'pg_proc'), '') AS "DESCRIPTION",
                'NAME' AS "MATCH_TYPE"
            FROM pg_catalog.pg_proc p
            INNER JOIN pg_catalog.pg_namespace n
                ON n.oid = p.pronamespace
            WHERE p.prokind IN ('f', 'p')
              AND ${buildUserSchemaPredicate('n.nspname')}
              AND UPPER(${buildRoutineSignatureExpression('p')}) LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                1 AS "PRIORITY",
                ${buildRoutineSignatureExpression('p')} AS "NAME",
                n.nspname AS "SCHEMA",
                ${databaseLiteral} AS "DATABASE",
                CASE WHEN p.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS "TYPE",
                '' AS "PARENT",
                COALESCE(obj_description(p.oid, 'pg_proc'), '') AS "DESCRIPTION",
                'OBJ_DESC' AS "MATCH_TYPE"
            FROM pg_catalog.pg_proc p
            INNER JOIN pg_catalog.pg_namespace n
                ON n.oid = p.pronamespace
            WHERE p.prokind IN ('f', 'p')
              AND ${buildUserSchemaPredicate('n.nspname')}
              AND UPPER(COALESCE(obj_description(p.oid, 'pg_proc'), '')) LIKE '${likePattern}' ESCAPE '\\'
              AND UPPER(${buildRoutineSignatureExpression('p')}) NOT LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                2 AS "PRIORITY",
                a.attname AS "NAME",
                n.nspname AS "SCHEMA",
                ${databaseLiteral} AS "DATABASE",
                'COLUMN' AS "TYPE",
                c.relname AS "PARENT",
                COALESCE(pg_catalog.col_description(c.oid, a.attnum), '') AS "DESCRIPTION",
                'NAME' AS "MATCH_TYPE"
            FROM pg_catalog.pg_class c
            INNER JOIN pg_catalog.pg_namespace n
                ON n.oid = c.relnamespace
            INNER JOIN pg_catalog.pg_attribute a
                ON a.attrelid = c.oid
               AND a.attnum > 0
               AND NOT a.attisdropped
            WHERE c.relkind IN (${tableLikeRelkinds})
              AND ${buildUserSchemaPredicate('n.nspname')}
              AND UPPER(a.attname) LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                2 AS "PRIORITY",
                a.attname AS "NAME",
                n.nspname AS "SCHEMA",
                ${databaseLiteral} AS "DATABASE",
                'COLUMN' AS "TYPE",
                c.relname AS "PARENT",
                COALESCE(pg_catalog.col_description(c.oid, a.attnum), '') AS "DESCRIPTION",
                'COL_DESC' AS "MATCH_TYPE"
            FROM pg_catalog.pg_class c
            INNER JOIN pg_catalog.pg_namespace n
                ON n.oid = c.relnamespace
            INNER JOIN pg_catalog.pg_attribute a
                ON a.attrelid = c.oid
               AND a.attnum > 0
               AND NOT a.attisdropped
            WHERE c.relkind IN (${tableLikeRelkinds})
              AND ${buildUserSchemaPredicate('n.nspname')}
              AND UPPER(COALESCE(pg_catalog.col_description(c.oid, a.attnum), '')) LIKE '${likePattern}' ESCAPE '\\'
              AND UPPER(a.attname) NOT LIKE '${likePattern}' ESCAPE '\\'
        ) AS R
        ORDER BY "PRIORITY", "NAME"
        LIMIT 200
    `;
}

export function buildViewSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string {
    const databaseLiteral = quoteLiteral(database);

    if (options.useServerSideFilter) {
        return `
            SELECT
                c.relname AS "NAME",
                n.nspname AS "SCHEMA",
                ${databaseLiteral} AS "DATABASE"
            FROM pg_catalog.pg_class c
            INNER JOIN pg_catalog.pg_namespace n
                ON n.oid = c.relnamespace
            WHERE c.relkind IN (${buildInList(VIEW_RELKINDS)})
              AND ${buildUserSchemaPredicate('n.nspname')}
              AND UPPER(pg_catalog.pg_get_viewdef(c.oid, true)) LIKE '${options.likePattern}' ESCAPE '\\'
        `;
    }

    return `
        SELECT
            c.relname AS "NAME",
            n.nspname AS "SCHEMA",
            ${databaseLiteral} AS "DATABASE",
            pg_catalog.pg_get_viewdef(c.oid, true) AS "SOURCE"
        FROM pg_catalog.pg_class c
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = c.relnamespace
        WHERE c.relkind IN (${buildInList(VIEW_RELKINDS)})
          AND ${buildUserSchemaPredicate('n.nspname')}
    `;
}

export function buildProcedureSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string {
    const databaseLiteral = quoteLiteral(database);
    const routineTypeExpression = `CASE WHEN p.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS "TYPE"`;

    if (options.useServerSideFilter) {
        return `
            SELECT
                ${buildRoutineSignatureExpression('p')} AS "NAME",
                n.nspname AS "SCHEMA",
                ${databaseLiteral} AS "DATABASE",
                ${routineTypeExpression}
            FROM pg_catalog.pg_proc p
            INNER JOIN pg_catalog.pg_namespace n
                ON n.oid = p.pronamespace
            WHERE p.prokind IN ('f', 'p')
              AND ${buildUserSchemaPredicate('n.nspname')}
              AND UPPER(pg_catalog.pg_get_functiondef(p.oid)) LIKE '${options.likePattern}' ESCAPE '\\'
        `;
    }

    return `
        SELECT
            ${buildRoutineSignatureExpression('p')} AS "NAME",
            n.nspname AS "SCHEMA",
            ${databaseLiteral} AS "DATABASE",
            ${routineTypeExpression},
            pg_catalog.pg_get_functiondef(p.oid) AS "SOURCE"
        FROM pg_catalog.pg_proc p
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = p.pronamespace
        WHERE p.prokind IN ('f', 'p')
          AND ${buildUserSchemaPredicate('n.nspname')}
    `;
}

export function buildTypeGroupsQuery(): string {
    return DEFAULT_TYPE_GROUPS
        .map((type, index) => `${index === 0 ? 'SELECT' : 'UNION ALL SELECT'} ${quoteLiteral(type)} AS "OBJTYPE"`)
        .join(' ');
}

export function buildColumnsWithKeysQuery(
    _database?: string,
    schema?: string,
    tableName?: string,
    objectTypes?: readonly string[]
): string {
    return `
        SELECT
            current_database() AS "DATABASE",
            n.nspname AS "SCHEMA",
            c.relname AS "TABLENAME",
            a.attname AS "ATTNAME",
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS "FORMAT_TYPE",
            COALESCE(pg_catalog.col_description(c.oid, a.attnum), '') AS "DESCRIPTION",
            CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM pg_catalog.pg_constraint pk
                    INNER JOIN LATERAL unnest(pk.conkey) AS key_attnum(attnum)
                        ON TRUE
                    WHERE pk.conrelid = c.oid
                      AND pk.contype = 'p'
                      AND key_attnum.attnum = a.attnum
                ) THEN 1
                ELSE 0
            END AS "IS_PK",
            CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM pg_catalog.pg_constraint fk
                    INNER JOIN LATERAL unnest(fk.conkey) AS key_attnum(attnum)
                        ON TRUE
                    WHERE fk.conrelid = c.oid
                      AND fk.contype = 'f'
                      AND key_attnum.attnum = a.attnum
                ) THEN 1
                ELSE 0
            END AS "IS_FK",
            a.attnum AS "ATTNUM"
        FROM pg_catalog.pg_class c
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = c.relnamespace
        INNER JOIN pg_catalog.pg_attribute a
            ON a.attrelid = c.oid
           AND a.attnum > 0
           AND NOT a.attisdropped
        WHERE ${buildColumnsBaseWhereClause(schema, tableName, objectTypes)}
        ORDER BY n.nspname, c.relname, a.attnum
    `;
}

export function buildTableColumnsQuery(_database: string, schema: string, tableName: string): string {
    return `
        SELECT
            a.attname AS "ATTNAME",
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS "FORMAT_TYPE",
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS "FULL_TYPE",
            CASE WHEN a.attnotnull THEN 1 ELSE 0 END AS "ATTNOTNULL",
            pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS "COLDEFAULT",
            a.attnum AS "ATTNUM",
            COALESCE(pg_catalog.col_description(c.oid, a.attnum), '') AS "DESCRIPTION"
        FROM pg_catalog.pg_class c
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = c.relnamespace
        INNER JOIN pg_catalog.pg_attribute a
            ON a.attrelid = c.oid
           AND a.attnum > 0
           AND NOT a.attisdropped
        LEFT JOIN pg_catalog.pg_attrdef ad
            ON ad.adrelid = c.oid
           AND ad.adnum = a.attnum
        WHERE c.relkind IN (${buildInList([...TABLE_RELKINDS, ...VIEW_RELKINDS])})
          AND ${buildUserSchemaPredicate('n.nspname')}
          ${buildSchemaPredicate('n.nspname', schema)}
          ${buildNamePredicate('c.relname', tableName)}
        ORDER BY a.attnum
    `;
}

export function buildColumnMetadataQuery(_database: string, schema: string, tableName: string): string {
    return `
        SELECT
            a.attname AS "ATTNAME",
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS "FORMAT_TYPE",
            CASE WHEN a.attnotnull THEN 1 ELSE 0 END AS "IS_NOT_NULL",
            pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS "COLDEFAULT",
            COALESCE(pg_catalog.col_description(c.oid, a.attnum), '') AS "DESCRIPTION",
            CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM pg_catalog.pg_constraint pk
                    INNER JOIN LATERAL unnest(pk.conkey) AS key_attnum(attnum)
                        ON TRUE
                    WHERE pk.conrelid = c.oid
                      AND pk.contype = 'p'
                      AND key_attnum.attnum = a.attnum
                ) THEN 1
                ELSE 0
            END AS "IS_PK",
            CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM pg_catalog.pg_constraint fk
                    INNER JOIN LATERAL unnest(fk.conkey) AS key_attnum(attnum)
                        ON TRUE
                    WHERE fk.conrelid = c.oid
                      AND fk.contype = 'f'
                      AND key_attnum.attnum = a.attnum
                ) THEN 1
                ELSE 0
            END AS "IS_FK",
            a.attnum AS "ATTNUM"
        FROM pg_catalog.pg_class c
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = c.relnamespace
        INNER JOIN pg_catalog.pg_attribute a
            ON a.attrelid = c.oid
           AND a.attnum > 0
           AND NOT a.attisdropped
        LEFT JOIN pg_catalog.pg_attrdef ad
            ON ad.adrelid = c.oid
           AND ad.adnum = a.attnum
        WHERE c.relkind IN (${buildInList([...TABLE_RELKINDS, ...VIEW_RELKINDS])})
          AND ${buildUserSchemaPredicate('n.nspname')}
          ${buildSchemaPredicate('n.nspname', schema)}
          ${buildNamePredicate('c.relname', tableName)}
        ORDER BY a.attnum
    `;
}

export function buildLookupColumnsQuery(
    params: {
        schema?: string;
        tableName: string;
        objectId?: number;
    }
): string {
    if (params.objectId !== undefined) {
        return `
            SELECT
                current_database() AS "DATABASE",
                n.nspname AS "SCHEMA",
                c.relname AS "TABLENAME",
                a.attname AS "ATTNAME",
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS "FORMAT_TYPE",
                COALESCE(pg_catalog.col_description(c.oid, a.attnum), '') AS "DESCRIPTION",
                CASE
                    WHEN EXISTS (
                        SELECT 1
                        FROM pg_catalog.pg_constraint pk
                        INNER JOIN LATERAL unnest(pk.conkey) AS key_attnum(attnum)
                            ON TRUE
                        WHERE pk.conrelid = c.oid
                          AND pk.contype = 'p'
                          AND key_attnum.attnum = a.attnum
                    ) THEN 1
                    ELSE 0
                END AS "IS_PK",
                CASE
                    WHEN EXISTS (
                        SELECT 1
                        FROM pg_catalog.pg_constraint fk
                        INNER JOIN LATERAL unnest(fk.conkey) AS key_attnum(attnum)
                            ON TRUE
                        WHERE fk.conrelid = c.oid
                          AND fk.contype = 'f'
                          AND key_attnum.attnum = a.attnum
                    ) THEN 1
                    ELSE 0
                END AS "IS_FK",
                a.attnum AS "ATTNUM"
            FROM pg_catalog.pg_class c
            INNER JOIN pg_catalog.pg_namespace n
                ON n.oid = c.relnamespace
            INNER JOIN pg_catalog.pg_attribute a
                ON a.attrelid = c.oid
               AND a.attnum > 0
               AND NOT a.attisdropped
            WHERE c.oid = ${params.objectId}
            ORDER BY a.attnum
        `;
    }

    return buildColumnsWithKeysQuery(undefined, params.schema, params.tableName, ['TABLE', 'VIEW']);
}

export function buildTableCommentQuery(_database: string, schema: string, tableName: string): string {
    return `
        SELECT
            COALESCE(pg_catalog.obj_description(c.oid, 'pg_class'), '') AS "DESCRIPTION"
        FROM pg_catalog.pg_class c
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = c.relnamespace
        WHERE c.relkind IN (${buildInList([...TABLE_RELKINDS, ...VIEW_RELKINDS])})
          AND n.nspname = ${quoteLiteral(schema)}
          AND c.relname = ${quoteLiteral(tableName)}
        LIMIT 1
    `;
}

export function buildFindTableSchemaQuery(tableName: string): string {
    return `
        SELECT n.nspname AS "SCHEMA"
        FROM pg_catalog.pg_class c
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = c.relnamespace
        WHERE c.relkind IN (${buildInList([...TABLE_RELKINDS, ...VIEW_RELKINDS])})
          AND ${buildUserSchemaPredicate('n.nspname')}
          AND c.relname = ${quoteLiteral(tableName)}
        ORDER BY CASE WHEN n.nspname = 'public' THEN 0 ELSE 1 END, n.nspname
        LIMIT 1
    `;
}

export function buildDdlColumnsQuery(schema: string, tableName: string): string {
    return `
        SELECT
            a.attname AS "ATTNAME",
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS "FULL_TYPE",
            COALESCE(pg_catalog.col_description(c.oid, a.attnum), '') AS "DESCRIPTION",
            CASE WHEN a.attnotnull THEN 1 ELSE 0 END AS "IS_NOT_NULL",
            pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS "COLDEFAULT"
        FROM pg_catalog.pg_class c
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = c.relnamespace
        INNER JOIN pg_catalog.pg_attribute a
            ON a.attrelid = c.oid
           AND a.attnum > 0
           AND NOT a.attisdropped
        LEFT JOIN pg_catalog.pg_attrdef ad
            ON ad.adrelid = c.oid
           AND ad.adnum = a.attnum
        WHERE c.relkind IN (${buildInList(TABLE_RELKINDS)})
          AND n.nspname = ${quoteLiteral(schema)}
          AND c.relname = ${quoteLiteral(tableName)}
        ORDER BY a.attnum
    `;
}

export function buildKeysInfoQuery(schema: string, tableName: string): string {
    return `
        SELECT
            tc.constraint_name AS "CONSTNAME",
            tc.constraint_type AS "TYPE",
            CASE tc.constraint_type
                WHEN 'PRIMARY KEY' THEN 'P'
                WHEN 'UNIQUE' THEN 'U'
                WHEN 'FOREIGN KEY' THEN 'R'
                ELSE ''
            END AS "TYPECHAR",
            kcu.column_name AS "COLNAME",
            pkcu.table_schema AS "PKSCHEMA",
            pkcu.table_name AS "PKRELATION",
            pkcu.column_name AS "PKCOLNAME",
            COALESCE(rc.update_rule, '') AS "UPDATERULE",
            COALESCE(rc.delete_rule, '') AS "DELETERULE"
        FROM information_schema.table_constraints tc
        LEFT JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.constraint_schema = kcu.constraint_schema
           AND tc.table_schema = kcu.table_schema
           AND tc.table_name = kcu.table_name
        LEFT JOIN information_schema.referential_constraints rc
            ON tc.constraint_name = rc.constraint_name
           AND tc.constraint_schema = rc.constraint_schema
        LEFT JOIN information_schema.key_column_usage pkcu
            ON rc.unique_constraint_name = pkcu.constraint_name
           AND rc.unique_constraint_schema = pkcu.constraint_schema
           AND pkcu.ordinal_position = kcu.position_in_unique_constraint
        WHERE tc.table_schema = ${quoteLiteral(schema)}
          AND tc.table_name = ${quoteLiteral(tableName)}
          AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
        ORDER BY tc.constraint_name, kcu.ordinal_position
    `;
}

export function buildTableOwnerQuery(schema: string, tableName: string): string {
    return `
        SELECT pg_catalog.pg_get_userbyid(c.relowner) AS "OWNER"
        FROM pg_catalog.pg_class c
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = c.relnamespace
        WHERE c.relkind IN (${buildInList([...TABLE_RELKINDS, ...VIEW_RELKINDS, ...SEQUENCE_RELKINDS])})
          AND n.nspname = ${quoteLiteral(schema)}
          AND c.relname = ${quoteLiteral(tableName)}
        LIMIT 1
    `;
}

export function buildTableIndexesQuery(schema: string, tableName: string): string {
    return `
        SELECT pg_catalog.pg_get_indexdef(i.indexrelid) AS "INDEX_DDL"
        FROM pg_catalog.pg_index i
        INNER JOIN pg_catalog.pg_class tbl
            ON tbl.oid = i.indrelid
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = tbl.relnamespace
        WHERE n.nspname = ${quoteLiteral(schema)}
          AND tbl.relname = ${quoteLiteral(tableName)}
          AND NOT i.indisprimary
        ORDER BY i.indexrelid
    `;
}

export function buildTableTriggersQuery(schema: string, tableName: string): string {
    return `
        SELECT pg_catalog.pg_get_triggerdef(t.oid, true) AS "TRIGGER_DDL"
        FROM pg_catalog.pg_trigger t
        INNER JOIN pg_catalog.pg_class c
            ON c.oid = t.tgrelid
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = c.relnamespace
        WHERE n.nspname = ${quoteLiteral(schema)}
          AND c.relname = ${quoteLiteral(tableName)}
          AND NOT t.tgisinternal
        ORDER BY t.tgname
    `;
}

export function buildTablePartitionKeyQuery(schema: string, tableName: string): string {
    return `
        SELECT pg_catalog.pg_get_partkeydef(c.oid) AS "PARTITION_KEY"
        FROM pg_catalog.pg_class c
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = c.relnamespace
        WHERE c.relkind = 'p'
          AND n.nspname = ${quoteLiteral(schema)}
          AND c.relname = ${quoteLiteral(tableName)}
        LIMIT 1
    `;
}

export function buildTablePartitionsQuery(schema: string, tableName: string): string {
    return `
        SELECT
            format(
                'CREATE TABLE %I.%I PARTITION OF %I.%I %s;',
                child_ns.nspname,
                child.relname,
                parent_ns.nspname,
                parent.relname,
                pg_catalog.pg_get_expr(child.relpartbound, child.oid, true)
            ) AS "PARTITION_DDL"
        FROM pg_catalog.pg_inherits i
        INNER JOIN pg_catalog.pg_class parent
            ON parent.oid = i.inhparent
        INNER JOIN pg_catalog.pg_namespace parent_ns
            ON parent_ns.oid = parent.relnamespace
        INNER JOIN pg_catalog.pg_class child
            ON child.oid = i.inhrelid
        INNER JOIN pg_catalog.pg_namespace child_ns
            ON child_ns.oid = child.relnamespace
        WHERE parent_ns.nspname = ${quoteLiteral(schema)}
          AND parent.relname = ${quoteLiteral(tableName)}
        ORDER BY child.relname
    `;
}

export function buildViewDefinitionQuery(schema: string, viewName: string): string {
    return `
        SELECT
            CASE WHEN c.relkind = 'm' THEN 'MATERIALIZED VIEW' ELSE 'VIEW' END AS "VIEW_KIND",
            pg_catalog.pg_get_viewdef(c.oid, true) AS "VIEW_SQL"
        FROM pg_catalog.pg_class c
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = c.relnamespace
        WHERE n.nspname = ${quoteLiteral(schema)}
          AND c.relname = ${quoteLiteral(viewName)}
          AND c.relkind IN (${buildInList(VIEW_RELKINDS)})
        LIMIT 1
    `;
}

export function buildRoutineDefinitionQuery(
    schema: string,
    routineSignature: string,
    routineKind?: 'FUNCTION' | 'PROCEDURE'
): string {
    const routineKindFilter = routineKind === 'FUNCTION'
        ? "AND p.prokind = 'f'"
        : routineKind === 'PROCEDURE'
            ? "AND p.prokind = 'p'"
            : '';

    return `
        SELECT pg_catalog.pg_get_functiondef(p.oid) AS "ROUTINE_DDL"
        FROM pg_catalog.pg_proc p
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = p.pronamespace
        WHERE n.nspname = ${quoteLiteral(schema)}
          ${routineKindFilter}
          AND ${buildRoutineSignatureExpression('p')} = ${quoteLiteral(routineSignature)}
        LIMIT 1
    `;
}

export function buildSequenceDefinitionQuery(schema: string, sequenceName: string): string {
  return `
SELECT
format(
'CREATE SEQUENCE %I.%I INCREMENT BY %s MINVALUE %s MAXVALUE %s START WITH %s CACHE %s%s;',
n.nspname,
c.relname,
s.seqincrement,
s.seqmin,
s.seqmax,
s.seqstart,
s.seqcache,
CASE WHEN s.seqcycle THEN ' CYCLE' ELSE ' NO CYCLE' END
) AS "SEQUENCE_DDL"
FROM pg_catalog.pg_class c
INNER JOIN pg_catalog.pg_namespace n
ON n.oid = c.relnamespace
INNER JOIN pg_catalog.pg_sequence s
ON s.seqrelid = c.oid
WHERE c.relkind = 'S'
AND n.nspname = ${quoteLiteral(schema)}
AND c.relname = ${quoteLiteral(sequenceName)}
LIMIT 1
`;
}

// =====================
// PARTITION MANAGEMENT QUERIES
// =====================

/**
 * Build a query to list all partitions of a table with metadata.
 * @param schema The schema name
 * @param tableName The parent table name
 * @returns SQL query string
 */
export function buildListPartitionsQuery(schema: string, tableName: string): string {
  return `
SELECT
child_ns.nspname AS "SCHEMA",
child.relname AS "NAME",
parent.relname AS "PARENT_TABLE",
pg_catalog.pg_get_expr(child.relpartbound, child.oid, true) AS "PARTITION_BOUND",
CASE c.partstrat
  WHEN 'r' THEN 'RANGE'
  WHEN 'l' THEN 'LIST'
  WHEN 'h' THEN 'HASH'
  ELSE 'RANGE'
END AS "PARTITION_STRATEGY",
pg_stat_get_live_tuples(child.oid) AS "ROW_COUNT",
pg_total_relation_size(child.oid) AS "TOTAL_SIZE"
FROM pg_catalog.pg_class parent
INNER JOIN pg_catalog.pg_namespace parent_ns
ON parent_ns.oid = parent.relnamespace
INNER JOIN pg_catalog.pg_inherits i
ON i.inhparent = parent.oid
INNER JOIN pg_catalog.pg_class child
ON child.oid = i.inhrelid
INNER JOIN pg_catalog.pg_namespace child_ns
ON child_ns.oid = child.relnamespace
LEFT JOIN pg_catalog.pg_partitioned_table c
ON c.partrelid = parent.oid
WHERE parent_ns.nspname = ${quoteLiteral(schema)}
AND parent.relname = ${quoteLiteral(tableName)}
ORDER BY child.relname
`;
}

// =====================
// INDEX MANAGEMENT QUERIES
// =====================

/**
 * Build a query to list all indexes on a table with metadata.
 * @param schema The schema name
 * @param tableName The table name
 * @returns SQL query string
 */
export function buildListIndexesQuery(schema: string, tableName: string): string {
  return `
SELECT
n.nspname AS "SCHEMA",
c.relname AS "NAME",
tbl.relname AS "TABLE_NAME",
tbl_ns.nspname AS "TABLE_SCHEMA",
am.amname AS "INDEX_TYPE",
i.indisunique AS "IS_UNIQUE",
i.indisprimary AS "IS_PRIMARY",
pg_catalog.pg_get_indexdef(i.indexrelid, 0, true) AS "DEFINITION",
pg_relation_size(i.indexrelid) AS "INDEX_SIZE",
i.indisvalid AS "IS_VALID"
FROM pg_catalog.pg_index i
INNER JOIN pg_catalog.pg_class c
ON c.oid = i.indexrelid
INNER JOIN pg_catalog.pg_namespace n
ON n.oid = c.relnamespace
INNER JOIN pg_catalog.pg_class tbl
ON tbl.oid = i.indrelid
INNER JOIN pg_catalog.pg_namespace tbl_ns
ON tbl_ns.oid = tbl.relnamespace
INNER JOIN pg_catalog.pg_am am
ON am.oid = c.relam
WHERE tbl_ns.nspname = ${quoteLiteral(schema)}
AND tbl.relname = ${quoteLiteral(tableName)}
ORDER BY c.relname
`;
}

/**
 * Build a query to get the columns of an index.
 * @param schema The schema name
 * @param indexName The index name
 * @returns SQL query string
 */
export function buildIndexColumnsQuery(schema: string, indexName: string): string {
  return `
SELECT
a.attname AS "COLUMN_NAME"
FROM pg_catalog.pg_index i
INNER JOIN pg_catalog.pg_class c
ON c.oid = i.indexrelid
INNER JOIN pg_catalog.pg_namespace n
ON n.oid = c.relnamespace
INNER JOIN pg_catalog.pg_attribute a
ON a.attrelid = i.indrelid
AND a.attnum = ANY(i.indkey)
WHERE n.nspname = ${quoteLiteral(schema)}
AND c.relname = ${quoteLiteral(indexName)}
ORDER BY array_position(i.indkey, a.attnum)
`;
}
