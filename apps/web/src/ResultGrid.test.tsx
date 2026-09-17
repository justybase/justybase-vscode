/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  it('opens a browser-safe pivot configuration and builds a local pivot', async () => {
    const user = userEvent.setup();
    const prompt = jest.spyOn(window, 'prompt').mockImplementation(() => { throw new Error('prompt unsupported'); });
    const api = createApiClient({ fetch: jest.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({}), blob: async () => new Blob() } as unknown as Response)) });
    const result: ResultState = {
      ...emptyResult,
      resultSetId: 'legacy-pivot-result',
      columns: ['CATEGORY', 'MONTH', 'AMOUNT'],
      columnTypes: ['VARCHAR', 'VARCHAR', 'NUMERIC'],
      columnScales: [undefined, undefined, 2],
      rows: [['EU', 'Jan', '10.25'], ['EU', 'Feb', '5.00'], ['US', 'Jan', '7.50']],
      totalRows: 3,
      status: 'complete',
    };

    render(
      <ApiClientProvider client={api}>
        <WorkspaceStorageProvider storage={createWorkspaceStorage('result-grid-pivot-test')}>
          <ResultGrid queryId="legacy-pivot-query" result={result} />
        </WorkspaceStorageProvider>
      </ApiClientProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Pivot' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pivot results' });
    expect(within(dialog).getByRole('combobox', { name: 'Row column' })).toHaveValue('0');
    expect(within(dialog).getByRole('combobox', { name: 'Pivot column' })).toHaveValue('1');
    expect(within(dialog).getByRole('combobox', { name: 'Value column' })).toHaveValue('2');
    await user.click(within(dialog).getByRole('button', { name: 'Create pivot' }));

    const pivotTable = await screen.findByText('Pivot view');
    expect(pivotTable).toBeInTheDocument();
    const tables = screen.getAllByRole('table');
    expect(tables[1]).toHaveTextContent('Jan');
    expect(tables[1]).toHaveTextContent('10.25');
    expect(tables[1]).toHaveTextContent('7.50');
    expect(prompt).not.toHaveBeenCalled();
    prompt.mockRestore();
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

    await user.click(await screen.findByRole('button', { name: /^Group$/ }));
    expect(await screen.findByText('CATEGORY: EU')).toBeInTheDocument();
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(document.querySelectorAll('.ui-data-grid-group-row')).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/api/query/server-group-query/group'), expect.anything());
    expect(screen.getAllByRole('group', { name: 'Grouping panel' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Close group panel' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Grouping panel' })).toHaveTextContent('CATEGORY');
    expect(screen.queryByRole('textbox', { name: 'Filter CATEGORY' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Filter AMOUNT' })).not.toBeInTheDocument();
    expect(screen.getByRole('table').closest('.ui-data-grid-compact')).toBeInTheDocument();
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
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 260_120 });
    scroller.scrollTop = 260_000;
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

  it('preserves a legacy simple filter when the compact menu is opened and applied', async () => {
    const user = userEvent.setup();
    const storage = createWorkspaceStorage('result-grid-legacy-filter-test');
    storage.set('grid_v2_legacy-filter-result', JSON.stringify({
      version: 2,
      resultSetId: 'legacy-filter-result',
      state: { columnFilters: [{ id: '0', value: 'EU' }] },
    }));
    const api = createApiClient({ fetch: jest.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({}), blob: async () => new Blob() } as unknown as Response)) });
    const result: ResultState = {
      ...emptyResult,
      resultSetId: 'legacy-filter-result',
      columns: ['CATEGORY'],
      columnTypes: ['VARCHAR'],
      rows: [['EU'], ['US']],
      totalRows: 2,
      status: 'complete',
    };

    render(
      <ApiClientProvider client={api}>
        <WorkspaceStorageProvider storage={storage}>
          <ResultGrid queryId="legacy-filter-query" result={result} />
        </WorkspaceStorageProvider>
      </ApiClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'Open filter for CATEGORY' }));
    const filter = await screen.findByRole('dialog', { name: 'Filter CATEGORY' });
    expect(within(filter).getByRole('combobox', { name: 'Filter condition for CATEGORY' })).toHaveValue('contains');
    expect(within(filter).getByRole('textbox', { name: 'Filter value for CATEGORY' })).toHaveValue('EU');
    await user.click(within(filter).getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('cell', { name: 'EU' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'US' })).not.toBeInTheDocument();
  });

  it('copies the full server spool instead of only the loaded page', async () => {
    const user = userEvent.setup();
    const pageRequests: Array<{ offset?: number; limit?: number }> = [];
    const fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('/page')) return { ok: true, status: 200, headers: new Headers(), json: async () => ({}), blob: async () => new Blob() } as unknown as Response;
      const request = JSON.parse(String(init?.body ?? '{}')) as { offset?: number; limit?: number };
      pageRequests.push(request);
      const offset = request.offset ?? 0;
      const all = [['a1'], ['a2'], ['a3'], ['a4'], ['a5']];
      const rows = all.slice(offset, offset + (request.limit ?? 10_000));
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ sessionId: 'session-copy-all', columns: [{ name: 'NAME', type: 'VARCHAR' }], rows, offset, limit: request.limit ?? 10_000, totalRows: all.length, hasMore: offset + rows.length < all.length }),
        blob: async () => new Blob(),
      } as unknown as Response;
    });
    const writeText = jest.fn();
    writeText.mockImplementation(async (text: string) => {
      void text;
    });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const api = createApiClient({ fetch });
    const result: ResultState = {
      ...emptyResult,
      resultSetId: 'copy-all-result',
      sessionId: 'session-copy-all',
      columns: ['NAME'],
      columnTypes: ['VARCHAR'],
      rows: [],
      totalRows: 5,
      status: 'complete',
    };

    render(
      <ApiClientProvider client={api}>
        <WorkspaceStorageProvider storage={createWorkspaceStorage('result-grid-copy-all-test')}>
          <ResultGrid queryId='copy-all-query' result={result} />
        </WorkspaceStorageProvider>
      </ApiClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'Copy full result (all rows)' }));
    expect(await screen.findByText(/Copied 5 rows \(full result\)/)).toBeInTheDocument();
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const lastCall = writeText.mock.calls.at(-1);
    const copied = String(lastCall?.[0] ?? '');
    for (const value of ['a1', 'a2', 'a3', 'a4', 'a5']) expect(copied).toContain(value);
    const copyOffsets = pageRequests.map(request => request.offset ?? 0);
    expect(copyOffsets).toContain(0);
    expect(pageRequests.length).toBeGreaterThanOrEqual(2);
  });

  it('persists both scroll axes with a stable anchor across hydration', async () => {
    const storage = createWorkspaceStorage('result-grid-scroll-test');
    storage.set('grid_v2_scroll-result', JSON.stringify({
      version: 2,
      resultSetId: 'scroll-result',
      state: { scrollTop: 9000, scrollLeft: 320, scrollAnchorRow: 300, scrollRowHeight: 30 },
    }));
    const api = createApiClient({ fetch: jest.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({}), blob: async () => new Blob() } as unknown as Response)) });
    const result: ResultState = {
      ...emptyResult,
      resultSetId: 'scroll-result',
      columns: ['ID'],
      columnTypes: ['INTEGER'],
      rows: [[1], [2]],
      totalRows: 2,
      status: 'complete',
    };

    render(
      <ApiClientProvider client={api}>
        <WorkspaceStorageProvider storage={storage}>
          <ResultGrid queryId='scroll-query' result={result} />
        </WorkspaceStorageProvider>
      </ApiClientProvider>,
    );

    await waitFor(() => {
      const persisted = storage.get('grid_v2_scroll-result');
      expect(persisted).toContain('9000');
      expect(persisted).toContain('320');
      expect(persisted).toContain('300');
    });
  });

  it('announces full-spool copy progress and keeps focus on the invoking control', async () => {
    const user = userEvent.setup();
    let releasePage!: (page: { rows: unknown[][]; offset: number; totalRows: number; hasMore: boolean }) => void;
    const gate = new Promise<{ rows: unknown[][]; offset: number; totalRows: number; hasMore: boolean }>(resolve => { releasePage = resolve; });
    const fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('/page')) return { ok: true, status: 200, headers: new Headers(), json: async () => ({}), blob: async () => new Blob() } as unknown as Response;
      const request = JSON.parse(String(init?.body ?? '{}')) as { offset?: number };
      if ((request.offset ?? 0) > 0) {
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ sessionId: 'session-a11y', columns: [{ name: 'NAME' }], rows: [], offset: 1, limit: 10_000, totalRows: 1, hasMore: false }), blob: async () => new Blob() } as unknown as Response;
      }
      const page = await gate;
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ sessionId: 'session-a11y', columns: [{ name: 'NAME' }], rows: page.rows, offset: 0, limit: 10_000, totalRows: page.totalRows, hasMore: page.hasMore }), blob: async () => new Blob() } as unknown as Response;
    });
    const writeText = jest.fn();
    writeText.mockImplementation(async (text: string) => { void text; });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const api = createApiClient({ fetch });
    const result: ResultState = {
      ...emptyResult,
      resultSetId: 'copy-a11y-result',
      sessionId: 'session-a11y',
      columns: ['NAME'],
      columnTypes: ['VARCHAR'],
      rows: [],
      totalRows: 1,
      status: 'complete',
    };

    render(
      <ApiClientProvider client={api}>
        <WorkspaceStorageProvider storage={createWorkspaceStorage('result-grid-copy-a11y-test')}>
          <ResultGrid queryId='copy-a11y-query' result={result} />
        </WorkspaceStorageProvider>
      </ApiClientProvider>,
    );

    const copyAll = await screen.findByRole('button', { name: 'Copy full result (all rows)' });
    await user.click(copyAll);
    expect(await screen.findByRole('button', { name: 'Cancel full result copy' })).toBeInTheDocument();
    releasePage({ rows: [['a1']], offset: 0, totalRows: 1, hasMore: false });
    expect(await screen.findByText(/Copied 1 rows \(full result\)/)).toBeInTheDocument();
    expect(copyAll).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Cancel full result copy' })).not.toBeInTheDocument();
  });

  it('shows a row-limit banner when the server stopped at its limit', async () => {
    const api = createApiClient({ fetch: jest.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({}), blob: async () => new Blob() } as unknown as Response)) });
    const result: ResultState = {
      ...emptyResult,
      resultSetId: 'limit-banner-result',
      columns: ['ID'],
      columnTypes: ['INTEGER'],
      rows: [[1]],
      totalRows: 200_000,
      limitReached: true,
      status: 'complete',
    };

    render(
      <ApiClientProvider client={api}>
        <WorkspaceStorageProvider storage={createWorkspaceStorage('result-grid-limit-test')}>
          <ResultGrid queryId='limit-query' result={result} />
        </WorkspaceStorageProvider>
      </ApiClientProvider>,
    );

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/Row limit reached/);
    expect(banner).toHaveTextContent(/200,000/);
  });

  it('warns when a server pivot is truncated to the group cap', async () => {
    const user = userEvent.setup();
    const fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      const json = url.includes('/group')
        ? { columns: [{ name: 'CATEGORY' }, { name: 'MONTH' }, { name: 'SUM(AMOUNT)' }], rows: [['EU', 'Jan', '10.25']], totalGroups: 10_000 }
        : url.includes('/page')
          ? { sessionId: 'session-pivot', columns: [{ name: 'CATEGORY' }, { name: 'MONTH' }, { name: 'AMOUNT' }], rows: [], offset: 0, limit: 10_000, totalRows: 0, hasMore: false }
          : {};
      return { ok: true, status: 200, headers: new Headers(), json: async () => json, blob: async () => new Blob() } as unknown as Response;
    });
    const api = createApiClient({ fetch });
    const result: ResultState = {
      ...emptyResult,
      resultSetId: 'pivot-truncated-result',
      sessionId: 'session-pivot',
      columns: ['CATEGORY', 'MONTH', 'AMOUNT'],
      columnTypes: ['VARCHAR', 'VARCHAR', 'NUMERIC'],
      columnScales: [undefined, undefined, 2],
      rows: [],
      totalRows: 0,
      status: 'complete',
    };

    render(
      <ApiClientProvider client={api}>
        <WorkspaceStorageProvider storage={createWorkspaceStorage('result-grid-pivot-truncated-test')}>
          <ResultGrid queryId='pivot-truncated-query' result={result} />
        </WorkspaceStorageProvider>
      </ApiClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'Pivot' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pivot results' });
    await user.click(within(dialog).getByRole('button', { name: 'Create pivot' }));
    expect(await screen.findByText(/Pivot truncated to the first 1 of 10,000 groups/)).toBeInTheDocument();
    const groupCall = fetch.mock.calls.find(([input]) => String(input).includes('/group'));
    expect(groupCall).toBeDefined();
    expect(JSON.parse(String((groupCall?.[1] as RequestInit | undefined)?.body))).toEqual(expect.objectContaining({ groupLimit: 10_000 }));
  });

  it('exports the context-menu selection as a CSV download', async () => {
    const user = userEvent.setup();
    const api = createApiClient({ fetch: jest.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({}), blob: async () => new Blob() } as unknown as Response)) });
    const createObjectURL = jest.fn(() => 'blob:selection');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
    const anchorClick = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const result: ResultState = {
      ...emptyResult,
      resultSetId: 'export-selection-result',
      columns: ['NAME'],
      columnTypes: ['VARCHAR'],
      rows: [['alpha'], ['beta']],
      totalRows: 2,
      status: 'complete',
    };

    render(
      <ApiClientProvider client={api}>
        <WorkspaceStorageProvider storage={createWorkspaceStorage('result-grid-export-selection-test')}>
          <ResultGrid queryId='export-selection-query' result={result} />
        </WorkspaceStorageProvider>
      </ApiClientProvider>,
    );

    fireEvent.contextMenu(await screen.findByRole('cell', { name: 'alpha' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Export selection as CSV' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(await screen.findByText(/Exported .* selected rows/)).toBeInTheDocument();
    anchorClick.mockRestore();
  });

  it('does not turn an untouched truncated value list into a first-page filter', async () => {
    const user = userEvent.setup();
    const pageRequests: string[] = [];
    const fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/page')) pageRequests.push(url);
      const json = url.includes('/distinct')
        ? { values: ['EU'], truncated: true }
        : url.includes('/page')
          ? { sessionId: 'session-truncated-filter', columns: [{ name: 'CATEGORY', type: 'VARCHAR' }], rows: [['EU'], ['US']], offset: 0, limit: 10_000, totalRows: 2, hasMore: false }
          : {};
      return { ok: true, status: 200, headers: new Headers(), json: async () => json, blob: async () => new Blob() } as unknown as Response;
    });
    const api = createApiClient({ fetch });
    const result: ResultState = {
      ...emptyResult,
      resultSetId: 'truncated-filter-result',
      sessionId: 'session-truncated-filter',
      columns: ['CATEGORY'],
      columnTypes: ['VARCHAR'],
      rows: [['EU'], ['US']],
      totalRows: 2,
      status: 'complete',
    };

    render(
      <ApiClientProvider client={api}>
        <WorkspaceStorageProvider storage={createWorkspaceStorage('result-grid-truncated-filter-test')}>
          <ResultGrid queryId="truncated-filter-query" result={result} />
        </WorkspaceStorageProvider>
      </ApiClientProvider>,
    );

    await waitFor(() => expect(pageRequests).toHaveLength(1));
    await user.click(await screen.findByRole('button', { name: 'Open filter for CATEGORY' }));
    const filter = await screen.findByRole('dialog', { name: 'Filter CATEGORY' });
    expect(within(filter).getByText(/first 500 values/)).toBeInTheDocument();
    await user.click(within(filter).getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('cell', { name: 'EU' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'US' })).toBeInTheDocument();
    expect(pageRequests).toHaveLength(1);
  });
});
