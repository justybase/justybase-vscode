import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';

describe('web API authentication and connection profiles', () => {
  let app: FastifyInstance;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'justybase-api-'));
    app = await buildServer({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      webDistDir: path.join(dataDir, 'missing-web'),
      masterKey: 'test-master-key',
      adminUsername: 'admin',
      adminPassword: 'admin-password',
    });
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('bootstraps an admin and protects authenticated routes', async () => {
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/connections' });
    expect(unauthenticated.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'admin-password' },
    });
    expect(login.statusCode).toBe(200);
    const rawCookie = login.headers['set-cookie'];
    const cookies = Array.isArray(rawCookie) ? rawCookie.map(value => value.split(';')[0]) : [String(rawCookie).split(';')[0]];
    const cookie = cookies.join('; ');

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe('admin');

    const connections = await app.inject({ method: 'GET', url: '/api/connections', headers: { cookie } });
    expect(connections.statusCode).toBe(200);
    expect(connections.json()).toEqual([]);
  });

  it('stores only a profile summary and defaults it to read-only', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin-password' } });
    const rawCookie = login.headers['set-cookie'];
    const cookies = Array.isArray(rawCookie) ? rawCookie.map(value => value.split(';')[0]) : [String(rawCookie).split(';')[0]];
    const cookie = cookies.join('; ');
    const csrf = cookies.find(value => value.startsWith('justybase_csrf='))?.split('=')[1];
    const created = await app.inject({
      method: 'POST',
      url: '/api/connections',
      headers: { cookie, 'x-justybase-csrf': csrf ?? '' },
      payload: { name: 'Development Netezza', host: 'localhost', database: 'system', user: 'admin', password: 'secret' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual(expect.objectContaining({ name: 'Development Netezza', readOnly: true, dbType: 'netezza' }));
    expect(JSON.stringify(created.json())).not.toContain('secret');

    const connectionId = String(created.json().id);
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/connections/${connectionId}`,
      headers: { cookie, 'x-justybase-csrf': csrf ?? '' },
      payload: { name: 'Updated Netezza', host: 'localhost', port: 5480, database: 'system', user: 'admin', readOnly: true },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().name).toBe('Updated Netezza');

    const completion = await app.inject({
      method: 'POST',
      url: '/api/lsp/completion',
      headers: { cookie, 'x-justybase-csrf': csrf ?? '' },
      payload: { sql: 'SELECT CO', offset: 9 },
    });
    expect(completion.statusCode).toBe(200);
    expect(completion.json().items.map((item: { label: string }) => item.label)).toContain('COALESCE');

    const diagnostics = await app.inject({
      method: 'POST',
      url: '/api/lsp/diagnostics',
      headers: { cookie, 'x-justybase-csrf': csrf ?? '' },
      payload: { sql: 'SELECT (' },
    });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json().diagnostics.map((item: { code: string }) => item.code)).toContain('WEB003');

    const deleted = await app.inject({ method: 'DELETE', url: `/api/connections/${connectionId}`, headers: { cookie, 'x-justybase-csrf': csrf ?? '' } });
    expect(deleted.statusCode).toBe(200);
  });

  it('serves web assets and falls back to the SPA entry point', async () => {
    const staticDataDir = mkdtempSync(path.join(os.tmpdir(), 'justybase-api-static-data-'));
    const webDistDir = mkdtempSync(path.join(os.tmpdir(), 'justybase-api-static-web-'));
    writeFileSync(path.join(webDistDir, 'index.html'), '<!doctype html><title>JustyBase</title>');
    writeFileSync(path.join(webDistDir, 'app.js'), 'console.log("app");');
    const staticApp = await buildServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: staticDataDir,
      webDistDir,
      masterKey: 'test-master-key',
    });

    try {
      const asset = await staticApp.inject({ method: 'GET', url: '/app.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toBe('console.log("app");');

      const spaRoute = await staticApp.inject({ method: 'GET', url: '/connections/new' });
      expect(spaRoute.statusCode).toBe(200);
      expect(spaRoute.body).toContain('<title>JustyBase</title>');

      const missingApiRoute = await staticApp.inject({ method: 'GET', url: '/api/missing' });
      expect(missingApiRoute.statusCode).toBe(404);
      expect(missingApiRoute.json()).toEqual({ code: 'NOT_FOUND', message: 'Route not found.' });
    } finally {
      await staticApp.close();
      rmSync(staticDataDir, { recursive: true, force: true });
      rmSync(webDistDir, { recursive: true, force: true });
    }
  });
});
