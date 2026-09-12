import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, safeStorage, session } from 'electron';
import type { OpaqueCredentialRequestId } from '@justybase/contracts';
import { CapabilityRegistry } from '@justybase/ui-core';
import { MainCredentialBroker } from './credentialBroker';
import { createNativeCredentialProvider } from './credentialPrompt';
import { registerIpcHandlers } from './ipc';
import { redactConnectionProfile, redactConnectionProfiles } from './redaction';
import { startElectronSession, type ElectronSessionHandle } from './startup';

let runtime: ElectronSessionHandle | undefined;
let window: BrowserWindow | undefined;
let ipcRegistration: { dispose(): void } | undefined;
let capabilityRegistry: CapabilityRegistry | undefined;
let credentialBroker: MainCredentialBroker | undefined;
let shutdownPromise: Promise<void> | undefined;
let quitPromise: Promise<void> | undefined;
let quitRequested = false;
let quitAllowed = false;

const ELECTRON_DATA_DIRECTORY = 'api';
const ELECTRON_MASTER_KEY_FILE = '.master-key';

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

async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
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
      window = undefined;
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
  await app.whenReady();
  if (quitRequested) return;
  const dataDirectory = process.env.JUSTYBASE_ELECTRON_DATA_DIR
    ?? path.join(app.getPath('userData'), ELECTRON_DATA_DIRECTORY);
  const masterKey = await loadOrCreateMasterKey(dataDirectory);
  const startedRuntime = await startElectronSession({
    dataDirectory,
    webDistDirectory: process.env.JUSTYBASE_ELECTRON_WEB_DIST ?? path.resolve(__dirname, '../renderer'),
    masterKey,
    adminUsername: 'electron-local-admin',
    adminPassword: localAdminPassword(masterKey),
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
  window = new BrowserWindow({
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
  const currentWindow = window;
  if (!currentWindow) throw new Error('Electron window failed to initialize.');
  const broker = new MainCredentialBroker(createNativeCredentialProvider({
    owner: () => window,
    preloadPath: path.resolve(__dirname, '../preload/credentialPromptPreload.js'),
  }));
  credentialBroker = broker;
  // Register before navigation: ready-to-show may be emitted while loadURL is
  // still pending, especially for a local renderer bundle.
  currentWindow.on('ready-to-show', () => {
    if (!quitRequested) currentWindow.show();
  });
  currentWindow.on('closed', () => {
    if (window === currentWindow) window = undefined;
    // Closing the only window must not leave a macOS process alive with a
    // closed runtime and no way to recreate the shell.
    void requestQuit(true);
  });
  await currentRuntime.applyAuthenticationCookie({ set: details => session.defaultSession.cookies.set(details) });
  ipcRegistration = registerIpcHandlers({
    authStatus: () => ({ status: 'authenticated', sessionId: currentRuntime.bootstrap.sessionId }),
    credentialBroker: broker,
    listConnections: async () => redactConnectionProfiles(await currentRuntime.requestJson<readonly unknown[]>('/api/connections')),
    createConnection: async (input, requestId) => {
      let password = credentialForRequest(broker, requestId);
      try {
        const profile = await currentRuntime.requestJson<unknown>('/api/connections', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...input, ...(password === undefined ? {} : { password }) }),
        });
        return redactConnectionProfile(profile);
      } finally {
        password = undefined;
      }
    },
    updateConnection: async (id, input, requestId) => {
      let password = credentialForRequest(broker, requestId);
      try {
        const profile = await currentRuntime.requestJson<unknown>(`/api/connections/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...input, ...(password === undefined ? {} : { password }) }),
        });
        return redactConnectionProfile(profile);
      } finally {
        password = undefined;
      }
    },
    deleteConnection: async id => {
      await currentRuntime.requestJson(`/api/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    testConnection: async id => {
      await currentRuntime.requestJson(`/api/connections/${encodeURIComponent(id)}/test`, { method: 'POST' });
    },
    testConnectionProfile: async (input, requestId) => {
      let password = credentialForRequest(broker, requestId);
      try {
        await currentRuntime.requestJson('/api/connections/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...input, ...(password === undefined ? {} : { password }) }),
        });
      } finally {
        password = undefined;
      }
    },
    listCapabilities: () => ({ descriptors: capabilities.list() }),
  });
  await currentWindow.loadURL(`${currentRuntime.url}/`);
  // Showing only after the authenticated cookie and preload bridge are ready
  // prevents an unauthenticated renderer flash.
  // The listener above is intentionally attached before loadURL.
}

app.on('before-quit', event => {
  if (quitAllowed) return;
  event.preventDefault();
  void requestQuit(true);
});
const startupPromise = start().catch(async error => {
  await shutdown().catch(() => undefined);
  process.stderr.write(`${error instanceof Error ? error.message : 'Electron startup failed.'}\n`);
  // Do not wait for a quit request that is already waiting for startup; that
  // would make the startup promise and quit promise wait on each other.
  if (!quitPromise) void requestQuit(false);
});
