import {
    buildColumnsWithKeysQuery,
    buildListDatabasesQuery,
    buildListProceduresQuery,
    buildListSchemasQuery,
    buildListTablesQuery,
    buildListViewsQuery,
    buildLookupColumnsQuery,
    buildObjectSearchQuery,
    buildProcedureSourceSearchQuery,
    buildTypeGroupsQuery,
    buildViewSourceSearchQuery,
} from '../../extensions/vertica/src/verticaSystemQueries';

function compactSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

describe('verticaSystemQueries', () => {
    it('builds Vertica catalog listing queries with the expected aliases and schema filters', () => {
        const databasesQuery = compactSql(buildListDatabasesQuery());
        const schemasQuery = compactSql(buildListSchemasQuery());
        const tablesQuery = compactSql(buildListTablesQuery('public'));
        const viewsQuery = compactSql(buildListViewsQuery('analytics'));
        const proceduresQuery = compactSql(buildListProceduresQuery('public'));
        const typeGroupsQuery = compactSql(buildTypeGroupsQuery());

        expect(databasesQuery).toContain('CURRENT_DATABASE() AS "DATABASE"');

        expect(schemasQuery).toContain('FROM V_CATALOG.SCHEMATA');
        expect(schemasQuery).toContain('AS "SCHEMA"');
        expect(schemasQuery).toContain("SCHEMA_NAME <> 'information_schema'");
        expect(schemasQuery).toContain("SCHEMA_NAME NOT ILIKE 'v_%'");

        expect(tablesQuery).toContain('FROM V_CATALOG.TABLES');
        expect(tablesQuery).toContain(`'TABLE' AS "OBJTYPE"`);
        expect(tablesQuery).toContain('NOT t.IS_SYSTEM_TABLE');
        expect(tablesQuery).toContain("UPPER('public')");

        expect(viewsQuery).toContain('FROM V_CATALOG.VIEWS');
        expect(viewsQuery).toContain(`'VIEW' AS "OBJTYPE"`);
        expect(viewsQuery).toContain('NOT v.IS_SYSTEM_VIEW');
        expect(viewsQuery).toContain("UPPER('analytics')");

        expect(proceduresQuery).toContain('FROM V_CATALOG.USER_PROCEDURES p');
        expect(proceduresQuery).toContain(`'' AS "OWNER"`);

        expect(typeGroupsQuery).toContain(`SELECT 'TABLE' AS "OBJTYPE"`);
        expect(typeGroupsQuery).toContain(`UNION ALL SELECT 'PROCEDURE' AS "OBJTYPE"`);
    });

    it('builds Vertica column lookup and search queries for schema and object-id paths', () => {
        const columnsQuery = compactSql(buildColumnsWithKeysQuery('public', 'orders', ['TABLE', 'VIEW']));
        const lookupByObjectIdQuery = compactSql(buildLookupColumnsQuery({ objectId: 42, tableName: 'orders' }));
        const lookupByNameQuery = compactSql(buildLookupColumnsQuery({ schema: 'public', tableName: 'orders' }));
        const objectSearchQuery = compactSql(buildObjectSearchQuery('warehouse', '%ORDERS%'));

        expect(columnsQuery).toContain('WITH CONSTRAINT_FLAGS AS');
        expect(columnsQuery).toContain('FROM V_CATALOG.COLUMNS c');
        expect(columnsQuery).toContain('FROM V_CATALOG.VIEW_COLUMNS vc');
        expect(columnsQuery).toContain('AS "ATTNAME"');
        expect(columnsQuery).toContain('AS "IS_PK"');
        expect(columnsQuery).toContain('AS "IS_FK"');

        expect(lookupByObjectIdQuery).toContain('c.TABLE_ID = 42');
        expect(lookupByObjectIdQuery).toContain('vc.TABLE_ID = 42');
        expect(lookupByObjectIdQuery).toContain('UNION ALL');

        expect(lookupByNameQuery).toContain("UPPER('public')");
        expect(lookupByNameQuery).toContain("UPPER('orders')");

        expect(objectSearchQuery).toContain('FROM V_CATALOG.TABLES t');
        expect(objectSearchQuery).toContain('FROM V_CATALOG.PROJECTIONS p');
        expect(objectSearchQuery).toContain(`'COLUMN' AS "TYPE"`);
        expect(objectSearchQuery).toContain('ORDER BY "PRIORITY", "NAME"');
    });

    it('orders combined Vertica column queries once at the union level', () => {
        const columnsQuery = compactSql(buildColumnsWithKeysQuery('public', 'orders', ['TABLE', 'VIEW']));
        const lookupByObjectIdQuery = compactSql(buildLookupColumnsQuery({ objectId: 42, tableName: 'orders' }));

        expect(columnsQuery).toContain('ORDER BY "SCHEMA", "TABLENAME", "ATTNUM"');
        expect(columnsQuery).not.toContain('ORDER BY c.TABLE_SCHEMA');
        expect(columnsQuery).not.toContain('ORDER BY vc.TABLE_SCHEMA');

        expect(lookupByObjectIdQuery).toContain('ORDER BY "SCHEMA", "TABLENAME", "ATTNUM"');
        expect(lookupByObjectIdQuery).not.toContain('ORDER BY c.TABLE_SCHEMA');
        expect(lookupByObjectIdQuery).not.toContain('ORDER BY vc.TABLE_SCHEMA');
    });

    it('builds Vertica source search queries for server-side and in-memory filtering', () => {
        const serverFilteredViewSourceQuery = compactSql(buildViewSourceSearchQuery('warehouse', {
            rawTerm: 'orders',
            likePattern: '%ORDERS%',
            useServerSideFilter: true,
        }));
        const inMemoryViewSourceQuery = compactSql(buildViewSourceSearchQuery('warehouse', {
            rawTerm: 'orders',
            likePattern: '%ORDERS%',
            useServerSideFilter: false,
        }));
        const serverFilteredProcedureSourceQuery = compactSql(buildProcedureSourceSearchQuery('warehouse', {
            rawTerm: 'orders',
            likePattern: '%ORDERS%',
            useServerSideFilter: true,
        }));
        const inMemoryProcedureSourceQuery = compactSql(buildProcedureSourceSearchQuery('warehouse', {
            rawTerm: 'orders',
            likePattern: '%ORDERS%',
            useServerSideFilter: false,
        }));

        expect(serverFilteredViewSourceQuery).toContain("UPPER(COALESCE(VIEW_DEFINITION, '')) LIKE '%ORDERS%' ESCAPE '\\'");
        expect(serverFilteredViewSourceQuery).not.toContain('AS "SOURCE"');
        expect(inMemoryViewSourceQuery).toContain('VIEW_DEFINITION AS "SOURCE"');

        expect(serverFilteredProcedureSourceQuery).toContain('FROM V_CATALOG.USER_FUNCTIONS f');
        expect(serverFilteredProcedureSourceQuery).toContain('FROM V_CATALOG.USER_PROCEDURES p');
        expect(serverFilteredProcedureSourceQuery).toContain("UPPER(COALESCE(f.FUNCTION_DEFINITION, '')) LIKE '%ORDERS%' ESCAPE '\\'");
        expect(inMemoryProcedureSourceQuery).toContain('COALESCE(f.FUNCTION_DEFINITION, \'\') AS "SOURCE"');
        expect(inMemoryProcedureSourceQuery).toContain(`'PROCEDURE' AS "TYPE"`);
    });
});
