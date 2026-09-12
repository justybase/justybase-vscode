import { rmSync } from 'node:fs';

jest.mock('electron', () => {
  const appEvents = new Map<string, (...args: unknown[]) => void>();
  const app = {
    whenReady: jest.fn(async () => undefined),
    getPath: jest.fn(() => '/tmp/justybase-electron-main-test'),
    on: jest.fn((event: string, listener: (...args: unknown[]) => void) => { appEvents.set(event, listener); }),
    quit: jest.fn(),
    __events: appEvents,
  };
  const windows: MockBrowserWindow[] = [];
  class MockBrowserWindow {
    public readonly events = new Map<string, (...args: unknown[]) => void>();
    public readonly loadURL = jest.fn(async () => { this.events.get('ready-to-show')?.(); });
    public readonly show = jest.fn();
    public constructor() { windows.push(this); }
    public on(event: string, listener: (...args: unknown[]) => void): void { this.events.set(event, listener); }
  }
  return {
    app,
    BrowserWindow: MockBrowserWindow,
    __windows: windows,
    ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
    session: { defaultSession: { cookies: { set: jest.fn(async () => undefined) } } },
    safeStorage: {
      isEncryptionAvailable: jest.fn(() => false),
      encryptString: jest.fn((value: string) => Buffer.from(value, 'utf8')),
      decryptString: jest.fn((value: Buffer) => value.toString('utf8')),
    },
  };
});

jest.mock('../src/main/startup', () => {
  const runtime = {
    url: 'http://127.0.0.1:43123',
    bootstrap: { contractVersion: 1, productId: 'electron', sessionId: 'session-1', capabilities: { descriptors: [{ key: 'workspace', status: 'available', owner: 'test', documentation: '/docs', removalCondition: 'keep' }] } },
    applyAuthenticationCookie: jest.fn(async () => undefined),
    requestJson: jest.fn(async () => []),
    close: jest.fn(async () => undefined),
  };
  return { startElectronSession: jest.fn(async () => runtime), __runtime: runtime };
});

describe('Electron main composition root', () => {
  afterAll(() => rmSync('/tmp/justybase-electron-main-test', { recursive: true, force: true }));

  it('starts an authenticated window and shuts down all main-owned resources once', async () => {
    await import('../src/main/main');
    const startup = jest.requireMock('../src/main/startup') as { startElectronSession: jest.Mock; __runtime: { applyAuthenticationCookie: jest.Mock; close: jest.Mock } };
    const electron = jest.requireMock('electron') as {
      app: { __events: Map<string, (...args: unknown[]) => void>; quit: jest.Mock };
      __windows: Array<{ events: Map<string, (...args: unknown[]) => void>; loadURL: jest.Mock; show: jest.Mock }>;
      ipcMain: { handle: jest.Mock; removeHandler: jest.Mock };
      session: { defaultSession: { cookies: { set: jest.Mock } } };
    };
    for (let attempt = 0; attempt < 2_000 && (electron.__windows[0] === undefined || electron.__windows[0].loadURL.mock.calls.length === 0); attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const windowInstance = electron.__windows[0];
    expect(windowInstance?.loadURL).toHaveBeenCalledWith('http://127.0.0.1:43123/');
    expect(windowInstance?.show).toHaveBeenCalledTimes(1);
    expect(startup.__runtime.applyAuthenticationCookie).toHaveBeenCalledTimes(1);
    expect(electron.ipcMain.handle).toHaveBeenCalledWith('ui:request', expect.any(Function));

    let resolveClose!: () => void;
    startup.__runtime.close.mockImplementation(() => new Promise<void>(resolve => { resolveClose = resolve; }));
    const preventDefault = jest.fn();
    electron.app.__events.get('before-quit')?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(startup.__runtime.close).toHaveBeenCalledTimes(1);
    expect(electron.app.quit).not.toHaveBeenCalled();
    resolveClose();
    windowInstance?.events.get('closed')?.();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(startup.__runtime.close).toHaveBeenCalledTimes(1);
    expect(electron.ipcMain.removeHandler).toHaveBeenCalledTimes(1);
    expect(electron.app.quit).toHaveBeenCalledTimes(1);
  });
});
