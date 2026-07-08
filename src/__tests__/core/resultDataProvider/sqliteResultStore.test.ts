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

describeIfSqlite('SqliteResultStore', () => {
    const tempPaths: string[] = [];

    afterEach(() => {
        for (const tempPath of tempPaths.splice(0)) {
            try {
                if (fs.existsSync(tempPath)) {
                    fs.unlinkSync(tempPath);
                }
            } catch {
                // ignore cleanup errors in tests
            }
        }
    });

    it('inserts, reads, and disposes 100k synthetic rows', () => {
        const dbPath = path.join(os.tmpdir(), `justybase-test-${Date.now()}.db`);
        tempPaths.push(dbPath);

        const columns = [
            { name: 'id', type: 'INTEGER' },
            { name: 'label', type: 'VARCHAR' },
        ];
        const store = SqliteResultStore.create(columns, 10_000, dbPath);

        const rows: unknown[][] = [];
        for (let i = 0; i < 100_000; i++) {
            rows.push([i, `row-${i}`]);
        }
        store.insertRows(rows);

        expect(store.getTotalRows()).toBe(100_000);
        expect(store.getRows({ offset: 0, limit: 2 })).toEqual([[0, 'row-0'], [1, 'row-1']]);
        expect(store.getRows({ offset: 99_998, limit: 5 })).toEqual([[99_998, 'row-99998'], [99_999, 'row-99999']]);

        store.dispose();
        expect(fs.existsSync(dbPath)).toBe(false);
    });

    it('truncates rows and finalizes bulk insert mode', () => {
        const dbPath = path.join(os.tmpdir(), `justybase-truncate-${Date.now()}.db`);
        tempPaths.push(dbPath);

        const store = SqliteResultStore.create(
            [{ name: 'id', type: 'INTEGER' }],
            1_000,
            dbPath,
        );
        store.insertRows([[1], [2], [3], [4], [5]]);
        store.truncateToRowCount(3);
        expect(store.getTotalRows()).toBe(3);
        expect(store.getRows({ offset: 0, limit: 10 })).toEqual([[1], [2], [3]]);

        store.finalizeBulkInsert();
        store.dispose();
    });

    it('reads BIGINT extremes without JavaScript number range errors', () => {
        const dbPath = path.join(os.tmpdir(), `justybase-bigint-${Date.now()}.db`);
        tempPaths.push(dbPath);

        const store = SqliteResultStore.create(
            [{ name: 'big_id', type: 'BIGINT' }],
            1_000,
            dbPath,
        );
        store.insertRows([
            [BigInt(Number.MAX_SAFE_INTEGER)],
            [BigInt(Number.MAX_SAFE_INTEGER) + 1n],
            ['111111111111111111'],
            [BigInt('9223372036854775807')],
            [BigInt('-9223372036854775808')],
        ]);

        expect(store.getRows({ offset: 0, limit: 10 })).toEqual([
            [Number.MAX_SAFE_INTEGER],
            ['9007199254740992'],
            ['111111111111111111'],
            ['9223372036854775807'],
            ['-9223372036854775808'],
        ]);

        expect(store.queryRows({
            columnFilters: [{ columnIndex: 0, values: ['111111111111111111'] }],
        }, { offset: 0, limit: 10 })).toEqual([
            ['111111111111111111'],
        ]);

        expect(store.queryRows({
            columnFilters: [{
                columnIndex: 0,
                conditions: [{ type: 'greaterThan', value: '111111111111111111' }],
            }],
        }, { offset: 0, limit: 10 })).toEqual([
            ['9223372036854775807'],
        ]);

        expect(store.queryRows({
            sorting: [{ columnIndex: 0, desc: false }],
        }, { offset: 0, limit: 10 })).toEqual([
            ['-9223372036854775808'],
            [Number.MAX_SAFE_INTEGER],
            ['9007199254740992'],
            ['111111111111111111'],
            ['9223372036854775807'],
        ]);

        const distinct = store.distinctValues(undefined, 0, 10);
        expect(distinct.truncated).toBe(false);
        expect(distinct.values).toHaveLength(5);
        expect(distinct.values).toEqual(expect.arrayContaining([
            { raw: Number.MAX_SAFE_INTEGER, count: 1 },
            { raw: '9007199254740992', count: 1 },
            { raw: '111111111111111111', count: 1 },
            { raw: '9223372036854775807', count: 1 },
            { raw: '-9223372036854775808', count: 1 },
        ]));

        const aggregations = store.aggregateRows(undefined, [
            { columnIndex: 0, fn: 'min' },
            { columnIndex: 0, fn: 'max' },
            { columnIndex: 0, fn: 'count' },
        ]);
        expect(aggregations).toEqual([
            { columnIndex: 0, fn: 'min', value: '-9223372036854775808' },
            { columnIndex: 0, fn: 'max', value: '9223372036854775807' },
            { columnIndex: 0, fn: 'count', value: 5 },
        ]);

        const groups = store.queryGroups(
            undefined,
            [{ columnIndex: 0 }],
            [],
            { offset: 0, limit: 10 },
        );
        expect(groups.kind).toBe('groups');
        expect(groups.groups).toEqual(expect.arrayContaining([
            expect.objectContaining({
                value: '111111111111111111',
                count: 1,
                path: [{ columnIndex: 0, value: '111111111111111111' }],
            }),
        ]));

        store.dispose();
    });
});
