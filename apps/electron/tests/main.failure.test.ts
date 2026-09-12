describe('Electron startup failure boundary', () => {
  it('closes the partially initialized composition and asks Electron to quit', async () => {
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    jest.doMock('electron', () => ({
      app: {
        whenReady: jest.fn(async () => undefined),
        getPath: jest.fn(() => '/tmp/justybase-electron-main-failure-test'),
        on: jest.fn(),
        quit: jest.fn(),
      },
      BrowserWindow: class MockBrowserWindow {},
      ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
      session: { defaultSession: { cookies: { set: jest.fn(async () => undefined) } } },
      safeStorage: {
        isEncryptionAvailable: jest.fn(() => false),
        encryptString: jest.fn((value: string) => Buffer.from(value, 'utf8')),
        decryptString: jest.fn((value: Buffer) => value.toString('utf8')),
      },
    }));
    jest.doMock('../src/main/startup', () => ({
      startElectronSession: jest.fn(async () => { throw new Error('startup failed'); }),
    }));
    jest.resetModules();
    await import('../src/main/main');
    for (let attempt = 0; attempt < 50 && write.mock.calls.length === 0; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(write).toHaveBeenCalledWith('startup failed\n');
    const electron = jest.requireMock('electron') as { app: { quit: jest.Mock } };
    expect(electron.app.quit).toHaveBeenCalledTimes(1);
    write.mockRestore();
  });
});
