import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function cookieParts(response: { headers: Record<string, unknown> }): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw.map(value => String(value).split(';')[0]) : [String(raw).split(';')[0]];
}

describe('test-only authentication endpoint', () => {
  let app: FastifyInstance;
  let dataDir: string;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousTestLoginFlag = process.env.JUSTYBASE_ENABLE_TEST_LOGIN;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.JUSTYBASE_ENABLE_TEST_LOGIN = '1';
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'justybase-api-test-login-'));
    app = await buildServer({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      webDistDir: path.join(dataDir, 'missing-web'),
      masterKey: 'test-master-key',
      adminUsername: 'test-admin',
      adminPassword: 'test-admin-password',
    });
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    restoreEnvironment('NODE_ENV', previousNodeEnv);
    restoreEnvironment('JUSTYBASE_ENABLE_TEST_LOGIN', previousTestLoginFlag);
  });

  it('creates the same authenticated session and cookies without a credential body', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/test-login' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: { id: expect.any(String), username: 'test-admin', role: 'admin' },
    });

    const testCookies = cookieParts(response);
    expect(testCookies).toEqual(expect.arrayContaining([
      expect.stringMatching(/^justybase_session=/),
      expect.stringMatching(/^justybase_csrf=/),
    ]));

    const regularLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'test-admin', password: 'test-admin-password' },
    });
    expect(cookieParts(regularLogin).map(value => value.split('=')[0]).sort()).toEqual(
      testCookies.map(value => value.split('=')[0]).sort(),
    );

    const cookie = testCookies.join('; ');
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toEqual(expect.objectContaining({ username: 'test-admin', role: 'admin' }));
  });

  it('does not register the route when the controlled test mode is disabled', async () => {
    const savedFlag = process.env.JUSTYBASE_ENABLE_TEST_LOGIN;
    delete process.env.JUSTYBASE_ENABLE_TEST_LOGIN;
    const disabledDataDir = mkdtempSync(path.join(os.tmpdir(), 'justybase-api-test-login-disabled-'));
    const disabled = await buildServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: disabledDataDir,
      webDistDir: path.join(disabledDataDir, 'missing-web'),
      masterKey: 'test-master-key',
      adminUsername: 'test-admin',
      adminPassword: 'test-admin-password',
    });
    try {
      const response = await disabled.inject({ method: 'POST', url: '/api/auth/test-login' });
      expect(response.statusCode).toBe(404);
    } finally {
      await disabled.close();
      rmSync(disabledDataDir, { recursive: true, force: true });
      restoreEnvironment('JUSTYBASE_ENABLE_TEST_LOGIN', savedFlag);
    }
  });

  it('does not register the route outside NODE_ENV=test', async () => {
    const savedNodeEnv = process.env.NODE_ENV;
    const savedFlag = process.env.JUSTYBASE_ENABLE_TEST_LOGIN;
    process.env.NODE_ENV = 'production';
    process.env.JUSTYBASE_ENABLE_TEST_LOGIN = '1';
    const productionDataDir = mkdtempSync(path.join(os.tmpdir(), 'justybase-api-test-login-production-'));
    const production = await buildServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: productionDataDir,
      webDistDir: path.join(productionDataDir, 'missing-web'),
      masterKey: 'test-master-key',
      adminUsername: 'test-admin',
      adminPassword: 'test-admin-password',
    });
    try {
      const response = await production.inject({ method: 'POST', url: '/api/auth/test-login' });
      expect(response.statusCode).toBe(404);
    } finally {
      await production.close();
      rmSync(productionDataDir, { recursive: true, force: true });
      restoreEnvironment('NODE_ENV', savedNodeEnv);
      restoreEnvironment('JUSTYBASE_ENABLE_TEST_LOGIN', savedFlag);
    }
  });
});
