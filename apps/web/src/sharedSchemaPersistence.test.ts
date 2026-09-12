import type { SchemaTreeNode } from '@justybase/contracts';
import type { WorkspaceStorage } from './workspacePersistence';
import { readSharedSchemaShortcuts, rememberSharedSchemaObject, sharedSchemaObjectIdentity, toggleSharedSchemaFavorite, writeSharedSchemaShortcuts } from './sharedSchemaPersistence';

function memoryStorage(): WorkspaceStorage {
  const values = new Map<string, string>();
  return {
    userId: 'schema-user',
    get: key => values.get(key) ?? null,
    set: (key, value) => { values.set(key, value); },
    remove: key => { values.delete(key); },
  };
}

function objectNode(id: string, name = id): SchemaTreeNode {
  return { id, kind: 'object', label: name, database: 'DB', schema: 'PUBLIC', objectName: name, objectType: 'TABLE', hasChildren: true, viewSql: 'SELECT secret_metadata' };
}

describe('shared Web schema shortcut persistence', () => {
  it('round-trips only safe object metadata and tolerates malformed storage', () => {
    const storage = memoryStorage();
    writeSharedSchemaShortcuts(storage, 'connection-1', { favorites: [objectNode('one')], recent: [objectNode('two')] });
    const restored = readSharedSchemaShortcuts(storage, 'connection-1');
    expect(restored.favorites[0]).toEqual(expect.objectContaining({ id: 'one', objectName: 'one' }));
    expect(restored.favorites[0]).not.toHaveProperty('viewSql');
    expect(readSharedSchemaShortcuts({ ...storage, get: () => '{bad json' }, 'connection-1')).toEqual({ favorites: [], recent: [] });
  });

  it('deduplicates recent objects and toggles favorites by catalog identity', () => {
    const original = objectNode('unstable-id', 'ORDERS');
    const refreshed = objectNode('new-id', 'ORDERS');
    expect(sharedSchemaObjectIdentity(original)).toBe(sharedSchemaObjectIdentity(refreshed));
    expect(rememberSharedSchemaObject([original], refreshed)).toHaveLength(1);
    expect(rememberSharedSchemaObject([original], refreshed)[0]?.id).toBe('new-id');
    expect(toggleSharedSchemaFavorite([original], refreshed)).toEqual([]);
    expect(toggleSharedSchemaFavorite([], refreshed)[0]).toEqual(expect.objectContaining({ objectName: 'ORDERS' }));
  });

  it('bounds persisted shortcut collections', () => {
    const storage = memoryStorage();
    const favorites = Array.from({ length: 25 }, (_value, index) => objectNode(`favorite-${index}`));
    const recent = Array.from({ length: 12 }, (_value, index) => objectNode(`recent-${index}`));
    writeSharedSchemaShortcuts(storage, 'connection-1', { favorites, recent });
    const restored = readSharedSchemaShortcuts(storage, 'connection-1');
    expect(restored.favorites).toHaveLength(20);
    expect(restored.recent).toHaveLength(8);
  });
});
