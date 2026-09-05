import { createRequire } from 'node:module';
import path from 'node:path';
import type { MetadataColumn, MetadataDatabase, MetadataObject, MetadataSchema, QueryColumn } from '@justybase/contracts';
import { isReadOnlySql as isRuntimeReadOnlySql, type QueryCallbacks, type QueryOptions } from '@justybase/database-runtime';
import type { StoredConnection } from './store';
import { resolveLocalDatabasePath } from './localDatabaseSandbox';

interface DuckDbResultReader {
  readonly rowsChanged?: number;
  readonly columnCount: number;
  columnName(index: number): string;
  columnType(index: number): { toString(): string };
  getRowsJS(): unknown[][];
}

interface DuckDbConnection {
  run(sql: string): Promise<{ rowsChanged?: number }>;
  runAndReadAll(sql: string): Promise<DuckDbResultReader>;
  streamAndReadUntil(sql: string, targetRowCount: number): Promise<DuckDbResultReader>;
  interrupt(): void;
  disconnectSync(): void;
}

interface DuckDbInstance {
  connect(): Promise<DuckDbConnection>;
  closeSync(): void;
}

interface DuckDbModule {
  DuckDBInstance: {
    create(databasePath?: string): Promise<DuckDbInstance>;
    fromCache(databasePath?: string): Promise<DuckDbInstance>;
  };
}

interface OpenDuckDb {
  instance: DuckDbInstance;
  connection: DuckDbConnection;
  closeInstance: boolean;
}

const moduleRequire = createRequire(__filename);
const openDatabases = new Map<string, Promise<OpenDuckDb>>();
const executionLocks = new Map<string, Promise<void>>();
const FALLBACK_ROW_LIMIT = 200_000;
let duckDbModulePromise: Promise<DuckDbModule> | undefined;

function rowLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : FALLBACK_ROW_LIMIT;
}

function asDuckDbModule(value: unknown): DuckDbModule | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { DuckDBInstance?: unknown };
  if (typeof candidate.DuckDBInstance !== 'function' && (typeof candidate.DuckDBInstance !== 'object' || candidate.DuckDBInstance === null)) return undefined;
  const instance = candidate.DuckDBInstance as { create?: unknown; fromCache?: unknown };
  return typeof instance.create === 'function' && typeof instance.fromCache === 'function' ? value as DuckDbModule : undefined;
}

function moduleCandidates(): string[] {
  const candidates = [
    process.env.JUSTYBASE_DUCKDB_MODULE_PATH,
    '@duckdb/node-api',
    path.resolve(process.cwd(), 'extensions/duckdb/node_modules/@duckdb/node-api'),
    path.resolve(__dirname, '../../../extensions/duckdb/node_modules/@duckdb/node-api'),
  ];
  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate && candidate.trim())))];
}

/**
 * Capability endpoints use this synchronous probe to distinguish an installed
 * optional DuckDB runtime from a profile that only has the shared contract.
 * The actual connection path still performs the asynchronous module load and
 * reports a detailed installation error if the runtime disappears later.
 */
export function isDuckDbRuntimeAvailable(): boolean {
  for (const candidate of moduleCandidates()) {
    try {
      if (asDuckDbModule(moduleRequire(candidate))) return true;
    } catch {
      // Try the next optional installation location.
    }
  }
  return false;
}

async function loadDuckDb(): Promise<DuckDbModule> {
  if (!duckDbModulePromise) {
    duckDbModulePromise = Promise.resolve().then(() => {
      for (const candidate of moduleCandidates()) {
        try {
          const loaded = asDuckDbModule(moduleRequire(candidate));
          if (loaded) return loaded;
        } catch {
          // Try the next optional installation location.
        }
      }
      throw new Error('DuckDB runtime dependency "@duckdb/node-api" is not installed. Install the optional DuckDB extension or set JUSTYBASE_DUCKDB_MODULE_PATH.');
    }).catch(error => {
      duckDbModulePromise = undefined;
      throw error;
    });
  }
  return duckDbModulePromise;
}

function databasePath(profile: StoredConnection): { path?: string; cached: boolean } {
  const requested = profile.database.trim();
  if (!requested || requested === ':memory:') return { path: undefined, cached: false };
  if (!profile.localDbRoot || !profile.userId) throw new Error('Local DuckDB profiles require an application-owned sandbox.');
  return { path: resolveLocalDatabasePath(requested, { root: profile.localDbRoot, userId: profile.userId }), cached: true };
}

export function normalizeDuckDbCatalog(database: string): string {
  const requested = database.trim();
  if (!requested || requested === ':memory:') return 'memory';
  const base = path.basename(requested.replace(/\\/g, '/'));
  return base.replace(/\.(?:duckdb|ddb)$/i, '') || base;
}

async function openDatabase(profile: StoredConnection): Promise<OpenDuckDb> {
  const existing = openDatabases.get(profile.id);
  if (existing) return existing;
  const pending = (async () => {
    const module = await loadDuckDb();
    const location = databasePath(profile);
    const instance = location.cached
      ? await module.DuckDBInstance.fromCache(location.path)
      : await module.DuckDBInstance.create(location.path);
    try {
      return { instance, connection: await instance.connect(), closeInstance: !location.cached };
    } catch (error: unknown) {
      try { instance.closeSync(); } catch { /* Preserve the connection error. */ }
      throw new Error(`Could not open DuckDB database: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  openDatabases.set(profile.id, pending);
  pending.catch(() => { if (openDatabases.get(profile.id) === pending) openDatabases.delete(profile.id); });
  return pending;
}

function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return value;
}

function columnsFromReader(reader: DuckDbResultReader): QueryColumn[] {
  return Array.from({ length: reader.columnCount }, (_, index) => ({ name: reader.columnName(index), type: reader.columnType(index).toString() }));
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function normalizeAttachedDatabaseTargets(profile: StoredConnection, sql: string): string {
  const leadingComments = /^\s*(?:(?:--[^\r\n]*(?:\r\n|\r|\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*/u.exec(sql)?.[0] ?? '';
  const command = sql.slice(leadingComments.length);
  if (!/^ATTACH\b/iu.test(command)) return sql;
  const pattern = /^(\bATTACH(?:\s+DATABASE)?\s+)(['"])(.*?)\2(\s+AS\s+)(['"]?)([A-Za-z_][A-Za-z0-9_]*)\5/iu;
  if (!pattern.test(command)) throw new Error('DuckDB ATTACH requires a sandboxed literal database path.');
  if (!profile.localDbRoot || !profile.userId) {
    if (/^\bATTACH(?:\s+DATABASE)?\s+(['"]):memory:\1\s+AS\s+/iu.test(command)) return sql;
    throw new Error('DuckDB ATTACH requires an application-owned sandbox.');
  }
  const normalizedCommand = command.replace(pattern, (full, prefix: string, quote: string, target: string, asClause: string, nameQuote: string, name: string) => {
    if (target === ':memory:') return full;
    const resolved = resolveLocalDatabasePath(target, { root: profile.localDbRoot!, userId: profile.userId! });
    const escaped = quote === "'" ? resolved.replace(/'/g, "''") : resolved.replace(/"/g, '""');
    return `${prefix}${quote}${escaped}${quote}${asClause}${nameQuote}${name}${nameQuote}`;
  });
  return `${leadingComments}${normalizedCommand}`;
}

function quoteIdentifier(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\u0000')) throw new Error('Invalid DuckDB database name.');
  return `"${trimmed.replace(/"/g, '""')}"`;
}

async function selectDatabase(database: OpenDuckDb, profile: StoredConnection, requestedDatabase: string | undefined): Promise<void> {
  const requestedCatalog = normalizeDuckDbCatalog(requestedDatabase?.trim() || profile.database);
  // USE changes connection-global state. Reset it even when selecting the
  // profile's default catalog after another tab used an attached catalog.
  await database.connection.run(`USE ${quoteIdentifier(requestedCatalog)}`);
}

async function withExecutionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = executionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  executionLocks.set(key, current);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (executionLocks.get(key) === current) executionLocks.delete(key);
  }
}

export function isDuckDbReadOnlySql(sql: string): boolean {
  const trimmed = sql.trim().replace(/;\s*$/u, '');
  const withoutLeadingComments = trimmed.replace(/^(?:(?:--[^\r\n]*(?:\r\n|\r|\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*/u, '').trim();
  if (/^VALUES\b/i.test(withoutLeadingComments)) return !/;/.test(withoutLeadingComments);
  if (/^PRAGMA\b/i.test(withoutLeadingComments) && !/\s*=/.test(withoutLeadingComments)) return true;
  return isRuntimeReadOnlySql(trimmed);
}

async function readRows(profile: StoredConnection, sql: string, requestedDatabase?: string): Promise<Array<Record<string, unknown>>> {
  return withExecutionLock(profile.id, async () => {
  const database = await openDatabase(profile);
  await selectDatabase(database, profile, requestedDatabase);
  const reader = await database.connection.runAndReadAll(sql);
  const columns = columnsFromReader(reader);
  return reader.getRowsJS().map(row => Object.fromEntries(columns.map((column, index) => [column.name, normalize(row[index])])))
    .map(row => row as Record<string, unknown>);
  });
}

async function executeDuckDbQueryUnlocked(profile: StoredConnection, sql: string, options: QueryOptions, callbacks: QueryCallbacks): Promise<{ totalRows: number; limitReached: boolean; rowsAffected?: number }> {
  const executableSql = normalizeAttachedDatabaseTargets(profile, sql);
  if (options.readOnly && !isDuckDbReadOnlySql(executableSql)) throw new Error('This DuckDB connection is read-only.');
  const database = await openDatabase(profile);
  await selectDatabase(database, profile, options.database);
  const command = { cancel: async (): Promise<void> => { database.connection.interrupt(); } };
  callbacks.onCommand(command);

  if (!isDuckDbReadOnlySql(executableSql)) {
    const result = await database.connection.run(executableSql);
    return { totalRows: 0, limitReached: false, rowsAffected: Number(result.rowsChanged ?? 0) };
  }

  const maxRows = rowLimit(options.maxRows);
  // The native reader otherwise materializes the complete result in
  // getRowsJS(). Fetch only maxRows + 1 rows so the extra row can still signal
  // truncation without allowing an unbounded local scan into memory.
  const reader = await database.connection.streamAndReadUntil(executableSql, maxRows + 1);
  const columns = columnsFromReader(reader);
  callbacks.onColumns(columns);
  const rawRows = reader.getRowsJS().map(row => row.map(normalize));
  const selected = rawRows.slice(0, maxRows);
  for (let offset = 0; offset < selected.length; offset += 200) callbacks.onRows(selected.slice(offset, offset + 200), Math.min(offset + 200, selected.length));
  return { totalRows: selected.length, limitReached: rawRows.length > maxRows, rowsAffected: reader.rowsChanged === undefined ? undefined : Number(reader.rowsChanged) };
}

export async function executeDuckDbQuery(profile: StoredConnection, sql: string, options: QueryOptions, callbacks: QueryCallbacks): Promise<{ totalRows: number; limitReached: boolean; rowsAffected?: number }> {
  // `USE` changes connection-local state. Keep selection and execution in the
  // same critical section so concurrent requests cannot run in another catalog.
  return withExecutionLock(profile.id, () => executeDuckDbQueryUnlocked(profile, sql, options, callbacks));
}

export async function listDuckDbDatabases(profile: StoredConnection): Promise<MetadataDatabase[]> {
  const rows = await readRows(profile, 'SELECT database_name FROM duckdb_databases() WHERE NOT internal ORDER BY database_name');
  return rows.map(row => ({ name: String(row.database_name ?? '') })).filter(row => row.name.length > 0);
}

export async function listDuckDbSchemas(profile: StoredConnection, database: string): Promise<MetadataSchema[]> {
  const catalog = normalizeDuckDbCatalog(database);
  const rows = await readRows(profile, `SELECT database_name, schema_name FROM duckdb_schemas() WHERE database_name = ${sqlLiteral(catalog)} AND schema_name NOT IN ('information_schema', 'pg_catalog') ORDER BY schema_name`, catalog);
  return rows.map(row => ({ database: String(row.database_name ?? database), name: String(row.schema_name ?? '') })).filter(row => row.name.length > 0);
}

export async function listDuckDbObjects(profile: StoredConnection, database: string, schema?: string): Promise<MetadataObject[]> {
  const catalog = normalizeDuckDbCatalog(database);
  const schemaClause = schema ? ` AND table_schema = ${sqlLiteral(schema)}` : " AND table_schema NOT IN ('information_schema', 'pg_catalog')";
  const rows = await readRows(profile, `
    SELECT table_name, table_schema, table_catalog, table_type, view_sql
      FROM (
        SELECT table_name, table_schema, table_catalog, table_type, CAST(NULL AS VARCHAR) AS view_sql
          FROM information_schema.tables
         WHERE table_catalog = ${sqlLiteral(catalog)}${schemaClause}
           AND table_type <> 'VIEW'
        UNION ALL
        SELECT view_name AS table_name, schema_name AS table_schema, database_name AS table_catalog, 'VIEW' AS table_type, sql AS view_sql
          FROM duckdb_views()
         WHERE database_name = ${sqlLiteral(catalog)}${schema ? ` AND schema_name = ${sqlLiteral(schema)}` : " AND schema_name NOT IN ('information_schema', 'pg_catalog')"}
      ) objects
     ORDER BY table_schema, table_name`, catalog);
  return rows.map(row => ({
    name: String(row.table_name ?? ''),
    schema: String(row.table_schema ?? ''),
    database: String(row.table_catalog ?? database),
    objectType: String(row.table_type ?? '').toUpperCase() === 'BASE TABLE' ? 'TABLE' : String(row.table_type ?? '').toUpperCase(),
    ...(typeof row.view_sql === 'string' && row.view_sql.trim() ? { description: row.view_sql } : {}),
  })).filter(row => row.name.length > 0);
}

export async function listDuckDbColumns(profile: StoredConnection, database: string, schema: string, table: string): Promise<MetadataColumn[]> {
  const catalog = normalizeDuckDbCatalog(database);
  const rows = await readRows(profile, `SELECT column_name, data_type FROM information_schema.columns WHERE table_catalog = ${sqlLiteral(catalog)} AND table_schema = ${sqlLiteral(schema)} AND table_name = ${sqlLiteral(table)} ORDER BY ordinal_position`, catalog);
  return rows.map(row => ({ name: String(row.column_name ?? ''), type: String(row.data_type ?? '') })).filter(row => row.name.length > 0);
}

export async function closeDuckDbDatabases(): Promise<void> {
  const databases = await Promise.all([...openDatabases.values()].map(pending => pending.catch(() => undefined)));
  openDatabases.clear();
  executionLocks.clear();
  for (const database of databases) {
    if (!database) continue;
    try { database.connection.disconnectSync(); } catch { /* Closing is best effort during server shutdown. */ }
    if (database.closeInstance) {
      try { database.instance.closeSync(); } catch { /* Closing is best effort during server shutdown. */ }
    }
  }
}

export async function closeDuckDbDatabase(profileId: string): Promise<void> {
  const pending = openDatabases.get(profileId);
  openDatabases.delete(profileId);
  const database = await pending?.catch(() => undefined);
  if (database) {
    try { database.connection.disconnectSync(); } catch { /* best effort while replacing a profile */ }
    if (database.closeInstance) {
      try { database.instance.closeSync(); } catch { /* best effort while replacing a profile */ }
    }
  }
  executionLocks.delete(profileId);
}
