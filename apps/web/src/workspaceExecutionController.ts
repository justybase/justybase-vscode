import type { QueryEvent } from '@justybase/contracts';
import { applyQueryEvent, emptyResult, type ResultState } from './queryState';
import type { EditorTab, StatementExecutionState } from './workspaceDocumentController';

export function statementStatusLabel(status: StatementExecutionState['status']): string {
  switch (status) {
    case 'success': return 'Success';
    case 'error': return 'Failed';
    case 'cancelled': return 'Cancelled';
    case 'skipped': return 'Skipped';
    case 'running': return 'Running';
    default: return 'Pending';
  }
}

export function statementStatusClass(status: StatementExecutionState['status']): string {
  return `statement-status statement-status-${status}`;
}

export function statementStateFor(tab: EditorTab, index: number): StatementExecutionState {
  const explicit = tab.statementStates[index];
  if (explicit) return explicit;
  const result = tab.results[index];
  if (!result) return { status: 'pending' };
  if (result.status === 'error') return { status: 'error', message: result.message };
  if (result.status === 'cancelled') return { status: 'cancelled', message: result.message };
  if (result.status.startsWith('complete')) return { status: 'success', message: result.message };
  return { status: tab.running ? 'running' : 'pending' };
}

export function applyEventToEditorTab(tab: EditorTab, event: QueryEvent): EditorTab {
  const statementIndex = event.statementIndex ?? tab.activeStatementIndex;
  const current = tab.results[statementIndex] ?? emptyResult;
  const nextResult = applyQueryEvent(current, event);
  const nextStatementStates: Record<number, StatementExecutionState> = { ...tab.statementStates };
  const statementCount = event.statementCount ?? tab.batchStatementCount;
  if (event.type === 'started' && event.statementCount !== undefined) {
    for (let index = 0; index < event.statementCount; index += 1) nextStatementStates[index] = { status: 'pending' };
  }
  if (event.statementIndex !== undefined) {
    const previousState = nextStatementStates[event.statementIndex] ?? { status: 'pending' as const };
    if (event.type === 'statement-started') nextStatementStates[event.statementIndex] = { status: 'running', sql: event.statementSql };
    else if (event.type === 'complete') nextStatementStates[event.statementIndex] = { ...previousState, status: 'success', message: event.message };
    else if (event.type === 'error') nextStatementStates[event.statementIndex] = { ...previousState, status: 'error', message: event.message };
    else if (event.type === 'cancelled') nextStatementStates[event.statementIndex] = { ...previousState, status: 'cancelled', message: event.scope === 'statement' ? 'Statement cancelled.' : undefined };
  }
  let batchStatus = tab.batchStatus;
  let batchMessage = tab.batchMessage;
  let batchCompletedStatements = tab.batchCompletedStatements;
  if (event.type === 'batch-complete') {
    batchStatus = event.status;
    batchMessage = event.message;
    batchCompletedStatements = event.completedStatements;
    const total = event.statementCount ?? Object.keys(nextStatementStates).length;
    for (let index = 0; index < total; index += 1) {
      const state = nextStatementStates[index];
      if (state?.status === 'pending' || !state) {
        nextStatementStates[index] = { status: event.status === 'complete' && index < event.completedStatements ? 'success' : 'skipped' };
      }
    }
  }
  const nextResults = event.type === 'started'
    ? {}
    : event.type === 'batch-complete'
      ? Object.fromEntries(Object.entries(tab.results).map(([index, item]) => [index, { ...item, batchStatus: event.status, lastSequence: event.sequence ?? item.lastSequence }])) as Record<number, ResultState>
      : { ...tab.results, [statementIndex]: nextResult };
  return {
    ...tab,
    results: nextResults,
    statementStates: nextStatementStates,
    batchStatus,
    batchMessage,
    batchCompletedStatements,
    batchStatementCount: statementCount,
    activeStatementIndex: event.type === 'statement-started' && event.statementIndex !== undefined ? event.statementIndex : tab.activeStatementIndex,
    running: event.type === 'batch-complete' ? false : tab.running,
  };
}

export function clearLiveQueryState(tab: EditorTab): EditorTab {
  return {
    ...tab,
    queryId: undefined,
    running: false,
    results: {},
    statementStates: {},
    batchStatus: undefined,
    batchMessage: undefined,
    batchCompletedStatements: undefined,
    batchStatementCount: undefined,
  };
}
