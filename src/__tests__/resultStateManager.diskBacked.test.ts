jest.mock('../utils/logger', () => ({
    getLogger: jest.fn().mockReturnValue({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
}));

jest.mock('../core/resultDataProvider/diskBackedSettings', () => ({
    getDiskBackedResultsSettings: () => ({
        enabled: true,
        rowThreshold: 500000,
        memoryRowThreshold: 5,
        insertBatchSize: 100,
    }),
    getEffectiveSpillThreshold: () => 5,
    isDiskBackedResultsAvailable: () => {
        try {
             
            require('node:sqlite');
            return true;
        } catch {
            return false;
        }
    },
}));

jest.mock(
    'vscode',
    () => ({
        EventEmitter: jest.fn().mockImplementation(() => {
            const listeners: Array<(data: unknown) => void> = [];
            return {
                event: jest.fn().mockImplementation((callback: (data: unknown) => void) => {
                    listeners.push(callback);
                    return { dispose: jest.fn() };
                }),
                fire: jest.fn().mockImplementation((data: unknown) => {
                    listeners.forEach((callback) => callback(data));
                }),
            };
        }),
        workspace: {
            getConfiguration: jest.fn().mockReturnValue({
                get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
            }),
        },
    }),
    { virtual: true },
);

import { ResultStateManager } from '../state/resultStateManager';
import { diskBackedStoreRegistry } from '../core/resultDataProvider/diskBackedStoreRegistry';
import { SqliteResultStore } from '../core/resultDataProvider/sqliteResultStore';

function isNodeSqliteAvailable(): boolean {
    try {
         
        require('node:sqlite');
        return true;
    } catch {
        return false;
    }
}

const describeIfSqlite = isNodeSqliteAvailable() ? describe : describe.skip;

describeIfSqlite('ResultStateManager disk-backed migration', () => {
    let manager: ResultStateManager;

    beforeEach(() => {
        manager = new ResultStateManager();
    });

    afterEach(() => {
        manager.disposeAllDiskStores();
        manager.dispose();
    });

    it('migrates to SQLite and clears host data when threshold is reached', () => {
        const sourceUri = 'file:///disk-test.sql';
        manager.startExecution(sourceUri);

        manager.appendStreamingChunk(sourceUri, {
            columns: [{ name: 'id', type: 'INTEGER' }],
            rows: [[1], [2], [3]],
            isFirstChunk: true,
            isLastChunk: false,
            totalRowsSoFar: 3,
            limitReached: false,
        }, 'SELECT * FROM t');

        const migrateResult = manager.appendStreamingChunk(sourceUri, {
            columns: [{ name: 'id', type: 'INTEGER' }],
            rows: [[4], [5]],
            isFirstChunk: false,
            isLastChunk: false,
            totalRowsSoFar: 5,
            limitReached: false,
        }, 'SELECT * FROM t');

        expect(migrateResult.type).toBe('diskBackedActivate');
        const resultSet = manager.resultsMap.get(sourceUri)![1];
        expect(resultSet.storageMode).toBe('sqlite');
        expect(resultSet.data).toHaveLength(0);
        expect(resultSet.totalRowCount).toBe(5);
        expect(resultSet.diskStoreId).toBeDefined();

        const rows = manager.getDiskBackedRows(resultSet.diskStoreId!, 0, 10);
        expect(rows).toEqual([[1], [2], [3], [4], [5]]);
    });

    it('migrates BIGINT extremes to SQLite instead of falling back to memory', () => {
        const sourceUri = 'file:///disk-bigint-extremes.sql';
        manager.startExecution(sourceUri);

        manager.appendStreamingChunk(sourceUri, {
            columns: [{ name: 'big_id', type: 'BIGINT' }],
            rows: [
                [1],
                ['111111111111111111'],
                [BigInt('9223372036854775807')],
            ],
            isFirstChunk: true,
            isLastChunk: false,
            totalRowsSoFar: 3,
            limitReached: false,
        }, 'SELECT 111111111111111111::BIGINT FROM JUST_DATA.ADMIN.FACTPRODUCTINVENTORY');

        const migrateResult = manager.appendStreamingChunk(sourceUri, {
            columns: [{ name: 'big_id', type: 'BIGINT' }],
            rows: [
                [BigInt('-9223372036854775808')],
                [BigInt(Number.MAX_SAFE_INTEGER) + 1n],
            ],
            isFirstChunk: false,
            isLastChunk: false,
            totalRowsSoFar: 5,
            limitReached: false,
        }, 'SELECT 111111111111111111::BIGINT FROM JUST_DATA.ADMIN.FACTPRODUCTINVENTORY');

        expect(migrateResult.type).toBe('diskBackedActivate');
        const resultSet = manager.resultsMap.get(sourceUri)![1];
        expect(resultSet.storageMode).toBe('sqlite');
        expect(resultSet.data).toHaveLength(0);
        expect(resultSet.totalRowCount).toBe(5);
        expect(manager.getDiskBackedRows(resultSet.diskStoreId!, 0, 10)).toEqual([
            [1],
            ['111111111111111111'],
            ['9223372036854775807'],
            ['-9223372036854775808'],
            ['9007199254740992'],
        ]);
    });

    it('uses separate SQLite stores for concurrent result sets', () => {
        const sourceUri = 'file:///disk-multi.sql';
        manager.startExecution(sourceUri);

        manager.appendStreamingChunk(sourceUri, {
            columns: [{ name: 'id', type: 'INTEGER' }],
            rows: [[1], [2], [3]],
            isFirstChunk: true,
            isLastChunk: false,
            totalRowsSoFar: 3,
            limitReached: false,
        }, 'SELECT 1');

        manager.appendStreamingChunk(sourceUri, {
            columns: [{ name: 'id', type: 'INTEGER' }],
            rows: [[4], [5]],
            isFirstChunk: false,
            isLastChunk: true,
            totalRowsSoFar: 5,
            limitReached: false,
        }, 'SELECT 1');

        manager.appendStreamingChunk(sourceUri, {
            columns: [{ name: 'id', type: 'INTEGER' }],
            rows: [[10], [11], [12]],
            isFirstChunk: true,
            isLastChunk: false,
            totalRowsSoFar: 3,
            limitReached: false,
        }, 'SELECT 2');

        const migrateSecond = manager.appendStreamingChunk(sourceUri, {
            columns: [{ name: 'id', type: 'INTEGER' }],
            rows: [[13], [14]],
            isFirstChunk: false,
            isLastChunk: true,
            totalRowsSoFar: 5,
            limitReached: false,
        }, 'SELECT 2');

        expect(migrateSecond.type).toBe('diskBackedActivate');
        const results = manager.resultsMap.get(sourceUri)!.filter((rs) => rs.storageMode === 'sqlite');
        expect(results).toHaveLength(2);
        expect(results[0].diskStoreId).toBeDefined();
        expect(results[1].diskStoreId).toBeDefined();
        expect(results[0].diskStoreId).not.toBe(results[1].diskStoreId);
        expect(diskBackedStoreRegistry.get(results[0].diskStoreId!)).toBeDefined();
        expect(diskBackedStoreRegistry.get(results[1].diskStoreId!)).toBeDefined();
    });

    it('disposes SQLite temp store when a result tab is closed', () => {
        const sourceUri = 'file:///disk-close.sql';
        manager.startExecution(sourceUri);

        manager.appendStreamingChunk(sourceUri, {
            columns: [{ name: 'id', type: 'INTEGER' }],
            rows: [[1], [2], [3]],
            isFirstChunk: true,
            isLastChunk: false,
            totalRowsSoFar: 3,
            limitReached: false,
        }, 'SELECT * FROM t');

        manager.appendStreamingChunk(sourceUri, {
            columns: [{ name: 'id', type: 'INTEGER' }],
            rows: [[4], [5]],
            isFirstChunk: false,
            isLastChunk: true,
            totalRowsSoFar: 5,
            limitReached: false,
        }, 'SELECT * FROM t');

        const resultSet = manager.resultsMap.get(sourceUri)!.find((rs) => rs.storageMode === 'sqlite')!;
        const storeId = resultSet.diskStoreId!;
        expect(diskBackedStoreRegistry.get(storeId)).toBeDefined();

        manager.closeResult(sourceUri, manager.resultsMap.get(sourceUri)!.indexOf(resultSet));
        expect(diskBackedStoreRegistry.get(storeId)).toBeUndefined();
        expect(resultSet.diskStoreId).toBeUndefined();
    });

    it('truncates SQLite rows when execution is cancelled', () => {
        const sourceUri = 'file:///disk-cancel.sql';
        manager.startExecution(sourceUri);

        manager.appendStreamingChunk(sourceUri, {
            columns: [{ name: 'id', type: 'INTEGER' }],
            rows: [[1], [2], [3]],
            isFirstChunk: true,
            isLastChunk: false,
            totalRowsSoFar: 3,
            limitReached: false,
        }, 'SELECT * FROM t');

        manager.appendStreamingChunk(sourceUri, {
            columns: [{ name: 'id', type: 'INTEGER' }],
            rows: [[4], [5]],
            isFirstChunk: false,
            isLastChunk: false,
            totalRowsSoFar: 5,
            limitReached: false,
        }, 'SELECT * FROM t');

        const resultSet = manager.resultsMap.get(sourceUri)!.find((rs) => rs.storageMode === 'sqlite')!;
        const storeId = resultSet.diskStoreId!;

        manager.cancelExecution(sourceUri, [0, 3]);

        expect(resultSet.totalRowCount).toBe(3);
        expect(manager.getDiskBackedRows(storeId, 0, 10)).toEqual([[1], [2], [3]]);
    });

    it('spills large result sets delivered via updateResults', () => {
        const sourceUri = 'file:///disk-update.sql';
        const rows = Array.from({ length: 5 }, (_, index) => [index + 1]);

        manager.updateResults([{
            columns: [{ name: 'id', type: 'INTEGER' }],
            data: rows,
            executionTimestamp: Date.now(),
        }], sourceUri);

        const resultSet = manager.resultsMap.get(sourceUri)![0];
        expect(resultSet.storageMode).toBe('sqlite');
        expect(resultSet.data).toHaveLength(0);
        expect(resultSet.totalRowCount).toBe(5);
        expect(manager.getDiskBackedRows(resultSet.diskStoreId!, 0, 10)).toEqual(rows.map((row) => [row[0]]));
    });

    it('keeps in-memory rows intact when SQLite spill fails', () => {
        const insertSpy = jest.spyOn(SqliteResultStore.prototype, 'insertRows').mockImplementation(() => {
            throw new Error('disk full');
        });

        const sourceUri = 'file:///spill-fail.sql';
        manager.startExecution(sourceUri);

        manager.appendStreamingChunk(sourceUri, {
            columns: [{ name: 'id', type: 'INTEGER' }],
            rows: [[1], [2], [3]],
            isFirstChunk: true,
            isLastChunk: false,
            totalRowsSoFar: 3,
            limitReached: false,
        }, 'SELECT * FROM t');

        const migrateResult = manager.appendStreamingChunk(sourceUri, {
            columns: [{ name: 'id', type: 'INTEGER' }],
            rows: [[4], [5]],
            isFirstChunk: false,
            isLastChunk: false,
            totalRowsSoFar: 5,
            limitReached: false,
        }, 'SELECT * FROM t');

        expect(migrateResult.type).not.toBe('diskBackedActivate');
        const resultSet = manager.resultsMap.get(sourceUri)![1];
        expect(resultSet.storageMode).not.toBe('sqlite');
        expect(resultSet.data).toEqual([[1], [2], [3], [4], [5]]);

        insertSpy.mockRestore();
    });
});
