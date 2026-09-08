import path from 'node:path';
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
import {
  createDuckDbModuleResolver,
  type DuckDbModuleResolver,
  type DuckDbResultReader,
} from './resolver';
import { DuckDbSession } from './session';

export { DuckDbSession } from './session';
export { createDuckDbModuleResolver, createDuckDbModuleResolver as createModuleResolver } from './resolver';
export type {
  DuckDbConnection,
  DuckDbInstance,
  DuckDbModule,
  DuckDbModuleResolver,
  DuckDbResultReader,
} from './resolver';

export interface DuckDbRuntimeTarget {
  connectionId: string;
  /** Absolute product-authorized path; undefined means an owned in-memory DB. */
  databasePath?: string;
  instanceOwnership?: 'cached-file' | 'owned-memory';
}

export interface DuckDbRuntimeOptions {
  resolver?: DuckDbModuleResolver;
  isReadOnlySql: (sql: string) => boolean;
}

export class DuckDbRuntimeTargetChangedError extends Error {
  public readonly code = 'DUCKDB_RUNTIME_TARGET_CHANGED';

  public constructor(connectionId: string) {
    super(`DuckDB connection ${connectionId} changed its database target without being closed.`);
    this.name = 'DuckDbRuntimeTargetChangedError';
  }
}

interface ActiveOperation extends DatabaseQueryCommand {
  readonly finished: Promise<void>;
  complete(): void;
}

interface RuntimeSession {
  readonly target: DuckDbRuntimeTarget;
  readonly session: DuckDbSession;
  readonly operations: Set<ActiveOperation>;
  closing?: Promise<void>;
}

const FALLBACK_ROW_LIMIT = 200_000;

function rowLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : FALLBACK_ROW_LIMIT;
}

function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return value;
}

function columnsFromReader(reader: DuckDbResultReader): QueryColumn[] {
  return Array.from({ length: reader.columnCount }, (_, index) => ({
    name: reader.columnName(index),
    type: reader.columnType(index).toString(),
  }));
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdentifier(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\u0000')) throw new Error('Invalid DuckDB database name.');
  return `"${trimmed.replace(/"/g, '""')}"`;
}

function attachedTarget(sql: string, resolveTarget: (path: string) => string): string {
  const leadingComments = /^\s*(?:(?:--[^\r\n]*(?:\r\n|\r|\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*/u.exec(sql)?.[0] ?? '';
  const command = sql.slice(leadingComments.length);
  if (!/^ATTACH\b/iu.test(command)) return sql;
  const pattern = /^(\bATTACH(?:\s+DATABASE)?\s+)(['"])(.*?)\2(\s+AS\s+)(['"]?)([A-Za-z_][A-Za-z0-9_]*)\5/iu;
  if (!pattern.test(command)) throw new Error('DuckDB ATTACH requires a sandboxed literal database path.');
  return `${leadingComments}${command.replace(pattern, (_full, prefix: string, quote: string, target: string, asClause: string, nameQuote: string, name: string) => {
    const resolved = target === ':memory:' ? target : resolveTarget(target);
    const escaped = quote === "'" ? resolved.replace(/'/g, "''") : resolved.replace(/"/g, '""');
    return `${prefix}${quote}${escaped}${quote}${asClause}${nameQuote}${name}${nameQuote}`;
  })}`;
}

class RuntimeOperation implements ActiveOperation {
  private completed = false;
  private cancelled = false;
  private cancelAction?: () => Promise<void>;
  private cancellation?: Promise<void>;
  private resolveFinished!: () => void;
  public readonly finished = new Promise<void>(resolve => { this.resolveFinished = resolve; });

  public constructor(private readonly session: DuckDbSession) {}

  public get isCancelled(): boolean { return this.cancelled; }

  public setCancelAction(action: () => Promise<void>): void {
    this.cancelAction = action;
    if (this.cancelled && !this.cancellation) this.cancellation = Promise.resolve().then(action);
  }

  public async cancel(): Promise<void> {
    if (this.completed) return;
    this.cancelled = true;
    if (this.cancelAction && !this.cancellation) this.cancellation = Promise.resolve().then(this.cancelAction);
    await this.cancellation;
  }

  public throwIfCancelled(): void {
    if (this.cancelled) throw new Error('Query cancelled.');
  }

  public complete(): void { this.completed = true; this.cancelAction = undefined; this.resolveFinished(); }

  public interrupt(): void { this.session.interrupt(); }
}

async function withLock<T>(locks: Map<string, Promise<void>>, key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  locks.set(key, current);
  await previous;
  try { return await work(); }
  finally { release(); if (locks.get(key) === current) locks.delete(key); }
}

/** Platform-neutral DuckDB lifecycle and query manager. */
export class DuckDbRuntime {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly resolver: DuckDbModuleResolver;
  private closingAll?: Promise<void>;

  public constructor(private readonly options: DuckDbRuntimeOptions) {
    this.resolver = options.resolver ?? createDuckDbModuleResolver();
  }

  public isAvailable(): boolean { return this.resolver.isAvailable(); }
  public invalidateAvailability(): void { this.resolver.invalidate(); }

  public async execute(target: DuckDbRuntimeTarget, sql: string, options: DatabaseQueryOptions, callbacks: DatabaseQueryCallbacks): Promise<DatabaseQueryResult> {
    const executableSql = attachedTarget(sql, requested => requested);
    const readOnlySql = this.options.isReadOnlySql(executableSql);
    if (options.readOnly && !readOnlySql) throw new Error('This DuckDB connection is read-only.');
    const runtimeSession = this.getSession(target);
    const operation = new RuntimeOperation(runtimeSession.session);
    runtimeSession.operations.add(operation);
    try {
      callbacks.onCommand(operation);
      return await withLock(this.locks, target.connectionId, async () => {
      try {
      operation.throwIfCancelled();
      await runtimeSession.session.connect();
      operation.throwIfCancelled();
      operation.setCancelAction(async () => { runtimeSession.session.interrupt(); });
      await runtimeSession.session.run(`USE ${quoteIdentifier(normalizeDuckDbCatalog(options.database ?? target.databasePath ?? ':memory:'))}`);
        operation.throwIfCancelled();
        if (!readOnlySql) {
          const result = await runtimeSession.session.run(executableSql);
          operation.throwIfCancelled();
          return { totalRows: 0, limitReached: false, rowsAffected: Number(result.rowsChanged ?? 0) };
        }
        const maxRows = rowLimit(options.maxRows);
        const reader = await runtimeSession.session.streamAndReadUntil(executableSql, maxRows + 1);
        operation.throwIfCancelled();
        callbacks.onColumns(columnsFromReader(reader));
        const rawRows = reader.getRowsJS().map(row => row.map(normalize));
        const selected = rawRows.slice(0, maxRows);
        for (let offset = 0; offset < selected.length; offset += 200) {
          operation.throwIfCancelled();
          callbacks.onRows(selected.slice(offset, offset + 200), Math.min(offset + 200, selected.length));
        }
        operation.throwIfCancelled();
        return { totalRows: selected.length, limitReached: rawRows.length > maxRows, rowsAffected: reader.rowsChanged === undefined ? undefined : Number(reader.rowsChanged) };
      } finally {
        operation.complete();
      }
      });
    } finally {
        runtimeSession.operations.delete(operation);
        operation.complete();
    }
  }

  public listDatabases(target: DuckDbRuntimeTarget): Promise<MetadataDatabase[]> {
    return this.queryRows(target, 'SELECT database_name FROM duckdb_databases() WHERE NOT internal ORDER BY database_name', values => ({ name: String(values[0] ?? '') }));
  }

  public listSchemas(target: DuckDbRuntimeTarget, database: string): Promise<MetadataSchema[]> {
    const catalog = normalizeDuckDbCatalog(database);
    return this.queryRows(target, `SELECT database_name, schema_name FROM duckdb_schemas() WHERE database_name = ${sqlLiteral(catalog)} AND schema_name NOT IN ('information_schema', 'pg_catalog') ORDER BY schema_name`, values => ({ database: String(values[0] ?? database), name: String(values[1] ?? '') }));
  }

  public listObjects(target: DuckDbRuntimeTarget, database: string, schema?: string): Promise<MetadataObject[]> {
    const catalog = normalizeDuckDbCatalog(database);
    const schemaClause = schema ? ` AND table_schema = ${sqlLiteral(schema)}` : " AND table_schema NOT IN ('information_schema', 'pg_catalog')";
    const viewSchemaClause = schema ? ` AND schema_name = ${sqlLiteral(schema)}` : " AND schema_name NOT IN ('information_schema', 'pg_catalog')";
    const sql = `SELECT table_name, table_schema, table_catalog, table_type, view_sql FROM (SELECT table_name, table_schema, table_catalog, table_type, CAST(NULL AS VARCHAR) AS view_sql FROM information_schema.tables WHERE table_catalog = ${sqlLiteral(catalog)}${schemaClause} AND table_type <> 'VIEW' UNION ALL SELECT view_name AS table_name, schema_name AS table_schema, database_name AS table_catalog, 'VIEW' AS table_type, sql AS view_sql FROM duckdb_views() WHERE database_name = ${sqlLiteral(catalog)}${viewSchemaClause}) objects ORDER BY table_schema, table_name`;
    return this.queryRows(target, sql, values => ({ name: String(values[0] ?? ''), schema: String(values[1] ?? ''), database: String(values[2] ?? database), objectType: String(values[3] ?? '').toUpperCase() === 'BASE TABLE' ? 'TABLE' : String(values[3] ?? '').toUpperCase(), ...(typeof values[4] === 'string' && values[4].trim() ? { viewSql: values[4].trim() } : {}) }));
  }

  public listColumns(target: DuckDbRuntimeTarget, database: string, schema: string, table: string): Promise<MetadataColumn[]> {
    const catalog = normalizeDuckDbCatalog(database);
    return this.queryRows(target, `SELECT column_name, data_type FROM information_schema.columns WHERE table_catalog = ${sqlLiteral(catalog)} AND table_schema = ${sqlLiteral(schema)} AND table_name = ${sqlLiteral(table)} ORDER BY ordinal_position`, values => ({ name: String(values[0] ?? ''), type: String(values[1] ?? '') }));
  }

  public async closeConnection(connectionId: string): Promise<void> {
    const runtimeSession = this.sessions.get(connectionId);
    if (!runtimeSession) return;
    if (runtimeSession.closing) return runtimeSession.closing;
    runtimeSession.closing = this.closeSession(runtimeSession);
    return runtimeSession.closing;
  }

  public async closeAll(): Promise<void> {
    if (this.closingAll) return this.closingAll;
    const pending = Promise.allSettled([...this.sessions.keys()].map(id => this.closeConnection(id))).then(results => {
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason as unknown);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Multiple DuckDB connections failed to close.');
    });
    this.closingAll = pending.finally(() => { this.closingAll = undefined; });
    return this.closingAll;
  }

  private getSession(target: DuckDbRuntimeTarget): RuntimeSession {
    if (this.closingAll) throw new Error('DuckDB runtime is closing all connections.');
    if (!target.connectionId.trim()) throw new Error('DuckDB runtime requires a connection identifier.');
    if (target.databasePath && !path.isAbsolute(target.databasePath)) throw new Error('DuckDB runtime requires an absolute database path.');
    const existing = this.sessions.get(target.connectionId);
    const targetKey = JSON.stringify({ databasePath: target.databasePath, instanceOwnership: target.instanceOwnership ?? (target.databasePath ? 'cached-file' : 'owned-memory') });
    if (existing) {
      if (existing.closing) throw new Error(`DuckDB connection ${target.connectionId} is closing.`);
      const existingKey = JSON.stringify({ databasePath: existing.target.databasePath, instanceOwnership: existing.target.instanceOwnership ?? (existing.target.databasePath ? 'cached-file' : 'owned-memory') });
      if (existingKey !== targetKey) throw new DuckDbRuntimeTargetChangedError(target.connectionId);
      return existing;
    }
    const ownership = target.instanceOwnership ?? (target.databasePath ? 'cached-file' : 'owned-memory');
    const session = new DuckDbSession({ databasePath: target.databasePath, instanceOwnership: ownership, resolver: this.resolver });
    const runtimeSession: RuntimeSession = { target: { ...target, instanceOwnership: ownership }, session, operations: new Set() };
    this.sessions.set(target.connectionId, runtimeSession);
    return runtimeSession;
  }

  private async queryRows<T>(target: DuckDbRuntimeTarget, sql: string, map: (values: unknown[]) => T): Promise<T[]> {
    const rows: T[] = [];
    await this.execute(target, sql, { maxRows: 200_000, timeoutSeconds: 90 }, {
      onCommand: () => undefined,
      onColumns: () => undefined,
      onRows: values => rows.push(...values.map(map)),
    });
    return rows;
  }

  private async closeSession(runtimeSession: RuntimeSession): Promise<void> {
    const operations = [...runtimeSession.operations];
    const cancellations = await Promise.allSettled(operations.map(operation => operation.cancel()));
    await Promise.all(operations.map(operation => operation.finished));
    try {
      runtimeSession.session.close();
    } finally {
      this.sessions.delete(runtimeSession.target.connectionId);
    }
    const failures = cancellations.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason as unknown), 'DuckDB cancellation failed.');
  }
}

export function normalizeDuckDbCatalog(database: string): string {
  const requested = database.trim();
  if (!requested || requested === ':memory:') return 'memory';
  const base = path.basename(requested.replace(/\\/g, '/'));
  return base.replace(/\.(?:duckdb|ddb)$/iu, '') || base;
}
