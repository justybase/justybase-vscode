import {
    DatabaseColumnLookupParams,
    DatabaseColumnQueryOptions,
    DatabaseMetadataProvider,
    DatabaseSourceSearchQueryOptions
} from '../../../contracts/database';
import {
    NZ_DEFAULT_OBJECT_TYPES,
    NZ_QUERIES,
    NZ_SYSTEM_VIEWS,
    qualifySystemView
} from './systemQueries';
import { buildNetezzaColumnsWithKeysQueries } from './columnsWithKeys';
import {
    SYSTEM_CATALOG_SOURCE_DATABASE,
    isMirroredSystemCatalogObjectName
} from './systemCatalogUtils';
import { escapeSqlString as escapeSqlLiteral } from '../../../utils/sqlUtils';
import {
    buildNetezzaIdentifierEquality,
} from './identifierUtils';

function buildSchemaPredicate(schemaName: string): string {
    return buildNetezzaIdentifierEquality('SCHEMA', schemaName);
}

function buildDatabasePredicate(database: string): string {
    return buildNetezzaIdentifierEquality('DBNAME', database);
}

function buildObjectSearchQuery(database: string, likePattern: string): string {
    const db = database;
    const objectDataView = qualifySystemView(db, NZ_SYSTEM_VIEWS.OBJECT_DATA);
    const relationColumnView = qualifySystemView(db, NZ_SYSTEM_VIEWS.RELATION_COLUMN);
    const externalView = qualifySystemView(db, NZ_SYSTEM_VIEWS.EXTERNAL);
    const extObjectView = qualifySystemView(db, NZ_SYSTEM_VIEWS.EXTOBJECT);

    return `
        SELECT * FROM (
            SELECT 1 AS PRIORITY, OBJNAME AS NAME, SCHEMA, DBNAME AS DATABASE, OBJTYPE AS TYPE, '' AS PARENT,
                   COALESCE(DESCRIPTION, '') AS DESCRIPTION, 'NAME' AS MATCH_TYPE
            FROM ${objectDataView}
            WHERE ${buildDatabasePredicate(db)} AND UPPER(OBJNAME) LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT 1 AS PRIORITY, OBJNAME AS NAME, SCHEMA, DBNAME AS DATABASE, OBJTYPE AS TYPE, '' AS PARENT,
                   COALESCE(DESCRIPTION, '') AS DESCRIPTION, 'OBJ_DESC' AS MATCH_TYPE
            FROM ${objectDataView}
            WHERE ${buildDatabasePredicate(db)} AND UPPER(DESCRIPTION) LIKE '${likePattern}' ESCAPE '\\' AND UPPER(OBJNAME) NOT LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT 2 AS PRIORITY, C.ATTNAME AS NAME, O.SCHEMA, O.DBNAME AS DATABASE, 'COLUMN' AS TYPE, O.OBJNAME AS PARENT,
                   COALESCE(C.DESCRIPTION, '') AS DESCRIPTION, 'NAME' AS MATCH_TYPE
            FROM ${relationColumnView} C
            JOIN ${objectDataView} O ON C.OBJID = O.OBJID
            WHERE ${buildNetezzaIdentifierEquality('O.DBNAME', db)} AND UPPER(C.ATTNAME) LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT 2 AS PRIORITY, C.ATTNAME AS NAME, O.SCHEMA, O.DBNAME AS DATABASE, 'COLUMN' AS TYPE, O.OBJNAME AS PARENT,
                   COALESCE(C.DESCRIPTION, '') AS DESCRIPTION, 'COL_DESC' AS MATCH_TYPE
            FROM ${relationColumnView} C
            JOIN ${objectDataView} O ON C.OBJID = O.OBJID
            WHERE ${buildNetezzaIdentifierEquality('O.DBNAME', db)} AND UPPER(C.DESCRIPTION) LIKE '${likePattern}' ESCAPE '\\' AND UPPER(C.ATTNAME) NOT LIKE '${likePattern}' ESCAPE '\\'
            UNION ALL
            SELECT 3 AS PRIORITY, E1.TABLENAME AS NAME, E1.SCHEMA, E1.DATABASE, 'EXTERNAL TABLE' AS TYPE, '' AS PARENT,
                   COALESCE(E2.EXTOBJNAME, '') AS DESCRIPTION, 'DATAOBJECT' AS MATCH_TYPE
            FROM ${externalView} E1
            JOIN ${extObjectView} E2 ON E1.RELID = E2.OBJID
            WHERE ${buildNetezzaIdentifierEquality('E1.DATABASE', db)} AND UPPER(E2.EXTOBJNAME) LIKE '${likePattern}' ESCAPE '\\'
        ) AS R
        ORDER BY PRIORITY, NAME
        LIMIT 200
    `.trim();
}

function buildViewSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string {
    const db = database;
    const viewSource = qualifySystemView(db, NZ_SYSTEM_VIEWS.VIEW);

    if (options.useServerSideFilter) {
        return `
            SELECT VIEWNAME AS NAME, SCHEMA, DATABASE
            FROM ${viewSource}
            WHERE DATABASE != 'SYSTEM' AND UPPER(DEFINITION) LIKE '${options.likePattern}' ESCAPE '\\'
        `.trim();
    }

    return `
        SELECT VIEWNAME AS NAME, SCHEMA, DATABASE, DEFINITION AS SOURCE
        FROM ${viewSource}
        WHERE DATABASE != 'SYSTEM'
    `.trim();
}

function buildProcedureSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string {
    const db = database;
    const procedureSource = qualifySystemView(db, NZ_SYSTEM_VIEWS.PROCEDURE);

    if (options.useServerSideFilter) {
        return `
            SELECT PROCEDURE AS NAME, SCHEMA, DATABASE
            FROM ${procedureSource}
            WHERE DATABASE != 'SYSTEM' AND UPPER(PROCEDURESOURCE) LIKE '${options.likePattern}' ESCAPE '\\'
        `.trim();
    }

    return `
        SELECT PROCEDURE AS NAME, SCHEMA, DATABASE, PROCEDURESOURCE AS SOURCE
        FROM ${procedureSource}
        WHERE DATABASE != 'SYSTEM'
    `.trim();
}

export interface NetezzaMetadataProvider extends DatabaseMetadataProvider {
    buildObjectByNameQuery(
        database: string,
        schema: string,
        objectName: string,
        objectTypes: readonly string[],
    ): string;
}

export const netezzaMetadataProvider: NetezzaMetadataProvider = {
    defaultObjectTypes: NZ_DEFAULT_OBJECT_TYPES,
    defaultColumnObjectTypes: ['TABLE', 'VIEW', 'EXTERNAL TABLE'],
    buildListDatabasesQuery(): string {
        return NZ_QUERIES.LIST_DATABASES;
    },
    buildListSchemasQuery(database: string): string {
        return NZ_QUERIES.listSchemas(database);
    },
    buildListTablesQuery(database: string, schema?: string): string {
        if (schema) {
            return `
                SELECT
                    O.OBJNAME,
                    O.OBJID,
                    O.OBJTYPE,
                    COALESCE(S.REFOBJNAME, '') AS REFOBJNAME,
                    COALESCE(O.DESCRIPTION, '') AS DESCRIPTION
                FROM ${qualifySystemView(database, NZ_SYSTEM_VIEWS.OBJECT_DATA)} O
                LEFT JOIN ${qualifySystemView(database, NZ_SYSTEM_VIEWS.SYNONYM)} S ON S.OBJID = O.OBJID
                WHERE ${buildDatabasePredicate(database)}
                    AND ${buildNetezzaIdentifierEquality('O.SCHEMA', schema)}
                    AND O.OBJTYPE IN ('TABLE', 'VIEW', 'SYNONYM', 'EXTERNAL TABLE')
                ORDER BY O.OBJNAME
            `.trim();
        }
        return `
            SELECT
                O.OBJNAME,
                O.OBJID,
                O.OBJTYPE,
                O.SCHEMA,
                COALESCE(S.REFOBJNAME, '') AS REFOBJNAME,
                COALESCE(O.DESCRIPTION, '') AS DESCRIPTION
            FROM ${qualifySystemView(database, NZ_SYSTEM_VIEWS.OBJECT_DATA)} O
            LEFT JOIN ${qualifySystemView(database, NZ_SYSTEM_VIEWS.SYNONYM)} S ON S.OBJID = O.OBJID
            WHERE ${buildDatabasePredicate(database)}
                AND O.OBJTYPE IN ('TABLE', 'VIEW', 'SYNONYM', 'EXTERNAL TABLE')
            ORDER BY O.OBJNAME
        `.trim();
    },
    buildListViewsQuery(database: string, schema?: string): string {
        if (schema) {
            return `SELECT OBJNAME, SCHEMA, COALESCE(DESCRIPTION, '') AS DESCRIPTION FROM ${qualifySystemView(database, NZ_SYSTEM_VIEWS.OBJECT_DATA)} WHERE ${buildDatabasePredicate(database)} AND ${buildSchemaPredicate(schema)} AND OBJTYPE = 'VIEW' ORDER BY OBJNAME`;
        }
        return `SELECT OBJNAME, SCHEMA, COALESCE(DESCRIPTION, '') AS DESCRIPTION FROM ${qualifySystemView(database, NZ_SYSTEM_VIEWS.OBJECT_DATA)} WHERE ${buildDatabasePredicate(database)} AND OBJTYPE = 'VIEW' ORDER BY OBJNAME`;
    },
    buildListProceduresQuery(database: string, schema?: string): string {
        let query = `SELECT SCHEMA, PROCEDURE, PROCEDURESIGNATURE FROM ${qualifySystemView(database, NZ_SYSTEM_VIEWS.PROCEDURE)} WHERE ${buildNetezzaIdentifierEquality('DATABASE', database)}`;
        if (schema) {
            query += ` AND ${buildSchemaPredicate(schema)}`;
        }
        query += ' ORDER BY SCHEMA, PROCEDURE';
        return query;
    },
    buildObjectTypeQuery(database: string, objectType: string): string {
        if (objectType === 'PROCEDURE') {
            return `SELECT PROCEDURESIGNATURE AS OBJNAME, SCHEMA, OBJID::INT AS OBJID, COALESCE(DESCRIPTION, '') AS DESCRIPTION, OWNER FROM ${qualifySystemView(database, NZ_SYSTEM_VIEWS.PROCEDURE)} WHERE ${buildNetezzaIdentifierEquality('DATABASE', database)} ORDER BY PROCEDURESIGNATURE`;
        }
        if (objectType === 'SYNONYM') {
            return `
                SELECT
                    O.OBJNAME,
                    O.SCHEMA,
                    O.OBJID,
                    COALESCE(O.DESCRIPTION, '') AS DESCRIPTION,
                    O.OWNER,
                    COALESCE(S.REFOBJNAME, '') AS REFOBJNAME
                FROM ${qualifySystemView(database, NZ_SYSTEM_VIEWS.OBJECT_DATA)} O
                LEFT JOIN ${qualifySystemView(database, NZ_SYSTEM_VIEWS.SYNONYM)} S ON S.OBJID = O.OBJID
                WHERE ${buildNetezzaIdentifierEquality('O.DBNAME', database)}
                    AND O.OBJTYPE = 'SYNONYM'
                ORDER BY O.OBJNAME
            `.trim();
        }
        return `SELECT OBJNAME, SCHEMA, OBJID, COALESCE(DESCRIPTION, '') AS DESCRIPTION, OWNER FROM ${qualifySystemView(database, NZ_SYSTEM_VIEWS.OBJECT_DATA)} WHERE ${buildNetezzaIdentifierEquality('DBNAME', database)} AND OBJTYPE = '${escapeSqlLiteral(objectType)}' ORDER BY OBJNAME`;
    },
    buildObjectByNameQuery(
        database: string,
        schema: string,
        objectName: string,
        objectTypes: readonly string[],
    ): string {
        const types = objectTypes
            .map(type => `'${escapeSqlLiteral(type)}'`)
            .join(', ');
        return `
            SELECT OBJNAME, SCHEMA, OBJID, OBJTYPE,
                   COALESCE(DESCRIPTION, '') AS DESCRIPTION, OWNER
            FROM ${qualifySystemView(database, NZ_SYSTEM_VIEWS.OBJECT_DATA)}
            WHERE ${buildDatabasePredicate(database)}
              AND ${buildSchemaPredicate(schema)}
              AND ${buildNetezzaIdentifierEquality('OBJNAME', objectName)}
              AND OBJTYPE IN (${types})
        `.trim();
    },
    buildTypeGroupsQuery(database: string): string {
        return `SELECT DISTINCT OBJTYPE FROM ${qualifySystemView(database, NZ_SYSTEM_VIEWS.OBJECT_DATA)} WHERE ${buildNetezzaIdentifierEquality('DBNAME', database)} ORDER BY OBJTYPE`;
    },
    buildColumnsWithKeysQuery(database: string, options?: DatabaseColumnQueryOptions): string {
        return NZ_QUERIES.listColumnsWithKeys(database, options);
    },
    buildColumnsWithKeysQueries(database: string, options?: DatabaseColumnQueryOptions) {
        return buildNetezzaColumnsWithKeysQueries(database, options);
    },
    buildExternalColumnsWithKeysQuery(database: string, options?: DatabaseColumnQueryOptions): string {
        return NZ_QUERIES.listExternalColumnsWithKeys(database, options);
    },
    buildTableColumnsQuery(database: string, schema: string, tableName: string): string {
        return NZ_QUERIES.getTableColumns(database, schema, tableName);
    },
    buildExternalTableColumnsQuery(database: string, schema: string, tableName: string): string {
        return NZ_QUERIES.getExternalTableColumns(database, schema, tableName);
    },
    buildColumnMetadataQuery(database: string, schema: string, tableName: string): string {
        const relationColumnView = qualifySystemView(database, NZ_SYSTEM_VIEWS.RELATION_COLUMN);
        const objectDataView = qualifySystemView(database, NZ_SYSTEM_VIEWS.OBJECT_DATA);
        const relationKeyDataView = qualifySystemView(database, NZ_SYSTEM_VIEWS.RELATION_KEYDATA);
        const tableDistMapView = qualifySystemView(database, NZ_SYSTEM_VIEWS.TABLE_DIST_MAP);
        return `
            SELECT 
                X.ATTNAME
                , X.FORMAT_TYPE
                , CASE WHEN X.ATTNOTNULL THEN 1 ELSE 0 END AS IS_NOT_NULL
                , X.COLDEFAULT
                , COALESCE(X.DESCRIPTION, '') AS DESCRIPTION
                , MAX(CASE WHEN K.CONTYPE = 'p' THEN 1 ELSE 0 END) AS IS_PK
                , MAX(CASE WHEN K.CONTYPE = 'f' THEN 1 ELSE 0 END) AS IS_FK
                , MAX(CASE WHEN D.ATTNAME IS NOT NULL THEN 1 ELSE 0 END) AS IS_DISTRIBUTION_KEY
            FROM
                ${relationColumnView} X
            INNER JOIN
                ${objectDataView} O ON X.OBJID = O.OBJID
            LEFT JOIN
                ${relationKeyDataView} K
                ON K.OBJID = O.OBJID
                AND K.ATTNAME = X.ATTNAME
                AND K.CONTYPE IN ('p', 'f')
            LEFT JOIN
                ${tableDistMapView} D
                ON D.OBJID = O.OBJID
                AND D.ATTNAME = X.ATTNAME
            WHERE
                ${buildNetezzaIdentifierEquality('O.OBJNAME', tableName)}
                AND ${buildNetezzaIdentifierEquality('O.DBNAME', database)}
                AND ${buildNetezzaIdentifierEquality('O.SCHEMA', schema)}
            GROUP BY 
                X.ATTNAME, X.FORMAT_TYPE, X.ATTNOTNULL, X.COLDEFAULT, X.DESCRIPTION, X.ATTNUM
            ORDER BY 
                X.ATTNUM
        `;
    },
    buildLookupColumnsQuery(params: DatabaseColumnLookupParams): string {
        const { database, schema, tableName, objectId } = params;
        const relationColumnView = database
            ? qualifySystemView(database, NZ_SYSTEM_VIEWS.RELATION_COLUMN)
            : NZ_SYSTEM_VIEWS.RELATION_COLUMN;
        const objectDataView = database
            ? qualifySystemView(database, NZ_SYSTEM_VIEWS.OBJECT_DATA)
            : NZ_SYSTEM_VIEWS.OBJECT_DATA;
        if (objectId !== undefined) {
            return `SELECT ATTNAME, FORMAT_TYPE, COALESCE(DESCRIPTION, '') AS DESCRIPTION FROM ${relationColumnView} WHERE OBJID = ${objectId} ORDER BY ATTNUM`;
        }
        const schemaClause = schema ? `AND ${buildNetezzaIdentifierEquality('O.SCHEMA', schema)}` : '';
        const dbClause = database ? `AND ${buildNetezzaIdentifierEquality('O.DBNAME', database)}` : '';
        return `
            SELECT C.ATTNAME, C.FORMAT_TYPE, COALESCE(C.DESCRIPTION, '') AS DESCRIPTION
            FROM ${relationColumnView} C
            JOIN ${objectDataView} O ON C.OBJID = O.OBJID
            WHERE ${buildNetezzaIdentifierEquality('O.OBJNAME', tableName)} ${schemaClause} ${dbClause}
            ORDER BY C.ATTNUM
        `;
    },
    buildTableCommentQuery(database: string, schema: string, tableName: string): string {
        return `SELECT DESCRIPTION FROM ${qualifySystemView(database, NZ_SYSTEM_VIEWS.OBJECT_DATA)} WHERE OBJTYPE='TABLE' AND ${buildNetezzaIdentifierEquality('OBJNAME', tableName)} AND ${buildNetezzaIdentifierEquality('SCHEMA', schema)} AND ${buildNetezzaIdentifierEquality('DBNAME', database)}`;
    },
    buildObjectSearchQuery(database: string, likePattern: string): string {
        return buildObjectSearchQuery(database, likePattern);
    },
    buildViewSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string {
        return buildViewSourceSearchQuery(database, options);
    },
    buildProcedureSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string {
        return buildProcedureSourceSearchQuery(database, options);
    },
    mirroredSystemCatalog: {
        sourceDatabase: SYSTEM_CATALOG_SOURCE_DATABASE,
        isMirroredObjectName: isMirroredSystemCatalogObjectName,
        buildMirroredObjectsQuery(): string {
            return `
                SELECT OBJNAME, OBJID, OBJTYPE, COALESCE(DESCRIPTION, '') AS DESCRIPTION
                FROM ${SYSTEM_CATALOG_SOURCE_DATABASE}.._V_OBJECT_DATA
                WHERE UPPER(OBJNAME) LIKE '\\_V\\_%' ESCAPE '\\'
                  AND OBJTYPE IN ('TABLE', 'VIEW')
                ORDER BY OBJNAME
            `;
        }
    }
};
