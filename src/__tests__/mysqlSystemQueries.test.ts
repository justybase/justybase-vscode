import {
    buildFindTableSchemaQuery,
    buildListDatabasesQuery,
    buildListProceduresQuery,
    buildListSchemasQuery,
    buildListTablesQuery,
    buildListViewsQuery,
    buildLookupColumnsQuery,
    buildObjectSearchQuery,
    buildObjectTypeQuery,
    buildProcedureSourceSearchQuery,
    buildTableColumnsQuery,
    buildTableCommentQuery,
    buildTypeGroupsQuery
} from '../../extensions/mysql/src/mysqlSystemQueries';

function compactSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

describe('mysqlSystemQueries', () => {
    it('builds information_schema-based listing queries', () => {
        expect(compactSql(buildListDatabasesQuery())).toContain('information_schema.schemata');
        expect(compactSql(buildListDatabasesQuery())).toContain('AS `DATABASE`');

        const schemasQuery = compactSql(buildListSchemasQuery('sales'));
        expect(schemasQuery).toContain('information_schema.schemata');
        expect(schemasQuery).toContain('AS `SCHEMA`');
        expect(schemasQuery).toContain("WHERE SCHEMA_NAME = 'sales'");

        expect(compactSql(buildTypeGroupsQuery())).toContain(`SELECT 'TABLE' AS OBJTYPE`);
        expect(compactSql(buildTypeGroupsQuery())).toContain(`UNION ALL SELECT 'EVENT' AS OBJTYPE`);
    });

    it('builds schema-scoped object and metadata queries', () => {
        const tablesQuery = compactSql(buildListTablesQuery('sales', 'app'));
        const viewsQuery = compactSql(buildListViewsQuery('sales', 'app'));
        const proceduresQuery = compactSql(buildListProceduresQuery('sales', 'app'));
        const objectTypeQuery = compactSql(buildObjectTypeQuery('sales', 'TRIGGER'));
        const tableColumnsQuery = compactSql(buildTableColumnsQuery('sales', 'app', 'orders'));
        const tableCommentQuery = compactSql(buildTableCommentQuery('sales', 'app', 'orders'));
        const lookupQuery = compactSql(buildLookupColumnsQuery({ database: 'sales', schema: 'app', tableName: 'orders' }));

        expect(tablesQuery).toContain('information_schema.tables');
        expect(tablesQuery).toContain("TABLE_TYPE = 'BASE TABLE'");
        expect(tablesQuery).toContain('TABLE_SCHEMA AS `SCHEMA`');
        expect(tablesQuery).toContain("TABLE_SCHEMA = 'app'");
        expect(tablesQuery).toContain("'TABLE' AS `OBJTYPE`");

        expect(viewsQuery).toContain('information_schema.tables');
        expect(viewsQuery).toContain("TABLE_TYPE = 'VIEW'");
        expect(viewsQuery).toContain("'VIEW' AS `OBJTYPE`");

        expect(proceduresQuery).toContain('information_schema.routines');
        expect(proceduresQuery).toContain("ROUTINE_TYPE = 'PROCEDURE'");
        expect(proceduresQuery).toContain('AS `PROCEDURESIGNATURE`');

        expect(objectTypeQuery).toContain('information_schema.triggers');

        expect(tableColumnsQuery).toContain('information_schema.columns');
        expect(tableColumnsQuery).toContain('c.COLUMN_NAME AS ATTNAME');
        expect(tableColumnsQuery).toContain('c.COLUMN_TYPE AS FORMAT_TYPE');
        expect(tableColumnsQuery).toContain('AS IS_NOT_NULL');
        expect(tableColumnsQuery).toContain("TABLE_SCHEMA = 'app'");
        expect(tableColumnsQuery).toContain("TABLE_NAME = 'orders'");

        expect(tableCommentQuery).toContain('information_schema.tables');
        expect(tableCommentQuery).toContain("TABLE_SCHEMA = 'app'");

        expect(lookupQuery).toContain('information_schema.columns');
        expect(lookupQuery).toContain("TABLE_SCHEMA = 'app'");
        expect(lookupQuery).toContain("TABLE_NAME = 'orders'");
    });

    it('builds search and schema lookup queries with information_schema filters', () => {
        const findSchemaQuery = compactSql(buildFindTableSchemaQuery('sales', 'orders'));
        const searchQuery = compactSql(buildObjectSearchQuery('sales', '%ORDER%'));
        const procedureSourceQuery = compactSql(buildProcedureSourceSearchQuery('sales', {
            rawTerm: 'orders',
            likePattern: '%ORDERS%',
            useServerSideFilter: true
        }));

        expect(findSchemaQuery).toContain('information_schema.tables');
        expect(findSchemaQuery).toContain("TABLE_NAME = 'orders'");
        expect(findSchemaQuery).toContain('AS `SCHEMA`');
        expect(findSchemaQuery).toContain('ORDER BY CASE WHEN TABLE_SCHEMA = DATABASE() THEN 0 ELSE 1 END');

        expect(searchQuery).toContain('information_schema.tables');
        expect(searchQuery).toContain('information_schema.routines');
        expect(searchQuery).toContain('information_schema.columns');
        expect(searchQuery).toContain('information_schema.triggers');
        expect(searchQuery).toContain('information_schema.events');
        expect(searchQuery).toContain('ORDER BY `PRIORITY`, `NAME`');
        expect(searchQuery).toContain("LIKE '%ORDER%' ESCAPE '\\'");
        expect(searchQuery).toContain("t.TABLE_SCHEMA = 'sales'");
        expect(searchQuery).toContain("r.ROUTINE_SCHEMA = 'sales'");
        expect(searchQuery).toContain("c.TABLE_SCHEMA = 'sales'");
        expect(searchQuery).toContain("tr.EVENT_OBJECT_SCHEMA = 'sales'");
        expect(searchQuery).toContain("ev.EVENT_SCHEMA = 'sales'");

        expect(procedureSourceQuery).toContain("ROUTINE_TYPE IN ('PROCEDURE', 'FUNCTION')");
        expect(procedureSourceQuery).toContain('ROUTINE_TYPE AS `TYPE`');
        expect(procedureSourceQuery).toContain('ROUTINE_DEFINITION AS `SOURCE`');
    });
});
