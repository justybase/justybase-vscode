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
