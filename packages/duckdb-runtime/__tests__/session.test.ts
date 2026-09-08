import { DuckDbSession, type DuckDbModuleResolver } from '../src';

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

  it('never closes a shared cached instance after connection failure', async () => {
    const state = fixture();
    state.instance.connect.mockRejectedValueOnce(new Error('connect failed'));
    const session = new DuckDbSession({ resolver: state.resolver, instanceOwnership: 'cached-file', databasePath: '/tmp/test.duckdb' });
    await expect(session.connect()).rejects.toThrow('connect failed');
    session.close();
    expect(state.instance.closeSync).not.toHaveBeenCalled();
  });

  it('releases a connection that arrives after close', async () => {
    const state = fixture();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    state.instance.connect.mockImplementationOnce(async () => { started(); await pending; return state.connection; });
    const session = new DuckDbSession({ resolver: state.resolver });
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

  it('releases the owned instance even if disconnect fails', async () => {
    const state = fixture();
    state.connection.disconnectSync.mockImplementationOnce(() => { throw new Error('disconnect failed'); });
    const session = new DuckDbSession({ resolver: state.resolver });
    await session.connect();
    expect(() => session.close()).toThrow('disconnect failed');
    expect(state.instance.closeSync).toHaveBeenCalledTimes(1);
    session.close();
    expect(session.isOpen).toBe(false);
  });
});
