import type { QueryEvent } from '@justybase/contracts';
import { createExecutionController, createInitialUiState, createUiStore } from '@justybase/ui-core';
import type { ElectronApiClient, QueryEventSubscription } from '../src/renderer/api';
import { createElectronExecutionPort } from '../src/renderer/execution';

function fakeSubscription(): QueryEventSubscription & { closed: boolean } {
  return { closed: false, close() { this.closed = true; }, getLastSequence: () => 0 };
}

function fakeClient() {
  let emit: ((event: QueryEvent) => void) | undefined;
  let reportError: ((error: Error) => void) | undefined;
  const subscription = fakeSubscription();
  const client: ElectronApiClient = {
    startQuery: jest.fn(async () => ({ queryId: 'query-1', statementCount: 1 })),
    queryPage: jest.fn(async () => ({ sessionId: 'session-1', columns: [], rows: [], offset: 0, limit: 10, totalRows: 0, hasMore: false })),
    cancelQuery: jest.fn(async () => ({ ok: true as const })),
    connectToQueryEvents: jest.fn((_queryId, onEvent, onError) => {
      emit = onEvent;
      reportError = onError;
      return subscription;
    }),
  };
  return { client, emit: (event: QueryEvent) => emit?.(event), reportError: (error: Error) => reportError?.(error), subscription };
}

describe('Electron renderer execution adapter', () => {
  it('maps API events to one ordered portable stream and keeps rows outside ui-core', async () => {
    const fixture = fakeClient();
    const rows: Array<readonly unknown[]> = [];
    const port = createElectronExecutionPort({ client: fixture.client, onRows: (_resultSetId, nextRows) => rows.push(...nextRows) });
    const handle = await port.start({ sourceId: 'electron:scratch', sql: 'SELECT 1', connectionId: 'connection-1', mode: 'single' });
    const iterator = handle.events[Symbol.asyncIterator]();
    fixture.emit({ queryId: 'query-1', type: 'started', startedAt: 1, sequence: 1 });
    fixture.emit({ queryId: 'query-1', type: 'session', sessionId: 'session-1', totalRows: 0, sequence: 2 });
    fixture.emit({ queryId: 'query-1', type: 'columns', columns: [{ name: 'value', type: 'INTEGER' }], sequence: 3 });
    fixture.emit({ queryId: 'query-1', type: 'rows', rows: [[1]], totalRows: 1, sequence: 4 });
    fixture.emit({ queryId: 'query-1', type: 'complete', totalRows: 1, limitReached: false, sequence: 5 });

    const events = [];
    for await (const event of handle.events) events.push(event);
    expect(events.map(event => event.type)).toEqual(['started', 'columns', 'rows', 'complete']);
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(events.every(event => event.sourceId === 'electron:scratch' && event.resultSetId === 'query-1:0')).toBe(true);
    expect(events.find(event => event.type === 'rows')).toMatchObject({ rowCount: 1, totalRowCount: 1 });
    expect(rows).toEqual([[1]]);
    expect(fixture.subscription.closed).toBe(true);
    await port.dispose();
    await port.dispose();
    expect(fixture.client.cancelQuery).not.toHaveBeenCalled();
    void iterator;
  });

  it('hydrates adapter-owned rows from the finalized API page when the stream only sends progress', async () => {
    const fixture = fakeClient();
    fixture.client.queryPage = jest.fn(async () => ({
      sessionId: 'session-1',
      columns: [{ name: 'value', type: 'INTEGER' }],
      rows: [[9]],
      offset: 0,
      limit: 500,
      totalRows: 1,
      hasMore: false,
    }));
    const pages: Array<readonly (readonly unknown[])[]> = [];
    const port = createElectronExecutionPort({ client: fixture.client, onPage: (_resultSetId, rows) => pages.push(rows) });
    const handle = await port.start({ sourceId: 'electron:scratch', sql: 'SELECT 9', connectionId: 'connection-1', mode: 'single' });
    fixture.emit({ queryId: 'query-1', type: 'started', startedAt: 1 });
    fixture.emit({ queryId: 'query-1', type: 'columns', columns: [{ name: 'value', type: 'INTEGER' }] });
    fixture.emit({ queryId: 'query-1', type: 'complete', totalRows: 1, limitReached: false });
    for await (const _event of handle.events) void _event;
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(fixture.client.queryPage).toHaveBeenCalledWith('query-1', { statementIndex: 0, offset: 0, limit: 500 });
    expect(pages).toEqual([[[9]]]);
    await port.dispose();
  });

  it('supports explicit cancellation and converts transport failure to an error event', async () => {
    const fixture = fakeClient();
    const port = createElectronExecutionPort({ client: fixture.client });
    const handle = await port.start({ sourceId: 'electron:scratch', sql: 'SELECT 1', connectionId: 'connection-1', mode: 'single' });
    const iterator = handle.events[Symbol.asyncIterator]();
    fixture.emit({ queryId: 'query-1', type: 'started', startedAt: 1 });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'started', sequence: 1 }, done: false });
    await expect(port.cancel('electron:scratch', 'query-1')).resolves.toEqual({ requestId: 'electron-cancel-query-1', status: 'acknowledged' });
    fixture.emit({ queryId: 'query-1', type: 'cancelled', totalRows: 0 });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'cancelled', sequence: 2 }, done: false });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(fixture.subscription.closed).toBe(true);

    const failedFixture = fakeClient();
    const failedPort = createElectronExecutionPort({ client: failedFixture.client });
    const failedHandle = await failedPort.start({ sourceId: 'electron:scratch', sql: 'SELECT 1', connectionId: 'connection-1', mode: 'single' });
    const failedIterator = failedHandle.events[Symbol.asyncIterator]();
    failedFixture.reportError(new Error('socket failed'));
    await expect(failedIterator.next()).resolves.toMatchObject({ value: { type: 'error', message: 'socket failed', sequence: 1 }, done: false });
    await expect(failedIterator.next()).resolves.toMatchObject({ done: true });
    await failedPort.dispose();
  });

  it('bridges the controller without replaying SQL during cancellation', async () => {
    const fixture = fakeClient();
    const store = createUiStore(createInitialUiState({ productId: 'electron', sourceId: 'electron:scratch' }, { mode: 'shared', persistenceScope: 'profile' }));
    const controller = createExecutionController(store, createElectronExecutionPort({ client: fixture.client }));
    const handle = await controller.run({ sourceId: 'electron:scratch', sql: 'SELECT 1', connectionId: 'connection-1', mode: 'single' });
    fixture.emit({ queryId: 'query-1', type: 'started', startedAt: 1 });
    await new Promise<void>(resolve => queueMicrotask(resolve));
    await controller.cancel(handle.sourceId, handle.executionId);
    expect(fixture.client.startQuery).toHaveBeenCalledTimes(1);
    expect(fixture.client.cancelQuery).toHaveBeenCalledTimes(1);
    fixture.emit({ queryId: 'query-1', type: 'cancelled', totalRows: 0 });
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(Object.values(store.getState().results.byResultSetId)[0]).toMatchObject({ status: 'cancelled', cancellation: 'cancelled' });
    await controller.dispose();
    store.dispose();
  });
});
