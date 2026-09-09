import { randomBytes } from 'node:crypto';
import type { AdminRestoreRequest, AdminUserCreateRequest, AdminUserUpdateRequest } from '@justybase/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { verifyPassword } from '../security';

export interface AuthAdminRouteHooks {
  authenticate: preHandlerHookHandler;
  validateCsrf: preHandlerHookHandler;
  requireAdmin: preHandlerHookHandler;
  loginRateLimit: preHandlerHookHandler;
  sessionCookie: string;
  setSessionCookie(reply: FastifyReply, token: string, request: FastifyRequest): void;
  issueCsrfToken(reply: FastifyReply, request: FastifyRequest): string;
  bodyObject(value: unknown): Record<string, unknown>;
  requiredString(value: unknown, field: string): string;
  restoreBodyLimit: number;
  backup(): Promise<{ data: Buffer; fileName: string }>;
  restore(app: FastifyInstance, input: AdminRestoreRequest): Promise<Record<string, unknown>>;
}

/** Authentication and user-administration HTTP routes. */
export function registerAuthAdminRoutes(app: FastifyInstance, hooks: AuthAdminRouteHooks): void {
  app.post('/api/auth/login', { preHandler: hooks.loginRateLimit }, async (request, reply) => {
    const body = hooks.bodyObject(request.body);
    const username = hooks.requiredString(body.username, 'username');
    const password = hooks.requiredString(body.password, 'password');
    const row = app.store.findUserByUsername(username);
    if (!row || !verifyPassword(password, row.password_hash)) {
      return reply.code(401).send({ code: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' });
    }
    const token = randomBytes(32).toString('base64url');
    app.store.createSession(row.id, token, Date.now() + 7 * 24 * 60 * 60 * 1000);
    hooks.setSessionCookie(reply, token, request);
    return { user: { id: row.id, username: row.username, role: row.role } };
  });

  app.get('/api/auth/csrf', async (request, reply) => ({ csrfToken: hooks.issueCsrfToken(reply, request) }));

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[hooks.sessionCookie];
    if (token) app.store.deleteSession(token);
    reply.clearCookie(hooks.sessionCookie, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: hooks.authenticate }, async request => ({ user: request.user }));

  app.get('/api/admin/users', { preHandler: [hooks.authenticate, hooks.requireAdmin] }, async () => app.store.listUsers());
  app.post('/api/admin/users', { preHandler: [hooks.authenticate, hooks.requireAdmin, hooks.validateCsrf] }, async (request, reply) => {
    try {
      const input = request.body as AdminUserCreateRequest;
      const username = hooks.requiredString(input.username, 'username');
      const password = hooks.requiredString(input.password, 'password');
      if (password.length < 8) throw new Error('password must contain at least 8 characters.');
      const role = input.role === 'admin' ? 'admin' : 'user';
      const created = app.store.createUser(username, password, role);
      return reply.code(201).send(app.store.listUsers().find(user => user.id === created.id));
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'INVALID_USER', message: error instanceof Error ? error.message : 'Invalid user.' });
    }
  });

  app.patch<{ Params: { id: string } }>('/api/admin/users/:id', { preHandler: [hooks.authenticate, hooks.requireAdmin, hooks.validateCsrf] }, async (request, reply) => {
    try {
      const input = request.body as AdminUserUpdateRequest;
      if (input.password !== undefined && input.password.length < 8) throw new Error('password must contain at least 8 characters.');
      const updated = app.store.updateUser(request.params.id, input);
      if (!updated) return reply.code(404).send({ code: 'NOT_FOUND', message: 'User not found.' });
      return updated;
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'INVALID_USER', message: error instanceof Error ? error.message : 'Invalid user update.' });
    }
  });

  app.get('/api/admin/backup', { preHandler: [hooks.authenticate, hooks.requireAdmin] }, async (_request, reply) => {
    const backup = await hooks.backup();
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${backup.fileName}"`);
    return reply.send(backup.data);
  });

  app.post('/api/admin/restore', { bodyLimit: hooks.restoreBodyLimit, preHandler: [hooks.authenticate, hooks.requireAdmin, hooks.validateCsrf] }, async (request, reply) => {
    try {
      return reply.code(200).send(await hooks.restore(app, request.body as AdminRestoreRequest));
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'RESTORE_REJECTED', message: error instanceof Error ? error.message : 'Backup restore failed.' });
    }
  });
}
