import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Editor from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import type {
  ConnectionProfileSummary,
  DatabaseKind,
  EditorPreferences,
  HistoryEntry,
  MetadataColumn,
  MetadataDatabase,
  SchemaTreeNode,
  WebUser,
} from '@justybase/contracts';
import { SqlProblemsPanel, sqlProblemsFromMarkers } from '@justybase/ui-react';
import type { SqlProblem } from '@justybase/ui-react';
import { EditorToolbar } from '../EditorToolbar';
import { ExplainPanel } from '../ExplainPanel';
import { InspectorPanel } from '../InspectorPanel';
import { ResultGrid } from '../ResultGrid';
import { SchemaTree } from '../SchemaTree';
import { StatusBar } from '../workspacePanels';
import { emptyResult } from '../queryState';
import type { EditorTab } from '../workspaceDocumentController';
import { canEditActiveResult } from '../workspaceConnectionController';
import type { WorkspaceStorage } from '../workspacePersistence';
import { statementStateFor, statementStatusClass, statementStatusLabel } from '../workspaceExecutionController';
import {
  DOCKYARD_CONTENT_IDS,
  DockyardManagerAdapter,
  explainToolId,
  queryDocumentId,
  type DockyardContentDefinition,
} from './dockyardManagerAdapter';
import '../../../../vendor/dockyard/src/avalondock.css';

export interface DockyardEditorSplit {
  size: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onMouseDown(event: React.MouseEvent): void;
}

export interface DockyardWorkspaceProps {
  user: WebUser;
  storage: WorkspaceStorage;
  tabs: readonly EditorTab[];
  activeTabId: string;
  connections: ConnectionProfileSummary[];
  selected: ConnectionProfileSummary | null;
  database: string;
  schema: string;
  columns: MetadataColumn[];
  inspectedObject: SchemaTreeNode | null;
  databases: MetadataDatabase[];
  preferences: EditorPreferences | null;
  error: string;
  lastQueryTime: number | null;
  overwrite: boolean;
  problemsByTab: Readonly<Record<string, readonly SqlProblem[]>>;
  editorSplit: DockyardEditorSplit;
  onEditorReady(tabId: string, editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco): void;
  onEditorDispose(tabId: string): void;
  onProblemsChange(tabId: string, problems: readonly SqlProblem[]): void;
  onSelectProblem(tabId: string, problem: SqlProblem): void;
  onOverwriteChange(tabId: string, overwrite: boolean): void;
  onActivateTab(tabId: string): void;
  onCloseTab(tabId: string): boolean;
  onAddTab(): void;
  onUpdateSql(tabId: string, sql: string): void;
  onRun(tabId: string, mode: Parameters<React.ComponentProps<typeof EditorToolbar>['onRun']>[0]): void;
  onSave(tabId: string): void | Promise<void>;
  onComment(tabId: string): void;
  onFormat(tabId: string): void;
  onCancel(tabId: string): void;
  onSelectStatement(tabId: string, statementIndex: number): void;
  onRetryStatement(tabId: string, statementIndex: number): void;
  onSelectConnection(tabId: string, connectionId: string): void;
  onSelectDatabase(tabId: string, database: string): void;
  onSelectDialect(tabId: string, databaseKind: DatabaseKind): void;
  onInsertSql(value: string): void;
  onContextChange(database?: string, schema?: string): void;
  onObjectSelect(node: SchemaTreeNode): void;
  onOpenDesigner(node: SchemaTreeNode): void;
  onOpenQuery(sql: string, title: string, node: SchemaTreeNode): void;
  onImport(node: SchemaTreeNode): void;
  onInsertColumn(column: MetadataColumn): void;
  onEditRow(tabId: string, values: unknown[]): void;
  onOpenConnectionForm(): void;
  onEditConnection(connection: ConnectionProfileSummary): void;
  onDeleteConnection(connection: ConnectionProfileSummary): void;
  onHistoryRefresh(): void;
  history: HistoryEntry[];
  onHistoryOpen(entry: HistoryEntry): void;
  onOpenAudit(): void;
  onOpenAdmin(): void;
  onOpenSettings(): void;
  onLogout(): void;
  transientUi: ReactNode;
  /** Temporary legacy recovery UI shown when Dockyard cannot initialize. */
  recoveryContent?(reason: string): ReactNode;
  onDockyardResetRegistration?(reset: (() => void) | undefined): void;
}

interface QueryDocumentProps {
  tab: EditorTab;
  active: boolean;
  error: string;
  connections: ConnectionProfileSummary[];
  selected: ConnectionProfileSummary | null;
  databases: MetadataDatabase[];
  preferences: EditorPreferences | null;
  editorSplit: DockyardEditorSplit;
  onEditorReady(tabId: string, editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco): void;
  onEditorDispose(tabId: string): void;
  problems: readonly SqlProblem[];
  onProblemsChange(tabId: string, problems: readonly SqlProblem[]): void;
  onSelectProblem(tabId: string, problem: SqlProblem): void;
  onOverwriteChange(tabId: string, overwrite: boolean): void;
  onActivateTab(tabId: string): void;
  onUpdateSql(tabId: string, sql: string): void;
  onRun(tabId: string, mode: Parameters<React.ComponentProps<typeof EditorToolbar>['onRun']>[0]): void;
  onSave(tabId: string): void | Promise<void>;
  onComment(tabId: string): void;
  onFormat(tabId: string): void;
  onCancel(tabId: string): void;
  onSelectStatement(tabId: string, statementIndex: number): void;
  onRetryStatement(tabId: string, statementIndex: number): void;
  onSelectConnection(tabId: string, connectionId: string): void;
  onSelectDatabase(tabId: string, database: string): void;
  onSelectDialect(tabId: string, databaseKind: DatabaseKind): void;
  onOpenConnectionForm(): void;
  onEditRow(tabId: string, values: unknown[]): void;
}

export function QueryDocument({
  tab,
  active,
  error,
  connections,
  selected,
  databases,
  preferences,
  editorSplit,
  onEditorReady,
  onEditorDispose,
  problems,
  onProblemsChange,
  onSelectProblem,
  onOverwriteChange,
  onActivateTab,
  onUpdateSql,
  onRun,
  onSave,
  onComment,
  onFormat,
  onCancel,
  onSelectStatement,
  onRetryStatement,
  onSelectConnection,
  onSelectDatabase,
  onSelectDialect,
  onOpenConnectionForm,
  onEditRow,
}: QueryDocumentProps): ReactElement {
  const result = tab.results[tab.activeStatementIndex] ?? emptyResult;
  const activeQueryId = tab.queryId ?? '';
  const busy = tab.running === true;
  const targetConnection = tab.connectionId ? connections.find(connection => connection.id === tab.connectionId) : selected;
  const targetDatabase = tab.database ?? (targetConnection ? targetConnection.database : '');
  const statementIndexes = Array.from(new Set([...Object.keys(tab.results), ...Object.keys(tab.statementStates)]).values(), Number).sort((a, b) => a - b);
  const batchStatementCount = tab.batchStatementCount ?? statementIndexes.length;
  const isBatchResult = batchStatementCount > 1 || statementIndexes.length > 1;
  const batchStates = statementIndexes.map(index => statementStateFor(tab, index));
  const batchStatusCounts = batchStates.reduce<Record<string, number>>((counts, state) => {
    counts[state.status] = (counts[state.status] ?? 0) + 1;
    return counts;
  }, {});
  const batchExecutedCount = (batchStatusCounts.success ?? 0) + (batchStatusCounts.error ?? 0) + (batchStatusCounts.cancelled ?? 0);
  const failedStatementIndex = statementIndexes.find(index => statementStateFor(tab, index).status === 'error');

  function mountEditor(editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco): void {
    onEditorReady(tab.id, editor, monaco);
    // Monaco does not expose the current insert/overtype mode through the
    // public EditorOption enum. Keep the small bit of UI state at this
    // boundary and update it on the Insert key, just like the legacy shell.
    let overwrite = false;
    const updateOverwrite = (): void => onOverwriteChange(tab.id, overwrite);
    updateOverwrite();
    const disposable = editor.onKeyDown(event => {
      if (event.keyCode !== monaco.KeyCode.Insert) return;
      overwrite = !overwrite;
      window.setTimeout(updateOverwrite, 0);
    });
    editor.onDidDispose(() => {
      disposable.dispose();
      onEditorDispose(tab.id);
    });
  }

  return <article className="dockyard-query-document" data-query-tab-id={tab.id} onMouseDown={() => onActivateTab(tab.id)}>
    <EditorToolbar
      connectionId={targetConnection?.id ?? ''}
      database={targetDatabase}
      connections={connections}
      databases={databases}
      onSelectConnection={connectionId => onSelectConnection(tab.id, connectionId)}
      onSelectDatabase={database => onSelectDatabase(tab.id, database)}
      databaseKind={tab.databaseKind ?? targetConnection?.dbType ?? 'netezza'}
      onSelectDialect={databaseKind => onSelectDialect(tab.id, databaseKind)}
      onRun={mode => onRun(tab.id, mode)}
      onSave={() => void onSave(tab.id)}
      onComment={() => onComment(tab.id)}
      onFormat={() => onFormat(tab.id)}
      isRunning={busy}
      onCancel={() => onCancel(tab.id)}
    />

    <div className="dockyard-query-split-container" ref={active ? editorSplit.containerRef : undefined}>
      <div className="editor dockyard-query-editor" style={{ height: `${editorSplit.size}%` }}>
        <div className="dockyard-editor-host">
          <Editor
            height="100%"
            language="sql"
            theme="vs-dark"
            value={tab.sql}
            onChange={value => onUpdateSql(tab.id, value ?? '')}
            onMount={mountEditor}
            onValidate={markers => onProblemsChange(tab.id, sqlProblemsFromMarkers(markers))}
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
        <SqlProblemsPanel problems={problems} onSelect={problem => onSelectProblem(tab.id, problem)} />
      </div>
      <div className="split-handle split-handle-v" onMouseDown={editorSplit.onMouseDown} />
      <section className="results dockyard-query-results" style={{ height: `${100 - editorSplit.size}%` }}>
        {active && error && <div className="error-banner">{error}</div>}
        <div className="results-header">
          <strong>Results</strong>
          <div className="result-statement-tabs">
            {statementIndexes.map(index => {
              const state = statementStateFor(tab, index);
              return <button
                key={index}
                className={`secondary small statement-tab ${tab.activeStatementIndex === index ? 'active' : ''}`}
                title={state.sql ?? `Statement ${index + 1}`}
                aria-label={`Statement ${index + 1}: ${statementStatusLabel(state.status)}`}
                onClick={() => { onActivateTab(tab.id); onSelectStatement(tab.id, index); }}
              >
                <span>Statement {index + 1}</span><span className={statementStatusClass(state.status)}>{statementStatusLabel(state.status)}</span>
              </button>;
            })}
          </div>
          <span className={`result-status result-status-${result.status.startsWith('complete') ? 'complete' : result.status}`}>
            {result.status}{result.totalRows >= 0 ? ` · ${result.totalRows.toLocaleString()} rows` : ''}
          </span>
        </div>
        {isBatchResult && <div className={`batch-summary ${tab.batchStatus ? `batch-summary-${tab.batchStatus}` : ''}`} role="status">
          <div className="batch-summary-heading"><strong>{tab.batchStatus === 'complete' ? 'Batch complete' : 'Running batch'}</strong><span>{batchExecutedCount} of {batchStatementCount} statements executed</span></div>
          <div className="batch-summary-counts">
            <span className="batch-count batch-count-success">{batchStatusCounts.success ?? 0} succeeded</span>
            <span className="batch-count batch-count-error">{batchStatusCounts.error ?? 0} failed</span>
            <span className="batch-count batch-count-skipped">{batchStatusCounts.skipped ?? 0} skipped</span>
            {(batchStatusCounts.cancelled ?? 0) > 0 && <span className="batch-count batch-count-cancelled">{batchStatusCounts.cancelled} cancelled</span>}
          </div>
          {tab.batchMessage && <span className="batch-summary-message">{tab.batchMessage}</span>}
          {failedStatementIndex !== undefined && <button type="button" className="secondary small batch-retry" onClick={() => onRetryStatement(tab.id, failedStatementIndex)}>Retry failed statement</button>}
        </div>}
        {result.message && <div className={`${result.status === 'error' ? 'error' : 'result-notice'} result-message`}>{result.message}</div>}
        {tab.resultView === 'explain' && activeQueryId && result.sessionId ? (
          <ExplainPanel queryId={activeQueryId} statementIndex={tab.activeStatementIndex} result={result} />
        ) : result.columns.length > 0 && activeQueryId && result.sessionId ? (
          <ResultGrid queryId={activeQueryId} statementIndex={tab.activeStatementIndex} result={result} onEditRow={canEditActiveResult(tab, result, targetConnection ?? null) ? values => onEditRow(tab.id, values) : undefined} />
        ) : (
          <div className="empty-state" aria-live="polite">
            {!targetConnection ? <><strong>No connection selected</strong><span>Add a connection to browse schema and run SQL.</span><button type="button" onClick={onOpenConnectionForm}>Add connection</button></> : result.status === 'idle' ? <><strong>Ready to run SQL</strong><span>Write a query or choose a table from the schema explorer.</span><small>Run with Ctrl/Cmd+Enter</small></> : result.status === 'running' ? <><span className="empty-state-spinner" aria-hidden="true" /> <strong>Preparing result session…</strong></> : <><strong>No tabular rows</strong><span>The statement completed without returning a result grid.</span></>}
          </div>
        )}
      </section>
    </div>
  </article>;
}

interface ExplorerToolProps {
  connections: ConnectionProfileSummary[];
  selected: ConnectionProfileSummary | null;
  database: string;
  onOpenConnectionForm(): void;
  onSelectConnection(connectionId: string): void;
  onEditConnection(connection: ConnectionProfileSummary): void;
  onDeleteConnection(connection: ConnectionProfileSummary): void;
}

function ExplorerTool({ connections, selected, database, onOpenConnectionForm, onSelectConnection, onEditConnection, onDeleteConnection }: ExplorerToolProps): ReactElement {
  return <div className="dockyard-tool-content sidebar dockyard-connections-tool">
    <div className="sidebar-section">
      <div className="section-title">Connections <button className="icon-button" onClick={onOpenConnectionForm}>+</button></div>
      {connections.map(connection => <div className="connection-row-wrap" key={connection.id}>
        <button className={`tree-row connection-row ${selected?.id === connection.id ? 'active' : ''}`} onClick={() => onSelectConnection(connection.id)}>
          <span className="status-dot" />{connection.name}
        </button>
        <div className="connection-actions">
          <button title="Edit connection" onClick={() => onEditConnection(connection)}>✎</button>
          <button title="Delete connection" onClick={() => onDeleteConnection(connection)}>×</button>
        </div>
      </div>)}
      {connections.length === 0 && <div className="sidebar-empty-state"><strong>No connections</strong><span>Add a connection to browse its schema.</span><button type="button" className="secondary small" onClick={onOpenConnectionForm}>Add connection</button></div>}
    </div>
    {selected && <div className="dockyard-explorer-context muted">{selected.name}{database ? ` · ${database}` : ''}</div>}
  </div>;
}

interface SchemaToolProps {
  selected: ConnectionProfileSummary | null;
  database: string;
  onInsertSql(value: string): void;
  onContextChange(database?: string, schema?: string): void;
  onObjectSelect(node: SchemaTreeNode): void;
  onOpenDesigner(node: SchemaTreeNode): void;
  onOpenQuery(sql: string, title: string, node: SchemaTreeNode): void;
  onImport(node: SchemaTreeNode): void;
}

function SchemaTool({ selected, database, onInsertSql, onContextChange, onObjectSelect, onOpenDesigner, onOpenQuery, onImport }: SchemaToolProps): ReactElement {
  return <div className="dockyard-tool-content sidebar dockyard-schema-tool">
    {selected ? <SchemaTree
      connectionId={selected.id}
      database={database}
      databaseKind={selected.dbType}
      onInsert={onInsertSql}
      onContextChange={onContextChange}
      onObjectSelect={onObjectSelect}
      onOpenDesigner={onOpenDesigner}
      onOpenQuery={onOpenQuery}
      onImport={onImport}
    /> : <div className="sidebar-empty-state"><strong>No connections</strong><span>Add a connection to browse its schema.</span></div>}
  </div>;
}

function HistoryTool({ entries, onRefresh, onOpen }: { entries: HistoryEntry[]; onRefresh(): void; onOpen(entry: HistoryEntry): void }): ReactElement {
  return <div className="dockyard-tool-content dockyard-history-tool history-card">
    <div className="dockyard-tool-heading section-title"><span>Query history</span><button type="button" className="secondary small" onClick={onRefresh}>Refresh</button></div>
    {entries.length === 0 ? <p className="muted">No queries yet.</p> : <div className="history-list">{entries.map(entry => <button className="history-entry" key={entry.id} onClick={() => onOpen(entry)}><span><strong>{entry.status}</strong> · {new Date(entry.createdAt).toLocaleString()} · {entry.rowCount.toLocaleString()} rows</span><code>{entry.sql}</code></button>)}</div>}
  </div>;
}

function ExplainTool({ tab }: { tab: EditorTab | undefined }): ReactElement {
  const result = tab?.results[tab.activeStatementIndex] ?? emptyResult;
  if (!tab?.queryId || !result.sessionId) return <div className="dockyard-tool-content dockyard-explain-tool"><strong>Explain</strong><p className="muted">Run Explain for this query to inspect its plan.</p></div>;
  return <div className="dockyard-tool-content dockyard-explain-tool"><ExplainPanel queryId={tab.queryId} statementIndex={tab.activeStatementIndex} result={result} /></div>;
}

function EmptyTool({ title, message }: { title: string; message: string }): ReactElement {
  return <div className="dockyard-tool-content dockyard-empty-tool"><strong>{title}</strong><p className="muted">{message}</p></div>;
}

export function DockyardWorkspace({
  user,
  storage,
  tabs,
  activeTabId,
  connections,
  selected,
  database,
  schema,
  columns,
  inspectedObject,
  databases,
  preferences,
  error,
  lastQueryTime,
  overwrite,
  problemsByTab,
  editorSplit,
  onEditorReady,
  onEditorDispose,
  onProblemsChange,
  onSelectProblem,
  onOverwriteChange,
  onActivateTab,
  onCloseTab,
  onAddTab,
  onUpdateSql,
  onRun,
  onSave,
  onComment,
  onFormat,
  onCancel,
  onSelectStatement,
  onRetryStatement,
  onSelectConnection,
  onSelectDatabase,
  onSelectDialect,
  onInsertSql,
  onContextChange,
  onObjectSelect,
  onOpenDesigner,
  onOpenQuery,
  onImport,
  onInsertColumn,
  onEditRow,
  onOpenConnectionForm,
  onEditConnection,
  onDeleteConnection,
  onHistoryRefresh,
  history,
  onHistoryOpen,
  onOpenAudit,
  onOpenAdmin,
  onOpenSettings,
  onLogout,
  transientUi,
  recoveryContent,
  onDockyardResetRegistration,
}: DockyardWorkspaceProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const contentHostsRef = useRef(new Map<string, HTMLElement>());
  const adapterRef = useRef<DockyardManagerAdapter | null>(null);
  const [adapter, setAdapter] = useState<DockyardManagerAdapter | null>(null);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const callbackRef = useRef({
    onActivateTab,
    onCloseTab,
    onError: (reason: Error) => setInitializationError(reason.message),
  });
  callbackRef.current = { onActivateTab, onCloseTab, onError: reason => setInitializationError(reason.message) };

  const hostFor = useCallback((contentId: string): HTMLElement => {
    const existing = contentHostsRef.current.get(contentId);
    if (existing) return existing;
    const host = (hostRef.current?.ownerDocument ?? document).createElement('div');
    host.className = 'dockyard-react-content-host';
    contentHostsRef.current.set(contentId, host);
    return host;
  }, []);

  const definitions = useMemo<DockyardContentDefinition[]>(() => {
    const result: DockyardContentDefinition[] = [
      { id: DOCKYARD_CONTENT_IDS.connections, title: 'Connections', kind: 'tool', content: hostFor(DOCKYARD_CONTENT_IDS.connections) },
      { id: DOCKYARD_CONTENT_IDS.schema, title: 'Schema', kind: 'tool', content: hostFor(DOCKYARD_CONTENT_IDS.schema) },
      { id: DOCKYARD_CONTENT_IDS.inspector, title: 'Inspector', kind: 'tool', content: hostFor(DOCKYARD_CONTENT_IDS.inspector) },
      { id: DOCKYARD_CONTENT_IDS.history, title: 'History', kind: 'tool', content: hostFor(DOCKYARD_CONTENT_IDS.history) },
    ];
    for (const tab of tabs) {
      result.push({ id: queryDocumentId(tab.id), title: tab.title, kind: 'document', modified: tab.dirty, content: hostFor(queryDocumentId(tab.id)) });
      result.push({ id: explainToolId(tab.id), title: `Explain · ${tab.title}`, kind: 'tool', content: hostFor(explainToolId(tab.id)) });
    }
    return result;
  }, [hostFor, tabs]);
  const definitionsRef = useRef(definitions);
  definitionsRef.current = definitions;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || adapterRef.current) return undefined;
    try {
      const persistedExplorerWidth = Number(storage.get('sidebar'));
      const next = new DockyardManagerAdapter({
        host,
        storage,
        definitions: definitionsRef.current,
        explorerWidth: Number.isFinite(persistedExplorerWidth) ? persistedExplorerWidth : 250,
        onActiveContentChanged: contentId => {
          const tabId = contentId?.startsWith('query:') ? contentId.slice('query:'.length) : undefined;
          if (tabId) callbackRef.current.onActivateTab(tabId);
        },
        onDocumentClosing: tabId => callbackRef.current.onCloseTab(tabId),
        onError: reason => callbackRef.current.onError(reason),
      });
      adapterRef.current = next;
      setAdapter(next);
      setInitializationError(null);
    } catch (reason: unknown) {
      const message = reason instanceof Error ? reason.message : 'Dockyard initialization failed.';
      setInitializationError(message);
    }
    return undefined;
  }, [storage]);

  useEffect(() => {
    if (!adapter) return undefined;
    adapter.setCallbacks({
      onActiveContentChanged: contentId => {
        const tabId = contentId?.startsWith('query:') ? contentId.slice('query:'.length) : undefined;
        if (tabId) onActivateTab(tabId);
      },
      onDocumentClosing: onCloseTab,
      onError: reason => setInitializationError(reason.message),
    });
    return undefined;
  }, [adapter, onActivateTab, onCloseTab]);

  useEffect(() => {
    if (!adapter) return;
    adapter.syncDefinitions(definitions, queryDocumentId(activeTabId));
  }, [adapter, definitions, activeTabId]);

  useEffect(() => {
    if (!adapter) return undefined;
    onDockyardResetRegistration?.(() => adapter.resetLayout());
    return () => onDockyardResetRegistration?.(undefined);
  }, [adapter, onDockyardResetRegistration]);

  useEffect(() => () => {
    onDockyardResetRegistration?.(undefined);
    adapterRef.current?.dispose();
    adapterRef.current = null;
    contentHostsRef.current.clear();
  }, [onDockyardResetRegistration]);

  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? tabs[0];

  function activateTool(id: string): void {
    adapter?.activate(id);
  }

  function renderDefinition(definition: DockyardContentDefinition): ReactElement {
    if (definition.kind === 'document') {
      const tabId = definition.id.slice('query:'.length);
      const tab = tabs.find(item => item.id === tabId);
      if (!tab) return <EmptyTool title="Query" message="This query is no longer available." />;
      return <QueryDocument
        tab={tab}
        active={tab.id === activeTabId}
        error={error}
        connections={connections}
        selected={selected}
        databases={databases}
        preferences={preferences}
        editorSplit={editorSplit}
        onEditorReady={onEditorReady}
        onEditorDispose={onEditorDispose}
        problems={problemsByTab[tab.id] ?? []}
        onProblemsChange={onProblemsChange}
        onSelectProblem={onSelectProblem}
        onOverwriteChange={onOverwriteChange}
        onActivateTab={onActivateTab}
        onUpdateSql={onUpdateSql}
        onRun={onRun}
        onSave={onSave}
        onComment={onComment}
        onFormat={onFormat}
        onCancel={onCancel}
        onSelectStatement={onSelectStatement}
        onRetryStatement={onRetryStatement}
        onSelectConnection={onSelectConnection}
        onSelectDatabase={onSelectDatabase}
        onSelectDialect={onSelectDialect}
        onOpenConnectionForm={onOpenConnectionForm}
        onEditRow={onEditRow}
      />;
    }
    if (definition.id === DOCKYARD_CONTENT_IDS.connections) return <ExplorerTool connections={connections} selected={selected} database={database} onOpenConnectionForm={onOpenConnectionForm} onSelectConnection={connectionId => onSelectConnection(activeTabId, connectionId)} onEditConnection={onEditConnection} onDeleteConnection={onDeleteConnection} />;
    if (definition.id === DOCKYARD_CONTENT_IDS.schema) return <SchemaTool selected={selected} database={database} onInsertSql={onInsertSql} onContextChange={onContextChange} onObjectSelect={onObjectSelect} onOpenDesigner={onOpenDesigner} onOpenQuery={onOpenQuery} onImport={onImport} />;
    if (definition.id === DOCKYARD_CONTENT_IDS.inspector) return <div className="dockyard-tool-content inspector dockyard-inspector-tool"><InspectorPanel database={database} schema={schema} columns={columns} selectedObject={inspectedObject} onInsertColumn={onInsertColumn} connectionName={selected?.name} /></div>;
    if (definition.id === DOCKYARD_CONTENT_IDS.history) return <HistoryTool entries={history} onRefresh={onHistoryRefresh} onOpen={onHistoryOpen} />;
    if (definition.id.startsWith('explain:')) return <ExplainTool tab={tabs.find(tab => tab.id === definition.id.slice('explain:'.length))} />;
    return <EmptyTool title={definition.title} message="This Dockyard tool is unavailable." />;
  }

  return <div className="app-shell dockyard-shell">
    <header className="topbar">
      <div className="brand">JustyBase</div>
      <div className="workspace-title">Netezza SQL Workspace</div>
      <nav className="dockyard-tool-buttons" aria-label="Dockyard tools">
        <button className="secondary small" data-dockyard-tool="connections" onClick={() => activateTool(DOCKYARD_CONTENT_IDS.connections)}>Connections</button>
        <button className="secondary small" data-dockyard-tool="schema" onClick={() => activateTool(DOCKYARD_CONTENT_IDS.schema)}>Schema</button>
        <button className="secondary small" data-dockyard-tool="inspector" onClick={() => activateTool(DOCKYARD_CONTENT_IDS.inspector)}>Inspector</button>
        <button className="secondary small" data-dockyard-tool="history" onClick={() => { onHistoryRefresh(); activateTool(DOCKYARD_CONTENT_IDS.history); }}>History</button>
        {activeTab && <button className="secondary small" data-dockyard-tool="explain" onClick={() => activateTool(explainToolId(activeTab.id))}>Explain</button>}
        <button className="secondary small" onClick={onAddTab}>New query</button>
      </nav>
      <div className="topbar-user">
        <button className="secondary small" onClick={onOpenAudit}>Audit</button>
        {user.role === 'admin' && <button className="secondary small" onClick={onOpenAdmin}>Admin</button>}
        <button className="secondary small" onClick={onOpenSettings}>⚙ Settings</button>
        <span>{user.username}</span>
        <button className="secondary small" onClick={onLogout}>Log out</button>
      </div>
    </header>

    <main className="dockyard-workspace-shell">
      <div className="dockyard-host" ref={hostRef} />
      {initializationError ? recoveryContent?.(initializationError) ?? <div className="dockyard-init-error" role="alert"><strong>Dockyard could not initialize.</strong><span>{initializationError}</span><button type="button" className="secondary small" onClick={() => window.location.reload()}>Reload workspace</button></div> : adapter && definitions.map(definition => createPortal(renderDefinition(definition), definition.content, definition.id))}
    </main>
    {transientUi}
    <StatusBar connectionName={selected?.name} database={database} lastQueryTime={lastQueryTime} overwrite={overwrite} />
  </div>;
}
