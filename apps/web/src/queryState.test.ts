import type { QueryEvent } from '@justybase/contracts';
import { applyQueryEvent, emptyResult } from './queryState';

describe('query result state', () => {
  it('accumulates streamed rows and completes with the server count', () => {
    const columns: QueryEvent = { type: 'columns', queryId: 'q1', columns: [{ name: 'ID', type: 'INT' }] };
    const rows: QueryEvent = { type: 'rows', queryId: 'q1', rows: [[1], [2]], totalRows: 2 };
    const complete: QueryEvent = { type: 'complete', queryId: 'q1', totalRows: 2, limitReached: false };
    const state = applyQueryEvent(applyQueryEvent(applyQueryEvent(emptyResult, columns), rows), complete);
    expect(state.columns).toEqual(['ID']);
    expect(state.columnTypes).toEqual(['INT']);
    expect(state.rows).toEqual([[1], [2]]);
    expect(state.status).toBe('complete');
    expect(state.totalRows).toBe(2);
  });

  it('keeps statement results separate and ignores replayed events', () => {
    const started: QueryEvent = { type: 'started', queryId: 'q2', mode: 'script', statementCount: 2, startedAt: 1, sequence: 1 };
    const first: QueryEvent = { type: 'statement-started', queryId: 'q2', statementIndex: 0, statementCount: 2, statementSql: 'SELECT 1', sequence: 2 };
    const session: QueryEvent = { type: 'session', queryId: 'q2', statementIndex: 0, statementCount: 2, sessionId: 's1', totalRows: 0, sequence: 3 };
    const complete: QueryEvent = { type: 'complete', queryId: 'q2', statementIndex: 0, statementCount: 2, totalRows: 1, limitReached: false, rowsAffected: 1, sequence: 4 };
    let state = applyQueryEvent(emptyResult, started);
    state = applyQueryEvent(state, first);
    state = applyQueryEvent(state, session);
    state = applyQueryEvent(state, complete);
    expect(applyQueryEvent(state, session)).toBe(state);
    expect(state.statementIndex).toBe(0);
    expect(state.sessionId).toBe('s1');
    expect(state.rowsAffected).toBe(1);
    const second = applyQueryEvent(emptyResult, { type: 'statement-started', queryId: 'q2', statementIndex: 1, statementCount: 2, statementSql: 'SELECT 2', sequence: 5 });
    expect(second.statementIndex).toBe(1);
    expect(second.statementSql).toBe('SELECT 2');
  });

  it('records batch terminal status independently from statement status', () => {
    const statement = applyQueryEvent(emptyResult, { type: 'error', queryId: 'q3', statementIndex: 1, statementCount: 3, message: 'syntax error', sequence: 8 });
    const batch = applyQueryEvent(statement, { type: 'batch-complete', queryId: 'q3', statementCount: 3, status: 'error', completedStatements: 1, message: 'Stopped after statement 2.', sequence: 9 });
    expect(batch.status).toBe('error');
    expect(batch.batchStatus).toBe('error');
    expect(batch.statementIndex).toBe(1);
    expect(batch.message).toBe('Stopped after statement 2.');
  });
});
