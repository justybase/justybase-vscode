/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SchemaTreeNode } from '@justybase/contracts';
import { SchemaExplorer } from '../src/renderer/SchemaExplorer';

const table: SchemaTreeNode = {
  id: 'table:orders',
  kind: 'object',
  label: 'Orders',
  database: 'DB1',
  schema: 'dbo',
  objectName: 'Orders',
  objectType: 'TABLE',
  hasChildren: true,
};

function apiFixture(): {
  schemaTree: jest.Mock;
  searchSchema: jest.Mock;
  columns: jest.Mock;
  ddl: jest.Mock;
} {
  return {
    schemaTree: jest.fn(async () => ({ nodes: [table] })),
    searchSchema: jest.fn(async () => ({ items: [] })),
    columns: jest.fn(async () => []),
    ddl: jest.fn(async () => ({ success: false, error: 'not used in this test' })),
  };
}

describe('Electron schema explorer SQL templates', () => {
  it('opens a SQL Server top-row query with TOP instead of LIMIT', async () => {
    const onOpenQuery = jest.fn();
    const api = apiFixture();
    render(<SchemaExplorer api={api} connectionId="connection-1" database="DB1" databaseKind="mssql" onInsert={() => undefined} onOpenQuery={onOpenQuery} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Orders/ })).toBeInTheDocument());
    fireEvent.contextMenu(screen.getByRole('button', { name: /Orders/ }));
    fireEvent.click(screen.getByRole('button', { name: 'View top 1000' }));
    expect(onOpenQuery).toHaveBeenCalledWith('SELECT TOP 1000 *\nFROM [DB1].[dbo].[Orders]', 'Top 1000 · Orders', table);
  });

  it('opens a SQL Server SHOWPLAN batch for Explain plan', async () => {
    const onOpenQuery = jest.fn();
    const api = apiFixture();
    render(<SchemaExplorer api={api} connectionId="connection-1" database="DB1" databaseKind="mssql" onInsert={() => undefined} onOpenQuery={onOpenQuery} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Orders/ })).toBeInTheDocument());
    fireEvent.contextMenu(screen.getByRole('button', { name: /Orders/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Explain plan' }));
    expect(onOpenQuery).toHaveBeenCalledWith(expect.stringContaining('SET SHOWPLAN_TEXT ON;\nGO'), 'Explain · Orders', table);
    expect(onOpenQuery.mock.calls[0]?.[0]).toContain('SELECT TOP 1000 *\nFROM [DB1].[dbo].[Orders];');
    expect(onOpenQuery.mock.calls[0]?.[0]).toContain('SET SHOWPLAN_TEXT OFF;\nGO');
  });

  it('uses schema-qualified PostgreSQL SQL for the shared object actions', async () => {
    const onOpenQuery = jest.fn();
    const api = apiFixture();
    render(<SchemaExplorer api={api} connectionId="connection-1" database="DB1" databaseKind="postgresql" onInsert={() => undefined} onOpenQuery={onOpenQuery} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Orders/ })).toBeInTheDocument());
    fireEvent.contextMenu(screen.getByRole('button', { name: /Orders/ }));
    fireEvent.click(screen.getByRole('button', { name: 'View top 1000' }));
    expect(onOpenQuery).toHaveBeenCalledWith('SELECT *\nFROM "dbo"."Orders"\nLIMIT 1000', 'Top 1000 · Orders', table);
  });
});
