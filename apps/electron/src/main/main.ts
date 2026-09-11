import path from 'node:path';
import { app, BrowserWindow, session } from 'electron';
import { CapabilityRegistry } from '@justybase/ui-core';
import { MainCredentialBroker } from './credentialBroker';
import { registerIpcHandlers } from './ipc';
import { redactConnectionProfiles } from './redaction';
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
  const startedRuntime = await startElectronSession({
    webDistDirectory: process.env.JUSTYBASE_ELECTRON_WEB_DIST ?? path.resolve(__dirname, '../renderer'),
    provisionSqliteFixture: true,
  });
  if (quitRequested) {
    await startedRuntime.close();
    return;
  }
  runtime = startedRuntime;
  const currentRuntime = runtime;
  if (!currentRuntime) throw new Error('Electron runtime failed to initialize.');
  const capabilities = new CapabilityRegistry(currentRuntime.bootstrap.capabilities.descriptors);
  const broker = new MainCredentialBroker();
  capabilityRegistry = capabilities;
  credentialBroker = broker;
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
