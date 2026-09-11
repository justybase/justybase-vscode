import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import type { ExecutionController, ExecutionHandle, UiResultSurfaceState, UiStore, UiSurface } from '@justybase/ui-core';
import { createExecutionController, createInitialUiState, createUiStore } from '@justybase/ui-core';
import {
  AsyncStateView,
  CapabilityGate,
  DataGrid,
  EditorSurface,
  ExplainView,
  HistoryView,
  ResultTabs,
  ResultViewToolbar,
  RowDetail,
  UiShell,
  WorkspaceTabs,
  formatDataGridCellValue,
  processDataGridRows,
} from '@justybase/ui-react';
import type { GridScrollPosition, HistoryViewEntry } from '@justybase/ui-react';
import { createElectronApiClient } from './api';
import { createElectronExecutionPort, fetchAllResultPages } from './execution';

type ElectronRow = readonly unknown[];
type ElectronRows = Readonly<Record<string, readonly ElectronRow[]>>;

export function resultAsyncState(result: UiResultSurfaceState | undefined, rowCount: number): 'loading' | 'empty' | 'error' | 'cancelled' | 'ready' {
  if (!result) return 'empty';
  if (result.status === 'error') return 'error';
  if (result.status === 'cancelled') return 'cancelled';
  if (result.status === 'loading' || (result.status === 'streaming' && rowCount === 0)) return 'loading';
  if (result.status === 'empty' || rowCount === 0) return 'empty';
  return 'ready';
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

export function rowsAsText(columns: readonly { readonly name: string; readonly type?: string }[], rows: readonly ElectronRow[]): string {
  return [columns.map(column => column.name).join('\t'), ...rows.map(row => row.map((value, index) => formatDataGridCellValue(value, columns[index]?.type)).join('\t'))].join('\n');
}

export function rowsAsCsv(columns: readonly { readonly name: string }[], rows: readonly ElectronRow[]): string {
  const quote = (value: unknown): string => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [columns.map(column => quote(column.name)).join(','), ...rows.map(row => row.map(quote).join(','))].join('\n');
}

/** Applies a page only when it still belongs to the result execution in the store. */
export function applyHydratedPage(
  store: UiStore,
  resultSetId: string,
  rows: readonly ElectronRow[],
  totalRowCount: number,
  columns: readonly { readonly name: string; readonly type?: string }[],
  executionId: string,
  update: (resultSetId: string, rows: readonly ElectronRow[]) => void,
): boolean {
  const result = Object.values(store.getState().results.byResultSetId)
    .find(item => item.sourceId === 'electron:scratch' && item.resultSetId === resultSetId);
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
  const activeExecutionRef = useRef<ExecutionHandle | undefined>(undefined);
  const clientRef = useRef<ReturnType<typeof createElectronApiClient> | undefined>(undefined);
  const executionRef = useRef<ExecutionController | undefined>(undefined);
  if (!clientRef.current) clientRef.current = createElectronApiClient();
  if (!executionRef.current) {
    executionRef.current = createExecutionController(store, createElectronExecutionPort({
      client: clientRef.current,
      onRows: (resultSetId, rows) => {
        setRowsByResult(previous => {
          const next = { ...previous, [resultSetId]: [...(previous[resultSetId] ?? []), ...rows] };
          rowsByResultRef.current = next;
          return next;
        });
      },
      onPage: (resultSetId, rows, totalRowCount, columns, executionId) => {
        applyHydratedPage(store, resultSetId, rows, totalRowCount, columns, executionId, (id, nextRows) => {
          const next = { ...rowsByResultRef.current, [id]: nextRows };
          rowsByResultRef.current = next;
          setRowsByResult(next);
        });
      },
      onPageError: (_resultSetId, error, executionId) => {
        if (activeExecutionRef.current?.executionId === executionId) setNotice(error.message);
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

  const activeDocument = state.workspace.activeDocumentId ? state.workspace.documents[state.workspace.activeDocumentId] : undefined;
  const activeResult = state.results.activeResultSetId
    ? Object.values(state.results.byResultSetId).find(result => result.sourceId === state.results.activeSourceId && result.resultSetId === state.results.activeResultSetId)
    : undefined;
  const rows = activeResult ? rowsByResult[activeResult.resultSetId] ?? [] : [];
  const visibleRows = useMemo(() => displayRows(activeResult, rows), [activeResult, rows]);
  const selectedConnection = state.connections.profiles.find(profile => profile.id === state.connections.selectedConnectionId);
  const resultState = resultAsyncState(activeResult, visibleRows.length);
  const resultMessage = activeResult?.message;

  const updateRows = useCallback((resultSetId: string, nextRows: readonly ElectronRow[]): void => {
    const next = { ...rowsByResultRef.current, [resultSetId]: nextRows };
    rowsByResultRef.current = next;
    setRowsByResult(next);
  }, []);

  const run = useCallback(async (mode: 'single' | 'explain' = 'single'): Promise<void> => {
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
      const handle = await execution.run({ sourceId: 'electron:scratch', sql: activeDocument.content, connectionId: selectedConnection.id, mode });
      activeExecutionRef.current = handle;
      updateRows(handle.resultSetId, []);
      store.dispatch({ type: 'results/select', sourceId: handle.sourceId, resultSetId: handle.resultSetId });
      store.dispatch({ type: 'shell/surface', surface: 'results' });
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : 'Could not start query.');
    }
  }, [activeDocument?.content, execution, selectedConnection, store, updateRows]);

  const cancel = useCallback(async (): Promise<void> => {
    const active = activeExecutionRef.current;
    if (!active) return;
    await execution.cancel(active.sourceId, active.executionId);
  }, [execution]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!activeResult) return;
    const { executionId, resultSetId, statementIndex } = activeResult;
    try {
      const hydrated = await fetchAllResultPages(clientRef.current!, executionId, statementIndex);
      applyHydratedPage(store, resultSetId, hydrated.rows, hydrated.totalRowCount, hydrated.columns, executionId, updateRows);
      setNotice(undefined);
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : 'Could not refresh results.');
    }
  }, [activeResult, store, updateRows]);

  const updateView = useCallback((patch: Partial<UiResultSurfaceState['view']>): void => {
    if (activeResult) store.dispatch({ type: 'results/view', sourceId: activeResult.sourceId, resultSetId: activeResult.resultSetId, patch });
  }, [activeResult, store]);

  const copyActive = useCallback(async (): Promise<void> => {
    const row = selectedRow === undefined ? visibleRows[0] : visibleRows[selectedRow];
    if (!row || !activeResult) return;
    const text = rowsAsText(activeResult.columns, [row]);
    if (typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(text);
    setNotice('Result copied.');
  }, [activeResult, selectedRow, visibleRows]);

  const exportActive = useCallback((): void => {
    if (!activeResult || typeof document === 'undefined') return;
    const url = URL.createObjectURL(new Blob([rowsAsCsv(activeResult.columns, visibleRows)], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'justybase-result.csv';
    link.click();
    URL.revokeObjectURL(url);
    setNotice('Result exported.');
  }, [activeResult, visibleRows]);

  const selectSurface = useCallback((surface: string): void => {
    const next = asSurface(surface);
    if (next) store.dispatch({ type: 'shell/surface', surface: next });
  }, [store]);

  if (booting) return <AsyncStateView state="loading" loadingLabel="Starting authenticated workspace…" /> as ReactElement;
  if (state.auth.status !== 'authenticated') return <AsyncStateView state="error" message={state.auth.message ?? 'Authentication is unavailable.'} /> as ReactElement;

  const workspaceCapability = state.capabilities.find(descriptor => descriptor.key === 'workspace');
  const explainCapability = state.capabilities.find(descriptor => descriptor.key === 'explain');
  const historyCapability = state.capabilities.find(descriptor => descriptor.key === 'history');
  const surfaces: readonly { id: UiSurface; label: string }[] = [
    { id: 'workspace', label: 'Workspace' },
    { id: 'results', label: 'Results' },
    { id: 'history', label: 'History' },
    { id: 'explain', label: 'Explain' },
  ];
  const historyItems: HistoryViewEntry[] = [];
  const onScroll = (position: GridScrollPosition): void => {
    if (activeResult && position.resultSetId === activeResult.resultSetId) updateView({ scrollTop: position.top, scrollLeft: position.left, anchorRow: position.anchorRow });
  };

  return <CapabilityGate capability={workspaceCapability}><UiShell
    title="JustyBase"
    activeSurface={state.shell.activeSurface}
    onSurfaceChange={selectSurface}
    surfaces={surfaces}
    sidebar={<>
      <WorkspaceTabs
        tabs={state.workspace.documentOrder.map(id => ({ id, label: state.workspace.documents[id]?.title ?? id, dirty: state.workspace.documents[id]?.dirty }))}
        activeId={state.workspace.activeDocumentId}
        onSelect={id => store.dispatch({ type: 'workspace/select-document', documentId: id })}
      />
      <section aria-label="Connections"><strong>Connections</strong>{state.connections.profiles.map(profile => <button type="button" key={profile.id} aria-pressed={profile.id === state.connections.selectedConnectionId} onClick={() => store.dispatch({ type: 'connections/select', connectionId: profile.id })}>{profile.name}</button>)}</section>
    </>}
  >
    {state.shell.activeSurface === 'history' ? <CapabilityGate capability={historyCapability} fallback={<AsyncStateView state="empty" emptyLabel="History is not available in this Electron shell yet." />}><HistoryView entries={historyItems} state="empty" /></CapabilityGate>
      : state.shell.activeSurface === 'explain' ? <CapabilityGate capability={explainCapability} fallback={<AsyncStateView state="empty" emptyLabel="Explain is not available in this Electron shell yet." />}><ExplainView state={activeResult ? resultState : 'empty'} plan={activeResult?.message} message={resultMessage} onCancel={() => void cancel()} /></CapabilityGate>
        : <>
          <WorkspaceTabs
            tabs={state.workspace.documentOrder.map(id => ({ id, label: state.workspace.documents[id]?.title ?? id, dirty: state.workspace.documents[id]?.dirty }))}
            activeId={state.workspace.activeDocumentId}
            onSelect={id => store.dispatch({ type: 'workspace/select-document', documentId: id })}
          />
          <EditorSurface value={activeDocument?.content ?? ''} onChange={content => activeDocument && store.dispatch({ type: 'workspace/update-document', documentId: activeDocument.id, patch: { content, dirty: true } })} onSubmit={() => void run()} />
          <div className="electron-result-panel">
            <button type="button" onClick={() => void run()}>Run</button>
            <button type="button" onClick={() => void run('explain')}>Explain</button>
            <button type="button" onClick={() => void cancel()} disabled={activeResult?.status !== 'loading' && activeResult?.status !== 'streaming'}>Cancel</button>
            {notice && <div role="status">{notice}</div>}
            <ResultTabs results={Object.values(state.results.byResultSetId)} activeResultSetId={state.results.activeResultSetId} activeSourceId={state.results.activeSourceId} onSelect={(resultSetId, sourceId) => store.dispatch({ type: 'results/select', sourceId, resultSetId })} />
            {activeResult && <ResultViewToolbar columns={activeResult.columns} view={activeResult.view} onChange={updateView} onRefresh={() => void refresh()} onCopy={() => void copyActive()} onExport={exportActive} />}
            <AsyncStateView state={resultState} message={resultMessage} emptyLabel="No rows to display." loadingLabel="Streaming result data…">
              <DataGrid sourceId={activeResult?.sourceId} resultSetId={activeResult?.resultSetId ?? 'empty'} columns={activeResult?.columns ?? []} rows={rows} totalRowCount={activeResult?.totalRowCount} view={activeResult?.view} onViewChange={updateView} selectedRowIndex={selectedRow} scroll={activeResult ? { sourceId: activeResult.sourceId, resultSetId: activeResult.resultSetId, top: activeResult.view.scrollTop, left: activeResult.view.scrollLeft, anchorRow: activeResult.view.anchorRow } : undefined} onScroll={onScroll} onRowSelect={setSelectedRow} />
            </AsyncStateView>
            {activeResult && selectedRow !== undefined && visibleRows[selectedRow] && <RowDetail columns={activeResult.columns} row={visibleRows[selectedRow]} onClose={() => setSelectedRow(undefined)} />}
          </div>
        </>}
  </UiShell></CapabilityGate> as ReactElement;
}
