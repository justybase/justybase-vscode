import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { DesignerSnapshotUnavailableError, getDesignerSnapshotResponse } from '../designerSnapshotService';
import { getDesignerCapabilitiesResponse } from '../designerService';
import { parseDesignerCapabilitiesRequest } from '../requestValidation';

export interface DesignerRouteHooks {
  authenticate: preHandlerHookHandler;
}

/** Designer capability and snapshot routes. */
export function registerDesignerRoutes(app: FastifyInstance, hooks: DesignerRouteHooks): void {
  app.get('/api/designer/capabilities', { preHandler: hooks.authenticate }, async (request, reply) => {
    try {
      const input = parseDesignerCapabilitiesRequest(request.query);
      const profile = app.store.getConnection(request.user!.id, input.connectionId);
      if (!profile) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
      return getDesignerCapabilitiesResponse(profile, input, app.databaseRuntimes);
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'DESIGNER_CAPABILITIES_FAILED', message: error instanceof Error ? error.message : 'Designer capabilities failed.' });
    }
  });

  app.get('/api/designer/snapshot', { preHandler: hooks.authenticate }, async (request, reply) => {
    try {
      const input = parseDesignerCapabilitiesRequest(request.query);
      const profile = app.store.getConnection(request.user!.id, input.connectionId);
      if (!profile) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
      return await getDesignerSnapshotResponse(profile, input, app.databaseRuntimes);
    } catch (error: unknown) {
      const statusCode = error instanceof Error && 'code' in error && error.code === 'DESIGNER_SNAPSHOT_UNAVAILABLE' ? 501 : 400;
      return reply.code(statusCode).send({
        code: error instanceof DesignerSnapshotUnavailableError ? error.code : 'DESIGNER_SNAPSHOT_FAILED',
        message: error instanceof Error ? error.message : 'Designer snapshot failed.',
      });
    }
  });
}
