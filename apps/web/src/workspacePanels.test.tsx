/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConnectionProfileSummary, WebUser } from '@justybase/contracts';
import { ApiClientProvider, createApiClient, type ApiClient } from './api';
import { ConnectionForm, Login } from './workspacePanels';

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

function connectionProfile(overrides: Partial<ConnectionProfileSummary> = {}): ConnectionProfileSummary {
  return {
    id: 'connection-1',
    name: 'Authoring profile',
    host: 'db.example.com',
    port: 5480,
    database: 'SYSTEM',
    user: 'admin',
    dbType: 'postgresql',
    readOnly: true,
    ...overrides,
  };
}

function connectionApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    createConnection: jest.fn(async () => connectionProfile({ dbType: 'netezza' })),
    updateConnection: jest.fn(async () => connectionProfile({ dbType: 'netezza' })),
    testConnection: jest.fn(async () => ({ ok: true as const })),
    testConnectionProfile: jest.fn(async () => ({ ok: true as const })),
    ...overrides,
  } as ApiClient;
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

describe('Web connection dialect catalog', () => {
  it('shows every supported authoring dialect and blocks profiles without a Web runtime', () => {
    render(<ConnectionForm api={connectionApi()} onCreated={jest.fn()} onCancel={jest.fn()} />);

    const select = screen.getByRole('combobox', { name: /Database type/u }) as HTMLSelectElement;
    expect(Array.from(select.options).map(option => option.value)).toEqual([
      'netezza', 'oracle', 'postgresql', 'vertica', 'snowflake', 'sqlite', 'duckdb', 'db2', 'mssql', 'mysql', 'clickhouse', 'access',
    ]);
    for (const value of ['oracle', 'postgresql', 'vertica', 'snowflake', 'db2', 'mssql', 'mysql', 'clickhouse', 'access']) {
      expect(select.querySelector(`option[value="${value}"]`)).toBeDisabled();
    }
    expect(screen.getByText('Metadata, execution and Result Grid are available.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add connection' })).toBeEnabled();
  });

  it('keeps an authoring-only existing profile visible but prevents a false runtime save or test', () => {
    const api = connectionApi();
    render(<ConnectionForm api={api} initial={connectionProfile()} onCreated={jest.fn()} onCancel={jest.fn()} />);

    const select = screen.getByRole('combobox', { name: /Database type/u }) as HTMLSelectElement;
    expect(select.value).toBe('postgresql');
    expect(screen.getByText('SQL authoring profile is available; Web runtime connection is not enabled.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    expect(api.updateConnection).not.toHaveBeenCalled();
    expect(api.testConnection).not.toHaveBeenCalled();
  });
});
