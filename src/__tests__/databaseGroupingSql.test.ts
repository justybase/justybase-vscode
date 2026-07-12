import { buildDatabaseGroupingSql } from '../results/databaseGroupingSql';

const BASE_SQL = 'SELECT employee_id, department, salary, hire_date FROM employees LIMIT 100';
const COLUMNS = [
    { name: 'EMPLOYEE_ID', type: 'INTEGER' },
    { name: 'DEPARTMENT', type: 'VARCHAR' },
    { name: 'SALARY', type: 'NUMERIC' },
    { name: 'HIRE_DATE', type: 'DATE' },
] as const;

describe('databaseGroupingSql', () => {
    // ======================== Basic Grouping ========================

    it('builds a GROUP BY query with one column and default COUNT + percentage', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [],
        });

        // Check SQL structure
        expect(built.sql).toContain('SELECT');
        expect(built.sql).toContain('t."DEPARTMENT" AS "DEPARTMENT"');
        expect(built.sql).toContain('COUNT(*) AS "COUNT"');
        expect(built.sql).toContain('COUNT(*) * 100.0 / SUM(COUNT(*)) OVER() AS "ROW_COUNT_PERCENTAGE"');
        expect(built.sql).toContain('FROM (');
        // LIMIT is stripped from the base SQL
        expect(built.sql).toContain('SELECT employee_id, department, salary, hire_date FROM employees');
        expect(built.sql).toContain(') t');
        expect(built.sql).toContain('GROUP BY t."DEPARTMENT"');
        expect(built.sql).toContain('ORDER BY 2 DESC');

        // Check column metadata
        expect(built.columnMetadata).toHaveLength(3);
        expect(built.columnMetadata[0]).toEqual({ kind: 'group', sourceColumnIndex: 1 });
        expect(built.columnMetadata[1]).toEqual({ kind: 'count', fn: 'count' });
        expect(built.columnMetadata[2]).toEqual({ kind: 'percentage', fn: 'rowCountPercentage' });
    });

    it('builds a query with multiple GROUP BY columns', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [
                { columnIndex: 1, columnName: 'DEPARTMENT' },
                { columnIndex: 3, columnName: 'HIRE_DATE' },
            ],
            functions: [{ fn: 'count' }],
        });

        expect(built.sql).toContain('t."DEPARTMENT" AS "DEPARTMENT"');
        expect(built.sql).toContain('t."HIRE_DATE" AS "HIRE_DATE"');
        expect(built.sql).toContain('GROUP BY t."DEPARTMENT", t."HIRE_DATE"');
        expect(built.sql).toContain('ORDER BY 3 DESC');
        expect(built.columnMetadata[0]).toEqual({ kind: 'group', sourceColumnIndex: 1 });
        expect(built.columnMetadata[1]).toEqual({ kind: 'group', sourceColumnIndex: 3 });
    });

    // ======================== Custom Aggregation Functions ========================

    it('builds a query with SUM aggregation', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [{ fn: 'sum', columnIndex: 2 }],
        });

        expect(built.sql).toContain('SUM(t."SALARY") AS "SUM_SALARY"');
        expect(built.columnMetadata[1]).toEqual({ kind: 'aggregate', sourceColumnIndex: 2, fn: 'sum' });
    });

    it('builds a query with AVG aggregation', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [{ fn: 'avg', columnIndex: 2 }],
        });

        expect(built.sql).toContain('AVG(t."SALARY") AS "AVG_SALARY"');
        expect(built.columnMetadata[1]).toEqual({ kind: 'aggregate', sourceColumnIndex: 2, fn: 'avg' });
    });

    it('builds a query with MIN aggregation', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [{ fn: 'min', columnIndex: 2 }],
        });

        expect(built.sql).toContain('MIN(t."SALARY") AS "MIN_SALARY"');
        expect(built.columnMetadata[1]).toEqual({ kind: 'aggregate', sourceColumnIndex: 2, fn: 'min' });
    });

    it('builds a query with MAX aggregation', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [{ fn: 'max', columnIndex: 2 }],
        });

        expect(built.sql).toContain('MAX(t."SALARY") AS "MAX_SALARY"');
        expect(built.columnMetadata[1]).toEqual({ kind: 'aggregate', sourceColumnIndex: 2, fn: 'max' });
    });

    it('builds a query with MEDIAN aggregation', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [{ fn: 'median', columnIndex: 2 }],
        });

        expect(built.sql).toContain('MEDIAN(t."SALARY") AS "MEDIAN_SALARY"');
        expect(built.columnMetadata[1]).toEqual({ kind: 'aggregate', sourceColumnIndex: 2, fn: 'median' });
    });

    it('builds a query with COUNT DISTINCT', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [{ fn: 'countDistinct', columnIndex: 2 }],
        });

        expect(built.sql).toContain('COUNT(DISTINCT t."SALARY") AS "COUNTDISTINCT_SALARY"');
        expect(built.columnMetadata[1]).toEqual({ kind: 'aggregate', sourceColumnIndex: 2, fn: 'countDistinct' });
    });

    it('builds a query with multiple aggregation functions', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [
                { fn: 'count' },
                { fn: 'sum', columnIndex: 2 },
                { fn: 'avg', columnIndex: 2 },
                { fn: 'max', columnIndex: 3 },
            ],
        });

        expect(built.sql).toContain('COUNT(*) AS "COUNT"');
        expect(built.sql).toContain('SUM(t."SALARY") AS "SUM_SALARY"');
        expect(built.sql).toContain('AVG(t."SALARY") AS "AVG_SALARY"');
        expect(built.sql).toContain('MAX(t."HIRE_DATE") AS "MAX_HIRE_DATE"');
    });

    it('supports custom aliases for aggregation functions', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [
                { fn: 'count', alias: 'TOTAL' },
                { fn: 'sum', columnIndex: 2, alias: 'TOTAL_SALARY' },
            ],
        });

        expect(built.sql).toContain('COUNT(*) AS "TOTAL"');
        expect(built.sql).toContain('SUM(t."SALARY") AS "TOTAL_SALARY"');
        expect(built.columnMetadata[1]).toEqual({ kind: 'count', fn: 'count' });
        expect(built.columnMetadata[2]).toEqual({ kind: 'aggregate', sourceColumnIndex: 2, fn: 'sum' });
    });

    it('rejects custom SQL expressions from the webview protocol', () => {
        expect(() => buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [
                { fn: 'custom' as never, alias: 'UNIQUE_EMPLOYEES' },
            ],
        })).toThrow('unsupported aggregate function');
    });

    // ======================== Default Behavior ========================

    it('adds default COUNT + percentage when no functions explicitly provided', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 0, columnName: 'EMPLOYEE_ID' }],
            functions: [],
        });

        expect(built.sql).toContain('COUNT(*) AS "COUNT"');
        expect(built.sql).toContain('COUNT(*) * 100.0 / SUM(COUNT(*)) OVER() AS "ROW_COUNT_PERCENTAGE"');
    });

    it('always includes percentage column regardless of functions', () => {
        const built1 = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [],
        });
        const built2 = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [{ fn: 'count' }, { fn: 'sum', columnIndex: 2 }],
        });

        expect(built1.sql).toContain('AS "ROW_COUNT_PERCENTAGE"');
        expect(built2.sql).toContain('AS "ROW_COUNT_PERCENTAGE"');
        expect(built1.columnMetadata[built1.columnMetadata.length - 1]).toEqual({ kind: 'percentage', fn: 'rowCountPercentage' });
        expect(built2.columnMetadata[built2.columnMetadata.length - 1]).toEqual({ kind: 'percentage', fn: 'rowCountPercentage' });
    });

    // ======================== ORDER BY ========================

    it('uses default ORDER BY by count DESC when no orderBy specified', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [{ fn: 'count' }],
        });

        expect(built.sql).toContain('ORDER BY 2 DESC');
    });

    it('supports custom ORDER BY', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [{ fn: 'count' }],
            orderBy: [{ columnIndex: 0, desc: true }],
        });

        expect(built.sql).toContain('ORDER BY 1 DESC');
    });

    it('supports ORDER BY with ascending', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [{ fn: 'count' }],
            orderBy: [{ columnIndex: 0, desc: false }],
        });

        expect(built.sql).toContain('ORDER BY 1 ASC');
    });

    it('maps ORDER BY to position 3 for percentage column', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [{ fn: 'count' }],
            orderBy: [{ columnIndex: 2, desc: true }], // columnMetadata[2] is percentage
        });

        expect(built.sql).toContain('ORDER BY 3 DESC');
    });

    it('uses column position for ORDER BY when column is group', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 0, columnName: 'EMPLOYEE_ID' }],
            functions: [{ fn: 'count' }],
            orderBy: [{ columnIndex: 0, desc: true }],
        });

        // Group column is at position 0 → ORDER BY 1 DESC
        expect(built.sql).toContain('ORDER BY 1 DESC');
    });

    // ======================== LIMIT ========================

    it('adds LIMIT when limit is specified', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [{ fn: 'count' }],
            limit: 50,
        });

        expect(built.sql).toContain('LIMIT 50');
    });

    it('preserves the source LIMIT when not specified', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [{ fn: 'count' }],
        });

        expect(built.sql).toMatch(/\nLIMIT 100$/);
    });

    it('omits an outer LIMIT when Unlimited is selected', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [{ fn: 'count' }],
            limit: null,
        });

        expect(built.sql).not.toContain('LIMIT');
    });

    // ======================== Edge Cases ========================

    it('strips trailing LIMIT from the base SQL', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 0, columnName: 'EMPLOYEE_ID' }],
            functions: [],
        });

        // The LIMIT 100 should NOT appear in the inner subquery
        const innerStart = built.sql.indexOf('FROM (') + 6;
        const innerEnd = built.sql.indexOf(') t');
        const innerSql = built.sql.substring(innerStart, innerEnd);
        expect(innerSql).not.toContain('LIMIT');
    });

    it('strips trailing semicolon from base SQL', () => {
        const built = buildDatabaseGroupingSql(
            'SELECT id, name FROM t LIMIT 10;',
            [{ name: 'ID', type: 'INTEGER' }, { name: 'NAME', type: 'VARCHAR' }],
            { groupByColumns: [{ columnIndex: 0, columnName: 'ID' }], functions: [] },
        );

        const innerSql = built.sql.substring(built.sql.indexOf('FROM (') + 6, built.sql.indexOf(') t'));
        expect(innerSql).not.toContain(';');
    });

    it('handles CTE queries without LIMIT', () => {
        const built = buildDatabaseGroupingSql(
            'WITH filtered AS (SELECT * FROM orders) SELECT * FROM filtered',
            [{ name: 'ID', type: 'INTEGER' }, { name: 'STATUS', type: 'VARCHAR' }],
            { groupByColumns: [{ columnIndex: 1, columnName: 'STATUS' }], functions: [{ fn: 'count' }] },
        );

        expect(built.sql).toContain('GROUP BY t."STATUS"');
        expect(built.sql).toContain('ORDER BY 2 DESC');
    });

    it('handles column names with special characters (quotes)', () => {
        const built = buildDatabaseGroupingSql(
            'SELECT "group", "count" FROM t LIMIT 100',
            [{ name: 'group', type: 'VARCHAR' }, { name: 'count', type: 'INTEGER' }],
            { groupByColumns: [{ columnIndex: 0, columnName: 'group' }], functions: [{ fn: 'count' }] },
        );

        // Column name "group" should be quoted as "group" (double-quote escaping)
        expect(built.sql).toContain('t."group" AS "group"');
        expect(built.sql).toContain('GROUP BY t."group"');
    });

    it('rejects invalid groupBy column indices', () => {
        expect(() => buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [
                { columnIndex: -1, columnName: 'INVALID' },
                { columnIndex: 1, columnName: 'DEPARTMENT' },
                { columnIndex: 999, columnName: 'OUT_OF_RANGE' },
            ],
            functions: [{ fn: 'count' }],
        })).toThrow('invalid column');
    });

    it('rejects functions with invalid column indices', () => {
        expect(() => buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [
                { fn: 'count' },
                { fn: 'sum', columnIndex: -1 },
                { fn: 'avg', columnIndex: 999 },
            ],
        })).toThrow('SUM requires a valid column');
    });

    it('rejects invalid function types', () => {
        expect(() => buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 0, columnName: 'EMPLOYEE_ID' }],
            functions: [
                { fn: 'count' as const },
                { fn: 'invalid' as 'count', columnIndex: 2 },
            ],
            limit: 100,
        })).toThrow('unsupported aggregate function');
    });

    // ======================== Effective SQL ========================

    it('keeps an existing database filter wrapper in the source query', () => {
        const built = buildDatabaseGroupingSql('SELECT * FROM employees WHERE department = \'sales\' LIMIT 100', COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [{ fn: 'count' }],
        });

        expect(built.sql).toContain("WHERE department = 'sales'");
    });

    it('omits WHERE clause when no filter spec', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [{ fn: 'count' }],
        });

        // First WHERE is the one we look for
        const whereLines = built.sql.split('\n').filter(line => line.trim().startsWith('WHERE'));
        expect(whereLines.length).toBe(0);
    });

    // ======================== Error Cases ========================

    it('throws error when base SQL is empty', () => {
        expect(() => buildDatabaseGroupingSql('   ', COLUMNS, {
            groupByColumns: [{ columnIndex: 0, columnName: 'EMPLOYEE_ID' }],
            functions: [],
        })).toThrow('does not have SQL that can be grouped');
    });

    it('throws error when no group columns provided', () => {
        expect(() => buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [],
            functions: [{ fn: 'count' }],
        })).toThrow('At least one GROUP BY column is required');
    });

    // ======================== Column Metadata ========================

    it('correctly assigns column metadata for all column types', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [{ fn: 'count' }, { fn: 'sum', columnIndex: 2 }],
        });

        expect(built.columnMetadata).toHaveLength(4);
        expect(built.columnMetadata[0]).toEqual({ kind: 'group', sourceColumnIndex: 1 });
        expect(built.columnMetadata[1]).toEqual({ kind: 'count', fn: 'count' });
        expect(built.columnMetadata[2]).toEqual({ kind: 'aggregate', sourceColumnIndex: 2, fn: 'sum' });
        expect(built.columnMetadata[3]).toEqual({ kind: 'percentage', fn: 'rowCountPercentage' });
    });

    it('correctly assigns positions for ORDER BY based on metadata kind', () => {
        const built = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [{ fn: 'count' }],
            orderBy: [{ columnIndex: 0, desc: true }], // order by group column = position 1
        });

        expect(built.sql).toContain('ORDER BY 1 DESC');

        // Count column is at metadata position 1 → would be 2 in ORDER BY
        const built2 = buildDatabaseGroupingSql(BASE_SQL, COLUMNS, {
            groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }],
            functions: [{ fn: 'count' }],
            orderBy: [{ columnIndex: 1, desc: true }], // order by count = "2 DESC" (reserved keyword)
        });

        expect(built2.sql).toContain('ORDER BY 2 DESC');
    });

    it('uses dialect-specific outer limit and identifier syntax', () => {
        const oracle = buildDatabaseGroupingSql(
            'SELECT id, department FROM employees FETCH FIRST 10 ROWS ONLY',
            COLUMNS,
            { groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }], functions: [], limit: 25 },
            { databaseKind: 'oracle' },
        );
        expect(oracle.sql).toContain('FETCH FIRST 25 ROWS ONLY');
        expect(oracle.sql).not.toContain('FETCH FIRST 10 ROWS ONLY\n) t');

        const sqlServer = buildDatabaseGroupingSql(
            'SELECT TOP (10) id, department FROM employees',
            COLUMNS,
            { groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }], functions: [], limit: 25 },
            { databaseKind: 'mssql' },
        );
        expect(sqlServer.sql).toContain('SELECT TOP (25) t.[DEPARTMENT] AS [DEPARTMENT]');
        expect(sqlServer.sql).toContain('SELECT id, department FROM employees');

        const mysql = buildDatabaseGroupingSql(
            BASE_SQL,
            COLUMNS,
            { groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }], functions: [], limit: 25 },
            { databaseKind: 'mysql' },
        );
        expect(mysql.sql).toContain('t.`DEPARTMENT` AS `DEPARTMENT`');
        expect(mysql.sql).toContain('LIMIT 25');
    });

    it('does not remove a nested LIMIT or a LIMIT inside a string literal', () => {
        const built = buildDatabaseGroupingSql(
            "SELECT id, department FROM (SELECT id, department FROM employees LIMIT 2) s WHERE department <> 'LIMIT 10' LIMIT 20",
            COLUMNS,
            { groupByColumns: [{ columnIndex: 1, columnName: 'DEPARTMENT' }], functions: [], limit: null },
        );
        expect(built.sql).toContain('FROM employees LIMIT 2');
        expect(built.sql).toContain("department <> 'LIMIT 10'");
        expect(built.sql).not.toMatch(/\nLIMIT 20$/);
    });
});
