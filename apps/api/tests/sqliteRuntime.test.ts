import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteApiDatabaseRuntime, isSqliteReadOnlySql } from '../src/databaseRuntime/sqliteRuntime';
import type { ApiQueryOptions, QueryCallbacks } from '../src/databaseRuntime/contracts';
import type { StoredConnection } from '../src/store';

type QueryCommand = { cancel(): Promise<void> };

function profile(root: string): StoredConnection {
  return {
    id: `sqlite-test-${Date.now()}-${Math.random()}`,
    name: 'SQLite test',
    host: '',
    port: 0,
    database: 'primary.sqlite',
    user: '',
    dbType: 'sqlite',
    passwordCiphertext: '',
    passwordIv: '',
    passwordAuthTag: '',
    readOnly: false,
    userId: 'user-1',
    localDbRoot: root,
  };
}

const options: ApiQueryOptions = { maxRows: 10, timeoutSeconds: 30, readOnly: false, database: 'main' };
const runtime = new SqliteApiDatabaseRuntime();

async function run(profileValue: StoredConnection, sql: string, queryOptions = options, callbacks: Partial<QueryCallbacks> = {}) {
  const received: { columns: unknown[]; rows: unknown[][]; command?: QueryCommand } = { columns: [], rows: [] };
  const fullCallbacks: QueryCallbacks = {
    onColumns: columns => { received.columns = columns; callbacks.onColumns?.(columns); },
    onRows: (rows, totalRows) => { received.rows.push(...rows); callbacks.onRows?.(rows, totalRows); },
    onCommand: command => { received.command = command; callbacks.onCommand?.(command); },
  };
  const result = await runtime.execute(profileValue, sql, queryOptions, fullCallbacks);
  return { result, received };
}

describe('SQLite local runtime', () => {
  let root: string;
  let connection: StoredConnection;

  beforeEach(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'justybase-sqlite-runtime-'));
    connection = profile(root);
    await run(connection, 'CREATE TABLE records (id INTEGER, label TEXT)');
    await run(connection, "INSERT INTO records VALUES (1, 'one')");
    await run(connection, "INSERT INTO records VALUES (2, 'two')");
    await run(connection, "INSERT INTO records VALUES (3, 'three')");
  });

  afterEach(async () => {
    await runtime.closeAll();
    rmSync(root, { recursive: true, force: true });
  });

  it('preserves duplicate result columns and stops at the requested limit', async () => {
    const duplicate = await run(connection, 'SELECT 1 AS value, 2 AS value');
    expect(duplicate.received.columns).toEqual([{ name: 'value', type: undefined }, { name: 'value', type: undefined }]);
    expect(duplicate.received.rows).toEqual([[1, 2]]);

    const limited = await run(connection, 'SELECT id FROM records ORDER BY id', { ...options, maxRows: 2 });
    expect(limited.received.rows).toEqual([[1], [2]]);
    expect(limited.result).toEqual({ totalRows: 2, limitReached: true, rowsAffected: undefined });
  });

  it('qualifies and reads attached catalogs', async () => {
    await run(connection, "ATTACH DATABASE 'attached.sqlite' AS aux");
    await run(connection, 'CREATE TABLE aux.items (id INTEGER, name TEXT)');
    await run(connection, "INSERT INTO aux.items VALUES (7, 'attached')");

    expect((await runtime.listDatabases(connection)).map(item => item.name)).toEqual(['main', 'aux']);
    expect(await runtime.listSchemas(connection, 'aux')).toEqual([{ database: 'aux', name: 'aux' }]);
    expect(await runtime.listObjects(connection, 'aux', 'aux')).toEqual([expect.objectContaining({ name: 'items', database: 'aux', schema: 'aux' })]);
    expect(await runtime.listColumns(connection, 'aux', 'aux', 'items')).toEqual([
      { name: 'id', type: 'INTEGER', isPk: false },
      { name: 'name', type: 'TEXT', isPk: false },
    ]);

    const attached = await run(connection, 'SELECT id, name FROM aux.items', { ...options, maxRows: 1 });
    expect(attached.received.rows).toEqual([[7, 'attached']]);
  });

  it('keeps integers outside JavaScript safe range exact', async () => {
    await run(connection, 'CREATE TABLE big_ids (id INTEGER)');
    await run(connection, 'INSERT INTO big_ids VALUES (9007199254740993)');
    const result = await run(connection, 'SELECT id FROM big_ids');
    expect(result.received.rows).toEqual([['9007199254740993']]);
  });

  it('can cancel a worker-backed file read', async () => {
    let command: QueryCommand | undefined;
    const pending = runtime.execute(connection, 'WITH RECURSIVE numbers(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM numbers) SELECT value FROM numbers', { ...options, maxRows: 100_000 }, {
      onColumns: () => undefined,
      onRows: () => undefined,
      onCommand: value => { command = value; },
    });
    expect(command).toBeDefined();
    await command!.cancel();
    await expect(pending).rejects.toThrow('cancelled');
  });

  it('rejects parenthesized write pragmas on read-only memory profiles', async () => {
    const memoryConnection = { ...connection, id: `${connection.id}-memory`, database: ':memory:' };
    try {
      expect(isSqliteReadOnlySql('PRAGMA user_version(123)')).toBe(false);
      expect(isSqliteReadOnlySql('PRAGMA table_info(records)')).toBe(true);

      await run(memoryConnection, 'PRAGMA user_version(123)');
      await expect(runtime.execute(memoryConnection, 'PRAGMA user_version(456)', { ...options, readOnly: true }, {
        onColumns: () => undefined,
        onRows: () => undefined,
        onCommand: () => undefined,
      })).rejects.toThrow('read-only');

      const version = await run(memoryConnection, 'PRAGMA user_version', { ...options, readOnly: true });
      expect(version.received.rows).toEqual([[123]]);
    } finally {
      await runtime.closeConnection(memoryConnection.id);
    }
  });

  it('can cancel a memory-backed read while yielding to the event loop', async () => {
    const memoryConnection = { ...connection, id: `${connection.id}-memory`, database: ':memory:' };
    try {
      let command: QueryCommand | undefined;
      const pending = runtime.execute(memoryConnection, 'WITH RECURSIVE numbers(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM numbers) SELECT value FROM numbers', { ...options, maxRows: 100_000 }, {
        onColumns: () => undefined,
        onRows: () => undefined,
        onCommand: value => { command = value; },
      });
      expect(command).toBeDefined();
      await command!.cancel();
      await expect(pending).rejects.toThrow('cancelled');
    } finally {
      await runtime.closeConnection(memoryConnection.id);
    }
  });
});
