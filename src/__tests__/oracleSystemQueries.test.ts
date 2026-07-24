import {
    buildBatchObjectListQuery,
    buildColumnMetadataQuery,
    buildColumnsWithKeysQuery,
    buildDdlQuery,
    buildFindTableSchemaQuery,
    buildIndexObjectListQuery,
    buildObjectSearchQuery,
    buildProcedureSourceSearchQuery,
    buildKeysInfoQuery,
    buildListDatabasesQuery,
    buildListProceduresQuery,
    buildListSchemasQuery,
    buildListTablesQuery,
    buildListViewsQuery,
    buildLookupColumnsQuery,
    buildObjectTypeQuery,
    buildObjectGrantsQuery,
    buildPartitionedTableListQuery,
    buildRoutineSourceQuery,
    buildTableColumnsQuery,
    buildTableCommentQuery,
    buildTypeGroupsQuery,
    buildViewSourceSearchQuery,
    buildViewDefinitionQuery,
    mapObjectTypeToDbmsMetadataType
} from '../../extensions/oracle/src/oracleSystemQueries';

function compactSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

describe('oracleSystemQueries', () => {
    it('builds Oracle database and schema listings from catalog views', () => {
        const databasesQuery = compactSql(buildListDatabasesQuery());
        const schemasQuery = compactSql(buildListSchemasQuery());

        expect(databasesQuery).toContain('AS "DATABASE"');
        expect(databasesQuery).toContain('FROM DUAL');
        expect(databasesQuery).toContain("SYS_CONTEXT('USERENV', 'SERVICE_NAME')");

        expect(schemasQuery).toContain('SELECT USERNAME AS SCHEMA');
        expect(schemasQuery).toContain('FROM ALL_USERS');
        expect(schemasQuery).toContain('ORDER BY USERNAME');
    });

    it('builds schema-scoped table and view listings with Oracle comment joins', () => {
        const tablesQuery = compactSql(buildListTablesQuery('HR'));
        const viewsQuery = compactSql(buildListViewsQuery('HR'));

        expect(tablesQuery).toContain("O.OBJECT_TYPE = 'TABLE'");
        expect(tablesQuery).toContain("C.TABLE_TYPE = 'TABLE'");
        expect(tablesQuery).toContain("AND UPPER(O.OWNER) = UPPER('HR')");
        expect(tablesQuery).toContain("'TABLE' AS OBJTYPE");

        expect(viewsQuery).toContain("O.OBJECT_TYPE = 'VIEW'");
        expect(viewsQuery).toContain("C.TABLE_TYPE = 'VIEW'");
        expect(viewsQuery).toContain("AND UPPER(O.OWNER) = UPPER('HR')");
        expect(viewsQuery).toContain("'VIEW' AS OBJTYPE");
    });

    it('builds Oracle routine queries with argument signatures and explicit database projection', () => {
        const proceduresQuery = compactSql(buildListProceduresQuery('TESTDB', 'HR'));
        const functionObjectsQuery = compactSql(buildObjectTypeQuery('FUNCTION', 'TESTDB'));
        const packageBodyObjectsQuery = compactSql(buildObjectTypeQuery('PACKAGE BODY', 'TESTDB'));

        expect(proceduresQuery).toContain('WITH ROUTINE_ARGUMENTS AS');
        expect(proceduresQuery).toContain('FROM ALL_ARGUMENTS A');
        expect(proceduresQuery).toContain('AS PROCEDURESIGNATURE');
        expect(proceduresQuery).toContain("'TESTDB' AS \"DATABASE\"");
        expect(proceduresQuery).toContain("AND UPPER(O.OWNER) = UPPER('HR')");

        expect(functionObjectsQuery).toContain("O.OBJECT_TYPE = 'FUNCTION'");
        expect(functionObjectsQuery).toContain('LEFT JOIN ROUTINE_ARGUMENTS A');
        expect(functionObjectsQuery).toContain('AS OBJNAME');
        expect(functionObjectsQuery).toContain("'TESTDB' AS \"DATABASE\"");

        expect(packageBodyObjectsQuery).toContain("O.OBJECT_TYPE = 'PACKAGE BODY'");
        expect(packageBodyObjectsQuery).toContain("'TESTDB' AS \"DATABASE\"");
    });

    it('builds Oracle column and lookup metadata helpers with schema and table filters', () => {
        const columnsQuery = compactSql(buildColumnsWithKeysQuery('TESTDB', 'HR', 'ORDERS', ['TABLE', 'VIEW']));
        const tableColumnsQuery = compactSql(buildTableColumnsQuery('HR', 'ORDERS'));
        const metadataQuery = compactSql(buildColumnMetadataQuery('HR', 'ORDERS'));
        const lookupByObjectIdQuery = compactSql(buildLookupColumnsQuery({ tableName: 'ORDERS', objectId: 42 }));
        const lookupByNameQuery = compactSql(buildLookupColumnsQuery({ schema: 'HR', tableName: 'ORDERS' }));

        expect(columnsQuery).toContain("'TESTDB' AS \"DATABASE\"");
        expect(columnsQuery).toContain("O.OBJECT_TYPE IN ('TABLE', 'VIEW')");
        expect(columnsQuery).toContain("AND UPPER(C.OWNER) = UPPER('HR')");
        expect(columnsQuery).toContain("AND UPPER(C.TABLE_NAME) = UPPER('ORDERS')");
        expect(columnsQuery).toContain('AS IS_PK');
        expect(columnsQuery).toContain('AS IS_FK');

        expect(tableColumnsQuery).toContain('AS ATTNOTNULL');
        expect(tableColumnsQuery).toContain('AS FULL_TYPE');
        expect(tableColumnsQuery).toContain("UPPER(C.OWNER) = UPPER('HR')");
        expect(tableColumnsQuery).toContain("UPPER(C.TABLE_NAME) = UPPER('ORDERS')");

        expect(metadataQuery).toContain('AS IS_NOT_NULL');
        expect(metadataQuery).toContain('AS IS_PK');
        expect(metadataQuery).toContain('AS IS_FK');

        expect(lookupByObjectIdQuery).toContain('WHERE O.OBJECT_ID = 42');
        expect(lookupByNameQuery).toContain("UPPER(C.TABLE_NAME) = UPPER('ORDERS')");
        expect(lookupByNameQuery).toContain("AND UPPER(C.OWNER) = UPPER('HR')");
    });

    it('builds Oracle DDL and supporting helper queries for batch export and metadata lookups', () => {
        const typeGroupsQuery = compactSql(buildTypeGroupsQuery());
        const tableCommentQuery = compactSql(buildTableCommentQuery('HR', 'ORDERS'));
        const findSchemaQuery = compactSql(buildFindTableSchemaQuery('ORDERS'));
        const keysInfoQuery = compactSql(buildKeysInfoQuery('HR', 'ORDERS'));
        const ddlQuery = compactSql(buildDdlQuery('PACKAGE BODY', 'HR', 'PKG_TEST'));
        const viewDefinitionQuery = compactSql(buildViewDefinitionQuery('HR', 'ORDERS_V'));
        const routineSourceQuery = compactSql(buildRoutineSourceQuery('HR', 'DO_WORK', 'PROCEDURE'));
        const batchQuery = compactSql(buildBatchObjectListQuery('HR', ['SEQUENCE', 'PACKAGE BODY']));
        const indexQuery = compactSql(buildIndexObjectListQuery('HR'));
        const partitionQuery = compactSql(buildPartitionedTableListQuery('HR'));
        const grantsQuery = compactSql(buildObjectGrantsQuery('HR'));

        expect(typeGroupsQuery).toContain("SELECT 'TABLE' AS OBJTYPE FROM DUAL");
        expect(typeGroupsQuery).toContain("UNION ALL SELECT 'TRIGGER' AS OBJTYPE FROM DUAL");

        expect(tableCommentQuery).toContain("TABLE_TYPE IN ('TABLE', 'VIEW')");
        expect(findSchemaQuery).toContain("OBJECT_TYPE = 'TABLE'");
        expect(keysInfoQuery).toContain("C.CONSTRAINT_TYPE IN ('P', 'U', 'R')");

        expect(ddlQuery).toContain('DBMS_METADATA.GET_DDL(');
        expect(ddlQuery).toContain("'PACKAGE_BODY'");
        expect(ddlQuery).toContain("'PKG_TEST'");
        expect(ddlQuery).toContain("'HR'");

        expect(viewDefinitionQuery).toContain('FROM ALL_VIEWS');
        expect(viewDefinitionQuery).toContain("UPPER(VIEW_NAME) = UPPER('ORDERS_V')");

        expect(routineSourceQuery).toContain('FROM ALL_SOURCE');
        expect(routineSourceQuery).toContain("TYPE = 'PROCEDURE'");

        expect(batchQuery).toContain("O.OBJECT_TYPE IN ('SEQUENCE', 'PACKAGE BODY')");
        expect(batchQuery).toContain("AND UPPER(O.OWNER) = UPPER('HR')");
        expect(batchQuery).toContain("WHEN 'SEQUENCE' THEN 1");
        expect(indexQuery).toContain('FROM ALL_INDEXES I');
        expect(indexQuery).toContain("NVL(I.GENERATED, 'N') <> 'Y'");
        expect(partitionQuery).toContain('FROM ALL_PART_TABLES');
        expect(grantsQuery).toContain('FROM ALL_TAB_PRIVS');
        expect(grantsQuery).toContain('FROM ALL_COL_PRIVS');

        expect(mapObjectTypeToDbmsMetadataType('package body')).toBe('PACKAGE_BODY');
        expect(mapObjectTypeToDbmsMetadataType('trigger')).toBe('TRIGGER');
    });

    it('builds Oracle object and source search queries for the search contract', () => {
        const objectSearchQuery = compactSql(buildObjectSearchQuery('TESTDB', '%CUSTOMER%'));
        const serverFilteredViewSourceQuery = compactSql(buildViewSourceSearchQuery('TESTDB', {
            rawTerm: 'CUSTOMER',
            likePattern: '%CUSTOMER%',
            useServerSideFilter: true
        }));
        const inMemoryProcedureSourceQuery = compactSql(buildProcedureSourceSearchQuery('TESTDB', {
            rawTerm: 'CUSTOMER',
            likePattern: '%CUSTOMER%',
            useServerSideFilter: false
        }));

        expect(objectSearchQuery).toContain("O.OBJECT_TYPE IN ('TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY', 'SEQUENCE', 'SYNONYM', 'TRIGGER')");
        expect(objectSearchQuery).toContain("'COLUMN' AS TYPE");
        expect(objectSearchQuery).toContain("'OBJ_DESC' AS MATCH_TYPE");
        expect(objectSearchQuery).toContain("'COL_DESC' AS MATCH_TYPE");

        expect(serverFilteredViewSourceQuery).toContain('FROM ALL_VIEWS');
        expect(serverFilteredViewSourceQuery).toContain("UPPER(COALESCE(TEXT_VC, '')) LIKE '%CUSTOMER%' ESCAPE '\\'");

        expect(inMemoryProcedureSourceQuery).toContain('FROM ALL_SOURCE');
        expect(inMemoryProcedureSourceQuery).toContain("TYPE IN ('PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY', 'TRIGGER')");
        expect(inMemoryProcedureSourceQuery).toContain('TYPE AS TYPE');
        expect(inMemoryProcedureSourceQuery).toContain('TEXT AS SOURCE');
    });
});
