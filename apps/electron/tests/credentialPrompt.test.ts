import { CREDENTIAL_PROMPT_CHANNEL } from '@justybase/contracts';
import { createNativeCredentialProvider } from '../src/main/credentialPrompt';

jest.mock('electron', () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const ipcMain: { on: jest.Mock; removeListener: jest.Mock; __listeners: typeof listeners } = {
    on: jest.fn((channel: string, listener: (...args: unknown[]) => void): void => { listeners.set(channel, listener); }),
    removeListener: jest.fn((channel: string): void => { listeners.delete(channel); }),
    __listeners: listeners,
  };
  const windows: MockBrowserWindow[] = [];
  class MockBrowserWindow {
    public readonly events = new Map<string, (...args: unknown[]) => void>();
    public readonly loadURL = jest.fn(async (_url: string) => undefined);
    public readonly show = jest.fn();
    public readonly close = jest.fn();
    public constructor(public readonly options: Record<string, unknown>) { windows.push(this); }
    public on(event: string, listener: (...args: unknown[]) => void): this { this.events.set(event, listener); return this; }
    public isDestroyed(): boolean { return false; }
  }
  return { BrowserWindow: MockBrowserWindow, ipcMain, __windows: windows };
});

describe('Electron native credential prompt', () => {
  afterEach(() => jest.clearAllMocks());

  it('keeps the password in the child window and resolves only a validated prompt message', async () => {
    const electron = jest.requireMock('electron') as {
      ipcMain: { __listeners: Map<string, (...args: unknown[]) => void> };
      __windows: Array<{ options: Record<string, unknown>; loadURL: jest.Mock; show: jest.Mock; close: jest.Mock; events: Map<string, (...args: unknown[]) => void> }>;
    };
    const provider = createNativeCredentialProvider({ preloadPath: '/tmp/credential-preload.js' });
    const pending = provider.request('connection');
    await Promise.resolve();
    const prompt = electron.__windows[0];
    expect(prompt?.options).toEqual(expect.objectContaining({ modal: false, show: false }));
    expect(prompt?.options.webPreferences).toEqual(expect.objectContaining({ contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '/tmp/credential-preload.js' }));
    prompt?.events.get('ready-to-show')?.();
    expect(prompt?.show).toHaveBeenCalledTimes(1);
    const html = decodeURIComponent(String(prompt?.loadURL.mock.calls[0]?.[0] ?? ''));
    const requestId = /data-request-id="([^"]+)"/u.exec(html)?.[1];
    expect(requestId).toBeTruthy();
    const listener = electron.ipcMain.__listeners.get(CREDENTIAL_PROMPT_CHANNEL);
    listener?.({}, { requestId: 'wrong-request', value: 'must-not-resolve', cancelled: false });
    let resolved = false;
    void pending.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    listener?.({}, { requestId, value: 'database-password-fixture', cancelled: false });
    await expect(pending).resolves.toBe('database-password-fixture');
    expect(prompt?.close).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it('cancels an open prompt and removes the dedicated IPC listener on disposal', async () => {
    const electron = jest.requireMock('electron') as {
      ipcMain: { removeListener: jest.Mock };
      __windows: Array<{ close: jest.Mock; events: Map<string, (...args: unknown[]) => void> }>;
    };
    const provider = createNativeCredentialProvider({ preloadPath: '/tmp/credential-preload.js' });
    const pending = provider.request('login');
    await Promise.resolve();
    provider.dispose();
    await expect(pending).resolves.toBeUndefined();
    expect(electron.__windows.at(-1)?.close).toHaveBeenCalledTimes(1);
    expect(electron.ipcMain.removeListener).toHaveBeenCalledWith(CREDENTIAL_PROMPT_CHANNEL, expect.any(Function));
  });
});
