import { createMenuActionSubscription, MENU_ACTION_CHANNEL } from '../src/preload/menuActions';

describe('Electron menu-action preload subscription', () => {
  it('delivers validated actions and drops malformed or secret-bearing messages', () => {
    const listeners = new Map<string, (event: unknown, message: unknown) => void>();
    const subscribe = (channel: string, listener: (event: unknown, message: unknown) => void): (() => void) => {
      listeners.set(channel, listener);
      return () => { listeners.delete(channel); };
    };
    const seen: unknown[] = [];
    const unsubscribe = createMenuActionSubscription(subscribe).onMenuAction(message => { seen.push(message); });
    const emit = (message: unknown): void => listeners.get(MENU_ACTION_CHANNEL)?.({}, message);

    emit({ action: 'open-file' });
    emit({ action: 'open-file-path', filePath: '/tmp/report.sql' });
    emit({ action: 'quit-app' });
    emit({ action: 'open-file-path', filePath: '/tmp/report.csv' });
    emit({ action: 'open-file-path' });
    emit({ action: 'open-file', filePath: '/tmp/report.sql' });
    emit({ action: 'save-file', password: 'secret' });
    emit(null);
    expect(seen).toEqual([{ action: 'open-file' }, { action: 'open-file-path', filePath: '/tmp/report.sql' }]);
    unsubscribe();
    expect(listeners.size).toBe(1);
  });

  it('buffers actions that arrive before the renderer subscribes and replays them once', () => {
    const listeners = new Map<string, (event: unknown, message: unknown) => void>();
    const subscribe = (channel: string, listener: (event: unknown, message: unknown) => void): (() => void) => {
      listeners.set(channel, listener);
      return () => { listeners.delete(channel); };
    };
    const subscription = createMenuActionSubscription(subscribe);
    listeners.get(MENU_ACTION_CHANNEL)?.({}, { action: 'open-file-path', filePath: '/tmp/early.sql' });
    listeners.get(MENU_ACTION_CHANNEL)?.({}, { action: 'quit-app' });
    const seen: unknown[] = [];
    const unsubscribe = subscription.onMenuAction(message => { seen.push(message); });
    expect(seen).toEqual([{ action: 'open-file-path', filePath: '/tmp/early.sql' }]);
    listeners.get(MENU_ACTION_CHANNEL)?.({}, { action: 'save-file' });
    expect(seen).toHaveLength(2);
    unsubscribe();
    listeners.get(MENU_ACTION_CHANNEL)?.({}, { action: 'open-file' });
    expect(seen).toHaveLength(2);
    const reseated: unknown[] = [];
    subscription.onMenuAction(message => { reseated.push(message); });
    expect(reseated).toEqual([{ action: 'open-file' }]);
  });

  it('requires a handler function', () => {
    expect(() => createMenuActionSubscription(() => () => undefined).onMenuAction(undefined as never)).toThrow('Menu action handler is required.');
  });
});
