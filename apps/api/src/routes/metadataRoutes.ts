import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { getSchemaObjectDdlResponse, SchemaDdlUnavailableError } from '../schemaDdlService';
import { getSchemaTree, searchSchema } from '../schemaService';
import { parseMetadataDdlRequest } from '../requestValidation';

export interface MetadataRouteHooks {
  authenticate: preHandlerHookHandler;
  validateCsrf: preHandlerHookHandler;
}

/** Metadata catalog and schema navigation routes. */
export function registerMetadataRoutes(app: FastifyInstance, hooks: MetadataRouteHooks): void {
  app.get('/api/metadata/databases', { preHandler: hooks.authenticate }, async (request, reply) => {
    const id = String((request.query as { connectionId?: string }).connectionId ?? '');
    const profile = app.store.getConnection(request.user!.id, id);
    if (!profile) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
    return app.metadataService.listDatabases(app.databaseRuntimes, request.user!.id, profile);
  });
  app.get('/api/metadata/schemas', { preHandler: hooks.authenticate }, async (request, reply) => {
    const query = request.query as { connectionId?: string; database?: string };
    const profile = app.store.getConnection(request.user!.id, String(query.connectionId ?? ''));
    if (!profile || !query.database) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection or database not found.' });
    return app.metadataService.listSchemas(app.databaseRuntimes, request.user!.id, profile, query.database);
  });
  app.get('/api/metadata/objects', { preHandler: hooks.authenticate }, async (request, reply) => {
    const query = request.query as { connectionId?: string; database?: string; schema?: string };
    const profile = app.store.getConnection(request.user!.id, String(query.connectionId ?? ''));
    if (!profile || !query.database) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection or database not found.' });
    return app.metadataService.listObjects(app.databaseRuntimes, request.user!.id, profile, query.database, query.schema);
  });
  app.get('/api/metadata/columns', { preHandler: hooks.authenticate }, async (request, reply) => {
    const query = request.query as { connectionId?: string; database?: string; schema?: string; table?: string };
    const profile = app.store.getConnection(request.user!.id, String(query.connectionId ?? ''));
    if (!profile || !query.database || !query.schema || !query.table) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Table scope not found.' });
    return app.metadataService.listColumns(app.databaseRuntimes, request.user!.id, profile, query.database, query.schema, query.table);
  });

  app.get('/api/metadata/ddl', { preHandler: hooks.authenticate }, async (request, reply) => {
    try {
      const input = parseMetadataDdlRequest(request.query);
      const profile = app.store.getConnection(request.user!.id, input.connectionId);
      if (!profile) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
      return await getSchemaObjectDdlResponse(profile, input, app.databaseRuntimes);
    } catch (error: unknown) {
      const statusCode = error instanceof SchemaDdlUnavailableError ? 501 : 400;
      return reply.code(statusCode).send({
        code: error instanceof SchemaDdlUnavailableError ? error.code : 'SCHEMA_DDL_FAILED',
        message: error instanceof Error ? error.message : 'Schema DDL generation failed.',
      });
    }
  });

  app.get('/api/schema/tree', { preHandler: hooks.authenticate }, async (request, reply) => {
    const query = request.query as { connectionId?: string; parentId?: string };
    if (!query.connectionId) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'connectionId is required.' });
    try { return await getSchemaTree(app.store, app.databaseRuntimes, request.user!.id, query.connectionId, query.parentId, app.metadataService); }
    catch (error: unknown) { return reply.code(400).send({ code: 'SCHEMA_TREE_FAILED', message: error instanceof Error ? error.message : 'Schema tree failed.' }); }
  });
  app.post('/api/schema/search', { preHandler: [hooks.authenticate, hooks.validateCsrf] }, async (request, reply) => {
    try { return await searchSchema(app.store, app.databaseRuntimes, request.user!.id, request.body as import('@justybase/contracts').SchemaSearchRequest, app.metadataService); }
    catch (error: unknown) { return reply.code(400).send({ code: 'SCHEMA_SEARCH_FAILED', message: error instanceof Error ? error.message : 'Schema search failed.' }); }
  });
}
