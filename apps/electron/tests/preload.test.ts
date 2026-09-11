jest.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: jest.fn() },
  ipcRenderer: { invoke: jest.fn(async () => ({ ok: true, auth: { status: 'authenticated' } })) },
}));

describe('Electron preload entrypoint', () => {
  it('exposes only the validated renderer bridge on the expected global name', async () => {
    const electron = jest.requireMock('electron') as { contextBridge: { exposeInMainWorld: jest.Mock }; ipcRenderer: { invoke: jest.Mock } };
    await import('../src/preload/preload');
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith('justybaseElectron', expect.any(Object));
    const bridge = electron.contextBridge.exposeInMainWorld.mock.calls[0][1] as { getAuthState(): Promise<unknown> };
    await expect(bridge.getAuthState()).resolves.toEqual({ status: 'authenticated' });
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('ui:request', { method: 'auth/status' });
  });
});
