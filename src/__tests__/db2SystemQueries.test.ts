import {
    buildAliasDefinitionQuery,
    buildBatchObjectListQuery,
    buildColumnMetadataQuery,
    buildColumnsWithKeysQuery,
    buildDdlQuery,
    buildFindTableSchemaQuery,
    buildKeysInfoQuery,
    buildListDatabasesQuery,
    buildListProceduresQuery,
    buildListSchemasQuery,
    buildListTablesQuery,
    buildListViewsQuery,
    buildNicknameDefinitionQuery,
    buildNicknameServerContextQuery,
    isNetezzaFederatedServer,
    resolveNicknameRemoteSchema,
    buildObjectSearchQuery,
    buildObjectTypeQuery,
    buildProcedureSourceSearchQuery,
    buildProcedureDefinitionQuery,
    buildTableColumnsQuery,
    buildTableCommentQuery,
    buildTableHashDistributionQuery,
    buildTableIndexesQuery,
    buildTableOwnerQuery,
    buildTablePartitionExpressionsQuery,
    buildTablePartitionsQuery,
    buildTableStatsQuery,
    buildTableStorageQuery,
    buildTableTriggersQuery,
    buildTypeGroupsQuery,
    buildViewSourceSearchQuery,
    buildViewDefinitionQuery,
    mapRoutineObjectType,
    buildListPartitionsQuery,
    buildListIndexesDetailedQuery,
    buildIndexColumnsDetailedQuery,
    buildIsPartitionedQuery
} from '../../extensions/db2/src/db2SystemQueries';

function compactSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

describe('db2SystemQueries', () => {
    it('builds DB2 database, schema, table, and view listings with federated table-like types', () => {
        const databasesQuery = compactSql(buildListDatabasesQuery());
        const schemasQuery = compactSql(buildListSchemasQuery());
        const tablesQuery = compactSql(buildListTablesQuery('DB2INST1'));
        const viewsQuery = compactSql(buildListViewsQuery('DB2INST1'));
        const typeGroupsQuery = compactSql(buildTypeGroupsQuery());

        expect(databasesQuery).toContain('CURRENT SERVER AS DATABASE');
        expect(databasesQuery).toContain('FROM SYSIBM.SYSDUMMY1');

        expect(schemasQuery).toContain('FROM SYSCAT.SCHEMATA');
        expect(schemasQuery).toContain('ORDER BY SCHEMANAME');

        expect(tablesQuery).toContain(`TYPE IN ('T', 'N', 'A')`);
        expect(tablesQuery).toContain(`AND TABSCHEMA = 'DB2INST1'`);
        expect(tablesQuery).toContain(`WHEN TYPE = 'N' THEN 'NICKNAME'`);
        expect(tablesQuery).toContain(`WHEN TYPE = 'A' THEN 'ALIAS'`);

        expect(viewsQuery).toContain(`TYPE = 'V'`);
        expect(viewsQuery).toContain(`AND TABSCHEMA = 'DB2INST1'`);

        expect(typeGroupsQuery).toContain(`SELECT 'NICKNAME' AS OBJTYPE FROM SYSIBM.SYSDUMMY1`);
        expect(typeGroupsQuery).toContain(`UNION ALL SELECT 'PASSTHRU AUTH' AS OBJTYPE FROM SYSIBM.SYSDUMMY1`);
    });

    it('builds DB2 column metadata helpers with database selection, table-like filters, and key flags', () => {
        const columnsQuery = compactSql(buildColumnsWithKeysQuery('TESTDB', 'DB2INST1', 'EMP', ['TABLE', 'NICKNAME']));
        const tableColumnsQuery = compactSql(buildTableColumnsQuery('DB2INST1', 'EMP'));
        const metadataQuery = compactSql(buildColumnMetadataQuery('DB2INST1', 'EMP'));

        expect(columnsQuery).toContain(`'TESTDB' AS DATABASE`);
        expect(columnsQuery).toContain(`T.TYPE IN ('T', 'N')`);
        expect(columnsQuery).toContain(`AND C.TABSCHEMA = 'DB2INST1'`);
        expect(columnsQuery).toContain(`AND C.TABNAME = 'EMP'`);
        expect(columnsQuery).toContain('CASE WHEN PK.COLNAME IS NULL THEN 0 ELSE 1 END AS IS_PK');
        expect(columnsQuery).toContain('CASE WHEN FK.COLNAME IS NULL THEN 0 ELSE 1 END AS IS_FK');

        expect(tableColumnsQuery).toContain('AS ATTNOTNULL');
        expect(tableColumnsQuery).toContain('AS FULL_TYPE');
        expect(tableColumnsQuery).toContain(`C.TABSCHEMA = 'DB2INST1'`);
        expect(tableColumnsQuery).toContain(`C.TABNAME = 'EMP'`);

        expect(metadataQuery).toContain('AS IS_NOT_NULL');
        expect(metadataQuery).toContain('AS IS_PK');
        expect(metadataQuery).toContain('AS IS_FK');
    });

    it('builds DB2 federated definition and lookup helpers for aliases, nicknames, comments, owners, and schema resolution', () => {
        const aliasQuery = compactSql(buildAliasDefinitionQuery('DB2INST1', 'EMP_ALIAS'));
        const nicknameQuery = compactSql(buildNicknameDefinitionQuery('DB2INST1', 'REMOTE_EMP'));
        const commentQuery = compactSql(buildTableCommentQuery('DB2INST1', 'EMP'));
        const ownerQuery = compactSql(buildTableOwnerQuery('DB2INST1', 'EMP'));
        const findSchemaQuery = compactSql(buildFindTableSchemaQuery('EMP'));

        expect(aliasQuery).toContain('FROM SYSCAT.TABLES');
        expect(aliasQuery).toContain(`TYPE = 'A'`);
        expect(aliasQuery).toContain(`TABSCHEMA = 'DB2INST1'`);
        expect(aliasQuery).toContain(`TABNAME = 'EMP_ALIAS'`);

        expect(nicknameQuery).toContain('FROM SYSCAT.NICKNAMES');
        expect(nicknameQuery).toContain(`TABSCHEMA = 'DB2INST1'`);
        expect(nicknameQuery).toContain(`TABNAME = 'REMOTE_EMP'`);

        expect(commentQuery).toContain(`SELECT COALESCE(REMARKS, '') AS DESCRIPTION`);
        expect(ownerQuery).toContain(`SELECT RTRIM(OWNER) AS OWNER`);

        expect(findSchemaQuery).toContain(`TYPE IN ('T', 'N', 'A')`);
        expect(findSchemaQuery).toContain(`TABNAME = 'EMP'`);
    });

    it('builds nickname server context query for Netezza federation DDL normalization', () => {
        const serverContextQuery = compactSql(buildNicknameServerContextQuery('NZ_SERVER'));

        expect(serverContextQuery).toContain('FROM SYSCAT.SERVERS S');
        expect(serverContextQuery).toContain('LEFT JOIN SYSCAT.WRAPPERS W');
        expect(serverContextQuery).toContain(`S.SERVERNAME = 'NZ_SERVER'`);
        expect(serverContextQuery).toContain(`UO."OPTION" = 'REMOTE_AUTHID'`);
        expect(serverContextQuery).toContain(`SO."OPTION" IN ('DRIVER_CLASS', 'URL')`);
        expect(serverContextQuery).toContain(`LIKE '%NETEZZA%'`);
    });

    it('resolves Netezza nickname remote schema when catalog REMOTE_SCHEMA is empty', () => {
        expect(resolveNicknameRemoteSchema('ADMIN', { WRAPTYPE: 'NETEZZA' })).toBe('ADMIN');
        expect(resolveNicknameRemoteSchema('', { WRAPTYPE: 'NETEZZA', REMOTE_AUTHID: 'APP_USER' })).toBe('APP_USER');
        expect(resolveNicknameRemoteSchema(undefined, { WRAPTYPE: 'NETEZZA' })).toBe('ADMIN');
        expect(resolveNicknameRemoteSchema('   ', { WRAPTYPE: 'JDBC', HAS_NETEZZA_OPTION: 1 })).toBe('ADMIN');
        expect(resolveNicknameRemoteSchema('', { WRAPTYPE: 'JDBC', HAS_NETEZZA_OPTION: 1, REMOTE_AUTHID: 'NZ_USER' })).toBe('NZ_USER');
        expect(resolveNicknameRemoteSchema('', { WRAPTYPE: 'ODBC' })).toBeUndefined();
        expect(resolveNicknameRemoteSchema('', undefined)).toBeUndefined();
        expect(isNetezzaFederatedServer({ WRAPTYPE: 'NETEZZA' })).toBe(true);
        expect(isNetezzaFederatedServer({ WRAPTYPE: 'JDBC', HAS_NETEZZA_OPTION: 1 })).toBe(true);
        expect(isNetezzaFederatedServer({ WRAPTYPE: 'DB2' })).toBe(false);
    });

    it('builds DB2 routine listings and overload-safe procedure definitions', () => {
        const proceduresQuery = compactSql(buildListProceduresQuery('DB2INST1'));
        const procedureDefinitionQuery = compactSql(buildProcedureDefinitionQuery('DB2INST1', 'DO_WORK(INTEGER)'));
        const procedureObjectQuery = compactSql(buildObjectTypeQuery('PROCEDURE', 'TESTDB'));
        const batchQuery = compactSql(buildBatchObjectListQuery('DB2INST1', ['NICKNAME', 'ALIAS', 'FUNCTION']));

        expect(proceduresQuery).toContain('WITH ROUTINE_SIGNATURES AS');
        expect(proceduresQuery).toContain('PROCEDURESIGNATURE');
        expect(proceduresQuery).toContain(`R.ROUTINETYPE = 'P'`);
        expect(proceduresQuery).toContain(`R.ROUTINESCHEMA = 'DB2INST1'`);

        expect(procedureDefinitionQuery).toContain('WITH ROUTINE_SIGNATURES AS');
        expect(procedureDefinitionQuery).toContain('AS PROCEDURE_SIGNATURE');
        expect(procedureDefinitionQuery).toContain(`R.ROUTINETYPE = 'P'`);
        expect(procedureDefinitionQuery).toContain(`RTRIM(R.ROUTINESCHEMA) = 'DB2INST1'`);
        expect(procedureDefinitionQuery).toContain(`OR RTRIM(R.ROUTINENAME) = 'DO_WORK'`);

        expect(procedureObjectQuery).toContain(`'TESTDB' AS DATABASE`);
        expect(procedureObjectQuery).toContain('WITH ROUTINE_SIGNATURES AS');

        expect(batchQuery).toContain(`TYPE IN ('N', 'A')`);
        expect(batchQuery).toContain(`CASE WHEN R.ROUTINETYPE = 'F' THEN 'FUNCTION' ELSE 'PROCEDURE' END AS OBJECT_TYPE`);
        expect(batchQuery).toContain(`R.ROUTINETYPE IN ('F')`);
    });

    it('builds DB2 DDL-supporting helpers for keys, storage, partitions, indexes, triggers, views, and ddl extraction', () => {
        const keysInfoQuery = compactSql(buildKeysInfoQuery('DB2INST1', 'EMP'));
        const statsQuery = compactSql(buildTableStatsQuery('DB2INST1', 'EMP'));
        const storageQuery = compactSql(buildTableStorageQuery('DB2INST1', 'EMP'));
        const indexesQuery = compactSql(buildTableIndexesQuery('DB2INST1', 'EMP'));
        const partitionExpressionsQuery = compactSql(buildTablePartitionExpressionsQuery('DB2INST1', 'EMP'));
        const partitionsQuery = compactSql(buildTablePartitionsQuery('DB2INST1', 'EMP'));
        const hashDistributionQuery = compactSql(buildTableHashDistributionQuery('DB2INST1', 'EMP'));
        const triggersQuery = compactSql(buildTableTriggersQuery('DB2INST1', 'EMP'));
        const viewDefinitionQuery = compactSql(buildViewDefinitionQuery('DB2INST1', 'EMP_V'));
        const ddlQuery = compactSql(buildDdlQuery('FUNCTION', 'DO_WORK', 'DB2INST1'));
        
        // New maintenance queries
        const listPartitionsQuery = compactSql(buildListPartitionsQuery('DB2INST1', 'EMP'));
        const listIndexesDetailedQuery = compactSql(buildListIndexesDetailedQuery('DB2INST1', 'EMP'));
        const indexColumnsDetailedQuery = compactSql(buildIndexColumnsDetailedQuery('DB2INST1', 'EMP_IDX'));
        const isPartitionedQuery = compactSql(buildIsPartitionedQuery('DB2INST1', 'EMP'));

        expect(listPartitionsQuery).toContain('FROM SYSCAT.DATAPARTITIONS P');
        expect(listIndexesDetailedQuery).toContain('FROM SYSCAT.INDEXES I');
        expect(indexColumnsDetailedQuery).toContain('FROM SYSCAT.INDEXCOLUSE');
        expect(isPartitionedQuery).toContain('SELECT COUNT(*) AS PARTITION_COUNT FROM SYSCAT.DATAPARTITIONS');

        expect(keysInfoQuery).toContain(`TC.TYPE IN ('P', 'U', 'F')`);
        expect(keysInfoQuery).toContain('LEFT JOIN SYSCAT.REFERENCES R');

        expect(statsQuery).toContain('CARD');
        expect(statsQuery).toContain('STATS_TIME');

        expect(storageQuery).toContain('TABLEORG');
        expect(storageQuery).toContain('TBSPACE');

        expect(indexesQuery).toContain('FROM SYSCAT.INDEXES I');
        expect(indexesQuery).toContain(`I.INDEXTYPE5 IN ('REG', 'CLUS')`);

        expect(partitionExpressionsQuery).toContain('FROM SYSCAT.DATAPARTITIONEXPRESSION');
        expect(partitionsQuery).toContain('FROM SYSCAT.DATAPARTITIONS P');
        expect(hashDistributionQuery).toContain('COALESCE(PARTKEYSEQ, 0) > 0');

        expect(triggersQuery).toContain('FROM SYSCAT.TRIGGERS');
        expect(viewDefinitionQuery).toContain('FROM SYSCAT.VIEWS');

        expect(ddlQuery).toContain(`DBMS_METADATA.GET_DDL('FUNCTION', 'DO_WORK', 'DB2INST1')`);

        expect(mapRoutineObjectType('f')).toBe('FUNCTION');
        expect(mapRoutineObjectType('p')).toBe('PROCEDURE');
    });

    it('builds DB2 object and source search queries for the search contract', () => {
        const objectSearchQuery = compactSql(buildObjectSearchQuery('TESTDB', '%CUSTOMER%'));
        const serverFilteredViewSourceQuery = compactSql(buildViewSourceSearchQuery('TESTDB', {
            rawTerm: 'products',
            likePattern: '%PRODUCTS%',
            useServerSideFilter: true
        }));
        const inMemoryProcedureSourceQuery = compactSql(buildProcedureSourceSearchQuery('TESTDB', {
            rawTerm: 'products',
            likePattern: '%PRODUCTS%',
            useServerSideFilter: false
        }));

        expect(objectSearchQuery).toContain(`'COLUMN' AS TYPE`);
        expect(objectSearchQuery).toContain(`INT(COALESCE(T.TABLEID, 0)) AS OBJID`);
        expect(objectSearchQuery).toContain(`'OBJ_DESC' AS MATCH_TYPE`);
        expect(objectSearchQuery).toContain(`'COL_DESC' AS MATCH_TYPE`);
        expect(objectSearchQuery).toContain(`FETCH FIRST 200 ROWS ONLY`);

        expect(serverFilteredViewSourceQuery).toContain(`REGEXP_LIKE(TEXT, 'products', 'i')`);
        expect(serverFilteredViewSourceQuery).toContain('FROM SYSCAT.VIEWS');

        expect(inMemoryProcedureSourceQuery).toContain('FROM SYSCAT.ROUTINES');
        expect(inMemoryProcedureSourceQuery).toContain(`CASE WHEN ROUTINETYPE = 'F' THEN 'FUNCTION' ELSE 'PROCEDURE' END AS TYPE`);
        expect(inMemoryProcedureSourceQuery).toContain(`ROUTINETYPE IN ('P', 'F')`);
        expect(inMemoryProcedureSourceQuery).toContain('COALESCE(TEXT, \'\') AS SOURCE');
    });
});
