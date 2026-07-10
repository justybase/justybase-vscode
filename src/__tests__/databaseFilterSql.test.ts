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
});
