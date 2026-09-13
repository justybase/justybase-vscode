import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import type {
  CapabilityDescriptor,
  ConnectionProfileSummary,
  DatabaseKind,
  EditorPreferences,
  HistoryEntry,
  QueryAggregateFunction,
  QueryColumnFilterSpec,
  QueryEvent,
  QueryExportFormat,
  QueryGroupAggregate,
  QuerySortSpec,
  SchemaSearchResult,
  SchemaTreeNode,
  UiMode,
  WebUser,
} from '@justybase/contracts';
import { buildExplainQuery, buildTopRowsQuery, formatQueryObjectName, formatQuerySchemaName, quoteIdentifierForQuery } from '@justybase/dialect-utils';
import {
  createInitialUiState,
  createUiStore,
  createAggregateAnalysisTable,
  createGroupAnalysisTable,
  createPivotAnalysisTable,
  hasUiResultQuery,
  resultAsyncState as getResultAsyncState,
  resolveUiMode,
  toUiResultQueryOptions,
} from '@justybase/ui-core';
import type { UiResultColumn, UiResultEvent, UiResultSurfaceState, UiStore, UiSurface } from '@justybase/ui-core';
import {
  CellValueViewer,
  createDataGridClipboardPayload,
  formatDataGridClipboard,
  processDataGridRows,
  ExplainView,
  HistoryView,
  ResultPanel,
  resolveDataGridColumns,
  SchemaTree,
  SqlDialectSelect,
  UiShell,
  WorkspaceTabs,
} from '@justybase/ui-react';
import type { DataGridClipboardFormat, DataGridColumnFilterState, DataGridCopyPayload, DataGridFilterValueOption, GridScrollPosition, HistoryViewEntry, ResultAnalysisKind, ResultOutputTab } from '@justybase/ui-react';
import type { UiResultAnalysisTable } from '@justybase/ui-core';
import { ApiClientProvider } from './api';
import type { ApiClient, QueryEventSubscription } from './api';
import { SharedSqlEditor } from './SharedSqlEditor';
import { ObjectDesigner } from './ObjectDesigner';
import { ImportPanel } from './ImportPanel';
import { createWorkspaceStorage, migrateLegacyWorkspace, readLegacyWorkspaceValue, type WorkspaceStorage } from './workspacePersistence';
import { readSharedResultView, writeSharedResultView } from './sharedResultViewPersistence';
import { readSharedSchemaShortcuts, rememberSharedSchemaObject, sharedSchemaObjectIdentity, toggleSharedSchemaFavorite, writeSharedSchemaShortcuts } from './sharedSchemaPersistence';
import { ConnectionForm } from './workspacePanels';

const sharedCapabilities: readonly CapabilityDescriptor[] = [
  { key: 'workspace', status: 'available', owner: 'ui-core', documentation: 'Shared workspace state and presentation.', removalCondition: 'Keep the shared workspace owner.' },
  { key: 'results.read', status: 'available', owner: 'web-api-adapter', documentation: 'Read result pages and stream events from the API.', removalCondition: 'Keep the shared result port.' },
  { key: 'results.write', status: 'read-only', owner: 'web-api-adapter', reason: 'Writes require the guarded preview/apply workflow.', documentation: 'API guarded-write routes.', removalCondition: 'Expose the guarded write port in shared mode.' },
  { key: 'designer', status: 'available', owner: 'web-api-adapter', documentation: 'Guarded designer preview/apply API.', removalCondition: 'Keep the guarded designer workflow.' },
  { key: 'history', status: 'available', owner: 'web-api-adapter', documentation: 'User-scoped query history.', removalCondition: 'Keep the shared history port.' },
];

const DOCUMENT_ID = 'shared-scratch';
const RESULT_PAGE_SIZE = 10_000;
const SHARED_SCHEMA_FILTERS = [
  // Keep these labels identical to the VS Code schema explorer. In
  // particular, do not turn TABLE into the old web-only "TABLEs" label.
  { id: 'TABLE', label: 'TABLE' },
  { id: 'VIEW', label: 'VIEW' },
  { id: 'PROCEDURE', label: 'PROCEDURE' },
  { id: 'SYNONYM', label: 'SYNONYM' },
] as const;

function filterValueKey(value: unknown): string {
  if (value === undefined) return 'undefined';
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

function filterValueLabel(value: unknown): string {
  if (value === null || value === undefined) return '(Blanks)';
  if (typeof value === 'object') {
    try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
  }
  return String(value);
}

function filterOptionList(values: readonly unknown[]): DataGridFilterValueOption[] {
  const seen = new Set<string>();
  return values.flatMap(value => {
    const key = filterValueKey(value);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ key, value, label: filterValueLabel(value) }];
  }).sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' }));
}

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
  return { ...node, ...(parentId === undefined ? {} : { parentId }), kind } as const;
}

function mapSchemaSearchResult(item: SchemaSearchResult): SchemaTreeNode {
  const schema = item.schema ?? '';
  return {
    id: `search:${encodeURIComponent([item.database, schema, item.name, item.objectType].join('\u001f'))}`,
    kind: 'object',
    label: item.name,
    description: item.description,
    database: item.database,
    schema: item.schema,
    objectName: item.name,
    objectType: item.objectType,
    hasChildren: false,
  };
}

function mergeSchemaNodes<T extends { readonly id: string }>(previous: readonly T[], additions: readonly T[]): T[] {
  const merged = new Map(previous.map(node => [node.id, node] as const));
  for (const node of additions) merged.set(node.id, node);
  return [...merged.values()];
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

function resultQueryOptions(result: UiResultSurfaceState, view: UiResultSurfaceState['view']) {
  return toUiResultQueryOptions(result.columns, view);
}

function isNumericResultColumn(column: UiResultColumn | undefined): boolean {
  return /INT|DECIMAL|NUMERIC|NUMBER|REAL|FLOAT|DOUBLE|MONEY/u.test(column?.type?.toUpperCase() ?? '')
    || column?.inferredNumericKind !== undefined;
}

export function qualifySharedSchemaNode(node: SchemaTreeNode, databaseKind: DatabaseKind): string {
  if (node.kind === 'column') {
    const objectName = formatQueryObjectName({ database: node.database, schema: node.schema, objectName: node.objectName ?? node.label }, databaseKind);
    return `${objectName}.${quoteIdentifierForQuery(node.label, databaseKind)}`;
  }
  if (node.kind === 'object') return formatQueryObjectName({ database: node.database, schema: node.schema, objectName: node.objectName ?? node.label }, databaseKind);
  if (node.kind === 'schema') return formatQuerySchemaName(node.database, node.schema ?? node.label, databaseKind);
  return quoteIdentifierForQuery(node.database ?? node.label, databaseKind);
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

interface RunOverride {
  readonly sql: string;
  readonly connection: ConnectionProfileSummary;
  readonly database: string;
}

interface SharedDocumentContext {
  /** Database used for unqualified SQL in this document. */
  readonly database?: string;
  /** Optional schema used for unqualified SQL in this document. */
  readonly schema?: string;
  readonly connectionId?: string;
  readonly databaseKind?: DatabaseKind;
}

export interface SharedWebWorkspaceProps {
  readonly api: ApiClient;
  readonly user: WebUser;
  readonly onLogout: () => void;
}

/** Web composition root for shared mode; all effects stay in this adapter. */
export function SharedWebWorkspace({ api, user, onLogout }: SharedWebWorkspaceProps): ReactElement {
  const storageRef = useRef<{ readonly userId: string; readonly storage: WorkspaceStorage } | undefined>(undefined);
  if (!storageRef.current || storageRef.current.userId !== user.id) {
    storageRef.current = { userId: user.id, storage: createWorkspaceStorage(user.id) };
  }
  const workspaceStorage = storageRef.current.storage;
  const storeRef = useRef<UiStore | undefined>(undefined);
  if (!storeRef.current) storeRef.current = createSharedStore(user);
  const store = storeRef.current;
  const subscribe = useCallback((listener: () => void) => store.subscribe(() => listener()), [store]);
  const getSnapshot = useCallback(() => store.getState(), [store]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [rowsByResult, setRowsByResult] = useState<Record<string, readonly (readonly unknown[])[]>>({});
  const [clientProcessableResultKeys, setClientProcessableResultKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [preferences, setPreferences] = useState<EditorPreferences | null>(null);
  const [problems, setProblems] = useState<readonly import('./SharedSqlEditor').SharedSqlEditorProblem[]>([]);
  const [activeOutputTab, setActiveOutputTab] = useState<ResultOutputTab>('results');
  const [filterMenu, setFilterMenu] = useState<DataGridColumnFilterState | undefined>(undefined);
  const [schemaNodes, setSchemaNodes] = useState<ReturnType<typeof mapSchemaNode>[]>([]);
  const [schemaSearch, setSchemaSearch] = useState('');
  const [schemaSearchRevision, setSchemaSearchRevision] = useState(0);
  const [schemaSearchResults, setSchemaSearchResults] = useState<SchemaTreeNode[]>([]);
  const [schemaSearchLoading, setSchemaSearchLoading] = useState(false);
  const [schemaFilters, setSchemaFilters] = useState<readonly string[]>(SHARED_SCHEMA_FILTERS.map(filter => filter.id));
  const [schemaFavorites, setSchemaFavorites] = useState<SchemaTreeNode[]>([]);
  const [schemaRecent, setSchemaRecent] = useState<SchemaTreeNode[]>([]);
  const [schemaShortcutsReadyKey, setSchemaShortcutsReadyKey] = useState<string | undefined>(undefined);
  const [connectionEditor, setConnectionEditor] = useState<{ readonly initial?: ConnectionProfileSummary } | undefined>(undefined);
  const [designerTarget, setDesignerTarget] = useState<SchemaTreeNode | undefined>(undefined);
  const [selectedRow, setSelectedRow] = useState<number | undefined>(undefined);
  const [cellViewer, setCellViewer] = useState<{ readonly column: UiResultColumn; readonly value: unknown; readonly rowNumber: number } | undefined>(undefined);
  const [resultAnalysis, setResultAnalysis] = useState<UiResultAnalysisTable | undefined>(undefined);
  const [resultAnalysisLoading, setResultAnalysisLoading] = useState(false);
  const [resultAnalysisError, setResultAnalysisError] = useState<string | undefined>(undefined);
  const [importTarget, setImportTarget] = useState<SchemaTreeNode | undefined>(undefined);
  const [exportFormat, setExportFormat] = useState<QueryExportFormat>('csv');
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const editorRef = useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null);
  const rowsByResultRef = useRef(rowsByResult);
  const activeQueryRef = useRef<ActiveQuery | undefined>(undefined);
  const runGenerationRef = useRef(0);
  const queryByResultRef = useRef(new Map<string, string>());
  const pageHydrationRef = useRef(new Set<string>());
  const pageStateRef = useRef(new Map<string, { readonly totalRows: number; readonly hasMore: boolean }>());
  const schemaLoadedParentsRef = useRef(new Set<string>());
  const schemaLoadingParentsRef = useRef(new Set<string>());
  const schemaGenerationRef = useRef(0);
  const resultAnalysisGenerationRef = useRef(0);
  const restoredResultViewsRef = useRef(new Set<string>());
  const pendingResultViewWritesRef = useRef(new Map<string, { readonly timer: ReturnType<typeof setTimeout>; readonly write: () => void }>());
  const filterMenuGenerationRef = useRef(0);
  const selectedConnectionId = state.connections.selectedConnectionId;
  const selectedConnection = state.connections.profiles.find(profile => profile.id === selectedConnectionId);
  const activeDocument = state.workspace.activeDocumentId ? state.workspace.documents[state.workspace.activeDocumentId] : undefined;
  const runtimeDatabaseKind = selectedConnection?.dbType ?? 'netezza';
  const authoringDatabaseKind = activeDocument?.databaseKind ?? runtimeDatabaseKind;
  const activeResult = state.results.activeResultSetId
    ? Object.values(state.results.byResultSetId).find(result => result.sourceId === state.results.activeSourceId && result.resultSetId === state.results.activeResultSetId)
    : undefined;
  const activeRows = activeResult ? rowsByResult[activeResult.resultSetId] ?? [] : [];
  const activeResultKey = activeResult ? `${activeResult.sourceId}\u0000${activeResult.resultSetId}` : undefined;
  const clientProcessing = activeResultKey !== undefined && clientProcessableResultKeys.has(activeResultKey);
  const visibleRows = displayRows(activeResult, activeRows);
  const visibleSchema = visibleSchemaNodes(schemaNodes, state.metadata.expandedNodeIds);

  const flushResultViewWrites = useCallback((): void => {
    for (const [key, pending] of pendingResultViewWritesRef.current) {
      clearTimeout(pending.timer);
      pending.write();
      pendingResultViewWritesRef.current.delete(key);
    }
  }, []);

  const scheduleResultViewWrite = useCallback((result: UiResultSurfaceState, view: UiResultSurfaceState['view']): void => {
    const key = `${result.sourceId}\u0000${result.resultSetId}`;
    const previous = pendingResultViewWritesRef.current.get(key);
    if (previous) clearTimeout(previous.timer);
    const write = (): void => writeSharedResultView(workspaceStorage, user.id, result, view);
    const timer = setTimeout(() => {
      write();
      pendingResultViewWritesRef.current.delete(key);
    }, 180);
    pendingResultViewWritesRef.current.set(key, { timer, write });
  }, [user.id, workspaceStorage]);

  const reloadConnections = useCallback(async (preferredId?: string): Promise<void> => {
    store.dispatch({ type: 'connections/status', status: 'loading' });
    try {
      const profiles = (await api.connections()).map(redactedWebProfile);
      store.dispatch({ type: 'connections/set-profiles', profiles });
      const currentId = store.getState().connections.selectedConnectionId;
      const nextId = preferredId && profiles.some(profile => profile.id === preferredId)
        ? preferredId
        : profiles.some(profile => profile.id === currentId) ? currentId : profiles[0]?.id;
      store.dispatch({ type: 'connections/select', connectionId: nextId });
      const currentDocumentId = store.getState().workspace.activeDocumentId;
      const nextProfile = profiles.find(profile => profile.id === nextId);
      if (currentDocumentId) store.dispatch({
        type: 'workspace/update-document',
        documentId: currentDocumentId,
        patch: {
          connectionId: nextId,
          database: nextProfile?.database ?? '',
          schema: '',
          databaseKind: nextProfile?.dbType ?? 'netezza',
        },
      });
      store.dispatch({ type: 'connections/status', status: 'complete' });
    } catch (error: unknown) {
      store.dispatch({ type: 'connections/status', status: 'error', message: error instanceof Error ? error.message : 'Could not load connections.' });
    }
  }, [api, store]);

  const reloadHistory = useCallback(async (): Promise<void> => {
    store.dispatch({ type: 'history/status', status: 'loading' });
    try {
      setHistory(await api.history());
      store.dispatch({ type: 'history/status', status: 'complete' });
    } catch (error: unknown) {
      store.dispatch({ type: 'history/status', status: 'error', message: error instanceof Error ? error.message : 'Could not load history.' });
    }
  }, [api, store]);

  useEffect(() => {
    setSelectedRow(undefined);
  }, [activeResult?.sourceId, activeResult?.resultSetId]);

  useEffect(() => {
    resultAnalysisGenerationRef.current += 1;
    setResultAnalysis(undefined);
    setResultAnalysisError(undefined);
    setResultAnalysisLoading(false);
  }, [activeResult?.sourceId, activeResult?.resultSetId]);

  useEffect(() => () => {
    const active = activeQueryRef.current;
    active?.subscription?.close();
    if (active) void api.cancelQuery(active.queryId).catch(() => undefined);
    store.dispose();
  }, [api, store]);

  useEffect(() => {
    void reloadConnections();
  }, [reloadConnections]);

  useEffect(() => {
    let live = true;
    void api.editorPreferences().then(value => {
      if (live) setPreferences(value);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [api]);

  useEffect(() => {
    migrateLegacyWorkspace(workspaceStorage);
  }, [workspaceStorage]);

  useEffect(() => {
    if (!activeResult) return;
    const resultKey = `${activeResult.sourceId}\u0000${activeResult.resultSetId}`;
    if (restoredResultViewsRef.current.has(resultKey)) return;
    restoredResultViewsRef.current.add(resultKey);
    const queryId = queryByResultRef.current.get(activeResult.resultSetId);
    const restored = readSharedResultView(workspaceStorage, user.id, activeResult, queryId, activeResult.statementIndex);
    if (!restored) return;
    store.dispatch({ type: 'results/view', sourceId: activeResult.sourceId, resultSetId: activeResult.resultSetId, patch: restored.view });
    if (restored.migratedFromLegacy) scheduleResultViewWrite(activeResult, restored.view);
  }, [activeResult?.resultSetId, activeResult?.sourceId, activeResult?.statementIndex, scheduleResultViewWrite, store, user.id, workspaceStorage]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const flush = (): void => flushResultViewWrites();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flushResultViewWrites();
    };
  }, [flushResultViewWrites]);

  useEffect(() => {
    if (!selectedConnectionId) {
      setSchemaFavorites([]);
      setSchemaRecent([]);
      setSchemaShortcutsReadyKey(undefined);
      return;
    }
    const key = `${workspaceStorage.userId}:${selectedConnectionId}`;
    setSchemaShortcutsReadyKey(undefined);
    const shortcuts = readSharedSchemaShortcuts(
      workspaceStorage,
      selectedConnectionId,
      readLegacyWorkspaceValue(`jwb_schema_${selectedConnectionId}`),
    );
    setSchemaFavorites([...shortcuts.favorites]);
    setSchemaRecent([...shortcuts.recent]);
    setSchemaShortcutsReadyKey(key);
  }, [selectedConnectionId, workspaceStorage]);

  useEffect(() => {
    if (!selectedConnectionId || schemaShortcutsReadyKey !== `${workspaceStorage.userId}:${selectedConnectionId}`) return;
    writeSharedSchemaShortcuts(workspaceStorage, selectedConnectionId, { favorites: schemaFavorites, recent: schemaRecent });
  }, [schemaFavorites, schemaRecent, schemaShortcutsReadyKey, selectedConnectionId, workspaceStorage]);

  useEffect(() => {
    void reloadHistory();
  }, [reloadHistory]);

  const loadSchemaChildren = useCallback(async (parentId?: string, parent?: ReturnType<typeof mapSchemaNode>): Promise<readonly ReturnType<typeof mapSchemaNode>[]> => {
    if (!selectedConnectionId) return [];
    const key = parentId ?? '';
    if (schemaLoadingParentsRef.current.has(key)) return [];
    schemaLoadingParentsRef.current.add(key);
    const generation = schemaGenerationRef.current;
    store.dispatch({ type: 'metadata/status', status: 'loading' });
    try {
      const response = await api.schemaTree(selectedConnectionId, parentId);
      if (generation !== schemaGenerationRef.current || store.getState().connections.selectedConnectionId !== selectedConnectionId) return [];
      const nodes = response.nodes.map(node => mapSchemaNode(node, parent?.id));
      schemaLoadedParentsRef.current.add(key);
      setSchemaNodes(previous => mergeSchemaNodes(previous, nodes));
      store.dispatch({ type: 'metadata/status', status: 'complete' });
      return nodes;
    } catch (error: unknown) {
      if (generation === schemaGenerationRef.current && store.getState().connections.selectedConnectionId === selectedConnectionId) {
        store.dispatch({ type: 'metadata/status', status: 'error', message: error instanceof Error ? error.message : 'Could not load schema.' });
      }
      return [];
    } finally {
      schemaLoadingParentsRef.current.delete(key);
    }
  }, [api, selectedConnectionId, store]);

  useEffect(() => {
    schemaGenerationRef.current += 1;
    schemaLoadedParentsRef.current.clear();
    schemaLoadingParentsRef.current.clear();
    setSchemaNodes([]);
    setSchemaSearch('');
    setSchemaSearchResults([]);
    setSchemaSearchLoading(false);
    store.dispatch({ type: 'metadata/set-expanded', nodeIds: [] });
    if (selectedConnectionId) void loadSchemaChildren();
  }, [loadSchemaChildren, selectedConnectionId, store]);

  useEffect(() => {
    const term = schemaSearch.trim();
    if (!term || !selectedConnectionId || schemaFilters.length === 0) {
      setSchemaSearchResults([]);
      setSchemaSearchLoading(false);
      return undefined;
    }
    let live = true;
    setSchemaSearchLoading(true);
    const timer = window.setTimeout(() => {
      void api.searchSchema({
        connectionId: selectedConnectionId,
        term,
        objectTypes: [...schemaFilters],
        searchAllDatabases: true,
      }).then(response => {
        if (!live) return;
        setSchemaSearchResults(response.items.map(mapSchemaSearchResult));
      }).catch(error => {
        if (!live) return;
        setSchemaSearchResults([]);
        store.dispatch({ type: 'metadata/status', status: 'error', message: error instanceof Error ? error.message : 'Schema search failed.' });
      }).finally(() => {
        if (live) setSchemaSearchLoading(false);
      });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [api, schemaFilters, schemaSearch, schemaSearchRevision, selectedConnectionId, store]);

  const toggleSchemaNode = useCallback((node: ReturnType<typeof mapSchemaNode>): void => {
    const isExpanded = state.metadata.expandedNodeIds.includes(node.id);
    store.dispatch({ type: 'metadata/toggle-expanded', nodeId: node.id });
    if (isExpanded || !node.hasChildren || !selectedConnectionId || schemaLoadedParentsRef.current.has(node.id)) return;
    void loadSchemaChildren(node.id, node);
  }, [loadSchemaChildren, selectedConnectionId, state.metadata.expandedNodeIds, store]);

  const refreshSchema = useCallback((): void => {
    schemaGenerationRef.current += 1;
    schemaLoadedParentsRef.current.clear();
    schemaLoadingParentsRef.current.clear();
    setSchemaNodes([]);
    setSchemaSearchResults([]);
    setSchemaSearchRevision(previous => previous + 1);
    store.dispatch({ type: 'metadata/set-expanded', nodeIds: [] });
    if (selectedConnectionId) void loadSchemaChildren();
  }, [loadSchemaChildren, selectedConnectionId, store]);

  const collapseSchema = useCallback((): void => {
    store.dispatch({ type: 'metadata/set-expanded', nodeIds: [] });
  }, [store]);

  const expandSchema = useCallback(async (): Promise<void> => {
    if (!selectedConnectionId) return;
    const generation = schemaGenerationRef.current;
    const loadedByParent = new Map<string, readonly ReturnType<typeof mapSchemaNode>[]>();
    const currentNodes = [...schemaNodes];
    loadedByParent.set('', currentNodes.filter(node => node.parentId === undefined));
    const root = loadedByParent.get('') ?? [];
    if (root.length === 0) {
      const loadedRoot = await loadSchemaChildren();
      if (generation !== schemaGenerationRef.current) return;
      loadedByParent.set('', loadedRoot);
    }
    const expanded = new Set<string>();
    const visit = async (nodes: readonly ReturnType<typeof mapSchemaNode>[]): Promise<void> => {
      for (const node of nodes) {
        if (generation !== schemaGenerationRef.current) return;
        if (!node.hasChildren) continue;
        expanded.add(node.id);
        let children = loadedByParent.get(node.id);
        if (!children) {
          children = currentNodes.filter(candidate => candidate.parentId === node.id);
          if (children.length === 0 && !schemaLoadedParentsRef.current.has(node.id)) children = await loadSchemaChildren(node.id, node);
          loadedByParent.set(node.id, children);
        }
        await visit(children);
      }
    };
    await visit(loadedByParent.get('') ?? []);
    if (generation === schemaGenerationRef.current) store.dispatch({ type: 'metadata/set-expanded', nodeIds: [...expanded] });
  }, [loadSchemaChildren, schemaNodes, selectedConnectionId, store]);

  const dispatchQueryEvent = useCallback((active: ActiveQuery, event: QueryEvent, nextSequence: () => number): void => {
    const base = { sourceId: active.sourceId, executionId: active.executionId, resultSetId: active.resultSetId };
    let mapped: UiResultEvent | undefined;
    switch (event.type) {
      case 'started': mapped = { ...base, sequence: nextSequence(), type: 'started' }; break;
      case 'statement-started': mapped = { ...base, sequence: nextSequence(), type: 'statement-started' }; break;
      case 'columns': mapped = { ...base, sequence: nextSequence(), type: 'columns', columns: event.columns.map(mapQueryColumn) }; break;
      case 'rows': {
        const rows = rowsByResultRef.current[active.resultSetId] ?? [];
        // The stream is a progress channel. Keep only the first bounded page
        // here; the finalized page endpoint remains the source for scrolling
        // through large results and prevents a 150k-row query from causing a
        // render/copy of the complete result in the browser.
        const nextRows = [...rows, ...event.rows.map(row => [...row])].slice(0, RESULT_PAGE_SIZE);
        rowsByResultRef.current = { ...rowsByResultRef.current, [active.resultSetId]: nextRows };
        setRowsByResult(rowsByResultRef.current);
        mapped = { ...base, sequence: nextSequence(), type: 'rows', rowCount: nextRows.length, totalRowCount: event.totalRows };
        break;
      }
      case 'progress': mapped = { ...base, sequence: nextSequence(), type: 'progress', totalRowCount: event.totalRows }; break;
      case 'complete': {
        const current = Object.values(store.getState().results.byResultSetId)
          .find(result => result.sourceId === active.sourceId && result.resultSetId === active.resultSetId && result.executionId === active.executionId);
        const streamedRows = rowsByResultRef.current[active.resultSetId] ?? [];
        // A complete bounded stream is safe to process in the shared renderer.
        // Keep the marker tied to the unfiltered execution so clearing a
        // server-side filter on a large result cannot mistake a one-row page
        // for the complete source result.
        if (event.totalRows > 0 && streamedRows.length >= event.totalRows && current && !hasUiResultQuery(current.view)) {
          const resultKey = `${active.sourceId}\u0000${active.resultSetId}`;
          setClientProcessableResultKeys(previous => previous.has(resultKey) ? previous : new Set([...previous, resultKey]));
        }
        mapped = { ...base, sequence: nextSequence(), type: 'complete', totalRowCount: event.totalRows, message: event.message };
        break;
      }
      case 'error': mapped = { ...base, sequence: nextSequence(), type: 'error', message: event.message }; break;
      case 'cancelled': mapped = { ...base, sequence: nextSequence(), type: 'cancelled', totalRowCount: event.totalRows }; break;
      case 'session':
      case 'batch-complete':
        break;
    }
    if (mapped) store.dispatch({ type: 'execution/event', event: mapped });
  }, [store]);

  const resultViewRequestKey = useCallback((view: UiResultSurfaceState['view']): string => JSON.stringify({
    globalFilter: view.globalFilter,
    columnFilters: view.columnFilters,
    columnFilterDefinitions: view.columnFilterDefinitions,
    sorting: view.sorting,
  }), []);

  const loadResultPage = useCallback(async (active: ActiveQuery, offset: number, replace: boolean, requestedView?: UiResultSurfaceState['view']): Promise<void> => {
    const currentBeforeRequest = Object.values(store.getState().results.byResultSetId)
      .find(result => result.sourceId === active.sourceId && result.resultSetId === active.resultSetId && result.executionId === active.executionId);
    const view = requestedView ?? currentBeforeRequest?.view;
    const viewKey = view ? resultViewRequestKey(view) : '';
    const queryOptions = currentBeforeRequest && view ? resultQueryOptions(currentBeforeRequest, view) : {};
    const hydrationKey = `${active.sourceId}\u0000${active.resultSetId}\u0000${active.queryId}\u0000${offset}\u0000${viewKey}`;
    if (pageHydrationRef.current.has(hydrationKey)) return;
    pageHydrationRef.current.add(hydrationKey);
    try {
      const page = await api.queryPage(active.queryId, { statementIndex: active.statementIndex, offset, limit: RESULT_PAGE_SIZE, ...queryOptions });
      if (queryByResultRef.current.get(active.resultSetId) !== active.queryId) return;
      const current = Object.values(store.getState().results.byResultSetId)
        .find(result => result.sourceId === active.sourceId && result.resultSetId === active.resultSetId);
      if (!current || current.executionId !== active.executionId || view && resultViewRequestKey(current.view) !== viewKey) return;
      const pageRows = page.rows.map(row => [...row]);
      if (page.totalRows > 0 && pageRows.length >= page.totalRows && view && !hasUiResultQuery(view)) {
        const resultKey = `${active.sourceId}\u0000${active.resultSetId}`;
        setClientProcessableResultKeys(previous => previous.has(resultKey) ? previous : new Set([...previous, resultKey]));
      }
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
  }, [api, resultViewRequestKey, store]);

  const hydrateResultPage = useCallback((active: ActiveQuery): void => {
    void loadResultPage(active, 0, true);
  }, [loadResultPage]);

  const run = useCallback(async (mode: 'single' | 'explain' = 'single', override?: RunOverride): Promise<void> => {
    const connection = override?.connection ?? selectedConnection;
    // Monaco owns the live document while the user is typing. Read it
    // directly so Run never races the editor's debounced React persistence.
    const sql = override?.sql ?? editorRef.current?.getModel()?.getValue() ?? activeDocument?.content ?? '';
    if (!connection) {
      setNotice('Select a connection before running SQL.');
      return;
    }
    if (!sql.trim()) {
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
      const started = await api.startQuery({ connectionId: connection.id, database: override?.database ?? connection.database, sql, mode });
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

  const loadMoreRows = useCallback(async (): Promise<void> => {
    if (!activeResult) return;
    const queryId = queryByResultRef.current.get(activeResult.resultSetId);
    if (!queryId) return;
    const loadedRows = rowsByResultRef.current[activeResult.resultSetId]?.length ?? 0;
    const pageState = pageStateRef.current.get(activeResult.resultSetId);
    const totalRows = pageState?.totalRows ?? activeResult.totalRowCount;
    if (!pageState?.hasMore && pageState !== undefined) return;
    if (loadedRows >= totalRows) return;
    await loadResultPage({
      queryId,
      resultSetId: activeResult.resultSetId,
      sourceId: activeResult.sourceId,
      executionId: activeResult.executionId,
      statementIndex: activeResult.statementIndex,
    }, loadedRows, false);
  }, [activeResult, loadResultPage]);

  const openSharedDocument = useCallback((id: string, title: string, content: string, context: SharedDocumentContext = {}): void => {
    if (!selectedConnection) {
      setNotice('Select a connection before opening a schema document.');
      return;
    }
    store.dispatch({
      type: 'workspace/open-document',
      document: {
        id,
        sourceId: id,
        title,
        content,
        dirty: false,
        connectionId: context.connectionId ?? selectedConnection.id,
        database: context.database ?? selectedConnection.database,
        schema: context.schema,
        databaseKind: context.databaseKind ?? authoringDatabaseKind,
      },
    });
    store.dispatch({ type: 'shell/surface', surface: 'workspace' });
  }, [authoringDatabaseKind, selectedConnection, store]);

  const openHistoryEntry = useCallback((entry: HistoryViewEntry): void => {
    const historyEntry = history.find(item => item.id === entry.id);
    if (!historyEntry) return;
    const profile = state.connections.profiles.find(item => item.id === historyEntry.connectionId);
    const sourceId = sourceIdFor(user);
    store.dispatch({
      type: 'workspace/open-document',
      document: {
        id: `history:${historyEntry.id}`,
        sourceId,
        title: entry.label || 'History query',
        content: historyEntry.sql,
        dirty: false,
        connectionId: profile?.id ?? historyEntry.connectionId,
        database: historyEntry.database ?? profile?.database,
        schema: '',
        databaseKind: profile?.dbType ?? runtimeDatabaseKind,
      },
    });
    store.dispatch({ type: 'shell/surface', surface: 'workspace' });
  }, [history, runtimeDatabaseKind, state.connections.profiles, store, user]);

  const rerunHistoryEntry = useCallback((entry: HistoryViewEntry): void => {
    const historyEntry = history.find(item => item.id === entry.id);
    const profile = historyEntry ? state.connections.profiles.find(item => item.id === historyEntry.connectionId) : undefined;
    if (!historyEntry || !profile) {
      setNotice('The connection used by this history entry is no longer available.');
      return;
    }
    openHistoryEntry(entry);
    void run('single', { sql: historyEntry.sql, connection: profile, database: historyEntry.database });
  }, [history, openHistoryEntry, run, state.connections.profiles]);

  const copyHistoryEntry = useCallback((entry: HistoryViewEntry): void => {
    const historyEntry = history.find(item => item.id === entry.id);
    if (!historyEntry?.sql) return;
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      setNotice('Clipboard access is unavailable.');
      return;
    }
    void navigator.clipboard.writeText(historyEntry.sql).then(() => setNotice('History SQL copied.')).catch(() => setNotice('Could not copy history SQL.'));
  }, [history]);

  const openSchemaQuery = useCallback((node: SchemaTreeNode): void => {
    if (node.kind !== 'object') return;
    const sql = buildTopRowsQuery({ database: node.database, schema: node.schema, objectName: node.objectName ?? node.label }, authoringDatabaseKind);
    const title = `Top 1000 · ${node.label}`;
    openSharedDocument(`schema:${node.id}:top`, title, sql, { database: node.database, schema: node.schema });
    if (selectedConnection) void run('single', { sql, connection: selectedConnection, database: node.database ?? selectedConnection.database });
  }, [authoringDatabaseKind, openSharedDocument, run, selectedConnection]);

  const explainSchemaObject = useCallback((node: SchemaTreeNode): void => {
    if (node.kind !== 'object') return;
    const sql = buildTopRowsQuery({ database: node.database, schema: node.schema, objectName: node.objectName ?? node.label }, authoringDatabaseKind);
    const title = `Explain · ${node.label}`;
    openSharedDocument(`schema:${node.id}:explain`, title, sql, { database: node.database, schema: node.schema });
    store.dispatch({ type: 'shell/surface', surface: 'explain' });
    if (selectedConnection) {
      try {
        buildExplainQuery(sql, authoringDatabaseKind);
        void run('explain', { sql, connection: selectedConnection, database: node.database ?? selectedConnection.database });
      } catch (error: unknown) {
        setNotice(error instanceof Error ? error.message : 'Explain plans are not available for this connection.');
      }
    }
  }, [authoringDatabaseKind, openSharedDocument, run, selectedConnection, store]);

  const openSchemaDdl = useCallback(async (node: SchemaTreeNode): Promise<void> => {
    if (node.kind !== 'object' || !selectedConnection || !node.schema) return;
    try {
      const result = await api.ddl({
        connectionId: selectedConnection.id,
        database: node.database ?? selectedConnection.database,
        schema: node.schema,
        objectName: node.objectName ?? node.label,
        objectType: node.objectType?.toUpperCase() || 'TABLE',
      });
      if (!result.success || !result.ddlCode) throw new Error(result.error ?? 'The database returned no DDL.');
      openSharedDocument(`schema:${node.id}:ddl`, `DDL · ${node.label}`, result.ddlCode, { database: node.database, schema: node.schema });
      setNotice(result.ddlFidelity === 'reconstructed' ? 'Reconstructed DDL opened; review metadata warnings before executing it.' : 'DDL opened.');
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : 'Could not generate DDL.');
    }
  }, [api, openSharedDocument, selectedConnection]);

  const copySchemaDdl = useCallback(async (node: SchemaTreeNode): Promise<void> => {
    if (node.kind !== 'object' || !selectedConnection || !node.schema) return;
    try {
      const result = await api.ddl({
        connectionId: selectedConnection.id,
        database: node.database ?? selectedConnection.database,
        schema: node.schema,
        objectName: node.objectName ?? node.label,
        objectType: node.objectType?.toUpperCase() || 'TABLE',
      });
      if (!result.success || !result.ddlCode) throw new Error(result.error ?? 'The database returned no DDL.');
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(result.ddlCode);
      setNotice(result.ddlFidelity === 'reconstructed'
        ? 'Reconstructed DDL copied; review metadata warnings before executing it.'
        : 'DDL copied.');
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : 'Could not copy DDL.');
    }
  }, [api, selectedConnection]);

  const openSchemaDesigner = useCallback((node: SchemaTreeNode): void => {
    if (node.kind !== 'object' || !selectedConnection || !node.schema) {
      setNotice('Select a schema object before opening the designer.');
      return;
    }
    setDesignerTarget(node);
  }, [selectedConnection]);

  const insertSchemaNode = useCallback((node: SchemaTreeNode): void => {
    if (!activeDocument) return;
    const value = qualifySharedSchemaNode(node, authoringDatabaseKind);
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (editor && model) {
      const selection = editor.getSelection() ?? model.getFullModelRange();
      const beforeCursor = model.getValue().slice(0, model.getOffsetAt({ lineNumber: selection.startLineNumber, column: selection.startColumn }));
      const separator = beforeCursor.length === 0 || /[\s(.,]$/u.test(beforeCursor) ? '' : ' ';
      editor.executeEdits('schema-insert', [{ range: selection, text: `${separator}${value}`, forceMoveMarkers: true }]);
      editor.focus();
      return;
    }
    const separator = activeDocument.content.length === 0 || /[\s(.,]$/u.test(activeDocument.content) ? '' : ' ';
    store.dispatch({ type: 'workspace/update-document', documentId: activeDocument.id, patch: { content: `${activeDocument.content}${separator}${value}`, dirty: true } });
  }, [activeDocument, authoringDatabaseKind, store]);

  const activateSchemaNode = useCallback((node: SchemaTreeNode): void => {
    if (node.kind === 'object') setSchemaRecent(previous => [...rememberSharedSchemaObject(previous, node)]);
    if (node.kind === 'object' || node.kind === 'column') insertSchemaNode(node);
  }, [insertSchemaNode]);

  const toggleSchemaFavorite = useCallback((node: SchemaTreeNode): void => {
    setSchemaFavorites(previous => [...toggleSharedSchemaFavorite(previous, node)]);
  }, []);

  const copySchemaName = useCallback((node: SchemaTreeNode): void => {
    const value = qualifySharedSchemaNode(node, authoringDatabaseKind);
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      setNotice('Clipboard access is unavailable.');
      return;
    }
    void navigator.clipboard.writeText(value).then(() => setNotice('Qualified name copied.')).catch(() => setNotice('Could not copy the qualified name.'));
  }, [authoringDatabaseKind]);

  const revealProblem = useCallback((problem: import('./SharedSqlEditor').SharedSqlEditorProblem): void => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(problem.startLineNumber);
    editor.setPosition({ lineNumber: problem.startLineNumber, column: problem.startColumn });
    editor.focus();
  }, []);

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
    if (activeDocument) store.dispatch({
      type: 'workspace/update-document',
      documentId: activeDocument.id,
      patch: { connectionId, database: profile?.database ?? '', schema: '', databaseKind: profile?.dbType ?? 'netezza' },
    });
  }, [activeDocument, state.connections.profiles, store]);

  const saveConnection = useCallback((profile: ConnectionProfileSummary): void => {
    setConnectionEditor(undefined);
    setNotice(`Connection “${profile.name}” saved.`);
    void reloadConnections(profile.id);
  }, [reloadConnections]);

  const deleteConnection = useCallback(async (profile: ConnectionProfileSummary): Promise<void> => {
    if (typeof window !== 'undefined' && !window.confirm(`Delete connection “${profile.name}”?`)) return;
    try {
      await api.deleteConnection(profile.id);
      setNotice(`Connection “${profile.name}” deleted.`);
      await reloadConnections();
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : 'Could not delete connection.');
    }
  }, [api, reloadConnections]);

  const selectAuthoringDialect = useCallback((databaseKind: DatabaseKind): void => {
    if (activeDocument) store.dispatch({ type: 'workspace/update-document', documentId: activeDocument.id, patch: { databaseKind } });
  }, [activeDocument, store]);

  const selectSurface = useCallback((surface: string): void => {
    if (['workspace', 'editor', 'results', 'schema', 'history', 'explain', 'designer'].includes(surface)) store.dispatch({ type: 'shell/surface', surface: surface as UiSurface });
  }, [store]);

  const closeResultAnalysis = useCallback((): void => {
    resultAnalysisGenerationRef.current += 1;
    setResultAnalysis(undefined);
    setResultAnalysisError(undefined);
    setResultAnalysisLoading(false);
  }, []);

  const toggleResultAnalysis = useCallback((kind: ResultAnalysisKind): void => {
    if (resultAnalysis?.kind === kind) {
      closeResultAnalysis();
      return;
    }
    const result = activeResult;
    const queryId = result ? queryByResultRef.current.get(result.resultSetId) ?? result.executionId : undefined;
    if (!result || !queryId) {
      setResultAnalysis(undefined);
      setResultAnalysisError('This result cannot be analysed because its query session is unavailable.');
      return;
    }
    const generation = ++resultAnalysisGenerationRef.current;
    setResultAnalysis(undefined);
    setResultAnalysisError(undefined);
    setResultAnalysisLoading(true);
    const options = resultQueryOptions(result, result.view);
    void (async (): Promise<void> => {
      try {
        if (kind === 'aggregate') {
          const response = await api.aggregate(queryId, {
            statementIndex: result.statementIndex,
            ...options,
            functions: ['count', 'sum', 'avg', 'min', 'max'] as QueryAggregateFunction[],
          });
          if (generation !== resultAnalysisGenerationRef.current) return;
          setResultAnalysis(createAggregateAnalysisTable(result.columns, response));
        } else if (kind === 'group') {
          const groupByColumnIndices = result.columns.length > 0 ? [0] : [];
          if (groupByColumnIndices.length === 0) throw new Error('This result has no columns to group.');
          const aggregates: QueryGroupAggregate[] = [
            { function: 'count' },
            ...result.columns.flatMap((column, columnIndex) => isNumericResultColumn(column) ? [{ function: 'sum' as const, columnIndex }] : []),
          ];
          const response = await api.group(queryId, {
            statementIndex: result.statementIndex,
            ...options,
            groupByColumnIndices,
            aggregates,
            groupLimit: 2_000,
          });
          if (generation !== resultAnalysisGenerationRef.current) return;
          setResultAnalysis(createGroupAnalysisTable(response));
        } else {
          if (result.columns.length < 3) throw new Error('Pivot requires at least three columns.');
          const valueColumnIndex = result.columns.findIndex((column, index) => index > 1 && isNumericResultColumn(column));
          if (valueColumnIndex < 0) throw new Error('Pivot requires a numeric value column after the row and pivot columns.');
          const response = await api.group(queryId, {
            statementIndex: result.statementIndex,
            ...options,
            groupByColumnIndices: [0, 1],
            aggregates: [{ function: 'sum', columnIndex: valueColumnIndex }],
            groupLimit: 2_000,
          });
          if (generation !== resultAnalysisGenerationRef.current) return;
          setResultAnalysis(createPivotAnalysisTable(result.columns, response, 0, 1, valueColumnIndex));
        }
        if (generation === resultAnalysisGenerationRef.current) setResultAnalysisError(undefined);
      } catch (error: unknown) {
        if (generation !== resultAnalysisGenerationRef.current) return;
        setResultAnalysis(undefined);
        setResultAnalysisError(error instanceof Error ? error.message : 'Could not analyse result.');
      } finally {
        if (generation === resultAnalysisGenerationRef.current) setResultAnalysisLoading(false);
      }
    })();
  }, [activeResult, api, closeResultAnalysis, resultAnalysis]);

  const updateResultView = useCallback((patch: Partial<UiResultSurfaceState['view']>): void => {
    if (!activeResult) return;
    if (resultAnalysis && ('globalFilter' in patch || 'columnFilters' in patch || 'sorting' in patch)) closeResultAnalysis();
    const nextView = { ...activeResult.view, ...patch };
    store.dispatch({ type: 'results/view', sourceId: activeResult.sourceId, resultSetId: activeResult.resultSetId, patch });
    scheduleResultViewWrite(activeResult, nextView);
    if ((patch.globalFilter !== undefined || patch.columnFilters !== undefined || patch.columnFilterDefinitions !== undefined || patch.sorting !== undefined) && !clientProcessing) {
      const queryId = queryByResultRef.current.get(activeResult.resultSetId);
      if (queryId) {
        pageHydrationRef.current.clear();
        pageStateRef.current.delete(activeResult.resultSetId);
        rowsByResultRef.current = { ...rowsByResultRef.current, [activeResult.resultSetId]: [] };
        setRowsByResult(rowsByResultRef.current);
        void loadResultPage({
          queryId,
          resultSetId: activeResult.resultSetId,
          sourceId: activeResult.sourceId,
          executionId: activeResult.executionId,
          statementIndex: activeResult.statementIndex,
        }, 0, true, nextView);
      }
    }
  }, [activeResult, clientProcessing, closeResultAnalysis, loadResultPage, resultAnalysis, scheduleResultViewWrite, store]);

  const closeColumnFilter = useCallback((): void => {
    filterMenuGenerationRef.current += 1;
    setFilterMenu(undefined);
  }, []);

  const openColumnFilter = useCallback(async (request: import('@justybase/ui-react').DataGridColumnFilterRequest): Promise<void> => {
    if (!activeResult) return;
    const generation = ++filterMenuGenerationRef.current;
    const key = request.column.name || String(request.columnIndex);
    const saved = activeResult.view.columnFilterDefinitions?.[key];
    const anchor = request.anchor;
    const popupWidth = Math.min(340, Math.max(240, window.innerWidth - 20));
    const popupHeight = Math.min(520, Math.max(160, window.innerHeight - 20));
    const margin = 10;
    const gap = 5;
    const left = Math.min(Math.max(margin, anchor.left), Math.max(margin, window.innerWidth - popupWidth - margin));
    const below = Math.max(0, window.innerHeight - anchor.bottom - margin - gap);
    const above = Math.max(0, anchor.top - margin - gap);
    const top = Math.max(margin, Math.min(above >= below && below < 280 ? anchor.top - popupHeight - gap : anchor.bottom + gap, window.innerHeight - popupHeight - margin));
    setFilterMenu({
      columnIndex: request.columnIndex,
      columnName: request.column.name,
      left,
      top,
      options: [],
      selectedKeys: saved?.operator === 'in' ? (saved.values ?? []).map(filterValueKey) : [],
      operator: saved?.operator ?? 'in',
      value: saved?.value ?? '',
      search: '',
      loading: true,
      truncated: false,
    });
    try {
      const queryId = queryByResultRef.current.get(activeResult.resultSetId);
      let values: readonly unknown[];
      let truncated = false;
      if (queryId) {
        const filters = { ...activeResult.view.columnFilters };
        delete filters[key];
        const definitions = { ...(activeResult.view.columnFilterDefinitions ?? {}) };
        delete definitions[key];
        const response = await api.distinct(queryId, {
          statementIndex: activeResult.statementIndex,
          columnIndex: request.columnIndex,
          limit: 500,
          ...resultQueryOptions(activeResult, { ...activeResult.view, columnFilters: filters, columnFilterDefinitions: definitions }),
        });
        values = response.values;
        truncated = response.truncated;
      } else {
        values = activeRows.map(row => row[request.columnIndex]);
      }
      if (generation !== filterMenuGenerationRef.current) return;
      const options = filterOptionList(values);
      const selectedKeys = saved?.operator === 'in'
        ? (saved.values ?? []).map(filterValueKey).filter(valueKey => options.some(option => option.key === valueKey))
        : options.map(option => option.key);
      setFilterMenu(current => current && current.columnIndex === request.columnIndex ? { ...current, options, selectedKeys, loading: false, truncated } : current);
    } catch (error: unknown) {
      if (generation !== filterMenuGenerationRef.current) return;
      setFilterMenu(current => current && current.columnIndex === request.columnIndex ? { ...current, loading: false, error: error instanceof Error ? error.message : 'Could not load column values.' } : current);
    }
  }, [activeResult, activeRows, api]);

  const updateColumnFilterMenu = useCallback((patch: Partial<DataGridColumnFilterState>): void => {
    setFilterMenu(current => current ? { ...current, ...patch } : current);
  }, []);

  const applyColumnFilter = useCallback((): void => {
    const menu = filterMenu;
    if (!menu || !activeResult) return;
    const key = menu.columnName || String(menu.columnIndex);
    const nextDefinitions = { ...(activeResult.view.columnFilterDefinitions ?? {}) };
    const nextFilters = { ...activeResult.view.columnFilters };
    delete nextDefinitions[key];
    delete nextFilters[key];
    if (menu.operator === 'in') {
      const selected = menu.options.filter(option => menu.selectedKeys.includes(option.key));
      const allLoadedValuesSelected = selected.length === menu.options.length && !menu.truncated;
      if (selected.length > 0 && !allLoadedValuesSelected) {
        nextDefinitions[key] = { operator: 'in', value: `${selected.length} selected`, values: selected.map(option => option.value) };
        nextFilters[key] = `${selected.length} selected`;
      }
    } else if (menu.operator === 'isNull' || menu.operator === 'isNotNull') {
      nextDefinitions[key] = { operator: menu.operator, value: menu.operator };
      nextFilters[key] = menu.operator;
    } else if (menu.value.trim()) {
      nextDefinitions[key] = { operator: menu.operator, value: menu.value.trim() };
      nextFilters[key] = menu.value.trim();
    }
    updateResultView({ columnFilters: nextFilters, columnFilterDefinitions: nextDefinitions });
    closeColumnFilter();
  }, [activeResult, closeColumnFilter, filterMenu, updateResultView]);

  const clearColumnFilter = useCallback((): void => {
    const menu = filterMenu;
    if (!menu || !activeResult) return;
    const key = menu.columnName || String(menu.columnIndex);
    const columnFilters = { ...activeResult.view.columnFilters };
    const columnFilterDefinitions = { ...(activeResult.view.columnFilterDefinitions ?? {}) };
    delete columnFilters[key];
    delete columnFilterDefinitions[key];
    updateResultView({ columnFilters, columnFilterDefinitions });
    closeColumnFilter();
  }, [activeResult, closeColumnFilter, filterMenu, updateResultView]);

  useEffect(() => {
    if (!filterMenu) return undefined;
    const closeOnOutsideClick = (event: MouseEvent): void => {
      const target = event.target;
      if (target instanceof Element && (target.closest('.ui-data-grid-filter-menu') || target.closest('.ui-data-grid-filter-action'))) return;
      closeColumnFilter();
    };
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') closeColumnFilter(); };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [closeColumnFilter, filterMenu]);

  const onScroll = useCallback((position: GridScrollPosition): void => {
    if (!activeResult || position.resultSetId !== activeResult.resultSetId
      || (position.top === activeResult.view.scrollTop
        && position.left === activeResult.view.scrollLeft
        && position.anchorRow === activeResult.view.anchorRow)) return;
    updateResultView({ scrollTop: position.top, scrollLeft: position.left, anchorRow: position.anchorRow });
  }, [activeResult, updateResultView]);

  const detailColumns = useMemo(
    () => activeResult ? resolveDataGridColumns(activeResult.columns, activeRows) : [],
    [activeResult?.columns, activeRows],
  );

  const openCellValue = useCallback((context: import('@justybase/ui-react').DataGridCellContext): void => {
    const column = activeResult?.columns[context.columnIndex];
    const value = activeRows[context.rowIndex]?.[context.columnIndex];
    if (!column || value === undefined && activeRows[context.rowIndex] === undefined) return;
    setCellViewer({ column, value, rowNumber: context.rowIndex + 1 });
  }, [activeResult?.columns, activeRows]);

  const openAnalysisCellValue = useCallback((context: import('@justybase/ui-react').DataGridCellContext): void => {
    const column = resultAnalysis?.columns[context.columnIndex];
    const row = resultAnalysis?.rows[context.rowIndex];
    if (!column || !row) return;
    setCellViewer({ column, value: row[context.columnIndex], rowNumber: context.rowIndex + 1 });
  }, [resultAnalysis]);

  const copyGridPayload = useCallback(async (payload: DataGridCopyPayload, format: DataGridClipboardFormat = 'text'): Promise<void> => {
    const options = { includeHeaders: payload.includeHeaders ?? true };
    const formatted = createDataGridClipboardPayload(payload, options);
    const plainText = formatDataGridClipboard(payload, format, options);
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setNotice('Clipboard access is unavailable.');
      return;
    }
    try {
      if (typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard.write === 'function') {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([formatted.html], { type: 'text/html' }),
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
        })]);
      } else if (typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(plainText);
      } else {
        setNotice('Clipboard access is unavailable.');
        return;
      }
      setNotice('Copied.');
    } catch {
      try {
        await navigator.clipboard.writeText(plainText);
        setNotice('Copied.');
      } catch {
        setNotice('Could not copy to the clipboard.');
      }
    }
  }, []);

  const copyGridSelection = useCallback((payload: DataGridCopyPayload, format?: DataGridClipboardFormat): void => {
    void copyGridPayload(payload, format);
  }, [copyGridPayload]);

  const copyCellValue = useCallback((): void => {
    const item = cellViewer;
    if (!item) return;
    void copyGridPayload({ columns: [item.column], rows: [[item.value]], includeHeaders: false });
  }, [cellViewer, copyGridPayload]);

  const copySelected = useCallback(async (): Promise<void> => {
    if (!activeResult) return;
    const row = selectedRow === undefined ? activeRows[0] : activeRows[selectedRow];
    if (!row) return;
    await copyGridPayload({ columns: activeResult.columns, rows: [row] });
  }, [activeResult, activeRows, copyGridPayload, selectedRow]);

  const exportResults = useCallback(async (): Promise<void> => {
    if (!activeResult || typeof document === 'undefined') return;
    const queryId = queryByResultRef.current.get(activeResult.resultSetId) ?? activeResult.executionId;
    if (!queryId) {
      setNotice('Result export is unavailable for this result.');
      return;
    }
    const columnFilters: QueryColumnFilterSpec[] = Object.entries(activeResult.view.columnFilters)
      .flatMap(([column, value]) => {
        const columnIndex = activeResult.columns.findIndex((item, index) => item.name === column || String(index) === column);
        return columnIndex >= 0 && value.trim() ? [{ columnIndex, value }] : [];
      });
    const sorting: QuerySortSpec[] = activeResult.view.sorting.flatMap(item => {
      const columnIndex = activeResult.columns.findIndex((column, index) => column.name === item.column || String(index) === item.column);
      return columnIndex >= 0 ? [{ columnIndex, desc: item.descending }] : [];
    });
    try {
      const downloaded = await api.exportQuery(queryId, {
        statementIndex: activeResult.statementIndex,
        format: exportFormat,
        globalFilter: activeResult.view.globalFilter,
        columnFilters,
        sorting,
      });
      const url = URL.createObjectURL(downloaded.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = downloaded.fileName;
      link.click();
      const revokeObjectUrl = URL.revokeObjectURL;
      if (typeof revokeObjectUrl === 'function') window.setTimeout(() => revokeObjectUrl(url), 100);
      setNotice('Result exported.');
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : 'Could not export results.');
    }
  }, [activeResult, api, exportFormat]);

  const historyItems: HistoryViewEntry[] = useMemo(() => history.map(entry => ({ id: entry.id, label: entry.sql.slice(0, 80), status: entry.status, sqlFingerprint: `${entry.createdAt} · ${entry.rowCount} rows · ${entry.durationMs} ms`, sql: entry.sql, createdAt: entry.createdAt, rowCount: entry.rowCount, durationMs: entry.durationMs, connectionId: entry.connectionId })), [history]);
  const selectedNode = state.metadata.selectedNodeId
    ? schemaNodes.find(node => node.id === state.metadata.selectedNodeId) ?? schemaSearchResults.find(node => node.id === state.metadata.selectedNodeId)
    : undefined;
  const resultState = resultAsyncState(activeResult, visibleRows.length);
  const resultMessage = activeResult?.message;

  return <UiShell title="JustyBase" activeSurface={state.shell.activeSurface} onSurfaceChange={selectSurface} surfaces={[{ id: 'workspace', label: 'Workspace' }, { id: 'history', label: 'History' }, { id: 'explain', label: 'Explain' }, { id: 'designer', label: 'Designer' }]} sidebar={<div className="shared-sidebar">
    <section className="shared-connections" aria-label="Connections"><div className="shared-sidebar-heading"><strong>Connections</strong><span>{state.connections.profiles.length}</span><button type="button" aria-label="Add connection" title="Add connection" onClick={() => setConnectionEditor({})}>＋</button></div>{state.connections.profiles.length === 0 ? <div className="shared-sidebar-empty">No connections configured.<button type="button" onClick={() => setConnectionEditor({})}>Add connection</button></div> : state.connections.profiles.map(profile => <div className="shared-connection-item" key={profile.id}><button type="button" className={profile.id === selectedConnectionId ? 'active' : ''} aria-label={profile.name} aria-pressed={profile.id === selectedConnectionId} onClick={() => selectConnection(profile.id)}><span className="shared-connection-dot" /><span>{profile.name}</span><small>{profile.dbType}</small></button><div className="shared-connection-actions"><button type="button" aria-label={`Edit ${profile.name} connection`} title="Edit connection" onClick={() => setConnectionEditor({ initial: profile })}>✎</button><button type="button" aria-label={`Delete ${profile.name} connection`} title="Delete connection" onClick={() => void deleteConnection(profile)}>×</button></div></div>)}</section>
    <SchemaTree
      nodes={visibleSchema}
      selectedId={state.metadata.selectedNodeId}
      expandedIds={state.metadata.expandedNodeIds}
      onToggle={toggleSchemaNode}
      onSelect={node => store.dispatch({ type: 'metadata/select', nodeId: node.id })}
      onActivate={activateSchemaNode}
      onInsert={insertSchemaNode}
      onOpenQuery={openSchemaQuery}
      onOpenExplain={explainSchemaObject}
      onOpenDesigner={node => openSchemaDesigner(node as SchemaTreeNode)}
      onOpenDdl={node => { void openSchemaDdl(node); }}
      onCopyDdl={node => { void copySchemaDdl(node); }}
      onImport={node => setImportTarget(node)}
      onCopyName={copySchemaName}
      onToggleFavorite={toggleSchemaFavorite}
      isFavorite={node => schemaFavorites.some(item => sharedSchemaObjectIdentity(item) === sharedSchemaObjectIdentity(node as SchemaTreeNode))}
      favorites={schemaFavorites.map(node => mapSchemaNode(node))}
      recent={schemaRecent.map(node => mapSchemaNode(node))}
      searchValue={schemaSearch}
      onSearchChange={setSchemaSearch}
      searchResults={schemaSearchResults.map(node => mapSchemaNode(node))}
      searchLoading={schemaSearchLoading}
      filters={SHARED_SCHEMA_FILTERS}
      activeFilterIds={schemaFilters}
      onFilterToggle={id => setSchemaFilters(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id])}
      onRefresh={refreshSchema}
      onExpandAll={expandSchema}
      onCollapseAll={collapseSchema}
    />
    <button type="button" onClick={onLogout}>Log out</button>
  </div>}>
    {state.shell.activeSurface === 'history' ? <HistoryView entries={historyItems} state={state.history.status === 'error' ? 'error' : state.history.status === 'loading' ? 'loading' : historyItems.length === 0 ? 'empty' : 'ready'} message={state.history.message} onOpen={openHistoryEntry} onRerun={rerunHistoryEntry} onCopy={copyHistoryEntry} onRefresh={() => void reloadHistory()} />
      : state.shell.activeSurface === 'explain' ? <ExplainView state={activeResult ? resultState : 'empty'} plan={activeResult?.message} message={resultMessage} onCancel={cancel} />
        : state.shell.activeSurface === 'designer' ? <div className="shared-designer-launch"><h2>Object Designer</h2><p>Select a table, view, or routine in the schema explorer and choose <em>Open Object Designer</em> from its context menu.</p>{selectedNode?.kind === 'object' && <button type="button" onClick={() => openSchemaDesigner(selectedNode as SchemaTreeNode)}>Open selected object</button>}</div>
          : <>
            <WorkspaceTabs tabs={state.workspace.documentOrder.map(id => ({ id, label: state.workspace.documents[id]?.title ?? id, dirty: state.workspace.documents[id]?.dirty }))} activeId={state.workspace.activeDocumentId} onSelect={id => store.dispatch({ type: 'workspace/select-document', documentId: id })} />
            <div className="shared-editor-stack"><SharedSqlEditor documentId={activeDocument?.id ?? DOCUMENT_ID} value={activeDocument?.content ?? ''} api={api} preferences={preferences} getContext={() => ({ connectionId: selectedConnection?.id, database: activeDocument?.database ?? selectedConnection?.database, schema: activeDocument?.schema, databaseKind: authoringDatabaseKind })} onChange={updateSql} onRun={() => void run()} onReady={editor => { editorRef.current = editor; }} onProblemsChange={setProblems} /></div>
            <div className="shared-result-panel">
              <div className="shared-editor-actions" role="toolbar" aria-label="SQL editor actions"><button type="button" onClick={() => void run()}>Run</button><button type="button" onClick={() => void run('explain')}>Explain</button><button type="button" onClick={() => void cancel()} disabled={!activeQueryRef.current}>Cancel</button><SqlDialectSelect value={authoringDatabaseKind} onChange={selectAuthoringDialect} ariaLabel="SQL authoring dialect" /></div>
              {notice && <div role="status">{notice}</div>}
              <ResultPanel
                results={Object.values(state.results.byResultSetId)}
                activeResult={activeResult}
                rows={activeRows}
                resultState={resultState}
                resultMessage={resultMessage}
                activeTab={activeOutputTab}
                problemCount={problems.length}
                problems={problems}
                onOutputTabChange={setActiveOutputTab}
                onProblemSelect={revealProblem}
                onResultSelect={(resultSetId, sourceId) => store.dispatch({ type: 'results/select', sourceId, resultSetId })}
                onViewChange={updateResultView}
                clientProcessing={clientProcessing}
                onLoadMore={loadMoreRows}
                onScroll={onScroll}
                selectedRowIndex={selectedRow}
                onRowSelect={setSelectedRow}
                onCopySelection={copyGridSelection}
                onViewCell={openCellValue}
                onOpenColumnFilter={openColumnFilter}
                filterMenu={filterMenu}
                onFilterMenuChange={updateColumnFilterMenu}
                onApplyColumnFilter={applyColumnFilter}
                onClearColumnFilter={clearColumnFilter}
                onCloseColumnFilter={closeColumnFilter}
                onRefresh={() => void refresh()}
                onCopy={() => void copySelected()}
                onExport={() => void exportResults()}
                onAggregate={() => toggleResultAnalysis('aggregate')}
                onGroup={() => updateResultView({ grouping: activeResult?.view.grouping.length ? [] : activeResult?.columns[0] ? [activeResult.columns[0].name] : [] })}
                onPivot={() => toggleResultAnalysis('pivot')}
                activeAnalysis={resultAnalysis?.kind}
                analysisBusy={resultAnalysisLoading}
                resultAnalysis={resultAnalysis}
                resultAnalysisLoading={resultAnalysisLoading}
                resultAnalysisError={resultAnalysisError}
                onCloseResultAnalysis={closeResultAnalysis}
                onViewAnalysisCell={openAnalysisCellValue}
                onCopyAnalysisSelection={copyGridSelection}
                detailColumns={detailColumns}
                onCloseRowDetail={() => setSelectedRow(undefined)}
                exportFormat={exportFormat}
                onExportFormatChange={value => setExportFormat(value as QueryExportFormat)}
                exportFormatAriaLabel="Shared export format"
                showContextMenu
                showInlineColumnFilters
              />
            </div>
          </>}
    {importTarget && selectedConnection && <ImportPanel connectionId={selectedConnection.id} target={importTarget} database={selectedConnection.database} onClose={() => setImportTarget(undefined)} onCompleted={() => { setImportTarget(undefined); setNotice('Import completed.'); }} />}
    {designerTarget && selectedConnection && <ApiClientProvider client={api}><ObjectDesigner connectionId={selectedConnection.id} database={designerTarget.database ?? selectedConnection.database} databaseKind={selectedConnection.dbType} target={designerTarget} onClose={() => setDesignerTarget(undefined)} onApplied={() => { setDesignerTarget(undefined); setNotice('Object designer change applied. Refresh the schema to see the updated definition.'); refreshSchema(); }} /></ApiClientProvider>}
    {connectionEditor && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setConnectionEditor(undefined); }}><section className="modal-card connection-card" role="dialog" aria-modal="true" aria-labelledby="shared-connection-dialog-title"><div className="section-title"><span id="shared-connection-dialog-title">{connectionEditor.initial ? 'Edit connection' : 'Add connection'}</span><button type="button" className="icon-button" aria-label="Close connection dialog" onClick={() => setConnectionEditor(undefined)}>×</button></div><ConnectionForm api={api} initial={connectionEditor.initial} onCreated={saveConnection} onCancel={() => setConnectionEditor(undefined)} /></section></div>}
    {cellViewer && <CellValueViewer column={cellViewer.column} value={cellViewer.value} rowNumber={cellViewer.rowNumber} onClose={() => setCellViewer(undefined)} onCopy={copyCellValue} />}
  </UiShell>;
}
