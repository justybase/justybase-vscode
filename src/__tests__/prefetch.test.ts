/**
 * Unit tests for metadata/prefetch.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  CachePrefetcher,
  QueryRunnerRawFn,
  MetadataPrefetchProgress,
  MetadataPrefetchRefreshDetails,
} from '../metadata/prefetch';
import type { MetadataPrefetchTarget } from '../metadata/cache/MetadataPrefetchTarget';
import type { PrefetchLease } from '../metadata/diskStorage/metadataDiskStorage';
import {
  getMetadataQueryConcurrencyLimit,
  resetMetadataQueryLimiterForTests,
} from '../metadata/metadataQueryLimiter';
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
  const baseColumnResult = (rows: unknown[][]) => ({
    columns: [
      { name: 'OBJID' }, { name: 'TABLENAME' }, { name: 'DBNAME' }, { name: 'SCHEMA' },
      { name: 'ATTNAME' }, { name: 'FORMAT_TYPE' }, { name: 'ATTNUM' }, { name: 'DESCRIPTION' },
    ],
    data: rows,
  });
  const keyFlagResult = (rows: unknown[][] = []) => ({
    columns: [{ name: 'OBJID' }, { name: 'ATTNAME' }, { name: 'CONTYPE' }],
    data: rows,
  });
  const distributionFlagResult = (rows: unknown[][] = []) => ({
    columns: [{ name: 'OBJID' }, { name: 'ATTNAME' }],
    data: rows,
  });
  const externalColumnResult = (rows: unknown[][]) => ({
    columns: [
      { name: 'TABLENAME' }, { name: 'DBNAME' }, { name: 'SCHEMA' }, { name: 'ATTNAME' },
      { name: 'FORMAT_TYPE' }, { name: 'IS_PK' }, { name: 'IS_FK' }, { name: 'IS_DISTRIBUTION_KEY' },
    ],
    data: rows,
  });

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
      markViewsCatalogLoaded: jest.fn(),
      markPrefetchObjectTypesCatalogLoaded: jest.fn(),
      markProcedureCatalogLoaded: jest.fn(),
      getTypeGroups: jest.fn(),
      hasCachedTypeGroups: jest.fn().mockReturnValue(false),
      setTypeGroups: jest.fn(),
      tryAcquirePrefetchLock: jest.fn().mockResolvedValue({ connectionName: connName, generation: 0, fence: 0 } satisfies PrefetchLease),
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

    it('keeps progress monotonic and exposes catalog SQL lifecycle details', async () => {
      const progress: MetadataPrefetchProgress[] = [];
      const details: MetadataPrefetchRefreshDetails[] = [];
      prefetcher = new CachePrefetcher(
        mockCache,
        event => progress.push(event),
        event => details.push(event),
      );
      const refresh = prefetcher['beginRefreshDetails'](connName);
      const lifecycle = prefetcher['getQueryLifecycleReporter'](connName, refresh.refreshId)!;

      prefetcher['emitProgress']({
        connectionName: connName,
        stage: 'objects',
        percent: 90,
        message: 'Objects loaded',
      });
      prefetcher['emitProgress']({
        connectionName: connName,
        stage: 'columns',
        percent: 80,
        message: 'Fetching columns',
      });
      await prefetcher['runPrefetchQuery'](
        connName,
        async () => ({ columns: [], data: [] }),
        'SELECT * FROM JUST_DATA.._V_OBJECT_DATA',
        { source: 'connection-prefetch', kind: 'objects', database: 'JUST_DATA', reason: 'test' },
        lifecycle,
      );

      expect(progress.map(event => event.percent)).toEqual([90, 90]);
      expect(progress.every(event => event.refreshId)).toBe(true);
      expect(details[details.length - 1]?.queries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          state: 'completed',
          sql: 'SELECT * FROM JUST_DATA.._V_OBJECT_DATA',
          rowsRead: 0,
          context: expect.objectContaining({ kind: 'objects', database: 'JUST_DATA' }),
        }),
      ]));
    });

    it('keeps the longest SQL duration and freezes refresh elapsed at finalization', async () => {
      const details: MetadataPrefetchRefreshDetails[] = [];
      prefetcher = new CachePrefetcher(
        mockCache,
        undefined,
        event => details.push(event),
      );
      const refresh = prefetcher['beginRefreshDetails'](connName);
      const lifecycle = prefetcher['getQueryLifecycleReporter'](connName, refresh.refreshId)!;
      const context = {
        connectionName: connName,
        source: 'connection-prefetch' as const,
        kind: 'objects' as const,
      };

      const firstQueryId = lifecycle.queued('SELECT first', context)!;
      lifecycle.started(firstQueryId, 0);
      lifecycle.executionCompleted(firstQueryId, { totalMs: 2_200 });
      lifecycle.completed(firstQueryId, { columns: [], data: [] });
      const active = prefetcher['refreshDetailsByConnection'].get(connName)!;
      const firstActivity = active.queries.get(firstQueryId)!;
      prefetcher['publishRefreshDetails'](active);
      expect(firstActivity.executionDurationMs).toBe(2_200);

      const secondQueryId = lifecycle.queued('SELECT second', context)!;
      lifecycle.started(secondQueryId, 0);
      lifecycle.executionCompleted(secondQueryId, { totalMs: 800 });
      lifecycle.completed(secondQueryId, { columns: [], data: [] });
      prefetcher['publishRefreshDetails'](active);

      prefetcher['finalizeRefreshDetails'](connName);
      const finalized = details[details.length - 1]!;
      expect(finalized.longestSqlDurationMs).toBe(2_200);
      expect(finalized.longestSqlQueryId).toBe(firstQueryId);
      expect(finalized.completedAt).toBeDefined();

      const completedAt = finalized.completedAt;
      expect(details[details.length - 1]!.completedAt).toBe(completedAt);
      expect(details[details.length - 1]!.longestSqlDurationMs).toBe(2_200);
      expect(lifecycle.queued('SELECT after-finalization', context)).toBeUndefined();

      await prefetcher['runPrefetchQuery'](
        connName,
        async () => ({ columns: [], data: [] }),
        'SELECT background warmup',
        context,
      );
      expect(details[details.length - 1]!.queries).toHaveLength(2);
    });

    it('clears per-connection object completion markers with the metadata cache', () => {
      prefetcher['allObjectsPrefetchTriggeredSet'].add(`ALL_OBJECTS|${connName}`);
      prefetcher['primaryObjectsPrefetchCompletedSet'].add(`ALL_OBJECTS|${connName}`);
      prefetcher['externalObjectsPrefetchTriggeredSet'].add(`ALL_OBJECTS|${connName}`);
      prefetcher['connectionPrefetchTriggered'].set(connName, Date.now());

      prefetcher.clearConnectionPrefetchState(connName);

      expect(prefetcher.hasAllObjectsPrefetchTriggered(connName)).toBe(false);
      expect(prefetcher['primaryObjectsPrefetchCompletedSet'].has(`ALL_OBJECTS|${connName}`)).toBe(false);
      expect(prefetcher['externalObjectsPrefetchTriggeredSet'].has(`ALL_OBJECTS|${connName}`)).toBe(false);
      expect(prefetcher.getConnectionPrefetchTimestamp(connName)).toBeUndefined();
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

      mockRunQuery.mockImplementation(async (_sql, context) => {
        if (context?.kind === 'column-keys') {
          return keyFlagResult([[1, 'col1', 'p'], [1, 'col2', 'f']]);
        }
        if (context?.kind === 'column-distribution') {
          return distributionFlagResult();
        }
        return baseColumnResult([
          [1, 't1', 'db1', 's1', 'col1', 'INT4', 1, ''],
          [1, 't1', 'db1', 's1', 'col2', 'VARCHAR', 2, ''],
        ]);
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
      prefetcher['primaryObjectsPrefetchCompletedSet'].add(`ALL_OBJECTS|${connName}`);
      prefetcher['externalObjectsPrefetchTriggeredSet'].add(`ALL_OBJECTS|${connName}`);
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
      expect(mockCache.setTables).toHaveBeenCalledTimes(2);
    });

    it('should discover external objects once when regular tables are already cached', async () => {
      (mockCache.hasTableCacheForConnection as jest.Mock).mockReturnValue(true);
      prefetcher['primaryObjectsPrefetchCompletedSet'].add(`ALL_OBJECTS|${connName}`);
      mockCache.getDatabases.mockReturnValue([{ label: 'db1' } as any]);
      mockRunQuery.mockResolvedValue({
        columns: [
          { name: 'OBJNAME' },
          { name: 'OBJID' },
          { name: 'SCHEMA' },
          { name: 'DBNAME' },
          { name: 'OBJTYPE' },
        ],
        data: [['external_t', 201, 's1', 'db1', 'EXTERNAL TABLE']],
      });
      await prefetcher.prefetchAllObjects(connName, mockRunQuery, true);
      expect(mockRunQuery).toHaveBeenCalledTimes(1);
      expect(mockRunQuery.mock.calls[0][0]).not.toContain('_V_OBJECT_DATA');
      expect(mockCache.setTables).toHaveBeenCalled();
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

    it('runs table queries per database serially, skipping dead databases', async () => {
      mockCache.isDatabaseDead.mockImplementation(
        (_connection: string, db: string | undefined) => (db ?? '').toUpperCase() === 'GHOST',
      );
      mockRunQuery.mockResolvedValue({
        columns: [{ name: 'OBJNAME' }, { name: 'OBJID' }, { name: 'SCHEMA' }, { name: 'DBNAME' }, { name: 'OBJTYPE' }],
        data: [['t1', 101, 's1', 'db1', 'TABLE']],
      });

      await prefetcher.prefetchAllObjects(connName, mockRunQuery, false, ['db1', 'GHOST'], true);

      // main + external queries for the live database, none for the dead one
      expect(mockRunQuery).toHaveBeenCalledTimes(2);
      for (const call of mockRunQuery.mock.calls) {
        const query = call[0] as string;
        expect(query).toMatch(/DB1/i);
        expect(query).not.toMatch(/GHOST/i);
      }
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

      mockRunQuery.mockImplementation(async (_sql, context) => {
        if (context?.kind === 'column-keys') return keyFlagResult([[1, 'ID', 'p']]);
        if (context?.kind === 'column-distribution') return distributionFlagResult();
        return baseColumnResult([[1, 'ORDERS', 'db1', 'PUBLIC', 'ID', 'INT4', 1, '']]);
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

describe('prefetchAllColumnsForConnection serial execution', () => {
    beforeEach(() => {
      resetMetadataQueryLimiterForTests();
    });

    it('runs one column query serially across databases when no external table is cached', async () => {
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

      mockRunQuery.mockImplementation(async (_sql, context) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => {
          release.push(() => {
            inFlight -= 1;
            resolve();
          });
        });
        if (context?.kind === 'column-keys') return keyFlagResult([[1, 'ID', 'p']]);
        if (context?.kind === 'column-distribution') return distributionFlagResult();
        return baseColumnResult([[1, 'T1', 'DB', 'PUBLIC', 'ID', 'INT4', 1, '']]);
      });

      const prefetchPromise = prefetcher['prefetchAllColumnsForConnection'](connName, mockRunQuery);

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(maxInFlight).toBe(1);

      while (release.length > 0) {
        release.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      await prefetchPromise;
      // Three regular scans per database; external remains conditional.
      expect(mockRunQuery).toHaveBeenCalledTimes(dbCount * 3);
      expect(maxInFlight).toBe(1);
      expect(inFlight).toBe(0);
    });
  });

  describe('prefetchColumnsForDatabase', () => {
    it('should deduplicate concurrent database column prefetch', async () => {
      mockRunQuery.mockImplementation(
        (_sql, context) => new Promise((resolve) =>
          setTimeout(() => {
            if (context?.kind === 'column-keys') {
              resolve(keyFlagResult([[1, 'ID', 'p']]));
            } else if (context?.kind === 'column-distribution') {
              resolve(distributionFlagResult());
            } else {
              resolve(baseColumnResult([[1, 'ORDERS', 'db1', 'PUBLIC', 'ID', 'INT4', 1, '']]));
            }
          }, 5),
        ),
      );

      await Promise.all([
        prefetcher.prefetchColumnsForDatabase(connName, 'db1', mockRunQuery),
        prefetcher.prefetchColumnsForDatabase(connName, 'db1', mockRunQuery),
      ]);

      // Concurrent calls are deduplicated to one three-query snapshot.
      expect(mockRunQuery).toHaveBeenCalledTimes(3);
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

      mockRunQuery.mockImplementation(async (_sql, context) => {
        if (context?.kind === 'column-keys') return keyFlagResult([[1, 'ID', 'p']]);
        if (context?.kind === 'column-distribution') return distributionFlagResult();
        return baseColumnResult([[1, 'ORDERS', 'db1', 'public', 'ID', 'INT4', 1, '']]);
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
      expect(mockRunQuery).toHaveBeenCalledTimes(3); // one regular three-query snapshot
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
      expect(mockCache.releasePrefetchLock).toHaveBeenCalledWith(expect.objectContaining({ connectionName: connName }));
    });

    it('should skip prefetch when lock is not acquired (E8)', () => {
      (mockCache.tryAcquirePrefetchLock as jest.Mock).mockReturnValue(undefined);
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
      expect(mockCache.releasePrefetchLock).toHaveBeenCalledWith(expect.objectContaining({ connectionName: connName }));
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

      expect(mockRunQuery.mock.calls.length).toBeGreaterThanOrEqual(
        getMetadataQueryConcurrencyLimit(),
      );
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

    it('should refresh when a fresh timestamp has an incomplete snapshot', async () => {
      const verifyCompleteSnapshot = jest.fn().mockReturnValue(false);
      (mockCache as unknown as { verifyCompleteSnapshot: jest.Mock }).verifyCompleteSnapshot =
        verifyCompleteSnapshot;
      mockCache.hasTableCacheForConnection.mockReturnValue(true);
      prefetcher['connectionPrefetchTriggered'].set(connName, Date.now() - 1000);
      mockRunQuery.mockResolvedValue({ columns: [], data: [] });

      await (prefetcher as any).runConnectionPrefetch(connName, mockRunQuery);

      expect(verifyCompleteSnapshot).toHaveBeenCalledWith(connName);
      expect(mockRunQuery).toHaveBeenCalled();
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

  describe('external-table split regressions', () => {
    const objectColumns = [
      { name: 'OBJNAME' }, { name: 'OBJID' }, { name: 'SCHEMA' }, { name: 'DBNAME' }, { name: 'OBJTYPE' },
    ];
    it('T2: main query failure does not discard external-table rows (prefetchAllObjects)', async () => {
      mockCache.getDatabases.mockReturnValue([{ label: 'db1' } as any]);
      mockRunQuery
        .mockRejectedValueOnce(new Error('main failed'))
        .mockResolvedValueOnce({
          columns: objectColumns,
          data: [['ET1', 55, 'S1', 'db1', 'EXTERNAL TABLE']],
        });

      await prefetcher.prefetchAllObjects(connName, mockRunQuery, false, ['db1'], true);

      expect(mockCache.setTables).toHaveBeenCalledWith(
        connName,
        'DB1.S1',
        expect.arrayContaining([expect.objectContaining({ OBJNAME: 'ET1', objType: 'EXTERNAL TABLE' })]),
        expect.any(Map),
      );
    });

    it('retries the primary object catalog after a partial external-only result', async () => {
      (mockCache.hasTableCacheForConnection as jest.Mock).mockReturnValue(true);
      mockRunQuery
        .mockRejectedValueOnce(new Error('main transient failure'))
        .mockResolvedValueOnce({
          columns: objectColumns,
          data: [['ET1', 55, 'S1', 'db1', 'EXTERNAL TABLE']],
        });

      await expect(
        prefetcher.prefetchAllObjects(connName, mockRunQuery, true, ['db1']),
      ).resolves.toBe(false);

      mockRunQuery.mockClear();
      mockRunQuery.mockResolvedValue({
        columns: objectColumns,
        data: [['T1', 1, 'S1', 'db1', 'TABLE']],
      });

      await expect(
        prefetcher.prefetchAllObjects(connName, mockRunQuery, true, ['db1']),
      ).resolves.toBe(true);

      expect(mockRunQuery).toHaveBeenCalledTimes(2);
      expect(mockRunQuery.mock.calls[0][0]).toContain('_V_OBJECT_DATA');
    });

    it('T3: F2 — prefetch trigger is cleared after a query failure so a retry re-runs stage 3', async () => {
      mockCache.getDatabases.mockReturnValue([{ label: 'db1' } as any]);
      mockRunQuery.mockRejectedValue(new Error('fail'));

      await prefetcher.prefetchAllObjects(connName, mockRunQuery);

      expect(prefetcher.hasAllObjectsPrefetchTriggered(connName)).toBe(false);

      mockRunQuery.mockResolvedValue({
        columns: objectColumns,
        data: [['t1', 1, 's1', 'db1', 'TABLE']],
      });
      await prefetcher.prefetchAllObjects(connName, mockRunQuery);
      expect(mockCache.setTables).toHaveBeenCalled();
    });

    it('T4: F0 — columns prefetch runs from the cached database list even when the table cache is empty', async () => {
      mockCache.getDatabases.mockReturnValue([{ label: 'db1' } as any]);
      mockRunQuery.mockImplementation(async (_sql, context) => {
        if (context?.kind === 'column-keys') return keyFlagResult([[1, 'ID', 'p']]);
        if (context?.kind === 'column-distribution') return distributionFlagResult();
        return baseColumnResult([[1, 'ORDERS', 'db1', 'PUBLIC', 'ID', 'INT4', 1, '']]);
      });

      await prefetcher['prefetchAllColumnsForConnection'](connName, mockRunQuery);

      expect(mockCache.setColumns).toHaveBeenCalledWith(
        connName,
        'DB1.PUBLIC.ORDERS',
        expect.arrayContaining([expect.objectContaining({ ATTNAME: 'ID' })]),
      );
    });

    it('T5: F0 — falls back to the table cache database list when no databases are cached', async () => {
      mockCache.tableCache.set(`${connName}|DB1.PUBLIC`, {
        data: [{ label: 'ORDERS' }],
        timestamp: Date.now(),
      });
      mockRunQuery.mockImplementation(async (_sql, context) => {
        if (context?.kind === 'column-keys') return keyFlagResult([[1, 'ID', 'p']]);
        if (context?.kind === 'column-distribution') return distributionFlagResult();
        return baseColumnResult([[1, 'ORDERS', 'db1', 'PUBLIC', 'ID', 'INT4', 1, '']]);
      });

      await prefetcher['prefetchAllColumnsForConnection'](connName, mockRunQuery);

      expect(mockCache.setColumns).toHaveBeenCalledWith(
        connName,
        'DB1.PUBLIC.ORDERS',
        expect.arrayContaining([expect.objectContaining({ ATTNAME: 'ID' })]),
      );
    });

    it('T6: columns prefetch merges main and external rows in code', async () => {
      mockCache.getDatabases.mockReturnValue([{ label: 'db1' } as any]);
      mockCache.tableCache.set(`${connName}|DB1.PUBLIC`, {
        data: [{ OBJNAME: 'ET1', label: 'ET1', objType: 'EXTERNAL TABLE', SCHEMA: 'PUBLIC' }],
        timestamp: Date.now(),
      });
      mockRunQuery.mockImplementation(async (_sql, context) => {
        if (context?.kind === 'column-keys') return keyFlagResult([[1, 'ID', 'p']]);
        if (context?.kind === 'column-distribution') return distributionFlagResult();
        if (context?.kind === 'external-columns') {
          return externalColumnResult([['ET1', 'db1', 'PUBLIC', 'COL1', 'VARCHAR(100)', 0, 0, 0]]);
        }
        return baseColumnResult([[1, 'ORDERS', 'db1', 'PUBLIC', 'ID', 'INT4', 1, '']]);
      });

      await prefetcher['prefetchAllColumnsForConnection'](connName, mockRunQuery);

      expect(mockCache.setColumns).toHaveBeenCalledWith(
        connName,
        'DB1.PUBLIC.ORDERS',
        expect.arrayContaining([expect.objectContaining({ ATTNAME: 'ID' })]),
      );
      expect(mockCache.setColumns).toHaveBeenCalledWith(
        connName,
        'DB1.PUBLIC.ET1',
        expect.arrayContaining([expect.objectContaining({ ATTNAME: 'COL1' })]),
      );
    });

    it('T8: database columns prefetch keeps main rows when the external query fails', async () => {
      mockCache.tableCache.set(`${connName}|DB1.PUBLIC`, {
        data: [{ OBJNAME: 'ET1', label: 'ET1', objType: 'EXTERNAL TABLE', SCHEMA: 'PUBLIC' }],
        timestamp: Date.now(),
      });
      mockRunQuery.mockImplementation(async (_sql, context) => {
        if (context?.kind === 'column-keys') return keyFlagResult([[1, 'ID', 'p']]);
        if (context?.kind === 'column-distribution') return distributionFlagResult();
        if (context?.kind === 'external-columns') throw new Error('external failed');
        return baseColumnResult([[1, 'ORDERS', 'db1', 'PUBLIC', 'ID', 'INT4', 1, '']]);
      });

      await prefetcher.prefetchColumnsForDatabase(connName, 'db1', mockRunQuery);

      expect(mockCache.setColumns).toHaveBeenCalledWith(
        connName,
        'DB1.PUBLIC.ORDERS',
        expect.arrayContaining([expect.objectContaining({ ATTNAME: 'ID' })]),
      );
    });

    it('T10: database columns prefetch still fetches external rows when the main query fails', async () => {
      mockCache.tableCache.set(`${connName}|DB1.PUBLIC`, {
        data: [{ OBJNAME: 'ET1', label: 'ET1', objType: 'EXTERNAL TABLE', SCHEMA: 'PUBLIC' }],
        timestamp: Date.now(),
      });
      mockRunQuery
        .mockRejectedValueOnce(new Error('main transient failure'))
        .mockResolvedValueOnce(externalColumnResult([['ET1', 'db1', 'PUBLIC', 'COL1', 'VARCHAR(100)', 0, 0, 0]]));

      await prefetcher.prefetchColumnsForDatabase(connName, 'db1', mockRunQuery);

      expect(mockRunQuery).toHaveBeenCalledTimes(2);
      expect(mockCache.setColumns).toHaveBeenCalledWith(
        connName,
        'DB1.PUBLIC.ET1',
        expect.arrayContaining([expect.objectContaining({ ATTNAME: 'COL1' })]),
      );
    });

    it('discards regular rows when an auxiliary key scan fails', async () => {
      mockRunQuery.mockImplementation(async (_sql, context) => {
        if (context?.kind === 'column-keys') throw new Error('keys failed');
        return baseColumnResult([[1, 'ORDERS', 'db1', 'PUBLIC', 'ID', 'INT4', 1, '']]);
      });

      await prefetcher.prefetchColumnsForDatabase(connName, 'db1', mockRunQuery);

      expect(mockRunQuery).toHaveBeenCalledTimes(2);
      expect(mockCache.setColumns).not.toHaveBeenCalled();
    });

    it('rejects a row-limited auxiliary scan instead of caching false key flags', async () => {
      mockRunQuery.mockImplementation(async (_sql, context) => {
        if (context?.kind === 'column-keys') {
          return { ...keyFlagResult([[1, 'ID', 'p']]), limitReached: true };
        }
        return baseColumnResult([[1, 'ORDERS', 'db1', 'PUBLIC', 'ID', 'INT4', 1, '']]);
      });

      await prefetcher.prefetchColumnsForDatabase(connName, 'db1', mockRunQuery);

      expect(mockRunQuery).toHaveBeenCalledTimes(2);
      expect(mockCache.setColumns).not.toHaveBeenCalled();
    });

    it('T11: full connection column prefetch isolates the main and external queries', async () => {
      mockCache.getDatabases.mockReturnValue([{ label: 'db1' } as any]);
      mockCache.tableCache.set(`${connName}|DB1.PUBLIC`, {
        data: [{ OBJNAME: 'ET1', label: 'ET1', objType: 'EXTERNAL TABLE', SCHEMA: 'PUBLIC' }],
        timestamp: Date.now(),
      });
      mockRunQuery
        .mockRejectedValueOnce(new Error('main transient failure'))
        .mockResolvedValueOnce(externalColumnResult([['ET1', 'db1', 'PUBLIC', 'COL1', 'VARCHAR(100)', 0, 0, 0]]));

      await prefetcher['prefetchAllColumnsForConnection'](connName, mockRunQuery);

      expect(mockRunQuery).toHaveBeenCalledTimes(2);
      expect(mockCache.setColumns).toHaveBeenCalledWith(
        connName,
        'DB1.PUBLIC.ET1',
        expect.arrayContaining([expect.objectContaining({ ATTNAME: 'COL1' })]),
      );
    });
  });

  describe('prefetch backoff and concurrency regressions', () => {
    it('T7: records last prefetch attempt time and clears it with the prefetch timestamp', async () => {
      prefetcher['lastPrefetchAttemptTime'].set(connName, 12345);
      expect(prefetcher.getLastPrefetchAttemptTime(connName)).toBe(12345);

      prefetcher.clearConnectionPrefetchTimestamp(connName);
      expect(prefetcher.getLastPrefetchAttemptTime(connName)).toBeUndefined();
    });

    it('T9: concurrent triggerConnectionPrefetch calls run only one prefetch', async () => {
      let releaseLock: (() => void) | undefined;
      (mockCache.tryAcquirePrefetchLock as jest.Mock).mockImplementation(
        () => new Promise((resolve) => {
          releaseLock = () => resolve({ connectionName: connName, generation: 0, fence: 0 } satisfies PrefetchLease);
        }),
      );
      mockRunQuery.mockResolvedValue({
        columns: [{ name: 'DATABASE' }],
        data: [['db1']],
      });

      prefetcher.triggerConnectionPrefetch(connName, mockRunQuery);
      prefetcher.triggerConnectionPrefetch(connName, mockRunQuery);

      // Let the first call get past whenDiskReady and start waiting on the lock
      await new Promise(process.nextTick);
      await new Promise(process.nextTick);

      // Second call must be rejected while the first waits on the lock
      expect(prefetcher.hasConnectionPrefetchInProgress(connName)).toBe(true);

      releaseLock?.();
      await new Promise(process.nextTick);
      await new Promise(process.nextTick);

      const startLogs = (Logger.getInstance().info as jest.Mock).mock.calls.filter(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('Starting eager prefetch'),
      );
      expect(startLogs).toHaveLength(1);
    });

    it('clears the in-progress marker when lock acquisition rejects', async () => {
      (mockCache.tryAcquirePrefetchLock as jest.Mock).mockRejectedValue(
        new Error('disk index write failed'),
      );

      await (prefetcher as any).runConnectionPrefetch(connName, mockRunQuery);

      expect(prefetcher.hasConnectionPrefetchInProgress(connName)).toBe(false);
      expect(Logger.getInstance().error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to acquire prefetch lock'),
        expect.any(Error),
      );
    });

    it('does not advance freshness when an object stage is only partially fetched', async () => {
      const resultForKind = (kind: string | undefined) => {
        switch (kind) {
          case 'databases':
            return { columns: [{ name: 'DATABASE' }], data: [['db1']] };
          case 'schemas':
            return { columns: [{ name: 'SCHEMA' }], data: [['S1']] };
          case 'type-groups':
            return { columns: [{ name: 'OBJTYPE' }], data: [['TABLE']] };
          case 'external-objects':
            return {
              columns: [
                { name: 'OBJNAME' }, { name: 'OBJID' }, { name: 'SCHEMA' },
                { name: 'DBNAME' }, { name: 'OBJTYPE' },
              ],
              data: [['ET1', 10, 'S1', 'db1', 'EXTERNAL TABLE']],
            };
          case 'procedures':
            return { columns: [{ name: 'PROCEDURE' }, { name: 'SCHEMA' }], data: [] };
          case 'columns':
            return {
              columns: [
                { name: 'TABLENAME' }, { name: 'DBNAME' }, { name: 'SCHEMA' },
                { name: 'ATTNAME' }, { name: 'FORMAT_TYPE' },
              ],
              data: [['ET1', 'db1', 'S1', 'C1', 'VARCHAR(30)']],
            };
          case 'external-columns':
            return {
              columns: [
                { name: 'TABLENAME' }, { name: 'DBNAME' }, { name: 'SCHEMA' },
                { name: 'ATTNAME' }, { name: 'FORMAT_TYPE' },
              ],
              data: [['ET1', 'db1', 'S1', 'C1', 'VARCHAR(30)']],
            };
          default:
            return { columns: [], data: [] };
        }
      };
      mockRunQuery.mockImplementation(async (_sql, context) => {
        if (context?.kind === 'objects') {
          throw new Error('primary catalog timeout');
        }
        return resultForKind(context?.kind);
      });

      await (prefetcher as any).runConnectionPrefetch(connName, mockRunQuery);

      expect(prefetcher.getConnectionPrefetchTimestamp(connName)).toBeUndefined();
      expect(mockCache.saveConnectionToDiskAfterPrefetch).not.toHaveBeenCalled();
      expect(prefetcher.hasConnectionPrefetchInProgress(connName)).toBe(false);
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
