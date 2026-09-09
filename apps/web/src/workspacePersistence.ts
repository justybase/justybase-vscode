import { createContext, createElement, useContext } from 'react';
import type { ReactElement, ReactNode } from 'react';

const MIGRATION_MARKER = 'jwb_workspace_migration_v1';

export interface WorkspaceStorage {
  readonly userId: string;
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    // Access to the storage getter itself can be denied in sandboxed or
    // privacy-restricted browser contexts.
    return undefined;
  }
}

function scopedKey(userId: string, key: string): string {
  return `jwb:user:${encodeURIComponent(userId)}:${key}`;
}

/**
 * Read an old global workspace value only while its migration is still
 * pending. This keeps a failed quota/security write recoverable without
 * exposing a successfully migrated user's legacy data to another account.
 */
export function readLegacyWorkspaceValue(key: string): string | null {
  const browser = browserStorage();
  if (!browser) return null;
  try {
    if (browser.getItem(MIGRATION_MARKER)) return null;
    return browser.getItem(key);
  } catch {
    return null;
  }
}

export function createWorkspaceStorage(userId: string): WorkspaceStorage {
  return {
    userId,
    get: key => {
      try { return browserStorage()?.getItem(scopedKey(userId, key)) ?? null; } catch { return null; }
    },
    set: (key, value) => {
      try { browserStorage()?.setItem(scopedKey(userId, key), value); } catch { /* storage is optional */ }
    },
    remove: key => {
      try { browserStorage()?.removeItem(scopedKey(userId, key)); } catch { /* storage is optional */ }
    },
  };
}

/**
 * Move the pre-R7 shared workspace keys to the first authenticated user's
 * namespace. The old values are removed only after all target writes succeed.
 */
export function migrateLegacyWorkspace(storage: WorkspaceStorage): void {
  const browser = browserStorage();
  if (!browser) return;
  try {
    if (browser.getItem(MIGRATION_MARKER)) return;
    const entries: Array<[legacy: string, scoped: string]> = [
      ['jwb_tabs', 'tabs'],
      ['justybase_current_draft', 'current_draft'],
      ['jwb_sidebar', 'sidebar'],
      ['jwb_editor_pct', 'editor_pct'],
      ['jwb_connection', 'connection'],
      ['jwb_database', 'database'],
    ];
    for (let index = 0; index < browser.length; index += 1) {
      const key = browser.key(index);
      if (!key) continue;
      if (key.startsWith('jwb_schema_')) entries.push([key, `schema_${key.slice('jwb_schema_'.length)}`]);
      else if (key.startsWith('jwb_grid_v2_')) entries.push([key, `grid_v2_${key.slice('jwb_grid_v2_'.length)}`]);
      else if (key.startsWith('jwb_grid_')) entries.push([key, `grid_${key.slice('jwb_grid_'.length)}`]);
    }

    const copied: string[] = [];
    for (const [legacyKey, targetKey] of entries) {
      const value = browser.getItem(legacyKey);
      if (value === null) continue;
      if (storage.get(targetKey) === null) {
        storage.set(targetKey, value);
        // WorkspaceStorage deliberately treats browser storage as optional. Do
        // not remove the only copy if a quota/security failure was swallowed.
        if (storage.get(targetKey) !== value) throw new Error('Workspace migration target could not be verified.');
      }
      copied.push(legacyKey);
    }
    for (const key of copied) browser.removeItem(key);
    browser.setItem(MIGRATION_MARKER, JSON.stringify({ userId: storage.userId, migratedAt: Date.now() }));
  } catch {
    // A quota/security error leaves legacy data intact for a later retry.
  }
}

const WorkspaceStorageContext = createContext<WorkspaceStorage | null>(null);

export function WorkspaceStorageProvider({ storage, children }: { storage: WorkspaceStorage; children: ReactNode }): ReactElement {
  return createElement(WorkspaceStorageContext.Provider, { value: storage }, children);
}

export function useWorkspaceStorage(): WorkspaceStorage {
  const storage = useContext(WorkspaceStorageContext);
  if (!storage) throw new Error('useWorkspaceStorage must be used below WorkspaceStorageProvider.');
  return storage;
}
