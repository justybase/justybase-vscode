import type { WorkspaceStorage } from './workspacePersistence';
import {
  newEditorTab,
  restoreEditorWorkspace,
  serializeEditorWorkspace,
} from './workspaceDocumentController';

function memoryWorkspaceStorage(values: Record<string, string> = {}): WorkspaceStorage {
  const store = new Map(Object.entries(values));
  return {
    userId: 'user-1',
    get: key => store.get(key) ?? null,
    set: (key, value) => { store.set(key, value); },
    remove: key => { store.delete(key); },
  };
}

describe('workspace document controller', () => {
  it('restores a draft when no tab collection exists', () => {
    const restored = restoreEditorWorkspace(memoryWorkspaceStorage({ current_draft: 'SELECT 1' }));
    expect(restored.activeTabId).toBe('query-1');
    expect(restored.tabs).toHaveLength(1);
    expect(restored.tabs[0]?.sql).toBe('SELECT 1');
  });

  it('restores only document fields and falls back from invalid active ids', () => {
    const raw = JSON.stringify({
      activeTabId: 'missing',
      tabs: [
        { id: 'tab-1', title: 'Saved', sql: 'SELECT 1', dirty: true, connectionId: 'connection-1', database: 'main', schema: 'main', queryId: 'must-not-restore' },
        { id: 42, sql: 'invalid' },
      ],
    });
    const restored = restoreEditorWorkspace(memoryWorkspaceStorage({ tabs: raw }));
    expect(restored.activeTabId).toBe('tab-1');
    expect(restored.tabs[0]).toEqual(expect.objectContaining({ id: 'tab-1', title: 'Saved', sql: 'SELECT 1', dirty: true }));
    expect(restored.tabs[0]).not.toHaveProperty('queryId');
    expect(restored.tabs).toHaveLength(1);
  });

  it('serializes tabs without transient results or running-query state', () => {
    const tab = newEditorTab(1, 'tab-1');
    tab.sql = 'SELECT 1';
    tab.dirty = true;
    tab.queryId = 'query-1';
    tab.running = true;
    const parsed = JSON.parse(serializeEditorWorkspace([tab], 'tab-1')) as { tabs: Array<Record<string, unknown>>; activeTabId: string };
    expect(parsed.activeTabId).toBe('tab-1');
    expect(parsed.tabs).toEqual([{ id: 'tab-1', title: 'Query 1', sql: 'SELECT 1', dirty: true }]);
  });
});
