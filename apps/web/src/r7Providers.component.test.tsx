/** @jest-environment jsdom */

import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiClientProvider, createApiClient, useApiClient } from './api';
import { createWorkspaceStorage, useWorkspaceStorage, WorkspaceStorageProvider } from './workspacePersistence';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
    blob: async () => new Blob(),
  } as unknown as Response;
}

function ApiProbe(): React.ReactElement {
  const api = useApiClient();
  const [state, setState] = useState('idle');
  return <><output aria-label="api-state">{state}</output><button onClick={() => void api.me().then(() => setState('loaded'))}>Load user</button></>;
}

function StorageProbe(): React.ReactElement {
  const storage = useWorkspaceStorage();
  return <><output aria-label="storage-user">{storage.userId}</output><button onClick={() => storage.set('draft', 'SELECT 1')}>Save draft</button></>;
}

describe('R7 React providers', () => {
  it('injects an API client into an interactive component', async () => {
    const user = userEvent.setup();
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return jsonResponse({ user: { id: 'user-1' } });
    });
    render(<ApiClientProvider client={createApiClient({ fetch: fetchMock })}><ApiProbe /></ApiClientProvider>);

    await user.click(screen.getByRole('button', { name: 'Load user' }));

    expect(screen.getByRole('status', { name: 'api-state' })).toHaveTextContent('loaded');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps workspace writes in the injected user namespace', async () => {
    const user = userEvent.setup();
    const storage = createWorkspaceStorage('component-user');
    render(<WorkspaceStorageProvider storage={storage}><StorageProbe /></WorkspaceStorageProvider>);

    expect(screen.getByRole('status', { name: 'storage-user' })).toHaveTextContent('component-user');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(storage.get('draft')).toBe('SELECT 1');
    expect(localStorage.getItem('jwb:user:component-user:draft')).toBe('SELECT 1');
  });
});
