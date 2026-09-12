import {
  CapabilityRegistry,
  CapabilityUnavailableError,
  createDisposalCoordinator,
  createInitialUiState,
  createPersistenceEnvelope,
  decodePersistenceEnvelope,
  decodeWithLegacyFallback,
  disposeOnInitializationFailure,
  encodePersistenceEnvelope,
  identitiesMatch,
  PersistenceDecodeError,
  reduceUiState,
  createUiStore,
  resolveUiMode,
} from '../src';
import type { Disposable, UiAction } from '../src';

const identity = {
  productId: 'web',
  userId: 'user-1',
  workspaceId: 'workspace-1',
  sourceId: 'source-1',
} as const;

function initial() {
  return createInitialUiState(identity, { persistenceScope: 'user' });
}

describe('ui-core reducer', () => {
  it('owns workspace identity and does not mutate the previous state', () => {
    const before = initial();
    const after = reduceUiState(before, {
      type: 'workspace/open-document',
      document: { id: 'doc-1', sourceId: 'source-1', title: 'scratch.sql', content: 'select 1', dirty: false, databaseKind: 'netezza' },
    });

    expect(before.workspace.documentOrder).toEqual([]);
    expect(after.workspace.documentOrder).toEqual(['doc-1']);
    expect(after.workspace.activeDocumentId).toBe('doc-1');
    expect(after.workspace.documents['doc-1']?.content).toBe('select 1');
    const changed = reduceUiState(after, { type: 'workspace/update-document', documentId: 'doc-1', patch: { databaseKind: 'postgresql' } });
    expect(changed.workspace.documents['doc-1']?.databaseKind).toBe('postgresql');
    expect(after.workspace.documents['doc-1']?.databaseKind).toBe('netezza');
  });

  it('rejects foreign, delayed, duplicate and gapped result events', () => {
    let state = reduceUiState(initial(), { type: 'execution/start', sourceId: 'source-1', executionId: 'exec-1', resultSetId: 'result-1' });
    const started = { type: 'execution/event' as const, event: { type: 'started' as const, sourceId: 'source-1', executionId: 'exec-1', resultSetId: 'result-1', sequence: 1 } };
    state = reduceUiState(state, started);
    const gapped = reduceUiState(state, { type: 'execution/event', event: { type: 'progress', sourceId: 'source-1', executionId: 'exec-1', resultSetId: 'result-1', sequence: 3, totalRowCount: 3 } });
    expect(gapped).toBe(state);
    const foreign = reduceUiState(state, { type: 'execution/event', event: { type: 'progress', sourceId: 'other-source', executionId: 'exec-1', resultSetId: 'result-1', sequence: 2, totalRowCount: 3 } });
    expect(foreign).toBe(state);
    const accepted = reduceUiState(state, { type: 'execution/event', event: { type: 'progress', sourceId: 'source-1', executionId: 'exec-1', resultSetId: 'result-1', sequence: 2, totalRowCount: 3 } });
    expect(accepted.results.byResultSetId['source-1\u0000result-1']?.lastSequence).toBe(2);
    expect(reduceUiState(accepted, { type: 'execution/event', event: { type: 'progress', sourceId: 'source-1', executionId: 'exec-1', resultSetId: 'result-1', sequence: 2, totalRowCount: 4 } })).toBe(accepted);
  });

  it('fails a stream even when the transport sequence has a gap', () => {
    let state = reduceUiState(initial(), { type: 'execution/start', sourceId: 'source-1', executionId: 'exec-gap', resultSetId: 'result-gap' });
    state = reduceUiState(state, { type: 'execution/event', event: { type: 'started', sourceId: 'source-1', executionId: 'exec-gap', resultSetId: 'result-gap', sequence: 1 } });
    state = reduceUiState(state, { type: 'execution/event', event: { type: 'progress', sourceId: 'source-1', executionId: 'exec-gap', resultSetId: 'result-gap', sequence: 3, totalRowCount: 1 } });
    const failed = reduceUiState(state, { type: 'execution/stream-failed', sourceId: 'source-1', executionId: 'exec-gap', resultSetId: 'result-gap', message: 'stream disconnected' });
    expect(failed.results.byResultSetId['source-1\u0000result-gap']).toMatchObject({ status: 'error', lastSequence: 1, message: 'stream disconnected' });
  });

  it('uses an explicit cancellation state machine and ignores post-cancel output', () => {
    let state = reduceUiState(initial(), { type: 'execution/start', sourceId: 'source-1', executionId: 'exec-2', resultSetId: 'result-2' });
    state = reduceUiState(state, { type: 'execution/event', event: { type: 'started', sourceId: 'source-1', executionId: 'exec-2', resultSetId: 'result-2', sequence: 1 } });
    state = reduceUiState(state, { type: 'execution/cancel-requested', sourceId: 'source-1', executionId: 'exec-2', requestId: 'cancel-1' });
    state = reduceUiState(state, { type: 'execution/cancel-acknowledged', sourceId: 'source-1', executionId: 'exec-2', requestId: 'cancel-1' });
    const ignoredRows = reduceUiState(state, { type: 'execution/event', event: { type: 'rows', sourceId: 'source-1', executionId: 'exec-2', resultSetId: 'result-2', sequence: 2, rowCount: 1, totalRowCount: 1 } });
    expect(ignoredRows).toBe(state);
    const cancelled = reduceUiState(state, { type: 'execution/event', event: { type: 'cancelled', sourceId: 'source-1', executionId: 'exec-2', resultSetId: 'result-2', sequence: 2, totalRowCount: 0 } });
    expect(cancelled.results.byResultSetId['source-1\u0000result-2']?.cancellation).toBe('cancelled');
    expect(reduceUiState(cancelled, { type: 'execution/event', event: { type: 'complete', sourceId: 'source-1', executionId: 'exec-2', resultSetId: 'result-2', sequence: 3, totalRowCount: 1 } })).toBe(cancelled);
  });

  it('keeps a terminal event that arrives before cancellation is acknowledged', () => {
    let state = reduceUiState(initial(), { type: 'execution/start', sourceId: 'source-1', executionId: 'exec-race', resultSetId: 'result-race' });
    state = reduceUiState(state, { type: 'execution/event', event: { type: 'started', sourceId: 'source-1', executionId: 'exec-race', resultSetId: 'result-race', sequence: 1 } });
    state = reduceUiState(state, { type: 'execution/cancel-requested', sourceId: 'source-1', executionId: 'exec-race', requestId: 'cancel-race' });
    const completed = reduceUiState(state, { type: 'execution/event', event: { type: 'complete', sourceId: 'source-1', executionId: 'exec-race', resultSetId: 'result-race', sequence: 2, totalRowCount: 1 } });
    expect(completed.results.byResultSetId['source-1\u0000result-race']).toMatchObject({ status: 'complete', lastSequence: 2 });
    const afterFailedCancellation = reduceUiState(completed, { type: 'execution/cancel-failed', sourceId: 'source-1', executionId: 'exec-race', requestId: 'cancel-race', message: 'Already completed.' });
    expect(afterFailedCancellation.results.byResultSetId['source-1\u0000result-race']).toMatchObject({ status: 'complete', cancellation: 'failed' });
  });

  it('resumes the normal stream after a failed cancellation without re-running SQL', () => {
    let state = reduceUiState(initial(), { type: 'execution/start', sourceId: 'source-1', executionId: 'exec-3', resultSetId: 'result-3' });
    state = reduceUiState(state, { type: 'execution/event', event: { type: 'started', sourceId: 'source-1', executionId: 'exec-3', resultSetId: 'result-3', sequence: 1 } });
    state = reduceUiState(state, { type: 'execution/cancel-requested', sourceId: 'source-1', executionId: 'exec-3', requestId: 'cancel-3' });
    state = reduceUiState(state, { type: 'execution/cancel-failed', sourceId: 'source-1', executionId: 'exec-3', requestId: 'cancel-3', message: 'Already completed.' });
    const resumed = reduceUiState(state, { type: 'execution/event', event: { type: 'complete', sourceId: 'source-1', executionId: 'exec-3', resultSetId: 'result-3', sequence: 2, totalRowCount: 0 } });
    expect(resumed.results.byResultSetId['source-1\u0000result-3']?.status).toBe('empty');
    expect(resumed.results.byResultSetId['source-1\u0000result-3']?.cancellation).toBe('failed');
  });
});

describe('ui-core persistence and capabilities', () => {
  const options = { schemaVersion: 2, scope: 'user' as const, identity };

  it('round-trips versioned envelopes, migrates old payloads and rejects foreign data', () => {
    const envelope = createPersistenceEnvelope({ globalFilter: 'orders', scrollTop: 42 }, options);
    const encoded = encodePersistenceEnvelope(envelope);
    expect(decodePersistenceEnvelope(encoded, options)?.payload).toEqual({ globalFilter: 'orders', scrollTop: 42 });
    expect(decodePersistenceEnvelope(JSON.stringify({ schemaVersion: 1, scope: 'user', identity, payload: { oldFilter: 'orders' } }), {
      ...options,
      migrations: { 1: value => ({ globalFilter: (value as { oldFilter: string }).oldFilter, scrollTop: 0 }) },
    })?.payload).toEqual({ globalFilter: 'orders', scrollTop: 0 });
    expect(() => decodePersistenceEnvelope(JSON.stringify({ ...envelope, identity: { ...identity, workspaceId: 'other' } }), options)).toThrow(PersistenceDecodeError);
    expect(identitiesMatch(identity, { productId: 'web', userId: 'user-1' })).toBe(true);
  });

  it('supports a legacy read fallback without accepting result buffers or secrets', () => {
    const envelope = createPersistenceEnvelope({ globalFilter: 'legacy' }, options);
    const read = decodeWithLegacyFallback(undefined, { globalFilter: 'legacy' }, { ...options, legacyIdentity: identity });
    expect(read?.migratedFromLegacy).toBe(true);
    expect(read?.envelope.identity.workspaceId).toBe('workspace-1');
    expect(() => decodeWithLegacyFallback(undefined, { globalFilter: 'foreign' }, options)).toThrow(PersistenceDecodeError);
    expect(() => createPersistenceEnvelope({ rows: [[1]] }, options)).toThrow(PersistenceDecodeError);
    expect(() => createPersistenceEnvelope({ accessToken: 'never-store' }, options)).toThrow(PersistenceDecodeError);
    expect(() => createPersistenceEnvelope({ sessionToken: 'never-store' }, options)).toThrow(PersistenceDecodeError);
    expect(() => createPersistenceEnvelope({ authToken: 'never-store' }, options)).toThrow(PersistenceDecodeError);
    expect(() => createPersistenceEnvelope({ apiKey: 'never-store' }, options)).toThrow(PersistenceDecodeError);
    expect(() => decodePersistenceEnvelope(JSON.stringify({ ...envelope, identity: { ...identity, password: 'never-store' } }), options)).toThrow(PersistenceDecodeError);
    expect(() => decodePersistenceEnvelope(JSON.stringify({ ...envelope, scope: 'another-product' }), options)).toThrow(PersistenceDecodeError);
    expect(() => decodePersistenceEnvelope(JSON.stringify({ ...envelope, schemaVersion: 0 }), { ...options, migrations: { 0: value => value } })).toThrow(PersistenceDecodeError);
  });

  it('requires available capabilities and exposes a stable descriptor for unavailable ones', () => {
    const registry = new CapabilityRegistry([
      { key: 'results.read', status: 'available', owner: 'result-adapter', documentation: '/docs/results', removalCondition: 'never' },
      { key: 'results.write', status: 'read-only', owner: 'result-adapter', reason: 'The profile is read-only.', documentation: '/docs/results', removalCondition: 'Enable a writable connection.' },
    ]);
    expect(registry.require('results.read').key).toBe('results.read');
    expect(() => registry.require('results.write')).not.toThrow();
    registry.set({ key: 'admin', status: 'unsupported', owner: 'web-adapter', documentation: '/docs/admin', removalCondition: 'Add an API route.' });
    expect(() => registry.require('admin')).toThrow(CapabilityUnavailableError);
    expect(() => registry.require('missing')).toThrow("Capability 'missing'");
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.list()).toHaveLength(3);
    registry.dispose();
    registry.dispose();
    expect(() => registry.set({ key: 'after-dispose', status: 'available', owner: 'test', documentation: '/docs', removalCondition: 'never' })).toThrow('disposed');
  });
});

describe('ui-core lifecycle', () => {
  it('disposes resources once in reverse registration order', async () => {
    const order: string[] = [];
    const coordinator = createDisposalCoordinator();
    coordinator.add(() => { order.push('first'); });
    coordinator.add(() => { order.push('second'); });
    await Promise.all([coordinator.dispose(), coordinator.dispose()]);
    expect(order).toEqual(['second', 'first']);
    expect(coordinator.disposed).toBe(true);
  });

  it('disposes a partially initialized resource and preserves the initialization error', async () => {
    let disposed = 0;
    const resource: Disposable = { dispose: () => { disposed += 1; } };
    await expect(disposeOnInitializationFailure(resource, async () => { throw new Error('init failed'); })).rejects.toThrow('init failed');
    expect(disposed).toBe(1);
  });

  it('supports unregistering resources, late registration and aggregated cleanup errors', async () => {
    const order: string[] = [];
    const coordinator = createDisposalCoordinator();
    const remove = coordinator.add(() => { order.push('removed'); });
    remove();
    remove();
    coordinator.add(() => { order.push('kept'); });
    await coordinator.dispose();
    const late = jest.fn();
    coordinator.add(late);
    await Promise.resolve();
    expect(order).toEqual(['kept']);
    expect(late).toHaveBeenCalledTimes(1);

    const singleFailure = createDisposalCoordinator();
    singleFailure.add(() => { throw new Error('one'); });
    await expect(singleFailure.dispose()).rejects.toThrow('one');
    const multipleFailures = createDisposalCoordinator();
    multipleFailures.add(() => { throw new Error('first'); });
    multipleFailures.add(() => { throw new Error('second'); });
    await expect(multipleFailures.dispose()).rejects.toBeInstanceOf(AggregateError);
  });
});

describe('ui-core mode and store contracts', () => {
  it('defaults unknown mode values to legacy and notifies subscribers only on transitions', () => {
    expect(resolveUiMode('shared')).toBe('shared');
    expect(resolveUiMode('legacy')).toBe('legacy');
    expect(resolveUiMode('unexpected')).toBe('legacy');
    const store = createUiStore(initial());
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    const action: UiAction = { type: 'mode/set', mode: 'shared' };
    expect(store.dispatch(action).mode).toBe('shared');
    expect(store.dispatch(action).mode).toBe('shared');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.dispatch({ type: 'mode/set', mode: 'legacy' });
    expect(listener).toHaveBeenCalledTimes(1);
    store.dispose();
    store.dispose();
    expect(store.dispatch({ type: 'mode/set', mode: 'shared' })).toBe(store.getState());
    expect(store.subscribe(() => undefined)()).toBeUndefined();
  });
});
