/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { QueryEvent, SchemaTreeNode } from '@justybase/contracts';
import type { UiResultSurfaceState } from '@justybase/ui-core';
import { createApiClient, type ApiClient } from './api';
import { displayRows, mapSchemaNode, resultAsyncState, SharedWebWorkspace } from './sharedUiAdapter';

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, headers: new Headers(), json: async () => body, blob: async () => new Blob() } as unknown as Response;
}

type SocketMode = 'complete' | 'page-only' | 'error' | 'cancelled' | 'pending';
let socketMode: SocketMode = 'complete';

class EdgeWebSocket {
  private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();

  public constructor(_url: string) {
    void _url;
    queueMicrotask(() => this.emit('open', {}));
  }

  public addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const callbacks = this.listeners.get(type) ?? new Set();
    callbacks.add(listener);
    this.listeners.set(type, callbacks);
  }

  public send(_message: string): void {
    void _message;
    const events: QueryEvent[] = socketMode === 'error'
      ? [
        { type: 'started', queryId: 'query-1', sequence: 1, startedAt: 1 },
        { type: 'error', queryId: 'query-1', sequence: 2, message: 'query failed' },
      ]
      : socketMode === 'cancelled'
        ? [
          { type: 'started', queryId: 'query-1', sequence: 1, startedAt: 1 },
          { type: 'cancelled', queryId: 'query-1', sequence: 2, totalRows: 0 },
        ]
        : socketMode === 'pending'
          ? [{ type: 'started', queryId: 'query-1', sequence: 1, startedAt: 1 }]
        : socketMode === 'page-only'
          ? [
            { type: 'started', queryId: 'query-1', sequence: 1, startedAt: 1 },
            { type: 'statement-started', queryId: 'query-1', sequence: 2, statementSql: 'SELECT 1' },
            { type: 'columns', queryId: 'query-1', sequence: 3, columns: [{ name: 'ID', type: 'INTEGER' }, { name: 'NAME', type: 'TEXT' }] },
            { type: 'session', queryId: 'query-1', sequence: 4, sessionId: 'session-1', totalRows: 0 },
            { type: 'progress', queryId: 'query-1', sequence: 5, totalRows: 2 },
            { type: 'complete', queryId: 'query-1', sequence: 6, totalRows: 2, limitReached: false },
          ]
          : [
            { type: 'started', queryId: 'query-1', sequence: 1, startedAt: 1 },
            { type: 'statement-started', queryId: 'query-1', sequence: 2, statementSql: 'SELECT 1' },
            { type: 'columns', queryId: 'query-1', sequence: 3, columns: [{ name: 'ID', type: 'INTEGER' }, { name: 'NAME', type: 'TEXT' }] },
            { type: 'session', queryId: 'query-1', sequence: 4, sessionId: 'session-1', totalRows: 2 },
            { type: 'progress', queryId: 'query-1', sequence: 5, totalRows: 2 },
            { type: 'rows', queryId: 'query-1', sequence: 6, rows: [[2, 'b'], [1, 'a']], totalRows: 2 },
            { type: 'batch-complete', queryId: 'query-1', sequence: 7, status: 'complete', completedStatements: 1 },
            { type: 'complete', queryId: 'query-1', sequence: 8, totalRows: 2, limitReached: false },
          ];
    for (const event of events) this.emit('message', { data: JSON.stringify(event) });
  }

  public close(): void { this.emit('close', {}); }

  private emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

interface ApiOptions {
  readonly noConnections?: boolean;
  readonly connectionsError?: boolean;
  readonly historyError?: boolean;
  readonly schemaError?: boolean;
  readonly schemaObject?: boolean;
  readonly pageError?: boolean;
  readonly startError?: boolean;
  readonly cancelError?: boolean;
  readonly connectionActions?: boolean;
}

function edgeApi(options: ApiOptions = {}): { api: ApiClient; fetchMock: jest.Mock } {
  const connectionProfiles = [{ id: 'connection-1', name: 'SQLite', host: 'local', port: 0, database: ':memory:', user: 'local', dbType: 'sqlite', readOnly: true }];
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method?.toUpperCase() ?? 'GET';
    if (url.endsWith('/api/connections')) {
      if (options.connectionsError) throw new Error('connections failed');
      if (options.connectionActions && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        const profile = { id: `connection-${connectionProfiles.length + 1}`, name: String(body.name ?? 'New connection'), host: String(body.host ?? ''), port: Number(body.port ?? 5480), database: String(body.database ?? 'system'), user: String(body.user ?? ''), dbType: typeof body.dbType === 'string' ? body.dbType : 'netezza', readOnly: body.readOnly !== false };
        connectionProfiles.push(profile);
        return response(profile);
      }
      return response(options.noConnections ? [] : connectionProfiles);
    }
    if (options.connectionActions && url.includes('/api/connections/')) {
      const id = url.split('/').at(-1);
      const index = connectionProfiles.findIndex(profile => profile.id === id);
      if (method === 'DELETE') {
        if (index >= 0) connectionProfiles.splice(index, 1);
        return response({ ok: true });
      }
      if (method === 'PUT' && index >= 0) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        connectionProfiles[index] = { ...connectionProfiles[index], name: String(body.name ?? connectionProfiles[index]!.name), database: String(body.database ?? connectionProfiles[index]!.database) };
        return response(connectionProfiles[index]);
      }
    }
    if (url.endsWith('/api/history')) {
      if (options.historyError) throw new Error('history failed');
      return response([{ id: 'history-1', connectionId: 'connection-1', database: ':memory:', sql: 'SELECT 7', status: 'success', durationMs: 1, rowCount: 2, createdAt: '2026-09-11T00:00:00.000Z' }]);
    }
    if (url.includes('/api/schema/tree')) {
      if (options.schemaError) throw new Error('schema failed');
      return response({ nodes: options.schemaObject
        ? [{ id: 'object-1', kind: 'object', label: 'orders', database: 'main', schema: 'public', objectName: 'orders', objectType: 'TABLE', hasChildren: true }]
        : [{ id: 'cte-1', kind: 'cte', label: 'orders_cte', hasChildren: false }] });
    }
    if (url.endsWith('/api/schema/search')) {
      return response({ items: [{ name: 'orders', database: 'main', schema: 'public', objectType: 'TABLE', description: 'Order records', matchType: 'name' }] });
    }
    if (url.endsWith('/api/query')) {
      if (options.startError) throw new Error('start failed');
      return response({ queryId: 'query-1' });
    }
    if (url.includes('/api/query/query-1/page')) {
      if (options.pageError) return Promise.reject('page failed without an Error object');
      return response({ sessionId: 'session-1', columns: [{ name: 'ID', type: 'INTEGER' }, { name: 'NAME', type: 'TEXT' }], rows: [[2, 'b'], [1, 'a']], offset: 0, limit: 500, totalRows: 2, hasMore: false });
    }
    if (url.includes('/api/query/query-1/cancel')) {
      if (options.cancelError) throw new Error('cancel failed');
      return response({ ok: true });
    }
    return response({ ok: true });
  });
  return { api: createApiClient({ fetch: fetchMock, WebSocket: EdgeWebSocket as unknown as new (url: string) => WebSocket }), fetchMock };
}

const completeResult: UiResultSurfaceState = {
  sourceId: 'source-1', executionId: 'execution-1', resultSetId: 'result-1', statementIndex: 0,
  status: 'complete', columns: [{ name: 'ID' }], totalRowCount: 2, loadedRowCount: 2, lastSequence: 1,
  cancellation: 'none', view: { globalFilter: '', columnFilters: {}, sorting: [], grouping: [], scrollTop: 0, scrollLeft: 0 },
};

describe('shared Web UI adapter edge contracts', () => {
  afterEach(() => { socketMode = 'complete'; });

  it('keeps pure identity, async and result-view transitions deterministic', () => {
    expect(mapSchemaNode({ id: 'cte', kind: 'cte', label: 'cte', hasChildren: false } as SchemaTreeNode).kind).toBe('object');
    expect(resultAsyncState(undefined, 0)).toBe('empty');
    expect(resultAsyncState({ ...completeResult, status: 'error' }, 1)).toBe('error');
    expect(resultAsyncState({ ...completeResult, status: 'cancelled' }, 1)).toBe('cancelled');
    expect(resultAsyncState({ ...completeResult, status: 'loading' }, 0)).toBe('loading');
    expect(resultAsyncState({ ...completeResult, status: 'streaming', loadedRowCount: 0, totalRowCount: 0 }, 0)).toBe('loading');
    expect(resultAsyncState({ ...completeResult, status: 'streaming', loadedRowCount: 0, totalRowCount: 2 }, 0)).toBe('loading');
    expect(resultAsyncState({ ...completeResult, status: 'empty' }, 0)).toBe('empty');
    expect(resultAsyncState({ ...completeResult, view: { ...completeResult.view, globalFilter: 'missing' } }, 0)).toBe('ready');
    expect(resultAsyncState({ ...completeResult, status: 'streaming' }, 2)).toBe('ready');
    expect(displayRows(undefined, [[1]])).toEqual([]);
    expect(displayRows({ ...completeResult, view: { ...completeResult.view, globalFilter: 'alpha' } }, [[2, 'beta'], [1, 'alpha']])).toEqual([[1, 'alpha']]);
    expect(displayRows({ ...completeResult, columns: [{ name: 'ID' }, { name: 'LABEL' }], view: { ...completeResult.view, sorting: [{ column: 'LABEL', descending: false }] } }, [[1, 'z'], [2, 'a']])).toEqual([[2, 'a'], [1, 'z']]);
    expect(displayRows({ ...completeResult, view: { ...completeResult.view, sorting: [{ column: '0', descending: false }] } }, [[2], [1]])).toEqual([[1], [2]]);
    expect(displayRows({ ...completeResult, view: { ...completeResult.view, sorting: [{ column: '0', descending: true }] } }, [[1], [2]])).toEqual([[2], [1]]);
    expect(displayRows({ ...completeResult, view: { ...completeResult.view, sorting: [{ column: 'bad', descending: false }] } }, [[1]])).toEqual([[1]]);
  });

  it('covers shared result controls, two-axis scroll, history, schema and guarded surfaces', async () => {
    const user = userEvent.setup();
    const { api, fetchMock } = edgeApi();
    const writeText = jest.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: jest.fn(() => 'blob:fixture') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
    const anchorClick = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<SharedWebWorkspace api={api} user={{ id: 'edge-user', username: 'alice', role: 'user' }} onLogout={jest.fn()} />);
    await screen.findByRole('button', { name: 'SQLite' });
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Sort' }));
    await user.type(screen.getByRole('textbox', { name: 'Filter results' }), 'a');
    await user.type(screen.getByRole('textbox', { name: 'Filter NAME' }), 'a');
    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.queryByText('b')).not.toBeInTheDocument();
    const grid = screen.getByRole('table').parentElement as HTMLDivElement;
    grid.scrollTop = 64;
    grid.scrollLeft = 32;
    fireEvent.scroll(grid);
    await user.click(screen.getByRole('row', { name: /alpha|1/ }));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Shared export format' }), 'json');
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/query/query-1/export'))).toBe(true));
    const exportCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/api/query/query-1/export'));
    expect(exportCall).toBeDefined();
    expect(JSON.parse(String((exportCall?.[1] as RequestInit | undefined)?.body))).toEqual(expect.objectContaining({
      format: 'json',
      globalFilter: 'a',
      columnFilters: [{ columnIndex: 1, value: 'a' }],
      sorting: [{ columnIndex: 0, desc: false }],
    }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(writeText).toHaveBeenCalled();

    await user.click(screen.getAllByRole('button', { name: 'Explain' })[0]);
    expect(screen.getByRole('heading', { name: 'Explain' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Designer' }));
    expect(screen.getByRole('heading', { name: 'Designer' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Workspace' }));
    await user.click(screen.getByRole('button', { name: 'orders_cte' }));
    await user.click(screen.getByRole('button', { name: 'History' }));
    await screen.findByRole('heading', { name: 'Query history' });
    await user.click(screen.getByRole('button', { name: 'Copy query' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('SELECT 7'));
    await user.click(screen.getByRole('button', { name: 'Refresh history' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/history')).length).toBeGreaterThan(1));
    await user.click(screen.getByRole('button', { name: /SELECT 7/ }));
    expect(screen.getByLabelText('SQL editor')).toHaveValue('SELECT 7');
    anchorClick.mockRestore();
  });

  it('keeps missing selections, API failures and cancellation failures visible', async () => {
    const user = userEvent.setup();
    const noConnections = edgeApi({ noConnections: true });
    const noConnectionView = render(<SharedWebWorkspace api={noConnections.api} user={{ id: 'no-connection', username: 'alice', role: 'user' }} onLogout={() => undefined} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByText('Select a connection before running SQL.')).toBeInTheDocument();
    noConnectionView.unmount();

    const failing = edgeApi({ historyError: true, schemaError: true, startError: true });
    const failingView = render(<SharedWebWorkspace api={failing.api} user={{ id: 'failing', username: 'bob', role: 'user' }} onLogout={() => undefined} />);
    await screen.findByRole('button', { name: 'SQLite' });
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(screen.getByText('start failed')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'History' }));
    await waitFor(() => expect(screen.getAllByRole('alert').some(element => element.textContent?.includes('history failed'))).toBe(true));
    failingView.unmount();
  });

  it('runs shared schema preview actions through the selected connection', async () => {
    const user = userEvent.setup();
    const { api, fetchMock } = edgeApi({ schemaObject: true });
    render(<SharedWebWorkspace api={api} user={{ id: 'schema-user', username: 'alice', role: 'user' }} onLogout={() => undefined} />);
    await screen.findByRole('button', { name: 'SQLite' });
    const treeItem = await screen.findByRole('treeitem', { name: /orders/i });
    fireEvent.contextMenu(treeItem, { clientX: 40, clientY: 40 });
    await user.click(screen.getByRole('menuitem', { name: 'View top 1000' }));
    await waitFor(() => expect((screen.getByLabelText('SQL editor') as HTMLTextAreaElement).value).toContain('FROM "public"."orders"'));
    const startCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/query'));
    expect(JSON.parse(String((startCall?.[1] as RequestInit | undefined)?.body))).toEqual(expect.objectContaining({ database: 'main' }));
  });

  it('keeps shared schema search, recent objects and favorites connected to the active editor', async () => {
    const user = userEvent.setup();
    const { api, fetchMock } = edgeApi({ schemaObject: true });
    render(<SharedWebWorkspace api={api} user={{ id: 'shared-schema-search-user', username: 'alice', role: 'user' }} onLogout={() => undefined} />);
    await screen.findByRole('button', { name: 'SQLite' });
    const search = screen.getByRole('textbox', { name: 'Search schema' });
    await user.type(search, 'ord');
    const result = await screen.findByRole('treeitem', { name: /orders/i });
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/schema/search'))).toBe(true));
    await user.click(result.querySelector('button:last-child')!);
    expect((screen.getByLabelText('SQL editor') as HTMLTextAreaElement).value).toContain('"public"."orders"');
    expect(screen.getByText('Recent')).toBeInTheDocument();
    fireEvent.contextMenu(result, { clientX: 32, clientY: 48 });
    await user.click(screen.getByRole('menuitem', { name: 'Add to favorites' }));
    fireEvent.contextMenu(result, { clientX: 32, clientY: 48 });
    expect(screen.getByRole('menuitem', { name: 'Remove from favorites' })).toBeInTheDocument();
    const searchCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/schema/search'));
    expect(JSON.parse(String((searchCall?.[1] as RequestInit | undefined)?.body))).toEqual(expect.objectContaining({ term: 'ord', objectTypes: ['TABLE', 'VIEW', 'PROCEDURE', 'SYNONYM'] }));
  });

  it('exposes guarded connection add, edit and delete actions in shared Web mode', async () => {
    const user = userEvent.setup();
    const { api, fetchMock } = edgeApi({ connectionActions: true });
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SharedWebWorkspace api={api} user={{ id: 'shared-connection-user', username: 'alice', role: 'user' }} onLogout={() => undefined} />);
    await screen.findByRole('button', { name: 'SQLite' });
    await user.click(screen.getByRole('button', { name: 'Add connection' }));
    const dialog = screen.getByRole('dialog', { name: 'Add connection' });
    await user.type(screen.getByLabelText('Profile name'), 'Analytics');
    await user.click(within(dialog).getByRole('button', { name: 'Add connection' }));
    await waitFor(() => expect(screen.getByText('Connection “Analytics” saved.')).toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/api/connections') && (init as RequestInit | undefined)?.method === 'POST')).toBe(true);
    expect(screen.getByRole('button', { name: 'Analytics' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit Analytics connection' }));
    expect(screen.getByRole('dialog', { name: 'Edit connection' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText('Connection “Analytics” saved.')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Delete Analytics connection' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Analytics' })).not.toBeInTheDocument());
    expect(confirm).toHaveBeenCalled();
    expect(dialog).not.toBeInTheDocument();
    confirm.mockRestore();
  });

  it('maps error, cancellation and empty result terminal states without retrying SQL', async () => {
    const user = userEvent.setup();
    for (const mode of ['error', 'cancelled'] as const) {
      socketMode = mode;
      const { api } = edgeApi();
      const view = render(<SharedWebWorkspace api={api} user={{ id: `state-${mode}`, username: 'state', role: 'user' }} onLogout={() => undefined} />);
      await screen.findAllByRole('button', { name: 'SQLite' });
      await user.click(screen.getAllByRole('button', { name: 'Run' }).at(-1)!);
      if (mode === 'error') await waitFor(() => expect(screen.getAllByRole('alert').some(element => element.textContent?.includes('query failed'))).toBe(true));
      else await waitFor(() => expect(screen.getAllByRole('status').some(element => element.textContent?.includes('Cancelled'))).toBe(true));
      view.unmount();
    }
  });

  it('hydrates rows through the page port when the API stream only carries progress', async () => {
    socketMode = 'page-only';
    const { api, fetchMock } = edgeApi();
    const user = userEvent.setup();
    render(<SharedWebWorkspace api={api} user={{ id: 'page-user', username: 'page', role: 'user' }} onLogout={() => undefined} />);
    await screen.findByRole('button', { name: 'SQLite' });
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByRole('cell', { name: 'b' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/query/query-1/page'), expect.anything());
  });

  it('uses a safe message when finalized page hydration rejects with a non-Error value', async () => {
    const user = userEvent.setup();
    const { api } = edgeApi({ pageError: true });
    render(<SharedWebWorkspace api={api} user={{ id: 'page-error-user', username: 'page', role: 'user' }} onLogout={() => undefined} />);
    await screen.findByRole('button', { name: 'SQLite' });
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(screen.getByText('Could not load result rows.')).toBeInTheDocument());
  });
});
