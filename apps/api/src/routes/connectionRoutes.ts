import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { tryNormalizeDatabaseKind, type ConnectionProfileInput, type ConnectionProfileUpdate } from '@justybase/contracts';
import { encryptSecret } from '../security';
import type { StoredConnection } from '../store';

export interface ConnectionRouteHooks {
  authenticate: preHandlerHookHandler;
  validateCsrf: preHandlerHookHandler;
  bodyObject(value: unknown): Record<string, unknown>;
  requiredString(value: unknown, field: string): string;
}

type RuntimeConnectionKind = 'netezza' | 'sqlite' | 'duckdb';

function connectionKind(value: unknown): RuntimeConnectionKind {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0)) return 'netezza';
  if (typeof value !== 'string') throw new Error('Database kind must be a string.');
  const normalized = tryNormalizeDatabaseKind(value);
  if (!normalized) throw new Error(`Unsupported database kind '${value}'.`);
  if (normalized !== 'netezza' && normalized !== 'sqlite' && normalized !== 'duckdb') {
    throw new Error(`Database runtime for '${normalized}' is not enabled in this Web deployment.`);
  }
  return normalized as RuntimeConnectionKind;
}

function localDatabase(kind: RuntimeConnectionKind): boolean {
  return kind === 'sqlite' || kind === 'duckdb';
}

function optionalLocalString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/** Connection profile CRUD and connectivity checks. */
export function registerConnectionRoutes(app: FastifyInstance, hooks: ConnectionRouteHooks): void {
  app.get('/api/connections', { preHandler: hooks.authenticate }, async request => app.store.listConnections(request.user!.id));

  app.post('/api/connections', { preHandler: [hooks.authenticate, hooks.validateCsrf] }, async (request, reply) => {
    try {
      const body = hooks.bodyObject(request.body);
      const dbType = connectionKind(body.dbType);
      const local = localDatabase(dbType);
      const input: ConnectionProfileInput = {
        name: hooks.requiredString(body.name, 'name'),
        host: local ? optionalLocalString(body.host, 'local') : hooks.requiredString(body.host, 'host'),
        port: typeof body.port === 'number' ? body.port : local ? 0 : undefined,
        database: hooks.requiredString(body.database, 'database'),
        user: local ? optionalLocalString(body.user, 'local') : hooks.requiredString(body.user, 'user'),
        password: local ? optionalLocalString(body.password, '') : hooks.requiredString(body.password, 'password'),
        dbType,
        readOnly: body.readOnly !== false,
      };
      return reply.code(201).send(app.store.createConnection(request.user!.id, input, encryptSecret(input.password, app.apiConfig.masterKey)));
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'INVALID_CONNECTION', message: error instanceof Error ? error.message : 'Invalid connection.' });
    }
  });

  app.put<{ Params: { id: string } }>('/api/connections/:id', { preHandler: [hooks.authenticate, hooks.validateCsrf] }, async (request, reply) => {
    try {
      const body = hooks.bodyObject(request.body);
      const dbType = connectionKind(body.dbType);
      const local = localDatabase(dbType);
      const input: ConnectionProfileUpdate = {
        name: hooks.requiredString(body.name, 'name'),
        host: local ? optionalLocalString(body.host, 'local') : hooks.requiredString(body.host, 'host'),
        port: typeof body.port === 'number' ? body.port : local ? 0 : undefined,
        database: hooks.requiredString(body.database, 'database'),
        user: local ? optionalLocalString(body.user, 'local') : hooks.requiredString(body.user, 'user'),
        password: typeof body.password === 'string' && body.password.length > 0 ? body.password : undefined,
        dbType,
        readOnly: body.readOnly !== false,
      };
      const updated = app.store.updateConnection(request.user!.id, request.params.id, input, input.password ? encryptSecret(input.password, app.apiConfig.masterKey) : undefined);
      if (!updated) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
      await app.databaseRuntimes.closeConnection(request.params.id);
      app.metadataService.invalidate(request.user!.id, request.params.id);
      for (const session of app.lspSessions) session.invalidateConnection(request.params.id);
      return updated;
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'INVALID_CONNECTION', message: error instanceof Error ? error.message : 'Invalid connection.' });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/connections/:id', { preHandler: [hooks.authenticate, hooks.validateCsrf] }, async (request, reply) => {
    if (!app.store.deleteConnection(request.user!.id, request.params.id)) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
    await app.databaseRuntimes.closeConnection(request.params.id);
    app.metadataService.invalidate(request.user!.id, request.params.id);
    for (const session of app.lspSessions) session.invalidateConnection(request.params.id);
    return { ok: true };
  });

  app.post('/api/connections/test', { preHandler: [hooks.authenticate, hooks.validateCsrf] }, async (request, reply) => {
    let testProfile: StoredConnection | undefined;
    try {
      const body = hooks.bodyObject(request.body);
      const dbType = connectionKind(body.dbType);
      const local = localDatabase(dbType);
      const password = local ? optionalLocalString(body.password, '') : hooks.requiredString(body.password, 'password');
      const encrypted = encryptSecret(password, app.apiConfig.masterKey);
      const profile: StoredConnection = {
        id: `test-${randomUUID()}`,
        name: hooks.requiredString(body.name, 'name'),
        host: local ? optionalLocalString(body.host, 'local') : hooks.requiredString(body.host, 'host'),
        port: typeof body.port === 'number' ? body.port : local ? 0 : 5480,
        database: hooks.requiredString(body.database, 'database'),
        user: local ? optionalLocalString(body.user, 'local') : hooks.requiredString(body.user, 'user'),
        dbType,
        passwordCiphertext: encrypted.ciphertext,
        passwordIv: encrypted.iv,
        passwordAuthTag: encrypted.authTag,
        readOnly: true,
        userId: request.user!.id,
        localDbRoot: app.apiConfig.localDbRoot ?? path.join(app.apiConfig.dataDir, 'local-databases'),
      };
      testProfile = profile;
      await app.databaseRuntimes.execute(profile, 'SELECT 1', { maxRows: 1, timeoutSeconds: 30, readOnly: true }, { onColumns: () => undefined, onRows: () => undefined, onCommand: () => undefined });
      return { ok: true };
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'CONNECTION_FAILED', message: error instanceof Error ? error.message : 'Connection failed.' });
    } finally {
      if (testProfile) await app.databaseRuntimes.closeConnection(testProfile.id);
    }
  });

  app.post<{ Params: { id: string } }>('/api/connections/:id/test', { preHandler: hooks.authenticate }, async (request, reply) => {
    const profile = app.store.getConnection(request.user!.id, request.params.id);
    if (!profile) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
    try {
      await app.databaseRuntimes.execute(profile, 'SELECT 1', { maxRows: 1, timeoutSeconds: 30, readOnly: true }, { onColumns: () => undefined, onRows: () => undefined, onCommand: () => undefined });
      return { ok: true };
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'CONNECTION_FAILED', message: error instanceof Error ? error.message : 'Connection failed.' });
    }
  });
}
