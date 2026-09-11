/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { createApiClient } from './api';

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, headers: new Headers(), json: async () => body, blob: async () => new Blob() } as unknown as Response;
}

function fixtureApi(me: 'authenticated' | 'unauthenticated' = 'authenticated') {
  const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/auth/me')) return me === 'authenticated'
      ? response({ user: { id: 'web-user', username: 'alice', role: 'user' } })
      : response({ message: 'Unauthenticated' }, false, 401);
    if (url.endsWith('/api/connections')) return response([]);
    if (url.endsWith('/api/history')) return response([]);
    if (url.endsWith('/api/preferences/editor')) return response({ fontSize: 14, tabSize: 4, insertSpaces: true, wordWrap: 'off', minimap: false, lineNumbers: true, formatOnSave: false, formatOnType: false, keywordCase: 'preserve', inlineTypeHints: true, linterEnabled: true, linterRules: {} });
    if (url.includes('/api/schema/tree')) return response({ nodes: [] });
    return response({ ok: true });
  });
  return createApiClient({ fetch: fetchMock });
}

describe('Web shared-mode composition root', () => {
  afterEach(() => {
    delete (globalThis as { __JUSTYBASE_UI_MODE__?: unknown }).__JUSTYBASE_UI_MODE__;
  });

  it('renders the shared React shell after authenticated startup', async () => {
    (globalThis as { __JUSTYBASE_UI_MODE__?: unknown }).__JUSTYBASE_UI_MODE__ = 'shared';
    render(<App apiClient={fixtureApi()} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'JustyBase' })).toBeInTheDocument());
    expect(screen.getByRole('tablist', { name: 'Open documents' })).toBeInTheDocument();
  });

  it('uses the shared async state during startup and preserves the legacy fallback', async () => {
    let resolveMe: ((value: Response) => void) | undefined;
    const pendingFetch = jest.fn(() => new Promise<Response>(resolve => { resolveMe = resolve; }));
    const pendingApi = createApiClient({ fetch: pendingFetch });
    const pending = render(<App apiClient={pendingApi} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading JustyBase');
    pending.unmount();
    resolveMe?.(response({ user: { id: 'never-used', username: 'pending', role: 'user' } }));

    delete (globalThis as { __JUSTYBASE_UI_MODE__?: unknown }).__JUSTYBASE_UI_MODE__;
    render(<App apiClient={fixtureApi('unauthenticated')} />);
    await waitFor(() => expect(screen.getByText('Sign in')).toBeInTheDocument());
    render(<App apiClient={fixtureApi()} />);
    await waitFor(() => expect(screen.getByText('Netezza SQL Workspace')).toBeInTheDocument());
  });
});
