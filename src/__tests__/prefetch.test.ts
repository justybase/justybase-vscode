/**
 * Unit tests for metadata/prefetch.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { CachePrefetcher, QueryRunnerRawFn, MetadataPrefetchProgress } from '../metadata/prefetch';
import type { MetadataPrefetchTarget } from '../metadata/cache/MetadataPrefetchTarget';
import { resetMetadataQueryLimiterForTests } from '../metadata/metadataQueryLimiter';
import { Logger } from '../utils/logger';
// Removed unused import

// Mock dependencies
jest.mock('../utils/logger', () => ({
  Logger: {
    getInstance: jest.fn().mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    })
  }
}));

describe('CachePrefetcher', () => {
  let mockCache: jest.Mocked<MetadataPrefetchTarget>;
  let prefetcher: CachePrefetcher;
  let mockRunQuery: jest.MockedFunction<QueryRunnerRawFn>;

  const connName = 'test-conn';

  beforeEach(() => {
    jest.clearAllMocks();

    // Create a fully mocked MetadataCache instance
    mockCache = {
      tableCache: new Map(),
      schemaCache: new Map(),
      columnCache: new Map(),
      getCacheTTL: jest.fn().mockReturnValue(12 * 60 * 60 * 1000),
      getTables: jest.fn(),
      setTables: jest.fn(),
      getColumns: jest.fn(),
      setColumns: jest.fn(),
      getColumnsAnySchema: jest.fn(),
      ensureColumnsLoaded: jest.fn().mockResolvedValue(undefined),
      getDatabases: jest.fn(),
      setDatabases: jest.fn(),
      getSchemas: jest.fn(),
      setSchemas: jest.fn(),
      getProcedures: jest.fn(),
      setProcedures: jest.fn(),
      getProceduresAllSchemas: jest.fn(),
      tryAcquirePrefetchLock: jest.fn().mockResolvedValue(true),
      releasePrefetchLock: jest.fn().mockResolvedValue(undefined),
      saveConnectionToDiskAfterPrefetch: jest.fn().mockResolvedValue(undefined),
      checkpointSave: jest.fn().mockResolvedValue(undefined),
      verifyStagesComplete: jest.fn().mockReturnValue(true),
      whenDiskReady: jest.fn().mockResolvedValue(undefined),
      hasTableCacheForConnection: jest.fn().mockReturnValue(false),
      isConnectionMetadataHydrating: jest.fn().mockReturnValue(false),
      isProcedureCatalogLoaded: jest.fn().mockReturnValue(false),
      isDatabaseDead: jest.fn().mockReturnValue(false),
      markDatabaseDead: jest.fn(),
      isDiskPersistenceEnabled: jest.fn().mockReturnValue(false),
    } as unknown as jest.Mocked<MetadataPrefetchTarget>;

    prefetcher = new CachePrefetcher(mockCache);
    mockRunQuery = jest.fn();
  });

  describe('State resets and checks', () => {
    it('should correctly reset tracking state', () => {
      // Directly set internal state (triggerConnectionPrefetch is fire-and-forget,
      // connectionPrefetchTriggered is only set in .finally() after async work)
      prefetcher['connectionPrefetchTriggered'].set(connName, Date.now());
      prefetcher['allObjectsPrefetchTriggeredSet'].add(`ALL_OBJECTS|${connName}`);
      expect(prefetcher.hasConnectionPrefetchTriggered(connName)).toBe(true);
      expect(prefetcher.hasAllObjectsPrefetchTriggered(connName)).toBe(true);
      prefetcher.reset();
      expect(prefetcher.hasConnectionPrefetchTriggered(connName)).toBe(false);
      expect(prefetcher.hasAllObjectsPrefetchTriggered(connName)).toBe(false);
    });

    it('should return false for untriggered connection prefetch', () => {
      expect(prefetcher.hasAllObjectsPrefetchTriggered(connName)).toBe(false);
    });
  });

  describe('prefetchColumnsForSchema', () => {
    it('should do nothing if prefetch is already in progress', async () => {
      // First call blocks the second
      mockCache.getTables.mockReturnValue([{ label: 't1' } as any]);
      mockRunQuery.mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 50));
        return undefined;
      });
      const p1 = prefetcher.prefetchColumnsForSchema(connName, 'db1', 's1', mockRunQuery);
      const p2 = prefetcher.prefetchColumnsForSchema(connName, 'db1', 's1', mockRunQuery);
      await Promise.all([p1, p2]);
      // Only one query should run
      expect(mockRunQuery).toHaveBeenCalledTimes(1);
    });

    it('should return early if no tables exist in cache for schema', async () => {
      mockCache.getTables.mockReturnValue([]);
      await prefetcher.prefetchColumnsForSchema(connName, 'db1', 's1', mockRunQuery);
      expect(mockRunQuery).not.toHaveBeenCalled();
    });

    it('should skip if columns already cached', async () => {
      mockCache.getTables.mockReturnValue([{ label: 't1' } as any]);
      mockCache.getColumns.mockReturnValue([{ label: 'col1' } as any]);
      await prefetcher.prefetchColumnsForSchema(connName, 'db1', 's1', mockRunQuery);
      expect(mockRunQuery).not.toHaveBeenCalled();
    });

    it('should fetch and populate columns', async () => {
      mockCache.getTables.mockReturnValue([{ label: 't1' } as any]);
      mockCache.getColumns.mockReturnValue(undefined); // not cached stringably

      mockRunQuery.mockResolvedValue({
        columns: [{ name: 'TABLENAME' }, { name: 'ATTNAME' }, { name: 'FORMAT_TYPE' }, { name: 'IS_PK' }, { name: 'IS_FK' }],
        data: [
          ['t1', 'col1', 'INT4', 1, 0],
          ['t1', 'col2', 'VARCHAR', 0, 1]
        ]
      });

      await prefetcher.prefetchColumnsForSchema(connName, 'db1', 's1', mockRunQuery);

      expect(mockCache.setColumns).toHaveBeenCalledWith(
        connName,
        'DB1.S1.T1',
        expect.arrayContaining([
          expect.objectContaining({ ATTNAME: 'col1', isPk: true, isFk: false }),
          expect.objectContaining({ ATTNAME: 'col2', isPk: false, isFk: true })
        ])
      );
    });

    it('should catch query errors gracefully', async () => {
      mockCache.getTables.mockReturnValue([{ label: 't1' } as any]);
      mockRunQuery.mockRejectedValue(new Error('DB Timeout'));
      await prefetcher.prefetchColumnsForSchema(connName, 'db1', undefined, mockRunQuery);
      expect(Logger.getInstance().error).toHaveBeenCalled();
      expect(prefetcher['columnPrefetchInProgress'].size).toBe(0);
    });

    it('skips when database is dead', async () => {
      mockCache.getTables.mockReturnValue([{ label: 't1' } as any]);
      mockCache.isDatabaseDead.mockReturnValue(true);

      await prefetcher.prefetchColumnsForSchema(connName, 'db1', 's1', mockRunQuery);

      expect(mockRunQuery).not.toHaveBeenCalled();
    });

    it('marks database dead on ResolveCatalog', async () => {
      mockCache.getTables.mockReturnValue([{ label: 't1' } as any]);
      mockCache.getColumns.mockReturnValue(undefined);
      mockRunQuery.mockRejectedValue(new Error('ResolveCatalog: error retrieving database'));

      await prefetcher.prefetchColumnsForSchema(connName, 'db1', 's1', mockRunQuery);

      expect(mockCache.markDatabaseDead).toHaveBeenCalledWith(connName, 'db1');
      expect(Logger.getInstance().warn).toHaveBeenCalled();
    });
  });

  describe('prefetchDatabases (internal)', () => {
    beforeEach(() => {
      // Need to test via triggerConnectionPrefetch which calls prefetchDatabases internally
      // Or access via any prototype
    });

    it('should return cached databases if available', async () => {
      mockCache.getDatabases.mockReturnValue([{ label: 'db1' } as any]);
      const dbs = await (prefetcher as any).prefetchDatabases(connName, mockRunQuery);
      expect(dbs).toEqual(['db1']);
      expect(mockRunQuery).not.toHaveBeenCalled();
    });

    it('should return empty array on query error', async () => {
      mockRunQuery.mockRejectedValue(new Error('err'));
      const dbs = await (prefetcher as any).prefetchDatabases(connName, mockRunQuery);
      expect(dbs).toEqual([]);
      expect(Logger.getInstance().error).toHaveBeenCalled();
    });

    it('should handle empty result', async () => {
      mockRunQuery.mockResolvedValue({ columns: [], data: [] });
      const dbs = await (prefetcher as any).prefetchDatabases(connName, mockRunQuery);
      expect(dbs).toEqual([]);
    });
  });

  describe('prefetchAllObjects', () => {
    it('should return early if already triggered', async () => {
      prefetcher['allObjectsPrefetchTriggeredSet'].add(`ALL_OBJECTS|${connName}`);
      await prefetcher.prefetchAllObjects(connName, mockRunQuery);
      expect(mockRunQuery).not.toHaveBeenCalled();
    });

    it('should abort if no databases are found', async () => {
      mockCache.getDatabases.mockReturnValue([]);
      mockRunQuery.mockResolvedValue({ columns: [], data: [] }); // fallback DB fetch empty
      await prefetcher.prefetchAllObjects(connName, mockRunQuery);
      expect(Logger.getInstance().warn).toHaveBeenCalledWith(expect.stringContaining('aborted'));
    });

    it('should fetch and cache objects into tablesByKey', async () => {
      mockCache.getDatabases.mockReturnValue([{ label: 'db1' } as any]);
      mockRunQuery.mockResolvedValue({
        columns: [{ name: 'OBJNAME' }, { name: 'OBJID' }, { name: 'SCHEMA' }, { name: 'DBNAME' }, { name: 'OBJTYPE' }],
        data: [
          ['t1', 101, 's1', 'db1', 'TABLE'],
          ['v1', 102, 's1', 'db1', 'VIEW'],
          ['t2', 103, null, 'db1', 'TABLE'] // no schema
        ]
      });

      await prefetcher.prefetchAllObjects(connName, mockRunQuery, false);

      expect(mockCache.setTables).toHaveBeenCalledWith(
        connName, 'DB1.S1', expect.arrayContaining([expect.anything(), expect.anything()]), expect.any(Map)
      );
      expect(mockCache.setTables).toHaveBeenCalledTimes(1);
    });

    it('should skip if skipIfCached is true and tables exist', async () => {
      (mockCache.hasTableCacheForConnection as jest.Mock).mockReturnValue(true);
      await prefetcher.prefetchAllObjects(connName, mockRunQuery, true);
      expect(mockRunQuery).not.toHaveBeenCalled();
      expect(mockCache.setTables).not.toHaveBeenCalled();
    });

    it('should skip per-schema setTables when skipIfCached and schema cached', async () => {
      mockCache.getDatabases.mockReturnValue([{ label: 'db1' } as any]);
      mockCache.getTables.mockReturnValue([{ label: 't1' } as any]);
      mockRunQuery.mockResolvedValue({
        columns: [{ name: 'OBJNAME' }, { name: 'OBJID' }, { name: 'SCHEMA' }, { name: 'DBNAME' }, { name: 'OBJTYPE' }],
        data: [['t1', 101, 's1', 'db1', 'TABLE']]
      });
      await prefetcher.prefetchAllObjects(connName, mockRunQuery, true);
      expect(mockCache.setTables).not.toHaveBeenCalled();
    });

    it('should handle errors', async () => {
      mockCache.getDatabases.mockReturnValue([{ label: 'db1' } as any]);
      mockRunQuery.mockRejectedValue(new Error('fail'));
      await prefetcher.prefetchAllObjects(connName, mockRunQuery);
      expect(Logger.getInstance().error).toHaveBeenCalled();
    });

    it('skips dead databases in UNION query', async () => {
      mockCache.isDatabaseDead.mockImplementation(
        (_connection: string, db: string | undefined) => (db ?? '').toUpperCase() === 'GHOST',
      );
      mockRunQuery.mockResolvedValue({
        columns: [{ name: 'OBJNAME' }, { name: 'OBJID' }, { name: 'SCHEMA' }, { name: 'DBNAME' }, { name: 'OBJTYPE' }],
        data: [['t1', 101, 's1', 'db1', 'TABLE']],
      });

      await prefetcher.prefetchAllObjects(connName, mockRunQuery, false, ['db1', 'GHOST'], true);

      expect(mockRunQuery).toHaveBeenCalledTimes(1);
      const query = mockRunQuery.mock.calls[0][0] as string;
      expect(query).toMatch(/DB1/i);
      expect(query).not.toMatch(/GHOST/i);
      expect(mockCache.setTables).toHaveBeenCalled();
    });

    it('aborts when all databases are dead', async () => {
      mockCache.isDatabaseDead.mockReturnValue(true);

      await prefetcher.prefetchAllObjects(connName, mockRunQuery, false, ['db1', 'GHOST'], true);

      expect(mockRunQuery).not.toHaveBeenCalled();
      expect(Logger.getInstance().warn).toHaveBeenCalledWith(
        expect.stringContaining('all databases marked dead'),
      );
    });
  });

  describe('triggerFullColumnPrefetch', () => {
    it('should keep existing cache entries while background fetch runs', () => {
      mockCache.columnCache.set(`${connName}|db1.s1.t1`, { data: [], timestamp: 0 });
      mockCache.columnCache.set(`other|db1.s1.t1`, { data: [], timestamp: 0 });

      prefetcher.triggerFullColumnPrefetch(connName, mockRunQuery);

      expect(mockCache.columnCache.has(`${connName}|db1.s1.t1`)).toBe(true);
      expect(mockCache.columnCache.has(`other|db1.s1.t1`)).toBe(true);
      expect(prefetcher['columnPrefetchInProgress'].has(`FULL_COL_PREFETCH|${connName}`)).toBe(true);
    });

    it('should skip if already running', () => {
      prefetcher['columnPrefetchInProgress'].add(`FULL_COL_PREFETCH|${connName}`);
      mockCache.columnCache.set(`${connName}|db1.s1.t1`, { data: [], timestamp: 0 });
      prefetcher.triggerFullColumnPrefetch(connName, mockRunQuery);
      expect(mockCache.columnCache.has(`${connName}|db1.s1.t1`)).toBe(true);
    });

    it('mirrors synonym columns after full connection column prefetch', async () => {
      const columnStore = new Map<string, unknown[]>();
      mockCache.getColumns.mockImplementation((connection: string, key: string) =>
        columnStore.get(`${connection}|${key}`) as never,
      );
      mockCache.setColumns.mockImplementation((connection: string, key: string, data: unknown[]) => {
        columnStore.set(`${connection}|${key}`, data);
      });

      mockCache.tableCache.set(`${connName}|db1.PUBLIC`, {
        data: [
          { label: 'ORDERS', OBJNAME: 'ORDERS', objType: 'TABLE', SCHEMA: 'PUBLIC' },
          {
            OBJNAME: 'ORDERS_SYN',
            label: 'ORDERS_SYN',
            objType: 'SYNONYM',
            SCHEMA: 'PUBLIC',
            REFOBJNAME: 'PUBLIC.ORDERS',
          },
        ],
        timestamp: Date.now(),
      });

      mockRunQuery.mockResolvedValue({
        columns: [
          { name: 'TABLENAME' },
          { name: 'DBNAME' },
          { name: 'SCHEMA' },
          { name: 'ATTNAME' },
          { name: 'FORMAT_TYPE' },
          { name: 'IS_PK' },
          { name: 'IS_FK' },
          { name: 'IS_DISTRIBUTION_KEY' },
        ],
        data: [['ORDERS', 'db1', 'PUBLIC', 'ID', 'INT4', 1, 0, 0]],
      });

      await prefetcher['prefetchAllColumnsForConnection'](connName, mockRunQuery);

      const targetColumns = columnStore.get(`${connName}|DB1.PUBLIC.ORDERS`);
      const synonymColumns = columnStore.get(`${connName}|DB1.PUBLIC.ORDERS_SYN`);

      expect(targetColumns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ATTNAME: 'ID', isPk: true }),
        ]),
      );
      expect(synonymColumns).toEqual(targetColumns);
    });
  });

  describe('prefetchAllColumnsForConnection parallelism', () => {
    const emptyColumnResult = {
      columns: [
        { name: 'TABLENAME' },
        { name: 'DBNAME' },
        { name: 'SCHEMA' },
        { name: 'ATTNAME' },
        { name: 'FORMAT_TYPE' },
        { name: 'IS_PK' },
        { name: 'IS_FK' },
        { name: 'IS_DISTRIBUTION_KEY' },
      ],
      data: [['T1', 'DB', 'PUBLIC', 'ID', 'INT4', 1, 0, 0]],
    };

    beforeEach(() => {
      resetMetadataQueryLimiterForTests();
    });

    it('runs up to 5 column queries per database in parallel', async () => {
      const dbCount = 12;
      for (let i = 1; i <= dbCount; i++) {
        mockCache.tableCache.set(`${connName}|DB${String(i).padStart(2, '0')}.PUBLIC`, {
          data: [{ label: `T${i}` }],
          timestamp: Date.now(),
        });
      }

      let inFlight = 0;
      let maxInFlight = 0;
      const release: Array<() => void> = [];

      mockRunQuery.mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => {
          release.push(() => {
            inFlight -= 1;
            resolve();
          });
        });
        return emptyColumnResult;
      });

      const prefetchPromise = prefetcher['prefetchAllColumnsForConnection'](connName, mockRunQuery);

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(maxInFlight).toBe(5);
      expect(mockRunQuery).toHaveBeenCalledTimes(5);

      while (release.length > 0) {
        release.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      await prefetchPromise;
      expect(mockRunQuery).toHaveBeenCalledTimes(dbCount);
      expect(maxInFlight).toBe(5);
      expect(inFlight).toBe(0);
    });
  });

  describe('prefetchColumnsForDatabase', () => {
    it('should deduplicate concurrent database column prefetch', async () => {
      mockRunQuery.mockImplementation(
        () => new Promise((resolve) =>
          setTimeout(() => resolve({
            columns: [
              { name: 'TABLENAME' },
              { name: 'DBNAME' },
              { name: 'SCHEMA' },
              { name: 'ATTNAME' },
              { name: 'FORMAT_TYPE' },
              { name: 'IS_PK' },
              { name: 'IS_FK' },
              { name: 'IS_DISTRIBUTION_KEY' },
            ],
            data: [['ORDERS', 'db1', 'PUBLIC', 'ID', 'INT4', 1, 0, 0]],
          }), 5),
        ),
      );

      await Promise.all([
        prefetcher.prefetchColumnsForDatabase(connName, 'db1', mockRunQuery),
        prefetcher.prefetchColumnsForDatabase(connName, 'db1', mockRunQuery),
      ]);

      expect(mockRunQuery).toHaveBeenCalledTimes(1);
      expect(mockCache.setColumns).toHaveBeenCalledWith(
        connName,
        'DB1.PUBLIC.ORDERS',
        expect.arrayContaining([
          expect.objectContaining({
            ATTNAME: 'ID',
            isPk: true,
            isDistributionKey: false,
          }),
        ]),
      );
    });

    it('mirrors synonym columns after database column prefetch', async () => {
      const columnStore = new Map<string, unknown[]>();
      mockCache.getColumns.mockImplementation((connection: string, key: string) =>
        columnStore.get(`${connection}|${key}`) as never,
      );
      mockCache.setColumns.mockImplementation((connection: string, key: string, data: unknown[]) => {
        columnStore.set(`${connection}|${key}`, data);
      });

      mockCache.tableCache.set(`${connName}|db1.PUBLIC`, {
        data: [{
          OBJNAME: 'ORDERS_SYN',
          label: 'ORDERS_SYN',
          objType: 'SYNONYM',
          SCHEMA: 'PUBLIC',
          REFOBJNAME: 'PUBLIC.ORDERS',
        }],
        timestamp: Date.now(),
      });

      mockRunQuery.mockResolvedValue({
        columns: [
          { name: 'TABLENAME' },
          { name: 'DBNAME' },
          { name: 'SCHEMA' },
          { name: 'ATTNAME' },
          { name: 'FORMAT_TYPE' },
          { name: 'IS_PK' },
          { name: 'IS_FK' },
          { name: 'IS_DISTRIBUTION_KEY' },
        ],
        data: [['ORDERS', 'db1', 'public', 'ID', 'INT4', 1, 0, 0]],
      });

      await prefetcher.prefetchColumnsForDatabase(connName, 'db1', mockRunQuery);

      const targetColumns = columnStore.get(`${connName}|DB1.PUBLIC.ORDERS`);
      const synonymColumns = columnStore.get(`${connName}|DB1.PUBLIC.ORDERS_SYN`);

      expect(targetColumns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ATTNAME: 'ID', isPk: true }),
        ]),
      );
      expect(synonymColumns).toEqual(targetColumns);
      expect(mockRunQuery).toHaveBeenCalledTimes(1);
    });

    it('skips when database is dead', async () => {
      mockCache.isDatabaseDead.mockReturnValue(true);

      await prefetcher.prefetchColumnsForDatabase(connName, 'db1', mockRunQuery);

      expect(mockRunQuery).not.toHaveBeenCalled();
    });
  });

  describe('triggerConnectionPrefetch', () => {
    it('should not run if already mapped or in progress', () => {
      prefetcher['connectionPrefetchTriggered'].set(connName, Date.now());
      prefetcher.triggerConnectionPrefetch(connName, mockRunQuery);
      expect(Logger.getInstance().info).not.toHaveBeenCalledWith(expect.stringContaining('Starting'));
    });

    it('should execute full suite of prefetch logic for a connection', async () => {
      // Setup DB mock
      mockRunQuery.mockResolvedValueOnce({
        columns: [{ name: 'DATABASE' }], data: [['db1']]
      })
        // Schemas mock
        .mockResolvedValueOnce({
          columns: [{ name: 'SCHEMA' }], data: [['s1']]
        })
        // Objects mock
        .mockResolvedValueOnce({
          columns: [{ name: 'OBJNAME' }, { name: 'OBJID' }, { name: 'SCHEMA' }, { name: 'DBNAME' }, { name: 'OBJTYPE' }],
          data: [['t1', 1, 's1', 'db1', 'TABLE']]
        })
        // Procedures mock
        .mockResolvedValueOnce({
          columns: [{ name: 'PROCEDURE' }, { name: 'SCHEMA' }, { name: 'PROCEDURESIGNATURE' }],
          data: [['p1', 's1', 'p1()']]
        });

      // We also need tables in cache to trigger column fetch
      mockCache.tableCache.set(`${connName}|db1.s1`, { data: [{ label: 't1' } as any], timestamp: 0 });

      // columns mock
      mockRunQuery.mockResolvedValueOnce({
        columns: [{ name: 'TABLENAME' }, { name: 'DBNAME' }, { name: 'SCHEMA' }, { name: 'ATTNAME' }, { name: 'FORMAT_TYPE' }, { name: 'IS_PK' }, { name: 'IS_FK' }],
        data: [['t1', 'db1', 's1', 'col1', 'INT', 0, 0]]
      });

      prefetcher.triggerConnectionPrefetch(connName, mockRunQuery);
      // Wait for all microtasks to drain
      await new Promise(process.nextTick);
      await new Promise(process.nextTick);
      await new Promise(process.nextTick);

      expect(mockCache.setDatabases).toHaveBeenCalled();
      expect(mockCache.setSchemas).toHaveBeenCalled();
      expect(mockCache.releasePrefetchLock).toHaveBeenCalledWith(connName);
    });

    it('should skip prefetch when lock is not acquired (E8)', () => {
      (mockCache.tryAcquirePrefetchLock as jest.Mock).mockReturnValue(false);
      prefetcher.triggerConnectionPrefetch(connName, mockRunQuery);
      expect(mockRunQuery).not.toHaveBeenCalled();
      expect(mockCache.releasePrefetchLock).not.toHaveBeenCalled();
    });

    it('should not save to disk when prefetch throws (E19)', async () => {
      (mockCache.verifyStagesComplete as jest.Mock).mockReturnValue(false);
      mockRunQuery.mockImplementation(async () => {
        throw new Error('fail');
      });
      prefetcher.triggerConnectionPrefetch(connName, mockRunQuery);
      await new Promise(process.nextTick);
      await new Promise(process.nextTick);
      expect(mockCache.saveConnectionToDiskAfterPrefetch).not.toHaveBeenCalled();
      expect(mockCache.releasePrefetchLock).toHaveBeenCalledWith(connName);
    });

    it('should restore prefetch timestamps from disk load', () => {
      const ts = Date.now() - 1000;
      prefetcher.restorePrefetchTimestamps(new Map([[connName, ts]]));
      expect(prefetcher.getConnectionPrefetchTimestamp(connName)).toBe(ts);
    });

    it('should emit progress events during connection prefetch', async () => {
      const progressEvents: MetadataPrefetchProgress[] = [];
      prefetcher = new CachePrefetcher(mockCache, event => progressEvents.push(event));

      mockRunQuery
        .mockResolvedValueOnce({
          columns: [{ name: 'DATABASE' }],
          data: [['db1']]
        })
        .mockResolvedValueOnce({
          columns: [{ name: 'SCHEMA' }],
          data: [['s1']]
        })
        .mockResolvedValueOnce({
          columns: [{ name: 'OBJNAME' }, { name: 'OBJID' }, { name: 'SCHEMA' }, { name: 'DBNAME' }, { name: 'OBJTYPE' }],
          data: [['t1', 1, 's1', 'db1', 'TABLE']]
        })
        .mockResolvedValueOnce({
          columns: [{ name: 'PROCEDURE' }, { name: 'SCHEMA' }, { name: 'PROCEDURESIGNATURE' }],
          data: [['p1', 's1', 'p1()']]
        })
        .mockResolvedValueOnce({
          columns: [{ name: 'TABLENAME' }, { name: 'DBNAME' }, { name: 'SCHEMA' }, { name: 'ATTNAME' }, { name: 'FORMAT_TYPE' }, { name: 'IS_PK' }, { name: 'IS_FK' }],
          data: [['t1', 'db1', 's1', 'col1', 'INT', 0, 0]]
        });

      mockCache.tableCache.set(`${connName}|db1.s1`, { data: [{ label: 't1' } as any], timestamp: 0 });

      prefetcher.triggerConnectionPrefetch(connName, mockRunQuery);
      await new Promise(process.nextTick);
      await new Promise(process.nextTick);

      expect(progressEvents.some(e => e.stage === 'start')).toBe(true);
    });

    it('should re-trigger prefetch when last prefetch is older than cache TTL', async () => {
      prefetcher['connectionPrefetchTriggered'].set(connName, 0);

      mockRunQuery
        .mockResolvedValueOnce({
          columns: [{ name: 'DATABASE' }], data: [['db1']]
        })
        .mockResolvedValueOnce({
          columns: [{ name: 'SCHEMA' }], data: [['s1']]
        })
        .mockResolvedValueOnce({
          columns: [{ name: 'OBJNAME' }, { name: 'OBJID' }, { name: 'SCHEMA' }, { name: 'DBNAME' }, { name: 'OBJTYPE' }],
          data: [['t1', 1, 's1', 'db1', 'TABLE']]
        })
        .mockResolvedValueOnce({
          columns: [{ name: 'PROCEDURE' }, { name: 'SCHEMA' }, { name: 'PROCEDURESIGNATURE' }],
          data: [['p1', 's1', 'p1()']]
        })
        .mockResolvedValueOnce({
          columns: [{ name: 'TABLENAME' }, { name: 'DBNAME' }, { name: 'SCHEMA' }, { name: 'ATTNAME' }, { name: 'FORMAT_TYPE' }, { name: 'IS_PK' }, { name: 'IS_FK' }],
          data: [['t1', 'db1', 's1', 'col1', 'INT', 0, 0]]
        });

      mockCache.tableCache.set(`${connName}|db1.s1`, { data: [{ label: 't1' } as any], timestamp: 0 });

      prefetcher.triggerConnectionPrefetch(connName, mockRunQuery);
      await new Promise(process.nextTick);

      expect(Logger.getInstance().info).toHaveBeenCalledWith(expect.stringContaining('stale'));
      expect(mockCache.setDatabases).toHaveBeenCalled();
      expect(prefetcher.hasConnectionPrefetchTriggered(connName)).toBe(true);
    });

    it('should force refresh all layers when disk-loaded prefetch is stale', async () => {
      prefetcher['connectionPrefetchTriggered'].set(connName, 0);
      mockCache.getDatabases.mockReturnValue([{ label: 'db1' } as any]);
      mockCache.getSchemas.mockReturnValue([{ label: 's1' } as any]);
      mockCache.getTables.mockReturnValue([{ label: 't1' } as any]);
      mockCache.getProcedures.mockReturnValue([{ label: 'p1' } as any]);
      mockCache.getColumns.mockReturnValue([{ label: 'col1' } as any]);
      mockCache.hasTableCacheForConnection.mockReturnValue(true);
      mockCache.tableCache.set(`${connName}|db1.s1`, { data: [{ label: 't1' } as any], timestamp: 0 });

      mockRunQuery
        .mockResolvedValueOnce({
          columns: [{ name: 'DATABASE' }], data: [['db1']]
        })
        .mockResolvedValueOnce({
          columns: [{ name: 'SCHEMA' }], data: [['s1']]
        })
        .mockResolvedValueOnce({
          columns: [{ name: 'OBJNAME' }, { name: 'OBJID' }, { name: 'SCHEMA' }, { name: 'DBNAME' }, { name: 'OBJTYPE' }],
          data: [['t1', 1, 's1', 'db1', 'TABLE']]
        })
        .mockResolvedValueOnce({
          columns: [{ name: 'PROCEDURE' }, { name: 'SCHEMA' }, { name: 'PROCEDURESIGNATURE' }],
          data: [['p1', 's1', 'p1()']]
        })
        .mockResolvedValueOnce({
          columns: [{ name: 'TABLENAME' }, { name: 'DBNAME' }, { name: 'SCHEMA' }, { name: 'ATTNAME' }, { name: 'FORMAT_TYPE' }, { name: 'IS_PK' }, { name: 'IS_FK' }],
          data: [['t1', 'db1', 's1', 'col1', 'INT', 0, 0]]
        });

      prefetcher.triggerConnectionPrefetch(connName, mockRunQuery);
      await new Promise(process.nextTick);
      await new Promise(process.nextTick);

      expect(mockRunQuery.mock.calls.length).toBeGreaterThanOrEqual(5);
      expect(mockCache.setDatabases).toHaveBeenCalled();
      expect(mockCache.setSchemas).toHaveBeenCalled();
    });

    it('should not re-fetch when already in progress (even if stale)', () => {
      prefetcher['connectionPrefetchTriggered'].set(connName, 0);
      prefetcher['connectionPrefetchInProgress'].add(connName);

      prefetcher.triggerConnectionPrefetch(connName, mockRunQuery);

      expect(mockRunQuery).not.toHaveBeenCalled();
    });

    it('should not re-trigger when fresh (timestamp within TTL)', () => {
      prefetcher['connectionPrefetchTriggered'].set(connName, Date.now() - 1000);

      prefetcher.triggerConnectionPrefetch(connName, mockRunQuery);

      expect(Logger.getInstance().info).not.toHaveBeenCalledWith(expect.stringContaining('Starting'));
    });

    it('should allow first prefetch when not yet triggered', async () => {
      expect(prefetcher.hasConnectionPrefetchTriggered(connName)).toBe(false);

      mockRunQuery
        .mockResolvedValueOnce({
          columns: [{ name: 'DATABASE' }], data: [['db1']]
        })
        .mockResolvedValueOnce({
          columns: [{ name: 'SCHEMA' }], data: [['s1']]
        })
        .mockResolvedValueOnce({
          columns: [{ name: 'OBJNAME' }, { name: 'OBJID' }, { name: 'SCHEMA' }, { name: 'DBNAME' }, { name: 'OBJTYPE' }],
          data: [['t1', 1, 's1', 'db1', 'TABLE']]
        })
        .mockResolvedValueOnce({
          columns: [{ name: 'PROCEDURE' }, { name: 'SCHEMA' }, { name: 'PROCEDURESIGNATURE' }],
          data: [['p1', 's1', 'p1()']]
        })
        .mockResolvedValueOnce({
          columns: [{ name: 'TABLENAME' }, { name: 'DBNAME' }, { name: 'SCHEMA' }, { name: 'ATTNAME' }, { name: 'FORMAT_TYPE' }, { name: 'IS_PK' }, { name: 'IS_FK' }],
          data: [['t1', 'db1', 's1', 'col1', 'INT', 0, 0]]
        });

      mockCache.tableCache.set(`${connName}|db1.s1`, { data: [{ label: 't1' } as any], timestamp: 0 });

      prefetcher.triggerConnectionPrefetch(connName, mockRunQuery);
      await new Promise(process.nextTick);

      expect(Logger.getInstance().info).toHaveBeenCalledWith(expect.stringContaining('Starting'));
    });
  });

  describe('prefetchProceduresForDb', () => {
    it('should skip if cache exists', async () => {
      mockCache.getProcedures.mockReturnValue([]);
      await (prefetcher as any).prefetchProceduresForDb(connName, 'db1', mockRunQuery);
      expect(mockRunQuery).not.toHaveBeenCalled();
    });

    it('should fetch procedures and cache by schema and globally', async () => {
      mockRunQuery.mockResolvedValue({
        columns: [{ name: 'PROCEDURE' }, { name: 'SCHEMA' }, { name: 'PROCEDURESIGNATURE' }, { name: 'OWNER' }],
        data: [
          ['p1', 's1', 'p1(int)', 'admin'],
          ['p2', null, undefined, null] // no schema, no signature fallback
        ]
      });
      await (prefetcher as any).prefetchProceduresForDb(connName, 'db1', mockRunQuery);

      expect(mockCache.setProcedures).toHaveBeenCalledWith(connName, 'db1..', expect.any(Array)); // Global
      expect(mockCache.setProcedures).toHaveBeenCalledWith(connName, 'db1.s1', expect.any(Array)); // Schema specific
    });

    it('should handle internal errors', async () => {
      mockRunQuery.mockRejectedValue(new Error('fail'));
      await (prefetcher as any).prefetchProceduresForDb(connName, 'db1', mockRunQuery);
      expect(Logger.getInstance().error).toHaveBeenCalled();
    });
  });

  describe('prefetchSchemasForDb', () => {
    it('should skip if schemas cached', async () => {
      mockCache.getSchemas.mockReturnValue([]);
      await (prefetcher as any).prefetchSchemasForDb(connName, 'db1', mockRunQuery);
      expect(mockRunQuery).not.toHaveBeenCalled();
    });

    it('should fetch and set schemas', async () => {
      mockRunQuery.mockResolvedValue({
        columns: [{ name: 'SCHEMA' }],
        data: [['s1'], [null], ['']]
      });
      await (prefetcher as any).prefetchSchemasForDb(connName, 'db1', mockRunQuery);
      expect(mockCache.setSchemas).toHaveBeenCalledWith(connName, 'db1', expect.arrayContaining([
        expect.objectContaining({ SCHEMA: 's1' })
      ]));
    });
  });
});

describe('catalog error classification', () => {
  const {
    isExpectedCatalogError,
    isDatabaseLevelCatalogError,
  } = jest.requireActual('../metadata/prefetch') as typeof import('../metadata/prefetch');

  it('treats ResolveCatalog as database-level', () => {
    const err = new Error('ResolveCatalog: error retrieving database FOO');
    expect(isDatabaseLevelCatalogError(err)).toBe(true);
    expect(isExpectedCatalogError(err)).toBe(true);
  });

  it('treats missing relation as expected but not database-level', () => {
    const err = new Error('relation "missing_table" does not exist');
    expect(isExpectedCatalogError(err)).toBe(true);
    expect(isDatabaseLevelCatalogError(err)).toBe(false);
  });
});
