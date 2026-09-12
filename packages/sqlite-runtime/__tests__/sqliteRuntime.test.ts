import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseQueryCallbacks, DatabaseQueryOptions } from '@justybase/contracts';
import {
  rewriteSqliteAttachTarget,
  SqliteRuntime,
  SqliteRuntimeTargetChangedError,
  type SqliteRuntimeTarget,
} from '../src';

const queryOptions: DatabaseQueryOptions = { maxRows: 10, timeoutSeconds: 30 };

function isReadOnlySql(sql: string): boolean {
  return /^(?:\s|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)*(?:SELECT|WITH|VALUES|PRAGMA)\b/iu.test(sql);
}

function target(connectionId: string, databasePath: string): SqliteRuntimeTarget {
  return { connectionId, databasePath };
}

async function execute(runtime: SqliteRuntime, runtimeTarget: SqliteRuntimeTarget, sql: string, options = queryOptions) {
  const columns: unknown[] = [];
  const rows: unknown[][] = [];
  const callbacks: DatabaseQueryCallbacks = {
    onColumns: value => { columns.push(...value); },
    onRows: value => { rows.push(...value); },
    onCommand: () => undefined,
  };
  const result = await runtime.execute(runtimeTarget, sql, options, callbacks);
  return { columns, rows, result };
}

describe('SqliteRuntime', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'justybase-sqlite-package-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('owns file sessions, streams exact values, and exposes metadata', async () => {
    const runtime = new SqliteRuntime({ isReadOnlySql });
    const runtimeTarget = target('primary', path.join(root, 'primary.sqlite'));
    try {
      await execute(runtime, runtimeTarget, 'CREATE TABLE records (id INTEGER PRIMARY KEY, label TEXT)');
      await execute(runtime, runtimeTarget, "INSERT INTO records VALUES (9007199254740993, 'large')");

      const query = await execute(runtime, runtimeTarget, 'SELECT id AS value, label AS value FROM records');
      expect(query.columns).toEqual([{ name: 'value', type: 'INTEGER' }, { name: 'value', type: 'TEXT' }]);
      expect(query.rows).toEqual([['9007199254740993', 'large']]);
      expect(await runtime.listDatabases(runtimeTarget)).toEqual([{ name: 'main' }]);
      expect(await runtime.listSchemas(runtimeTarget, 'main')).toEqual([{ database: 'main', name: 'main' }]);
      expect(await runtime.listObjects(runtimeTarget, 'main')).toEqual([
        expect.objectContaining({ name: 'records', objectType: 'TABLE' }),
      ]);
      expect(await runtime.listColumns(runtimeTarget, 'main', 'main', 'records')).toEqual([
        { name: 'id', type: 'INTEGER', isPk: true },
        { name: 'label', type: 'TEXT', isPk: false },
      ]);
    } finally {
      await runtime.closeAll();
    }
  });

  it('exposes catalog view SQL for shared DDL generation', async () => {
    const runtime = new SqliteRuntime({ isReadOnlySql });
    const runtimeTarget = target('view-source', path.join(root, 'view-source.sqlite'));
    try {
      await execute(runtime, runtimeTarget, 'CREATE TABLE records (id INTEGER)');
      await execute(runtime, runtimeTarget, 'CREATE VIEW recent_records AS SELECT id FROM records');

      expect(await runtime.listObjects(runtimeTarget, 'main')).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'recent_records',
          objectType: 'VIEW',
          viewSql: 'CREATE VIEW recent_records AS SELECT id FROM records',
        }),
      ]));
    } finally {
      await runtime.closeAll();
    }
  });

  it('rejects read-only writes before creating a missing database file', async () => {
    const runtime = new SqliteRuntime({ isReadOnlySql });
    const databasePath = path.join(root, 'missing.sqlite');
    const runtimeTarget = target('read-only', databasePath);

    await expect(execute(runtime, runtimeTarget, 'CREATE TABLE records (id INTEGER)', { ...queryOptions, readOnly: true }))
      .rejects.toThrow('This SQLite connection is read-only.');
    expect(existsSync(databasePath)).toBe(false);
    await runtime.closeAll();
  });

  it('rejects silent target changes for an open connection identity', async () => {
    const runtime = new SqliteRuntime({ isReadOnlySql });
    const first = target('stable-id', path.join(root, 'first.sqlite'));
    const second = target('stable-id', path.join(root, 'second.sqlite'));
    try {
      await execute(runtime, first, 'CREATE TABLE records (id INTEGER)');
      await expect(runtime.listDatabases(second)).rejects.toBeInstanceOf(SqliteRuntimeTargetChangedError);
    } finally {
      await runtime.closeAll();
    }
  });

  it('keeps equal connection ids isolated between runtime instances', async () => {
    const first = new SqliteRuntime({ isReadOnlySql });
    const second = new SqliteRuntime({ isReadOnlySql });
    const firstTarget = target('same-id', ':memory:');
    const secondTarget = target('same-id', ':memory:');
    try {
      await execute(first, firstTarget, 'CREATE TABLE only_first (id INTEGER)');
      expect((await first.listObjects(firstTarget, 'main')).map(item => item.name)).toEqual(['only_first']);
      expect(await second.listObjects(secondTarget, 'main')).toEqual([]);
    } finally {
      await Promise.all([first.closeAll(), second.closeAll()]);
    }
  });

  it('cancels active work before closing and can be reused afterwards', async () => {
    const runtime = new SqliteRuntime({ isReadOnlySql });
    const runtimeTarget = target('memory', ':memory:');
    const pending = runtime.execute(
      runtimeTarget,
      'WITH RECURSIVE numbers(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM numbers) SELECT value FROM numbers',
      { ...queryOptions, maxRows: 100_000 },
      {
        onColumns: () => undefined,
        onRows: () => undefined,
        onCommand: () => undefined,
      },
    );
    const closing = runtime.closeConnection(runtimeTarget.connectionId);
    await expect(pending).rejects.toThrow('cancelled');
    await closing;

    await execute(runtime, runtimeTarget, 'CREATE TABLE after_close (id INTEGER)');
    expect((await runtime.listObjects(runtimeTarget, 'main')).map(item => item.name)).toEqual(['after_close']);
    await runtime.closeAll();
  });
});

describe('rewriteSqliteAttachTarget', () => {
  it('authorizes only literal ATTACH paths while preserving leading comments', () => {
    const resolver = jest.fn((requested: string) => `/sandbox/${requested}`);
    expect(rewriteSqliteAttachTarget("-- attach next\nATTACH DATABASE 'aux.sqlite' AS aux", resolver))
      .toBe("-- attach next\nATTACH DATABASE '/sandbox/aux.sqlite' AS aux");
    expect(resolver).toHaveBeenCalledWith('aux.sqlite');
  });

  it('leaves unrelated SQL untouched and rejects expression targets', () => {
    const resolver = jest.fn((requested: string) => requested);
    expect(rewriteSqliteAttachTarget('SELECT 1', resolver)).toBe('SELECT 1');
    expect(() => rewriteSqliteAttachTarget("ATTACH printf('%s', 'aux.sqlite') AS aux", resolver))
      .toThrow('product-authorized literal');
    expect(resolver).not.toHaveBeenCalled();
  });
});
