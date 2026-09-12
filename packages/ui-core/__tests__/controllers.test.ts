import {
  createExecutionController,
  createInitialUiState,
  createUiStore,
  createWorkspaceController,
  reduceUiState,
} from '../src';
import type {
  DocumentPort,
  DocumentSnapshot,
  ExecutionHandle,
  ExecutionInput,
  ExecutionPort,
  UiResultEvent,
} from '../src';

const identity = { productId: 'test', userId: 'user-1', sourceId: 'source-1' } as const;

function input(): ExecutionInput {
  return { sourceId: 'source-1', sql: 'SELECT 1', connectionId: 'connection-1', mode: 'single' };
}

function snapshot(): DocumentSnapshot {
  return { id: 'document-1', sourceId: 'source-1', title: 'scratch.sql', content: 'SELECT 1', dirty: false };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise = (): void => undefined;
  const promise = new Promise<void>(resolve => { resolvePromise = resolve; });
  return { promise, resolve: () => resolvePromise() };
}

describe('ui-core product controllers', () => {
  it('bridges document lifecycle and disposes the host exactly once', async () => {
    const opened = snapshot();
    const documents: DocumentPort = {
      open: jest.fn(async () => opened),
      save: jest.fn(async () => undefined),
      close: jest.fn(async () => undefined),
      dispose: jest.fn(),
    };
    const store = createUiStore(createInitialUiState(identity));
    const controller = createWorkspaceController(store, documents);
    await expect(controller.open()).resolves.toMatchObject({ id: opened.id });
    await controller.close(opened.id);
    await controller.dispose();
    await controller.dispose();
    expect(documents.open).toHaveBeenCalledTimes(1);
    expect(documents.close).toHaveBeenCalledWith(opened.id);
    expect(documents.dispose).toHaveBeenCalledTimes(1);
    await expect(controller.open()).rejects.toThrow('disposed');
    await controller.close(opened.id);
    store.dispose();
  });

  it('consumes one ordered stream, acknowledges cancellation, and never retries it', async () => {
    const startedGate = deferred();
    const doneGate = deferred();
    const releaseCancelled = deferred();
    const startedEvent: UiResultEvent = { type: 'started', sourceId: 'source-1', executionId: 'execution-1', resultSetId: 'result-1', sequence: 1 };
    const cancelledEvent: UiResultEvent = { type: 'cancelled', sourceId: 'source-1', executionId: 'execution-1', resultSetId: 'result-1', sequence: 2, totalRowCount: 0 };
    async function* events(): AsyncIterable<UiResultEvent> {
      yield startedEvent;
      startedGate.resolve();
      await releaseCancelled.promise;
      yield cancelledEvent;
      doneGate.resolve();
    }
    const start = jest.fn(async (_request: ExecutionInput): Promise<ExecutionHandle> => {
      void _request;
      return { sourceId: 'source-1', executionId: 'execution-1', resultSetId: 'result-1', events: events() };
    });
    const cancel = jest.fn(async () => ({ requestId: 'cancel-1', status: 'acknowledged' as const }));
    const dispose = jest.fn();
    const execution: ExecutionPort = { start, cancel, dispose };
    const store = createUiStore(createInitialUiState(identity));
    const controller = createExecutionController(store, execution);
    await controller.run(input());
    await startedGate.promise;
    await controller.cancel('source-1', 'execution-1');
    expect(start).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(store.getState().results.byResultSetId['source-1\u0000result-1']?.cancellation).toBe('acknowledged');
    releaseCancelled.resolve();
    await doneGate.promise;
    expect(store.getState().results.byResultSetId['source-1\u0000result-1']?.status).toBe('cancelled');
    await controller.dispose();
    await controller.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(controller.run(input())).rejects.toThrow('disposed');
    store.dispose();
  });

  it('retains a failed cancellation as non-terminal and converts a stream failure to one error event', async () => {
    const startedGate = deferred();
    const releaseFailure = deferred();
    const doneGate = deferred();
    async function* events(): AsyncIterable<UiResultEvent> {
      yield { type: 'started', sourceId: 'source-1', executionId: 'execution-2', resultSetId: 'result-2', sequence: 1 };
      startedGate.resolve();
      await releaseFailure.promise;
      throw new Error('stream disconnected');
    }
    const execution: ExecutionPort = {
      start: jest.fn(async () => ({ sourceId: 'source-1', executionId: 'execution-2', resultSetId: 'result-2', events: events() })),
      cancel: jest.fn(async () => ({ requestId: 'cancel-2', status: 'failed' as const, message: 'Too late.' })),
      dispose: jest.fn(),
    };
    const store = createUiStore(createInitialUiState(identity));
    const controller = createExecutionController(store, execution);
    await controller.run(input());
    await startedGate.promise;
    await controller.cancel('source-1', 'execution-2');
    expect(store.getState().results.byResultSetId['source-1\u0000result-2']?.cancellation).toBe('failed');
    releaseFailure.resolve();
    await Promise.resolve();
    await Promise.resolve();
    doneGate.resolve();
    expect(store.getState().results.byResultSetId['source-1\u0000result-2']?.status).toBe('error');
    expect(store.getState().results.byResultSetId['source-1\u0000result-2']?.message).toBe('stream disconnected');
    await controller.cancel('source-1', 'missing-execution');
    await controller.dispose();
    store.dispose();
  });

  it('creates and consumes additional result surfaces for script statements', async () => {
    const release = deferred();
    const execution: ExecutionPort = {
      start: jest.fn(async () => ({
        sourceId: 'source-1',
        executionId: 'script-1',
        resultSetId: 'script-1:0',
        events: (async function* (): AsyncIterable<UiResultEvent> {
          yield { type: 'started', sourceId: 'source-1', executionId: 'script-1', resultSetId: 'script-1:0', statementIndex: 0, sequence: 1 };
          yield { type: 'statement-started', sourceId: 'source-1', executionId: 'script-1', resultSetId: 'script-1:1', statementIndex: 1, sequence: 1 };
          yield { type: 'columns', sourceId: 'source-1', executionId: 'script-1', resultSetId: 'script-1:1', statementIndex: 1, sequence: 2, columns: [{ name: 'VALUE', type: 'INTEGER' }] };
          yield { type: 'complete', sourceId: 'source-1', executionId: 'script-1', resultSetId: 'script-1:1', statementIndex: 1, sequence: 3, totalRowCount: 1 };
          release.resolve();
        })(),
      })),
      cancel: jest.fn(async () => ({ requestId: 'cancel-script', status: 'acknowledged' as const })),
      dispose: jest.fn(),
    };
    const store = createUiStore(createInitialUiState(identity));
    const controller = createExecutionController(store, execution);
    await controller.run({ ...input(), mode: 'script' });
    await release.promise;
    await Promise.resolve();
    await Promise.resolve();
    const second = store.getState().results.byResultSetId['source-1\u0000script-1:1'];
    expect(second).toMatchObject({ resultSetId: 'script-1:1', statementIndex: 1, status: 'complete', lastSequence: 3 });
    await controller.dispose();
    store.dispose();
  });
});

describe('ui-core reducer action coverage', () => {
  it('handles shell, workspace, connection, result-view, metadata, history and designer transitions', () => {
    let state = createInitialUiState(identity);
    state = reduceUiState(state, { type: 'mode/set', mode: 'shared' });
    state = reduceUiState(state, { type: 'auth/set', auth: { status: 'authenticated', userId: 'user-1' } });
    state = reduceUiState(state, { type: 'capabilities/set', capabilities: [] });
    state = reduceUiState(state, { type: 'shell/status', status: 'running', message: 'starting' });
    state = reduceUiState(state, { type: 'shell/surface', surface: 'results' });
    state = reduceUiState(state, { type: 'shell/sidebar', open: false });
    state = reduceUiState(state, { type: 'workspace/open-document', document: { id: 'document-1', sourceId: 'source-1', title: 'one.sql', content: 'SELECT 1', dirty: false } });
    state = reduceUiState(state, { type: 'workspace/update-document', documentId: 'document-1', patch: { content: 'SELECT 2', dirty: true, title: 'two.sql', uri: 'file:///two.sql', connectionId: 'connection-1' } });
    state = reduceUiState(state, { type: 'workspace/select-document', documentId: 'document-1' });
    state = reduceUiState(state, { type: 'connections/status', status: 'loading' });
    state = reduceUiState(state, { type: 'connections/set-profiles', profiles: [{ id: 'connection-1', name: 'SQLite', host: 'local', port: 0, database: ':memory:', user: 'local', dbType: 'sqlite', readOnly: true }] });
    state = reduceUiState(state, { type: 'connections/select', connectionId: 'connection-1' });
    state = reduceUiState(state, { type: 'connections/select', connectionId: 'missing' });
    state = reduceUiState(state, { type: 'execution/start', sourceId: 'source-1', executionId: 'execution-1', resultSetId: 'result-1', storageId: 'storage-1' });
    const events: UiResultEvent[] = [
      { type: 'started', sourceId: 'source-1', executionId: 'execution-1', resultSetId: 'result-1', sequence: 1 },
      { type: 'columns', sourceId: 'source-1', executionId: 'execution-1', resultSetId: 'result-1', sequence: 2, columns: [{ name: 'ID', type: 'INTEGER' }] },
      { type: 'rows', sourceId: 'source-1', executionId: 'execution-1', resultSetId: 'result-1', sequence: 3, rowCount: 1, totalRowCount: 2 },
      { type: 'progress', sourceId: 'source-1', executionId: 'execution-1', resultSetId: 'result-1', sequence: 4, totalRowCount: 2 },
      { type: 'complete', sourceId: 'source-1', executionId: 'execution-1', resultSetId: 'result-1', sequence: 5, totalRowCount: 2 },
    ];
    for (const event of events) state = reduceUiState(state, { type: 'execution/event', event });
    expect(reduceUiState(state, { type: 'execution/start', sourceId: 'source-1', executionId: 'execution-1', resultSetId: 'result-1' })).toBe(state);
    state = reduceUiState(state, { type: 'results/select-source', sourceId: 'source-1' });
    state = reduceUiState(state, { type: 'results/select-source', sourceId: 'missing' });
    state = reduceUiState(state, { type: 'results/select', resultSetId: 'result-1' });
    state = reduceUiState(state, { type: 'results/view', resultSetId: 'result-1', patch: { globalFilter: '2', sorting: [{ column: '0', descending: true }], grouping: ['0'], aggregation: 'count', pivotColumn: '0', scrollTop: 100, scrollLeft: 50, anchorRow: 3 } });
    state = reduceUiState(state, { type: 'metadata/status', status: 'loading' });
    state = reduceUiState(state, { type: 'metadata/select', nodeId: 'table-1' });
    state = reduceUiState(state, { type: 'metadata/toggle-expanded', nodeId: 'table-1' });
    state = reduceUiState(state, { type: 'metadata/toggle-expanded', nodeId: 'table-1' });
    state = reduceUiState(state, { type: 'history/status', status: 'complete' });
    state = reduceUiState(state, { type: 'history/select', entryId: 'history-1' });
    state = reduceUiState(state, { type: 'designer/status', status: 'loading' });
    state = reduceUiState(state, { type: 'designer/target', targetId: 'table-1' });
    state = reduceUiState(state, { type: 'designer/dirty', dirty: true });
    state = reduceUiState(state, { type: 'workspace/close-document', documentId: 'document-1' });
    expect(state.mode).toBe('shared');
    expect(state.workspace.documentOrder).toEqual([]);
    expect(state.results.byResultSetId['source-1\u0000result-1']?.view.scrollLeft).toBe(50);
  });

  it('rejects invalid row totals and reaches empty and error terminal states', () => {
    let state = createInitialUiState(identity);
    state = reduceUiState(state, { type: 'execution/start', sourceId: 'source-1', executionId: 'execution-empty', resultSetId: 'result-empty' });
    state = reduceUiState(state, { type: 'execution/event', event: { type: 'rows', sourceId: 'source-1', executionId: 'execution-empty', resultSetId: 'result-empty', sequence: 1, rowCount: 1, totalRowCount: 0 } });
    expect(state.results.byResultSetId['source-1\u0000result-empty']?.lastSequence).toBe(0);
    state = reduceUiState(state, { type: 'execution/event', event: { type: 'empty', sourceId: 'source-1', executionId: 'execution-empty', resultSetId: 'result-empty', sequence: 1 } });
    expect(state.results.byResultSetId['source-1\u0000result-empty']?.status).toBe('empty');
    state = reduceUiState(state, { type: 'execution/start', sourceId: 'source-1', executionId: 'execution-error', resultSetId: 'result-error' });
    state = reduceUiState(state, { type: 'execution/event', event: { type: 'error', sourceId: 'source-1', executionId: 'execution-error', resultSetId: 'result-error', sequence: 1, message: 'failed' } });
    expect(state.results.byResultSetId['source-1\u0000result-error']?.status).toBe('error');
  });

  it('keeps duplicate result-set labels isolated by source identity', () => {
    let state = createInitialUiState(identity);
    state = reduceUiState(state, { type: 'execution/start', sourceId: 'source-a', executionId: 'execution-a', resultSetId: 'shared-result' });
    state = reduceUiState(state, { type: 'execution/start', sourceId: 'source-b', executionId: 'execution-b', resultSetId: 'shared-result' });
    state = reduceUiState(state, { type: 'results/view', sourceId: 'source-b', resultSetId: 'shared-result', patch: { scrollTop: 99 } });
    expect(state.results.byResultSetId['source-a\u0000shared-result']?.view.scrollTop).toBe(0);
    expect(state.results.byResultSetId['source-b\u0000shared-result']?.view.scrollTop).toBe(99);
    state = reduceUiState(state, { type: 'results/select', sourceId: 'source-b', resultSetId: 'shared-result' });
    expect(state.results.activeSourceId).toBe('source-b');
  });

  it('accepts adapter page hydration only for the matching execution identity', () => {
    let state = createInitialUiState(identity);
    state = reduceUiState(state, { type: 'execution/start', sourceId: 'source-1', executionId: 'execution-hydrate', resultSetId: 'result-hydrate' });
    const hydrated = reduceUiState(state, {
      type: 'results/hydrate',
      sourceId: 'source-1',
      executionId: 'execution-hydrate',
      resultSetId: 'result-hydrate',
      loadedRowCount: 2,
      totalRowCount: 100,
      columns: [{ name: 'ID', type: 'INTEGER' }],
    });
    expect(hydrated.results.byResultSetId['source-1\u0000result-hydrate']).toMatchObject({ loadedRowCount: 2, totalRowCount: 100, columns: [{ name: 'ID' }] });
    const refreshed = reduceUiState(hydrated, {
      type: 'results/hydrate',
      sourceId: 'source-1',
      executionId: 'execution-hydrate',
      resultSetId: 'result-hydrate',
      loadedRowCount: 2,
      totalRowCount: 10,
    });
    expect(refreshed.results.byResultSetId['source-1\u0000result-hydrate']?.totalRowCount).toBe(10);
    expect(reduceUiState(refreshed, {
      type: 'results/hydrate',
      sourceId: 'other-source',
      executionId: 'execution-hydrate',
      resultSetId: 'result-hydrate',
      loadedRowCount: 1,
    })).toBe(refreshed);
    expect(reduceUiState(refreshed, {
      type: 'results/hydrate',
      sourceId: 'source-1',
      executionId: 'old-execution',
      resultSetId: 'result-hydrate',
      loadedRowCount: 1,
    })).toBe(refreshed);
    expect(reduceUiState(refreshed, {
      type: 'results/hydrate',
      sourceId: 'source-1',
      executionId: 'execution-hydrate',
      resultSetId: 'result-hydrate',
      loadedRowCount: 3,
      totalRowCount: 2,
    })).toBe(refreshed);
  });
});
