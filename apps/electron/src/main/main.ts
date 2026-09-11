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

async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    ipcRegistration?.dispose();
    ipcRegistration = undefined;
    credentialBroker?.dispose();
    credentialBroker = undefined;
    capabilityRegistry?.dispose();
    capabilityRegistry = undefined;
    await runtime?.close();
    runtime = undefined;
    window = undefined;
  })();
  await shutdownPromise;
}

async function start(): Promise<void> {
  await app.whenReady();
  runtime = await startElectronSession({
    webDistDirectory: process.env.JUSTYBASE_ELECTRON_WEB_DIST ?? path.resolve(__dirname, '../renderer'),
    provisionSqliteFixture: true,
  });
  const currentRuntime = runtime;
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
  await currentRuntime.applyAuthenticationCookie({ set: details => session.defaultSession.cookies.set(details) });
  ipcRegistration = registerIpcHandlers({
    authStatus: () => ({ status: 'authenticated', sessionId: currentRuntime.bootstrap.sessionId }),
    credentialBroker: broker,
    listConnections: async () => redactConnectionProfiles(await currentRuntime.requestJson<readonly unknown[]>('/api/connections')),
    listCapabilities: () => ({ descriptors: capabilities.list() }),
  });
  window.on('closed', () => { void shutdown(); });
  await window.loadURL(`${currentRuntime.url}/`);
  // Showing only after the authenticated cookie and preload bridge are ready
  // prevents an unauthenticated renderer flash.
  window.on('ready-to-show', () => window?.show());
}

app.once('before-quit', () => { void shutdown(); });
void start().catch(async error => {
  await shutdown().catch(() => undefined);
  process.stderr.write(`${error instanceof Error ? error.message : 'Electron startup failed.'}\n`);
  app.quit();
});
