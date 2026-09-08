import type { DatabaseQueryCallbacks } from '@justybase/contracts';
import { isReadOnlySql, NetezzaRuntime, type NetezzaDriverConnection } from '../src';

describe('Netezza runtime boundary', () => {
  const target = { connectionId: 'nz', details: { host: 'host', port: 5480, database: 'db', user: 'user', password: 'secret' } };
  const options = { maxRows: 10, timeoutSeconds: 1 };
  const callbacks: DatabaseQueryCallbacks = { onColumns: () => undefined, onRows: () => undefined, onCommand: () => undefined };

  it('cancels before connecting and cleans up a throwing callback', async () => {
    const factory = jest.fn<Promise<NetezzaDriverConnection>, []>();
    const runtime = new NetezzaRuntime({ connectionFactory: factory });
    await expect(runtime.execute(target, 'SELECT 1', options, {
      ...callbacks, onCommand: command => { void command.cancel(); },
    })).rejects.toThrow('cancelled');
    await expect(runtime.execute(target, 'SELECT 1', options, {
      ...callbacks, onCommand: () => { throw new Error('callback failed'); },
    })).rejects.toThrow('callback failed');
    await runtime.closeAll();
    expect(factory).not.toHaveBeenCalled();
  });

  it('drains connecting operations and honors the per-query database', async () => {
    let resolveConnection!: (connection: NetezzaDriverConnection) => void;
    const pendingConnection = new Promise<NetezzaDriverConnection>(resolve => { resolveConnection = resolve; });
    const factory = jest.fn(async () => pendingConnection);
    const runtime = new NetezzaRuntime({ connectionFactory: factory });
    const execution = runtime.execute(target, 'SELECT 1', { ...options, database: 'other' }, callbacks);
    const rejection = expect(execution).rejects.toThrow('cancelled');
    let drained = false;
    const closing = runtime.closeAll().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    const close = jest.fn(async () => undefined);
    const createCommand = jest.fn();
    resolveConnection({ close, createCommand } as unknown as NetezzaDriverConnection);
    await rejection;
    await closing;
    expect(factory).toHaveBeenCalledWith({ ...target.details, database: 'other' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(createCommand).not.toHaveBeenCalled();
  });

  it.each(['SET TRANSACTION READ ONLY', 'reader', 'reader.close'])('rolls back and closes after failure in %s', async failure => {
    const commands: string[] = [];
    const close = jest.fn(async () => undefined);
    const connection = {
      close,
      createCommand: (sql: string) => {
        commands.push(sql);
        return {
          cancel: async () => undefined,
          executeNonQuery: async () => { if (sql === failure) throw new Error(failure); },
          executeReader: async () => {
            if (failure === 'reader') throw new Error(failure);
            return { fieldCount: 0, read: async () => false, close: async () => { throw new Error('reader.close'); } };
          },
        };
      },
    } as unknown as NetezzaDriverConnection;
    const runtime = new NetezzaRuntime({ connectionFactory: async () => connection });
    await expect(runtime.execute(target, 'SELECT 1', { ...options, readOnly: true }, callbacks)).rejects.toThrow(failure);
    expect(commands.at(-1)).toBe('ROLLBACK');
    expect(close).toHaveBeenCalledTimes(1);
    await runtime.closeAll();
  });

  it('keeps read-only classification independent from the driver', () => {
    expect(isReadOnlySql('SELECT 1; SHOW DATABASE')).toBe(true);
    expect(isReadOnlySql('SELECT 1; INSERT INTO T VALUES (1)')).toBe(false);
  });

  it('owns a connection and drains it on close', async () => {
    const close = jest.fn(async () => undefined);
    const reader = {
      fieldCount: 1,
      getName: () => 'VALUE',
      getTypeName: () => 'INTEGER',
      getValue: () => 7,
      read: jest.fn(async () => true).mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      close: jest.fn(async () => undefined),
    };
    const command = {
      _recordsAffected: 0,
      commandTimeout: 0,
      executeReader: jest.fn(async () => reader),
      executeNonQuery: jest.fn(async () => 0),
      cancel: jest.fn(async () => undefined),
    };
    const connection = {
      createCommand: jest.fn(() => command),
      close,
    } as unknown as NetezzaDriverConnection;
    const runtime = new NetezzaRuntime({ connectionFactory: async () => connection });
    const rows: unknown[][] = [];
    const callbacks: DatabaseQueryCallbacks = {
      onColumns: () => undefined,
      onRows: values => rows.push(...values),
      onCommand: () => undefined,
    };

    await runtime.execute({ connectionId: 'nz-1', details: { host: 'host', port: 5480, database: 'db', user: 'user', password: 'secret' } }, 'SELECT 7', { maxRows: 10, timeoutSeconds: 1 }, callbacks);
    await runtime.closeConnection('nz-1');

    expect(rows).toEqual([[7]]);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
