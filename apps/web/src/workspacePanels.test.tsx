/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WebUser } from '@justybase/contracts';
import { ApiClientProvider, createApiClient } from './api';
import { Login } from './workspacePanels';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
    blob: async () => new Blob(),
  } as unknown as Response;
}

function setTestLoginFlag(value: boolean): void {
  (globalThis as { __JUSTYBASE_ENABLE_TEST_LOGIN__?: boolean }).__JUSTYBASE_ENABLE_TEST_LOGIN__ = value;
}

function renderLogin(fetch: typeof globalThis.fetch, onLogin = jest.fn()): jest.Mock {
  render(
    <ApiClientProvider client={createApiClient({ fetch })}>
      <Login onLogin={onLogin} />
    </ApiClientProvider>,
  );
  return onLogin;
}

describe('Login test harness affordance', () => {
  afterEach(() => {
    delete (globalThis as { __JUSTYBASE_ENABLE_TEST_LOGIN__?: boolean }).__JUSTYBASE_ENABLE_TEST_LOGIN__;
  });

  it('does not render the test login button in a normal build', () => {
    setTestLoginFlag(false);
    renderLogin(jest.fn(async () => jsonResponse({ user: { id: 'user-1', username: 'admin', role: 'admin' } })));

    expect(screen.queryByRole('button', { name: /^Use test login data$/ })).not.toBeInTheDocument();
  });

  it('renders the exact test-only button and logs in without a password body', async () => {
    setTestLoginFlag(true);
    const fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return jsonResponse({ user: { id: 'user-1', username: 'admin', role: 'admin' } satisfies WebUser });
    });
    const onLogin = renderLogin(fetch);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /^Use test login data$/ }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith({ id: 'user-1', username: 'admin', role: 'admin' }));
    expect(fetch).toHaveBeenCalledWith('/api/auth/test-login', expect.objectContaining({ method: 'POST' }));
    expect(fetch.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(JSON.stringify(fetch.mock.calls)).not.toContain('password');
  });

  it('keeps the normal username/password form on the regular endpoint', async () => {
    setTestLoginFlag(false);
    const fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return jsonResponse({ user: { id: 'user-1', username: 'admin', role: 'admin' } satisfies WebUser });
    });
    const onLogin = renderLogin(fetch);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'normal-password');
    await user.click(screen.getByRole('button', { name: /^Sign in$/ }));
    await waitFor(() => expect(onLogin).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'normal-password' }),
    }));
  });
});
