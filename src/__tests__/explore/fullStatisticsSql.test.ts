import {
    buildFullStatisticsSql,
    mapFullStatisticsRow,
} from '../../../src/results/explore/fullStatisticsSql';

const COLUMNS = [
    { name: 'AMOUNT', type: 'DECIMAL(10,2)' },
];

describe('fullStatisticsSql', () => {
    it('builds base aggregates with percentiles for netezza', () => {
        const built = buildFullStatisticsSql(
            'SELECT * FROM SALES LIMIT 100',
            COLUMNS,
            { columnIndex: 0 },
            undefined,
            'netezza',
        );
        expect(built.percentilesUnavailable).toBe(false);
        expect(built.sql).toContain('COUNT(t."AMOUNT") AS "stat_count"');
        expect(built.sql).toContain('PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY t."AMOUNT") AS "stat_p25"');
        expect(built.sql).toContain('FROM (');
        expect(built.sql).toContain('SELECT * FROM SALES');
        expect(built.sql).not.toContain('LIMIT 100');
        expect(built.sql).not.toContain('WHERE');
    });

    it('uses quantile_cont for duckdb', () => {
        const built = buildFullStatisticsSql(
            'SELECT * FROM SALES',
            COLUMNS,
            { columnIndex: 0 },
            undefined,
            'duckdb',
        );
        expect(built.percentilesUnavailable).toBe(false);
        expect(built.sql).toContain('QUANTILE_CONT(t."AMOUNT", 0.5)');
    });

    it('uses backticks for MySQL identifiers', () => {
        const built = buildFullStatisticsSql(
            'SELECT * FROM SALES',
            COLUMNS,
            { columnIndex: 0 },
            undefined,
            'mysql',
        );
        expect(built.sql).toContain('COUNT(t.`AMOUNT`) AS `stat_count`');
    });

    it('marks percentiles unavailable for sqlite and omits them', () => {
        const built = buildFullStatisticsSql(
            'SELECT * FROM SALES',
            COLUMNS,
            { columnIndex: 0 },
            undefined,
            'sqlite',
        );
        expect(built.percentilesUnavailable).toBe(true);
        expect(built.stddevUnavailable).toBe(true);
        expect(built.sql).not.toContain('PERCENTILE_CONT');
        expect(built.sql).not.toContain('STDDEV');
    });

    it('composes explore filters into the WHERE clause', () => {
        const built = buildFullStatisticsSql(
            'SELECT * FROM SALES',
            COLUMNS,
            { columnIndex: 0 },
            { dimensions: [{ columnIndex: 0, values: ['A'] }], dates: [], measures: [] },
            'netezza',
        );
        expect(built.sql).toContain('WHERE t."AMOUNT" = \'A\'');
    });

    it('throws for unstable column names', () => {
        expect(() => buildFullStatisticsSql(
            'SELECT * FROM SALES',
            [{ name: 'X' }, { name: 'X' }],
            { columnIndex: 0 },
            undefined,
            'netezza',
        )).toThrow('unique output column name');
    });

    it('maps query rows to named statistics', () => {
        const built = buildFullStatisticsSql(
            'SELECT * FROM SALES',
            COLUMNS,
            { columnIndex: 0 },
            undefined,
            'netezza',
        );
        const row = Array(built.aliases.length).fill(null);
        row[built.aliases.findIndex(entry => entry.stat === 'sum')] = 1234.5;
        row[built.aliases.findIndex(entry => entry.stat === 'count')] = 42;
        const mapped = mapFullStatisticsRow(row, built.aliases);
        expect(mapped.sum).toBe(1234.5);
        expect(mapped.count).toBe(42);
        expect(mapped.p50).toBeNull();
    });
});
