import fs from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ApiConfig } from '@justybase/web-api';
import type { EmbeddedApiServer } from '@justybase/web-api/embeddedServer';
import { startElectronSession } from '../src/main/startup';

function fakeServer(url = 'http://127.0.0.1:43123'): EmbeddedApiServer & { starts: number; closes: number } {
  const server = {
    starts: 0,
    closes: 0,
    async start(): Promise<string> { server.starts += 1; return url; },
    async requestJson<T>(): Promise<T> { return undefined as T; },
    async close(): Promise<void> { server.closes += 1; },
  } as EmbeddedApiServer & { starts: number; closes: number };
  return server;
}

function successfulLogin(): typeof fetch {
  return (async () => new Response(null, {
    status: 200,
    headers: { 'set-cookie': 'justybase_session=session-fixture; Path=/, justybase_csrf=csrf-fixture; Path=/' },
  })) as typeof fetch;
}

function loginWithHeader(header: string | null): typeof fetch {
  return (async () => new Response(null, {
    status: 200,
    headers: header === null ? undefined : { 'set-cookie': header },
  })) as typeof fetch;
}

describe('Electron authenticated startup', () => {
  it('provisions a temporary profile, logs in in main, and exposes only safe bootstrap data', async () => {
    let configuration: ApiConfig | undefined;
    const server = fakeServer();
    const session = await startElectronSession({
      webDistDirectory: '/tmp/electron-renderer-fixture',
      apiFactory: provided => { configuration = provided; return server; },
      fetcher: successfulLogin(),
    });
    expect(configuration?.adminPassword).toBeTruthy();
    expect(configuration?.masterKey).toBeTruthy();
    expect(JSON.stringify(session.bootstrap)).not.toContain(configuration?.adminPassword ?? '');
    expect(JSON.stringify(session.bootstrap)).not.toContain(configuration?.masterKey ?? '');
    expect(session.bootstrap).not.toHaveProperty('password');

    const cookies: Array<{ name: string; value: string }> = [];
    await session.applyAuthenticationCookie({ set: async details => { cookies.push({ name: details.name, value: details.value }); } });
    expect(cookies).toEqual([{ name: 'justybase_session', value: 'session-fixture' }, { name: 'justybase_csrf', value: 'csrf-fixture' }]);
    await expect(session.applyAuthenticationCookie({ set: async () => undefined })).rejects.toThrow('unavailable');
    await Promise.all([session.close(), session.close()]);
    expect(server.starts).toBe(1);
    expect(server.closes).toBe(1);
    expect(fs.existsSync(session.profileDirectory)).toBe(false);
  });

  it('cleans a temporary profile when authentication fails', async () => {
    const server = fakeServer();
    await expect(startElectronSession({
      webDistDirectory: '/tmp/electron-renderer-fixture',
      apiFactory: () => server,
      fetcher: (async () => new Response(null, { status: 401 })) as typeof fetch,
    })).rejects.toThrow('authentication failed');
    expect(server.closes).toBe(1);
  });

  it('does not delete a caller-owned profile', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'justybase-electron-owned-'));
    const server = fakeServer();
    const session = await startElectronSession({ dataDirectory: parent, webDistDirectory: '/tmp/electron-renderer-fixture', apiFactory: () => server, fetcher: successfulLogin() });
    await session.close();
    expect(fs.existsSync(parent)).toBe(true);
    await fs.promises.rm(parent, { recursive: true, force: true });
  });

  it('validates both authentication cookies and ignores malformed cookie fragments', async () => {
    for (const header of [null, 'justybase_session=session-fixture; Path=/', 'broken, justybase_session=session-fixture; Path=/, justybase_csrf=csrf-fixture; Path=/']) {
      const server = fakeServer();
      if (header?.startsWith('broken')) {
        const session = await startElectronSession({ webDistDirectory: '/tmp/electron-renderer-fixture', apiFactory: () => server, fetcher: loginWithHeader(header), productId: 'custom-electron' });
        expect(session.bootstrap.productId).toBe('custom-electron');
        await session.close();
      } else {
        await expect(startElectronSession({ webDistDirectory: '/tmp/electron-renderer-fixture', apiFactory: () => server, fetcher: loginWithHeader(header) })).rejects.toThrow(/cookie/u);
        expect(server.closes).toBe(1);
      }
    }
  });

  it('keeps authenticated requests main-owned and rejects failed/closed requests', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const server = fakeServer();
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      if (calls.length === 1) return new Response(null, { status: 200, headers: { 'set-cookie': 'justybase_session=session-fixture; Path=/, justybase_csrf=csrf-fixture; Path=/' } });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const session = await startElectronSession({ webDistDirectory: '/tmp/electron-renderer-fixture', apiFactory: () => server, fetcher });
    await expect(session.requestJson<{ ok: boolean }>('api/status', { headers: { 'x-fixture': 'yes' } })).resolves.toEqual({ ok: true });
    expect(String(calls[1]?.input)).toBe('http://127.0.0.1:43123/api/status');
    expect(calls[1]?.init?.headers).toEqual(expect.objectContaining({ Cookie: 'justybase_session=session-fixture; justybase_csrf=csrf-fixture' }));

    await expect(session.applyAuthenticationCookie({ set: async () => { throw new Error('cookie writer failed'); } })).rejects.toThrow('cookie writer failed');
    await expect(session.applyAuthenticationCookie({ set: async () => undefined })).resolves.toBeUndefined();
    await expect(session.requestJson('api/status')).resolves.toEqual({ ok: true });
    await session.close();
    await expect(session.requestJson('/api/status')).rejects.toThrow('closed');
    await expect(session.applyAuthenticationCookie({ set: async () => undefined })).rejects.toThrow('closed');
  });

  it('cleans up when initialization or server shutdown fails', async () => {
    let failedProfile: string | undefined;
    await expect(startElectronSession({
      webDistDirectory: '/tmp/electron-renderer-fixture',
      apiFactory: configuration => { failedProfile = configuration.dataDir; throw new Error('factory failed'); },
      fetcher: successfulLogin(),
    })).rejects.toThrow('factory failed');
    expect(failedProfile).toBeDefined();
    expect(fs.existsSync(failedProfile ?? '')).toBe(false);

    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'justybase-electron-close-failure-'));
    const server = fakeServer();
    server.close = async () => { server.closes += 1; throw new Error('close failed'); };
    const session = await startElectronSession({ dataDirectory: dataDir, webDistDirectory: '/tmp/electron-renderer-fixture', apiFactory: () => server, fetcher: successfulLogin() });
    const close = session.close();
    await expect(close).rejects.toThrow('close failed');
    await expect(session.close()).rejects.toThrow('close failed');
    expect(fs.existsSync(dataDir)).toBe(true);
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });

  it('reports non-successful authenticated API responses', async () => {
    const server = fakeServer();
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 200, headers: { 'set-cookie': 'justybase_session=session-fixture; Path=/, justybase_csrf=csrf-fixture; Path=/' } });
      return new Response(null, { status: 503 });
    }) as typeof fetch;
    const session = await startElectronSession({ webDistDirectory: '/tmp/electron-renderer-fixture', apiFactory: () => server, fetcher });
    await expect(session.requestJson('/api/unavailable')).rejects.toThrow('status 503');
    await session.close();
  });
});
