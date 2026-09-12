import type { ApiDatabaseRuntime, ApiDatabaseRuntimeKind, QueryCallbacks } from '../src/databaseRuntime/contracts';
import { createApiDatabaseRuntimeRegistry } from '../src/databaseRuntime/registry';
import type { StoredConnection } from '../src/store';

function profile(dbType: StoredConnection['dbType']): StoredConnection {
  return {
    id: 'connection-1',
    name: 'Connection',
    host: 'localhost',
    port: 0,
    database: 'database',
    user: 'user',
    dbType,
    passwordCiphertext: '',
    passwordIv: '',
    passwordAuthTag: '',
    readOnly: true,
  };
}

function runtime(kind: ApiDatabaseRuntimeKind): jest.Mocked<ApiDatabaseRuntime> {
  return {
    kind,
    isAvailable: jest.fn().mockReturnValue(true),
    isReadOnlySql: jest.fn().mockReturnValue(true),
    normalizeDatabase: jest.fn((database: string) => `${kind}:${database}`),
    execute: jest.fn().mockResolvedValue({ totalRows: 0, limitReached: false }),
    listDatabases: jest.fn().mockResolvedValue([]),
    listSchemas: jest.fn().mockResolvedValue([]),
    listObjects: jest.fn().mockResolvedValue([]),
    listColumns: jest.fn().mockResolvedValue([]),
    closeConnection: jest.fn().mockResolvedValue(undefined),
    closeAll: jest.fn().mockResolvedValue(undefined),
  };
}

function callbacks(): QueryCallbacks {
  return {
    onColumns: () => undefined,
    onRows: () => undefined,
    onCommand: () => undefined,
  };
}

describe('API database runtime registry', () => {
  it.each([
    ['netezza', 'netezza'],
    ['sqlite', 'sqlite'],
    ['duckdb', 'duckdb'],
  ] as const)('selects %s profiles through the %s runtime', (dbType, expectedKind) => {
    const runtimes = [runtime('netezza'), runtime('sqlite'), runtime('duckdb')];
    const registry = createApiDatabaseRuntimeRegistry({ masterKey: 'unused', runtimes });

    expect(registry.forProfile(profile(dbType))).toBe(runtimes.find(candidate => candidate.kind === expectedKind));
  });

  it('rejects an authoring-only or unknown profile instead of silently routing it to Netezza', () => {
    const runtimes = [runtime('netezza'), runtime('sqlite'), runtime('duckdb')];
    const registry = createApiDatabaseRuntimeRegistry({ masterKey: 'unused', runtimes });

    expect(() => registry.forProfile(profile('postgresql'))).toThrow("No API database runtime is registered for 'postgresql'.");
    expect(() => registry.forProfile(profile('future-database'))).toThrow("No API database runtime is registered for 'future-database'.");
    expect(registry.isAvailable(profile('postgresql'))).toBe(false);
    expect(runtimes[0]?.execute).not.toHaveBeenCalled();
  });

  it('delegates execution, metadata, read-only checks, and normalization to the selected runtime', async () => {
    const netezza = runtime('netezza');
    const sqlite = runtime('sqlite');
    const duckdb = runtime('duckdb');
    const registry = createApiDatabaseRuntimeRegistry({ masterKey: 'unused', runtimes: [netezza, sqlite, duckdb] });
    const connection = profile('duckdb');
    const queryCallbacks = callbacks();
    const options = { maxRows: 10, timeoutSeconds: 30, readOnly: true, database: 'catalog' };

    await registry.execute(connection, 'SELECT 1', options, queryCallbacks);
    await registry.listDatabases(connection);
    await registry.listSchemas(connection, 'catalog');
    await registry.listObjects(connection, 'catalog', 'main');
    await registry.listColumns(connection, 'catalog', 'main', 'items');

    expect(duckdb.execute).toHaveBeenCalledWith(connection, 'SELECT 1', options, queryCallbacks);
    expect(duckdb.listDatabases).toHaveBeenCalledWith(connection);
    expect(duckdb.listSchemas).toHaveBeenCalledWith(connection, 'catalog');
    expect(duckdb.listObjects).toHaveBeenCalledWith(connection, 'catalog', 'main');
    expect(duckdb.listColumns).toHaveBeenCalledWith(connection, 'catalog', 'main', 'items');
    expect(registry.isReadOnlySql(connection, 'SELECT 1')).toBe(true);
    expect(registry.normalizeDatabase(connection, 'catalog')).toBe('duckdb:catalog');
    expect(netezza.execute).not.toHaveBeenCalled();
    expect(sqlite.execute).not.toHaveBeenCalled();
  });

  it('attempts cleanup in every runtime and reports failures after all attempts', async () => {
    const netezza = runtime('netezza');
    const sqlite = runtime('sqlite');
    const duckdb = runtime('duckdb');
    const closeError = new Error('SQLite close failed');
    sqlite.closeConnection.mockImplementationOnce(() => { throw closeError; });
    const registry = createApiDatabaseRuntimeRegistry({ masterKey: 'unused', runtimes: [netezza, sqlite, duckdb] });

    await expect(registry.closeConnection('connection-1')).rejects.toBe(closeError);
    for (const candidate of [netezza, sqlite, duckdb]) {
      expect(candidate.closeConnection).toHaveBeenCalledWith('connection-1');
    }

    await expect(registry.closeAll()).resolves.toBeUndefined();
    await expect(registry.execute(profile('sqlite'), 'SELECT 1', { maxRows: 1, timeoutSeconds: 1 }, callbacks())).resolves.toEqual({ totalRows: 0, limitReached: false });
    for (const candidate of [netezza, sqlite, duckdb]) {
      expect(candidate.closeAll).toHaveBeenCalledTimes(1);
    }
  });

  it('aggregates multiple cleanup failures', async () => {
    const netezza = runtime('netezza');
    const sqlite = runtime('sqlite');
    const duckdb = runtime('duckdb');
    netezza.closeAll.mockRejectedValueOnce(new Error('Netezza close failed'));
    duckdb.closeAll.mockRejectedValueOnce(new Error('DuckDB close failed'));
    const registry = createApiDatabaseRuntimeRegistry({ masterKey: 'unused', runtimes: [netezza, sqlite, duckdb] });

    await expect(registry.closeAll()).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'Multiple database runtimes failed to close.',
    });
    expect(sqlite.closeAll).toHaveBeenCalledTimes(1);
  });
});
