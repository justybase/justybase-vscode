import {
    buildDistinctValuesSql,
    buildExplorePivotSql,
} from '../../../src/results/explore/pivotSqlBuilder';

const COLUMNS = [
    { name: 'REGION', type: 'VARCHAR(20)' },
    { name: 'CATEGORY', type: 'VARCHAR(20)' },
    { name: 'AMOUNT', type: 'DECIMAL(10,2)' },
    { name: 'QTY', type: 'INT' },
];

describe('pivotSqlBuilder', () => {
    it('builds a distinct values query for the pivot column', () => {
        const sql = buildDistinctValuesSql(
            'SELECT * FROM SALES LIMIT 100',
            COLUMNS,
            { columnIndex: 1 },
            undefined,
            'netezza',
            50,
        );
        expect(sql).toContain('SELECT DISTINCT t."CATEGORY" AS "PIVOT_VALUE"');
        expect(sql).toContain('LIMIT 50');
        expect(sql).not.toContain('SELECT * FROM SALES LIMIT 100');
    });

    it('builds CASE-based pivot columns with grouping', () => {
        const built = buildExplorePivotSql(
            'SELECT * FROM SALES',
            COLUMNS,
            {
                rowColumnIndexes: [0],
                columnColumnIndex: 1,
                valueColumnIndex: 2,
                aggFn: 'sum',
            },
            ['A', "B's"],
            'netezza',
        );
        expect(built.sql).toContain('t."REGION" AS "REGION"');
        expect(built.sql).toContain('SUM(CASE WHEN t."CATEGORY" = \'A\' THEN t."AMOUNT" END) AS "V: A"');
        expect(built.sql).toContain('SUM(CASE WHEN t."CATEGORY" = \'B\'\'s\' THEN t."AMOUNT" END)');
        expect(built.sql).toContain('GROUP BY t."REGION"');
        expect(built.sql).toContain('LIMIT 5000');
        expect(built.pivotColumnNames).toEqual(['A', "B's"]);
    });

    it('supports count and countDistinct aggregates', () => {
        const countBuilt = buildExplorePivotSql(
            'SELECT * FROM SALES',
            COLUMNS,
            { rowColumnIndexes: [0], columnColumnIndex: 1, valueColumnIndex: 2, aggFn: 'count' },
            ['A'],
            'netezza',
        );
        expect(countBuilt.sql).toContain('COUNT(CASE WHEN t."CATEGORY" = \'A\' THEN 1 END)');

        const distinctBuilt = buildExplorePivotSql(
            'SELECT * FROM SALES',
            COLUMNS,
            { rowColumnIndexes: [0], columnColumnIndex: 1, valueColumnIndex: 2, aggFn: 'countDistinct' },
            ['A'],
            'netezza',
        );
        expect(distinctBuilt.sql).toContain('COUNT(DISTINCT CASE WHEN t."CATEGORY" = \'A\' THEN t."AMOUNT" END)');
    });

    it('uses backticks for MySQL identifiers', () => {
        const built = buildExplorePivotSql(
            'SELECT * FROM SALES',
            COLUMNS,
            { rowColumnIndexes: [0], columnColumnIndex: 1, valueColumnIndex: 2, aggFn: 'sum' },
            ['A'],
            'mysql',
        );
        expect(built.sql).toContain('t.`REGION` AS `REGION`');
        expect(built.sql).toContain('t.`CATEGORY` = \'A\'');
    });

    it('composes filters into the pivot query', () => {
        const built = buildExplorePivotSql(
            'SELECT * FROM SALES',
            COLUMNS,
            {
                rowColumnIndexes: [0],
                columnColumnIndex: 1,
                valueColumnIndex: 2,
                aggFn: 'sum',
                filters: { dimensions: [{ columnIndex: 0, values: ['EU'] }], dates: [], measures: [] },
            },
            ['A'],
            'netezza',
        );
        expect(built.sql).toContain('WHERE t."REGION" = \'EU\'');
    });

    it('supports multiple row dimensions and mssql limit style', () => {
        const built = buildExplorePivotSql(
            'SELECT * FROM SALES',
            COLUMNS,
            { rowColumnIndexes: [0, 1], columnColumnIndex: 2, valueColumnIndex: 3, aggFn: 'count' },
            ['1'],
            'mssql',
        );
        expect(built.sql).toContain('GROUP BY t.[REGION], t.[CATEGORY]');
        expect(built.sql).toContain('SELECT TOP 5000 ');
        expect(built.sql).not.toContain('LIMIT');
    });

    it('keeps the distinct-value cap for MSSQL with TOP', () => {
        const sql = buildDistinctValuesSql(
            'SELECT * FROM SALES',
            COLUMNS,
            { columnIndex: 1 },
            undefined,
            'mssql',
            25,
        );
        expect(sql).toContain('SELECT DISTINCT TOP 25 t.[CATEGORY] AS [PIVOT_VALUE]');
        expect(sql).not.toContain('LIMIT');
    });

    it('validates configuration', () => {
        expect(() => buildExplorePivotSql(
            'SELECT * FROM SALES',
            COLUMNS,
            { rowColumnIndexes: [], columnColumnIndex: 1, valueColumnIndex: 2, aggFn: 'sum' },
            ['A'],
            'netezza',
        )).toThrow('At least one row dimension');

        expect(() => buildExplorePivotSql(
            'SELECT * FROM SALES',
            COLUMNS,
            { rowColumnIndexes: [0], columnColumnIndex: 0, valueColumnIndex: 2, aggFn: 'sum' },
            ['A'],
            'netezza',
        )).toThrow('differ from the pivot and value columns');

        expect(() => buildExplorePivotSql(
            'SELECT * FROM SALES',
            COLUMNS,
            { rowColumnIndexes: [0], columnColumnIndex: 1, valueColumnIndex: 2, aggFn: 'bogus' as never },
            ['A'],
            'netezza',
        )).toThrow('Unsupported pivot aggregate');
    });
});
