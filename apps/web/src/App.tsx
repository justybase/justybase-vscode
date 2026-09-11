import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type * as Monaco from 'monaco-editor';
import type { ConnectionProfileSummary, EditorPreferences, MetadataColumn, MetadataDatabase, SchemaTreeNode, WebUser } from '@justybase/contracts';
import { AsyncStateView } from '@justybase/ui-react';
import { ApiClientProvider, createApiClient, useApiClient, type ApiClient, type QueryEventSubscription } from './api';
import { emptyResult } from './queryState';
import { registerSqlLanguageFeatures } from './sqlLanguage';
import { ObjectDesigner } from './ObjectDesigner';
import { ImportPanel } from './ImportPanel';
import { EditRowPanel } from './EditRowPanel';
import { AdminPanel } from './AdminPanel';
import type { RunMode } from './EditorToolbar';
import { useSplitPane } from './useSplitPane';
import { createWorkspaceStorage, migrateLegacyWorkspace, useWorkspaceStorage, WorkspaceStorageProvider, type WorkspaceStorage } from './workspacePersistence';
import { canEditActiveResult, workspaceDatabase } from './workspaceConnectionController';
import { restoreEditorWorkspace, newEditorTab, type EditorTab, type ExecutionInput } from './workspaceDocumentController';
import { applyEventToEditorTab, clearLiveQueryState } from './workspaceExecutionController';
import { persistDraft, persistEditorWorkspace, readPersistedNumber, resetPersistedWorkspaceLayout } from './workspacePersistenceController';
import { AuditPanel, ConnectionForm, EditorSettings, Login } from './workspacePanels';
import { configuredWebUiMode, SharedWebWorkspace } from './sharedUiAdapter';
import { DockyardWorkspace } from './dockyard/DockyardWorkspace';
import { LegacyWorkspaceRecovery } from './dockyard/LegacyWorkspaceRecovery';

interface PendingQueryStart {
  readonly tabId: string;
  cancelRequested: boolean;
  queryId?: string;
  settled: Promise<void>;
  resolveSettled(): void;
}

function createPendingQueryStart(tabId: string): PendingQueryStart {
  let resolve: () => void = () => undefined;
  const settled = new Promise<void>(promiseResolve => { resolve = promiseResolve; });
  return { tabId, cancelRequested: false, settled, resolveSettled: () => resolve() };
}

export function App({ apiClient }: { apiClient?: ApiClient } = {}): ReactElement {
  const defaultClientRef = useRef<ApiClient | undefined>(undefined);
  if (!defaultClientRef.current) defaultClientRef.current = apiClient ?? createApiClient();
  return <ApiClientProvider client={apiClient ?? defaultClientRef.current}><AuthenticatedApp /></ApiClientProvider>;
}

function AuthenticatedApp(): ReactElement {
  const api = useApiClient();
  const [user, setUser] = useState<WebUser | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { void api.me().then(response => setUser(response.user)).catch(() => undefined).finally(() => setLoading(false)); }, []);
  const invalidateSession = useCallback(async (): Promise<void> => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, [api]);
  if (loading) return <AsyncStateView state="loading" loadingLabel="Loading JustyBase…" />;
  if (!user) return <Login onLogin={setUser} />;
  if (configuredWebUiMode() === 'shared') return <SharedWebWorkspace api={api} user={user} onLogout={() => { void invalidateSession(); }} />;
  return <Workspace user={user} onLogout={() => setUser(null)} />;
}

function Workspace({ user, onLogout }: { user: WebUser; onLogout(): void }): ReactElement {
  const storageRef = useRef<{ userId: string; storage: WorkspaceStorage } | undefined>(undefined);
  const [migrationReadyFor, setMigrationReadyFor] = useState<string | undefined>(undefined);
  if (!storageRef.current || storageRef.current.userId !== user.id) {
    const storage = createWorkspaceStorage(user.id);
    storageRef.current = { userId: user.id, storage };
  }
  useEffect(() => {
    const current = storageRef.current;
    if (!current || current.userId !== user.id) return;
    migrateLegacyWorkspace(current.storage);
    setMigrationReadyFor(user.id);
  }, [user.id]);
  const currentStorage = storageRef.current;
  if (migrationReadyFor !== user.id || !currentStorage || currentStorage.userId !== user.id) return <div className="center-message">Loading workspace…</div>;
  return <WorkspaceStorageProvider storage={currentStorage.storage}><WorkspaceContent user={user} onLogout={onLogout} /></WorkspaceStorageProvider>;
}

function WorkspaceContent({ user, onLogout }: { user: WebUser; onLogout(): void }): ReactElement {
  const api = useApiClient();
  const storage = useWorkspaceStorage();
  const restoredWorkspace = useRef<{ tabs: EditorTab[]; activeTabId: string } | null>(null);
  if (!restoredWorkspace.current) restoredWorkspace.current = restoreEditorWorkspace(storage);
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
  const [importTarget, setImportTarget] = useState<SchemaTreeNode | null>(null);
  const [editRow, setEditRow] = useState<unknown[] | null>(null);
  const [databases, setDatabases] = useState<MetadataDatabase[]>([]);
  const [lastQueryTime, setLastQueryTime] = useState<number | null>(null);
  const [overwrite, setOverwrite] = useState(false);

  // Dockyard owns explorer/tool geometry; the query/result split remains a
  // product-level preference and is migrated from editor_pct.
  const editorSplit = useSplitPane('vertical', readPersistedNumber(storage, 'editor_pct', 45), 20, 80);
  const [showConnectionForm, setShowConnectionForm] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [history, setHistory] = useState<Awaited<ReturnType<ApiClient['history']>>>([]);
  const [showAudit, setShowAudit] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [audit, setAudit] = useState<Awaited<ReturnType<ApiClient['audit']>>>([]);
  const [preferences, setPreferences] = useState<EditorPreferences | null>(null);
  const selectedRef = useRef<ConnectionProfileSummary | null>(null);
  const databaseRef = useRef('');
  const schemaRef = useRef('');
  const subscriptionsRef = useRef(new Map<string, QueryEventSubscription>());
  const preferencesRef = useRef<EditorPreferences | null>(null);
  const activeQueryIdRef = useRef('');
  const tabsRef = useRef<EditorTab[]>(tabs);
  const connectionsRef = useRef<ConnectionProfileSummary[]>(connections);
  const pendingQueryStartsRef = useRef(new Set<PendingQueryStart>());
  const activeQueryIdsRef = useRef(new Map<string, Set<string>>());
  const savedConnectionIdRef = useRef<string | null>(null);
  const savedDatabaseRef = useRef('');
  const editorRefs = useRef(new Map<string, Monaco.editor.IStandaloneCodeEditor>());
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const dockyardResetRef = useRef<(() => void) | undefined>(undefined);
  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? tabs[0];
  const activeQueryId = activeTab?.queryId ?? '';
  const result = activeTab?.results[activeTab.activeStatementIndex] ?? emptyResult;

  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  // Editor language callbacks can outlive the render in which the editor was
  // mounted. Keep connection lookup independent from that initial closure so
  // an asynchronously loaded profile can still supply its database kind.
  connectionsRef.current = connections;

  const cleanupLiveResources = useCallback(async (clearLiveState = false): Promise<void> => {
    const pendingStarts = [...pendingQueryStartsRef.current];
    for (const pendingStart of pendingStarts) pendingStart.cancelRequested = true;

    const queryIds = new Set<string>();
    for (const tab of tabsRef.current) if (tab.queryId) queryIds.add(tab.queryId);
    for (const trackedIds of activeQueryIdsRef.current.values()) {
      for (const queryId of trackedIds) queryIds.add(queryId);
    }
    for (const pendingStart of pendingStarts) if (pendingStart.queryId) queryIds.add(pendingStart.queryId);

    const jobs = [...queryIds].map(queryId => api.cancelQuery(queryId).catch(() => undefined));
    for (const subscription of subscriptionsRef.current.values()) subscription.close();
    subscriptionsRef.current.clear();
    // A start request is deliberately allowed to finish: aborting it can
    // hide a server-created job before its id is returned. The runQuery
    // continuation observes cancelRequested and cancels that returned job.
    await Promise.all([...jobs, ...pendingStarts.map(pendingStart => pendingStart.settled)]);
    if (clearLiveState) setTabs(previous => previous.map(clearLiveQueryState));
  }, [api]);

  useEffect(() => () => { void cleanupLiveResources(); }, [cleanupLiveResources]);

  async function handleLogout(): Promise<void> {
    await cleanupLiveResources(true);
    try { await api.logout(); } finally { onLogout(); }
  }

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
        const savedId = storage.get('connection');
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
      const savedDb = storage.get('database');
      savedDatabaseRef.current = savedDb ?? '';
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { if (!selected) return; void api.databases(selected.id).then(setDatabases).catch(() => undefined); }, [selected?.id]);

  // Dockyard persists its own explorer/tool geometry in its versioned layout.
  useEffect(() => { storage.set('editor_pct', String(editorSplit.size)); }, [editorSplit.size, storage]);

  // Persist connection selection
  useEffect(() => { storage.set('connection', selected?.id ?? ''); }, [selected?.id, storage]);
  useEffect(() => { storage.set('database', database); }, [database, storage]);
  useEffect(() => {
    try {
      persistEditorWorkspace(storage, tabs, activeTabId);
    } catch { /* ignore */ }
  }, [tabs, activeTabId, storage]);

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

  function handleCancel(targetTabId = activeTabId): void {
    const targetTab = tabs.find(tab => tab.id === targetTabId);
    const queryIds = new Set<string>(targetTab?.queryId ? [targetTab.queryId] : []);
    for (const queryId of activeQueryIdsRef.current.get(targetTabId) ?? []) queryIds.add(queryId);
    for (const queryId of queryIds) void api.cancelQuery(queryId).catch(() => undefined);
  }

  // Keyboard shortcuts
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Escape closes transient UI first, then cancels an active query.
      if (e.key === 'Escape') {
        if (showConnectionForm || editingConnection) { e.preventDefault(); setEditingConnection(null); setShowConnectionForm(false); return; }
        if (showSettings) { e.preventDefault(); setShowSettings(false); return; }
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
  }, [activeTabId, editRow, editingConnection, importTarget, showAdmin, showAudit, showConnectionForm, showSettings]);

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

  function handleEditorReady(tabId: string, editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco): void {
    editorRefs.current.set(tabId, editor);
    if (tabId === activeTabId) editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      handleRunRef.current('run', tabId);
    });
    registerSqlLanguageFeatures(editor, monaco, api, () => ({
      connectionId: tabsRef.current.find(tab => tab.id === tabId)?.connectionId,
      database: tabsRef.current.find(tab => tab.id === tabId)?.database ?? '',
      schema: tabsRef.current.find(tab => tab.id === tabId)?.schema ?? '',
      databaseKind: (() => {
        const connectionId = tabsRef.current.find(tab => tab.id === tabId)?.connectionId;
        return connectionsRef.current.find(connection => connection.id === connectionId)?.dbType;
      })(),
    }), () => preferencesRef.current);
  }

  function handleEditorDispose(tabId: string): void {
    editorRefs.current.delete(tabId);
    if (tabId === activeTabId) editorRef.current = null;
  }

  const overwriteByTabRef = useRef(new Map<string, boolean>());
  function handleOverwriteChange(tabId: string, value: boolean): void {
    overwriteByTabRef.current.set(tabId, value);
    if (tabId === activeTabId) setOverwrite(value);
  }

  function activateTab(tabId: string, allowQueuedTab = false): void {
    // React state updates are batched. New-document callers queue the tab and
    // activate it in the same event, before `tabs` contains the new id.
    if (!allowQueuedTab && !tabs.some(tab => tab.id === tabId)) return;
    setActiveTabId(tabId);
    editorRef.current = editorRefs.current.get(tabId) ?? null;
    setOverwrite(overwriteByTabRef.current.get(tabId) ?? false);
  }

  function executionInput(mode: RunMode, targetTabId = activeTabId): ExecutionInput | null {
    const targetTab = tabs.find(tab => tab.id === targetTabId);
    if (!targetTab) return null;
    const targetConnection = targetTab.connectionId
      ? connections.find(connection => connection.id === targetTab.connectionId)
      : selected;
    if (!targetConnection) return null;
    const targetDatabase = targetTab.database ?? workspaceDatabase(targetConnection);
    const editor = editorRefs.current.get(targetTabId) ?? (targetTabId === activeTabId ? editorRef.current : null);
    const model = editor?.getModel();
    const selection = editor?.getSelection();
    const selectedSql = model && selection && !selection.isEmpty() ? model.getValueInRange(selection) : '';
    const targetSql = model?.getValue() ?? targetTab.sql;
    if (mode === 'explain') {
      const base = executionInput('run', targetTabId);
      if (!base || !base.sql.trim()) return null;
      return { ...base, mode: 'explain' };
    }
    if (mode === 'run') {
      if (selectedSql.trim()) return { connectionId: targetConnection.id, database: targetDatabase, sql: selectedSql, mode: 'single' };
      return { connectionId: targetConnection.id, database: targetDatabase, sql: targetSql, mode: 'single', cursorOffset: model && editor?.getPosition() ? model.getOffsetAt(editor.getPosition()!) : undefined };
    }
    if (mode === 'smart' && !selectedSql.trim()) return executionInput('run', targetTabId);
    return { connectionId: targetConnection.id, database: targetDatabase, sql: mode === 'smart' ? selectedSql : targetSql, mode: 'script' };
  }

  async function runQuery(mode: 'run' | 'smart' | 'batch' = 'run', inputOverride?: ExecutionInput, targetTabId = activeTabId): Promise<{ queryId: string; statementIndex: number; status: 'complete' | 'error' | 'cancelled' }> {
    const input = inputOverride ?? executionInput(mode, targetTabId);
    if (!input) throw new Error('No active editor tab.');
    if (!connections.some(connection => connection.id === input.connectionId)) throw new Error('Select a connection first.');
    const tabId = targetTabId;
    setError('');
    setTabs(previous => previous.map(tab => tab.id === tabId ? { ...tab, results: {}, activeStatementIndex: 0, queryId: undefined, running: true, statementStates: {}, batchStatus: undefined, batchMessage: undefined, batchCompletedStatements: undefined, batchStatementCount: undefined } : tab));
    const pendingStart = createPendingQueryStart(tabId);
    pendingQueryStartsRef.current.add(pendingStart);
    let pendingStartReleased = false;
    const releasePendingStart = (): void => {
      if (pendingStartReleased) return;
      pendingStartReleased = true;
      pendingQueryStartsRef.current.delete(pendingStart);
      pendingStart.resolveSettled();
    };
    const trackQueryId = (queryId: string): void => {
      pendingStart.queryId = queryId;
      const trackedIds = activeQueryIdsRef.current.get(tabId) ?? new Set<string>();
      trackedIds.add(queryId);
      activeQueryIdsRef.current.set(tabId, trackedIds);
    };
    const untrackQueryId = (queryId: string): void => {
      const trackedIds = activeQueryIdsRef.current.get(tabId);
      if (!trackedIds) return;
      trackedIds.delete(queryId);
      if (trackedIds.size === 0) activeQueryIdsRef.current.delete(tabId);
    };
    try {
      let started: Awaited<ReturnType<typeof api.startQuery>>;
      try {
        started = await api.startQuery(input);
      } catch (reason: unknown) {
        const message = reason instanceof Error ? reason.message : '';
        if (!message.includes('Write confirmation required')) throw reason;
        if (pendingStart.cancelRequested) throw new Error('Query cancelled during start.', { cause: reason });
        const preview = await api.previewQuery(input);
        if (pendingStart.cancelRequested) throw new Error('Query cancelled during start.', { cause: reason });
        const previewText = preview.statements.map(statement => `${statement.index + 1}. ${statement.commandType}: ${statement.sql.trim()}${statement.warnings.length > 0 ? `\n   ${statement.warnings.join(' ')}` : ''}`).join('\n\n');
        if (!window.confirm(`This SQL can modify data or schema. Confirm execution?\n\nDatabase: ${preview.database}\n\n${previewText.slice(0, 2_000)}${previewText.length > 2_000 ? '\n…' : ''}`)) throw new Error('Write execution cancelled.', { cause: reason });
        if (pendingStart.cancelRequested) throw new Error('Query cancelled during start.', { cause: reason });
        started = await api.startQuery({ ...input, writeConfirmed: true, writePreviewToken: preview.previewToken });
      }
      trackQueryId(started.queryId);
      if (pendingStart.cancelRequested) {
        await api.cancelQuery(started.queryId).catch(() => undefined);
        untrackQueryId(started.queryId);
        throw new Error('Query cancelled during start.');
      }
      setTabs(previous => previous.map(tab => tab.id === tabId ? { ...tab, queryId: started.queryId } : tab));
      const outcome = new Promise<{ queryId: string; statementIndex: number; status: 'complete' | 'error' | 'cancelled' }>((resolve, reject) => {
        let terminalStatus: 'complete' | 'error' | 'cancelled' = 'complete';
        let lastStatementIndex = 0;
        const subscription = api.connectToQueryEvents(started.queryId, event => {
          if (event.statementIndex !== undefined) lastStatementIndex = event.statementIndex;
          setTabs(previous => previous.map(tab => tab.id === tabId ? applyEventToEditorTab(tab, event) : tab));
          if (event.type === 'error') terminalStatus = 'error';
          if (event.type === 'cancelled') terminalStatus = 'cancelled';
          if (event.type === 'batch-complete') {
            terminalStatus = event.status;
            untrackQueryId(started.queryId);
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
      // From this point the tab/subscription owns the query id; cleanup will
      // find it through activeQueryIdsRef even before React commits setTabs.
      releasePendingStart();
      return await outcome;
    } catch (reason: unknown) {
      const message = reason instanceof Error ? reason.message : 'Query failed.';
      setTabs(previous => previous.map(tab => tab.id === tabId ? { ...tab, running: false, results: { 0: { ...emptyResult, status: 'error', message } } } : tab));
      setError(message);
      throw reason;
    } finally {
      releasePendingStart();
    }
  }

  /** Run query, then export results. */
  async function runAndExport(format: 'csv' | 'xlsx' | 'xlsb', targetTabId = activeTabId): Promise<void> {
    if (!executionInput('run', targetTabId)) { setError('Select a connection first.'); return; }
    setError('');
    try {
      const outcome = await runQuery('run', undefined, targetTabId);
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

  function retryStatement(index: number, targetTabId = activeTabId): void {
    const targetTab = tabs.find(tab => tab.id === targetTabId);
    const statement = targetTab?.statementStates[index];
    const statementSql = statement?.sql;
    const targetConnection = targetTab?.connectionId ? connections.find(connection => connection.id === targetTab.connectionId) : selected;
    if (!targetConnection || !targetTab || !statementSql?.trim()) {
      setError('The failed statement text is unavailable for retry.');
      return;
    }
    const id = `retry-${Date.now()}`;
    const retryInput: ExecutionInput = { connectionId: targetConnection.id, database: targetTab.database ?? workspaceDatabase(targetConnection), sql: statementSql, mode: 'single' };
    setTabs(previous => [...previous, { ...newEditorTab(previous.length + 1, id), title: `Retry · Statement ${index + 1}`, sql: statementSql, connectionId: targetConnection.id, database: retryInput.database, schema: targetTab.schema }]);
    activateTab(id, true);
    void runQuery('run', retryInput, id).catch(reason => setError(reason instanceof Error ? reason.message : 'Retry failed.'));
  }

  function handleRun(mode: RunMode, targetTabId = activeTabId): void {
    if (mode === 'export-csv') { void runAndExport('csv', targetTabId); }
    else if (mode === 'export-xlsx') { void runAndExport('xlsx', targetTabId); }
    else if (mode === 'export-xlsb') { void runAndExport('xlsb', targetTabId); }
    else if (mode === 'explain') {
      const input = executionInput(mode, targetTabId);
      if (input) {
        setTabs(previous => previous.map(tab => tab.id === targetTabId ? { ...tab, resultView: 'explain' } : tab));
        void runQuery('run', input, targetTabId).catch(() => undefined);
      }
    } else {
      setTabs(previous => previous.map(tab => tab.id === targetTabId ? { ...tab, resultView: 'grid' } : tab));
      void runQuery(mode, undefined, targetTabId).catch(() => undefined);
    }
  }

  async function handleSave(targetTabId = activeTabId): Promise<void> {
    const active = tabs.find(t => t.id === targetTabId);
    if (!active) return;
    const editor = editorRefs.current.get(targetTabId) ?? (targetTabId === activeTabId ? editorRef.current : null);
    if (preferences?.formatOnSave) await editor?.getAction('editor.action.formatDocument')?.run();
    const savedSql = editor?.getValue() ?? active.sql;
    try {
      persistDraft(storage, savedSql);
    } catch { /* ignore */ }
    setTabs(prev => prev.map(t => t.id === targetTabId ? { ...t, sql: savedSql, dirty: false } : t));
  }

  function handleFormat(targetTabId = activeTabId): void {
    const editor = editorRefs.current.get(targetTabId) ?? (targetTabId === activeTabId ? editorRef.current : null);
    void editor?.getAction('editor.action.formatDocument')?.run();
  }

  function handleComment(targetTabId = activeTabId): void {
    const targetTab = tabs.find(tab => tab.id === targetTabId);
    if (!targetTab) return;
    const ed = editorRefs.current.get(targetTabId) ?? (targetTabId === activeTabId ? editorRef.current : null);
    if (ed) {
      // Use Monaco's built-in comment action (respects selection)
      ed.getAction('editor.action.commentLine')?.run();
      return;
    }
    // Fallback: toggle -- on every line
    const lines = targetTab.sql.split('\n');
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
    }).join('\n'), targetTabId);
  }

  function updateSql(nextSql: string, targetTabId = activeTabId): void { setTabs(previous => previous.map(tab => tab.id === targetTabId ? { ...tab, sql: nextSql, dirty: true, source: undefined, sourceSql: undefined, sourceConnectionId: undefined, sourceDatabase: undefined } : tab)); setInspectedObject(null); }
  function insertSql(value: string, targetTabId = activeTabId): void {
    const editor = editorRefs.current.get(targetTabId) ?? (targetTabId === activeTabId ? editorRef.current : null);
    const model = editor?.getModel();
    if (editor && model) {
      const selection = editor.getSelection() ?? model.getFullModelRange();
      editor.executeEdits('schema-insert', [{ range: selection, text: value, forceMoveMarkers: true }]);
      editor.focus();
      return;
    }
    const targetTab = tabs.find(tab => tab.id === targetTabId);
    updateSql(`${targetTab?.sql ?? ''}${value}`, targetTabId);
  }
  function addTab(): void {
    const id = `query-${Date.now()}`;
    setTabs(previous => [...previous, { ...newEditorTab(previous.length + 1, id), connectionId: selected?.id, database: selected ? workspaceDatabase(selected) : database }]);
    activateTab(id, true);
  }
  function closeTab(id: string): boolean {
    const tab = tabs.find(item => item.id === id);
    if (!tab || tabs.length === 1) return false;
    if (tab.dirty && !window.confirm(`Close modified tab “${tab.title}”?`)) return false;
    const queryIds = new Set<string>();
    if (tab.queryId) queryIds.add(tab.queryId);
    for (const queryId of activeQueryIdsRef.current.get(id) ?? []) queryIds.add(queryId);
    for (const pendingStart of pendingQueryStartsRef.current) {
      if (pendingStart.tabId === id) {
        pendingStart.cancelRequested = true;
        if (pendingStart.queryId) queryIds.add(pendingStart.queryId);
      }
    }
    for (const queryId of queryIds) void api.cancelQuery(queryId).catch(() => undefined);
    subscriptionsRef.current.get(id)?.close();
    subscriptionsRef.current.delete(id);
    const index = tabs.findIndex(item => item.id === id);
    const next = tabs.filter(item => item.id !== id);
    setTabs(next);
    editorRefs.current.delete(id);
    overwriteByTabRef.current.delete(id);
    if (id === activeTabId) activateTab(next[Math.max(0, index - 1)]?.id ?? next[0]!.id);
    return true;
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
  }
  function selectColumn(column: MetadataColumn): void { insertSql(column.name, activeTabId); }
  function openSchemaQuery(nextSql: string, title: string, node: SchemaTreeNode): void {
    const id = `schema-${Date.now()}`;
    const queryInput = { connectionId: selected?.id ?? '', database: node.database ?? database, sql: nextSql, mode: 'single' as const };
    setTabs(previous => [...previous, { ...newEditorTab(previous.length + 1, id), title, sql: nextSql, connectionId: selected?.id, database: queryInput.database, schema: node.schema, source: node, sourceSql: nextSql, sourceConnectionId: selected?.id, sourceDatabase: queryInput.database, resultView: title.toLowerCase().startsWith('explain') ? 'explain' : 'grid' }]);
    activateTab(id, true);
    void runQuery('run', queryInput, id).catch(reason => setError(reason instanceof Error ? reason.message : 'Could not run schema query.'));
  }

  function resetLayout(): void {
    editorSplit.setSize(45);
    try { resetPersistedWorkspaceLayout(storage); } catch { /* ignore */ }
    dockyardResetRef.current?.();
  }

  function selectConnection(id: string, targetTabId = activeTabId): void {
    const conn = connections.find(c => c.id === id);
    if (conn) {
      setSelected(conn);
      setDatabase(workspaceDatabase(conn));
      setSchema('');
      setColumns([]);
      setTabs(previous => previous.map(tab => tab.id === targetTabId ? { ...tab, connectionId: conn.id, database: workspaceDatabase(conn), schema: '', source: undefined, sourceSql: undefined, sourceConnectionId: undefined, sourceDatabase: undefined } : tab));
      setInspectedObject(null);
    }
  }

  function selectDatabase(nextDatabase: string, targetTabId = activeTabId): void {
    setDatabase(nextDatabase);
    setSchema('');
    setTabs(previous => previous.map(tab => tab.id === targetTabId
      ? { ...tab, database: nextDatabase, schema: '', source: undefined, sourceSql: undefined, sourceConnectionId: undefined, sourceDatabase: undefined }
      : tab));
    setColumns([]);
    setInspectedObject(null);
  }

  function openHistoryEntry(entry: Awaited<ReturnType<ApiClient['history']>>[number]): void {
    const id = `history-${entry.id}`;
    setTabs(previous => [...previous, { ...newEditorTab(previous.length + 1, id), title: 'History query', sql: entry.sql, connectionId: entry.connectionId, database: entry.database }]);
    activateTab(id, true);
  }

  function openAudit(): void {
    setShowAudit(true);
    void api.audit().then(setAudit).catch(reason => setError(reason instanceof Error ? reason.message : 'Could not load audit log.'));
  }

  const registerDockyardReset = useCallback((reset: (() => void) | undefined): void => {
    dockyardResetRef.current = reset;
  }, []);

  function openEditRow(tabId: string, values: unknown[]): void {
    activateTab(tabId);
    setEditRow(values);
  }

  const transientUi = <>
    {(showConnectionForm || editingConnection) && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) { setEditingConnection(null); setShowConnectionForm(false); } }}>
      <section className="modal-card connection-card" role="dialog" aria-modal="true" aria-labelledby="connection-dialog-title">
        <div className="section-title"><span id="connection-dialog-title">{editingConnection ? 'Edit connection' : 'Add connection'}</span><button type="button" className="icon-button" aria-label="Close connection dialog" onClick={() => { setEditingConnection(null); setShowConnectionForm(false); }}>×</button></div>
        <ConnectionForm initial={editingConnection ?? undefined} onCreated={saveConnection} onCancel={() => { setEditingConnection(null); setShowConnectionForm(false); }} />
      </section>
    </div>}
    {showSettings && preferences && <EditorSettings value={preferences} onSave={next => { setPreferences(next); setShowSettings(false); }} onClose={() => setShowSettings(false)} onResetLayout={resetLayout} />}
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
  </>;

  const recoveryContent = (reason: string): ReactElement => <LegacyWorkspaceRecovery
    user={user}
    storage={storage}
    tabs={tabs}
    activeTabId={activeTabId}
    connections={connections}
    selected={selected}
    database={database}
    schema={schema}
    columns={columns}
    inspectedObject={inspectedObject}
    databases={databases}
    preferences={preferences}
    error={error}
    lastQueryTime={lastQueryTime}
    overwrite={overwrite}
    editorSplit={editorSplit}
    onEditorReady={handleEditorReady}
    onEditorDispose={handleEditorDispose}
    onOverwriteChange={handleOverwriteChange}
    onActivateTab={activateTab}
    onCloseTab={closeTab}
    onAddTab={addTab}
    onUpdateSql={(tabId, nextSql) => updateSql(nextSql, tabId)}
    onRun={(tabId, mode) => handleRun(mode, tabId)}
    onSave={handleSave}
    onComment={handleComment}
    onFormat={handleFormat}
    onCancel={handleCancel}
    onSelectStatement={(tabId, statementIndex) => setTabs(previous => previous.map(tab => tab.id === tabId ? { ...tab, activeStatementIndex: statementIndex } : tab))}
    onRetryStatement={(tabId, statementIndex) => retryStatement(statementIndex, tabId)}
    onSelectConnection={(tabId, connectionId) => { activateTab(tabId); selectConnection(connectionId, tabId); }}
    onSelectDatabase={(tabId, nextDatabase) => { activateTab(tabId); selectDatabase(nextDatabase, tabId); }}
    onInsertSql={value => insertSql(value, activeTabId)}
    onContextChange={contextChanged}
    onObjectSelect={selectObject}
    onOpenDesigner={openObjectDesigner}
    onOpenQuery={openSchemaQuery}
    onImport={node => setImportTarget(node)}
    onInsertColumn={selectColumn}
    onEditRow={openEditRow}
    onOpenConnectionForm={() => { setEditingConnection(null); setShowConnectionForm(true); }}
    onEditConnection={connection => { setEditingConnection(connection); setShowConnectionForm(false); }}
    onDeleteConnection={connection => { void deleteConnection(connection); }}
    onHistoryRefresh={() => { void api.history().then(setHistory).catch(() => undefined); }}
    history={history}
    onHistoryOpen={openHistoryEntry}
    onOpenAudit={openAudit}
    onOpenAdmin={() => setShowAdmin(true)}
    onOpenSettings={() => setShowSettings(true)}
    onLogout={() => { void handleLogout(); }}
    transientUi={transientUi}
    recoveryReason={reason}
    onRetryDockyard={() => window.location.reload()}
  />;

  return <DockyardWorkspace
    user={user}
    storage={storage}
    tabs={tabs}
    activeTabId={activeTabId}
    connections={connections}
    selected={selected}
    database={database}
    schema={schema}
    columns={columns}
    inspectedObject={inspectedObject}
    databases={databases}
    preferences={preferences}
    error={error}
    lastQueryTime={lastQueryTime}
    overwrite={overwrite}
    editorSplit={editorSplit}
    onEditorReady={handleEditorReady}
    onEditorDispose={handleEditorDispose}
    onOverwriteChange={handleOverwriteChange}
    onActivateTab={activateTab}
    onCloseTab={closeTab}
    onAddTab={addTab}
    onUpdateSql={(tabId, nextSql) => updateSql(nextSql, tabId)}
    onRun={(tabId, mode) => handleRun(mode, tabId)}
    onSave={handleSave}
    onComment={handleComment}
    onFormat={handleFormat}
    onCancel={handleCancel}
    onSelectStatement={(tabId, statementIndex) => setTabs(previous => previous.map(tab => tab.id === tabId ? { ...tab, activeStatementIndex: statementIndex } : tab))}
    onRetryStatement={(tabId, statementIndex) => retryStatement(statementIndex, tabId)}
    onSelectConnection={(tabId, connectionId) => { activateTab(tabId); selectConnection(connectionId, tabId); }}
    onSelectDatabase={(tabId, nextDatabase) => { activateTab(tabId); selectDatabase(nextDatabase, tabId); }}
    onInsertSql={value => insertSql(value, activeTabId)}
    onContextChange={contextChanged}
    onObjectSelect={selectObject}
    onOpenDesigner={openObjectDesigner}
    onOpenQuery={openSchemaQuery}
    onImport={node => setImportTarget(node)}
    onInsertColumn={selectColumn}
    onEditRow={openEditRow}
    onOpenConnectionForm={() => { setEditingConnection(null); setShowConnectionForm(true); }}
    onEditConnection={connection => { setEditingConnection(connection); setShowConnectionForm(false); }}
    onDeleteConnection={connection => { void deleteConnection(connection); }}
    onHistoryRefresh={() => { void api.history().then(setHistory).catch(() => undefined); }}
    history={history}
    onHistoryOpen={openHistoryEntry}
    onOpenAudit={openAudit}
    onOpenAdmin={() => setShowAdmin(true)}
    onOpenSettings={() => setShowSettings(true)}
    onLogout={() => { void handleLogout(); }}
    transientUi={transientUi}
    recoveryContent={recoveryContent}
    onDockyardResetRegistration={registerDockyardReset}
  />;
}
