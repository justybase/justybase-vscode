import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CapabilityDescriptor, UiRendererBootstrap } from '@justybase/contracts';
import { UI_CONTRACT_VERSION } from '@justybase/contracts';
import { createEmbeddedApiServer } from '@justybase/web-api/embeddedServer';
import type { ApiConfig } from '@justybase/web-api';
import type { EmbeddedApiServer } from '@justybase/web-api/embeddedServer';

export interface CookieWriter {
  set(details: { readonly url: string; readonly name: string; readonly value: string; readonly path: string; readonly httpOnly: boolean }): Promise<void>;
}

export interface ElectronSessionHandle {
  readonly url: string;
  readonly profileDirectory: string;
  readonly bootstrap: UiRendererBootstrap;
  applyAuthenticationCookie(writer: CookieWriter): Promise<void>;
  /** Main-only authenticated request helper; never exposed through preload. */
  requestJson<T>(route: string, init?: RequestInit): Promise<T>;
  close(): Promise<void>;
}

export interface ElectronStartupOptions {
  readonly dataDirectory?: string;
  readonly webDistDirectory: string;
  readonly productId?: string;
  readonly masterKey?: string;
  readonly adminUsername?: string;
  readonly adminPassword?: string;
  /** Test/dev fixture only; creates a read-only in-memory SQLite profile. */
  readonly provisionSqliteFixture?: boolean;
  readonly apiFactory?: (configuration: ApiConfig) => EmbeddedApiServer;
  readonly fetcher?: typeof fetch;
}

const defaultCapabilities: readonly CapabilityDescriptor[] = [
  { key: 'workspace', status: 'available', owner: 'ui-core', documentation: 'Shared workspace state and presentation.', removalCondition: 'Keep the shared surface.' },
  { key: 'results.read', status: 'available', owner: 'electron-api-adapter', documentation: 'Paged/streamed result access through loopback API.', removalCondition: 'Keep the shared result port.' },
  { key: 'results.write', status: 'read-only', owner: 'electron-api-adapter', reason: 'Write operations require an explicit guarded API workflow.', documentation: 'API guarded-write contract.', removalCondition: 'Expose a reviewed preview/apply workflow.' },
  { key: 'metadata', status: 'degraded', owner: 'electron-api-adapter', reason: 'The shell does not yet hydrate the shared metadata tree.', documentation: 'Cross-product UI parity matrix.', removalCondition: 'Wire MetadataPort to the authenticated loopback API.' },
  { key: 'history', status: 'unsupported', owner: 'electron-api-adapter', reason: 'History is not yet exposed by the Electron renderer.', documentation: 'Cross-product UI parity matrix.', removalCondition: 'Wire profile-scoped HistoryPort persistence.' },
  { key: 'explain', status: 'unsupported', owner: 'electron-api-adapter', reason: 'Explain transport is not yet exposed by the Electron renderer.', documentation: 'Cross-product UI parity matrix.', removalCondition: 'Wire the shared Explain workflow to the API.' },
  { key: 'designer', status: 'read-only', owner: 'electron-api-adapter', reason: 'Designer preview/apply is not yet exposed by the Electron renderer.', documentation: 'Cross-product UI parity matrix.', removalCondition: 'Wire guarded DesignerPort preview/apply actions.' },
  { key: 'import-export', status: 'unsupported', owner: 'electron-main', reason: 'R9 does not add native filesystem workflows.', documentation: 'Cross-product UI parity matrix.', removalCondition: 'Add a reviewed main-process file port and sandbox.' },
  { key: 'notebooks', status: 'unsupported', owner: 'electron-api-adapter', reason: 'Notebook workflows are not portable in this shell yet.', documentation: 'Cross-product UI parity matrix.', removalCondition: 'Define a portable notebook contract and lifecycle gate.' },
  { key: 'administration', status: 'unsupported', owner: 'electron-api-adapter', reason: 'Administrative operations remain adapter-owned.', documentation: 'Cross-product UI parity matrix.', removalCondition: 'Add audited, authorized, dialect-specific workflows.' },
  { key: 'filesystem.native-dialog', status: 'unsupported', owner: 'electron-main', reason: 'R9 does not add native filesystem integration.', documentation: 'Cross-product UI parity matrix.', removalCondition: 'Add a reviewed main-process file dialog port.' },
];

function randomValue(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

function cookiesFromHeader(header: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header.split(/,(?=\s*[A-Za-z0-9_-]+=)/u)) {
    const pair = part.trim().split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return cookies;
}

async function loginAtServer(url: string, username: string, password: string, fetcher: typeof fetch): Promise<Map<string, string>> {
  const response = await fetcher(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`Embedded API authentication failed with status ${response.status}.`);
  const cookieHeader = response.headers.get('set-cookie');
  if (!cookieHeader) throw new Error('Embedded API authentication did not return a session cookie.');
  const cookies = cookiesFromHeader(cookieHeader);
  if (!cookies.get('justybase_session') || !cookies.get('justybase_csrf')) throw new Error('Embedded API authentication returned incomplete session cookies.');
  return cookies;
}

/**
 * Creates an authenticated loopback API session for Electron. Passwords and
 * cookie values stay in this main-process closure and are never in bootstrap.
 */
export async function startElectronSession(options: ElectronStartupOptions): Promise<ElectronSessionHandle> {
  const ownsProfile = options.dataDirectory === undefined;
  const profileDirectory = options.dataDirectory ?? await mkdtemp(path.join(os.tmpdir(), 'justybase-electron-profile-'));
  const username = options.adminUsername ?? `r9-electron-${randomValue(8)}`;
  let password = options.adminPassword ?? randomValue(32);
  const clearPassword = (): void => { password = ''; };
  const configuration: ApiConfig = {
    host: '127.0.0.1',
    port: 0,
    dataDir: profileDirectory,
    webDistDir: options.webDistDirectory,
    masterKey: options.masterKey ?? randomValue(32),
    adminUsername: username,
    adminPassword: password,
  };
  let server: EmbeddedApiServer | undefined;
  let cookies: Map<string, string> | undefined;
  let cookieHeader: string | undefined;
  let csrfToken: string | undefined;
  let authenticationCookieApplied = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  const fetcher = options.fetcher ?? fetch;
  try {
    server = (options.apiFactory ?? createEmbeddedApiServer)(configuration);
    const currentServer = server;
    const url = await currentServer.start();
    try {
      cookies = await loginAtServer(url, username, password, fetcher);
      cookieHeader = [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
      csrfToken = cookies.get('justybase_csrf');
    } finally {
      clearPassword();
    }
    const requestJson = async <T>(route: string, init: RequestInit = {}): Promise<T> => {
      if (closed) throw new Error('Electron session is closed.');
      if (!cookieHeader) throw new Error('Electron session authentication is unavailable.');
      const headers = new Headers(init.headers);
      headers.set('Cookie', cookieHeader);
      if (csrfToken) headers.set('x-justybase-csrf', csrfToken);
      const response = await fetcher(`${url}${route.startsWith('/') ? route : `/${route}`}`, {
        ...init,
        headers,
      });
      if (!response.ok) throw new Error(`Embedded API request failed with status ${response.status}.`);
      try {
        return await response.json() as T;
      } catch {
        throw new Error('Embedded API returned an invalid JSON response.');
      }
    };
    if (options.provisionSqliteFixture) {
      await requestJson('/api/connections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Electron SQLite fixture', host: 'local', port: 0, database: ':memory:', user: 'local', password: '', dbType: 'sqlite', readOnly: true }),
      });
    }
    const bootstrap: UiRendererBootstrap = {
      contractVersion: UI_CONTRACT_VERSION,
      productId: options.productId ?? 'electron',
      sessionId: randomValue(18),
      capabilities: { descriptors: defaultCapabilities.map(descriptor => ({ ...descriptor })) },
    };
    let serverClosed = false;
    const close = (): Promise<void> => {
      if (closing) return closing;
      const attempt = (async () => {
        closed = true;
        cookies = undefined;
        cookieHeader = undefined;
        csrfToken = undefined;
        if (!serverClosed) {
          await currentServer.close();
          serverClosed = true;
        }
        if (ownsProfile) await rm(profileDirectory, { recursive: true, force: true });
      })();
      closing = attempt;
      void attempt.catch(() => {
        if (closing === attempt) closing = undefined;
      });
      return closing;
    };
    return {
      url,
      profileDirectory,
      bootstrap,
      requestJson,
      applyAuthenticationCookie: async writer => {
        if (closed) throw new Error('Electron session is closed.');
        const currentCookies = cookies;
        if (!currentCookies || authenticationCookieApplied) throw new Error('Electron session authentication is unavailable.');
        await writer.set({ url, name: 'justybase_session', value: currentCookies.get('justybase_session') ?? '', path: '/', httpOnly: true });
        await writer.set({ url, name: 'justybase_csrf', value: currentCookies.get('justybase_csrf') ?? '', path: '/', httpOnly: false });
        authenticationCookieApplied = true;
        cookies = undefined;
      },
      close,
    };
  } catch (error: unknown) {
    clearPassword();
    cookies = undefined;
    cookieHeader = undefined;
    csrfToken = undefined;
    await server?.close().catch(() => undefined);
    if (ownsProfile) await rm(profileDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
