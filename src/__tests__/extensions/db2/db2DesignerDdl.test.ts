import {
    buildDb2AddPartitionSql,
    buildDb2AttachPartitionSql,
    buildDb2CreateIndexSql,
    buildDb2DetachPartitionSql,
    buildDb2DropPartitionSql,
    buildDb2SetIntegritySql
} from '../../../../extensions/db2/src/db2DesignerDdl';

describe('Db2 designer DDL', () => {
    it('builds a Db2 index using supported common and advanced options', () => {
        expect(buildDb2CreateIndexSql({
            schema: 'ADMIN',
            tableName: 'SALES',
            indexName: 'SALES_ORDER_IDX',
            keyColumns: [
                { name: 'ORDER_DATE', order: 'DESC' },
                { name: 'CUSTOMER_ID', order: 'ASC' }
            ],
            includeColumns: ['STATUS'],
            unique: true,
            clustered: true,
            reverseScans: 'allow',
            compress: 'yes',
            pctFree: 10,
            level2PctFree: 5,
            minPctUsed: 25,
            pageSplit: 'symmetric',
            collectStatistics: 'sampled',
            tablespace: 'IDXSPACE'
        })).toBe(
            'CREATE UNIQUE INDEX ADMIN.SALES_ORDER_IDX ON ADMIN.SALES (ORDER_DATE DESC, CUSTOMER_ID) INCLUDE (STATUS) PCTFREE 10 LEVEL2 PCTFREE 5 MINPCTUSED 25 ALLOW REVERSE SCANS PAGE SPLIT SYMMETRIC COLLECT SAMPLED DETAILED STATISTICS COMPRESS YES IN IDXSPACE CLUSTER;'
        );
    });

    it('quotes mixed-case identifiers and prevents indexes without keys', () => {
        expect(buildDb2CreateIndexSql({
            schema: 'app',
            tableName: 'Order',
            indexName: 'order created idx',
            keyColumns: [{ name: 'createdAt', order: 'ASC' }],
            compress: 'no'
        })).toBe(
            'CREATE INDEX "app"."order created idx" ON "app"."Order" ("createdAt") COMPRESS NO;'
        );
        expect(() => buildDb2CreateIndexSql({
            schema: 'ADMIN',
            tableName: 'SALES',
            indexName: 'EMPTY_IDX',
            keyColumns: []
        })).toThrow('Select at least one key column.');
    });

    it('builds add and attach partition statements with boundary and tablespace options', () => {
        const range = {
            partitionName: 'P_2025_01',
            startingFrom: "('2025-01-01')",
            startingInclusive: true,
            endingAt: "('2025-02-01')",
            endingInclusive: false,
            tablespace: 'DATA_TS',
            indexTablespace: 'INDEX_TS',
            longTablespace: 'LONG_TS'
        };

        expect(buildDb2AddPartitionSql({
            schema: 'ADMIN',
            tableName: 'SALES',
            ...range
        })).toBe(
            "ALTER TABLE ADMIN.SALES ADD PARTITION P_2025_01 STARTING FROM ('2025-01-01') INCLUSIVE ENDING AT ('2025-02-01') EXCLUSIVE IN DATA_TS INDEX IN INDEX_TS LONG IN LONG_TS;"
        );
        expect(buildDb2AttachPartitionSql({
            schema: 'ADMIN',
            tableName: 'SALES',
            sourceSchema: 'STAGE',
            sourceTable: 'SALES_2025_01',
            partitionName: range.partitionName,
            startingFrom: range.startingFrom,
            startingInclusive: range.startingInclusive,
            endingAt: range.endingAt,
            endingInclusive: range.endingInclusive
        })).toBe(
            "ALTER TABLE ADMIN.SALES ATTACH PARTITION P_2025_01 STARTING FROM ('2025-01-01') INCLUSIVE ENDING AT ('2025-02-01') EXCLUSIVE FROM TABLE STAGE.SALES_2025_01;"
        );
        expect(buildDb2SetIntegritySql('ADMIN', 'SALES')).toBe(
            'SET INTEGRITY FOR ADMIN.SALES IMMEDIATE CHECKED;'
        );
    });

    it('builds a safe detach then drop script for destructive partition removal', () => {
        const options = {
            schema: 'ADMIN',
            tableName: 'SALES',
            partitionName: 'P_2024_12',
            detachedSchema: 'ADMIN',
            detachedTable: 'SALES_P_2024_12_DETACHED'
        };
        expect(buildDb2DetachPartitionSql(options)).toBe(
            'ALTER TABLE ADMIN.SALES DETACH PARTITION P_2024_12 INTO ADMIN.SALES_P_2024_12_DETACHED;'
        );
        expect(buildDb2DropPartitionSql(options)).toEqual([
            'ALTER TABLE ADMIN.SALES DETACH PARTITION P_2024_12 INTO ADMIN.SALES_P_2024_12_DETACHED;',
            'DROP TABLE ADMIN.SALES_P_2024_12_DETACHED;'
        ]);
    });
});
