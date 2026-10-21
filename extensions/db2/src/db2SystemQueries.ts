import type { DatabaseSourceSearchQueryOptions } from '@justybase/contracts';

type Db2CatalogObjectType =
    | 'TABLE'
    | 'VIEW'
    | 'PROCEDURE'
    | 'FUNCTION'
    | 'NICKNAME'
    | 'ALIAS'
    | 'MATERIALIZED QUERY TABLE'
    | 'SEQUENCE'
    | 'INDEX'
    | 'TRIGGER'
    | 'TABLESPACE'
    | 'SERVER'
    | 'WRAPPER'
    | 'SERVER OPTION'
    | 'WRAPPER OPTION'
    | 'USER MAPPING'
    | 'PASSTHRU AUTH';

type Db2TableLikeObjectType = 'TABLE' | 'VIEW' | 'NICKNAME' | 'ALIAS' | 'MATERIALIZED QUERY TABLE';

const TABLE_OBJECT_TYPES: Readonly<Record<Db2TableLikeObjectType, readonly string[]>> = {
    TABLE: ['T'],
    VIEW: ['V'],
    NICKNAME: ['N'],
    ALIAS: ['A'],
    'MATERIALIZED QUERY TABLE': ['S']
};

const DEFAULT_TABLE_LIKE_OBJECT_TYPES: readonly Db2TableLikeObjectType[] = ['TABLE', 'VIEW'];
const DEFAULT_TABLE_LIST_OBJECT_TYPES: readonly Db2TableLikeObjectType[] = ['TABLE', 'NICKNAME', 'ALIAS'];
const DEFAULT_BATCH_OBJECT_TYPES = ['TABLE', 'VIEW', 'NICKNAME', 'ALIAS', 'PROCEDURE', 'FUNCTION'] as const;

const NUMERIC_TYPES = new Set(['DECIMAL', 'NUMERIC']);
const LENGTH_TYPES = new Set([
    'CHAR',
    'CHARACTER',
    'VARCHAR',
    'CHARACTER VARYING',
    'GRAPHIC',
    'VARGRAPHIC'
]);

function quoteLiteral(value: string | undefined): string {
    return `'${(value ?? '').replace(/'/g, "''")}'`;
}

function normalizeOptionalName(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function buildEqualityFilter(columnName: string, value?: string): string {
    const normalizedValue = normalizeOptionalName(value);
    return normalizedValue ? ` AND ${columnName} = ${quoteLiteral(normalizedValue)}` : '';
}

function buildInList(values: readonly string[]): string {
    return values.map(value => quoteLiteral(value)).join(', ');
}

function buildProjectedTableTypeExpression(columnName: string): string {
    return `
        CASE
            WHEN ${columnName} = 'N' THEN 'NICKNAME'
            WHEN ${columnName} = 'A' THEN 'ALIAS'
            WHEN ${columnName} = 'V' THEN 'VIEW'
            ELSE 'TABLE'
        END
    `.trim();
}

function buildDatabaseSelectionExpression(database?: string): string {
    const normalizedDatabase = normalizeOptionalName(database);
    return normalizedDatabase ? `${quoteLiteral(normalizedDatabase)} AS DATABASE` : 'CURRENT SERVER AS DATABASE';
}

function buildRoutineSignatureExpression(routineAlias: string, parameterSignatureExpression: string): string {
    return `
        CASE
            WHEN COALESCE(${parameterSignatureExpression}, '') <> ''
                THEN RTRIM(${routineAlias}.ROUTINENAME) || '(' || ${parameterSignatureExpression} || ')'
            ELSE RTRIM(${routineAlias}.ROUTINENAME) || '()'
        END
    `.trim();
}

function buildRoutineParameterSignatureExpression(parameterAlias: string): string {
    return `
        TRIM(
            CASE ${parameterAlias}.ROWTYPE
                WHEN 'O' THEN 'OUT '
                WHEN 'B' THEN 'INOUT '
                ELSE ''
            END ||
            ${buildDb2TypeExpression(parameterAlias, 'LENGTH', 'SCALE')}
        )
    `.trim();
}

function buildRoutineSignaturesCte(routineType?: 'P' | 'F'): string {
    const typeFilter = routineType ? `WHERE R.ROUTINETYPE = ${quoteLiteral(routineType)}` : '';
    return `
        WITH ROUTINE_SIGNATURES AS (
            SELECT
                RTRIM(R.ROUTINESCHEMA) AS ROUTINESCHEMA,
                RTRIM(R.ROUTINENAME) AS ROUTINENAME,
                RTRIM(R.SPECIFICNAME) AS SPECIFICNAME,
                COALESCE(
                    LISTAGG(
                        ${buildRoutineParameterSignatureExpression('P')},
                        ', '
                    ) WITHIN GROUP (ORDER BY P.ORDINAL),
                    ''
                ) AS PARAM_SIGNATURE
            FROM SYSCAT.ROUTINES R
            LEFT JOIN SYSCAT.ROUTINEPARMS P
                ON P.ROUTINESCHEMA = R.ROUTINESCHEMA
               AND P.ROUTINENAME = R.ROUTINENAME
               AND P.SPECIFICNAME = R.SPECIFICNAME
               AND P.ROWTYPE IN ('P', 'B', 'O')
            ${typeFilter}
            GROUP BY R.ROUTINESCHEMA, R.ROUTINENAME, R.SPECIFICNAME
        )
    `;
}

function escapeDb2RegexLiteral(value: string): string {
    return value
        .replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')
        .replace(/'/g, "''");
}

function buildDb2SourceRegexPattern(term: string): string {
    return escapeDb2RegexLiteral(term);
}

function normalizeDb2TableTypes(
    objectTypes?: readonly string[],
    fallbackTypes: readonly Db2TableLikeObjectType[] = DEFAULT_TABLE_LIKE_OBJECT_TYPES
): readonly string[] {
    const normalizedTypes = (objectTypes ?? fallbackTypes)
        .map(type => type.trim().toUpperCase())
        .filter((type): type is Db2TableLikeObjectType => type in TABLE_OBJECT_TYPES);

    if (normalizedTypes.length === 0) {
        return fallbackTypes.flatMap(type => TABLE_OBJECT_TYPES[type]);
    }

    return normalizedTypes.flatMap(type => TABLE_OBJECT_TYPES[type]);
}

function mapRoutineTypeLabel(value: string): Db2CatalogObjectType {
    return value.trim().toUpperCase() === 'F' ? 'FUNCTION' : 'PROCEDURE';
}

export function buildDb2TypeExpression(
    columnAlias: string,
    lengthColumn: string = 'LENGTH',
    scaleColumn: string = 'SCALE'
): string {
    return `
        RTRIM(${columnAlias}.TYPENAME) ||
        CASE
            WHEN ${columnAlias}.TYPENAME IN (${buildInList(Array.from(NUMERIC_TYPES.values()))})
                THEN '(' || RTRIM(CHAR(${columnAlias}.${lengthColumn})) || ',' || RTRIM(CHAR(${columnAlias}.${scaleColumn})) || ')'
            WHEN ${columnAlias}.TYPENAME IN (${buildInList(Array.from(LENGTH_TYPES.values()))}) AND COALESCE(${columnAlias}.${lengthColumn}, 0) > 0
                THEN '(' || RTRIM(CHAR(${columnAlias}.${lengthColumn})) || ')'
            ELSE ''
        END
    `.trim();
}

export function buildListDatabasesQuery(): string {
    return 'SELECT CURRENT SERVER AS DATABASE FROM SYSIBM.SYSDUMMY1 WITH UR';
}

export function buildObjectSearchQuery(database: string, likePattern: string): string {
    const databaseLiteral = quoteLiteral(database);
    return `
        SELECT * FROM (
            SELECT
                1 AS PRIORITY,
                RTRIM(T.TABNAME) AS NAME,
                RTRIM(T.TABSCHEMA) AS SCHEMA,
                ${databaseLiteral} AS DATABASE,
                CASE T.TYPE
                    WHEN 'V' THEN 'VIEW'
                    WHEN 'N' THEN 'NICKNAME'
                    WHEN 'A' THEN 'ALIAS'
                    WHEN 'S' THEN 'MATERIALIZED QUERY TABLE'
                    ELSE 'TABLE'
                END AS TYPE,
                INT(COALESCE(T.TABLEID, 0)) AS OBJID,
                '' AS PARENT,
                COALESCE(T.REMARKS, '') AS DESCRIPTION,
                'NAME' AS MATCH_TYPE
            FROM SYSCAT.TABLES T
            WHERE T.TYPE IN ('T', 'V', 'N', 'A', 'S')
              AND UPPER(T.TABNAME) LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                1 AS PRIORITY,
                RTRIM(T.TABNAME) AS NAME,
                RTRIM(T.TABSCHEMA) AS SCHEMA,
                ${databaseLiteral} AS DATABASE,
                CASE T.TYPE
                    WHEN 'V' THEN 'VIEW'
                    WHEN 'N' THEN 'NICKNAME'
                    WHEN 'A' THEN 'ALIAS'
                    WHEN 'S' THEN 'MATERIALIZED QUERY TABLE'
                    ELSE 'TABLE'
                END AS TYPE,
                INT(COALESCE(T.TABLEID, 0)) AS OBJID,
                '' AS PARENT,
                COALESCE(T.REMARKS, '') AS DESCRIPTION,
                'OBJ_DESC' AS MATCH_TYPE
            FROM SYSCAT.TABLES T
            WHERE T.TYPE IN ('T', 'V', 'N', 'A', 'S')
              AND UPPER(COALESCE(T.REMARKS, '')) LIKE '${likePattern}' ESCAPE '\\'
              AND UPPER(T.TABNAME) NOT LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                1 AS PRIORITY,
                RTRIM(R.ROUTINENAME) AS NAME,
                RTRIM(R.ROUTINESCHEMA) AS SCHEMA,
                ${databaseLiteral} AS DATABASE,
                CASE WHEN R.ROUTINETYPE = 'F' THEN 'FUNCTION' ELSE 'PROCEDURE' END AS TYPE,
                INT(0) AS OBJID,
                '' AS PARENT,
                COALESCE(R.REMARKS, '') AS DESCRIPTION,
                'NAME' AS MATCH_TYPE
            FROM SYSCAT.ROUTINES R
            WHERE R.ROUTINETYPE IN ('P', 'F')
              AND UPPER(R.ROUTINENAME) LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                1 AS PRIORITY,
                RTRIM(R.ROUTINENAME) AS NAME,
                RTRIM(R.ROUTINESCHEMA) AS SCHEMA,
                ${databaseLiteral} AS DATABASE,
                CASE WHEN R.ROUTINETYPE = 'F' THEN 'FUNCTION' ELSE 'PROCEDURE' END AS TYPE,
                INT(0) AS OBJID,
                '' AS PARENT,
                COALESCE(R.REMARKS, '') AS DESCRIPTION,
                'OBJ_DESC' AS MATCH_TYPE
            FROM SYSCAT.ROUTINES R
            WHERE R.ROUTINETYPE IN ('P', 'F')
              AND UPPER(COALESCE(R.REMARKS, '')) LIKE '${likePattern}' ESCAPE '\\'
              AND UPPER(R.ROUTINENAME) NOT LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                2 AS PRIORITY,
                RTRIM(C.COLNAME) AS NAME,
                RTRIM(C.TABSCHEMA) AS SCHEMA,
                ${databaseLiteral} AS DATABASE,
                'COLUMN' AS TYPE,
                INT(COALESCE(T.TABLEID, 0)) AS OBJID,
                RTRIM(C.TABNAME) AS PARENT,
                COALESCE(C.REMARKS, '') AS DESCRIPTION,
                'NAME' AS MATCH_TYPE
            FROM SYSCAT.COLUMNS C
            INNER JOIN SYSCAT.TABLES T
                ON T.TABSCHEMA = C.TABSCHEMA
               AND T.TABNAME = C.TABNAME
            WHERE T.TYPE IN ('T', 'V', 'N', 'A', 'S')
              AND UPPER(C.COLNAME) LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                2 AS PRIORITY,
                RTRIM(C.COLNAME) AS NAME,
                RTRIM(C.TABSCHEMA) AS SCHEMA,
                ${databaseLiteral} AS DATABASE,
                'COLUMN' AS TYPE,
                INT(COALESCE(T.TABLEID, 0)) AS OBJID,
                RTRIM(C.TABNAME) AS PARENT,
                COALESCE(C.REMARKS, '') AS DESCRIPTION,
                'COL_DESC' AS MATCH_TYPE
            FROM SYSCAT.COLUMNS C
            INNER JOIN SYSCAT.TABLES T
                ON T.TABSCHEMA = C.TABSCHEMA
               AND T.TABNAME = C.TABNAME
            WHERE T.TYPE IN ('T', 'V', 'N', 'A', 'S')
              AND UPPER(COALESCE(C.REMARKS, '')) LIKE '${likePattern}' ESCAPE '\\'
              AND UPPER(C.COLNAME) NOT LIKE '${likePattern}' ESCAPE '\\'
        ) AS R
        ORDER BY PRIORITY, NAME
        FETCH FIRST 200 ROWS ONLY
        WITH UR
    `;
}

export function buildViewSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string {
    const databaseLiteral = quoteLiteral(database);
    const searchPattern = buildDb2SourceRegexPattern(options.rawTerm);

    if (options.useServerSideFilter) {
        return `
            SELECT
                RTRIM(VIEWNAME) AS NAME,
                RTRIM(VIEWSCHEMA) AS SCHEMA,
                ${databaseLiteral} AS DATABASE
            FROM SYSCAT.VIEWS
            WHERE REGEXP_LIKE(TEXT, '${searchPattern}', 'i')
            WITH UR
        `;
    }

    return `
        SELECT
            RTRIM(VIEWNAME) AS NAME,
            RTRIM(VIEWSCHEMA) AS SCHEMA,
            ${databaseLiteral} AS DATABASE,
            COALESCE(TEXT, '') AS SOURCE
        FROM SYSCAT.VIEWS
        WITH UR
    `;
}

export function buildProcedureSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string {
    const databaseLiteral = quoteLiteral(database);
    const searchPattern = buildDb2SourceRegexPattern(options.rawTerm);
    const routineTypeExpression = `CASE WHEN ROUTINETYPE = 'F' THEN 'FUNCTION' ELSE 'PROCEDURE' END AS TYPE`;

    if (options.useServerSideFilter) {
        return `
            SELECT
                RTRIM(ROUTINENAME) AS NAME,
                RTRIM(ROUTINESCHEMA) AS SCHEMA,
                ${databaseLiteral} AS DATABASE,
                ${routineTypeExpression}
            FROM SYSCAT.ROUTINES
            WHERE ROUTINETYPE IN ('P', 'F')
              AND REGEXP_LIKE(TEXT, '${searchPattern}', 'i')
            WITH UR
        `;
    }

    return `
        SELECT
            RTRIM(ROUTINENAME) AS NAME,
            RTRIM(ROUTINESCHEMA) AS SCHEMA,
            ${databaseLiteral} AS DATABASE,
            ${routineTypeExpression},
            COALESCE(TEXT, '') AS SOURCE
        FROM SYSCAT.ROUTINES
        WHERE ROUTINETYPE IN ('P', 'F')
        WITH UR
    `;
}

export function buildListSchemasQuery(): string {
    return `
        SELECT RTRIM(SCHEMANAME) AS SCHEMA
        FROM SYSCAT.SCHEMATA
        ORDER BY SCHEMANAME
        WITH UR
    `;
}

export function buildListTablesQuery(schema?: string): string {
    const tableTypes = normalizeDb2TableTypes(DEFAULT_TABLE_LIST_OBJECT_TYPES, DEFAULT_TABLE_LIST_OBJECT_TYPES);
    return `
        SELECT
            RTRIM(TABNAME) AS OBJNAME,
            INT(COALESCE(TABLEID, 0)) AS OBJID,
            ${buildProjectedTableTypeExpression('TYPE')} AS OBJTYPE,
            RTRIM(TABSCHEMA) AS SCHEMA,
            COALESCE(REMARKS, '') AS DESCRIPTION
        FROM SYSCAT.TABLES
        WHERE TYPE IN (${buildInList(tableTypes)})
        ${buildEqualityFilter('TABSCHEMA', schema)}
        ORDER BY TABSCHEMA, TABNAME
        WITH UR
    `;
}

export function buildListTablespacesQuery(): string {
    return `
        SELECT RTRIM(TBSPACE) AS TBSPACE
        FROM SYSCAT.TABLESPACES
        ORDER BY TBSPACE
        WITH UR
    `;
}

export function buildListViewsQuery(schema?: string): string {
    return `
        SELECT
            RTRIM(TABNAME) AS OBJNAME,
            INT(COALESCE(TABLEID, 0)) AS OBJID,
            'VIEW' AS OBJTYPE,
            RTRIM(TABSCHEMA) AS SCHEMA,
            COALESCE(REMARKS, '') AS DESCRIPTION
        FROM SYSCAT.TABLES
        WHERE TYPE = 'V'
        ${buildEqualityFilter('TABSCHEMA', schema)}
        ORDER BY TABNAME
        WITH UR
    `;
}

export function buildListProceduresQuery(schema?: string): string {
    return `
        ${buildRoutineSignaturesCte('P')}
        SELECT
            RTRIM(R.ROUTINESCHEMA) AS SCHEMA,
            RTRIM(R.ROUTINENAME) AS PROCEDURE,
            ${buildRoutineSignatureExpression('R', 'S.PARAM_SIGNATURE')} AS PROCEDURESIGNATURE,
            RTRIM(COALESCE(R.DEFINER, R.OWNER, '')) AS OWNER,
            CURRENT SERVER AS DATABASE
        FROM SYSCAT.ROUTINES R
        LEFT JOIN ROUTINE_SIGNATURES S
            ON S.ROUTINESCHEMA = RTRIM(R.ROUTINESCHEMA)
           AND S.ROUTINENAME = RTRIM(R.ROUTINENAME)
           AND S.SPECIFICNAME = RTRIM(R.SPECIFICNAME)
        WHERE R.ROUTINETYPE = 'P'
        ${buildEqualityFilter('R.ROUTINESCHEMA', schema)}
        ORDER BY R.ROUTINENAME, R.SPECIFICNAME
        WITH UR
    `;
}

export function buildObjectTypeQuery(objectType: string, database?: string): string {
    const normalizedType = objectType.trim().toUpperCase();
    const databaseSelection = buildDatabaseSelectionExpression(database);
    if (normalizedType === 'PROCEDURE' || normalizedType === 'FUNCTION') {
        const routineSignatureCte = normalizedType === 'PROCEDURE'
            ? buildRoutineSignaturesCte('P')
            : '';
        const routineTypeFilter = normalizedType === 'FUNCTION' ? "AND ROUTINETYPE = 'F'" : "AND ROUTINETYPE = 'P'";
        return `
            ${routineSignatureCte}
            SELECT
                ${normalizedType === 'PROCEDURE'
            ? buildRoutineSignatureExpression('R', 'S.PARAM_SIGNATURE')
            : 'RTRIM(R.ROUTINENAME)'} AS OBJNAME,
                0 AS OBJID,
                RTRIM(R.ROUTINESCHEMA) AS SCHEMA,
                VARCHAR(COALESCE(R.TEXT, ''), 2048) AS DESCRIPTION,
                RTRIM(COALESCE(R.DEFINER, R.OWNER, '')) AS OWNER,
                ${databaseSelection}
            FROM SYSCAT.ROUTINES R
            ${normalizedType === 'PROCEDURE'
            ? `LEFT JOIN ROUTINE_SIGNATURES S
                ON S.ROUTINESCHEMA = RTRIM(R.ROUTINESCHEMA)
               AND S.ROUTINENAME = RTRIM(R.ROUTINENAME)
               AND S.SPECIFICNAME = RTRIM(R.SPECIFICNAME)`
            : ''}
            WHERE 1 = 1
            ${routineTypeFilter}
            ORDER BY R.ROUTINESCHEMA, R.ROUTINENAME, R.SPECIFICNAME
            WITH UR
        `;
    }

    if (normalizedType === 'SERVER') {
        return `
            SELECT
                RTRIM(SERVERNAME) AS OBJNAME,
                0 AS OBJID,
                NULL AS SCHEMA,
                COALESCE(REMARKS, '') AS DESCRIPTION,
                RTRIM(COALESCE(WRAPNAME, '')) AS OWNER,
                ${databaseSelection}
            FROM SYSCAT.SERVERS
            ORDER BY SERVERNAME
            WITH UR
        `;
    }

    if (normalizedType === 'WRAPPER') {
        return `
            SELECT
                RTRIM(WRAPNAME) AS OBJNAME,
                0 AS OBJID,
                NULL AS SCHEMA,
                COALESCE(REMARKS, '') AS DESCRIPTION,
                RTRIM(COALESCE(WRAPTYPE, '')) AS OWNER,
                ${databaseSelection}
            FROM SYSCAT.WRAPPERS
            ORDER BY WRAPNAME
            WITH UR
        `;
    }

    if (normalizedType === 'SERVER OPTION') {
        return `
            SELECT
                RTRIM(S.SERVERNAME) || ' / ' || RTRIM(S."OPTION") AS OBJNAME,
                0 AS OBJID,
                NULL AS SCHEMA,
                COALESCE(NULLIF(RTRIM(S.SETTING), ''), COALESCE(S.REMARKS, '')) AS DESCRIPTION,
                RTRIM(COALESCE(S.WRAPNAME, '')) AS OWNER,
                ${databaseSelection}
            FROM SYSCAT.SERVEROPTIONS S
            ORDER BY S.SERVERNAME, S."OPTION"
            WITH UR
        `;
    }

    if (normalizedType === 'WRAPPER OPTION') {
        return `
            SELECT
                RTRIM(W.WRAPNAME) || ' / ' || RTRIM(W."OPTION") AS OBJNAME,
                0 AS OBJID,
                NULL AS SCHEMA,
                COALESCE(NULLIF(RTRIM(W.SETTING), ''), '') AS DESCRIPTION,
                RTRIM(W.WRAPNAME) AS OWNER,
                ${databaseSelection}
            FROM SYSCAT.WRAPOPTIONS W
            ORDER BY W.WRAPNAME, W."OPTION"
            WITH UR
        `;
    }

    if (normalizedType === 'USER MAPPING') {
        return `
            SELECT
                RTRIM(SERVERNAME) || ' / ' || RTRIM(AUTHID) AS OBJNAME,
                0 AS OBJID,
                NULL AS SCHEMA,
                COALESCE(MIN(NULLIF(RTRIM(SETTING), '')), '') AS DESCRIPTION,
                RTRIM(COALESCE(AUTHIDTYPE, '')) AS OWNER,
                ${databaseSelection}
            FROM SYSCAT.USEROPTIONS
            GROUP BY SERVERNAME, AUTHID, AUTHIDTYPE
            ORDER BY SERVERNAME, AUTHID
            WITH UR
        `;
    }

    if (normalizedType === 'PASSTHRU AUTH') {
        return `
            SELECT
                RTRIM(SERVERNAME) || ' / ' || RTRIM(GRANTEE) || ' / ' || RTRIM(GRANTOR) AS OBJNAME,
                0 AS OBJID,
                NULL AS SCHEMA,
                RTRIM(COALESCE(GRANTEETYPE, '')) ||
                    CASE
                        WHEN COALESCE(GRANTORTYPE, '') <> '' THEN ' -> ' || RTRIM(GRANTORTYPE)
                        ELSE ''
                    END AS DESCRIPTION,
                RTRIM(COALESCE(GRANTEE, '')) AS OWNER,
                ${databaseSelection}
            FROM SYSCAT.PASSTHRUAUTH
            ORDER BY SERVERNAME, GRANTEE, GRANTOR
            WITH UR
        `;
    }

    if (normalizedType === 'SEQUENCE') {
        return `
            SELECT
                RTRIM(SEQNAME) AS OBJNAME,
                0 AS OBJID,
                RTRIM(SEQSCHEMA) AS SCHEMA,
                COALESCE(REMARKS, '') AS DESCRIPTION,
                RTRIM(COALESCE(DEFINER, '')) AS OWNER,
                ${databaseSelection}
            FROM SYSCAT.SEQUENCES
            ORDER BY SEQSCHEMA, SEQNAME
            WITH UR
        `;
    }

    if (normalizedType === 'INDEX') {
        return `
            SELECT
                RTRIM(INDNAME) AS OBJNAME,
                0 AS OBJID,
                RTRIM(INDSCHEMA) AS SCHEMA,
                COALESCE('ON ' || RTRIM(TABSCHEMA) || '.' || RTRIM(TABNAME), '') AS DESCRIPTION,
                RTRIM(COALESCE(DEFINER, '')) AS OWNER,
                ${databaseSelection}
            FROM SYSCAT.INDEXES
            WHERE TRIM(INDSCHEMA) NOT LIKE 'SYS%'
            ORDER BY INDSCHEMA, INDNAME
            WITH UR
        `;
    }

    if (normalizedType === 'TRIGGER') {
        return `
            SELECT
                RTRIM(TRIGNAME) AS OBJNAME,
                0 AS OBJID,
                RTRIM(TRIGSCHEMA) AS SCHEMA,
                COALESCE('ON ' || RTRIM(TABSCHEMA) || '.' || RTRIM(TABNAME), '') AS DESCRIPTION,
                RTRIM(COALESCE(DEFINER, '')) AS OWNER,
                ${databaseSelection}
            FROM SYSCAT.TRIGGERS
            ORDER BY TRIGSCHEMA, TRIGNAME
            WITH UR
        `;
    }

    if (normalizedType === 'TABLESPACE') {
        return `
            SELECT
                RTRIM(TBSPACE) AS OBJNAME,
                INT(COALESCE(TBSPACEID, 0)) AS OBJID,
                NULL AS SCHEMA,
                COALESCE(REMARKS, '') AS DESCRIPTION,
                RTRIM(COALESCE(DEFINER, '')) AS OWNER,
                ${databaseSelection}
            FROM SYSCAT.TABLESPACES
            ORDER BY TBSPACE
            WITH UR
        `;
    }

    const tableTypes = normalizeDb2TableTypes([normalizedType], DEFAULT_TABLE_LIKE_OBJECT_TYPES);
    return `
        SELECT
            RTRIM(TABNAME) AS OBJNAME,
            INT(COALESCE(TABLEID, 0)) AS OBJID,
            RTRIM(TABSCHEMA) AS SCHEMA,
            COALESCE(REMARKS, '') AS DESCRIPTION,
            RTRIM(OWNER) AS OWNER,
            ${databaseSelection}
        FROM SYSCAT.TABLES
        WHERE TYPE IN (${buildInList(tableTypes)})
        ORDER BY TABSCHEMA, TABNAME
        WITH UR
    `;
}

export function buildTypeGroupsQuery(database?: string): string {
    // Shared metadata contracts pass the database name, but Db2 type groups are catalog-static.
    void database;
    return `
        SELECT 'TABLE' AS OBJTYPE FROM SYSIBM.SYSDUMMY1
        UNION ALL
        SELECT 'VIEW' AS OBJTYPE FROM SYSIBM.SYSDUMMY1
        UNION ALL
        SELECT 'NICKNAME' AS OBJTYPE FROM SYSIBM.SYSDUMMY1
        UNION ALL
        SELECT 'ALIAS' AS OBJTYPE FROM SYSIBM.SYSDUMMY1
        UNION ALL
        SELECT 'PROCEDURE' AS OBJTYPE FROM SYSIBM.SYSDUMMY1
        UNION ALL
        SELECT 'FUNCTION' AS OBJTYPE FROM SYSIBM.SYSDUMMY1
        UNION ALL
        SELECT 'SERVER' AS OBJTYPE FROM SYSIBM.SYSDUMMY1
        UNION ALL
        SELECT 'SERVER OPTION' AS OBJTYPE FROM SYSIBM.SYSDUMMY1
        UNION ALL
        SELECT 'WRAPPER' AS OBJTYPE FROM SYSIBM.SYSDUMMY1
        UNION ALL
        SELECT 'WRAPPER OPTION' AS OBJTYPE FROM SYSIBM.SYSDUMMY1
        UNION ALL
        SELECT 'USER MAPPING' AS OBJTYPE FROM SYSIBM.SYSDUMMY1
        UNION ALL
        SELECT 'PASSTHRU AUTH' AS OBJTYPE FROM SYSIBM.SYSDUMMY1
        UNION ALL
        SELECT 'MATERIALIZED QUERY TABLE' AS OBJTYPE FROM SYSIBM.SYSDUMMY1
        UNION ALL
        SELECT 'SEQUENCE' AS OBJTYPE FROM SYSIBM.SYSDUMMY1
        UNION ALL
        SELECT 'INDEX' AS OBJTYPE FROM SYSIBM.SYSDUMMY1
        UNION ALL
        SELECT 'TRIGGER' AS OBJTYPE FROM SYSIBM.SYSDUMMY1
        UNION ALL
        SELECT 'TABLESPACE' AS OBJTYPE FROM SYSIBM.SYSDUMMY1
        WITH UR
    `;
}

export function buildColumnsWithKeysQuery(
    database?: string,
    schema?: string,
    tableName?: string,
    objectTypes?: readonly string[]
): string {
    const tableTypes = normalizeDb2TableTypes(objectTypes);

    return `
        SELECT
            ${buildDatabaseSelectionExpression(database)},
            RTRIM(C.TABSCHEMA) AS SCHEMA,
            RTRIM(C.TABNAME) AS TABLENAME,
            RTRIM(C.COLNAME) AS ATTNAME,
            ${buildDb2TypeExpression('C')} AS FORMAT_TYPE,
            COALESCE(C.REMARKS, '') AS DESCRIPTION,
            CASE WHEN PK.COLNAME IS NULL THEN 0 ELSE 1 END AS IS_PK,
            CASE WHEN FK.COLNAME IS NULL THEN 0 ELSE 1 END AS IS_FK,
            INT(C.COLNO + 1) AS ATTNUM
        FROM SYSCAT.COLUMNS C
        INNER JOIN SYSCAT.TABLES T
            ON T.TABSCHEMA = C.TABSCHEMA
           AND T.TABNAME = C.TABNAME
        LEFT JOIN (
            SELECT K.TABSCHEMA, K.TABNAME, K.COLNAME
            FROM SYSCAT.KEYCOLUSE K
            INNER JOIN SYSCAT.TABCONST TC
                ON TC.TABSCHEMA = K.TABSCHEMA
               AND TC.TABNAME = K.TABNAME
               AND TC.CONSTNAME = K.CONSTNAME
            WHERE TC.TYPE = 'P'
        ) PK
            ON PK.TABSCHEMA = C.TABSCHEMA
           AND PK.TABNAME = C.TABNAME
           AND PK.COLNAME = C.COLNAME
        LEFT JOIN (
            SELECT K.TABSCHEMA, K.TABNAME, K.COLNAME
            FROM SYSCAT.KEYCOLUSE K
            INNER JOIN SYSCAT.TABCONST TC
                ON TC.TABSCHEMA = K.TABSCHEMA
               AND TC.TABNAME = K.TABNAME
               AND TC.CONSTNAME = K.CONSTNAME
            WHERE TC.TYPE = 'F'
        ) FK
            ON FK.TABSCHEMA = C.TABSCHEMA
           AND FK.TABNAME = C.TABNAME
           AND FK.COLNAME = C.COLNAME
        WHERE T.TYPE IN (${buildInList(tableTypes)})
        ${buildEqualityFilter('C.TABSCHEMA', schema)}
        ${buildEqualityFilter('C.TABNAME', tableName)}
        ORDER BY C.TABSCHEMA, C.TABNAME, C.COLNO
        WITH UR
    `;
}

export function buildForeignKeyRelationshipsQuery(
    database?: string,
    schema?: string,
    tableName?: string,
): string {
    const databaseExpression = database?.trim() ? quoteLiteral(database) : 'CURRENT SERVER';
    return `
        SELECT
            ${databaseExpression} AS FROM_DATABASE,
            RTRIM(FK.TABSCHEMA) AS FROM_SCHEMA,
            RTRIM(FK.TABNAME) AS FROM_TABLE,
            RTRIM(FK.COLNAME) AS FROM_COLUMN,
            ${databaseExpression} AS TO_DATABASE,
            RTRIM(PK.TABSCHEMA) AS TO_SCHEMA,
            RTRIM(PK.TABNAME) AS TO_TABLE,
            RTRIM(PK.COLNAME) AS TO_COLUMN,
            RTRIM(R.CONSTNAME) AS CONSTRAINT_NAME,
            FK.COLSEQ AS ORDINAL_POSITION
        FROM SYSCAT.REFERENCES R
        INNER JOIN SYSCAT.KEYCOLUSE FK
            ON FK.TABSCHEMA = R.TABSCHEMA
           AND FK.TABNAME = R.TABNAME
           AND FK.CONSTNAME = R.CONSTNAME
        INNER JOIN SYSCAT.KEYCOLUSE PK
            ON PK.TABSCHEMA = R.REFTABSCHEMA
           AND PK.TABNAME = R.REFTABNAME
           AND PK.CONSTNAME = R.REFKEYNAME
           AND PK.COLSEQ = FK.COLSEQ
        WHERE 1 = 1
        ${buildEqualityFilter('FK.TABSCHEMA', schema)}
        ${buildEqualityFilter('FK.TABNAME', tableName)}
        ORDER BY FK.TABSCHEMA, FK.TABNAME, R.CONSTNAME, FK.COLSEQ
        WITH UR
    `;
}

export function buildTableColumnsQuery(schema: string, tableName: string): string {
    return `
        SELECT
            RTRIM(C.COLNAME) AS ATTNAME,
            ${buildDb2TypeExpression('C')} AS FORMAT_TYPE,
            ${buildDb2TypeExpression('C')} AS FULL_TYPE,
            CASE WHEN C.NULLS = 'N' THEN 1 ELSE 0 END AS ATTNOTNULL,
            COALESCE(C.DEFAULT, '') AS COLDEFAULT,
            COALESCE(C.REMARKS, '') AS DESCRIPTION,
            INT(C.COLNO + 1) AS ATTNUM
        FROM SYSCAT.COLUMNS C
        WHERE C.TABSCHEMA = ${quoteLiteral(schema)}
          AND C.TABNAME = ${quoteLiteral(tableName)}
        ORDER BY C.COLNO
        WITH UR
    `;
}

export function buildColumnMetadataQuery(schema: string, tableName: string): string {
    return `
        SELECT
            RTRIM(C.COLNAME) AS ATTNAME,
            ${buildDb2TypeExpression('C')} AS FORMAT_TYPE,
            CASE WHEN C.NULLS = 'N' THEN 1 ELSE 0 END AS IS_NOT_NULL,
            COALESCE(C.DEFAULT, '') AS COLDEFAULT,
            COALESCE(C.REMARKS, '') AS DESCRIPTION,
            CASE WHEN PK.COLNAME IS NULL THEN 0 ELSE 1 END AS IS_PK,
            CASE WHEN FK.COLNAME IS NULL THEN 0 ELSE 1 END AS IS_FK,
            INT(C.COLNO + 1) AS ATTNUM
        FROM SYSCAT.COLUMNS C
        LEFT JOIN (
            SELECT K.TABSCHEMA, K.TABNAME, K.COLNAME
            FROM SYSCAT.KEYCOLUSE K
            INNER JOIN SYSCAT.TABCONST TC
                ON TC.TABSCHEMA = K.TABSCHEMA
               AND TC.TABNAME = K.TABNAME
               AND TC.CONSTNAME = K.CONSTNAME
            WHERE TC.TYPE = 'P'
        ) PK
            ON PK.TABSCHEMA = C.TABSCHEMA
           AND PK.TABNAME = C.TABNAME
           AND PK.COLNAME = C.COLNAME
        LEFT JOIN (
            SELECT K.TABSCHEMA, K.TABNAME, K.COLNAME
            FROM SYSCAT.KEYCOLUSE K
            INNER JOIN SYSCAT.TABCONST TC
                ON TC.TABSCHEMA = K.TABSCHEMA
               AND TC.TABNAME = K.TABNAME
               AND TC.CONSTNAME = K.CONSTNAME
            WHERE TC.TYPE = 'F'
        ) FK
            ON FK.TABSCHEMA = C.TABSCHEMA
           AND FK.TABNAME = C.TABNAME
           AND FK.COLNAME = C.COLNAME
        WHERE C.TABSCHEMA = ${quoteLiteral(schema)}
          AND C.TABNAME = ${quoteLiteral(tableName)}
        ORDER BY C.COLNO
        WITH UR
    `;
}

export function buildAliasDefinitionQuery(schema: string, aliasName: string): string {
    return `
        SELECT
            RTRIM(TABSCHEMA) AS SCHEMA,
            RTRIM(TABNAME) AS ALIAS_NAME,
            RTRIM(COALESCE(BASE_TABSCHEMA, '')) AS TARGET_SCHEMA,
            RTRIM(COALESCE(BASE_TABNAME, '')) AS TARGET_NAME
        FROM SYSCAT.TABLES
        WHERE TYPE = 'A'
          AND TABSCHEMA = ${quoteLiteral(schema)}
          AND TABNAME = ${quoteLiteral(aliasName)}
        FETCH FIRST 1 ROW ONLY
        WITH UR
    `;
}

export function buildNicknameDefinitionQuery(schema: string, nicknameName: string): string {
    return `
        SELECT
            RTRIM(TABSCHEMA) AS SCHEMA,
            RTRIM(TABNAME) AS NICKNAME_NAME,
            RTRIM(COALESCE(SERVERNAME, '')) AS SERVERNAME,
            RTRIM(COALESCE(REMOTE_SCHEMA, '')) AS REMOTE_SCHEMA,
            RTRIM(COALESCE(REMOTE_TABLE, '')) AS REMOTE_TABLE,
            COALESCE(REMARKS, '') AS DESCRIPTION
        FROM SYSCAT.NICKNAMES
        WHERE TABSCHEMA = ${quoteLiteral(schema)}
          AND TABNAME = ${quoteLiteral(nicknameName)}
        FETCH FIRST 1 ROW ONLY
        WITH UR
    `;
}

export interface NicknameServerContextRow {
    WRAPTYPE?: string | null;
    REMOTE_AUTHID?: string | null;
    HAS_NETEZZA_OPTION?: number | string | boolean | null;
}

export function buildNicknameServerContextQuery(serverName: string): string {
    return `
        SELECT
            RTRIM(COALESCE(W.WRAPTYPE, '')) AS WRAPTYPE,
            RTRIM(COALESCE((
                SELECT UO.SETTING
                FROM SYSCAT.USEROPTIONS UO
                WHERE UO.SERVERNAME = S.SERVERNAME
                  AND UO."OPTION" = 'REMOTE_AUTHID'
                FETCH FIRST 1 ROW ONLY
            ), '')) AS REMOTE_AUTHID,
            CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM SYSCAT.SERVEROPTIONS SO
                    WHERE SO.SERVERNAME = S.SERVERNAME
                      AND SO."OPTION" IN ('DRIVER_CLASS', 'URL')
                      AND UPPER(RTRIM(COALESCE(SO.SETTING, ''))) LIKE '%NETEZZA%'
                ) THEN 1
                ELSE 0
            END AS HAS_NETEZZA_OPTION
        FROM SYSCAT.SERVERS S
        LEFT JOIN SYSCAT.WRAPPERS W
            ON W.WRAPNAME = S.WRAPNAME
        WHERE S.SERVERNAME = ${quoteLiteral(serverName)}
        FETCH FIRST 1 ROW ONLY
        WITH UR
    `;
}

const NETEZZA_DEFAULT_REMOTE_SCHEMA = 'ADMIN';

export function isNetezzaFederatedServer(context: NicknameServerContextRow | undefined): boolean {
    if (!context) {
        return false;
    }

    const wrapType = context.WRAPTYPE?.trim().toUpperCase() ?? '';
    if (wrapType === 'NETEZZA' || wrapType.includes('NETEZZA')) {
        return true;
    }

    const hasNetezzaOption = context.HAS_NETEZZA_OPTION;
    return hasNetezzaOption === 1
        || hasNetezzaOption === true
        || String(hasNetezzaOption).trim() === '1';
}

export function resolveNicknameRemoteSchema(
    remoteSchema: string | undefined,
    serverContext: NicknameServerContextRow | undefined
): string | undefined {
    const trimmedRemoteSchema = remoteSchema?.trim();
    if (trimmedRemoteSchema) {
        return trimmedRemoteSchema;
    }

    if (!isNetezzaFederatedServer(serverContext)) {
        return undefined;
    }

    const remoteAuthId = serverContext?.REMOTE_AUTHID?.trim();
    return remoteAuthId || NETEZZA_DEFAULT_REMOTE_SCHEMA;
}

export function buildTableCommentQuery(schema: string, tableName: string): string {
    return `
        SELECT COALESCE(REMARKS, '') AS DESCRIPTION
        FROM SYSCAT.TABLES
        WHERE TABSCHEMA = ${quoteLiteral(schema)}
          AND TABNAME = ${quoteLiteral(tableName)}
        FETCH FIRST 1 ROW ONLY
        WITH UR
    `;
}

export function buildTableOwnerQuery(schema: string, tableName: string): string {
    return `
        SELECT RTRIM(OWNER) AS OWNER
        FROM SYSCAT.TABLES
        WHERE TABSCHEMA = ${quoteLiteral(schema)}
          AND TABNAME = ${quoteLiteral(tableName)}
        FETCH FIRST 1 ROW ONLY
        WITH UR
    `;
}

export function buildFindTableSchemaQuery(tableName: string): string {
    return `
        SELECT RTRIM(TABSCHEMA) AS SCHEMA
        FROM SYSCAT.TABLES
        WHERE TABNAME = ${quoteLiteral(tableName)}
          AND TYPE IN ('T', 'N', 'A')
        ORDER BY TABSCHEMA
        WITH UR
    `;
}

export function buildTableStatsQuery(schema: string, tableName: string): string {
    return `
        SELECT
            RTRIM(TABNAME) AS TABNAME,
            CARD,
            NPAGES,
            FPAGES,
            OVERFLOW,
            LASTUSED,
            STATS_TIME
        FROM SYSCAT.TABLES
        WHERE TABSCHEMA = ${quoteLiteral(schema)}
          AND TABNAME = ${quoteLiteral(tableName)}
        WITH UR
    `;
}

export function buildKeysInfoQuery(schema: string, tableName: string): string {
    return `
        SELECT
            RTRIM(TC.CONSTNAME) AS CONSTNAME,
            LOWER(RTRIM(TC.TYPE)) AS TYPECHAR,
            CASE
                WHEN TC.TYPE = 'P' THEN 'PRIMARY KEY'
                WHEN TC.TYPE = 'U' THEN 'UNIQUE'
                WHEN TC.TYPE = 'F' THEN 'FOREIGN KEY'
                ELSE RTRIM(TC.TYPE)
            END AS TYPE,
            RTRIM(K.COLNAME) AS COLNAME,
            INT(K.COLSEQ) AS COLSEQ,
            RTRIM(COALESCE(R.REFTABSCHEMA, '')) AS PKSCHEMA,
            RTRIM(COALESCE(R.REFTABNAME, '')) AS PKRELATION,
            RTRIM(COALESCE(PK.COLNAME, '')) AS PKCOLNAME,
            RTRIM(COALESCE(R.DELETERULE, '')) AS DELETERULE,
            RTRIM(COALESCE(R.UPDATERULE, '')) AS UPDATERULE,
            RTRIM(COALESCE(TC.ENFORCED, '')) AS ENFORCED,
            RTRIM(COALESCE(TC.TRUSTED, '')) AS TRUSTED,
            RTRIM(COALESCE(TC.REMARKS, '')) AS REMARKS
        FROM SYSCAT.TABCONST TC
        INNER JOIN SYSCAT.KEYCOLUSE K
            ON K.TABSCHEMA = TC.TABSCHEMA
           AND K.TABNAME = TC.TABNAME
           AND K.CONSTNAME = TC.CONSTNAME
        LEFT JOIN SYSCAT.REFERENCES R
            ON R.TABSCHEMA = TC.TABSCHEMA
           AND R.TABNAME = TC.TABNAME
           AND R.CONSTNAME = TC.CONSTNAME
        LEFT JOIN SYSCAT.KEYCOLUSE PK
            ON PK.TABSCHEMA = R.REFTABSCHEMA
           AND PK.TABNAME = R.REFTABNAME
           AND PK.CONSTNAME = R.REFKEYNAME
           AND PK.COLSEQ = K.COLSEQ
        WHERE TC.TABSCHEMA = ${quoteLiteral(schema)}
          AND TC.TABNAME = ${quoteLiteral(tableName)}
          AND TC.TYPE IN ('P', 'U', 'F')
        ORDER BY TC.CONSTNAME, K.COLSEQ
        WITH UR
    `;
}

export function buildTableCheckConstraintsQuery(schema: string, tableName: string): string {
    return `
        SELECT
            RTRIM(C.CONSTNAME) AS CONSTNAME,
            VARCHAR(COALESCE(C.TEXT, ''), 2048) AS TEXT,
            RTRIM(COALESCE(TC.ENFORCED, '')) AS ENFORCED,
            RTRIM(COALESCE(TC.TRUSTED, '')) AS TRUSTED,
            RTRIM(COALESCE(TC.REMARKS, '')) AS REMARKS
        FROM SYSCAT.CHECKS C
        INNER JOIN SYSCAT.TABCONST TC
            ON TC.TABSCHEMA = C.TABSCHEMA
           AND TC.TABNAME = C.TABNAME
           AND TC.CONSTNAME = C.CONSTNAME
        WHERE C.TABSCHEMA = ${quoteLiteral(schema)}
          AND C.TABNAME = ${quoteLiteral(tableName)}
          AND TC.TYPE = 'K'
          AND C.TYPE = 'C'
        ORDER BY C.CONSTNAME
        WITH UR
    `;
}

export function buildTableStorageQuery(schema: string, tableName: string): string {
    return `
        SELECT
            RTRIM(COALESCE(PARTITION_MODE, '')) AS PARTITION_MODE,
            RTRIM(COALESCE(PROPERTY, '')) AS PROPERTY,
            RTRIM(COALESCE(COMPRESSION, '')) AS COMPRESSION,
            RTRIM(COALESCE(ROWCOMPMODE, '')) AS ROWCOMPMODE,
            RTRIM(COALESCE(TABLEORG, '')) AS TABLEORG,
            RTRIM(COALESCE(TBSPACE, '')) AS TBSPACE
        FROM SYSCAT.TABLES
        WHERE TABSCHEMA = ${quoteLiteral(schema)}
          AND TABNAME = ${quoteLiteral(tableName)}
        FETCH FIRST 1 ROW ONLY
        WITH UR
    `;
}

export function buildTableIndexesQuery(schema: string, tableName: string): string {
    return `
        SELECT
            RTRIM(I.INDSCHEMA) AS INDEX_SCHEMA,
            RTRIM(I.INDNAME) AS INDEX_NAME,
            RTRIM(COALESCE(IC.COLNAME, '')) AS COLNAME,
            INT(IC.COLSEQ) AS COLSEQ,
            RTRIM(COALESCE(IC.COLORDER, 'A')) AS COLORDER,
            RTRIM(COALESCE(I.UNIQUERULE, '')) AS UNIQUERULE,
            RTRIM(COALESCE(I.INDEXTYPE5, '')) AS INDEXTYPE,
            RTRIM(COALESCE(I.COMPRESSION, '')) AS COMPRESSION
        FROM SYSCAT.INDEXES I
        INNER JOIN SYSCAT.INDEXCOLUSE IC
            ON IC.INDSCHEMA = I.INDSCHEMA
           AND IC.INDNAME = I.INDNAME
        WHERE I.TABSCHEMA = ${quoteLiteral(schema)}
          AND I.TABNAME = ${quoteLiteral(tableName)}
          AND COALESCE(I.SYSTEM_REQUIRED, 0) = 0
          AND I.INDEXTYPE5 IN ('REG', 'CLUS')
        ORDER BY I.INDNAME, IC.COLSEQ
        WITH UR
    `;
}

export function buildTablePartitionExpressionsQuery(schema: string, tableName: string): string {
    return `
        SELECT
            INT(DATAPARTITIONKEYSEQ) AS PARTKEYSEQ,
            VARCHAR(DATAPARTITIONEXPRESSION, 2048) AS PARTITION_EXPRESSION,
            RTRIM(COALESCE(NULLSFIRST, '')) AS NULLSFIRST
        FROM SYSCAT.DATAPARTITIONEXPRESSION
        WHERE TABSCHEMA = ${quoteLiteral(schema)}
          AND TABNAME = ${quoteLiteral(tableName)}
        ORDER BY DATAPARTITIONKEYSEQ
        WITH UR
    `;
}

export function buildTablePartitionsQuery(schema: string, tableName: string): string {
    return `
        SELECT
            RTRIM(DATAPARTITIONNAME) AS PARTITION_NAME,
            INT(SEQNO) AS PARTITION_SEQNO,
            RTRIM(COALESCE(LOWVALUE, '')) AS LOWVALUE,
            RTRIM(COALESCE(HIGHVALUE, '')) AS HIGHVALUE,
            RTRIM(COALESCE(LOWINCLUSIVE, '')) AS LOWINCLUSIVE,
            RTRIM(COALESCE(HIGHINCLUSIVE, '')) AS HIGHINCLUSIVE,
            RTRIM(COALESCE(T.TBSPACE, '')) AS TBSPACE
        FROM SYSCAT.DATAPARTITIONS P
        LEFT JOIN SYSCAT.TABLESPACES T
            ON T.TBSPACEID = P.TBSPACEID
        WHERE P.TABSCHEMA = ${quoteLiteral(schema)}
          AND P.TABNAME = ${quoteLiteral(tableName)}
        ORDER BY P.SEQNO
        WITH UR
    `;
}

export function buildTableHashDistributionQuery(schema: string, tableName: string): string {
    return `
        SELECT
            RTRIM(COLNAME) AS COLNAME,
            INT(PARTKEYSEQ) AS PARTKEYSEQ
        FROM SYSCAT.COLUMNS
        WHERE TABSCHEMA = ${quoteLiteral(schema)}
          AND TABNAME = ${quoteLiteral(tableName)}
          AND COALESCE(PARTKEYSEQ, 0) > 0
        ORDER BY PARTKEYSEQ
        WITH UR
    `;
}

export function buildTableTriggersQuery(schema: string, tableName: string): string {
    return `
        SELECT
            RTRIM(TRIGSCHEMA) AS TRIGGER_SCHEMA,
            RTRIM(TRIGNAME) AS TRIGGER_NAME,
            COALESCE(TEXT, '') AS DEFINITION
        FROM SYSCAT.TRIGGERS
        WHERE TABSCHEMA = ${quoteLiteral(schema)}
          AND TABNAME = ${quoteLiteral(tableName)}
        ORDER BY TRIGSCHEMA, TRIGNAME
        WITH UR
    `;
}

export function buildProcedureDefinitionQuery(schema: string, procedureSignatureOrName: string): string {
    const normalizedProcedure = normalizeOptionalName(procedureSignatureOrName) ?? '';
    const bareProcedureName = normalizeOptionalName(procedureSignatureOrName?.split('(')[0]) ?? normalizedProcedure;

    return `
        ${buildRoutineSignaturesCte('P')}
        SELECT
            RTRIM(R.ROUTINESCHEMA) AS SCHEMA,
            RTRIM(R.ROUTINENAME) AS PROCEDURE_NAME,
            RTRIM(R.SPECIFICNAME) AS SPECIFICNAME,
            ${buildRoutineSignatureExpression('R', 'S.PARAM_SIGNATURE')} AS PROCEDURE_SIGNATURE,
            COALESCE(R.TEXT, '') AS PROCEDURE_TEXT
        FROM SYSCAT.ROUTINES R
        LEFT JOIN ROUTINE_SIGNATURES S
            ON S.ROUTINESCHEMA = RTRIM(R.ROUTINESCHEMA)
           AND S.ROUTINENAME = RTRIM(R.ROUTINENAME)
           AND S.SPECIFICNAME = RTRIM(R.SPECIFICNAME)
        WHERE R.ROUTINETYPE = 'P'
          AND RTRIM(R.ROUTINESCHEMA) = ${quoteLiteral(schema)}
          AND (
              ${buildRoutineSignatureExpression('R', 'S.PARAM_SIGNATURE')} = ${quoteLiteral(normalizedProcedure)}
              OR RTRIM(R.ROUTINENAME) = ${quoteLiteral(bareProcedureName)}
          )
        ORDER BY
            CASE
                WHEN ${buildRoutineSignatureExpression('R', 'S.PARAM_SIGNATURE')} = ${quoteLiteral(normalizedProcedure)} THEN 0
                ELSE 1
            END,
            R.SPECIFICNAME
        FETCH FIRST 1 ROW ONLY
        WITH UR
    `;
}

export function buildViewDefinitionQuery(schema: string, viewName: string): string {
    return `
        SELECT
            RTRIM(VIEWSCHEMA) AS SCHEMA,
            RTRIM(VIEWNAME) AS VIEW_NAME,
            COALESCE(TEXT, '') AS VIEW_TEXT
        FROM SYSCAT.VIEWS
        WHERE VIEWSCHEMA = ${quoteLiteral(schema)}
          AND VIEWNAME = ${quoteLiteral(viewName)}
        WITH UR
    `;
}

export function buildDdlQuery(objectType: Db2CatalogObjectType, objectName: string, schema: string): string {
    return `
        SELECT DBMS_METADATA.GET_DDL(${quoteLiteral(objectType)}, ${quoteLiteral(objectName)}, ${quoteLiteral(schema)}) AS DDL
        FROM SYSIBM.SYSDUMMY1
    `;
}

export function buildBatchObjectListQuery(schema?: string, objectTypes?: readonly string[]): string {
    const requestedTypes = new Set((objectTypes ?? [...DEFAULT_BATCH_OBJECT_TYPES]).map(type => type.trim().toUpperCase()));
    const queryParts: string[] = [];
    const needsRoutineQuery = requestedTypes.has('PROCEDURE') || requestedTypes.has('FUNCTION');

    if (
        requestedTypes.has('TABLE')
        || requestedTypes.has('VIEW')
        || requestedTypes.has('NICKNAME')
        || requestedTypes.has('ALIAS')
    ) {
        const tableTypes = normalizeDb2TableTypes(Array.from(requestedTypes), DEFAULT_TABLE_LIKE_OBJECT_TYPES);
        queryParts.push(`
            SELECT
                RTRIM(TABSCHEMA) AS OBJECT_SCHEMA,
                RTRIM(TABNAME) AS OBJECT_NAME,
                ${buildProjectedTableTypeExpression('TYPE')} AS OBJECT_TYPE
            FROM SYSCAT.TABLES
            WHERE TYPE IN (${buildInList(tableTypes)})
            ${buildEqualityFilter('TABSCHEMA', schema)}
        `);
    }

    if (requestedTypes.has('PROCEDURE') || requestedTypes.has('FUNCTION')) {
        const routineTypes: string[] = [];
        if (requestedTypes.has('PROCEDURE')) {
            routineTypes.push('P');
        }
        if (requestedTypes.has('FUNCTION')) {
            routineTypes.push('F');
        }
        queryParts.push(`
            SELECT
                RTRIM(R.ROUTINESCHEMA) AS OBJECT_SCHEMA,
                CASE
                    WHEN R.ROUTINETYPE = 'P' THEN ${buildRoutineSignatureExpression('R', 'S.PARAM_SIGNATURE')}
                    ELSE RTRIM(R.ROUTINENAME)
                END AS OBJECT_NAME,
                CASE WHEN R.ROUTINETYPE = 'F' THEN 'FUNCTION' ELSE 'PROCEDURE' END AS OBJECT_TYPE
            FROM SYSCAT.ROUTINES R
            LEFT JOIN ROUTINE_SIGNATURES S
                ON S.ROUTINESCHEMA = RTRIM(R.ROUTINESCHEMA)
               AND S.ROUTINENAME = RTRIM(R.ROUTINENAME)
               AND S.SPECIFICNAME = RTRIM(R.SPECIFICNAME)
            WHERE R.ROUTINETYPE IN (${buildInList(routineTypes)})
            ${buildEqualityFilter('R.ROUTINESCHEMA', schema)}
        `);
    }

    if (queryParts.length === 0) {
        return 'SELECT NULL AS OBJECT_SCHEMA, NULL AS OBJECT_NAME, NULL AS OBJECT_TYPE FROM SYSIBM.SYSDUMMY1 WHERE 1 = 0';
    }

    return `
        ${needsRoutineQuery ? buildRoutineSignaturesCte() : ''}
        ${queryParts.join('\nUNION ALL\n')}
        ORDER BY OBJECT_SCHEMA, OBJECT_TYPE, OBJECT_NAME
        WITH UR
    `;
}

export function mapRoutineObjectType(value: string): Db2CatalogObjectType {
    return mapRoutineTypeLabel(value);
}

export function buildListPartitionsQuery(schema: string, tableName: string): string {
    return `
        SELECT
            RTRIM(P.DATAPARTITIONNAME) AS PARTITION_NAME,
            INT(P.SEQNO) AS PARTITION_SEQNO,
            RTRIM(COALESCE(P.LOWVALUE, '')) AS LOWVALUE,
            RTRIM(COALESCE(P.HIGHVALUE, '')) AS HIGHVALUE,
            RTRIM(COALESCE(P.LOWINCLUSIVE, '')) AS LOWINCLUSIVE,
            RTRIM(COALESCE(P.HIGHINCLUSIVE, '')) AS HIGHINCLUSIVE,
            RTRIM(COALESCE(TS.TBSPACE, '')) AS TBSPACE,
            COALESCE(T.CARD, -1) AS ROW_COUNT,
            COALESCE(T.NPAGES, -1) AS NPAGES,
            COALESCE(T.FPAGES, -1) AS FPAGES,
            RTRIM(COALESCE(T.TABNAME, '')) AS PARENT_TABLE
        FROM SYSCAT.DATAPARTITIONS P
        INNER JOIN SYSCAT.TABLES T
            ON T.TABSCHEMA = P.TABSCHEMA
           AND T.TABNAME = P.TABNAME
        LEFT JOIN SYSCAT.TABLESPACES TS
            ON TS.TBSPACEID = P.TBSPACEID
        WHERE P.TABSCHEMA = ${quoteLiteral(schema)}
          AND P.TABNAME = ${quoteLiteral(tableName)}
        ORDER BY P.SEQNO
        WITH UR
    `;
}

export function buildListIndexesDetailedQuery(schema: string, tableName: string): string {
    return `
        SELECT
            RTRIM(I.INDSCHEMA) AS INDEX_SCHEMA,
            RTRIM(I.INDNAME) AS INDEX_NAME,
            RTRIM(I.TABSCHEMA) AS TABLE_SCHEMA,
            RTRIM(I.TABNAME) AS TABLE_NAME,
            RTRIM(COALESCE(I.UNIQUERULE, '')) AS UNIQUERULE,
            RTRIM(COALESCE(I.INDEXTYPE5, '')) AS INDEXTYPE,
            RTRIM(COALESCE(I.COMPRESSION, '')) AS COMPRESSION,
            COALESCE(I.NLEAF, -1) AS NLEAF,
            COALESCE(I.NLEVELS, -1) AS NLEVELS,
            COALESCE(I.FULLKEYCARD, -1) AS FULLKEYCARD,
            COALESCE(I.FIRSTKEYCARD, -1) AS FIRSTKEYCARD,
            COALESCE(I.FIRST2KEYCARD, -1) AS FIRST2KEYCARD,
            RTRIM(COALESCE(I.PCTFREE, '')) AS PCTFREE,
            RTRIM(COALESCE(I.REMARKS, '')) AS REMARKS,
            COALESCE(I.SYSTEM_REQUIRED, 0) AS SYSTEM_REQUIRED,
            RTRIM(COALESCE(TS.TBSPACE, '')) AS TBSPACE
        FROM SYSCAT.INDEXES I
        LEFT JOIN SYSCAT.TABLESPACES TS
            ON TS.TBSPACEID = I.TBSPACEID
        WHERE I.TABSCHEMA = ${quoteLiteral(schema)}
          AND I.TABNAME = ${quoteLiteral(tableName)}
        ORDER BY I.INDNAME
        WITH UR
    `;
}

export function buildIndexColumnsDetailedQuery(schema: string, indexName: string): string {
    return `
        SELECT
            RTRIM(IC.COLNAME) AS COLNAME,
            INT(IC.COLSEQ) AS COLSEQ,
            RTRIM(COALESCE(IC.COLORDER, 'A')) AS COLORDER
        FROM SYSCAT.INDEXCOLUSE IC
        WHERE IC.INDSCHEMA = ${quoteLiteral(schema)}
          AND IC.INDNAME = ${quoteLiteral(indexName)}
        ORDER BY IC.COLSEQ
        WITH UR
    `;
}

export function buildIsPartitionedQuery(schema: string, tableName: string): string {
    return `
        SELECT COUNT(*) AS PARTITION_COUNT
        FROM SYSCAT.DATAPARTITIONS
        WHERE TABSCHEMA = ${quoteLiteral(schema)}
          AND TABNAME = ${quoteLiteral(tableName)}
        WITH UR
    `;
}

export type Db2TableDetailKind = 'keys' | 'indexes' | 'triggers';

/** Keys/constraints, indexes or triggers of one table for the schema tree (NAME, KIND, DETAIL). */
export function buildTableDetailQuery(
    _database: string,
    schema: string,
    tableName: string,
    detail: Db2TableDetailKind,
): string {
    const owner = quoteLiteral(schema);
    const table = quoteLiteral(tableName);
    if (detail === 'keys') {
        return `
            SELECT
                RTRIM(c.CONSTNAME) AS NAME,
                CASE c.TYPE WHEN 'P' THEN 'PRIMARY KEY' WHEN 'U' THEN 'UNIQUE' WHEN 'F' THEN 'FOREIGN KEY' ELSE 'CHECK' END AS KIND,
                -- Narrow casts keep the row inside a 4K temporary page (SQL1585N otherwise).
                COALESCE((SELECT CAST(LISTAGG(CAST(RTRIM(k.COLNAME) AS VARCHAR(128)), ', ') WITHIN GROUP (ORDER BY k.COLSEQ) AS VARCHAR(1000))
                            FROM SYSCAT.KEYCOLUSE k
                           WHERE k.TABSCHEMA = c.TABSCHEMA AND k.TABNAME = c.TABNAME AND k.CONSTNAME = c.CONSTNAME), '')
                || COALESCE((SELECT CAST(' -> ' || RTRIM(r.REFTABSCHEMA) || '.' || RTRIM(r.REFTABNAME) AS VARCHAR(300))
                               FROM SYSCAT.REFERENCES r
                              WHERE r.TABSCHEMA = c.TABSCHEMA AND r.TABNAME = c.TABNAME AND r.CONSTNAME = c.CONSTNAME), '')
                || COALESCE((SELECT RTRIM(CAST(SUBSTR(ch.TEXT, 1, 200) AS VARCHAR(200)))
                               FROM SYSCAT.CHECKS ch
                              WHERE ch.TABSCHEMA = c.TABSCHEMA AND ch.TABNAME = c.TABNAME AND ch.CONSTNAME = c.CONSTNAME), '')
                || CASE WHEN c.ENFORCED = 'N' THEN ' (not enforced)' ELSE '' END AS DETAIL
            FROM SYSCAT.TABCONST c
            WHERE c.TABSCHEMA = ${owner} AND c.TABNAME = ${table}
            ORDER BY CASE c.TYPE WHEN 'P' THEN 0 WHEN 'U' THEN 1 WHEN 'F' THEN 2 ELSE 3 END, c.CONSTNAME
        `;
    }
    if (detail === 'indexes') {
        return `
            SELECT
                RTRIM(i.INDNAME) AS NAME,
                CASE i.UNIQUERULE WHEN 'P' THEN 'PRIMARY KEY' WHEN 'U' THEN 'UNIQUE' ELSE 'INDEX' END AS KIND,
                COALESCE((SELECT CAST(LISTAGG(CAST(RTRIM(u.COLNAME) || CASE u.COLORDER WHEN 'D' THEN ' DESC' WHEN 'I' THEN ' (INCLUDE)' ELSE '' END AS VARCHAR(140)), ', ')
                                 WITHIN GROUP (ORDER BY u.COLSEQ) AS VARCHAR(1000))
                            FROM SYSCAT.INDEXCOLUSE u
                           WHERE u.INDSCHEMA = i.INDSCHEMA AND u.INDNAME = i.INDNAME), '') AS DETAIL
            FROM SYSCAT.INDEXES i
            WHERE i.TABSCHEMA = ${owner} AND i.TABNAME = ${table}
            ORDER BY CASE i.UNIQUERULE WHEN 'P' THEN 0 WHEN 'U' THEN 1 ELSE 2 END, i.INDNAME
        `;
    }
    return `
        SELECT
            RTRIM(t.TRIGNAME) AS NAME,
            CASE WHEN t.VALID <> 'Y' THEN 'INVALID' ELSE 'TRIGGER' END AS KIND,
            CASE t.TRIGTIME WHEN 'B' THEN 'BEFORE' WHEN 'A' THEN 'AFTER' ELSE 'INSTEAD OF' END || ' '
            || CASE t.TRIGEVENT WHEN 'I' THEN 'INSERT' WHEN 'U' THEN 'UPDATE' WHEN 'D' THEN 'DELETE' ELSE 'MULTIPLE EVENTS' END
            || CASE t.GRANULARITY WHEN 'R' THEN ' FOR EACH ROW' ELSE ' FOR EACH STATEMENT' END AS DETAIL
        FROM SYSCAT.TRIGGERS t
        WHERE t.TABSCHEMA = ${owner} AND t.TABNAME = ${table}
        ORDER BY t.TRIGNAME
    `;
}

/**
 * Catalog-recorded dependencies for impact analysis: views/MQTs (TABDEP),
 * triggers on the objects they read (TRIGDEP) and routines through their packages (ROUTINEDEP +
 * PACKAGEDEP), limited to user schemas.
 */
export function buildObjectDependenciesQuery(_database: string): string {
    const baseType = (column: string) => `CASE ${column} WHEN 'V' THEN 'VIEW' WHEN 'Q' THEN 'SEQUENCE' ELSE 'TABLE' END`;
    const userSchema = (column: string) => `${column} NOT LIKE 'SYS%'`;
    return `
        SELECT DISTINCT RTRIM(d.TABSCHEMA) AS SOURCE_SCHEMA, RTRIM(d.TABNAME) AS SOURCE_NAME,
            CASE d.DTYPE WHEN 'S' THEN 'TABLE' ELSE 'VIEW' END AS SOURCE_TYPE,
            RTRIM(d.BSCHEMA) AS TARGET_SCHEMA, RTRIM(d.BNAME) AS TARGET_NAME, ${baseType('d.BTYPE')} AS TARGET_TYPE,
            CAST(NULL AS VARCHAR(128)) AS TARGET_COLUMN
        FROM SYSCAT.TABDEP d
        WHERE d.BTYPE IN ('T', 'V', 'S', 'Q') AND ${userSchema('d.TABSCHEMA')}

        UNION
        SELECT RTRIM(d.TRIGSCHEMA), RTRIM(d.TRIGNAME), 'PROCEDURE', RTRIM(d.BSCHEMA), RTRIM(d.BNAME), ${baseType('d.BTYPE')}, CAST(NULL AS VARCHAR(128))
        FROM SYSCAT.TRIGDEP d
        WHERE d.BTYPE IN ('T', 'V', 'S', 'Q') AND ${userSchema('d.TRIGSCHEMA')}
        UNION
        SELECT RTRIM(r.ROUTINESCHEMA), RTRIM(r.ROUTINENAME), 'PROCEDURE', RTRIM(p.BSCHEMA), RTRIM(p.BNAME), ${baseType('p.BTYPE')}, CAST(NULL AS VARCHAR(128))
        FROM SYSCAT.ROUTINEDEP rd
        INNER JOIN SYSCAT.ROUTINES r ON r.ROUTINESCHEMA = rd.ROUTINESCHEMA AND r.SPECIFICNAME = rd.SPECIFICNAME
        INNER JOIN SYSCAT.PACKAGEDEP p ON p.PKGSCHEMA = rd.BSCHEMA AND p.PKGNAME = rd.BNAME
        WHERE rd.BTYPE = 'K' AND p.BTYPE IN ('T', 'V', 'S', 'Q') AND ${userSchema('rd.ROUTINESCHEMA')}
        UNION
        SELECT RTRIM(r.ROUTINESCHEMA), RTRIM(r.ROUTINENAME), 'PROCEDURE', RTRIM(rd.BSCHEMA), RTRIM(rd.BNAME), ${baseType('rd.BTYPE')}, CAST(NULL AS VARCHAR(128))
        FROM SYSCAT.ROUTINEDEP rd
        INNER JOIN SYSCAT.ROUTINES r ON r.ROUTINESCHEMA = rd.ROUTINESCHEMA AND r.SPECIFICNAME = rd.SPECIFICNAME
        WHERE rd.BTYPE IN ('T', 'V', 'S', 'Q') AND ${userSchema('rd.ROUTINESCHEMA')}
    `;
}

export type Db2TableReportKind = 'size' | 'privileges' | 'maintenance';
export type Db2DatabaseReportKind = 'locks' | 'invalidObjects';

/** Read-only table reports shown in SQL Results (size, privileges, REORGCHK-style maintenance status). */
export function buildTableReportQuery(
    _database: string,
    schema: string,
    tableName: string,
    report: Db2TableReportKind,
): string {
    const owner = quoteLiteral(schema);
    const table = quoteLiteral(tableName);
    if (report === 'size') {
        // ADMIN_GET_TAB_INFO sizes are in KB and return one row per database partition.
        return `
            SELECT
                RTRIM(T.TABSCHEMA) AS SCHEMA_NAME,
                RTRIM(T.TABNAME) AS TABLE_NAME,
                CASE WHEN T.CARD < 0 THEN NULL ELSE T.CARD END AS ROWS_FROM_STATISTICS,
                DEC(COALESCE(A.TOTAL_KB, 0) / 1024.0, 18, 2) AS TOTAL_MB,
                DEC(COALESCE(A.DATA_KB, 0) / 1024.0, 18, 2) AS DATA_MB,
                DEC(COALESCE(A.INDEX_KB, 0) / 1024.0, 18, 2) AS INDEX_MB,
                DEC(COALESCE(A.LOB_KB, 0) / 1024.0, 18, 2) AS LOB_XML_MB,
                CASE WHEN T.NPAGES < 0 THEN NULL ELSE T.NPAGES END AS PAGES_WITH_ROWS,
                CASE WHEN T.FPAGES < 0 THEN NULL ELSE T.FPAGES END AS TOTAL_PAGES,
                RTRIM(COALESCE(T.TBSPACE, '')) AS TABLESPACE,
                T.STATS_TIME AS STATISTICS_TIME
            FROM SYSCAT.TABLES T
            LEFT JOIN (
                SELECT
                    SUM(DATA_OBJECT_P_SIZE + INDEX_OBJECT_P_SIZE + LONG_OBJECT_P_SIZE + LOB_OBJECT_P_SIZE + XML_OBJECT_P_SIZE) AS TOTAL_KB,
                    SUM(DATA_OBJECT_P_SIZE) AS DATA_KB,
                    SUM(INDEX_OBJECT_P_SIZE) AS INDEX_KB,
                    SUM(LONG_OBJECT_P_SIZE + LOB_OBJECT_P_SIZE + XML_OBJECT_P_SIZE) AS LOB_KB
                FROM TABLE(SYSPROC.ADMIN_GET_TAB_INFO(${owner}, ${table})) AS I
            ) A ON 1 = 1
            WHERE T.TABSCHEMA = ${owner} AND T.TABNAME = ${table}
            WITH UR
        `;
    }
    if (report === 'privileges') {
        return `
            SELECT
                RTRIM(GRANTEE) AS GRANTEE,
                CASE GRANTEETYPE WHEN 'U' THEN 'USER' WHEN 'G' THEN 'GROUP' WHEN 'R' THEN 'ROLE' ELSE GRANTEETYPE END AS GRANTEE_TYPE,
                RTRIM(GRANTOR) AS GRANTOR,
                CONTROLAUTH AS "CONTROL",
                SELECTAUTH AS "SELECT",
                INSERTAUTH AS "INSERT",
                UPDATEAUTH AS "UPDATE",
                DELETEAUTH AS "DELETE",
                ALTERAUTH AS "ALTER",
                INDEXAUTH AS "INDEX",
                REFAUTH AS "REFERENCES"
            FROM SYSCAT.TABAUTH
            WHERE TABSCHEMA = ${owner} AND TABNAME = ${table}
            ORDER BY GRANTEE
            WITH UR
        `;
    }
    // REORGCHK formulas: F1 overflow rows < 5%, F3 full pages > 80% (NPAGES / FPAGES).
    return `
        SELECT
            RTRIM(T.TABSCHEMA) AS SCHEMA_NAME,
            RTRIM(T.TABNAME) AS TABLE_NAME,
            CASE
                WHEN A.REORG_PENDING = 'Y' THEN 'REORG TABLE required (reorg pending)'
                WHEN T.STATS_TIME IS NULL OR T.CARD < 0 THEN 'Run RUNSTATS (no statistics)'
                WHEN T.CARD > 0 AND T.OVERFLOW * 100 > T.CARD * 5 THEN 'REORG TABLE recommended (F1: overflow rows > 5%)'
                WHEN T.FPAGES > 1 AND T.NPAGES * 100 < T.FPAGES * 80 THEN 'REORG TABLE recommended (F3: full pages < 80%)'
                WHEN T.STATS_TIME < CURRENT TIMESTAMP - 30 DAYS THEN 'Run RUNSTATS (statistics older than 30 days)'
                ELSE 'OK'
            END AS RECOMMENDATION,
            T.STATS_TIME AS STATISTICS_TIME,
            CASE WHEN T.CARD < 0 THEN NULL ELSE T.CARD END AS ROWS_FROM_STATISTICS,
            CASE WHEN T.OVERFLOW < 0 THEN NULL ELSE T.OVERFLOW END AS OVERFLOW_ROWS,
            CASE WHEN T.CARD > 0 AND T.OVERFLOW >= 0 THEN DEC(T.OVERFLOW * 100.0 / T.CARD, 7, 2) END AS OVERFLOW_PCT,
            CASE WHEN T.FPAGES > 0 AND T.NPAGES >= 0 THEN DEC(T.NPAGES * 100.0 / T.FPAGES, 7, 2) END AS FULL_PAGES_PCT,
            COALESCE(A.REORG_PENDING, 'N') AS REORG_PENDING,
            RTRIM(COALESCE(A.INPLACE_REORG_STATUS, '')) AS INPLACE_REORG_STATUS,
            A.NUM_REORG_REC_ALTERS AS REORG_RECOMMENDED_ALTERS,
            RTRIM(COALESCE(A.AVAILABLE, '')) AS AVAILABLE
        FROM SYSCAT.TABLES T
        LEFT JOIN (
            SELECT
                MAX(REORG_PENDING) AS REORG_PENDING,
                MAX(INPLACE_REORG_STATUS) AS INPLACE_REORG_STATUS,
                MAX(NUM_REORG_REC_ALTERS) AS NUM_REORG_REC_ALTERS,
                MIN(AVAILABLE) AS AVAILABLE
            FROM TABLE(SYSPROC.ADMIN_GET_TAB_INFO(${owner}, ${table})) AS I
        ) A ON 1 = 1
        WHERE T.TABSCHEMA = ${owner} AND T.TABNAME = ${table}
        WITH UR
    `;
}

/** Read-only database reports shown in SQL Results (lock waits, invalid or inoperative objects). */
export function buildDatabaseReportQuery(_database: string, report: Db2DatabaseReportKind): string {
    if (report === 'locks') {
        return `
            SELECT
                REQ_APPLICATION_HANDLE AS WAITING_APPLICATION,
                RTRIM(COALESCE(REQ_USERID, '')) AS WAITING_USER,
                RTRIM(COALESCE(REQ_APPLICATION_NAME, '')) AS WAITING_PROGRAM,
                LOCK_WAIT_ELAPSED_TIME AS WAIT_SECONDS,
                HLD_APPLICATION_HANDLE AS BLOCKING_APPLICATION,
                RTRIM(COALESCE(HLD_USERID, '')) AS BLOCKING_USER,
                RTRIM(COALESCE(HLD_APPLICATION_NAME, '')) AS BLOCKING_PROGRAM,
                RTRIM(COALESCE(TABSCHEMA, '')) || '.' || RTRIM(COALESCE(TABNAME, '')) AS LOCKED_OBJECT,
                RTRIM(COALESCE(LOCK_OBJECT_TYPE, '')) AS LOCK_OBJECT_TYPE,
                RTRIM(COALESCE(LOCK_MODE, '')) AS HELD_MODE,
                RTRIM(COALESCE(LOCK_MODE_REQUESTED, '')) AS REQUESTED_MODE,
                VARCHAR(SUBSTR(COALESCE(REQ_STMT_TEXT, ''), 1, 2000), 2000) AS WAITING_SQL,
                VARCHAR(SUBSTR(COALESCE(HLD_CURRENT_STMT_TEXT, ''), 1, 2000), 2000) AS BLOCKING_SQL
            FROM SYSIBMADM.MON_LOCKWAITS
            ORDER BY LOCK_WAIT_ELAPSED_TIME DESC
        `;
    }
    return `
        SELECT
            RTRIM(OBJECTSCHEMA) AS SCHEMA_NAME,
            RTRIM(COALESCE(OBJECTMODULENAME || '.', '') || OBJECTNAME) AS OBJECT_NAME,
            CASE OBJECTTYPE
                WHEN 'F' THEN 'ROUTINE' WHEN 'R' THEN 'TYPE' WHEN 'B' THEN 'TRIGGER' WHEN 'V' THEN 'VIEW'
                WHEN 'v' THEN 'GLOBAL VARIABLE' WHEN 'y' THEN 'ROW PERMISSION' WHEN '2' THEN 'COLUMN MASK'
                ELSE OBJECTTYPE
            END AS OBJECT_TYPE,
            'INVALID' AS STATUS,
            INVALIDATE_TIME AS SINCE,
            VARCHAR(SUBSTR(COALESCE(ERRORMESSAGE, ''), 1, 1000), 1000) AS DETAIL
        FROM SYSCAT.INVALIDOBJECTS
        UNION ALL
        SELECT
            RTRIM(TABSCHEMA), RTRIM(TABNAME),
            CASE TYPE WHEN 'V' THEN 'VIEW' WHEN 'S' THEN 'MQT' ELSE 'TABLE' END,
            CASE STATUS WHEN 'C' THEN 'SET INTEGRITY PENDING' ELSE 'INOPERATIVE' END,
            ALTER_TIME,
            CASE STATUS WHEN 'C' THEN 'Run SET INTEGRITY before using the table' ELSE 'Recreate the inoperative view' END
        FROM SYSCAT.TABLES
        WHERE STATUS IN ('C', 'X') AND TABSCHEMA NOT LIKE 'SYS%'
        ORDER BY 1, 2
        WITH UR
    `;
}
