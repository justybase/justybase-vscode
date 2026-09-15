import { dispatchIpcMessage } from '../src/main/ipcProtocol';
import type { IpcHandlers } from '../src/main/ipcProtocol';
import { MainCredentialBroker } from '../src/main/credentialBroker';

function handlers(overrides: Partial<IpcHandlers> = {}): IpcHandlers {
  const broker = new MainCredentialBroker({ request: async () => 'fixture-secret' });
  return {
    authStatus: () => ({ status: 'authenticated' }),
    credentialBroker: broker,
    listConnections: () => [],
    createConnection: async () => ({ id: 'connection-1', name: 'SQLite', host: 'local', port: 0, database: ':memory:', user: 'local', dbType: 'sqlite', readOnly: true }),
    updateConnection: async () => ({ id: 'connection-1', name: 'SQLite', host: 'local', port: 0, database: ':memory:', user: 'local', dbType: 'sqlite', readOnly: true }),
    deleteConnection: async () => undefined,
    testConnection: async () => undefined,
    testConnectionProfile: async () => undefined,
    listCapabilities: () => ({ descriptors: [] }),
    openSqlFile: async () => null,
    saveSqlFile: async filePath => ({ filePath, fileName: 'report.sql', sizeBytes: 9 }),
    saveSqlFileAs: async () => null,
    ...overrides,
  };
}

describe('Electron SQL file IPC', () => {
  it('opens a file and returns the contract payload', async () => {
    const file = { filePath: '/tmp/report.sql', fileName: 'report.sql', content: 'SELECT 1;', sizeBytes: 9, oversize: false };
    const response = await dispatchIpcMessage({ method: 'filesystem/open-sql' }, handlers({ openSqlFile: async () => file }));
    expect(response).toEqual({ ok: true, file });
  });

  it('rejects payloads on open and validates save payloads', async () => {
    const base = handlers();
    await expect(dispatchIpcMessage({ method: 'filesystem/open-sql', payload: {} }, base)).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_IPC_PAYLOAD',
    });
    await expect(dispatchIpcMessage({ method: 'filesystem/save-sql', payload: { filePath: '/tmp/notes.txt', content: 'x' } }, base)).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_IPC_PAYLOAD',
    });
    await expect(dispatchIpcMessage({ method: 'filesystem/save-sql', payload: { filePath: '/tmp/report.sql' } }, base)).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_IPC_PAYLOAD',
    });
    await expect(dispatchIpcMessage({ method: 'filesystem/save-sql-as', payload: {} }, base)).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_IPC_PAYLOAD',
    });
  });

  it('saves and saves-as through validated handlers', async () => {
    const saveSqlFile = jest.fn(async (filePath: string) => ({ filePath, fileName: 'report.sql', sizeBytes: 9 }));
    const saveSqlFileAs = jest.fn(async () => ({ filePath: '/tmp/export.sql', fileName: 'export.sql', sizeBytes: 9 }));
    const base = handlers({ saveSqlFile, saveSqlFileAs });
    await expect(
      dispatchIpcMessage({ method: 'filesystem/save-sql', payload: { filePath: '/tmp/report.sql', content: 'SELECT 1;' } }, base),
    ).resolves.toEqual({ ok: true, saved: { filePath: '/tmp/report.sql', fileName: 'report.sql', sizeBytes: 9 } });
    await expect(
      dispatchIpcMessage({ method: 'filesystem/save-sql-as', payload: { suggestedName: 'export.sql', content: 'SELECT 1;' } }, base),
    ).resolves.toEqual({ ok: true, saved: { filePath: '/tmp/export.sql', fileName: 'export.sql', sizeBytes: 9 } });
    expect(saveSqlFile).toHaveBeenCalledWith('/tmp/report.sql', 'SELECT 1;');
    expect(saveSqlFileAs).toHaveBeenCalledWith('export.sql', 'SELECT 1;');
  });

  it('rejects secret-shaped file payloads before invoking main handlers', async () => {
    const openSqlFile = jest.fn(async () => null);
    const response = await dispatchIpcMessage(
      { method: 'filesystem/save-sql', payload: { filePath: '/tmp/report.sql', content: 'x', password: 'secret' } },
      handlers({ openSqlFile }),
    );
    expect(response).toMatchObject({ ok: false, code: 'SECRET_IN_IPC' });
    expect(openSqlFile).not.toHaveBeenCalled();
  });

  it('surfaces main failures without leaking secret-shaped messages', async () => {
    const base = handlers({
      saveSqlFile: async () => {
        throw new Error('disk password failure');
      },
    });
    await expect(
      dispatchIpcMessage({ method: 'filesystem/save-sql', payload: { filePath: '/tmp/report.sql', content: 'x' } }, base),
    ).resolves.toEqual({ ok: false, code: 'IPC_OPERATION_FAILED', message: 'Electron operation failed.' });
  });
});
