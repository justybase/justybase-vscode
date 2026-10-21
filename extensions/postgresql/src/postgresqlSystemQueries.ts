import type { DatabaseSourceSearchQueryOptions } from '@justybase/contracts';

type PostgreSqlTableLikeType = 'TABLE' | 'VIEW' | 'MATERIALIZED VIEW' | 'FOREIGN TABLE';
type PostgreSqlCatalogObjectType = PostgreSqlTableLikeType | 'SEQUENCE' | 'FUNCTION' | 'PROCEDURE' | 'TRIGGER' | 'INDEX';

const TABLE_RELKINDS = ['r', 'p'] as const;
const MATERIALIZED_VIEW_RELKINDS = ['m'] as const;
const FOREIGN_TABLE_RELKINDS = ['f'] as const;
const VIEW_RELKINDS = ['v'] as const;
/** Every relation kind with browsable columns. */
const COLUMN_BEARING_RELKINDS = [...TABLE_RELKINDS, ...VIEW_RELKINDS, ...MATERIALIZED_VIEW_RELKINDS, ...FOREIGN_TABLE_RELKINDS] as const;
const SEQUENCE_RELKINDS = ['S'] as const;
const DEFAULT_TYPE_GROUPS = ['TABLE', 'VIEW', 'MATERIALIZED VIEW', 'FOREIGN TABLE', 'SEQUENCE', 'FUNCTION', 'PROCEDURE', 'TRIGGER', 'INDEX'] as const;

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

function buildRelkindList(objectTypes?: readonly string[], fallback: readonly PostgreSqlTableLikeType[] = ['TABLE', 'VIEW', 'MATERIALIZED VIEW', 'FOREIGN TABLE']): string {
    const normalizedTypes = (objectTypes ?? fallback)
        .map(type => type.trim().toUpperCase())
        .filter((type): type is PostgreSqlTableLikeType => type === 'TABLE' || type === 'VIEW' || type === 'MATERIALIZED VIEW' || type === 'FOREIGN TABLE');

    const relkinds = new Set<string>();
    for (const type of normalizedTypes.length > 0 ? normalizedTypes : fallback) {
        const source = type === 'VIEW' ? VIEW_RELKINDS : type === 'MATERIALIZED VIEW' ? MATERIALIZED_VIEW_RELKINDS : type === 'FOREIGN TABLE' ? FOREIGN_TABLE_RELKINDS : TABLE_RELKINDS;
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

    if (normalizedType === 'MATERIALIZED VIEW') {
        return buildRelationObjectQuery(MATERIALIZED_VIEW_RELKINDS, 'MATERIALIZED VIEW');
    }

    if (normalizedType === 'FOREIGN TABLE') {
        return buildRelationObjectQuery(FOREIGN_TABLE_RELKINDS, 'FOREIGN TABLE');
    }

    if (normalizedType === 'TRIGGER') {
        return `
            SELECT
                t.tgname AS "OBJNAME",
                t.oid::INT AS "OBJID",
                n.nspname AS "SCHEMA",
                COALESCE('ON ' || c.relname || ' (' || CASE t.tgenabled WHEN 'O' THEN 'enabled' WHEN 'D' THEN 'disabled' ELSE 'replica/always' END || ')', '') AS "DESCRIPTION",
                pg_get_userbyid(c.relowner) AS "OWNER",
                current_database() AS "DATABASE"
            FROM pg_catalog.pg_trigger t
            INNER JOIN pg_catalog.pg_class c
                ON c.oid = t.tgrelid
            INNER JOIN pg_catalog.pg_namespace n
                ON n.oid = c.relnamespace
            WHERE NOT t.tgisinternal
              AND ${buildUserSchemaPredicate('n.nspname')}
            ORDER BY n.nspname, t.tgname
        `;
    }

    if (normalizedType === 'INDEX') {
        return `
            SELECT
                c.relname AS "OBJNAME",
                c.oid::INT AS "OBJID",
                n.nspname AS "SCHEMA",
                COALESCE('ON ' || tbl.relname, '') AS "DESCRIPTION",
                pg_get_userbyid(c.relowner) AS "OWNER",
                current_database() AS "DATABASE"
            FROM pg_catalog.pg_index i
            INNER JOIN pg_catalog.pg_class c
                ON c.oid = i.indexrelid
            INNER JOIN pg_catalog.pg_class tbl
                ON tbl.oid = i.indrelid
            INNER JOIN pg_catalog.pg_namespace n
                ON n.oid = c.relnamespace
            WHERE NOT i.indisprimary
              AND ${buildUserSchemaPredicate('n.nspname')}
            ORDER BY n.nspname, c.relname
        `;
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
    const relationRelkinds = buildInList([...COLUMN_BEARING_RELKINDS, ...SEQUENCE_RELKINDS]);
    const tableLikeRelkinds = buildInList([...COLUMN_BEARING_RELKINDS]);

    return `
        SELECT * FROM (
            SELECT
                1 AS "PRIORITY",
                c.relname AS "NAME",
                n.nspname AS "SCHEMA",
                ${databaseLiteral} AS "DATABASE",
                CASE
                    WHEN c.relkind IN (${buildInList(MATERIALIZED_VIEW_RELKINDS)}) THEN 'MATERIALIZED VIEW'
                    WHEN c.relkind IN (${buildInList(FOREIGN_TABLE_RELKINDS)}) THEN 'FOREIGN TABLE'
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
                    WHEN c.relkind IN (${buildInList(MATERIALIZED_VIEW_RELKINDS)}) THEN 'MATERIALIZED VIEW'
                    WHEN c.relkind IN (${buildInList(FOREIGN_TABLE_RELKINDS)}) THEN 'FOREIGN TABLE'
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

export function buildForeignKeyRelationshipsQuery(
    _database: string,
    schema?: string,
    tableName?: string,
): string {
    return `
        SELECT
            current_database() AS "FROM_DATABASE",
            source_ns.nspname AS "FROM_SCHEMA",
            source_table.relname AS "FROM_TABLE",
            source_column.attname AS "FROM_COLUMN",
            current_database() AS "TO_DATABASE",
            target_ns.nspname AS "TO_SCHEMA",
            target_table.relname AS "TO_TABLE",
            target_column.attname AS "TO_COLUMN",
            fk.conname AS "CONSTRAINT_NAME",
            source_key.ordinality AS "ORDINAL_POSITION"
        FROM pg_catalog.pg_constraint fk
        INNER JOIN pg_catalog.pg_class source_table ON source_table.oid = fk.conrelid
        INNER JOIN pg_catalog.pg_namespace source_ns ON source_ns.oid = source_table.relnamespace
        INNER JOIN pg_catalog.pg_class target_table ON target_table.oid = fk.confrelid
        INNER JOIN pg_catalog.pg_namespace target_ns ON target_ns.oid = target_table.relnamespace
        INNER JOIN LATERAL unnest(fk.conkey) WITH ORDINALITY source_key(attnum, ordinality) ON TRUE
        INNER JOIN LATERAL unnest(fk.confkey) WITH ORDINALITY target_key(attnum, ordinality)
            ON target_key.ordinality = source_key.ordinality
        INNER JOIN pg_catalog.pg_attribute source_column
            ON source_column.attrelid = source_table.oid AND source_column.attnum = source_key.attnum
        INNER JOIN pg_catalog.pg_attribute target_column
            ON target_column.attrelid = target_table.oid AND target_column.attnum = target_key.attnum
        WHERE fk.contype = 'f'
          ${buildSchemaPredicate('source_ns.nspname', schema)}
          ${buildNamePredicate('source_table.relname', tableName)}
        ORDER BY source_ns.nspname, source_table.relname, fk.conname, source_key.ordinality
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
        WHERE c.relkind IN (${buildInList([...COLUMN_BEARING_RELKINDS])})
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
        WHERE c.relkind IN (${buildInList([...COLUMN_BEARING_RELKINDS])})
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

    return buildColumnsWithKeysQuery(undefined, params.schema, params.tableName, ['TABLE', 'VIEW', 'MATERIALIZED VIEW', 'FOREIGN TABLE']);
}

export function buildTableCommentQuery(_database: string, schema: string, tableName: string): string {
    return `
        SELECT
            COALESCE(pg_catalog.obj_description(c.oid, 'pg_class'), '') AS "DESCRIPTION"
        FROM pg_catalog.pg_class c
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = c.relnamespace
        WHERE c.relkind IN (${buildInList([...COLUMN_BEARING_RELKINDS])})
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
        WHERE c.relkind IN (${buildInList([...COLUMN_BEARING_RELKINDS])})
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
        WHERE c.relkind IN (${buildInList(COLUMN_BEARING_RELKINDS)})
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
        WHERE c.relkind IN (${buildInList([...COLUMN_BEARING_RELKINDS, ...SEQUENCE_RELKINDS])})
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

/** Single index definition plus the parent table (index names are schema-unique). */
export function buildIndexDefinitionQuery(schema: string, indexName: string): string {
    return `
        SELECT
            pg_catalog.pg_get_indexdef(c.oid) AS "INDEX_DDL",
            tbl.relname AS "TABLE_NAME"
        FROM pg_catalog.pg_class c
        INNER JOIN pg_catalog.pg_index i
            ON i.indexrelid = c.oid
        INNER JOIN pg_catalog.pg_class tbl
            ON tbl.oid = i.indrelid
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = c.relnamespace
        WHERE n.nspname = ${quoteLiteral(schema)}
          AND c.relname = ${quoteLiteral(indexName)}
        LIMIT 1
    `;
}

/** Single trigger definition plus the parent table (trigger names may repeat per table). */
export function buildTriggerDefinitionQuery(schema: string, triggerName: string): string {
    return `
        SELECT
            pg_catalog.pg_get_triggerdef(t.oid, true) AS "TRIGGER_DDL",
            c.relname AS "TABLE_NAME"
        FROM pg_catalog.pg_trigger t
        INNER JOIN pg_catalog.pg_class c
            ON c.oid = t.tgrelid
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = c.relnamespace
        WHERE n.nspname = ${quoteLiteral(schema)}
          AND t.tgname = ${quoteLiteral(triggerName)}
          AND NOT t.tgisinternal
        ORDER BY c.relname
    `;
}

/** Foreign table server, options, owner and comment. */
export function buildForeignTableDefinitionQuery(schema: string, tableName: string): string {
    return `
        SELECT
            s.srvname AS "SERVER_NAME",
            ft.ftoptions AS "TABLE_OPTIONS",
            COALESCE(pg_catalog.obj_description(c.oid, 'pg_class'), '') AS "DESCRIPTION",
            pg_catalog.pg_get_userbyid(c.relowner) AS "OWNER"
        FROM pg_catalog.pg_foreign_table ft
        INNER JOIN pg_catalog.pg_class c
            ON c.oid = ft.ftrelid
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = c.relnamespace
        INNER JOIN pg_catalog.pg_foreign_server s
            ON s.oid = ft.ftserver
        WHERE n.nspname = ${quoteLiteral(schema)}
          AND c.relname = ${quoteLiteral(tableName)}
        LIMIT 1
    `;
}

/** Per-column OPTIONS for foreign table columns. */
export function buildForeignTableColumnOptionsQuery(schema: string, tableName: string): string {
    return `
        SELECT
            a.attname AS "ATTNAME",
            a.attoptions AS "COLUMN_OPTIONS"
        FROM pg_catalog.pg_attribute a
        INNER JOIN pg_catalog.pg_class c
            ON c.oid = a.attrelid
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = c.relnamespace
        WHERE n.nspname = ${quoteLiteral(schema)}
          AND c.relname = ${quoteLiteral(tableName)}
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND a.attoptions IS NOT NULL
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
          AND c.relkind IN (${buildInList([...VIEW_RELKINDS, ...MATERIALIZED_VIEW_RELKINDS])})
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
export function buildAlterTablePropertiesQuery(schema: string, tableName: string): string {
    return `
        SELECT
            c.oid AS TABLE_OID,
            COALESCE(t.spcname, '') AS TABLESPACE,
            (
                SELECT option_value
                FROM pg_catalog.pg_options_to_table(c.reloptions) AS relopt(option_name, option_value)
                WHERE relopt.option_name = 'fillfactor'
            ) AS FILLFACTOR,
            COALESCE(obj_description(c.oid, 'pg_class'), '') AS TABLE_COMMENT
        FROM pg_catalog.pg_class c
        INNER JOIN pg_catalog.pg_namespace n
            ON n.oid = c.relnamespace
        LEFT JOIN pg_catalog.pg_tablespace t
            ON t.oid = c.reltablespace
        WHERE n.nspname = ${quoteLiteral(schema)}
          AND c.relname = ${quoteLiteral(tableName)}
          AND c.relkind IN (${buildInList([...COLUMN_BEARING_RELKINDS])})
    `;
}

export function buildDesignerListIndexesQuery(schema: string, tableName: string): string {
    return `
        SELECT
            c.relname AS INDEX_NAME,
            CASE WHEN i.indisunique THEN 1 ELSE 0 END AS IS_UNIQUE,
            CASE WHEN i.indisprimary THEN 1 ELSE 0 END AS IS_PRIMARY,
            am.amname AS INDEX_TYPE,
            COALESCE(pg_catalog.pg_get_expr(i.indpred, i.indrelid), '') AS PREDICATE,
            COALESCE(t.spcname, '') AS TABLESPACE,
            COALESCE(a.attname, pg_catalog.pg_get_indexdef(i.indexrelid, k.ord, true)) AS COLUMN_NAME,
            k.ord AS SEQ,
            CASE WHEN k.ord <= i.indnkeyatts THEN 1 ELSE 0 END AS IS_KEY,
            CASE WHEN (i.indoption[k.ord - 1] & 1)::INT = 1 THEN 1 ELSE 0 END AS IS_DESC,
            CASE WHEN (i.indoption[k.ord - 1] & 2)::INT = 2 THEN 1 ELSE 0 END AS NULLS_FIRST
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
        LEFT JOIN pg_catalog.pg_tablespace t
            ON t.oid = c.reltablespace
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
        LEFT JOIN pg_catalog.pg_attribute a
            ON a.attrelid = i.indrelid
           AND a.attnum = k.attnum
           AND a.attnum > 0
           AND NOT a.attisdropped
        WHERE tbl_ns.nspname = ${quoteLiteral(schema)}
          AND tbl.relname = ${quoteLiteral(tableName)}
        ORDER BY c.relname, k.ord
    `;
}

export function buildListTablespacesQuery(): string {
    return `
        SELECT spcname AS TABLESPACE
        FROM pg_catalog.pg_tablespace
        ORDER BY spcname
    `;
}

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

export type PostgreSqlTableDetailKind = 'keys' | 'indexes' | 'triggers';

/** Keys/constraints, indexes or triggers of one table for the schema tree (NAME, KIND, DETAIL). */
export function buildTableDetailQuery(
    _database: string,
    schema: string,
    tableName: string,
    detail: PostgreSqlTableDetailKind,
): string {
    const tableFilter = `n.nspname = ${quoteLiteral(schema)} AND t.relname = ${quoteLiteral(tableName)}`;
    if (detail === 'keys') {
        return `
            SELECT
                c.conname AS "NAME",
                CASE c.contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'u' THEN 'UNIQUE' WHEN 'f' THEN 'FOREIGN KEY'
                    WHEN 'c' THEN 'CHECK' ELSE 'EXCLUDE' END AS "KIND",
                pg_catalog.pg_get_constraintdef(c.oid, true) AS "DETAIL"
            FROM pg_catalog.pg_constraint c
            INNER JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
            INNER JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
            WHERE ${tableFilter} AND c.contype IN ('p', 'u', 'f', 'c', 'x')
            ORDER BY CASE c.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, c.conname
        `;
    }
    if (detail === 'indexes') {
        return `
            SELECT
                i.relname AS "NAME",
                CASE WHEN ix.indisprimary THEN 'PRIMARY KEY' WHEN ix.indisunique THEN 'UNIQUE' ELSE 'INDEX' END AS "KIND",
                substring(pg_catalog.pg_get_indexdef(ix.indexrelid) FROM ' USING (.*)$') AS "DETAIL"
            FROM pg_catalog.pg_index ix
            INNER JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
            INNER JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
            INNER JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
            WHERE ${tableFilter}
            ORDER BY ix.indisprimary DESC, ix.indisunique DESC, i.relname
        `;
    }
    return `
        SELECT
            tg.tgname AS "NAME",
            CASE tg.tgenabled WHEN 'D' THEN 'DISABLED' ELSE 'TRIGGER' END AS "KIND",
            substring(pg_catalog.pg_get_triggerdef(tg.oid, true) FROM '((?:BEFORE|AFTER|INSTEAD OF) .*?) ON ') AS "DETAIL"
        FROM pg_catalog.pg_trigger tg
        INNER JOIN pg_catalog.pg_class t ON t.oid = tg.tgrelid
        INNER JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
        WHERE ${tableFilter} AND NOT tg.tgisinternal
        ORDER BY tg.tgname
    `;
}

/**
 * Catalog-recorded dependencies for impact analysis: views/materialized views
 * through their rewrite rules (with column detail), SQL-standard routine
 * bodies, trigger functions and sequence-backed column defaults.
 */
export function buildObjectDependenciesQuery(_database: string): string {
    const relationType = (alias: string) => `CASE ${alias}.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'VIEW' WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END`;
    const userSchema = (column: string) => `${column} NOT IN ('pg_catalog', 'information_schema') AND ${column} NOT LIKE 'pg\\_toast%'`;
    return `
        SELECT DISTINCT sn.nspname AS "SOURCE_SCHEMA", sc.relname AS "SOURCE_NAME", 'VIEW' AS "SOURCE_TYPE",
            tn.nspname AS "TARGET_SCHEMA", tc.relname AS "TARGET_NAME", ${relationType('tc')} AS "TARGET_TYPE",
            a.attname AS "TARGET_COLUMN"
        FROM pg_catalog.pg_depend d
        INNER JOIN pg_catalog.pg_rewrite r ON r.oid = d.objid AND d.classid = 'pg_catalog.pg_rewrite'::regclass
        INNER JOIN pg_catalog.pg_class sc ON sc.oid = r.ev_class
        INNER JOIN pg_catalog.pg_namespace sn ON sn.oid = sc.relnamespace
        INNER JOIN pg_catalog.pg_class tc ON tc.oid = d.refobjid AND d.refclassid = 'pg_catalog.pg_class'::regclass
        INNER JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = tc.oid AND a.attnum = d.refobjsubid AND d.refobjsubid > 0
        WHERE sc.oid <> tc.oid AND ${userSchema('sn.nspname')}
        UNION
        SELECT pn.nspname, p.proname, 'PROCEDURE', tn.nspname, tc.relname, ${relationType('tc')}, a.attname
        FROM pg_catalog.pg_depend d
        INNER JOIN pg_catalog.pg_proc p ON p.oid = d.objid AND d.classid = 'pg_catalog.pg_proc'::regclass
        INNER JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
        INNER JOIN pg_catalog.pg_class tc ON tc.oid = d.refobjid AND d.refclassid = 'pg_catalog.pg_class'::regclass
        INNER JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = tc.oid AND a.attnum = d.refobjsubid AND d.refobjsubid > 0
        WHERE ${userSchema('pn.nspname')}
        UNION
        SELECT tn.nspname, tc.relname, 'TABLE', pn.nspname, p.proname, 'PROCEDURE', NULL
        FROM pg_catalog.pg_trigger tg
        INNER JOIN pg_catalog.pg_class tc ON tc.oid = tg.tgrelid
        INNER JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
        INNER JOIN pg_catalog.pg_proc p ON p.oid = tg.tgfoid
        INNER JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
        WHERE NOT tg.tgisinternal AND ${userSchema('tn.nspname')}
        UNION
        SELECT tn.nspname, tc.relname, 'TABLE', sn.nspname, s.relname, 'SEQUENCE', NULL
        FROM pg_catalog.pg_depend d
        INNER JOIN pg_catalog.pg_attrdef ad ON ad.oid = d.objid AND d.classid = 'pg_catalog.pg_attrdef'::regclass
        INNER JOIN pg_catalog.pg_class tc ON tc.oid = ad.adrelid
        INNER JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
        INNER JOIN pg_catalog.pg_class s ON s.oid = d.refobjid AND d.refclassid = 'pg_catalog.pg_class'::regclass AND s.relkind = 'S'
        INNER JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace
        WHERE ${userSchema('tn.nspname')}
    `;
}

export type PostgreSqlTableReportKind = 'size' | 'privileges' | 'maintenance';
export type PostgreSqlDatabaseReportKind = 'locks' | 'invalidObjects';

/** Read-only table reports shown in SQL Results (size, privileges, vacuum/analyze status). */
export function buildTableReportQuery(
    _database: string,
    schema: string,
    tableName: string,
    report: PostgreSqlTableReportKind,
): string {
    const owner = quoteLiteral(schema);
    const table = quoteLiteral(tableName);
    if (report === 'size') {
        return `
            SELECT
                n.nspname AS "SCHEMA_NAME",
                c.relname AS "TABLE_NAME",
                CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS "ESTIMATED_ROWS",
                pg_size_pretty(pg_total_relation_size(c.oid)) AS "TOTAL_SIZE",
                pg_size_pretty(pg_relation_size(c.oid)) AS "TABLE_SIZE",
                pg_size_pretty(pg_indexes_size(c.oid)) AS "INDEXES_SIZE",
                pg_size_pretty(COALESCE(pg_total_relation_size(NULLIF(c.reltoastrelid, 0)), 0)) AS "TOAST_SIZE",
                pg_total_relation_size(c.oid) AS "TOTAL_BYTES",
                COALESCE(t.spcname, 'pg_default') AS "TABLESPACE"
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_tablespace t ON t.oid = c.reltablespace
            WHERE n.nspname = ${owner} AND c.relname = ${table}
        `;
    }
    if (report === 'privileges') {
        return `
            SELECT
                g.grantee AS "GRANTEE",
                g.grantor AS "GRANTOR",
                string_agg(g.privilege_type, ', ' ORDER BY g.privilege_type) AS "PRIVILEGES",
                bool_or(g.is_grantable = 'YES') AS "WITH_GRANT_OPTION"
            FROM information_schema.role_table_grants g
            WHERE g.table_schema = ${owner} AND g.table_name = ${table}
            GROUP BY g.grantee, g.grantor
            ORDER BY g.grantee
        `;
    }
    return `
        SELECT
            s.schemaname AS "SCHEMA_NAME",
            s.relname AS "TABLE_NAME",
            CASE
                WHEN COALESCE(s.last_analyze, s.last_autoanalyze) IS NULL THEN 'Run ANALYZE (never analyzed)'
                WHEN s.n_live_tup + s.n_dead_tup > 1000 AND s.n_dead_tup * 100 > (s.n_live_tup + s.n_dead_tup) * 20 THEN 'Run VACUUM (dead rows > 20%)'
                WHEN s.n_live_tup > 1000 AND s.n_mod_since_analyze * 100 > s.n_live_tup * 20 THEN 'Run ANALYZE (> 20% rows changed since last analyze)'
                ELSE 'OK'
            END AS "RECOMMENDATION",
            s.n_live_tup AS "LIVE_ROWS",
            s.n_dead_tup AS "DEAD_ROWS",
            CASE WHEN s.n_live_tup + s.n_dead_tup > 0
                THEN round(s.n_dead_tup * 100.0 / (s.n_live_tup + s.n_dead_tup), 2) END AS "DEAD_ROWS_PCT",
            s.n_mod_since_analyze AS "CHANGED_SINCE_ANALYZE",
            GREATEST(s.last_vacuum, s.last_autovacuum) AS "LAST_VACUUM",
            GREATEST(s.last_analyze, s.last_autoanalyze) AS "LAST_ANALYZE",
            s.vacuum_count + s.autovacuum_count AS "VACUUM_COUNT",
            s.analyze_count + s.autoanalyze_count AS "ANALYZE_COUNT"
        FROM pg_stat_user_tables s
        WHERE s.schemaname = ${owner} AND s.relname = ${table}
    `;
}

/** Read-only database reports shown in SQL Results (blocking sessions, invalid indexes). */
export function buildDatabaseReportQuery(_database: string, report: PostgreSqlDatabaseReportKind): string {
    if (report === 'locks') {
        return `
            SELECT
                w.pid AS "WAITING_PID",
                w.usename AS "WAITING_USER",
                w.application_name AS "WAITING_APPLICATION",
                date_trunc('second', now() - w.query_start)::text AS "WAITING_FOR",
                w.wait_event_type || ': ' || w.wait_event AS "WAIT_EVENT",
                b.pid AS "BLOCKING_PID",
                b.usename AS "BLOCKING_USER",
                b.application_name AS "BLOCKING_APPLICATION",
                b.state AS "BLOCKING_STATE",
                left(w.query, 2000) AS "WAITING_SQL",
                left(b.query, 2000) AS "BLOCKING_SQL"
            FROM pg_stat_activity w
            CROSS JOIN LATERAL unnest(pg_blocking_pids(w.pid)) AS blocker(pid)
            JOIN pg_stat_activity b ON b.pid = blocker.pid
            WHERE w.datname = current_database()
            ORDER BY w.query_start
        `;
    }
    // PostgreSQL has no invalid routines or views; a failed CREATE INDEX CONCURRENTLY leaves an invalid index.
    return `
        SELECT
            n.nspname AS "SCHEMA_NAME",
            ic.relname AS "OBJECT_NAME",
            'INDEX' AS "OBJECT_TYPE",
            CASE WHEN NOT i.indisvalid THEN 'INVALID' ELSE 'NOT READY' END AS "STATUS",
            tc.relname AS "TABLE_NAME",
            'Drop and recreate the index, or run REINDEX INDEX' AS "DETAIL"
        FROM pg_index i
        JOIN pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_class tc ON tc.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = ic.relnamespace
        WHERE (NOT i.indisvalid OR NOT i.indisready)
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY 1, 2
    `;
}
