/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { QueryFileImportPreviewRequest, QueryFileImportRequest, SchemaTreeNode } from '@justybase/contracts';
import { ApiClientProvider, type ApiClient } from './api';
import { ImportPanel } from './ImportPanel';

const target: SchemaTreeNode = {
  id: 'table:orders',
  kind: 'object',
  label: 'ORDERS',
  database: 'DB1',
  schema: 'PUBLIC',
  objectName: 'ORDERS',
  objectType: 'TABLE',
  hasChildren: true,
};

function apiFixture(): jest.Mocked<Pick<ApiClient, 'importFilePreview' | 'importFile'>> {
  return {
    importFilePreview: jest.fn(async (_input: QueryFileImportPreviewRequest) => ({
      sql: 'INSERT INTO PUBLIC.ORDERS …',
      previewToken: 'preview-1',
      expiresAt: Date.now() + 60_000,
      warnings: ['Verify the target table.'],
      rowCount: 2,
    })),
    importFile: jest.fn(async (_input: QueryFileImportRequest) => ({
      sql: 'INSERT INTO PUBLIC.ORDERS …',
      rowsAffected: 2,
      message: 'Imported 2 rows.',
    })),
  };
}

describe('Web guarded file import panel', () => {
  afterEach(() => jest.restoreAllMocks());

  it('shows the real preview row count and applies only after confirmation', async () => {
    const api = apiFixture();
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const onCompleted = jest.fn();
    render(<ApiClientProvider client={api as unknown as ApiClient}><ImportPanel connectionId="connection-1" target={target} database="DB1" onClose={() => undefined} onCompleted={onCompleted} /></ApiClientProvider>);

    expect(screen.getByRole('dialog', { name: 'Import data' })).toBeInTheDocument();
    const file = new File(['ID,NAME\n1,Alpha\n2,Beta\n'], 'orders.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('File'), { target: { files: [file] } });
    expect(screen.getByText(/orders\.csv ·/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preview and import' }));

    await waitFor(() => expect(api.importFilePreview).toHaveBeenCalledWith(expect.objectContaining({
      fileName: 'orders.csv',
      format: 'csv',
      hasHeader: true,
      delimiter: ',',
    })));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Confirm import of 2 row(s) into PUBLIC.ORDERS?'));
    await waitFor(() => expect(api.importFile).toHaveBeenCalledWith(expect.objectContaining({ writeConfirmed: true, writePreviewToken: 'preview-1' })));
    expect(screen.getByRole('status')).toHaveTextContent('Imported 2 rows.');
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it('keeps unsupported extensions from reaching the import API', () => {
    const api = apiFixture();
    render(<ApiClientProvider client={api as unknown as ApiClient}><ImportPanel connectionId="connection-1" target={target} database="DB1" onClose={() => undefined} onCompleted={() => undefined} /></ApiClientProvider>);
    const file = new File(['not supported'], 'orders.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('File'), { target: { files: [file] } });
    expect(screen.getByRole('button', { name: 'Preview and import' })).toBeDisabled();
    expect(api.importFilePreview).not.toHaveBeenCalled();
  });
});
