import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import Editor from '@monaco-editor/react';
import type { ConnectionProfileSummary, ConnectionProfileUpdate, EditorPreferences, MetadataColumn, MetadataDatabase, QueryEvent, SchemaTreeNode, WebUser } from '@justybase/contracts';
import { api, connectToQueryEvents } from './api';
import { applyQueryEvent, emptyResult, type ResultState } from './queryState';
import { registerSqlLanguageFeatures } from './sqlLanguage';
import { SchemaTree } from './SchemaTree';
import { ResultGrid } from './ResultGrid';
import { InspectorPanel } from './InspectorPanel';
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

const NETEZZA_FORMAT_KEYWORDS = new Set('SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER ON GROUP BY ORDER BY HAVING LIMIT OFFSET UNION ALL EXCEPT INTERSECT WITH AS DISTINCT CASE WHEN THEN ELSE END AND OR NOT NULL IS NULL IS NOT NULL IN EXISTS LIKE BETWEEN ASC DESC INSERT INTO UPDATE DELETE FROM MERGE CREATE TABLE ALTER TABLE DROP TABLE CALL EXPLAIN'.split(' '));

function applyKeywordCase(sql: string, keywordCase: EditorPreferences['keywordCase']): string {
  if (keywordCase === 'preserve') return sql;
  return sql.split(/('(?:''|[^'])*'|"(?:""|[^"])*")/g).map((part, index) => index % 2 === 1 ? part : part.replace(/\b[A-Za-z_][A-Za-z0-9_$]*\b/g, token => NETEZZA_FORMAT_KEYWORDS.has(token.toUpperCase()) ? (keywordCase === 'upper' ? token.toUpperCase() : token.toLowerCase()) : token)).join('');
}

function Workspace({ user, onLogout }: { user: WebUser; onLogout(): void }): ReactElement {
  interface EditorTab { id: string; title: string; sql: string; dirty: boolean; }
  const [connections, setConnections] = useState<ConnectionProfileSummary[]>([]);
  const [selected, setSelected] = useState<ConnectionProfileSummary | null>(null);
  const [editingConnection, setEditingConnection] = useState<ConnectionProfileSummary | null>(null);
  const [tabs, setTabs] = useState<EditorTab[]>([{ id: 'query-1', title: 'Query 1', sql: 'SELECT *\nFROM ', dirty: false }]);
  const [activeTabId, setActiveTabId] = useState('query-1');
  const [result, setResult] = useState<ResultState>(emptyResult);
  const [activeQueryId, setActiveQueryId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [database, setDatabase] = useState('');
  const [schema, setSchema] = useState('');
  const [columns, setColumns] = useState<MetadataColumn[]>([]);
  const [inspectedObject, setInspectedObject] = useState<SchemaTreeNode | null>(null);
  const [databases, setDatabases] = useState<MetadataDatabase[]>([]);

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
  const [preferences, setPreferences] = useState<EditorPreferences | null>(null);
  const selectedRef = useRef<ConnectionProfileSummary | null>(null);
  const databaseRef = useRef('');
  const schemaRef = useRef('');
  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? tabs[0];
  const sql = activeTab?.sql ?? '';

  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { setDatabase(''); setSchema(''); setColumns([]); setInspectedObject(null); }, [selected?.id]);
  useEffect(() => { databaseRef.current = database; }, [database]);
  useEffect(() => { schemaRef.current = schema; }, [schema]);
  useEffect(() => {
    void api.connections().then(items => {
      setConnections(items);
      // Restore last connection from localStorage
      let conn: ConnectionProfileSummary | undefined;
      try {
        const savedId = localStorage.getItem('jwb_connection');
        if (savedId) conn = items.find(c => c.id === savedId);
      } catch { /* ignore */ }
      setSelected(conn ?? items[0] ?? null);
    }).catch(reason => setError(reason instanceof Error ? reason.message : 'Could not load connections.'));
    void api.editorPreferences().then(setPreferences).catch(reason => setError(reason instanceof Error ? reason.message : 'Could not load editor preferences.'));
    void api.history().then(setHistory).catch(() => undefined);
    // Restore saved draft from localStorage
    try {
      const draft = localStorage.getItem('justybase_current_draft');
      if (draft) {
        setTabs(prev => prev.map(t => t.id === 'query-1' ? { ...t, sql: draft } : t));
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { if (!selected) return; void api.databases(selected.id).then(setDatabases).catch(() => undefined); }, [selected?.id]);

  // Persist panel sizes
  useEffect(() => { try { localStorage.setItem('jwb_sidebar', String(sidebar.size)); } catch { /* ignore */ } }, [sidebar.size]);
  useEffect(() => { try { localStorage.setItem('jwb_editor_pct', String(editorSplit.size)); } catch { /* ignore */ } }, [editorSplit.size]);

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

  // Keyboard shortcuts
  useEffect(() => {
    function handler(e: KeyboardEvent) {
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
        // Ctrl+/ is handled natively by Monaco editor
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTabId]);

  function saveConnection(connection: ConnectionProfileSummary): void {
    setConnections(previous => previous.some(item => item.id === connection.id) ? previous.map(item => item.id === connection.id ? connection : item) : [...previous, connection]);
    setSelected(connection); setDatabase(''); setSchema(''); setColumns([]); setEditingConnection(null); setShowConnectionForm(false);
  }

  async function deleteConnection(connection: ConnectionProfileSummary): Promise<void> {
    if (!window.confirm(`Delete connection “${connection.name}”?`)) return;
    try { await api.deleteConnection(connection.id); setConnections(previous => previous.filter(item => item.id !== connection.id)); if (selected?.id === connection.id) setSelected(null); } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : 'Could not delete connection.'); }
  }

  async function runQuery(): Promise<void> {
    if (!selected) { setError('Select a connection first.'); return; }
    setBusy(true); setError(''); setActiveQueryId(''); setResult({ ...emptyResult, status: 'running' });
    try {
      const started = await api.startQuery({ connectionId: selected.id, sql });
      setActiveQueryId(started.queryId);
      const socket = connectToQueryEvents(started.queryId, (event: QueryEvent) => {
        setResult(previous => applyQueryEvent(previous, event));
        if (event.type === 'complete' || event.type === 'error' || event.type === 'cancelled') { setBusy(false); socket.close(); }
      }, () => { setBusy(false); setResult(previous => ({ ...previous, status: 'error', message: 'Could not connect to the query result stream.' })); });
    } catch (reason: unknown) { setBusy(false); setResult({ ...emptyResult, status: 'error', message: reason instanceof Error ? reason.message : 'Query failed.' }); }
  }

  /** Run query, then export results. */
  async function runAndExport(format: 'csv' | 'xlsx' | 'xlsb'): Promise<void> {
    if (!selected) { setError('Select a connection first.'); return; }
    setBusy(true); setError('');
    try {
      // Step 1: start query
      const started = await api.startQuery({ connectionId: selected.id, sql });
      setActiveQueryId(started.queryId);

      // Step 2: wait for completion via WebSocket
      await new Promise<void>((resolve, reject) => {
        const socket = connectToQueryEvents(started.queryId, (event: QueryEvent) => {
          setResult(previous => applyQueryEvent(previous, event));
          if (event.type === 'complete') {
            socket.close();
            resolve();
          } else if (event.type === 'error' || event.type === 'cancelled') {
            socket.close();
            reject(new Error(event.type === 'error' ? event.message : 'Query cancelled.'));
          }
        }, () => {
          reject(new Error('Could not connect to query result stream.'));
        });
      });

      // Step 3: export
      const { blob, fileName } = await api.exportQuery(started.queryId, {
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
    } finally {
      setBusy(false);
    }
  }

  function handleRun(mode: RunMode): void {
    if (mode === 'export-csv') { void runAndExport('csv'); }
    else if (mode === 'export-xlsx') { void runAndExport('xlsx'); }
    else if (mode === 'export-xlsb') { void runAndExport('xlsb'); }
    else { void runQuery(); }
  }

  function handleSave(): void {
    const active = tabs.find(t => t.id === activeTabId);
    if (!active) return;
    // Save current SQL to localStorage as 'current_draft'
    try {
      localStorage.setItem('justybase_current_draft', active.sql);
    } catch { /* ignore */ }
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, dirty: false } : t));
  }

  const editorRef = useRef<{ getAction(id: string): { run(): void } | null } | null>(null);

  function handleFormat(): void {
    updateSql(applyKeywordCase(sql, preferences?.keywordCase ?? 'upper'));
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

  function updateSql(nextSql: string): void { setTabs(previous => previous.map(tab => tab.id === activeTabId ? { ...tab, sql: nextSql, dirty: true } : tab)); }
  function insertSql(value: string): void { updateSql(`${sql}${value}`); }
  function addTab(): void { const id = `query-${Date.now()}`; setTabs(previous => [...previous, { id, title: `Query ${previous.length + 1}`, sql: 'SELECT *\nFROM ', dirty: false }]); setActiveTabId(id); }
  function closeTab(id: string): void { if (tabs.length === 1) return; const index = tabs.findIndex(tab => tab.id === id); const next = tabs.filter(tab => tab.id !== id); setTabs(next); if (id === activeTabId) setActiveTabId(next[Math.max(0, index - 1)]?.id ?? next[0]!.id); }
  function contextChanged(nextDatabase?: string, nextSchema?: string): void { setDatabase(nextDatabase ?? ''); setSchema(nextSchema ?? ''); }
  function selectObject(node: SchemaTreeNode): void {
    if (!selected || node.kind !== 'object' || !node.objectName || !node.database || !node.schema) return;
    setDatabase(node.database);
    setSchema(node.schema);
    setInspectedObject(node);
    void api.columns(selected.id, node.database, node.schema, node.objectName).then(setColumns).catch(reason =>
      setError(reason instanceof Error ? reason.message : 'Could not load columns.')
    );
  }
  function selectColumn(column: MetadataColumn): void { insertSql(column.name); }

  function resetLayout(): void {
    sidebar.setSize(250);
    editorSplit.setSize(45);
    try { localStorage.removeItem('jwb_sidebar'); localStorage.removeItem('jwb_editor_pct'); } catch { /* ignore */ }
  }

  function selectConnection(id: string): void {
    const conn = connections.find(c => c.id === id);
    if (conn) { setSelected(conn); setResult(emptyResult); setColumns([]); }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">JustyBase</div>
        <div className="workspace-title">Netezza SQL Workspace</div>
        <div className="topbar-user">
          <button className="secondary small" onClick={() => { setShowHistory(true); void api.history().then(setHistory); }}>History</button>
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
            {(showConnectionForm || editingConnection) && (
              <ConnectionForm initial={editingConnection ?? undefined} onCreated={saveConnection} onCancel={() => { setEditingConnection(null); setShowConnectionForm(false); }} />
            )}
            {connections.map(connection => (
              <div className="connection-row-wrap" key={connection.id}>
                <button className={`tree-row connection-row ${selected?.id === connection.id ? 'active' : ''}`}
                  onClick={() => { setSelected(connection); setResult(emptyResult); setColumns([]); }}
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
              onInsert={insertSql}
              onContextChange={contextChanged}
              onObjectSelect={selectObject}
            />
          ) : (
            <div className="empty-results">Add a connection to browse its schema.</div>
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
            onCancel={() => activeQueryId ? void api.cancelQuery(activeQueryId) : undefined}
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
                  registerSqlLanguageFeatures(editor, monaco, () => ({
                    connectionId: selectedRef.current?.id,
                    database: databaseRef.current,
                    schema: schemaRef.current,
                  }));
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
                <span>{result.status}{result.totalRows >= 0 ? ` · ${result.totalRows.toLocaleString()} rows` : ''}</span>
              </div>
              {result.message && <div className="error result-message">{result.message}</div>}
              {result.columns.length > 0 && activeQueryId ? (
                <ResultGrid queryId={activeQueryId} result={result} />
              ) : (
                <div className="empty-results">
                  {result.status === 'idle' ? 'Run a query to see results.' :
                   result.status === 'running' ? 'Preparing result session…' :
                   'The query returned no tabular rows.'}
                </div>
              )}
            </section>
          </div>
        </main>

        {/* ── Right panel (inspector) ── */}
        <aside className="inspector">
          <InspectorPanel
            database={database}
            schema={schema}
            columns={columns}
            selectedObject={inspectedObject}
            onInsertColumn={selectColumn}
            connectionName={selected?.name}
          />
        </aside>
      </div>

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
            setTabs(previous => [...previous, { id, title: 'History query', sql: entry.sql, dirty: false }]);
            setActiveTabId(id);
            setShowHistory(false);
          }}
        />
      )}
    </div>
  );
}

interface ConnectionFormState { name: string; host: string; port: number; database: string; user: string; password: string; dbType: 'netezza'; readOnly: boolean; }

function ConnectionForm({ initial, onCreated, onCancel }: { initial?: ConnectionProfileSummary; onCreated(connection: ConnectionProfileSummary): void; onCancel(): void }): ReactElement {
  const [form, setForm] = useState<ConnectionFormState>(() => ({ name: initial?.name ?? '', host: initial?.host ?? '', port: initial?.port ?? 5480, database: initial?.database ?? 'system', user: initial?.user ?? '', password: '', dbType: 'netezza', readOnly: initial?.readOnly ?? true }));
  const [error, setError] = useState('');
  async function submit(event: FormEvent): Promise<void> { event.preventDefault(); setError(''); try { if (initial) { const input: ConnectionProfileUpdate = { ...form, password: form.password || undefined }; onCreated(await api.updateConnection(initial.id, input)); } else { onCreated(await api.createConnection(form)); } } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : 'Could not save connection.'); } }
  const update = (key: keyof ConnectionFormState, value: string | number | boolean): void => setForm(previous => ({ ...previous, [key]: value }));
  return <form className="connection-form" onSubmit={event => void submit(event)}><input placeholder="Profile name" value={form.name} onChange={event => update('name', event.target.value)} /><input placeholder="Host" value={form.host} onChange={event => update('host', event.target.value)} /><input type="number" placeholder="Port" value={form.port} onChange={event => update('port', Number(event.target.value))} /><input placeholder="Database" value={form.database} onChange={event => update('database', event.target.value)} /><input placeholder="User" value={form.user} onChange={event => update('user', event.target.value)} /><input type="password" placeholder={initial ? 'New password (optional)' : 'Password'} value={form.password} onChange={event => update('password', event.target.value)} /><label className="checkbox"><input type="checkbox" checked={form.readOnly} onChange={event => update('readOnly', event.target.checked)} /> Read-only</label>{error && <div className="error">{error}</div>}<div className="form-actions"><button>{initial ? 'Save changes' : 'Add connection'}</button><button type="button" className="secondary" onClick={onCancel}>Cancel</button></div></form>;
}

function EditorSettings({ value, onSave, onClose, onResetLayout }: { value: EditorPreferences; onSave(value: EditorPreferences): void; onClose(): void; onResetLayout?(): void }): ReactElement {
  const [form, setForm] = useState(value);
  const update = <K extends keyof EditorPreferences>(key: K, next: EditorPreferences[K]): void => setForm(previous => ({ ...previous, [key]: next }));
  async function save(): Promise<void> { onSave(await api.updateEditorPreferences(form)); }
  return <div className="modal-backdrop"><section className="modal-card"><div className="section-title">Editor settings <button className="icon-button" onClick={onClose}>×</button></div><div className="settings-grid"><label>Font size<input type="number" min="10" max="32" value={form.fontSize} onChange={event => update('fontSize', Number(event.target.value))} /></label><label>Tab size<input type="number" min="1" max="16" value={form.tabSize} onChange={event => update('tabSize', Number(event.target.value))} /></label><label>Word wrap<select value={form.wordWrap} onChange={event => update('wordWrap', event.target.value as EditorPreferences['wordWrap'])}><option value="off">Off</option><option value="on">On</option><option value="bounded">Bounded</option></select></label><label>Keyword case<select value={form.keywordCase} onChange={event => update('keywordCase', event.target.value as EditorPreferences['keywordCase'])}><option value="upper">Uppercase</option><option value="lower">Lowercase</option><option value="preserve">Preserve</option></select></label><label className="checkbox"><input type="checkbox" checked={form.insertSpaces} onChange={event => update('insertSpaces', event.target.checked)} /> Insert spaces</label><label className="checkbox"><input type="checkbox" checked={form.minimap} onChange={event => update('minimap', event.target.checked)} /> Minimap</label><label className="checkbox"><input type="checkbox" checked={form.lineNumbers} onChange={event => update('lineNumbers', event.target.checked)} /> Line numbers</label><label className="checkbox"><input type="checkbox" checked={form.linterEnabled} onChange={event => update('linterEnabled', event.target.checked)} /> SQL linter</label><label className="checkbox"><input type="checkbox" checked={form.formatOnType} onChange={event => update('formatOnType', event.target.checked)} /> Format on type</label><label className="checkbox"><input type="checkbox" checked={form.formatOnSave} onChange={event => update('formatOnSave', event.target.checked)} /> Format on save</label>            <label className="checkbox"><input type="checkbox" checked={form.inlineTypeHints} onChange={event => update('inlineTypeHints', event.target.checked)} /> Inline type hints</label></div><div className="settings-actions"><div className="form-actions"><button onClick={() => void save()}>Save settings</button><button className="secondary" onClick={onClose}>Cancel</button></div><button className="secondary small settings-reset-layout" onClick={() => { onResetLayout?.(); onClose(); }}>Reset layout</button></div></section></div>;
}

function HistoryPanel({ entries, onClose, onOpen }: { entries: Awaited<ReturnType<typeof api.history>>; onClose(): void; onOpen(entry: Awaited<ReturnType<typeof api.history>>[number]): void }): ReactElement {
  return <div className="modal-backdrop"><section className="modal-card history-card"><div className="section-title">Query history <button className="icon-button" onClick={onClose}>×</button></div>{entries.length === 0 ? <p className="muted">No queries yet.</p> : <div className="history-list">{entries.map(entry => <button className="history-entry" key={entry.id} onClick={() => onOpen(entry)}><span><strong>{entry.status}</strong> · {new Date(entry.createdAt).toLocaleString()} · {entry.rowCount.toLocaleString()} rows</span><code>{entry.sql}</code></button>)}</div>}</section></div>;
}
