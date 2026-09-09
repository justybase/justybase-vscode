import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { createQueryExportStream } from '../queryExport';
import { parseQueryAggregateRequest, parseQueryExportRequest, parseQueryGroupRequest, parseQueryPageRequest } from '../requestValidation';

export interface ResultRouteHooks {
  authenticate: preHandlerHookHandler;
  queryRateLimit: preHandlerHookHandler;
  validateCsrf: preHandlerHookHandler;
}

function sessionFor(app: FastifyInstance, queryId: string, userId: string, statementIndex: number): string | undefined {
  const job = app.queryJobs.get(queryId);
  if (job && job.userId !== userId) return undefined;
  return job?.sessionIds.get(statementIndex) ?? app.querySessions.querySessionId(userId, queryId, statementIndex);
}

/** Query result paging, aggregation, grouping, and export routes. */
export function registerResultRoutes(app: FastifyInstance, hooks: ResultRouteHooks): void {
  const preHandler = [hooks.authenticate, hooks.queryRateLimit, hooks.validateCsrf];

  app.post<{ Params: { id: string } }>('/api/query/:id/page', { preHandler }, async (request, reply) => {
    const input = parseQueryPageRequest(request.body);
    const statementIndex = Number.isInteger(input.statementIndex) && (input.statementIndex ?? 0) >= 0 ? input.statementIndex ?? 0 : 0;
    const sessionId = sessionFor(app, request.params.id, request.user!.id, statementIndex);
    if (!sessionId) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Query result session not found.' });
    try { return app.querySessions.page(request.user!.id, sessionId, input); }
    catch (error: unknown) { return reply.code(410).send({ code: 'RESULT_EXPIRED', message: error instanceof Error ? error.message : 'Query result expired.' }); }
  });

  app.post<{ Params: { id: string } }>('/api/query/:id/aggregate', { preHandler }, async (request, reply) => {
    const input = parseQueryAggregateRequest(request.body);
    const statementIndex = Number.isInteger(input.statementIndex) && (input.statementIndex ?? 0) >= 0 ? input.statementIndex ?? 0 : 0;
    const sessionId = sessionFor(app, request.params.id, request.user!.id, statementIndex);
    if (!sessionId) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Query result session not found.' });
    try { return app.querySessions.aggregate(request.user!.id, sessionId, input); }
    catch (error: unknown) { return reply.code(410).send({ code: 'RESULT_EXPIRED', message: error instanceof Error ? error.message : 'Query result expired.' }); }
  });

  app.post<{ Params: { id: string } }>('/api/query/:id/group', { preHandler }, async (request, reply) => {
    const input = parseQueryGroupRequest(request.body);
    const statementIndex = Number.isInteger(input.statementIndex) && (input.statementIndex ?? 0) >= 0 ? input.statementIndex ?? 0 : 0;
    const sessionId = sessionFor(app, request.params.id, request.user!.id, statementIndex);
    if (!sessionId) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Query result session not found.' });
    try { return app.querySessions.group(request.user!.id, sessionId, input); }
    catch (error: unknown) { return reply.code(410).send({ code: 'RESULT_EXPIRED', message: error instanceof Error ? error.message : 'Query result grouping failed.' }); }
  });

  app.post<{ Params: { id: string } }>('/api/query/:id/export', { preHandler }, async (request, reply) => {
    const input = parseQueryExportRequest(request.body);
    const statementIndex = Number.isInteger(input.statementIndex) && (input.statementIndex ?? 0) >= 0 ? input.statementIndex ?? 0 : 0;
    const sessionId = sessionFor(app, request.params.id, request.user!.id, statementIndex);
    if (!sessionId) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Query result session not found.' });
    try {
      const exported = createQueryExportStream(app.querySessions, request.user!.id, sessionId, input);
      const fileName = (typeof input.fileName === 'string' && input.fileName.trim() ? input.fileName.trim().replace(/[^A-Za-z0-9._-]/g, '_') : `justybase-query-${request.params.id}`).replace(/\.+$/u, '') || `justybase-query-${request.params.id}`;
      reply.header('Content-Type', exported.contentType);
      reply.header('Content-Disposition', `attachment; filename="${fileName}.${exported.extension}"`);
      return reply.send(exported.stream);
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'EXPORT_FAILED', message: error instanceof Error ? error.message : 'Query export failed.' });
    }
  });
}
