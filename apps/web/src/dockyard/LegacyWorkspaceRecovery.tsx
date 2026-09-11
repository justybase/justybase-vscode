import type { ReactElement } from 'react';
import type { DockyardWorkspaceProps } from './DockyardWorkspace';
import { QueryDocument } from './DockyardWorkspace';
import { InspectorPanel } from '../InspectorPanel';
import { SchemaTree } from '../SchemaTree';

type LegacyWorkspaceRecoveryProps = Omit<DockyardWorkspaceProps, 'recoveryContent' | 'onDockyardResetRegistration'> & {
  recoveryReason: string;
  onRetryDockyard(): void;
};

/**
 * Small, deliberately temporary recovery surface. It keeps the query/editor
 * path usable when Dockyard itself cannot initialize, without making the old
 * shell a second normal production route.
 */
export function LegacyWorkspaceRecovery({
  user,
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
  editorSplit,
  onEditorReady,
  onEditorDispose,
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
  onOpenAudit,
  onOpenAdmin,
  onOpenSettings,
  onLogout,
  recoveryReason,
  onRetryDockyard,
}: LegacyWorkspaceRecoveryProps): ReactElement {
  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? tabs[0];

  return <div className="legacy-recovery-workspace">
    <aside className="sidebar legacy-recovery-sidebar">
      <div className="sidebar-section">
        <div className="section-title"><span>Connections</span><button type="button" className="icon-button" onClick={onOpenConnectionForm}>+</button></div>
        {connections.map(connection => <div className="connection-row-wrap" key={connection.id}>
          <button type="button" className={`tree-row connection-row ${selected?.id === connection.id ? 'active' : ''}`} onClick={() => onSelectConnection(activeTabId, connection.id)}>
            <span className="status-dot" />{connection.name}
          </button>
          <div className="connection-actions">
            <button type="button" title="Edit connection" onClick={() => onEditConnection(connection)}>✎</button>
            <button type="button" title="Delete connection" onClick={() => onDeleteConnection(connection)}>×</button>
          </div>
        </div>)}
      </div>
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
      /> : <div className="sidebar-empty-state"><strong>No connections</strong><span>Add a connection to browse its schema.</span><button type="button" className="secondary small" onClick={onOpenConnectionForm}>Add connection</button></div>}
    </aside>

    <main className="editor-area legacy-recovery-editor">
      <div className="legacy-recovery-banner" role="alert">
        <strong>Dockyard recovery mode</strong>
        <span>{recoveryReason}</span>
        <button type="button" className="secondary small" onClick={onRetryDockyard}>Retry Dockyard</button>
      </div>
      <div className="legacy-recovery-actions" aria-label="Recovery workspace actions">
        <span className="muted">{user.username}</span>
        <button type="button" className="secondary small" onClick={onHistoryRefresh}>History</button>
        <button type="button" className="secondary small" onClick={onOpenAudit}>Audit</button>
        {user.role === 'admin' && <button type="button" className="secondary small" onClick={onOpenAdmin}>Admin</button>}
        <button type="button" className="secondary small" onClick={onOpenSettings}>⚙ Settings</button>
        <button type="button" className="secondary small" onClick={onLogout}>Log out</button>
      </div>
      <div className="editor-tabs legacy-recovery-tabs">
        {tabs.map(tab => <button type="button" className={`editor-tab ${tab.id === activeTab?.id ? 'active' : ''}`} data-recovery-query-tab-id={tab.id} key={tab.id} onClick={() => onActivateTab(tab.id)}>
          {tab.title}{tab.dirty ? ' •' : ''}
          <span className="editor-tab-close" onClick={event => { event.stopPropagation(); onCloseTab(tab.id); }}>×</span>
        </button>)}
        <button type="button" className="editor-tab-add" onClick={onAddTab}>+</button>
      </div>
      {activeTab ? <QueryDocument
        tab={activeTab}
        active
        error={error}
        connections={connections}
        selected={selected}
        databases={databases}
        preferences={preferences}
        editorSplit={editorSplit}
        onEditorReady={onEditorReady}
        onEditorDispose={onEditorDispose}
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
        onOpenConnectionForm={onOpenConnectionForm}
        onEditRow={onEditRow}
      /> : <div className="empty-state"><strong>No query tab</strong><button type="button" onClick={onAddTab}>New query</button></div>}
    </main>

    <aside className="inspector legacy-recovery-inspector">
      <div className="inspector-toolbar"><span>Inspector</span><span className="muted">Recovery</span></div>
      <InspectorPanel
        database={database}
        schema={schema}
        columns={columns}
        selectedObject={inspectedObject}
        onInsertColumn={onInsertColumn}
        connectionName={selected?.name}
      />
    </aside>
  </div>;
}
