import type { UiResultViewState, UiResultSurfaceState } from '@justybase/ui-core';
import { readSharedResultView, writeSharedResultView } from './sharedResultViewPersistence';
import type { WorkspaceStorage } from './workspacePersistence';

class MemoryWorkspaceStorage implements WorkspaceStorage {
  public readonly userId = 'alice';
  private readonly values = new Map<string, string>();

  public get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public set(key: string, value: string): void {
    this.values.set(key, value);
  }

  public remove(key: string): void {
    this.values.delete(key);
  }
}

const result: Pick<UiResultSurfaceState, 'sourceId' | 'resultSetId'> = {
  sourceId: 'web:alice',
  resultSetId: 'query-1:0',
};

const view: UiResultViewState = {
  globalFilter: 'open',
  columnFilters: { STATUS: 'open' },
  sorting: [{ column: 'CREATED_AT', descending: true }],
  grouping: ['STATUS'],
  columnVisibility: { INTERNAL: false },
  columnOrder: ['ID', 'STATUS'],
  pinnedColumns: ['ID'],
  columnWidths: { ID: 120 },
  scrollTop: 7_500,
  scrollLeft: 192,
  anchorRow: 250,
};

describe('shared Web result view persistence adapter', () => {
  it('round-trips scoped filters, layout and two-axis scroll state', () => {
    const storage = new MemoryWorkspaceStorage();
    writeSharedResultView(storage, storage.userId, result, view);
    expect(readSharedResultView(storage, storage.userId, result)).toEqual({ view, migratedFromLegacy: false });
    expect(storage.get('result_view_v1_query-1%3A0')).not.toContain('rows');
  });

  it('migrates the old Web grid envelope and preserves its scroll anchor', () => {
    const storage = new MemoryWorkspaceStorage();
    storage.set('grid_v2_query-1:0', JSON.stringify({
      version: 2,
      resultSetId: 'query-1:0',
      state: {
        globalFilter: 'legacy',
        sorting: [{ id: '0', desc: true }],
        scrollTop: 3_000,
        scrollLeft: 64,
        scrollAnchorRow: 100,
      },
    }));
    expect(readSharedResultView(storage, storage.userId, result, 'query-1')).toEqual({
      view: {
        globalFilter: 'legacy',
        columnFilters: {},
        sorting: [{ column: '0', descending: true }],
        grouping: [],
        scrollTop: 3_000,
        scrollLeft: 64,
        anchorRow: 100,
      },
      migratedFromLegacy: true,
    });
  });

  it('does not accept a persisted envelope belonging to another user', () => {
    const storage = new MemoryWorkspaceStorage();
    writeSharedResultView(storage, 'bob', result, view);
    expect(readSharedResultView(storage, 'alice', result)).toBeUndefined();
  });
});
