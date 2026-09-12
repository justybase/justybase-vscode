/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react';
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
});
