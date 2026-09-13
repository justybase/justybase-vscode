import type { QueryEvent } from '@justybase/contracts';
import { ApiRequestError, createApiClient, parseQueryEvent } from '../src';

function jsonResponse(body: unknown, status = 200, responseHeaders?: HeadersInit): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(responseHeaders),
    json: async () => body,
    blob: async () => new Blob(['fixture']),
  } as unknown as Response;
}

type FakeSocketEvent = { data?: unknown };
type FakeSocketListener = (event: FakeSocketEvent) => void;

class FakeWebSocket {
  public static instances: FakeWebSocket[] = [];
  public readonly sent: string[] = [];
  private readonly listeners = new Map<string, FakeSocketListener[]>();

  public constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  public addEventListener(type: string, listener: FakeSocketListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  public send(value: string): void {
    this.sent.push(value);
  }

  public open(): void {
    this.dispatch('open', {});
  }

  public close(): void {
    this.dispatch('close', {});
  }

  public emit(type: string, event: FakeSocketEvent = {}): void {
    this.dispatch(type, event);
  }

  private dispatch(type: string, event: FakeSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('shared workspace API transport', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps request credentials configurable for each product adapter', async () => {
    const fetch = jest.fn(async () => jsonResponse({ queryId: 'query-1' }));
    const client = createApiClient({ fetch, credentials: 'same-origin' });

    await expect(client.startQuery({ connectionId: 'connection-1', sql: 'SELECT 1', mode: 'single' })).resolves.toEqual({ queryId: 'query-1' });
    expect(fetch).toHaveBeenCalledWith('/api/query', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('preserves typed HTTP failures and response filenames for downloads', async () => {
    const blob = new Blob(['data']);
    const fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'unauthorized' }, 401))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-disposition': 'attachment; filename="orders.csv"' }),
        blob: async () => blob,
      } as unknown as Response);
    const client = createApiClient({ fetch });

    await expect(client.me()).rejects.toEqual(expect.objectContaining({ name: 'ApiRequestError', status: 401 } satisfies Partial<ApiRequestError>));
    await expect(client.exportQuery('query-1', { format: 'csv' })).resolves.toEqual({ blob, fileName: 'orders.csv' });
  });

  it('validates query frames and replays only newer sequence numbers', () => {
    expect(parseQueryEvent({ queryId: 'other', type: 'started' }, 'query-1')).toBeUndefined();
    expect(parseQueryEvent({ queryId: 'query-1', type: 'rows', rows: [[1]], totalRows: 0 }, 'query-1')).toBeUndefined();
    expect(parseQueryEvent({ queryId: 'query-1', type: 'started', startedAt: 100 }, 'query-1')).toEqual({ queryId: 'query-1', type: 'started', startedAt: 100 });

    const client = createApiClient({
      fetch: jest.fn(async () => jsonResponse({ ok: true })),
      webSocketBaseUrl: 'wss://events.example.test/',
      WebSocket: FakeWebSocket as unknown as new (url: string) => WebSocket,
    });
    const events: QueryEvent[] = [];
    const subscription = client.connectToQueryEvents('query-1', event => events.push(event));
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    const event: QueryEvent = { queryId: 'query-1', type: 'complete', totalRows: 1, limitReached: false, sequence: 1 };
    socket?.emit('message', { data: JSON.stringify(event) });
    socket?.emit('message', { data: JSON.stringify(event) });
    expect(events).toEqual([event]);
    expect(subscription.getLastSequence()).toBe(1);
    subscription.close();
  });

  it('does not let a late close from an old socket create a duplicate reconnect', () => {
    jest.useFakeTimers();
    const client = createApiClient({
      fetch: jest.fn(async () => jsonResponse({ ok: true })),
      webSocketBaseUrl: 'ws://events.example.test',
      WebSocket: FakeWebSocket as unknown as new (url: string) => WebSocket,
    });
    const subscription = client.connectToQueryEvents('query-1', () => undefined);
    const first = FakeWebSocket.instances[0];
    first?.close();
    jest.advanceTimersByTime(200);
    const second = FakeWebSocket.instances[1];
    expect(FakeWebSocket.instances).toHaveLength(2);
    second?.open();

    first?.close();
    expect(FakeWebSocket.instances).toHaveLength(2);
    subscription.close();
  });

  it('reports a missing fetch lazily so composition roots can be created before the renderer is ready', async () => {
    const originalFetch = globalThis.fetch;
    try {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: undefined });
      const client = createApiClient();
      await expect(client.me()).rejects.toThrow('Fetch is unavailable. Provide fetch in ApiClientOptions.');
    } finally {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
    }
  });
});
