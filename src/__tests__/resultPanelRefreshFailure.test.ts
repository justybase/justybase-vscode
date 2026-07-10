import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { ResultStateManager } from '../state/resultStateManager';
import type { ResultSet } from '../types';

describe('result panel refresh failure state', () => {
    const sourceUri = 'file:///refresh-failure.sql';
    let stateManager: ResultStateManager;
    let resultSet: ResultSet;

    beforeEach(() => {
        stateManager = new ResultStateManager();
        resultSet = {
            columns: [{ name: 'ID' }],
            data: [[1], [2]],
            sql: 'SELECT * FROM T',
            refreshSql: 'SELECT * FROM T',
            executionTimestamp: 1000,
        };
        stateManager.updateResults([resultSet], sourceUri);
    });

    afterEach(() => {
        stateManager.dispose();
    });

    it('stores refresh failure without replacing result data', () => {
        stateManager.setResultSetRefreshFailure(sourceUri, 0, {
            message: 'Error: Connection is already executing a command',
            sql: 'SELECT * FROM T LIMIT 10',
        });

        const stored = stateManager.resultsMap.get(sourceUri)?.[0];
        expect(stored?.data).toEqual([[1], [2]]);
        expect(stored?.isError).toBeUndefined();
        expect(stored?.refreshFailure?.message).toContain('already executing');
        expect(stored?.refreshFailure?.sql).toContain('LIMIT 10');
    });

    it('clears refresh failure without touching grid data', () => {
        stateManager.setResultSetRefreshFailure(sourceUri, 0, {
            message: 'Refresh failed',
        });
        stateManager.clearResultSetRefreshFailure(sourceUri, 0);

        const stored = stateManager.resultsMap.get(sourceUri)?.[0];
        expect(stored?.data).toEqual([[1], [2]]);
        expect(stored?.refreshFailure).toBeUndefined();
    });
});
