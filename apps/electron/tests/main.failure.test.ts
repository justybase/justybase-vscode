jest.mock('electron', () => ({
  app: {
    whenReady: jest.fn(async () => undefined),
    once: jest.fn(),
    quit: jest.fn(),
  },
  BrowserWindow: class MockBrowserWindow {},
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
  session: { defaultSession: { cookies: { set: jest.fn(async () => undefined) } } },
}));

jest.mock('../src/main/startup', () => ({
  startElectronSession: jest.fn(async () => { throw new Error('startup failed'); }),
}));

describe('Electron startup failure boundary', () => {
  it('closes the partially initialized composition and asks Electron to quit', async () => {
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await import('../src/main/main');
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    const electron = jest.requireMock('electron') as { app: { quit: jest.Mock } };
    expect(write).toHaveBeenCalledWith('startup failed\n');
    expect(electron.app.quit).toHaveBeenCalledTimes(1);
    write.mockRestore();
  });
});
