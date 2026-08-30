import { describe, expect, it } from '@jest/globals';
import type { DatabaseMaintenanceServices, DatabaseMaintenanceTarget } from '@justybase/contracts';
import {
    loadMysqlIndexDesignerContext,
    loadMysqlPartitionDesignerContext,
} from '../../../../extensions/mysql/src/mysqlDesignerOperations';

const target: DatabaseMaintenanceTarget = {
    connectionName: 'mysql-test',
    databaseName: 'sales',
    schemaName: 'sales',
    tableName: 'orders',
    qualifiedName: 'sales.orders',
};

function createServices(rows: {
    properties?: Record<string, unknown>;
    columns?: Array<Record<string, unknown>>;
    indexes?: Array<Record<string, unknown>>;
    partitions?: Array<Record<string, unknown>>;
}): DatabaseMaintenanceServices {
    return {
        context: {},
        executeSql: jest.fn(),
        getConnectionDetails: jest.fn(),
        openSqlDocument: jest.fn(),
        executeWithProgress: jest.fn(),
        executeAndReport: jest.fn(),
        executeQuery: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('information_schema.tables')) {
                return Promise.resolve(rows.properties ? [rows.properties] : []);
            }
            if (sql.includes('information_schema.columns')) {
                return Promise.resolve(rows.columns ?? []);
            }
            if (sql.includes('information_schema.statistics')) {
                return Promise.resolve(rows.indexes ?? []);
            }
            if (sql.includes('information_schema.partitions')) {
                return Promise.resolve(rows.partitions ?? []);
            }
            return Promise.resolve([]);
        }),
    };
}

const columns = [
    { ATTNAME: 'id', FORMAT_TYPE: 'bigint', IS_NOT_NULL: 1, IS_PK: 1, ATTNUM: 1 },
    { ATTNAME: 'created_at', FORMAT_TYPE: 'datetime', IS_NOT_NULL: 1, IS_PK: 0, ATTNUM: 2 },
    { ATTNAME: 'status', FORMAT_TYPE: 'varchar(20)', IS_NOT_NULL: 0, IS_PK: 0, ATTNUM: 3 },
];

describe('MySQL designer metadata operations', () => {
    it('loads and groups MySQL index metadata, including prefix and visibility details', async () => {
        const services = createServices({
            properties: { ENGINE: 'InnoDB', SERVER_VERSION: '8.0.36' },
            columns: [...columns, { ATTNAME: 'id', FORMAT_TYPE: 'bigint', IS_NOT_NULL: 1, IS_PK: 0, IS_FK: 1, ATTNUM: 1 }],
            indexes: [
                {
                    INDEX_NAME: 'PRIMARY', SEQ_IN_INDEX: 1, COLUMN_NAME: 'id',
                    COLLATION: 'A', NON_UNIQUE: 0, INDEX_TYPE: 'BTREE', CARDINALITY: 3, IS_VISIBLE: 'YES',
                },
                {
                    INDEX_NAME: 'orders_status_idx', SEQ_IN_INDEX: 1, COLUMN_NAME: 'status',
                    COLLATION: 'D', SUB_PART: 8, NON_UNIQUE: 1, INDEX_TYPE: 'BTREE', CARDINALITY: 2, IS_VISIBLE: 'NO',
                },
            ],
        });

        const context = await loadMysqlIndexDesignerContext(target, services);

        expect(context.supportsDescendingIndexes).toBe(true);
        expect(context.columns.map(column => column.name)).toEqual(['id', 'created_at', 'status']);
        expect(context.columns[0]?.isForeignKey).toBe(true);
        expect(context.existingIndexes).toEqual([
            expect.objectContaining({ name: 'PRIMARY', isPrimary: true, isUnique: true }),
            expect.objectContaining({
                name: 'orders_status_idx',
                isVisible: false,
                parts: [{ name: 'status', expression: undefined, order: 'DESC', prefixLength: 8 }],
            }),
        ]);
    });

    it('keeps descending keys available across MySQL 8.0 InnoDB patch levels', async () => {
        const context = await loadMysqlIndexDesignerContext(target, createServices({
            properties: { ENGINE: 'InnoDB', SERVER_VERSION: '8.0.1' },
            columns,
        }));

        expect(context.supportsDescendingIndexes).toBe(true);
    });

    it('gates RANGE/LIST operations when MAXVALUE would require REORGANIZE', async () => {
        const services = createServices({
            properties: { ENGINE: 'InnoDB', SERVER_VERSION: '8.0.36' },
            columns,
            partitions: [
                {
                    PARTITION_NAME: 'p2026', PARTITION_ORDINAL_POSITION: 1,
                    PARTITION_METHOD: 'RANGE', PARTITION_EXPRESSION: 'YEAR(created_at)',
                    PARTITION_DESCRIPTION: '2026', TABLE_ROWS: 12,
                },
                {
                    PARTITION_NAME: 'pmax', PARTITION_ORDINAL_POSITION: 2,
                    PARTITION_METHOD: 'RANGE', PARTITION_EXPRESSION: 'YEAR(created_at)',
                    PARTITION_DESCRIPTION: 'MAXVALUE', TABLE_ROWS: 4,
                },
            ],
        });

        const context = await loadMysqlPartitionDesignerContext(target, services);

        expect(context.capabilities).toEqual(expect.objectContaining({
            isPartitioned: true,
            partitionMethod: 'RANGE',
            canAddPartition: false,
            canDropPartition: true,
            dropMode: 'named',
        }));
        expect(context.capabilities.reason).toContain('REORGANIZE PARTITION');
        expect(context.partitions).toHaveLength(2);
    });

    it('normalizes RANGE/LIST COLUMNS methods from information_schema', async () => {
        const context = await loadMysqlPartitionDesignerContext(target, createServices({
            properties: { ENGINE: 'InnoDB', SERVER_VERSION: '8.0.36' },
            columns,
            partitions: [{
                PARTITION_NAME: 'p0', PARTITION_ORDINAL_POSITION: 1,
                PARTITION_METHOD: 'RANGE COLUMNS', PARTITION_EXPRESSION: '`created_at`',
                PARTITION_DESCRIPTION: "'2027-01-01'",
            }],
        }));

        expect(context.capabilities.partitionMethod).toBe('RANGE');
        expect(context.capabilities.canAddPartition).toBe(true);
    });

    it('exposes HASH/KEY count operations and disables partition drops for NDB', async () => {
        const hashRows = [
            { PARTITION_NAME: 'p0', PARTITION_ORDINAL_POSITION: 1, PARTITION_METHOD: 'HASH', PARTITION_EXPRESSION: 'id', PARTITION_DESCRIPTION: '0' },
            { PARTITION_NAME: 'p1', PARTITION_ORDINAL_POSITION: 2, PARTITION_METHOD: 'HASH', PARTITION_EXPRESSION: 'id', PARTITION_DESCRIPTION: '1' },
        ];
        const hashContext = await loadMysqlPartitionDesignerContext(target, createServices({
            properties: { ENGINE: 'InnoDB', SERVER_VERSION: '8.0.36' },
            columns,
            partitions: hashRows,
        }));
        expect(hashContext.capabilities).toEqual(expect.objectContaining({
            partitionMethod: 'HASH',
            canAddPartition: true,
            canDropPartition: true,
            dropMode: 'coalesce',
        }));

        const ndbContext = await loadMysqlPartitionDesignerContext(target, createServices({
            properties: { ENGINE: 'NDB', SERVER_VERSION: '8.0.36' },
            columns,
            partitions: hashRows,
        }));
        expect(ndbContext.capabilities).toEqual(expect.objectContaining({
            canDropPartition: false,
            dropMode: 'none',
        }));
        expect(ndbContext.capabilities.reason).toContain('NDB');
    });

    it('marks non-partitioned tables read-only instead of offering conversion DDL', async () => {
        const context = await loadMysqlPartitionDesignerContext(target, createServices({
            properties: { ENGINE: 'InnoDB', SERVER_VERSION: '8.0.36' },
            columns,
            partitions: [{ PARTITION_NAME: null, PARTITION_METHOD: null }],
        }));

        expect(context.partitions).toEqual([]);
        expect(context.capabilities).toEqual(expect.objectContaining({
            isPartitioned: false,
            canAddPartition: false,
            canDropPartition: false,
            dropMode: 'none',
        }));
        expect(context.capabilities.reason).toContain('not partitioned');
    });
});
