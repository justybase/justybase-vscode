import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createWorkspaceStorage,
  migrateLegacyWorkspace,
  readLegacyWorkspaceValue,
  useWorkspaceStorage,
  WorkspaceStorageProvider,
  type WorkspaceStorage,
} from './workspacePersistence';
import { readPersistedNumber } from './workspacePersistenceController';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  public get length(): number { return this.values.size; }
  public clear(): void { this.values.clear(); }
  public getItem(key: string): string | null { return this.values.get(key) ?? null; }
  public key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  public removeItem(key: string): void { this.values.delete(key); }
  public setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

function StorageProbe(): ReactElement {
  return createElement('span', null, useWorkspaceStorage().userId);
}

describe('workspace persistence', () => {
  let previousLocalStorage: PropertyDescriptor | undefined;

  beforeEach(() => {
    previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
  });

  afterEach(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('isolates logical workspace keys between users', () => {
    const first = createWorkspaceStorage('alice@example.test');
    const second = createWorkspaceStorage('bob@example.test');
    first.set('tabs', '["alice-tab"]');

    expect(first.get('tabs')).toBe('["alice-tab"]');
    expect(second.get('tabs')).toBeNull();
    expect(globalThis.localStorage.getItem('jwb:user:alice%40example.test:tabs')).toBe('["alice-tab"]');
  });

  it('migrates legacy global keys once without leaking them to later users', () => {
    const browser = globalThis.localStorage;
    browser.setItem('jwb_tabs', '["legacy-tab"]');
    browser.setItem('justybase_current_draft', 'SELECT 1');
    browser.setItem('jwb_schema_connection-1', '{"nodes":[]}');
    browser.setItem('jwb_grid_v2_result-1', '{"resultSetId":"result-1"}');
    browser.setItem('jwb_sidebar', '333');
    browser.setItem('jwb_editor_pct', '62');
    const first = createWorkspaceStorage('alice@example.test');

    migrateLegacyWorkspace(first);

    expect(first.get('tabs')).toBe('["legacy-tab"]');
    expect(first.get('current_draft')).toBe('SELECT 1');
    expect(first.get('schema_connection-1')).toBe('{"nodes":[]}');
    expect(first.get('grid_v2_result-1')).toBe('{"resultSetId":"result-1"}');
    expect(first.get('sidebar')).toBe('333');
    expect(first.get('editor_pct')).toBe('62');
    expect(readPersistedNumber(first, 'editor_pct', 45)).toBe(62);
    expect(browser.getItem('jwb_tabs')).toBeNull();
    expect(browser.getItem('justybase_current_draft')).toBeNull();
    expect(browser.getItem('jwb_schema_connection-1')).toBeNull();
    expect(browser.getItem('jwb_grid_v2_result-1')).toBeNull();
    expect(browser.getItem('jwb_sidebar')).toBeNull();
    expect(browser.getItem('jwb_editor_pct')).toBeNull();
    expect(browser.getItem('jwb_workspace_migration_v1')).toContain('alice@example.test');

    const second = createWorkspaceStorage('bob@example.test');
    migrateLegacyWorkspace(second);
    expect(second.get('tabs')).toBeNull();
    expect(second.get('current_draft')).toBeNull();
  });

  it('does not overwrite an existing scoped value during migration', () => {
    const browser = globalThis.localStorage;
    const storage = createWorkspaceStorage('alice@example.test');
    storage.set('tabs', '["new-tab"]');
    browser.setItem('jwb_tabs', '["old-tab"]');

    migrateLegacyWorkspace(storage);

    expect(storage.get('tabs')).toBe('["new-tab"]');
    expect(browser.getItem('jwb_tabs')).toBeNull();
  });

  it('keeps legacy data when a scoped migration write cannot be verified', () => {
    const browser = globalThis.localStorage;
    browser.setItem('jwb_tabs', '["legacy-tab"]');
    const storage: WorkspaceStorage = {
      userId: 'alice@example.test',
      get: () => null,
      set: () => undefined,
      remove: () => undefined,
    };

    migrateLegacyWorkspace(storage);

    expect(browser.getItem('jwb_tabs')).toBe('["legacy-tab"]');
    expect(browser.getItem('jwb_workspace_migration_v1')).toBeNull();
    expect(readLegacyWorkspaceValue('jwb_tabs')).toBe('["legacy-tab"]');
  });

  it('falls back safely when the localStorage getter is denied', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => { throw new Error('Storage access denied.'); },
    });
    const storage = createWorkspaceStorage('restricted@example.test');

    expect(() => migrateLegacyWorkspace(storage)).not.toThrow();
    expect(storage.get('tabs')).toBeNull();
    expect(() => storage.set('tabs', '[]')).not.toThrow();
    expect(() => storage.remove('tabs')).not.toThrow();
  });

  it('uses the editor split fallback for missing or invalid persisted values', () => {
    const storage = createWorkspaceStorage('split-user');
    expect(readPersistedNumber(storage, 'editor_pct', 45)).toBe(45);
    storage.set('editor_pct', 'not-a-number');
    expect(readPersistedNumber(storage, 'editor_pct', 45)).toBe(45);
    storage.set('editor_pct', '61');
    expect(readPersistedNumber(storage, 'editor_pct', 45)).toBe(61);
  });

  it('provides the user-scoped storage through React context', () => {
    const storage = createWorkspaceStorage('alice@example.test');
    const markup = renderToStaticMarkup(createElement(WorkspaceStorageProvider, { storage, children: createElement(StorageProbe) }));
    expect(markup).toContain('<span>alice@example.test</span>');
  });
});
