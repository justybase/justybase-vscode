import { MainCredentialBroker } from '../src/main/credentialBroker';
import { registerIpcHandlers } from '../src/main/ipc';

jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn(),
    removeHandler: jest.fn(),
  },
}));

describe('Electron IPC registration lifecycle', () => {
  it('registers the allowlisted channel and removes it idempotently', async () => {
    const electron = jest.requireMock('electron') as { ipcMain: { handle: jest.Mock; removeHandler: jest.Mock } };
    const broker = new MainCredentialBroker({ request: async () => 'fixture-secret' });
    const registration = registerIpcHandlers({
      authStatus: () => ({ status: 'authenticated' }),
      credentialBroker: broker,
      listConnections: () => [],
      listCapabilities: () => ({ descriptors: [] }),
    });
    expect(electron.ipcMain.handle).toHaveBeenCalledWith('ui:request', expect.any(Function));
    const listener = electron.ipcMain.handle.mock.calls[0][1] as (_event: unknown, message: unknown) => Promise<unknown>;
    await expect(listener({}, { method: 'auth/status' })).resolves.toEqual({ ok: true, auth: { status: 'authenticated' } });
    registration.dispose();
    registration.dispose();
    expect(electron.ipcMain.removeHandler).toHaveBeenCalledTimes(1);
    broker.dispose();
  });
});
