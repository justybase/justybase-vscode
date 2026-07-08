import type { DatabaseColumnLookupParams, DatabaseSourceSearchQueryOptions } from '@justybase/contracts';

const DEFAULT_TYPE_GROUPS = ['TABLE', 'VIEW', 'PROJECTION', 'FUNCTION', 'PROCEDURE'] as const;

type VerticaTableLikeType = 'TABLE' | 'VIEW';

function quoteLiteral(value: string | undefined): string {
    return `'${(value ?? '').replace(/'/g, "''")}'`;
}

function normalizeOptionalName(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function buildSchemaPredicate(alias: string, schema?: string): string {
    const normalizedSchema = normalizeOptionalName(schema);
    return normalizedSchema ? ` AND UPPER(${alias}) = UPPER(${quoteLiteral(normalizedSchema)})` : '';
}

function buildNamePredicate(alias: string, objectName?: string): string {
    const normalizedName = normalizeOptionalName(objectName);
    return normalizedName ? ` AND UPPER(${alias}) = UPPER(${quoteLiteral(normalizedName)})` : '';
}

function buildNonSystemSchemaPredicate(alias: string): string {
    return `${alias} <> 'information_schema' AND ${alias} NOT ILIKE 'v_%'`;
}

function buildRoutineSignatureExpression(nameExpression: string, argsExpression: string): string {
    return `CASE WHEN COALESCE(${argsExpression}, '') = '' THEN ${nameExpression} || '()' ELSE ${nameExpression} || '(' || ${argsExpression} || ')' END`;
}

function buildCommentsJoin(objectType: string, schemaAlias: string, nameAlias: string): string {
	return `
LEFT JOIN V_CATALOG.COMMENTS comments
ON comments.OBJECT_TYPE = ${quoteLiteral(objectType)}
AND comments.OBJECT_SCHEMA = ${schemaAlias}
AND comments.OBJECT_NAME = ${nameAlias}
`;
}

function buildColumnCommentsJoin(schemaAlias: string, _tableAlias: string, columnAlias: string): string {
	return `
LEFT JOIN V_CATALOG.COMMENTS comments
ON comments.OBJECT_TYPE = 'COLUMN'
AND comments.OBJECT_SCHEMA = ${schemaAlias}
AND comments.OBJECT_NAME = ${columnAlias}
`;
}

function buildConstraintFlagsCte(): string {
    return `
        WITH CONSTRAINT_FLAGS AS (
            SELECT
                TABLE_SCHEMA,
                TABLE_NAME,
                COLUMN_NAME,
                MAX(CASE WHEN CONSTRAINT_TYPE = 'p' THEN 1 ELSE 0 END) AS IS_PK,
                MAX(CASE WHEN CONSTRAINT_TYPE = 'f' THEN 1 ELSE 0 END) AS IS_FK
            FROM V_CATALOG.CONSTRAINT_COLUMNS
            GROUP BY TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
        )
    `;
}

function buildListTableObjectsQuery(objectType: 'TABLE' | 'VIEW', schema?: string): string {
    if (objectType === 'TABLE') {
        return `
            SELECT
                t.TABLE_NAME AS "OBJNAME",
                t.TABLE_ID AS "OBJID",
                'TABLE' AS "OBJTYPE",
                t.TABLE_SCHEMA AS "SCHEMA",
                COALESCE(comments.COMMENT, '') AS "DESCRIPTION",
                t.OWNER_NAME AS "OWNER",
                CURRENT_DATABASE() AS "DATABASE"
            FROM V_CATALOG.TABLES t
            ${buildCommentsJoin('TABLE', 't.TABLE_SCHEMA', 't.TABLE_NAME')}
            WHERE NOT t.IS_SYSTEM_TABLE
              AND NOT t.IS_TEMP_TABLE
              AND ${buildNonSystemSchemaPredicate('t.TABLE_SCHEMA')}
              ${buildSchemaPredicate('t.TABLE_SCHEMA', schema)}
            ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME
        `;
    }

    return `
        SELECT
            v.TABLE_NAME AS "OBJNAME",
            v.TABLE_ID AS "OBJID",
            'VIEW' AS "OBJTYPE",
            v.TABLE_SCHEMA AS "SCHEMA",
            COALESCE(comments.COMMENT, '') AS "DESCRIPTION",
            v.OWNER_NAME AS "OWNER",
            CURRENT_DATABASE() AS "DATABASE"
        FROM V_CATALOG.VIEWS v
        ${buildCommentsJoin('VIEW', 'v.TABLE_SCHEMA', 'v.TABLE_NAME')}
        WHERE NOT v.IS_SYSTEM_VIEW
          AND ${buildNonSystemSchemaPredicate('v.TABLE_SCHEMA')}
          ${buildSchemaPredicate('v.TABLE_SCHEMA', schema)}
        ORDER BY v.TABLE_SCHEMA, v.TABLE_NAME
    `;
}

function buildListProjectionObjectsQuery(schema?: string): string {
    return `
        SELECT
            p.PROJECTION_NAME AS "OBJNAME",
            p.PROJECTION_ID AS "OBJID",
            'PROJECTION' AS "OBJTYPE",
            p.PROJECTION_SCHEMA AS "SCHEMA",
            COALESCE(comments.COMMENT, '') AS "DESCRIPTION",
            p.OWNER_NAME AS "OWNER",
            CURRENT_DATABASE() AS "DATABASE"
        FROM V_CATALOG.PROJECTIONS p
        ${buildCommentsJoin('PROJECTION', 'p.PROJECTION_SCHEMA', 'p.PROJECTION_NAME')}
        WHERE ${buildNonSystemSchemaPredicate('p.PROJECTION_SCHEMA')}
          ${buildSchemaPredicate('p.PROJECTION_SCHEMA', schema)}
        ORDER BY p.PROJECTION_SCHEMA, p.PROJECTION_NAME
    `;
}

function buildListFunctionObjectsQuery(schema?: string): string {
    return `
        SELECT
            ${buildRoutineSignatureExpression('f.FUNCTION_NAME', 'f.FUNCTION_ARGUMENT_TYPE')} AS "OBJNAME",
            0 AS "OBJID",
            'FUNCTION' AS "OBJTYPE",
            f.SCHEMA_NAME AS "SCHEMA",
            COALESCE(f.COMMENT, '') AS "DESCRIPTION",
            '' AS "OWNER",
            CURRENT_DATABASE() AS "DATABASE"
        FROM V_CATALOG.USER_FUNCTIONS f
        WHERE ${buildNonSystemSchemaPredicate('f.SCHEMA_NAME')}
          ${buildSchemaPredicate('f.SCHEMA_NAME', schema)}
        ORDER BY f.SCHEMA_NAME, f.FUNCTION_NAME
    `;
}

function buildListProcedureObjectsQuery(schema?: string): string {
    return `
        SELECT
            ${buildRoutineSignatureExpression('p.PROCEDURE_NAME', 'p.PROCEDURE_ARGUMENTS')} AS "OBJNAME",
            0 AS "OBJID",
            'PROCEDURE' AS "OBJTYPE",
            p.SCHEMA_NAME AS "SCHEMA",
            '' AS "DESCRIPTION",
            '' AS "OWNER",
            CURRENT_DATABASE() AS "DATABASE"
        FROM V_CATALOG.USER_PROCEDURES p
        WHERE ${buildNonSystemSchemaPredicate('p.SCHEMA_NAME')}
          ${buildSchemaPredicate('p.SCHEMA_NAME', schema)}
        ORDER BY p.SCHEMA_NAME, p.PROCEDURE_NAME
    `;
}

function buildTableColumnSelect(schema?: string, tableName?: string, objectId?: number, includeOrderBy = true): string {
	const orderByClause = includeOrderBy ? '\nORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION' : '';
	return `
SELECT
CURRENT_DATABASE() AS "DATABASE",
c.TABLE_SCHEMA AS "SCHEMA",
c.TABLE_NAME AS "TABLENAME",
c.COLUMN_NAME AS "ATTNAME",
c.DATA_TYPE AS "FORMAT_TYPE",
c.DATA_TYPE AS "FULL_TYPE",
CASE WHEN c.IS_NULLABLE THEN 0 ELSE 1 END AS "IS_NOT_NULL",
CASE WHEN c.IS_NULLABLE THEN 0 ELSE 1 END AS "ATTNOTNULL",
c.COLUMN_DEFAULT AS "COLDEFAULT",
COALESCE(comments.COMMENT, '') AS "DESCRIPTION",
c.ORDINAL_POSITION AS "ATTNUM",
COALESCE(flags.IS_PK, 0) AS "IS_PK",
COALESCE(flags.IS_FK, 0) AS "IS_FK"
FROM V_CATALOG.COLUMNS c
INNER JOIN V_CATALOG.TABLES t
ON t.TABLE_ID = c.TABLE_ID
LEFT JOIN CONSTRAINT_FLAGS flags
ON flags.TABLE_SCHEMA = c.TABLE_SCHEMA
AND flags.TABLE_NAME = c.TABLE_NAME
AND flags.COLUMN_NAME = c.COLUMN_NAME
${buildColumnCommentsJoin('c.TABLE_SCHEMA', 'c.TABLE_NAME', 'c.COLUMN_NAME')}
WHERE NOT t.IS_SYSTEM_TABLE
AND NOT t.IS_TEMP_TABLE
${typeof objectId === 'number' ? `AND c.TABLE_ID = ${objectId}` : ''}
AND ${buildNonSystemSchemaPredicate('c.TABLE_SCHEMA')}
${buildSchemaPredicate('c.TABLE_SCHEMA', schema)}
${buildNamePredicate('c.TABLE_NAME', tableName)}${orderByClause}
`;
}

function buildViewColumnSelect(schema?: string, tableName?: string, objectId?: number, includeOrderBy = true): string {
	const orderByClause = includeOrderBy ? '\nORDER BY vc.TABLE_SCHEMA, vc.TABLE_NAME, vc.ORDINAL_POSITION' : '';
	return `
SELECT
CURRENT_DATABASE() AS "DATABASE",
vc.TABLE_SCHEMA AS "SCHEMA",
vc.TABLE_NAME AS "TABLENAME",
vc.COLUMN_NAME AS "ATTNAME",
vc.DATA_TYPE AS "FORMAT_TYPE",
vc.DATA_TYPE AS "FULL_TYPE",
0 AS "IS_NOT_NULL",
0 AS "ATTNOTNULL",
NULL AS "COLDEFAULT",
'' AS "DESCRIPTION",
vc.ORDINAL_POSITION AS "ATTNUM",
0 AS "IS_PK",
0 AS "IS_FK"
FROM V_CATALOG.VIEW_COLUMNS vc
INNER JOIN V_CATALOG.VIEWS v
ON v.TABLE_ID = vc.TABLE_ID
WHERE NOT v.IS_SYSTEM_VIEW
${typeof objectId === 'number' ? `AND vc.TABLE_ID = ${objectId}` : ''}
AND ${buildNonSystemSchemaPredicate('vc.TABLE_SCHEMA')}
${buildSchemaPredicate('vc.TABLE_SCHEMA', schema)}
${buildNamePredicate('vc.TABLE_NAME', tableName)}${orderByClause}
`;
}

function buildEmptyObjectQuery(): string {
    return `SELECT NULL AS "OBJNAME", 0 AS "OBJID", NULL AS "OBJTYPE", NULL AS "SCHEMA", NULL AS "DESCRIPTION", NULL AS "OWNER", NULL AS "DATABASE" WHERE 1 = 0`;
}

function buildEmptyColumnQuery(): string {
    return `SELECT NULL AS "DATABASE", NULL AS "SCHEMA", NULL AS "TABLENAME", NULL AS "ATTNAME", NULL AS "FORMAT_TYPE", NULL AS "FULL_TYPE", 0 AS "IS_NOT_NULL", 0 AS "ATTNOTNULL", NULL AS "COLDEFAULT", NULL AS "DESCRIPTION", 0 AS "ATTNUM", 0 AS "IS_PK", 0 AS "IS_FK" WHERE 1 = 0`;
}

function buildCombinedColumnQuery(selects: readonly string[]): string {
    if (selects.length === 0) {
        return buildEmptyColumnQuery();
    }

    return `${buildConstraintFlagsCte()} ${selects.join(' UNION ALL ')} ORDER BY "SCHEMA", "TABLENAME", "ATTNUM"`;
}

function normalizeRequestedTableTypes(objectTypes?: readonly string[]): readonly VerticaTableLikeType[] {
    const normalized = (objectTypes ?? ['TABLE', 'VIEW'])
        .map((type) => type.trim().toUpperCase())
        .filter((type): type is VerticaTableLikeType => type === 'TABLE' || type === 'VIEW');
    return normalized.length > 0 ? normalized : ['TABLE', 'VIEW'];
}

export function buildListDatabasesQuery(): string {
    return 'SELECT CURRENT_DATABASE() AS "DATABASE"';
}

export function buildListSchemasQuery(): string {
    return `
        SELECT SCHEMA_NAME AS "SCHEMA"
        FROM V_CATALOG.SCHEMATA
        WHERE NOT IS_SYSTEM_SCHEMA
          AND ${buildNonSystemSchemaPredicate('SCHEMA_NAME')}
        ORDER BY SCHEMA_NAME
    `;
}

export function buildListTablesQuery(schema?: string): string {
    return buildListTableObjectsQuery('TABLE', schema);
}

export function buildListViewsQuery(schema?: string): string {
    return buildListTableObjectsQuery('VIEW', schema);
}

export function buildListProceduresQuery(schema?: string): string {
    return `
        SELECT
            p.SCHEMA_NAME AS "SCHEMA",
            p.PROCEDURE_NAME AS "PROCEDURE",
            ${buildRoutineSignatureExpression('p.PROCEDURE_NAME', 'p.PROCEDURE_ARGUMENTS')} AS "PROCEDURESIGNATURE",
            '' AS "OWNER",
            CURRENT_DATABASE() AS "DATABASE"
        FROM V_CATALOG.USER_PROCEDURES p
        WHERE ${buildNonSystemSchemaPredicate('p.SCHEMA_NAME')}
          ${buildSchemaPredicate('p.SCHEMA_NAME', schema)}
        ORDER BY p.SCHEMA_NAME, p.PROCEDURE_NAME
    `;
}

export function buildObjectTypeQuery(objectType: string): string {
    const normalizedType = objectType.trim().toUpperCase();
    if (normalizedType === 'TABLE') {
        return buildListTablesQuery();
    }
    if (normalizedType === 'VIEW') {
        return buildListViewsQuery();
    }
    if (normalizedType === 'PROJECTION') {
        return buildListProjectionObjectsQuery();
    }
    if (normalizedType === 'FUNCTION') {
        return buildListFunctionObjectsQuery();
    }
    if (normalizedType === 'PROCEDURE') {
        return buildListProcedureObjectsQuery();
    }
    return buildEmptyObjectQuery();
}

export function buildTypeGroupsQuery(): string {
    return DEFAULT_TYPE_GROUPS
        .map((type, index) => `${index === 0 ? 'SELECT' : 'UNION ALL SELECT'} ${quoteLiteral(type)} AS "OBJTYPE"`)
        .join(' ');
}

export function buildColumnsWithKeysQuery(schema?: string, tableName?: string, objectTypes?: readonly string[]): string {
    const requestedTypes = new Set(normalizeRequestedTableTypes(objectTypes));
    const selects: string[] = [];

    if (requestedTypes.has('TABLE')) {
        selects.push(buildTableColumnSelect(schema, tableName, undefined, false));
    }
    if (requestedTypes.has('VIEW')) {
        selects.push(buildViewColumnSelect(schema, tableName, undefined, false));
    }

    return buildCombinedColumnQuery(selects);
}

export function buildTableColumnsQuery(schema: string, tableName: string): string {
    return `${buildConstraintFlagsCte()} ${buildTableColumnSelect(schema, tableName)}`;
}

export function buildColumnMetadataQuery(schema: string, tableName: string): string {
    return buildColumnsWithKeysQuery(schema, tableName, ['TABLE', 'VIEW']);
}

export function buildLookupColumnsQuery(params: DatabaseColumnLookupParams): string {
    if (params.objectId !== undefined) {
        return buildCombinedColumnQuery([
            buildTableColumnSelect(undefined, undefined, params.objectId, false),
            buildViewColumnSelect(undefined, undefined, params.objectId, false),
        ]);
    }

    return buildColumnsWithKeysQuery(params.schema, params.tableName, ['TABLE', 'VIEW']);
}

export function buildTableCommentQuery(schema: string, tableName: string): string {
	return `
SELECT COALESCE(COMMENT, '') AS "DESCRIPTION"
FROM V_CATALOG.COMMENTS
WHERE OBJECT_TYPE = 'TABLE'
AND UPPER(OBJECT_SCHEMA) = UPPER(${quoteLiteral(schema)})
AND UPPER(OBJECT_NAME) = UPPER(${quoteLiteral(tableName)})
LIMIT 1
`;
}

export function buildFindTableSchemaQuery(tableName: string): string {
    return `
        SELECT TABLE_SCHEMA AS "SCHEMA"
        FROM V_CATALOG.TABLES
        WHERE NOT IS_SYSTEM_TABLE
          AND NOT IS_TEMP_TABLE
          AND ${buildNonSystemSchemaPredicate('TABLE_SCHEMA')}
          AND TABLE_NAME ILIKE ${quoteLiteral(tableName)}
        ORDER BY CASE WHEN TABLE_SCHEMA = 'public' THEN 0 ELSE 1 END, TABLE_SCHEMA
        LIMIT 1
    `;
}

export function buildDdlColumnsQuery(schema: string, tableName: string): string {
    return `
        SELECT
            c.COLUMN_NAME AS "ATTNAME",
            c.DATA_TYPE AS "FULL_TYPE",
            COALESCE(comments.COMMENT, '') AS "DESCRIPTION",
            CASE WHEN c.IS_NULLABLE THEN 0 ELSE 1 END AS "IS_NOT_NULL",
            c.COLUMN_DEFAULT AS "COLDEFAULT"
        FROM V_CATALOG.COLUMNS c
        ${buildColumnCommentsJoin('c.TABLE_SCHEMA', 'c.TABLE_NAME', 'c.COLUMN_NAME')}
        WHERE UPPER(c.TABLE_SCHEMA) = UPPER(${quoteLiteral(schema)})
          AND UPPER(c.TABLE_NAME) = UPPER(${quoteLiteral(tableName)})
        ORDER BY c.ORDINAL_POSITION
    `;
}

export function buildKeysInfoQuery(schema: string, tableName: string): string {
    return `
        SELECT
            CONSTRAINT_NAME AS "CONSTNAME",
            CASE CONSTRAINT_TYPE
                WHEN 'p' THEN 'PRIMARY KEY'
                WHEN 'u' THEN 'UNIQUE'
                WHEN 'f' THEN 'FOREIGN KEY'
                WHEN 'c' THEN 'CHECK'
                WHEN 'n' THEN 'NOT NULL'
                ELSE CONSTRAINT_TYPE
            END AS "TYPE",
            UPPER(CONSTRAINT_TYPE) AS "TYPECHAR",
            COLUMN_NAME AS "COLNAME",
            REFERENCE_TABLE_SCHEMA AS "PKSCHEMA",
            REFERENCE_TABLE_NAME AS "PKRELATION",
            REFERENCE_COLUMN_NAME AS "PKCOLNAME",
            '' AS "UPDATERULE",
            '' AS "DELETERULE",
            CASE WHEN IS_ENABLED THEN 'ENABLED' ELSE 'DISABLED' END AS "ENFORCED"
        FROM V_CATALOG.CONSTRAINT_COLUMNS
        WHERE UPPER(TABLE_SCHEMA) = UPPER(${quoteLiteral(schema)})
          AND UPPER(TABLE_NAME) = UPPER(${quoteLiteral(tableName)})
        ORDER BY CONSTRAINT_NAME, COLUMN_NAME
    `;
}

export function buildTableOwnerQuery(schema: string, tableName: string): string {
    return `
        SELECT OWNER_NAME AS "OWNER"
        FROM V_CATALOG.TABLES
        WHERE UPPER(TABLE_SCHEMA) = UPPER(${quoteLiteral(schema)})
          AND UPPER(TABLE_NAME) = UPPER(${quoteLiteral(tableName)})
        LIMIT 1
    `;
}

export function buildObjectSearchQuery(_database: string, likePattern: string): string {
    return `
        SELECT * FROM (
            SELECT
                1 AS "PRIORITY",
                t.TABLE_NAME AS "NAME",
                t.TABLE_SCHEMA AS "SCHEMA",
                CURRENT_DATABASE() AS "DATABASE",
                'TABLE' AS "TYPE",
                '' AS "PARENT",
                COALESCE(comments.COMMENT, '') AS "DESCRIPTION",
                'NAME' AS "MATCH_TYPE"
            FROM V_CATALOG.TABLES t
            ${buildCommentsJoin('TABLE', 't.TABLE_SCHEMA', 't.TABLE_NAME')}
            WHERE NOT t.IS_SYSTEM_TABLE
              AND NOT t.IS_TEMP_TABLE
              AND ${buildNonSystemSchemaPredicate('t.TABLE_SCHEMA')}
              AND UPPER(t.TABLE_NAME) LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                1 AS "PRIORITY",
                v.TABLE_NAME AS "NAME",
                v.TABLE_SCHEMA AS "SCHEMA",
                CURRENT_DATABASE() AS "DATABASE",
                'VIEW' AS "TYPE",
                '' AS "PARENT",
                COALESCE(v.VIEW_DEFINITION, '') AS "DESCRIPTION",
                'NAME' AS "MATCH_TYPE"
            FROM V_CATALOG.VIEWS v
            WHERE NOT v.IS_SYSTEM_VIEW
              AND ${buildNonSystemSchemaPredicate('v.TABLE_SCHEMA')}
              AND UPPER(v.TABLE_NAME) LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                1 AS "PRIORITY",
                p.PROJECTION_NAME AS "NAME",
                p.PROJECTION_SCHEMA AS "SCHEMA",
                CURRENT_DATABASE() AS "DATABASE",
                'PROJECTION' AS "TYPE",
                p.ANCHOR_TABLE_NAME AS "PARENT",
                '' AS "DESCRIPTION",
                'NAME' AS "MATCH_TYPE"
            FROM V_CATALOG.PROJECTIONS p
            WHERE ${buildNonSystemSchemaPredicate('p.PROJECTION_SCHEMA')}
              AND UPPER(p.PROJECTION_NAME) LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                1 AS "PRIORITY",
                ${buildRoutineSignatureExpression('f.FUNCTION_NAME', 'f.FUNCTION_ARGUMENT_TYPE')} AS "NAME",
                f.SCHEMA_NAME AS "SCHEMA",
                CURRENT_DATABASE() AS "DATABASE",
                'FUNCTION' AS "TYPE",
                '' AS "PARENT",
                COALESCE(f.COMMENT, '') AS "DESCRIPTION",
                'NAME' AS "MATCH_TYPE"
            FROM V_CATALOG.USER_FUNCTIONS f
            WHERE ${buildNonSystemSchemaPredicate('f.SCHEMA_NAME')}
              AND UPPER(${buildRoutineSignatureExpression('f.FUNCTION_NAME', 'f.FUNCTION_ARGUMENT_TYPE')}) LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                1 AS "PRIORITY",
                ${buildRoutineSignatureExpression('p.PROCEDURE_NAME', 'p.PROCEDURE_ARGUMENTS')} AS "NAME",
                p.SCHEMA_NAME AS "SCHEMA",
                CURRENT_DATABASE() AS "DATABASE",
                'PROCEDURE' AS "TYPE",
                '' AS "PARENT",
                '' AS "DESCRIPTION",
                'NAME' AS "MATCH_TYPE"
            FROM V_CATALOG.USER_PROCEDURES p
            WHERE ${buildNonSystemSchemaPredicate('p.SCHEMA_NAME')}
              AND UPPER(${buildRoutineSignatureExpression('p.PROCEDURE_NAME', 'p.PROCEDURE_ARGUMENTS')}) LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                2 AS "PRIORITY",
                c.COLUMN_NAME AS "NAME",
                c.TABLE_SCHEMA AS "SCHEMA",
                CURRENT_DATABASE() AS "DATABASE",
                'COLUMN' AS "TYPE",
                c.TABLE_NAME AS "PARENT",
                COALESCE(comments.COMMENT, '') AS "DESCRIPTION",
                'NAME' AS "MATCH_TYPE"
            FROM V_CATALOG.COLUMNS c
            INNER JOIN V_CATALOG.TABLES t
                ON t.TABLE_ID = c.TABLE_ID
            ${buildColumnCommentsJoin('c.TABLE_SCHEMA', 'c.TABLE_NAME', 'c.COLUMN_NAME')}
            WHERE NOT t.IS_SYSTEM_TABLE
              AND NOT t.IS_TEMP_TABLE
              AND ${buildNonSystemSchemaPredicate('c.TABLE_SCHEMA')}
              AND UPPER(c.COLUMN_NAME) LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                2 AS "PRIORITY",
                vc.COLUMN_NAME AS "NAME",
                vc.TABLE_SCHEMA AS "SCHEMA",
                CURRENT_DATABASE() AS "DATABASE",
                'COLUMN' AS "TYPE",
                vc.TABLE_NAME AS "PARENT",
                '' AS "DESCRIPTION",
                'NAME' AS "MATCH_TYPE"
            FROM V_CATALOG.VIEW_COLUMNS vc
            INNER JOIN V_CATALOG.VIEWS v
                ON v.TABLE_ID = vc.TABLE_ID
            WHERE NOT v.IS_SYSTEM_VIEW
              AND ${buildNonSystemSchemaPredicate('vc.TABLE_SCHEMA')}
              AND UPPER(vc.COLUMN_NAME) LIKE '${likePattern}' ESCAPE '\\'
        ) AS R
        ORDER BY "PRIORITY", "NAME"
        LIMIT 200
    `;
}

export function buildViewSourceSearchQuery(_database: string, options: DatabaseSourceSearchQueryOptions): string {
    if (options.useServerSideFilter) {
        return `
            SELECT
                TABLE_NAME AS "NAME",
                TABLE_SCHEMA AS "SCHEMA",
                CURRENT_DATABASE() AS "DATABASE",
                'VIEW' AS "TYPE"
            FROM V_CATALOG.VIEWS
            WHERE NOT IS_SYSTEM_VIEW
              AND ${buildNonSystemSchemaPredicate('TABLE_SCHEMA')}
              AND UPPER(COALESCE(VIEW_DEFINITION, '')) LIKE '${options.likePattern}' ESCAPE '\\'
        `;
    }

    return `
        SELECT
            TABLE_NAME AS "NAME",
            TABLE_SCHEMA AS "SCHEMA",
            CURRENT_DATABASE() AS "DATABASE",
            'VIEW' AS "TYPE",
            VIEW_DEFINITION AS "SOURCE"
        FROM V_CATALOG.VIEWS
        WHERE NOT IS_SYSTEM_VIEW
          AND ${buildNonSystemSchemaPredicate('TABLE_SCHEMA')}
    `;
}

export function buildProcedureSourceSearchQuery(_database: string, options: DatabaseSourceSearchQueryOptions): string {
    if (options.useServerSideFilter) {
        return `
            SELECT
                ${buildRoutineSignatureExpression('f.FUNCTION_NAME', 'f.FUNCTION_ARGUMENT_TYPE')} AS "NAME",
                f.SCHEMA_NAME AS "SCHEMA",
                CURRENT_DATABASE() AS "DATABASE",
                'FUNCTION' AS "TYPE"
            FROM V_CATALOG.USER_FUNCTIONS f
            WHERE ${buildNonSystemSchemaPredicate('f.SCHEMA_NAME')}
              AND UPPER(COALESCE(f.FUNCTION_DEFINITION, '')) LIKE '${options.likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                ${buildRoutineSignatureExpression('p.PROCEDURE_NAME', 'p.PROCEDURE_ARGUMENTS')} AS "NAME",
                p.SCHEMA_NAME AS "SCHEMA",
                CURRENT_DATABASE() AS "DATABASE",
                'PROCEDURE' AS "TYPE"
            FROM V_CATALOG.USER_PROCEDURES p
            WHERE ${buildNonSystemSchemaPredicate('p.SCHEMA_NAME')}
              AND (
                    UPPER(${buildRoutineSignatureExpression('p.PROCEDURE_NAME', 'p.PROCEDURE_ARGUMENTS')}) LIKE '${options.likePattern}' ESCAPE '\\'
                 OR UPPER(COALESCE(p.PROCEDURE_ARGUMENTS, '')) LIKE '${options.likePattern}' ESCAPE '\\'
              )
        `;
    }

    return `
        SELECT
            ${buildRoutineSignatureExpression('f.FUNCTION_NAME', 'f.FUNCTION_ARGUMENT_TYPE')} AS "NAME",
            f.SCHEMA_NAME AS "SCHEMA",
            CURRENT_DATABASE() AS "DATABASE",
            'FUNCTION' AS "TYPE",
            COALESCE(f.FUNCTION_DEFINITION, '') AS "SOURCE"
        FROM V_CATALOG.USER_FUNCTIONS f
        WHERE ${buildNonSystemSchemaPredicate('f.SCHEMA_NAME')}
        UNION ALL
        SELECT
            ${buildRoutineSignatureExpression('p.PROCEDURE_NAME', 'p.PROCEDURE_ARGUMENTS')} AS "NAME",
            p.SCHEMA_NAME AS "SCHEMA",
            CURRENT_DATABASE() AS "DATABASE",
            'PROCEDURE' AS "TYPE",
            '' AS "SOURCE"
        FROM V_CATALOG.USER_PROCEDURES p
        WHERE ${buildNonSystemSchemaPredicate('p.SCHEMA_NAME')}
    `;
}
