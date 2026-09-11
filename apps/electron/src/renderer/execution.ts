import type { QueryEvent } from '@justybase/contracts';
import type { ExecutionHandle, ExecutionInput, ExecutionPort, UiResultEvent } from '@justybase/ui-core';
import type { ElectronApiClient, QueryEventSubscription } from './api';

export interface ElectronExecutionPortOptions {
  readonly client: ElectronApiClient;
  readonly onRows?: (resultSetId: string, rows: readonly (readonly unknown[])[]) => void;
  /** Replaces the adapter-owned page after the API has finalized the session. */
  readonly onPage?: (resultSetId: string, rows: readonly (readonly unknown[])[], totalRowCount: number, columns: readonly { readonly name: string; readonly type?: string }[], executionId: string) => void;
  readonly onPageError?: (resultSetId: string, error: Error, executionId: string) => void;
}

interface ActiveStream {
  readonly queryId: string;
  readonly subscription: QueryEventSubscription;
}

function resultSetIdFor(queryId: string): string {
  return `${queryId}:0`;
}

function mapEvent(sourceId: string, queryId: string, event: QueryEvent, sequence: number, loadedRowCount: number, onRows: ElectronExecutionPortOptions['onRows']): UiResultEvent | undefined {
  const resultSetId = resultSetIdFor(queryId);
  const base = { sourceId, executionId: queryId, resultSetId, sequence };
  switch (event.type) {
    case 'started': return { ...base, type: 'started' };
    case 'statement-started': return { ...base, type: 'statement-started' };
    case 'columns': return { ...base, type: 'columns', columns: event.columns.map(column => ({ name: column.name, type: column.type })) };
    case 'progress': return { ...base, type: 'progress', totalRowCount: event.totalRows };
    case 'rows': {
      onRows?.(resultSetId, event.rows.map(row => [...row]));
      return { ...base, type: 'rows', rowCount: loadedRowCount, totalRowCount: event.totalRows };
    }
    case 'complete': return { ...base, type: 'complete', totalRowCount: event.totalRows, message: event.message };
    case 'error': return { ...base, type: 'error', message: event.message };
    case 'cancelled': return { ...base, type: 'cancelled', totalRowCount: event.totalRows };
    case 'session':
    case 'batch-complete':
      return undefined;
  }
}

function eventStream(
  sourceId: string,
  queryId: string,
  client: ElectronApiClient,
  onRows: ElectronExecutionPortOptions['onRows'],
  onPage: ElectronExecutionPortOptions['onPage'],
  onPageError: ElectronExecutionPortOptions['onPageError'],
  onActive: (stream: ActiveStream | undefined) => void,
): AsyncIterable<UiResultEvent> {
  const queue: UiResultEvent[] = [];
  const pending: Array<(result: IteratorResult<UiResultEvent>) => void> = [];
  let done = false;
  let sequence = 0;
  let loadedRowCount = 0;
  const subscriptionRef: { current?: QueryEventSubscription } = {};
  let pageRequested = false;

  const hydratePage = (): void => {
    if (!onPage || pageRequested) return;
    pageRequested = true;
    void client.queryPage(queryId, { statementIndex: 0, offset: 0, limit: 500 }).then(page => {
      onPage(
        resultSetIdFor(queryId),
        page.rows.map(row => [...row]),
        page.totalRows,
        page.columns.map(column => ({ name: column.name, type: column.type })),
        queryId,
      );
    }).catch(error => {
      onPageError?.(resultSetIdFor(queryId), error instanceof Error ? error : new Error('Could not load result rows.'), queryId);
    });
  };

  const flush = (): void => {
    while (pending.length > 0 && queue.length > 0) pending.shift()?.({ done: false, value: queue.shift()! });
    if (done && queue.length === 0) while (pending.length > 0) pending.shift()?.({ done: true, value: undefined });
  };
  const finish = (): void => {
    if (done) return;
    done = true;
    subscriptionRef.current?.close();
    onActive(undefined);
    flush();
  };
  const push = (event: QueryEvent): void => {
    if (done) return;
    if (event.type === 'session' || event.type === 'batch-complete') return;
    if (event.type === 'rows') loadedRowCount += event.rows.length;
    if (event.type === 'complete') hydratePage();
    const mapped = mapEvent(sourceId, queryId, event, ++sequence, loadedRowCount, onRows);
    if (mapped) {
      queue.push(mapped);
      if (mapped.type === 'complete' || mapped.type === 'error' || mapped.type === 'cancelled') finish();
      flush();
    }
  };
  const subscription = client.connectToQueryEvents(queryId, push, error => {
    if (done) return;
    queue.push({ sourceId, executionId: queryId, resultSetId: resultSetIdFor(queryId), sequence: ++sequence, type: 'error', message: error.message });
    finish();
  });
  subscriptionRef.current = subscription;
  if (done) subscription.close();
  else onActive({ queryId, subscription });

  const iterator: AsyncIterator<UiResultEvent> = {
    next: () => {
      if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift()! });
      if (done) return Promise.resolve({ done: true, value: undefined });
      return new Promise(resolve => pending.push(resolve));
    },
  };
  return { [Symbol.asyncIterator]: () => iterator };
}

/** Maps the authenticated same-origin transport to the portable execution port. */
export function createElectronExecutionPort(options: ElectronExecutionPortOptions): ExecutionPort {
  const active = new Map<string, ActiveStream>();
  let disposed = false;
  return {
    async start(input: ExecutionInput): Promise<ExecutionHandle> {
      if (disposed) throw new Error('Electron execution port is disposed.');
      const started = await options.client.startQuery({ connectionId: input.connectionId, sql: input.sql, mode: input.mode });
      const sourceId = input.sourceId;
      const resultSetId = resultSetIdFor(started.queryId);
      const events = eventStream(sourceId, started.queryId, options.client, options.onRows, options.onPage, options.onPageError, stream => {
        if (stream) active.set(started.queryId, stream);
        else active.delete(started.queryId);
      });
      return { sourceId, executionId: started.queryId, resultSetId, events };
    },
    async cancel(_sourceId: string, executionId: string): Promise<{ requestId: string; status: 'acknowledged' | 'failed'; message?: string }> {
      if (disposed) return { requestId: `electron-cancel-${executionId}`, status: 'failed', message: 'Electron execution port is disposed.' };
      const requestId = `electron-cancel-${executionId}`;
      try {
        await options.client.cancelQuery(executionId);
        return { requestId, status: 'acknowledged' };
      } catch (error: unknown) {
        return { requestId, status: 'failed', message: error instanceof Error ? error.message : 'Cancellation failed.' };
      }
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      const streams = [...active.values()];
      active.clear();
      for (const stream of streams) stream.subscription.close();
      await Promise.allSettled(streams.map(stream => options.client.cancelQuery(stream.queryId)));
    },
  };
}
