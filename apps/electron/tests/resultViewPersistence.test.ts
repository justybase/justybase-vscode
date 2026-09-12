import {
  electronResultViewIdentity,
  readElectronResultView,
  writeElectronResultView,
} from '../src/renderer/resultViewPersistence';
import type { UiResultViewState } from '@justybase/ui-core';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const result = { sourceId: 'electron:scratch', resultSetId: 'query-1:0' } as const;
const view: UiResultViewState = {
  globalFilter: 'needle',
  columnFilters: { ID: '42' },
  sorting: [{ column: 'ID', descending: true }],
  grouping: [],
  scrollTop: 4_500,
  scrollLeft: 256,
  anchorRow: 150,
};

describe('Electron result view persistence adapter', () => {
  it('round-trips profile-scoped grid and scroll state without result rows', () => {
    const storage = new MemoryStorage();
    writeElectronResultView(storage, result, view);
    expect(readElectronResultView(storage, result)).toEqual(view);
    expect(JSON.stringify(storage)).not.toContain('rows');
  });

  it('rejects a result envelope from another source identity', () => {
    const storage = new MemoryStorage();
    writeElectronResultView(storage, result, view);
    expect(readElectronResultView(storage, { ...result, sourceId: 'electron:other' })).toBeUndefined();
    expect(electronResultViewIdentity(result)).toEqual(expect.objectContaining({ productId: 'electron', workspaceId: 'electron-profile', resultSetId: result.resultSetId }));
  });

  it('degrades safely when renderer storage is unavailable or corrupted', () => {
    expect(readElectronResultView(undefined, result)).toBeUndefined();
    expect(() => writeElectronResultView(undefined, result, view)).not.toThrow();
    const storage = new MemoryStorage();
    storage.setItem('result_view_v1_query-1%3A0', '{broken');
    expect(readElectronResultView(storage, result)).toBeUndefined();
  });
});
