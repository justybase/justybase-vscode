/** @jest-environment jsdom */

import type { SchemaTreeNode } from '@justybase/contracts';
import {
  readSchemaExplorerShortcuts,
  rememberSchemaObject,
  schemaExplorerStorageKey,
  schemaObjectIdentity,
  toggleSchemaFavorite,
  writeSchemaExplorerShortcuts,
} from '../src/renderer/schemaExplorerState';

const orders: SchemaTreeNode = {
  id: 'old-id',
  kind: 'object',
  label: 'Orders',
  database: 'DB1',
  schema: 'dbo',
  objectName: 'Orders',
  objectType: 'TABLE',
  hasChildren: true,
};

describe('Electron schema explorer persistence', () => {
  beforeEach(() => localStorage.clear());

  it('keys shortcuts by an encoded connection profile and ignores corrupt entries', () => {
    const connectionId = 'profile/with spaces';
    const key = schemaExplorerStorageKey(connectionId);
    expect(key).toContain(encodeURIComponent(connectionId));
    localStorage.setItem(key, JSON.stringify({ favorites: [orders, { kind: 'schema' }], recent: 'not-an-array' }));
    expect(readSchemaExplorerShortcuts(connectionId)).toEqual({ favorites: [orders], recent: [] });

    localStorage.setItem(key, '{not-json');
    expect(readSchemaExplorerShortcuts(connectionId)).toEqual({ favorites: [], recent: [] });
  });

  it('deduplicates by catalog identity when metadata IDs change', () => {
    const refreshed = { ...orders, id: 'new-id', label: 'Orders (refreshed)' };
    expect(schemaObjectIdentity(orders)).toBe(schemaObjectIdentity(refreshed));
    expect(rememberSchemaObject([orders], refreshed)).toEqual([expect.objectContaining({ id: 'new-id', label: 'Orders (refreshed)' })]);
    expect(toggleSchemaFavorite([orders], refreshed)).toEqual([]);
  });

  it('writes only bounded object shortcuts and excludes non-object metadata', () => {
    const schemas = Array.from({ length: 25 }, (_, index) => ({ ...orders, id: `id-${index}`, label: `Table${index}`, objectName: `Table${index}` }));
    writeSchemaExplorerShortcuts('connection-1', {
      favorites: [{ ...orders, kind: 'schema', id: 'schema', label: 'dbo' }, ...schemas],
      recent: schemas,
    });
    const stored = readSchemaExplorerShortcuts('connection-1');
    expect(stored.favorites).toHaveLength(20);
    expect(stored.recent).toHaveLength(8);
    expect(stored.favorites.every(node => node.kind === 'object')).toBe(true);
    expect(localStorage.getItem(schemaExplorerStorageKey('connection-1'))).not.toContain('viewSql');
  });
});
