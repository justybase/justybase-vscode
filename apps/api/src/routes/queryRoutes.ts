import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type {
  QueryEditPreviewRequest,
  QueryEditRequest,
  QueryFileImportPreviewRequest,
  QueryFileImportRequest,
  QueryImportPreviewRequest,
  QueryImportRequest,
  QueryPreviewResponse,
  QueryStartRequest,
  QueryWriteResponse,
  WriteOperationPreviewResponse,
} from '@justybase/contracts';
import { DesignerSnapshotUnavailableError } from '../designerSnapshotService';
import { StaleDesignerSnapshotError } from '@justybase/database-runtime';
import { parseQueryStartRequest, RequestValidationError } from '../requestValidation';
import { createWebSocketOriginGuard } from '../webSocketOrigin';

export interface QueryRouteHooks {
  authenticate: preHandlerHookHandler;
  queryRateLimit: preHandlerHookHandler;
  validateCsrf: preHandlerHookHandler;
  importBodyLimit: number;
  previewQuery(userId: string, input: QueryStartRequest): Promise<QueryPreviewResponse>;
  startQuery(userId: string, input: QueryStartRequest): Promise<{ queryId: string; statementCount: number }>;
  editPreview(userId: string, input: QueryEditPreviewRequest): Promise<WriteOperationPreviewResponse>;
  edit(userId: string, input: QueryEditRequest): Promise<QueryWriteResponse>;
  importPreview(userId: string, input: QueryImportPreviewRequest): Promise<WriteOperationPreviewResponse>;
  importRows(userId: string, input: QueryImportRequest): Promise<QueryWriteResponse>;
  importFilePreview(userId: string, input: QueryFileImportPreviewRequest): Promise<WriteOperationPreviewResponse>;
  importFile(userId: string, input: QueryFileImportRequest): Promise<QueryWriteResponse>;
}

function connectionIdFromWriteBody(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestValidationError('request body must be a JSON object.');
  }
  const connectionId = (value as { connectionId?: unknown }).connectionId;
  if (typeof connectionId !== 'string' || connectionId.trim().length === 0) {
    throw new RequestValidationError('connectionId is required.');
  }
  return connectionId;
}

/** Query preview/start/cancellation and result-stream WebSocket routes. */
export function registerQueryRoutes(app: FastifyInstance, hooks: QueryRouteHooks): void {
  const preHandler = [hooks.authenticate, hooks.queryRateLimit, hooks.validateCsrf];
  const webSocketOriginGuard = createWebSocketOriginGuard(app.apiConfig.webOrigins ?? []);

  app.post('/api/query/preview', { preHandler }, async (request, reply) => {
    try {
      return reply.code(200).send(await hooks.previewQuery(request.user!.id, parseQueryStartRequest(request.body)));
    } catch (error: unknown) {
      const statusCode = error instanceof StaleDesignerSnapshotError ? 409 : error instanceof DesignerSnapshotUnavailableError ? 501 : 400;
      return reply.code(statusCode).send({
        code: error instanceof RequestValidationError ? error.code : error instanceof StaleDesignerSnapshotError ? error.code : error instanceof DesignerSnapshotUnavailableError ? error.code : 'QUERY_PREVIEW_REJECTED',
        message: error instanceof Error ? error.message : 'Query preview rejected.',
      });
    }
  });

  app.post('/api/query', { preHandler }, async (request, reply) => {
    try {
      return reply.code(202).send(await hooks.startQuery(request.user!.id, parseQueryStartRequest(request.body)));
    } catch (error: unknown) {
      const statusCode = error instanceof StaleDesignerSnapshotError ? 409 : error instanceof DesignerSnapshotUnavailableError ? 501 : 400;
      return reply.code(statusCode).send({
        code: error instanceof RequestValidationError ? error.code : error instanceof StaleDesignerSnapshotError ? error.code : error instanceof DesignerSnapshotUnavailableError ? error.code : 'QUERY_REJECTED',
        message: error instanceof Error ? error.message : 'Query rejected.',
      });
    }
  });

  app.post('/api/query/edit/preview', { preHandler }, async (request, reply) => {
    try {
      return reply.code(200).send(await hooks.editPreview(request.user!.id, request.body as QueryEditPreviewRequest));
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'EDIT_PREVIEW_REJECTED', message: error instanceof Error ? error.message : 'Edit preview rejected.' });
    }
  });

  app.post('/api/query/edit', { preHandler }, async (request, reply) => {
    try {
      const input = request.body as QueryEditRequest;
      if (!app.store.getConnection(request.user!.id, connectionIdFromWriteBody(input))) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
      return reply.code(200).send(await hooks.edit(request.user!.id, input));
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'EDIT_REJECTED', message: error instanceof Error ? error.message : 'Edit rejected.' });
    }
  });

  app.post('/api/query/import/preview', { bodyLimit: hooks.importBodyLimit, preHandler }, async (request, reply) => {
    try {
      return reply.code(200).send(await hooks.importPreview(request.user!.id, request.body as QueryImportPreviewRequest));
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'IMPORT_PREVIEW_REJECTED', message: error instanceof Error ? error.message : 'Import preview rejected.' });
    }
  });

  app.post('/api/query/import', { bodyLimit: hooks.importBodyLimit, preHandler }, async (request, reply) => {
    try {
      const input = request.body as QueryImportRequest;
      if (!app.store.getConnection(request.user!.id, connectionIdFromWriteBody(input))) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
      return reply.code(200).send(await hooks.importRows(request.user!.id, input));
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'IMPORT_REJECTED', message: error instanceof Error ? error.message : 'Import rejected.' });
    }
  });

  app.post('/api/query/import-file/preview', { bodyLimit: hooks.importBodyLimit, preHandler }, async (request, reply) => {
    try {
      return reply.code(200).send(await hooks.importFilePreview(request.user!.id, request.body as QueryFileImportPreviewRequest));
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'FILE_IMPORT_PREVIEW_REJECTED', message: error instanceof Error ? error.message : 'File import preview rejected.' });
    }
  });

  app.post('/api/query/import-file', { bodyLimit: hooks.importBodyLimit, preHandler }, async (request, reply) => {
    try {
      const input = request.body as QueryFileImportRequest;
      if (!app.store.getConnection(request.user!.id, connectionIdFromWriteBody(input))) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
      return reply.code(200).send(await hooks.importFile(request.user!.id, input));
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'FILE_IMPORT_REJECTED', message: error instanceof Error ? error.message : 'File import rejected.' });
    }
  });

  app.post<{ Params: { id: string } }>('/api/query/:id/cancel', { preHandler }, async (request, reply) => {
    const job = app.queryJobs.get(request.params.id);
    if (!job || job.userId !== request.user!.id) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Query not found.' });
    if (!job.done) {
      job.cancelRequested = true;
      if (job.cancel) await job.cancel();
    }
    return { ok: true };
  });

  app.get('/api/ws', { websocket: true, preValidation: [webSocketOriginGuard, hooks.authenticate] }, (socket, request) => {
    socket.on('message', (raw: Buffer) => {
      let message: { type?: string; queryId?: string; afterSequence?: number };
      try { message = JSON.parse(raw.toString()) as { type?: string; queryId?: string; afterSequence?: number }; }
      catch { socket.close(1003, 'Malformed JSON payload.'); return; }
      if (message.type !== 'subscribe' || !message.queryId) return;
      const job = app.queryJobs.get(message.queryId);
      if (!job || job.userId !== request.user!.id) { socket.close(4404, 'Query result stream not found.'); return; }
      job.subscribers.add(socket);
      const afterSequence = Number.isFinite(message.afterSequence) ? message.afterSequence ?? 0 : 0;
      for (const event of job.events) if ((event.sequence ?? 0) > afterSequence && socket.readyState === 1) socket.send(JSON.stringify(event));
      socket.once('close', () => job.subscribers.delete(socket));
    });
  });
}
