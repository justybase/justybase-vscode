import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDuckDbDatabase, executeDuckDbQuery } from '../src/duckdb';
import type { QueryCallbacks, QueryOptions } from '../src/netezza';
import type { StoredConnection } from '../src/store';

function createProfile(root: string): StoredConnection {
  return {
    id: `duckdb-test-${Date.now()}-${Math.random()}`,
    name: 'DuckDB test',
    host: '',
    port: 0,
    database: ':memory:',
    user: '',
    dbType: 'duckdb',
    passwordCiphertext: '',
    passwordIv: '',
    passwordAuthTag: '',
    readOnly: false,
    userId: 'user-1',
    localDbRoot: root,
  };
}

const baseOptions: QueryOptions = { masterKey: '', maxRows: 10, timeoutSeconds: 30, readOnly: false };

async function run(profile: StoredConnection, sql: string, options: QueryOptions = baseOptions): Promise<{ rows: unknown[][]; result: { totalRows: number; limitReached: boolean } }> {
  const rows: unknown[][] = [];
  const callbacks: QueryCallbacks = {
    onColumns: () => undefined,
    onRows: values => rows.push(...values),
    onCommand: () => undefined,
  };
  const result = await executeDuckDbQuery(profile, sql, options, callbacks);
  return { rows, result };
}

describe('DuckDB local runtime', () => {
  let root: string;
  let connection: StoredConnection;

  beforeEach(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'justybase-duckdb-runtime-'));
    connection = createProfile(root);
    await run(connection, "ATTACH ':memory:' AS one");
    await run(connection, "ATTACH ':memory:' AS two");
    await run(connection, 'CREATE TABLE one.items AS SELECT * FROM range(1, 4) AS values(value)');
    await run(connection, 'CREATE TABLE two.items AS SELECT * FROM range(11, 14) AS values(value)');
  });

  afterEach(async () => {
    await closeDuckDbDatabase(connection.id);
    rmSync(root, { recursive: true, force: true });
  });

  it('serializes catalog selection with execution and bounds materialization', async () => {
    const [one, two] = await Promise.all([
      run(connection, 'SELECT current_database() AS database, value FROM items ORDER BY value', { ...baseOptions, database: 'one', maxRows: 2 }),
      run(connection, 'SELECT current_database() AS database, value FROM items ORDER BY value', { ...baseOptions, database: 'two', maxRows: 2 }),
    ]);
    expect(one.rows).toEqual([['one', '1'], ['one', '2']]);
    expect(two.rows).toEqual([['two', '11'], ['two', '12']]);
    expect(one.result).toEqual({ totalRows: 2, limitReached: true, rowsAffected: 0 });
    expect(two.result).toEqual({ totalRows: 2, limitReached: true, rowsAffected: 0 });
  });
});
