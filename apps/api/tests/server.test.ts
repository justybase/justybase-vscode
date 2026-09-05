import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { resolveLocalDatabasePath } from '../src/localDatabaseSandbox';

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

  it('serves capability-aware designer state for a connection target', async () => {
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/designer/capabilities?connectionId=missing' });
    expect(unauthenticated.statusCode).toBe(401);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin-password' } });
    const rawCookie = login.headers['set-cookie'];
    const cookies = Array.isArray(rawCookie) ? rawCookie.map(value => value.split(';')[0]) : [String(rawCookie).split(';')[0]];
    const cookie = cookies.join('; ');
    const csrf = cookies.find(value => value.startsWith('justybase_csrf='))?.split('=')[1] ?? '';
    const created = await app.inject({
      method: 'POST',
      url: '/api/connections',
      headers: { cookie, 'x-justybase-csrf': csrf },
      payload: { name: `Designer Netezza ${Date.now()}`, host: 'localhost', database: 'system', user: 'admin', password: 'secret' },
    });
    expect(created.statusCode).toBe(201);
    const connectionId = String(created.json().id);

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/designer/capabilities?connectionId=${encodeURIComponent(connectionId)}&database=SYSTEM&schema=ADMIN&objectName=FACT_SALES&objectType=TABLE`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(expect.objectContaining({
        runtimeAvailable: true,
        readOnly: true,
        target: expect.objectContaining({ objectName: 'FACT_SALES', objectType: 'TABLE' }),
      }));
      expect(response.json().capabilities.constructs.indexes.level).toBe('privilege-blocked');
      const snapshot = await app.inject({
        method: 'GET',
        url: `/api/designer/snapshot?connectionId=${encodeURIComponent(connectionId)}&database=SYSTEM&schema=ADMIN&objectName=FACT_SALES&objectType=TABLE`,
        headers: { cookie },
      });
      expect(snapshot.statusCode).toBe(501);
      expect(snapshot.json()).toEqual(expect.objectContaining({ code: 'DESIGNER_SNAPSHOT_UNAVAILABLE' }));
    } finally {
      await app.inject({ method: 'DELETE', url: `/api/connections/${connectionId}`, headers: { cookie, 'x-justybase-csrf': csrf } });
    }
  });

  it('preserves Fastify client-error status codes', async () => {
    const malformedJson = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"username":',
    });
    expect(malformedJson.statusCode).toBe(400);
    expect(malformedJson.json()).toEqual(expect.objectContaining({ code: 'INVALID_REQUEST' }));

    const oversizedJson = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'x'.repeat(1_048_576), password: 'test' }),
    });
    expect(oversizedJson.statusCode).toBe(413);
    expect(oversizedJson.json()).toEqual(expect.objectContaining({ code: 'INVALID_REQUEST' }));
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

  it('routes aggregate requests to the requested statement session', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin-password' } });
    const rawCookie = login.headers['set-cookie'];
    const cookies = Array.isArray(rawCookie) ? rawCookie.map(value => value.split(';')[0]) : [String(rawCookie).split(';')[0]];
    const cookie = cookies.join('; ');
    const csrf = cookies.find(value => value.startsWith('justybase_csrf='))?.split('=')[1] ?? '';
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    const userId = String(me.json().user.id);
    const queryId = `aggregate-route-${Date.now()}`;
    const sessionId = app.querySessions.create(queryId, userId, 'connection-1', [{ name: 'VALUE', type: 'INT' }], 1, 2);
    app.querySessions.appendRows(userId, sessionId, [[2], [4], [6]]);
    app.querySessions.complete(userId, sessionId);
    try {
      const response = await app.inject({ method: 'POST', url: `/api/query/${queryId}/aggregate`, headers: { cookie, 'x-justybase-csrf': csrf }, payload: { statementIndex: 1, columnIndices: [0], functions: ['sum', 'avg'] } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ statementIndex: 1, filteredRowCount: 3, values: [{ columnIndex: 0, count: 0, sum: 12, avg: 4 }] });

      const groupedQueryId = `group-route-${Date.now()}`;
      const groupedSessionId = app.querySessions.create(groupedQueryId, userId, 'connection-1', [{ name: 'CATEGORY', type: 'VARCHAR' }, { name: 'VALUE', type: 'INT' }], 0, 1);
      app.querySessions.appendRows(userId, groupedSessionId, [['A', 10], ['A', 20], ['B', 5]]);
      app.querySessions.complete(userId, groupedSessionId);
      const grouped = await app.inject({ method: 'POST', url: `/api/query/${groupedQueryId}/group`, headers: { cookie, 'x-justybase-csrf': csrf }, payload: { groupByColumnIndices: [0], aggregates: [{ function: 'count' }, { function: 'sum', columnIndex: 1 }] } });
      expect(grouped.statusCode).toBe(200);
      expect(grouped.json()).toEqual(expect.objectContaining({ totalGroups: 2, rows: [['A', 2, 30], ['B', 1, 5]] }));
      app.querySessions.delete(userId, groupedSessionId);
    } finally {
      app.querySessions.delete(userId, sessionId);
    }
  });

  it('returns structured validation errors for malformed query requests', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin-password' } });
    const rawCookie = login.headers['set-cookie'];
    const cookies = Array.isArray(rawCookie) ? rawCookie.map(value => value.split(';')[0]) : [String(rawCookie).split(';')[0]];
    const cookie = cookies.join('; ');
    const csrf = cookies.find(value => value.startsWith('justybase_csrf='))?.split('=')[1] ?? '';

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/query',
      headers: { cookie, 'x-justybase-csrf': csrf },
      payload: { connectionId: 42, sql: 'SELECT 1' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ code: 'INVALID_REQUEST', message: 'connectionId is required.' });

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/query',
      headers: { cookie, 'x-justybase-csrf': csrf },
      payload: [],
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ code: 'INVALID_REQUEST', message: 'request body must be a JSON object.' });
  });

  it('requires explicit confirmation before DML on a writable profile', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin-password' } });
    const rawCookie = login.headers['set-cookie'];
    const cookies = Array.isArray(rawCookie) ? rawCookie.map(value => value.split(';')[0]) : [String(rawCookie).split(';')[0]];
    const cookie = cookies.join('; ');
    const csrf = cookies.find(value => value.startsWith('justybase_csrf='))?.split('=')[1] ?? '';
    const created = await app.inject({
      method: 'POST',
      url: '/api/connections',
      headers: { cookie, 'x-justybase-csrf': csrf },
      payload: { name: 'Writable Netezza', host: 'localhost', database: 'system', user: 'admin', password: 'secret', readOnly: false },
    });
    const connectionId = String(created.json().id);
    try {
      const preview = await app.inject({
        method: 'POST',
        url: '/api/query/preview',
        headers: { cookie, 'x-justybase-csrf': csrf },
        payload: { connectionId, database: 'system', sql: 'DELETE FROM ADMIN.T', mode: 'single' },
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toEqual(expect.objectContaining({ containsWrite: true, readOnly: false, database: 'system' }));
      expect(typeof preview.json().previewToken).toBe('string');

      const editPreview = await app.inject({
        method: 'POST',
        url: '/api/query/edit/preview',
        headers: { cookie, 'x-justybase-csrf': csrf },
        payload: { connectionId, database: 'system', schema: 'ADMIN', table: 'T', key: { ID: 1 }, changes: { NAME: 'Alice' } },
      });
      expect(editPreview.statusCode).toBe(200);
      expect(editPreview.json().sql).toBe('UPDATE "system"."ADMIN"."T" SET "NAME" = \'Alice\' WHERE "ID" = 1;');
      expect(editPreview.json().rowCount).toBe(1);

      const filePreview = await app.inject({
        method: 'POST',
        url: '/api/query/import-file/preview',
        headers: { cookie, 'x-justybase-csrf': csrf },
        payload: {
          connectionId,
          database: 'system',
          schema: 'ADMIN',
          table: 'T',
          fileName: 'rows.csv',
          format: 'csv',
          contentBase64: Buffer.from('ID,NAME\n1,"Alice, A."\n2,Bob\n').toString('base64'),
        },
      });
      expect(filePreview.statusCode).toBe(200);
      expect(filePreview.json().sql).toContain('"ID", "NAME"');
      expect(filePreview.json().sql).toContain("('1', 'Alice, A.')");
      expect(filePreview.json().rowCount).toBe(2);

      const response = await app.inject({
        method: 'POST',
        url: '/api/query',
        headers: { cookie, 'x-justybase-csrf': csrf },
        payload: { connectionId, sql: 'DELETE FROM ADMIN.T', mode: 'single' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('Write confirmation required');

      const stale = await app.inject({
        method: 'POST',
        url: '/api/query',
        headers: { cookie, 'x-justybase-csrf': csrf },
        payload: { connectionId, database: 'system', sql: 'DELETE FROM ADMIN.OTHER_T', mode: 'single', writeConfirmed: true, writePreviewToken: preview.json().previewToken },
      });
      expect(stale.statusCode).toBe(400);
      expect(stale.json().message).toContain('stale');

      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
      app.store.addAudit(String(me.json().user.id), {
        connectionId,
        database: 'system',
        statementIndex: 0,
        statementCount: 1,
        commandType: 'DELETE',
        sql: 'DELETE FROM ADMIN.T',
        status: 'error',
        durationMs: 1,
        confirmed: true,
        createdAt: new Date().toISOString(),
      });
      const audit = await app.inject({ method: 'GET', url: '/api/audit?limit=1', headers: { cookie } });
      expect(audit.statusCode).toBe(200);
      expect(audit.json()[0]).toEqual(expect.objectContaining({ commandType: 'DELETE', connectionId, confirmed: true }));
    } finally {
      await app.inject({ method: 'DELETE', url: `/api/connections/${connectionId}`, headers: { cookie, 'x-justybase-csrf': csrf } });
    }
  });

  it('supports local SQLite profiles through the same metadata and query session APIs', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin-password' } });
    const rawCookie = login.headers['set-cookie'];
    const cookies = Array.isArray(rawCookie) ? rawCookie.map(value => value.split(';')[0]) : [String(rawCookie).split(';')[0]];
    const cookie = cookies.join('; ');
    const csrf = cookies.find(value => value.startsWith('justybase_csrf='))?.split('=')[1] ?? '';
    const unsavedTest = await app.inject({
      method: 'POST',
      url: '/api/connections/test',
      headers: { cookie, 'x-justybase-csrf': csrf },
      payload: { name: 'Unsaved SQLite', dbType: 'sqlite', database: ':memory:', readOnly: true },
    });
    expect(unsavedTest.statusCode).toBe(200);
    const created = await app.inject({
      method: 'POST',
      url: '/api/connections',
      headers: { cookie, 'x-justybase-csrf': csrf },
      payload: { name: `SQLite ${Date.now()}`, dbType: 'sqlite', database: `local-${Date.now()}.sqlite`, readOnly: false },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().dbType).toBe('sqlite');
    const connectionId = String(created.json().id);
    try {
      const tested = await app.inject({ method: 'POST', url: `/api/connections/${connectionId}/test`, headers: { cookie } });
      expect(tested.statusCode).toBe(200);
      const databases = await app.inject({ method: 'GET', url: `/api/metadata/databases?connectionId=${connectionId}`, headers: { cookie } });
      expect(databases.statusCode).toBe(200);
      expect(databases.json()).toEqual(expect.arrayContaining([{ name: 'main' }]));
      const started = await app.inject({ method: 'POST', url: '/api/query', headers: { cookie, 'x-justybase-csrf': csrf }, payload: { connectionId, database: 'main', sql: 'SELECT 42 AS ANSWER', mode: 'single' } });
      expect(started.statusCode).toBe(202);
      const queryId = String(started.json().queryId);
      for (let attempt = 0; attempt < 50 && !app.queryJobs.get(queryId)?.done; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
      const page = await app.inject({ method: 'POST', url: `/api/query/${queryId}/page`, headers: { cookie, 'x-justybase-csrf': csrf }, payload: { limit: 10 } });
      expect(page.statusCode).toBe(200);
      expect(page.json().rows).toEqual([[42]]);
    } finally {
      await app.inject({ method: 'DELETE', url: `/api/connections/${connectionId}`, headers: { cookie, 'x-justybase-csrf': csrf } });
    }
  });

  it('rejects a designer preview when the target changed after the snapshot', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin-password' } });
    const rawCookie = login.headers['set-cookie'];
    const cookies = Array.isArray(rawCookie) ? rawCookie.map(value => value.split(';')[0]) : [String(rawCookie).split(';')[0]];
    const cookie = cookies.join('; ');
    const csrf = cookies.find(value => value.startsWith('justybase_csrf='))?.split('=')[1] ?? '';
    const database = `designer-concurrency-${Date.now()}.sqlite`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/connections',
      headers: { cookie, 'x-justybase-csrf': csrf },
      payload: { name: `Designer concurrency ${Date.now()}`, dbType: 'sqlite', database, readOnly: false },
    });
    expect(created.statusCode).toBe(201);
    const connectionId = String(created.json().id);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    const userId = String(me.json().user.id);
    const databasePath = resolveLocalDatabasePath(database, { root: path.join(dataDir, 'local-databases'), userId });
    const fixture = new DatabaseSync(databasePath);
    fixture.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT);');
    fixture.close();

    try {
      const snapshot = await app.inject({
        method: 'GET',
        url: `/api/designer/snapshot?connectionId=${encodeURIComponent(connectionId)}&database=main&schema=main&objectName=orders&objectType=TABLE`,
        headers: { cookie },
      });
      expect(snapshot.statusCode).toBe(200);
      const snapshotBody = snapshot.json() as { snapshot: { target: Record<string, unknown>; fingerprint: string } };
      const designer = { target: snapshotBody.snapshot.target, baseFingerprint: snapshotBody.snapshot.fingerprint };
      const renamed = await app.inject({
        method: 'PUT',
        url: `/api/connections/${connectionId}`,
        headers: { cookie, 'x-justybase-csrf': csrf },
        payload: { name: `Renamed designer connection ${Date.now()}`, host: 'local', database, user: 'local', dbType: 'sqlite', readOnly: false },
      });
      expect(renamed.statusCode).toBe(200);
      const preview = await app.inject({
        method: 'POST',
        url: '/api/query/preview',
        headers: { cookie, 'x-justybase-csrf': csrf },
        payload: { connectionId, database: 'main', mode: 'script', sql: 'ALTER TABLE "main"."orders" ADD COLUMN "created_at" TEXT;', designer },
      });
      expect(preview.statusCode).toBe(200);

      const changed = new DatabaseSync(databasePath);
      changed.exec('ALTER TABLE orders ADD COLUMN external_change TEXT;');
      changed.close();
      const stale = await app.inject({
        method: 'POST',
        url: '/api/query/preview',
        headers: { cookie, 'x-justybase-csrf': csrf },
        payload: { connectionId, database: 'main', mode: 'script', sql: 'ALTER TABLE "main"."orders" ADD COLUMN "created_at" TEXT;', designer },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toEqual(expect.objectContaining({ code: 'DESIGNER_SNAPSHOT_STALE' }));
      const staleApply = await app.inject({
        method: 'POST',
        url: '/api/query',
        headers: { cookie, 'x-justybase-csrf': csrf },
        payload: {
          connectionId,
          database: 'main',
          mode: 'script',
          sql: 'ALTER TABLE "main"."orders" ADD COLUMN "created_at" TEXT;',
          designer,
          writeConfirmed: true,
          writePreviewToken: preview.json().previewToken,
        },
      });
      expect(staleApply.statusCode).toBe(409);
      expect(staleApply.json()).toEqual(expect.objectContaining({ code: 'DESIGNER_SNAPSHOT_STALE' }));
    } finally {
      await app.inject({ method: 'DELETE', url: `/api/connections/${connectionId}`, headers: { cookie, 'x-justybase-csrf': csrf } });
    }
  });

  it('supports an optional DuckDB profile when the runtime extension is installed', async () => {
    const duckDbModulePath = process.env.JUSTYBASE_DUCKDB_MODULE_PATH ?? path.join(process.cwd(), 'extensions/duckdb/node_modules/@duckdb/node-api');
    if (!existsSync(duckDbModulePath)) return;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin-password' } });
    const rawCookie = login.headers['set-cookie'];
    const cookies = Array.isArray(rawCookie) ? rawCookie.map(value => value.split(';')[0]) : [String(rawCookie).split(';')[0]];
    const cookie = cookies.join('; ');
    const csrf = cookies.find(value => value.startsWith('justybase_csrf='))?.split('=')[1] ?? '';
    const created = await app.inject({
      method: 'POST',
      url: '/api/connections',
      headers: { cookie, 'x-justybase-csrf': csrf },
      payload: { name: `DuckDB ${Date.now()}`, dbType: 'duckdb', database: ':memory:', readOnly: false },
    });
    expect(created.statusCode).toBe(201);
    const connectionId = String(created.json().id);
    try {
      const started = await app.inject({ method: 'POST', url: '/api/query', headers: { cookie, 'x-justybase-csrf': csrf }, payload: { connectionId, database: 'memory', sql: 'SELECT 7 AS ANSWER', mode: 'single' } });
      expect(started.statusCode).toBe(202);
      const queryId = String(started.json().queryId);
      for (let attempt = 0; attempt < 50 && !app.queryJobs.get(queryId)?.done; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
      const page = await app.inject({ method: 'POST', url: `/api/query/${queryId}/page`, headers: { cookie, 'x-justybase-csrf': csrf }, payload: { limit: 10 } });
      expect(page.statusCode).toBe(200);
      expect(page.json().rows).toEqual([[7]]);
    } finally {
      await app.inject({ method: 'DELETE', url: `/api/connections/${connectionId}`, headers: { cookie, 'x-justybase-csrf': csrf } });
    }
  });

  it('protects administration endpoints and produces a SQLite backup', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin-password' } });
    const rawCookie = login.headers['set-cookie'];
    const cookies = Array.isArray(rawCookie) ? rawCookie.map(value => value.split(';')[0]) : [String(rawCookie).split(';')[0]];
    const cookie = cookies.join('; ');
    const csrf = cookies.find(value => value.startsWith('justybase_csrf='))?.split('=')[1] ?? '';
    const backup = await app.inject({ method: 'GET', url: '/api/admin/backup', headers: { cookie } });
    expect(backup.statusCode).toBe(200);
    expect(backup.headers['content-type']).toContain('application/octet-stream');
    expect(backup.rawPayload.length).toBeGreaterThan(100);
    const analystName = `analyst-${Date.now()}`;
    const created = await app.inject({ method: 'POST', url: '/api/admin/users', headers: { cookie, 'x-justybase-csrf': csrf }, payload: { username: analystName, password: 'analyst-password', role: 'user' } });
    expect(created.statusCode).toBe(201);
    const restored = await app.inject({
      method: 'POST',
      url: '/api/admin/restore',
      headers: { cookie, 'x-justybase-csrf': csrf },
      payload: { fileName: 'backup.sqlite', contentBase64: Buffer.from(backup.rawPayload).toString('base64'), restoreConfirmed: true },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().message).toContain('safety copy');
    const users = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie } });
    expect(users.statusCode).toBe(200);
    expect(users.json().map((user: { username: string }) => user.username)).not.toContain(analystName);
  });
});
