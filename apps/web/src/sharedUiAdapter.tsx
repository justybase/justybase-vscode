import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import type {
  CapabilityDescriptor,
  ConnectionProfileSummary,
  DatabaseKind,
  EditorPreferences,
  HistoryEntry,
  MetadataColumn,
  MetadataDatabase,
  QueryAggregateFunction,
  QueryEvent,
  QueryExportFormat,
  QueryGroupAggregate,
  SchemaSearchResult,
  SchemaTreeNode,
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
  toUiResultQueryOptions,
} from '@justybase/ui-core';
import type { UiExecutionMode, UiExecutionState, UiResultColumn, UiResultEvent, UiResultSurfaceState, UiStore, UiSurface } from '@justybase/ui-core';
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
import { AdminPanel } from './AdminPanel';
import { InspectorPanel } from './InspectorPanel';
import { AuditPanel, ConnectionForm, EditorSettings } from './workspacePanels';
import { createWorkspaceStorage, migrateLegacyWorkspace, readLegacyWorkspaceValue, type WorkspaceStorage } from './workspacePersistence';
import { persistSharedWorkspace, restoreSharedWorkspace, sharedDocumentSourceId, type RestoredSharedWorkspace } from './sharedWorkspacePersistence';
import { readSharedResultView, writeSharedResultView } from './sharedResultViewPersistence';
import { readSharedSchemaShortcuts, rememberSharedSchemaObject, sharedSchemaObjectIdentity, toggleSharedSchemaFavorite, writeSharedSchemaShortcuts } from './sharedSchemaPersistence';

const sharedCapabilities: readonly CapabilityDescriptor[] = [
  { key: 'workspace', status: 'available', owner: 'ui-core', documentation: 'Shared workspace state and presentation.', removalCondition: 'Keep the shared workspace owner.' },
  { key: 'results.read', status: 'available', owner: 'web-api-adapter', documentation: 'Read result pages and stream events from the API.', removalCondition: 'Keep the shared result port.' },
  { key: 'results.write', status: 'read-only', owner: 'web-api-adapter', reason: 'Writes require the guarded preview/apply workflow.', documentation: 'API guarded-write routes.', removalCondition: 'Expose the guarded write port in shared mode.' },
  { key: 'designer', status: 'available', owner: 'web-api-adapter', documentation: 'Guarded designer preview/apply API.', removalCondition: 'Keep the guarded designer workflow.' },
  { key: 'history', status: 'available', owner: 'web-api-adapter', documentation: 'User-scoped query history.', removalCondition: 'Keep the shared history port.' },
  { key: 'settings', status: 'available', owner: 'web-api-adapter', documentation: 'User-scoped editor preferences.', removalCondition: 'Keep the authoring preferences API.' },
  { key: 'audit', status: 'available', owner: 'web-api-adapter', documentation: 'User-scoped execution audit.', removalCondition: 'Keep the audit API.' },
  { key: 'admin', status: 'available', owner: 'web-api-adapter', documentation: 'Role-gated administration.', removalCondition: 'Keep the admin API and capability gate.' },
];

const DOCUMENT_ID = 'shared-scratch';
const RESULT_PAGE_SIZE = 10_000;
let sharedDocumentSequence = 0;
const SHARED_SCHEMA_FILTERS = [
  // Keep these labels identical to the VS Code schema explorer. In
  // particular, do not turn TABLE into the old web-only "TABLEs" label.
  { id: 'TABLE', label: 'TABLE' },
  { id: 'VIEW', label: 'VIEW' },
  { id: 'PROCEDURE', label: 'PROCEDURE' },
  { id: 'EXTERNAL TABLE', label: 'EXTERNAL TABLE' },
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

function createSharedStore(user: WebUser, restored: RestoredSharedWorkspace): UiStore {
  const sourceId = sharedDocumentSourceId(user.id, restored.activeDocumentId);
  const store = createUiStore(createInitialUiState({ productId: 'web', userId: user.id, workspaceId: `web:${user.id}`, sourceId, documentId: restored.activeDocumentId }, {
    mode: 'shared',
    auth: { status: 'authenticated', userId: user.id, username: user.username },
    capabilities: sharedCapabilities,
    persistenceScope: 'user',
  }));
  for (const document of restored.documents) store.dispatch({ type: 'workspace/open-document', document });
  store.dispatch({ type: 'workspace/select-document', documentId: restored.activeDocumentId });
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

function queryResultId(queryId: string, statementIndex = 0): string {
  return `${queryId}:${statementIndex}`;
}

function nextSharedDocumentId(prefix = 'query'): string {
  sharedDocumentSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sharedDocumentSequence.toString(36)}`;
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
  readonly documentId: string;
  readonly mode: UiExecutionMode;
  readonly statementCount: number;
  statementIndex: number;
  subscription?: QueryEventSubscription;
}

interface PendingQueryStart {
  readonly documentId: string;
  cancelled: boolean;
}

interface RunOverride {
  readonly sql: string;
  readonly connection: ConnectionProfileSummary;
  readonly database: string;
  readonly documentId?: string;
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
  const restoredWorkspaceRef = useRef<{ readonly userId: string; readonly workspace: RestoredSharedWorkspace } | undefined>(undefined);
  if (!restoredWorkspaceRef.current || restoredWorkspaceRef.current.userId !== user.id) {
    restoredWorkspaceRef.current = { userId: user.id, workspace: restoreSharedWorkspace(workspaceStorage, user.id) };
  }
  const restoredWorkspace = restoredWorkspaceRef.current.workspace;
  const storeRef = useRef<UiStore | undefined>(undefined);
  if (!storeRef.current || storeRef.current.getState().identity.userId !== user.id) storeRef.current = createSharedStore(user, restoredWorkspace);
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
  const [databases, setDatabases] = useState<MetadataDatabase[]>([]);
  const [databaseLoadState, setDatabaseLoadState] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle');
  const [databaseLoadError, setDatabaseLoadError] = useState<string | undefined>(undefined);
  const [databaseReloadToken, setDatabaseReloadToken] = useState(0);
  const [columns, setColumns] = useState<MetadataColumn[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [audit, setAudit] = useState<Awaited<ReturnType<ApiClient['audit']>>>([]);
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
  const activeQueriesRef = useRef(new Map<string, ActiveQuery>());
  const pendingQueryStartsRef = useRef(new Map<string, PendingQueryStart>());
  const runGenerationRef = useRef(new Map<string, number>());
  const queryByResultRef = useRef(new Map<string, string>());
  const resultSequenceRef = useRef(new Map<string, number>());
  const pageHydrationRef = useRef(new Set<string>());
  const pageStateRef = useRef(new Map<string, { readonly totalRows: number; readonly hasMore: boolean }>());
  const schemaLoadedParentsRef = useRef(new Set<string>());
  const schemaLoadingParentsRef = useRef(new Set<string>());
  const schemaGenerationRef = useRef(0);
  const resultAnalysisGenerationRef = useRef(0);
  const restoredResultViewsRef = useRef(new Set<string>());
  const pendingResultViewWritesRef = useRef(new Map<string, { readonly timer: ReturnType<typeof setTimeout>; readonly write: () => void }>());
  const filterMenuGenerationRef = useRef(0);
  const activeDocument = state.workspace.activeDocumentId ? state.workspace.documents[state.workspace.activeDocumentId] : undefined;
  const selectedConnectionId = activeDocument?.connectionId !== undefined
    ? state.connections.profiles.some(profile => profile.id === activeDocument.connectionId) ? activeDocument.connectionId : undefined
    : state.connections.profiles.some(profile => profile.id === state.connections.selectedConnectionId)
      ? state.connections.selectedConnectionId
      : undefined;
  const selectedConnection = state.connections.profiles.find(profile => profile.id === selectedConnectionId);
  const runtimeDatabaseKind = selectedConnection?.dbType ?? 'netezza';
  const authoringDatabaseKind = activeDocument?.databaseKind ?? runtimeDatabaseKind;
  const documentResults = activeDocument
    ? Object.values(state.results.byResultSetId).filter(result => result.sourceId === activeDocument.sourceId)
    : [];
  const activeResult = state.results.activeResultSetId
    ? documentResults.find(result => result.resultSetId === state.results.activeResultSetId)
    : undefined;
  const activeRows = activeResult ? rowsByResult[activeResult.resultSetId] ?? [] : [];
  const activeResultKey = activeResult ? `${activeResult.sourceId}\u0000${activeResult.resultSetId}` : undefined;
  const clientProcessing = activeResultKey !== undefined && clientProcessableResultKeys.has(activeResultKey);
  const visibleRows = displayRows(activeResult, activeRows);
  const visibleSchema = visibleSchemaNodes(schemaNodes, state.metadata.expandedNodeIds);

  useEffect(() => {
    // Documents own their connection context. Keep the legacy/global
    // selection mirrored for consumers that still read the connection slice,
    // without allowing it to override an active document binding.
    if (state.connections.selectedConnectionId !== selectedConnectionId) {
      store.dispatch({ type: 'connections/select', connectionId: selectedConnectionId });
    }
  }, [selectedConnectionId, state.connections.selectedConnectionId, store]);

  const flushResultViewWrites = useCallback((): void => {
    for (const [key, pending] of pendingResultViewWritesRef.current) {
      clearTimeout(pending.timer);
      pending.write();
      pendingResultViewWritesRef.current.delete(key);
    }
  }, []);

  const cleanupActiveQueries = useCallback(async (): Promise<void> => {
    for (const pending of pendingQueryStartsRef.current.values()) pending.cancelled = true;
    pendingQueryStartsRef.current.clear();
    const activeQueries = [...activeQueriesRef.current.values()];
    activeQueriesRef.current.clear();
    for (const active of activeQueries) active.subscription?.close();
    await Promise.all(activeQueries.map(active => api.cancelQuery(active.queryId).catch(() => undefined)));
  }, [api]);

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
      const active = store.getState().workspace.activeDocumentId
        ? store.getState().workspace.documents[store.getState().workspace.activeDocumentId!]
        : undefined;
      const documentConnectionId = active?.connectionId;
      const hasDocumentBinding = documentConnectionId !== undefined;
      const documentProfile = profiles.find(profile => profile.id === documentConnectionId);
      const restoredPreferredId = restoredWorkspace.selectedConnectionId;
      const explicitPreferredProfile = preferredId === undefined ? undefined : profiles.find(profile => profile.id === preferredId);
      // A persisted document binding is authoritative. In particular, do not
      // retarget it to the preferred/global profile during reload. If the
      // profile disappeared, keep the document unresolved until the user
      // explicitly chooses a replacement.
      // An explicit profile passed after a user action (for example, saving a
      // new connection) is that explicit replacement and is allowed to retarget
      // the active document.
      const nextId = explicitPreferredProfile?.id
        ?? (hasDocumentBinding
          ? documentProfile?.id
          : restoredPreferredId && profiles.some(profile => profile.id === restoredPreferredId)
            ? restoredPreferredId
            : profiles.some(profile => profile.id === currentId) ? currentId : profiles[0]?.id);
      const documentId = active?.id;
      store.dispatch({ type: 'connections/select', connectionId: nextId });
      const nextProfile = profiles.find(profile => profile.id === nextId);
      if (documentId && nextProfile && (!hasDocumentBinding || explicitPreferredProfile !== undefined)) store.dispatch({
        type: 'workspace/update-document',
        documentId,
        patch: {
          connectionId: nextProfile.id,
          database: nextProfile.database,
          schema: '',
          databaseKind: nextProfile.dbType,
        },
      });
      store.dispatch({ type: 'connections/status', status: 'complete' });
    } catch (error: unknown) {
      store.dispatch({ type: 'connections/status', status: 'error', message: error instanceof Error ? error.message : 'Could not load connections.' });
    }
  }, [api, restoredWorkspace.selectedConnectionId, store]);

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
    if (activeDocument) store.dispatch({ type: 'results/select-source', sourceId: activeDocument.sourceId });
  }, [activeDocument?.id, activeDocument?.sourceId, store]);

  useEffect(() => {
    resultAnalysisGenerationRef.current += 1;
    setResultAnalysis(undefined);
    setResultAnalysisError(undefined);
    setResultAnalysisLoading(false);
  }, [activeResult?.sourceId, activeResult?.resultSetId]);

  useEffect(() => () => {
    void cleanupActiveQueries();
    store.dispose();
  }, [cleanupActiveQueries, store]);

  useEffect(() => {
    void reloadConnections();
  }, [reloadConnections]);

  useEffect(() => {
    const connectionId = selectedConnectionId;
    if (!connectionId) {
      setDatabases([]);
      setDatabaseLoadState('idle');
      setDatabaseLoadError(undefined);
      return undefined;
    }
    let live = true;
    setDatabases([]);
    setDatabaseLoadState('loading');
    setDatabaseLoadError(undefined);
    void api.databases(connectionId).then(items => {
      if (!live) return;
      const next = Array.isArray(items) ? items.filter(item => item && typeof item.name === 'string') : [];
      setDatabases(next);
      setDatabaseLoadState(next.length > 0 ? 'ready' : 'empty');
      const document = store.getState().workspace.activeDocumentId
        ? store.getState().workspace.documents[store.getState().workspace.activeDocumentId!]
        : undefined;
      if (document && document.connectionId === connectionId && document.database && next.some(item => item.name === document.database)) return;
      const nextDatabase = next[0]?.name;
      if (document && nextDatabase !== undefined) store.dispatch({ type: 'workspace/update-document', documentId: document.id, patch: { database: nextDatabase, schema: '' } });
    }).catch(error => {
      if (!live) return;
      setDatabases([]);
      setDatabaseLoadState('error');
      setDatabaseLoadError(error instanceof Error ? error.message : 'Could not load databases.');
    });
    return () => { live = false; };
  }, [api, databaseReloadToken, selectedConnectionId, store]);

  useEffect(() => {
    let live = true;
    void api.editorPreferences().then(value => {
      if (live) setPreferences(value);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [api]);

  useEffect(() => {
    migrateLegacyWorkspace(workspaceStorage);
    try {
      persistSharedWorkspace(workspaceStorage, user.id, {
        documents: Object.values(state.workspace.documents),
        documentOrder: state.workspace.documentOrder,
        activeDocumentId: state.workspace.activeDocumentId ?? state.workspace.documentOrder[0] ?? DOCUMENT_ID,
        selectedConnectionId: state.connections.selectedConnectionId,
      });
    } catch {
      setNotice('Workspace persistence is unavailable in this browser.');
    }
  }, [state.connections.selectedConnectionId, state.workspace.activeDocumentId, state.workspace.documentOrder, state.workspace.documents, user.id, workspaceStorage]);

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
    const flush = (): void => {
      flushResultViewWrites();
      void cleanupActiveQueries();
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flushResultViewWrites();
    };
  }, [cleanupActiveQueries, flushResultViewWrites]);

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
  }, [activeDocument?.database, loadSchemaChildren, selectedConnectionId, store]);

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
  }, [activeDocument?.database, api, schemaFilters, schemaSearch, schemaSearchRevision, selectedConnectionId, store]);

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

  const dispatchQueryEvent = useCallback((active: ActiveQuery, event: QueryEvent): void => {
    const defaultStatementIndex = event.type === 'started' ? 0 : active.statementIndex;
    const statementIndex = event.statementIndex ?? defaultStatementIndex;
    if (event.type !== 'batch-complete') active.statementIndex = statementIndex;
    const resultSetId = queryResultId(active.queryId, statementIndex);
    const resultKey = `${active.sourceId}\u0000${resultSetId}`;
    const nextSequence = (): number => {
      const next = (resultSequenceRef.current.get(resultKey) ?? 0) + 1;
      resultSequenceRef.current.set(resultKey, next);
      return next;
    };
    const eventStatementCount = event.statementCount ?? active.statementCount;
    const eventMode = event.type === 'started' ? event.mode : undefined;
    const startResult = (statementSql?: string): void => {
      queryByResultRef.current.set(resultSetId, active.queryId);
      if (!(resultSetId in rowsByResultRef.current)) {
        rowsByResultRef.current = { ...rowsByResultRef.current, [resultSetId]: [] };
        setRowsByResult(rowsByResultRef.current);
      }
      const current = store.getState();
      const result = current.results.byResultSetId[`${active.sourceId}\u0000${resultSetId}`];
      const execution = current.executions.byExecutionId[active.executionId];
      const currentStatement = execution?.sourceId === active.sourceId ? execution.statements[statementIndex] : undefined;
      const needsStart = !result
        || result.executionId !== active.executionId
        || statementSql !== undefined && currentStatement?.sql !== statementSql
        || eventStatementCount !== execution?.statementCount;
      if (!needsStart) return;
      store.dispatch({
        type: 'execution/start',
        sourceId: active.sourceId,
        executionId: active.executionId,
        resultSetId,
        statementIndex,
        mode: active.mode,
        statementCount: eventStatementCount,
        ...(statementSql === undefined ? {} : { statementSql }),
      });
    };
    const base = { sourceId: active.sourceId, executionId: active.executionId, resultSetId, statementIndex };
    let mapped: UiResultEvent | undefined;
    switch (event.type) {
      case 'started':
        startResult();
        mapped = { ...base, sequence: nextSequence(), type: 'started', ...(eventMode === undefined ? {} : { mode: eventMode }), ...(event.statementCount === undefined ? {} : { statementCount: event.statementCount }) };
        break;
      case 'statement-started':
        startResult(event.statementSql);
        mapped = { ...base, sequence: nextSequence(), type: 'statement-started', ...(event.statementSql === undefined ? {} : { statementSql: event.statementSql }) };
        break;
      case 'columns':
        startResult();
        mapped = { ...base, sequence: nextSequence(), type: 'columns', columns: event.columns.map(mapQueryColumn) };
        break;
      case 'session':
        startResult();
        mapped = { ...base, sequence: nextSequence(), type: 'session', storageId: event.sessionId, totalRowCount: event.totalRows };
        break;
      case 'rows': {
        startResult();
        const rows = rowsByResultRef.current[resultSetId] ?? [];
        // The stream is a progress channel. Keep only the first bounded page
        // here; the finalized page endpoint remains the source for scrolling
        // through large results and prevents a 150k-row query from causing a
        // render/copy of the complete result in the browser.
        const nextRows = [...rows, ...event.rows.map(row => [...row])].slice(0, RESULT_PAGE_SIZE);
        rowsByResultRef.current = { ...rowsByResultRef.current, [resultSetId]: nextRows };
        setRowsByResult(rowsByResultRef.current);
        mapped = { ...base, sequence: nextSequence(), type: 'rows', rowCount: nextRows.length, totalRowCount: event.totalRows };
        break;
      }
      case 'progress':
        startResult();
        mapped = { ...base, sequence: nextSequence(), type: 'progress', totalRowCount: event.totalRows };
        break;
      case 'complete': {
        startResult();
        const current = Object.values(store.getState().results.byResultSetId)
          .find(result => result.sourceId === active.sourceId && result.resultSetId === resultSetId && result.executionId === active.executionId);
        const streamedRows = rowsByResultRef.current[resultSetId] ?? [];
        // A complete bounded stream is safe to process in the shared renderer.
        // Keep the marker tied to the unfiltered execution so clearing a
        // server-side filter on a large result cannot mistake a one-row page
        // for the complete source result.
        if (event.totalRows > 0 && streamedRows.length >= event.totalRows && current && !hasUiResultQuery(current.view)) {
          setClientProcessableResultKeys(previous => previous.has(resultKey) ? previous : new Set([...previous, resultKey]));
        }
        mapped = { ...base, sequence: nextSequence(), type: 'complete', totalRowCount: event.totalRows, message: event.message };
        break;
      }
      case 'error':
        startResult();
        mapped = { ...base, sequence: nextSequence(), type: 'error', message: event.message };
        break;
      case 'cancelled': {
        const targets = event.scope === 'batch'
          ? Object.values(store.getState().results.byResultSetId).filter(result => result.sourceId === active.sourceId && result.executionId === active.executionId)
          : [];
        if (targets.length > 0) {
          for (const target of targets) {
            const targetKey = `${target.sourceId}\u0000${target.resultSetId}`;
            const sequence = (resultSequenceRef.current.get(targetKey) ?? 0) + 1;
            resultSequenceRef.current.set(targetKey, sequence);
            store.dispatch({ type: 'execution/event', event: { sourceId: target.sourceId, executionId: target.executionId, resultSetId: target.resultSetId, statementIndex: target.statementIndex, sequence, type: 'cancelled', totalRowCount: event.totalRows } });
          }
          return;
        }
        startResult();
        mapped = { ...base, sequence: nextSequence(), type: 'cancelled', totalRowCount: event.totalRows };
        break;
      }
      case 'batch-complete':
        store.dispatch({
          type: 'execution/batch-complete',
          sourceId: active.sourceId,
          executionId: active.executionId,
          status: event.status === 'complete' ? 'success' : event.status,
          statementCount: event.statementCount ?? active.statementCount,
          completedStatements: event.completedStatements,
          ...(event.message === undefined ? {} : { message: event.message }),
        });
        return;
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

  const run = useCallback(async (mode: UiExecutionMode = 'single', override?: RunOverride): Promise<boolean> => {
    const connection = override?.connection ?? selectedConnection;
    const document = override?.documentId
      ? store.getState().workspace.documents[override.documentId]
      : activeDocument;
    // Monaco owns the live document while the user is typing. Read it
    // directly so Run never races the editor's debounced React persistence.
    const editor = editorRef.current;
    const model = editor?.getModel();
    const selection = editor?.getSelection();
    const selectedSql = model && selection && !selection.isEmpty() ? model.getValueInRange(selection) : undefined;
    const sql = override?.sql ?? (mode === 'smart' ? selectedSql : undefined) ?? model?.getValue() ?? document?.content ?? '';
    if (!connection) {
      setNotice('Select a connection before running SQL.');
      return false;
    }
    if (!document) {
      setNotice('Open a query document before running SQL.');
      return false;
    }
    if (!sql.trim()) {
      setNotice('Enter SQL before running the document.');
      return false;
    }
    const apiMode = mode === 'script' ? 'script' : mode === 'explain' ? 'explain' : 'single';
    const cursorOffset = mode === 'smart' && !selectedSql && model && selection
      ? model.getOffsetAt({ lineNumber: selection.positionLineNumber, column: selection.positionColumn })
      : undefined;
    const request = {
      connectionId: connection.id,
      database: override?.database ?? document.database ?? connection.database,
      sql,
      mode: apiMode,
      ...(cursorOffset === undefined ? {} : { cursorOffset }),
    } as const;
    const runGeneration = (runGenerationRef.current.get(document.id) ?? 0) + 1;
    runGenerationRef.current.set(document.id, runGeneration);
    for (const [pendingKey, pending] of pendingQueryStartsRef.current) {
      if (pending.documentId !== document.id) continue;
      pending.cancelled = true;
      pendingQueryStartsRef.current.delete(pendingKey);
    }
    const previous = [...activeQueriesRef.current.values()].filter(item => item.documentId === document.id);
    for (const item of previous) {
      item.subscription?.close();
      activeQueriesRef.current.delete(item.queryId);
      void api.cancelQuery(item.queryId).catch(() => undefined);
    }
    const oldResultIds = Object.values(store.getState().results.byResultSetId)
      .filter(result => result.sourceId === document.sourceId)
      .map(result => result.resultSetId);
    store.dispatch({ type: 'results/reconcile-source', sourceId: document.sourceId, resultSetIds: [] });
    const nextRows = { ...rowsByResultRef.current };
    for (const resultSetId of oldResultIds) {
      delete nextRows[resultSetId];
      queryByResultRef.current.delete(resultSetId);
      pageStateRef.current.delete(resultSetId);
      resultSequenceRef.current.delete(`${document.sourceId}\u0000${resultSetId}`);
    }
    rowsByResultRef.current = nextRows;
    setRowsByResult(nextRows);
    setClientProcessableResultKeys(previousKeys => new Set([...previousKeys].filter(key => !key.startsWith(`${document.sourceId}\u0000`))));
    setNotice(undefined);
    const pendingKey = `query-start:${document.id}:${runGeneration}`;
    const pendingStart: PendingQueryStart = { documentId: document.id, cancelled: false };
    pendingQueryStartsRef.current.set(pendingKey, pendingStart);
    const isStale = (): boolean => pendingStart.cancelled || runGenerationRef.current.get(document.id) !== runGeneration;
    let startedQueryId: string | undefined;
    try {
      let started;
      try {
        started = await api.startQuery(request);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '';
        if (!message.includes('Write confirmation required')) throw error;
        const preview = await api.previewQuery(request);
        if (isStale()) return false;
        const previewText = preview.statements.map(statement => `${statement.index + 1}. ${statement.commandType}: ${statement.sql.trim()}${statement.warnings.length > 0 ? `\n   ${statement.warnings.join(' ')}` : ''}`).join('\n\n');
        if (typeof window !== 'undefined' && !window.confirm(`This SQL can modify data or schema. Confirm execution?\n\nDatabase: ${preview.database}\n\n${previewText.slice(0, 2_000)}${previewText.length > 2_000 ? '\n…' : ''}`)) {
          setNotice('Write execution cancelled.');
          return false;
        }
        started = await api.startQuery({ ...request, writeConfirmed: true, writePreviewToken: preview.previewToken });
      }
      startedQueryId = started.queryId;
      if (isStale()) {
        await api.cancelQuery(started.queryId).catch(() => undefined);
        return false;
      }
      const active: ActiveQuery = {
        queryId: started.queryId,
        resultSetId: queryResultId(started.queryId),
        sourceId: document.sourceId,
        executionId: started.queryId,
        documentId: document.id,
        mode,
        statementCount: started.statementCount ?? (mode === 'script' ? 1 : 1),
        statementIndex: 0,
      };
      activeQueriesRef.current.set(active.queryId, active);
      queryByResultRef.current.set(active.resultSetId, active.queryId);
      resultSequenceRef.current.set(`${active.sourceId}\u0000${active.resultSetId}`, 0);
      pageStateRef.current.delete(active.resultSetId);
      rowsByResultRef.current = { ...rowsByResultRef.current, [active.resultSetId]: [] };
      setRowsByResult(rowsByResultRef.current);
      setSelectedRow(undefined);
      store.dispatch({ type: 'execution/start', sourceId: active.sourceId, executionId: active.executionId, resultSetId: active.resultSetId, mode, statementCount: active.statementCount, statementSql: sql });
      store.dispatch({ type: 'results/select-source', sourceId: active.sourceId });
      store.dispatch({ type: 'results/select', sourceId: active.sourceId, resultSetId: active.resultSetId });
      const subscriptionRef: { current?: QueryEventSubscription } = {};
      const closeActiveStream = (): void => {
        subscriptionRef.current?.close();
        if (activeQueriesRef.current.get(active.queryId)?.queryId === active.queryId) activeQueriesRef.current.delete(active.queryId);
      };
      const subscription = api.connectToQueryEvents(started.queryId, event => {
        if (activeQueriesRef.current.get(active.queryId)?.queryId !== active.queryId) return;
        dispatchQueryEvent(active, event);
        if (event.type === 'complete') {
          const statementIndex = event.statementIndex ?? active.statementIndex;
          hydrateResultPage({ ...active, resultSetId: queryResultId(active.queryId, statementIndex), statementIndex });
        }
        const terminal = event.type === 'batch-complete'
          || event.type === 'error' && active.mode !== 'script'
          || event.type === 'cancelled' && (event.scope !== 'statement' || active.mode !== 'script')
          || event.type === 'complete' && active.mode !== 'script';
        if (terminal) queueMicrotask(closeActiveStream);
      }, error => {
        if (activeQueriesRef.current.get(active.queryId)?.queryId !== active.queryId) return;
        dispatchQueryEvent(active, { type: 'error', queryId: active.queryId, statementIndex: active.statementIndex, message: error.message });
        if (active.mode === 'script') {
          const execution = store.getState().executions.byExecutionId[active.executionId];
          store.dispatch({
            type: 'execution/batch-complete',
            sourceId: active.sourceId,
            executionId: active.executionId,
            status: 'error',
            statementCount: active.statementCount,
            completedStatements: execution?.completedStatements ?? 0,
            message: error.message,
          });
        }
        setNotice(error.message);
        queueMicrotask(closeActiveStream);
      });
      subscriptionRef.current = subscription;
      active.subscription = subscription;
      return true;
    } catch (error) {
      if (startedQueryId) {
        activeQueriesRef.current.get(startedQueryId)?.subscription?.close();
        activeQueriesRef.current.delete(startedQueryId);
        void api.cancelQuery(startedQueryId).catch(() => undefined);
      }
      if (isStale()) return false;
      setNotice(error instanceof Error ? error.message : 'Could not start query.');
      return false;
    } finally {
      pendingQueryStartsRef.current.delete(pendingKey);
    }
  }, [activeDocument, api, dispatchQueryEvent, hydrateResultPage, selectedConnection, store]);

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
      documentId: activeDocument?.id ?? activeResult.sourceId,
      mode: state.executions.byExecutionId[activeResult.executionId]?.mode ?? 'single',
      statementCount: state.executions.byExecutionId[activeResult.executionId]?.statementCount ?? 1,
      statementIndex: activeResult.statementIndex,
    }, loadedRows, false);
  }, [activeDocument?.id, activeResult, loadResultPage, state.executions.byExecutionId]);

  const openSharedDocument = useCallback((id: string, title: string, content: string, context: SharedDocumentContext = {}): string | undefined => {
    if (!selectedConnection) {
      setNotice('Select a connection before opening a schema document.');
      return undefined;
    }
    store.dispatch({
      type: 'workspace/open-document',
      document: {
        id,
        sourceId: sharedDocumentSourceId(user.id, id),
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
    return id;
  }, [authoringDatabaseKind, selectedConnection, store, user.id]);

  const openHistoryEntry = useCallback((entry: HistoryViewEntry): void => {
    const historyEntry = history.find(item => item.id === entry.id);
    if (!historyEntry) return;
    const profile = state.connections.profiles.find(item => item.id === historyEntry.connectionId);
    const documentId = `history:${historyEntry.id}`;
    const sourceId = sharedDocumentSourceId(user.id, documentId);
    store.dispatch({
      type: 'workspace/open-document',
      document: {
        id: documentId,
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
    void run('single', { sql: historyEntry.sql, connection: profile, database: historyEntry.database, documentId: `history:${historyEntry.id}` });
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
    const documentId = openSharedDocument(`schema:${node.id}:top`, title, sql, { database: node.database, schema: node.schema });
    if (selectedConnection && documentId) void run('single', { sql, connection: selectedConnection, database: node.database ?? selectedConnection.database, documentId });
  }, [authoringDatabaseKind, openSharedDocument, run, selectedConnection]);

  const openSchemaEditData = useCallback((node: SchemaTreeNode): void => {
    if (node.kind !== 'object') return;
    const sql = buildTopRowsQuery({ database: node.database, schema: node.schema, objectName: node.objectName ?? node.label }, authoringDatabaseKind, 50_000);
    const title = `View/Edit · ${node.label}`;
    const documentId = openSharedDocument(`schema:${node.id}:edit`, title, sql, { database: node.database, schema: node.schema });
    if (selectedConnection && documentId) void run('single', { sql, connection: selectedConnection, database: node.database ?? selectedConnection.database, documentId });
  }, [authoringDatabaseKind, openSharedDocument, run, selectedConnection]);

  const explainSchemaObject = useCallback((node: SchemaTreeNode): void => {
    if (node.kind !== 'object') return;
    const sql = buildTopRowsQuery({ database: node.database, schema: node.schema, objectName: node.objectName ?? node.label }, authoringDatabaseKind);
    const title = `Explain · ${node.label}`;
    const documentId = openSharedDocument(`schema:${node.id}:explain`, title, sql, { database: node.database, schema: node.schema });
    store.dispatch({ type: 'shell/surface', surface: 'explain' });
    if (selectedConnection && documentId) {
      try {
        buildExplainQuery(sql, authoringDatabaseKind);
        void run('explain', { sql, connection: selectedConnection, database: node.database ?? selectedConnection.database, documentId });
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
    const documentId = activeDocument?.id;
    const pendingStarts = [...pendingQueryStartsRef.current.entries()].filter(([, pending]) => documentId === undefined || pending.documentId === documentId);
    for (const [pendingKey, pending] of pendingStarts) {
      pending.cancelled = true;
      pendingQueryStartsRef.current.delete(pendingKey);
    }
    const activeQueries = [...activeQueriesRef.current.values()].filter(query => documentId === undefined || query.documentId === documentId);
    const affectedDocumentIds = new Set([...pendingStarts.map(([, pending]) => pending.documentId), ...activeQueries.map(query => query.documentId)]);
    for (const affectedDocumentId of affectedDocumentIds) {
      runGenerationRef.current.set(affectedDocumentId, (runGenerationRef.current.get(affectedDocumentId) ?? 0) + 1);
    }
    if (pendingStarts.length > 0) setNotice('Execution cancelled.');
    await Promise.all(activeQueries.map(async active => {
      const requestId = `cancel-${Date.now().toString(36)}-${active.queryId}`;
      store.dispatch({ type: 'execution/cancel-requested', sourceId: active.sourceId, executionId: active.executionId, requestId });
      try {
        await api.cancelQuery(active.queryId);
        store.dispatch({ type: 'execution/cancel-acknowledged', sourceId: active.sourceId, executionId: active.executionId, requestId });
      } catch (error) {
        store.dispatch({ type: 'execution/cancel-failed', sourceId: active.sourceId, executionId: active.executionId, requestId, message: error instanceof Error ? error.message : 'Cancellation failed.' });
      }
    }));
  }, [activeDocument?.id, api, store]);

  const retryStatement = useCallback((statementIndex: number): void => {
    const executionId = activeResult?.executionId;
    const execution = executionId ? state.executions.byExecutionId[executionId] : undefined;
    const statement = execution?.statements[statementIndex];
    const connection = selectedConnection;
    if (!statement?.sql || !connection) {
      setNotice('The failed statement is no longer available for retry.');
      return;
    }
    const id = nextSharedDocumentId(`retry-${statementIndex + 1}`);
    store.dispatch({
      type: 'workspace/open-document',
      document: {
        id,
        sourceId: sharedDocumentSourceId(user.id, id),
        title: `Retry · Statement ${statementIndex + 1}`,
        content: statement.sql,
        dirty: false,
        connectionId: connection.id,
        database: activeDocument?.database ?? connection.database,
        databaseKind: activeDocument?.databaseKind ?? connection.dbType,
      },
    });
    void run('single', { sql: statement.sql, connection, database: activeDocument?.database ?? connection.database, documentId: id });
  }, [activeDocument?.database, activeDocument?.databaseKind, activeResult?.executionId, run, selectedConnection, state.executions.byExecutionId, store, user.id]);

  const openAudit = useCallback((): void => {
    setShowAudit(true);
    void api.audit().then(entries => setAudit(Array.isArray(entries) ? entries : [])).catch(error => {
      setAudit([]);
      setNotice(error instanceof Error ? error.message : 'Could not load audit log.');
    });
  }, [api]);

  const handleLogout = useCallback(async (): Promise<void> => {
    flushResultViewWrites();
    await cleanupActiveQueries();
    try { await api.logout(); } finally { onLogout(); }
  }, [api, cleanupActiveQueries, flushResultViewWrites, onLogout]);

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
      documentId: activeDocument?.id ?? activeResult.sourceId,
      mode: state.executions.byExecutionId[activeResult.executionId]?.mode ?? 'single',
      statementCount: state.executions.byExecutionId[activeResult.executionId]?.statementCount ?? 1,
      statementIndex: activeResult.statementIndex,
    }, 0, true);
  }, [activeDocument?.id, activeResult, loadResultPage, state.executions.byExecutionId]);

  const updateSql = useCallback((content: string): void => {
    if (!activeDocument) return;
    store.dispatch({ type: 'workspace/update-document', documentId: activeDocument.id, patch: { content, dirty: true } });
  }, [activeDocument, store]);

  const selectConnection = useCallback((connectionId: string): void => {
    if (connectionId === '') {
      store.dispatch({ type: 'connections/select', connectionId: undefined });
      if (activeDocument) store.dispatch({
        type: 'workspace/update-document',
        documentId: activeDocument.id,
        patch: { connectionId: undefined, database: undefined, schema: undefined },
      });
      return;
    }
    const profile = state.connections.profiles.find(item => item.id === connectionId);
    if (!profile) return;
    store.dispatch({ type: 'connections/select', connectionId: profile.id });
    if (activeDocument) store.dispatch({
      type: 'workspace/update-document',
      documentId: activeDocument.id,
      patch: { connectionId: profile.id, database: profile.database, schema: '', databaseKind: profile.dbType },
    });
  }, [activeDocument, state.connections.profiles, store]);

  const selectDatabase = useCallback((database: string): void => {
    if (!activeDocument) return;
    store.dispatch({ type: 'workspace/update-document', documentId: activeDocument.id, patch: { database, schema: '' } });
    schemaGenerationRef.current += 1;
    schemaLoadedParentsRef.current.clear();
    schemaLoadingParentsRef.current.clear();
    setSchemaNodes([]);
    setSchemaSearch('');
    setSchemaSearchResults([]);
    setSchemaSearchLoading(false);
    setSchemaSearchRevision(previous => previous + 1);
    store.dispatch({ type: 'metadata/set-expanded', nodeIds: [] });
  }, [activeDocument, store]);

  const setSchemaActiveContext = useCallback((node: SchemaTreeNode): void => {
    const nextDatabase = node.database ?? (node.kind === 'database' ? node.label : undefined);
    if (!activeDocument || !nextDatabase) return;
    selectDatabase(nextDatabase);
    if (node.kind === 'schema') {
      store.dispatch({ type: 'workspace/update-document', documentId: activeDocument.id, patch: { database: nextDatabase, schema: node.schema ?? node.label } });
    }
  }, [activeDocument, selectDatabase, store]);

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

  const createDocument = useCallback((): void => {
    const id = nextSharedDocumentId();
    const document = {
      id,
      sourceId: sharedDocumentSourceId(user.id, id),
      title: `Query ${state.workspace.documentOrder.length + 1}`,
      content: 'SELECT 1;',
      dirty: false,
      ...(selectedConnection === undefined ? {} : { connectionId: selectedConnection.id, database: selectedConnection.database, databaseKind: selectedConnection.dbType }),
    };
    store.dispatch({ type: 'workspace/open-document', document });
    store.dispatch({ type: 'shell/surface', surface: 'workspace' });
  }, [selectedConnection, state.workspace.documentOrder.length, store, user.id]);

  const selectDocument = useCallback((documentId: string): void => {
    const current = store.getState();
    const nextDocument = current.workspace.documents[documentId];
    if (!nextDocument) return;
    // The keyed editor is disposed before the next document mounts. Clear the
    // parent reference synchronously so toolbar actions cannot target the old
    // Monaco model during that hand-off.
    editorRef.current = null;
    const currentConnectionId = current.connections.selectedConnectionId;
    const nextConnectionId = nextDocument.connectionId !== undefined
      ? current.connections.profiles.some(profile => profile.id === nextDocument.connectionId) ? nextDocument.connectionId : undefined
      : current.connections.profiles.some(profile => profile.id === currentConnectionId) ? currentConnectionId : undefined;
    store.dispatch({ type: 'workspace/select-document', documentId });
    store.dispatch({ type: 'connections/select', connectionId: nextConnectionId });
    if (nextDocument.connectionId === undefined && nextConnectionId !== undefined) {
      const profile = current.connections.profiles.find(item => item.id === nextConnectionId);
      if (profile) store.dispatch({
        type: 'workspace/update-document',
        documentId,
        patch: {
          connectionId: profile.id,
          database: nextDocument.database ?? profile.database,
          databaseKind: nextDocument.databaseKind ?? profile.dbType,
        },
      });
    }
  }, [store]);

  const closeDocument = useCallback((documentId: string): void => {
    const document = store.getState().workspace.documents[documentId];
    if (!document) return;
    if (document.dirty && typeof window !== 'undefined' && !window.confirm(`Close modified document “${document.title}”?`)) return;
    runGenerationRef.current.set(documentId, (runGenerationRef.current.get(documentId) ?? 0) + 1);
    for (const [pendingKey, pending] of pendingQueryStartsRef.current) {
      if (pending.documentId !== documentId) continue;
      pending.cancelled = true;
      pendingQueryStartsRef.current.delete(pendingKey);
    }
    if (store.getState().workspace.activeDocumentId === documentId) editorRef.current = null;
    const activeQueries = [...activeQueriesRef.current.values()].filter(query => query.documentId === documentId);
    for (const active of activeQueries) {
      active.subscription?.close();
      activeQueriesRef.current.delete(active.queryId);
      void api.cancelQuery(active.queryId).catch(() => undefined);
    }
    const resultIds = Object.values(store.getState().results.byResultSetId).filter(result => result.sourceId === document.sourceId).map(result => result.resultSetId);
    store.dispatch({ type: 'results/reconcile-source', sourceId: document.sourceId, resultSetIds: [] });
    const nextRows = { ...rowsByResultRef.current };
    for (const resultSetId of resultIds) {
      delete nextRows[resultSetId];
      queryByResultRef.current.delete(resultSetId);
      pageStateRef.current.delete(resultSetId);
      resultSequenceRef.current.delete(`${document.sourceId}\u0000${resultSetId}`);
    }
    rowsByResultRef.current = nextRows;
    setRowsByResult(nextRows);
    store.dispatch({ type: 'workspace/close-document', documentId });
  }, [api, store]);

  const saveDocument = useCallback(async (): Promise<void> => {
    if (!activeDocument) return;
    const editor = editorRef.current;
    if (preferences?.formatOnSave) await editor?.getAction('editor.action.formatDocument')?.run();
    const content = editor?.getModel()?.getValue() ?? activeDocument.content;
    store.dispatch({ type: 'workspace/update-document', documentId: activeDocument.id, patch: { content, dirty: false } });
    setNotice('Document saved locally.');
  }, [activeDocument, preferences?.formatOnSave, store]);

  const formatDocument = useCallback((): void => {
    void editorRef.current?.getAction('editor.action.formatDocument')?.run();
  }, []);

  const commentDocument = useCallback((): void => {
    const editor = editorRef.current;
    if (editor) {
      void editor.getAction('editor.action.commentLine')?.run();
      return;
    }
    if (!activeDocument) return;
    const lines = activeDocument.content.split('\n');
    const allCommented = lines.every(line => line.trim() === '' || line.trim().startsWith('--'));
    store.dispatch({ type: 'workspace/update-document', documentId: activeDocument.id, patch: {
      content: lines.map(line => {
        const trimmed = line.trimStart();
        if (allCommented && trimmed.startsWith('--')) return line.replace(/^\s*--\s?/u, '');
        if (!allCommented && trimmed && !trimmed.startsWith('--')) return line.startsWith(' ') || line.startsWith('\t') ? line.replace(/^(\s*)/u, '$1-- ') : `-- ${line}`;
        return line;
      }).join('\n'),
      dirty: true,
    } });
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
          documentId: activeDocument?.id ?? activeResult.sourceId,
          mode: state.executions.byExecutionId[activeResult.executionId]?.mode ?? 'single',
          statementCount: state.executions.byExecutionId[activeResult.executionId]?.statementCount ?? 1,
          statementIndex: activeResult.statementIndex,
        }, 0, true, nextView);
      }
    }
  }, [activeDocument?.id, activeResult, clientProcessing, closeResultAnalysis, loadResultPage, resultAnalysis, scheduleResultViewWrite, state.executions.byExecutionId, store]);

  const closeColumnFilter = useCallback((): void => {
    filterMenuGenerationRef.current += 1;
    setFilterMenu(undefined);
  }, []);

  const openColumnFilter = useCallback(async (request: import('@justybase/ui-react').DataGridColumnFilterRequest): Promise<void> => {
    if (!activeResult) return;
    const generation = ++filterMenuGenerationRef.current;
    const key = request.column.name || String(request.columnIndex);
    const saved = activeResult.view.columnFilterDefinitions?.[key];
    const legacyValue = activeResult.view.columnFilters[key];
    const definition = saved ?? (legacyValue?.trim()
      ? { operator: 'contains' as const, value: legacyValue.trim(), values: [] as readonly unknown[] }
      : undefined);
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
      selectedKeys: definition?.operator === 'in' ? (definition.values ?? []).map(filterValueKey) : [],
      operator: definition?.operator ?? 'in',
      value: definition?.value ?? '',
      search: '',
      loading: true,
      truncated: false,
      dirty: false,
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
      const selectedKeys = definition?.operator === 'in'
        ? (definition.values ?? []).map(filterValueKey).filter(valueKey => options.some(option => option.key === valueKey))
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
      if (!menu.dirty) {
        closeColumnFilter();
        return;
      }
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
        && position.anchorRow === activeResult.view.anchorRow
        && position.rowHeight === activeResult.view.scrollRowHeight)) return;
    updateResultView({ scrollTop: position.top, scrollLeft: position.left, anchorRow: position.anchorRow, scrollRowHeight: position.rowHeight });
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
    try {
      const downloaded = await api.exportQuery(queryId, {
        statementIndex: activeResult.statementIndex,
        format: exportFormat,
        ...resultQueryOptions(activeResult, activeResult.view),
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
  useEffect(() => {
    if (!selectedConnection || selectedNode?.kind !== 'object' || !selectedNode.database || !selectedNode.schema || !selectedNode.objectName) {
      setColumns([]);
      return undefined;
    }
    let live = true;
    setColumns([]);
    void api.columns(selectedConnection.id, selectedNode.database, selectedNode.schema, selectedNode.objectName).then(items => {
      if (live) setColumns(Array.isArray(items) ? items : []);
    }).catch(error => {
      if (live) setNotice(error instanceof Error ? error.message : 'Could not load columns.');
    });
    return () => { live = false; };
  }, [api, selectedConnection?.id, selectedNode?.database, selectedNode?.kind, selectedNode?.objectName, selectedNode?.schema]);
  const resultState = resultAsyncState(activeResult, visibleRows.length);
  const resultMessage = activeResult?.message;
  const activeExecution: UiExecutionState | undefined = activeResult ? state.executions.byExecutionId[activeResult.executionId] : undefined;
  const hasActiveQuery = activeDocument !== undefined && (
    [...activeQueriesRef.current.values()].some(query => query.documentId === activeDocument.id)
      || [...pendingQueryStartsRef.current.values()].some(query => query.documentId === activeDocument.id)
  );
  const runAndExport = useCallback(async (): Promise<void> => {
    if (activeResult && ['complete', 'empty', 'error', 'cancelled'].includes(activeResult.status)) {
      await exportResults();
      return;
    }
    const started = await run();
    if (started) setNotice('Query started. Export is available when the result is ready.');
  }, [activeResult, exportResults, run]);
  const inspectorDatabase = selectedNode?.database ?? activeDocument?.database ?? selectedConnection?.database ?? '';
  const inspectorSchema = selectedNode?.schema ?? activeDocument?.schema ?? '';

  return <ApiClientProvider client={api}><UiShell title="JustyBase" className="shared-ui-shell" activeSurface={state.shell.activeSurface} onSurfaceChange={selectSurface} surfaces={[{ id: 'workspace', label: 'Workspace' }, { id: 'history', label: 'History' }, { id: 'explain', label: 'Explain' }, { id: 'designer', label: 'Designer' }]} sidebar={<div className="shared-sidebar">
    <section className="shared-connections" aria-label="Connections"><div className="shared-sidebar-heading"><strong>Connections</strong><span>{state.connections.profiles.length}</span><button type="button" aria-label="Add connection" title="Add connection" onClick={() => setConnectionEditor({})}>＋</button></div>{state.connections.status === 'loading' && <div role="status">Loading connections…</div>}{state.connections.status === 'error' && <div role="alert">{state.connections.message ?? 'Could not load connections.'}<button type="button" onClick={() => void reloadConnections()}>Retry connections</button></div>}{state.connections.profiles.length === 0 && state.connections.status !== 'loading' ? <div className="shared-sidebar-empty">No connections configured.<button type="button" onClick={() => setConnectionEditor({})}>Add connection</button></div> : state.connections.profiles.map(profile => <div className="shared-connection-item" key={profile.id}><button type="button" className={profile.id === selectedConnectionId ? 'active' : ''} aria-label={profile.name} aria-pressed={profile.id === selectedConnectionId} onClick={() => selectConnection(profile.id)}><span className="shared-connection-dot" /><span>{profile.name}</span><small>{profile.dbType}</small></button><div className="shared-connection-actions"><button type="button" aria-label={`Edit ${profile.name} connection`} title="Edit connection" onClick={() => setConnectionEditor({ initial: profile })}>✎</button><button type="button" aria-label={`Delete ${profile.name} connection`} title="Delete connection" onClick={() => void deleteConnection(profile)}>×</button></div></div>)}</section>
    <label className="shared-context-picker">Database<select aria-label="Database" value={activeDocument?.database ?? ''} disabled={!selectedConnection || databaseLoadState === 'loading' || (databaseLoadState !== 'ready' && databaseLoadState !== 'empty')} onChange={event => selectDatabase(event.target.value)}><option value="">{databaseLoadState === 'loading' ? 'Loading databases…' : databaseLoadState === 'empty' ? 'No databases' : 'Select database'}</option>{activeDocument?.database && !databases.some(item => item.name === activeDocument.database) && <option value={activeDocument.database}>{activeDocument.database}</option>}{databases.map(database => <option key={database.name} value={database.name}>{database.name}</option>)}</select>{databaseLoadState === 'error' && <span className="field-help" role="alert">{databaseLoadError ?? 'Could not load databases.'} <button type="button" onClick={() => setDatabaseReloadToken(previous => previous + 1)}>Retry</button></span>}</label>
    <SchemaTree
      nodes={visibleSchema}
      selectedId={state.metadata.selectedNodeId}
      expandedIds={state.metadata.expandedNodeIds}
      onToggle={toggleSchemaNode}
      onSelect={node => store.dispatch({ type: 'metadata/select', nodeId: node.id })}
      onActivate={activateSchemaNode}
      onInsert={insertSchemaNode}
      onSetActiveContext={node => setSchemaActiveContext(node as SchemaTreeNode)}
      onRefreshNode={() => refreshSchema()}
      onOpenQuery={openSchemaQuery}
      onOpenExplain={explainSchemaObject}
      onOpenEditData={openSchemaEditData}
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
    <InspectorPanel database={inspectorDatabase} schema={inspectorSchema} columns={columns} selectedObject={selectedNode} onInsertColumn={column => insertSchemaNode({ id: `column:${column.name}`, kind: 'column', label: column.name, database: selectedNode?.database ?? activeDocument?.database, schema: selectedNode?.schema ?? activeDocument?.schema, objectName: selectedNode?.objectName, hasChildren: false })} connectionName={selectedConnection?.name} />
    <section className="shared-capabilities" aria-label="Capabilities"><strong>Capabilities</strong><button type="button" onClick={() => setShowSettings(true)}>Settings</button><button type="button" onClick={openAudit}>Audit</button>{user.role === 'admin' ? <button type="button" onClick={() => setShowAdmin(true)}>Admin</button> : <span role="status">Admin: unavailable for this account</span>}</section>
    <button type="button" onClick={() => void handleLogout()}>Log out</button>
  </div>}>
    {state.shell.activeSurface === 'history' ? <HistoryView entries={historyItems} state={state.history.status === 'error' ? 'error' : state.history.status === 'loading' ? 'loading' : historyItems.length === 0 ? 'empty' : 'ready'} message={state.history.message} onOpen={openHistoryEntry} onRerun={rerunHistoryEntry} onCopy={copyHistoryEntry} onRefresh={() => void reloadHistory()} />
      : state.shell.activeSurface === 'explain' ? <ExplainView state={activeResult ? resultState : 'empty'} plan={activeResult?.message} message={resultMessage} onCancel={cancel} />
        : state.shell.activeSurface === 'designer' ? <div className="shared-designer-launch"><h2>Object Designer</h2><p>Select a table, view, or routine in the schema explorer and choose <em>Open Object Designer</em> from its context menu.</p>{selectedNode?.kind === 'object' && <button type="button" onClick={() => openSchemaDesigner(selectedNode as SchemaTreeNode)}>Open selected object</button>}</div>
          : <>
            <div className="shared-document-toolbar" role="toolbar" aria-label="Document actions"><div className="shared-document-summary"><span className="shared-toolbar-caption">Document</span><strong>{activeDocument?.title ?? 'scratch.sql'}</strong>{activeDocument?.dirty && <span className="shared-document-dirty">Unsaved</span>}</div><div className="shared-document-actions"><button type="button" onClick={createDocument}>New query</button><button type="button" onClick={() => void saveDocument()} disabled={!activeDocument}>Save</button><button type="button" onClick={commentDocument} disabled={!activeDocument}>Comment</button><button type="button" onClick={formatDocument} disabled={!activeDocument}>Format</button></div></div>
            <WorkspaceTabs tabs={state.workspace.documentOrder.map(id => ({ id, label: state.workspace.documents[id]?.title ?? id, dirty: state.workspace.documents[id]?.dirty }))} activeId={state.workspace.activeDocumentId} onSelect={selectDocument} onClose={closeDocument} />
            <div className="shared-editor-actions" role="toolbar" aria-label="SQL execution actions"><span className="shared-toolbar-caption">Execute</span><div className="shared-run-actions"><button type="button" onClick={() => void run()}>Run</button><button type="button" onClick={() => void run('smart')}>Smart</button><button type="button" onClick={() => void run('script')}>Batch</button><button type="button" onClick={() => void run('explain')}>Explain</button><button type="button" onClick={() => void runAndExport()}>Run → Export</button><button type="button" onClick={() => void cancel()} disabled={!hasActiveQuery}>Cancel</button></div><span className="shared-toolbar-divider" aria-hidden="true" /><div className="shared-context-controls"><label className="shared-connection-picker">Connection<select aria-label="Connection" value={selectedConnectionId ?? ''} onChange={event => selectConnection(event.target.value)}><option value="">Select connection</option>{state.connections.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><SqlDialectSelect value={authoringDatabaseKind} onChange={selectAuthoringDialect} ariaLabel="SQL authoring dialect" /></div></div>
            <div className="shared-editor-stack"><SharedSqlEditor key={activeDocument?.id ?? DOCUMENT_ID} documentId={activeDocument?.id ?? DOCUMENT_ID} value={activeDocument?.content ?? ''} api={api} preferences={preferences} getContext={() => ({ connectionId: selectedConnection?.id, database: activeDocument?.database ?? selectedConnection?.database, schema: activeDocument?.schema, databaseKind: authoringDatabaseKind })} onChange={updateSql} onRun={() => void run()} onReady={editor => { if (store.getState().workspace.activeDocumentId === (activeDocument?.id ?? DOCUMENT_ID)) editorRef.current = editor; }} onProblemsChange={setProblems} /></div>
            <div className="shared-result-panel">
              {notice && <div role="status">{notice}</div>}
              <ResultPanel
                results={documentResults}
                activeResult={activeResult}
                execution={activeExecution}
                onRetryStatement={retryStatement}
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
                showInlineColumnFilters={false}
              />
            </div>
          </>}
    {importTarget && selectedConnection && <ImportPanel connectionId={selectedConnection.id} target={importTarget} database={importTarget.database ?? activeDocument?.database ?? selectedConnection.database} onClose={() => setImportTarget(undefined)} onCompleted={() => { setImportTarget(undefined); setNotice('Import completed.'); }} />}
    {designerTarget && selectedConnection && <ApiClientProvider client={api}><ObjectDesigner connectionId={selectedConnection.id} database={designerTarget.database ?? selectedConnection.database} databaseKind={selectedConnection.dbType} target={designerTarget} onClose={() => setDesignerTarget(undefined)} onApplied={() => { setDesignerTarget(undefined); setNotice('Object designer change applied. Refresh the schema to see the updated definition.'); refreshSchema(); }} /></ApiClientProvider>}
    {connectionEditor && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setConnectionEditor(undefined); }}><section className="modal-card connection-card" role="dialog" aria-modal="true" aria-labelledby="shared-connection-dialog-title"><div className="section-title"><span id="shared-connection-dialog-title">{connectionEditor.initial ? 'Edit connection' : 'Add connection'}</span><button type="button" className="icon-button" aria-label="Close connection dialog" onClick={() => setConnectionEditor(undefined)}>×</button></div><ConnectionForm api={api} initial={connectionEditor.initial} onCreated={saveConnection} onCancel={() => setConnectionEditor(undefined)} /></section></div>}
    {showSettings && preferences && <EditorSettings value={preferences} onSave={next => { setPreferences(next); setShowSettings(false); setNotice('Settings saved.'); }} onClose={() => setShowSettings(false)} />}
    {showSettings && !preferences && <div className="modal-backdrop"><section className="modal-card" role="dialog" aria-modal="true" aria-label="Editor settings"><div role="status">Loading settings…</div><button type="button" onClick={() => setShowSettings(false)}>Close</button></section></div>}
    {showAudit && <AuditPanel entries={audit} onClose={() => setShowAudit(false)} />}
    {showAdmin && user.role === 'admin' && <AdminPanel onClose={() => setShowAdmin(false)} />}
    {cellViewer && <CellValueViewer column={cellViewer.column} value={cellViewer.value} rowNumber={cellViewer.rowNumber} onClose={() => setCellViewer(undefined)} onCopy={copyCellValue} />}
  </UiShell></ApiClientProvider>;
}
