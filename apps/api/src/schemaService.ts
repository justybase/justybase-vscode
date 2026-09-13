import type { SchemaSearchRequest, SchemaSearchResponse, SchemaTreeNode, SchemaTreeResponse } from '@justybase/contracts';
import type { ApiDatabaseRuntimeRegistry } from './databaseRuntime/contracts';
import type { AppStore, StoredConnection } from './store';
import { ApiMetadataService } from './metadataCache';

const GROUPS = ['TABLE', 'VIEW', 'SYNONYM', 'EXTERNAL TABLE', 'PROCEDURE'] as const;
const GROUP_LABELS: Readonly<Record<typeof GROUPS[number], string>> = {
  // The VS Code Netezza explorer renders the object type token itself. Keep
  // the web tree consistent with that reference, including its casing and
  // singular form (the group is TABLE, not a generated "TABLEs").
  TABLE: 'TABLE',
  VIEW: 'VIEW',
  SYNONYM: 'SYNONYM',
  'EXTERNAL TABLE': 'EXTERNAL TABLE',
  PROCEDURE: 'PROCEDURE',
};

function encodeNode(value: object): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeNode(value: string): Record<string, string> { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, string>; }
function node(kind: SchemaTreeNode['kind'], label: string, values: Record<string, string | undefined>, hasChildren: boolean, extra: Partial<SchemaTreeNode> = {}): SchemaTreeNode {
  return { id: encodeNode({ kind, ...values }), kind, label, hasChildren, ...values, ...extra };
}

function profileFor(store: AppStore, userId: string, connectionId: string): StoredConnection {
  const profile = store.getConnection(userId, connectionId);
  if (!profile) throw new Error('Connection profile not found.');
  return profile;
}

export async function getSchemaTree(
  store: AppStore,
  runtimes: ApiDatabaseRuntimeRegistry,
  userId: string,
  connectionId: string,
  parentId?: string,
  metadataService = new ApiMetadataService(),
): Promise<SchemaTreeResponse> {
  const profile = profileFor(store, userId, connectionId);
  if (!parentId) {
    const result = await metadataService.listDatabasesWithState(runtimes, userId, profile);
    return { nodes: result.value.map(item => node('database', item.name, { connectionId, database: item.name }, true)), stale: result.stale };
  }
  const parent = decodeNode(parentId);
  if (parent.kind === 'database') {
    const database = parent.database ?? '';
    // The desktop Netezza explorer deliberately flattens the schema level:
    // database -> object type -> objects. Each object keeps its schema in the
    // inline description (for example `DIMDATE (ADMIN)`), which is both more
    // compact and consistent with the VS Code tree. Other adapters retain the
    // database -> schema -> object type hierarchy because it is useful for
    // file/portable databases and is part of their existing web contract.
    if (profile.dbType === 'netezza') {
      return { nodes: GROUPS.map(objectType => node('group', GROUP_LABELS[objectType], { connectionId, database, objectType }, true)) };
    }
    const result = await metadataService.listSchemasWithState(runtimes, userId, profile, database);
    return { nodes: result.value.map(item => node('schema', item.name, { connectionId, database, schema: item.name }, true)), stale: result.stale };
  }
  if (parent.kind === 'schema') {
    const database = parent.database ?? '';
    const schema = parent.schema ?? '';
    return { nodes: GROUPS.map(objectType => node('group', GROUP_LABELS[objectType], { connectionId, database, schema, objectType }, true)) };
  }
  if (parent.kind === 'group') {
    const database = parent.database ?? '';
    const schema = parent.schema ?? '';
    const objectType = parent.objectType ?? 'TABLE';
    const result = await metadataService.listObjectsWithState(runtimes, userId, profile, database, schema);
    const items = result.value.filter(item => item.objectType?.trim().toUpperCase() === objectType).map(item => node('object', item.name, {
      connectionId,
      database,
      // Flat Netezza groups contain objects from more than one schema. Keep
      // the per-object catalog value so qualification and column loading use
      // the same schema the desktop tree displays inline.
      schema: item.schema?.trim() || schema,
      objectName: item.name,
      objectType,
    }, true, {
      description: item.description,
      viewSql: item.viewSql,
    }));
    return { nodes: items, stale: result.stale };
  }
  if (parent.kind === 'object') {
    const database = parent.database ?? '';
    const schema = parent.schema ?? '';
    const table = parent.objectName ?? '';
    const result = await metadataService.listColumnsWithState(runtimes, userId, profile, database, schema, table);
    return { nodes: result.value.map(item => node('column', item.name, { connectionId, database, schema, objectName: table, columnType: item.type }, false, { description: item.description })), stale: result.stale };
  }
  return { nodes: [] };
}

export async function searchSchema(
  store: AppStore,
  runtimes: ApiDatabaseRuntimeRegistry,
  userId: string,
  request: SchemaSearchRequest,
  metadataService = new ApiMetadataService(),
): Promise<SchemaSearchResponse> {
  const profile = profileFor(store, userId, request.connectionId);
  const term = request.term.trim().toUpperCase();
  if (!term) return { items: [] };
  const databases = request.database ? [{ name: request.database }] : await metadataService.listDatabases(runtimes, userId, profile);
  const items: SchemaSearchResponse['items'] = [];
  for (const database of databases.slice(0, request.searchAllDatabases ? databases.length : 1)) {
    const schemas = request.schema ? [{ name: request.schema, database: database.name }] : await metadataService.listSchemas(runtimes, userId, profile, database.name);
    for (const schema of schemas) {
      const objects = await metadataService.listObjects(runtimes, userId, profile, database.name, schema.name);
      for (const object of objects) {
        const type = object.objectType?.toUpperCase() ?? 'OBJECT';
        if (request.objectTypes?.length && !request.objectTypes.some(item => item.toUpperCase() === type)) continue;
        const nameMatch = object.name.toUpperCase().includes(term);
        const descriptionMatch = object.description?.toUpperCase().includes(term) ?? false;
        if (nameMatch || descriptionMatch) items.push({ name: object.name, database: database.name, schema: schema.name, objectType: type, description: object.description, matchType: nameMatch ? 'name' : 'description' });
        if (items.length >= 500) return { items };
      }
    }
  }
  return { items };
}
