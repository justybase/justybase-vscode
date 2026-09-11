import type { CapabilityDescriptor, UiAuthState, UiIdentity, UiMode, PersistenceScope } from '@justybase/contracts';
import type {
  UiAction,
  UiDocumentState,
  UiResultEvent,
  UiResultSurfaceState,
  UiResultViewState,
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
    contractVersion: 1,
    mode: options.mode ?? 'legacy',
    identity: { ...identity },
    auth: options.auth ?? { status: 'unauthenticated' },
    capabilities: [...(options.capabilities ?? [])],
    shell: { status: 'idle', activeSurface: 'workspace', sidebarOpen: true },
    workspace: { documentOrder: [], documents: {} },
    connections: { status: 'idle', profiles: [] },
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

function findResultById(state: UiState, resultSetId: string, sourceId?: string): UiResultSurfaceState | undefined {
  return sourceId === undefined
    ? Object.values(state.results.byResultSetId).find(result => result.resultSetId === resultSetId)
    : resultFor(state, sourceId, resultSetId);
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

function applyResultEvent(state: UiState, event: UiResultEvent): UiState {
  const previous = resultFor(state, event.sourceId, event.resultSetId);
  if (!previous || previous.executionId !== event.executionId) return state;

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
  return withResult(state, next);
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
        ...(patch.uri === undefined ? {} : { uri: patch.uri }),
        ...(patch.content === undefined ? {} : { content: patch.content }),
        ...(patch.dirty === undefined ? {} : { dirty: patch.dirty }),
        ...(patch.connectionId === undefined ? {} : { connectionId: patch.connectionId }),
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
      if (state.results.byResultSetId[key]?.executionId === action.executionId) return state;
      return withResult(state, resultStateForStart(action));
    }
    case 'execution/event':
      return applyResultEvent(state, action.event);
    case 'results/hydrate':
      return hydrateResult(state, action);
    case 'execution/cancel-requested': {
      const result = resultFor(state, action.sourceId, findResultSetForExecution(state, action.sourceId, action.executionId));
      if (!result || result.executionId !== action.executionId || result.status === 'complete' || result.status === 'empty' || result.status === 'error' || result.status === 'cancelled') return state;
      return withResult(state, { ...result, cancellation: 'requested', cancelRequestId: action.requestId });
    }
    case 'execution/cancel-acknowledged': {
      const result = resultFor(state, action.sourceId, findResultSetForExecution(state, action.sourceId, action.executionId));
      if (!result || result.executionId !== action.executionId || result.cancelRequestId !== action.requestId || result.cancellation !== 'requested') return state;
      return withResult(state, { ...result, cancellation: 'acknowledged' });
    }
    case 'execution/cancel-failed': {
      const result = resultFor(state, action.sourceId, findResultSetForExecution(state, action.sourceId, action.executionId));
      if (!result || result.executionId !== action.executionId || result.cancelRequestId !== action.requestId || result.cancellation !== 'requested') return state;
      return withResult(state, { ...result, cancellation: 'failed', message: action.message });
    }
    case 'results/select-source': {
      if (action.sourceId === undefined) {
        return { ...state, results: { ...state.results, activeSourceId: undefined, activeResultSetId: undefined } };
      }
      const sourceResults = Object.values(state.results.byResultSetId).filter(result => result.sourceId === action.sourceId);
      if (sourceResults.length === 0) return state;
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

function findResultSetForExecution(state: UiState, sourceId: string, executionId: string): string {
  return Object.values(state.results.byResultSetId).find(result => result.sourceId === sourceId && result.executionId === executionId)?.resultSetId ?? '';
}

export { emptyResultView, resultKey };
