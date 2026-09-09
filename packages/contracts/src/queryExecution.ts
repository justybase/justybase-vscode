import type { QueryColumn } from './webApi';

export type Awaitable<T> = T | PromiseLike<T>;

/** A running database command exposed to product-level cancellation controls. */
export interface DatabaseQueryCommand {
  cancel(): Promise<void>;
}

/** Streaming callbacks shared by Node database runtimes and product adapters. */
export interface DatabaseQueryCallbacks {
  onColumns(columns: QueryColumn[]): void;
  onRows(rows: unknown[][], totalRows: number): void;
  onCommand(command: DatabaseQueryCommand): void;
}

/** Product-neutral execution limits and safety context. */
export interface DatabaseQueryOptions {
  maxRows: number;
  timeoutSeconds: number;
  readOnly?: boolean;
  database?: string;
}

/** Summary returned after a streamed database execution completes. */
export interface DatabaseQueryResult {
  totalRows: number;
  limitReached: boolean;
  rowsAffected?: number;
}

/** A logical statement prepared by a product adapter for execution. */
export interface ExecutionStatement {
  index: number;
  sql: string;
  /** SQL before variable/macro expansion, when the product has both forms. */
  originalSql?: string;
  /** Fully expanded SQL used by the database, when it differs from `sql`. */
  expandedSql?: string;
}

export type ExecutionDelivery = 'buffered' | 'streaming';
export type ExecutionConnectionMode = 'persistent' | 'transient';
export type ExecutionRetryPolicy = 'disabled' | 'safe-read-only-on-broken-connection';
export type ExecutionPhase = 'preparing' | 'running' | 'retrying' | 'cancelling';
export type ExecutionTerminalStatus = 'success' | 'error' | 'cancelled';

/** Product-neutral request consumed by the shared execution orchestrator. */
export interface ExecutionRequest<TTarget = unknown> {
  executionId: string;
  sourceKey: string;
  target: TTarget;
  database?: string;
  statements: readonly ExecutionStatement[];
  delivery: ExecutionDelivery;
  connectionMode: ExecutionConnectionMode;
  maxRows: number;
  timeoutSeconds: number;
  readOnly: boolean;
  retryPolicy: ExecutionRetryPolicy;
  continueOnError: boolean;
}

export interface ExecutionContext {
  executionId: string;
  sourceKey: string;
  statementIndex?: number;
  statementCount: number;
  attempt: number;
}

export interface ExecutionRetryingEvent {
  attempt: number;
  reason: 'broken-connection';
}

export interface ExecutionFailure {
  message: string;
  cause: unknown;
  kind?: 'timeout' | 'cancellation' | 'cleanup' | 'backend' | 'observer';
}

export interface ExecutionStatementSummary {
  statementIndex: number;
  totalRows: number;
  limitReached: boolean;
  rowsAffected?: number;
}

export interface ExecutionSummary {
  executionId: string;
  status: ExecutionTerminalStatus;
  statements: readonly ExecutionStatementSummary[];
  totalRows: number;
  limitReached: boolean;
  error?: ExecutionFailure;
  cleanupErrors?: readonly unknown[];
}

export interface ExecutionStartedEvent {
  type: 'execution-started';
  sequence: number;
  context: ExecutionContext;
}

export interface ExecutionStatementStartedEvent {
  type: 'statement-started';
  sequence: number;
  context: ExecutionContext & { statementIndex: number };
  statement: ExecutionStatement;
}

export interface ExecutionColumnsEvent {
  type: 'columns';
  sequence: number;
  context: ExecutionContext & { statementIndex: number };
  columns: QueryColumn[];
}

export interface ExecutionRowsEvent {
  type: 'rows';
  sequence: number;
  context: ExecutionContext & { statementIndex: number };
  rows: unknown[][];
  totalRows: number;
}

export interface ExecutionProgressEvent {
  type: 'progress';
  sequence: number;
  context: ExecutionContext & { statementIndex: number };
  totalRows: number;
}

export interface ExecutionStatementCompletedEvent {
  type: 'statement-completed';
  sequence: number;
  context: ExecutionContext & { statementIndex: number };
  summary: ExecutionStatementSummary;
}

export interface ExecutionStatementFailedEvent {
  type: 'statement-failed';
  sequence: number;
  context: ExecutionContext & { statementIndex: number };
  failure: ExecutionFailure;
  /** Partial progress retained when the statement failed or was cancelled. */
  summary?: ExecutionStatementSummary;
}

export interface ExecutionRetryingEventEnvelope {
  type: 'retrying';
  sequence: number;
  context: ExecutionContext & { statementIndex: number };
  retry: ExecutionRetryingEvent;
}

export interface ExecutionTerminalEvent {
  type: 'execution-terminal';
  sequence: number;
  context: ExecutionContext;
  summary: ExecutionSummary;
}

export interface ExecutionBatchCompletedEvent {
  type: 'batch-completed';
  sequence: number;
  context: ExecutionContext;
  summary: ExecutionSummary;
}

export type ExecutionEvent =
  | ExecutionStartedEvent
  | ExecutionStatementStartedEvent
  | ExecutionColumnsEvent
  | ExecutionRowsEvent
  | ExecutionProgressEvent
  | ExecutionStatementCompletedEvent
  | ExecutionStatementFailedEvent
  | ExecutionRetryingEventEnvelope
  | ExecutionTerminalEvent
  | ExecutionBatchCompletedEvent;
