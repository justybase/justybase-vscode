/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { QueryEditPreviewRequest, QueryEditRequest, QueryFileImportPreviewRequest, QueryFileImportRequest, SchemaTreeNode } from '@justybase/contracts';
import type { ElectronWorkspaceApi } from '../src/renderer/api';
import { EditRowPanel, valueFromInput } from '../src/renderer/EditRowPanel';
import { ImportPanel } from '../src/renderer/ImportPanel';

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

function apiFixture(): jest.Mocked<Pick<ElectronWorkspaceApi, 'importFilePreview' | 'importFile' | 'editPreview' | 'edit'>> {
  return {
    importFilePreview: jest.fn(async (_input: QueryFileImportPreviewRequest) => ({ sql: 'INSERT INTO PUBLIC.ORDERS …', previewToken: 'preview-1', expiresAt: Date.now() + 60_000, warnings: [], rowCount: 1 })),
    importFile: jest.fn(async (_input: QueryFileImportRequest) => ({ sql: 'INSERT INTO PUBLIC.ORDERS …', rowsAffected: 1, message: 'Imported 1 row.' })),
    editPreview: jest.fn(async (_input: QueryEditPreviewRequest) => ({ sql: 'UPDATE PUBLIC.ORDERS SET NAME = \'Beta\' WHERE ID = 1', previewToken: 'preview-2', expiresAt: Date.now() + 60_000, warnings: [], rowCount: 1 })),
    edit: jest.fn(async (_input: QueryEditRequest) => ({ sql: 'UPDATE PUBLIC.ORDERS …', rowsAffected: 1, message: 'Updated 1 row.' })),
  };
}

describe('Electron guarded data movement panels', () => {
  afterEach(() => jest.restoreAllMocks());

  it('preserves exact integer/decimal text and explicit NULL values', () => {
    expect(valueFromInput('9223372036854775807', 1, 'BIGINT')).toBe('9223372036854775807');
    expect(valueFromInput('12.3400', 1, 'DECIMAL(12,4)')).toBe('12.3400');
    expect(valueFromInput('NULL', 'value', 'VARCHAR')).toBeNull();
    expect(valueFromInput('true', false, 'BOOLEAN')).toBe(true);
    expect(valueFromInput('{"ok":true}', {}, 'JSON')).toEqual({ ok: true });
  });

  it('reads a CSV in the renderer, previews it, and applies only after confirmation', async () => {
    const api = apiFixture();
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const onCompleted = jest.fn();
    render(<ImportPanel api={api as unknown as ElectronWorkspaceApi} connectionId="connection-1" target={target} database="DB1" onClose={() => undefined} onCompleted={onCompleted} />);
    const file = new File(['ID,NAME\n1,Alpha\n'], 'orders.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('File'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview and import' }));
    await waitFor(() => expect(api.importFilePreview).toHaveBeenCalled());
    expect(api.importFilePreview).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: 'connection-1',
      database: 'DB1',
      schema: 'PUBLIC',
      table: 'ORDERS',
      fileName: 'orders.csv',
      format: 'csv',
      hasHeader: true,
      delimiter: ',',
      contentBase64: expect.any(String),
    }));
    await waitFor(() => expect(api.importFile).toHaveBeenCalledWith(expect.objectContaining({ writeConfirmed: true, writePreviewToken: 'preview-1' })));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Confirm import of 1 row(s) into PUBLIC.ORDERS?'));
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it('does not apply a rejected import preview', async () => {
    const api = apiFixture();
    jest.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ImportPanel api={api as unknown as ElectronWorkspaceApi} connectionId="connection-1" target={target} database="DB1" onClose={() => undefined} onCompleted={() => undefined} />);
    const file = new File(['ID\n1\n'], 'orders.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('File'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview and import' }));
    await waitFor(() => expect(api.importFilePreview).toHaveBeenCalled());
    expect(api.importFile).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Import cancelled.');
  });

  it('previews and applies a guarded row edit with primary-key defaults', async () => {
    const api = apiFixture();
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    const onCompleted = jest.fn();
    render(<EditRowPanel api={api as unknown as ElectronWorkspaceApi} connectionId="connection-1" database="DB1" target={target} columns={[{ name: 'ID', type: 'BIGINT', isPk: true }, { name: 'NAME', type: 'VARCHAR' }]} values={['9223372036854775807', 'Alpha']} onClose={() => undefined} onCompleted={onCompleted} />);
    expect(screen.getByLabelText('Value ID')).toHaveValue('9223372036854775807');
    fireEvent.change(screen.getByLabelText('Value NAME'), { target: { value: 'Beta' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview and update' }));
    await waitFor(() => expect(api.editPreview).toHaveBeenCalledWith({ connectionId: 'connection-1', database: 'DB1', schema: 'PUBLIC', table: 'ORDERS', key: { ID: '9223372036854775807' }, changes: { NAME: 'Beta' } }));
    await waitFor(() => expect(api.edit).toHaveBeenCalledWith(expect.objectContaining({ writeConfirmed: true, writePreviewToken: 'preview-2' })));
    expect(onCompleted).toHaveBeenCalledWith('Updated 1 row.');
  });
});
