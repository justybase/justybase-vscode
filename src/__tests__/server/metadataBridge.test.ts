import {
  type CompletionItem,
  CompletionItemKind,
} from "vscode-languageserver/node";
import { MetadataBridge } from "../../server/metadataBridge";
import { CompletionMetadataResolver } from "../../server/completionMetadataResolver";
import { CompletionWildcardResolver } from "../../server/completionWildcardResolver";
import type {
  MetadataObjectItem,
  MetadataRequestParams,
  MetadataResponse,
} from "../../lsp/protocol";
import type {
  FromJoinContext,
} from "../../server/completionTypes";

type ListCacheEntry = { data: MetadataObjectItem[]; timestamp: number };

interface BridgeInternals {
  listCache: Map<string, ListCacheEntry>;
}

function internals(bridge: MetadataBridge): BridgeInternals {
  return bridge as unknown as BridgeInternals;
}

function makeList(items: { name: string; detail?: string }[]): MetadataObjectItem[] {
  return items.map((it) => ({ name: it.name, detail: it.detail }));
}

describe("MetadataBridge list cache", () => {
  let bridge: MetadataBridge;
  let sendRequest: jest.MockedFunction<
    (params: MetadataRequestParams) => Promise<MetadataResponse>
  >;

  const docUri = "file:///doc1.sql";
  const db = "MYDB";
  const schema = "PUBLIC";

  beforeEach(() => {
    sendRequest = jest.fn();
    bridge = new MetadataBridge(sendRequest);
  });

  // =========================================================================
  // Block A: Cache hit/miss — podstawowe
  // =========================================================================

  describe("cache hit/miss", () => {
    const schemasList = makeList([{ name: "S1" }, { name: "S2" }, { name: "S3" }]);
    const tablesList = makeList([{ name: "T1" }, { name: "T2" }]);
    const databasesList = makeList([{ name: "DB1" }, { name: "DB2" }]);
    const viewsList = makeList([{ name: "V1" }]);
    const procsList = makeList([{ name: "P1" }, { name: "P2" }]);

    it("A1: getSchemas — cache hit", async () => {
      sendRequest.mockResolvedValue(schemasList);

      const r1 = await bridge.getSchemas(docUri, db);
      const r2 = await bridge.getSchemas(docUri, db);

      expect(sendRequest).toHaveBeenCalledTimes(1);
      expect(r1).toEqual(schemasList);
      expect(r2).toEqual(schemasList);
    });

    it("A2: getTables — cache hit", async () => {
      sendRequest.mockResolvedValue(tablesList);

      const r1 = await bridge.getTables(docUri, db, schema);
      const r2 = await bridge.getTables(docUri, db, schema);

      expect(sendRequest).toHaveBeenCalledTimes(1);
      expect(r1).toEqual(tablesList);
      expect(r2).toEqual(tablesList);
    });

    it("A3: getDatabases — cache hit", async () => {
      sendRequest.mockResolvedValue(databasesList);

      const r1 = await bridge.getDatabases(docUri);
      const r2 = await bridge.getDatabases(docUri);

      expect(sendRequest).toHaveBeenCalledTimes(1);
      expect(r1).toEqual(databasesList);
      expect(r2).toEqual(databasesList);
    });

    it("A4: getViews — cache hit", async () => {
      sendRequest.mockResolvedValue(viewsList);

      const r1 = await bridge.getViews(docUri, db, schema);
      const r2 = await bridge.getViews(docUri, db, schema);

      expect(sendRequest).toHaveBeenCalledTimes(1);
      expect(r1).toEqual(viewsList);
      expect(r2).toEqual(viewsList);
    });

    it("A5: getProcedures — cache hit", async () => {
      sendRequest.mockResolvedValue(procsList);

      const r1 = await bridge.getProcedures(docUri, db, schema);
      const r2 = await bridge.getProcedures(docUri, db, schema);

      expect(sendRequest).toHaveBeenCalledTimes(1);
      expect(r1).toEqual(procsList);
      expect(r2).toEqual(procsList);
    });
  });

  // =========================================================================
  // Block B: Separacja kluczy
  // =========================================================================

  describe("key separation", () => {
    it("B1: different databases — separate cache keys", async () => {
      const list1 = makeList([{ name: "A" }]);
      const list2 = makeList([{ name: "B" }]);
      sendRequest
        .mockResolvedValueOnce(list1)
        .mockResolvedValueOnce(list2);

      const r1 = await bridge.getSchemas(docUri, "DB1");
      const r2 = await bridge.getSchemas(docUri, "DB2");

      expect(sendRequest).toHaveBeenCalledTimes(2);
      expect(r1).toEqual(list1);
      expect(r2).toEqual(list2);
    });

    it("B2: different schema — separate cache keys for getTables", async () => {
      const list1 = makeList([{ name: "T1" }]);
      const list2 = makeList([{ name: "T2" }]);
      sendRequest
        .mockResolvedValueOnce(list1)
        .mockResolvedValueOnce(list2);

      const r1 = await bridge.getTables(docUri, db, "S1");
      const r2 = await bridge.getTables(docUri, db, "S2");

      expect(sendRequest).toHaveBeenCalledTimes(2);
      expect(r1).toEqual(list1);
      expect(r2).toEqual(list2);
    });

    it("B3: undefined schema is separate from explicit schema", async () => {
      const list1 = makeList([{ name: "ALL_T" }]);
      const list2 = makeList([{ name: "PUB_T" }]);
      sendRequest
        .mockResolvedValueOnce(list1)
        .mockResolvedValueOnce(list2);

      const r1 = await bridge.getTables(docUri, db);
      const r2 = await bridge.getTables(docUri, db, "PUBLIC");

      expect(sendRequest).toHaveBeenCalledTimes(2);
      expect(r1).toEqual(list1);
      expect(r2).toEqual(list2);
    });

    it("B4: getTables and getViews have separate cache keys", async () => {
      const tables = makeList([{ name: "T1" }]);
      const views = makeList([{ name: "V1" }]);
      sendRequest
        .mockResolvedValueOnce(tables)
        .mockResolvedValueOnce(views);

      const r1 = await bridge.getTables(docUri, db, schema);
      const r2 = await bridge.getViews(docUri, db, schema);

      expect(sendRequest).toHaveBeenCalledTimes(2);
      expect(r1).toEqual(tables);
      expect(r2).toEqual(views);
    });
  });

  // =========================================================================
  // Block C: TTL expiry
  // =========================================================================

  describe("TTL expiry", () => {
    it("C1: fresh entry — cache hit", async () => {
      sendRequest.mockResolvedValue(makeList([{ name: "FRESH" }]));

      await bridge.getSchemas(docUri, db); // fill cache
      const r2 = await bridge.getSchemas(docUri, db);

      expect(sendRequest).toHaveBeenCalledTimes(1);
      expect(r2).toEqual(makeList([{ name: "FRESH" }]));
    });

    it("C2: stale entry — re-fetches", async () => {
      sendRequest
        .mockResolvedValueOnce(makeList([{ name: "OLD" }]))
        .mockResolvedValueOnce(makeList([{ name: "NEW" }]));

      await bridge.getSchemas(docUri, db); // fill cache

      // Simulate TTL expiry by manipulating the internal cache timestamp
      const cacheKey = `SCH|${docUri}|${db}`;
      const cache = internals(bridge).listCache;
      const entry = cache.get(cacheKey);
      if (entry) {
        entry.timestamp = Date.now() - 13 * 60 * 60 * 1000; // 13h ago
      }

      const r2 = await bridge.getSchemas(docUri, db);

      expect(sendRequest).toHaveBeenCalledTimes(2);
      expect(r2).toEqual(makeList([{ name: "NEW" }]));
    });

    it("C3: at TTL boundary — re-fetches (>= TTL)", async () => {
      sendRequest
        .mockResolvedValueOnce(makeList([{ name: "BOUNDARY_OLD" }]))
        .mockResolvedValueOnce(makeList([{ name: "BOUNDARY_NEW" }]));

      await bridge.getSchemas(docUri, db); // fill cache

      const cacheKey = `SCH|${docUri}|${db}`;
      const cache = internals(bridge).listCache;
      const entry = cache.get(cacheKey);
      if (entry) {
        entry.timestamp = Date.now() - 12 * 60 * 60 * 1000; // exactly 12h ago (at TTL)
      }

      const r2 = await bridge.getSchemas(docUri, db);

      expect(sendRequest).toHaveBeenCalledTimes(2);
      expect(r2).toEqual(makeList([{ name: "BOUNDARY_NEW" }]));
    });
  });

  // =========================================================================
  // Block D: Obsługa błędów
  // =========================================================================

  describe("error handling", () => {
    it("D1: null response — not cached", async () => {
      sendRequest.mockResolvedValue(null);

      const r1 = await bridge.getSchemas(docUri, db);
      const r2 = await bridge.getSchemas(docUri, db);

      expect(sendRequest).toHaveBeenCalledTimes(2);
      expect(r1).toEqual([]);
      expect(r2).toEqual([]);
    });

    it("D2: rejected promise — not cached", async () => {
      sendRequest.mockRejectedValue(new Error("network error"));

      const r1 = await bridge.getSchemas(docUri, db);
      const r2 = await bridge.getSchemas(docUri, db);

      expect(sendRequest).toHaveBeenCalledTimes(2);
      expect(r1).toEqual([]);
      expect(r2).toEqual([]);
    });

    it("D3: empty array from DB — IS cached", async () => {
      sendRequest.mockResolvedValue([]);

      const r1 = await bridge.getTables(docUri, db, "EMPTY_SCHEMA");
      const r2 = await bridge.getTables(docUri, db, "EMPTY_SCHEMA");

      expect(sendRequest).toHaveBeenCalledTimes(1);
      expect(r1).toEqual([]);
      expect(r2).toEqual([]);
    });
  });

  // =========================================================================
  // Block E: In-flight deduplikacja
  // =========================================================================

  describe("in-flight deduplication", () => {
    it("E1: three concurrent calls — one request", async () => {
      sendRequest.mockImplementation(
        () => new Promise((resolve) =>
          setTimeout(() => resolve(makeList([{ name: "X" }])), 5),
        ),
      );

      const [r1, r2, r3] = await Promise.all([
        bridge.getSchemas(docUri, db),
        bridge.getSchemas(docUri, db),
        bridge.getSchemas(docUri, db),
      ]);

      expect(sendRequest).toHaveBeenCalledTimes(1);
      expect(r1).toEqual(makeList([{ name: "X" }]));
      expect(r2).toEqual(makeList([{ name: "X" }]));
      expect(r3).toEqual(makeList([{ name: "X" }]));
    });

    it("E2: in-flight failure — subsequent call retries", async () => {
      sendRequest
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValueOnce(makeList([{ name: "RETRY_OK" }]));

      // First batch: two concurrent calls, both share the failing in-flight
      const results1 = await Promise.all([
        bridge.getSchemas(docUri, db),
        bridge.getSchemas(docUri, db),
      ]);
      // Both should get [] (error path)
      expect(results1).toEqual([[], []]);

      // Third call: after the failure, should retry
      const r3 = await bridge.getSchemas(docUri, db);

      expect(sendRequest).toHaveBeenCalledTimes(2);
      expect(r3).toEqual(makeList([{ name: "RETRY_OK" }]));
    });

    it("E3: different keys — separate in-flight requests", async () => {
      sendRequest
        .mockResolvedValueOnce(makeList([{ name: "A" }]))
        .mockResolvedValueOnce(makeList([{ name: "B" }]));

      const [r1, r2] = await Promise.all([
        bridge.getSchemas(docUri, "DB_A"),
        bridge.getSchemas(docUri, "DB_B"),
      ]);

      expect(sendRequest).toHaveBeenCalledTimes(2);
      expect(r1).toEqual(makeList([{ name: "A" }]));
      expect(r2).toEqual(makeList([{ name: "B" }]));
    });
  });

  // =========================================================================
  // Block F: Unieważnianie cache
  // =========================================================================

  describe("cache invalidation", () => {
    const docUri2 = "file:///doc2.sql";

    it("F1: clearDocument removes only target uri", async () => {
      sendRequest
        .mockResolvedValueOnce(makeList([{ name: "DB1_S" }]))
        .mockResolvedValueOnce(makeList([{ name: "DB2_S" }]));

      await bridge.getSchemas(docUri, db); // fills cache for docUri
      await bridge.getSchemas(docUri2, db); // fills cache for docUri2

      bridge.clearDocument(docUri);

      // docUri: should re-fetch, docUri2: should still be cached
      sendRequest.mockResolvedValue(makeList([{ name: "DB1_REFETCH" }]));

      const r1 = await bridge.getSchemas(docUri, db);
      const r2 = await bridge.getSchemas(docUri2, db);

      expect(sendRequest).toHaveBeenCalledTimes(3); // 2 initial + 1 refetch
      expect(r1).toEqual(makeList([{ name: "DB1_REFETCH" }]));
      expect(r2).toEqual(makeList([{ name: "DB2_S" }]));
    });

    it("F2: clearAll removes everything", async () => {
      sendRequest
        .mockResolvedValueOnce(makeList([{ name: "X" }]))
        .mockResolvedValueOnce(makeList([{ name: "Y" }]));

      await bridge.getSchemas(docUri, db);
      await bridge.getDatabases(docUri);

      bridge.clearAll();

      sendRequest.mockResolvedValue(makeList([{ name: "AFTER_CLEAR" }]));

      await bridge.getSchemas(docUri, db);

      expect(sendRequest).toHaveBeenCalledTimes(3); // 2 initial + 1 after clear
    });

    it("F3: clearDocument clears in-flight promises too", async () => {
      // Start a slow in-flight request
      const slowPromise = new Promise<MetadataResponse>((resolve) =>
        setTimeout(() => resolve(makeList([{ name: "SLOW" }])), 50),
      );
      sendRequest.mockReturnValueOnce(slowPromise);

      const flightPromise = bridge.getSchemas(docUri, db);

      // Clear before it finishes
      bridge.clearDocument(docUri);

      // After clearing, a new request should be a fresh fetch
      sendRequest.mockResolvedValueOnce(makeList([{ name: "FRESH" }]));

      // Wait for slow promise to finish (it was cleared, so shouldn't cache)
      await flightPromise;
      // Now fetch - should go to network
      const r2 = await bridge.getSchemas(docUri, db);

      expect(sendRequest).toHaveBeenCalledTimes(2);
      expect(r2).toEqual(makeList([{ name: "FRESH" }]));
    });

    it("F4: clearAll after clearDocument — idempotent", async () => {
      sendRequest.mockResolvedValue(makeList([{ name: "Z" }]));

      await bridge.getSchemas(docUri, db);
      bridge.clearDocument(docUri);
      bridge.clearAll();

      sendRequest.mockResolvedValue(makeList([{ name: "POST_CLEAR" }]));
      const r = await bridge.getSchemas(docUri, db);

      expect(sendRequest).toHaveBeenCalledTimes(2);
      expect(r).toEqual(makeList([{ name: "POST_CLEAR" }]));
    });
  });

  // =========================================================================
  // Block H: warmValidationCache — cache-first batch warm
  // =========================================================================

  describe("warmValidationCache", () => {
    const tableInfo = {
      exists: true,
      table: "ORDERS",
      database: db,
      schema,
      columns: [{ name: "ID", type: "INT4" }],
    };

    beforeEach(() => {
      sendRequest.mockImplementation(async (params: MetadataRequestParams) => {
        if (params.kind === "context") {
          return {
            connectionName: "CONN",
            effectiveDatabase: db,
            databaseKind: "netezza",
          };
        }
        if (params.kind === "cachedTableInfo") {
          return tableInfo;
        }
        return null;
      });
    });

    it("H1: uses cached table info without warmDatabaseColumns request", async () => {
      const sql = "SELECT * FROM PUBLIC.ORDERS";

      await bridge.warmValidationCache(docUri, sql);

      expect(sendRequest).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "warmDatabaseColumns" }),
      );
      expect(sendRequest).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "tableInfo" }),
      );
    });

    it("H2: batches warmDatabaseColumns per database when cache is cold", async () => {
      sendRequest.mockImplementation(async (params: MetadataRequestParams) => {
        if (params.kind === "context") {
          return {
            connectionName: "CONN",
            effectiveDatabase: db,
            databaseKind: "netezza",
          };
        }
        if (params.kind === "cachedTableInfo") {
          return {
            exists: true,
            table: "ORDERS",
            database: db,
            schema,
            columns: [],
          };
        }
        if (params.kind === "tableInfo") {
          return tableInfo;
        }
        return null;
      });

      const sql = "SELECT * FROM PUBLIC.ORDERS o JOIN PUBLIC.CUSTOMERS c ON o.ID = c.ID";

      await bridge.warmValidationCache(docUri, sql);

      expect(sendRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "warmDatabaseColumns",
          databases: [db],
        }),
      );
      expect(sendRequest).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "tableInfo", table: "ORDERS" }),
      );
    });

    it("H2b: refreshes empty cached table info after warm instead of reusing stale columns", async () => {
      const database = "JUST_DATA_2";
      let cachedTableInfoCalls = 0;
      sendRequest.mockImplementation(async (params: MetadataRequestParams) => {
        if (params.kind === "context") {
          return {
            connectionName: "CONN",
            effectiveDatabase: database,
            databaseKind: "netezza",
          };
        }
        if (params.kind === "cachedTableInfo") {
          cachedTableInfoCalls += 1;
          return {
            exists: true,
            table: "FACT_SALES_2",
            database,
            schema: undefined,
            columns:
              cachedTableInfoCalls >= 2
                ? [{ name: "PRODUCT_ID", type: "INT4" }]
                : [],
          };
        }
        if (params.kind === "tableInfo") {
          return {
            exists: true,
            table: "FACT_SALES_2",
            database,
            schema: undefined,
            columns: [{ name: "PRODUCT_ID", type: "INT4" }],
          };
        }
        return null;
      });

      const sql =
        "SELECT * FROM JUST_DATA_2..FACT_SALES_2 S WHERE S.PRODUCT_ID > 0";

      await bridge.warmValidationCache(docUri, sql);

      const resolved = bridge.findCachedTableInfo(
        docUri,
        "FACT_SALES_2",
        database,
      );
      expect(resolved?.columns).toEqual([
        { name: "PRODUCT_ID", type: "INT4" },
      ]);
      expect(cachedTableInfoCalls).toBeGreaterThan(1);
    });

    it("H3: shares table info cache across documents for the same connection", async () => {
      const docUri2 = "file:///doc2.sql";
      sendRequest.mockImplementation(async (params: MetadataRequestParams) => {
        if (params.kind === "context") {
          return {
            connectionName: "CONN",
            effectiveDatabase: db,
            databaseKind: "netezza",
          };
        }
        if (params.kind === "cachedTableInfo") {
          return tableInfo;
        }
        return null;
      });

      await bridge.getCachedTableInfo(docUri, db, "ORDERS", schema);
      const fromSecondDoc = bridge.findCachedTableInfo(docUri2, "ORDERS", db, schema);

      expect(fromSecondDoc).toEqual(tableInfo);
    });

    it("H4: skips repeat warm when table refs fingerprint is unchanged", async () => {
      const sql = "SELECT * FROM PUBLIC.ORDERS";
      sendRequest.mockClear();

      const firstContext = await bridge.warmValidationCache(docUri, sql);
      const contextCallsAfterFirst = sendRequest.mock.calls.filter(
        ([params]) => params.kind === "context",
      ).length;

      sendRequest.mockClear();
      const secondContext = await bridge.warmValidationCache(docUri, sql);

      expect(secondContext).toEqual(firstContext);
      expect(sendRequest).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "warmDatabaseColumns" }),
      );
      expect(
        sendRequest.mock.calls.filter(([params]) => params.kind === "context"),
      ).toHaveLength(1);
      expect(contextCallsAfterFirst).toBe(1);
    });

    it("H4b: early return still warms qualification proposals when cache is empty", async () => {
      sendRequest.mockImplementation(async (params: MetadataRequestParams) => {
        if (params.kind === "context") {
          return {
            connectionName: "CONN",
            effectiveDatabase: db,
            databaseKind: "netezza",
          };
        }
        if (params.kind === "cachedTableInfo") {
          return tableInfo;
        }
        if (params.kind === "qualifyTable") {
          return [
            {
              database: db,
              schema,
              name: "ORDERS",
              qualifiedText: `${db}.PUBLIC.ORDERS`,
              isPreferred: true,
            },
          ];
        }
        return null;
      });

      const sql = "SELECT * FROM ORDERS";
      await bridge.warmValidationCache(docUri, sql);
      sendRequest.mockClear();

      bridge.clearDocument(docUri);
      sendRequest.mockImplementation(async (params: MetadataRequestParams) => {
        if (params.kind === "context") {
          return {
            connectionName: "CONN",
            effectiveDatabase: db,
            databaseKind: "netezza",
          };
        }
        if (params.kind === "cachedTableInfo") {
          return tableInfo;
        }
        if (params.kind === "qualifyTable") {
          return [
            {
              database: db,
              schema,
              name: "ORDERS",
              qualifiedText: `${db}.PUBLIC.ORDERS`,
              isPreferred: true,
            },
          ];
        }
        return null;
      });

      await bridge.warmValidationCache(docUri, sql);

      expect(sendRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "qualifyTable",
          table: "ORDERS",
        }),
      );
      expect(sendRequest).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "warmDatabaseColumns" }),
      );
    });

    it("H5a: bumps validation metadata epoch when table info is newly cached", async () => {
      sendRequest.mockImplementation(async (params: MetadataRequestParams) => {
        if (params.kind === "context") {
          return {
            connectionName: "CONN",
            effectiveDatabase: db,
            databaseKind: "netezza",
          };
        }
        if (params.kind === "tableInfo") {
          return tableInfo;
        }
        return null;
      });

      expect(bridge.getValidationMetadataEpoch(docUri)).toBe(0);
      await bridge.getTableInfo(docUri, db, "ORDERS", schema);
      expect(bridge.getValidationMetadataEpoch(docUri)).toBe(1);
    });

    it("H5: re-evaluates warm skip after clearAll even for sql without table refs", async () => {
      const sql = "SELECT 1;";
      sendRequest.mockClear();

      await bridge.warmValidationCache(docUri, sql);
      const contextCallsAfterFirst = sendRequest.mock.calls.filter(
        ([params]) => params.kind === "context",
      ).length;

      bridge.clearAll();
      sendRequest.mockClear();

      await bridge.warmValidationCache(docUri, sql);

      expect(
        sendRequest.mock.calls.filter(([params]) => params.kind === "context"),
      ).toHaveLength(contextCallsAfterFirst);
    });
  });

  // =========================================================================
  // Block I: exists: false — caching nieistniejących tabel
  // =========================================================================

  describe("exists: false table info caching", () => {
    beforeEach(() => {
      sendRequest.mockImplementation(async (params: MetadataRequestParams) => {
        if (params.kind === "context") {
          return {
            connectionName: "CONN",
            effectiveDatabase: db,
            databaseKind: "netezza",
          };
        }
        if (params.kind === "tableInfo" && params.table === "NO_SUCH_TABLE") {
          return {
            exists: false,
            table: "NO_SUCH_TABLE",
            database: db,
            schema,
            columns: [],
          };
        }
        if (params.kind === "cachedTableInfo" && params.table === "NO_SUCH_TABLE") {
          return {
            exists: false,
            table: "NO_SUCH_TABLE",
            database: db,
            schema,
            columns: [],
          };
        }
        if (params.kind === "tableInfo" && params.table === "ORDERS") {
          return {
            exists: true,
            table: "ORDERS",
            database: db,
            schema,
            columns: [{ name: "ID", type: "INT4" }],
          };
        }
        if (params.kind === "cachedTableInfo" && params.table === "ORDERS") {
          return {
            exists: true,
            table: "ORDERS",
            database: db,
            schema,
            columns: [{ name: "ID", type: "INT4" }],
          };
        }
        return null;
      });
    });

    it("I1: getTableInfo caches exists:false entry", async () => {
      const r1 = await bridge.getTableInfo(docUri, db, "NO_SUCH_TABLE", schema);
      expect(r1).toEqual({
        exists: false,
        table: "NO_SUCH_TABLE",
        database: db,
        schema,
        columns: [],
      });

      // Second call: should return from cache, not re-request
      sendRequest.mockClear();
      const r2 = await bridge.getTableInfo(docUri, db, "NO_SUCH_TABLE", schema);
      expect(sendRequest).not.toHaveBeenCalled();
      expect(r2).toEqual({
        exists: false,
        table: "NO_SUCH_TABLE",
        database: db,
        schema,
        columns: [],
      });
    });

    it("I2: getCachedTableInfo returns exists:false from cache", async () => {
      // First call: populate cache
      await bridge.getTableInfo(docUri, db, "NO_SUCH_TABLE", schema);

      sendRequest.mockClear();
      const cached = await bridge.getCachedTableInfo(
        docUri,
        db,
        "NO_SUCH_TABLE",
        schema,
      );
      expect(sendRequest).not.toHaveBeenCalled();
      expect(cached?.exists).toBe(false);
      expect(cached?.columns).toEqual([]);
    });

    it("I3: findCachedTableInfo returns exists:false entry", async () => {
      await bridge.getTableInfo(docUri, db, "NO_SUCH_TABLE", schema);

      const found = bridge.findCachedTableInfo(
        docUri,
        "NO_SUCH_TABLE",
        db,
        schema,
      );
      expect(found).toBeDefined();
      expect(found?.exists).toBe(false);
    });

    it("I4: findCachedTableInfo returns exists:false entry via iteration (no schema)", async () => {
      await bridge.getTableInfo(docUri, db, "NO_SUCH_TABLE");

      const found = bridge.findCachedTableInfo(docUri, "NO_SUCH_TABLE", db);
      expect(found).toBeDefined();
      expect(found?.exists).toBe(false);
    });

    it("I5: warmValidationCache caches exists:false and does not re-fetch", async () => {
      const sql = "SELECT * FROM PUBLIC.NO_SUCH_TABLE";

      await bridge.warmValidationCache(docUri, sql);

      sendRequest.mockClear();
      const cached = await bridge.getCachedTableInfo(
        docUri,
        db,
        "NO_SUCH_TABLE",
        schema,
      );
      expect(sendRequest).not.toHaveBeenCalled();
      expect(cached?.exists).toBe(false);
    });

    it("I6: exists:true entry still works alongside exists:false", async () => {
      await bridge.getTableInfo(docUri, db, "ORDERS", schema);
      await bridge.getTableInfo(docUri, db, "NO_SUCH_TABLE", schema);

      const orders = bridge.findCachedTableInfo(docUri, "ORDERS", db, schema);
      expect(orders?.exists).toBe(true);
      expect(orders?.columns).toEqual([{ name: "ID", type: "INT4" }]);

      const noSuch = bridge.findCachedTableInfo(
        docUri,
        "NO_SUCH_TABLE",
        db,
        schema,
      );
      expect(noSuch?.exists).toBe(false);
    });
  });

  // =========================================================================
  // Block G: Cache działa end-to-end z CompletionMetadataResolver
  // =========================================================================

  describe("integration with CompletionMetadataResolver", () => {
    it("G1: from_join_name — cached databases/tables flow into completions", async () => {
      // Pre-fill bridge cache with databases, schemas, tables, and views
      sendRequest
        .mockResolvedValueOnce(makeList([{ name: "MYDB" }, { name: "OTHER" }]))
        .mockResolvedValueOnce(makeList([{ name: "PUBLIC" }, { name: "ADMIN" }]))
        .mockResolvedValueOnce(makeList([{ name: "MY_TABLE" }]))
        .mockResolvedValueOnce(makeList([{ name: "MY_VIEW" }]));

      // First call: populates cache
      const resolver = new CompletionMetadataResolver(
        bridge,
        new CompletionWildcardResolver(),
      );

      const context1: FromJoinContext = { kind: "from_join_name", partial: "" };
      const result1 = await resolver.resolveTablePathCompletions(
        context1,
        [],
        docUri,
        "MYDB",
        "netezza",
        true,
      );

      expect(sendRequest).toHaveBeenCalledTimes(4);
      expect(result1.some((c: CompletionItem) => c.label === "MYDB")).toBe(true);
      expect(result1.some((c: CompletionItem) => c.label === "MY_TABLE")).toBe(true);
      expect(result1.some((c: CompletionItem) => c.label === "PUBLIC")).toBe(true);

      // Second call: should use cache
      const result2 = await resolver.resolveTablePathCompletions(
        context1,
        [],
        docUri,
        "MYDB",
        "netezza",
        true,
      );

      expect(sendRequest).toHaveBeenCalledTimes(4);
      expect(result2).toEqual(result1);
    });

    it("G2: db_dot — schema-qualified tables when qualifier is not a database", async () => {
      sendRequest
        .mockResolvedValueOnce(makeList([{ name: "MYDB" }, { name: "OTHER" }]))
        .mockResolvedValueOnce(makeList([{ name: "ORDERS" }, { name: "CUSTOMERS" }]));

      const resolver = new CompletionMetadataResolver(
        bridge,
        new CompletionWildcardResolver(),
      );

      const context: FromJoinContext = { kind: "db_dot", dbName: "ADMIN", partial: "" };
      const result1 = await resolver.resolveTablePathCompletions(
        context,
        [],
        docUri,
        "MYDB",
        "netezza",
      );

      expect(sendRequest).toHaveBeenCalledTimes(2);
      expect(result1).toEqual([
        { label: "ORDERS", kind: CompletionItemKind.Class, detail: undefined, sortText: "3_ORDERS", insertText: "ORDERS" },
        { label: "CUSTOMERS", kind: CompletionItemKind.Class, detail: undefined, sortText: "3_CUSTOMERS", insertText: "CUSTOMERS" },
      ]);

      // Second call: cached
      const result2 = await resolver.resolveTablePathCompletions(
        context,
        [],
        docUri,
        "MYDB",
        "netezza",
      );

      expect(sendRequest).toHaveBeenCalledTimes(2);
      expect(result2).toEqual(result1);
    });

    it("G3: db_dot — schemas when qualifier matches a known database", async () => {
      sendRequest
        .mockResolvedValueOnce(makeList([{ name: "MYDB" }, { name: "OTHER" }]))
        .mockResolvedValueOnce(makeList([{ name: "PUBLIC" }, { name: "ADMIN" }]));

      const resolver = new CompletionMetadataResolver(
        bridge,
        new CompletionWildcardResolver(),
      );

      const context: FromJoinContext = { kind: "db_dot", dbName: "OTHER", partial: "" };
      const result1 = await resolver.resolveTablePathCompletions(
        context,
        [],
        docUri,
        "MYDB",
        "netezza",
      );

      expect(sendRequest).toHaveBeenCalledTimes(2);
      expect(result1).toEqual([
        { label: "PUBLIC", kind: CompletionItemKind.Module, detail: undefined, sortText: "3_PUBLIC", insertText: "PUBLIC" },
        { label: "ADMIN", kind: CompletionItemKind.Module, detail: undefined, sortText: "3_ADMIN", insertText: "ADMIN" },
      ]);
    });
  });
});
