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
});
