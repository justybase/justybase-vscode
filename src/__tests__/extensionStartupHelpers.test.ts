import { jest } from '@jest/globals';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import { runQueryRaw } from '../core/queryRunner';
import type { MetadataCache } from '../metadataCache';
import { getDatabaseList } from '../activation/extensionStartupHelpers';

jest.mock('vscode');

jest.mock('../core/queryRunner', () => ({
  runQueryRaw: jest.fn(),
  queryResultToRows: jest.fn((result: {
    columns?: Array<{ name: string }>;
    data?: unknown[][];
  }) => {
    if (!result?.columns || !result.data) {
      return [];
    }
    return result.data.map((row) => {
      const mapped: Record<string, unknown> = {};
      result.columns!.forEach((column, index) => {
        mapped[column.name] = row[index];
      });
      return mapped;
    });
  }),
}));

const runQueryRawMock = runQueryRaw as jest.MockedFunction<typeof runQueryRaw>;

describe('getDatabaseList', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('persists DEFSCHEMA with the refreshed database layer', async () => {
    runQueryRawMock.mockResolvedValue({
      columns: [{ name: 'DATABASE' }, { name: 'DEFSCHEMA' }],
      data: [['BAZA', 'PUBLIC']],
    } as never);
    const metadataCache = {
      getDatabases: jest.fn(() => undefined),
      setDatabases: jest.fn(),
    } as unknown as MetadataCache;

    await expect(getDatabaseList(
      {} as vscode.ExtensionContext,
      {} as ConnectionManager,
      'NZ_CONN',
      metadataCache,
    )).resolves.toEqual(['BAZA']);

    expect(runQueryRawMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('DEFSCHEMA'),
      true,
      expect.anything(),
      'NZ_CONN',
      undefined,
      undefined,
      undefined,
      1_000_000,
      false,
    );
    expect(metadataCache.setDatabases).toHaveBeenCalledWith('NZ_CONN', [
      expect.objectContaining({ DATABASE: 'BAZA', DEFSCHEMA: 'PUBLIC' }),
    ]);
  });

  it('serves the cached database list without a catalog query', async () => {
    const metadataCache = {
      getDatabases: jest.fn(() => [
        { DATABASE: 'BAZA', DEFSCHEMA: 'PUBLIC', label: 'BAZA', kind: 9 },
      ]),
      setDatabases: jest.fn(),
    } as unknown as MetadataCache;

    await expect(getDatabaseList(
      {} as vscode.ExtensionContext,
      {} as ConnectionManager,
      'NZ_CONN',
      metadataCache,
    )).resolves.toEqual(['BAZA']);

    expect(runQueryRawMock).not.toHaveBeenCalled();
    expect(metadataCache.setDatabases).not.toHaveBeenCalled();
  });
});
