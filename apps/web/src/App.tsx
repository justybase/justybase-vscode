import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import Editor from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import type { ConnectionProfileSummary, ConnectionProfileUpdate, EditorPreferences, MetadataColumn, MetadataDatabase, QueryEvent, QueryStartRequest, SchemaTreeNode, WebUser } from '@justybase/contracts';
import { api, connectToQueryEvents, type QueryEventSubscription } from './api';
import { applyQueryEvent, emptyResult, type ResultState } from './queryState';
import { registerSqlLanguageFeatures } from './sqlLanguage';
import { SchemaTree } from './SchemaTree';
import { ResultGrid } from './ResultGrid';
import { InspectorPanel } from './InspectorPanel';
import { ObjectDesigner } from './ObjectDesigner';
import { ImportPanel } from './ImportPanel';
import { EditRowPanel } from './EditRowPanel';
import { ExplainPanel } from './ExplainPanel';
import { AdminPanel } from './AdminPanel';
import { EditorToolbar, type RunMode } from './EditorToolbar';
import { useSplitPane } from './useSplitPane';

export function App(): ReactElement {
  const [user, setUser] = useState<WebUser | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { void api.me().then(response => setUser(response.user)).catch(() => undefined).finally(() => setLoading(false)); }, []);
  if (loading) return <div className="center-message">Loading JustyBase…</div>;
  if (!user) return <Login onLogin={setUser} />;
  return <Workspace user={user} onLogout={() => { void api.logout().finally(() => setUser(null)); }} />;
}

function Login({ onLogin }: { onLogin(user: WebUser): void }): ReactElement {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault(); setBusy(true); setError('');
    try { onLogin((await api.login(username, password)).user); } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : 'Login failed.'); } finally { setBusy(false); }
  }
  return <main className="auth-shell"><form className="card auth-card" onSubmit={event => void submit(event)}><div className="brand">JustyBase</div><h1>Web database editor</h1><p className="muted">Sign in to your self-hosted workspace.</p><label>Username<input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" /></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></label>{error && <div className="error">{error}</div>}<button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></form></main>;
}

interface EditorTab {
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

type StatementExecutionStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled' | 'skipped';

interface StatementExecutionState {
  status: StatementExecutionStatus;
  sql?: string;
  message?: string;
}

interface PersistedEditorTab {
  id: string;
  title: string;
  sql: string;
  dirty: boolean;
  connectionId?: string;
  database?: string;
  schema?: string;
}

type ExecutionInput = Pick<QueryStartRequest, 'connectionId' | 'sql' | 'mode' | 'cursorOffset' | 'writeConfirmed' | 'writePreviewToken'> & { database: string };

function newEditorTab(number: number, id = `query-${number}`): EditorTab {
  return { id, title: `Query ${number}`, sql: 'SELECT *\nFROM ', dirty: false, results: {}, activeStatementIndex: 0, resultView: 'grid', statementStates: {} };
}

function workspaceDatabase(connection: ConnectionProfileSummary): string {
  if (connection.dbType === 'sqlite') return 'main';
  if (connection.dbType === 'duckdb') {
    if (connection.database === ':memory:') return 'memory';
    const base = connection.database.replaceAll('\\', '/').split('/').pop() ?? connection.database;
    return base.replace(/\.(?:duckdb|ddb)$/i, '') || base;
  }
  return connection.database;
}

function normalizeSql(value: string): string { return value.trim().replace(/;\s*$/u, '').replace(/\s+/gu, ' '); }

function canEditActiveResult(tab: EditorTab | undefined, result: ResultState, connection: ConnectionProfileSummary | null): boolean {
  return Boolean(tab?.source && tab.source.kind === 'object' && tab.source.objectType?.toUpperCase() === 'TABLE'
    && tab.sourceSql && normalizeSql(tab.sourceSql) === normalizeSql(tab.sql)
    && tab.sourceConnectionId === connection?.id && tab.sourceDatabase === tab.database
    && result.status.startsWith('complete') && result.sessionId && result.statementSql
    && normalizeSql(result.statementSql) === normalizeSql(tab.sourceSql));
}

function statementStatusLabel(status: StatementExecutionStatus): string {
  switch (status) {
    case 'success': return 'Success';
    case 'error': return 'Failed';
    case 'cancelled': return 'Cancelled';
    case 'skipped': return 'Skipped';
    case 'running': return 'Running';
    default: return 'Pending';
  }
}

function statementStatusClass(status: StatementExecutionStatus): string {
  return `statement-status statement-status-${status}`;
}

function statementStateFor(tab: EditorTab, index: number): StatementExecutionState {
  const explicit = tab.statementStates[index];
  if (explicit) return explicit;
  const result = tab.results[index];
  if (!result) return { status: 'pending' };
  if (result.status === 'error') return { status: 'error', message: result.message };
  if (result.status === 'cancelled') return { status: 'cancelled', message: result.message };
  if (result.status.startsWith('complete')) return { status: 'success', message: result.message };
  return { status: tab.running ? 'running' : 'pending' };
}

function restoreEditorWorkspace(): { tabs: EditorTab[]; activeTabId: string } {
  const fallback = newEditorTab(1);
  try {
    const raw = localStorage.getItem('jwb_tabs');
    if (!raw) {
      const draft = localStorage.getItem('justybase_current_draft');
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

function Workspace({ user, onLogout }: { user: WebUser; onLogout(): void }): ReactElement {
  const restoredWorkspace = useRef<{ tabs: EditorTab[]; activeTabId: string } | null>(null);
  if (!restoredWorkspace.current) restoredWorkspace.current = restoreEditorWorkspace();
  const [connections, setConnections] = useState<ConnectionProfileSummary[]>([]);
  const [selected, setSelected] = useState<ConnectionProfileSummary | null>(null);
  const [editingConnection, setEditingConnection] = useState<ConnectionProfileSummary | null>(null);
  const [tabs, setTabs] = useState<EditorTab[]>(() => restoredWorkspace.current!.tabs);
  const [activeTabId, setActiveTabId] = useState(() => restoredWorkspace.current!.activeTabId);
  const [error, setError] = useState('');
  const [database, setDatabase] = useState(() => restoredWorkspace.current!.tabs.find(tab => tab.id === restoredWorkspace.current!.activeTabId)?.database ?? '');
  const [schema, setSchema] = useState(() => restoredWorkspace.current!.tabs.find(tab => tab.id === restoredWorkspace.current!.activeTabId)?.schema ?? '');
  const [columns, setColumns] = useState<MetadataColumn[]>([]);
  const [inspectedObject, setInspectedObject] = useState<SchemaTreeNode | null>(null);
  const [designerTarget, setDesignerTarget] = useState<SchemaTreeNode | null>(null);
  const [showInspector, setShowInspector] = useState(false);
  const [importTarget, setImportTarget] = useState<SchemaTreeNode | null>(null);
  const [editRow, setEditRow] = useState<unknown[] | null>(null);
  const [databases, setDatabases] = useState<MetadataDatabase[]>([]);
  const [lastQueryTime, setLastQueryTime] = useState<number | null>(null);
  const [overwrite, setOverwrite] = useState(false);

  // Split pane sizes — persisted in localStorage
  function getInitial(key: string, fallback: number): number {
    try { const v = localStorage.getItem(key); return v ? Number(v) : fallback; } catch { return fallback; }
  }
  const sidebar = useSplitPane('horizontal', getInitial('jwb_sidebar', 250), 160, 500);
  const editorSplit = useSplitPane('vertical', getInitial('jwb_editor_pct', 45), 20, 80);
  const [showConnectionForm, setShowConnectionForm] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof api.history>>>([]);
  const [showAudit, setShowAudit] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [audit, setAudit] = useState<Awaited<ReturnType<typeof api.audit>>>([]);
  const [preferences, setPreferences] = useState<EditorPreferences | null>(null);
  const selectedRef = useRef<ConnectionProfileSummary | null>(null);
  const databaseRef = useRef('');
  const schemaRef = useRef('');
  const subscriptionsRef = useRef(new Map<string, QueryEventSubscription>());
  const preferencesRef = useRef<EditorPreferences | null>(null);
  const activeQueryIdRef = useRef('');
  const savedConnectionIdRef = useRef<string | null>(null);
  const savedDatabaseRef = useRef('');
  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? tabs[0];
  const sql = activeTab?.sql ?? '';
  const result = activeTab?.results[activeTab.activeStatementIndex] ?? emptyResult;
  const activeQueryId = activeTab?.queryId ?? '';
  const busy = activeTab?.running === true;
  const statementIndexes = activeTab
    ? Array.from(new Set([...Object.keys(activeTab.results), ...Object.keys(activeTab.statementStates)]).values(), Number).sort((a, b) => a - b)
    : [];
  const batchStatementCount = activeTab?.batchStatementCount ?? statementIndexes.length;
  const isBatchResult = batchStatementCount > 1 || statementIndexes.length > 1;
  const batchStates = statementIndexes.map(index => statementStateFor(activeTab!, index));
  const batchStatusCounts = batchStates.reduce<Record<StatementExecutionStatus, number>>((counts, state) => {
    counts[state.status] += 1;
    return counts;
  }, { pending: 0, running: 0, success: 0, error: 0, cancelled: 0, skipped: 0 });
  const batchVisualStatus = activeTab?.batchStatus ?? (busy && isBatchResult ? 'running' : undefined);
  const batchExecutedCount = batchStatusCounts.success + batchStatusCounts.error + batchStatusCounts.cancelled;
  const failedStatementIndex = statementIndexes.find(index => statementStateFor(activeTab!, index).status === 'error');

  useEffect(() => () => {
    for (const subscription of subscriptionsRef.current.values()) subscription.close();
    subscriptionsRef.current.clear();
  }, []);

  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { preferencesRef.current = preferences; }, [preferences]);
  useEffect(() => { activeQueryIdRef.current = activeQueryId; }, [activeQueryId]);
  useEffect(() => {
    if (!selected) return;
    const tab = tabs.find(item => item.id === activeTabId);
    const tabOwnsConnection = tab?.connectionId === selected.id;
    const profileDatabase = workspaceDatabase(selected);
    const nextDatabase = tabOwnsConnection && tab?.database && !(selected.dbType === 'sqlite' && tab.database === selected.database)
      ? tab.database
      : selected.dbType !== 'sqlite' && selected.id === savedConnectionIdRef.current && savedDatabaseRef.current
        ? savedDatabaseRef.current
        : profileDatabase;
    const nextSchema = tabOwnsConnection ? tab?.schema ?? '' : '';
    setDatabase(nextDatabase);
    setSchema(nextSchema);
    setColumns([]);
    const sourceStillValid = tab?.sourceConnectionId === selected.id && tab.sourceDatabase === nextDatabase;
    setInspectedObject(sourceStillValid ? tab?.source ?? null : null);
    setTabs(previous => previous.map(item => item.id === activeTabId
      ? sourceStillValid
        ? { ...item, connectionId: selected.id, database: nextDatabase, schema: nextSchema }
        : { ...item, connectionId: selected.id, database: nextDatabase, schema: nextSchema, source: undefined, sourceSql: undefined, sourceConnectionId: undefined, sourceDatabase: undefined }
      : item));
  }, [selected?.id]);
  useEffect(() => {
    const tab = tabs.find(item => item.id === activeTabId);
    if (!tab) return;
    const tabConnection = tab.connectionId ? connections.find(item => item.id === tab.connectionId) : undefined;
    if (!tab.connectionId) {
      // A new/unbound tab may adopt the currently selected profile. Do not
      // clear the loader's selection before the [selected.id] effect binds it.
      if (selected) return;
      setSelected(null);
      setDatabase('');
      setSchema('');
      setColumns([]);
      setInspectedObject(null);
      return;
    }
    if (!tabConnection) {
      // A persisted tab must never silently run against whichever profile the
      // loader happened to select after its original profile was deleted.
      setTabs(previous => previous.map(item => item.id === tab.id ? { ...item, connectionId: undefined, database: undefined, schema: undefined, source: undefined, sourceSql: undefined, sourceConnectionId: undefined, sourceDatabase: undefined } : item));
      setSelected(null);
      setDatabase('');
      setSchema('');
      setColumns([]);
      setInspectedObject(null);
      return;
    }
    if (selected?.id !== tabConnection.id) setSelected(tabConnection);
    setDatabase(tab.database ?? '');
    setSchema(tab.schema ?? '');
    setColumns([]);
    setInspectedObject(tab.source ?? null);
  }, [activeTabId, connections]);
  useEffect(() => { databaseRef.current = database; }, [database]);
  useEffect(() => { schemaRef.current = schema; }, [schema]);
  useEffect(() => {
    void api.connections().then(items => {
      setConnections(items);
      const knownIds = new Set(items.map(item => item.id));
      const restoredActiveTab = restoredWorkspace.current?.tabs.find(tab => tab.id === restoredWorkspace.current?.activeTabId);
      const restoredActiveConnectionMissing = Boolean(restoredActiveTab?.connectionId && !knownIds.has(restoredActiveTab.connectionId));
      setTabs(previous => previous.map(tab => tab.connectionId && !knownIds.has(tab.connectionId)
        ? { ...tab, connectionId: undefined, database: undefined, schema: undefined, source: undefined, sourceSql: undefined, sourceConnectionId: undefined, sourceDatabase: undefined }
        : tab));
      // Restore last connection from localStorage
      let conn: ConnectionProfileSummary | undefined;
      try {
        const savedId = localStorage.getItem('jwb_connection');
        savedConnectionIdRef.current = savedId;
        if (savedId) conn = items.find(c => c.id === savedId);
      } catch { /* ignore */ }
      const tabConnection = restoredWorkspace.current?.tabs.find(tab => tab.id === restoredWorkspace.current?.activeTabId)?.connectionId;
      setSelected(restoredActiveConnectionMissing ? null : items.find(item => item.id === tabConnection) ?? conn ?? items[0] ?? null);
    }).catch(reason => setError(reason instanceof Error ? reason.message : 'Could not load connections.'));
    void api.editorPreferences().then(setPreferences).catch(reason => setError(reason instanceof Error ? reason.message : 'Could not load editor preferences.'));
    void api.history().then(setHistory).catch(() => undefined);
    // Capture the saved database so the selected-connection reset can preserve it.
    try {
      const savedDb = localStorage.getItem('jwb_database');
      savedDatabaseRef.current = savedDb ?? '';
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { if (!selected) return; void api.databases(selected.id).then(setDatabases).catch(() => undefined); }, [selected?.id]);

  // Persist panel sizes
  useEffect(() => { try { localStorage.setItem('jwb_sidebar', String(sidebar.size)); } catch { /* ignore */ } }, [sidebar.size]);
  useEffect(() => { try { localStorage.setItem('jwb_editor_pct', String(editorSplit.size)); } catch { /* ignore */ } }, [editorSplit.size]);

  // Persist connection selection
  useEffect(() => { try { localStorage.setItem('jwb_connection', selected?.id ?? ''); } catch { /* ignore */ } }, [selected?.id]);
  useEffect(() => { try { localStorage.setItem('jwb_database', database); } catch { /* ignore */ } }, [database]);
  useEffect(() => {
    try {
      const persistedTabs: PersistedEditorTab[] = tabs.map(tab => ({ id: tab.id, title: tab.title, sql: tab.sql, dirty: tab.dirty, connectionId: tab.connectionId, database: tab.database, schema: tab.schema }));
      localStorage.setItem('jwb_tabs', JSON.stringify({ tabs: persistedTabs, activeTabId }));
    } catch { /* ignore */ }
  }, [tabs, activeTabId]);

  // Stable refs for keyboard shortcuts to avoid re-registering listener on every render
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;
  const handleRunRef = useRef(handleRun);
  handleRunRef.current = handleRun;
  const handleFormatRef = useRef(handleFormat);
  handleFormatRef.current = handleFormat;
  const addTabRef = useRef(addTab);
  addTabRef.current = addTab;
  const closeTabRef = useRef(closeTab);
  closeTabRef.current = closeTab;
  const handleCancelRef = useRef(handleCancel);
  handleCancelRef.current = handleCancel;

  function handleCancel(): void {
    if (activeQueryId) { void api.cancelQuery(activeQueryId); }
  }

  // Keyboard shortcuts
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Escape closes transient UI first, then cancels an active query.
      if (e.key === 'Escape') {
        if (showConnectionForm || editingConnection) { e.preventDefault(); setEditingConnection(null); setShowConnectionForm(false); return; }
        if (showSettings) { e.preventDefault(); setShowSettings(false); return; }
        if (showHistory) { e.preventDefault(); setShowHistory(false); return; }
        if (showAudit) { e.preventDefault(); setShowAudit(false); return; }
        if (showAdmin) { e.preventDefault(); setShowAdmin(false); return; }
        if (importTarget) { e.preventDefault(); setImportTarget(null); return; }
        if (editRow) { e.preventDefault(); setEditRow(null); return; }
        if (activeQueryIdRef.current) { e.preventDefault(); handleCancelRef.current(); return; }
      }

      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;

      // Don't intercept if user is typing in an input/select (e.g. filter fields)
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';

      switch (e.key.toLowerCase()) {
        case 's':
          e.preventDefault();
          handleSaveRef.current();
          break;
        case 'enter':
          e.preventDefault();
          handleRunRef.current('run');
          break;
        case 'f':
          if (e.shiftKey) {
            e.preventDefault();
            handleFormatRef.current();
          }
          break;
        case 'n':
          if (!isInput) {
            e.preventDefault();
            addTabRef.current();
          }
          break;
        case 'w':
          if (!isInput) {
            e.preventDefault();
            closeTabRef.current(activeTabId);
          }
          break;
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTabId, editRow, editingConnection, importTarget, showAdmin, showAudit, showConnectionForm, showHistory, showSettings]);

  function saveConnection(connection: ConnectionProfileSummary): void {
    setConnections(previous => previous.some(item => item.id === connection.id) ? previous.map(item => item.id === connection.id ? connection : item) : [...previous, connection]);
    const nextDatabase = workspaceDatabase(connection);
    setSelected(connection); setDatabase(nextDatabase); setSchema(''); setColumns([]); setEditingConnection(null); setShowConnectionForm(false);
    setTabs(previous => previous.map(tab => tab.id === activeTabId ? { ...tab, connectionId: connection.id, database: nextDatabase, schema: '', source: undefined, sourceSql: undefined, sourceConnectionId: undefined, sourceDatabase: undefined } : tab));
    setInspectedObject(null);
  }

  async function deleteConnection(connection: ConnectionProfileSummary): Promise<void> {
    if (!window.confirm(`Delete connection “${connection.name}”?`)) return;
    try { await api.deleteConnection(connection.id); setConnections(previous => previous.filter(item => item.id !== connection.id)); if (selected?.id === connection.id) setSelected(null); } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : 'Could not delete connection.'); }
  }

  function executionInput(mode: RunMode): ExecutionInput | null {
    if (!selected || !activeTab) return null;
    const editor = editorRef.current;
    const model = editor?.getModel();
    const selection = editor?.getSelection();
    const selectedSql = model && selection && !selection.isEmpty() ? model.getValueInRange(selection) : '';
    if (mode === 'explain') {
      const base = executionInput('run');
      if (!base || !base.sql.trim()) return null;
      return { ...base, mode: 'explain' };
    }
    if (mode === 'run') {
      if (selectedSql.trim()) return { connectionId: selected.id, database, sql: selectedSql, mode: 'single' };
      return { connectionId: selected.id, database, sql, mode: 'single', cursorOffset: model && editor?.getPosition() ? model.getOffsetAt(editor.getPosition()!) : undefined };
    }
    if (mode === 'smart' && !selectedSql.trim()) return executionInput('run');
    return { connectionId: selected.id, database, sql: mode === 'smart' ? selectedSql : sql, mode: 'script' };
  }

  function applyEventToTab(tabId: string, event: QueryEvent): void {
    setTabs(previous => previous.map(tab => {
      if (tab.id !== tabId) return tab;
      const statementIndex = event.statementIndex ?? tab.activeStatementIndex;
      const current = tab.results[statementIndex] ?? emptyResult;
      const nextResult = applyQueryEvent(current, event);
      const nextStatementStates: Record<number, StatementExecutionState> = { ...tab.statementStates };
      const statementCount = event.statementCount ?? tab.batchStatementCount;
      if (event.type === 'started' && event.statementCount !== undefined) {
        for (let index = 0; index < event.statementCount; index += 1) nextStatementStates[index] = { status: 'pending' };
      }
      if (event.statementIndex !== undefined) {
        const previousState = nextStatementStates[event.statementIndex] ?? { status: 'pending' as const };
        if (event.type === 'statement-started') nextStatementStates[event.statementIndex] = { status: 'running', sql: event.statementSql };
        else if (event.type === 'complete') nextStatementStates[event.statementIndex] = { ...previousState, status: 'success', message: event.message };
        else if (event.type === 'error') nextStatementStates[event.statementIndex] = { ...previousState, status: 'error', message: event.message };
        else if (event.type === 'cancelled') nextStatementStates[event.statementIndex] = { ...previousState, status: 'cancelled', message: event.scope === 'statement' ? 'Statement cancelled.' : undefined };
      }
      let batchStatus = tab.batchStatus;
      let batchMessage = tab.batchMessage;
      let batchCompletedStatements = tab.batchCompletedStatements;
      if (event.type === 'batch-complete') {
        batchStatus = event.status;
        batchMessage = event.message;
        batchCompletedStatements = event.completedStatements;
        const total = event.statementCount ?? Object.keys(nextStatementStates).length;
        for (let index = 0; index < total; index += 1) {
          const state = nextStatementStates[index];
          if (state?.status === 'pending' || !state) {
            nextStatementStates[index] = { status: event.status === 'complete' && index < event.completedStatements ? 'success' : 'skipped' };
          }
        }
      }
      const nextResults = event.type === 'started'
        ? {}
        : event.type === 'batch-complete'
          ? Object.fromEntries(Object.entries(tab.results).map(([index, item]) => [index, { ...item, batchStatus: event.status, lastSequence: event.sequence ?? item.lastSequence }])) as Record<number, ResultState>
          : { ...tab.results, [statementIndex]: nextResult };
      return {
        ...tab,
        results: nextResults,
        statementStates: nextStatementStates,
        batchStatus,
        batchMessage,
        batchCompletedStatements,
        batchStatementCount: statementCount,
        activeStatementIndex: event.type === 'statement-started' && event.statementIndex !== undefined ? event.statementIndex : tab.activeStatementIndex,
        running: event.type === 'batch-complete' ? false : tab.running,
      };
    }));
  }

  async function runQuery(mode: 'run' | 'smart' | 'batch' = 'run', inputOverride?: ExecutionInput, targetTabId = activeTabId): Promise<{ queryId: string; statementIndex: number; status: 'complete' | 'error' | 'cancelled' }> {
    if (!selected) throw new Error('Select a connection first.');
    const input = inputOverride ?? executionInput(mode);
    if (!input) throw new Error('No active editor tab.');
    const tabId = targetTabId;
    setError('');
    setTabs(previous => previous.map(tab => tab.id === tabId ? { ...tab, results: {}, activeStatementIndex: 0, queryId: undefined, running: true, statementStates: {}, batchStatus: undefined, batchMessage: undefined, batchCompletedStatements: undefined, batchStatementCount: undefined } : tab));
    try {
      let started: Awaited<ReturnType<typeof api.startQuery>>;
      try {
        started = await api.startQuery(input);
      } catch (reason: unknown) {
        const message = reason instanceof Error ? reason.message : '';
        if (!message.includes('Write confirmation required')) throw reason;
        const preview = await api.previewQuery(input);
        const previewText = preview.statements.map(statement => `${statement.index + 1}. ${statement.commandType}: ${statement.sql.trim()}${statement.warnings.length > 0 ? `\n   ${statement.warnings.join(' ')}` : ''}`).join('\n\n');
        if (!window.confirm(`This SQL can modify data or schema. Confirm execution?\n\nDatabase: ${preview.database}\n\n${previewText.slice(0, 2_000)}${previewText.length > 2_000 ? '\n…' : ''}`)) throw new Error('Write execution cancelled.', { cause: reason });
        started = await api.startQuery({ ...input, writeConfirmed: true, writePreviewToken: preview.previewToken });
      }
      setTabs(previous => previous.map(tab => tab.id === tabId ? { ...tab, queryId: started.queryId } : tab));
      return await new Promise<{ queryId: string; statementIndex: number; status: 'complete' | 'error' | 'cancelled' }>((resolve, reject) => {
        let terminalStatus: 'complete' | 'error' | 'cancelled' = 'complete';
        let lastStatementIndex = 0;
        const subscription = connectToQueryEvents(started.queryId, event => {
          if (event.statementIndex !== undefined) lastStatementIndex = event.statementIndex;
          applyEventToTab(tabId, event);
          if (event.type === 'error') terminalStatus = 'error';
          if (event.type === 'cancelled') terminalStatus = 'cancelled';
          if (event.type === 'batch-complete') {
            terminalStatus = event.status;
            subscription.close();
            subscriptionsRef.current.delete(tabId);
            setTabs(previous => previous.map(tab => tab.id === tabId ? { ...tab, running: false } : tab));
            if (event.status === 'complete') setLastQueryTime(Date.now());
            resolve({ queryId: started.queryId, statementIndex: mode === 'run' ? 0 : lastStatementIndex, status: terminalStatus });
          }
        }, (reason: Error) => {
          subscription.close();
          subscriptionsRef.current.delete(tabId);
          setTabs(previous => previous.map(tab => tab.id === tabId ? { ...tab, running: false, results: { ...tab.results, [tab.activeStatementIndex]: { ...(tab.results[tab.activeStatementIndex] ?? emptyResult), status: 'error', message: reason.message } } } : tab));
          setError(reason.message);
          reject(reason);
        });
        subscriptionsRef.current.set(tabId, subscription);
      });
    } catch (reason: unknown) {
      const message = reason instanceof Error ? reason.message : 'Query failed.';
      setTabs(previous => previous.map(tab => tab.id === tabId ? { ...tab, running: false, results: { 0: { ...emptyResult, status: 'error', message } } } : tab));
      setError(message);
      throw reason;
    }
  }

  /** Run query, then export results. */
  async function runAndExport(format: 'csv' | 'xlsx' | 'xlsb'): Promise<void> {
    if (!selected) { setError('Select a connection first.'); return; }
    setError('');
    try {
      const outcome = await runQuery('run');
      if (outcome.status !== 'complete') throw new Error(outcome.status === 'cancelled' ? 'Query cancelled.' : 'Query failed.');
      const { blob, fileName } = await api.exportQuery(outcome.queryId, {
        statementIndex: outcome.statementIndex,
        format,
        fileName: `query-export-${Date.now()}`,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Export failed.');
    }
  }

  function retryStatement(index: number): void {
    const statement = activeTab?.statementStates[index];
    const statementSql = statement?.sql;
    if (!selected || !activeTab || !statementSql?.trim()) {
      setError('The failed statement text is unavailable for retry.');
      return;
    }
    const id = `retry-${Date.now()}`;
    const retryInput: ExecutionInput = { connectionId: selected.id, database: activeTab.database ?? database, sql: statementSql, mode: 'single' };
    setTabs(previous => [...previous, { ...newEditorTab(previous.length + 1, id), title: `Retry · Statement ${index + 1}`, sql: statementSql, connectionId: selected.id, database: retryInput.database, schema: activeTab.schema }]);
    setActiveTabId(id);
    void runQuery('run', retryInput, id).catch(reason => setError(reason instanceof Error ? reason.message : 'Retry failed.'));
  }

  function handleRun(mode: RunMode): void {
    if (mode === 'export-csv') { void runAndExport('csv'); }
    else if (mode === 'export-xlsx') { void runAndExport('xlsx'); }
    else if (mode === 'export-xlsb') { void runAndExport('xlsb'); }
    else if (mode === 'explain') {
      const input = executionInput(mode);
      if (input) {
        setTabs(previous => previous.map(tab => tab.id === activeTabId ? { ...tab, resultView: 'explain' } : tab));
        void runQuery('run', input).catch(() => undefined);
      }
    } else {
      setTabs(previous => previous.map(tab => tab.id === activeTabId ? { ...tab, resultView: 'grid' } : tab));
      void runQuery(mode).catch(() => undefined);
    }
  }

  async function handleSave(): Promise<void> {
    const active = tabs.find(t => t.id === activeTabId);
    if (!active) return;
    if (preferences?.formatOnSave) await editorRef.current?.getAction('editor.action.formatDocument')?.run();
    const savedSql = editorRef.current?.getValue() ?? active.sql;
    try {
      localStorage.setItem('justybase_current_draft', savedSql);
    } catch { /* ignore */ }
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, sql: savedSql, dirty: false } : t));
  }

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  function handleFormat(): void {
    void editorRef.current?.getAction('editor.action.formatDocument')?.run();
  }

  function handleComment(): void {
    const ed = editorRef.current;
    if (ed) {
      // Use Monaco's built-in comment action (respects selection)
      ed.getAction('editor.action.commentLine')?.run();
      return;
    }
    // Fallback: toggle -- on every line
    const lines = sql.split('\n');
    const allCommented = lines.every(l => l.trim() === '' || l.trim().startsWith('--'));
    updateSql(lines.map(l => {
      const trimmed = l.trimStart();
      if (allCommented && trimmed.startsWith('--')) {
        return l.replace(/^\s*--\s?/, '');
      }
      if (!allCommented && !trimmed.startsWith('--') && trimmed !== '') {
        return l.startsWith(' ') || l.startsWith('\t') ? l.replace(/^(\s*)/, '$1-- ') : `-- ${l}`;
      }
      return l;
    }).join('\n'));
  }

  function updateSql(nextSql: string): void { setTabs(previous => previous.map(tab => tab.id === activeTabId ? { ...tab, sql: nextSql, dirty: true, source: undefined, sourceSql: undefined, sourceConnectionId: undefined, sourceDatabase: undefined } : tab)); setInspectedObject(null); }
  function insertSql(value: string): void {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (editor && model) {
      const selection = editor.getSelection() ?? model.getFullModelRange();
      editor.executeEdits('schema-insert', [{ range: selection, text: value, forceMoveMarkers: true }]);
      editor.focus();
      return;
    }
    updateSql(`${sql}${value}`);
  }
  function addTab(): void {
    const id = `query-${Date.now()}`;
    setTabs(previous => [...previous, { ...newEditorTab(previous.length + 1, id), connectionId: selected?.id, database: selected ? workspaceDatabase(selected) : database }]);
    setActiveTabId(id);
  }
  function closeTab(id: string): void {
    const tab = tabs.find(item => item.id === id);
    if (!tab || tabs.length === 1) return;
    if (tab.dirty && !window.confirm(`Close modified tab “${tab.title}”?`)) return;
    if (tab.running && tab.queryId) void api.cancelQuery(tab.queryId);
    subscriptionsRef.current.get(id)?.close();
    subscriptionsRef.current.delete(id);
    const index = tabs.findIndex(item => item.id === id);
    const next = tabs.filter(item => item.id !== id);
    setTabs(next);
    if (id === activeTabId) setActiveTabId(next[Math.max(0, index - 1)]?.id ?? next[0]!.id);
  }
  function contextChanged(nextDatabase?: string, nextSchema?: string): void {
    const nextDb = nextDatabase ?? '';
    const nextSchemaValue = nextSchema ?? '';
    setDatabase(nextDb); setSchema(nextSchemaValue);
    setTabs(previous => previous.map(tab => tab.id === activeTabId ? { ...tab, database: nextDb, schema: nextSchemaValue, source: undefined, sourceSql: undefined, sourceConnectionId: undefined, sourceDatabase: undefined } : tab));
    setInspectedObject(null);
  }
  function selectObject(node: SchemaTreeNode): void {
    if (!selected || node.kind !== 'object' || !node.objectName || !node.database || !node.schema) return;
    setDatabase(node.database);
    setSchema(node.schema);
    setTabs(previous => previous.map(tab => tab.id === activeTabId ? { ...tab, database: node.database, schema: node.schema, source: undefined, sourceSql: undefined, sourceConnectionId: undefined, sourceDatabase: undefined } : tab));
    setInspectedObject(node);
    setShowInspector(true);
    setTabs(previous => previous.map(tab => tab.id === activeTabId ? { ...tab, source: node } : tab));
    void api.columns(selected.id, node.database, node.schema, node.objectName).then(setColumns).catch(reason =>
      setError(reason instanceof Error ? reason.message : 'Could not load columns.')
    );
  }

  function openObjectDesigner(node: SchemaTreeNode): void {
    if (!selected || node.kind !== 'object' || !node.objectName || !node.database || !node.schema) {
      setError('Select a schema object before opening the designer.');
      return;
    }
    setDesignerTarget(node);
    setShowInspector(false);
  }
  function selectColumn(column: MetadataColumn): void { insertSql(column.name); }
  function openSchemaQuery(nextSql: string, title: string, node: SchemaTreeNode): void {
    const id = `schema-${Date.now()}`;
    const queryInput = { connectionId: selected?.id ?? '', database: node.database ?? database, sql: nextSql, mode: 'single' as const };
    setTabs(previous => [...previous, { ...newEditorTab(previous.length + 1, id), title, sql: nextSql, connectionId: selected?.id, database: queryInput.database, schema: node.schema, source: node, sourceSql: nextSql, sourceConnectionId: selected?.id, sourceDatabase: queryInput.database, resultView: title.toLowerCase().startsWith('explain') ? 'explain' : 'grid' }]);
    setActiveTabId(id);
    void runQuery('run', queryInput, id).catch(reason => setError(reason instanceof Error ? reason.message : 'Could not run schema query.'));
  }

  function resetLayout(): void {
    sidebar.setSize(250);
    editorSplit.setSize(45);
    try {
      localStorage.removeItem('jwb_sidebar');
      localStorage.removeItem('jwb_editor_pct');
      localStorage.removeItem('jwb_connection');
      localStorage.removeItem('jwb_database');
    } catch { /* ignore */ }
  }

  function selectConnection(id: string): void {
    const conn = connections.find(c => c.id === id);
    if (conn) {
      setSelected(conn);
      setDatabase(workspaceDatabase(conn));
      setSchema('');
      setColumns([]);
      setTabs(previous => previous.map(tab => tab.id === activeTabId ? { ...tab, connectionId: conn.id, database: workspaceDatabase(conn), schema: '', source: undefined, sourceSql: undefined, sourceConnectionId: undefined, sourceDatabase: undefined } : tab));
      setInspectedObject(null);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">JustyBase</div>
        <div className="workspace-title">Netezza SQL Workspace</div>
        <div className="topbar-user">
          <button className="secondary small" onClick={() => { setShowHistory(true); void api.history().then(setHistory); }}>History</button>
          <button className="secondary small" onClick={() => { setShowAudit(true); void api.audit().then(setAudit).catch(reason => setError(reason instanceof Error ? reason.message : 'Could not load audit log.')); }}>Audit</button>
          {user.role === 'admin' && <button className="secondary small" onClick={() => setShowAdmin(true)}>Admin</button>}
          <button className="secondary small" onClick={() => setShowSettings(true)}>⚙ Settings</button>
          <span>{user.username}</span>
          <button className="secondary small" onClick={onLogout}>Log out</button>
        </div>
      </header>

      <div className="workspace" ref={sidebar.containerRef}>
        {/* ── Left panel (sidebar) ── */}
        <aside className="sidebar" style={{ width: `${sidebar.size}px` }}>
          <div className="sidebar-section">
            <div className="section-title">
              Connections
              <button className="icon-button" onClick={() => { setEditingConnection(null); setShowConnectionForm(value => !value); }}>+</button>
            </div>
            {connections.map(connection => (
              <div className="connection-row-wrap" key={connection.id}>
                <button className={`tree-row connection-row ${selected?.id === connection.id ? 'active' : ''}`}
                  onClick={() => selectConnection(connection.id)}
                >
                  <span className="status-dot" />{connection.name}
                </button>
                <div className="connection-actions">
                  <button title="Edit connection" onClick={() => { setEditingConnection(connection); setShowConnectionForm(false); }}>✎</button>
                  <button title="Delete connection" onClick={() => void deleteConnection(connection)}>×</button>
                </div>
              </div>
            ))}
          </div>
          {selected ? (
            <SchemaTree
              connectionId={selected.id}
              database={database}
              databaseKind={selected.dbType}
              onInsert={insertSql}
              onContextChange={contextChanged}
              onObjectSelect={selectObject}
              onOpenDesigner={openObjectDesigner}
              onOpenQuery={openSchemaQuery}
              onImport={node => setImportTarget(node)}
            />
          ) : (
            <div className="sidebar-empty-state"><strong>No connections</strong><span>Add a connection to browse its schema.</span><button type="button" className="secondary small" onClick={() => { setEditingConnection(null); setShowConnectionForm(true); }}>Add connection</button></div>
          )}
        </aside>

        {/* Resize handle */}
        <div className="split-handle split-handle-h" onMouseDown={sidebar.onMouseDown} />

        {/* ── Center area ── */}
        <main className="editor-area">
          {/* Editor tabs */}
          <div className="editor-tabs">
            {tabs.map(tab => (
              <button className={`editor-tab ${tab.id === activeTabId ? 'active' : ''}`} key={tab.id} onClick={() => setActiveTabId(tab.id)}>
                {tab.title}{tab.dirty ? ' •' : ''}
                <span className="editor-tab-close" onClick={event => { event.stopPropagation(); closeTab(tab.id); }}>×</span>
              </button>
            ))}
            <button className="editor-tab-add" onClick={addTab}>+</button>
          </div>

          {/* New toolbar */}
          <EditorToolbar
            connectionId={selected?.id ?? ''}
            database={database}
            connections={connections}
            databases={databases}
            onSelectConnection={selectConnection}
            onSelectDatabase={db => { setDatabase(db); setSchema(''); contextChanged(db, undefined); }}
            onRun={handleRun}
            onSave={handleSave}
            onComment={handleComment}
            onFormat={handleFormat}
            isRunning={busy}
            onCancel={handleCancel}
          />

          {/* Editor + Results with vertical split */}
          <div className="editor-split-container" ref={editorSplit.containerRef}>
            <div className="editor" style={{ height: `${editorSplit.size}%` }}>
              <Editor
                height="100%"
                language="sql"
                theme="vs-dark"
                value={sql}
                onChange={value => updateSql(value ?? '')}
                onMount={(editor, monaco) => {
                  editorRef.current = editor;
                  // Register Ctrl+Enter as a Monaco command for Run
                  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
                    handleRunRef.current('run');
                  });
                  // Track INSERT/OVR mode
              const isInsert = editor.getOption(monaco.editor.EditorOption.insertMode);
              setOverwrite(!isInsert);
              const disposable = editor.onKeyDown(e => {
                if (e.keyCode === monaco.KeyCode.Insert) {
                  setTimeout(() => {
                    setOverwrite(!editor.getOption(monaco.editor.EditorOption.insertMode));
                  }, 0);
                }
              });
              editor.onDidDispose(() => disposable.dispose());
                  registerSqlLanguageFeatures(editor, monaco, () => ({
                    connectionId: selectedRef.current?.id,
                    database: databaseRef.current,
                    schema: schemaRef.current,
                    databaseKind: selectedRef.current?.dbType,
                  }), () => preferencesRef.current);
                }}
                options={{
                  minimap: { enabled: preferences?.minimap ?? false },
                  fontSize: preferences?.fontSize ?? 14,
                  tabSize: preferences?.tabSize ?? 4,
                  insertSpaces: preferences?.insertSpaces ?? true,
                  wordWrap: preferences?.wordWrap ?? 'off',
                  lineNumbers: preferences?.lineNumbers === false ? 'off' : 'on',
                  formatOnType: preferences?.formatOnType ?? false,
                  automaticLayout: true,
                  padding: { top: 12 },
                }}
              />
            </div>

            {/* Vertical resize handle */}
            <div className="split-handle split-handle-v" onMouseDown={editorSplit.onMouseDown} />

            <section className="results" style={{ height: `${100 - editorSplit.size}%` }}>
              {error && <div className="error-banner">{error}</div>}
              <div className="results-header">
                <strong>Results</strong>
                <div className="result-statement-tabs">
                  {statementIndexes.map(index => {
                    const state = statementStateFor(activeTab!, index);
                    return <button key={index} className={`secondary small statement-tab ${activeTab?.activeStatementIndex === index ? 'active' : ''}`} title={state.sql ?? `Statement ${index + 1}`} aria-label={`Statement ${index + 1}: ${statementStatusLabel(state.status)}`} onClick={() => setTabs(previous => previous.map(tab => tab.id === activeTabId ? { ...tab, activeStatementIndex: index } : tab))}>
                      <span>Statement {index + 1}</span><span className={statementStatusClass(state.status)}>{statementStatusLabel(state.status)}</span>
                    </button>;
                  })}
                </div>
                <span className={`result-status result-status-${result.status.startsWith('complete') ? 'complete' : result.status}`}>{result.status}{result.totalRows >= 0 ? ` · ${result.totalRows.toLocaleString()} rows` : ''}</span>
              </div>
              {isBatchResult && activeTab && <div className={`batch-summary ${batchVisualStatus ? `batch-summary-${batchVisualStatus}` : ''}`} role="status">
                <div className="batch-summary-heading"><strong>{batchVisualStatus === 'running' ? 'Running batch' : 'Batch complete'}</strong><span>{batchExecutedCount} of {batchStatementCount} statements executed</span></div>
                <div className="batch-summary-counts">
                  <span className="batch-count batch-count-success">{batchStatusCounts.success} succeeded</span>
                  <span className="batch-count batch-count-error">{batchStatusCounts.error} failed</span>
                  <span className="batch-count batch-count-skipped">{batchStatusCounts.skipped} skipped</span>
                  {batchStatusCounts.cancelled > 0 && <span className="batch-count batch-count-cancelled">{batchStatusCounts.cancelled} cancelled</span>}
                </div>
                {activeTab.batchMessage && <span className="batch-summary-message">{activeTab.batchMessage}</span>}
                {failedStatementIndex !== undefined && <button type="button" className="secondary small batch-retry" onClick={() => retryStatement(failedStatementIndex)}>Retry failed statement</button>}
              </div>}
              {result.message && <div className={`${result.status === 'error' ? 'error' : 'result-notice'} result-message`}>{result.message}</div>}
              {activeTab?.resultView === 'explain' && activeQueryId && result.sessionId ? (
                <ExplainPanel queryId={activeQueryId} statementIndex={activeTab.activeStatementIndex} result={result} />
              ) : result.columns.length > 0 && activeQueryId && result.sessionId ? (
                <ResultGrid queryId={activeQueryId} statementIndex={activeTab?.activeStatementIndex ?? 0} result={result} onEditRow={canEditActiveResult(activeTab, result, selected) ? row => setEditRow(row) : undefined} />
              ) : (
                <div className="empty-state" aria-live="polite">
                  {!selected ? <><strong>No connection selected</strong><span>Add a connection to browse schema and run SQL.</span><button type="button" onClick={() => { setEditingConnection(null); setShowConnectionForm(true); }}>Add connection</button></> : result.status === 'idle' ? <><strong>Ready to run SQL</strong><span>Write a query or choose a table from the schema explorer.</span><small>Run with Ctrl/Cmd+Enter</small></> : result.status === 'running' ? <><span className="empty-state-spinner" aria-hidden="true" /> <strong>Preparing result session…</strong></> : <><strong>No tabular rows</strong><span>The statement completed without returning a result grid.</span></>}
                </div>
              )}
            </section>
          </div>
        </main>

        {/* ── Right panel (inspector) ── */}
        {(showInspector && (inspectedObject || columns.length > 0)) ? <aside className="inspector">
          <div className="inspector-toolbar"><span>Inspector</span><button type="button" className="icon-button" aria-label="Hide inspector" onClick={() => setShowInspector(false)}>×</button></div>
          <InspectorPanel
            database={database}
            schema={schema}
            columns={columns}
            selectedObject={inspectedObject}
            onInsertColumn={selectColumn}
            connectionName={selected?.name}
          />
        </aside> : (inspectedObject || columns.length > 0) ? <button type="button" className="inspector-toggle" aria-label="Show inspector" onClick={() => setShowInspector(true)}>‹<span>Inspector</span></button> : null}
      </div>

      {(showConnectionForm || editingConnection) && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) { setEditingConnection(null); setShowConnectionForm(false); } }}>
        <section className="modal-card connection-card" role="dialog" aria-modal="true" aria-labelledby="connection-dialog-title">
          <div className="section-title"><span id="connection-dialog-title">{editingConnection ? 'Edit connection' : 'Add connection'}</span><button type="button" className="icon-button" aria-label="Close connection dialog" onClick={() => { setEditingConnection(null); setShowConnectionForm(false); }}>×</button></div>
          <ConnectionForm initial={editingConnection ?? undefined} onCreated={saveConnection} onCancel={() => { setEditingConnection(null); setShowConnectionForm(false); }} />
        </section>
      </div>}
      {showSettings && preferences && (
        <EditorSettings
          value={preferences}
          onSave={next => { setPreferences(next); setShowSettings(false); }}
          onClose={() => setShowSettings(false)}
          onResetLayout={resetLayout}
        />
      )}
      {showHistory && (
        <HistoryPanel
          entries={history}
          onClose={() => setShowHistory(false)}
          onOpen={entry => {
            const id = `history-${entry.id}`;
            setTabs(previous => [...previous, { ...newEditorTab(previous.length + 1, id), title: 'History query', sql: entry.sql, connectionId: entry.connectionId, database: entry.database }]);
            setActiveTabId(id);
            setShowHistory(false);
          }}
        />
      )}
      {showAudit && <AuditPanel entries={audit} onClose={() => setShowAudit(false)} />}
      {showAdmin && <AdminPanel onClose={() => setShowAdmin(false)} />}
      {designerTarget && selected && <ObjectDesigner
        connectionId={selected.id}
        database={designerTarget.database ?? database}
        databaseKind={selected.dbType}
        target={designerTarget}
        onClose={() => setDesignerTarget(null)}
        onApplied={() => { setError('Object designer change submitted. Refresh the schema to see the new definition.'); setDesignerTarget(null); }}
      />}
      {importTarget && selected && <ImportPanel connectionId={selected.id} database={database} target={importTarget} onClose={() => setImportTarget(null)} onCompleted={() => { setImportTarget(null); setInspectedObject(importTarget); }} />}
      {editRow && activeTab?.source && selected && canEditActiveResult(activeTab, result, selected) && <EditRowPanel connectionId={selected.id} database={activeTab.database ?? database} target={activeTab.source} columns={result.columns} columnTypes={result.columnTypes} values={editRow} onClose={() => setEditRow(null)} onCompleted={message => { setEditRow(null); setError(message); void runQuery('run').catch(() => undefined); }} />}

      {/* ── Status bar ── */}
      <StatusBar
        connectionName={selected?.name}
        database={database}
        lastQueryTime={lastQueryTime}
        overwrite={overwrite}
      />
    </div>
  );
}

type WebConnectionKind = 'netezza' | 'sqlite' | 'duckdb';
interface ConnectionFormState { name: string; host: string; port: number; database: string; user: string; password: string; dbType: WebConnectionKind; readOnly: boolean; }

function webConnectionKind(value: ConnectionProfileSummary['dbType'] | undefined): WebConnectionKind {
  if (value === 'sqlite') return 'sqlite';
  if (value === 'duckdb') return 'duckdb';
  return 'netezza';
}

function ConnectionForm({ initial, onCreated, onCancel }: { initial?: ConnectionProfileSummary; onCreated(connection: ConnectionProfileSummary): void; onCancel(): void }): ReactElement {
  const [form, setForm] = useState<ConnectionFormState>(() => ({ name: initial?.name ?? '', host: initial?.host ?? '', port: initial?.port ?? 5480, database: initial?.database ?? 'system', user: initial?.user ?? '', password: '', dbType: webConnectionKind(initial?.dbType), readOnly: initial?.readOnly ?? true }));
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault(); setSaving(true); setError('');
    try {
      if (initial) {
        const input: ConnectionProfileUpdate = { ...form, password: form.password || undefined };
        onCreated(await api.updateConnection(initial.id, input));
      } else {
        onCreated(await api.createConnection(form));
      }
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not save connection.');
    } finally { setSaving(false); }
  }
  async function test(): Promise<void> {
    setTesting(true); setTestMessage(''); setError('');
    try {
      if (initial && !form.password) {
        await api.testConnection(initial.id);
      } else {
        await api.testConnectionProfile(form);
      }
      setTestMessage('Connection succeeded.');
    }
    catch (reason: unknown) { setError(reason instanceof Error ? reason.message : 'Connection test failed.'); }
    finally { setTesting(false); }
  }
  const update = (key: keyof ConnectionFormState, value: string | number | boolean | WebConnectionKind): void => setForm(previous => ({ ...previous, [key]: value }));
  const local = form.dbType !== 'netezza';
  return <form className="connection-form" onSubmit={event => void submit(event)}>
    <div className="connection-fields">
      <label htmlFor="connection-type">Database type<select id="connection-type" value={form.dbType} onChange={event => update('dbType', event.target.value as WebConnectionKind)}><option value="netezza">Netezza</option><option value="sqlite">SQLite (local)</option><option value="duckdb">DuckDB (optional)</option></select></label>
      <label htmlFor="connection-name">Profile name<input id="connection-name" required value={form.name} onChange={event => update('name', event.target.value)} /></label>
      <label htmlFor="connection-host">Host<input id="connection-host" disabled={local} placeholder={local ? 'Not used for local databases' : undefined} value={form.host} onChange={event => update('host', event.target.value)} /></label>
      <label htmlFor="connection-port">Port<input id="connection-port" type="number" min="1" max="65535" disabled={local} value={form.port} onChange={event => update('port', Number(event.target.value))} /></label>
      <label htmlFor="connection-database">Database{local && <span className="field-help">File path or :memory:</span>}<input id="connection-database" required value={form.database} onChange={event => update('database', event.target.value)} /></label>
      <label htmlFor="connection-user">User<input id="connection-user" placeholder={local ? 'Optional' : undefined} value={form.user} onChange={event => update('user', event.target.value)} /></label>
      <label htmlFor="connection-password">{initial ? 'New password' : 'Password'}{local && <span className="field-help">Optional</span>}<input id="connection-password" type="password" autoComplete={initial ? 'new-password' : 'current-password'} value={form.password} onChange={event => update('password', event.target.value)} /></label>
    </div>
    <label className="checkbox"><input type="checkbox" checked={form.readOnly} onChange={event => update('readOnly', event.target.checked)} /> Read-only mode <span className="field-help">Recommended for exploration</span></label>
    {error && <div className="error" role="alert">{error}</div>}
    {testMessage && <div className="success-message" role="status">{testMessage} You can now save this profile.</div>}
    <div className="form-actions connection-actions-row"><button type="submit" disabled={saving}>{saving ? 'Saving…' : initial ? 'Save changes' : 'Add connection'}</button><button type="button" className="secondary" disabled={testing || saving} onClick={() => void test()}>{testing ? 'Testing…' : 'Test connection'}</button><button type="button" className="secondary" disabled={saving} onClick={onCancel}>Cancel</button></div>
  </form>;
}

function EditorSettings({ value, onSave, onClose, onResetLayout }: { value: EditorPreferences; onSave(value: EditorPreferences): void; onClose(): void; onResetLayout?(): void }): ReactElement {
  const [form, setForm] = useState(value);
  const [ruleText, setRuleText] = useState(() => Object.entries(value.linterRules).map(([code, level]) => `${code}=${level}`).join('\n'));
  const [ruleError, setRuleError] = useState('');
  const update = <K extends keyof EditorPreferences>(key: K, next: EditorPreferences[K]): void => setForm(previous => ({ ...previous, [key]: next }));
  async function save(): Promise<void> {
    setRuleError('');
    const linterRules: EditorPreferences['linterRules'] = { ...form.linterRules };
    for (const line of ruleText.split(/\r?\n/)) {
      const [rawCode, rawLevel] = line.split('=', 2).map(item => item.trim());
      if (!rawCode || !rawLevel) continue;
      if (!/^[A-Z][A-Z0-9_]*$/u.test(rawCode) || !['error', 'warning', 'information', 'hint', 'off'].includes(rawLevel)) {
        setRuleError(`Invalid rule entry: ${line}. Use CODE=error|warning|information|hint|off.`);
        return;
      }
      linterRules[rawCode] = rawLevel as EditorPreferences['linterRules'][string];
    }
    onSave(await api.updateEditorPreferences({ ...form, linterRules }));
  }
  return <div className="modal-backdrop"><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="editor-settings-title"><div className="section-title"><span id="editor-settings-title">Editor settings</span><button type="button" className="icon-button" aria-label="Close editor settings" onClick={onClose}>×</button></div><div className="settings-grid"><label>Font size<input type="number" min="10" max="32" value={form.fontSize} onChange={event => update('fontSize', Number(event.target.value))} /></label><label>Tab size<input type="number" min="1" max="16" value={form.tabSize} onChange={event => update('tabSize', Number(event.target.value))} /></label><label>Word wrap<select value={form.wordWrap} onChange={event => update('wordWrap', event.target.value as EditorPreferences['wordWrap'])}><option value="off">Off</option><option value="on">On</option><option value="bounded">Bounded</option></select></label><label>Keyword case<select value={form.keywordCase} onChange={event => update('keywordCase', event.target.value as EditorPreferences['keywordCase'])}><option value="upper">Uppercase</option><option value="lower">Lowercase</option><option value="preserve">Preserve</option></select></label><label className="checkbox"><input type="checkbox" checked={form.insertSpaces} onChange={event => update('insertSpaces', event.target.checked)} /> Insert spaces</label><label className="checkbox"><input type="checkbox" checked={form.minimap} onChange={event => update('minimap', event.target.checked)} /> Minimap</label><label className="checkbox"><input type="checkbox" checked={form.lineNumbers} onChange={event => update('lineNumbers', event.target.checked)} /> Line numbers</label><label className="checkbox"><input type="checkbox" checked={form.linterEnabled} onChange={event => update('linterEnabled', event.target.checked)} /> SQL linter</label><label className="checkbox"><input type="checkbox" checked={form.formatOnType} onChange={event => update('formatOnType', event.target.checked)} /> Format on type</label><label className="checkbox"><input type="checkbox" checked={form.formatOnSave} onChange={event => update('formatOnSave', event.target.checked)} /> Format on save</label><label className="checkbox"><input type="checkbox" checked={form.inlineTypeHints} onChange={event => update('inlineTypeHints', event.target.checked)} /> Inline type hints</label><label className="settings-rule-label">Rule levels<textarea rows={4} aria-invalid={Boolean(ruleError)} aria-describedby="settings-rule-help" placeholder="SQL025=warning\nNZP001=off" value={ruleText} onChange={event => { setRuleText(event.target.value); setRuleError(''); }} /><span id="settings-rule-help" className={ruleError ? 'settings-rule-error' : 'muted'}>{ruleError || 'One CODE=level per line: error, warning, information, hint or off.'}</span></label></div><div className="settings-actions"><div className="form-actions"><button type="button" onClick={() => void save()}>Save settings</button><button type="button" className="secondary" onClick={onClose}>Cancel</button></div><button type="button" className="secondary small settings-reset-layout" onClick={() => { onResetLayout?.(); onClose(); }}>Reset layout</button></div></section></div>;
}

function StatusBar({ connectionName, database, lastQueryTime, overwrite }: { connectionName?: string; database: string; lastQueryTime: number | null; overwrite: boolean }): ReactElement {
  const timeStr = lastQueryTime
    ? new Date(lastQueryTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;
  return (
    <footer className="statusbar">
      <div className="statusbar-left">
        {connectionName && (
          <span className="statusbar-item" title="Connection">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 7V4h16v3" /><path d="M9 20h6" /><path d="M12 4v16" />
            </svg>
            {connectionName}
          </span>
        )}
        {database && (
          <span className="statusbar-item" title="Database">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            </svg>
            {database}
          </span>
        )}
      </div>
      <div className="statusbar-right">
        {timeStr && (
          <span className="statusbar-item" title="Last query completed">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
            {timeStr}
          </span>
        )}
        <span className={`statusbar-item statusbar-ovr ${overwrite ? 'active' : ''}`} title={overwrite ? 'Overwrite mode (Press Insert to toggle)' : 'Insert mode (Press Insert to toggle)'}>
          {overwrite ? 'OVR' : 'INS'}
        </span>
      </div>
    </footer>
  );
}

function HistoryPanel({ entries, onClose, onOpen }: { entries: Awaited<ReturnType<typeof api.history>>; onClose(): void; onOpen(entry: Awaited<ReturnType<typeof api.history>>[number]): void }): ReactElement {
  return <div className="modal-backdrop"><section className="modal-card history-card"><div className="section-title">Query history <button className="icon-button" onClick={onClose}>×</button></div>{entries.length === 0 ? <p className="muted">No queries yet.</p> : <div className="history-list">{entries.map(entry => <button className="history-entry" key={entry.id} onClick={() => onOpen(entry)}><span><strong>{entry.status}</strong> · {new Date(entry.createdAt).toLocaleString()} · {entry.rowCount.toLocaleString()} rows</span><code>{entry.sql}</code></button>)}</div>}</section></div>;
}

function AuditPanel({ entries, onClose }: { entries: Awaited<ReturnType<typeof api.audit>>; onClose(): void }): ReactElement {
  return <div className="modal-backdrop"><section className="modal-card history-card audit-card"><div className="section-title">Execution audit <button className="icon-button" onClick={onClose}>×</button></div>{entries.length === 0 ? <p className="muted">No executed statements yet.</p> : <div className="history-list">{entries.map(entry => <div className="history-entry audit-entry" key={entry.id}><span><strong>{entry.status}</strong> · {entry.commandType} · {new Date(entry.createdAt).toLocaleString()} · {entry.database}</span><code>{entry.sql}</code><small>{entry.rowsAffected === undefined ? '—' : `${entry.rowsAffected.toLocaleString()} row(s) affected`} · {entry.durationMs} ms · {entry.confirmed ? 'confirmed' : 'read-only'}</small></div>)}</div>}</section></div>;
}
