import type {
  DatabaseQueryCallbacks,
  DatabaseQueryCommand,
  DatabaseQueryOptions,
  DatabaseQueryResult,
  ExecutionEvent,
  ExecutionRequest,
} from '@justybase/contracts';
import {
  ExecutionBackendError,
  ExecutionCancelledError,
  ExecutionOrchestrator,
  ExecutionResourceScope,
  ExecutionTimeoutError,
  type ExecutionBackend,
  type ExecutionObserver,
  type ExecutionScheduler,
} from '../src';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

interface ScriptedResult {
  columns?: { name: string; type?: string }[];
  rows?: unknown[][];
  result?: DatabaseQueryResult;
  error?: unknown;
  gate?: Deferred<void>;
}

class ManualScheduler implements ExecutionScheduler {
  private nextHandle = 1;
  private readonly timers = new Map<number, () => void>();
  private currentTime = 0;

  public now(): number { return this.currentTime; }

  public setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    const handle = this.nextHandle++;
    this.timers.set(handle, callback);
    return handle as unknown as ReturnType<typeof setTimeout>;
  }

  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.timers.delete(handle as unknown as number);
  }

  public fireAll(): void {
    const callbacks = [...this.timers.values()];
    this.timers.clear();
    callbacks.forEach(callback => callback());
  }

  public get pendingTimers(): number { return this.timers.size; }
}

class FakeBackend implements ExecutionBackend<string> {
  public readonly calls: string[] = [];
  public readonly reconnect = jest.fn(async () => undefined);
  public readonly closeAll = jest.fn(async () => undefined);
  public readonly commands: DatabaseQueryCommand[] = [];
  private readonly scripts: ScriptedResult[];

  public constructor(scripts: ScriptedResult[]) {
    this.scripts = [...scripts];
  }

  public isConnectionBrokenError(error: unknown): boolean {
    return error instanceof Error && error.message === 'socket closed';
  }

  public isSafeToRetrySql(sql: string): boolean {
    return /^SELECT\b/iu.test(sql.trim());
  }

  public async execute(
    _target: string,
    sql: string,
    _options: DatabaseQueryOptions,
    callbacks: DatabaseQueryCallbacks,
  ): Promise<DatabaseQueryResult> {
    this.calls.push(sql);
    const script = this.scripts.shift() ?? { result: { totalRows: 0, limitReached: false } };
    let cancelled = false;
    let rejectCancelled!: (error: unknown) => void;
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
    const command: DatabaseQueryCommand = {
      cancel: jest.fn(async () => {
        cancelled = true;
        rejectCancelled(new ExecutionCancelledError());
      }),
    };
    this.commands.push(command);
    callbacks.onCommand(command);

    const run = async (): Promise<DatabaseQueryResult> => {
      if (script.gate) await script.gate.promise;
      if (cancelled) throw new ExecutionCancelledError();
      if (script.columns) await callbacks.onColumns(script.columns);
      if (script.rows) await callbacks.onRows(script.rows, script.rows.length);
      if (script.error) throw script.error;
      return script.result ?? { totalRows: script.rows?.length ?? 0, limitReached: false };
    };

    if (script.gate) return Promise.race([run(), cancellation]);
    return run();
  }
}

function request(overrides: Partial<ExecutionRequest<string>> = {}): ExecutionRequest<string> {
  return {
    executionId: 'execution-1',
    sourceKey: 'source-1',
    target: 'target-1',
    statements: [{ index: 0, sql: 'SELECT 1' }],
    delivery: 'buffered',
    connectionMode: 'transient',
    maxRows: 10,
    timeoutSeconds: 0,
    readOnly: false,
    retryPolicy: 'disabled',
    continueOnError: false,
    ...overrides,
  };
}

function observer(events: ExecutionEvent[]): ExecutionObserver {
  return { onEvent: event => { events.push(event); } };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !predicate(); attempt += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

describe('ExecutionOrchestrator', () => {
  it('disposes execution resources in reverse order and reports cleanup failures', async () => {
    const scope = new ExecutionResourceScope();
    const order: string[] = [];
    scope.add({ label: 'reader', dispose: () => { order.push('reader'); } });
    scope.add({ label: 'worker', dispose: () => { order.push('worker'); throw new Error('worker close failed'); } });
    scope.add({ label: 'timer', dispose: () => { order.push('timer'); } });

    const first = await scope.dispose();
    const second = await scope.dispose();

    expect(order).toEqual(['timer', 'worker', 'reader']);
    expect(first).toHaveLength(1);
    expect(second).toBe(first);
  });

  it('does not lose synchronous or undefined cleanup failures after disposal starts', async () => {
    const scope = new ExecutionResourceScope();
    await scope.dispose();
    const dispose = jest.fn(() => { throw undefined; });

    scope.add({ dispose });
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('turns a successful execution with cleanup failure into one error terminal', async () => {
    const events: ExecutionEvent[] = [];
    const backend: ExecutionBackend<string> = {
      execute: async (_target, _sql, _options, _callbacks, resources) => {
        resources?.add({ dispose: () => { throw new Error('reader close failed'); } });
        return { totalRows: 0, limitReached: false };
      },
    };

    const execution = new ExecutionOrchestrator({ backend }).start(request(), observer(events));
    const summary = await execution.settled;

    expect(summary.status).toBe('error');
    expect(summary.error?.kind).toBe('cleanup');
    expect(summary.cleanupErrors).toHaveLength(1);
    expect(events.filter(event => event.type === 'execution-terminal')).toHaveLength(1);
    expect(events.filter(event => event.type === 'batch-completed')).toHaveLength(1);
  });

  it('serializes events and emits one terminal lifecycle for a successful batch', async () => {
    const backend = new FakeBackend([
      { columns: [{ name: 'A', type: 'INTEGER' }], rows: [[1]], result: { totalRows: 1, limitReached: false } },
      { columns: [{ name: 'B', type: 'INTEGER' }], rows: [[2], [3]], result: { totalRows: 2, limitReached: false } },
    ]);
    const events: ExecutionEvent[] = [];
    const execution = new ExecutionOrchestrator({ backend }).start(
      request({
        statements: [{ index: 0, sql: 'SELECT 1' }, { index: 1, sql: 'SELECT 2' }],
      }),
      observer(events),
    );

    const summary = await execution.settled;
    expect(summary.status).toBe('success');
    expect(summary.totalRows).toBe(3);
    expect(events.map(event => event.type)).toEqual([
      'execution-started',
      'statement-started',
      'columns',
      'rows',
      'progress',
      'statement-completed',
      'statement-started',
      'columns',
      'rows',
      'progress',
      'statement-completed',
      'execution-terminal',
      'batch-completed',
    ]);
    expect(events.map(event => event.sequence)).toEqual([...Array(events.length)].map((_value, index) => index + 1));
    expect(events.filter(event => event.type === 'execution-terminal')).toHaveLength(1);
    expect(events.filter(event => event.type === 'batch-completed')).toHaveLength(1);
  });

  it('cancels before the first statement without calling the backend', async () => {
    const backend = new FakeBackend([]);
    const events: ExecutionEvent[] = [];
    const execution = new ExecutionOrchestrator({ backend }).start(request(), observer(events));
    await execution.cancel('cancel before start');
    const summary = await execution.settled;

    expect(summary.status).toBe('cancelled');
    expect(backend.calls).toHaveLength(0);
    expect(events.at(-2)?.type).toBe('execution-terminal');
    expect(events.at(-1)?.type).toBe('batch-completed');
  });

  it('cancels an in-flight command once and does not emit late rows', async () => {
    const gate = deferred<void>();
    const backend = new FakeBackend([{ gate, columns: [{ name: 'A' }], rows: [[1]] }]);
    const events: ExecutionEvent[] = [];
    const execution = new ExecutionOrchestrator({ backend }).start(request(), observer(events));
    await waitFor(() => backend.commands.length === 1);
    await execution.cancel('user cancellation');
    gate.resolve(undefined);
    const summary = await execution.settled;

    expect(summary.status).toBe('cancelled');
    expect(backend.commands[0]?.cancel).toHaveBeenCalledTimes(1);
    expect(events.some(event => event.type === 'rows')).toBe(false);
  });

  it('retries one safe broken-connection execution before any rows', async () => {
    const backend = new FakeBackend([
      { error: new Error('socket closed') },
      { columns: [{ name: 'A' }], rows: [[1]], result: { totalRows: 1, limitReached: false } },
    ]);
    const events: ExecutionEvent[] = [];
    const execution = new ExecutionOrchestrator({ backend }).start(
      request({ connectionMode: 'persistent', retryPolicy: 'safe-read-only-on-broken-connection' }),
      observer(events),
    );

    const summary = await execution.settled;
    expect(summary.status).toBe('success');
    expect(backend.calls).toEqual(['SELECT 1', 'SELECT 1']);
    expect(backend.reconnect).toHaveBeenCalledTimes(1);
    expect(events.map(event => event.type)).toContain('retrying');
    expect(events.filter(event => event.type === 'execution-terminal')).toHaveLength(1);
  });

  it('binds backend classifier methods to their owning adapter instance', async () => {
    class StatefulBackend implements ExecutionBackend<string> {
      public calls = 0;
      public reconnect = jest.fn(async () => undefined);
      private readonly marker = 'owned';

      public isConnectionBrokenError(error: unknown): boolean {
        return this.marker === 'owned' && error instanceof Error && error.message === 'socket closed';
      }

      public isSafeToRetrySql(sql: string): boolean {
        return this.marker === 'owned' && sql === 'SELECT 1';
      }

      public async execute(): Promise<DatabaseQueryResult> {
        this.calls += 1;
        if (this.calls === 1) throw new Error('socket closed');
        return { totalRows: 1, limitReached: false };
      }
    }

    const backend = new StatefulBackend();
    const summary = await new ExecutionOrchestrator({ backend }).start(request({
      connectionMode: 'persistent',
      retryPolicy: 'safe-read-only-on-broken-connection',
    })).settled;

    expect(summary.status).toBe('success');
    expect(backend.calls).toBe(2);
    expect(backend.reconnect).toHaveBeenCalledTimes(1);
  });

  it('observes external cancellation after reconnect and never replays the statement', async () => {
    let cancellationRequested = false;
    let calls = 0;
    const backend: ExecutionBackend<string> = {
      execute: async () => {
        calls += 1;
        throw new Error('socket closed');
      },
      isConnectionBrokenError: () => true,
      isSafeToRetrySql: () => true,
      isCancellationRequested: () => cancellationRequested,
      reconnect: async () => { cancellationRequested = true; },
    };

    const summary = await new ExecutionOrchestrator({ backend }).start(request({
      connectionMode: 'persistent',
      retryPolicy: 'safe-read-only-on-broken-connection',
    })).settled;

    expect(summary.status).toBe('cancelled');
    expect(calls).toBe(1);
  });

  it('retains partial row metadata on a cancelled statement', async () => {
    const events: ExecutionEvent[] = [];
    const backend: ExecutionBackend<string> = {
      execute: async () => {
        throw new ExecutionBackendError(
          'Query cancelled',
          new ExecutionCancelledError(),
          { totalRows: 3, limitReached: true },
        );
      },
    };

    const summary = await new ExecutionOrchestrator({ backend }).start(
      request(),
      observer(events),
    ).settled;
    const failed = events.find(
      (event): event is Extract<ExecutionEvent, { type: 'statement-failed' }> =>
        event.type === 'statement-failed',
    );

    expect(summary.status).toBe('cancelled');
    expect(summary.totalRows).toBe(3);
    expect(summary.limitReached).toBe(true);
    expect(failed?.summary).toEqual(expect.objectContaining({ totalRows: 3, limitReached: true }));
  });

  it('does not retry after a row has been delivered', async () => {
    const backend = new FakeBackend([
      { columns: [{ name: 'A' }], rows: [[1]], error: new Error('socket closed') },
    ]);
    const events: ExecutionEvent[] = [];
    const execution = new ExecutionOrchestrator({ backend }).start(
      request({ connectionMode: 'persistent', retryPolicy: 'safe-read-only-on-broken-connection' }),
      observer(events),
    );

    const summary = await execution.settled;
    expect(summary.status).toBe('error');
    expect(backend.calls).toHaveLength(1);
    expect(backend.reconnect).not.toHaveBeenCalled();
    expect(events.some(event => event.type === 'retrying')).toBe(false);
  });

  it('turns a timeout into one error terminal and clears its timer', async () => {
    const scheduler = new ManualScheduler();
    const gate = deferred<void>();
    const backend = new FakeBackend([{ gate }]);
    const events: ExecutionEvent[] = [];
    const execution = new ExecutionOrchestrator({ backend, scheduler }).start(
      request({ timeoutSeconds: 1 }),
      observer(events),
    );
    await Promise.resolve();
    await Promise.resolve();
    scheduler.fireAll();
    gate.resolve(undefined);
    const summary = await execution.settled;

    expect(summary.status).toBe('error');
    expect(summary.error?.kind).toBe('timeout');
    expect(summary.error?.cause).toBeInstanceOf(ExecutionTimeoutError);
    expect(scheduler.pendingTimers).toBe(0);
    expect(events.filter(event => event.type === 'execution-terminal')).toHaveLength(1);
  });

  it('preserves the first failure when a batch continues after statement errors', async () => {
    const firstFailure = new Error('first statement failed');
    const backend = new FakeBackend([{ error: firstFailure }, { result: { totalRows: 1, limitReached: false } }]);
    const events: ExecutionEvent[] = [];
    const execution = new ExecutionOrchestrator({ backend }).start(
      request({
        continueOnError: true,
        statements: [{ index: 0, sql: 'SELECT 1' }, { index: 1, sql: 'SELECT 2' }],
      }),
      observer(events),
    );

    const summary = await execution.settled;
    expect(summary.status).toBe('error');
    expect(summary.error?.cause).toBe(firstFailure);
    expect(events.filter(event => event.type === 'statement-failed')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('batch-completed');
  });

  it('keeps transient and write executions from replaying after a broken connection', async () => {
    const transientBackend = new FakeBackend([{ error: new Error('socket closed') }]);
    const transient = new ExecutionOrchestrator({ backend: transientBackend }).start(
      request({ connectionMode: 'transient', retryPolicy: 'safe-read-only-on-broken-connection' }),
    );
    const transientSummary = await transient.settled;

    const writeBackend = new FakeBackend([{ error: new Error('socket closed') }]);
    const write = new ExecutionOrchestrator({ backend: writeBackend }).start(
      request({ connectionMode: 'persistent', readOnly: false, retryPolicy: 'safe-read-only-on-broken-connection', statements: [{ index: 0, sql: 'INSERT INTO t VALUES (1)' }] }),
    );
    const writeSummary = await write.settled;

    expect(transientSummary.status).toBe('error');
    expect(transientBackend.calls).toHaveLength(1);
    expect(writeSummary.status).toBe('error');
    expect(writeBackend.calls).toHaveLength(1);
  });

  it('supports observer detachment without cancelling the execution', async () => {
    const backend = new FakeBackend([{ rows: [[1]], result: { totalRows: 1, limitReached: false } }]);
    const events: ExecutionEvent[] = [];
    const execution = new ExecutionOrchestrator({ backend }).start(request(), observer(events));
    execution.detachObserver();
    const summary = await execution.settled;

    expect(summary.status).toBe('success');
    expect(backend.calls).toHaveLength(1);
    expect(events).toHaveLength(0);
  });

  it('ignores callbacks delivered after a backend statement has settled', async () => {
    const events: ExecutionEvent[] = [];
    const backend: ExecutionBackend<string> = {
      execute: async (_target, _sql, _options, callbacks) => {
        callbacks.onRows([[1]], 1);
        setImmediate(() => callbacks.onRows([[2]], 2));
        return { totalRows: 1, limitReached: false };
      },
    };

    const execution = new ExecutionOrchestrator({ backend }).start(request(), observer(events));
    await execution.settled;
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(events.filter(event => event.type === 'rows')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('batch-completed');
  });

  it('keeps execution state isolated between orchestrator instances', async () => {
    const backendA = new FakeBackend([{ rows: [[1]], result: { totalRows: 1, limitReached: false } }]);
    const backendB = new FakeBackend([{ rows: [[2]], result: { totalRows: 1, limitReached: false } }]);
    const first = new ExecutionOrchestrator({ backend: backendA });
    const second = new ExecutionOrchestrator({ backend: backendB });

    const left = first.start(request({ executionId: 'same-id', sourceKey: 'same-source' }));
    const right = second.start(request({ executionId: 'same-id', sourceKey: 'same-source' }));
    await left.settled;
    await right.settled;

    expect(first.snapshot().activeExecutions).toBe(0);
    expect(second.snapshot().activeExecutions).toBe(0);
    expect(backendA.calls).toHaveLength(1);
    expect(backendB.calls).toHaveLength(1);
  });

  it('makes runtime disposal idempotent and waits for active work before closing the backend', async () => {
    const gate = deferred<void>();
    const backend = new FakeBackend([{ gate }]);
    const orchestrator = new ExecutionOrchestrator({ backend });
    const execution = orchestrator.start(request());
    await waitFor(() => backend.commands.length === 1);

    const firstDispose = orchestrator.dispose();
    const secondDispose = orchestrator.dispose();
    gate.resolve(undefined);
    await Promise.all([firstDispose, secondDispose, execution.settled]);

    expect(firstDispose).toBe(secondDispose);
    expect(backend.commands[0]?.cancel).toHaveBeenCalledTimes(1);
    expect(backend.closeAll).toHaveBeenCalledTimes(1);
    expect(orchestrator.snapshot().activeExecutions).toBe(0);
  });
});
