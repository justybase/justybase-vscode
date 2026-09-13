/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiClientProvider, createApiClient } from './api';
import { ResultGrid } from './ResultGrid';
import { emptyResult, type ResultState } from './queryState';
import { createWorkspaceStorage, WorkspaceStorageProvider } from './workspacePersistence';

describe('legacy Web ResultGrid compatibility surface', () => {
  it('uses the shared grid metadata path for local aggregate cells', async () => {
    const user = userEvent.setup();
    const api = createApiClient({ fetch: jest.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({}), blob: async () => new Blob() } as unknown as Response)) });
    const result: ResultState = {
      ...emptyResult,
      resultSetId: 'legacy-aggregate-result',
      columns: ['CATEGORY', 'AMOUNT'],
      columnTypes: ['VARCHAR', 'NUMERIC'],
      columnScales: [undefined, 2],
      rows: [['EU', '10.25'], ['US', '7.50']],
      totalRows: 2,
      status: 'complete',
    };

    render(
      <ApiClientProvider client={api}>
        <WorkspaceStorageProvider storage={createWorkspaceStorage('result-grid-test')}>
          <ResultGrid queryId="legacy-query" result={result} />
        </WorkspaceStorageProvider>
      </ApiClientProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Aggregates' }));
    expect(await screen.findByText('Aggregates for 2 rows')).toBeInTheDocument();
    const tables = screen.getAllByRole('table');
    expect(tables).toHaveLength(2);
    expect(tables[1]).toHaveTextContent('10.25');
    expect(tables[1]).toHaveTextContent('7.50');
  });

  it('renders grouping immediately as tree rows in the same shared grid', async () => {
    const user = userEvent.setup();
    const fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = url.includes('/page')
        ? { rows: [['EU', '10.25'], ['US', '7.50']], totalRows: 2 }
        : {};
      return { ok: true, status: 200, headers: new Headers(), json: async () => json, blob: async () => new Blob() } as unknown as Response;
    });
    const api = createApiClient({ fetch });
    const result: ResultState = {
      ...emptyResult,
      resultSetId: 'server-group-result',
      sessionId: 'session-1',
      columns: ['CATEGORY', 'AMOUNT'],
      columnTypes: ['VARCHAR', 'NUMERIC'],
      columnScales: [undefined, 2],
      rows: [['EU', '10.25'], ['US', '7.50']],
      totalRows: 2,
      status: 'complete',
    };

    render(
      <ApiClientProvider client={api}>
        <WorkspaceStorageProvider storage={createWorkspaceStorage('result-grid-server-group-test')}>
          <ResultGrid queryId="server-group-query" result={result} />
        </WorkspaceStorageProvider>
      </ApiClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'Group by CATEGORY' }));
    expect(await screen.findByText('CATEGORY: EU')).toBeInTheDocument();
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(document.querySelectorAll('.ui-data-grid-group-row')).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/api/query/server-group-query/group'), expect.anything());
    expect(screen.getByRole('group', { name: 'Grouping panel' })).toHaveTextContent('CATEGORY');
  });

  it('uses one virtualized result surface and loads the next batch on scroll', async () => {
    const pageRequests: Array<{ offset?: number; limit?: number }> = [];
    const fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('/page')) return { ok: true, status: 200, headers: new Headers(), json: async () => ({}), blob: async () => new Blob() } as unknown as Response;
      const request = JSON.parse(String(init?.body ?? '{}')) as { offset?: number; limit?: number };
      pageRequests.push(request);
      const offset = request.offset ?? 0;
      const rows = Array.from({ length: 10_000 }, (_value, index) => [offset + index + 1]);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ sessionId: 'session-virtual', columns: [{ name: 'ID', type: 'INTEGER' }], rows, offset, limit: 10_000, totalRows: 20_000, hasMore: offset < 10_000 }),
        blob: async () => new Blob(),
      } as unknown as Response;
    });
    const api = createApiClient({ fetch });
    const result: ResultState = {
      ...emptyResult,
      resultSetId: 'server-virtual-result',
      sessionId: 'session-virtual',
      columns: ['ID'],
      columnTypes: ['INTEGER'],
      rows: [],
      totalRows: 20_000,
      status: 'complete',
    };

    const { container } = render(
      <ApiClientProvider client={api}>
        <WorkspaceStorageProvider storage={createWorkspaceStorage('result-grid-virtual-test')}>
          <ResultGrid queryId="server-virtual-query" result={result} />
        </WorkspaceStorageProvider>
      </ApiClientProvider>,
    );

    await waitFor(() => expect(pageRequests).toHaveLength(1));
    expect(pageRequests[0]).toEqual(expect.objectContaining({ offset: 0, limit: 10_000 }));
    expect(screen.queryByRole('button', { name: /previous|next|page size/i })).not.toBeInTheDocument();

    const scroller = container.querySelector<HTMLDivElement>('.ui-data-grid-scroll');
    expect(scroller).not.toBeNull();
    if (!scroller) return;
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 120 });
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 300_120 });
    scroller.scrollTop = 300_000;
    fireEvent.scroll(scroller);

    await waitFor(() => expect(pageRequests).toHaveLength(2));
    expect(pageRequests[1]).toEqual(expect.objectContaining({ offset: 10_000, limit: 10_000 }));
    expect(await screen.findByText('10 001')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('All rows loaded');
  });

  it('opens a compact Excel-like filter surface with visible-value actions', async () => {
    const user = userEvent.setup();
    const fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = url.includes('/distinct')
        ? { values: ['EU', 'US', null], truncated: false }
        : url.includes('/page')
          ? { sessionId: 'session-filter', columns: [{ name: 'CATEGORY', type: 'VARCHAR' }], rows: [['EU'], ['US'], [null]], offset: 0, limit: 10_000, totalRows: 3, hasMore: false }
          : {};
      return { ok: true, status: 200, headers: new Headers(), json: async () => json, blob: async () => new Blob() } as unknown as Response;
    });
    const api = createApiClient({ fetch });
    const result: ResultState = {
      ...emptyResult,
      resultSetId: 'server-filter-result',
      sessionId: 'session-filter',
      columns: ['CATEGORY'],
      columnTypes: ['VARCHAR'],
      rows: [['EU'], ['US'], [null]],
      totalRows: 3,
      status: 'complete',
    };

    render(
      <ApiClientProvider client={api}>
        <WorkspaceStorageProvider storage={createWorkspaceStorage('result-grid-filter-test')}>
          <ResultGrid queryId="server-filter-query" result={result} />
        </WorkspaceStorageProvider>
      </ApiClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'Open filter for CATEGORY' }));
    const filter = await screen.findByRole('dialog', { name: 'Filter CATEGORY' });
    expect(filter).toHaveClass('grid-column-filter-menu');
    expect(screen.getByRole('button', { name: 'Select all' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deselect all' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invert' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Values for CATEGORY' })).toHaveTextContent('(Blanks)');
  });
});
