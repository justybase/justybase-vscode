import { DatabaseSync } from 'node:sqlite';
import { buildExploreOperationSql, buildRankingSql } from '../../results/explore/operationSql';
import { buildExploreWhereSql } from '../../results/explore/exploreFilters';
import { compareExploreNumbers, matchesExploreFilters } from '@justybase/result-core';
import type { ExploreFilterModel, ExploreRankingConfig } from '@justybase/contracts';

const columns = [{ name: 'category', type: 'TEXT' }, { name: 'amount', type: 'INTEGER' }, { name: 'date', type: 'TEXT' }];
const empty = (): ExploreFilterModel => ({ dimensions: [], dates: [], measures: [] });
const ranking = (overrides: Partial<ExploreRankingConfig> = {}): ExploreRankingConfig => ({ categoryColumnIndex: 0,
    aggregate: 'count', direction: 'top', count: 2, showShare: true, includeOther: true, filters: empty(), ...overrides });

describe('Explore database operations', () => {
    let db: DatabaseSync;
    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        db.exec("CREATE TABLE sales(category TEXT, amount INTEGER, date TEXT); INSERT INTO sales VALUES ('A', 10, '2026-01-31T23:00'), ('A', 20, '2026-01-01'), ('B', 5, '2026-02-01'), ('C', 2, '2026-02-01'), (NULL, 1, '2026-01-01'), ('', 3, '2026-01-01')");
    });
    afterEach(() => db.close());
    const rows = (database: DatabaseSync, sql: string) => database.prepare(sql).all().map(row => Object.values(row));

    it('ranks all groups before Top N and calculates Other and shares over the full population', () => {
        const data = rows(db, buildRankingSql('SELECT * FROM sales', columns, ranking(), 'sqlite'));
        expect(data[0].slice(0, 4)).toEqual(['A', 2, 100 / 3, 0]);
        const other = data.find(row => row[3] === 1)!;
        expect(other.slice(0, 4)).toEqual([null, 3, 50, 1]);
    });
    it('preserves source LIMIT and CTEs', () => {
        const sql = buildRankingSql('WITH source AS (SELECT * FROM sales) SELECT * FROM source ORDER BY amount DESC LIMIT 2;', columns, ranking(), 'sqlite');
        expect(sql).toContain('ORDER BY amount DESC LIMIT 2');
        expect(rows(db, sql)[0][1]).toBe(2);
    });
    it('supports Bottom N, averages and count distinct without inventing Other totals', () => {
        for (const aggregate of ['sum', 'avg', 'min', 'max', 'countDistinct'] as const) {
            const result = rows(db, buildRankingSql('SELECT * FROM sales', columns, ranking({ aggregate, measureColumnIndex: 1, direction: 'bottom', count: 1 }), 'sqlite'));
            expect(result[0][1]).toBe(1);
            if (aggregate !== 'sum') expect(result).toHaveLength(1);
        }
    });
    it('suppresses shares for negative category totals and zero totals', () => {
        db.exec("UPDATE sales SET amount = -100 WHERE category = 'B'");
        const data = rows(db, buildRankingSql('SELECT * FROM sales', columns, ranking({ aggregate: 'sum', measureColumnIndex: 1 }), 'sqlite'));
        expect(data.every(row => row[2] === null)).toBe(true);
    });
    it('keeps the real Other category separate from the synthetic remainder', () => {
        db.exec("INSERT INTO sales VALUES ('Other', 500, '2026-01-01')");
        const data = rows(db, buildRankingSql('SELECT * FROM sales', columns, ranking({ aggregate: 'sum', measureColumnIndex: 1, count: 1 }), 'sqlite'));
        expect(data.map(row => [row[0], row[3]])).toEqual([['Other', 0], [null, 1]]);
    });
    it('searches literal wildcard characters and ignores unrelated SQL text', () => {
        db.exec("INSERT INTO sales VALUES ('a%_!', 0, '2026-01-01')");
        const sql = buildExploreOperationSql('SELECT * FROM sales', columns, { kind: 'values', columnIndex: 0, search: '%_!', filters: empty() }, 'sqlite');
        expect(rows(db, sql)).toEqual([['a%_!']]);
    });
    it('bounds detail rows with a sentinel', () => {
        db.exec('WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n<1500) INSERT INTO sales SELECT \'many\', n, \'2026-01-01\' FROM x');
        const sql = buildExploreOperationSql('SELECT * FROM sales', columns, { kind: 'rows', filters: empty() }, 'sqlite');
        expect(rows(db, sql)).toHaveLength(1001);
    });
    it.each(['mssql', 'oracle', 'db2', 'mysql', 'netezza', 'postgresql', 'snowflake', 'clickhouse', 'duckdb', 'vertica'])('uses the %s outer row limiter', kind => {
        const sql = buildExploreOperationSql('SELECT * FROM sales', columns, { kind: 'rows', filters: empty() }, kind);
        expect(sql).toContain(kind === 'mssql' ? 'TOP (1001)' : kind === 'oracle' || kind === 'db2' ? 'FETCH FIRST 1001 ROWS ONLY' : 'LIMIT 1001');
    });
    it('places SQL Server TOP after DISTINCT for value lookups', () => {
        const sql = buildExploreOperationSql('SELECT * FROM sales', columns, { kind: 'values', columnIndex: 0, search: '', filters: empty() }, 'mssql');
        expect(sql).toMatch(/^SELECT DISTINCT TOP \(101\) t\.\[category\]/);
        expect(sql).not.toContain('TOP (101) DISTINCT');
    });
    it('rejects invalid ranking and duplicate output references', () => {
        expect(() => buildRankingSql('SELECT 1', columns, ranking({ count: 101 }))).toThrow('between');
        expect(() => buildRankingSql('SELECT 1', [columns[0], columns[0]], ranking())).toThrow('unique');
    });
    it('has matching local and database NULL/empty/exclusion semantics', () => {
        const all = rows(db, 'SELECT * FROM sales');
        for (const mode of ['include', 'exclude'] as const) for (const includeNull of [true, false]) for (const includeEmpty of [true, false]) {
            const filters: ExploreFilterModel = { ...empty(), dimensions: [{ columnIndex: 0, values: ['A'], mode, includeNull, includeEmpty }] };
            const sql = `SELECT * FROM sales t WHERE ${buildExploreWhereSql(filters, columns, 'sqlite')}`;
            expect(rows(db, sql)).toEqual(all.filter(row => matchesExploreFilters(row, filters)));
        }
    });
    it('matches inclusive timestamp bounds locally like SQL regardless of cell precision', () => {
        const filters: ExploreFilterModel = { dimensions: [], measures: [], dates: [{ columnIndex: 0, grain: 'day', from: '2026-01-01', to: '2026-01-31T23:00' }] };
        for (const cell of ['2026-01-31 23:00:00', '2026-01-31T23:00:00.000', new Date('2026-01-31T23:00:00Z'), '2026-01-01']) {
            expect(matchesExploreFilters([cell], filters)).toBe(true);
        }
        for (const cell of ['2026-01-31 23:00:01', new Date('2026-01-31T23:00:00.001Z'), '2025-12-31 23:59:59']) {
            expect(matchesExploreFilters([cell], filters)).toBe(false);
        }
        expect(matchesExploreFilters(['2026-02-01'], { ...filters, dates: [{ columnIndex: 0, grain: 'day', from: '2026-01-01', to: '2026-02-01', toExclusive: true }] })).toBe(false);
    });
    it('uses exclusive histogram and timestamp boundaries', () => {
        const filters: ExploreFilterModel = { dimensions: [], measures: [{ columnIndex: 1, min: '10', max: '20', maxExclusive: true }], dates: [{ columnIndex: 2, grain: 'day', from: '2026-01-01', to: '2026-02-01', toExclusive: true }] };
        const sql = buildExploreOperationSql('SELECT * FROM sales', columns, { kind: 'rows', filters }, 'sqlite');
        expect(rows(db, sql)).toEqual([['A', 10, '2026-01-31T23:00']]);
    });
});

describe('exact Explore numeric bounds', () => {
    it('distinguishes adjacent large integer and decimal values', () => {
        expect(compareExploreNumbers('9007199254740993', '9007199254740992')).toBe(1);
        expect(compareExploreNumbers('123.000000000000000001', '123')).toBe(1);
        expect(compareExploreNumbers('-0.01', '-1e-2')).toBe(0);
        expect(compareExploreNumbers('1; DROP TABLE x', '1')).toBeUndefined();
        expect(buildExploreWhereSql({ ...empty(), measures: [{ columnIndex: 1, min: '9007199254740993' }] }, columns)).toContain('>= 9007199254740993');
    });
});
