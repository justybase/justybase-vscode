import { bucketDateExpression } from '../../../src/results/explore/timeBucketingSql';
import { buildComposerSql } from '../../../src/results/explore/composerSql';

const COLUMNS = [
    { name: 'ORDER_DATE', type: 'DATE' },
    { name: 'REGION', type: 'VARCHAR(20)' },
    { name: 'CATEGORY', type: 'VARCHAR(20)' },
    { name: 'AMOUNT', type: 'DECIMAL(10,2)' },
];

describe('timeBucketingSql', () => {
    it('buckets months per dialect', () => {
        expect(bucketDateExpression('postgresql', 't."D"', 'month')).toBe("DATE_TRUNC('month', t.\"D\")");
        expect(bucketDateExpression('netezza', 't."D"', 'month')).toBe("TRUNC(t.\"D\", 'MM')");
        expect(bucketDateExpression('oracle', 't."D"', 'month')).toBe("TRUNC(t.\"D\", 'MM')");
        expect(bucketDateExpression('sqlite', 't."D"', 'month')).toBe("DATE(t.\"D\", 'start of month')");
        expect(bucketDateExpression('mysql', 't."D"', 'month')).toBe("DATE_FORMAT(t.\"D\", '%Y-%m-01')");
        expect(bucketDateExpression('mssql', 't."D"', 'month')).toBe('DATEFROMPARTS(YEAR(t."D"), MONTH(t."D"), 1)');
    });

    it('buckets days, quarters, weeks and years per dialect', () => {
        expect(bucketDateExpression('netezza', 't."D"', 'day')).toBe('CAST(t."D" AS DATE)');
        expect(bucketDateExpression('netezza', 't."D"', 'week')).toBe("TRUNC(t.\"D\", 'WW')");
        expect(bucketDateExpression('netezza', 't."D"', 'quarter')).toBe("TRUNC(t.\"D\", 'Q')");
        expect(bucketDateExpression('netezza', 't."D"', 'year')).toBe("TRUNC(t.\"D\", 'YYYY')");
        expect(bucketDateExpression('postgresql', 't."D"', 'quarter')).toBe("DATE_TRUNC('quarter', t.\"D\")");
    });
});

describe('composerSql', () => {
    it('builds a simple bucket + aggregate query', () => {
        const built = buildComposerSql(
            'SELECT * FROM SALES LIMIT 100',
            COLUMNS,
            {
                dateColumnIndex: 0,
                grain: 'month',
                measureColumnIndex: 3,
                aggFn: 'sum',
                comparePrevious: false,
            },
            'netezza',
        );
        expect(built.columnIndexes.bucket).toBe(0);
        expect(built.columnIndexes.measure).toBe(1);
        expect(built.columnIndexes.dimension).toBeUndefined();
        expect(built.sql).toContain("TRUNC(t.\"ORDER_DATE\", 'MM') AS \"BUCKET\"");
        expect(built.sql).toContain('SUM(t."AMOUNT") AS "MEASURE"');
        expect(built.sql).toContain('GROUP BY');
        expect(built.sql).toContain('LIMIT 5000');
    });

    it('adds dimension and split columns', () => {
        const built = buildComposerSql(
            'SELECT * FROM SALES',
            COLUMNS,
            {
                dateColumnIndex: 0,
                grain: 'month',
                dimensionColumnIndex: 1,
                measureColumnIndex: 3,
                aggFn: 'count',
                splitByColumnIndex: 2,
                splitValues: ['A', 'B'],
                includeOther: true,
                comparePrevious: false,
            },
            'netezza',
        );
        expect(built.columnIndexes.dimension).toBe(1);
        expect(built.columnIndexes.split).toBe(2);
        expect(built.columnIndexes.measure).toBe(3);
        expect(built.sql).toContain('t."REGION" AS "DIM"');
        expect(built.sql).toContain("CASE WHEN t.\"CATEGORY\" IN ('A', 'B') THEN t.\"CATEGORY\" ELSE 'Other' END AS \"SPLIT\"");
        expect(built.sql).toContain('COUNT(*) AS "MEASURE"');
    });

    it('uses backticks for MySQL identifiers', () => {
        const built = buildComposerSql(
            'SELECT * FROM SALES',
            COLUMNS,
            {
                dateColumnIndex: 0,
                grain: 'month',
                dimensionColumnIndex: 1,
                measureColumnIndex: 3,
                aggFn: 'sum',
                comparePrevious: false,
            },
            'mysql',
        );
        expect(built.sql).toContain('t.`REGION` AS `DIM`');
        expect(built.sql).toContain('SUM(t.`AMOUNT`) AS `MEASURE`');
    });

    it('keeps the configured row cap for MSSQL with TOP', () => {
        const built = buildComposerSql(
            'SELECT * FROM SALES',
            COLUMNS,
            {
                dateColumnIndex: 0,
                grain: 'month',
                measureColumnIndex: 3,
                aggFn: 'sum',
                comparePrevious: false,
                limit: 123,
            },
            'mssql',
        );
        expect(built.sql).toContain('SELECT TOP 123 ');
        expect(built.sql).not.toContain('LIMIT');
    });

    it('adds LAG for previous-period comparison', () => {
        const built = buildComposerSql(
            'SELECT * FROM SALES',
            COLUMNS,
            {
                dateColumnIndex: 0,
                grain: 'year',
                dimensionColumnIndex: 1,
                measureColumnIndex: 3,
                aggFn: 'sum',
                comparePrevious: true,
            },
            'netezza',
        );
        expect(built.columnIndexes.previous).toBeDefined();
        expect(built.sql).toContain('LAG(SUM(t."AMOUNT")) OVER (PARTITION BY t."REGION" ORDER BY');
    });

    it('composes filters', () => {
        const built = buildComposerSql(
            'SELECT * FROM SALES',
            COLUMNS,
            {
                dateColumnIndex: 0,
                grain: 'month',
                measureColumnIndex: 3,
                aggFn: 'sum',
                comparePrevious: false,
                filters: { dimensions: [{ columnIndex: 1, values: ['EU'] }], dates: [], measures: [] },
            },
            'netezza',
        );
        expect(built.sql).toContain('WHERE t."REGION" = \'EU\'');
    });

    it('validates configuration', () => {
        expect(() => buildComposerSql(
            'SELECT * FROM SALES',
            COLUMNS,
            { dateColumnIndex: 99, grain: 'month', measureColumnIndex: 3, aggFn: 'sum', comparePrevious: false },
            'netezza',
        )).toThrow('stable date column');

        expect(() => buildComposerSql(
            'SELECT * FROM SALES',
            COLUMNS,
            { dateColumnIndex: 0, grain: 'month', measureColumnIndex: 3, aggFn: 'bogus' as never, comparePrevious: false },
            'netezza',
        )).toThrow('Unsupported composer aggregate');
    });
});
