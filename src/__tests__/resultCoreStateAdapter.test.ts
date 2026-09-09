import { ResultCoreStateAdapter, resultSetToCoreInput } from '../state/resultCoreStateAdapter';
import type { ResultSet } from '../types';

function resultSet(overrides: Partial<ResultSet> = {}): ResultSet {
    return {
        columns: [{ name: 'id', type: 'INTEGER' }],
        data: [[1]],
        executionTimestamp: 42,
        ...overrides,
    };
}

describe('ResultCoreStateAdapter', () => {
    it('projects stable, storage and legacy identities without mutating result data', () => {
        const legacy = resultSet();
        const stored = resultSet({
            resultSetId: 'stored-result',
            storageSessionId: 'session-1',
            storageMode: 'sqlite',
            totalRowCount: 8,
            lastChunkSequence: 3,
            data: [[2]],
        });
        const adapter = new ResultCoreStateAdapter();

        adapter.syncSource(
            'file:///query.sql',
            [legacy, stored],
            [{ resultId: 'pin-1', sourceId: 'file:///query.sql', resultSetIndex: 0, timestamp: 10, label: 'legacy', automatic: false }],
            1,
            true,
            'execution-1',
        );

        const source = adapter.getSource('file:///query.sql');
        expect(source?.resultSets.map(item => item.resultSetId)).toEqual(['legacy-result-42', 'stored-result']);
        expect(source?.activeResultSetId).toBe('stored-result');
        expect(source?.resultSets[1]).toMatchObject({ storageSessionId: 'session-1', loadedRowCount: 8, lastChunkSequence: 3 });
        expect(adapter.state.pinnedResults[0]).toMatchObject({ resultSetId: 'legacy-result-42', resultSetIndex: 0 });
        expect(legacy.resultSetId).toBeUndefined();
    });

    it('creates an adapter input with a stable fallback without copying row buffers', () => {
        const original = resultSet();
        const input = resultSetToCoreInput('untitled:Untitled-1', 'execution-2', original);

        expect(input.resultSetId).toBe('legacy-result-42');
        expect(input.executionId).toBe('execution-2');
        expect(input.data).toEqual([]);
        expect(input.loadedRowCount).toBe(original.data.length);

        const storedInput = resultSetToCoreInput('untitled:Untitled-1', 'execution-2', resultSet({
            storageMode: 'sqlite',
            totalRowCount: 8,
            data: [],
        }));
        expect(storedInput.status).toBe('complete');
        expect(storedInput.loadedRowCount).toBe(8);
    });
});
