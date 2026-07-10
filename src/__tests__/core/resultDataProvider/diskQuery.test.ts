import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildDiskQuery } from '../../../core/resultDataProvider/diskQueryBuilder';
import { SqliteResultStore } from '../../../core/resultDataProvider/sqliteResultStore';
import type { DiskQuerySpec } from '../../../core/resultDataProvider/types';

function isNodeSqliteAvailable(): boolean {
    try {
         
        require('node:sqlite');
        return true;
    } catch {
        return false;
    }
}

const describeIfSqlite = isNodeSqliteAvailable() ? describe : describe.skip;

describe('diskQueryBuilder', () => {
    it('builds empty where and default order by rowid', () => {
        const built = buildDiskQuery(undefined, 2, ['INTEGER', 'VARCHAR']);
        expect(built.whereSql).toBe('');
        expect(built.whereParams).toEqual([]);
        expect(built.orderBySql).toBe('_rowid');
    });

    it('builds global search across columns', () => {
        const built = buildDiskQuery({ globalSearch: 'abc' }, 2, ['INTEGER', 'VARCHAR']);
        expect(built.whereSql).toContain('CAST("col_0" AS TEXT) LIKE ?');
        expect(built.whereSql).toContain('CAST("col_1" AS TEXT) LIKE ?');
        expect(built.whereParams).toEqual(['%abc%', '%abc%']);
    });

    it('builds column IN filter and sort', () => {
        const spec: DiskQuerySpec = {
            columnFilters: [{ columnIndex: 1, values: ['x', null] }],
            sorting: [{ columnIndex: 0, desc: true }],
        };
        const built = buildDiskQuery(spec, 2, ['INTEGER', 'VARCHAR']);
        expect(built.whereSql).toContain('"col_1" IN (?)');
        expect(built.whereSql).toContain('"col_1" IS NULL');
        expect(built.whereParams).toEqual(['x']);
        expect(built.orderBySql).toBe('"col_0" DESC');
    });

    it('builds chronological sort for ABSTIME columns', () => {
        const spec: DiskQuerySpec = {
            sorting: [{ columnIndex: 0, desc: false }],
        };
        const built = buildDiskQuery(spec, 1, ['ABSTIME']);
        expect(built.orderBySql).toBe('"col_0" ASC');
    });

    it('builds multi-column ORDER BY in sort priority order', () => {
        const spec: DiskQuerySpec = {
            sorting: [
                { columnIndex: 1, desc: false },
                { columnIndex: 0, desc: true },
            ],
        };
        const built = buildDiskQuery(spec, 2, ['INTEGER', 'INTEGER']);
        expect(built.orderBySql).toBe('"col_1" ASC, "col_0" DESC');
    });

    it('builds numeric greater-than and text contains conditions', () => {
        const spec: DiskQuerySpec = {
            columnFilters: [{
                columnIndex: 0,
                conditions: [{ type: 'greaterThan', value: '10' }],
            }, {
                columnIndex: 1,
                conditions: [{ type: 'contains', value: 'alp' }],
                conditionLogic: 'and',
            }],
        };
        const built = buildDiskQuery(spec, 2, ['INTEGER', 'VARCHAR']);
        expect(built.whereSql).toContain('"col_0" > ?');
        expect(built.whereSql).toContain('LOWER(CAST("col_1" AS TEXT)) LIKE ?');
        expect(built.whereParams).toEqual([10, '%alp%']);
    });

    it('binds unsafe integer condition values as bigint parameters', () => {
        const spec: DiskQuerySpec = {
            columnFilters: [{
                columnIndex: 0,
                conditions: [{ type: 'greaterThan', value: '111111111111111111' }],
            }],
        };
        const built = buildDiskQuery(spec, 1, ['BIGINT']);
        expect(built.whereSql).toBe('"col_0" > ?');
        expect(built.whereParams).toEqual([BigInt('111111111111111111')]);
    });

    it('parses grouped numeric condition values for integer columns', () => {
        const spec: DiskQuerySpec = {
            columnFilters: [{
                columnIndex: 0,
                conditions: [{ type: 'greaterThan', value: '123 456' }],
            }],
        };
        const built = buildDiskQuery(spec, 1, ['INT4']);
        expect(built.whereSql).toBe('"col_0" > ?');
        expect(built.whereParams).toEqual([123456]);
    });
});

describeIfSqlite('SqliteResultStore disk queries', () => {
    const tempPaths: string[] = [];

    afterEach(() => {
        for (const tempPath of tempPaths.splice(0)) {
            try {
                if (fs.existsSync(tempPath)) {
                    fs.unlinkSync(tempPath);
                }
            } catch {
                // ignore
            }
        }
    });

    function createStoreWithSampleRows(): SqliteResultStore {
        const dbPath = path.join(os.tmpdir(), `justybase-query-test-${Date.now()}.db`);
        tempPaths.push(dbPath);
        const store = SqliteResultStore.create(
            [
                { name: 'id', type: 'INTEGER' },
                { name: 'label', type: 'VARCHAR' },
            ],
            1000,
            dbPath,
        );
        store.insertRows([
            [1, 'alpha'],
            [2, 'beta'],
            [3, 'alpha'],
            [4, null],
        ]);
        return store;
    }

    function createStoreWithGroupingRows(): SqliteResultStore {
        const dbPath = path.join(os.tmpdir(), `justybase-group-test-${Date.now()}.db`);
        tempPaths.push(dbPath);
        const store = SqliteResultStore.create(
            [
                { name: 'id', type: 'INTEGER' },
                { name: 'region', type: 'VARCHAR' },
                { name: 'status', type: 'VARCHAR' },
                { name: 'amount', type: 'INTEGER' },
            ],
            1000,
            dbPath,
        );
        store.insertRows([
            [1, 'EU', 'open', 10],
            [2, 'EU', 'closed', 20],
            [3, 'US', 'open', 30],
            [4, 'US', 'open', 40],
            [5, null, 'closed', 50],
        ]);
        return store;
    }

    it('filters, sorts, counts, distincts, and aggregates', () => {
        const store = createStoreWithSampleRows();
        const filterSpec: DiskQuerySpec = {
            columnFilters: [{ columnIndex: 1, values: ['alpha'] }],
            sorting: [{ columnIndex: 0, desc: true }],
        };

        expect(store.countRows(filterSpec)).toBe(2);
        expect(store.queryRows(filterSpec, { offset: 0, limit: 10 })).toEqual([
            [3, 'alpha'],
            [1, 'alpha'],
        ]);

        const distinct = store.distinctValues(undefined, 1, 10);
        expect(distinct.truncated).toBe(false);
        expect(distinct.values.map((entry) => entry.raw)).toEqual([null, 'alpha', 'beta']);

        const filteredDistinct = store.distinctValues(filterSpec, 1, 10);
        expect(filteredDistinct.truncated).toBe(false);
        expect(filteredDistinct.values).toEqual([{ raw: 'alpha', count: 2 }]);

        const aggs = store.aggregateRows(filterSpec, [
            { columnIndex: 0, fn: 'sum' },
            { columnIndex: 0, fn: 'count' },
        ]);
        expect(aggs).toEqual([
            { columnIndex: 0, fn: 'sum', value: 4 },
            { columnIndex: 0, fn: 'count', value: 2 },
        ]);

        const globalSpec: DiskQuerySpec = { globalSearch: 'bet' };
        expect(store.aggregateRows(globalSpec, [
            { columnIndex: 0, fn: 'max' },
            { columnIndex: 1, fn: 'countDistinct' },
        ])).toEqual([
            { columnIndex: 0, fn: 'max', value: 2 },
            { columnIndex: 1, fn: 'countDistinct', value: 1 },
        ]);

        expect(store.countRows(globalSpec)).toBe(1);
        expect(store.queryRows(globalSpec, { offset: 0, limit: 5 })).toEqual([[2, 'beta']]);

        const conditionSpec: DiskQuerySpec = {
            columnFilters: [{
                columnIndex: 0,
                conditions: [{ type: 'greaterThan', value: '2' }],
            }],
        };
        expect(store.countRows(conditionSpec)).toBe(2);
        expect(store.queryRows(conditionSpec, { offset: 0, limit: 10 })).toEqual([
            [3, 'alpha'],
            [4, null],
        ]);

        const textConditionSpec: DiskQuerySpec = {
            columnFilters: [{
                columnIndex: 1,
                conditions: [{ type: 'contains', value: 'lph' }],
            }],
        };
        expect(store.countRows(textConditionSpec)).toBe(2);
        expect(store.queryRows(textConditionSpec, { offset: 0, limit: 10 })).toEqual([
            [1, 'alpha'],
            [3, 'alpha'],
        ]);

        store.dispose();
    });

    it('sorts ABSTIME values stored as dates or epoch seconds', () => {
        const store = SqliteResultStore.create([{ name: 'conntime', type: 'ABSTIME' }], 10_000);
        store.insertRows([
            [new Date('2024-06-15T10:00:00.000Z')],
            [new Date('2023-01-01T10:00:00.000Z')],
            [1704067200],
        ]);

        const ascending = store.queryRows(
            { sorting: [{ columnIndex: 0, desc: false }] },
            { offset: 0, limit: 10 },
        );
        expect(ascending.map((row) => row[0])).toEqual([
            '2023-01-01T10:00:00.000Z',
            '2024-01-01T00:00:00.000Z',
            '2024-06-15T10:00:00.000Z',
        ]);

        store.dispose();
    });

    it('handles 100k rows with sort and filter', () => {
        const dbPath = path.join(os.tmpdir(), `justybase-query-100k-${Date.now()}.db`);
        tempPaths.push(dbPath);
        const store = SqliteResultStore.create([{ name: 'id', type: 'INTEGER' }], 10_000, dbPath);
        const rows: unknown[][] = [];
        for (let i = 0; i < 100_000; i++) {
            rows.push([i]);
        }
        store.insertRows(rows);

        const spec: DiskQuerySpec = {
            columnFilters: [{ columnIndex: 0, values: [42] }],
            sorting: [{ columnIndex: 0, desc: false }],
        };
        expect(store.countRows(spec)).toBe(1);
        expect(store.queryRows(spec, { offset: 0, limit: 1 })).toEqual([[42]]);

        store.dispose();
    });

    it('groups rows across the full SQLite store with filters, nulls, and sorting', () => {
        const store = createStoreWithGroupingRows();
        const result = store.queryGroups(
            { sorting: [{ columnIndex: 1, desc: true }] },
            [{ columnIndex: 1 }],
            [],
            { offset: 0, limit: 10 },
        );

        expect(result.kind).toBe('groups');
        expect(result.totalCount).toBe(3);
        expect(result.groups?.map((group) => ({ value: group.value, count: group.count }))).toEqual([
            { value: 'US', count: 2 },
            { value: 'EU', count: 2 },
            { value: null, count: 1 },
        ]);

        const filtered = store.queryGroups(
            { globalSearch: 'open' },
            [{ columnIndex: 1 }],
            [],
            { offset: 0, limit: 10 },
        );
        expect(filtered.groups?.map((group) => ({ value: group.value, count: group.count }))).toEqual([
            { value: 'EU', count: 1 },
            { value: 'US', count: 2 },
        ]);

        store.dispose();
    });

    it('queries nested groups, leaf rows, and group aggregations', () => {
        const store = createStoreWithGroupingRows();
        const root = store.queryGroups(
            undefined,
            [{ columnIndex: 1 }, { columnIndex: 2 }],
            [],
            { offset: 0, limit: 10 },
            [{ columnIndex: 3, fn: 'sum' }],
        );
        const eu = root.groups?.find((group) => group.value === 'EU');
        expect(eu).toMatchObject({
            columnIndex: 1,
            depth: 0,
            count: 2,
            aggregations: [{ columnIndex: 3, fn: 'sum', value: 30 }],
        });

        const nested = store.queryGroups(
            undefined,
            [{ columnIndex: 1 }, { columnIndex: 2 }],
            eu?.path ?? [],
            { offset: 0, limit: 10 },
        );
        expect(nested.kind).toBe('groups');
        expect(nested.groups?.map((group) => ({ value: group.value, count: group.count }))).toEqual([
            { value: 'closed', count: 1 },
            { value: 'open', count: 1 },
        ]);

        const leaf = store.queryGroups(
            { sorting: [{ columnIndex: 3, desc: true }] },
            [{ columnIndex: 1 }, { columnIndex: 2 }],
            [
                { columnIndex: 1, value: 'US' },
                { columnIndex: 2, value: 'open' },
            ],
            { offset: 0, limit: 10 },
            [{ columnIndex: 3, fn: 'avg' }],
        );
        expect(leaf.kind).toBe('leafRows');
        expect(leaf.totalCount).toBe(2);
        expect(leaf.rows).toEqual([
            [4, 'US', 'open', 40],
            [3, 'US', 'open', 30],
        ]);
        expect(leaf.aggregations).toEqual([{ columnIndex: 3, fn: 'avg', value: 35 }]);

        const stdevResult = store.aggregateRows(
            undefined,
            [{ columnIndex: 3, fn: 'stdev' }],
        );
        expect(stdevResult).toHaveLength(1);
        expect(stdevResult[0]?.fn).toBe('stdev');
        expect(typeof stdevResult[0]?.value).toBe('number');

        const singleValueStdev = store.aggregateRows(
            { columnFilters: [{ columnIndex: 0, values: [5] }] },
            [{ columnIndex: 3, fn: 'stdev' }],
        );
        expect(singleValueStdev).toEqual([{ columnIndex: 3, fn: 'stdev', value: 0 }]);

        const nullLeaf = store.queryGroups(
            undefined,
            [{ columnIndex: 1 }],
            [{ columnIndex: 1, value: null }],
            { offset: 0, limit: 10 },
        );
        expect(nullLeaf.rows).toEqual([[5, null, 'closed', 50]]);

        store.dispose();
    });
});
