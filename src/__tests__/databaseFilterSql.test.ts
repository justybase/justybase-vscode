import {
    buildDatabaseDistinctValuesSql,
    buildDatabaseFilteredSql,
} from '../results/databaseFilterSql';

const columns = [
    { name: 'AMOUNT', type: 'NUMERIC' },
    { name: 'CUSTOMER', type: 'VARCHAR' },
    { name: 'CREATED_AT', type: 'DATE' },
];

describe('databaseFilterSql', () => {
    it('wraps refresh SQL without LIMIT and applies WHERE before the original LIMIT', () => {
        const sql = buildDatabaseFilteredSql(
            'WITH c AS (SELECT * FROM T) SELECT amount, customer FROM c LIMIT 10;',
            columns,
            {
                columnFilters: [
                    { columnIndex: 0, conditions: [{ type: 'greaterThan', value: '100' }], conditionLogic: 'and' },
                    { columnIndex: 1, conditions: [{ type: 'contains', value: "O'Reilly" }], conditionLogic: 'and' },
                ],
            },
        );

        expect(sql).toContain('FROM (\nWITH c AS (SELECT * FROM T) SELECT amount, customer FROM c\n) t');
        expect(sql).toContain('WHERE t."AMOUNT" > 100 AND LOWER(CAST(t."CUSTOMER" AS VARCHAR(64000))) LIKE \'%o\'\'reilly%\' ESCAPE');
        expect(sql).toMatch(/LIMIT 10$/);
    });

    it('builds distinct values SQL excluding the active column filter', () => {
        const sql = buildDatabaseDistinctValuesSql(
            'SELECT amount, customer FROM T LIMIT 50',
            columns,
            1,
            {
                columnFilters: [
                    { columnIndex: 0, values: [1, 2] },
                    { columnIndex: 1, values: ['A'] },
                ],
            },
        );

        expect(sql).toContain('SELECT t."CUSTOMER" AS value');
        expect(sql).toContain('WHERE t."AMOUNT" IN (1, 2)');
        expect(sql).not.toContain('CUSTOMER" IN');
        expect(sql).toContain('GROUP BY value');
    });

    it('rejects generated result columns without stable names', () => {
        expect(() => buildDatabaseFilteredSql(
            'SELECT 1 LIMIT 10',
            [{ name: '?COLUMN?', type: 'INTEGER' }],
            { columnFilters: [{ columnIndex: 0, values: [1] }] },
        )).toThrow('stable, unique column names');
    });

    it('uses numeric literals for INT4 value filters', () => {
        const sql = buildDatabaseFilteredSql(
            'SELECT productkey FROM FACTPRODUCTINVENTORY LIMIT 5',
            [{ name: 'PRODUCTKEY', type: 'INT4' }],
            {
                columnFilters: [
                    { columnIndex: 0, values: [5] },
                ],
            },
        );

        expect(sql).toContain('t."PRODUCTKEY" IN (5)');
        expect(sql).not.toContain("IN ('5')");
        expect(sql).toMatch(/LIMIT 5$/);
    });

    it('re-applies database filter on refresh using the updated base LIMIT', () => {
        const sql = buildDatabaseFilteredSql(
            'SELECT * FROM FACTPRODUCTINVENTORY LIMIT 10',
            [{ name: 'PRODUCTKEY', type: 'INT4' }],
            {
                columnFilters: [{ columnIndex: 0, values: [5] }],
            },
        );

        expect(sql).toContain('FROM (\nSELECT * FROM FACTPRODUCTINVENTORY\n) t');
        expect(sql).toContain('WHERE t."PRODUCTKEY" IN (5)');
        expect(sql).toMatch(/LIMIT 10$/);
    });

    it('normalizes grouped numeric literals in comparison filters', () => {
        const sql = buildDatabaseFilteredSql(
            'SELECT datekey FROM FACT LIMIT 100',
            [{ name: 'DATEKEY', type: 'INT4' }],
            {
                columnFilters: [
                    { columnIndex: 0, conditions: [{ type: 'greaterThan', value: '2010 12 28' }], conditionLogic: 'and' },
                ],
            },
        );

        expect(sql).toContain('t."DATEKEY" > 20101228');
        expect(sql).not.toContain("'2010 12 28'");
    });

    describe('temporal column filtering', () => {
        const tsColumns = [
            { name: 'ID', type: 'INT4' },
            { name: 'TS_COL', type: 'TIMESTAMP' },
            { name: 'TS_TZ_COL', type: 'TIMESTAMPTZ' },
            { name: 'DATE_COL', type: 'DATE' },
            { name: 'TIME_COL', type: 'TIME' },
        ];

        it('converts ISO 8601 TIMESTAMP value to space-separated literal', () => {
            const sql = buildDatabaseFilteredSql(
                'SELECT * FROM T LIMIT 10',
                tsColumns,
                {
                    columnFilters: [{ columnIndex: 1, values: ['2005-01-03T00:00:00.000Z'] }],
                },
            );
            expect(sql).toContain("t.\"TS_COL\" IN ('2005-01-03 00:00:00')");
            expect(sql).not.toContain("'2005-01-03T00:00:00.000Z'");
        });

        it('converts ISO 8601 TIMESTAMPTZ value to space-separated literal', () => {
            const sql = buildDatabaseFilteredSql(
                'SELECT * FROM T LIMIT 10',
                tsColumns,
                {
                    columnFilters: [{ columnIndex: 2, values: ['2005-01-03T00:00:00.000Z'] }],
                },
            );
            expect(sql).toContain("t.\"TS_TZ_COL\" IN ('2005-01-03 00:00:00')");
            expect(sql).not.toContain("'2005-01-03T00:00:00.000Z'");
        });

        it('converts ISO 8601 DATE value to date-only literal', () => {
            const sql = buildDatabaseFilteredSql(
                'SELECT * FROM T LIMIT 10',
                tsColumns,
                {
                    columnFilters: [{ columnIndex: 3, values: ['2005-01-03T00:00:00.000Z'] }],
                },
            );
            expect(sql).toContain("t.\"DATE_COL\" IN ('2005-01-03 00:00:00')");
            expect(sql).not.toContain("'2005-01-03T00:00:00.000Z'");
        });

        it('preserves already-correct space-separated timestamp literals', () => {
            const sql = buildDatabaseFilteredSql(
                'SELECT * FROM T LIMIT 10',
                tsColumns,
                {
                    columnFilters: [{ columnIndex: 1, values: ['2005-01-03 12:30:00'] }],
                },
            );
            expect(sql).toContain("t.\"TS_COL\" IN ('2005-01-03 12:30:00')");
        });

        it('handles null temporal values', () => {
            const sql = buildDatabaseFilteredSql(
                'SELECT * FROM T LIMIT 10',
                tsColumns,
                {
                    columnFilters: [{ columnIndex: 1, values: ['2005-01-03T00:00:00.000Z', null] }],
                },
            );
            expect(sql).toContain("t.\"TS_COL\" IN ('2005-01-03 00:00:00')");
            expect(sql).toContain('t."TS_COL" IS NULL');
        });

        it('uses native comparison for TIMESTAMP greaterThan condition', () => {
            const sql = buildDatabaseFilteredSql(
                'SELECT * FROM T LIMIT 10',
                tsColumns,
                {
                    columnFilters: [{
                        columnIndex: 1,
                        conditions: [{ type: 'greaterThan', value: '2005-01-03T00:00:00.000Z' }],
                        conditionLogic: 'and',
                    }],
                },
            );
            expect(sql).toContain("t.\"TS_COL\" > '2005-01-03 00:00:00'");
            expect(sql).not.toContain('CAST(t."TS_COL" AS VARCHAR(64000))');
        });

        it('uses native comparison for TIMESTAMP between condition', () => {
            const sql = buildDatabaseFilteredSql(
                'SELECT * FROM T LIMIT 10',
                tsColumns,
                {
                    columnFilters: [{
                        columnIndex: 1,
                        conditions: [{ type: 'between', value: '2005-01-03T00:00:00.000Z', value2: '2005-01-03T12:00:00.000Z' }],
                        conditionLogic: 'and',
                    }],
                },
            );
            expect(sql).toContain("t.\"TS_COL\" >= '2005-01-03 00:00:00'");
            expect(sql).toContain("t.\"TS_COL\" <= '2005-01-03 12:00:00'");
            expect(sql).not.toContain('CAST(t."TS_COL" AS VARCHAR(64000))');
        });

        it('uses native comparison for TIMESTAMP equals condition', () => {
            const sql = buildDatabaseFilteredSql(
                'SELECT * FROM T LIMIT 10',
                tsColumns,
                {
                    columnFilters: [{
                        columnIndex: 1,
                        conditions: [{ type: 'equals', value: '2005-01-03T00:00:00.000Z' }],
                        conditionLogic: 'and',
                    }],
                },
            );
            expect(sql).toContain("t.\"TS_COL\" = '2005-01-03 00:00:00'");
            expect(sql).not.toContain('CAST(t."TS_COL" AS VARCHAR(64000))');
        });

        it('uses native comparison for DATE equals condition', () => {
            const sql = buildDatabaseFilteredSql(
                'SELECT * FROM T LIMIT 10',
                tsColumns,
                {
                    columnFilters: [{
                        columnIndex: 3,
                        conditions: [{ type: 'equals', value: '2005-01-03T00:00:00.000Z' }],
                        conditionLogic: 'and',
                    }],
                },
            );
            expect(sql).toContain("t.\"DATE_COL\" = '2005-01-03 00:00:00'");
            expect(sql).not.toContain('CAST(t."DATE_COL" AS VARCHAR(64000))');
        });
    });
});
