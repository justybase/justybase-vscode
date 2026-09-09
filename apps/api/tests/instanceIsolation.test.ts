import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';

function cookieParts(response: { headers: { 'set-cookie'?: unknown } }): { cookie: string; csrf: string } {
  const raw = response.headers['set-cookie'];
  const values = Array.isArray(raw) ? raw.map(value => String(value)) : [String(raw ?? '')];
  const cookies = values.map(value => value.split(';')[0]).filter(Boolean);
  return {
    cookie: cookies.join('; '),
    csrf: cookies.find(value => value.startsWith('justybase_csrf='))?.slice('justybase_csrf='.length) ?? '',
  };
}

describe('API instance isolation', () => {
  let first: FastifyInstance;
  let second: FastifyInstance;
  let firstDataDir: string;
  let secondDataDir: string;

  beforeAll(async () => {
    firstDataDir = mkdtempSync(path.join(os.tmpdir(), 'justybase-api-isolation-first-'));
    secondDataDir = mkdtempSync(path.join(os.tmpdir(), 'justybase-api-isolation-second-'));
    const baseConfig = {
      host: '127.0.0.1',
      port: 0,
      webDistDir: path.join(firstDataDir, 'missing-web'),
      masterKey: 'isolation-test-key',
      adminUsername: 'admin',
      adminPassword: 'admin-password',
    };
    [first, second] = await Promise.all([
      buildServer({ ...baseConfig, dataDir: firstDataDir }),
      buildServer({ ...baseConfig, dataDir: secondDataDir, webDistDir: path.join(secondDataDir, 'missing-web') }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([first.close(), second.close()]);
    rmSync(firstDataDir, { recursive: true, force: true });
    rmSync(secondDataDir, { recursive: true, force: true });
  });

  it('does not share stores, jobs, rate limits, or user data between servers', async () => {
    expect(first.apiContext).not.toBe(second.apiContext);
    expect(first.store).not.toBe(second.store);
    expect(first.queryJobs).not.toBe(second.queryJobs);
    expect(first.rateLimiter).not.toBe(second.rateLimiter);

    const login = await first.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin-password' } });
    expect(login.statusCode).toBe(200);
    const firstAuth = cookieParts(login);
    const created = await first.inject({
      method: 'POST',
      url: '/api/connections',
      headers: { cookie: firstAuth.cookie, 'x-justybase-csrf': firstAuth.csrf },
      payload: { name: 'First only', dbType: 'sqlite', database: 'main', host: 'local', user: 'local', password: '' },
    });
    expect(created.statusCode).toBe(201);

    const secondLogin = await second.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin-password' } });
    const secondAuth = cookieParts(secondLogin);
    const secondConnections = await second.inject({ method: 'GET', url: '/api/connections', headers: { cookie: secondAuth.cookie } });
    expect(secondConnections.statusCode).toBe(200);
    expect(secondConnections.json()).toEqual([]);
  });
});
