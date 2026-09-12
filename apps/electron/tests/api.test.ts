/** @jest-environment jsdom */

import { createElectronApiClient } from '../src/renderer/api';

class FakeWebSocket {
  public static readonly instances: FakeWebSocket[] = [];
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  public readonly sent: string[] = [];
  public constructor(public readonly url: string) { FakeWebSocket.instances.push(this); }
  public addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  public send(value: string): void { this.sent.push(value); }
  public close(): void { for (const listener of this.listeners.get('close') ?? []) listener({}); }
  public error(): void { for (const listener of this.listeners.get('error') ?? []) listener({}); }
  public emit(type: string, event: { data?: unknown } = {}): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}

describe('Electron same-origin API adapter', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    jest.useFakeTimers();
    document.cookie = 'justybase_csrf=csrf-fixture';
  });

  afterEach(() => {
    document.cookie = '';
    jest.useRealTimers();
  });

  it('sends the browser session and CSRF boundary to query routes', async () => {
    const fetcher = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return ({
      ok: true,
      json: async () => ({ queryId: 'query-1' }),
      }) as Response;
    });
    const client = createElectronApiClient({ fetcher });
    await expect(client.startQuery({ connectionId: 'connection-1', sql: 'SELECT 1', mode: 'single' })).resolves.toEqual({ queryId: 'query-1' });
    expect(fetcher).toHaveBeenCalledWith('/api/query', expect.objectContaining({ credentials: 'same-origin', method: 'POST', headers: expect.objectContaining({ 'x-justybase-csrf': 'csrf-fixture' }) }));
    await expect(client.queryPage('query/one', { offset: 0, limit: 10 })).resolves.toEqual({ queryId: 'query-1' });
    expect(fetcher).toHaveBeenLastCalledWith('/api/query/query%2Fone/page', expect.anything());
  });

  it('downloads a server export with the active CSRF cookie and response filename', async () => {
    const blob = new Blob(['"ID"\n"1"'], { type: 'text/csv' });
    const fetcher = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-disposition': 'attachment; filename="orders.csv"' }),
      blob: async () => blob,
    }) as Response);
    const client = createElectronApiClient({ fetcher });
    await expect(client.exportQuery('query/one', { format: 'csv', offset: 0, limit: 500 })).resolves.toEqual({ blob, fileName: 'orders.csv' });
    expect(fetcher).toHaveBeenCalledWith('/api/query/query%2Fone/export', expect.objectContaining({ credentials: 'same-origin', method: 'POST', headers: expect.objectContaining({ 'x-justybase-csrf': 'csrf-fixture' }) }));
  });

  it('exposes the authenticated metadata, authoring and guarded-write routes', async () => {
    const fetcher = jest.fn(async (input: RequestInfo | URL) => {
      const route = String(input);
      if (route.startsWith('/api/metadata/databases')) return { ok: true, json: async () => [{ name: 'DB1' }] } as Response;
      if (route.startsWith('/api/metadata/schemas')) return { ok: true, json: async () => [{ name: 'PUBLIC', database: 'DB1' }] } as Response;
      if (route.startsWith('/api/metadata/objects')) return { ok: true, json: async () => [{ name: 'ORDERS', schema: 'PUBLIC', database: 'DB1', objectType: 'TABLE' }] } as Response;
      if (route.startsWith('/api/metadata/columns')) return { ok: true, json: async () => [{ name: 'ID', type: 'INTEGER', isPk: true }] } as Response;
      if (route.startsWith('/api/metadata/ddl')) return { ok: true, json: async () => ({ success: true, ddlCode: 'CREATE TABLE PUBLIC.ORDERS (ID INTEGER);', ddlFidelity: 'exact' }) } as Response;
      if (route.startsWith('/api/designer/capabilities')) return { ok: true, json: async () => ({ runtimeAvailable: true, readOnly: false, target: {}, capabilities: {} }) } as Response;
      if (route.startsWith('/api/designer/snapshot')) return { ok: true, json: async () => ({ target: {}, snapshot: {} }) } as Response;
      if (route === '/api/history') return { ok: true, json: async () => [{ id: 'history-1', sql: 'SELECT 1', status: 'success', createdAt: '2026-09-12T00:00:00.000Z', rowCount: 1, durationMs: 1 }] } as Response;
      if (route.startsWith('/api/audit')) return { ok: true, json: async () => [] } as Response;
      if (route === '/api/query/preview') return { ok: true, json: async () => ({ database: 'DB1', readOnly: false, containsWrite: true, previewToken: 'preview-1', expiresAt: 1, statements: [] }) } as Response;
      if (route === '/api/query/edit/preview' || route === '/api/query/import/preview' || route === '/api/query/import-file/preview') return { ok: true, json: async () => ({ sql: 'UPDATE …', previewToken: 'preview-1', expiresAt: 1, warnings: [], rowCount: 1 }) } as Response;
      if (route === '/api/query/edit' || route === '/api/query/import' || route === '/api/query/import-file') return { ok: true, json: async () => ({ sql: 'UPDATE …', rowsAffected: 1, message: 'done' }) } as Response;
      if (route.startsWith('/api/schema/tree')) return { ok: true, json: async () => ({ nodes: [] }) } as Response;
      if (route === '/api/schema/search') return { ok: true, json: async () => ({ items: [] }) } as Response;
      if (route === '/api/preferences/editor') return { ok: true, json: async () => ({ fontSize: 12, tabSize: 2, insertSpaces: true, wordWrap: 'off', minimap: false, lineNumbers: true, formatOnSave: false, formatOnType: false, keywordCase: 'preserve', inlineTypeHints: true, linterEnabled: true, linterRules: {} }) } as Response;
      if (route === '/api/lsp/snippets') return { ok: true, json: async () => ({ snippets: [] }) } as Response;
      return { ok: true, json: async () => ({ items: [], diagnostics: [], sql: 'SELECT 1', changes: [] }) } as Response;
    });
    const client = createElectronApiClient({ fetcher, WebSocket: FakeWebSocket as unknown as new (url: string) => WebSocket });
    await expect(client.databases('connection-1')).resolves.toEqual([{ name: 'DB1' }]);
    await expect(client.schemas('connection-1', 'DB1')).resolves.toEqual([{ name: 'PUBLIC', database: 'DB1' }]);
    await expect(client.objects('connection-1', 'DB1', 'PUBLIC')).resolves.toEqual([{ name: 'ORDERS', schema: 'PUBLIC', database: 'DB1', objectType: 'TABLE' }]);
    await expect(client.columns('connection-1', 'DB1', 'PUBLIC', 'ORDERS')).resolves.toEqual([{ name: 'ID', type: 'INTEGER', isPk: true }]);
    await expect(client.ddl({ connectionId: 'connection-1', database: 'DB1', schema: 'PUBLIC', objectName: 'ORDERS', objectType: 'TABLE' })).resolves.toMatchObject({ ddlCode: expect.stringContaining('CREATE TABLE') });
    await expect(client.designerCapabilities({ connectionId: 'connection-1', database: 'DB1', schema: 'PUBLIC', objectName: 'ORDERS', objectType: 'TABLE' })).resolves.toHaveProperty('runtimeAvailable', true);
    await expect(client.designerSnapshot({ connectionId: 'connection-1', database: 'DB1', schema: 'PUBLIC', objectName: 'ORDERS', objectType: 'TABLE' })).resolves.toHaveProperty('snapshot');
    await expect(client.history()).resolves.toHaveLength(1);
    await expect(client.audit()).resolves.toEqual([]);
    await expect(client.previewQuery({ connectionId: 'connection-1', sql: 'DELETE FROM PUBLIC.ORDERS', mode: 'single' })).resolves.toHaveProperty('previewToken', 'preview-1');
    await expect(client.editPreview({ connectionId: 'connection-1', database: 'DB1', schema: 'PUBLIC', table: 'ORDERS', key: { ID: 1 }, changes: { ID: 2 } })).resolves.toHaveProperty('rowCount', 1);
    await expect(client.edit({ connectionId: 'connection-1', database: 'DB1', schema: 'PUBLIC', table: 'ORDERS', key: { ID: 1 }, changes: { ID: 2 }, writeConfirmed: true, writePreviewToken: 'preview-1' })).resolves.toHaveProperty('rowsAffected', 1);
    await expect(client.importPreview({ connectionId: 'connection-1', database: 'DB1', schema: 'PUBLIC', table: 'ORDERS', columns: ['ID'], rows: [[1]] })).resolves.toHaveProperty('previewToken', 'preview-1');
    await expect(client.importRows({ connectionId: 'connection-1', database: 'DB1', schema: 'PUBLIC', table: 'ORDERS', columns: ['ID'], rows: [[1]], writeConfirmed: true, writePreviewToken: 'preview-1' })).resolves.toHaveProperty('message', 'done');
    await expect(client.importFilePreview({ connectionId: 'connection-1', database: 'DB1', schema: 'PUBLIC', table: 'ORDERS', fileName: 'orders.csv', contentBase64: 'Zml4dHVyZQ==', format: 'csv', hasHeader: true })).resolves.toHaveProperty('previewToken', 'preview-1');
    await expect(client.importFile({ connectionId: 'connection-1', database: 'DB1', schema: 'PUBLIC', table: 'ORDERS', fileName: 'orders.csv', contentBase64: 'Zml4dHVyZQ==', format: 'csv', hasHeader: true, writeConfirmed: true, writePreviewToken: 'preview-1' })).resolves.toHaveProperty('message', 'done');
    await expect(client.schemaTree('connection-1')).resolves.toEqual({ nodes: [] });
    await expect(client.searchSchema({ connectionId: 'connection-1', term: 'order' })).resolves.toEqual({ items: [] });
    await expect(client.editorPreferences()).resolves.toHaveProperty('fontSize', 12);
    await expect(client.updateEditorPreferences({ fontSize: 13 })).resolves.toHaveProperty('fontSize', 12);
    await expect(client.completion({ sql: 'SELECT ', offset: 7, connectionId: 'connection-1' })).resolves.toHaveProperty('items');
    await expect(client.diagnostics({ sql: 'SELECT ', connectionId: 'connection-1' })).resolves.toHaveProperty('diagnostics');
    await expect(client.formatSql({ sql: 'select 1', tabSize: 2, insertSpaces: true })).resolves.toHaveProperty('sql', 'SELECT 1');
    await expect(client.snippets()).resolves.toEqual({ snippets: [] });
    const socket = client.openWebSocket('/api/lsp');
    expect(socket.url).toContain('/api/lsp');
    expect(fetcher.mock.calls.map(call => String(call[0]))).toContain('/api/query/import-file/preview');
  });

  it('deduplicates malformed/foreign websocket frames and reconnects with the last sequence', () => {
    const client = createElectronApiClient({ fetcher: jest.fn(async () => ({ ok: true, json: async () => ({}) }) as Response), WebSocket: FakeWebSocket as unknown as new (url: string) => WebSocket });
    const events: unknown[] = [];
    const errors: Error[] = [];
    const subscription = client.connectToQueryEvents('query-1', event => events.push(event), error => errors.push(error));
    const socket = FakeWebSocket.instances[0];
    socket?.emit('open');
    expect(socket?.sent).toEqual([JSON.stringify({ type: 'subscribe', queryId: 'query-1', afterSequence: 0 })]);
    socket?.emit('message', { data: JSON.stringify({ queryId: 'other', type: 'started', sequence: 1 }) });
    socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'started', sequence: 1 }) });
    socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'started', sequence: 1 }) });
    socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'unknown', sequence: 2 }) });
    socket?.emit('message', { data: '{bad-json' });
    expect(events).toHaveLength(1);
    socket?.close();
    jest.runOnlyPendingTimers();
    const second = FakeWebSocket.instances[1];
    second?.emit('open');
    expect(second?.sent).toEqual([JSON.stringify({ type: 'subscribe', queryId: 'query-1', afterSequence: 1 })]);
    expect(errors).toHaveLength(0);
    subscription.close();
  });

  it('validates optional event fields, HTTP error bodies and reconnect exhaustion', async () => {
    document.cookie = 'justybase_csrf=%E0%A4%A';
    const fetcher = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ message: 'service unavailable' }) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => { throw new Error('not json'); } } as unknown as Response);
    const client = createElectronApiClient({ fetcher, WebSocket: FakeWebSocket as unknown as new (url: string) => WebSocket });
    await expect(client.startQuery({ connectionId: 'connection-1', sql: 'SELECT 1', mode: 'single' })).rejects.toThrow('service unavailable');
    expect(fetcher.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ 'x-justybase-csrf': '%E0%A4%A' }) }));
    await expect(client.queryPage('query-1', { offset: 0, limit: 1 })).rejects.toThrow('Electron API request failed.');

    const events: unknown[] = [];
    const errors: Error[] = [];
    const subscription = client.connectToQueryEvents('query-1', event => events.push(event), error => errors.push(error));
    const socket = FakeWebSocket.instances[0];
    socket?.emit('open');
    socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'started', sequence: 1, startedAt: 100, mode: 'script', statementIndex: 0, statementCount: 2 }) });
    socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'statement-started', sequence: 2, statementIndex: 0, statementSql: 'SELECT 1' }) });
    socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'session', sequence: 3, sessionId: 'session-1', totalRows: 0 }) });
    socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'columns', sequence: 4, columns: [{ name: 'ID', type: 'INTEGER' }, { name: 'NAME' }] }) });
    socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'progress', sequence: 5, totalRows: 1 }) });
    socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'rows', sequence: 6, rows: [[1, 'Alpha']], totalRows: 1 }) });
    socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'complete', sequence: 7, totalRows: 1, limitReached: false, rowsAffected: 1, message: 'done', commandType: 'SELECT' }) });
    socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'cancelled', sequence: 8, totalRows: 1, scope: 'statement' }) });
    socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'batch-complete', sequence: 9, status: 'complete', completedStatements: 2, message: 'finished' }) });
    socket?.emit('message', { data: JSON.stringify({ queryId: 'query-1', type: 'error', sequence: 10, message: 'diagnostic' }) });
    expect(events).toHaveLength(10);
    expect((events[0] as { startedAt: number }).startedAt).toBe(100);
    expect(subscription.getLastSequence()).toBe(10);

    socket?.error();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      jest.runOnlyPendingTimers();
      FakeWebSocket.instances.at(-1)?.close();
    }
    jest.runOnlyPendingTimers();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toHaveProperty('message', 'Electron query stream disconnected after five reconnect attempts.');
    subscription.close();
  });

  it('reports unavailable renderer transports', async () => {
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    try {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
      const client = createElectronApiClient();
      await expect(client.startQuery({ connectionId: 'connection-1', sql: 'SELECT 1', mode: 'single' })).rejects.toThrow('Fetch is unavailable in the Electron renderer.');
      delete (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
      expect(() => client.connectToQueryEvents('query-1', () => undefined)).toThrow('WebSocket is unavailable in the Electron renderer.');
    } finally {
      if (originalFetch) Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
      if (originalWebSocket) Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket });
    }
  });
});
