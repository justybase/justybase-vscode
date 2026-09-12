/** @jest-environment jsdom */

import type { LayoutSnapshot } from 'avalondock-web';
import { DockingManager } from 'avalondock-web';
import {
  DOCKYARD_CONTENT_IDS,
  DockyardManagerAdapter,
  createDefaultDockyardLayout,
  explainToolId,
  filterDockyardContextMenu,
  queryDocumentId,
  type DockyardContentDefinition,
} from './dockyardManagerAdapter';
import {
  DOCKYARD_LAYOUT_SCHEMA_VERSION,
  DOCKYARD_UPSTREAM_COMMIT,
  DOCKYARD_UPSTREAM_VERSION,
  loadDockyardLayout,
  parseDockyardLayout,
  resetDockyardLayout,
  saveDockyardLayout,
} from './dockyardLayout';
import type { WorkspaceStorage } from '../workspacePersistence';

function memoryStorage(userId: string): WorkspaceStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    userId,
    values,
    get: key => values.get(key) ?? null,
    set: (key, value) => { values.set(key, value); },
    remove: key => { values.delete(key); },
  };
}

const snapshot: LayoutSnapshot = {
  format: 'avalondock-web',
  version: 1,
  layout: {
    type: 'LayoutRoot',
    props: { Id: 'dockyard-root' },
    rootPanel: { type: 'LayoutPanel', props: { Id: 'dockyard-root-panel' } },
    sides: {},
    floatingWindows: [],
    hidden: [],
  },
};

function definitions(document: Document): DockyardContentDefinition[] {
  const content = (id: string): HTMLElement => {
    const node = document.createElement('div');
    node.dataset.contentId = id;
    return node;
  };
  return [
    { id: DOCKYARD_CONTENT_IDS.connections, title: 'Connections', kind: 'tool', content: content(DOCKYARD_CONTENT_IDS.connections) },
    { id: DOCKYARD_CONTENT_IDS.schema, title: 'Schema', kind: 'tool', content: content(DOCKYARD_CONTENT_IDS.schema) },
    { id: queryDocumentId('tab-1'), title: 'Query 1', kind: 'document', content: content(queryDocumentId('tab-1')) },
    { id: explainToolId('tab-1'), title: 'Explain · Query 1', kind: 'tool', content: content(explainToolId('tab-1')) },
  ];
}

describe('Dockyard layout persistence', () => {
  it('writes a versioned user-scoped envelope and reads the stable snapshot', () => {
    const storage = memoryStorage('alice');
    saveDockyardLayout(storage, snapshot);

    const raw = JSON.parse(storage.values.get('dockyard_layout_v1') ?? '{}') as Record<string, unknown>;
    expect(raw).toEqual(expect.objectContaining({
      schemaVersion: DOCKYARD_LAYOUT_SCHEMA_VERSION,
      scope: 'user',
      identity: { productId: 'web', userId: 'alice', workspaceId: 'web:alice' },
      payload: expect.objectContaining({
        format: 'justybase-dockyard-layout',
        dockyardVersion: DOCKYARD_UPSTREAM_VERSION,
        dockyardCommit: DOCKYARD_UPSTREAM_COMMIT,
        snapshot,
      }),
    }));
    expect(JSON.stringify(raw)).not.toMatch(/password|resultRows|rowData|dom|runtimeHandle/iu);
    expect(loadDockyardLayout(storage)).toEqual(snapshot);
  });

  it('rejects foreign, future, corrupt, and unsafe persisted layouts', () => {
    const alice = memoryStorage('alice');
    const bob = memoryStorage('bob');
    saveDockyardLayout(alice, snapshot);
    bob.values.set('dockyard_layout_v1', alice.values.get('dockyard_layout_v1') ?? '');
    expect(loadDockyardLayout(bob)).toBeUndefined();

    alice.values.set('dockyard_layout_v1', JSON.stringify({ schemaVersion: 99 }));
    expect(loadDockyardLayout(alice)).toBeUndefined();
    alice.values.set('dockyard_layout_v1', '{not-json');
    expect(loadDockyardLayout(alice)).toBeUndefined();
    alice.values.set('dockyard_layout_v1', JSON.stringify({
      schemaVersion: 1,
      scope: 'user',
      identity: { productId: 'web', userId: 'alice', workspaceId: 'web:alice' },
      payload: { format: 'justybase-dockyard-layout', dockyardVersion: DOCKYARD_UPSTREAM_VERSION, dockyardCommit: DOCKYARD_UPSTREAM_COMMIT, snapshot: { ...snapshot, layout: { ...snapshot.layout, props: { UserData: { password: 'not allowed' } } } } },
    }));
    expect(loadDockyardLayout(alice)).toBeUndefined();
  });

  it('accepts an earlier direct Dockyard snapshot once and can reset it', () => {
    const storage = memoryStorage('alice');
    storage.values.set('dockyard_layout_v1', JSON.stringify(snapshot));
    expect(parseDockyardLayout(storage.values.get('dockyard_layout_v1'))).toEqual(snapshot);
    expect(loadDockyardLayout(storage)).toEqual(snapshot);
    resetDockyardLayout(storage);
    expect(storage.get('dockyard_layout_v1')).toBeNull();
  });

  it('creates one stable model for each document and tool identity', () => {
    const layout = createDefaultDockyardLayout(definitions(document), 275);
    const ids = [...layout.Descendents()]
      .filter(item => 'ContentId' in item)
      .map(item => (item as { ContentId: string }).ContentId);
    expect(ids).toEqual(expect.arrayContaining([
      DOCKYARD_CONTENT_IDS.connections,
      DOCKYARD_CONTENT_IDS.schema,
      queryDocumentId('tab-1'),
      explainToolId('tab-1'),
    ]));
  });

  it('treats storage read failures as an empty layout', () => {
    const storage: WorkspaceStorage = {
      userId: 'alice',
      get: () => { throw new Error('storage unavailable'); },
      set: () => undefined,
      remove: () => undefined,
    };
    expect(loadDockyardLayout(storage)).toBeUndefined();
  });
});

describe('Dockyard DOM adapter lifecycle', () => {
  it('maps stable models and releases content hosts/listeners on dispose', () => {
    const storage = memoryStorage('adapter-user');
    const host = document.createElement('div');
    const contentDefinitions = definitions(document);
    const closed: string[] = [];
    const adapter = new DockyardManagerAdapter({
      host,
      storage,
      definitions: contentDefinitions,
      explorerWidth: 275,
      onDocumentClosed: tabId => closed.push(tabId),
    });

    expect(adapter.manager.Find(queryDocumentId('tab-1'))).not.toBeNull();
    expect(adapter.getContentHost(DOCKYARD_CONTENT_IDS.connections)).toBe(contentDefinitions[0]?.content);
    expect(adapter.activate(queryDocumentId('tab-1'))).toBe(true);
    expect(adapter.float(queryDocumentId('tab-1'))).toBe(true);
    expect(adapter.dock(queryDocumentId('tab-1'))).toBe(true);
    expect(adapter.hide(DOCKYARD_CONTENT_IDS.connections)).toBe(true);
    expect(adapter.show(DOCKYARD_CONTENT_IDS.connections)).toBe(true);
    expect(adapter.toggleAutoHide(DOCKYARD_CONTENT_IDS.connections)).toBe(true);
    expect(storage.get('dockyard_layout_v1')).not.toBeNull();

    const model = adapter.manager.Find(queryDocumentId('tab-1'));
    expect(model).not.toBeNull();
    if (model) expect(adapter.manager.Close(model)).toBe(true);
    expect(closed).toEqual(['tab-1']);

    adapter.dispose();
    adapter.dispose();
    expect(adapter.getContentHost(DOCKYARD_CONTENT_IDS.connections)).toBeUndefined();
  });

  it('removes the unsupported browser-window action from both context menus', () => {
    const storage = memoryStorage('menu-user');
    const adapter = new DockyardManagerAdapter({ host: document.createElement('div'), storage, definitions: definitions(document), explorerWidth: 275 });
    const menuEntries = [
      { Label: 'Float' },
      { Label: 'Open in browser window' },
      { Label: 'Close' },
      null,
    ];
    const documentMenu = adapter.manager.DocumentContextMenu;
    const anchorableMenu = adapter.manager.AnchorableContextMenu;
    expect(typeof documentMenu).toBe('function');
    expect(typeof anchorableMenu).toBe('function');
    const model = adapter.manager.Find(queryDocumentId('tab-1'));
    expect(model).not.toBeNull();
    if (model && typeof documentMenu === 'function' && typeof anchorableMenu === 'function') {
      expect(documentMenu(model, adapter.manager, menuEntries)).toEqual([{ Label: 'Float' }, { Label: 'Close' }, null]);
      expect(anchorableMenu(model, adapter.manager, menuEntries)).toEqual([{ Label: 'Float' }, { Label: 'Close' }, null]);
    }
    expect(filterDockyardContextMenu(model!, adapter.manager, menuEntries)).toEqual([{ Label: 'Float' }, { Label: 'Close' }, null]);
    adapter.dispose();
  });

  it('cancels a document close and disposes after failed initialization', () => {
    const storage = memoryStorage('close-user');
    const denied: string[] = [];
    const adapter = new DockyardManagerAdapter({
      host: document.createElement('div'),
      storage,
      definitions: definitions(document),
      explorerWidth: 275,
      onDocumentClosing: tabId => { denied.push(tabId); return false; },
    });
    const model = adapter.manager.Find(queryDocumentId('tab-1'));
    expect(model).not.toBeNull();
    if (model) expect(adapter.manager.Close(model)).toBe(false);
    expect(denied).toEqual(['tab-1']);
    expect(adapter.manager.Find(queryDocumentId('tab-1'))).not.toBeNull();
    adapter.dispose();

    const dispose = jest.spyOn(DockingManager.prototype, 'Dispose');
    const beginUpdate = jest.spyOn(DockingManager.prototype, 'BeginUpdate').mockImplementation(() => {
      throw new Error('initial sync failed');
    });
    expect(() => new DockyardManagerAdapter({
      host: document.createElement('div'),
      storage: memoryStorage('failed-init-user'),
      definitions: definitions(document),
      explorerWidth: 275,
    })).toThrow('initial sync failed');
    expect(dispose).toHaveBeenCalledTimes(1);
    beginUpdate.mockRestore();
    dispose.mockRestore();
  });
});
