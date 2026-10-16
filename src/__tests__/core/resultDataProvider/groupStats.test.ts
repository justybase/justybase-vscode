import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteResultStore } from '../../../core/resultDataProvider/sqliteResultStore';

function isNodeSqliteAvailable(): boolean {
    try {
        require('node:sqlite');
        return true;
    } catch {
        return false;
    }
}

const describeIfSqlite = isNodeSqliteAvailable() ? describe : describe.skip;

const EPOCH_BASE = 1_700_000_000_000;
const REGIONS: Array<string | null> = ['EMEA', 'US', 'APAC', null];

interface Row {
    region: string | null;
    amount: number;
    status: string;
    epoch: number;
}

function sampleRows(count: number): Row[] {
    const rows: Row[] = [];
    for (let i = 0; i < count; i++) {
        rows.push({
            region: REGIONS[i % REGIONS.length],
            amount: ((i * 37) % 101) + (i % 4 === 0 ? 1000 : 0),
            status: i % 5 === 0 ? 'ERR' : 'OK',
            epoch: EPOCH_BASE + (i % 11),
        });
    }
    return rows;
}

function oracleMean(values: number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function oracleStddev(values: number[]): number {
    const mean = oracleMean(values);
    return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function keyOf(values: unknown[]): string {
    return JSON.stringify(values.map(value => (value === null || value === undefined ? null : String(value))));
}

describeIfSqlite('SqliteResultStore group statistics', () => {
    const tempPaths: string[] = [];
    let store: SqliteResultStore | undefined;
    let rows: Row[];

    beforeEach(() => {
        rows = sampleRows(400);
        const dbPath = path.join(os.tmpdir(), `justybase-groupstats-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
        tempPaths.push(dbPath);
        store = SqliteResultStore.create(
            [
                { name: 'region', type: 'VARCHAR' },
                { name: 'amount', type: 'NUMERIC' },
                { name: 'status', type: 'VARCHAR' },
                { name: 'epoch', type: 'BIGINT' },
            ],
            1000,
            dbPath,
        );
        store.insertRows(rows.map(row => [row.region, row.amount, row.status, row.epoch]));
        store.finalizeBulkInsert();
    });

    afterEach(() => {
        store?.dispose();
        store = undefined;
        for (const tempPath of tempPaths.splice(0)) {
            try {
                if (fs.existsSync(tempPath)) {
                    fs.unlinkSync(tempPath);
                }
            } catch {
                // ignore cleanup failures
            }
        }
    });

    it('matches a brute-force oracle for group counts, population and per-group statistics', () => {
        const result = store!.queryGroupStats({ groupColumns: [0], statColumns: [1, 2], limit: 100 });

        expect(result.totalRows).toBe(rows.length);
        expect(result.totalGroups).toBe(REGIONS.length);
        expect(result.unlistedRows).toBe(0);

        const amounts = rows.map(row => row.amount);
        const population = result.population.find(column => column.columnIndex === 1);
        expect(population?.numeric?.mean).toBeCloseTo(oracleMean(amounts), 9);
        expect(population?.numeric?.stddev).toBeCloseTo(oracleStddev(amounts), 9);

        for (const group of result.groups) {
            const expected = rows.filter(row => keyOf([row.region]) === keyOf(group.values));
            expect(group.count).toBe(expected.length);
            const amountStats = group.columns.find(column => column.columnIndex === 1);
            const expectedAmounts = expected.map(row => row.amount);
            expect(amountStats?.numeric?.mean).toBeCloseTo(oracleMean(expectedAmounts), 9);
            expect(amountStats?.numeric?.stddev).toBeCloseTo(oracleStddev(expectedAmounts), 9);
            expect(amountStats?.nonNullCount).toBe(expected.length);
        }
    });

    it('keeps SQL NULL group keys as their own listed group', () => {
        const result = store!.queryGroupStats({ groupColumns: [0], statColumns: [], limit: 100 });
        const nullGroup = result.groups.find(group => group.values[0] === null);
        expect(nullGroup?.count).toBe(rows.filter(row => row.region === null).length);
    });

    it('lists only the largest groups and reports the remaining rows as unlisted', () => {
        const result = store!.queryGroupStats({ groupColumns: [0], statColumns: [], limit: 2 });
        expect(result.groups).toHaveLength(2);
        const listed = result.groups.reduce((sum, group) => sum + group.count, 0);
        expect(result.unlistedRows).toBe(rows.length - listed);
        expect(result.totalGroups).toBe(REGIONS.length);
    });

    it('keeps variance accurate for large magnitudes such as epoch values', () => {
        const result = store!.queryGroupStats({ groupColumns: [0], statColumns: [3], limit: 100 });
        const epochs = rows.map(row => row.epoch);
        const population = result.population.find(column => column.columnIndex === 3);
        expect(population?.numeric?.stddev).toBeCloseTo(oracleStddev(epochs), 3);
    });

    it('returns deterministic group order across statistic batches', () => {
        const first = store!.queryGroupStats({ groupColumns: [0], statColumns: [1], limit: 100 });
        const second = store!.queryGroupStats({ groupColumns: [0], statColumns: [2, 3], limit: 100 });
        expect(second.groups.map(group => group.values)).toEqual(first.groups.map(group => group.values));
        expect(second.groups.map(group => group.count)).toEqual(first.groups.map(group => group.count));
    });

    it('does not report numeric statistics for text-affinity columns', () => {
        const result = store!.queryGroupStats({ groupColumns: [0], statColumns: [2], limit: 100 });
        const status = result.population.find(column => column.columnIndex === 2);
        expect(status?.numeric).toBeUndefined();
        expect(status?.distinctCount).toBe(2);
        expect(status?.min).toBe('ERR');
        expect(status?.max).toBe('OK');
    });

    it('reports population and per-group top values bounded by topLimit', () => {
        const result = store!.queryGroupStats({
            groupColumns: [0],
            statColumns: [2],
            limit: 100,
            topColumns: [2],
            topLimit: 1,
        });
        const population = result.population.find(column => column.columnIndex === 2);
        expect(population?.topValues).toEqual([{ value: 'OK', count: rows.filter(row => row.status === 'OK').length }]);
        for (const group of result.groups) {
            const top = group.columns.find(column => column.columnIndex === 2)?.topValues ?? [];
            expect(top).toHaveLength(1);
            const expectedCount = rows.filter(row => keyOf([row.region]) === keyOf(group.values) && row.status === 'OK').length;
            const expectedErr = rows.filter(row => keyOf([row.region]) === keyOf(group.values) && row.status === 'ERR').length;
            expect(top[0].count).toBe(Math.max(expectedCount, expectedErr));
        }
    });

    it('ignores invalid and duplicate indexes and never allows a group column as a statistic column', () => {
        const result = store!.queryGroupStats({
            groupColumns: [0, 0, 99, -1],
            statColumns: [0, 1, 1, 99],
            limit: 100,
        });
        expect(result.groupColumns).toEqual([0]);
        expect(result.population.map(column => column.columnIndex)).toEqual([1]);
    });

    it('returns population statistics only when no grouping column is chosen', () => {
        const result = store!.queryGroupStats({ groupColumns: [], statColumns: [1], limit: 100 });
        expect(result.groups).toEqual([]);
        expect(result.totalGroups).toBe(0);
        expect(result.population).toHaveLength(1);
    });

    it('deduplicates repeated statistic columns within a batch', () => {
        const result = store!.queryGroupStats({
            groupColumns: [0],
            statColumns: [1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3],
            limit: 100,
        });
        expect(result.population.map(column => column.columnIndex)).toEqual([1, 2, 3]);
    });
});

describeIfSqlite('SqliteResultStore bounded statistics and empty strings', () => {
    const tempPaths: string[] = [];
    const stores: SqliteResultStore[] = [];

    function makeStore(data: unknown[][], types: string[] = ['VARCHAR', 'VARCHAR']): SqliteResultStore {
        const dbPath = path.join(os.tmpdir(), `justybase-bounds-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
        tempPaths.push(dbPath);
        const made = SqliteResultStore.create(
            types.map((type, index) => ({ name: `c${index}`, type })),
            1000,
            dbPath,
        );
        made.insertRows(data);
        made.finalizeBulkInsert();
        stores.push(made);
        return made;
    }

    afterEach(() => {
        for (const made of stores.splice(0)) {
            made.dispose();
        }
        for (const tempPath of tempPaths.splice(0)) {
            try {
                if (fs.existsSync(tempPath)) {
                    fs.unlinkSync(tempPath);
                }
            } catch {
                // ignore cleanup failures
            }
        }
    });

    it('treats empty strings as null-like for counts, extremes and top values', () => {
        const result = makeStore([
            ['A', 'x'],
            ['A', ''],
            ['A', null],
            ['A', 'z'],
            ['B', ''],
        ]).queryGroupStats({ groupColumns: [0], statColumns: [1], limit: 10, topColumns: [1], topLimit: 5 });

        const population = result.population.find(column => column.columnIndex === 1);
        expect(population?.nonNullCount).toBe(2);
        expect(population?.distinctCount).toBe(2);
        expect(population?.min).toBe('x');
        expect(population?.max).toBe('z');
        expect(population?.topValues?.map(entry => entry.value).sort()).toEqual(['x', 'z']);

        const groupWithEmptyOnly = result.groups.find(group => group.values[0] === 'B');
        const emptyStats = groupWithEmptyOnly?.columns.find(column => column.columnIndex === 1);
        expect(emptyStats?.nonNullCount).toBe(0);
        expect(emptyStats?.topValues ?? []).toEqual([]);
    });

    it('reports top values and categories as skipped past 50 distinct values', () => {
        const data = Array.from({ length: 200 }, (_, i) => ['A', `v${i}`]);
        const result = makeStore(data).queryGroupStats({
            groupColumns: [0],
            statColumns: [1],
            limit: 10,
            topColumns: [1],
            categoryColumns: [1],
        });

        const population = result.population.find(column => column.columnIndex === 1);
        expect(population?.distinctCount).toBe(200);
        expect(population?.categories).toBeUndefined();
        // Population top values stay cheap (one pass); the per-group cross-tab is what the distinct bound skips.
        const groupTop = result.groups[0]?.columns.find(column => column.columnIndex === 1)?.topValues ?? [];
        expect(groupTop).toEqual([]);
        expect(result.omitted).toEqual(expect.arrayContaining([
            { columnIndex: 1, field: 'categories', reason: 'too-many-distinct' },
            { columnIndex: 1, field: 'topValues', reason: 'too-many-distinct' },
        ]));
    });

    it('reports top values and categories as skipped past 5,000 groups', () => {
        const data = Array.from({ length: 5001 }, (_, i) => [`g${i}`, i % 2 === 0 ? 'x' : 'y']);
        const result = makeStore(data).queryGroupStats({
            groupColumns: [0],
            statColumns: [1],
            limit: 10,
            topColumns: [1],
            categoryColumns: [1],
        });

        expect(result.totalGroups).toBe(5001);
        expect(result.omitted).toEqual(expect.arrayContaining([
            { columnIndex: 1, field: 'categories', reason: 'too-many-groups' },
            { columnIndex: 1, field: 'topValues', reason: 'too-many-groups' },
        ]));
    });

    it('reports quartiles as skipped for a measure column stored as text', () => {
        const data = Array.from({ length: 20 }, (_, i) => ['A', String(i)]);
        const result = makeStore(data).queryGroupStats({
            groupColumns: [0],
            statColumns: [1],
            limit: 10,
            quantileColumns: [1],
        });

        const population = result.population.find(column => column.columnIndex === 1);
        expect(population?.numeric).toBeUndefined();
        expect(result.omitted).toContainEqual({ columnIndex: 1, field: 'quartiles', reason: 'not-numeric' });
    });

    it('orders equal-sized groups nulls last and text ascending', () => {
        const data = [['b'], ['b'], ['a'], ['a'], [null], [null], [''], ['']];
        const store = makeStore(data, ['VARCHAR']);

        const all = store.queryGroupStats({ groupColumns: [0], statColumns: [], limit: 100 });
        expect(all.groups.map(group => group.values[0])).toEqual(['', 'a', 'b', null]);

        const cut = store.queryGroupStats({ groupColumns: [0], statColumns: [], limit: 2 });
        expect(cut.groups.map(group => group.values[0])).toEqual(['', 'a']);
    });
});
