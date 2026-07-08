import type { DatabaseSourceSearchQueryOptions } from '@justybase/contracts';

type OracleCatalogObjectType =
    | 'TABLE'
    | 'VIEW'
    | 'PROCEDURE'
    | 'FUNCTION'
    | 'PACKAGE'
    | 'PACKAGE BODY'
    | 'SEQUENCE'
    | 'SYNONYM'
    | 'TRIGGER';

type OracleColumnObjectType = 'TABLE' | 'VIEW';

export const ORACLE_DEFAULT_OBJECT_TYPES = [
    'TABLE',
    'VIEW',
    'PROCEDURE',
    'FUNCTION',
    'PACKAGE',
    'PACKAGE BODY',
    'SEQUENCE',
    'SYNONYM',
    'TRIGGER'
] as const;

export const ORACLE_DEFAULT_COLUMN_OBJECT_TYPES = ['TABLE', 'VIEW'] as const;

const ORACLE_TABLE_LIKE_OBJECT_TYPES = new Set<OracleColumnObjectType>(['TABLE', 'VIEW']);
const ORACLE_SOURCE_SEARCH_OBJECT_TYPES: readonly OracleCatalogObjectType[] = [
    'PROCEDURE',
    'FUNCTION',
    'PACKAGE',
    'PACKAGE BODY',
    'TRIGGER'
];

function quoteLiteral(value: string | undefined): string {
    return `'${(value ?? '').replace(/'/g, "''")}'`;
}

function normalizeOptionalName(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function buildEqualityFilter(columnName: string, value?: string): string {
    const normalizedValue = normalizeOptionalName(value);
    return normalizedValue ? ` AND UPPER(${columnName}) = UPPER(${quoteLiteral(normalizedValue)})` : '';
}

function buildDatabaseSelectionExpression(database?: string): string {
    const normalizedDatabase = normalizeOptionalName(database);
    if (normalizedDatabase) {
        return `${quoteLiteral(normalizedDatabase.toUpperCase())} AS "DATABASE"`;
    }

    return `${buildCurrentDatabaseExpression()} AS "DATABASE"`;
}

function buildCurrentDatabaseExpression(): string {
    return `
        UPPER(
            COALESCE(
                NULLIF(SYS_CONTEXT('USERENV', 'SERVICE_NAME'), ''),
                NULLIF(SYS_CONTEXT('USERENV', 'DB_NAME'), ''),
                NULLIF(SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'), ''),
                USER
            )
        )
    `.trim();
}

function buildOracleTypeExpression(columnAlias: string): string {
    return `
        ${columnAlias}.DATA_TYPE ||
        CASE
            WHEN ${columnAlias}.DATA_TYPE IN ('CHAR', 'NCHAR', 'VARCHAR2', 'NVARCHAR2')
                AND COALESCE(${columnAlias}.CHAR_LENGTH, 0) > 0
                THEN '(' || TO_CHAR(${columnAlias}.CHAR_LENGTH) ||
                    CASE WHEN ${columnAlias}.CHAR_USED = 'C' THEN ' CHAR' ELSE '' END || ')'
            WHEN ${columnAlias}.DATA_TYPE = 'RAW'
                AND COALESCE(${columnAlias}.DATA_LENGTH, 0) > 0
                THEN '(' || TO_CHAR(${columnAlias}.DATA_LENGTH) || ')'
            WHEN ${columnAlias}.DATA_TYPE = 'NUMBER'
                AND ${columnAlias}.DATA_PRECISION IS NOT NULL
                AND COALESCE(${columnAlias}.DATA_SCALE, 0) > 0
                THEN '(' || TO_CHAR(${columnAlias}.DATA_PRECISION) || ',' || TO_CHAR(${columnAlias}.DATA_SCALE) || ')'
            WHEN ${columnAlias}.DATA_TYPE = 'NUMBER'
                AND ${columnAlias}.DATA_PRECISION IS NOT NULL
                THEN '(' || TO_CHAR(${columnAlias}.DATA_PRECISION) || ')'
            WHEN ${columnAlias}.DATA_TYPE LIKE 'TIMESTAMP%'
                AND ${columnAlias}.DATA_SCALE IS NOT NULL
                THEN '(' || TO_CHAR(${columnAlias}.DATA_SCALE) || ')'
            ELSE ''
        END
    `.trim();
}

function buildOracleArgumentTypeExpression(argumentAlias: string): string {
    return `
        CASE
            WHEN ${argumentAlias}.DATA_TYPE IN ('CHAR', 'NCHAR', 'VARCHAR2', 'NVARCHAR2')
                AND COALESCE(${argumentAlias}.CHAR_LENGTH, 0) > 0
                THEN ${argumentAlias}.DATA_TYPE || '(' || TO_CHAR(${argumentAlias}.CHAR_LENGTH) || ')'
            WHEN ${argumentAlias}.DATA_TYPE = 'RAW'
                AND COALESCE(${argumentAlias}.DATA_LENGTH, 0) > 0
                THEN ${argumentAlias}.DATA_TYPE || '(' || TO_CHAR(${argumentAlias}.DATA_LENGTH) || ')'
            WHEN ${argumentAlias}.DATA_TYPE = 'NUMBER'
                AND ${argumentAlias}.DATA_PRECISION IS NOT NULL
                AND COALESCE(${argumentAlias}.DATA_SCALE, 0) > 0
                THEN ${argumentAlias}.DATA_TYPE || '(' || TO_CHAR(${argumentAlias}.DATA_PRECISION) || ',' || TO_CHAR(${argumentAlias}.DATA_SCALE) || ')'
            WHEN ${argumentAlias}.DATA_TYPE = 'NUMBER'
                AND ${argumentAlias}.DATA_PRECISION IS NOT NULL
                THEN ${argumentAlias}.DATA_TYPE || '(' || TO_CHAR(${argumentAlias}.DATA_PRECISION) || ')'
            WHEN ${argumentAlias}.DATA_TYPE IS NOT NULL
                THEN ${argumentAlias}.DATA_TYPE
            WHEN ${argumentAlias}.TYPE_OWNER IS NOT NULL AND ${argumentAlias}.TYPE_NAME IS NOT NULL
                THEN ${argumentAlias}.TYPE_OWNER || '.' || ${argumentAlias}.TYPE_NAME
            ELSE 'UNKNOWN'
        END
    `.trim();
}

function buildStandaloneRoutineArgumentsCte(): string {
    return `
        WITH ROUTINE_ARGUMENTS AS (
            SELECT
                A.OWNER,
                A.OBJECT_NAME,
                LISTAGG(
                    TRIM(
                        CASE
                            WHEN UPPER(COALESCE(A.IN_OUT, 'IN')) = 'OUT' THEN 'OUT '
                            WHEN UPPER(COALESCE(A.IN_OUT, 'IN')) IN ('IN/OUT', 'IN OUT') THEN 'IN OUT '
                            ELSE ''
                        END ||
                        CASE
                            WHEN A.ARGUMENT_NAME IS NOT NULL THEN A.ARGUMENT_NAME || ' '
                            ELSE ''
                        END ||
                        ${buildOracleArgumentTypeExpression('A')}
                    ),
                    ', '
                ) WITHIN GROUP (ORDER BY A.POSITION, A.SEQUENCE) AS ARGUMENT_SIGNATURE
            FROM ALL_ARGUMENTS A
            WHERE A.PACKAGE_NAME IS NULL
              AND A.DATA_LEVEL = 0
              AND A.POSITION > 0
            GROUP BY A.OWNER, A.OBJECT_NAME
        )
    `;
}

function buildRoutineSignatureExpression(routineAlias: string, argumentsAlias: string): string {
    return `
        CASE
            WHEN COALESCE(${argumentsAlias}.ARGUMENT_SIGNATURE, '') <> ''
                THEN ${routineAlias}.OBJECT_NAME || '(' || ${argumentsAlias}.ARGUMENT_SIGNATURE || ')'
            ELSE ${routineAlias}.OBJECT_NAME || '()'
        END
    `.trim();
}

function buildTableLikeObjectQuery(
    objectType: OracleColumnObjectType,
    database?: string,
    schema?: string
): string {
    const tableType = objectType === 'VIEW' ? 'VIEW' : 'TABLE';
    return `
        SELECT
            O.OBJECT_NAME AS OBJNAME,
            O.OBJECT_ID AS OBJID,
            ${quoteLiteral(objectType)} AS OBJTYPE,
            O.OWNER AS SCHEMA,
            COALESCE(C.COMMENTS, '') AS DESCRIPTION,
            O.OWNER AS OWNER,
            ${buildDatabaseSelectionExpression(database)}
        FROM ALL_OBJECTS O
        LEFT JOIN ALL_TAB_COMMENTS C
            ON C.OWNER = O.OWNER
           AND C.TABLE_NAME = O.OBJECT_NAME
           AND C.TABLE_TYPE = ${quoteLiteral(tableType)}
        WHERE O.OBJECT_TYPE = ${quoteLiteral(objectType)}
        ${buildEqualityFilter('O.OWNER', schema)}
        ORDER BY O.OWNER, O.OBJECT_NAME
    `;
}

function buildStandaloneRoutineQuery(
    routineType: 'PROCEDURE' | 'FUNCTION',
    database?: string,
    schema?: string,
    resultMode: 'procedures' | 'objects' = 'procedures'
): string {
    const signatureExpression = buildRoutineSignatureExpression('O', 'A');
    if (resultMode === 'procedures') {
        return `
            ${buildStandaloneRoutineArgumentsCte()}
            SELECT
                O.OWNER AS SCHEMA,
                O.OBJECT_NAME AS PROCEDURE,
                ${signatureExpression} AS PROCEDURESIGNATURE,
                O.OWNER AS OWNER,
                ${buildDatabaseSelectionExpression(database)}
            FROM ALL_OBJECTS O
            LEFT JOIN ROUTINE_ARGUMENTS A
                ON A.OWNER = O.OWNER
               AND A.OBJECT_NAME = O.OBJECT_NAME
            WHERE O.OBJECT_TYPE = ${quoteLiteral(routineType)}
            ${buildEqualityFilter('O.OWNER', schema)}
            ORDER BY O.OWNER, O.OBJECT_NAME
        `;
    }

    return `
        ${buildStandaloneRoutineArgumentsCte()}
        SELECT
            ${signatureExpression} AS OBJNAME,
            O.OBJECT_ID AS OBJID,
            O.OWNER AS SCHEMA,
            '' AS DESCRIPTION,
            O.OWNER AS OWNER,
            ${buildDatabaseSelectionExpression(database)}
        FROM ALL_OBJECTS O
        LEFT JOIN ROUTINE_ARGUMENTS A
            ON A.OWNER = O.OWNER
           AND A.OBJECT_NAME = O.OBJECT_NAME
        WHERE O.OBJECT_TYPE = ${quoteLiteral(routineType)}
        ${buildEqualityFilter('O.OWNER', schema)}
        ORDER BY O.OWNER, O.OBJECT_NAME
    `;
}

function normalizeColumnObjectTypes(objectTypes?: readonly string[]): readonly OracleColumnObjectType[] {
    const normalizedTypes = (objectTypes ?? ORACLE_DEFAULT_COLUMN_OBJECT_TYPES)
        .map(type => type.trim().toUpperCase())
        .filter((type): type is OracleColumnObjectType => ORACLE_TABLE_LIKE_OBJECT_TYPES.has(type as OracleColumnObjectType));

    return normalizedTypes.length > 0 ? normalizedTypes : ORACLE_DEFAULT_COLUMN_OBJECT_TYPES;
}

function buildKeyFlagsCte(): string {
    return `
        WITH KEY_FLAGS AS (
            SELECT
                ACC.OWNER,
                ACC.TABLE_NAME,
                ACC.COLUMN_NAME,
                MAX(CASE WHEN AC.CONSTRAINT_TYPE = 'P' THEN 1 ELSE 0 END) AS IS_PK,
                MAX(CASE WHEN AC.CONSTRAINT_TYPE = 'R' THEN 1 ELSE 0 END) AS IS_FK
            FROM ALL_CONS_COLUMNS ACC
            INNER JOIN ALL_CONSTRAINTS AC
                ON AC.OWNER = ACC.OWNER
               AND AC.CONSTRAINT_NAME = ACC.CONSTRAINT_NAME
            WHERE AC.CONSTRAINT_TYPE IN ('P', 'R')
            GROUP BY ACC.OWNER, ACC.TABLE_NAME, ACC.COLUMN_NAME
        )
    `;
}

function buildDetailedColumnQuery(schema: string, tableName: string, includeMetadataFlag: boolean): string {
    const notNullAlias = includeMetadataFlag ? 'IS_NOT_NULL' : 'ATTNOTNULL';
    return `
        ${buildKeyFlagsCte()}
        SELECT
            C.COLUMN_NAME AS ATTNAME,
            ${buildOracleTypeExpression('C')} AS FORMAT_TYPE,
            ${buildOracleTypeExpression('C')} AS FULL_TYPE,
            CASE WHEN C.NULLABLE = 'N' THEN 1 ELSE 0 END AS ${notNullAlias},
            CASE WHEN C.NULLABLE = 'N' THEN 1 ELSE 0 END AS IS_NOT_NULL,
            C.DATA_DEFAULT AS COLDEFAULT,
            COALESCE(CC.COMMENTS, '') AS DESCRIPTION,
            COALESCE(K.IS_PK, 0) AS IS_PK,
            COALESCE(K.IS_FK, 0) AS IS_FK,
            C.COLUMN_ID AS ATTNUM
        FROM ALL_TAB_COLUMNS C
        LEFT JOIN ALL_COL_COMMENTS CC
            ON CC.OWNER = C.OWNER
           AND CC.TABLE_NAME = C.TABLE_NAME
           AND CC.COLUMN_NAME = C.COLUMN_NAME
        LEFT JOIN KEY_FLAGS K
            ON K.OWNER = C.OWNER
           AND K.TABLE_NAME = C.TABLE_NAME
           AND K.COLUMN_NAME = C.COLUMN_NAME
        WHERE UPPER(C.OWNER) = UPPER(${quoteLiteral(schema)})
          AND UPPER(C.TABLE_NAME) = UPPER(${quoteLiteral(tableName)})
        ORDER BY C.COLUMN_ID
    `;
}

function buildObjectCommentJoinCondition(objectAlias: string, commentAlias: string): string {
    return `
        (
            (${objectAlias}.OBJECT_TYPE = 'TABLE' AND ${commentAlias}.TABLE_TYPE = 'TABLE')
            OR (${objectAlias}.OBJECT_TYPE = 'VIEW' AND ${commentAlias}.TABLE_TYPE = 'VIEW')
        )
    `.trim();
}

export function buildListDatabasesQuery(): string {
    return `SELECT ${buildCurrentDatabaseExpression()} AS "DATABASE" FROM DUAL`;
}

export function buildListSchemasQuery(): string {
    return `
        SELECT USERNAME AS SCHEMA
        FROM ALL_USERS
        ORDER BY USERNAME
    `;
}

export function buildListTablesQuery(schema?: string): string {
    return buildTableLikeObjectQuery('TABLE', undefined, schema);
}

export function buildListViewsQuery(schema?: string): string {
    return buildTableLikeObjectQuery('VIEW', undefined, schema);
}

export function buildListProceduresQuery(database?: string, schema?: string): string {
    return buildStandaloneRoutineQuery('PROCEDURE', database, schema, 'procedures');
}

export function buildObjectTypeQuery(objectType: string, database?: string): string {
    const normalizedType = objectType.trim().toUpperCase();
    if (normalizedType === 'TABLE' || normalizedType === 'VIEW') {
        return buildTableLikeObjectQuery(normalizedType as OracleColumnObjectType, database);
    }

    if (normalizedType === 'PROCEDURE' || normalizedType === 'FUNCTION') {
        return buildStandaloneRoutineQuery(normalizedType as 'PROCEDURE' | 'FUNCTION', database, undefined, 'objects');
    }

    return `
        SELECT
            O.OBJECT_NAME AS OBJNAME,
            O.OBJECT_ID AS OBJID,
            O.OWNER AS SCHEMA,
            '' AS DESCRIPTION,
            O.OWNER AS OWNER,
            ${buildDatabaseSelectionExpression(database)}
        FROM ALL_OBJECTS O
        WHERE O.OBJECT_TYPE = ${quoteLiteral(normalizedType)}
        ORDER BY O.OWNER, O.OBJECT_NAME
    `;
}

export function buildObjectSearchQuery(database: string, likePattern: string): string {
    const objectTypeList = ORACLE_DEFAULT_OBJECT_TYPES.map(type => quoteLiteral(type)).join(', ');

    return `
        SELECT * FROM (
            SELECT
                1 AS PRIORITY,
                O.OBJECT_NAME AS NAME,
                O.OWNER AS SCHEMA,
                ${buildDatabaseSelectionExpression(database)},
                O.OBJECT_TYPE AS TYPE,
                '' AS PARENT,
                COALESCE(C.COMMENTS, '') AS DESCRIPTION,
                'NAME' AS MATCH_TYPE
            FROM ALL_OBJECTS O
            LEFT JOIN ALL_TAB_COMMENTS C
                ON C.OWNER = O.OWNER
               AND C.TABLE_NAME = O.OBJECT_NAME
               AND ${buildObjectCommentJoinCondition('O', 'C')}
            WHERE O.OBJECT_TYPE IN (${objectTypeList})
              AND UPPER(O.OBJECT_NAME) LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                1 AS PRIORITY,
                O.OBJECT_NAME AS NAME,
                O.OWNER AS SCHEMA,
                ${buildDatabaseSelectionExpression(database)},
                O.OBJECT_TYPE AS TYPE,
                '' AS PARENT,
                COALESCE(C.COMMENTS, '') AS DESCRIPTION,
                'OBJ_DESC' AS MATCH_TYPE
            FROM ALL_OBJECTS O
            INNER JOIN ALL_TAB_COMMENTS C
                ON C.OWNER = O.OWNER
               AND C.TABLE_NAME = O.OBJECT_NAME
               AND ${buildObjectCommentJoinCondition('O', 'C')}
            WHERE O.OBJECT_TYPE IN ('TABLE', 'VIEW')
              AND UPPER(COALESCE(C.COMMENTS, '')) LIKE '${likePattern}' ESCAPE '\\'
              AND UPPER(O.OBJECT_NAME) NOT LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                2 AS PRIORITY,
                C.COLUMN_NAME AS NAME,
                C.OWNER AS SCHEMA,
                ${buildDatabaseSelectionExpression(database)},
                'COLUMN' AS TYPE,
                C.TABLE_NAME AS PARENT,
                COALESCE(CC.COMMENTS, '') AS DESCRIPTION,
                'NAME' AS MATCH_TYPE
            FROM ALL_TAB_COLUMNS C
            INNER JOIN ALL_OBJECTS O
                ON O.OWNER = C.OWNER
               AND O.OBJECT_NAME = C.TABLE_NAME
               AND O.OBJECT_TYPE IN ('TABLE', 'VIEW')
            LEFT JOIN ALL_COL_COMMENTS CC
                ON CC.OWNER = C.OWNER
               AND CC.TABLE_NAME = C.TABLE_NAME
               AND CC.COLUMN_NAME = C.COLUMN_NAME
            WHERE UPPER(C.COLUMN_NAME) LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT
                2 AS PRIORITY,
                C.COLUMN_NAME AS NAME,
                C.OWNER AS SCHEMA,
                ${buildDatabaseSelectionExpression(database)},
                'COLUMN' AS TYPE,
                C.TABLE_NAME AS PARENT,
                COALESCE(CC.COMMENTS, '') AS DESCRIPTION,
                'COL_DESC' AS MATCH_TYPE
            FROM ALL_TAB_COLUMNS C
            INNER JOIN ALL_OBJECTS O
                ON O.OWNER = C.OWNER
               AND O.OBJECT_NAME = C.TABLE_NAME
               AND O.OBJECT_TYPE IN ('TABLE', 'VIEW')
            INNER JOIN ALL_COL_COMMENTS CC
                ON CC.OWNER = C.OWNER
               AND CC.TABLE_NAME = C.TABLE_NAME
               AND CC.COLUMN_NAME = C.COLUMN_NAME
            WHERE UPPER(COALESCE(CC.COMMENTS, '')) LIKE '${likePattern}' ESCAPE '\\'
              AND UPPER(C.COLUMN_NAME) NOT LIKE '${likePattern}' ESCAPE '\\'
        ) R
        ORDER BY PRIORITY, NAME
        FETCH FIRST 200 ROWS ONLY
    `;
}

export function buildViewSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string {
    if (options.useServerSideFilter) {
        return `
            SELECT
                VIEW_NAME AS NAME,
                OWNER AS SCHEMA,
                ${buildDatabaseSelectionExpression(database)}
            FROM ALL_VIEWS
            WHERE UPPER(COALESCE(TEXT_VC, '')) LIKE '${options.likePattern}' ESCAPE '\\'
        `;
    }

    return `
        SELECT
            VIEW_NAME AS NAME,
            OWNER AS SCHEMA,
            ${buildDatabaseSelectionExpression(database)},
            COALESCE(TEXT_VC, '') AS SOURCE
        FROM ALL_VIEWS
    `;
}

export function buildProcedureSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string {
    const sourceTypeList = ORACLE_SOURCE_SEARCH_OBJECT_TYPES.map(type => quoteLiteral(type)).join(', ');
    if (options.useServerSideFilter) {
        return `
            SELECT DISTINCT
                NAME AS NAME,
                OWNER AS SCHEMA,
                ${buildDatabaseSelectionExpression(database)},
                TYPE AS TYPE
            FROM ALL_SOURCE
            WHERE TYPE IN (${sourceTypeList})
              AND UPPER(TEXT) LIKE '${options.likePattern}' ESCAPE '\\'
        `;
    }

    return `
        SELECT
            NAME AS NAME,
            OWNER AS SCHEMA,
            ${buildDatabaseSelectionExpression(database)},
            TYPE AS TYPE,
            TEXT AS SOURCE
        FROM ALL_SOURCE
        WHERE TYPE IN (${sourceTypeList})
        ORDER BY OWNER, NAME, TYPE, LINE
    `;
}

export function buildTypeGroupsQuery(): string {
    return ORACLE_DEFAULT_OBJECT_TYPES.map((objectType, index) => {
        const prefix = index === 0 ? '' : 'UNION ALL ';
        return `${prefix}SELECT ${quoteLiteral(objectType)} AS OBJTYPE FROM DUAL`;
    }).join('\n');
}

export function buildColumnsWithKeysQuery(
    database?: string,
    schema?: string,
    tableName?: string,
    objectTypes?: readonly string[]
): string {
    const normalizedObjectTypes = normalizeColumnObjectTypes(objectTypes);
    const objectTypeList = normalizedObjectTypes.map(type => quoteLiteral(type)).join(', ');
    return `
        ${buildKeyFlagsCte()}
        SELECT
            ${buildDatabaseSelectionExpression(database)},
            C.OWNER AS SCHEMA,
            C.TABLE_NAME AS TABLENAME,
            C.COLUMN_NAME AS ATTNAME,
            ${buildOracleTypeExpression('C')} AS FORMAT_TYPE,
            COALESCE(CC.COMMENTS, '') AS DESCRIPTION,
            COALESCE(K.IS_PK, 0) AS IS_PK,
            COALESCE(K.IS_FK, 0) AS IS_FK,
            C.COLUMN_ID AS ATTNUM
        FROM ALL_TAB_COLUMNS C
        INNER JOIN ALL_OBJECTS O
            ON O.OWNER = C.OWNER
           AND O.OBJECT_NAME = C.TABLE_NAME
           AND O.OBJECT_TYPE IN (${objectTypeList})
        LEFT JOIN ALL_COL_COMMENTS CC
            ON CC.OWNER = C.OWNER
           AND CC.TABLE_NAME = C.TABLE_NAME
           AND CC.COLUMN_NAME = C.COLUMN_NAME
        LEFT JOIN KEY_FLAGS K
            ON K.OWNER = C.OWNER
           AND K.TABLE_NAME = C.TABLE_NAME
           AND K.COLUMN_NAME = C.COLUMN_NAME
        WHERE 1 = 1
        ${buildEqualityFilter('C.OWNER', schema)}
        ${buildEqualityFilter('C.TABLE_NAME', tableName)}
        ORDER BY C.OWNER, C.TABLE_NAME, C.COLUMN_ID
    `;
}

export function buildTableColumnsQuery(schema: string, tableName: string): string {
    return buildDetailedColumnQuery(schema, tableName, false);
}

export function buildColumnMetadataQuery(schema: string, tableName: string): string {
    return buildDetailedColumnQuery(schema, tableName, true);
}

export function buildLookupColumnsQuery(params: {
    schema?: string;
    tableName: string;
    objectId?: number;
}): string {
    if (params.objectId !== undefined) {
        return `
            SELECT
                C.COLUMN_NAME AS ATTNAME,
                ${buildOracleTypeExpression('C')} AS FORMAT_TYPE,
                C.COLUMN_ID AS ATTNUM
            FROM ALL_TAB_COLUMNS C
            INNER JOIN ALL_OBJECTS O
                ON O.OWNER = C.OWNER
               AND O.OBJECT_NAME = C.TABLE_NAME
            WHERE O.OBJECT_ID = ${params.objectId}
            ORDER BY C.COLUMN_ID
        `;
    }

    return `
        SELECT
            C.COLUMN_NAME AS ATTNAME,
            ${buildOracleTypeExpression('C')} AS FORMAT_TYPE,
            C.COLUMN_ID AS ATTNUM
        FROM ALL_TAB_COLUMNS C
        WHERE UPPER(C.TABLE_NAME) = UPPER(${quoteLiteral(params.tableName)})
        ${buildEqualityFilter('C.OWNER', params.schema)}
        ORDER BY C.COLUMN_ID
    `;
}

export function buildTableCommentQuery(schema: string, tableName: string): string {
    return `
        SELECT COALESCE(COMMENTS, '') AS DESCRIPTION
        FROM ALL_TAB_COMMENTS
        WHERE UPPER(OWNER) = UPPER(${quoteLiteral(schema)})
          AND UPPER(TABLE_NAME) = UPPER(${quoteLiteral(tableName)})
          AND TABLE_TYPE IN ('TABLE', 'VIEW')
          AND ROWNUM = 1
    `;
}

export function buildFindTableSchemaQuery(tableName: string): string {
    return `
        SELECT OWNER AS SCHEMA
        FROM ALL_OBJECTS
        WHERE OBJECT_TYPE = 'TABLE'
          AND UPPER(OBJECT_NAME) = UPPER(${quoteLiteral(tableName)})
        ORDER BY OWNER
    `;
}

export function buildTableStatsQuery(schema: string, tableName: string): string {
    return `
        SELECT
            NUM_ROWS AS ROW_COUNT,
            LAST_ANALYZED
        FROM ALL_TABLES
        WHERE UPPER(OWNER) = UPPER(${quoteLiteral(schema)})
          AND UPPER(TABLE_NAME) = UPPER(${quoteLiteral(tableName)})
    `;
}

export function buildKeysInfoQuery(schema: string, tableName: string): string {
    return `
        SELECT
            C.CONSTRAINT_NAME AS CONSTNAME,
            CASE
                WHEN C.CONSTRAINT_TYPE = 'P' THEN 'PRIMARY KEY'
                WHEN C.CONSTRAINT_TYPE = 'U' THEN 'UNIQUE'
                WHEN C.CONSTRAINT_TYPE = 'R' THEN 'FOREIGN KEY'
                ELSE C.CONSTRAINT_TYPE
            END AS TYPE,
            C.CONSTRAINT_TYPE AS TYPECHAR,
            CC.COLUMN_NAME AS COLNAME,
            RC.OWNER AS PKSCHEMA,
            RC.TABLE_NAME AS PKRELATION,
            RCC.COLUMN_NAME AS PKCOLNAME,
            C.DELETE_RULE AS DELETERULE,
            '' AS UPDATERULE,
            NULL AS ENFORCED,
            NULL AS TRUSTED,
            NULL AS REMARKS
        FROM ALL_CONSTRAINTS C
        INNER JOIN ALL_CONS_COLUMNS CC
            ON CC.OWNER = C.OWNER
           AND CC.CONSTRAINT_NAME = C.CONSTRAINT_NAME
        LEFT JOIN ALL_CONSTRAINTS RC
            ON RC.OWNER = C.R_OWNER
           AND RC.CONSTRAINT_NAME = C.R_CONSTRAINT_NAME
        LEFT JOIN ALL_CONS_COLUMNS RCC
            ON RCC.OWNER = RC.OWNER
           AND RCC.CONSTRAINT_NAME = RC.CONSTRAINT_NAME
           AND RCC.POSITION = CC.POSITION
        WHERE UPPER(C.OWNER) = UPPER(${quoteLiteral(schema)})
          AND UPPER(C.TABLE_NAME) = UPPER(${quoteLiteral(tableName)})
          AND C.CONSTRAINT_TYPE IN ('P', 'U', 'R')
        ORDER BY C.CONSTRAINT_NAME, CC.POSITION
    `;
}

export function buildDdlQuery(objectType: string, schema: string, objectName: string): string {
    const normalizedType = mapObjectTypeToDbmsMetadataType(objectType);
    return `
        SELECT DBMS_METADATA.GET_DDL(
            ${quoteLiteral(normalizedType)},
            ${quoteLiteral(objectName)},
            ${quoteLiteral(schema)}
        ) AS DDL
        FROM DUAL
    `;
}

export function buildViewDefinitionQuery(schema: string, viewName: string): string {
    return `
        SELECT TEXT AS VIEW_TEXT
        FROM ALL_VIEWS
        WHERE UPPER(OWNER) = UPPER(${quoteLiteral(schema)})
          AND UPPER(VIEW_NAME) = UPPER(${quoteLiteral(viewName)})
    `;
}

export function buildRoutineSourceQuery(schema: string, objectName: string, sourceType: string): string {
    return `
        SELECT
            LINE AS LINE_NO,
            TEXT AS SOURCE_LINE
        FROM ALL_SOURCE
        WHERE UPPER(OWNER) = UPPER(${quoteLiteral(schema)})
          AND UPPER(NAME) = UPPER(${quoteLiteral(objectName)})
          AND TYPE = ${quoteLiteral(sourceType)}
        ORDER BY LINE
    `;
}

export function buildBatchObjectListQuery(schema?: string, objectTypes?: readonly string[]): string {
    const normalizedObjectTypes = (objectTypes ?? ORACLE_DEFAULT_OBJECT_TYPES)
        .map(type => type.trim().toUpperCase())
        .filter((type): type is OracleCatalogObjectType => ORACLE_DEFAULT_OBJECT_TYPES.includes(type as OracleCatalogObjectType));
    const objectTypeList = (normalizedObjectTypes.length > 0 ? normalizedObjectTypes : ORACLE_DEFAULT_OBJECT_TYPES)
        .map(type => quoteLiteral(type))
        .join(', ');

    return `
        SELECT
            O.OWNER AS OBJECT_SCHEMA,
            O.OBJECT_NAME AS OBJECT_NAME,
            O.OBJECT_TYPE AS OBJECT_TYPE
        FROM ALL_OBJECTS O
        WHERE O.OBJECT_TYPE IN (${objectTypeList})
        ${buildEqualityFilter('O.OWNER', schema)}
        ORDER BY
            O.OWNER,
            CASE O.OBJECT_TYPE
                WHEN 'SEQUENCE' THEN 1
                WHEN 'TABLE' THEN 2
                WHEN 'VIEW' THEN 3
                WHEN 'PACKAGE' THEN 4
                WHEN 'PACKAGE BODY' THEN 5
                WHEN 'FUNCTION' THEN 6
                WHEN 'PROCEDURE' THEN 7
                WHEN 'TRIGGER' THEN 8
                WHEN 'SYNONYM' THEN 9
                ELSE 10
            END,
            O.OBJECT_NAME
    `;
}

export function mapObjectTypeToDbmsMetadataType(objectType: string): string {
    const normalizedType = objectType.trim().toUpperCase();
    if (normalizedType === 'PACKAGE BODY') {
        return 'PACKAGE_BODY';
    }

    return normalizedType;
}
