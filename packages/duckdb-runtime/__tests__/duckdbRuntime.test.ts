import type { DatabaseQueryCallbacks } from '@justybase/contracts';
import { DuckDbRuntime, type DuckDbModuleResolver } from '../src';

function resolver(): DuckDbModuleResolver {
  const reader = {
    rowsChanged: 0,
    columnCount: 1,
    columnName: () => 'value',
    columnType: () => ({ toString: () => 'INTEGER' }),
    getRowsJS: () => [[1], [2]],
  };
  const connection = {
    run: async () => ({ rowsChanged: 0 }),
    runAndReadAll: async () => reader,
    streamAndReadUntil: async () => reader,
    interrupt: () => undefined,
    disconnectSync: () => undefined,
  };
  const instance = {
    connect: async () => connection,
    closeSync: () => undefined,
  };
  const module = {
    DuckDBInstance: {
      create: async () => instance,
      fromCache: async () => instance,
    },
  };
  return {
    load: async () => module,
    isAvailable: () => true,
    invalidate: () => undefined,
  };
}

function callbacks(rows: unknown[][]): DatabaseQueryCallbacks {
  return {
    onColumns: () => undefined,
    onRows: values => rows.push(...values),
    onCommand: () => undefined,
  };
}

describe('DuckDbRuntime', () => {
  const target = { connectionId: 'memory' };
  const options = { maxRows: 1, timeoutSeconds: 1 };

  it('cleans up after a throwing command callback', async () => {
    const runtime = new DuckDbRuntime({ resolver: resolver(), isReadOnlySql: () => true });
    await expect(runtime.execute(target, 'SELECT 1', options, {
      ...callbacks([]), onCommand: () => { throw new Error('callback failed'); },
    })).rejects.toThrow('callback failed');
    await runtime.closeAll();
  });

  it('rejects read-only writes before opening a file session', async () => {
    const create = jest.fn(async () => { throw new Error('session opened'); });
    const fromCache = jest.fn(async () => { throw new Error('session opened'); });
    const moduleResolver: DuckDbModuleResolver = {
      load: async () => ({ DuckDBInstance: { create, fromCache } }),
      isAvailable: () => true,
      invalidate: () => undefined,
    };
    const runtime = new DuckDbRuntime({ resolver: moduleResolver, isReadOnlySql: () => false });

    await expect(runtime.execute(
      { connectionId: 'missing-file', databasePath: '/tmp/justybase-missing.duckdb', instanceOwnership: 'cached-file' },
      'CREATE TABLE records (id INTEGER)',
      { ...options, readOnly: true },
      callbacks([]),
    )).rejects.toThrow('This DuckDB connection is read-only.');
    expect(create).not.toHaveBeenCalled();
    expect(fromCache).not.toHaveBeenCalled();
    await runtime.closeAll();
  });

  it('cancels queued work without interrupting another command and ignores stale handles', async () => {
    const moduleResolver = resolver();
    const module = await moduleResolver.load();
    const instance = await module.DuckDBInstance.create();
    const native = await instance.connect();
    const interrupt = jest.spyOn(native, 'interrupt');
    const originalRead = native.streamAndReadUntil;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const read = jest.spyOn(native, 'streamAndReadUntil').mockImplementationOnce(async (...args) => {
      await pending;
      return originalRead(...args);
    });
    const runtime = new DuckDbRuntime({ resolver: moduleResolver, isReadOnlySql: () => true });
    let firstCommand!: Parameters<DatabaseQueryCallbacks['onCommand']>[0];
    const first = runtime.execute(target, 'SELECT 1', options, {
      ...callbacks([]), onCommand: command => { firstCommand = command; },
    });
    const second = runtime.execute(target, 'SELECT 2', options, {
      ...callbacks([]), onCommand: command => { void command.cancel(); },
    });
    const rejected = expect(second).rejects.toThrow('cancelled');
    release();
    await first;
    await rejected;
    await firstCommand.cancel();
    expect(interrupt).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    await runtime.closeAll();
  });

  it('tracks sessions before module loading and drains them on close', async () => {
    const moduleResolver = resolver();
    const module = await moduleResolver.load();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    moduleResolver.load = async () => { await pending; return module; };
    const runtime = new DuckDbRuntime({ resolver: moduleResolver, isReadOnlySql: () => true });
    const query = runtime.execute(target, 'SELECT 1', options, callbacks([]));
    const rejected = expect(query).rejects.toThrow('cancelled');
    await Promise.resolve();
    const closed = runtime.closeAll();
    release();
    await rejected;
    await closed;
    await expect(runtime.execute(target, 'SELECT 1', options, callbacks([]))).resolves.toMatchObject({ totalRows: 1 });
    await runtime.closeAll();
  });

  it('restores the default catalog after a query selects another database', async () => {
    const moduleResolver = resolver();
    const module = await moduleResolver.load();
    const instance = await module.DuckDBInstance.create();
    const native = await instance.connect();
    const run = jest.spyOn(native, 'run');
    const runtime = new DuckDbRuntime({ resolver: moduleResolver, isReadOnlySql: () => true });
    await runtime.execute(target, 'SELECT 1', { ...options, database: 'attached' }, callbacks([]));
    await runtime.execute(target, 'SELECT 1', options, callbacks([]));
    expect(run.mock.calls.map(args => args[0])).toEqual(['USE "attached"', 'USE "memory"']);
    await runtime.closeAll();
  });

  it('keeps a bounded, portable read result and closes an owned memory session', async () => {
    const runtime = new DuckDbRuntime({ resolver: resolver(), isReadOnlySql: sql => /^SELECT\b/iu.test(sql.trim()) });
    const rows: unknown[][] = [];
    const result = await runtime.execute({ connectionId: 'memory-1' }, 'SELECT 1', { maxRows: 1, timeoutSeconds: 1 }, callbacks(rows));

    expect(rows).toEqual([[1]]);
    expect(result).toMatchObject({ totalRows: 1, limitReached: true });
    await expect(runtime.closeConnection('memory-1')).resolves.toBeUndefined();
  });
});
