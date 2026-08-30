import { describe, expect, it } from '@jest/globals';
import {
    areMysqlIdentifiersEqual,
    buildMysqlAddHashKeyPartitionSql,
    buildMysqlAddRangeListPartitionSql,
    buildMysqlCoalescePartitionSql,
    buildMysqlCreateIndexSql,
    buildMysqlDropIndexSql,
    buildMysqlDropPartitionSql,
} from '../../../../extensions/mysql/src/mysqlDesignerDdl';

describe('MySQL designer DDL', () => {
    it('builds a standard or UNIQUE index with ordered key columns', () => {
        expect(buildMysqlCreateIndexSql({
            schema: 'sales',
            tableName: 'orders',
            indexName: 'orders status idx',
            keyColumns: [
                { name: 'created_at', order: 'DESC' },
                { name: 'order', order: 'ASC' },
            ],
            unique: true,
            allowDescending: true,
        })).toBe(
            'CREATE UNIQUE INDEX `orders status idx` ON sales.orders (created_at DESC, `order` ASC);',
        );
    });

    it('rejects unsupported descending keys and duplicate columns', () => {
        expect(() => buildMysqlCreateIndexSql({
            schema: 'sales',
            tableName: 'orders',
            indexName: 'orders_created_idx',
            keyColumns: [{ name: 'created_at', order: 'DESC' }],
        })).toThrow('Descending indexes are not supported');

        expect(() => buildMysqlCreateIndexSql({
            schema: 'sales',
            tableName: 'orders',
            indexName: 'orders_duplicate_idx',
            keyColumns: [
                { name: 'id', order: 'ASC' },
                { name: 'ID', order: 'DESC' },
            ],
            allowDescending: true,
        })).toThrow('can only be selected once');
    });

    it('builds and safely quotes index removal', () => {
        expect(buildMysqlDropIndexSql('sales', 'orders', 'orders status idx')).toBe(
            'DROP INDEX `orders status idx` ON sales.orders;',
        );
        expect(areMysqlIdentifiersEqual('`Orders_Status`', 'orders_status')).toBe(true);
    });

    it('builds RANGE/LIST and HASH/KEY partition operations', () => {
        expect(buildMysqlAddRangeListPartitionSql({
            schema: 'sales',
            tableName: 'orders',
            partitionName: 'p2027',
            valuesClause: "VALUES LESS THAN ('2027-01-01')",
            method: 'RANGE',
        })).toBe(
            "ALTER TABLE sales.orders ADD PARTITION (PARTITION p2027 VALUES LESS THAN ('2027-01-01'));",
        );
        expect(buildMysqlAddRangeListPartitionSql({
            schema: 'sales',
            tableName: 'orders',
            partitionName: 'pmax',
            valuesClause: 'VALUES LESS THAN MAXVALUE',
            method: 'RANGE',
        })).toBe(
            'ALTER TABLE sales.orders ADD PARTITION (PARTITION pmax VALUES LESS THAN MAXVALUE);',
        );
        expect(buildMysqlAddRangeListPartitionSql({
            schema: 'sales',
            tableName: 'orders',
            partitionName: 'p_eu',
            valuesClause: "VALUES IN ('DE', 'PL')",
            method: 'LIST',
        })).toBe(
            "ALTER TABLE sales.orders ADD PARTITION (PARTITION p_eu VALUES IN ('DE', 'PL'));",
        );
        expect(buildMysqlAddHashKeyPartitionSql({
            schema: 'sales',
            tableName: 'orders',
            partitionCount: 2,
        })).toBe('ALTER TABLE sales.orders ADD PARTITION PARTITIONS 2;');
        expect(buildMysqlDropPartitionSql({
            schema: 'sales',
            tableName: 'orders',
            partitionName: 'p2026',
        })).toBe('ALTER TABLE sales.orders DROP PARTITION p2026;');
        expect(buildMysqlCoalescePartitionSql({
            schema: 'sales',
            tableName: 'orders',
            partitionCount: 1,
        })).toBe('ALTER TABLE sales.orders COALESCE PARTITION 1;');
    });

    it('rejects malformed partition clauses and invalid counts', () => {
        expect(() => buildMysqlAddRangeListPartitionSql({
            schema: 'sales',
            tableName: 'orders',
            partitionName: 'p_bad',
            valuesClause: 'VALUES LESS THAN (1); DROP TABLE orders',
            method: 'RANGE',
        })).toThrow('statement separators or comments');
        expect(() => buildMysqlAddRangeListPartitionSql({
            schema: 'sales',
            tableName: 'orders',
            partitionName: 'p_bad',
            valuesClause: 'VALUES IN (1)',
            method: 'RANGE',
        })).toThrow('VALUES LESS THAN');
        expect(() => buildMysqlAddRangeListPartitionSql({
            schema: 'sales',
            tableName: 'orders',
            partitionName: 'p_bad',
            valuesClause: 'VALUES LESS THAN (1), PARTITION p2 VALUES LESS THAN (2)',
            method: 'RANGE',
        })).toThrow('VALUES LESS THAN');
        expect(() => buildMysqlCoalescePartitionSql({
            schema: 'sales',
            tableName: 'orders',
            partitionCount: 0,
        })).toThrow('positive integer');
    });
});
