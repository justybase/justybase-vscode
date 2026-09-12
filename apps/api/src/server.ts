import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { MAX_QUERY_FILE_IMPORT_BYTES } from '@justybase/contracts';
import type { AdminRestoreRequest, QueryPreviewResponse, QueryStartRequest } from '@justybase/contracts';
import { createExecutionOrchestrator, ExecutionOrchestrator, isConnectionBrokenError, isSafeToRetrySql, type ExecutionBackend } from '@justybase/database-runtime';
import { type ApiConfig } from './config';
import { createApiApplicationContext, type ApiApplicationContext } from './applicationContext';
import { AppStore, type StoredConnection } from './store';
import type { ApiDatabaseRuntimeRegistry } from './databaseRuntime/contracts';
import { createApiDatabaseRuntimeRegistry } from './databaseRuntime/registry';
import { QuerySessionManager } from './querySessions';
import type { LspSession } from './lspProtocol';
import { ApiMetadataService } from './metadataCache';
import { createApiQueryUseCases, type QueryJob, type QueryUseCaseContext } from './queryUseCases';
import { registerAuthAdminRoutes } from './routes/authAdminRoutes';
import { registerConnectionRoutes } from './routes/connectionRoutes';
import { registerMetadataRoutes } from './routes/metadataRoutes';
import { registerDesignerRoutes } from './routes/designerRoutes';
import { registerLspRoutes } from './routes/lspRoutes';
import { registerResultRoutes } from './routes/resultRoutes';
import { registerQueryRoutes } from './routes/queryRoutes';
import { RequestValidationError } from './requestValidation';

// Compatibility export retained for API consumers that use the pure planner.
export { planStatements } from './queryUseCases';
export type { PlannedStatement } from './queryUseCases';

const SESSION_COOKIE = 'justybase_session';
const CSRF_COOKIE = 'justybase_csrf';
const LOGIN_RATE_LIMIT = { max: 10, windowMs: 60_000 };
const QUERY_RATE_LIMIT = { max: 120, windowMs: 60_000 };
const MAX_ADMIN_BACKUP_BYTES = 100 * 1024 * 1024;
const REQUEST_BODY_OVERHEAD_BYTES = 1024 * 1024;
const MAX_ADMIN_RESTORE_BODY_BYTES = Math.ceil(MAX_ADMIN_BACKUP_BYTES / 3) * 4 + REQUEST_BODY_OVERHEAD_BYTES;
const MAX_IMPORT_BODY_BYTES = Math.ceil(MAX_QUERY_FILE_IMPORT_BYTES / 3) * 4 + REQUEST_BODY_OVERHEAD_BYTES;

interface RateLimitBucket { count: number; resetAt: number; }

class RateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();

  public check(key: string, max: number, windowMs: number): number | undefined {
    const now = Date.now();
    if (this.buckets.size > 1_000) {
      for (const [bucketKey, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(bucketKey);
    }
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return undefined;
    }
    existing.count += 1;
    if (existing.count <= max) return undefined;
    return Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  }

  public clear(): void {
    this.buckets.clear();
  }
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestValidationError('request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function clientErrorStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number'
    && Number.isInteger(statusCode)
    && statusCode >= 400
    && (statusCode < 500 || statusCode === 501)
    ? statusCode
    : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} is required.`);
  return value.trim();
}

type CookieSameSite = 'lax' | 'none';
interface CookieSettings {
  sameSite: CookieSameSite;
  secure: boolean;
}

function cookieSettingsForRequest(request: FastifyRequest, origins: readonly string[]): CookieSettings {
  const origin = request.headers.origin;
  const crossOrigin = typeof origin === 'string' && origins.includes(origin);
  // The configured browser origin also identifies the public scheme. This is
  // important behind a TLS-terminating reverse proxy, where Fastify may see
  // the internal HTTP hop unless trustProxy is enabled.
  const secureTransport = request.protocol === 'https'
    || (crossOrigin && typeof origin === 'string' && origin.startsWith('https://'));
  return {
    sameSite: crossOrigin && secureTransport ? 'none' : 'lax',
    // An explicitly configured HTTP development origin must not receive a
    // Secure cookie: browsers reject it before the session can be used. Keep
    // the historical production default for same-origin deployments, where
    // production is expected to run behind HTTPS.
    secure: secureTransport || (process.env.NODE_ENV === 'production' && !crossOrigin),
  };
}

function setCsrfCookie(reply: FastifyReply, settings: CookieSettings = { sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }): string {
  const token = randomBytes(24).toString('base64url');
  reply.setCookie(CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: settings.sameSite,
    secure: settings.secure,
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
  // The header is useful to separately hosted frontends, which cannot read
  // this cookie because it belongs to the API origin.
  reply.header('x-justybase-csrf', token);
  return token;
}

function setSessionCookie(reply: FastifyReply, token: string, settings: CookieSettings = { sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }): void {
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: settings.sameSite, secure: settings.secure, path: '/', maxAge: 60 * 60 * 24 * 7 });
  setCsrfCookie(reply, settings);
}

function registerCors(app: FastifyInstance, origins: readonly string[]): void {
  const allowedOrigins = new Set(origins);
  if (allowedOrigins.size === 0) return;

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !allowedOrigins.has(origin)) return;

    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Credentials', 'true');
    reply.header('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, X-JustyBase-CSRF');
    reply.header('Access-Control-Expose-Headers', 'Content-Disposition, X-JustyBase-CSRF');
    reply.header('Vary', 'Origin');

    if (request.method === 'OPTIONS') return reply.code(204).send();
  });
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

async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.user?.role !== 'admin') await reply.code(403).send({ code: 'FORBIDDEN', message: 'Administrator role required.' });
}

async function loginRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const retryAfter = request.server.rateLimiter.check(`login:${request.ip}`, LOGIN_RATE_LIMIT.max, LOGIN_RATE_LIMIT.windowMs);
  if (retryAfter !== undefined) {
    reply.header('Retry-After', String(retryAfter));
    await reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.' });
  }
}

async function queryRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const retryAfter = request.server.rateLimiter.check(`query:${request.user?.id ?? request.ip}`, QUERY_RATE_LIMIT.max, QUERY_RATE_LIMIT.windowMs);
  if (retryAfter !== undefined) {
    reply.header('Retry-After', String(retryAfter));
    await reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many query requests. Try again later.' });
  }
}

function decodeBase64Upload(value: unknown, field: string, maxBytes: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`${field} is invalid.`);
  const content = Buffer.from(value, 'base64');
  if (content.length === 0) throw new Error(`${field} is empty.`);
  if (content.length > maxBytes) throw new Error(`${field} exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`);
  return content;
}

async function createAdminBackup(app: FastifyInstance): Promise<{ data: Buffer; fileName: string }> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'justybase-web-backup-'));
  const backupPath = path.join(tempDir, 'justybase.sqlite');
  try {
    app.store.backupTo(backupPath);
    return {
      data: await readFile(backupPath),
      fileName: `justybase-backup-${new Date().toISOString().slice(0, 10)}.sqlite`,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function restoreAdminBackup(app: FastifyInstance, input: AdminRestoreRequest): Promise<Record<string, unknown>> {
  let tempDir: string | undefined;
  try {
    if (input.restoreConfirmed !== true) throw new Error('Restore confirmation is required.');
    if (typeof input.fileName !== 'string' || input.fileName.trim().length === 0) throw new Error('fileName is required.');
    if ([...app.queryJobs.values()].some(job => !job.done)) throw new Error('Wait for running queries to finish before restoring a backup.');
    const content = decodeBase64Upload(input.contentBase64, 'contentBase64', MAX_ADMIN_BACKUP_BYTES);
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'justybase-web-restore-'));
    const uploadPath = path.join(tempDir, 'restore.sqlite');
    await writeFile(uploadPath, content, { mode: 0o600 });

    const safetyDir = path.join(app.apiConfig.dataDir, 'backups');
    await mkdir(safetyDir, { recursive: true });
    const safetyPath = path.join(safetyDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    app.store.backupTo(safetyPath);
    await app.databaseRuntimes.closeAll();
    const restored = app.store.restoreFrom(uploadPath);
    app.querySessions.clearAll();
    clearQueryJobs(app.queryJobs);
    app.metadataService.clear();
    for (const session of app.lspSessions) session.invalidateAll();
    app.rateLimiter.clear();
    return {
      message: `Backup restored. A safety copy was saved as ${path.basename(safetyPath)}. Sign in again if this session is no longer valid.`,
      ...restored,
    };
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function clearQueryJobs(queryJobs: Map<string, QueryJob>): void {
  for (const job of queryJobs.values()) {
    if (job.cleanupTimer !== undefined) clearTimeout(job.cleanupTimer);
    job.cleanupTimer = undefined;
  }
  queryJobs.clear();
}

async function disposeQueryJobs(queryJobs: Map<string, QueryJob>): Promise<void> {
  const jobs = [...queryJobs.values()];
  await Promise.allSettled(jobs.map(async job => {
    if (!job.done && job.cancel) await job.cancel();
    await job.settled;
  }));
  for (const job of jobs) {
    for (const subscriber of job.subscribers) subscriber.close?.();
    job.subscribers.clear();
  }
  clearQueryJobs(queryJobs);
}

function queryUseCaseContextForApp(app: FastifyInstance): QueryUseCaseContext {
  return {
    config: app.apiConfig,
    store: app.store,
    databaseRuntimes: app.databaseRuntimes,
    executionOrchestrator: app.executionOrchestrator,
    metadataService: app.metadataService,
    queryJobs: app.queryJobs,
    querySessions: app.querySessions,
    lspSessions: app.lspSessions,
    log: {
      debug: (bindings, message) => app.log.debug(bindings, message),
      warn: (bindings, message) => app.log.warn(bindings, message),
    },
  };
}

/**
 * Compatibility facade for callers that used the former server-level
 * previewQuery export. HTTP routes use the composed use-case object directly.
 */
export async function previewQuery(app: FastifyInstance, userId: string, input: QueryStartRequest): Promise<QueryPreviewResponse> {
  return createApiQueryUseCases(queryUseCaseContextForApp(app)).previewQuery(userId, input);
}


export async function buildServer(apiConfig: ApiConfig): Promise<FastifyInstance> {
  const app = fastify({ logger: true });
  app.setErrorHandler((error, request, reply) => {
    const hasValidation = typeof error === 'object'
      && error !== null
      && 'validation' in error
      && Boolean((error as { validation?: unknown }).validation);
    if (error instanceof RequestValidationError || hasValidation) {
      void reply.code(400).send({
        code: error instanceof RequestValidationError ? error.code : 'INVALID_REQUEST',
        message: error instanceof Error ? error.message : 'Invalid request.',
      });
      return;
    }
    const statusCode = clientErrorStatusCode(error);
    if (statusCode !== undefined) {
      void reply.code(statusCode).send({
        code: typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : 'INVALID_REQUEST',
        message: error instanceof Error ? error.message : 'Invalid request.',
      });
      return;
    }
    request.log.error(error);
    void reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Internal server error.' });
  });
  const localDbRoot = apiConfig.localDbRoot ?? path.join(apiConfig.dataDir, 'local-databases');
  const store = new AppStore(apiConfig.dataDir, localDbRoot);
  const databaseRuntimes = createApiDatabaseRuntimeRegistry({ masterKey: apiConfig.masterKey });
  const executionBackend: ExecutionBackend<StoredConnection> = {
    execute: (target, sql, options, callbacks) => databaseRuntimes.execute(target, sql, options, callbacks),
    closeTarget: target => databaseRuntimes.closeConnection(target.id),
    closeAll: () => databaseRuntimes.closeAll(),
    isConnectionBrokenError,
    isSafeToRetrySql,
  };
  const executionOrchestrator = createExecutionOrchestrator({ backend: executionBackend, logger: {
    warn: (message, error) => app.log.warn({ error }, message),
    error: (message, error) => app.log.error({ error }, message),
  } });
  const metadataService = new ApiMetadataService();
  const rateLimiter = new RateLimiter();
  const queryJobs = new Map<string, QueryJob>();
  const querySessions = new QuerySessionManager(apiConfig.dataDir);
  const lspSessions = new Set<LspSession>();
  const apiContext = createApiApplicationContext<QueryJob>({
    config: apiConfig,
    store,
    databaseRuntimes,
    executionOrchestrator,
    rateLimiter,
    metadataService,
    queryJobs,
    querySessions,
    lspSessions,
    disposeJobs: () => disposeQueryJobs(queryJobs),
    closeLspSessions: () => {
      for (const session of lspSessions) session.close?.();
      lspSessions.clear();
    },
  });
  const queryUseCases = createApiQueryUseCases({
    config: apiContext.config,
    store: apiContext.store,
    databaseRuntimes: apiContext.databaseRuntimes,
    executionOrchestrator: apiContext.executionOrchestrator,
    metadataService: apiContext.metadataService,
    queryJobs: apiContext.queryJobs,
    querySessions: apiContext.querySessions,
    lspSessions: apiContext.lspSessions,
    log: {
      debug: (bindings, message) => app.log.debug(bindings, message),
      warn: (bindings, message) => app.log.warn(bindings, message),
    },
  });
  app.decorate('apiContext', apiContext);
  // Keep these decorations as a compatibility facade for route handlers and
  // existing integrations while the route groups migrate to apiContext.
  app.decorate('store', apiContext.store);
  app.decorate('apiConfig', apiContext.config);
  app.decorate('databaseRuntimes', apiContext.databaseRuntimes);
  app.decorate('executionOrchestrator', apiContext.executionOrchestrator);
  app.decorate('rateLimiter', rateLimiter);
  app.decorate('metadataService', apiContext.metadataService);
  app.decorate('queryJobs', apiContext.queryJobs);
  app.decorate('querySessions', apiContext.querySessions);
  app.decorate('lspSessions', apiContext.lspSessions);
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
  await app.register(cookie);
  await app.register(websocket);
  registerCors(app, apiConfig.webOrigins ?? []);
  const webOrigins = apiConfig.webOrigins ?? [];

  if (apiConfig.adminUsername && apiConfig.adminPassword && store.countUsers() === 0) store.createUser(apiConfig.adminUsername, apiConfig.adminPassword, 'admin');
  const testLoginCredentials = process.env.NODE_ENV === 'test'
    && process.env.JUSTYBASE_ENABLE_TEST_LOGIN === '1'
    && apiConfig.adminUsername
    && apiConfig.adminPassword
    ? { username: apiConfig.adminUsername, password: apiConfig.adminPassword }
    : undefined;

  app.get('/healthz', async () => ({ status: 'ok' }));
  registerAuthAdminRoutes(app, {
    authenticate,
    validateCsrf,
    requireAdmin,
    loginRateLimit,
    sessionCookie: SESSION_COOKIE,
    setSessionCookie: (reply, token, request) => setSessionCookie(reply, token, cookieSettingsForRequest(request, webOrigins)),
    issueCsrfToken: (reply, request) => setCsrfCookie(reply, cookieSettingsForRequest(request, webOrigins)),
    bodyObject,
    requiredString,
    restoreBodyLimit: MAX_ADMIN_RESTORE_BODY_BYTES,
    backup: () => createAdminBackup(app),
    restore: (server, input) => restoreAdminBackup(server, input),
    ...(testLoginCredentials ? { testLogin: () => testLoginCredentials } : {}),
  });

  registerConnectionRoutes(app, { authenticate, validateCsrf, bodyObject, requiredString });

  registerMetadataRoutes(app, { authenticate, validateCsrf });
  registerDesignerRoutes(app, { authenticate });

  app.get('/api/history', { preHandler: authenticate }, async request => store.listHistory(request.user!.id));
  app.get('/api/audit', { preHandler: authenticate }, async request => {
    const limit = Number((request.query as { limit?: string }).limit ?? 200);
    return store.listAudit(request.user!.id, Number.isFinite(limit) ? limit : 200);
  });
  app.get('/api/preferences/editor', { preHandler: authenticate }, async request => store.getEditorPreferences(request.user!.id));
  app.patch('/api/preferences/editor', { preHandler: [authenticate, validateCsrf] }, async request => store.updateEditorPreferences(request.user!.id, request.body as import('@justybase/contracts').EditorPreferencesPatch));
  registerLspRoutes(app, { authenticate, validateCsrf });
  registerResultRoutes(app, { authenticate, queryRateLimit, validateCsrf });
  registerQueryRoutes(app, {
    authenticate,
    queryRateLimit,
    validateCsrf,
    importBodyLimit: MAX_IMPORT_BODY_BYTES,
    previewQuery: queryUseCases.previewQuery,
    startQuery: queryUseCases.startQuery,
    editPreview: queryUseCases.editPreview,
    edit: queryUseCases.edit,
    importPreview: queryUseCases.importPreview,
    importRows: queryUseCases.importRows,
    importFilePreview: queryUseCases.importFilePreview,
    importFile: queryUseCases.importFile,
  });

  const webRoot = path.resolve(apiConfig.webDistDir);
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ code: 'NOT_FOUND', message: 'Route not found.' }) : reply.sendFile('index.html'));
  }
  const cleanupTimer = setInterval(() => app.querySessions.cleanup(), 60_000);
  cleanupTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(cleanupTimer);
    await app.apiContext.dispose();
  });
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    apiContext: ApiApplicationContext<QueryJob>;
    store: AppStore;
    apiConfig: ApiConfig;
    databaseRuntimes: ApiDatabaseRuntimeRegistry;
    executionOrchestrator: ExecutionOrchestrator<StoredConnection>;
    rateLimiter: RateLimiter;
    metadataService: ApiMetadataService;
    queryJobs: Map<string, QueryJob>;
    querySessions: QuerySessionManager;
    lspSessions: Set<LspSession>;
  }
}
