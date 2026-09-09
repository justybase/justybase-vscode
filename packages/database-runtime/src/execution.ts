import type {
  Awaitable,
  DatabaseQueryCallbacks,
  DatabaseQueryCommand,
  DatabaseQueryOptions,
  DatabaseQueryResult,
  ExecutionContext,
  ExecutionEvent,
  ExecutionFailure,
  ExecutionPhase,
  ExecutionRequest,
  ExecutionStatement,
  ExecutionStatementSummary,
  ExecutionSummary,
  ExecutionTerminalStatus,
} from '@justybase/contracts';

export interface ExecutionBackend<TTarget> {
  execute(
    target: TTarget,
    sql: string,
    options: DatabaseQueryOptions,
    callbacks: DatabaseQueryCallbacks,
    resources?: ExecutionResourceScope,
    context?: ExecutionBackendContext<TTarget>,
  ): Promise<DatabaseQueryResult>;
  isReadOnlySql?(sql: string): boolean;
  isConnectionBrokenError?(error: unknown): boolean;
  isSafeToRetrySql?(sql: string): boolean;
  isCancellationRequested?(target: TTarget): boolean;
  cancel?(target: TTarget, request: ExecutionRequest<TTarget>, reason?: string): Awaitable<void>;
  closeConnection?(connectionId: string): Promise<void>;
  closeTarget?(target: TTarget): Promise<void>;
  reconnect?(target: TTarget): Promise<void>;
  closeAll?(): Promise<void>;
  cleanup?(target: TTarget, request: ExecutionRequest<TTarget>): Awaitable<void>;
}

/** Per-statement context available to a product adapter without coupling the
 * adapter to editor, transport, history, or authorization state. */
export interface ExecutionBackendContext<TTarget> {
  readonly request: ExecutionRequest<TTarget>;
  readonly statement: ExecutionStatement;
  readonly context: ExecutionContext & { statementIndex: number };
  readonly delivery: ExecutionRequest<TTarget>['delivery'];
}

export interface ExecutionObserver {
  onEvent(event: ExecutionEvent): Awaitable<void>;
}

export interface ExecutionResource {
  readonly label?: string;
  dispose(): Awaitable<void>;
}

/**
 * LIFO ownership for resources created while one execution is active.
 * Disposal is deliberately idempotent and collects every failure so one
 * broken reader/worker cannot prevent the remaining resources from closing.
 */
export class ExecutionResourceScope {
  private readonly resources: ExecutionResource[] = [];
  private disposal?: Promise<readonly unknown[]>;

  public add(resource: ExecutionResource): () => void {
    if (this.disposal) {
      void Promise.resolve()
        .then(() => resource.dispose())
        .catch(() => undefined);
      return () => undefined;
    }
    this.resources.push(resource);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const index = this.resources.indexOf(resource);
      if (index >= 0) this.resources.splice(index, 1);
    };
  }

  public dispose(): Promise<readonly unknown[]> {
    if (this.disposal) return this.disposal;
    const resources = this.resources.splice(0).reverse();
    this.disposal = (async () => {
      const errors: unknown[] = [];
      // Resources are owned as a stack. Dispose them serially so a reader is
      // fully closed before its connection, and one failure cannot reorder or
      // skip the remaining cleanup work.
      for (const resource of resources) {
        try {
          await resource.dispose();
        } catch (error: unknown) {
          errors.push(error);
        }
      }
      return errors;
    })();
    return this.disposal;
  }
}

export interface ExecutionLogger {
  debug?(message: string, error?: unknown): void;
  warn?(message: string, error?: unknown): void;
  error?(message: string, error?: unknown): void;
}

export interface ExecutionScheduler {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface ExecutionOrchestratorOptions<TTarget> {
  backend: ExecutionBackend<TTarget>;
  logger?: ExecutionLogger;
  scheduler?: ExecutionScheduler;
  isConnectionBrokenError?: (error: unknown) => boolean;
  isSafeToRetrySql?: (sql: string) => boolean;
}

export interface ExecutionHandle {
  readonly executionId: string;
  readonly status: ExecutionPhase | ExecutionTerminalStatus;
  readonly settled: Promise<ExecutionSummary>;
  cancel(reason?: string): Promise<void>;
  detachObserver(): void;
}

export interface ExecutionSnapshot {
  activeExecutions: number;
  executionIds: readonly string[];
  phases: Readonly<Record<ExecutionPhase, number>>;
}

type ExecutionEventInput = {
  [K in ExecutionEvent['type']]: Omit<Extract<ExecutionEvent, { type: K }>, 'sequence'>;
}[ExecutionEvent['type']];

const DEFAULT_SCHEDULER: ExecutionScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: handle => clearTimeout(handle),
};

const NOOP_OBSERVER: ExecutionObserver = {
  onEvent: () => undefined,
};

export class ExecutionCancelledError extends Error {
  public readonly code = 'EXECUTION_CANCELLED';

  public constructor(message = 'Query cancelled.') {
    super(message);
    this.name = 'ExecutionCancelledError';
  }
}

export class ExecutionTimeoutError extends Error {
  public readonly code = 'EXECUTION_TIMEOUT';

  public constructor(message = 'Query execution timed out.') {
    super(message);
    this.name = 'ExecutionTimeoutError';
  }
}

export class ExecutionDisposedError extends Error {
  public readonly code = 'EXECUTION_RUNTIME_DISPOSED';

  public constructor() {
    super('The execution runtime has been disposed.');
    this.name = 'ExecutionDisposedError';
  }
}

export interface ExecutionBackendFailureMetadata {
  totalRows?: number;
  limitReached?: boolean;
  rowsAffected?: number;
}

/** Error carrying partial-result metadata returned alongside an adapter error. */
export class ExecutionBackendError extends Error {
  public readonly metadata: ExecutionBackendFailureMetadata;

  public constructor(
    message: string,
    cause: unknown,
    metadata: ExecutionBackendFailureMetadata = {},
  ) {
    super(message, { cause });
    this.name = 'ExecutionBackendError';
    this.metadata = metadata;
  }
}

interface InternalExecution<TTarget> {
  readonly request: ExecutionRequest<TTarget>;
  observer: ExecutionObserver;
  readonly resources: ExecutionResourceScope;
  readonly settled: Promise<ExecutionSummary>;
  resolveSettled: (summary: ExecutionSummary) => void;
  phase: ExecutionPhase;
  sequence: number;
  eventQueue: Promise<void>;
  observerError?: unknown;
  command?: DatabaseQueryCommand;
  commandCancel?: Promise<void>;
  cancelRequested: boolean;
  cancelReason?: string;
  timedOut: boolean;
  terminal?: ExecutionTerminalStatus;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  statementResults: ExecutionStatementSummary[];
  hadFailure: boolean;
  attempt: number;
  totalRows: number;
  limitReached: boolean;
  disposedObserver: boolean;
}

function errorMessage(error: unknown): string {
  if (error instanceof ExecutionBackendError) return error.message;
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      if (current.message.trim()) messages.push(current.message);
      current = current.cause;
      continue;
    }
    if (typeof current === 'object') {
      const candidate = current as { message?: unknown; cause?: unknown };
      if (typeof candidate.message === 'string' && candidate.message.trim()) messages.push(candidate.message);
      current = candidate.cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  return messages.join(' ') || 'Query execution failed.';
}

function hasErrorCode(error: unknown, codes: readonly string[]): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error && codes.includes(current.name.toUpperCase())) return true;
    if (typeof current === 'object') {
      const candidate = current as { code?: unknown; name?: unknown; cause?: unknown };
      const code = String(candidate.code ?? '').toUpperCase();
      const name = String(candidate.name ?? '').toUpperCase();
      if (codes.includes(code) || codes.includes(name)) return true;
      current = candidate.cause;
    } else {
      break;
    }
  }
  return false;
}

function defaultIsCancellationError(error: unknown): boolean {
  if (hasErrorCode(error, ['ABORTERROR', 'ABORT_ERR', 'ERR_CANCELED', 'ERR_ABORTED', 'CANCELED', 'CANCELLED', 'ECANCELED', 'QUERY_CANCELED', 'QUERY_CANCELLED'])) return true;
  return /(?:query|statement|command|operation|request|execution)?\s*(?:was\s+)?cancel(?:led|ed)|aborted|aborterror/i.test(errorMessage(error));
}

export function isConnectionBrokenError(error: unknown): boolean {
  return hasErrorCode(error, ['ECONNRESET', 'EPIPE', 'ERR_SOCKET_CLOSED', 'ERR_SOCKET_DESTROYED'])
    || /socket\s+(?:closed|destroyed)|connection\s+(?:reset|closed|is\s+closed)|econnreset|epipe|broken\s+pipe/i.test(errorMessage(error));
}

function failureFrom(error: unknown, kind?: ExecutionFailure['kind']): ExecutionFailure {
  return {
    message: errorMessage(error),
    cause: error,
    ...(kind === undefined ? {} : { kind }),
  };
}

function statementContext<TTarget>(
  record: InternalExecution<TTarget>,
  statementIndex: number,
  attempt: number,
): ExecutionContext & { statementIndex: number } {
  return {
    executionId: record.request.executionId,
    sourceKey: record.request.sourceKey,
    statementIndex,
    statementCount: record.request.statements.length,
    attempt,
  };
}

function executionContext<TTarget>(
  record: InternalExecution<TTarget>,
  attempt: number,
): ExecutionContext {
  return {
    executionId: record.request.executionId,
    sourceKey: record.request.sourceKey,
    statementCount: record.request.statements.length,
    attempt,
  };
}

function validateRequest<TTarget>(request: ExecutionRequest<TTarget>): void {
  if (!request.executionId.trim()) throw new Error('Execution requires an executionId.');
  if (!request.sourceKey.trim()) throw new Error('Execution requires a sourceKey.');
  if (request.statements.length === 0) throw new Error('Execution requires at least one statement.');
  if (!Number.isFinite(request.maxRows) || request.maxRows < 1) throw new Error('Execution maxRows must be a positive number.');
  if (!Number.isFinite(request.timeoutSeconds) || request.timeoutSeconds < 0) throw new Error('Execution timeoutSeconds must be zero or positive.');
  request.statements.forEach((statement, expectedIndex) => {
    if (statement.index !== expectedIndex) throw new Error('Execution statements must have contiguous indexes.');
    if (!statement.sql.trim()) throw new Error(`Execution statement ${expectedIndex + 1} is empty.`);
  });
}

/**
 * Instance-owned orchestration for single, batch, and streamed execution.
 * Database-specific runtimes remain behind `ExecutionBackend`; this class
 * owns ordering, cancellation, retry decisions, and terminal state.
 */
export class ExecutionOrchestrator<TTarget> {
  private readonly executions = new Map<string, InternalExecution<TTarget>>();
  private readonly backend: ExecutionBackend<TTarget>;
  private readonly logger: ExecutionLogger;
  private readonly scheduler: ExecutionScheduler;
  private readonly connectionBroken: (error: unknown) => boolean;
  private readonly safeToRetry: (sql: string) => boolean;
  private disposed = false;
  private disposal?: Promise<void>;

  public constructor(options: ExecutionOrchestratorOptions<TTarget>) {
    this.backend = options.backend;
    this.logger = options.logger ?? {};
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    this.connectionBroken = options.isConnectionBrokenError
      ?? (options.backend.isConnectionBrokenError
        ? options.backend.isConnectionBrokenError.bind(options.backend)
        : isConnectionBrokenError);
    this.safeToRetry = options.isSafeToRetrySql
      ?? (options.backend.isSafeToRetrySql
        ? options.backend.isSafeToRetrySql.bind(options.backend)
        : (() => false));
  }

  public start(
    request: ExecutionRequest<TTarget>,
    observer: ExecutionObserver = NOOP_OBSERVER,
  ): ExecutionHandle {
    validateRequest(request);
    if (this.disposed) throw new ExecutionDisposedError();
    if (this.executions.has(request.executionId)) {
      throw new Error(`Execution ${request.executionId} is already active.`);
    }

    let resolveSettled!: (summary: ExecutionSummary) => void;
    const settled = new Promise<ExecutionSummary>(resolve => { resolveSettled = resolve; });
    const record: InternalExecution<TTarget> = {
      request,
      observer,
      resources: new ExecutionResourceScope(),
      settled,
      resolveSettled,
      phase: 'preparing',
      sequence: 0,
      eventQueue: Promise.resolve(),
      cancelRequested: false,
      timedOut: false,
      statementResults: [],
      hadFailure: false,
      attempt: 0,
      totalRows: 0,
      limitReached: false,
      disposedObserver: false,
    };
    this.executions.set(request.executionId, record);
    this.installTimeout(record);
    void this.run(record);

    return {
      executionId: request.executionId,
      get status(): ExecutionPhase | ExecutionTerminalStatus { return record.terminal ?? record.phase; },
      settled,
      cancel: reason => this.cancelRecord(record, reason),
      detachObserver: () => {
        record.disposedObserver = true;
        record.observer = NOOP_OBSERVER;
      },
    };
  }

  public snapshot(): ExecutionSnapshot {
    const phases: Record<ExecutionPhase, number> = {
      preparing: 0,
      running: 0,
      retrying: 0,
      cancelling: 0,
    };
    for (const record of this.executions.values()) phases[record.phase] += 1;
    return {
      activeExecutions: this.executions.size,
      executionIds: [...this.executions.keys()],
      phases,
    };
  }

  public dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    const active = [...this.executions.values()];
    this.disposal = (async () => {
      await Promise.allSettled(active.map(record => this.cancelRecord(record, 'Execution runtime disposed.')));
      await Promise.allSettled(active.map(record => record.settled));
      await this.backend.closeAll?.();
    })();
    return this.disposal;
  }

  private installTimeout(record: InternalExecution<TTarget>): void {
    if (record.request.timeoutSeconds <= 0) return;
    record.timeoutHandle = this.scheduler.setTimeout(() => {
      void this.timeoutRecord(record);
    }, record.request.timeoutSeconds * 1000);
  }

  private clearTimeout(record: InternalExecution<TTarget>): void {
    if (record.timeoutHandle === undefined) return;
    this.scheduler.clearTimeout(record.timeoutHandle);
    record.timeoutHandle = undefined;
  }

  private async timeoutRecord(record: InternalExecution<TTarget>): Promise<void> {
    if (record.terminal) return;
    record.timedOut = true;
    await this.cancelRecord(record, 'Query execution timed out.');
  }

  private async cancelRecord(record: InternalExecution<TTarget>, reason?: string): Promise<void> {
    if (record.terminal) return;
    record.cancelRequested = true;
    record.cancelReason ??= reason;
    record.phase = 'cancelling';
    if (record.commandCancel) {
      await record.commandCancel;
      return;
    }
    if (!record.command) {
      if (this.backend.cancel) {
        record.commandCancel = Promise.resolve()
          .then(() => this.backend.cancel?.(record.request.target, record.request, reason))
          .catch(error => {
            this.logger.warn?.(`[Execution ${record.request.executionId}] backend cancellation failed.`, error);
          });
        await record.commandCancel;
      }
      return;
    }
    record.commandCancel = Promise.resolve()
      .then(() => record.command?.cancel())
      .catch(error => {
        this.logger.warn?.(`[Execution ${record.request.executionId}] command cancellation failed.`, error);
      });
    await record.commandCancel;
  }

  private enqueue(record: InternalExecution<TTarget>, event: ExecutionEventInput): void {
    const sequenced = { ...event, sequence: ++record.sequence } as ExecutionEvent;
    record.eventQueue = record.eventQueue.then(async () => {
      if (record.disposedObserver) return;
      try {
        await record.observer.onEvent(sequenced);
      } catch (error: unknown) {
        record.observerError ??= error;
        this.logger.warn?.(`[Execution ${record.request.executionId}] observer failed.`, error);
      }
    });
  }

  private async drainEvents(record: InternalExecution<TTarget>): Promise<void> {
    await record.eventQueue;
    if (record.observerError !== undefined) {
      throw new Error('Execution observer failed.', { cause: record.observerError });
    }
  }

  private async run(record: InternalExecution<TTarget>): Promise<void> {
    let status: ExecutionTerminalStatus = 'success';
    let failure: ExecutionFailure | undefined;
    const attempt = 0;
    try {
      record.phase = 'running';
      this.enqueue(record, {
        type: 'execution-started',
        context: executionContext(record, attempt),
      });
      await this.drainEvents(record);

      for (const statement of record.request.statements) {
        if (record.cancelRequested) {
          status = record.timedOut ? 'error' : 'cancelled';
          failure = record.timedOut
            ? failureFrom(new ExecutionTimeoutError(record.cancelReason), 'timeout')
            : failureFrom(new ExecutionCancelledError(record.cancelReason), 'cancellation');
          break;
        }
        const result = await this.runStatement(record, statement);
        if (result.status === 'success') {
          record.statementResults.push(result.summary);
          record.totalRows += result.summary.totalRows;
          record.limitReached = record.limitReached || result.summary.limitReached;
          continue;
        }

        if (result.status === 'cancelled') {
          record.totalRows += result.summary.totalRows;
          record.limitReached = record.limitReached || result.summary.limitReached;
          this.enqueue(record, {
            type: 'statement-failed',
            context: statementContext(record, statement.index, result.attempt),
            summary: result.summary,
            failure: failureFrom(
              result.error ?? new ExecutionCancelledError(record.cancelReason),
              record.timedOut ? 'timeout' : 'cancellation',
            ),
          });
          await this.drainEvents(record);
          status = record.timedOut ? 'error' : 'cancelled';
          failure = record.timedOut
            ? failureFrom(result.error ?? new ExecutionTimeoutError(record.cancelReason), 'timeout')
            : failureFrom(result.error ?? new ExecutionCancelledError(record.cancelReason), 'cancellation');
          break;
        }

        const statementFailure = failureFrom(result.error ?? new Error('Query execution failed.'), result.errorKind);
        record.totalRows += result.summary.totalRows;
        record.limitReached = record.limitReached || result.summary.limitReached;
        if (record.request.continueOnError) {
          record.hadFailure = true;
          failure ??= statementFailure;
          this.enqueue(record, {
            type: 'statement-failed',
            context: statementContext(record, statement.index, result.attempt),
            summary: result.summary,
            failure: statementFailure,
          });
          await this.drainEvents(record);
          continue;
        }
        this.enqueue(record, {
          type: 'statement-failed',
          context: statementContext(record, statement.index, result.attempt),
          summary: result.summary,
          failure: statementFailure,
        });
        await this.drainEvents(record);
        status = 'error';
        failure = statementFailure;
        break;
      }
      if (status === 'success' && record.hadFailure) {
        status = 'error';
        failure = failure ?? failureFrom(new Error('One or more statements failed.'), 'backend');
      }
    } catch (error: unknown) {
      status = record.timedOut ? 'error' : record.cancelRequested || defaultIsCancellationError(error) ? 'cancelled' : 'error';
      failure = record.timedOut
        ? failureFrom(error, 'timeout')
        : status === 'cancelled'
          ? failureFrom(error, 'cancellation')
          : failureFrom(error, error instanceof Error && error.message === 'Execution observer failed.' ? 'observer' : 'backend');
    }

    await this.finish(record, status, failure);
  }

  private async runStatement(
    record: InternalExecution<TTarget>,
    statement: ExecutionStatement,
  ): Promise<{
    status: 'success' | 'error' | 'cancelled';
    summary: ExecutionStatementSummary;
    error?: unknown;
    errorKind?: ExecutionFailure['kind'];
    attempt: number;
  }> {
    let attempt = 0;
    let lastError: unknown;
    let rowsDelivered = false;
    let latestTotalRows = 0;
    let latestResult: DatabaseQueryResult = { totalRows: 0, limitReached: false };

    while (true) {
      if (this.backend.isCancellationRequested?.(record.request.target)) {
        return {
          status: 'cancelled',
          summary: {
            statementIndex: statement.index,
            totalRows: latestTotalRows,
            limitReached: latestResult.limitReached,
            ...(latestResult.rowsAffected === undefined ? {} : { rowsAffected: latestResult.rowsAffected }),
          },
          error: new ExecutionCancelledError(record.cancelReason),
          errorKind: 'cancellation',
          attempt,
        };
      }
      if (record.cancelRequested) {
        return {
          status: 'cancelled',
          summary: { statementIndex: statement.index, totalRows: latestTotalRows, limitReached: false },
          error: record.timedOut ? new ExecutionTimeoutError(record.cancelReason) : new ExecutionCancelledError(record.cancelReason),
          attempt,
        };
      }

      record.phase = 'running';
      if (attempt === 0) {
        this.enqueue(record, {
          type: 'statement-started',
          context: statementContext(record, statement.index, attempt),
          statement,
        });
        await this.drainEvents(record);
        if (this.backend.isCancellationRequested?.(record.request.target)) {
          return {
            status: 'cancelled',
            summary: {
              statementIndex: statement.index,
              totalRows: latestTotalRows,
              limitReached: latestResult.limitReached,
              ...(latestResult.rowsAffected === undefined ? {} : { rowsAffected: latestResult.rowsAffected }),
            },
            error: new ExecutionCancelledError(record.cancelReason),
            errorKind: 'cancellation',
            attempt,
          };
        }
      }

      record.command = undefined;
      record.commandCancel = undefined;
      record.attempt = attempt;
      let callbacksOpen = true;
      const callbacks: DatabaseQueryCallbacks = {
        onCommand: command => {
          if (!callbacksOpen || record.terminal) {
            void Promise.resolve().then(() => command.cancel()).catch(error => {
              this.logger.warn?.(`[Execution ${record.request.executionId}] late command cleanup failed.`, error);
            });
            return;
          }
          record.command = command;
          if (record.cancelRequested && !record.commandCancel) {
            record.commandCancel = Promise.resolve()
              .then(() => command.cancel())
              .catch(error => {
                this.logger.warn?.(`[Execution ${record.request.executionId}] late command cancellation failed.`, error);
              });
          }
        },
        onColumns: columns => {
          if (!callbacksOpen || record.cancelRequested || record.terminal) return;
          this.enqueue(record, {
            type: 'columns',
            context: statementContext(record, statement.index, attempt),
            columns,
          });
        },
        onRows: (rows, totalRows) => {
          if (!callbacksOpen || record.cancelRequested || record.terminal) return;
          rowsDelivered = rowsDelivered || rows.length > 0;
          latestTotalRows = Math.max(latestTotalRows, totalRows);
          const context = statementContext(record as InternalExecution<unknown>, statement.index, attempt);
          this.enqueue(record, {
            type: 'rows',
            context,
            rows,
            totalRows,
          });
          this.enqueue(record, {
            type: 'progress',
            context,
            totalRows,
          });
        },
      };

      try {
        const sql = statement.expandedSql ?? statement.sql;
        latestResult = await this.backend.execute(record.request.target, sql, {
          maxRows: record.request.maxRows,
          timeoutSeconds: record.request.timeoutSeconds,
          readOnly: record.request.readOnly,
          database: record.request.database,
        }, callbacks, record.resources, {
          request: record.request,
          statement,
          context: statementContext(record, statement.index, attempt),
          delivery: record.request.delivery,
        });
        callbacksOpen = false;
        await this.drainEvents(record);
        if (this.backend.isCancellationRequested?.(record.request.target)) {
          return {
            status: 'cancelled',
            summary: {
              statementIndex: statement.index,
              totalRows: latestResult.totalRows,
              limitReached: latestResult.limitReached,
              ...(latestResult.rowsAffected === undefined ? {} : { rowsAffected: latestResult.rowsAffected }),
            },
            error: new ExecutionCancelledError(record.cancelReason),
            errorKind: 'cancellation',
            attempt,
          };
        }
        if (record.cancelRequested) {
          return {
            status: 'cancelled',
            summary: { statementIndex: statement.index, totalRows: latestResult.totalRows, limitReached: latestResult.limitReached, rowsAffected: latestResult.rowsAffected },
            error: record.timedOut ? new ExecutionTimeoutError(record.cancelReason) : new ExecutionCancelledError(record.cancelReason),
            attempt,
          };
        }
        const summary: ExecutionStatementSummary = {
          statementIndex: statement.index,
          totalRows: latestResult.totalRows,
          limitReached: latestResult.limitReached,
          ...(latestResult.rowsAffected === undefined ? {} : { rowsAffected: latestResult.rowsAffected }),
        };
        this.enqueue(record, {
          type: 'statement-completed',
          context: statementContext(record, statement.index, attempt),
          summary,
        });
        await this.drainEvents(record);
        return { status: 'success', summary, attempt };
      } catch (error: unknown) {
        lastError = error;
        if (error instanceof ExecutionBackendError) {
          latestTotalRows = Math.max(latestTotalRows, error.metadata.totalRows ?? 0);
          latestResult = {
            totalRows: Math.max(latestResult.totalRows, error.metadata.totalRows ?? 0),
            limitReached: error.metadata.limitReached ?? latestResult.limitReached,
            ...(error.metadata.rowsAffected === undefined
              ? (latestResult.rowsAffected === undefined ? {} : { rowsAffected: latestResult.rowsAffected })
              : { rowsAffected: error.metadata.rowsAffected }),
          };
        }
        if (record.cancelRequested || defaultIsCancellationError(error)) {
          return {
            status: 'cancelled',
            summary: {
              statementIndex: statement.index,
              totalRows: latestResult.totalRows || latestTotalRows,
              limitReached: latestResult.limitReached,
              ...(latestResult.rowsAffected === undefined ? {} : { rowsAffected: latestResult.rowsAffected }),
            },
            error: record.timedOut ? new ExecutionTimeoutError(record.cancelReason) : error,
            errorKind: record.timedOut ? 'timeout' : 'cancellation',
            attempt,
          };
        }

        const canRetry = attempt === 0
          && record.request.connectionMode === 'persistent'
          && record.request.retryPolicy === 'safe-read-only-on-broken-connection'
          && !rowsDelivered
          && this.connectionBroken(error)
          && this.safeToRetry(statement.originalSql ?? statement.sql)
          && this.safeToRetry(statement.expandedSql ?? statement.sql);
        if (!canRetry) break;

        record.phase = 'retrying';
        this.enqueue(record, {
          type: 'retrying',
          context: statementContext(record, statement.index, attempt),
          retry: { attempt: 1, reason: 'broken-connection' },
        });
        await this.drainEvents(record);
        if (record.cancelRequested) {
          return {
            status: 'cancelled',
            summary: { statementIndex: statement.index, totalRows: latestTotalRows, limitReached: false },
            error: new ExecutionCancelledError(record.cancelReason),
            errorKind: 'cancellation',
            attempt,
          };
        }
        try {
          if (this.backend.reconnect) await this.backend.reconnect(record.request.target);
          else if (this.backend.closeTarget) await this.backend.closeTarget(record.request.target);
        } catch (reconnectError: unknown) {
          return { status: 'error', summary: { statementIndex: statement.index, totalRows: latestTotalRows, limitReached: false }, error: reconnectError, errorKind: 'backend', attempt };
        }
        if (this.backend.isCancellationRequested?.(record.request.target)) {
          return {
            status: 'cancelled',
            summary: {
              statementIndex: statement.index,
              totalRows: latestResult.totalRows || latestTotalRows,
              limitReached: latestResult.limitReached,
              ...(latestResult.rowsAffected === undefined ? {} : { rowsAffected: latestResult.rowsAffected }),
            },
            error: new ExecutionCancelledError(record.cancelReason),
            errorKind: 'cancellation',
            attempt,
          };
        }
        attempt = 1;
        continue;
      } finally {
        callbacksOpen = false;
        record.command = undefined;
        record.commandCancel = undefined;
      }
    }

    return {
      status: 'error',
      summary: {
        statementIndex: statement.index,
        totalRows: latestResult.totalRows || latestTotalRows,
        limitReached: latestResult.limitReached,
        ...(latestResult.rowsAffected === undefined ? {} : { rowsAffected: latestResult.rowsAffected }),
      },
      error: lastError,
      errorKind: 'backend',
      attempt,
    };
  }

  private async finish(
    record: InternalExecution<TTarget>,
    status: ExecutionTerminalStatus,
    failure?: ExecutionFailure,
  ): Promise<void> {
    if (record.terminal) return;
    this.clearTimeout(record);
    const cleanupErrors: unknown[] = [...await record.resources.dispose()];
    if (this.backend.cleanup) {
      try {
        await this.backend.cleanup(record.request.target, record.request);
      } catch (error: unknown) {
        cleanupErrors.push(error);
      }
    }
    if (status === 'success' && cleanupErrors.length > 0) {
      status = 'error';
      failure = failureFrom(new Error('Execution cleanup failed.', { cause: cleanupErrors[0] }), 'cleanup');
    }
    record.terminal = status;
    if (status === 'error' && failure === undefined) failure = failureFrom(new Error('Query execution failed.'), 'backend');
    const summary: ExecutionSummary = {
      executionId: record.request.executionId,
      status,
      statements: [...record.statementResults],
      totalRows: record.totalRows,
      limitReached: record.limitReached,
      ...(failure === undefined ? {} : { error: failure }),
      ...(cleanupErrors.length === 0 ? {} : { cleanupErrors }),
    };
    this.enqueue(record, {
      type: 'execution-terminal',
      context: executionContext(record, record.attempt),
      summary,
    });
    this.enqueue(record, {
      type: 'batch-completed',
      context: executionContext(record, record.attempt),
      summary,
    });
    try {
      await this.drainEvents(record);
    } catch (observerError: unknown) {
      this.logger.error?.(`[Execution ${record.request.executionId}] terminal observer failed.`, observerError);
    } finally {
      this.executions.delete(record.request.executionId);
      record.resolveSettled(summary);
    }
  }
}

export function createExecutionId(prefix = 'execution'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Factory seam used by product composition roots to own one runtime instance. */
export function createExecutionOrchestrator<TTarget>(
  options: ExecutionOrchestratorOptions<TTarget>,
): ExecutionOrchestrator<TTarget> {
  return new ExecutionOrchestrator(options);
}
