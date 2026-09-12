import type { QueryColumn, QueryEvent } from '@justybase/contracts';
import type { ExecutionHandle, ExecutionInput, ExecutionPort, UiResultEvent } from '@justybase/ui-core';
import type { ElectronApiClient, QueryEventSubscription } from './api';

const RESULT_PAGE_SIZE = 500;

export interface HydratedResultRows {
  readonly columns: readonly QueryColumn[];
  readonly rows: readonly (readonly unknown[])[];
  readonly totalRowCount: number;
}

/** Loads the complete finalized result for one statement from the API spool. */
export async function fetchAllResultPages(
  client: ElectronApiClient,
  queryId: string,
  statementIndex = 0,
): Promise<HydratedResultRows> {
  const rows: Array<readonly unknown[]> = [];
  let offset = 0;

  for (;;) {
    const page = await client.queryPage(queryId, { statementIndex, offset, limit: RESULT_PAGE_SIZE });
    if (page.offset !== offset) throw new Error('Electron result paging returned a non-contiguous offset.');

    rows.push(...page.rows.map(row => [...row]));

    if (!page.hasMore) {
      return {
        columns: page.columns.map(column => ({
          name: column.name,
          ...(column.type === undefined ? {} : { type: column.type }),
          ...(column.scale === undefined ? {} : { scale: column.scale }),
        })),
        rows,
        totalRowCount: page.totalRows,
      };
    }
    if (page.rows.length === 0) throw new Error('Electron result paging made no progress.');
    offset += page.rows.length;
  }
}

export interface ElectronExecutionPortOptions {
  readonly client: ElectronApiClient;
  readonly onRows?: (resultSetId: string, rows: readonly (readonly unknown[])[]) => void;
  /** Replaces the adapter-owned page after the API has finalized the session. */
  readonly onPage?: (sourceId: string, resultSetId: string, rows: readonly (readonly unknown[])[], totalRowCount: number, columns: readonly QueryColumn[], executionId: string) => void;
}

interface ActiveStream {
  readonly queryId: string;
  readonly subscription: QueryEventSubscription;
  readonly stop: () => void;
}

function resultSetIdFor(queryId: string, statementIndex = 0): string {
  return `${queryId}:${statementIndex}`;
}

function mapEvent(sourceId: string, queryId: string, event: QueryEvent, sequence: number, loadedRowCount: number, onRows: ElectronExecutionPortOptions['onRows']): UiResultEvent | undefined {
  const resultSetId = resultSetIdFor(queryId, event.statementIndex ?? 0);
  const base = { sourceId, executionId: queryId, resultSetId, sequence };
  switch (event.type) {
    case 'started': return { ...base, type: 'started' };
    case 'statement-started': return { ...base, type: 'statement-started' };
    case 'columns': return { ...base, type: 'columns', columns: event.columns.map(column => ({
      name: column.name,
      ...(column.type === undefined ? {} : { type: column.type }),
      ...(column.scale === undefined ? {} : { scale: column.scale }),
    })) };
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
  onActive: (stream: ActiveStream | undefined) => void,
): AsyncIterable<UiResultEvent> {
  const queue: UiResultEvent[] = [];
  const pending: Array<(result: IteratorResult<UiResultEvent>) => void> = [];
  let done = false;
  let sequence = 0;
  let loadedRowCount = 0;
  const subscriptionRef: { current?: QueryEventSubscription } = {};
  let pageRequested = false;

  const hydratePages = async (statementIndex: number): Promise<Error | undefined> => {
    if (!onPage || pageRequested) return undefined;
    pageRequested = true;
    const resultSetId = resultSetIdFor(queryId, statementIndex);
    try {
      const hydrated = await fetchAllResultPages(client, queryId, statementIndex);
      if (done) return undefined;
      onPage(
        sourceId,
        resultSetId,
        hydrated.rows,
        hydrated.totalRowCount,
        hydrated.columns,
        queryId,
      );
      return undefined;
    } catch (error: unknown) {
      const failure = error instanceof Error ? error : new Error('Could not load result rows.');
      if (done) return undefined;
      return failure;
    }
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
  const pushMapped = (event: QueryEvent): void => {
    if (done) return;
    if (event.type === 'rows') loadedRowCount += event.rows.length;
    const mapped = mapEvent(sourceId, queryId, event, ++sequence, loadedRowCount, onRows);
    if (mapped) {
      queue.push(mapped);
      if (mapped.type === 'complete' || mapped.type === 'error' || mapped.type === 'cancelled') finish();
      flush();
    }
  };
  const push = (event: QueryEvent): void => {
    if (done) return;
    if (event.type === 'session' || event.type === 'batch-complete') return;
    if (event.type === 'complete' && onPage && !pageRequested) {
      // Keep the terminal event behind hydration. The renderer can therefore
      // only expose a complete/ready result after every result page is local.
      void hydratePages(event.statementIndex ?? 0).then(failure => {
        if (failure) {
          pushMapped({ ...event, type: 'error', message: `Result page hydration failed: ${failure.message}` });
          return;
        }
        pushMapped(event);
      });
      return;
    }
    pushMapped(event);
  };
  const subscription = client.connectToQueryEvents(queryId, push, error => {
    if (done) return;
    queue.push({ sourceId, executionId: queryId, resultSetId: resultSetIdFor(queryId), sequence: ++sequence, type: 'error', message: error.message });
    finish();
  });
  subscriptionRef.current = subscription;
  if (done) subscription.close();
  else onActive({ queryId, subscription, stop: finish });

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
      if (input.mode === 'script') throw new Error('Electron execution does not support script mode.');
      const started = await options.client.startQuery({ connectionId: input.connectionId, sql: input.sql, mode: input.mode });
      const sourceId = input.sourceId;
      const resultSetId = resultSetIdFor(started.queryId);
      const events = eventStream(sourceId, started.queryId, options.client, options.onRows, options.onPage, stream => {
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
      for (const stream of streams) stream.stop();
      await Promise.allSettled(streams.map(stream => options.client.cancelQuery(stream.queryId)));
    },
  };
}
