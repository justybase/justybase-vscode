import { describe, expect, it, jest } from '@jest/globals';
import * as vscode from 'vscode';
jest.mock('../dialects/netezza/metadata/netezzaSchemaContext', () => ({
  resolveNetezzaSchemasEnabled: jest.fn(async () => false),
  resolveNetezzaDefaultSchema: jest.fn(async () => 'ADMIN'),
}));

import { handleMetadataRequest } from '../activation/lspRegistration';
import { MetadataCache } from '../metadataCache';
import { MetadataBridge } from '../server/metadataBridge';
import { DocumentValidationSession } from '../sqlParser/documentValidationSession';
import type { ConnectionManager } from '../core/connectionManager';
import type { MetadataProvider } from '../providers/providers/metadataProvider';
import type { MetadataRequestParams } from '../lsp/protocol';
import { Logger } from '../utils/logger';

jest.mock('vscode');

describe('metadata host ↔ LSP coherence', () => {
  const mockOutputChannel = {
    appendLine: jest.fn(),
    show: jest.fn(),
    dispose: jest.fn(),
  } as unknown as vscode.OutputChannel;

  beforeEach(() => {
    Logger.initialize(mockOutputChannel);
    jest.spyOn(
      require('../compatibility/configuration'),
      'getExtensionConfiguration',
    ).mockReturnValue({
      get: (_key: string, defaultValue?: unknown) => defaultValue,
    });
  });

  function createCache(): MetadataCache {
    return new MetadataCache(
      { globalStorageUri: undefined } as unknown as vscode.ExtensionContext,
      {
        getConnectionDatabaseKind: () => 'netezza',
      } as unknown as ConnectionManager,
    );
  }

  function createConnectionManager(): ConnectionManager {
    return {
      ensureFullyLoaded: jest.fn(async () => undefined),
      getConnectionForExecution: jest.fn(() => 'NZ'),
      getEffectiveDatabase: jest.fn(async () => 'DB1'),
      getExecutionDatabaseKind: jest.fn(() => 'netezza'),
      getEffectiveSchema: jest.fn(async () => 'ADMIN'),
    } as unknown as ConnectionManager;
  }

  it('invalidateSchema + bridge clearAll yields refreshed column types from host cache', async () => {
    const cache = createCache();
    const connectionManager = createConnectionManager();
    const metadataProvider = {} as MetadataProvider;
    const documentUri = 'file:///coherence.sql';

    cache.setColumns('NZ', 'DB1.ADMIN.T1', [
      { ATTNAME: 'C1', FORMAT_TYPE: 'INTEGER', label: 'C1' },
    ]);

    const bridge = new MetadataBridge(async (params: MetadataRequestParams) => {
      return handleMetadataRequest(
        params,
        { subscriptions: [] } as unknown as vscode.ExtensionContext,
        metadataProvider,
        cache,
        connectionManager,
      );
    });

    const first = await bridge.getTableInfo(
      documentUri,
      'DB1',
      'T1',
      'ADMIN',
    );
    expect(first?.columns[0]?.type).toBe('INTEGER');

    cache.invalidateSchema('NZ', 'DB1', 'ADMIN');
    bridge.clearAll();

    cache.setColumns('NZ', 'DB1.ADMIN.T1', [
      { ATTNAME: 'C1', FORMAT_TYPE: 'VARCHAR(32)', label: 'C1' },
    ]);

    const second = await bridge.getTableInfo(
      documentUri,
      'DB1',
      'T1',
      'ADMIN',
    );
    expect(second?.columns[0]?.type).toBe('VARCHAR(32)');
  });

  it('documentValidationSession drops cached diagnostics when metadataEpoch changes', () => {
    const session = new DocumentValidationSession();
    const documentUri = 'file:///epoch.sql';
    const statement = {
      index: 0,
      startOffset: 0,
      endOffset: 10,
      sql: 'SELECT 1',
      contentHash: 'hash-1',
    };

    session.syncMetadataEpoch(documentUri, 1);
    session.storeStatementDiagnostics(
      documentUri,
      statement,
      [
        {
          code: 'SQL001',
          message: 'stale',
          severity: 'error',
          position: {
            startLine: 0,
            startColumn: 0,
            endLine: 0,
            endColumn: 1,
            offset: 0,
          },
        },
      ],
      1,
    );

    expect(
      session.getCachedDiagnostics(documentUri, statement, 1),
    ).toHaveLength(1);

    session.syncMetadataEpoch(documentUri, 2);

    expect(
      session.getCachedDiagnostics(documentUri, statement, 2),
    ).toBeUndefined();
  });
});
