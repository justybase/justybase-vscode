/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createApiClient, type ApiClient } from './api';
import { SharedWebWorkspace } from './sharedUiAdapter';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body, blob: async () => new Blob() } as unknown as Response;
}

class FixtureWebSocket {
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
    const events = [
      { type: 'started', queryId: 'query-1', sequence: 1 },
      { type: 'columns', queryId: 'query-1', sequence: 2, columns: [{ name: 'ID', type: 'INTEGER' }] },
      { type: 'rows', queryId: 'query-1', sequence: 3, rows: [[7]], totalRows: 1 },
      { type: 'complete', queryId: 'query-1', sequence: 4, totalRows: 1, limitReached: false },
    ];
    for (const event of events) this.emit('message', { data: JSON.stringify(event) });
  }

  public close(): void {
    this.emit('close', {});
  }

  private emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function fixtureApi(): ApiClient {
  const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/connections')) return jsonResponse([{ id: 'connection-1', name: 'SQLite', host: 'local', port: 0, database: ':memory:', user: 'local', dbType: 'sqlite', readOnly: true }]);
    if (url.endsWith('/api/history')) return jsonResponse([{ id: 'history-1', connectionId: 'connection-1', database: ':memory:', sql: 'SELECT 7', status: 'success', durationMs: 1, rowCount: 1, createdAt: '2026-09-11T00:00:00.000Z' }]);
    if (url.includes('/api/schema/tree')) return jsonResponse({ nodes: [{ id: 'table-1', kind: 'object', label: 'orders', hasChildren: false }] });
    if (url.endsWith('/api/query')) return jsonResponse({ queryId: 'query-1' });
    if (url.includes('/page')) return jsonResponse({ sessionId: 'session-1', columns: [{ name: 'ID', type: 'INTEGER' }], rows: [[7]], offset: 0, limit: 500, totalRows: 1, hasMore: false });
    if (url.includes('/cancel')) return jsonResponse({ ok: true });
    return jsonResponse({ ok: true });
  });
  return createApiClient({ fetch: fetchMock, WebSocket: FixtureWebSocket as unknown as new (url: string) => WebSocket });
}

describe('shared Web UI adapter', () => {
  it('uses shared state and presentation for connection, schema, execution, results and history', async () => {
    const user = userEvent.setup();
    const api = fixtureApi();
    const onLogout = jest.fn();
    render(<SharedWebWorkspace api={api} user={{ id: 'user-1', username: 'alice', role: 'user' }} onLogout={onLogout} />);

    await screen.findByRole('button', { name: 'SQLite' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'SQL authoring dialect' }), 'postgresql');
    expect(screen.getByRole('combobox', { name: 'SQL authoring dialect' })).toHaveValue('postgresql');
    expect(screen.getByRole('tree', { name: 'Schema' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByRole('table');
    expect(screen.getByText('7')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Filter results' }), '7');
    await user.click(screen.getByRole('button', { name: 'Group' }));
    await user.click(screen.getByRole('button', { name: 'Sort' }));
    await user.click(screen.getByRole('button', { name: 'Aggregate' }));
    await user.click(screen.getByRole('button', { name: 'Pivot' }));
    fireEvent.scroll(screen.getByRole('table').parentElement as HTMLDivElement);
    await user.click(screen.getByRole('row', { name: '7' }));
    expect(screen.getByRole('heading', { name: 'Row details' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'History' }));
    await screen.findByRole('heading', { name: 'Query history' });
    await user.click(screen.getByRole('button', { name: /SELECT 7/ }));
    expect(screen.getByLabelText('SQL editor')).toHaveValue('SELECT 7');
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('keeps designer and unavailable execution states visible', async () => {
    const user = userEvent.setup();
    render(<SharedWebWorkspace api={fixtureApi()} user={{ id: 'user-2', username: 'bob', role: 'user' }} onLogout={() => undefined} />);
    await screen.findByRole('button', { name: 'SQLite' });
    await user.click(screen.getByRole('button', { name: 'Designer' }));
    expect(screen.getByRole('heading', { name: 'Designer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Explain' }));
    expect(screen.getByRole('heading', { name: 'Explain' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Workspace' })).toBeInTheDocument());
  });
});
