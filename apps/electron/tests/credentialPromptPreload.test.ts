jest.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: jest.fn() },
  ipcRenderer: { send: jest.fn() },
}));

describe('Electron credential prompt preload', () => {
  it('exposes only the narrow submit surface and forwards no application IPC method', async () => {
    const electron = jest.requireMock('electron') as { contextBridge: { exposeInMainWorld: jest.Mock }; ipcRenderer: { send: jest.Mock } };
    await import('../src/preload/credentialPromptPreload');
    const exposed = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as { submit(requestId: unknown, value: unknown, cancelled: unknown): void };
    exposed.submit('request-1', 'secret', false);
    exposed.submit('', 'ignored', false);
    exposed.submit('request-2', 'ignored', 'not-bool');
    expect(electron.ipcRenderer.send).toHaveBeenCalledTimes(1);
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith('justybase:credential-prompt', { requestId: 'request-1', value: 'secret', cancelled: false });
  });
});
