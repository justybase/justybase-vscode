import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import type { DatabaseKind, EditorPreferences, HistoryEntry, MetadataColumn, MetadataDatabase, QueryColumnFilterSpec, QueryExportFormat, QuerySortSpec, SchemaTreeNode } from '@justybase/contracts';
import type { ExecutionController, ExecutionHandle, UiResultColumn, UiResultSurfaceState, UiStore, UiSurface } from '@justybase/ui-core';
import { createExecutionController, createInitialUiState, createUiStore, resultAsyncState as getResultAsyncState } from '@justybase/ui-core';
import {
  AsyncStateView,
  CapabilityGate,
  DataGrid,
  ExplainView,
  HistoryView,
  ResultTabs,
  ResultViewToolbar,
  RowDetail,
  UiShell,
  WorkspaceTabs,
  createDataGridClipboardPayload,
  disposeSqlLanguageFeatures,
  formatDataGridClipboard,
  formatDataGridCellValue,
  processDataGridRows,
  resolveDataGridColumns,
} from '@justybase/ui-react';
import type { DataGridCellContext, DataGridCopyPayload, GridScrollPosition, HistoryViewEntry } from '@justybase/ui-react';
import { createElectronApiClient } from './api';
import { createElectronExecutionPort, fetchResultPage, RESULT_PAGE_SIZE } from './execution';
import { ProblemsPanel, SqlEditor } from './SqlEditor';
import type { SqlEditorProblem } from './SqlEditor';
import { SchemaExplorer } from './SchemaExplorer';
import { EditRowPanel } from './EditRowPanel';
import { ImportPanel } from './ImportPanel';

type ElectronRow = readonly unknown[];
type ElectronRows = Readonly<Record<string, readonly ElectronRow[]>>;

interface ElectronGridContextMenu {
  readonly clientX: number;
  readonly clientY: number;
  readonly rowIndex: number;
  readonly columnIndex: number;
}

export function resultAsyncState(result: UiResultSurfaceState | undefined, rowCount: number) {
  return getResultAsyncState(result, rowCount);
}

export function displayRows(result: UiResultSurfaceState | undefined, rows: readonly ElectronRow[]): readonly ElectronRow[] {
  if (!result) return [];
  return processDataGridRows(result.columns, rows, result.view);
}

export function asSurface(value: string): UiSurface | undefined {
  return ['workspace', 'editor', 'results', 'schema', 'history', 'explain', 'designer'].includes(value)
    ? value as UiSurface
    : undefined;
}

export function rowsAsText(columns: readonly UiResultColumn[], rows: readonly ElectronRow[]): string {
  return formatDataGridClipboard({ columns, rows }, 'text');
}

export function rowsAsCsv(columns: readonly UiResultColumn[], rows: readonly ElectronRow[]): string {
  const quote = (value: unknown): string => {
    if (value === null || value === undefined) return '""';
    let text: string;
    if (typeof value === 'object') {
      try {
        text = JSON.stringify(value) ?? String(value);
      } catch {
        text = String(value);
      }
    } else {
      text = String(value);
    }
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [columns.map(column => quote(column.name)).join(','), ...rows.map(row => row.map(value => quote(value)).join(','))].join('\n');
}

/** Merges a contiguous API page without creating holes in the renderer window. */
export function mergeElectronResultRows(
  existingRows: readonly ElectronRow[],
  pageRows: readonly ElectronRow[],
  offset: number,
  replace = false,
): readonly ElectronRow[] {
  if (replace || offset === 0) return pageRows.map(row => [...row]);
  if (!Number.isInteger(offset) || offset < 0 || offset > existingRows.length) return existingRows;
  return [
    ...existingRows.slice(0, offset),
    ...pageRows.map(row => [...row]),
    ...existingRows.slice(offset + pageRows.length),
  ];
}

/** Applies a page only when it still belongs to the result execution in the store. */
export function applyHydratedPage(
  store: UiStore,
  sourceId: string,
  resultSetId: string,
  rows: readonly ElectronRow[],
  totalRowCount: number,
  columns: readonly UiResultColumn[],
  executionId: string,
  update: (resultSetId: string, rows: readonly ElectronRow[]) => void,
): boolean {
  const result = Object.values(store.getState().results.byResultSetId)
    .find(item => item.sourceId === sourceId && item.resultSetId === resultSetId);
  if (!result || result.executionId !== executionId) return false;
  update(resultSetId, rows);
  store.dispatch({ type: 'results/hydrate', sourceId: result.sourceId, executionId, resultSetId, loadedRowCount: rows.length, totalRowCount, columns });
  return true;
}

export function App(): ReactElement {
  const storeRef = useRef<UiStore | undefined>(undefined);
  if (!storeRef.current) {
    const store = createUiStore(createInitialUiState({
      productId: 'electron',
      workspaceId: 'electron-profile',
      sourceId: 'electron:scratch',
    }, {
      mode: 'shared',
      persistenceScope: 'profile',
    }));
    store.dispatch({
      type: 'workspace/open-document',
      document: {
        id: 'electron:scratch',
        sourceId: 'electron:scratch',
        title: 'scratch.sql',
        content: 'SELECT 1;',
        dirty: false,
      },
    });
    storeRef.current = store;
  }
  const store = storeRef.current;
  if (!store) throw new Error('Electron UI store failed to initialize.');

  const [booting, setBooting] = useState(true);
  const [rowsByResult, setRowsByResult] = useState<ElectronRows>({});
  const rowsByResultRef = useRef<ElectronRows>({});
  const [selectedRow, setSelectedRow] = useState<number | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [contextMenu, setContextMenu] = useState<ElectronGridContextMenu | undefined>(undefined);
  const [exportFormat, setExportFormat] = useState<QueryExportFormat>('csv');
  const [preferences, setPreferences] = useState<EditorPreferences | null>(null);
  const [problems, setProblems] = useState<readonly SqlEditorProblem[]>([]);
  const [database, setDatabase] = useState('');
  const [schema, setSchema] = useState('');
  const [databases, setDatabases] = useState<readonly MetadataDatabase[]>([]);
  const [history, setHistory] = useState<readonly HistoryEntry[]>([]);
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'error'>('ready');
  const [historyMessage, setHistoryMessage] = useState<string | undefined>(undefined);
  const [selectedObject, setSelectedObject] = useState<SchemaTreeNode | undefined>(undefined);
  const [importTarget, setImportTarget] = useState<SchemaTreeNode | undefined>(undefined);
  const [editRow, setEditRow] = useState<{ target: SchemaTreeNode; values: ElectronRow } | undefined>(undefined);
  const [editColumns, setEditColumns] = useState<readonly MetadataColumn[]>([]);
  const [editColumnsState, setEditColumnsState] = useState<'idle' | 'loading' | 'error'>('idle');
  const activeExecutionRef = useRef<ExecutionHandle | undefined>(undefined);
  const pendingPageRequestsRef = useRef(new Set<string>());
  const pageStateRef = useRef(new Map<string, { readonly totalRows: number; readonly hasMore: boolean }>());
  const clientRef = useRef<ReturnType<typeof createElectronApiClient> | undefined>(undefined);
  const executionRef = useRef<ExecutionController | undefined>(undefined);
  const editorRef = useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import('monaco-editor') | undefined>(undefined);
  const documentContextRef = useRef(new Map<string, { database: string; schema: string }>());
  const documentSequenceRef = useRef(1);
  if (!clientRef.current) clientRef.current = createElectronApiClient();
  if (!executionRef.current) {
    executionRef.current = createExecutionController(store, createElectronExecutionPort({
      client: clientRef.current,
      onRows: (resultSetId, rows) => {
        setRowsByResult(previous => {
          // Streaming remains responsive, but the finalized API page owns the
          // complete result. Never retain an unbounded stream in the renderer.
          const nextRows = [...(previous[resultSetId] ?? []), ...rows].slice(0, RESULT_PAGE_SIZE);
          const next = { ...previous, [resultSetId]: nextRows };
          rowsByResultRef.current = next;
          return next;
        });
      },
      onPage: (sourceId, resultSetId, rows, totalRowCount, columns, executionId, _offset, hasMore) => {
        pageStateRef.current.set(resultSetId, { totalRows: totalRowCount, hasMore });
        applyHydratedPage(store, sourceId, resultSetId, rows, totalRowCount, columns, executionId, (id, nextRows) => {
          const next = { ...rowsByResultRef.current, [id]: nextRows };
          rowsByResultRef.current = next;
          setRowsByResult(next);
        });
      },
    }));
  }
  const execution = executionRef.current;
  if (!execution) throw new Error('Electron execution controller failed to initialize.');

  const subscribe = useCallback((listener: () => void) => store.subscribe(() => listener()), [store]);
  const getSnapshot = useCallback(() => store.getState(), [store]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    let active = true;
    store.dispatch({ type: 'shell/status', status: 'loading' });
    void Promise.all([
      window.justybaseElectron.getAuthState(),
      window.justybaseElectron.listCapabilities(),
      window.justybaseElectron.listConnections(),
    ]).then(([auth, capabilities, profiles]) => {
      if (!active) return;
      store.dispatch({ type: 'auth/set', auth });
      store.dispatch({ type: 'capabilities/set', capabilities: capabilities.descriptors });
      store.dispatch({ type: 'connections/set-profiles', profiles });
      if (profiles[0]) store.dispatch({ type: 'connections/select', connectionId: profiles[0].id });
      store.dispatch({ type: 'shell/status', status: auth.status === 'authenticated' ? 'complete' : 'error', message: auth.message });
      void clientRef.current?.editorPreferences().then(setPreferences).catch(() => undefined);
    }).catch(error => {
      if (!active) return;
      store.dispatch({ type: 'auth/set', auth: { status: 'error', message: error instanceof Error ? error.message : 'Authentication is unavailable.' } });
      store.dispatch({ type: 'shell/status', status: 'error', message: error instanceof Error ? error.message : 'Electron bootstrap failed.' });
    }).finally(() => {
      if (active) setBooting(false);
    });
    return () => { active = false; };
  }, [store]);

  // React StrictMode replays effect cleanup/setup. Delay disposal until the
  // component is genuinely gone so a development replay cannot kill the
  // shared controller used by the second setup pass.
  const mountCountRef = useRef(0);
  useEffect(() => {
    mountCountRef.current += 1;
    return () => {
      mountCountRef.current -= 1;
      queueMicrotask(() => {
        if (mountCountRef.current !== 0) return;
        void execution.dispose().finally(() => store.dispose());
      });
    };
  }, [execution, store]);

  useEffect(() => () => {
    if (monacoRef.current) disposeSqlLanguageFeatures(monacoRef.current);
  }, []);

  const activeDocument = state.workspace.activeDocumentId ? state.workspace.documents[state.workspace.activeDocumentId] : undefined;
  const activeResult = state.results.activeResultSetId
    ? Object.values(state.results.byResultSetId).find(result => result.sourceId === state.results.activeSourceId && result.resultSetId === state.results.activeResultSetId)
    : undefined;
  const rows = activeResult ? rowsByResult[activeResult.resultSetId] ?? [] : [];
  const selectedConnection = state.connections.profiles.find(profile => profile.id === state.connections.selectedConnectionId);
  const resultState = resultAsyncState(activeResult, rows.length);
  const resultMessage = activeResult?.message;

  useEffect(() => {
    if (!activeDocument) return;
    const remembered = documentContextRef.current.get(activeDocument.id);
    const nextDatabase = remembered?.database || selectedConnection?.database || '';
    const nextSchema = remembered?.schema ?? '';
    setDatabase(previous => previous === nextDatabase ? previous : nextDatabase);
    setSchema(previous => previous === nextSchema ? previous : nextSchema);
  }, [activeDocument?.id, selectedConnection?.database]);

  useEffect(() => {
    const connectionId = selectedConnection?.id;
    if (!connectionId) {
      setDatabases([]);
      return undefined;
    }
    let active = true;
    void clientRef.current?.databases(connectionId).then(next => {
      if (active) setDatabases(Array.isArray(next) ? next : []);
    }).catch(error => {
      if (active) setNotice(error instanceof Error ? error.message : 'Could not load databases.');
    });
    return () => { active = false; };
  }, [selectedConnection?.id]);

  useEffect(() => {
    if (state.shell.activeSurface !== 'history') return undefined;
    let active = true;
    setHistoryState('loading');
    setHistoryMessage(undefined);
    void clientRef.current?.history().then(entries => {
      if (!active) return;
      setHistory(Array.isArray(entries) ? entries : []);
      setHistoryState('ready');
    }).catch(error => {
      if (!active) return;
      setHistoryState('error');
      setHistoryMessage(error instanceof Error ? error.message : 'Could not load query history.');
    });
    return () => { active = false; };
  }, [state.shell.activeSurface]);

  useEffect(() => {
    setSelectedRow(undefined);
  }, [activeResult?.sourceId, activeResult?.resultSetId]);

  const updateRows = useCallback((resultSetId: string, nextRows: readonly ElectronRow[]): void => {
    const next = { ...rowsByResultRef.current, [resultSetId]: nextRows };
    rowsByResultRef.current = next;
    setRowsByResult(next);
  }, []);

  const openDocument = useCallback((content: string, title: string, sourceId = `electron:document:${documentSequenceRef.current++}`): void => {
    const connectionId = selectedConnection?.id;
    documentContextRef.current.set(sourceId, { database: database || selectedConnection?.database || '', schema });
    store.dispatch({
      type: 'workspace/open-document',
      document: { id: sourceId, sourceId, title, content, dirty: false, connectionId },
    });
    store.dispatch({ type: 'workspace/select-document', documentId: sourceId });
    store.dispatch({ type: 'shell/surface', surface: 'workspace' });
  }, [database, schema, selectedConnection?.database, selectedConnection?.id, store]);

  const closeDocument = useCallback((documentId: string): void => {
    if (state.workspace.documentOrder.length <= 1) return;
    const document = state.workspace.documents[documentId];
    if (document?.dirty && typeof window !== 'undefined' && !window.confirm(`Close modified document “${document.title}”?`)) return;
    documentContextRef.current.delete(documentId);
    store.dispatch({ type: 'workspace/close-document', documentId });
  }, [state.workspace.documentOrder.length, state.workspace.documents, store]);

  const insertSql = useCallback((value: string): void => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) {
      if (activeDocument) store.dispatch({ type: 'workspace/update-document', documentId: activeDocument.id, patch: { content: `${activeDocument.content}${value}`, dirty: true } });
      return;
    }
    const selection = editor.getSelection() ?? model.getFullModelRange();
    editor.executeEdits('schema-insert', [{ range: selection, text: value, forceMoveMarkers: true }]);
    editor.focus();
  }, [activeDocument, store]);

  const selectConnection = useCallback((connectionId: string): void => {
    store.dispatch({ type: 'connections/select', connectionId });
    if (activeDocument) store.dispatch({ type: 'workspace/update-document', documentId: activeDocument.id, patch: { connectionId } });
  }, [activeDocument, store]);

  const selectDatabase = useCallback((nextDatabase: string): void => {
    setDatabase(nextDatabase);
    if (activeDocument) documentContextRef.current.set(activeDocument.id, { database: nextDatabase, schema });
    setSchema('');
  }, [activeDocument, schema]);

  const handleEditorProblems = useCallback((nextProblems: readonly SqlEditorProblem[]): void => {
    setProblems(nextProblems);
  }, []);

  const revealProblem = useCallback((problem: SqlEditorProblem): void => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(problem.startLineNumber);
    editor.setPosition({ lineNumber: problem.startLineNumber, column: problem.startColumn });
    editor.focus();
  }, []);

  const openSchemaQuery = useCallback((sql: string, title: string, node?: SchemaTreeNode): void => {
    if (node?.database) setDatabase(node.database);
    if (node?.schema) setSchema(node.schema);
    openDocument(sql, title);
  }, [openDocument]);

  const openHistoryEntry = useCallback((entry: HistoryEntry): void => {
    openDocument(entry.sql, `History · ${entry.createdAt.slice(0, 19)}`, `electron:history:${entry.id}`);
  }, [openDocument]);

  const openDdl = useCallback((sql: string, title: string, node: SchemaTreeNode): void => {
    if (node.database) setDatabase(node.database);
    if (node.schema) setSchema(node.schema);
    openDocument(sql, title);
  }, [openDocument]);

  const saveDocument = useCallback((): void => {
    if (!activeDocument) return;
    store.dispatch({ type: 'workspace/update-document', documentId: activeDocument.id, patch: { dirty: false } });
    setNotice('Document saved for this Electron profile.');
  }, [activeDocument, store]);

  const formatDocument = useCallback((): void => {
    void editorRef.current?.getAction('editor.action.formatDocument')?.run();
  }, []);

  const commentDocument = useCallback((): void => {
    void editorRef.current?.getAction('editor.action.commentLine')?.run();
  }, []);

  const selectProblem = useCallback((problem: SqlEditorProblem): void => {
    revealProblem(problem);
  }, [revealProblem]);

  const resultViewRequestKey = useCallback((view: UiResultSurfaceState['view']): string => {
    const columnFilters = Object.entries(view.columnFilters)
      .filter(([, value]) => value.trim().length > 0)
      .sort(([left], [right]) => left.localeCompare(right));
    return JSON.stringify({
      globalFilter: view.globalFilter,
      columnFilters,
      sorting: view.sorting,
    });
  }, []);

  const loadResultPage = useCallback(async (
    result: UiResultSurfaceState,
    offset: number,
    replace: boolean,
    requestedView = result.view,
  ): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    const columnFilters: QueryColumnFilterSpec[] = Object.entries(requestedView.columnFilters)
      .flatMap(([column, value]) => {
        const columnIndex = result.columns.findIndex(item => item.name === column || String(result.columns.indexOf(item)) === column);
        return columnIndex >= 0 && value.trim() ? [{ columnIndex, value }] : [];
      });
    const sorting: QuerySortSpec[] = requestedView.sorting.flatMap(item => {
      const columnIndex = result.columns.findIndex(column => column.name === item.column || String(result.columns.indexOf(column)) === item.column);
      return columnIndex >= 0 ? [{ columnIndex, desc: item.descending }] : [];
    });
    const viewKey = resultViewRequestKey(requestedView);
    const requestKey = `${result.sourceId}\u0000${result.resultSetId}\u0000${result.executionId}\u0000${offset}\u0000${viewKey}`;
    if (pendingPageRequestsRef.current.has(requestKey)) return;
    pendingPageRequestsRef.current.add(requestKey);
    try {
      const page = await fetchResultPage(client, result.executionId, result.statementIndex, offset, RESULT_PAGE_SIZE, {
        ...(requestedView.globalFilter.trim() ? { globalFilter: requestedView.globalFilter } : {}),
        ...(columnFilters.length > 0 ? { columnFilters } : {}),
        ...(sorting.length > 0 ? { sorting } : {}),
      });
      const current = Object.values(store.getState().results.byResultSetId)
        .find(item => item.sourceId === result.sourceId && item.resultSetId === result.resultSetId);
      if (!current || current.executionId !== result.executionId || resultViewRequestKey(current.view) !== viewKey) return;
      const existingRows = rowsByResultRef.current[result.resultSetId] ?? [];
      const nextRows = mergeElectronResultRows(existingRows, page.rows, page.offset, replace || page.offset === 0);
      updateRows(result.resultSetId, nextRows);
      pageStateRef.current.set(result.resultSetId, { totalRows: page.totalRowCount, hasMore: page.hasMore });
      store.dispatch({
        type: 'results/hydrate',
        sourceId: current.sourceId,
        executionId: current.executionId,
        resultSetId: current.resultSetId,
        loadedRowCount: nextRows.length,
        totalRowCount: page.totalRowCount,
        columns: page.columns,
      });
    } catch (error: unknown) {
      const current = Object.values(store.getState().results.byResultSetId)
        .find(item => item.sourceId === result.sourceId && item.resultSetId === result.resultSetId);
      if (current?.executionId === result.executionId && current.status !== 'cancelled' && current.status !== 'error') {
        setNotice(error instanceof Error ? error.message : 'Could not load result rows.');
      }
    } finally {
      pendingPageRequestsRef.current.delete(requestKey);
    }
  }, [resultViewRequestKey, store, updateRows]);

  const run = useCallback(async (mode: 'single' | 'script' | 'explain' = 'single'): Promise<void> => {
    if (!selectedConnection) {
      setNotice('Select a connection before running SQL.');
      return;
    }
    if (!activeDocument?.content.trim()) {
      setNotice('Enter SQL before running the document.');
      return;
    }
    const previous = activeExecutionRef.current;
    const previousResult = previous
      ? Object.values(store.getState().results.byResultSetId).find(result => result.executionId === previous.executionId)
      : undefined;
    if (previous && (previousResult?.status === 'loading' || previousResult?.status === 'streaming')) await execution.cancel(previous.sourceId, previous.executionId);
    setNotice(undefined);
    setSelectedRow(undefined);
    try {
      const editor = editorRef.current;
      const model = editor?.getModel();
      const selection = editor?.getSelection();
      const selectedSql = model && selection && !selection.isEmpty() ? model.getValueInRange(selection) : '';
      const sql = selectedSql.trim() && mode === 'single' ? selectedSql : activeDocument.content;
      const cursorOffset = model && editor?.getPosition() ? model.getOffsetAt(editor.getPosition()!) : undefined;
      const handle = await execution.run({ sourceId: activeDocument.sourceId, sql, connectionId: selectedConnection.id, mode, ...(selectedSql.trim() ? {} : { cursorOffset }) });
      activeExecutionRef.current = handle;
      pageStateRef.current.delete(handle.resultSetId);
      updateRows(handle.resultSetId, []);
      store.dispatch({ type: 'results/select', sourceId: handle.sourceId, resultSetId: handle.resultSetId });
      store.dispatch({ type: 'shell/surface', surface: 'results' });
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : 'Could not start query.');
    }
  }, [activeDocument, execution, selectedConnection, store, updateRows]);

  const cancel = useCallback(async (): Promise<void> => {
    const active = activeExecutionRef.current;
    if (!active) return;
    await execution.cancel(active.sourceId, active.executionId);
  }, [execution]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!activeResult) return;
    setNotice(undefined);
    await loadResultPage(activeResult, 0, true);
  }, [activeResult, loadResultPage]);

  const updateView = useCallback((patch: Partial<UiResultSurfaceState['view']>): void => {
    if (!activeResult) return;
    const nextView = { ...activeResult.view, ...patch };
    store.dispatch({ type: 'results/view', sourceId: activeResult.sourceId, resultSetId: activeResult.resultSetId, patch });
    if (patch.globalFilter !== undefined || patch.columnFilters !== undefined || patch.sorting !== undefined) {
      pageStateRef.current.delete(activeResult.resultSetId);
      void loadResultPage({ ...activeResult, view: nextView }, 0, true, nextView);
    }
  }, [activeResult, loadResultPage, store]);

  const loadMoreRows = useCallback((): void => {
    if (!activeResult) return;
    const loadedRows = rowsByResultRef.current[activeResult.resultSetId]?.length ?? 0;
    const pageState = pageStateRef.current.get(activeResult.resultSetId);
    const totalRows = pageState?.totalRows ?? activeResult.totalRowCount;
    if (loadedRows >= totalRows || pageState?.hasMore === false) return;
    void loadResultPage(activeResult, loadedRows, false);
  }, [activeResult, loadResultPage]);

  const detailColumns = useMemo(
    () => activeResult ? resolveDataGridColumns(activeResult.columns, rows) : [],
    [activeResult?.columns, rows],
  );

  const copyText = useCallback(async (text: string): Promise<void> => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setNotice('Clipboard access is unavailable.');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setNotice('Copied.');
    } catch {
      setNotice('Could not copy to the clipboard.');
    }
  }, []);

  const copyGridPayload = useCallback(async (payload: DataGridCopyPayload): Promise<void> => {
    const formatted = createDataGridClipboardPayload(payload);
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setNotice('Clipboard access is unavailable.');
      return;
    }
    try {
      if (typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard.write === 'function') {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([formatted.html], { type: 'text/html' }),
          'text/plain': new Blob([formatted.text], { type: 'text/plain' }),
        })]);
      } else {
        await navigator.clipboard.writeText(formatted.text);
      }
      setNotice('Copied.');
    } catch {
      try {
        await navigator.clipboard.writeText(formatted.text);
        setNotice('Copied.');
      } catch {
        setNotice('Could not copy to the clipboard.');
      }
    }
  }, []);

  const copyGridSelection = useCallback((payload: DataGridCopyPayload): void => {
    void copyGridPayload(payload);
  }, [copyGridPayload]);

  const copyActive = useCallback(async (): Promise<void> => {
    const row = selectedRow === undefined ? rows[0] : rows[selectedRow];
    if (!row || !activeResult) return;
    await copyGridPayload({ columns: activeResult.columns, rows: [row] });
  }, [activeResult, copyGridPayload, rows, selectedRow]);

  const exportActive = useCallback(async (): Promise<void> => {
    if (!activeResult || typeof document === 'undefined') return;
    const columnFilters: QueryColumnFilterSpec[] = Object.entries(activeResult.view.columnFilters)
      .flatMap(([column, value]) => {
        const columnIndex = activeResult.columns.findIndex(item => item.name === column || String(activeResult.columns.indexOf(item)) === column);
        return columnIndex >= 0 && value.trim() ? [{ columnIndex, value }] : [];
      });
    const sorting: QuerySortSpec[] = activeResult.view.sorting.flatMap(item => {
      const columnIndex = activeResult.columns.findIndex(column => column.name === item.column || String(activeResult.columns.indexOf(column)) === item.column);
      return columnIndex >= 0 ? [{ columnIndex, desc: item.descending }] : [];
    });
    try {
      const downloaded = await clientRef.current!.exportQuery(activeResult.executionId, {
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
  }, [activeResult, exportFormat]);

  const openEditRow = useCallback(async (context: ElectronGridContextMenu): Promise<void> => {
    const target = selectedObject;
    const row = rows[context.rowIndex];
    const connectionId = selectedConnection?.id;
    const targetDatabase = database || target?.database;
    if (!target || target.kind !== 'object' || target.objectType?.toUpperCase() === 'VIEW' || !target.schema || !target.objectName || !connectionId || !targetDatabase || !row) {
      setNotice('Select a writable table in the schema explorer before editing a row.');
      setContextMenu(undefined);
      return;
    }
    setContextMenu(undefined);
    setEditColumnsState('loading');
    setEditRow({ target, values: row });
    try {
      const loaded = await clientRef.current!.columns(connectionId, targetDatabase, target.schema, target.objectName);
      if (loaded.length > 0) {
        setEditColumns(loaded);
      } else {
        setEditColumns((activeResult?.columns ?? []).map(column => ({ name: column.name, type: column.type })));
      }
      setEditColumnsState('idle');
    } catch (error: unknown) {
      setEditColumnsState('error');
      setEditRow(undefined);
      setNotice(error instanceof Error ? error.message : 'Could not load table columns.');
    }
  }, [activeResult?.columns, database, rows, selectedConnection?.id, selectedObject]);

  const contextRow = contextMenu ? rows[contextMenu.rowIndex] : undefined;
  const closeContextMenu = useCallback((): void => setContextMenu(undefined), []);
  const contextText = useCallback((context: DataGridCellContext, format: 'value' | 'row'): string | undefined => {
    const row = rows[context.rowIndex];
    const column = activeResult?.columns[context.columnIndex];
    if (!row || !column) return undefined;
    if (format === 'value') return formatDataGridCellValue(row[context.columnIndex], column.type, column);
    return rowsAsText(activeResult.columns, [row]);
  }, [activeResult, rows]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = (): void => setContextMenu(undefined);
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') close(); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  const selectSurface = useCallback((surface: string): void => {
    const next = asSurface(surface);
    if (next) store.dispatch({ type: 'shell/surface', surface: next });
  }, [store]);

  if (booting) return <AsyncStateView state="loading" loadingLabel="Starting authenticated workspace…" /> as ReactElement;
  if (state.auth.status !== 'authenticated') return <AsyncStateView state="error" message={state.auth.message ?? 'Authentication is unavailable.'} /> as ReactElement;

  const workspaceCapability = state.capabilities.find(descriptor => descriptor.key === 'workspace');
  const explainCapability = state.capabilities.find(descriptor => descriptor.key === 'explain');
  const historyCapability = state.capabilities.find(descriptor => descriptor.key === 'history');
  const metadataCapability = state.capabilities.find(descriptor => descriptor.key === 'metadata');
  const databaseKind = (selectedConnection?.dbType ?? 'netezza') as DatabaseKind;
  const surfaces: readonly { id: UiSurface; label: string }[] = [
    { id: 'workspace', label: 'Workspace' },
    { id: 'results', label: 'Results' },
    { id: 'history', label: 'History' },
    { id: 'explain', label: 'Explain' },
  ];
  const historyItems: HistoryViewEntry[] = history.map(entry => ({
    id: entry.id,
    label: entry.sql.slice(0, 120) || '(empty SQL)',
    status: entry.status,
    sqlFingerprint: `${entry.createdAt} · ${entry.rowCount.toLocaleString()} rows · ${entry.durationMs} ms`,
  }));
  const onScroll = (position: GridScrollPosition): void => {
    if (activeResult && position.resultSetId === activeResult.resultSetId) updateView({ scrollTop: position.top, scrollLeft: position.left, anchorRow: position.anchorRow });
  };

  return <CapabilityGate capability={workspaceCapability}><>
    <UiShell
    title="JustyBase"
    activeSurface={state.shell.activeSurface}
    onSurfaceChange={selectSurface}
    surfaces={surfaces}
    sidebar={<div className="electron-sidebar-content">
      <div className="electron-sidebar-title"><strong>Explorer</strong><button type="button" onClick={() => openDocument('SELECT 1;', 'query.sql')}>New SQL</button></div>
      <section className="electron-connections" aria-label="Connections"><div className="electron-section-heading"><strong>Connections</strong><span>{state.connections.profiles.length}</span></div>{state.connections.profiles.length === 0 ? <span className="electron-schema-empty">No connections configured.</span> : state.connections.profiles.map(profile => <button type="button" className={profile.id === state.connections.selectedConnectionId ? 'active' : ''} key={profile.id} aria-pressed={profile.id === state.connections.selectedConnectionId} onClick={() => selectConnection(profile.id)}><span className="electron-connection-dot" /><span>{profile.name}</span><small>{profile.dbType}</small></button>)}</section>
      <CapabilityGate capability={metadataCapability} fallback={<div className="electron-capability-muted">{metadataCapability?.reason ?? 'Schema metadata unavailable.'}</div>}><SchemaExplorer api={clientRef.current!} connectionId={selectedConnection?.id} database={database} databaseKind={databaseKind} onInsert={insertSql} onObjectSelect={setSelectedObject} onOpenQuery={openSchemaQuery} onOpenDdl={openDdl} onImport={setImportTarget} /></CapabilityGate>
    </div>}
  >
    {state.shell.activeSurface === 'history' ? <CapabilityGate capability={historyCapability} fallback={<AsyncStateView state="empty" emptyLabel="History is not available in this Electron shell yet." />}><HistoryView entries={historyItems} state={historyState} message={historyMessage} onOpen={entry => { const item = history.find(candidate => candidate.id === entry.id); if (item) openHistoryEntry(item); }} /></CapabilityGate>
      : state.shell.activeSurface === 'explain' ? <CapabilityGate capability={explainCapability} fallback={<AsyncStateView state="empty" emptyLabel="Explain is not available in this Electron shell yet." />}><ExplainView state={activeResult ? resultState : 'empty'} plan={activeResult?.message} message={resultMessage} onCancel={() => void cancel()} /></CapabilityGate>
        : <div className="electron-workspace-content">
          <WorkspaceTabs tabs={state.workspace.documentOrder.map(id => ({ id, label: state.workspace.documents[id]?.title ?? id, dirty: state.workspace.documents[id]?.dirty }))} activeId={state.workspace.activeDocumentId} onSelect={id => store.dispatch({ type: 'workspace/select-document', documentId: id })} onClose={closeDocument} />
          <div className="electron-editor-toolbar" role="toolbar" aria-label="SQL editor actions">
            <button type="button" onClick={() => openDocument('SELECT 1;', 'query.sql')}>＋ SQL</button>
            <button type="button" onClick={saveDocument}>Save</button>
            <button type="button" onClick={commentDocument}>Comment</button>
            <button type="button" onClick={formatDocument}>Format</button>
            <span className="electron-toolbar-spacer" />
            <label>Connection<select aria-label="Editor connection" value={selectedConnection?.id ?? ''} onChange={event => selectConnection(event.target.value)}><option value="">Select connection</option>{state.connections.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
            <label>Database<select aria-label="Editor database" value={database} disabled={!selectedConnection} onChange={event => selectDatabase(event.target.value)}><option value="">{selectedConnection ? 'Select database' : 'Select connection'}</option>{databases.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
            <button type="button" className="electron-run-button" aria-label="Run" onClick={() => void run()} disabled={!activeDocument}>▶ Run</button>
            <button type="button" onClick={() => void run('script')} disabled={!selectedConnection || !activeDocument}>Run script</button>
            <button type="button" aria-label="Explain current SQL" onClick={() => void run('explain')} disabled={!selectedConnection || !activeDocument}>Explain</button>
            <button type="button" onClick={() => void cancel()} disabled={activeResult?.status !== 'loading' && activeResult?.status !== 'streaming'}>Cancel</button>
          </div>
          {notice && <div className="electron-notice" role="status">{notice}</div>}
          <div className="electron-editor-area"><SqlEditor documentId={activeDocument?.id ?? 'empty'} value={activeDocument?.content ?? ''} api={clientRef.current!} preferences={preferences} getContext={() => ({ connectionId: selectedConnection?.id, database, schema, databaseKind })} onChange={content => activeDocument && store.dispatch({ type: 'workspace/update-document', documentId: activeDocument.id, patch: { content, dirty: true } })} onRun={() => void run()} onReady={(editor, monaco) => { editorRef.current = editor; monacoRef.current = monaco; }} onProblemsChange={handleEditorProblems} /></div>
          <ProblemsPanel problems={problems} onSelect={selectProblem} />
          <div className="electron-result-panel">
            <div className="electron-result-heading"><strong>Results</strong><ResultTabs results={Object.values(state.results.byResultSetId)} activeResultSetId={state.results.activeResultSetId} activeSourceId={state.results.activeSourceId} onSelect={(resultSetId, sourceId) => store.dispatch({ type: 'results/select', sourceId, resultSetId })} /></div>
            {activeResult && <div className="electron-result-controls"><ResultViewToolbar columns={activeResult.columns} view={activeResult.view} onChange={updateView} onRefresh={() => void refresh()} onCopy={() => void copyActive()} onExport={() => void exportActive()} /><label className="electron-export-format">Export<select aria-label="Electron export format" value={exportFormat} onChange={event => setExportFormat(event.target.value as QueryExportFormat)}><option value="csv">CSV</option><option value="json">JSON</option><option value="xml">XML</option><option value="sql">SQL INSERT</option><option value="markdown">Markdown</option><option value="xlsx">XLSX</option><option value="xlsb">XLSB</option></select></label></div>}
            <AsyncStateView state={resultState} message={resultMessage} emptyLabel="No rows to display." loadingLabel="Streaming result data…"><DataGrid sourceId={activeResult?.sourceId} resultSetId={activeResult?.resultSetId ?? 'empty'} columns={activeResult?.columns ?? []} rows={rows} totalRowCount={activeResult?.totalRowCount} view={activeResult?.view} clientProcessing={false} onViewChange={updateView} onLoadMore={loadMoreRows} selectedRowIndex={selectedRow} scroll={activeResult ? { sourceId: activeResult.sourceId, resultSetId: activeResult.resultSetId, top: activeResult.view.scrollTop, left: activeResult.view.scrollLeft, anchorRow: activeResult.view.anchorRow } : undefined} onScroll={onScroll} onCopySelection={copyGridSelection} onContextMenu={context => setContextMenu(context)} onRowSelect={setSelectedRow} /></AsyncStateView>
            {contextMenu && contextRow && activeResult && <div className="electron-grid-context-menu" role="menu" style={{ left: contextMenu.clientX, top: contextMenu.clientY }} onClick={event => event.stopPropagation()}><button type="button" role="menuitem" onClick={() => { const text = contextText(contextMenu, 'value'); if (text !== undefined) void copyText(text); closeContextMenu(); }}>Copy value</button><button type="button" role="menuitem" onClick={() => { const text = contextText(contextMenu, 'row'); if (text !== undefined) void copyText(text); closeContextMenu(); }}>Copy row</button><button type="button" role="menuitem" onClick={() => { const column = activeResult.columns[contextMenu.columnIndex]; if (column) updateView({ columnFilters: { ...activeResult.view.columnFilters, [column.name]: String(contextRow[contextMenu.columnIndex] ?? '') } }); closeContextMenu(); }}>Filter by value</button><button type="button" role="menuitem" onClick={() => { const column = activeResult.columns[contextMenu.columnIndex]; if (column) updateView({ sorting: [{ column: column.name, descending: false }] }); closeContextMenu(); }}>Sort ascending</button><button type="button" role="menuitem" onClick={() => { setSelectedRow(contextMenu.rowIndex); closeContextMenu(); }}>View full row</button>{selectedObject?.kind === 'object' && selectedObject.objectType?.toUpperCase() !== 'VIEW' && <button type="button" role="menuitem" onClick={() => void openEditRow(contextMenu)}>Edit row</button>}</div>}
            {activeResult && selectedRow !== undefined && rows[selectedRow] && <RowDetail columns={detailColumns} row={rows[selectedRow]} onClose={() => setSelectedRow(undefined)} />}
          </div>
        </div>}
    </UiShell>
    {importTarget && selectedConnection && clientRef.current && <ImportPanel api={clientRef.current} connectionId={selectedConnection.id} target={importTarget} database={database} onClose={() => setImportTarget(undefined)} onCompleted={() => { setImportTarget(undefined); setNotice('Import completed. Refresh the schema or rerun the query to see new rows.'); }} />}
    {editRow && selectedConnection && clientRef.current && <>{editColumnsState === 'loading' ? <div className="electron-modal-backdrop" role="presentation"><div className="electron-modal-card" role="status">Loading table columns…</div></div> : editColumnsState === 'error' ? null : <EditRowPanel api={clientRef.current} connectionId={selectedConnection.id} database={database || editRow.target.database || ''} target={editRow.target} columns={editColumns} values={editRow.values} onClose={() => setEditRow(undefined)} onCompleted={message => { setEditRow(undefined); setNotice(message); void refresh(); }} />}</>}
  </></CapabilityGate> as ReactElement;
}
