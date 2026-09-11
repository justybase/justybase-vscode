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
