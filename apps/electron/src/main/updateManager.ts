/**
 * Product update checks built on Electron's bundled autoUpdater (Squirrel).
 * No additional dependency; every collaborator is injected so the manager is
 * unit-testable without an Electron runtime. When no feed URL is configured
 * the manager is a documented no-op and startup continues unchanged.
 */

export interface UpdateAutoUpdater {
  on(event: 'update-downloaded' | 'error', listener: (...args: unknown[]) => void): void;
  setFeedURL(options: { readonly url: string }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
}

export interface UpdateDialog {
  showMessageBox(
    owner: unknown,
    options: { readonly type?: string; readonly title?: string; readonly message: string; readonly buttons: string[] },
  ): Promise<{ readonly response: number }>;
}

export interface UpdateManagerOptions {
  readonly autoUpdater: UpdateAutoUpdater;
  readonly dialog: UpdateDialog;
  readonly owner: () => unknown;
  /** Squirrel feed URL; when omitted the manager stays idle by design. */
  readonly feedUrl?: string;
  readonly checkIntervalMs?: number;
  readonly productName?: string;
}

export interface UpdateManagerHandle {
  /** True when a feed URL was configured and checks were scheduled. */
  readonly enabled: boolean;
  dispose(): void;
}

const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function settle(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

export function startUpdateManager(options: UpdateManagerOptions): UpdateManagerHandle {
  const feedUrl = (options.feedUrl ?? '').trim();
  if (!feedUrl) return { enabled: false, dispose: () => undefined };
  const checkIntervalMs = Math.max(60_000, Math.floor(options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS));
  const productName = options.productName ?? 'JustyBase';
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  try {
    options.autoUpdater.setFeedURL({ url: feedUrl });
  } catch {
    return { enabled: false, dispose: () => undefined };
  }

  const check = (): void => {
    if (disposed) return;
    try {
      options.autoUpdater.checkForUpdates();
    } catch {
      // Update checks are best-effort and must never disturb the workspace.
    }
  };

  options.autoUpdater.on('update-downloaded', () => {
    if (disposed) return;
    settle(
      options.dialog
        .showMessageBox(options.owner(), {
          type: 'info',
          title: `${productName} update ready`,
          message: `A ${productName} update has been downloaded. Restart now to install it?`,
          buttons: ['Restart now', 'Later'],
        })
        .then(({ response }) => {
          if (!disposed && response === 0) options.autoUpdater.quitAndInstall();
        }),
    );
  });
  options.autoUpdater.on('error', () => undefined);

  check();
  timer = setInterval(check, checkIntervalMs);
  if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof (timer as { unref?: unknown }).unref === 'function') {
    (timer as unknown as { unref(): void }).unref();
  }

  return {
    enabled: true,
    dispose: () => {
      disposed = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
