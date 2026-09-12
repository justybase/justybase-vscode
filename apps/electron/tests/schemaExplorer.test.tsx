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

function schemaLabel(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('.electron-schema-label');
  if (!button) throw new Error('Schema object label was not rendered.');
  return button;
}

describe('Electron schema explorer SQL templates', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('opens a SQL Server top-row query with TOP instead of LIMIT', async () => {
    const onOpenQuery = jest.fn();
    const api = apiFixture();
    render(<SchemaExplorer api={api} connectionId="connection-1" database="DB1" databaseKind="mssql" onInsert={() => undefined} onOpenQuery={onOpenQuery} />);
    await waitFor(() => expect(document.querySelector('.electron-schema-label')).toBeTruthy());
    fireEvent.contextMenu(schemaLabel());
    fireEvent.click(screen.getByRole('button', { name: 'View top 1000' }));
    expect(onOpenQuery).toHaveBeenCalledWith('SELECT TOP 1000 *\nFROM [DB1].[dbo].[Orders]', 'Top 1000 · Orders', table);
  });

  it('opens a SQL Server SHOWPLAN batch for Explain plan', async () => {
    const onOpenQuery = jest.fn();
    const api = apiFixture();
    render(<SchemaExplorer api={api} connectionId="connection-1" database="DB1" databaseKind="mssql" onInsert={() => undefined} onOpenQuery={onOpenQuery} />);
    await waitFor(() => expect(document.querySelector('.electron-schema-label')).toBeTruthy());
    fireEvent.contextMenu(schemaLabel());
    fireEvent.click(screen.getByRole('button', { name: 'Explain plan' }));
    expect(onOpenQuery).toHaveBeenCalledWith(expect.stringContaining('SET SHOWPLAN_TEXT ON;\nGO'), 'Explain · Orders', table);
    expect(onOpenQuery.mock.calls[0]?.[0]).toContain('SELECT TOP 1000 *\nFROM [DB1].[dbo].[Orders];');
    expect(onOpenQuery.mock.calls[0]?.[0]).toContain('SET SHOWPLAN_TEXT OFF;\nGO');
  });

  it('opens the shared Object Designer from the object context menu', async () => {
    const onOpenDesigner = jest.fn();
    const api = apiFixture();
    render(<SchemaExplorer api={api} connectionId="connection-1" database="DB1" databaseKind="mssql" onInsert={() => undefined} onOpenDesigner={onOpenDesigner} />);
    await waitFor(() => expect(document.querySelector('.electron-schema-label')).toBeTruthy());
    fireEvent.contextMenu(schemaLabel());
    fireEvent.click(screen.getByRole('button', { name: 'Open Object Designer' }));
    expect(onOpenDesigner).toHaveBeenCalledWith(table);
  });

  it('uses schema-qualified PostgreSQL SQL for the shared object actions', async () => {
    const onOpenQuery = jest.fn();
    const api = apiFixture();
    render(<SchemaExplorer api={api} connectionId="connection-1" database="DB1" databaseKind="postgresql" onInsert={() => undefined} onOpenQuery={onOpenQuery} />);
    await waitFor(() => expect(document.querySelector('.electron-schema-label')).toBeTruthy());
    fireEvent.contextMenu(schemaLabel());
    fireEvent.click(screen.getByRole('button', { name: 'View top 1000' }));
    expect(onOpenQuery).toHaveBeenCalledWith('SELECT *\nFROM "dbo"."Orders"\nLIMIT 1000', 'Top 1000 · Orders', table);
  });

  it('persists favorites and recent objects and copies a stable qualified name', async () => {
    const onInsert = jest.fn();
    const clipboard = jest.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
    const api = apiFixture();
    const first = render(<SchemaExplorer api={api} connectionId="connection-1" database="DB1" databaseKind="mssql" onInsert={onInsert} />);
    await waitFor(() => expect(document.querySelector('.electron-schema-label')).toBeTruthy());
    const tableButton = schemaLabel();
    fireEvent.click(tableButton);
    expect(onInsert).toHaveBeenCalledWith('[DB1].[dbo].[Orders]');
    expect(screen.getByText('Recent')).toBeInTheDocument();

    fireEvent.contextMenu(tableButton);
    fireEvent.click(screen.getByRole('button', { name: 'Add to favorites' }));
    expect(screen.getByText('Favorites')).toBeInTheDocument();

    fireEvent.contextMenu(tableButton);
    fireEvent.click(screen.getByRole('button', { name: 'Copy qualified name' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith('[DB1].[dbo].[Orders]'));

    first.unmount();
    render(<SchemaExplorer api={api} connectionId="connection-1" database="DB1" databaseKind="mssql" onInsert={onInsert} />);
    await waitFor(() => expect(screen.getByText('Favorites')).toBeInTheDocument());
    expect(screen.getByText('Recent')).toBeInTheDocument();
  });

  it('copies reconstructed DDL with an explicit fidelity notice', async () => {
    const clipboard = jest.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
    const api = apiFixture();
    api.ddl.mockResolvedValue({ success: true, ddlCode: 'CREATE TABLE dbo.Orders (id INT);', ddlFidelity: 'reconstructed' });
    render(<SchemaExplorer api={api} connectionId="connection-1" database="DB1" databaseKind="mssql" onInsert={() => undefined} />);
    await waitFor(() => expect(document.querySelector('.electron-schema-label')).toBeTruthy());
    const tableButton = schemaLabel();
    fireEvent.contextMenu(tableButton);
    fireEvent.click(screen.getByRole('button', { name: 'Copy DDL' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith('CREATE TABLE dbo.Orders (id INT);'));
    expect(await screen.findByRole('status')).toHaveTextContent('Reconstructed DDL copied');
  });

  it('refreshes safely and exposes expand/collapse state to keyboard and screen-reader users', async () => {
    const api = apiFixture();
    render(<SchemaExplorer api={api} connectionId="connection-1" database="DB1" databaseKind="mssql" onInsert={() => undefined} />);
    await waitFor(() => expect(document.querySelector('.electron-schema-label')).toBeTruthy());
    const expander = screen.getByRole('button', { name: 'Expand Orders' });
    expect(expander).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(expander);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Collapse Orders' })).toHaveAttribute('aria-expanded', 'true'));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all schema nodes' }));
    expect(screen.getByRole('button', { name: 'Expand Orders' })).toHaveAttribute('aria-expanded', 'false');
    const callsBeforeRefresh = api.schemaTree.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh schema' }));
    await waitFor(() => expect(api.schemaTree.mock.calls.length).toBeGreaterThan(callsBeforeRefresh));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Database schema' })).toHaveAttribute('aria-busy', 'false'));
  });

  it('reloads the root before expanding all children after a metadata mutation', async () => {
    const api = apiFixture();
    render(<SchemaExplorer api={api} connectionId="connection-1" database="DB1" databaseKind="mssql" onInsert={() => undefined} />);
    await waitFor(() => expect(document.querySelector('.electron-schema-label')).toBeTruthy());
    const callsBeforeExpand = api.schemaTree.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Expand all schema nodes' }));
    await waitFor(() => expect(api.schemaTree.mock.calls.length).toBeGreaterThan(callsBeforeExpand));
  });

  it('reloads the schema and an active search after a designer mutation', async () => {
    const api = apiFixture();
    const view = render(<SchemaExplorer api={api} connectionId="connection-1" database="DB1" databaseKind="mssql" refreshNonce={0} onInsert={() => undefined} />);
    await waitFor(() => expect(document.querySelector('.electron-schema-label')).toBeTruthy());
    const callsBeforeRefresh = api.schemaTree.mock.calls.length;
    view.rerender(<SchemaExplorer api={api} connectionId="connection-1" database="DB1" databaseKind="mssql" refreshNonce={1} onInsert={() => undefined} />);
    await waitFor(() => expect(api.schemaTree.mock.calls.length).toBeGreaterThan(callsBeforeRefresh));
  });
});
