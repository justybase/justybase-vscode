import path from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import type {
  DatabaseQueryCallbacks,
  DatabaseQueryCommand,
  DatabaseQueryOptions,
  DatabaseQueryResult,
  MetadataColumn,
  MetadataDatabase,
  MetadataObject,
  MetadataSchema,
  QueryColumn,
} from '@justybase/contracts';
import { SqliteSession, type SqliteDatabase } from './session';

export { SqliteSession } from './session';
export type { SqliteDatabase, SqliteSessionOptions } from './session';

const FALLBACK_ROW_LIMIT = 200_000;

export interface SqliteRuntimeTarget {
  connectionId: string;
  /** Absolute, product-authorized path or the special `:memory:` target. */
  databasePath: string;
}

export interface SqliteRuntimeOptions {
  isReadOnlySql(sql: string): boolean;
}

export type SqliteAttachTargetResolver = (requestedPath: string) => string;

export class SqliteRuntimeTargetChangedError extends Error {
  public readonly code = 'SQLITE_RUNTIME_TARGET_CHANGED';

  public constructor(connectionId: string) {
    super(`SQLite connection ${connectionId} changed its database target without being closed.`);
    this.name = 'SqliteRuntimeTargetChangedError';
  }
}

interface SqliteWorkerData {
  databasePath: string;
  sql: string;
  maxRows: number;
  attachments: Array<{ name: string; file: string }>;
}

interface SqliteWorkerColumnsMessage { type: 'columns'; columns: QueryColumn[]; }
interface SqliteWorkerRowsMessage { type: 'rows'; rows: unknown[][]; totalRows: number; }
interface SqliteWorkerDoneMessage { type: 'done'; totalRows: number; limitReached: boolean; }
interface SqliteWorkerErrorMessage { type: 'error'; message: string; }
type SqliteWorkerMessage = SqliteWorkerColumnsMessage | SqliteWorkerRowsMessage | SqliteWorkerDoneMessage | SqliteWorkerErrorMessage;

interface RuntimeSqliteSession {
  readonly connectionId: string;
  readonly databasePath: string;
  readonly native: SqliteSession;
  readonly operations: Set<ActiveSqliteOperation>;
  closing?: Promise<void>;
}

const SQLITE_READ_WORKER = `
  const { parentPort, workerData } = require('node:worker_threads');
  const { DatabaseSync } = require('node:sqlite');
  function normalize(value) {
    if (typeof value === 'bigint') return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
    if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
    return value;
  }
  try {
    const db = new DatabaseSync(workerData.databasePath, { readOnly: true, readBigInts: true });
    for (const attachment of workerData.attachments) {
      db.exec('ATTACH DATABASE ' + JSON.stringify(attachment.file) + ' AS "' + attachment.name.replace(/"/g, '""') + '"');
    }
    const statement = db.prepare(workerData.sql);
    statement.setReturnArrays(true);
    const columns = statement.columns().map(column => ({ name: column.name, type: column.type ?? undefined }));
    parentPort.postMessage({ type: 'columns', columns });
    const rows = [];
    let totalRows = 0;
    let limitReached = false;
    for (const row of statement.iterate()) {
      if (totalRows >= workerData.maxRows) { limitReached = true; break; }
      rows.push(row.map(normalize));
      totalRows += 1;
      if (rows.length >= 200) {
        parentPort.postMessage({ type: 'rows', rows: rows.splice(0, rows.length), totalRows });
      }
    }
    if (rows.length > 0) parentPort.postMessage({ type: 'rows', rows, totalRows });
    parentPort.postMessage({ type: 'done', totalRows, limitReached });
    db.close();
  } catch (error) {
    parentPort.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
`;

class ActiveSqliteOperation implements DatabaseQueryCommand {
  private cancelled = false;
  private cancelAction?: () => Promise<void>;
  private cancellation?: Promise<void>;
  private finish!: () => void;
  public readonly finished = new Promise<void>(resolve => { this.finish = resolve; });

  public get isCancelled(): boolean {
    return this.cancelled;
  }

  public setCancelAction(action: () => Promise<void>): void {
    this.cancelAction = action;
    if (this.cancelled && !this.cancellation) {
      this.cancellation = Promise.resolve().then(action);
    }
  }

  public async cancel(): Promise<void> {
    this.cancelled = true;
    if (this.cancelAction && !this.cancellation) {
      this.cancellation = Promise.resolve().then(this.cancelAction);
    }
    await this.cancellation;
  }

  public throwIfCancelled(): void {
    if (this.cancelled) throw new Error('Query cancelled.');
  }

  public complete(): void {
    this.finish();
  }
}

function normalizeDatabasePath(databasePath: string): string {
  const trimmed = databasePath.trim();
  if (trimmed === ':memory:') return trimmed;
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error('SQLite runtime requires an absolute, product-authorized database path or :memory:.');
  }
  return path.normalize(trimmed);
}

function rowLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : FALLBACK_ROW_LIMIT;
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return value;
}

function quoteIdentifier(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\u0000')) throw new Error('Invalid SQLite identifier.');
  return `"${trimmed.replace(/"/g, '""')}"`;
}

function sqliteCatalog(database: string | undefined): string {
  return database?.trim() || 'main';
}

function attachedFiles(database: SqliteDatabase): Array<{ name: string; file: string }> {
  const statement = database.prepare('PRAGMA database_list');
  statement.setReturnArrays(true);
  return (statement.all() as unknown as unknown[][]).slice(1).flatMap(row => {
    const name = String(row[1] ?? '');
    const file = String(row[2] ?? '');
    return name && file ? [{ name, file }] : [];
  });
}

function hasInMemoryAttachment(database: SqliteDatabase): boolean {
  const statement = database.prepare('PRAGMA database_list');
  statement.setReturnArrays(true);
  return (statement.all() as unknown as unknown[][]).some(row => {
    const name = String(row[1] ?? '');
    return name !== 'main' && name !== 'temp' && String(row[2] ?? '') === '';
  });
}

function aggregateErrors(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

/**
 * Rewrites a literal SQLite ATTACH target through product-owned authorization.
 * Statements other than ATTACH are returned unchanged.
 */
export function rewriteSqliteAttachTarget(sql: string, resolveTarget: SqliteAttachTargetResolver): string {
  const leadingComments = /^\s*(?:(?:--[^\r\n]*(?:\r\n|\r|\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*/u.exec(sql)?.[0] ?? '';
  const command = sql.slice(leadingComments.length);
  if (!/^ATTACH\b/iu.test(command)) return sql;
  const pattern = /^(\bATTACH(?:\s+DATABASE)?\s+)(['"])(.*?)\2(\s+AS\s+)(['"]?)([A-Za-z_][A-Za-z0-9_]*)\5/iu;
  if (!pattern.test(command)) throw new Error('SQLite ATTACH requires a product-authorized literal database path.');
  const normalizedCommand = command.replace(
    pattern,
    (_full, prefix: string, quote: string, target: string, asClause: string, nameQuote: string, name: string) => {
      const resolved = resolveTarget(target);
      const escaped = quote === "'" ? resolved.replace(/'/g, "''") : resolved.replace(/"/g, '""');
      return `${prefix}${quote}${escaped}${quote}${asClause}${nameQuote}${name}${nameQuote}`;
    },
  );
  return `${leadingComments}${normalizedCommand}`;
}

export class SqliteRuntime {
  private readonly sessions = new Map<string, RuntimeSqliteSession>();
  private closingAll?: Promise<void>;

  public constructor(private readonly options: SqliteRuntimeOptions) {}

  public async execute(
    target: SqliteRuntimeTarget,
    sql: string,
    options: DatabaseQueryOptions,
    callbacks: DatabaseQueryCallbacks,
  ): Promise<DatabaseQueryResult> {
    const readOnlySql = this.options.isReadOnlySql(sql);
    if (options.readOnly && !readOnlySql) throw new Error('This SQLite connection is read-only.');
    const session = this.getSession(target);
    const operation = new ActiveSqliteOperation();
    session.operations.add(operation);
    try {
      callbacks.onCommand(operation);
      operation.throwIfCancelled();
      const maxRows = rowLimit(options.maxRows);
      if (!readOnlySql) {
        const statement = session.native.database.prepare(sql);
        const result = statement.run();
        operation.throwIfCancelled();
        return { totalRows: 0, limitReached: false, rowsAffected: Number(result.changes ?? 0) };
      }
      if (session.databasePath === ':memory:' || hasInMemoryAttachment(session.native.database)) {
        const result = await this.executeMemoryRead(session.native.database, sql, maxRows, callbacks, operation);
        return { ...result, rowsAffected: undefined };
      }
      const result = await this.executeFileRead(
        session.databasePath,
        sql,
        maxRows,
        attachedFiles(session.native.database),
        callbacks,
        operation,
      );
      return { ...result, rowsAffected: undefined };
    } finally {
      session.operations.delete(operation);
      operation.complete();
    }
  }

  public async listDatabases(target: SqliteRuntimeTarget): Promise<MetadataDatabase[]> {
    const database = this.getSession(target).native.database;
    const statement = database.prepare('PRAGMA database_list');
    statement.setReturnArrays(true);
    return (statement.all() as unknown as unknown[][])
      .map(row => ({ name: String(row[1] ?? '') }))
      .filter(row => row.name.length > 0);
  }

  public async listSchemas(target: SqliteRuntimeTarget, database: string): Promise<MetadataSchema[]> {
    const catalogs = await this.listDatabases(target);
    if (!catalogs.some(item => item.name === database)) return [];
    return [{ database, name: database }];
  }

  public async listObjects(target: SqliteRuntimeTarget, database: string, schema?: string): Promise<MetadataObject[]> {
    const catalog = sqliteCatalog(database || schema);
    const source = `${quoteIdentifier(catalog)}.sqlite_master`;
    const statement = this.getSession(target).native.database.prepare(`SELECT name, type, sql FROM ${source} WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`);
    statement.setReturnArrays(true);
    return (statement.all() as unknown as unknown[][]).map(row => {
      const objectType = String(row[1] ?? '').toUpperCase();
      const sourceSql = typeof row[2] === 'string' ? row[2] : undefined;
      return {
        name: String(row[0] ?? ''),
        database: catalog,
        schema: catalog,
        objectType,
        description: sourceSql,
        ...(objectType === 'VIEW' && sourceSql ? { viewSql: sourceSql } : {}),
      };
    });
  }

  public async listColumns(target: SqliteRuntimeTarget, database: string, schema: string, table: string): Promise<MetadataColumn[]> {
    const catalog = sqliteCatalog(database || schema);
    const statement = this.getSession(target).native.database.prepare(`PRAGMA ${quoteIdentifier(catalog)}.table_info(${quoteIdentifier(table)})`);
    statement.setReturnArrays(true);
    return (statement.all() as unknown as unknown[][]).map(row => ({
      name: String(row[1] ?? ''),
      type: String(row[2] ?? ''),
      isPk: Number(row[5] ?? 0) > 0,
    }));
  }

  public async closeConnection(connectionId: string): Promise<void> {
    const session = this.sessions.get(connectionId);
    if (!session) return;
    if (session.closing) return session.closing;
    session.closing = this.closeSession(session);
    return session.closing;
  }

  public async closeAll(): Promise<void> {
    if (this.closingAll) return this.closingAll;
    const closing = (async () => {
      const results = await Promise.allSettled([...this.sessions.keys()].map(connectionId => this.closeConnection(connectionId)));
      aggregateErrors(
        results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason as unknown),
        'Multiple SQLite connections failed to close.',
      );
    })();
    this.closingAll = closing.finally(() => { this.closingAll = undefined; });
    return this.closingAll;
  }

  private getSession(target: SqliteRuntimeTarget): RuntimeSqliteSession {
    if (this.closingAll) throw new Error('SQLite runtime is closing all connections.');
    if (!target.connectionId.trim()) throw new Error('SQLite runtime requires a connection identifier.');
    const databasePath = normalizeDatabasePath(target.databasePath);
    const existing = this.sessions.get(target.connectionId);
    if (existing) {
      if (existing.closing) throw new Error(`SQLite connection ${target.connectionId} is closing.`);
      if (existing.databasePath !== databasePath) throw new SqliteRuntimeTargetChangedError(target.connectionId);
      return existing;
    }
    const session: RuntimeSqliteSession = {
      connectionId: target.connectionId,
      databasePath,
      native: new SqliteSession(databasePath, { readBigInts: true }),
      operations: new Set(),
    };
    this.sessions.set(target.connectionId, session);
    return session;
  }

  private async closeSession(session: RuntimeSqliteSession): Promise<void> {
    const errors: unknown[] = [];
    const operations = [...session.operations];
    const cancellations = await Promise.allSettled(operations.map(operation => operation.cancel()));
    errors.push(...cancellations.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason as unknown));
    await Promise.allSettled(operations.map(operation => operation.finished));
    try {
      session.native.close();
    } catch (error: unknown) {
      errors.push(error);
    } finally {
      if (this.sessions.get(session.connectionId) === session) this.sessions.delete(session.connectionId);
    }
    aggregateErrors(errors, `SQLite connection ${session.connectionId} failed to close cleanly.`);
  }

  private executeFileRead(
    databasePath: string,
    sql: string,
    maxRows: number,
    attachments: Array<{ name: string; file: string }>,
    callbacks: DatabaseQueryCallbacks,
    operation: ActiveSqliteOperation,
  ): Promise<{ totalRows: number; limitReached: boolean }> {
    let worker: Worker | undefined;
    let settled = false;
    let rejectResult: ((reason: unknown) => void) | undefined;
    const result = new Promise<{ totalRows: number; limitReached: boolean }>((resolve, reject) => {
      rejectResult = reject;
      worker = new Worker(SQLITE_READ_WORKER, {
        eval: true,
        workerData: { databasePath, sql, maxRows, attachments } satisfies SqliteWorkerData,
      });
      worker.on('message', (message: SqliteWorkerMessage) => {
        if (settled) return;
        try {
          if (message.type === 'columns') callbacks.onColumns(message.columns);
          else if (message.type === 'rows') callbacks.onRows(message.rows, message.totalRows);
          else if (message.type === 'done') { settled = true; resolve({ totalRows: message.totalRows, limitReached: message.limitReached }); }
          else { settled = true; reject(new Error(message.message)); }
        } catch (error: unknown) {
          settled = true;
          reject(error);
        }
      });
      worker.on('error', error => { if (!settled) { settled = true; reject(error); } });
      worker.on('exit', code => {
        if (!settled) {
          settled = true;
          reject(new Error(`SQLite worker exited before completing with code ${code}.`));
        }
      });
    });
    operation.setCancelAction(async () => {
      if (settled) return;
      settled = true;
      rejectResult?.(new Error('Query cancelled.'));
      await worker?.terminate();
    });
    return result.finally(async () => { if (worker) await worker.terminate(); });
  }

  private async executeMemoryRead(
    database: SqliteDatabase,
    sql: string,
    maxRows: number,
    callbacks: DatabaseQueryCallbacks,
    operation: ActiveSqliteOperation,
  ): Promise<{ totalRows: number; limitReached: boolean }> {
    const statement = database.prepare(sql);
    statement.setReturnArrays(true);
    const columns = statement.columns().map(column => ({
      name: column.name,
      type: column.type ?? undefined,
    } satisfies QueryColumn));
    callbacks.onColumns(columns);
    const rows: unknown[][] = [];
    let totalRows = 0;
    let limitReached = false;
    for (const row of statement.iterate() as Iterable<unknown[]>) {
      operation.throwIfCancelled();
      if (totalRows >= maxRows) { limitReached = true; break; }
      rows.push(row.map(normalizeValue));
      totalRows += 1;
      if (rows.length >= 200) {
        callbacks.onRows(rows.splice(0, rows.length), totalRows);
        await yieldToEventLoop();
        operation.throwIfCancelled();
      }
    }
    if (rows.length > 0) callbacks.onRows(rows, totalRows);
    return { totalRows, limitReached };
  }
}
