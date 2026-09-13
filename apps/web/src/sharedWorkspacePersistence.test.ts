import {
  persistSharedWorkspace,
  restoreSharedWorkspace,
  sharedDocumentSourceId,
  SHARED_WORKSPACE_STORAGE_KEY,
} from './sharedWorkspacePersistence';
import type { WorkspaceStorage } from './workspacePersistence';

function storage(initial: Record<string, string> = {}): WorkspaceStorage {
  const values = new Map(Object.entries(initial));
  return {
    userId: 'user-1',
    get: key => values.get(key) ?? null,
    set: (key, value) => { values.set(key, value); },
    remove: key => { values.delete(key); },
  };
}

describe('Shared Web workspace persistence', () => {
  it('round-trips only document metadata and keeps source identities stable', () => {
    const target = storage();
    persistSharedWorkspace(target, 'user-1', {
      documents: [{
        id: 'doc-1',
        sourceId: sharedDocumentSourceId('user-1', 'doc-1'),
        title: 'orders.sql',
        content: 'SELECT * FROM orders;',
        dirty: true,
        connectionId: 'connection-1',
        database: 'JUST_DATA',
        schema: 'ADMIN',
        databaseKind: 'netezza',
      }],
      documentOrder: ['doc-1'],
      activeDocumentId: 'doc-1',
      selectedConnectionId: 'connection-1',
    });

    const restored = restoreSharedWorkspace(target, 'user-1');
    expect(restored).toMatchObject({ documentOrder: ['doc-1'], activeDocumentId: 'doc-1', selectedConnectionId: 'connection-1', migratedFromLegacy: false });
    expect(restored.documents[0]).toEqual(expect.objectContaining({ id: 'doc-1', sourceId: 'web:user-1:document:doc-1', content: 'SELECT * FROM orders;', dirty: true }));
    expect(target.get(SHARED_WORKSPACE_STORAGE_KEY)).not.toContain('password');
    expect(target.get(SHARED_WORKSPACE_STORAGE_KEY)).not.toContain('rows');
  });

  it('migrates the old tabs payload and repairs duplicate or missing active ids', () => {
    const target = storage({
      tabs: JSON.stringify({
        tabs: [
          { id: 'legacy-1', title: 'One', sql: 'SELECT 1', dirty: false, database: 'DB1' },
          { id: 'legacy-1', title: 'Duplicate', sql: 'SELECT 2', dirty: false },
          { id: 'legacy-2', title: 'Two', sql: 'SELECT 2', dirty: true },
        ],
        activeTabId: 'missing',
      }),
    });
    const restored = restoreSharedWorkspace(target, 'user-1');
    expect(restored.migratedFromLegacy).toBe(true);
    expect(restored.documentOrder).toEqual(['legacy-1', 'legacy-2']);
    expect(restored.activeDocumentId).toBe('legacy-1');
    expect(restored.documents.map(document => document.sourceId)).toEqual([
      sharedDocumentSourceId('user-1', 'legacy-1'),
      sharedDocumentSourceId('user-1', 'legacy-2'),
    ]);
  });

  it('falls back to a fresh scratch document for corrupt or foreign envelopes', () => {
    const corrupt = storage({ [SHARED_WORKSPACE_STORAGE_KEY]: '{not-json' });
    expect(restoreSharedWorkspace(corrupt, 'user-1').activeDocumentId).toBe('shared-scratch');
    const foreign = storage({
      [SHARED_WORKSPACE_STORAGE_KEY]: JSON.stringify({
        schemaVersion: 2,
        scope: 'user',
        identity: { productId: 'web', userId: 'other-user', workspaceId: 'web:other-user' },
        payload: { documents: [], documentOrder: [], activeDocumentId: 'none' },
      }),
    });
    expect(restoreSharedWorkspace(foreign, 'user-1').documents[0]?.sourceId).toBe(sharedDocumentSourceId('user-1', 'shared-scratch'));
  });
});
