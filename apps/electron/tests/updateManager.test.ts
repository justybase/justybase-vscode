import { startUpdateManager } from '../src/main/updateManager';

function harness() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const autoUpdater = {
    on: jest.fn((event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); }),
    setFeedURL: jest.fn(),
    checkForUpdates: jest.fn(),
    quitAndInstall: jest.fn(),
  };
  const dialog = { showMessageBox: jest.fn(async () => ({ response: 1 })) };
  return { autoUpdater, dialog, listeners };
}

describe('Electron update manager', () => {
  it('stays idle without a configured feed URL', () => {
    const { autoUpdater } = harness();
    const handle = startUpdateManager({ autoUpdater, dialog: { showMessageBox: jest.fn() }, owner: () => null });
    expect(handle.enabled).toBe(false);
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('checks on start and restarts only on explicit confirmation', async () => {
    jest.useFakeTimers();
    try {
      const { autoUpdater, dialog, listeners } = harness();
      const handle = startUpdateManager({
        autoUpdater,
        dialog,
        owner: () => null,
        feedUrl: 'https://updates.example.test/feed',
        checkIntervalMs: 60_000,
        productName: 'JustyBase',
      });
      expect(handle.enabled).toBe(true);
      expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({ url: 'https://updates.example.test/feed' });
      expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

      listeners.get('update-downloaded')?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
      expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();

      dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
      listeners.get('update-downloaded')?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
      handle.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('never throws update errors into the workspace', () => {
    const offline = harness();
    offline.autoUpdater.setFeedURL.mockImplementation(() => { throw new Error('offline'); });
    expect(startUpdateManager({ autoUpdater: offline.autoUpdater, dialog: offline.dialog, owner: () => null, feedUrl: 'https://x.test' }).enabled).toBe(false);

    const working = harness();
    const handle = startUpdateManager({ autoUpdater: working.autoUpdater, dialog: working.dialog, owner: () => null, feedUrl: 'https://x.test', checkIntervalMs: 60_000 });
    expect(() => working.listeners.get('error')?.(new Error('feed unreachable'))).not.toThrow();
    working.autoUpdater.checkForUpdates.mockImplementation(() => { throw new Error('offline'); });
    handle.dispose();
  });
});
