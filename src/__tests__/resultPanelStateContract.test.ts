import { ResultStateManager } from '../state/resultStateManager';
import type { ResultSet } from '../types';

jest.mock('../utils/logger', () => ({
    getLogger: jest.fn().mockReturnValue({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
}));

jest.mock(
    'vscode',
    () => ({
        EventEmitter: jest.fn().mockImplementation(() => {
            const listeners: Array<(value: unknown) => void> = [];
            return {
                event: jest.fn().mockImplementation((listener: (value: unknown) => void) => {
                    listeners.push(listener);
                    return {
                        dispose: jest.fn(() => {
                            const index = listeners.indexOf(listener);
                            if (index >= 0) listeners.splice(index, 1);
                        }),
                    };
                }),
                fire: jest.fn().mockImplementation((value: unknown) => {
                    listeners.slice().forEach(listener => listener(value));
                }),
            };
        }),
        workspace: {
            getConfiguration: jest.fn().mockImplementation((section: string) => ({
                get: jest.fn().mockImplementation((key: string, defaultValue: unknown) => {
                    if (section === 'netezza.results' && key === 'maxDataResults') return 50;
                    if (section === 'netezza.results' && key === 'maxPinnedDataResults') return 10;
                    return defaultValue;
                }),
            })),
        },
        window: {
            showInformationMessage: jest.fn(),
            showWarningMessage: jest.fn().mockResolvedValue(undefined),
        },
    }),
    { virtual: true },
);

function dataResult(resultSetId: string, value: number): ResultSet {
    return {
        columns: [{ name: 'id', type: 'int' }],
        data: [[value]],
        name: resultSetId,
        resultSetId,
    };
}

function pinEntryFor(manager: ResultStateManager, sourceUri: string, resultSetIndex: number) {
    return Array.from(manager.pinnedResults.entries()).find(([, info]) =>
        info.sourceUri === sourceUri && info.resultSetIndex === resultSetIndex
    );
}

describe('Result Panel state contract', () => {
    let manager: ResultStateManager;

    beforeEach(() => {
        manager = new ResultStateManager();
    });

    afterEach(() => {
        manager.disposeAllDiskStores();
        manager.dispose();
    });

    it('preserves identity and manually pinned results across source switches and re-execution', () => {
        const sourceA = 'file:///contract-a.sql';
        const sourceB = 'file:///contract-b.sql';

        manager.startExecution(sourceA);
        manager.updateResults([dataResult('a-result-1', 1), dataResult('a-result-2', 2)], sourceA);

        const automaticPin = pinEntryFor(manager, sourceA, 1);
        expect(automaticPin).toBeDefined();
        manager.pinnedResults.delete(automaticPin![0]);
        manager.toggleResultPin(sourceA, 1);

        manager.setActiveResultSetIndex(sourceA, 2);
        manager.startExecution(sourceB);
        manager.updateResults([dataResult('b-result-1', 3)], sourceB);
        expect(manager.activeSourceUri).toBe(sourceB);

        manager.setActiveSource(sourceA);
        expect(manager.getActiveResultSetIndex(sourceA)).toBe(2);

        manager.startExecution(sourceA);
        const results = manager.resultsMap.get(sourceA) ?? [];

        expect(results[0]?.isLog).toBe(true);
        expect(results.map(result => result.resultSetId)).toContain('a-result-1');
        expect(results.map(result => result.resultSetId)).not.toContain('a-result-2');
        expect(manager.getActiveResultSetIndex(sourceA)).toBe(0);

        const retainedPin = pinEntryFor(manager, sourceA, 1);
        expect(retainedPin?.[1].resultSetIndex).toBe(1);
        expect(manager.resultsMap.get(sourceB)?.map(result => result.resultSetId)).toContain('b-result-1');
    });

    it('shifts pinned and active indices when a result is closed', () => {
        const sourceUri = 'file:///contract-close.sql';
        manager.startExecution(sourceUri);
        manager.updateResults([dataResult('first', 1), dataResult('second', 2)], sourceUri);
        manager.setActiveResultSetIndex(sourceUri, 2);

        const secondPin = pinEntryFor(manager, sourceUri, 2);
        expect(secondPin).toBeDefined();

        manager.closeResult(sourceUri, 1);

        const results = manager.resultsMap.get(sourceUri) ?? [];
        expect(results[1]?.resultSetId).toBe('second');
        expect(manager.getActiveResultSetIndex(sourceUri)).toBe(1);
        expect(pinEntryFor(manager, sourceUri, 1)?.[0]).toBe(secondPin![0]);
    });

    it('keeps partial streaming data marked cancelled and ignores late chunks', () => {
        const sourceUri = 'file:///contract-stream.sql';
        manager.startExecution(sourceUri);

        const firstChunk = manager.appendStreamingChunk(
            sourceUri,
            {
                columns: [{ name: 'id', type: 'int' }],
                rows: [[1], [2]],
                isFirstChunk: true,
                isLastChunk: false,
                totalRowsSoFar: 2,
                limitReached: false,
            },
            'SELECT id FROM stream',
        );
        expect(firstChunk.type).toBe('incremental');

        const nextChunk = manager.appendStreamingChunk(
            sourceUri,
            {
                columns: [{ name: 'id', type: 'int' }],
                rows: [[3]],
                isFirstChunk: false,
                isLastChunk: false,
                totalRowsSoFar: 3,
                limitReached: false,
            },
            'SELECT id FROM stream',
        );
        expect(nextChunk.type).toBe('incremental');

        manager.cancelExecution(sourceUri, [1, 2]);

        const result = manager.resultsMap.get(sourceUri)?.[1];
        expect(result?.isCancelled).toBe(true);
        expect(result?.data).toHaveLength(2);
        expect(result?.totalRowCount).toBe(2);
        expect(manager.executingSources.has(sourceUri)).toBe(false);
        expect(manager.appendStreamingChunk(
            sourceUri,
            {
                columns: [{ name: 'id', type: 'int' }],
                rows: [[4]],
                isFirstChunk: false,
                isLastChunk: true,
                totalRowsSoFar: 3,
                limitReached: false,
            },
            'SELECT id FROM stream',
        ).type).toBe('ignore');
    });

    it('removes source-owned state and selects a surviving source on close', () => {
        const sourceA = 'file:///contract-remove-a.sql';
        const sourceB = 'file:///contract-remove-b.sql';
        manager.startExecution(sourceA);
        manager.updateResults([dataResult('a-result', 1)], sourceA);
        manager.startExecution(sourceB);
        manager.updateResults([dataResult('b-result', 2)], sourceB);

        manager.setActiveSource(sourceA);
        manager.closeSource(sourceA);

        expect(manager.resultsMap.has(sourceA)).toBe(false);
        expect(manager.pinnedSources.has(sourceA)).toBe(false);
        expect(Array.from(manager.pinnedResults.values()).some(pin => pin.sourceUri === sourceA)).toBe(false);
        expect(manager.activeSourceUri).toBe(sourceB);
        expect(manager.resultsMap.get(sourceB)?.map(result => result.resultSetId)).toContain('b-result');
    });
});

