/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('Web Dockyard composition root', () => {
  it('renders the Dockyard shell after authenticated startup', async () => {
    render(<App apiClient={fixtureApi()} />);
    await waitFor(() => expect(screen.getByText('JustyBase')).toBeInTheDocument());
    expect(screen.getByRole('navigation', { name: 'Dockyard tools' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connections' })).toBeInTheDocument();
  });

  it('uses the async state during startup and restores the Dockyard shell after login', async () => {
    let resolveMe: ((value: Response) => void) | undefined;
    const pendingFetch = jest.fn(() => new Promise<Response>(resolve => { resolveMe = resolve; }));
    const pendingApi = createApiClient({ fetch: pendingFetch });
    const pending = render(<App apiClient={pendingApi} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading JustyBase');
    pending.unmount();
    resolveMe?.(response({ user: { id: 'never-used', username: 'pending', role: 'user' } }));

    const unauthenticated = render(<App apiClient={fixtureApi('unauthenticated')} />);
    await waitFor(() => expect(screen.getByText('Sign in')).toBeInTheDocument());
    unauthenticated.unmount();
    render(<App apiClient={fixtureApi()} />);
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Dockyard tools' })).toBeInTheDocument());
  });

  it('keeps retryable bootstrap failures visible and retries the API connection', async () => {
    let attempts = 0;
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        attempts += 1;
        return attempts === 1
          ? response({ message: 'Workspace API temporarily unavailable.' }, false, 503)
          : response({ user: { id: 'web-user', username: 'alice', role: 'user' } });
      }
      if (url.endsWith('/api/connections')) return response([]);
      if (url.endsWith('/api/history')) return response([]);
      if (url.endsWith('/api/preferences/editor')) return response({ fontSize: 14, tabSize: 4, insertSpaces: true, wordWrap: 'off', minimap: false, lineNumbers: true, formatOnSave: false, formatOnType: false, keywordCase: 'preserve', inlineTypeHints: true, linterEnabled: true, linterRules: {} });
      return response({ ok: true });
    });
    render(<App apiClient={createApiClient({ fetch: fetchMock })} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Workspace API temporarily unavailable.'));
    expect(screen.queryByText('Sign in')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Dockyard tools' })).toBeInTheDocument());
    expect(attempts).toBe(2);
  });
});
