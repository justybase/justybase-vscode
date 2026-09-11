import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import type {
  CapabilityDescriptor,
  ConnectionProfileSummary,
  HistoryEntry,
  QueryEvent,
  SchemaTreeNode,
  UiMode,
  WebUser,
} from '@justybase/contracts';
import {
  createInitialUiState,
  createUiStore,
  resolveUiMode,
} from '@justybase/ui-core';
import type { UiResultEvent, UiResultSurfaceState, UiStore, UiSurface } from '@justybase/ui-core';
import {
  AsyncStateView,
  DataGrid,
  DesignerForm,
  EditorSurface,
  ExplainView,
  HistoryView,
  ResultTabs,
  ResultViewToolbar,
  RowDetail,
  SchemaTree,
  UiShell,
  WorkspaceTabs,
} from '@justybase/ui-react';
import type { GridScrollPosition, HistoryViewEntry } from '@justybase/ui-react';
import type { ApiClient, QueryEventSubscription } from './api';

const sharedCapabilities: readonly CapabilityDescriptor[] = [
  { key: 'workspace', status: 'available', owner: 'ui-core', documentation: 'Shared workspace state and presentation.', removalCondition: 'Keep the shared workspace owner.' },
  { key: 'results.read', status: 'available', owner: 'web-api-adapter', documentation: 'Read result pages and stream events from the API.', removalCondition: 'Keep the shared result port.' },
  { key: 'results.write', status: 'read-only', owner: 'web-api-adapter', reason: 'Writes require the guarded preview/apply workflow.', documentation: 'API guarded-write routes.', removalCondition: 'Expose the guarded write port in shared mode.' },
  { key: 'designer', status: 'read-only', owner: 'web-api-adapter', reason: 'Shared designer preview is available; apply remains adapter-owned.', documentation: 'Designer capability API.', removalCondition: 'Wire the shared DesignerPort apply workflow.' },
  { key: 'history', status: 'available', owner: 'web-api-adapter', documentation: 'User-scoped query history.', removalCondition: 'Keep the shared history port.' },
];

const DOCUMENT_ID = 'shared-scratch';

interface WebRuntimeConfig {
  readonly __JUSTYBASE_UI_MODE__?: unknown;
}

export function configuredWebUiMode(): UiMode {
  const value = (globalThis as WebRuntimeConfig).__JUSTYBASE_UI_MODE__;
  return resolveUiMode(value);
}

export function redactedWebProfile(profile: ConnectionProfileSummary) {
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    database: profile.database,
    user: profile.user,
    dbType: profile.dbType,
    readOnly: profile.readOnly,
  } as const;
}

function sourceIdFor(user: WebUser): string {
  return `web:${user.id}`;
}

function createSharedStore(user: WebUser): UiStore {
  const sourceId = sourceIdFor(user);
  const store = createUiStore(createInitialUiState({ productId: 'web', userId: user.id, workspaceId: `web:${user.id}`, sourceId }, {
    mode: 'shared',
    auth: { status: 'authenticated', userId: user.id, username: user.username },
    capabilities: sharedCapabilities,
    persistenceScope: 'user',
  }));
  store.dispatch({
    type: 'workspace/open-document',
    document: { id: DOCUMENT_ID, sourceId, title: 'scratch.sql', content: 'SELECT 1;', dirty: false },
  });
  return store;
}

export function mapSchemaNode(node: SchemaTreeNode) {
  const kind = node.kind === 'cte' ? 'object' : node.kind;
  return { id: node.id, parentId: node.parentId, kind, label: node.label, hasChildren: node.hasChildren } as const;
}

function queryResultId(queryId: string): string {
  return `${queryId}:0`;
}

export function resultAsyncState(result: UiResultSurfaceState | undefined, rowCount: number): 'loading' | 'empty' | 'error' | 'cancelled' | 'ready' {
  if (!result) return 'empty';
  if (result.status === 'error') return 'error';
  if (result.status === 'cancelled') return 'cancelled';
  if (result.status === 'loading' || (result.status === 'streaming' && rowCount === 0)) return 'loading';
  if (result.status === 'empty' || rowCount === 0) return 'empty';
  return 'ready';
}

export function displayRows(result: UiResultSurfaceState | undefined, rows: readonly (readonly unknown[])[]): readonly (readonly unknown[])[] {
  if (!result) return [];
  const filter = result.view.globalFilter.trim().toLocaleLowerCase();
  const filtered = filter.length === 0
    ? [...rows]
    : rows.filter(row => row.some(value => String(value ?? '').toLocaleLowerCase().includes(filter)));
  const sorting = result.view.sorting[0];
  if (!sorting) return filtered;
  const columnIndex = Number(sorting.column);
  if (!Number.isInteger(columnIndex)) return filtered;
  return filtered.sort((left, right) => {
    const leftText = String(left[columnIndex] ?? '');
    const rightText = String(right[columnIndex] ?? '');
    const order = leftText.localeCompare(rightText, undefined, { numeric: true });
    return sorting.descending ? -order : order;
  });
}

interface ActiveQuery {
  readonly queryId: string;
  readonly resultSetId: string;
  readonly sourceId: string;
  readonly executionId: string;
  readonly statementIndex: number;
  subscription?: QueryEventSubscription;
}

export interface SharedWebWorkspaceProps {
  readonly api: ApiClient;
  readonly user: WebUser;
  readonly onLogout: () => void;
}

/** Web composition root for shared mode; all effects stay in this adapter. */
export function SharedWebWorkspace({ api, user, onLogout }: SharedWebWorkspaceProps): ReactElement {
  const storeRef = useRef<UiStore | undefined>(undefined);
  if (!storeRef.current) storeRef.current = createSharedStore(user);
  const store = storeRef.current;
  const subscribe = useCallback((listener: () => void) => store.subscribe(() => listener()), [store]);
  const getSnapshot = useCallback(() => store.getState(), [store]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [rowsByResult, setRowsByResult] = useState<Record<string, readonly (readonly unknown[])[]>>({});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [schemaNodes, setSchemaNodes] = useState<ReturnType<typeof mapSchemaNode>[]>([]);
  const [selectedRow, setSelectedRow] = useState<number | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const rowsByResultRef = useRef(rowsByResult);
  const activeQueryRef = useRef<ActiveQuery | undefined>(undefined);
  const queryByResultRef = useRef(new Map<string, string>());
  const pageHydrationRef = useRef(new Set<string>());
  const selectedConnectionId = state.connections.selectedConnectionId;
  const selectedConnection = state.connections.profiles.find(profile => profile.id === selectedConnectionId);
  const activeDocument = state.workspace.activeDocumentId ? state.workspace.documents[state.workspace.activeDocumentId] : undefined;
  const activeResult = state.results.activeResultSetId
    ? Object.values(state.results.byResultSetId).find(result => result.sourceId === state.results.activeSourceId && result.resultSetId === state.results.activeResultSetId)
    : undefined;
  const activeRows = activeResult ? rowsByResult[activeResult.resultSetId] ?? [] : [];
  const visibleRows = displayRows(activeResult, activeRows);

  useEffect(() => () => {
    const active = activeQueryRef.current;
    active?.subscription?.close();
    if (active) void api.cancelQuery(active.queryId).catch(() => undefined);
    store.dispose();
  }, [api, store]);

  useEffect(() => {
    let live = true;
    store.dispatch({ type: 'connections/status', status: 'loading' });
    void api.connections().then(profiles => {
      if (!live) return;
      store.dispatch({ type: 'connections/set-profiles', profiles: profiles.map(redactedWebProfile) });
      if (profiles[0]) store.dispatch({ type: 'connections/select', connectionId: profiles[0].id });
    }).catch(error => {
      if (!live) return;
      store.dispatch({ type: 'connections/status', status: 'error', message: error instanceof Error ? error.message : 'Could not load connections.' });
    });
    return () => { live = false; };
  }, [api, store]);

  useEffect(() => {
    let live = true;
    store.dispatch({ type: 'history/status', status: 'loading' });
    void api.history().then(entries => {
      if (!live) return;
      setHistory(entries);
      store.dispatch({ type: 'history/status', status: 'complete' });
    }).catch(error => {
      if (!live) return;
      store.dispatch({ type: 'history/status', status: 'error', message: error instanceof Error ? error.message : 'Could not load history.' });
    });
    return () => { live = false; };
  }, [api, store]);

  useEffect(() => {
    if (!selectedConnectionId) {
      setSchemaNodes([]);
      return undefined;
    }
    let live = true;
    store.dispatch({ type: 'metadata/status', status: 'loading' });
    void api.schemaTree(selectedConnectionId).then(response => {
      if (!live) return;
      setSchemaNodes(response.nodes.map(mapSchemaNode));
      store.dispatch({ type: 'metadata/status', status: 'complete' });
    }).catch(error => {
      if (!live) return;
      setSchemaNodes([]);
      store.dispatch({ type: 'metadata/status', status: 'error', message: error instanceof Error ? error.message : 'Could not load schema.' });
    });
    return () => { live = false; };
  }, [api, selectedConnectionId, store]);

  const dispatchQueryEvent = useCallback((active: ActiveQuery, event: QueryEvent, nextSequence: () => number): void => {
    const base = { sourceId: active.sourceId, executionId: active.executionId, resultSetId: active.resultSetId, sequence: nextSequence() };
    let mapped: UiResultEvent | undefined;
    switch (event.type) {
      case 'started': mapped = { ...base, type: 'started' }; break;
      case 'statement-started': mapped = { ...base, type: 'statement-started' }; break;
      case 'columns': mapped = { ...base, type: 'columns', columns: event.columns.map(column => ({ name: column.name, type: column.type })) }; break;
      case 'rows': {
        const rows = rowsByResultRef.current[active.resultSetId] ?? [];
        const nextRows = [...rows, ...event.rows.map(row => [...row])];
        rowsByResultRef.current = { ...rowsByResultRef.current, [active.resultSetId]: nextRows };
        setRowsByResult(rowsByResultRef.current);
        mapped = { ...base, type: 'rows', rowCount: nextRows.length, totalRowCount: event.totalRows };
        break;
      }
      case 'progress': mapped = { ...base, type: 'progress', totalRowCount: event.totalRows }; break;
      case 'complete': mapped = { ...base, type: 'complete', totalRowCount: event.totalRows, message: event.message }; break;
      case 'error': mapped = { ...base, type: 'error', message: event.message }; break;
      case 'cancelled': mapped = { ...base, type: 'cancelled', totalRowCount: event.totalRows }; break;
      case 'session':
      case 'batch-complete':
        break;
    }
    if (mapped) store.dispatch({ type: 'execution/event', event: mapped });
  }, [store]);

  const hydrateResultPage = useCallback((active: ActiveQuery): void => {
    const hydrationKey = `${active.sourceId}\u0000${active.resultSetId}\u0000${active.queryId}`;
    if (pageHydrationRef.current.has(hydrationKey)) return;
    pageHydrationRef.current.add(hydrationKey);
    void api.queryPage(active.queryId, { statementIndex: active.statementIndex, offset: 0, limit: 500 }).then(page => {
      if (queryByResultRef.current.get(active.resultSetId) !== active.queryId) return;
      const nextRows = page.rows.map(row => [...row]);
      rowsByResultRef.current = { ...rowsByResultRef.current, [active.resultSetId]: nextRows };
      setRowsByResult(rowsByResultRef.current);
      store.dispatch({
        type: 'results/hydrate',
        sourceId: active.sourceId,
        executionId: active.executionId,
        resultSetId: active.resultSetId,
        loadedRowCount: nextRows.length,
        totalRowCount: page.totalRows,
        columns: page.columns.map(column => ({ name: column.name, type: column.type })),
      });
    }).catch(error => {
      const current = store.getState().results.byResultSetId[`${active.sourceId}\u0000${active.resultSetId}`];
      if (current?.executionId === active.executionId && current.status !== 'cancelled' && current.status !== 'error') {
        setNotice(error instanceof Error ? error.message : 'Could not load result rows.');
      }
    }).finally(() => {
      pageHydrationRef.current.delete(hydrationKey);
    });
  }, [api, store]);

  const run = useCallback(async (mode: 'single' | 'explain' = 'single'): Promise<void> => {
    if (!selectedConnection) {
      setNotice('Select a connection before running SQL.');
      return;
    }
    if (!activeDocument?.content.trim()) {
      setNotice('Enter SQL before running the document.');
      return;
    }
    const previous = activeQueryRef.current;
    activeQueryRef.current = undefined;
    previous?.subscription?.close();
    if (previous) void api.cancelQuery(previous.queryId).catch(() => undefined);
    setNotice(undefined);
    try {
      const started = await api.startQuery({ connectionId: selectedConnection.id, database: selectedConnection.database, sql: activeDocument.content, mode });
      const active: ActiveQuery = { queryId: started.queryId, resultSetId: queryResultId(started.queryId), sourceId: sourceIdFor(user), executionId: started.queryId, statementIndex: 0 };
      activeQueryRef.current = active;
      queryByResultRef.current.set(active.resultSetId, active.queryId);
      rowsByResultRef.current = { ...rowsByResultRef.current, [active.resultSetId]: [] };
      setRowsByResult(rowsByResultRef.current);
      setSelectedRow(undefined);
      store.dispatch({ type: 'execution/start', sourceId: active.sourceId, executionId: active.executionId, resultSetId: active.resultSetId });
      let sequence = 0;
      const nextSequence = (): number => { sequence += 1; return sequence; };
      const subscriptionRef: { current?: QueryEventSubscription } = {};
      const closeActiveStream = (): void => {
        subscriptionRef.current?.close();
        if (activeQueryRef.current?.queryId === active.queryId) activeQueryRef.current = undefined;
      };
      const subscription = api.connectToQueryEvents(started.queryId, event => {
        if (activeQueryRef.current?.queryId !== active.queryId) return;
        dispatchQueryEvent(active, event, nextSequence);
        if (event.type === 'complete') hydrateResultPage(active);
        if (event.type === 'complete' || event.type === 'error' || event.type === 'cancelled') queueMicrotask(closeActiveStream);
      }, error => {
        if (activeQueryRef.current?.queryId !== active.queryId) return;
        store.dispatch({ type: 'execution/event', event: { sourceId: active.sourceId, executionId: active.executionId, resultSetId: active.resultSetId, sequence: nextSequence(), type: 'error', message: error.message } });
        setNotice(error.message);
        queueMicrotask(closeActiveStream);
      });
      subscriptionRef.current = subscription;
      active.subscription = subscription;
      activeQueryRef.current = active;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not start query.');
    }
  }, [activeDocument?.content, api, dispatchQueryEvent, hydrateResultPage, selectedConnection, store, user]);

  const cancel = useCallback(async (): Promise<void> => {
    const active = activeQueryRef.current;
    if (!active) return;
    const requestId = `cancel-${Date.now().toString(36)}`;
    store.dispatch({ type: 'execution/cancel-requested', sourceId: active.sourceId, executionId: active.executionId, requestId });
    try {
      await api.cancelQuery(active.queryId);
      store.dispatch({ type: 'execution/cancel-acknowledged', sourceId: active.sourceId, executionId: active.executionId, requestId });
    } catch (error) {
      store.dispatch({ type: 'execution/cancel-failed', sourceId: active.sourceId, executionId: active.executionId, requestId, message: error instanceof Error ? error.message : 'Cancellation failed.' });
    }
  }, [api, store]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!activeResult) return;
    const queryId = queryByResultRef.current.get(activeResult.resultSetId);
    if (!queryId) return;
    try {
      const page = await api.queryPage(queryId, { statementIndex: activeResult.statementIndex, offset: 0, limit: 500 });
      if (queryByResultRef.current.get(activeResult.resultSetId) !== queryId) return;
      const nextRows = page.rows.map(row => [...row]);
      rowsByResultRef.current = { ...rowsByResultRef.current, [activeResult.resultSetId]: nextRows };
      setRowsByResult(rowsByResultRef.current);
      store.dispatch({
        type: 'results/hydrate',
        sourceId: activeResult.sourceId,
        executionId: activeResult.executionId,
        resultSetId: activeResult.resultSetId,
        loadedRowCount: nextRows.length,
        totalRowCount: page.totalRows,
        columns: page.columns.map(column => ({ name: column.name, type: column.type })),
      });
      setNotice(undefined);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not refresh results.');
    }
  }, [activeResult, api, store]);

  const updateSql = useCallback((content: string): void => {
    if (!activeDocument) return;
    store.dispatch({ type: 'workspace/update-document', documentId: activeDocument.id, patch: { content, dirty: true } });
  }, [activeDocument, store]);

  const selectSurface = useCallback((surface: string): void => {
    if (['workspace', 'editor', 'results', 'schema', 'history', 'explain', 'designer'].includes(surface)) store.dispatch({ type: 'shell/surface', surface: surface as UiSurface });
  }, [store]);

  const updateResultView = useCallback((patch: Partial<UiResultSurfaceState['view']>): void => {
    if (activeResult) store.dispatch({ type: 'results/view', sourceId: activeResult.sourceId, resultSetId: activeResult.resultSetId, patch });
  }, [activeResult, store]);

  const onScroll = useCallback((position: GridScrollPosition): void => {
    updateResultView({ scrollTop: position.top, scrollLeft: position.left, anchorRow: position.anchorRow });
  }, [updateResultView]);

  const copySelected = useCallback(async (): Promise<void> => {
    const row = selectedRow === undefined ? visibleRows[0] : visibleRows[selectedRow];
    if (!row) return;
    const text = row.map(value => String(value ?? '')).join('\t');
    if (typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(text);
    setNotice('Row copied.');
  }, [selectedRow, visibleRows]);

  const exportResults = useCallback((): void => {
    if (typeof document === 'undefined') return;
    const header = activeResult?.columns.map(column => column.name).join(',') ?? '';
    const body = visibleRows.map(row => row.map(value => JSON.stringify(value ?? '')).join(',')).join('\n');
    const blob = new Blob([`${header}\n${body}\n`], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'justybase-result.csv';
    link.click();
    URL.revokeObjectURL(url);
    setNotice('Result exported.');
  }, [activeResult?.columns, visibleRows]);

  const historyItems: HistoryViewEntry[] = useMemo(() => history.map(entry => ({ id: entry.id, label: entry.sql.slice(0, 80), status: entry.status, sqlFingerprint: `${entry.createdAt} · ${entry.rowCount} rows` })), [history]);
  const selectedNode = state.metadata.selectedNodeId ? schemaNodes.find(node => node.id === state.metadata.selectedNodeId) : undefined;
  const resultState = resultAsyncState(activeResult, visibleRows.length);
  const resultMessage = activeResult?.message;
  const designerFields = { target: selectedNode?.label ?? 'Select an object', connection: selectedConnection?.name ?? 'No connection' };

  return <UiShell title="JustyBase" activeSurface={state.shell.activeSurface} onSurfaceChange={selectSurface} surfaces={[{ id: 'workspace', label: 'Workspace' }, { id: 'history', label: 'History' }, { id: 'explain', label: 'Explain' }, { id: 'designer', label: 'Designer' }]} sidebar={<div className="shared-sidebar">
    <strong>Connections</strong>{state.connections.profiles.map(profile => <button type="button" key={profile.id} aria-pressed={profile.id === selectedConnectionId} onClick={() => store.dispatch({ type: 'connections/select', connectionId: profile.id })}>{profile.name}</button>)}
    <SchemaTree nodes={schemaNodes} selectedId={state.metadata.selectedNodeId} expandedIds={state.metadata.expandedNodeIds} onToggle={node => store.dispatch({ type: 'metadata/toggle-expanded', nodeId: node.id })} onSelect={node => store.dispatch({ type: 'metadata/select', nodeId: node.id })} />
    <button type="button" onClick={onLogout}>Log out</button>
  </div>}>
    {state.shell.activeSurface === 'history' ? <HistoryView entries={historyItems} state={state.history.status === 'error' ? 'error' : state.history.status === 'loading' ? 'loading' : historyItems.length === 0 ? 'empty' : 'ready'} message={state.history.message} onOpen={entry => { const sourceId = sourceIdFor(user); store.dispatch({ type: 'workspace/open-document', document: { id: `history:${entry.id}`, sourceId, title: entry.label || 'History query', content: history.find(item => item.id === entry.id)?.sql ?? '', dirty: false } }); store.dispatch({ type: 'shell/surface', surface: 'workspace' }); }} />
      : state.shell.activeSurface === 'explain' ? <ExplainView state={activeResult ? resultState : 'empty'} plan={activeResult?.message} message={resultMessage} onCancel={cancel} />
        : state.shell.activeSurface === 'designer' ? <DesignerForm fields={designerFields} capability={state.capabilities.find(capability => capability.key === 'designer')} onChange={() => undefined} onPreview={() => setNotice('Designer preview remains adapter-backed in shared mode.')} onApply={() => setNotice('Designer apply is guarded and unavailable for this read-only capability.')} />
          : <>
            <WorkspaceTabs tabs={state.workspace.documentOrder.map(id => ({ id, label: state.workspace.documents[id]?.title ?? id, dirty: state.workspace.documents[id]?.dirty }))} activeId={state.workspace.activeDocumentId} onSelect={id => store.dispatch({ type: 'workspace/select-document', documentId: id })} />
            <EditorSurface value={activeDocument?.content ?? ''} onChange={updateSql} onSubmit={() => void run()} />
            <div className="shared-result-panel">
              <button type="button" onClick={() => void run()}>Run</button><button type="button" onClick={() => void run('explain')}>Explain</button><button type="button" onClick={() => void cancel()} disabled={!activeQueryRef.current}>Cancel</button>
              {notice && <div role="status">{notice}</div>}
              <ResultTabs results={Object.values(state.results.byResultSetId)} activeResultSetId={state.results.activeResultSetId} activeSourceId={state.results.activeSourceId} onSelect={(resultSetId, sourceId) => store.dispatch({ type: 'results/select', sourceId, resultSetId })} />
              {activeResult && <ResultViewToolbar view={activeResult.view} onChange={updateResultView} onRefresh={() => void refresh()} onCopy={() => void copySelected()} onExport={exportResults} />}
              <AsyncStateView state={resultState} message={resultMessage} emptyLabel="No rows to display."><DataGrid sourceId={activeResult?.sourceId} resultSetId={activeResult?.resultSetId ?? 'empty'} columns={activeResult?.columns ?? []} rows={visibleRows} totalRowCount={activeResult?.totalRowCount} scroll={activeResult ? { sourceId: activeResult.sourceId, resultSetId: activeResult.resultSetId, top: activeResult.view.scrollTop, left: activeResult.view.scrollLeft, anchorRow: activeResult.view.anchorRow } : undefined} onScroll={onScroll} onRowSelect={setSelectedRow} /></AsyncStateView>
              {selectedRow !== undefined && visibleRows[selectedRow] && activeResult && <RowDetail columns={activeResult.columns} row={visibleRows[selectedRow]} onClose={() => setSelectedRow(undefined)} />}
            </div>
          </>}
  </UiShell>;
}
