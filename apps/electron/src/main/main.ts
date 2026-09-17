import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, autoUpdater, BrowserWindow, crashReporter, dialog, Menu, safeStorage, session } from 'electron';
import type { ElectronMenuMessage, OpaqueCredentialRequestId } from '@justybase/contracts';
import { MENU_ACTION_CHANNEL } from '@justybase/contracts';
import { CapabilityRegistry } from '@justybase/ui-core';
import { MainCredentialBroker } from './credentialBroker';
import { createNativeCredentialProvider } from './credentialPrompt';
import { registerIpcHandlers } from './ipc';
import { buildAppMenuTemplate } from './menu';
import { ensureSingleInstance, JUSTYBASE_PROTOCOL, createLaunchPathQueue, parseLaunchTargets, registerProtocolClient, sqlPathsFromTargets } from './productLifecycle';
import { redactConnectionProfile, redactConnectionProfiles } from './redaction';
import { createSqlFileService } from './sqlFileService';
import { startElectronSession, type ElectronSessionHandle } from './startup';
import { startUpdateManager, type UpdateManagerHandle } from './updateManager';

let runtime: ElectronSessionHandle | undefined;
const windows = new Set<BrowserWindow>();
/** OS file opens that arrive before any window can receive them. */
const pendingLaunchPaths = createLaunchPathQueue();
let ipcRegistration: { dispose(): void } | undefined;
let capabilityRegistry: CapabilityRegistry | undefined;
let credentialBroker: MainCredentialBroker | undefined;
let updateManager: UpdateManagerHandle | undefined;
let shutdownPromise: Promise<void> | undefined;
let quitPromise: Promise<void> | undefined;
let quitRequested = false;
let quitAllowed = false;

const ELECTRON_DATA_DIRECTORY = 'api';
const ELECTRON_MASTER_KEY_FILE = '.master-key';

/** Best-effort product crash reporting; never blocks startup. */
function startCrashReporting(): void {
  try {
    crashReporter.start({
      productName: 'JustyBase',
      companyName: 'JustyBase',
      submitURL: process.env.JUSTYBASE_CRASH_UPLOAD_URL ?? '',
      uploadToServer: Boolean(process.env.JUSTYBASE_CRASH_UPLOAD_URL),
    });
  } catch {
    // Crash reporting is unavailable in this host; the workspace still starts.
  }
}

startCrashReporting();

function focusedWindow(): BrowserWindow | undefined {
  try {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed()) return focused;
  } catch {
    // Fall through to the owned window set below.
  }
  for (const window of windows) {
    if (!window.isDestroyed()) return window;
  }
  return undefined;
}

interface MenuTarget {
  readonly isDestroyed: () => boolean;
  readonly webContents: { send(channel: string, message: unknown): void };
}

function sendMenuAction(window: MenuTarget | undefined, message: ElectronMenuMessage): void {
  if (!window) return;
  try {
    if (window.isDestroyed()) return;
    window.webContents.send(MENU_ACTION_CHANNEL, message);
  } catch {
    // A renderer that is still loading cannot receive pushes; cold-start
    // files travel through the window URL hash instead.
  }
}

function handleLaunchTargets(targets: { sqlFiles: readonly string[]; deepLinks: readonly string[] }): void {
  const paths = sqlPathsFromTargets(targets);
  const target = focusedWindow() ?? createWindow();
  if (!target || target.isDestroyed()) {
    // Runtime still starting (or the window failed): queue for the first
    // window instead of dropping the OS request.
    pendingLaunchPaths.push(paths);
    return;
  }
  target.focus();
  for (const filePath of paths) sendMenuAction(target, { action: 'open-file-path', filePath });
}

const primaryInstance = (() => {
  try {
    return ensureSingleInstance(app, handleLaunchTargets);
  } catch {
    process.stderr.write('Electron single-instance lock is unavailable; continuing as the primary instance.\n');
    return true;
  }
})();
if (!primaryInstance) {
  void app.whenReady().then(() => {
    quitAllowed = true;
    app.quit();
  });
}

async function loadOrCreateMasterKey(dataDirectory: string): Promise<string> {
  await mkdir(dataDirectory, { recursive: true });
  const keyPath = path.join(dataDirectory, ELECTRON_MASTER_KEY_FILE);
  try {
    const stored = (await readFile(keyPath, 'utf8')).trim();
    if (stored.startsWith('safe:')) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Electron safe storage is unavailable for the existing profile key.');
      return safeStorage.decryptString(Buffer.from(stored.slice('safe:'.length), 'base64'));
    }
    if (stored.length > 0) return stored;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const masterKey = randomBytes(32).toString('base64url');
  const storedKey = safeStorage.isEncryptionAvailable()
    ? `safe:${safeStorage.encryptString(masterKey).toString('base64')}`
    : masterKey;
  await writeFile(keyPath, `${storedKey}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }).catch(async error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  try {
    const persisted = (await readFile(keyPath, 'utf8')).trim();
    return persisted.startsWith('safe:') && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(persisted.slice('safe:'.length), 'base64'))
      : persisted;
  } catch {
    return masterKey;
  }
}

function localAdminPassword(masterKey: string): string {
  return createHash('sha256').update('justybase-electron-admin\0').update(masterKey, 'utf8').digest('base64url');
}

function credentialForRequest(broker: MainCredentialBroker, requestId: OpaqueCredentialRequestId | undefined): string | undefined {
  if (requestId === undefined) return undefined;
  const value = broker.consume(requestId);
  if (value === undefined) throw new Error('AUTH_CREDENTIAL_UNAVAILABLE');
  return value;
}

function installAppMenu(): void {
  try {
    // esbuild does not define NODE_ENV, so the packaged state is the only
    // reliable production signal; dev-only reload tooling must never ship.
    const isDev = process.env.NODE_ENV === 'development' || (process.env.NODE_ENV !== 'production' && !app.isPackaged);
    const template = buildAppMenuTemplate({
      appName: 'JustyBase',
      platform: process.platform,
      isDev,
      actions: {
        newWindow: () => { createWindow()?.focus(); },
        openFile: window => sendMenuAction(window ?? focusedWindow(), { action: 'open-file' }),
        saveFile: window => sendMenuAction(window ?? focusedWindow(), { action: 'save-file' }),
        saveFileAs: window => sendMenuAction(window ?? focusedWindow(), { action: 'save-file-as' }),
      },
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } catch {
    // A missing menu must not block the workspace; renderer shortcuts remain.
  }
}

function createWindow(initialSqlFiles: readonly string[] = []): BrowserWindow | undefined {
  const currentRuntime = runtime;
  if (!currentRuntime) return undefined;
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.resolve(__dirname, '../preload/preload.js'),
    },
  });
  windows.add(window);
  // Register before navigation: ready-to-show may be emitted while loadURL is
  // still pending, especially for a local renderer bundle.
  window.on('ready-to-show', () => {
    if (!quitRequested && !window.isDestroyed()) {
      window.show();
      // Flush OS requests that arrived while the renderer was loading; the
      // preload buffer replays anything still arriving before subscription.
      for (const filePath of pendingLaunchPaths.drain()) sendMenuAction(window, { action: 'open-file-path', filePath });
    }
  });
  window.on('closed', () => {
    windows.delete(window);
    if (windows.size === 0) {
      // Closing the last window must not leave a process alive with a
      // closed runtime and no way to recreate the shell.
      void requestQuit(true);
    }
  });
  const hash = initialSqlFiles.length > 0
    ? `#open-files=${encodeURIComponent(JSON.stringify(initialSqlFiles))}`
    : '';
  void window.loadURL(`${currentRuntime.url}/${hash}`).catch(error => {
    process.stderr.write(`Electron window failed to load: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  });
  return window;
}

async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    updateManager?.dispose();
    updateManager = undefined;
    ipcRegistration?.dispose();
    ipcRegistration = undefined;
    credentialBroker?.dispose();
    credentialBroker = undefined;
    capabilityRegistry?.dispose();
    capabilityRegistry = undefined;
    const currentRuntime = runtime;
    try {
      await currentRuntime?.close();
    } finally {
      runtime = undefined;
      windows.clear();
    }
  })();
  await shutdownPromise;
}

async function requestQuit(waitForStartup: boolean): Promise<void> {
  if (quitPromise) return quitPromise;
  quitRequested = true;
  const pendingStartup = waitForStartup ? startupPromise : undefined;
  quitPromise = (async () => {
    await pendingStartup?.catch(() => undefined);
    await shutdown().catch(error => {
      process.stderr.write(`Electron shutdown failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    });
    quitAllowed = true;
    app.quit();
  })();
  await quitPromise;
}

async function start(): Promise<void> {
  if (!primaryInstance) return;
  await app.whenReady();
  if (quitRequested) return;
  registerProtocolClient(app);
  const dataDirectory = process.env.JUSTYBASE_ELECTRON_DATA_DIR
    ?? path.join(app.getPath('userData'), ELECTRON_DATA_DIRECTORY);
  const masterKey = await loadOrCreateMasterKey(dataDirectory);
  const startedRuntime = await startElectronSession({
    dataDirectory,
    webDistDirectory: process.env.JUSTYBASE_ELECTRON_WEB_DIST ?? path.resolve(__dirname, '../renderer'),
    masterKey,
    adminUsername: 'electron-local-admin',
    adminPassword: localAdminPassword(masterKey),
    ...(process.env.JUSTYBASE_ELECTRON_PROVISION_SQLITE === '1' ? { provisionSqliteFixture: true } : {}),
  });
  if (quitRequested) {
    await startedRuntime.close();
    return;
  }
  runtime = startedRuntime;
  const currentRuntime = runtime;
  if (!currentRuntime) throw new Error('Electron runtime failed to initialize.');
  const capabilities = new CapabilityRegistry(currentRuntime.bootstrap.capabilities.descriptors);
  capabilityRegistry = capabilities;
  const broker = new MainCredentialBroker(createNativeCredentialProvider({
    owner: () => focusedWindow(),
    preloadPath: path.resolve(__dirname, '../preload/credentialPromptPreload.js'),
  }));
  credentialBroker = broker;
  await currentRuntime.applyAuthenticationCookie({ set: details => session.defaultSession.cookies.set(details) });
  const sqlFiles = createSqlFileService({
    dialog,
    owner: () => focusedWindow(),
    fs: {
      readFile: (filePath, encoding) => readFile(filePath, encoding),
      writeFile: (filePath, content, encoding) => writeFile(filePath, content, encoding),
      statSize: async filePath => (await stat(filePath)).size,
      byteLength: content => Buffer.byteLength(content, 'utf8'),
    },
  });
  ipcRegistration = registerIpcHandlers({
    authStatus: () => ({ status: 'authenticated', sessionId: currentRuntime.bootstrap.sessionId }),
    credentialBroker: broker,
    listConnections: async () => redactConnectionProfiles(await currentRuntime.requestJson<readonly unknown[]>('/api/connections')),
    createConnection: async (input, requestId) => {
      const password = credentialForRequest(broker, requestId);
      const profile = await currentRuntime.requestJson<unknown>('/api/connections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, ...(password === undefined ? {} : { password }) }),
      });
      return redactConnectionProfile(profile);
    },
    updateConnection: async (id, input, requestId) => {
      const password = credentialForRequest(broker, requestId);
      const profile = await currentRuntime.requestJson<unknown>(`/api/connections/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, ...(password === undefined ? {} : { password }) }),
      });
      return redactConnectionProfile(profile);
    },
    deleteConnection: async id => {
      await currentRuntime.requestJson(`/api/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    testConnection: async id => {
      await currentRuntime.requestJson(`/api/connections/${encodeURIComponent(id)}/test`, { method: 'POST' });
    },
    testConnectionProfile: async (input, requestId) => {
      const password = credentialForRequest(broker, requestId);
      await currentRuntime.requestJson('/api/connections/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, ...(password === undefined ? {} : { password }) }),
      });
    },
    listCapabilities: () => ({ descriptors: capabilities.list() }),
    openSqlFile: () => sqlFiles.openSqlFile(),
    openSqlFilePath: filePath => sqlFiles.openSqlFilePath(filePath),
    saveSqlFile: (filePath, content) => sqlFiles.saveSqlFile(filePath, content),
    saveSqlFileAs: (suggestedName, content) => sqlFiles.saveSqlFileAs(suggestedName, content),
    requestNewWindow: async () => { createWindow()?.focus(); },
  });
  installAppMenu();
  updateManager = startUpdateManager({
    autoUpdater,
    dialog,
    owner: () => focusedWindow(),
    feedUrl: process.env.JUSTYBASE_UPDATE_FEED_URL,
    productName: 'JustyBase',
  });
  const launchTargets = parseLaunchTargets(process.argv.slice(1));
  const initialFiles = [...new Set([...sqlPathsFromTargets(launchTargets), ...pendingLaunchPaths.drain()])];
  const initialWindow = createWindow(initialFiles);
  if (!initialWindow) throw new Error('Electron window failed to initialize.');
  // Showing only after the authenticated cookie and preload bridge are ready
  // prevents an unauthenticated renderer flash.
  // The listener above is intentionally attached before loadURL.
}

app.on('before-quit', event => {
  if (quitAllowed) return;
  event.preventDefault();
  void requestQuit(true);
});
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (typeof filePath === 'string') handleLaunchTargets({ sqlFiles: [filePath], deepLinks: [] });
});
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (typeof url === 'string') handleLaunchTargets({ sqlFiles: [], deepLinks: [url] });
});
void app.whenReady().then(() => {
  // Protocol registration is best-effort and must not block window creation.
  registerProtocolClient(app);
});
const startupPromise = start().catch(async error => {
  await shutdown().catch(() => undefined);
  process.stderr.write(`${error instanceof Error ? error.message : 'Electron startup failed.'}\n`);
  // Do not wait for a quit request that is already waiting for startup; that
  // would make the startup promise and quit promise wait on each other.
  if (!quitPromise) void requestQuit(false);
});

export { JUSTYBASE_PROTOCOL };
