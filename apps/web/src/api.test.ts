/** @jest-environment jsdom */

import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QueryEvent } from '@justybase/contracts';
import { ApiClientProvider, ApiRequestError, createApiClient, useApiClient } from './api';

function jsonResponse(body: unknown, status = 200, responseHeaders?: HeadersInit): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(responseHeaders),
    json: async () => body,
    blob: async () => new Blob(),
  } as unknown as Response;
}

function ClientProbe(): ReactElement {
  const client = useApiClient();
  return createElement('span', null, typeof client.me);
}

type FakeSocketEvent = { data?: unknown };
type FakeSocketListener = (event: FakeSocketEvent) => void;

class FakeWebSocket {
  public static instances: FakeWebSocket[] = [];
  public readonly sent: string[] = [];
  public readonly url: string;
  public readyState = 0;
  private readonly listeners = new Map<string, FakeSocketListener[]>();

  public constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  public addEventListener(type: string, listener: FakeSocketListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  public send(payload: string): void {
    this.sent.push(payload);
  }

  public close(): void {
    this.readyState = 3;
    this.dispatch('close', {});
  }

  public open(): void {
    this.readyState = 1;
    this.dispatch('open', {});
  }

  public message(data: string): void {
    this.dispatch('message', { data });
  }

  private dispatch(type: string, event: FakeSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('API client factory', () => {
  beforeEach(() => { FakeWebSocket.instances = []; });

  it('keeps HTTP origins, cookie credentials, and CSRF adapters instance-local', async () => {
    const firstFetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return jsonResponse({ user: { id: 'one', username: 'one', role: 'user' } });
    });
    const secondFetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return jsonResponse({ user: { id: 'two', username: 'two', role: 'user' } });
    });
    const first = createApiClient({ httpBaseUrl: 'https://one.example.test/', csrfAdapter: () => 'csrf-one', fetch: firstFetch });
    const second = createApiClient({ httpBaseUrl: 'https://two.example.test/', csrfAdapter: () => 'csrf-two', fetch: secondFetch });

    await expect(first.me()).resolves.toEqual({ user: { id: 'one', username: 'one', role: 'user' } });
    await expect(second.me()).resolves.toEqual({ user: { id: 'two', username: 'two', role: 'user' } });

    expect(firstFetch).toHaveBeenCalledWith('https://one.example.test/api/auth/me', expect.objectContaining({
      credentials: 'include',
      headers: expect.objectContaining({ 'x-justybase-csrf': 'csrf-one' }),
    }));
    expect(secondFetch).toHaveBeenCalledWith('https://two.example.test/api/auth/me', expect.objectContaining({
      credentials: 'include',
      headers: expect.objectContaining({ 'x-justybase-csrf': 'csrf-two' }),
    }));
  });

  it('uses a bodyless request for the server-side test login', async () => {
    const fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return jsonResponse({ user: { id: 'test-user', username: 'test-admin', role: 'admin' } });
    });
    const client = createApiClient({ fetch });

    await expect(client.testLogin()).resolves.toEqual({
      user: { id: 'test-user', username: 'test-admin', role: 'admin' },
    });

    expect(fetch).toHaveBeenCalledWith('/api/auth/test-login', expect.objectContaining({ method: 'POST', credentials: 'include' }));
    expect(fetch.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toEqual(expect.objectContaining({ 'Content-Type': 'application/json' }));
    expect(JSON.stringify(fetch.mock.calls[0])).not.toContain('password');
  });

  it('requests schema DDL by identity without rebuilding it in the browser', async () => {
    const fetch = jest.fn(async () => jsonResponse({
      success: true,
      ddlCode: 'CREATE TABLE MYDB.ADMIN.USERS (...);',
      ddlFidelity: 'exact',
    }));
    const client = createApiClient({ fetch });

    await expect(client.ddl({
      connectionId: 'connection-1',
      database: 'MYDB',
      schema: 'ADMIN',
      objectName: 'USERS',
      objectType: 'TABLE',
    })).resolves.toEqual(expect.objectContaining({ success: true, ddlFidelity: 'exact' }));
    expect(fetch).toHaveBeenCalledWith(
      '/api/metadata/ddl?connectionId=connection-1&database=MYDB&schema=ADMIN&objectName=USERS&objectType=TABLE',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('preserves HTTP error status and deduplicates replayed WebSocket events', async () => {
    const fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return jsonResponse({ message: 'no session' }, 401);
    });
    const WebSocketConstructor = FakeWebSocket as unknown as new (url: string) => WebSocket;
    const client = createApiClient({
      fetch,
      webSocketBaseUrl: 'wss://events.example.test/',
      WebSocket: WebSocketConstructor,
    });

    await expect(client.me()).rejects.toEqual(expect.objectContaining({ name: 'ApiRequestError', status: 401 } satisfies Partial<ApiRequestError>));

    const events: QueryEvent[] = [];
    const subscription = client.connectToQueryEvents('query-1', event => events.push(event));
    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toBe('wss://events.example.test/api/ws');
    socket?.open();
    expect(socket?.sent).toEqual([JSON.stringify({ type: 'subscribe', queryId: 'query-1', afterSequence: 0 })]);
    const complete: QueryEvent = { type: 'complete', queryId: 'query-1', totalRows: 1, limitReached: false, sequence: 1 };
    socket?.message(JSON.stringify(complete));
    socket?.message(JSON.stringify(complete));
    expect(events).toEqual([complete]);
    expect(subscription.getLastSequence()).toBe(1);
    subscription.close();
    expect(socket?.readyState).toBe(3);
  });

  it('drops malformed, foreign, and unsupported query-event frames at the transport boundary', () => {
    const client = createApiClient({
      fetch: jest.fn(async () => jsonResponse({ ok: true })),
      webSocketBaseUrl: 'wss://events.example.test',
      WebSocket: FakeWebSocket as unknown as new (url: string) => WebSocket,
    });
    const events: QueryEvent[] = [];
    const subscription = client.connectToQueryEvents('query-1', event => events.push(event));
    const socket = FakeWebSocket.instances[0];
    socket?.open();

    const malformed = [
      'not-json',
      JSON.stringify({ queryId: 'other', type: 'started' }),
      JSON.stringify({ queryId: 'query-1', type: 'unknown' }),
      JSON.stringify({ queryId: 'query-1', type: 'started', sequence: -1 }),
      JSON.stringify({ queryId: 'query-1', type: 'started', statementIndex: -1 }),
      JSON.stringify({ queryId: 'query-1', type: 'columns', columns: [{ name: 1 }] }),
      JSON.stringify({ queryId: 'query-1', type: 'session', totalRows: -1 }),
      JSON.stringify({ queryId: 'query-1', type: 'progress', totalRows: 'many' }),
      JSON.stringify({ queryId: 'query-1', type: 'rows', rows: [[1, 2]], totalRows: 0 }),
      JSON.stringify({ queryId: 'query-1', type: 'complete', totalRows: 1, limitReached: 'no' }),
      JSON.stringify({ queryId: 'query-1', type: 'error', message: 42 }),
      JSON.stringify({ queryId: 'query-1', type: 'cancelled', totalRows: 0, scope: 'unknown' }),
      JSON.stringify({ queryId: 'query-1', type: 'batch-complete', status: 'complete', completedStatements: -1 }),
      JSON.stringify({ queryId: 'query-1', type: 'started', startedAt: Number.NaN }),
      JSON.stringify({ queryId: 'query-1', type: 'statement-started', statementSql: 42 }),
    ];
    for (const frame of malformed) socket?.message(frame);

    const valid = [
      { queryId: 'query-1', type: 'started', sequence: 1 },
      { queryId: 'query-1', type: 'statement-started', sequence: 2 },
      { queryId: 'query-1', type: 'columns', sequence: 3, columns: [{ name: 'ID' }] },
      { queryId: 'query-1', type: 'session', sequence: 4, totalRows: 1 },
      { queryId: 'query-1', type: 'progress', sequence: 5, totalRows: 1 },
      { queryId: 'query-1', type: 'rows', sequence: 6, rows: [[1]], totalRows: 1 },
      { queryId: 'query-1', type: 'complete', sequence: 7, totalRows: 1, limitReached: false },
      { queryId: 'query-1', type: 'error', sequence: 8, message: 'later error' },
      { queryId: 'query-1', type: 'cancelled', sequence: 9, totalRows: 1 },
      { queryId: 'query-1', type: 'batch-complete', sequence: 10, status: 'complete', completedStatements: 1 },
    ];
    for (const frame of valid) socket?.message(JSON.stringify(frame));

    expect(events).toHaveLength(valid.length);
    expect(subscription.getLastSequence()).toBe(10);
    subscription.close();
  });

  it('bootstraps CSRF from a remote API origin before state-changing requests', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      if (String(input).endsWith('/api/auth/csrf')) {
        return jsonResponse({ csrfToken: 'remote-csrf' }, 200, { 'x-justybase-csrf': 'remote-csrf' });
      }
      return jsonResponse({ ok: true });
    });
    const client = createApiClient({ httpBaseUrl: 'https://api.example.test', fetch });

    await client.updateEditorPreferences({ fontSize: 14 });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.input).toBe('https://api.example.test/api/auth/csrf');
    expect(calls[0]?.init).toEqual(expect.objectContaining({ credentials: 'include' }));
    expect(calls[1]?.input).toBe('https://api.example.test/api/preferences/editor');
    expect(calls[1]?.init).toEqual(expect.objectContaining({
      credentials: 'include',
      headers: expect.objectContaining({ 'x-justybase-csrf': 'remote-csrf' }),
    }));
  });

  it('shares one remote CSRF bootstrap across concurrent state-changing requests', async () => {
    let releaseBootstrap!: () => void;
    const bootstrapReleased = new Promise<void>(resolve => { releaseBootstrap = resolve; });
    const calls: string[] = [];
    const fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/api/auth/csrf')) {
        await bootstrapReleased;
        return jsonResponse({ csrfToken: 'shared-remote-csrf' }, 200, { 'x-justybase-csrf': 'shared-remote-csrf' });
      }
      return jsonResponse({ ok: true });
    });
    const client = createApiClient({ httpBaseUrl: 'https://api.example.test', fetch });

    const first = client.updateEditorPreferences({ fontSize: 14 });
    const second = client.updateEditorPreferences({ tabSize: 2 });
    await Promise.resolve();
    expect(calls.filter(url => url.endsWith('/api/auth/csrf'))).toHaveLength(1);

    releaseBootstrap();
    await Promise.all([first, second]);
    expect(calls.filter(url => url.endsWith('/api/preferences/editor'))).toHaveLength(2);
  });

  it('derives the WebSocket origin from a remote HTTP origin when no override is supplied', () => {
    const WebSocketConstructor = FakeWebSocket as unknown as new (url: string) => WebSocket;
    const client = createApiClient({
      httpBaseUrl: 'https://api.example.test/',
      fetch: jest.fn(async () => jsonResponse({ ok: true })),
      WebSocket: WebSocketConstructor,
    });

    const subscription = client.connectToQueryEvents('query-1', () => undefined);
    expect(FakeWebSocket.instances[0]?.url).toBe('wss://api.example.test/api/ws');
    subscription.close();
  });

  it('clears the cached remote CSRF token after logout', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      const url = String(input);
      if (url.endsWith('/api/auth/login')) return jsonResponse({ user: { id: 'one', username: 'one', role: 'user' } }, 200, { 'x-justybase-csrf': 'old-csrf' });
      if (url.endsWith('/api/auth/csrf')) return jsonResponse({ csrfToken: 'new-csrf' }, 200, { 'x-justybase-csrf': 'new-csrf' });
      return url.endsWith('/api/auth/logout') ? jsonResponse({ ok: true }) : jsonResponse({ ok: true });
    });
    const client = createApiClient({ httpBaseUrl: 'https://api.example.test', fetch });

    await client.login('one', 'password');
    await client.logout();
    await client.updateEditorPreferences({ fontSize: 14 });

    const logoutCall = calls.find(call => String(call.input).endsWith('/api/auth/logout'));
    expect(logoutCall?.init?.headers).toEqual(expect.objectContaining({ 'x-justybase-csrf': 'old-csrf' }));
    const preferenceCall = calls.find(call => String(call.input).endsWith('/api/preferences/editor'));
    expect(preferenceCall?.init?.headers).toEqual(expect.objectContaining({ 'x-justybase-csrf': 'new-csrf' }));
  });

  it('injects the same client through the React provider', () => {
    const fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return jsonResponse({});
    });
    const client = createApiClient({ fetch });
    const markup = renderToStaticMarkup(createElement(ApiClientProvider, { client, children: createElement(ClientProbe) }));
    expect(markup).toContain('<span>function</span>');
  });
});
