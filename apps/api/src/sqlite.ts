import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import type { MetadataColumn, MetadataDatabase, MetadataObject, MetadataSchema, QueryColumn } from '@justybase/contracts';
import { isReadOnlySql as isRuntimeReadOnlySql } from '@justybase/database-runtime';
import type { QueryCallbacks, QueryOptions } from './netezza';
import type { StoredConnection } from './store';
import { resolveLocalDatabasePath } from './localDatabaseSandbox';

const databases = new Map<string, DatabaseSync>();
const FALLBACK_ROW_LIMIT = 200_000;
const READ_ONLY_PRAGMA_FUNCTIONS = new Set([
  'collation_list',
  'compile_options',
  'database_list',
  'foreign_key_check',
  'foreign_key_list',
  'function_list',
  'index_info',
  'index_list',
  'index_xinfo',
  'integrity_check',
  'module_list',
  'pragma_list',
  'quick_check',
  'stats',
  'table_info',
  'table_list',
  'table_xinfo',
]);

function rowLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : FALLBACK_ROW_LIMIT;
}

function databaseLocation(profile: StoredConnection): string {
  const requested = profile.database.trim();
  if (requested === ':memory:') return ':memory:';
  if (profile.localDbRoot && profile.userId) return resolveLocalDatabasePath(requested, { root: profile.localDbRoot, userId: profile.userId });
  throw new Error('Local SQLite profiles require an application-owned sandbox.');
}

function getDatabase(profile: StoredConnection): DatabaseSync {
  const existing = databases.get(profile.id);
  if (existing) return existing;
  const database = new DatabaseSync(databaseLocation(profile), { readBigInts: true });
  databases.set(profile.id, database);
  return database;
}

function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return value;
}

function quoteIdentifier(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\u0000')) throw new Error('Invalid SQLite identifier.');
  return `"${trimmed.replace(/"/g, '""')}"`;
}

function sqliteCatalog(profile: StoredConnection, database: string | undefined): string {
  const requested = database?.trim();
  if (requested) return requested;
  return profile.database.trim() === ':memory:' ? 'main' : 'main';
}

export function isSqliteReadOnlySql(sql: string): boolean {
  const trimmed = sql.trim().replace(/;\s*$/u, '');
  const withoutLeadingComments = trimmed.replace(/^(?:(?:--[^\r\n]*(?:\r\n|\r|\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*/u, '').trim();
  if (/^VALUES\b/i.test(withoutLeadingComments)) return !/;/.test(withoutLeadingComments);
  const pragma = /^PRAGMA\s+(?:(?:[A-Za-z_][A-Za-z0-9_$]*|"(?:""|[^"])+")\s*\.\s*)?(?:"((?:""|[^"])*)"|([A-Za-z_][A-Za-z0-9_$]*))\s*([\s\S]*)$/iu.exec(withoutLeadingComments);
  if (pragma) {
    const pragmaName = (pragma[1] ?? pragma[2] ?? '').replace(/""/g, '"').toLowerCase();
    const suffix = pragma[3]?.trim() ?? '';
    if (suffix.startsWith('=')) return false;
    // SQLite accepts both `name = value` and `name(value)` for assignment
    // pragmas. Keep the documented table/index inspection pragmas readable,
    // but fail closed for every other parenthesized form.
    if (suffix.startsWith('(')) return READ_ONLY_PRAGMA_FUNCTIONS.has(pragmaName) && /^\([\s\S]*\)$/u.test(suffix);
    return true;
  }
  return isRuntimeReadOnlySql(trimmed);
}

function normalizeAttachedDatabaseTargets(profile: StoredConnection, sql: string): string {
  const leadingComments = /^\s*(?:(?:--[^\r\n]*(?:\r\n|\r|\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*/u.exec(sql)?.[0] ?? '';
  const command = sql.slice(leadingComments.length);
  if (!/^ATTACH\b/iu.test(command)) return sql;
  const pattern = /^(\bATTACH(?:\s+DATABASE)?\s+)(['"])(.*?)\2(\s+AS\s+)(['"]?)([A-Za-z_][A-Za-z0-9_]*)\5/iu;
  if (!pattern.test(command)) throw new Error('SQLite ATTACH requires a sandboxed literal database path.');
  if (!profile.localDbRoot || !profile.userId) {
    if (/^\bATTACH(?:\s+DATABASE)?\s+(['"]):memory:\1\s+AS\s+/iu.test(command)) return sql;
    throw new Error('SQLite ATTACH requires an application-owned sandbox.');
  }
  const normalizedCommand = command.replace(pattern, (full, prefix: string, quote: string, target: string, asClause: string, nameQuote: string, name: string) => {
    if (target === ':memory:') return full;
    const resolved = resolveLocalDatabasePath(target, { root: profile.localDbRoot!, userId: profile.userId! });
    const escaped = quote === "'" ? resolved.replace(/'/g, "''") : resolved.replace(/"/g, '""');
    return `${prefix}${quote}${escaped}${quote}${asClause}${nameQuote}${name}${nameQuote}`;
  });
  return `${leadingComments}${normalizedCommand}`;
}

interface SqliteWorkerData { databasePath: string; sql: string; maxRows: number; attachments: Array<{ name: string; file: string }>; }
interface SqliteWorkerColumnsMessage { type: 'columns'; columns: QueryColumn[]; }
interface SqliteWorkerRowsMessage { type: 'rows'; rows: unknown[][]; totalRows: number; }
interface SqliteWorkerDoneMessage { type: 'done'; totalRows: number; limitReached: boolean; }
interface SqliteWorkerErrorMessage { type: 'error'; message: string; }
type SqliteWorkerMessage = SqliteWorkerColumnsMessage | SqliteWorkerRowsMessage | SqliteWorkerDoneMessage | SqliteWorkerErrorMessage;

// File-backed reads run in a worker because DatabaseSync is synchronous and a
// large SQLite scan otherwise blocks Fastify's event loop. Arrays are enabled
// explicitly: unlike object rows, arrays preserve duplicate column labels.
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

function attachedFiles(database: DatabaseSync): Array<{ name: string; file: string }> {
  const statement = database.prepare('PRAGMA database_list');
  statement.setReturnArrays(true);
  return (statement.all() as unknown as unknown[][]).slice(1).flatMap(row => {
    const name = String(row[1] ?? '');
    const file = String(row[2] ?? '');
    return name && file ? [{ name, file }] : [];
  });
}

function hasInMemoryAttachment(database: DatabaseSync): boolean {
  const statement = database.prepare('PRAGMA database_list');
  statement.setReturnArrays(true);
  return (statement.all() as unknown as unknown[][]).some(row => {
    const name = String(row[1] ?? '');
    return name !== 'main' && name !== 'temp' && String(row[2] ?? '') === '';
  });
}

function executeFileRead(databasePath: string, sql: string, maxRows: number, attachments: Array<{ name: string; file: string }>, callbacks: QueryCallbacks): Promise<{ totalRows: number; limitReached: boolean }> {
  let worker: Worker | undefined;
  let settled = false;
  let rejectResult: ((reason: unknown) => void) | undefined;
  const result = new Promise<{ totalRows: number; limitReached: boolean }>((resolve, reject) => {
    rejectResult = reject;
    worker = new Worker(SQLITE_READ_WORKER, { eval: true, workerData: { databasePath, sql, maxRows, attachments } satisfies SqliteWorkerData });
    worker.on('message', (message: SqliteWorkerMessage) => {
      if (message.type === 'columns') callbacks.onColumns(message.columns);
      else if (message.type === 'rows') callbacks.onRows(message.rows, message.totalRows);
      else if (message.type === 'done') { settled = true; resolve({ totalRows: message.totalRows, limitReached: message.limitReached }); }
      else { settled = true; reject(new Error(message.message)); }
    });
    worker.on('error', error => { if (!settled) { settled = true; reject(error); } });
    worker.on('exit', code => { if (!settled && code !== 0) { settled = true; reject(new Error(`SQLite worker exited with code ${code}.`)); } });
  });
  callbacks.onCommand({ cancel: async () => {
    if (settled) return;
    settled = true;
    rejectResult?.(new Error('Query cancelled.'));
    await worker?.terminate();
  } });
  return result.finally(async () => { if (worker) await worker.terminate(); });
}

async function executeMemoryRead(database: DatabaseSync, sql: string, maxRows: number, callbacks: QueryCallbacks): Promise<{ totalRows: number; limitReached: boolean }> {
  const statement = database.prepare(sql);
  statement.setReturnArrays(true);
  const columns = statement.columns().map(column => ({ name: column.name, type: column.type ?? undefined } satisfies QueryColumn));
  let cancelRequested = false;
  callbacks.onCommand({ cancel: async () => { cancelRequested = true; } });
  callbacks.onColumns(columns);
  const rows: unknown[][] = [];
  let totalRows = 0;
  let limitReached = false;
  for (const row of statement.iterate() as Iterable<unknown[]>) {
    if (cancelRequested) throw new Error('Query cancelled.');
    if (totalRows >= maxRows) { limitReached = true; break; }
    rows.push(row.map(normalize));
    totalRows += 1;
    if (rows.length >= 200) {
      callbacks.onRows(rows.splice(0, rows.length), totalRows);
      await yieldToEventLoop();
      if (cancelRequested) throw new Error('Query cancelled.');
    }
  }
  if (rows.length > 0) callbacks.onRows(rows, totalRows);
  return { totalRows, limitReached };
}

export async function executeSqliteQuery(profile: StoredConnection, sql: string, options: QueryOptions, callbacks: QueryCallbacks): Promise<{ totalRows: number; limitReached: boolean; rowsAffected?: number }> {
  if (options.readOnly && !isSqliteReadOnlySql(sql)) throw new Error('This SQLite connection is read-only.');
  const executableSql = normalizeAttachedDatabaseTargets(profile, sql);
  const database = getDatabase(profile);
  const maxRows = rowLimit(options.maxRows);
  if (!isSqliteReadOnlySql(executableSql)) {
    const statement = database.prepare(executableSql);
    let cancelRequested = false;
    callbacks.onCommand({ cancel: async () => { cancelRequested = true; } });
    const result = statement.run();
    if (cancelRequested) throw new Error('Query cancelled.');
    return { totalRows: 0, limitReached: false, rowsAffected: Number(result.changes ?? 0) };
  }
  if (databaseLocation(profile) === ':memory:') {
    return executeMemoryRead(database, executableSql, maxRows, callbacks);
  }
  // An in-memory attachment cannot be recreated in the worker. Keep this
  // uncommon case on the owning connection; file attachments remain fully
  // asynchronous and cancellable.
  if (hasInMemoryAttachment(database)) return executeMemoryRead(database, executableSql, maxRows, callbacks);
  const result = await executeFileRead(databaseLocation(profile), executableSql, maxRows, attachedFiles(database), callbacks);
  return { ...result, rowsAffected: undefined };
}

export async function listSqliteDatabases(profile: StoredConnection): Promise<MetadataDatabase[]> {
  const database = getDatabase(profile);
  const statement = database.prepare('PRAGMA database_list');
  statement.setReturnArrays(true);
  return (statement.all() as unknown as unknown[][]).map(row => ({ name: String(row[1] ?? '') })).filter(row => row.name.length > 0);
}

export async function listSqliteSchemas(profile: StoredConnection, database: string): Promise<MetadataSchema[]> {
  const catalogs = await listSqliteDatabases(profile);
  if (!catalogs.some(item => item.name === database)) return [];
  // SQLite calls attached databases catalogs; exposing the catalog as the
  // logical schema keeps the existing tree contract while producing catalog.table SQL.
  return [{ database, name: database }];
}

export async function listSqliteObjects(profile: StoredConnection, database: string, schema?: string): Promise<MetadataObject[]> {
  const catalog = sqliteCatalog(profile, database || schema);
  const source = `${quoteIdentifier(catalog)}.sqlite_master`;
  const statement = getDatabase(profile).prepare(`SELECT name, type, sql FROM ${source} WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  statement.setReturnArrays(true);
  return (statement.all() as unknown as unknown[][]).map(row => ({ name: String(row[0] ?? ''), database: catalog, schema: catalog, objectType: String(row[1] ?? '').toUpperCase(), description: typeof row[2] === 'string' ? row[2] : undefined }));
}

export async function listSqliteColumns(profile: StoredConnection, database: string, schema: string, table: string): Promise<MetadataColumn[]> {
  const catalog = sqliteCatalog(profile, database || schema);
  const statement = getDatabase(profile).prepare(`PRAGMA ${quoteIdentifier(catalog)}.table_info(${quoteIdentifier(table)})`);
  statement.setReturnArrays(true);
  return (statement.all() as unknown as unknown[][]).map(row => ({ name: String(row[1] ?? ''), type: String(row[2] ?? ''), isPk: Number(row[5] ?? 0) > 0 }));
}

export function closeSqliteDatabase(profileId: string): void {
  const database = databases.get(profileId);
  if (!database) return;
  try { database.close(); } finally { databases.delete(profileId); }
}

export function closeSqliteDatabases(): void {
  for (const profileId of databases.keys()) closeSqliteDatabase(profileId);
}
