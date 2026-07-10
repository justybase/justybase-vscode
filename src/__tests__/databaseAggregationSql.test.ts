import { buildDatabaseAggregationSql } from '../results/databaseAggregationSql';

describe('databaseAggregationSql', () => {
    it('builds one aliased aggregate query without the trailing LIMIT', () => {
        const built = buildDatabaseAggregationSql(
            'WITH c AS (SELECT * FROM T) SELECT amount, dt FROM c LIMIT 10;',
            [
                { name: 'AMOUNT', type: 'NUMERIC' },
                { name: 'DT', type: 'DATE' },
            ],
            [
                { columnIndex: 0, fn: 'sum' },
                { columnIndex: 0, fn: 'median' },
                { columnIndex: 1, fn: 'max' },
            ],
        );

        expect(built.sql).toContain('SUM(t."AMOUNT") AS "agg_0_sum"');
        expect(built.sql).toContain('MEDIAN(t."AMOUNT") AS "agg_0_median"');
        expect(built.sql).toContain('MAX(t."DT") AS "agg_1_max"');
        expect(built.sql).toContain('FROM (\nWITH c AS (SELECT * FROM T) SELECT amount, dt FROM c\n) t');
        expect(built.aliases).toEqual([
            { alias: 'agg_0_sum', columnIndex: 0, fn: 'sum' },
            { alias: 'agg_0_median', columnIndex: 0, fn: 'median' },
            { alias: 'agg_1_max', columnIndex: 1, fn: 'max' },
        ]);
    });

    it('rejects result columns without stable unique names', () => {
        expect(() => buildDatabaseAggregationSql(
            'SELECT 1 LIMIT 10',
            [{ name: '?COLUMN?', type: 'INTEGER' }],
            [{ columnIndex: 0, fn: 'sum' }],
        )).toThrow('stable, unique column names');
    });
});
