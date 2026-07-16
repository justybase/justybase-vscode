import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { ConnectionProfileInput, ConnectionProfileUpdate, QueryEvent, QueryExportRequest, QueryPageRequest, QueryStartRequest } from '@justybase/contracts';
import { type ApiConfig } from './config';
import { encryptSecret, verifyPassword } from './security';
import { AppStore } from './store';
import { executeNetezzaQuery, isReadOnlySql, listColumns, listDatabases, listObjects, listSchemas } from './netezza';
import { invalidateSqlMetadataCache, provideSqlCompletion, provideSqlDiagnostics } from './lsp';
import { QuerySessionManager } from './querySessions';
import { getSchemaTree, invalidateSchemaCache, searchSchema } from './schemaService';
import { attachLspSocket, type LspSession } from './lspProtocol';
import { createQueryExportStream } from './queryExport';

const SESSION_COOKIE = 'justybase_session';
const CSRF_COOKIE = 'justybase_csrf';
const DEFAULT_ROW_LIMIT = 200_000;
const DEFAULT_TIMEOUT_SECONDS = 1_800;

interface QueryJob {
  id: string;
  userId: string;
  connectionId: string;
  events: QueryEvent[];
  subscribers: Set<{ send(data: string): void; readyState: number }>;
  cancel?: () => Promise<void>;
  sessionId?: string;
  done: boolean;
}

interface LoginBody { username?: string; password?: string; }

function bodyObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} is required.`);
  return value.trim();
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 7 });
  reply.setCookie(CSRF_COOKIE, randomBytes(24).toString('base64url'), { httpOnly: false, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 7 });
}

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  const user = token ? request.server.store.findUserBySession(token) : undefined;
  if (!user) {
    await reply.code(401).send({ code: 'UNAUTHENTICATED', message: 'Login required.' });
    return;
  }
  request.user = user;
  request.sessionId = token ?? null;
}

async function validateCsrf(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const cookieToken = request.cookies[CSRF_COOKIE];
  const headerToken = request.headers['x-justybase-csrf'];
  if (!cookieToken || typeof headerToken !== 'string' || cookieToken !== headerToken) {
    await reply.code(403).send({ code: 'CSRF_FAILED', message: 'CSRF validation failed.' });
  }
}

function emit(job: QueryJob, event: QueryEvent): void {
  if (job.subscribers.size === 0) job.events.push(event);
  const payload = JSON.stringify(event);
  for (const socket of job.subscribers) if (socket.readyState === 1) socket.send(payload);
}

function startQuery(app: FastifyInstance, userId: string, input: QueryStartRequest): string {
  const profile = app.store.getConnection(userId, input.connectionId);
  if (!profile) throw new Error('Connection profile not found.');
  if (!input.sql.trim()) throw new Error('SQL is required.');
  if (profile.readOnly && !isReadOnlySql(input.sql)) throw new Error('This connection is read-only. Enable write mode for DDL or DML.');

  const queryId = randomUUID();
  const job: QueryJob = { id: queryId, userId, connectionId: input.connectionId, events: [], subscribers: new Set(), done: false };
  app.queryJobs.set(queryId, job);
  void (async () => {
    const startedAt = Date.now();
    emit(job, { type: 'started', queryId, startedAt });
    let totalRows = 0;
    try {
      const result = await executeNetezzaQuery(profile, input.sql, { masterKey: app.apiConfig.masterKey, maxRows: input.maxRows ?? DEFAULT_ROW_LIMIT, timeoutSeconds: input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, readOnly: profile.readOnly }, {
        onColumns: columns => {
          job.sessionId = app.querySessions.create(queryId, userId, input.connectionId, columns);
          emit(job, { type: 'columns', queryId, columns });
          emit(job, { type: 'session', queryId, sessionId: job.sessionId, totalRows: 0 });
        },
        onRows: rows => {
          if (!job.sessionId) throw new Error('Query result session was not initialized.');
          totalRows = app.querySessions.appendRows(userId, job.sessionId, rows);
          emit(job, { type: 'progress', queryId, totalRows });
        },
        onCommand: command => { job.cancel = () => command.cancel(); },
      });
      totalRows = result.totalRows;
      if (job.sessionId) totalRows = app.querySessions.complete(userId, job.sessionId);
      emit(job, { type: 'complete', queryId, totalRows, limitReached: result.limitReached, rowsAffected: result.rowsAffected });
      app.store.addHistory(userId, input.connectionId, input.sql, 'success', Date.now() - startedAt, totalRows);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Query failed.';
      const cancelled = /cancel/i.test(message);
      if (job.sessionId) app.querySessions.complete(userId, job.sessionId);
      emit(job, cancelled ? { type: 'cancelled', queryId, totalRows } : { type: 'error', queryId, message });
      app.store.addHistory(userId, input.connectionId, input.sql, cancelled ? 'cancelled' : 'error', Date.now() - startedAt, totalRows);
    } finally {
      job.done = true;
      job.cancel = undefined;
      setTimeout(() => app.queryJobs.delete(queryId), 60_000).unref();
    }
  })();
  return queryId;
}

export async function buildServer(apiConfig: ApiConfig): Promise<FastifyInstance> {
  const app = fastify({ logger: true });
  const store = new AppStore(apiConfig.dataDir);
  app.decorate('store', store);
  app.decorate('apiConfig', apiConfig);
  app.decorate('queryJobs', new Map<string, QueryJob>());
  app.decorate('querySessions', new QuerySessionManager(apiConfig.dataDir));
  app.decorate('lspSessions', new Set<LspSession>());
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
  await app.register(cookie);
  await app.register(websocket);

  if (apiConfig.adminUsername && apiConfig.adminPassword && store.countUsers() === 0) store.createUser(apiConfig.adminUsername, apiConfig.adminPassword, 'admin');

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.post('/api/auth/login', async (request, reply) => {
    const body = bodyObject(request.body) as LoginBody;
    const username = requiredString(body.username, 'username');
    const password = requiredString(body.password, 'password');
    const row = store.findUserByUsername(username);
    if (!row || !verifyPassword(password, row.password_hash)) return reply.code(401).send({ code: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' });
    const token = randomBytes(32).toString('base64url');
    store.createSession(row.id, token, Date.now() + 7 * 24 * 60 * 60 * 1000);
    setSessionCookie(reply, token);
    return { user: { id: row.id, username: row.username, role: row.role } };
  });
  app.post('/api/auth/logout', async (request, reply) => { const token = request.cookies[SESSION_COOKIE]; if (token) store.deleteSession(token); reply.clearCookie(SESSION_COOKIE, { path: '/' }); return { ok: true }; });
  app.get('/api/auth/me', { preHandler: authenticate }, async request => ({ user: request.user }));

  app.get('/api/connections', { preHandler: authenticate }, async request => store.listConnections(request.user!.id));
  app.post('/api/connections', { preHandler: [authenticate, validateCsrf] }, async (request, reply) => {
    try {
      const body = bodyObject(request.body);
      const input: ConnectionProfileInput = { name: requiredString(body.name, 'name'), host: requiredString(body.host, 'host'), port: typeof body.port === 'number' ? body.port : undefined, database: requiredString(body.database, 'database'), user: requiredString(body.user, 'user'), password: requiredString(body.password, 'password'), dbType: body.dbType === 'netezza' || body.dbType === undefined ? 'netezza' : undefined, readOnly: body.readOnly !== false };
      return reply.code(201).send(store.createConnection(request.user!.id, input, encryptSecret(input.password, apiConfig.masterKey)));
    } catch (error: unknown) { return reply.code(400).send({ code: 'INVALID_CONNECTION', message: error instanceof Error ? error.message : 'Invalid connection.' }); }
  });
  app.put<{ Params: { id: string } }>('/api/connections/:id', { preHandler: [authenticate, validateCsrf] }, async (request, reply) => {
    try {
      const body = bodyObject(request.body);
      const input: ConnectionProfileUpdate = {
        name: requiredString(body.name, 'name'),
        host: requiredString(body.host, 'host'),
        port: typeof body.port === 'number' ? body.port : undefined,
        database: requiredString(body.database, 'database'),
        user: requiredString(body.user, 'user'),
        password: typeof body.password === 'string' && body.password.length > 0 ? body.password : undefined,
        dbType: body.dbType === 'netezza' || body.dbType === undefined ? 'netezza' : undefined,
        readOnly: body.readOnly !== false,
      };
      const updated = store.updateConnection(request.user!.id, request.params.id, input, input.password ? encryptSecret(input.password, apiConfig.masterKey) : undefined);
      if (!updated) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
      invalidateSchemaCache(request.params.id);
      invalidateSqlMetadataCache(request.params.id);
      for (const session of app.lspSessions) session.invalidateConnection(request.params.id);
      return updated;
    } catch (error: unknown) { return reply.code(400).send({ code: 'INVALID_CONNECTION', message: error instanceof Error ? error.message : 'Invalid connection.' }); }
  });
  app.delete<{ Params: { id: string } }>('/api/connections/:id', { preHandler: [authenticate, validateCsrf] }, async (request, reply) => {
    if (!store.deleteConnection(request.user!.id, request.params.id)) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/connections/:id/test', { preHandler: authenticate }, async (request, reply) => {
    const profile = store.getConnection(request.user!.id, request.params.id);
    if (!profile) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
    try { await executeNetezzaQuery(profile, 'SELECT 1', { masterKey: apiConfig.masterKey, maxRows: 1, timeoutSeconds: 30 }, { onColumns: () => undefined, onRows: () => undefined, onCommand: () => undefined }); return { ok: true }; } catch (error: unknown) { return reply.code(400).send({ code: 'CONNECTION_FAILED', message: error instanceof Error ? error.message : 'Connection failed.' }); }
  });

  app.get('/api/metadata/databases', { preHandler: authenticate }, async (request, reply) => { const id = String((request.query as { connectionId?: string }).connectionId ?? ''); const profile = store.getConnection(request.user!.id, id); if (!profile) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' }); return listDatabases(profile, apiConfig.masterKey); });
  app.get('/api/metadata/schemas', { preHandler: authenticate }, async (request, reply) => { const query = request.query as { connectionId?: string; database?: string }; const profile = store.getConnection(request.user!.id, String(query.connectionId ?? '')); if (!profile || !query.database) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection or database not found.' }); return listSchemas(profile, query.database, apiConfig.masterKey); });
  app.get('/api/metadata/objects', { preHandler: authenticate }, async (request, reply) => { const query = request.query as { connectionId?: string; database?: string; schema?: string }; const profile = store.getConnection(request.user!.id, String(query.connectionId ?? '')); if (!profile || !query.database) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection or database not found.' }); return listObjects(profile, query.database, query.schema, apiConfig.masterKey); });
  app.get('/api/metadata/columns', { preHandler: authenticate }, async (request, reply) => { const query = request.query as { connectionId?: string; database?: string; schema?: string; table?: string }; const profile = store.getConnection(request.user!.id, String(query.connectionId ?? '')); if (!profile || !query.database || !query.schema || !query.table) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Table scope not found.' }); return listColumns(profile, query.database, query.schema, query.table, apiConfig.masterKey); });

  app.get('/api/history', { preHandler: authenticate }, async request => store.listHistory(request.user!.id));
  app.get('/api/preferences/editor', { preHandler: authenticate }, async request => store.getEditorPreferences(request.user!.id));
  app.patch('/api/preferences/editor', { preHandler: [authenticate, validateCsrf] }, async request => store.updateEditorPreferences(request.user!.id, request.body as import('@justybase/contracts').EditorPreferencesPatch));
  app.get('/api/schema/tree', { preHandler: authenticate }, async (request, reply) => {
    const query = request.query as { connectionId?: string; parentId?: string };
    if (!query.connectionId) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'connectionId is required.' });
    try { return await getSchemaTree(store, apiConfig, request.user!.id, query.connectionId, query.parentId); }
    catch (error: unknown) { return reply.code(400).send({ code: 'SCHEMA_TREE_FAILED', message: error instanceof Error ? error.message : 'Schema tree failed.' }); }
  });
  app.post('/api/schema/search', { preHandler: [authenticate, validateCsrf] }, async (request, reply) => {
    try { return await searchSchema(store, apiConfig, request.user!.id, request.body as import('@justybase/contracts').SchemaSearchRequest); }
    catch (error: unknown) { return reply.code(400).send({ code: 'SCHEMA_SEARCH_FAILED', message: error instanceof Error ? error.message : 'Schema search failed.' }); }
  });
  app.post('/api/lsp/completion', { preHandler: [authenticate, validateCsrf] }, async (request, reply) => {
    try { return await provideSqlCompletion(store, apiConfig, request.user!.id, request.body as import('@justybase/contracts').SqlCompletionRequest); }
    catch (error: unknown) { return reply.code(400).send({ code: 'LSP_COMPLETION_FAILED', message: error instanceof Error ? error.message : 'Completion failed.' }); }
  });
  app.post('/api/lsp/diagnostics', { preHandler: [authenticate, validateCsrf] }, async (request, reply) => {
    try { return await provideSqlDiagnostics(store, apiConfig, request.user!.id, request.body as import('@justybase/contracts').SqlDiagnosticsRequest); }
    catch (error: unknown) { return reply.code(400).send({ code: 'LSP_DIAGNOSTICS_FAILED', message: error instanceof Error ? error.message : 'Diagnostics failed.' }); }
  });
  app.post<{ Params: { id: string } }>('/api/query/:id/page', { preHandler: [authenticate, validateCsrf] }, async (request, reply) => {
    const job = app.queryJobs.get(request.params.id);
    const sessionId = job?.sessionId ?? app.querySessions.querySessionId(request.user!.id, request.params.id);
    if (!sessionId || (job && job.userId !== request.user!.id)) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Query result session not found.' });
    try { return app.querySessions.page(request.user!.id, sessionId, request.body as QueryPageRequest); }
    catch (error: unknown) { return reply.code(410).send({ code: 'RESULT_EXPIRED', message: error instanceof Error ? error.message : 'Query result expired.' }); }
  });
  app.post<{ Params: { id: string } }>('/api/query/:id/export', { preHandler: [authenticate, validateCsrf] }, async (request, reply) => {
    const job = app.queryJobs.get(request.params.id);
    const sessionId = job?.sessionId ?? app.querySessions.querySessionId(request.user!.id, request.params.id);
    if (!sessionId || (job && job.userId !== request.user!.id)) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Query result session not found.' });
    try {
      const input = request.body as QueryExportRequest;
      const exported = createQueryExportStream(app.querySessions, request.user!.id, sessionId, input);
      const fileName = (typeof input.fileName === 'string' && input.fileName.trim() ? input.fileName.trim().replace(/[^A-Za-z0-9._-]/g, '_') : `justybase-query-${request.params.id}`).replace(/\.+$/, '') || `justybase-query-${request.params.id}`;
      reply.header('Content-Type', exported.contentType);
      reply.header('Content-Disposition', `attachment; filename="${fileName}.${exported.extension}"`);
      return reply.send(exported.stream);
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'EXPORT_FAILED', message: error instanceof Error ? error.message : 'Query export failed.' });
    }
  });
  app.post('/api/query', { preHandler: [authenticate, validateCsrf] }, async (request, reply) => { try { return reply.code(202).send({ queryId: startQuery(app, request.user!.id, request.body as QueryStartRequest) }); } catch (error: unknown) { return reply.code(400).send({ code: 'QUERY_REJECTED', message: error instanceof Error ? error.message : 'Query rejected.' }); } });
  app.post<{ Params: { id: string } }>('/api/query/:id/cancel', { preHandler: [authenticate, validateCsrf] }, async (request, reply) => { const job = app.queryJobs.get(request.params.id); if (!job || job.userId !== request.user!.id) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Query not found.' }); if (job.cancel) await job.cancel(); return { ok: true }; });
  app.get('/api/ws', { websocket: true, preValidation: authenticate }, (socket, request) => {
    socket.on('message', (raw: Buffer) => {
      let message: { type?: string; queryId?: string };
      try { message = JSON.parse(raw.toString()) as { type?: string; queryId?: string }; }
      catch { socket.close(1003, 'Malformed JSON payload.'); return; }
      if (message.type !== 'subscribe' || !message.queryId) return;
      const job = app.queryJobs.get(message.queryId);
      if (!job || job.userId !== request.user!.id) return;
      job.subscribers.add(socket);
      for (const event of job.events) if (socket.readyState === 1) socket.send(JSON.stringify(event));
      job.events.length = 0;
      socket.once('close', () => job.subscribers.delete(socket));
    });
  });
  app.get('/api/lsp', { websocket: true, preValidation: authenticate }, (socket, request) => {
    let session: LspSession;
    session = attachLspSocket(socket, store, apiConfig, request.user!.id, closed => app.lspSessions.delete(closed));
    app.lspSessions.add(session);
  });

  const webRoot = path.resolve(apiConfig.webDistDir);
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ code: 'NOT_FOUND', message: 'Route not found.' }) : reply.sendFile('index.html'));
  }
  const cleanupTimer = setInterval(() => app.querySessions.cleanup(), 60_000);
  cleanupTimer.unref();
  app.addHook('onClose', async () => { clearInterval(cleanupTimer); app.querySessions.closeAll(); store.close(); });
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    store: AppStore;
    apiConfig: ApiConfig;
    queryJobs: Map<string, QueryJob>;
    querySessions: QuerySessionManager;
    lspSessions: Set<LspSession>;
  }
}
