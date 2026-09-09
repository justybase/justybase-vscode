import type { QueryEvent } from '@justybase/contracts';
import { newEditorTab, type EditorTab } from './workspaceDocumentController';
import { applyEventToEditorTab, clearLiveQueryState, statementStateFor } from './workspaceExecutionController';

describe('workspace execution controller', () => {
  it('keeps statement states and result state aligned for streamed batches', () => {
    let tab: EditorTab = { ...newEditorTab(1, 'tab-1'), running: true };
    tab = applyEventToEditorTab(tab, { type: 'started', queryId: 'query-1', mode: 'script', statementCount: 2, startedAt: 1, sequence: 1 });
    tab = applyEventToEditorTab(tab, { type: 'statement-started', queryId: 'query-1', statementIndex: 0, statementCount: 2, statementSql: 'SELECT 1', sequence: 2 });
    tab = applyEventToEditorTab(tab, { type: 'complete', queryId: 'query-1', statementIndex: 0, statementCount: 2, totalRows: 1, limitReached: false, sequence: 3 });
    tab = applyEventToEditorTab(tab, { type: 'batch-complete', queryId: 'query-1', statementCount: 2, status: 'complete', completedStatements: 1, sequence: 4 });

    expect(tab.statementStates[0]).toEqual(expect.objectContaining({ status: 'success' }));
    expect(tab.statementStates[1]).toEqual({ status: 'skipped' });
    expect(tab.batchStatus).toBe('complete');
    expect(tab.running).toBe(false);
    expect(statementStateFor(tab, 0).status).toBe('success');
  });

  it('clears live execution data without changing the document', () => {
    const source = newEditorTab(1, 'tab-1');
    const live = applyEventToEditorTab({ ...source, running: true }, { type: 'session', queryId: 'query-1', statementIndex: 0, statementCount: 1, sessionId: 'session-1', totalRows: 0, sequence: 1 });
    const cleared = clearLiveQueryState({ ...live, queryId: 'query-1', running: true });
    expect(cleared.sql).toBe(source.sql);
    expect(cleared.queryId).toBeUndefined();
    expect(cleared.running).toBe(false);
    expect(cleared.results).toEqual({});
    expect(cleared.statementStates).toEqual({});
  });

  it('does not mutate the previous tab while applying an event', () => {
    const previous = newEditorTab(1, 'tab-1');
    const event: QueryEvent = { type: 'columns', queryId: 'query-1', columns: [{ name: 'ID', type: 'INT' }], sequence: 1 };
    const next = applyEventToEditorTab(previous, event);
    expect(previous.results).toEqual({});
    expect(next.results[0]?.columns).toEqual(['ID']);
  });
});
