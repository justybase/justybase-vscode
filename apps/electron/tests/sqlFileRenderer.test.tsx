/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/renderer/App';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body, blob: async () => new Blob([JSON.stringify(body)]) } as Response;
}

function installShell(bridge: Record<string, jest.Mock>): void {
  Object.defineProperty(window, 'justybaseElectron', {
    configurable: true,
    value: {
      getAuthState: jest.fn(async () => ({ status: 'authenticated' })),
      requestCredential: jest.fn(async () => 'opaque-request-id'),
      listConnections: jest.fn(async () => []),
      listCapabilities: jest.fn(async () => ({
        descriptors: [{ key: 'workspace', status: 'available', owner: 'test', documentation: '/docs', removalCondition: 'keep' }],
      })),
      ...bridge,
    },
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: jest.fn(async () => jsonResponse({})),
  });
}

describe('Electron SQL file workspace', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens a .sql file into a tracked document with its path visible', async () => {
    const openSqlFile = jest.fn(async () => ({
      filePath: '/tmp/report.sql',
      fileName: 'report.sql',
      content: 'SELECT 42;',
      sizeBytes: 10,
      oversize: false,
    }));
    installShell({ openSqlFile });
    const view = render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'JustyBase' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Open SQL file' }));
    await waitFor(() => expect(openSqlFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Opened report.sql.')).toBeInTheDocument());
    expect(screen.getByLabelText('SQL editor')).toHaveValue('SELECT 42;');
    expect(screen.getByTitle('/tmp/report.sql')).toHaveTextContent('/tmp/report.sql');
    view.unmount();
  });

  it('asks before opening an oversized file and keeps the current document on cancel', async () => {
    const openSqlFile = jest.fn(async () => ({
      filePath: '/tmp/big.sql',
      fileName: 'big.sql',
      content: 'SELECT 1;',
      sizeBytes: 3 * 1024 * 1024,
      oversize: true,
    }));
    installShell({ openSqlFile });
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    const view = render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'JustyBase' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Open SQL file' }));
    await waitFor(() => expect(openSqlFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(screen.getByLabelText('SQL editor')).toHaveValue('SELECT 1;');
    expect(screen.queryByText('Opened big.sql.')).not.toBeInTheDocument();
    view.unmount();
  });

  it('saves an untracked document through Save As and then overwrites with Save', async () => {
    const saveSqlFileAs = jest.fn(async () => ({ filePath: '/tmp/query.sql', fileName: 'query.sql', sizeBytes: 9 }));
    const saveSqlFile = jest.fn(async (filePath: string) => ({ filePath, fileName: 'query.sql', sizeBytes: 9 }));
    installShell({ saveSqlFile, saveSqlFileAs });
    const view = render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'JustyBase' })).toBeTruthy());

    fireEvent.change(screen.getByLabelText('SQL editor'), { target: { value: 'SELECT 2;' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save SQL file' }));
    await waitFor(() => expect(saveSqlFileAs).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Saved query.sql.')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('SQL editor'), { target: { value: 'SELECT 3;' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save SQL file' }));
    await waitFor(() => expect(saveSqlFile).toHaveBeenCalledWith('/tmp/query.sql', 'SELECT 3;'));
    await waitFor(() => expect(screen.getByText('Saved query.sql.')).toBeInTheDocument());
    view.unmount();
  });

  it('surfaces save failures without losing the document', async () => {
    const saveSqlFileAs = jest.fn(async () => {
      throw new Error('Disk is read-only.');
    });
    installShell({ saveSqlFileAs });
    const view = render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'JustyBase' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Save SQL file as' }));
    await waitFor(() => expect(screen.getByText('Disk is read-only.')).toBeInTheDocument());
    expect(screen.getByLabelText('SQL editor')).toBeInTheDocument();
    view.unmount();
  });
});
