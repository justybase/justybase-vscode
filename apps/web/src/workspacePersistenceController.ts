import type { EditorTab } from './workspaceDocumentController';
import { serializeEditorWorkspace } from './workspaceDocumentController';
import type { WorkspaceStorage } from './workspacePersistence';

export function readPersistedNumber(storage: WorkspaceStorage, key: string, fallback: number): number {
  const value = storage.get(key);
  const parsed = value === null ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function persistEditorWorkspace(storage: WorkspaceStorage, tabs: readonly EditorTab[], activeTabId: string): void {
  storage.set('tabs', serializeEditorWorkspace(tabs, activeTabId));
}

export function persistDraft(storage: WorkspaceStorage, sql: string): void {
  storage.set('current_draft', sql);
}

export function resetPersistedWorkspaceLayout(storage: WorkspaceStorage): void {
  storage.remove('sidebar');
  storage.remove('editor_pct');
  storage.remove('connection');
  storage.remove('database');
}
