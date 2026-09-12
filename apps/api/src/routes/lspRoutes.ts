import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { tryNormalizeDatabaseKind, type SqlCompletionRequest, type SqlDiagnosticsRequest, type SqlFormatRequest } from '@justybase/contracts';
import { formatSqlDocument, provideSqlCompletion, provideSqlDiagnostics } from '../lsp';
import { attachLspSocket } from '../lspProtocol';
import { loadSqlSnippets } from '../snippets';
import { createWebSocketOriginGuard } from '../webSocketOrigin';

export interface LspRouteHooks {
  authenticate: preHandlerHookHandler;
  validateCsrf: preHandlerHookHandler;
}

/** HTTP and WebSocket language-service routes. */
export function registerLspRoutes(app: FastifyInstance, hooks: LspRouteHooks): void {
  const webSocketOriginGuard = createWebSocketOriginGuard(app.apiConfig.webOrigins ?? []);
  app.post('/api/lsp/completion', { preHandler: [hooks.authenticate, hooks.validateCsrf] }, async (request, reply) => {
    try { return await provideSqlCompletion(app.store, app.databaseRuntimes, request.user!.id, request.body as SqlCompletionRequest, app.metadataService); }
    catch (error: unknown) { return reply.code(400).send({ code: 'LSP_COMPLETION_FAILED', message: error instanceof Error ? error.message : 'Completion failed.' }); }
  });
  app.post('/api/lsp/diagnostics', { preHandler: [hooks.authenticate, hooks.validateCsrf] }, async (request, reply) => {
    try { return await provideSqlDiagnostics(app.store, app.databaseRuntimes, request.user!.id, request.body as SqlDiagnosticsRequest, app.metadataService); }
    catch (error: unknown) { return reply.code(400).send({ code: 'LSP_DIAGNOSTICS_FAILED', message: error instanceof Error ? error.message : 'Diagnostics failed.' }); }
  });
  app.post('/api/lsp/format', { preHandler: [hooks.authenticate, hooks.validateCsrf] }, async (request, reply) => {
    try { return await formatSqlDocument(app.store, app.apiConfig, request.user!.id, request.body as SqlFormatRequest); }
    catch (error: unknown) { return reply.code(400).send({ code: 'LSP_FORMAT_FAILED', message: error instanceof Error ? error.message : 'Formatting failed.' }); }
  });
  app.get('/api/lsp/snippets', { preHandler: hooks.authenticate }, async request => {
    const rawKind = typeof request.query === 'object' && request.query !== null && 'databaseKind' in request.query
      ? (request.query as { databaseKind?: unknown }).databaseKind
      : undefined;
    const databaseKind = typeof rawKind === 'string' ? tryNormalizeDatabaseKind(rawKind) ?? 'netezza' : 'netezza';
    return { snippets: loadSqlSnippets(databaseKind) };
  });
  app.get('/api/lsp', { websocket: true, preValidation: [webSocketOriginGuard, hooks.authenticate] }, (socket, request) => {
    const session = attachLspSocket(socket, app.store, app.databaseRuntimes, request.user!.id, closed => app.lspSessions.delete(closed), app.metadataService);
    app.lspSessions.add(session);
  });
}
