import type { SchemaSearchRequest, SchemaSearchResponse, SchemaTreeNode, SchemaTreeResponse } from '@justybase/contracts';
import { listColumns, listDatabases, listObjects, listSchemas } from './netezza';
import type { ApiConfig } from './config';
import type { AppStore, StoredConnection } from './store';

const TTL_MS = 12 * 60 * 60 * 1000;
const GROUPS = ['TABLE', 'VIEW', 'SYNONYM', 'EXTERNAL TABLE', 'PROCEDURE'];

interface CacheEntry<T> { value: T; expiresAt: number; }

const cache = new Map<string, CacheEntry<unknown>>();

export function invalidateSchemaCache(connectionId: string): void {
  const prefix = `${connectionId}|`;
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}

function cacheKey(profile: StoredConnection, kind: string, ...parts: string[]): string { return `${profile.id}|${kind}|${parts.map(part => part.toUpperCase()).join('|')}`; }
function encodeNode(value: object): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeNode(value: string): Record<string, string> { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, string>; }
function node(kind: SchemaTreeNode['kind'], label: string, values: Record<string, string | undefined>, hasChildren: boolean, extra: Partial<SchemaTreeNode> = {}): SchemaTreeNode {
  return { id: encodeNode({ kind, ...values }), kind, label, hasChildren, ...values, ...extra };
}

async function cached<T>(key: string, loader: () => Promise<T>): Promise<{ value: T; stale: boolean }> {
  const current = cache.get(key) as CacheEntry<T> | undefined;
  if (current && current.expiresAt > Date.now()) return { value: current.value, stale: false };
  try {
    const value = await loader();
    cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
    return { value, stale: false };
  } catch (error: unknown) {
    if (current) return { value: current.value, stale: true };
    throw error;
  }
}

function profileFor(store: AppStore, userId: string, connectionId: string): StoredConnection {
  const profile = store.getConnection(userId, connectionId);
  if (!profile) throw new Error('Connection profile not found.');
  return profile;
}

export async function getSchemaTree(store: AppStore, config: ApiConfig, userId: string, connectionId: string, parentId?: string): Promise<SchemaTreeResponse> {
  const profile = profileFor(store, userId, connectionId);
  if (!parentId) {
    const result = await cached(cacheKey(profile, 'databases'), () => listDatabases(profile, config.masterKey));
    return { nodes: result.value.map(item => node('database', item.name, { connectionId, database: item.name }, true)), stale: result.stale };
  }
  const parent = decodeNode(parentId);
  if (parent.kind === 'database') {
    const database = parent.database ?? '';
    const result = await cached(cacheKey(profile, 'schemas', database), () => listSchemas(profile, database, config.masterKey));
    return { nodes: result.value.map(item => node('schema', item.name, { connectionId, database, schema: item.name }, true)), stale: result.stale };
  }
  if (parent.kind === 'schema') {
    const database = parent.database ?? '';
    const schema = parent.schema ?? '';
    return { nodes: GROUPS.map(objectType => node('group', `${objectType}s`, { connectionId, database, schema, objectType }, true)) };
  }
  if (parent.kind === 'group') {
    const database = parent.database ?? '';
    const schema = parent.schema ?? '';
    const objectType = parent.objectType ?? 'TABLE';
    const result = await cached(cacheKey(profile, 'objects', database, schema), () => listObjects(profile, database, schema, config.masterKey));
    const items = result.value.filter(item => item.objectType?.toUpperCase() === objectType).map(item => node('object', item.name, { connectionId, database, schema, objectName: item.name, objectType }, true, { description: item.description }));
    return { nodes: items, stale: result.stale };
  }
  if (parent.kind === 'object') {
    const database = parent.database ?? '';
    const schema = parent.schema ?? '';
    const table = parent.objectName ?? '';
    const result = await cached(cacheKey(profile, 'columns', database, schema, table), () => listColumns(profile, database, schema, table, config.masterKey));
    return { nodes: result.value.map(item => node('column', item.name, { connectionId, database, schema, objectName: table, columnType: item.type }, false, { description: item.description })), stale: result.stale };
  }
  return { nodes: [] };
}

export async function searchSchema(store: AppStore, config: ApiConfig, userId: string, request: SchemaSearchRequest): Promise<SchemaSearchResponse> {
  const profile = profileFor(store, userId, request.connectionId);
  const term = request.term.trim().toUpperCase();
  if (!term) return { items: [] };
  const databases = request.database ? [{ name: request.database }] : await listDatabases(profile, config.masterKey);
  const items: SchemaSearchResponse['items'] = [];
  for (const database of databases.slice(0, request.searchAllDatabases ? databases.length : 1)) {
    const schemas = request.schema ? [{ name: request.schema }] : await listSchemas(profile, database.name, config.masterKey);
    for (const schema of schemas) {
      const objects = await listObjects(profile, database.name, schema.name, config.masterKey);
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
