import { jest } from '@jest/globals';
import type * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectedDatabaseFactory';
import { runQueryRaw } from '../core/queryRunner';
import { detectNetezzaSchemasEnabled } from '../dialects/netezza/metadata/schemasOn';
import type { MetadataCache } from '../metadataCache';
import {
  NETEZZA_DEFAULT_SCHEMA_TIMEOUT_SECONDS,
  resetNetezzaDefaultSchemaLookupsForTests,
  resolveNetezzaDefaultSchema,
  resolveNetezzaSchemasEnabled,
} from '../dialects/netezza/metadata/netezzaSchemaContext';

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

jest.mock('../core/connectedDatabaseFactory', () => ({
  createConnectedDatabaseConnectionFromDetails: jest.fn(),
}));

jest.mock('../dialects/netezza/metadata/schemasOn', () => ({
  detectNetezzaSchemasEnabled: jest.fn(),
}));

const runQueryRawMock = runQueryRaw as jest.MockedFunction<typeof runQueryRaw>;
const createConnectionMock =
  createConnectedDatabaseConnectionFromDetails as jest.MockedFunction<
    typeof createConnectedDatabaseConnectionFromDetails
  >;
const detectSchemasEnabledMock =
  detectNetezzaSchemasEnabled as jest.MockedFunction<typeof detectNetezzaSchemasEnabled>;

const CONNECTION = 'NZ_CONN';
const DATABASE = 'BAZA';
const CONTEXT = {} as vscode.ExtensionContext;

function createCache(overrides: {
  getDefaultSchema?: jest.Mock;
} = {}): MetadataCache {
  return {
    getDefaultSchema: overrides.getDefaultSchema ?? jest.fn(() => undefined),
    setDefaultSchema: jest.fn(),
    getDatabases: jest.fn(() => [
      { DATABASE, DEFSCHEMA: 'PUBLIC', label: DATABASE, kind: 9 },
    ]),
  } as unknown as MetadataCache;
}

describe('resolveNetezzaDefaultSchema', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetNetezzaDefaultSchemaLookupsForTests();
  });

  it('returns the cached default schema without querying the catalog', async () => {
    const cache = createCache({
      getDefaultSchema: jest.fn(() => 'ADMIN'),
    });

    await expect(resolveNetezzaDefaultSchema(
      CONNECTION,
      DATABASE,
      {} as ConnectionManager,
      cache,
      CONTEXT,
    )).resolves.toBe('ADMIN');

    expect(runQueryRawMock).not.toHaveBeenCalled();
  });

  it('never blocks completion on a live query and backfills in the background', async () => {
    const cache = createCache();
    runQueryRawMock.mockResolvedValue({
      columns: [{ name: 'DEFSCHEMA' }],
      data: [['PUBLIC']],
    } as never);

    await expect(resolveNetezzaDefaultSchema(
      CONNECTION,
      DATABASE,
      {} as ConnectionManager,
      cache,
      CONTEXT,
    )).resolves.toBeUndefined();

    // The background lookup must run with the short metadata timeout, not the
    // generic query timeout (which can be an hour).
    await new Promise(process.nextTick);

    expect(runQueryRawMock).toHaveBeenCalledTimes(1);
    expect(runQueryRawMock).toHaveBeenCalledWith(expect.objectContaining({
      connectionName: CONNECTION,
      isUserQuery: false,
      maxRows: 1,
      timeoutSeconds: NETEZZA_DEFAULT_SCHEMA_TIMEOUT_SECONDS,
    }));
    expect(cache.setDefaultSchema).toHaveBeenCalledWith(CONNECTION, DATABASE, 'PUBLIC');
    // Also keyed by the exact catalog spelling so a quoted/lower-case request
    // and the catalog name share the same value.
    expect(cache.setDefaultSchema).toHaveBeenCalledTimes(2);
  });

  it('does not cache a fabricated ADMIN fallback when the lookup fails', async () => {
    const cache = createCache();
    runQueryRawMock.mockRejectedValue(new Error('connection busy') as never);

    await expect(resolveNetezzaDefaultSchema(
      CONNECTION,
      DATABASE,
      {} as ConnectionManager,
      cache,
      CONTEXT,
    )).resolves.toBeUndefined();

    await new Promise(process.nextTick);

    expect(cache.setDefaultSchema).not.toHaveBeenCalled();
  });

  it('backs off a failed lookup instead of retrying on every completion request', async () => {
    const cache = createCache();
    runQueryRawMock.mockRejectedValue(new Error('connection busy') as never);

    await resolveNetezzaDefaultSchema(
      CONNECTION,
      DATABASE,
      {} as ConnectionManager,
      cache,
      CONTEXT,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runQueryRawMock).toHaveBeenCalledTimes(1);

    await resolveNetezzaDefaultSchema(
      CONNECTION,
      DATABASE,
      {} as ConnectionManager,
      cache,
      CONTEXT,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(runQueryRawMock).toHaveBeenCalledTimes(1);
    expect(cache.setDefaultSchema).not.toHaveBeenCalled();
  });

  it('coalesces concurrent background lookups for the same database', async () => {
    const cache = createCache();
    runQueryRawMock.mockResolvedValue({
      columns: [{ name: 'DEFSCHEMA' }],
      data: [['PUBLIC']],
    } as never);

    await Promise.all([
      resolveNetezzaDefaultSchema(CONNECTION, DATABASE, {} as ConnectionManager, cache, CONTEXT),
      resolveNetezzaDefaultSchema(CONNECTION, DATABASE, {} as ConnectionManager, cache, CONTEXT),
    ]);
    await new Promise(process.nextTick);

    expect(runQueryRawMock).toHaveBeenCalledTimes(1);
  });
});

describe('resolveNetezzaSchemasEnabled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetNetezzaDefaultSchemaLookupsForTests();
  });

  it('returns the cached schema-mode flag without opening a connection', async () => {
    const cache = {
      getNetezzaSchemasEnabled: jest.fn(() => true),
      setNetezzaSchemasEnabled: jest.fn(),
    } as unknown as MetadataCache;

    await expect(resolveNetezzaSchemasEnabled(
      CONNECTION,
      {} as ConnectionManager,
      cache,
      CONTEXT,
    )).resolves.toBe(true);

    expect(createConnectionMock).not.toHaveBeenCalled();
  });

  it('returns undefined immediately and probes in the background on a miss', async () => {
    const cache = {
      getNetezzaSchemasEnabled: jest.fn(() => undefined),
      setNetezzaSchemasEnabled: jest.fn(),
    } as unknown as MetadataCache;
    const connectionManager = {
      getConnection: jest.fn(async () => ({ host: 'nz' })),
    } as unknown as ConnectionManager;
    const close = jest.fn(async () => undefined);
    createConnectionMock.mockResolvedValue({ close } as never);
    detectSchemasEnabledMock.mockResolvedValue(true);

    await expect(resolveNetezzaSchemasEnabled(
      CONNECTION,
      connectionManager,
      cache,
      CONTEXT,
    )).resolves.toBeUndefined();

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(detectSchemasEnabledMock).toHaveBeenCalledTimes(1);
    expect(cache.setNetezzaSchemasEnabled).toHaveBeenCalledWith(CONNECTION, true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent schema-mode probes for the same connection', async () => {
    const cache = {
      getNetezzaSchemasEnabled: jest.fn(() => undefined),
      setNetezzaSchemasEnabled: jest.fn(),
    } as unknown as MetadataCache;
    const connectionManager = {
      getConnection: jest.fn(async () => ({ host: 'nz' })),
    } as unknown as ConnectionManager;
    createConnectionMock.mockResolvedValue({ close: jest.fn(async () => undefined) } as never);
    detectSchemasEnabledMock.mockResolvedValue(true);

    await Promise.all([
      resolveNetezzaSchemasEnabled(CONNECTION, connectionManager, cache, CONTEXT),
      resolveNetezzaSchemasEnabled(CONNECTION, connectionManager, cache, CONTEXT),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(createConnectionMock).toHaveBeenCalledTimes(1);
  });
});
