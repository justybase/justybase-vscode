/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { UiResultSurfaceState } from '@justybase/ui-core';
import { App, applyHydratedPage, asSurface, displayRows, mergeElectronResultRows, resultAsyncState, rowsAsCsv, rowsAsText } from '../src/renderer/App';
import { createInitialUiState, createUiStore } from '@justybase/ui-core';

class FakeQueryWebSocket {
  public static readonly instances: FakeQueryWebSocket[] = [];
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  public readonly sent: string[] = [];

  public constructor(public readonly url: string) {
    FakeQueryWebSocket.instances.push(this);
  }

  public addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  public send(value: string): void {
    this.sent.push(value);
  }

  public close(): void {
    for (const listener of this.listeners.get('close') ?? []) listener({});
  }

  public emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const resultFixture: UiResultSurfaceState = {
  sourceId: 'electron:scratch',
  executionId: 'query-1',
  resultSetId: 'query-1:0',
  statementIndex: 0,
  status: 'complete',
  columns: [{ name: 'ID' }, { name: 'NAME' }],
  totalRowCount: 2,
  loadedRowCount: 2,
  lastSequence: 4,
  cancellation: 'none',
  view: { globalFilter: '', columnFilters: {}, sorting: [], grouping: [], scrollTop: 0, scrollLeft: 0 },
};

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body, blob: async () => new Blob([JSON.stringify(body)]) } as Response;
}

function installApi(auth: { status: 'authenticated' | 'unauthenticated'; message?: string }, workspaceStatus: 'available' | 'unsupported' = 'available', profiles: readonly [{ id: string; name: string; host: string; port: number; database: string; user: string; dbType: string; readOnly: boolean }] | readonly [] = []): void {
  Object.defineProperty(window, 'justybaseElectron', {
    configurable: true,
    value: {
      getAuthState: jest.fn(async () => auth),
      requestCredential: jest.fn(async () => 'opaque-request-id'),
      listConnections: jest.fn(async () => profiles),
      listCapabilities: jest.fn(async () => ({ descriptors: [{ key: 'workspace', status: workspaceStatus, owner: 'test', reason: workspaceStatus === 'unsupported' ? 'Unavailable in fixture.' : undefined, documentation: '/docs', removalCondition: 'Enable it.' }] })),
    },
  });
}

describe('Electron renderer composition', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    FakeQueryWebSocket.instances.length = 0;
    if (originalFetch) Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
    else delete (globalThis as { fetch?: typeof fetch }).fetch;
    if (originalWebSocket) Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket });
    else delete (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (originalCreateObjectUrl) Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectUrl });
    else delete (URL as unknown as { createObjectURL?: typeof URL.createObjectURL }).createObjectURL;
    if (originalRevokeObjectUrl) Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectUrl });
    else delete (URL as unknown as { revokeObjectURL?: typeof URL.revokeObjectURL }).revokeObjectURL;
  });

  it('keeps portable result view helpers deterministic for empty, filtered and sorted data', () => {
    expect(resultAsyncState(undefined, 0)).toBe('empty');
    expect(resultAsyncState({ ...resultFixture, status: 'error' }, 1)).toBe('error');
    expect(resultAsyncState({ ...resultFixture, status: 'cancelled' }, 1)).toBe('cancelled');
    expect(resultAsyncState({ ...resultFixture, status: 'loading' }, 0)).toBe('loading');
    expect(resultAsyncState({ ...resultFixture, status: 'streaming', loadedRowCount: 0, totalRowCount: 0 }, 0)).toBe('loading');
    expect(resultAsyncState({ ...resultFixture, status: 'streaming', loadedRowCount: 0, totalRowCount: 2 }, 0)).toBe('loading');
    expect(resultAsyncState({ ...resultFixture, status: 'empty' }, 0)).toBe('empty');
    expect(resultAsyncState({ ...resultFixture, view: { ...resultFixture.view, globalFilter: 'missing' } }, 0)).toBe('ready');
    expect(resultAsyncState(resultFixture, 0)).toBe('empty');
    expect(resultAsyncState(resultFixture, 2)).toBe('ready');
    expect(displayRows(undefined, [[1]])).toEqual([]);
    expect(displayRows(resultFixture, [[2, 'Beta'], [1, 'Alpha']])).toEqual([[2, 'Beta'], [1, 'Alpha']]);
    expect(displayRows({ ...resultFixture, view: { ...resultFixture.view, globalFilter: 'alpha' } }, [[2, 'Beta'], [1, 'Alpha']])).toEqual([[1, 'Alpha']]);
    expect(displayRows({ ...resultFixture, view: { ...resultFixture.view, sorting: [{ column: 'bad', descending: false }] } }, [[2, 'Beta']])).toEqual([[2, 'Beta']]);
    expect(displayRows({ ...resultFixture, view: { ...resultFixture.view, sorting: [{ column: 'NAME', descending: false }] } }, [[2, 'Beta'], [1, 'Alpha']])).toEqual([[1, 'Alpha'], [2, 'Beta']]);
    expect(displayRows({ ...resultFixture, view: { ...resultFixture.view, sorting: [{ column: '0', descending: true }] } }, [[2, 'Beta'], [1, 'Alpha']])).toEqual([[2, 'Beta'], [1, 'Alpha']]);
    expect(displayRows({ ...resultFixture, view: { ...resultFixture.view, sorting: [{ column: '0', descending: false }] } }, [[2, 'Beta'], [1, 'Alpha']])).toEqual([[1, 'Alpha'], [2, 'Beta']]);
    expect(asSurface('results')).toBe('results');
    expect(asSurface('not-a-surface')).toBeUndefined();
    expect(rowsAsText([{ name: 'ID' }, { name: 'NAME' }], [[1, null]])).toBe('ID\tNAME\n1\tNULL');
    expect(rowsAsText([{ name: 'AMOUNT', type: 'NUMERIC', scale: 2 }], [['1234.5']])).toBe('AMOUNT\n1 234.50');
    expect(rowsAsCsv([{ name: 'ID' }], [[1], ['two']])).toBe('"ID"\n"1"\n"two"');
    expect(rowsAsCsv([{ name: 'A"B' }], [['x"y']])).toBe('"A""B"\n"x""y"');
    expect(rowsAsCsv([{ name: 'ENABLED', type: 'BOOLEAN' }], [[true]])).toBe('"ENABLED"\n"true"');
    expect(mergeElectronResultRows([[1], [2], [3]], [[9], [8]], 1)).toEqual([[1], [9], [8]]);
    expect(mergeElectronResultRows([[1], [2]], [[7]], 9)).toEqual([[1], [2]]);
    expect(mergeElectronResultRows([[1], [2]], [[7]], 4, true)).toEqual([[7]]);
  });

  it('renders authenticated shared presentation after the preload bootstrap resolves', async () => {
    installApi({ status: 'authenticated' });
    const view = render(<App />);
    expect(screen.getByRole('status')).toHaveTextContent('Starting authenticated workspace');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'JustyBase' })).toBeTruthy());
    expect(screen.getByLabelText('SQL editor')).toHaveValue('SELECT 1;');
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('Select a connection before running SQL.')).toBeInTheDocument();
    view.unmount();
  });

  it('runs a SQLite-shaped query through the authenticated API and renders shared result controls', async () => {
    const profile = { id: 'connection-1', name: 'SQLite', host: 'local', port: 0, database: ':memory:', user: 'local', dbType: 'sqlite', readOnly: true } as const;
    installApi({ status: 'authenticated' }, 'available', [profile]);
    const fetcher = jest.fn(async (input: RequestInfo | URL) => {
      const route = String(input);
      if (route === '/api/query') return jsonResponse({ queryId: 'query-1', statementCount: 1 });
      if (route.includes('/page')) return jsonResponse({ queryId: 'query-1', sessionId: 'session-1', columns: [{ name: 'ID', type: 'INTEGER' }, { name: 'NAME', type: 'TEXT' }], rows: [[1, 'Alpha']], offset: 0, limit: 500, totalRows: 1, hasMore: false });
      if (route.includes('/cancel')) return jsonResponse({ ok: true });
      return jsonResponse({});
    });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetcher });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeQueryWebSocket });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: jest.fn(() => 'blob:fixture') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
    const clipboard = jest.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });

    const view = render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'JustyBase' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('SQL editor'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('Enter SQL before running the document.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('SQL editor'), { target: { value: 'SELECT 1;' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/query', expect.anything()));
    const socket = FakeQueryWebSocket.instances[0];
    act(() => {
      socket?.emit('open');
      socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'started', sequence: 1 }) });
      socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'columns', columns: [{ name: 'ID', type: 'INTEGER' }, { name: 'NAME', type: 'TEXT' }], sequence: 2 }) });
      socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'rows', rows: [[1, 'Alpha']], totalRows: 1, sequence: 3 }) });
      socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'complete', totalRows: 1, limitReached: false, sequence: 4 }) });
    });
    expect(await screen.findByRole('cell', { name: 'Alpha' })).toBeInTheDocument();
    fireEvent.contextMenu(screen.getByRole('cell', { name: 'Alpha' }), { clientX: 48, clientY: 72 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy row as JSON' }));
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(expect.stringContaining('"NAME": "Alpha"')));
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter results' }), { target: { value: 'Alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/query/query-1/page', expect.anything()));
    expect(clipboard).toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(await screen.findByText('History is not available in this Electron shell yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }));
    expect(await screen.findByText('Explain is not available in this Electron shell yet.')).toBeInTheDocument();
    view.unmount();
  });

  it('rejects stale hydrated pages and exposes finalized page failures once', async () => {
    const store = createUiStore(createInitialUiState({ productId: 'electron', sourceId: 'electron:scratch' }));
    const update = jest.fn();
    expect(applyHydratedPage(store, 'electron:scratch', 'missing:0', [[1]], 1, [{ name: 'ID' }], 'execution-1', update)).toBe(false);
    store.dispatch({ type: 'execution/start', sourceId: 'electron:scratch', executionId: 'execution-1', resultSetId: 'result-1' });
    expect(applyHydratedPage(store, 'electron:scratch', 'result-1', [[1]], 1, [{ name: 'ID' }], 'old-execution', update)).toBe(false);
    expect(applyHydratedPage(store, 'electron:scratch', 'result-1', [[1]], 1, [{ name: 'ID' }], 'execution-1', update)).toBe(true);
    expect(update).toHaveBeenCalledWith('result-1', [[1]]);
    store.dispose();

    const profile = { id: 'connection-1', name: 'SQLite', host: 'local', port: 0, database: ':memory:', user: 'local', dbType: 'sqlite', readOnly: true } as const;
    installApi({ status: 'authenticated' }, 'available', [profile]);
    const fetcher = jest.fn(async (input: RequestInfo | URL) => {
      const route = String(input);
      if (route === '/api/query') return jsonResponse({ queryId: 'query-1', statementCount: 1 });
      if (route.includes('/page')) return jsonResponse({ message: 'page failed' }, 503);
      return jsonResponse({ ok: true });
    });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetcher });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeQueryWebSocket });
    const view = render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'JustyBase' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/query', expect.anything()));
    const socket = FakeQueryWebSocket.instances[0];
    act(() => {
      socket?.emit('open');
      socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'started', sequence: 1 }) });
      socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'columns', columns: [{ name: 'ID' }], sequence: 2 }) });
      socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'complete', totalRows: 0, limitReached: false, sequence: 3 }) });
    });
    await waitFor(() => expect(screen.getByText('Result page hydration failed: page failed')).toBeInTheDocument());
    view.unmount();
  });

  it('keeps authentication and capability failures visible', async () => {
    installApi({ status: 'unauthenticated', message: 'Sign in required.' });
    const unauthenticated = render(<App />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Sign in required.'));
    unauthenticated.unmount();

    installApi({ status: 'authenticated' }, 'unsupported');
    render(<App />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Unavailable in fixture.'));
  });
});
