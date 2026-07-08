import {
    buildColumnMetadataQuery,
    buildColumnsWithKeysQuery,
    buildDynamicTableStatusQuery,
    buildListDatabasesQuery,
    buildListProceduresQuery,
    buildListSchemasQuery,
    buildListTablesQuery,
    buildListViewsQuery,
    buildLookupColumnsQuery,
    buildObjectSearchQuery,
    buildObjectTypeQuery,
    buildProcedureSourceSearchQuery,
    buildTableCommentQuery,
    buildTypeGroupsQuery,
    buildViewSourceSearchQuery,
} from '../../extensions/snowflake/src/snowflakeSystemQueries';

function compactSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

describe('snowflakeSystemQueries', () => {
    it('lists databases and schemas with explicit aliases', () => {
        const databasesQuery = compactSql(buildListDatabasesQuery());
        const schemasQuery = compactSql(buildListSchemasQuery('ANALYTICS'));
        const mixedCaseSchemasQuery = compactSql(buildListSchemasQuery('analytics'));

        expect(databasesQuery).toContain('SHOW DATABASES');
        expect(databasesQuery).toContain('"name" AS "DATABASE"');
        expect(databasesQuery).toContain('"name" AS "label"');
        expect(databasesQuery).toContain('FROM $1');

        expect(schemasQuery).toContain('SHOW SCHEMAS IN ACCOUNT');
        expect(schemasQuery).toContain('"name" AS "SCHEMA"');
        expect(schemasQuery).toContain('"name" AS "label"');
        expect(schemasQuery).toContain('FROM $1');
        expect(schemasQuery).toContain(`WHERE "database_name" = 'ANALYTICS'`);
        expect(mixedCaseSchemasQuery).toContain('SHOW SCHEMAS IN ACCOUNT');
        expect(mixedCaseSchemasQuery).toContain(`WHERE "database_name" = 'ANALYTICS'`);
    });

    it('qualifies table, view, routine, and column queries against the selected database', () => {
        const tablesQuery = compactSql(buildListTablesQuery('ANALYTICS', 'PUBLIC'));
        const viewsQuery = compactSql(buildListViewsQuery('ANALYTICS', 'PUBLIC'));
        const proceduresQuery = compactSql(buildListProceduresQuery('ANALYTICS', 'PUBLIC'));
        const functionQuery = compactSql(buildObjectTypeQuery('ANALYTICS', 'FUNCTION'));
        const sequenceQuery = compactSql(buildObjectTypeQuery('ANALYTICS', 'SEQUENCE'));
        const stageQuery = compactSql(buildObjectTypeQuery('ANALYTICS', 'STAGE'));
        const streamQuery = compactSql(buildObjectTypeQuery('ANALYTICS', 'STREAM'));
        const taskQuery = compactSql(buildObjectTypeQuery('ANALYTICS', 'TASK'));
        const warehouseQuery = compactSql(buildObjectTypeQuery('ANALYTICS', 'WAREHOUSE'));
        const dynamicTableQuery = compactSql(buildObjectTypeQuery('ANALYTICS', 'DYNAMIC TABLE'));
        const dynamicTableStatusQuery = compactSql(buildDynamicTableStatusQuery('ANALYTICS', 'PUBLIC', 'ORDERS_DYNAMIC'));
        const columnsQuery = compactSql(buildColumnsWithKeysQuery('ANALYTICS', 'PUBLIC', 'ORDERS', ['TABLE', 'VIEW']));
        const columnMetadataQuery = compactSql(buildColumnMetadataQuery('ANALYTICS', 'PUBLIC', 'ORDERS'));
        const tableCommentQuery = compactSql(buildTableCommentQuery('ANALYTICS', 'PUBLIC', 'ORDERS'));

        expect(tablesQuery).toContain('FROM "ANALYTICS".INFORMATION_SCHEMA.TABLES');
        expect(tablesQuery).toContain(
            `TABLE_TYPE IN ('BASE TABLE', 'TEMPORARY TABLE', 'EXTERNAL TABLE', 'EVENT TABLE')`,
        );
        expect(tablesQuery).toContain(`TABLE_SCHEMA = 'PUBLIC'`);
        expect(tablesQuery).toContain('TABLE_NAME AS "OBJNAME"');

        expect(viewsQuery).toContain('FROM "ANALYTICS".INFORMATION_SCHEMA.VIEWS');
        expect(viewsQuery).toContain('TABLE_NAME AS "OBJNAME"');

        expect(proceduresQuery).toContain('FROM "ANALYTICS".INFORMATION_SCHEMA.PROCEDURES');
        expect(proceduresQuery).toContain('AS "PROCEDURESIGNATURE"');

        expect(functionQuery).toContain('FROM "ANALYTICS".INFORMATION_SCHEMA.FUNCTIONS');
        expect(functionQuery).toContain(`'FUNCTION' AS "OBJTYPE"`);

        expect(sequenceQuery).toContain('FROM "ANALYTICS".INFORMATION_SCHEMA.SEQUENCES');
        expect(sequenceQuery).toContain(`'SEQUENCE' AS "OBJTYPE"`);

        expect(stageQuery).toContain('SHOW STAGES IN DATABASE "ANALYTICS"');
        expect(stageQuery).toContain(`'STAGE' AS "OBJTYPE"`);

        expect(streamQuery).toContain('SHOW STREAMS IN DATABASE "ANALYTICS"');
        expect(streamQuery).toContain(`'STREAM' AS "OBJTYPE"`);

        expect(taskQuery).toContain('SHOW TASKS IN DATABASE "ANALYTICS"');
        expect(taskQuery).toContain(`'TASK' AS "OBJTYPE"`);

        expect(dynamicTableQuery).toContain('SHOW DYNAMIC TABLES IN DATABASE "ANALYTICS"');
        expect(dynamicTableQuery).toContain('"scheduling_state" AS "SCHEDULING_STATE"');
        expect(dynamicTableQuery).toContain('"target_lag" AS "TARGET_LAG"');
        expect(dynamicTableQuery).toContain('"warehouse" AS "WAREHOUSE"');
        expect(dynamicTableQuery).toContain('"refresh_mode" AS "REFRESH_MODE"');
        expect(dynamicTableQuery).toContain('State: ');

        expect(dynamicTableStatusQuery).toContain('SHOW DYNAMIC TABLES LIKE \'ORDERS_DYNAMIC\' IN SCHEMA "ANALYTICS"."PUBLIC"');
        expect(dynamicTableStatusQuery).toContain('"scheduling_state" AS "SCHEDULING_STATE"');
        expect(dynamicTableStatusQuery).toContain('"target_lag" AS "TARGET_LAG"');
        expect(dynamicTableStatusQuery).toContain('LIMIT 1');

        expect(warehouseQuery).toContain('SHOW WAREHOUSES');
        expect(warehouseQuery).toContain(`'WAREHOUSE' AS "OBJTYPE"`);

        expect(columnsQuery).toContain('FROM "ANALYTICS".INFORMATION_SCHEMA.COLUMNS c');
        expect(columnsQuery).toContain('INNER JOIN "ANALYTICS".INFORMATION_SCHEMA.TABLES t');
        expect(columnsQuery).toContain('LEFT JOIN (');
        expect(columnsQuery).toContain(`c.TABLE_NAME = 'ORDERS'`);
        expect(columnsQuery).toContain('AS ATTNAME');

        expect(columnMetadataQuery).toContain('FROM "ANALYTICS".INFORMATION_SCHEMA.COLUMNS');
        expect(columnMetadataQuery).toContain(`TABLE_NAME = 'ORDERS'`);

        expect(tableCommentQuery).toContain('FROM "ANALYTICS".INFORMATION_SCHEMA.TABLES');
    });

    it('builds search, lookup, and type group queries for the shared contracts', () => {
        const typeGroupsQuery = compactSql(buildTypeGroupsQuery());
        const lookupColumnsQuery = compactSql(
            buildLookupColumnsQuery({
                database: 'ANALYTICS',
                schema: 'PUBLIC',
                tableName: 'ORDERS',
            }),
        );
        const objectSearchQuery = compactSql(buildObjectSearchQuery('ANALYTICS', '%ORDERS%'));
        const viewSourceQuery = compactSql(
            buildViewSourceSearchQuery('ANALYTICS', {
                rawTerm: 'orders',
                likePattern: '%ORDERS%',
                useServerSideFilter: true,
            }),
        );
        const procedureSourceQuery = compactSql(
            buildProcedureSourceSearchQuery('ANALYTICS', {
                rawTerm: 'orders',
                likePattern: '%ORDERS%',
                useServerSideFilter: true,
            }),
        );

        expect(typeGroupsQuery).toContain(`SELECT COLUMN1 AS "OBJTYPE"`);
        expect(typeGroupsQuery).toContain(`('TABLE')`);
        expect(typeGroupsQuery).toContain(`('FUNCTION')`);
        expect(typeGroupsQuery).toContain(`('STAGE')`);
        expect(typeGroupsQuery).toContain(`('WAREHOUSE')`);

        expect(lookupColumnsQuery).toContain('FROM "ANALYTICS".INFORMATION_SCHEMA.COLUMNS');
        expect(lookupColumnsQuery).toContain(`TABLE_SCHEMA = 'PUBLIC'`);
        expect(lookupColumnsQuery).toContain(`TABLE_NAME = 'ORDERS'`);

        expect(objectSearchQuery).toContain('FROM "ANALYTICS".INFORMATION_SCHEMA.TABLES');
        expect(objectSearchQuery).toContain('FROM "ANALYTICS".INFORMATION_SCHEMA.PROCEDURES');
        expect(objectSearchQuery).toContain('FROM "ANALYTICS".INFORMATION_SCHEMA.FUNCTIONS');
        expect(objectSearchQuery).toContain('FROM "ANALYTICS".INFORMATION_SCHEMA.SEQUENCES');
        expect(objectSearchQuery).toContain('FROM "ANALYTICS".INFORMATION_SCHEMA.STAGES');
        expect(objectSearchQuery).toContain('FROM "ANALYTICS".INFORMATION_SCHEMA.FILE_FORMATS');
        expect(objectSearchQuery).toContain('FROM "ANALYTICS".INFORMATION_SCHEMA.COLUMNS');
        expect(objectSearchQuery).toContain(`ORDER BY "PRIORITY", "SCHEMA", "NAME"`);
        expect(objectSearchQuery).toContain('LIMIT 200');

        expect(viewSourceQuery).toContain('FROM "ANALYTICS".INFORMATION_SCHEMA.VIEWS');
        expect(viewSourceQuery).toContain('VIEW_DEFINITION');

        expect(procedureSourceQuery).toContain('FROM "ANALYTICS".INFORMATION_SCHEMA.PROCEDURES');
        expect(procedureSourceQuery).toContain('PROCEDURE_DEFINITION');
    });
});
