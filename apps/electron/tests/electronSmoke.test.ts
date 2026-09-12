import { MainCredentialBroker } from '../src/main/credentialBroker';
import { dispatchIpcMessage } from '../src/main/ipcProtocol';
import { redactConnectionProfile, redactConnectionProfiles } from '../src/main/redaction';
import { createPreloadBridge } from '../src/preload/bridge';

describe('Electron main/preload secret boundary', () => {
  it('keeps broker values out of opaque IDs, IPC responses and redacted profiles', async () => {
    const secret = 'database-password-fixture';
    const broker = new MainCredentialBroker({ request: async () => secret });
    const requestId = await broker.request('connection');
    expect(requestId).not.toContain(secret);
    expect(JSON.stringify({ requestId })).not.toContain(secret);
    expect(broker.consume(requestId)).toBe(secret);
    expect(broker.consume(requestId)).toBeUndefined();

    const profile = redactConnectionProfile({ id: 'connection-1', name: 'SQLite', host: 'local', port: 0, database: ':memory:', user: 'local', dbType: 'sqlite', readOnly: true, password: secret });
    expect(profile).toEqual({ id: 'connection-1', name: 'SQLite', host: 'local', port: 0, database: ':memory:', user: 'local', dbType: 'sqlite', readOnly: true });
    expect(JSON.stringify(profile)).not.toContain(secret);
    expect(redactConnectionProfiles([profile])).toEqual([profile]);
    expect(() => redactConnectionProfile(null)).toThrow('invalid');
    expect(() => redactConnectionProfile({ id: 'missing-fields' })).toThrow('invalid');
    broker.dispose();
    broker.dispose();
  });

  it('rejects unavailable credentials and ignores broker operations after disposal', async () => {
    const unavailable = new MainCredentialBroker();
    await expect(unavailable.request('login')).rejects.toThrow('AUTH_CREDENTIAL_UNAVAILABLE');
    unavailable.dispose();
    await expect(unavailable.request('connection')).rejects.toThrow('disposed');
    expect(unavailable.consume('missing-id' as never)).toBeUndefined();

    const provider = new MainCredentialBroker({ request: async () => 'temporary-secret' });
    const requestId = await provider.request('connection');
    provider.revoke(requestId);
    expect(provider.consume(requestId)).toBeUndefined();
    provider.dispose();
  });

  it('rejects malformed, unknown and secret-bearing IPC messages', async () => {
    const broker = new MainCredentialBroker({ request: async () => 'secret' });
    const profile = { id: 'connection-1', name: 'SQLite', host: 'local', port: 0, database: ':memory:', user: 'local', dbType: 'sqlite', readOnly: true } as const;
    const handlers = {
      authStatus: () => ({ status: 'authenticated' as const }),
      credentialBroker: broker,
      listConnections: () => [],
      createConnection: async () => profile,
      updateConnection: async () => profile,
      deleteConnection: async () => undefined,
      testConnection: async () => undefined,
      testConnectionProfile: async () => undefined,
      listCapabilities: () => ({ descriptors: [] }),
    };
    await expect(dispatchIpcMessage(null, handlers)).resolves.toEqual(expect.objectContaining({ ok: false, code: 'INVALID_IPC_MESSAGE' }));
    await expect(dispatchIpcMessage({ method: 'main/execute' }, handlers)).resolves.toEqual(expect.objectContaining({ ok: false, code: 'UNKNOWN_IPC_METHOD' }));
    await expect(dispatchIpcMessage({ method: 'connections/list', payload: { password: 'secret' } }, handlers)).resolves.toEqual(expect.objectContaining({ ok: false, code: 'SECRET_IN_IPC' }));
    await expect(dispatchIpcMessage({ method: 'connections/list', password: 'secret' }, handlers)).resolves.toEqual(expect.objectContaining({ ok: false, code: 'SECRET_IN_IPC' }));
    await expect(dispatchIpcMessage({ method: 'credential/request', payload: { purpose: 'connection' } }, handlers)).resolves.toEqual(expect.objectContaining({ ok: true, requestId: expect.any(String) }));
    await expect(dispatchIpcMessage({ method: 'credential/request', payload: { purpose: 'connection' } }, { ...handlers, credentialBroker: { request: async () => 'database-password' } as never })).resolves.toEqual(expect.objectContaining({ ok: false, code: 'INVALID_IPC_RESPONSE' }));
    await expect(dispatchIpcMessage({ method: 'connections/list' }, { ...handlers, listConnections: () => [{ id: 'leaked', password: 'secret' }] as never })).resolves.toEqual(expect.objectContaining({ ok: false, code: 'INVALID_IPC_RESPONSE' }));
    await expect(dispatchIpcMessage({ method: 'auth/status' }, { ...handlers, authStatus: () => ({ status: 'authenticated', password: 'secret' } as never) })).resolves.toEqual(expect.objectContaining({ ok: false, code: 'INVALID_IPC_RESPONSE' }));
    await expect(dispatchIpcMessage({ method: 'capabilities/list' }, { ...handlers, listCapabilities: () => ({ descriptors: [{ key: 'bad' }] } as never) })).resolves.toEqual(expect.objectContaining({ ok: false, code: 'INVALID_IPC_RESPONSE' }));
    await expect(dispatchIpcMessage({ method: 'capabilities/list' }, { ...handlers, listCapabilities: () => ({ descriptors: [{ key: 'bad', status: 'available', owner: 'test', documentation: '/docs', removalCondition: 'remove', password: 'secret' }] } as never) })).resolves.toEqual(expect.objectContaining({ ok: false, code: 'INVALID_IPC_RESPONSE' }));
    await expect(dispatchIpcMessage({ method: 'credential/request', payload: { purpose: 'connection' } }, { ...handlers, credentialBroker: { request: async () => { throw new Error('secret unavailable'); } } as never })).resolves.toEqual(expect.objectContaining({ ok: false, code: 'IPC_OPERATION_FAILED', message: 'Electron operation failed.' }));
    broker.dispose();
  });

  it('routes only safe profile data and consumes a credential handle once', async () => {
    const broker = new MainCredentialBroker({ request: async () => 'secret' });
    const profile = { id: 'connection-1', name: 'Netezza', host: 'db', port: 5480, database: 'SYSTEM', user: 'admin', dbType: 'netezza', readOnly: true } as const;
    const createConnection = jest.fn(async (_input: unknown, requestId?: string) => {
      expect(requestId).toBe('opaque-request');
      return profile;
    });
    const handlers = {
      authStatus: () => ({ status: 'authenticated' as const }),
      credentialBroker: broker,
      listConnections: () => [],
      createConnection,
      updateConnection: async () => profile,
      deleteConnection: async () => undefined,
      testConnection: async () => undefined,
      testConnectionProfile: async () => undefined,
      listCapabilities: () => ({ descriptors: [] }),
    };
    await expect(dispatchIpcMessage({ method: 'connections/create', payload: {
      profile: { name: 'Netezza', host: 'db', port: 5480, database: 'SYSTEM', user: 'admin', dbType: 'netezza', readOnly: true },
      requestId: 'opaque-request',
    } }, handlers)).resolves.toEqual({ ok: true, profile });
    expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({ host: 'db' }), 'opaque-request');
    await expect(dispatchIpcMessage({ method: 'connections/create', payload: { profile: { name: 'Netezza', host: 'db', port: 5480, database: 'SYSTEM', user: 'admin', dbType: 'netezza', readOnly: true, password: 'secret' } } }, handlers)).resolves.toEqual(expect.objectContaining({ ok: false, code: 'SECRET_IN_IPC' }));
    await expect(dispatchIpcMessage({ method: 'connections/update', payload: { id: 'connection-1', profile: { name: 'Netezza', host: 'db', port: 5480, database: 'SYSTEM', user: 'admin', dbType: 'netezza', readOnly: true }, requestId: 'password-handle' } }, handlers)).resolves.toEqual(expect.objectContaining({ ok: false, code: 'INVALID_IPC_PAYLOAD' }));
    await expect(dispatchIpcMessage({ method: 'connections/delete', payload: { id: '' } }, handlers)).resolves.toEqual(expect.objectContaining({ ok: false, code: 'INVALID_IPC_PAYLOAD' }));
    broker.dispose();
  });

  it('exposes only the allowlisted preload methods and validates main responses', async () => {
    const calls: unknown[] = [];
    const bridge = createPreloadBridge(async message => {
      calls.push(message);
      if (message.method === 'auth/status') return { ok: true, auth: { status: 'authenticated' } };
      if (message.method === 'connections/list') return { ok: true, profiles: [] };
      if (message.method === 'capabilities/list') return { ok: true, capabilities: { descriptors: [] } };
      return { ok: true, requestId: 'opaque-id' };
    });
    await expect(bridge.getAuthState()).resolves.toEqual({ status: 'authenticated' });
    await expect(bridge.listConnections()).resolves.toEqual([]);
    await expect(bridge.listCapabilities()).resolves.toEqual({ descriptors: [] });
    expect(Object.keys(bridge)).toEqual(['getAuthState', 'requestCredential', 'listConnections', 'createConnection', 'updateConnection', 'deleteConnection', 'testConnection', 'testConnectionProfile', 'listCapabilities']);
    expect(JSON.stringify(bridge)).toBe('{}');
    expect(calls).toHaveLength(3);

    const malformed = createPreloadBridge(async () => 'not-an-object');
    await expect(malformed.getAuthState()).rejects.toThrow('Malformed response');
    const malformedProfiles = createPreloadBridge(async () => ({ ok: true, profiles: [{ id: 'bad', password: 'secret' }] }));
    await expect(malformedProfiles.listConnections()).rejects.toThrow('Malformed connection profiles');
    const malformedCapabilities = createPreloadBridge(async () => ({ ok: true, capabilities: { descriptors: [{ key: 'bad' }] } }));
    await expect(malformedCapabilities.listCapabilities()).rejects.toThrow('Malformed capability snapshot');
    const failed = createPreloadBridge(async () => ({ ok: false, code: 'FAILED', message: 'Request failed.' }));
    await expect(failed.getAuthState()).rejects.toThrow('Request failed.');
    const failedWithoutMessage = createPreloadBridge(async () => ({ ok: false, code: 'FAILED', message: 42 }));
    await expect(failedWithoutMessage.getAuthState()).rejects.toThrow('Electron operation failed.');
    const invalidAuth = createPreloadBridge(async () => ({ ok: true, auth: { status: 'not-authenticated' } }));
    await expect(invalidAuth.getAuthState()).rejects.toThrow('Malformed auth state');
    const validCredential = createPreloadBridge(async () => ({ ok: true, requestId: 'opaque-id' }));
    await expect(validCredential.requestCredential('connection')).resolves.toBe('opaque-id');
    const invalidCredential = createPreloadBridge(async () => ({ ok: true, requestId: 'database-password' }));
    await expect(invalidCredential.requestCredential('login')).rejects.toThrow('Malformed credential request');
  });
});
