import type { QueryStartRequest, SchemaTreeNode } from '@justybase/contracts';
import type { ResultState } from './queryState';
import type { WorkspaceStorage } from './workspacePersistence';

export type StatementExecutionStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled' | 'skipped';

export interface StatementExecutionState {
  status: StatementExecutionStatus;
  sql?: string;
  message?: string;
}

export interface EditorTab {
  id: string;
  title: string;
  sql: string;
  dirty: boolean;
  connectionId?: string;
  database?: string;
  schema?: string;
  results: Record<number, ResultState>;
  activeStatementIndex: number;
  queryId?: string;
  running?: boolean;
  resultView?: 'grid' | 'explain';
  source?: SchemaTreeNode;
  sourceSql?: string;
  sourceConnectionId?: string;
  sourceDatabase?: string;
  statementStates: Record<number, StatementExecutionState>;
  batchStatus?: 'complete' | 'error' | 'cancelled';
  batchMessage?: string;
  batchCompletedStatements?: number;
  batchStatementCount?: number;
}

export interface PersistedEditorTab {
  id: string;
  title: string;
  sql: string;
  dirty: boolean;
  connectionId?: string;
  database?: string;
  schema?: string;
}

export type ExecutionInput = Pick<QueryStartRequest, 'connectionId' | 'sql' | 'mode' | 'cursorOffset' | 'writeConfirmed' | 'writePreviewToken'> & { database: string };

let transientTabSequence = 0;

export function createTransientTabId(prefix: string): string {
  transientTabSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${transientTabSequence.toString(36)}`;
}

export function newEditorTab(number: number, id = `query-${number}`): EditorTab {
  return { id, title: `Query ${number}`, sql: 'SELECT *\nFROM ', dirty: false, results: {}, activeStatementIndex: 0, resultView: 'grid', statementStates: {} };
}

export function restoreEditorWorkspace(storage: WorkspaceStorage): { tabs: EditorTab[]; activeTabId: string } {
  const fallback = newEditorTab(1);
  try {
    const raw = storage.get('tabs');
    if (!raw) {
      const draft = storage.get('current_draft');
      if (draft) fallback.sql = draft;
      return { tabs: [fallback], activeTabId: 'query-1' };
    }
    const saved = JSON.parse(raw) as { tabs?: PersistedEditorTab[]; activeTabId?: string };
    const restored = (saved.tabs ?? []).filter(tab => tab && typeof tab.id === 'string' && typeof tab.sql === 'string').map((tab, index) => ({
      id: tab.id,
      title: typeof tab.title === 'string' && tab.title.trim() ? tab.title : `Query ${index + 1}`,
      sql: tab.sql,
      dirty: tab.dirty === true,
      connectionId: typeof tab.connectionId === 'string' ? tab.connectionId : undefined,
      database: typeof tab.database === 'string' ? tab.database : undefined,
      schema: typeof tab.schema === 'string' ? tab.schema : undefined,
      results: {},
      activeStatementIndex: 0,
      statementStates: {},
    }));
    if (restored.length === 0) return { tabs: [fallback], activeTabId: fallback.id };
    const activeTabId = restored.some(tab => tab.id === saved.activeTabId) ? saved.activeTabId! : restored[0]!.id;
    return { tabs: restored, activeTabId };
  } catch {
    return { tabs: [fallback], activeTabId: fallback.id };
  }
}

export function serializeEditorWorkspace(tabs: readonly EditorTab[], activeTabId: string): string {
  const persistedTabs: PersistedEditorTab[] = tabs.map(tab => ({
    id: tab.id,
    title: tab.title,
    sql: tab.sql,
    dirty: tab.dirty,
    connectionId: tab.connectionId,
    database: tab.database,
    schema: tab.schema,
  }));
  return JSON.stringify({ tabs: persistedTabs, activeTabId });
}
