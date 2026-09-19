import type {
  DatabaseQueryResult,
  ExecutionEvent,
  ExecutionRequest,
} from '@justybase/contracts';
import {
  ExecutionBackendError,
  ExecutionOrchestrator,
  extractDatabaseErrorDetails,
  hasSqlStateCode,
  isConnectionBrokenError,
  isConnectionExceptionSqlState,
  isDatabaseSqlError,
  MAX_ERROR_DETAIL_LENGTH,
  type ExecutionBackend,
} from '../src';

/** Mirrors the Netezza driver's NzDatabaseError shape without importing it. */
function backendError(overrides: Record<string, unknown> = {}): Error {
  const error = new Error('relation "MISSING_TABLE" does not exist') as Error & Record<string, unknown>;
  error.name = 'NzDatabaseError';
  error.severity = 'ERROR';
  error.code = '42P01';
  error.dbMessage = 'relation "MISSING_TABLE" does not exist';
  error.detail = 'The referenced relation was not found in the current database.';
  error.hint = 'Check the table name and schema search path.';
  error.diagnostics = { S: 'ERROR', C: '42P01', M: 'relation does not exist' };
  error.raw = 'SERROR\0C42P01\0Mrelation does not exist\0\0';
  return Object.assign(error, overrides);
}

describe('extractDatabaseErrorDetails', () => {
  it('extracts SQLSTATE, severity, detail, hint and extra diagnostics', () => {
    expect(extractDatabaseErrorDetails(backendError())).toEqual({
      code: '42P01',
      severity: 'ERROR',
      detail: 'The referenced relation was not found in the current database.',
      hint: 'Check the table name and schema search path.',
      diagnostics: { S: 'ERROR', C: '42P01', M: 'relation does not exist' },
    });
  });

  it('never carries the driver raw payload', () => {
    const details = extractDatabaseErrorDetails(backendError());
    expect(details).not.toHaveProperty('raw');
    expect(JSON.stringify(details)).not.toContain('SERROR');
  });

  it('drops credential-looking diagnostic keys', () => {
    const error = backendError({ diagnostics: { M: 'safe', password: 'hunter2', ApiKey: 'k', auth_token: 't' } });
    expect(extractDatabaseErrorDetails(error)?.diagnostics).toEqual({ M: 'safe' });
  });

  it('bounds long diagnostic values', () => {
    const error = backendError({ detail: 'x'.repeat(MAX_ERROR_DETAIL_LENGTH + 500) });
    expect(extractDatabaseErrorDetails(error)?.detail).toHaveLength(MAX_ERROR_DETAIL_LENGTH);
  });

  it('walks several cause levels', () => {
    const wrapped = new Error('Executed SQL failed', {
      cause: new Error('Batch statement failed', { cause: backendError() }),
    });
    expect(extractDatabaseErrorDetails(wrapped)?.code).toBe('42P01');
  });

  it('finds diagnostics through ExecutionBackendError', () => {
    const failure = new ExecutionBackendError('Query failed.', backendError(), { totalRows: 3 });
    expect(extractDatabaseErrorDetails(failure)).toMatchObject({ code: '42P01', severity: 'ERROR' });
  });

  it('finds diagnostics in an Adapter-style error chain built by an ExecutedSqlError', () => {
    class ExecutedSqlError extends Error {
      public constructor(error: unknown) {
        super(error instanceof Error ? error.message : String(error), { cause: error });
        this.name = 'ExecutedSqlError';
      }
    }
    const failure = new ExecutionBackendError('Query failed.', new ExecutedSqlError(backendError()));
    expect(extractDatabaseErrorDetails(failure)?.hint).toBe('Check the table name and schema search path.');
  });

  it('reports a handshake/authentication failure as a database error', () => {
    const authError = Object.assign(new Error('password authentication failed for user "dw"'), {
      name: 'NzDatabaseError',
      severity: 'FATAL',
      code: '28P01',
    });
    expect(extractDatabaseErrorDetails(authError)).toEqual({ code: '28P01', severity: 'FATAL' });
    expect(isDatabaseSqlError(authError)).toBe(true);
    expect(isConnectionExceptionSqlState(authError)).toBe(false);
  });

  it('returns undefined for a legacy message-only error', () => {
    expect(extractDatabaseErrorDetails(new Error('Something went wrong'))).toBeUndefined();
    expect(extractDatabaseErrorDetails(undefined)).toBeUndefined();
    expect(extractDatabaseErrorDetails('plain string')).toBeUndefined();
  });

  it('does not confuse transport codes or product codes with SQLSTATE', () => {
    const socket = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(extractDatabaseErrorDetails(socket)).toBeUndefined();

    const cancelled = Object.assign(new Error('Query cancelled.'), { code: 'EXECUTION_CANCELLED' });
    expect(extractDatabaseErrorDetails(cancelled)).toBeUndefined();
    expect(hasSqlStateCode(cancelled)).toBe(false);
  });

  it('accepts a non-SQLSTATE code only from a structurally backend error', () => {
    const odd = Object.assign(new Error('maintenance in progress'), { code: 'NZ-1234', severity: 'ERROR' });
    expect(extractDatabaseErrorDetails(odd)).toEqual({ code: 'NZ-1234', severity: 'ERROR' });
    // A vendor code is not a SQLSTATE, so callers that specifically need a
    // SQLSTATE must not treat it as one.
    expect(hasSqlStateCode(odd)).toBe(false);
    expect(isConnectionExceptionSqlState(odd)).toBe(false);
  });

  it('ignores detail and hint on an error without a strong backend marker', () => {
    // `detail`/`hint` alone are not proof of a database error. Accepting them
    // would suppress reconnect/replay for an unrelated transport failure.
    const unrelated = Object.assign(new Error('socket closed'), {
      detail: 'internal diagnostic',
      hint: 'retry later',
    });
    expect(extractDatabaseErrorDetails(unrelated)).toBeUndefined();
    expect(isDatabaseSqlError(unrelated)).toBe(false);
  });

  it('propagates an authentication failure found behind a container error', () => {
    const container = Object.assign(new Error('Connection failed.'), {
      cause: Object.assign(new Error('password authentication failed for user "dw"'), {
        severity: 'FATAL',
        code: '28P01',
        dbMessage: 'password authentication failed for user "dw"',
      }),
    });
    expect(extractDatabaseErrorDetails(container)).toMatchObject({ code: '28P01', severity: 'FATAL' });
    expect(hasSqlStateCode(container)).toBe(true);
  });

  it('terminates on a self-referencing cause chain', () => {
    const loop = new Error('looping') as Error & { cause?: unknown };
    loop.cause = loop;
    expect(extractDatabaseErrorDetails(loop)).toBeUndefined();
  });
});

describe('orchestrator failure propagation', () => {
  function request(overrides: Partial<ExecutionRequest<string>> = {}): ExecutionRequest<string> {
    return {
      executionId: 'exec-1',
      sourceKey: 'source-1',
      target: 'target',
      statements: [{ index: 0, sql: 'SELECT * FROM MISSING_TABLE' }],
      delivery: 'buffered',
      connectionMode: 'transient',
      maxRows: 100,
      timeoutSeconds: 0,
      readOnly: true,
      retryPolicy: 'disabled',
      continueOnError: false,
      ...overrides,
    };
  }

  function backendThrowing(error: unknown): ExecutionBackend<string> {
    return {
      execute: async (_target, _sql, _options, callbacks): Promise<DatabaseQueryResult> => {
        callbacks.onColumns([]);
        throw new ExecutionBackendError('Query failed.', error);
      },
    };
  }

  async function collect(backend: ExecutionBackend<string>, executionRequest = request()): Promise<ExecutionEvent[]> {
    const events: ExecutionEvent[] = [];
    const handle = new ExecutionOrchestrator<string>({ backend }).start(executionRequest, {
      onEvent: event => { events.push(event); },
    });
    await handle.settled;
    return events;
  }

  it('carries structured diagnostics on the statement failure and terminal summary', async () => {
    const events = await collect(backendThrowing(backendError()));
    const failed = events.find(event => event.type === 'statement-failed');
    expect(failed && failed.type === 'statement-failed' ? failed.failure.details : undefined).toEqual({
      code: '42P01',
      severity: 'ERROR',
      detail: 'The referenced relation was not found in the current database.',
      hint: 'Check the table name and schema search path.',
      diagnostics: { S: 'ERROR', C: '42P01', M: 'relation does not exist' },
    });
    const terminal = events.find(event => event.type === 'execution-terminal');
    const summary = terminal && terminal.type === 'execution-terminal' ? terminal.summary : undefined;
    expect(summary?.status).toBe('error');
    expect(summary?.error?.details?.code).toBe('42P01');
    expect(summary?.error?.cause).toBeInstanceOf(Error);
  });

  it('omits details for a legacy error so old consumers stay unchanged', async () => {
    const events = await collect(backendThrowing(new Error('Something went wrong')));
    const failed = events.find(event => event.type === 'statement-failed');
    expect(failed && failed.type === 'statement-failed' ? failed.failure.details : undefined).toBeUndefined();
    expect(failed && failed.type === 'statement-failed' ? failed.failure.message : undefined).toBe('Query failed.');
  });

  it('does not retry a database failure even for an allow-listed read-only statement', async () => {
    let attempts = 0;
    const backend: ExecutionBackend<string> = {
      execute: async (_target, _sql, _options, callbacks): Promise<DatabaseQueryResult> => {
        attempts += 1;
        callbacks.onColumns([]);
        throw new ExecutionBackendError('Query failed.', backendError());
      },
      isSafeToRetrySql: () => true,
    };
    await collect(backend, request({ retryPolicy: 'safe-read-only-on-broken-connection' }));
    expect(attempts).toBe(1);
  });
});

describe('transport vs database classification', () => {
  it('never treats a SQL error as a broken connection', () => {
    expect(isConnectionBrokenError(backendError())).toBe(false);
  });

  it('never treats a SQL error as a broken connection even when the message reads like one', () => {
    // A user table name can legitimately contain these words; the structured
    // SQLSTATE must win over the message heuristic.
    const error = backendError({ message: 'connection reset while reading table' });
    expect(isConnectionBrokenError(error)).toBe(false);
  });

  it('keeps SQLSTATE class 08 as a reconnectable connection failure', () => {
    const linkFailure = Object.assign(new Error('server closed the connection unexpectedly'), {
      severity: 'FATAL',
      code: '08S01',
    });
    expect(isConnectionExceptionSqlState(linkFailure)).toBe(true);
    expect(isConnectionBrokenError(linkFailure)).toBe(true);
  });

  it('keeps socket-level detection for errors without diagnostics', () => {
    expect(isConnectionBrokenError(new Error('socket closed'))).toBe(true);
    expect(isConnectionBrokenError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isConnectionBrokenError(new Error('syntax error'))).toBe(false);
  });
});
