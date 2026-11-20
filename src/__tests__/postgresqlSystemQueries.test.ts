import {
    buildColumnMetadataQuery,
    buildDesignerListIndexesQuery,
    buildColumnsWithKeysQuery,
    buildDdlColumnsQuery,
    buildFindTableSchemaQuery,
    buildKeysInfoQuery,
    buildListDatabasesQuery,
    buildListProceduresQuery,
    buildListSchemasQuery,
    buildListTablesQuery,
    buildListViewsQuery,
    buildLookupColumnsQuery,
    buildObjectSearchQuery,
    buildObjectTypeQuery,
    buildProcedureSourceSearchQuery,
    buildRoutineDefinitionQuery,
    buildSequenceDefinitionQuery,
    buildTableCommentQuery,
    buildTableColumnsQuery,
    buildTableDefinitionQuery,
    buildTableIndexesQuery,
    buildTableOwnerQuery,
    buildTablePartitionKeyQuery,
    buildTablePartitionsQuery,
    buildTableSerialSequencesQuery,
    buildTableTriggersQuery,
    buildTypeGroupsQuery,
    buildViewSourceSearchQuery,
    buildViewDefinitionQuery
} from '../../extensions/postgresql/src/postgresqlSystemQueries';

function compactSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

describe('postgresqlSystemQueries', () => {
    it('quotes uppercase aliases for database, schema, and type-group listings', () => {
        const databasesQuery = compactSql(buildListDatabasesQuery());
        const schemasQuery = compactSql(buildListSchemasQuery());
        const typeGroupsQuery = compactSql(buildTypeGroupsQuery());

        expect(databasesQuery).toContain('AS "DATABASE"');

        expect(schemasQuery).toContain('AS "SCHEMA"');
        expect(schemasQuery).toContain("nspname <> 'information_schema'");
        expect(schemasQuery).toContain("nspname <> 'pg_catalog'");
        expect(schemasQuery).toContain("nspname NOT LIKE 'pg_toast%'");
        expect(schemasQuery).toContain("nspname NOT LIKE 'pg_temp_%'");

        expect(typeGroupsQuery).toContain(`SELECT 'TABLE' AS "OBJTYPE"`);
        expect(typeGroupsQuery).toContain(`UNION ALL SELECT 'PROCEDURE' AS "OBJTYPE"`);
        expect(typeGroupsQuery).toContain(`UNION ALL SELECT 'TYPE' AS "OBJTYPE"`);
        expect(typeGroupsQuery).toContain(`UNION ALL SELECT 'DOMAIN' AS "OBJTYPE"`);
        expect(typeGroupsQuery).toContain(`UNION ALL SELECT 'POLICY' AS "OBJTYPE"`);
    });

    it('uses PostgreSQL relkind and prokind filters for relation and routine listings', () => {
        const tablesQuery = compactSql(buildListTablesQuery('public'));
        const viewsQuery = compactSql(buildListViewsQuery('analytics'));
        const sequenceQuery = compactSql(buildObjectTypeQuery('SEQUENCE'));
        const typeQuery = compactSql(buildObjectTypeQuery('TYPE'));
        const domainQuery = compactSql(buildObjectTypeQuery('DOMAIN'));
        const policyQuery = compactSql(buildObjectTypeQuery('POLICY'));
        const functionQuery = compactSql(buildObjectTypeQuery('FUNCTION'));
        const proceduresQuery = compactSql(buildListProceduresQuery('public'));

        expect(tablesQuery).toContain(`c.relkind IN ('r', 'p')`);
        expect(tablesQuery).toContain(`'TABLE' AS "OBJTYPE"`);
        expect(tablesQuery).toContain(`AND n.nspname = 'public'`);

        expect(viewsQuery).toContain(`c.relkind IN ('v')`);
        expect(viewsQuery).toContain(`'VIEW' AS "OBJTYPE"`);
        expect(viewsQuery).toContain(`AND n.nspname = 'analytics'`);

        expect(sequenceQuery).toContain(`c.relkind IN ('S')`);
        expect(sequenceQuery).toContain(`'SEQUENCE' AS "OBJTYPE"`);

        expect(typeQuery).toContain(`t.typtype IN ('c', 'e', 'r', 'm')`);
        expect(typeQuery).toContain(`c.relkind = 'c'`);
        expect(domainQuery).toContain(`t.typtype = 'd'`);
        expect(domainQuery).toContain('format_type(t.typbasetype, t.typtypmod)');
        expect(policyQuery).toContain('pg_catalog.pg_policy');
        expect(policyQuery).toContain(`WHEN 'r' THEN 'SELECT'`);

        expect(functionQuery).toContain(`p.prokind = 'f'`);
        expect(functionQuery).toContain('pg_get_function_identity_arguments');
        expect(functionQuery).toContain(`'FUNCTION' AS "OBJTYPE"`);

        expect(proceduresQuery).toContain(`p.prokind = 'p'`);
        expect(proceduresQuery).toContain('AS "PROCEDURESIGNATURE"');
    });

    it('builds PostgreSQL column and lookup metadata helpers for schema and object-id lookups', () => {
        const columnsQuery = compactSql(buildColumnsWithKeysQuery('demo', 'public', 'orders', ['TABLE', 'VIEW']));
        const tableColumnsQuery = compactSql(buildTableColumnsQuery('demo', 'public', 'orders'));
        const metadataQuery = compactSql(buildColumnMetadataQuery('demo', 'public', 'orders'));
        const lookupByObjectIdQuery = compactSql(buildLookupColumnsQuery({ tableName: 'orders', objectId: 42 }));
        const lookupByNameQuery = compactSql(buildLookupColumnsQuery({ schema: 'public', tableName: 'orders' }));

        for (const query of [columnsQuery, tableColumnsQuery, metadataQuery, lookupByObjectIdQuery]) {
            expect(query).toContain('AS "ATTNAME"');
            expect(query).toContain('AS "FORMAT_TYPE"');
            expect(query).toContain('AS "DESCRIPTION"');
        }

        expect(columnsQuery).toContain(`c.relkind IN ('r', 'p', 'v')`);
        expect(columnsQuery).toContain(`current_database() AS "DATABASE"`);
        expect(columnsQuery).toContain(`AND n.nspname = 'public'`);
        expect(columnsQuery).toContain(`AND c.relname = 'orders'`);
        expect(columnsQuery).toContain('AS "TABLENAME"');
        expect(columnsQuery).toContain('AS "IS_PK"');
        expect(columnsQuery).toContain('AS "IS_FK"');

        expect(tableColumnsQuery).toContain(`c.relkind IN ('r', 'p', 'v', 'm', 'f')`);
        expect(tableColumnsQuery).toContain('AS "FULL_TYPE"');
        expect(tableColumnsQuery).toContain('AS "ATTNOTNULL"');

        expect(metadataQuery).toContain('AS "IS_NOT_NULL"');

        expect(lookupByObjectIdQuery).toContain('WHERE c.oid = 42');
        expect(lookupByObjectIdQuery).toContain('AS "DATABASE"');

        expect(lookupByNameQuery).toContain(`c.relkind IN ('r', 'p', 'v', 'm', 'f')`);
        expect(lookupByNameQuery).toContain(`AND n.nspname = 'public'`);
        expect(lookupByNameQuery).toContain(`AND c.relname = 'orders'`);
    });

    it('builds PostgreSQL metadata helpers for comments, keys, ddl columns, and owners', () => {
        const commentQuery = compactSql(buildTableCommentQuery('demo', 'public', 'orders'));
        const findSchemaQuery = compactSql(buildFindTableSchemaQuery('orders'));
        const ddlColumnsQuery = compactSql(buildDdlColumnsQuery('public', 'orders'));
        const keysInfoQuery = compactSql(buildKeysInfoQuery('public', 'orders'));
        const ownerQuery = compactSql(buildTableOwnerQuery('public', 'orders'));

        expect(commentQuery).toContain(`c.relkind IN ('r', 'p', 'v', 'm', 'f')`);
        expect(commentQuery).toContain('AS "DESCRIPTION"');

        expect(findSchemaQuery).toContain(`ORDER BY CASE WHEN n.nspname = 'public' THEN 0 ELSE 1 END`);
        expect(findSchemaQuery).toContain(`c.relkind IN ('r', 'p', 'v', 'm', 'f')`);

        expect(ddlColumnsQuery).toContain('AS "FULL_TYPE"');
        expect(ddlColumnsQuery).toContain('AS "ATTIDENTITY"');
        expect(ddlColumnsQuery).toContain('AS "ATTGENERATED"');
        expect(ddlColumnsQuery).toContain('AS "IDENTITY_OPTIONS"');
        expect(ddlColumnsQuery).toContain('AS "COLLATION"');
        expect(ddlColumnsQuery).toContain('AS "STORAGE"');
        expect(ddlColumnsQuery).toContain('AS "COMPRESSION"');
        expect(ddlColumnsQuery).toContain(`dep.deptype = 'i'`);
        expect(ddlColumnsQuery).toContain(`n.nspname = 'public'`);
        expect(ddlColumnsQuery).toContain(`c.relname = 'orders'`);

        expect(keysInfoQuery).toContain('FROM information_schema.table_constraints tc');
        expect(keysInfoQuery).toContain('AS "TYPECHAR"');
        expect(keysInfoQuery).toContain(`tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')`);

        expect(ownerQuery).toContain('pg_catalog.pg_get_userbyid(c.relowner)');
        expect(ownerQuery).toContain(`c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')`);
    });

    it('builds PostgreSQL source and partition helper queries', () => {
        const indexesQuery = compactSql(buildTableIndexesQuery('public', 'orders'));
        const triggersQuery = compactSql(buildTableTriggersQuery('public', 'orders'));
        const partitionKeyQuery = compactSql(buildTablePartitionKeyQuery('public', 'orders'));
        const tableDefinitionQuery = compactSql(buildTableDefinitionQuery('public', 'orders'));
        const serialSequencesQuery = compactSql(buildTableSerialSequencesQuery('public', 'orders'));
        const partitionsQuery = compactSql(buildTablePartitionsQuery('public', 'orders'));
        const viewDefinitionQuery = compactSql(buildViewDefinitionQuery('public', 'orders_view'));
        const routineDefinitionQuery = compactSql(buildRoutineDefinitionQuery('public', 'do_work(integer)', 'PROCEDURE'));
        const sequenceDefinitionQuery = compactSql(buildSequenceDefinitionQuery('public', 'orders_id_seq'));

        expect(indexesQuery).toContain('pg_catalog.pg_get_indexdef');
        expect(indexesQuery).toContain('AND NOT i.indisprimary');

        expect(triggersQuery).toContain('pg_catalog.pg_get_triggerdef');
        expect(triggersQuery).toContain('AND NOT t.tgisinternal');

        expect(partitionKeyQuery).toContain('pg_catalog.pg_get_partkeydef');
        expect(partitionKeyQuery).toContain(`c.relkind = 'p'`);

        expect(tableDefinitionQuery).toContain('c.relpersistence AS "PERSISTENCE"');
        expect(tableDefinitionQuery).toContain('c.reloptions AS "RELOPTIONS"');
        expect(tableDefinitionQuery).toContain('pg_catalog.pg_get_partkeydef');
        expect(tableDefinitionQuery).toContain(`c.relkind IN ('r', 'p')`);

        expect(serialSequencesQuery).toContain(`d.deptype = 'a'`);
        expect(serialSequencesQuery).toContain('CREATE SEQUENCE %I.%I INCREMENT BY %s');
        expect(serialSequencesQuery).toContain(`c.relname = 'orders'`);

        expect(partitionsQuery).toContain('CREATE TABLE %I.%I PARTITION OF %I.%I %s;');
        expect(partitionsQuery).toContain('pg_catalog.pg_get_expr(child.relpartbound, child.oid, true)');

        expect(viewDefinitionQuery).toContain('pg_catalog.pg_get_viewdef');
        expect(viewDefinitionQuery).toContain(`CASE WHEN c.relkind = 'm' THEN 'MATERIALIZED VIEW' ELSE 'VIEW' END AS "VIEW_KIND"`);
        expect(viewDefinitionQuery).toContain(`n.nspname = 'public'`);
        expect(viewDefinitionQuery).toContain(`c.relname = 'orders_view'`);
        expect(viewDefinitionQuery).toContain(`c.relkind IN ('v', 'm')`);

        expect(routineDefinitionQuery).toContain(`AND p.prokind = 'p'`);
        expect(routineDefinitionQuery).toContain(`'do_work(integer)'`);

        expect(sequenceDefinitionQuery).toContain('CREATE SEQUENCE %I.%I INCREMENT BY %s');
        expect(sequenceDefinitionQuery).toContain(`c.relkind = 'S'`);
    });

    it('keeps expression indexes in the index designer catalog', () => {
        const query = compactSql(buildDesignerListIndexesQuery('public', 'orders'));

        expect(query).toContain('LEFT JOIN pg_catalog.pg_attribute a');
        expect(query).toContain('COALESCE(a.attname, pg_catalog.pg_get_indexdef(i.indexrelid, k.ord, true)) AS COLUMN_NAME');
    });

    it('builds PostgreSQL object and source search queries for the search contract', () => {
        const objectSearchQuery = compactSql(buildObjectSearchQuery('demo', '%ORDERS%'));
        const serverFilteredViewSourceQuery = compactSql(buildViewSourceSearchQuery('demo', {
            rawTerm: 'orders',
            likePattern: '%ORDERS%',
            useServerSideFilter: true
        }));
        const inMemoryProcedureSourceQuery = compactSql(buildProcedureSourceSearchQuery('demo', {
            rawTerm: 'orders',
            likePattern: '%ORDERS%',
            useServerSideFilter: false
        }));

        expect(objectSearchQuery).toContain(`c.relname AS "NAME"`);
        expect(objectSearchQuery).toContain(`n.nspname AS "SCHEMA"`);
        expect(objectSearchQuery).toContain(`CASE WHEN p.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS "TYPE"`);
        expect(objectSearchQuery).toContain(`CASE WHEN t.typtype = 'd' THEN 'DOMAIN' ELSE 'TYPE' END AS "TYPE"`);
        expect(objectSearchQuery).toContain(`'POLICY' AS "TYPE"`);
        expect(objectSearchQuery).toContain(`'COLUMN' AS "TYPE"`);
        expect(objectSearchQuery).toContain(`'OBJ_DESC' AS "MATCH_TYPE"`);
        expect(objectSearchQuery).toContain(`'COL_DESC' AS "MATCH_TYPE"`);
        expect(objectSearchQuery).toContain(`ORDER BY "PRIORITY", "NAME"`);

        expect(serverFilteredViewSourceQuery).toContain('pg_catalog.pg_get_viewdef(c.oid, true)');
        expect(serverFilteredViewSourceQuery).toContain(`c.relname AS "NAME"`);
        expect(serverFilteredViewSourceQuery).toContain(`UPPER(pg_catalog.pg_get_viewdef(c.oid, true)) LIKE '%ORDERS%' ESCAPE '\\'`);

        expect(inMemoryProcedureSourceQuery).toContain('pg_catalog.pg_get_functiondef(p.oid) AS "SOURCE"');
        expect(inMemoryProcedureSourceQuery).toContain(`CASE WHEN p.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS "TYPE"`);
        expect(inMemoryProcedureSourceQuery).toContain(`p.prokind IN ('f', 'p')`);
    });
});
