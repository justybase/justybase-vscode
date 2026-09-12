import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import type {
  CapabilityDescriptor,
  ConnectionProfileSummary,
  DatabaseKind,
  EditorPreferences,
  HistoryEntry,
  QueryEvent,
  SchemaTreeNode,
  UiMode,
  WebUser,
} from '@justybase/contracts';
import {
  createInitialUiState,
  createUiStore,
  resultAsyncState as getResultAsyncState,
  resolveUiMode,
} from '@justybase/ui-core';
import type { UiResultEvent, UiResultSurfaceState, UiStore, UiSurface } from '@justybase/ui-core';
import {
  AsyncStateView,
  DataGrid,
  formatDataGridCellValue,
  processDataGridRows,
  DesignerForm,
  ExplainView,
  HistoryView,
  ResultTabs,
  ResultViewToolbar,
  RowDetail,
  resolveDataGridColumnIndexes,
  resolveDataGridColumns,
  SchemaTree,
  SqlDialectSelect,
  UiShell,
  WorkspaceTabs,
} from '@justybase/ui-react';
import type { GridScrollPosition, HistoryViewEntry } from '@justybase/ui-react';
import type { ApiClient, QueryEventSubscription } from './api';
import { SharedSqlEditor, SharedSqlProblems } from './SharedSqlEditor';

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
    document: { id: DOCUMENT_ID, sourceId, title: 'scratch.sql', content: 'SELECT 1;', dirty: false, databaseKind: 'netezza' },
  });
  return store;
}

export function mapSchemaNode(node: SchemaTreeNode, parentId = node.parentId) {
  const kind = node.kind === 'cte' ? 'object' : node.kind;
  return { id: node.id, ...(parentId === undefined ? {} : { parentId }), kind, label: node.label, hasChildren: node.hasChildren } as const;
}

function visibleSchemaNodes<T extends { readonly id: string; readonly parentId?: string }>(nodes: readonly T[], expandedIds: readonly string[]): readonly T[] {
  const expanded = new Set(expandedIds);
  const childrenByParent = new Map<string | undefined, T[]>();
  for (const node of nodes) {
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }
  const visible: T[] = [];
  const visit = (parentId: string | undefined): void => {
    for (const node of childrenByParent.get(parentId) ?? []) {
      visible.push(node);
      if (expanded.has(node.id)) visit(node.id);
    }
  };
  visit(undefined);
  return visible;
}

function queryResultId(queryId: string): string {
  return `${queryId}:0`;
}

function mapQueryColumn(column: { readonly name: string; readonly type?: string; readonly scale?: number }) {
  return {
    name: column.name,
    ...(column.type === undefined ? {} : { type: column.type }),
    ...(column.scale === undefined ? {} : { scale: column.scale }),
  };
}

export function resultAsyncState(result: UiResultSurfaceState | undefined, rowCount: number) {
  return getResultAsyncState(result, rowCount);
}

export function displayRows(result: UiResultSurfaceState | undefined, rows: readonly (readonly unknown[])[]): readonly (readonly unknown[])[] {
  if (!result) return [];
  return processDataGridRows(result.columns, rows, result.view);
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? (() => {
        try {
          return JSON.stringify(value) ?? String(value);
        } catch {
          return String(value);
        }
      })()
      : String(value);
  return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function rowsAsCsv(columns: readonly { readonly name: string }[], rows: readonly (readonly unknown[])[]): string {
  return [
    columns.map(column => csvCell(column.name)).join(','),
    ...rows.map(row => row.map(value => csvCell(value)).join(',')),
  ].join('\n');
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
  const [preferences, setPreferences] = useState<EditorPreferences | null>(null);
  const [problems, setProblems] = useState<readonly import('./SharedSqlEditor').SharedSqlEditorProblem[]>([]);
  const [schemaNodes, setSchemaNodes] = useState<ReturnType<typeof mapSchemaNode>[]>([]);
  const [selectedRow, setSelectedRow] = useState<number | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const rowsByResultRef = useRef(rowsByResult);
  const activeQueryRef = useRef<ActiveQuery | undefined>(undefined);
  const runGenerationRef = useRef(0);
  const queryByResultRef = useRef(new Map<string, string>());
  const pageHydrationRef = useRef(new Set<string>());
  const pageStateRef = useRef(new Map<string, { readonly totalRows: number; readonly hasMore: boolean }>());
  const schemaLoadedParentsRef = useRef(new Set<string>());
  const selectedConnectionId = state.connections.selectedConnectionId;
  const selectedConnection = state.connections.profiles.find(profile => profile.id === selectedConnectionId);
  const activeDocument = state.workspace.activeDocumentId ? state.workspace.documents[state.workspace.activeDocumentId] : undefined;
  const runtimeDatabaseKind = selectedConnection?.dbType ?? 'netezza';
  const authoringDatabaseKind = activeDocument?.databaseKind ?? runtimeDatabaseKind;
  const activeResult = state.results.activeResultSetId
    ? Object.values(state.results.byResultSetId).find(result => result.sourceId === state.results.activeSourceId && result.resultSetId === state.results.activeResultSetId)
    : undefined;
  const activeRows = activeResult ? rowsByResult[activeResult.resultSetId] ?? [] : [];
  const visibleRows = displayRows(activeResult, activeRows);
  const visibleSchema = visibleSchemaNodes(schemaNodes, state.metadata.expandedNodeIds);

  useEffect(() => {
    setSelectedRow(undefined);
  }, [activeResult?.sourceId, activeResult?.resultSetId]);

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
      if (profiles[0]) {
        store.dispatch({ type: 'connections/select', connectionId: profiles[0].id });
        const currentDocumentId = store.getState().workspace.activeDocumentId;
        if (currentDocumentId) store.dispatch({ type: 'workspace/update-document', documentId: currentDocumentId, patch: { connectionId: profiles[0].id, databaseKind: profiles[0].dbType } });
      }
    }).catch(error => {
      if (!live) return;
      store.dispatch({ type: 'connections/status', status: 'error', message: error instanceof Error ? error.message : 'Could not load connections.' });
    });
    return () => { live = false; };
  }, [api, store]);

  useEffect(() => {
    let live = true;
    void api.editorPreferences().then(value => {
      if (live) setPreferences(value);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [api]);

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
      schemaLoadedParentsRef.current.clear();
      setSchemaNodes([]);
      return undefined;
    }
    let live = true;
    store.dispatch({ type: 'metadata/status', status: 'loading' });
    void api.schemaTree(selectedConnectionId).then(response => {
      if (!live) return;
      schemaLoadedParentsRef.current.clear();
      schemaLoadedParentsRef.current.add('');
      setSchemaNodes(response.nodes.map(node => mapSchemaNode(node)));
      store.dispatch({ type: 'metadata/status', status: 'complete' });
    }).catch(error => {
      if (!live) return;
      setSchemaNodes([]);
      store.dispatch({ type: 'metadata/status', status: 'error', message: error instanceof Error ? error.message : 'Could not load schema.' });
    });
    return () => { live = false; };
  }, [api, selectedConnectionId, store]);

  const toggleSchemaNode = useCallback((node: ReturnType<typeof mapSchemaNode>): void => {
    const isExpanded = state.metadata.expandedNodeIds.includes(node.id);
    store.dispatch({ type: 'metadata/toggle-expanded', nodeId: node.id });
    if (isExpanded || !node.hasChildren || !selectedConnectionId || schemaLoadedParentsRef.current.has(node.id)) return;

    schemaLoadedParentsRef.current.add(node.id);
    store.dispatch({ type: 'metadata/status', status: 'loading' });
    void api.schemaTree(selectedConnectionId, node.id).then(response => {
      if (store.getState().connections.selectedConnectionId !== selectedConnectionId) return;
      setSchemaNodes(previous => {
        const merged = new Map(previous.map(item => [item.id, item] as const));
        for (const child of response.nodes) merged.set(child.id, mapSchemaNode(child, node.id));
        return [...merged.values()];
      });
      store.dispatch({ type: 'metadata/status', status: 'complete' });
    }).catch(error => {
      if (store.getState().connections.selectedConnectionId !== selectedConnectionId) return;
      schemaLoadedParentsRef.current.delete(node.id);
      store.dispatch({ type: 'metadata/status', status: 'error', message: error instanceof Error ? error.message : 'Could not load schema.' });
    });
  }, [api, selectedConnectionId, state.metadata.expandedNodeIds, store]);

  const dispatchQueryEvent = useCallback((active: ActiveQuery, event: QueryEvent, nextSequence: () => number): void => {
    const base = { sourceId: active.sourceId, executionId: active.executionId, resultSetId: active.resultSetId, sequence: nextSequence() };
    let mapped: UiResultEvent | undefined;
    switch (event.type) {
      case 'started': mapped = { ...base, type: 'started' }; break;
      case 'statement-started': mapped = { ...base, type: 'statement-started' }; break;
      case 'columns': mapped = { ...base, type: 'columns', columns: event.columns.map(mapQueryColumn) }; break;
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

  const loadResultPage = useCallback(async (active: ActiveQuery, offset: number, replace: boolean): Promise<void> => {
    const hydrationKey = `${active.sourceId}\u0000${active.resultSetId}\u0000${active.queryId}\u0000${offset}`;
    if (pageHydrationRef.current.has(hydrationKey)) return;
    pageHydrationRef.current.add(hydrationKey);
    try {
      const page = await api.queryPage(active.queryId, { statementIndex: active.statementIndex, offset, limit: 500 });
      if (queryByResultRef.current.get(active.resultSetId) !== active.queryId) return;
      const pageRows = page.rows.map(row => [...row]);
      const previousRows = rowsByResultRef.current[active.resultSetId] ?? [];
      const pageOffset = Math.max(0, page.offset);
      const nextRows = replace || pageOffset === 0
        ? pageRows
        : [...previousRows.slice(0, pageOffset), ...pageRows, ...previousRows.slice(pageOffset + pageRows.length)];
      rowsByResultRef.current = { ...rowsByResultRef.current, [active.resultSetId]: nextRows };
      setRowsByResult(rowsByResultRef.current);
      pageStateRef.current.set(active.resultSetId, {
        totalRows: page.totalRows,
        hasMore: page.hasMore || pageOffset + pageRows.length < page.totalRows,
      });
      store.dispatch({
        type: 'results/hydrate',
        sourceId: active.sourceId,
        executionId: active.executionId,
        resultSetId: active.resultSetId,
        loadedRowCount: nextRows.length,
        totalRowCount: page.totalRows,
        columns: page.columns.map(mapQueryColumn),
      });
    } catch (error) {
      const current = store.getState().results.byResultSetId[`${active.sourceId}\u0000${active.resultSetId}`];
      if (current?.executionId === active.executionId && current.status !== 'cancelled' && current.status !== 'error') {
        setNotice(error instanceof Error ? error.message : 'Could not load result rows.');
      }
    } finally {
      pageHydrationRef.current.delete(hydrationKey);
    }
  }, [api, store]);

  const hydrateResultPage = useCallback((active: ActiveQuery): void => {
    void loadResultPage(active, 0, true);
  }, [loadResultPage]);

  const run = useCallback(async (mode: 'single' | 'explain' = 'single'): Promise<void> => {
    if (!selectedConnection) {
      setNotice('Select a connection before running SQL.');
      return;
    }
    if (!activeDocument?.content.trim()) {
      setNotice('Enter SQL before running the document.');
      return;
    }
    const runGeneration = ++runGenerationRef.current;
    const previous = activeQueryRef.current;
    activeQueryRef.current = undefined;
    previous?.subscription?.close();
    if (previous) {
      const previousResult = Object.values(store.getState().results.byResultSetId)
        .find(result => result.sourceId === previous.sourceId && result.executionId === previous.executionId);
      if (previousResult?.status === 'loading' || previousResult?.status === 'streaming') {
        void api.cancelQuery(previous.queryId).catch(() => undefined);
      }
    }
    setNotice(undefined);
    try {
      const started = await api.startQuery({ connectionId: selectedConnection.id, database: selectedConnection.database, sql: activeDocument.content, mode });
      if (runGenerationRef.current !== runGeneration) {
        await api.cancelQuery(started.queryId).catch(() => undefined);
        return;
      }
      const active: ActiveQuery = { queryId: started.queryId, resultSetId: queryResultId(started.queryId), sourceId: sourceIdFor(user), executionId: started.queryId, statementIndex: 0 };
      activeQueryRef.current = active;
      queryByResultRef.current.set(active.resultSetId, active.queryId);
      pageStateRef.current.delete(active.resultSetId);
      rowsByResultRef.current = { ...rowsByResultRef.current, [active.resultSetId]: [] };
      setRowsByResult(rowsByResultRef.current);
      setSelectedRow(undefined);
      store.dispatch({ type: 'execution/start', sourceId: active.sourceId, executionId: active.executionId, resultSetId: active.resultSetId });
      store.dispatch({ type: 'results/select-source', sourceId: active.sourceId });
      store.dispatch({ type: 'results/select', sourceId: active.sourceId, resultSetId: active.resultSetId });
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
      if (runGenerationRef.current !== runGeneration) return;
      setNotice(error instanceof Error ? error.message : 'Could not start query.');
    }
  }, [activeDocument?.content, api, dispatchQueryEvent, hydrateResultPage, selectedConnection, store, user]);

  const loadMoreRows = useCallback((): void => {
    if (!activeResult) return;
    const queryId = queryByResultRef.current.get(activeResult.resultSetId);
    if (!queryId) return;
    const loadedRows = rowsByResultRef.current[activeResult.resultSetId]?.length ?? 0;
    const pageState = pageStateRef.current.get(activeResult.resultSetId);
    const totalRows = pageState?.totalRows ?? activeResult.totalRowCount;
    if (!pageState?.hasMore && pageState !== undefined) return;
    if (loadedRows >= totalRows) return;
    void loadResultPage({
      queryId,
      resultSetId: activeResult.resultSetId,
      sourceId: activeResult.sourceId,
      executionId: activeResult.executionId,
      statementIndex: activeResult.statementIndex,
    }, loadedRows, false);
  }, [activeResult, loadResultPage]);

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
    pageStateRef.current.delete(activeResult.resultSetId);
    setNotice(undefined);
    await loadResultPage({
      queryId,
      resultSetId: activeResult.resultSetId,
      sourceId: activeResult.sourceId,
      executionId: activeResult.executionId,
      statementIndex: activeResult.statementIndex,
    }, 0, true);
  }, [activeResult, loadResultPage]);

  const updateSql = useCallback((content: string): void => {
    if (!activeDocument) return;
    store.dispatch({ type: 'workspace/update-document', documentId: activeDocument.id, patch: { content, dirty: true } });
  }, [activeDocument, store]);

  const selectConnection = useCallback((connectionId: string): void => {
    const profile = state.connections.profiles.find(item => item.id === connectionId);
    store.dispatch({ type: 'connections/select', connectionId });
    if (activeDocument) store.dispatch({ type: 'workspace/update-document', documentId: activeDocument.id, patch: { connectionId, databaseKind: profile?.dbType ?? 'netezza' } });
  }, [activeDocument, state.connections.profiles, store]);

  const selectAuthoringDialect = useCallback((databaseKind: DatabaseKind): void => {
    if (activeDocument) store.dispatch({ type: 'workspace/update-document', documentId: activeDocument.id, patch: { databaseKind } });
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

  const detailColumns = useMemo(
    () => activeResult ? resolveDataGridColumns(activeResult.columns, activeRows) : [],
    [activeResult?.columns, activeRows],
  );

  const copySelected = useCallback(async (): Promise<void> => {
    const row = selectedRow === undefined ? visibleRows[0] : visibleRows[selectedRow];
    if (!row) return;
    const indexes = resolveDataGridColumnIndexes(detailColumns, activeResult?.view);
    const text = indexes.map(index => formatDataGridCellValue(row[index], detailColumns[index]?.type, detailColumns[index])).join('\t');
    if (typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(text);
    setNotice('Row copied.');
  }, [activeResult?.view, detailColumns, selectedRow, visibleRows]);

  const exportResults = useCallback((): void => {
    if (typeof document === 'undefined') return;
    const blob = new Blob([`${rowsAsCsv(activeResult?.columns ?? [], visibleRows)}\n`], { type: 'text/csv' });
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
    <strong>Connections</strong>{state.connections.profiles.map(profile => <button type="button" key={profile.id} aria-pressed={profile.id === selectedConnectionId} onClick={() => selectConnection(profile.id)}>{profile.name}</button>)}
    <SchemaTree nodes={visibleSchema} selectedId={state.metadata.selectedNodeId} expandedIds={state.metadata.expandedNodeIds} onToggle={toggleSchemaNode} onSelect={node => store.dispatch({ type: 'metadata/select', nodeId: node.id })} />
    <button type="button" onClick={onLogout}>Log out</button>
  </div>}>
    {state.shell.activeSurface === 'history' ? <HistoryView entries={historyItems} state={state.history.status === 'error' ? 'error' : state.history.status === 'loading' ? 'loading' : historyItems.length === 0 ? 'empty' : 'ready'} message={state.history.message} onOpen={entry => { const sourceId = sourceIdFor(user); const historyEntry = history.find(item => item.id === entry.id); const profile = historyEntry ? state.connections.profiles.find(item => item.id === historyEntry.connectionId) : undefined; store.dispatch({ type: 'workspace/open-document', document: { id: `history:${entry.id}`, sourceId, title: entry.label || 'History query', content: historyEntry?.sql ?? '', dirty: false, connectionId: historyEntry?.connectionId, databaseKind: profile?.dbType ?? runtimeDatabaseKind } }); store.dispatch({ type: 'shell/surface', surface: 'workspace' }); }} />
      : state.shell.activeSurface === 'explain' ? <ExplainView state={activeResult ? resultState : 'empty'} plan={activeResult?.message} message={resultMessage} onCancel={cancel} />
        : state.shell.activeSurface === 'designer' ? <DesignerForm fields={designerFields} capability={state.capabilities.find(capability => capability.key === 'designer')} onChange={() => undefined} onPreview={() => setNotice('Designer preview remains adapter-backed in shared mode.')} onApply={() => setNotice('Designer apply is guarded and unavailable for this read-only capability.')} />
          : <>
            <WorkspaceTabs tabs={state.workspace.documentOrder.map(id => ({ id, label: state.workspace.documents[id]?.title ?? id, dirty: state.workspace.documents[id]?.dirty }))} activeId={state.workspace.activeDocumentId} onSelect={id => store.dispatch({ type: 'workspace/select-document', documentId: id })} />
            <div className="shared-editor-stack"><SharedSqlEditor documentId={activeDocument?.id ?? DOCUMENT_ID} value={activeDocument?.content ?? ''} api={api} preferences={preferences} getContext={() => ({ connectionId: selectedConnection?.id, database: selectedConnection?.database, databaseKind: authoringDatabaseKind })} onChange={updateSql} onRun={() => void run()} onProblemsChange={setProblems} /><SharedSqlProblems problems={problems} onSelect={problem => setNotice(`SQL problem at line ${problem.startLineNumber}, column ${problem.startColumn}.`)} /></div>
            <div className="shared-result-panel">
              <div className="shared-editor-actions" role="toolbar" aria-label="SQL editor actions"><button type="button" onClick={() => void run()}>Run</button><button type="button" onClick={() => void run('explain')}>Explain</button><button type="button" onClick={() => void cancel()} disabled={!activeQueryRef.current}>Cancel</button><SqlDialectSelect value={authoringDatabaseKind} onChange={selectAuthoringDialect} ariaLabel="SQL authoring dialect" /></div>
              {notice && <div role="status">{notice}</div>}
              <ResultTabs results={Object.values(state.results.byResultSetId)} activeResultSetId={state.results.activeResultSetId} activeSourceId={state.results.activeSourceId} onSelect={(resultSetId, sourceId) => store.dispatch({ type: 'results/select', sourceId, resultSetId })} />
              {activeResult && <ResultViewToolbar columns={activeResult.columns} view={activeResult.view} onChange={updateResultView} onRefresh={() => void refresh()} onCopy={() => void copySelected()} onExport={exportResults} />}
              <AsyncStateView state={resultState} message={resultMessage} emptyLabel="No rows to display."><DataGrid sourceId={activeResult?.sourceId} resultSetId={activeResult?.resultSetId ?? 'empty'} columns={activeResult?.columns ?? []} rows={visibleRows} totalRowCount={activeResult?.totalRowCount} view={activeResult?.view} onViewChange={updateResultView} clientProcessing={false} selectedRowIndex={selectedRow} scroll={activeResult ? { sourceId: activeResult.sourceId, resultSetId: activeResult.resultSetId, top: activeResult.view.scrollTop, left: activeResult.view.scrollLeft, anchorRow: activeResult.view.anchorRow } : undefined} onScroll={onScroll} onLoadMore={loadMoreRows} onRowSelect={setSelectedRow} /></AsyncStateView>
              {selectedRow !== undefined && visibleRows[selectedRow] && activeResult && <RowDetail columns={detailColumns} row={visibleRows[selectedRow]} onClose={() => setSelectedRow(undefined)} />}
            </div>
          </>}
  </UiShell>;
}
