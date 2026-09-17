import { isElectronMenuMessage, MENU_ACTION_CHANNEL } from '@justybase/contracts';
import type { ElectronMenuMessage } from '@justybase/contracts';

export { MENU_ACTION_CHANNEL };

export type MenuEventSubscriber = (
  channel: string,
  listener: (event: unknown, message: unknown) => void,
) => () => void;

export type MenuActionHandler = (message: ElectronMenuMessage) => void;

/** Upper bound for actions buffered before the renderer subscribes. */
export const MAX_BUFFERED_MENU_ACTIONS = 20 as const;

/**
 * Allowlisted main-to-renderer subscription. The channel listener is attached
 * immediately (preload load, before React mounts) so OS file opens that race
 * renderer startup are buffered instead of lost. Malformed or secret-bearing
 * messages are dropped before they reach the renderer.
 */
export function createMenuActionSubscription(subscribe: MenuEventSubscriber): {
  readonly onMenuAction: (handler: MenuActionHandler) => () => void;
} {
  const buffered: ElectronMenuMessage[] = [];
  let handler: MenuActionHandler | undefined;
  subscribe(MENU_ACTION_CHANNEL, (_event, message) => {
    if (!isElectronMenuMessage(message)) return;
    const current = handler;
    if (current) current(message);
    else if (buffered.length < MAX_BUFFERED_MENU_ACTIONS) buffered.push(message);
  });
  return Object.freeze({
    onMenuAction: (next: MenuActionHandler): (() => void) => {
      if (typeof next !== 'function') throw new Error('Menu action handler is required.');
      if (handler) throw new Error('Menu action handler is already registered.');
      handler = next;
      const replay = buffered.splice(0, buffered.length);
      for (const message of replay) handler(message);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (handler === next) handler = undefined;
      };
    },
  });
}
