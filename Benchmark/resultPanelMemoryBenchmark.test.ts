/**
 * Result panel memory benchmark — verifies spill keeps host row buffers bounded.
 *
 * Run:
 *   npx jest --config Benchmark/jest.config.js --runInBand Benchmark/resultPanelMemoryBenchmark.test.ts
 */

import { ResultStateManager } from '../src/state/resultStateManager';

jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn().mockReturnValue({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
}));

jest.mock('../src/core/resultDataProvider/diskBackedSettings', () => ({
    getDiskBackedResultsSettings: () => ({
        enabled: true,
        rowThreshold: 500000,
        memoryRowThreshold: 1000,
        insertBatchSize: 500,
        idleSpillMinutes: 0,
        idleSpillRowThreshold: 1000,
    }),
    getEffectiveSpillThreshold: () => 1000,
    isDiskBackedResultsAvailable: () => {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
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

function isNodeSqliteAvailable(): boolean {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('node:sqlite');
        return true;
    } catch {
        return false;
    }
}

const describeIfSqlite = isNodeSqliteAvailable() ? describe : describe.skip;

describeIfSqlite('result panel memory benchmark', () => {
    it('keeps host RAM bounded after spill for large streaming results', () => {
        const manager = new ResultStateManager();
        const sourceUri = 'file:///bench-large.sql';
        manager.startExecution(sourceUri);

        const chunkSize = 500;
        const totalRows = 5000;
        let rowsSoFar = 0;

        while (rowsSoFar < totalRows) {
            const remaining = totalRows - rowsSoFar;
            const currentChunkSize = Math.min(chunkSize, remaining);
            const rows = Array.from({ length: currentChunkSize }, (_, index) => [rowsSoFar + index + 1]);
            rowsSoFar += currentChunkSize;

            manager.appendStreamingChunk(sourceUri, {
                columns: [{ name: 'id', type: 'INTEGER' }],
                rows,
                isFirstChunk: rowsSoFar === currentChunkSize,
                isLastChunk: rowsSoFar >= totalRows,
                totalRowsSoFar: rowsSoFar,
                limitReached: false,
            }, 'SELECT generate_series(1, 5000)');
        }

        const resultSet = manager.resultsMap.get(sourceUri)!.find((rs) => !rs.isLog)!;
        expect(resultSet.storageMode).toBe('sqlite');
        expect(resultSet.data).toHaveLength(0);
        expect(resultSet.totalRowCount).toBe(totalRows);

        manager.disposeAllDiskStores();
        manager.dispose();
    });
});
