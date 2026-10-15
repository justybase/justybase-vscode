import { DuckDbSession, type DuckDbModuleResolver } from '../src';
import os from 'node:os';
import path from 'node:path';

const databasePath = path.join(os.tmpdir(), 'justybase-session-fixture.duckdb');

function fixture() {
  const connection = {
    run: jest.fn(async () => ({})),
    runAndReadAll: jest.fn(),
    streamAndReadUntil: jest.fn(),
    interrupt: jest.fn(),
    disconnectSync: jest.fn(),
  };
  const instance = { connect: jest.fn(async () => connection), closeSync: jest.fn() };
  const module = { DuckDBInstance: { create: jest.fn(async () => instance), fromCache: jest.fn(async () => instance) } };
  const resolver: DuckDbModuleResolver = { load: async () => module, isAvailable: () => true, invalidate: () => undefined };
  return { connection, instance, module, resolver };
}

describe('DuckDbSession ownership', () => {
  it('deduplicates simultaneous connects and closes an owned instance once', async () => {
    const state = fixture();
    const session = new DuckDbSession({ resolver: state.resolver });
    await Promise.all([session.connect(), session.connect()]);
    expect(state.instance.connect).toHaveBeenCalledTimes(1);
    session.close();
    session.close();
    expect(state.connection.disconnectSync).toHaveBeenCalledTimes(1);
    expect(state.instance.closeSync).toHaveBeenCalledTimes(1);
  });

  it('releases the file instance after connection failure', async () => {
    const state = fixture();
    state.instance.connect.mockRejectedValueOnce(new Error('connect failed'));
    const session = new DuckDbSession({ resolver: state.resolver, instanceOwnership: 'cached-file', databasePath });
    await expect(session.connect()).rejects.toThrow('connect failed');
    session.close();
    expect(state.instance.closeSync).toHaveBeenCalledTimes(1);
  });

  it('shares simultaneous file opens and closes the instance after the last session', async () => {
    const state = fixture();
    const options = { resolver: state.resolver, instanceOwnership: 'cached-file' as const, databasePath };
    const first = new DuckDbSession(options);
    const second = new DuckDbSession({ ...options, databasePath: path.join(path.dirname(databasePath), '.', path.basename(databasePath)) });
    await Promise.all([first.connect(), second.connect()]);
    expect(state.module.DuckDBInstance.create).toHaveBeenCalledTimes(1);
    expect(state.module.DuckDBInstance.fromCache).not.toHaveBeenCalled();
    first.close();
    first.close();
    expect(state.instance.closeSync).not.toHaveBeenCalled();
    await second.run('SELECT 1');
    second.close();
    expect(state.instance.closeSync).toHaveBeenCalledTimes(1);
    expect(state.connection.disconnectSync).toHaveBeenCalledTimes(2);

    const reopened = new DuckDbSession(options);
    await reopened.connect();
    expect(state.module.DuckDBInstance.create).toHaveBeenCalledTimes(2);
    reopened.close();
    expect(state.instance.closeSync).toHaveBeenCalledTimes(2);
  });

  it('keeps a file instance alive when another session fails to connect', async () => {
    const state = fixture();
    const options = { resolver: state.resolver, instanceOwnership: 'cached-file' as const, databasePath };
    const first = new DuckDbSession(options);
    await first.connect();
    state.instance.connect.mockRejectedValueOnce(new Error('connect failed'));
    const second = new DuckDbSession(options);
    await expect(second.connect()).rejects.toThrow('connect failed');
    second.close();
    expect(state.instance.closeSync).not.toHaveBeenCalled();
    await first.run('SELECT 1');
    first.close();
    expect(state.instance.closeSync).toHaveBeenCalledTimes(1);
  });

  it('allows retry after simultaneous file creation failures', async () => {
    const state = fixture();
    state.module.DuckDBInstance.create.mockRejectedValueOnce(new Error('open failed'));
    const options = { resolver: state.resolver, instanceOwnership: 'cached-file' as const, databasePath };
    const first = new DuckDbSession(options);
    const second = new DuckDbSession(options);
    const attempts = await Promise.allSettled([first.connect(), second.connect()]);
    expect(attempts.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(state.module.DuckDBInstance.create).toHaveBeenCalledTimes(1);
    await first.connect();
    expect(state.module.DuckDBInstance.create).toHaveBeenCalledTimes(2);
    first.close();
    second.close();
    expect(state.instance.closeSync).toHaveBeenCalledTimes(1);
  });

  it('releases a file instance that arrives after close without connecting it', async () => {
    const state = fixture();
    let resolveInstance!: (instance: typeof state.instance) => void;
    const pending = new Promise<typeof state.instance>(resolve => { resolveInstance = resolve; });
    state.module.DuckDBInstance.create.mockReturnValueOnce(pending);
    const session = new DuckDbSession({ resolver: state.resolver, instanceOwnership: 'cached-file', databasePath });
    const connecting = session.connect();
    const rejected = expect(connecting).rejects.toThrow('closed');
    await Promise.resolve();
    session.close();
    resolveInstance(state.instance);
    await rejected;
    expect(state.instance.connect).not.toHaveBeenCalled();
    expect(state.instance.closeSync).toHaveBeenCalledTimes(1);
  });

  it.each(['owned-memory', 'cached-file'] as const)('releases a connection that arrives after close (%s)', async (instanceOwnership) => {
    const state = fixture();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    state.instance.connect.mockImplementationOnce(async () => { started(); await pending; return state.connection; });
    const session = new DuckDbSession({ resolver: state.resolver, instanceOwnership, databasePath: instanceOwnership === 'cached-file' ? databasePath : undefined });
    const connecting = session.connect();
    const rejected = expect(connecting).rejects.toThrow('closed');
    await ready;
    session.close();
    release();
    await rejected;
    expect(state.connection.disconnectSync).toHaveBeenCalledTimes(1);
    expect(state.instance.closeSync).toHaveBeenCalledTimes(1);
    expect(session.isOpen).toBe(false);
  });

  it.each(['owned-memory', 'cached-file'] as const)('releases the instance even if disconnect fails (%s)', async (instanceOwnership) => {
    const state = fixture();
    state.connection.disconnectSync.mockImplementationOnce(() => { throw new Error('disconnect failed'); });
    const session = new DuckDbSession({ resolver: state.resolver, instanceOwnership, databasePath: instanceOwnership === 'cached-file' ? databasePath : undefined });
    await session.connect();
    expect(() => session.close()).toThrow('disconnect failed');
    expect(state.instance.closeSync).toHaveBeenCalledTimes(1);
    session.close();
    expect(session.isOpen).toBe(false);
  });
});
