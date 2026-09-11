jest.mock('electron', () => {
  const appEvents = new Map<string, () => void>();
  const app = {
    whenReady: jest.fn(async () => undefined),
    once: jest.fn((event: string, listener: () => void) => { appEvents.set(event, listener); }),
    quit: jest.fn(),
    __events: appEvents,
  };
  const windows: MockBrowserWindow[] = [];
  class MockBrowserWindow {
    public readonly events = new Map<string, () => void>();
    public readonly loadURL = jest.fn(async () => undefined);
    public readonly show = jest.fn();
    public constructor() { windows.push(this); }
    public on(event: string, listener: () => void): void { this.events.set(event, listener); }
  }
  return {
    app,
    BrowserWindow: MockBrowserWindow,
    __windows: windows,
    ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
    session: { defaultSession: { cookies: { set: jest.fn(async () => undefined) } } },
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
  it('starts an authenticated window and shuts down all main-owned resources once', async () => {
    await import('../src/main/main');
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));

    const electron = jest.requireMock('electron') as {
      app: { __events: Map<string, () => void> };
      __windows: Array<{ events: Map<string, () => void>; loadURL: jest.Mock; show: jest.Mock }>;
      ipcMain: { handle: jest.Mock; removeHandler: jest.Mock };
      session: { defaultSession: { cookies: { set: jest.Mock } } };
    };
    const startup = jest.requireMock('../src/main/startup') as { __runtime: { applyAuthenticationCookie: jest.Mock; close: jest.Mock } };
    const windowInstance = electron.__windows[0];
    expect(windowInstance?.loadURL).toHaveBeenCalledWith('http://127.0.0.1:43123/');
    windowInstance?.events.get('ready-to-show')?.();
    expect(windowInstance?.show).toHaveBeenCalledTimes(1);
    expect(startup.__runtime.applyAuthenticationCookie).toHaveBeenCalledTimes(1);
    expect(electron.ipcMain.handle).toHaveBeenCalledWith('ui:request', expect.any(Function));

    electron.app.__events.get('before-quit')?.();
    windowInstance?.events.get('closed')?.();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(startup.__runtime.close).toHaveBeenCalledTimes(1);
    expect(electron.ipcMain.removeHandler).toHaveBeenCalledTimes(1);
  });
});
