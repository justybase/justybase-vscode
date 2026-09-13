/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SchemaTreeNode } from '@justybase/contracts';
import type { ApiClient } from './api';
import { ApiClientProvider } from './api';
import { SchemaTree } from './SchemaTree';
import { WorkspaceStorageProvider } from './workspacePersistence';
import type { WorkspaceStorage } from './workspacePersistence';

function node(id: string, label: string): SchemaTreeNode {
  return { id, kind: 'database', label, database: label, hasChildren: true };
}

function storage(): WorkspaceStorage {
  const values = new Map<string, string>();
  return {
    userId: 'schema-test-user',
    get: key => values.get(key) ?? null,
    set: (key, value) => { values.set(key, value); },
    remove: key => { values.delete(key); },
  };
}

describe('legacy Web schema explorer', () => {
  it('keeps every database visible while opening the document database by default', async () => {
    const schemaTree = jest.fn(async (_connectionId: string, parentId?: string) => {
      if (!parentId) return { nodes: [node('db:JUST_DATA', 'JUST_DATA'), node('db:REPORTING', 'REPORTING')] };
      return { nodes: [] };
    });
    const searchSchema = jest.fn(async (request: { database?: string }) => {
      void request;
      return { items: [] };
    });
    const api = { schemaTree, searchSchema } as unknown as ApiClient;
    render(
      <ApiClientProvider client={api}>
        <WorkspaceStorageProvider storage={storage()}>
          <SchemaTree connectionId="connection-1" database="JUST_DATA" onInsert={() => undefined} onContextChange={() => undefined} />
        </WorkspaceStorageProvider>
      </ApiClientProvider>,
    );

    expect(await screen.findByText('JUST_DATA')).toBeInTheDocument();
    expect(screen.getByText('REPORTING')).toBeInTheDocument();
    expect(schemaTree).toHaveBeenCalledWith('connection-1', undefined);

    fireEvent.click(screen.getByRole('button', { name: 'REPORTING' }));
    await waitFor(() => expect(schemaTree).toHaveBeenCalledWith('connection-1', 'db:REPORTING'));

    fireEvent.change(screen.getByPlaceholderText('Search tables, views…'), { target: { value: 'dim' } });
    await waitFor(() => expect(searchSchema).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: 'connection-1',
      searchAllDatabases: true,
    })), { timeout: 1_000 });
    expect(searchSchema.mock.calls[0]?.[0]?.database).toBeUndefined();
  });
});
