import { UI_CONTRACT_VERSION } from '@justybase/contracts';
import type { CapabilityDescriptor, UiAuthState, UiIdentity, UiMode, PersistenceScope } from '@justybase/contracts';
import type {
  UiAction,
  UiDocumentState,
  UiExecutionState,
  UiResultEvent,
  UiResultSurfaceState,
  UiResultViewState,
  UiStatementExecutionState,
  UiState,
} from './types';

export interface InitialUiStateOptions {
  readonly mode?: UiMode;
  readonly persistenceScope?: PersistenceScope;
  readonly auth?: UiAuthState;
  readonly capabilities?: readonly CapabilityDescriptor[];
}

const emptyResultView = (): UiResultViewState => ({
  globalFilter: '',
  columnFilters: {},
  sorting: [],
  grouping: [],
  scrollTop: 0,
  scrollLeft: 0,
});

export function createInitialUiState(identity: UiIdentity, options: InitialUiStateOptions = {}): UiState {
  return {
    contractVersion: UI_CONTRACT_VERSION,
    mode: options.mode ?? 'legacy',
    identity: { ...identity },
    auth: options.auth ?? { status: 'unauthenticated' },
    capabilities: [...(options.capabilities ?? [])],
    shell: { status: 'idle', activeSurface: 'workspace', sidebarOpen: true },
    workspace: { documentOrder: [], documents: {} },
    connections: { status: 'idle', profiles: [] },
    executions: { byExecutionId: {} },
    results: { byResultSetId: {} },
    metadata: { status: 'idle', expandedNodeIds: [] },
    history: { status: 'idle', entryIds: [] },
    designer: { status: 'idle', dirty: false },
    persistenceScope: options.persistenceScope ?? 'user',
  };
}

function resultKey(sourceId: string, resultSetId: string): string {
  return `${sourceId}\u0000${resultSetId}`;
}

function resultFor(state: UiState, sourceId: string, resultSetId: string): UiResultSurfaceState | undefined {
  return state.results.byResultSetId[resultKey(sourceId, resultSetId)];
}

function resultStateForStart(action: Extract<UiAction, { type: 'execution/start' }>): UiResultSurfaceState {
  return {
    sourceId: action.sourceId,
    executionId: action.executionId,
    resultSetId: action.resultSetId,
    storageId: action.storageId,
    statementIndex: action.statementIndex ?? 0,
    status: 'loading',
    columns: [],
    totalRowCount: 0,
    loadedRowCount: 0,
    lastSequence: 0,
    cancellation: 'none',
    view: emptyResultView(),
  };
}

function executionFor(state: UiState, sourceId: string, executionId: string): UiExecutionState | undefined {
  const execution = state.executions.byExecutionId[executionId];
  return execution?.sourceId === sourceId ? execution : undefined;
}

function executionWith(state: UiState, execution: UiExecutionState): UiState {
  return {
    ...state,
    executions: {
      ...state.executions,
      activeExecutionId: execution.executionId,
      byExecutionId: { ...state.executions.byExecutionId, [execution.executionId]: execution },
    },
  };
}

function statementState(
  statementIndex: number,
  status: UiStatementExecutionState['status'],
  patch: Pick<UiStatementExecutionState, 'resultSetId' | 'sql' | 'message'> = {},
): UiStatementExecutionState {
  return { statementIndex, status, ...patch };
}

function completedStatementCount(statements: Readonly<Record<number, UiStatementExecutionState>>): number {
  return Object.values(statements).filter(statement =>
    statement.status === 'success' || statement.status === 'error' || statement.status === 'cancelled',
  ).length;
}

function executionForStart(state: UiState, action: Extract<UiAction, { type: 'execution/start' }>): UiExecutionState {
  const previous = executionFor(state, action.sourceId, action.executionId);
  const statementIndex = action.statementIndex ?? 0;
  const statementCount = Math.max(action.statementCount ?? previous?.statementCount ?? 1, statementIndex + 1);
  const statements = { ...(previous?.statements ?? {}) };
  const oldStatement = statements[statementIndex];
  // Stream adapters may need to repeat the start action when a result event
  // arrives before its surface exists. Repeating that action must not turn an
  // already running statement back into pending or discard its SQL metadata.
  statements[statementIndex] = statementState(statementIndex, oldStatement?.status ?? 'pending', {
    resultSetId: action.resultSetId,
    ...(action.statementSql === undefined
      ? oldStatement?.sql === undefined ? {} : { sql: oldStatement.sql }
      : { sql: action.statementSql }),
    ...(oldStatement?.message === undefined ? {} : { message: oldStatement.message }),
  });
  const currentResult = resultFor(state, action.sourceId, action.resultSetId);
  const resultAlreadyTerminal = currentResult?.executionId === action.executionId
    && currentResult.statementIndex === statementIndex
    && ['complete', 'empty', 'error', 'cancelled'].includes(currentResult.status);
  const nextStatus = resultAlreadyTerminal && previous ? previous.status : 'running';
  return {
    sourceId: action.sourceId,
    executionId: action.executionId,
    mode: action.mode ?? previous?.mode ?? 'single',
    statementCount,
    completedStatements: previous?.completedStatements ?? 0,
    status: nextStatus,
    ...(previous?.message === undefined ? {} : { message: previous.message }),
    statements,
  };
}

function withResult(state: UiState, result: UiResultSurfaceState): UiState {
  const key = resultKey(result.sourceId, result.resultSetId);
  return {
    ...state,
    results: {
      ...state.results,
      activeSourceId: state.results.activeSourceId ?? result.sourceId,
      activeResultSetId: state.results.activeResultSetId ?? result.resultSetId,
      byResultSetId: { ...state.results.byResultSetId, [key]: result },
    },
  };
}

function failExecution(state: UiState, action: Extract<UiAction, { type: 'execution/stream-failed' }>): UiState {
  const result = resultFor(state, action.sourceId, action.resultSetId);
  if (!result || result.executionId !== action.executionId || result.status === 'complete' || result.status === 'empty' || result.status === 'error' || result.status === 'cancelled') return state;
  let next = withResult(state, { ...result, status: 'error', message: action.message });
  const execution = executionFor(next, action.sourceId, action.executionId);
  if (!execution) return next;
  const statements = {
    ...execution.statements,
    [result.statementIndex]: statementState(result.statementIndex, 'error', { resultSetId: result.resultSetId, message: action.message }),
  };
  next = executionWith(next, {
    ...execution,
    status: 'error',
    message: action.message,
    completedStatements: completedStatementCount(statements),
    statements,
  });
  return next;
}

function findResultById(state: UiState, resultSetId: string, sourceId?: string): UiResultSurfaceState | undefined {
  if (sourceId !== undefined) return resultFor(state, sourceId, resultSetId);
  const matches = Object.values(state.results.byResultSetId).filter(result => result.resultSetId === resultSetId);
  return matches.length === 1 ? matches[0] : undefined;
}

function updateResultView(state: UiState, resultSetId: string, sourceId: string | undefined, patch: Partial<UiResultViewState>): UiState {
  const found = findResultById(state, resultSetId, sourceId);
  if (!found) return state;
  const next: UiResultSurfaceState = { ...found, view: { ...found.view, ...patch } };
  return withResult(state, next);
}

function reconcileResultsForSource(state: UiState, sourceId: string, resultSetIds: readonly string[]): UiState {
  const retainedIds = new Set(resultSetIds);
  const existingEntries = Object.entries(state.results.byResultSetId);
  const byResultSetId = Object.fromEntries(existingEntries.filter(([, result]) =>
    result.sourceId !== sourceId || retainedIds.has(result.resultSetId),
  ));
  const removed = existingEntries.length !== Object.keys(byResultSetId).length;
  if (!removed) return state;

  if (state.results.activeSourceId !== sourceId) {
    return { ...state, results: { ...state.results, byResultSetId } };
  }

  const sourceResults = Object.values(byResultSetId).filter(result => result.sourceId === sourceId);
  const activeResult = sourceResults.find(result => result.resultSetId === state.results.activeResultSetId) ?? sourceResults[0];
  return {
    ...state,
    results: {
      ...state.results,
      byResultSetId,
      activeSourceId: activeResult?.sourceId,
      activeResultSetId: activeResult?.resultSetId,
    },
  };
}

function hydrateResult(state: UiState, action: Extract<UiAction, { type: 'results/hydrate' }>): UiState {
  const found = resultFor(state, action.sourceId, action.resultSetId);
  if (!found || found.executionId !== action.executionId) return state;
  if (found.status === 'cancelled' || found.status === 'error') return state;
  if (!Number.isInteger(action.loadedRowCount) || action.loadedRowCount < 0) return state;
  if (action.totalRowCount !== undefined && (!Number.isInteger(action.totalRowCount) || action.totalRowCount < 0)) return state;
  // Hydration reports the authoritative count for the current result. It may
  // legitimately shrink after a refresh, so do not preserve an older count;
  // only reject a page whose loaded rows cannot fit in that count.
  const totalRowCount = action.totalRowCount ?? found.totalRowCount;
  if (action.loadedRowCount > totalRowCount) return state;
  return withResult(state, {
    ...found,
    loadedRowCount: action.loadedRowCount,
    totalRowCount,
    ...(action.columns === undefined ? {} : { columns: action.columns.map(column => ({ ...column })) }),
  });
}

function updateExecutionFromResultEvent(state: UiState, event: UiResultEvent, result: UiResultSurfaceState): UiState {
  const execution = executionFor(state, event.sourceId, event.executionId);
  if (!execution) return state;
  const statementIndex = result.statementIndex;
  const previousStatement = execution.statements[statementIndex];
  let nextStatement = previousStatement;
  let executionStatus = execution.status;
  let executionMessage = execution.message;
  if (event.type === 'started') {
    executionStatus = 'running';
  } else if (event.type === 'statement-started') {
    nextStatement = statementState(statementIndex, 'running', {
      resultSetId: result.resultSetId,
      ...(event.statementSql === undefined ? {} : { sql: event.statementSql }),
    });
  } else if (event.type === 'complete' || event.type === 'empty') {
    nextStatement = statementState(statementIndex, 'success', {
      resultSetId: result.resultSetId,
      ...(previousStatement?.sql === undefined ? {} : { sql: previousStatement.sql }),
      ...(event.type === 'complete' && event.message === undefined ? {} : { message: event.type === 'complete' ? event.message : event.message }),
    });
    executionStatus = execution.mode === 'script' ? 'running' : 'success';
  } else if (event.type === 'error') {
    nextStatement = statementState(statementIndex, 'error', {
      resultSetId: result.resultSetId,
      ...(previousStatement?.sql === undefined ? {} : { sql: previousStatement.sql }),
      message: event.message,
    });
    executionMessage = event.message;
    // Script execution may continue after a statement error. The terminal
    // batch action is authoritative for the execution-level status.
    executionStatus = execution.mode === 'script' ? 'running' : 'error';
  } else if (event.type === 'cancelled') {
    nextStatement = statementState(statementIndex, 'cancelled', {
      resultSetId: result.resultSetId,
      ...(previousStatement?.sql === undefined ? {} : { sql: previousStatement.sql }),
      ...(event.message === undefined ? {} : { message: event.message }),
    });
    executionStatus = execution.mode === 'script' ? 'running' : 'cancelled';
  }
  if (nextStatement === previousStatement && executionStatus === execution.status && executionMessage === execution.message) return state;
  const statements = nextStatement === previousStatement
    ? execution.statements
    : { ...execution.statements, [statementIndex]: nextStatement };
  return executionWith(state, {
    ...execution,
    status: executionStatus,
    completedStatements: completedStatementCount(statements),
    ...(executionMessage === undefined ? {} : { message: executionMessage }),
    statements,
  });
}

function applyResultEvent(state: UiState, event: UiResultEvent): UiState {
  let previous = resultFor(state, event.sourceId, event.resultSetId);
  if (!previous) {
    if (!executionFor(state, event.sourceId, event.executionId)) return state;
    previous = resultStateForStart({
      type: 'execution/start',
      sourceId: event.sourceId,
      executionId: event.executionId,
      resultSetId: event.resultSetId,
      statementIndex: event.statementIndex,
    });
    state = withResult(state, previous);
  }
  if (previous.executionId !== event.executionId) return state;

  // Shared adapters use a contiguous, one-based event sequence. This rejects
  // replayed, delayed, duplicated, and out-of-order transport messages.
  if (event.sequence !== previous.lastSequence + 1) return state;
  const terminal = previous.status === 'complete'
    || previous.status === 'empty'
    || previous.status === 'error'
    || previous.status === 'cancelled';
  if (terminal) return state;
  // A cancellation request is unresolved until the port acknowledges it. The
  // execution can finish during that interval, and its terminal event must be
  // consumed so a later cancellation failure cannot strand the result. Once
  // cancellation is acknowledged, only the cancelled terminal event remains
  // authoritative and late output is suppressed.
  if (previous.cancellation === 'acknowledged' && event.type !== 'cancelled') return state;

  const base = { ...previous, lastSequence: event.sequence };
  let next: UiResultSurfaceState;
  switch (event.type) {
    case 'started':
    case 'statement-started':
      next = { ...base, status: 'streaming' };
      break;
    case 'columns':
      next = { ...base, status: 'streaming', columns: event.columns.map(column => ({ ...column })) };
      break;
    case 'session':
      if (!Number.isInteger(event.totalRowCount) || event.totalRowCount < 0 || !event.storageId.trim()) return state;
      next = { ...base, status: 'streaming', storageId: event.storageId, totalRowCount: event.totalRowCount };
      break;
    case 'rows': {
      if (!Number.isInteger(event.rowCount) || event.rowCount < 0 || event.rowCount < previous.loadedRowCount) return state;
      if (!Number.isInteger(event.totalRowCount) || event.totalRowCount < event.rowCount) return state;
      next = {
        ...base,
        status: 'streaming',
        loadedRowCount: event.rowCount,
        totalRowCount: event.totalRowCount,
      };
      break;
    }
    case 'progress':
      if (!Number.isInteger(event.totalRowCount) || event.totalRowCount < previous.totalRowCount) return state;
      next = { ...base, status: 'streaming', totalRowCount: event.totalRowCount };
      break;
    case 'complete':
      if (!Number.isInteger(event.totalRowCount) || event.totalRowCount < 0 || event.totalRowCount < previous.loadedRowCount) return state;
      next = {
        ...base,
        status: event.totalRowCount === 0 ? 'empty' : 'complete',
        totalRowCount: event.totalRowCount,
        loadedRowCount: previous.loadedRowCount,
        message: event.message,
      };
      break;
    case 'empty':
      next = { ...base, status: 'empty', message: event.message, totalRowCount: 0 };
      break;
    case 'error':
      next = { ...base, status: 'error', message: event.message };
      break;
    case 'cancelled':
      if (!Number.isInteger(event.totalRowCount) || event.totalRowCount < 0 || event.totalRowCount < previous.loadedRowCount) return state;
      next = {
        ...base,
        status: 'cancelled',
        cancellation: 'cancelled',
        totalRowCount: Math.max(previous.totalRowCount, event.totalRowCount),
        message: event.message ?? 'Execution cancelled.',
      };
      break;
  }
  const resultState = withResult(state, next);
  return updateExecutionFromResultEvent(resultState, event, next);
}

function updateDocuments(state: UiState, documents: Readonly<Record<string, UiDocumentState>>, documentOrder: readonly string[], activeDocumentId?: string): UiState {
  return {
    ...state,
    workspace: { documents, documentOrder, activeDocumentId },
  };
}

function setShellStatus(state: UiState, status: UiState['shell']['status'], message?: string): UiState {
  return { ...state, shell: { ...state.shell, status, message } };
}

/** Pure, immutable reducer for all portable UI transitions. */
export function reduceUiState(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'mode/set':
      return state.mode === action.mode ? state : { ...state, mode: action.mode };
    case 'auth/set':
      return { ...state, auth: { ...action.auth } };
    case 'capabilities/set':
      return { ...state, capabilities: action.capabilities.map(capability => ({ ...capability })) };
    case 'shell/status':
      return setShellStatus(state, action.status, action.message);
    case 'shell/surface':
      return state.shell.activeSurface === action.surface ? state : { ...state, shell: { ...state.shell, activeSurface: action.surface } };
    case 'shell/sidebar':
      return state.shell.sidebarOpen === action.open ? state : { ...state, shell: { ...state.shell, sidebarOpen: action.open } };
    case 'workspace/open-document': {
      const document = { ...action.document };
      const exists = Boolean(state.workspace.documents[document.id]);
      const documentOrder = exists ? state.workspace.documentOrder : [...state.workspace.documentOrder, document.id];
      return updateDocuments(state, { ...state.workspace.documents, [document.id]: document }, documentOrder, document.id);
    }
    case 'workspace/update-document': {
      const current = state.workspace.documents[action.documentId];
      if (!current) return state;
      const patch = action.patch;
      const document: UiDocumentState = {
        ...current,
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...('uri' in patch ? { uri: patch.uri } : {}),
        ...(patch.content === undefined ? {} : { content: patch.content }),
        ...(patch.dirty === undefined ? {} : { dirty: patch.dirty }),
        ...('connectionId' in patch ? { connectionId: patch.connectionId } : {}),
        ...('database' in patch ? { database: patch.database } : {}),
        ...('schema' in patch ? { schema: patch.schema } : {}),
        ...('databaseKind' in patch ? { databaseKind: patch.databaseKind } : {}),
      };
      return updateDocuments(state, { ...state.workspace.documents, [document.id]: document }, state.workspace.documentOrder, state.workspace.activeDocumentId);
    }
    case 'workspace/close-document': {
      if (!state.workspace.documents[action.documentId]) return state;
      const documentOrder = state.workspace.documentOrder.filter(id => id !== action.documentId);
      const documents = { ...state.workspace.documents };
      delete documents[action.documentId];
      const activeDocumentId = state.workspace.activeDocumentId === action.documentId
        ? documentOrder[0]
        : state.workspace.activeDocumentId;
      return updateDocuments(state, documents, documentOrder, activeDocumentId);
    }
    case 'workspace/select-document':
      return state.workspace.documents[action.documentId]
        ? updateDocuments(state, state.workspace.documents, state.workspace.documentOrder, action.documentId)
        : state;
    case 'connections/status':
      return { ...state, connections: { ...state.connections, status: action.status, message: action.message } };
    case 'connections/set-profiles':
      return { ...state, connections: { ...state.connections, profiles: action.profiles.map(profile => ({ ...profile })), status: 'complete' } };
    case 'connections/select':
      return action.connectionId === undefined || state.connections.profiles.some(profile => profile.id === action.connectionId)
        ? { ...state, connections: { ...state.connections, selectedConnectionId: action.connectionId } }
        : state;
    case 'execution/start': {
      const key = resultKey(action.sourceId, action.resultSetId);
      const existing = state.results.byResultSetId[key];
      // Preserve the reducer's identity contract for the legacy idempotent
      // "start this already-started result" action. Rich start metadata is
      // allowed to update an execution when a later script event supplies it.
      if (existing?.executionId === action.executionId
        && action.statementIndex === undefined
        && action.storageId === undefined
        && action.mode === undefined
        && action.statementCount === undefined
        && action.statementSql === undefined) return state;
      const execution = executionForStart(state, action);
      const withExecution = executionWith(state, execution);
      if (existing?.executionId === action.executionId) return withExecution;
      return withResult(withExecution, resultStateForStart(action));
    }
    case 'execution/event':
      return applyResultEvent(state, action.event);
    case 'execution/statement-status': {
      const execution = executionFor(state, action.sourceId, action.executionId);
      if (!execution || !Number.isInteger(action.statementIndex) || action.statementIndex < 0) return state;
      const current = execution.statements[action.statementIndex];
      const nextStatement = statementState(action.statementIndex, action.status, {
        ...(action.resultSetId === undefined ? current?.resultSetId === undefined ? {} : { resultSetId: current.resultSetId } : { resultSetId: action.resultSetId }),
        ...(action.sql === undefined ? current?.sql === undefined ? {} : { sql: current.sql } : { sql: action.sql }),
        ...(action.message === undefined ? {} : { message: action.message }),
      });
      const statements = { ...execution.statements, [action.statementIndex]: nextStatement };
      return executionWith(state, { ...execution, completedStatements: completedStatementCount(statements), statements });
    }
    case 'execution/batch-complete': {
      const execution = executionFor(state, action.sourceId, action.executionId);
      if (!execution || !Number.isInteger(action.completedStatements) || action.completedStatements < 0) return state;
      const statementCount = Math.max(action.statementCount ?? execution.statementCount, action.completedStatements);
      const statements = { ...execution.statements };
      for (let index = 0; index < statementCount; index += 1) {
        const current = statements[index];
        if (current && current.status !== 'pending') continue;
        statements[index] = statementState(index, action.status === 'success' && index < action.completedStatements ? 'success' : 'skipped', {
          ...(current?.resultSetId === undefined ? {} : { resultSetId: current.resultSetId }),
          ...(current?.sql === undefined ? {} : { sql: current.sql }),
        });
      }
      const byResultSetId = Object.fromEntries(Object.entries(state.results.byResultSetId).map(([key, result]) => {
        if (result.sourceId !== action.sourceId || result.executionId !== action.executionId) return [key, result];
        const terminalStatus = action.status === 'cancelled' && !['complete', 'empty', 'error'].includes(result.status)
          ? { status: 'cancelled' as const, cancellation: 'cancelled' as const, message: action.message ?? 'Execution cancelled.' }
          : {};
        return [key, { ...result, batchStatus: action.status, batchMessage: action.message, ...terminalStatus }];
      }));
      const next = executionWith(state, {
        ...execution,
        status: action.status,
        statementCount,
        completedStatements: action.completedStatements,
        ...(action.message === undefined ? {} : { message: action.message }),
        statements,
      });
      return { ...next, results: { ...next.results, byResultSetId } };
    }
    case 'execution/stream-failed':
      return failExecution(state, action);
    case 'results/hydrate':
      return hydrateResult(state, action);
    case 'execution/cancel-requested': {
      const results = Object.values(state.results.byResultSetId).filter(result => result.sourceId === action.sourceId && result.executionId === action.executionId && !['complete', 'empty', 'error', 'cancelled'].includes(result.status));
      if (results.length === 0) return state;
      return results.reduce((next, result) => withResult(next, { ...result, cancellation: 'requested', cancelRequestId: action.requestId }), state);
    }
    case 'execution/cancel-acknowledged': {
      const results = Object.values(state.results.byResultSetId).filter(result => result.sourceId === action.sourceId && result.executionId === action.executionId && result.cancelRequestId === action.requestId && result.cancellation === 'requested');
      if (results.length === 0) return state;
      return results.reduce((next, result) => withResult(next, { ...result, cancellation: 'acknowledged' }), state);
    }
    case 'execution/cancel-failed': {
      const results = Object.values(state.results.byResultSetId).filter(result => result.sourceId === action.sourceId && result.executionId === action.executionId && result.cancelRequestId === action.requestId && result.cancellation === 'requested');
      if (results.length === 0) return state;
      return results.reduce((next, result) => withResult(next, { ...result, cancellation: 'failed', message: action.message }), state);
    }
    case 'results/select-source': {
      if (action.sourceId === undefined) {
        return { ...state, results: { ...state.results, activeSourceId: undefined, activeResultSetId: undefined } };
      }
      const sourceResults = Object.values(state.results.byResultSetId).filter(result => result.sourceId === action.sourceId);
      if (sourceResults.length === 0) return { ...state, results: { ...state.results, activeSourceId: action.sourceId, activeResultSetId: undefined } };
      const activeResult = sourceResults.find(result => result.resultSetId === state.results.activeResultSetId) ?? sourceResults[0];
      return { ...state, results: { ...state.results, activeSourceId: action.sourceId, activeResultSetId: activeResult.resultSetId } };
    }
    case 'results/select': {
      const result = findResultById(state, action.resultSetId, action.sourceId);
      return result
        ? { ...state, results: { ...state.results, activeSourceId: result.sourceId, activeResultSetId: result.resultSetId } }
        : state;
    }
    case 'results/reconcile-source':
      return reconcileResultsForSource(state, action.sourceId, action.resultSetIds);
    case 'results/view':
      return updateResultView(state, action.resultSetId, action.sourceId, action.patch);
    case 'metadata/status':
      return { ...state, metadata: { ...state.metadata, status: action.status, message: action.message } };
    case 'metadata/select':
      return { ...state, metadata: { ...state.metadata, selectedNodeId: action.nodeId } };
    case 'metadata/toggle-expanded': {
      const expanded = new Set(state.metadata.expandedNodeIds);
      if (expanded.has(action.nodeId)) expanded.delete(action.nodeId); else expanded.add(action.nodeId);
      return { ...state, metadata: { ...state.metadata, expandedNodeIds: [...expanded] } };
    }
    case 'metadata/set-expanded':
      return { ...state, metadata: { ...state.metadata, expandedNodeIds: [...new Set(action.nodeIds)] } };
    case 'history/status':
      return { ...state, history: { ...state.history, status: action.status, message: action.message } };
    case 'history/select':
      return { ...state, history: { ...state.history, selectedEntryId: action.entryId } };
    case 'designer/status':
      return { ...state, designer: { ...state.designer, status: action.status, message: action.message } };
    case 'designer/target':
      return { ...state, designer: { ...state.designer, targetId: action.targetId, dirty: false } };
    case 'designer/dirty':
      return state.designer.dirty === action.dirty ? state : { ...state, designer: { ...state.designer, dirty: action.dirty } };
  }
}

export { emptyResultView, resultKey };
