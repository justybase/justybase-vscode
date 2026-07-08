/**
 * Unit tests for MetadataCache
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import * as vscode from "vscode";
import { MetadataCache } from "../metadataCache";
import {
  DatabaseMetadata,
  SchemaMetadata,
  TableMetadata,
  ProcedureMetadata,
  ColumnMetadata,
} from "../metadata/types";
import { Logger } from "../utils/logger";

// Mock vscode
jest.mock("vscode");

describe("MetadataCache", () => {
  let cache: MetadataCache;
  let mockContext: vscode.ExtensionContext;

  beforeEach(() => {
    jest.clearAllMocks();
    mockContext = {} as vscode.ExtensionContext;

    // Initialize Logger for tests
    const mockOutputChannel = {
      appendLine: jest.fn(),
      show: jest.fn(),
      dispose: jest.fn(),
    } as unknown as vscode.OutputChannel;
    Logger.initialize(mockOutputChannel);

    cache = new MetadataCache(mockContext);
  });

  describe("Basic Operations", () => {
    it("should set and get databases", () => {
      const dbs: DatabaseMetadata[] = [
        { DATABASE: "DB1", label: "DB1", kind: 17 },
        { DATABASE: "DB2", label: "DB2", kind: 17 },
      ];
      cache.setDatabases("conn1", dbs);
      expect(cache.getDatabases("conn1")).toEqual(dbs);
    });

    it("should return undefined for missing database entry", () => {
      expect(cache.getDatabases("nonexistent")).toBeUndefined();
    });

    it("should set and get schemas", () => {
      const schemas: SchemaMetadata[] = [
        { SCHEMA: "SCHEMA1", label: "SCHEMA1", kind: 17 },
        { SCHEMA: "SCHEMA2", label: "SCHEMA2", kind: 17 },
      ];
      cache.setSchemas("conn1", "DB1", schemas);
      expect(cache.getSchemas("conn1", "DB1")).toEqual(schemas);
    });

    it("should set, get, and invalidate current schema", () => {
      cache.setCurrentSchema("conn1", "DB1", "SALES");

      expect(cache.getCurrentSchema("conn1", "DB1")).toBe("SALES");

      cache.invalidateCurrentSchema("conn1", "DB1");
      expect(cache.getCurrentSchema("conn1", "DB1")).toBeUndefined();
    });

    it("should set and get tables with ID map", () => {
      const tables: TableMetadata[] = [
        { OBJNAME: "TABLE1", label: "TABLE1", objType: "TABLE", kind: 6 },
        { OBJNAME: "VIEW1", label: "VIEW1", objType: "VIEW", kind: 18 },
      ];
      const idMap = new Map<string, number>();
      idMap.set("DB1.ADMIN.TABLE1", 1001);
      idMap.set("DB1.ADMIN.VIEW1", 1002);

      cache.setTables("conn1", "DB1.ADMIN", tables, idMap);

      expect(cache.getTables("conn1", "DB1.ADMIN")).toEqual(tables);
      expect(cache.findTableId("conn1", "DB1.ADMIN.TABLE1")).toBe(1001);
    });

    it("should set and get columns", () => {
      const columns: ColumnMetadata[] = [
        {
          ATTNAME: "COL1",
          FORMAT_TYPE: "INT",
          label: "COL1",
          detail: "INT",
          kind: 5,
        },
        {
          ATTNAME: "COL2",
          FORMAT_TYPE: "TEXT",
          label: "COL2",
          detail: "TEXT",
          kind: 5,
        },
      ];
      cache.setColumns("conn1", "DB1.ADMIN.TABLE1", columns);
      expect(cache.getColumns("conn1", "DB1.ADMIN.TABLE1")).toEqual(columns);
    });

    it("should set and get procedures", () => {
      const procedures: ProcedureMetadata[] = [
        {
          PROCEDURE: "PROC1",
          PROCEDURESIGNATURE: "PROC1()",
          SCHEMA: "ADMIN",
          label: "PROC1()",
        },
      ];
      cache.setProcedures("conn1", "DB1.ADMIN", procedures);
      expect(cache.getProcedures("conn1", "DB1.ADMIN")).toEqual(procedures);
    });

    it("should clear cache", () => {
      cache.setDatabases("conn1", [
        { DATABASE: "DB1", label: "DB1", kind: 17 },
      ]);
      cache.clearCache();
      expect(cache.getDatabases("conn1")).toBeUndefined();
    });
  });

  describe("TTL Logic", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("should expire database entries after STALE_TTL", () => {
      const dbs: DatabaseMetadata[] = [
        { DATABASE: "DB1", label: "DB1", kind: 17 },
      ];
      cache.setDatabases("conn1", dbs);

      // Advance time by 25 hours (STALE_TTL = 24h for default 12h CACHE_TTL)
      jest.advanceTimersByTime(25 * 60 * 60 * 1000);

      expect(cache.getDatabases("conn1")).toBeUndefined();
    });

    it("should expire table entries after STALE_TTL", () => {
      const tables: TableMetadata[] = [
        { OBJNAME: "TABLE1", label: "TABLE1", objType: "TABLE", kind: 6 },
      ];
      cache.setTables("conn1", "DB1.ADMIN", tables, new Map());

      jest.advanceTimersByTime(25 * 60 * 60 * 1000);

      expect(cache.getTables("conn1", "DB1.ADMIN")).toBeUndefined();
      // Should also clean up ID map
      expect(cache.findTableId("conn1", "DB1.ADMIN.TABLE1")).toBeUndefined();
    });

    it("should restore name-only lookup to another schema when an older cache entry expires", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "SHARED", label: "SHARED", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.SHARED", 1]]),
      );

      // Advance 23h so S1 is stale but S2 will be fresh
      jest.advanceTimersByTime(23 * 60 * 60 * 1000);

      cache.setTables(
        "conn1",
        "DB1.S2",
        [{ OBJNAME: "SHARED", label: "SHARED", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S2.SHARED", 2]]),
      );

      // Advance 3h → S1 is 26h old (>24h STALE_TTL), S2 is 3h old (fresh)
      jest.advanceTimersByTime(3 * 60 * 60 * 1000);

      expect(cache.getTables("conn1", "DB1.S1")).toBeUndefined();
      expect(
        cache.findObjectWithType("conn1", "DB1", undefined, "SHARED"),
      ).toEqual(
        expect.objectContaining({
          objId: 2,
          schema: "S2",
        }),
      );
    });
  });

  describe("Special Retrieval Methods", () => {
    beforeEach(() => {
      const tables1: TableMetadata[] = [
        { OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 },
      ];
      const tables2: TableMetadata[] = [
        { OBJNAME: "T2", label: "T2", objType: "TABLE", kind: 6 },
      ];
      const idMap1 = new Map([["DB1.S1.T1", 101]]);
      const idMap2 = new Map([["DB1.S2.T2", 102]]);

      cache.setTables("conn1", "DB1.S1", tables1, idMap1);
      cache.setTables("conn1", "DB1.S2", tables2, idMap2);
    });

    it("getTablesAllSchemas should return tables from all schemas", () => {
      const results = cache.getTablesAllSchemas("conn1", "DB1");
      expect(results?.length).toBe(2);
      expect(
        results?.map((t) =>
          typeof t.label === "string" ? t.label : t.OBJNAME,
        ),
      ).toContain("T1");
      expect(
        results?.map((t) =>
          typeof t.label === "string" ? t.label : t.OBJNAME,
        ),
      ).toContain("T2");
    });

    it("getObjectsWithSchema should return objects with extra metadata", () => {
      const results = cache.getObjectsWithSchema("conn1", "DB1");
      expect(results.length).toBe(2);

      const r1 = results.find((r) => r.schema === "S1");
      expect(r1?.objId).toBe(101);
      expect(r1?.item.label).toBe("T1");
    });

    it("getObjectsByType should return typed objects from cached schemas", () => {
      const results = cache.getObjectsByType("conn1", "DB1", "TABLE");
      expect(results).toBeDefined();
      expect(results?.length).toBe(2);

      const cachedAgain = cache.getObjectsByType("conn1", "DB1", "TABLE");
      expect(cachedAgain).toEqual(results);
    });

    it("invalidateSchema should clear objectsByType cache for database", () => {
      cache.getObjectsByType("conn1", "DB1", "TABLE");
      expect(cache._objectsByTypeCache.size).toBeGreaterThan(0);

      cache.invalidateSchema("conn1", "DB1", "S1");
      expect(cache._objectsByTypeCache.size).toBe(0);
    });

    it("getColumnsAnySchema should find columns by table name across schemas", () => {
      const columns: ColumnMetadata[] = [
        {
          ATTNAME: "C1",
          FORMAT_TYPE: "INT",
          label: "C1",
          detail: "INT",
          kind: 5,
        },
      ];
      cache.setColumns("conn1", "DB1.S1.T1", columns);

      const result = cache.getColumnsAnySchema("conn1", "DB1", "T1");
      expect(result).toEqual(columns);
    });

    it("getColumnsAnySchema should resolve unquoted table names case-insensitively", () => {
      const columns: ColumnMetadata[] = [
        {
          ATTNAME: "UP_COL",
          FORMAT_TYPE: "INT",
          label: "UP_COL",
          detail: "INT",
          kind: 5,
        },
      ];
      cache.setColumns("conn1", "DB1.ADMIN.ORDERS", columns);

      expect(cache.getColumnsAnySchema("conn1", "DB1", "orders")).toEqual(
        columns,
      );
      expect(cache.getColumnsAnySchema("conn1", "DB1", "ORDERS")).toEqual(
        columns,
      );
    });
  });

  describe("Dead database tracking", () => {
    it("should clear dead databases on clearCache", async () => {
      cache.markDatabaseDead("conn1", "GHOST_DB");
      expect(cache.isDatabaseDead("conn1", "GHOST_DB")).toBe(true);

      await cache.clearCache();

      expect(cache.isDatabaseDead("conn1", "GHOST_DB")).toBe(false);
    });

    it("should revive database when it appears in setDatabases", () => {
      cache.markDatabaseDead("conn1", "DB1");
      expect(cache.isDatabaseDead("conn1", "DB1")).toBe(true);

      cache.setDatabases("conn1", [{ DATABASE: "DB1", label: "DB1" }]);

      expect(cache.isDatabaseDead("conn1", "DB1")).toBe(false);
    });
  });

  describe("Search and Lookup", () => {
    it("findObjectWithType should return correct metadata", () => {
      const tables: TableMetadata[] = [
        { OBJNAME: "MY_TABLE", label: "MY_TABLE", objType: "TABLE", kind: 6 },
      ];
      const idMap = new Map([["DB1.ADMIN.MY_TABLE", 5001]]);
      cache.setTables("conn1", "DB1.ADMIN", tables, idMap);

      const info = cache.findObjectWithType(
        "conn1",
        "DB1",
        "ADMIN",
        "MY_TABLE",
      );
      expect(info).toBeDefined();
      expect(info?.objId).toBe(5001);
      expect(info?.objType).toBe("TABLE");
      expect(info?.schema).toBe("ADMIN");
    });

    it("findObjectWithType should work without schema name", () => {
      const tables: TableMetadata[] = [
        { OBJNAME: "MY_TABLE", label: "MY_TABLE", objType: "TABLE", kind: 6 },
      ];
      const idMap = new Map([["DB1.ADMIN.MY_TABLE", 5001]]);
      cache.setTables("conn1", "DB1.ADMIN", tables, idMap);

      const info = cache.findObjectWithType(
        "conn1",
        "DB1",
        undefined,
        "MY_TABLE",
      );
      expect(info).toBeDefined();
      expect(info?.objId).toBe(5001);
    });

    it("findObjectWithType should preserve schema-aware lookup for all-schema caches", () => {
      const tables: TableMetadata[] = [
        {
          OBJNAME: "EMPLOYEES",
          OBJID: 7001,
          SCHEMA: "JZN71862",
          label: "EMPLOYEES",
          objType: "TABLE",
          kind: 6,
        },
      ];
      const idMap = new Map([["BLUDB.JZN71862.EMPLOYEES", 7001]]);
      cache.setTables("conn1", "BLUDB..", tables, idMap);

      const info = cache.findObjectWithType(
        "conn1",
        "BLUDB",
        "JZN71862",
        "EMPLOYEES",
      );
      expect(info).toBeDefined();
      expect(info?.objId).toBe(7001);
      expect(info?.schema).toBe("JZN71862");
    });

    it("getObjectsByType should preserve per-item schemas for all-schema caches", () => {
      const tables: TableMetadata[] = [
        {
          OBJNAME: "EMPLOYEES",
          OBJID: 7001,
          SCHEMA: "JZN71862",
          label: "EMPLOYEES",
          objType: "TABLE",
          kind: 6,
        },
      ];
      const idMap = new Map([["BLUDB.JZN71862.EMPLOYEES", 7001]]);
      cache.setTables("conn1", "BLUDB..", tables, idMap);

      const objects = cache.getObjectsByType("conn1", "BLUDB", "TABLE");
      expect(objects).toEqual([
        expect.objectContaining({
          schema: "JZN71862",
          objId: 7001,
        }),
      ]);
    });
  });

  describe("Invalidation", () => {
    it("invalidateSchema should remove specific entries", () => {
      cache.setTables(
        "conn1",
        "DB1.ADMIN",
        [{ OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 }],
        new Map(),
      );

      cache.invalidateSchema("conn1", "DB1", "ADMIN");

      expect(cache.getTables("conn1", "DB1.ADMIN")).toBeUndefined();
    });

    it("invalidateSchema should fire onDidInvalidate event", () => {
      const listener = jest.fn();
      cache.onDidInvalidate(listener);

      cache.setTables(
        "conn1",
        "DB1.ADMIN",
        [{ OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 }],
        new Map(),
      );
      cache.invalidateSchema("conn1", "DB1", "ADMIN");

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("invalidateSchema should remove lookup index entries", () => {
      const tables: TableMetadata[] = [
        { OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 },
      ];
      const idMap = new Map([["DB1.ADMIN.T1", 100]]);
      cache.setTables("conn1", "DB1.ADMIN", tables, idMap);

      expect(
        cache.findObjectWithType("conn1", "DB1", "ADMIN", "T1"),
      ).toBeDefined();
      expect(
        cache.findObjectWithType("conn1", "DB1", undefined, "T1"),
      ).toBeDefined();

      cache.invalidateSchema("conn1", "DB1", "ADMIN");

      expect(
        cache.findObjectWithType("conn1", "DB1", "ADMIN", "T1"),
      ).toBeUndefined();
      expect(
        cache.findObjectWithType("conn1", "DB1", undefined, "T1"),
      ).toBeUndefined();
    });

    it("invalidateSchema should not affect other schemas", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.T1", 1]]),
      );
      cache.setTables(
        "conn1",
        "DB1.S2",
        [{ OBJNAME: "T2", label: "T2", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S2.T2", 2]]),
      );

      cache.invalidateSchema("conn1", "DB1", "S1");

      expect(cache.getTables("conn1", "DB1.S1")).toBeUndefined();
      expect(cache.getTables("conn1", "DB1.S2")).toBeDefined();
    });

    it("invalidateSchema should preserve shared name-only lookup from remaining schemas", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "SHARED", label: "SHARED", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.SHARED", 1]]),
      );
      cache.setTables(
        "conn1",
        "DB1.S2",
        [{ OBJNAME: "SHARED", label: "SHARED", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S2.SHARED", 2]]),
      );

      cache.invalidateSchema("conn1", "DB1", "S1");

      expect(
        cache.findObjectWithType("conn1", "DB1", undefined, "SHARED"),
      ).toEqual(
        expect.objectContaining({
          objId: 2,
          schema: "S2",
        }),
      );
    });

    it("invalidateSchema should evict aggregated all-schema table cache entries", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [
          {
            OBJNAME: "T1",
            SCHEMA: "S1",
            label: "T1",
            objType: "TABLE",
            kind: 6,
          },
        ],
        new Map([["DB1.S1.T1", 1]]),
      );
      cache.setTables(
        "conn1",
        "DB1.S2",
        [
          {
            OBJNAME: "T2",
            SCHEMA: "S2",
            label: "T2",
            objType: "TABLE",
            kind: 6,
          },
        ],
        new Map([["DB1.S2.T2", 2]]),
      );
      cache.setTables(
        "conn1",
        "DB1..",
        [
          {
            OBJNAME: "T1",
            SCHEMA: "S1",
            label: "T1",
            objType: "TABLE",
            kind: 6,
          },
          {
            OBJNAME: "T2",
            SCHEMA: "S2",
            label: "T2",
            objType: "TABLE",
            kind: 6,
          },
        ],
        new Map([
          ["DB1.S1.T1", 1],
          ["DB1.S2.T2", 2],
        ]),
      );

      cache.invalidateSchema("conn1", "DB1", "S1");

      expect(cache.getTables("conn1", "DB1..")).toBeUndefined();
      expect(cache.getTablesAllSchemas("conn1", "DB1")).toEqual([
        expect.objectContaining({
          OBJNAME: "T2",
          SCHEMA: "S2",
        }),
      ]);
    });

    it("invalidateSchema should clear schema-specific and schema-less column cache entries for the invalidated schema", () => {
      const s1Columns: ColumnMetadata[] = [
        {
          ATTNAME: "COL_S1",
          FORMAT_TYPE: "INT",
          label: "COL_S1",
          detail: "INT",
          kind: 5,
        },
      ];
      const s2Columns: ColumnMetadata[] = [
        {
          ATTNAME: "COL_S2",
          FORMAT_TYPE: "INT",
          label: "COL_S2",
          detail: "INT",
          kind: 5,
        },
      ];
      const allSchemaColumns: ColumnMetadata[] = [
        {
          ATTNAME: "COL_ANY",
          FORMAT_TYPE: "INT",
          label: "COL_ANY",
          detail: "INT",
          kind: 5,
        },
      ];

      cache.setColumns("conn1", "DB1.S1.SHARED", s1Columns);
      cache.setColumns("conn1", "DB1.S2.SHARED", s2Columns);
      cache.setColumns("conn1", "DB1..SHARED", allSchemaColumns);

      cache.invalidateSchema("conn1", "DB1", "S1");

      expect(cache.getColumns("conn1", "DB1.S1.SHARED")).toBeUndefined();
      expect(cache.getColumns("conn1", "DB1..SHARED")).toBeUndefined();
      expect(cache.getColumns("conn1", "DB1.S2.SHARED")).toEqual(s2Columns);
    });

    it("clearCache should fire onDidInvalidate event", () => {
      const listener = jest.fn();
      cache.onDidInvalidate(listener);

      cache.clearCache();

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe("Merge Semantics", () => {
    it("setTables for one schema should not replace another schema", () => {
      const tables1: TableMetadata[] = [
        { OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 },
      ];
      const tables2: TableMetadata[] = [
        { OBJNAME: "T2", label: "T2", objType: "VIEW", kind: 18 },
      ];
      cache.setTables("conn1", "DB1.S1", tables1, new Map([["DB1.S1.T1", 1]]));
      cache.setTables("conn1", "DB1.S2", tables2, new Map([["DB1.S2.T2", 2]]));

      // Both schemas should coexist
      expect(cache.getTables("conn1", "DB1.S1")).toEqual(tables1);
      expect(cache.getTables("conn1", "DB1.S2")).toEqual(tables2);

      // Both should appear in all-schemas view
      const all = cache.getTablesAllSchemas("conn1", "DB1");
      expect(all?.length).toBe(2);
    });

    it("setTables should replace stale lookup indexes on re-set for same schema", () => {
      const tables1: TableMetadata[] = [
        { OBJNAME: "OLD_TABLE", label: "OLD_TABLE", objType: "TABLE", kind: 6 },
      ];
      cache.setTables(
        "conn1",
        "DB1.S1",
        tables1,
        new Map([["DB1.S1.OLD_TABLE", 1]]),
      );
      expect(
        cache.findObjectWithType("conn1", "DB1", "S1", "OLD_TABLE"),
      ).toBeDefined();

      // Re-set same schema with new table
      const tables2: TableMetadata[] = [
        { OBJNAME: "NEW_TABLE", label: "NEW_TABLE", objType: "TABLE", kind: 6 },
      ];
      cache.setTables(
        "conn1",
        "DB1.S1",
        tables2,
        new Map([["DB1.S1.NEW_TABLE", 2]]),
      );

      expect(
        cache.findObjectWithType("conn1", "DB1", "S1", "NEW_TABLE"),
      ).toBeDefined();
      expect(
        cache.findObjectWithType("conn1", "DB1", "S1", "OLD_TABLE"),
      ).toBeUndefined();
      expect(
        cache.findObjectWithType("conn1", "DB1", undefined, "OLD_TABLE"),
      ).toBeUndefined();
    });

    it("getTablesAllSchemas should deduplicate same-name tables across schemas", () => {
      const tables1: TableMetadata[] = [
        { OBJNAME: "SHARED", label: "SHARED", objType: "TABLE", kind: 6 },
      ];
      const tables2: TableMetadata[] = [
        { OBJNAME: "SHARED", label: "SHARED", objType: "TABLE", kind: 6 },
      ];
      cache.setTables("conn1", "DB1.S1", tables1, new Map());
      cache.setTables("conn1", "DB1.S2", tables2, new Map());

      const all = cache.getTablesAllSchemas("conn1", "DB1");
      // Should deduplicate by name
      expect(all?.length).toBe(1);
    });

    it("schema-specific setTables should invalidate stale all-schemas table cache", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.T1", 1]]),
      );
      cache.setTables(
        "conn1",
        "DB1.S2",
        [{ OBJNAME: "T2", label: "T2", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S2.T2", 2]]),
      );
      cache.setTables(
        "conn1",
        "DB1..",
        [
          { OBJNAME: "T1", SCHEMA: "S1", label: "T1", objType: "TABLE", kind: 6 },
          { OBJNAME: "T2", SCHEMA: "S2", label: "T2", objType: "TABLE", kind: 6 },
        ],
        new Map([
          ["DB1.S1.T1", 1],
          ["DB1.S2.T2", 2],
        ]),
      );

      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "T3", label: "T3", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.T3", 3]]),
      );

      expect(cache.getTables("conn1", "DB1..")).toBeUndefined();
      expect(cache.getTablesAllSchemas("conn1", "DB1")).toEqual([
        expect.objectContaining({ OBJNAME: "T3" }),
        expect.objectContaining({ OBJNAME: "T2" }),
      ]);
      expect(cache.findObjectWithType("conn1", "DB1", undefined, "T1")).toBeUndefined();
    });

    it("schema-specific setColumns should invalidate stale all-schemas column cache for the same table", () => {
      cache.setColumns("conn1", "DB1.S1.SHARED", [
        {
          ATTNAME: "S1_COL",
          FORMAT_TYPE: "INT",
          label: "S1_COL",
          detail: "INT",
          kind: 5,
        },
      ]);
      cache.setColumns("conn1", "DB1.S2.SHARED", [
        {
          ATTNAME: "S2_COL",
          FORMAT_TYPE: "INT",
          label: "S2_COL",
          detail: "INT",
          kind: 5,
        },
      ]);
      cache.setColumns("conn1", "DB1..SHARED", [
        {
          ATTNAME: "AGG_COL",
          FORMAT_TYPE: "INT",
          label: "AGG_COL",
          detail: "INT",
          kind: 5,
        },
      ]);

      cache.setColumns("conn1", "DB1.S1.SHARED", [
        {
          ATTNAME: "S1_REFRESHED_COL",
          FORMAT_TYPE: "INT",
          label: "S1_REFRESHED_COL",
          detail: "INT",
          kind: 5,
        },
      ]);

      expect(cache.getColumns("conn1", "DB1..SHARED")).toBeUndefined();
      expect(cache.getColumnsAnySchema("conn1", "DB1", "SHARED")).toEqual([
        expect.objectContaining({ ATTNAME: "S1_REFRESHED_COL" }),
      ]);
    });

    it("typeGroups should merge with defaults", () => {
      // Without a connection manager the cache falls back to the default Netezza metadata provider.
      const types = ["MATERIALIZED_VIEW", "EXTERNAL_TABLE"];
      cache.setTypeGroups("conn1", "DB1", types);

      const result = cache.getTypeGroups("conn1", "DB1");
      expect(result).toBeDefined();
      // Should include both defaults and custom types
      expect(result).toContain("MATERIALIZED_VIEW");
      expect(result).toContain("EXTERNAL_TABLE");
      // Should include defaults (TABLE, VIEW are standard)
      expect(result).toContain("TABLE");
      expect(result).toContain("VIEW");
    });
  });

  describe("Observability", () => {
    it("should record miss, refresh, and hit for typeGroup cache", () => {
      const initial = cache.getTypeGroups("conn1", "DB1");
      expect(initial).toBeDefined();

      cache.setTypeGroups("conn1", "DB1", ["MATERIALIZED_VIEW"]);

      const cached = cache.getTypeGroups("conn1", "DB1");
      expect(cached).toContain("MATERIALIZED_VIEW");

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot).toBeDefined();
      expect(snapshot!.misses.typeGroup).toBe(1);
      expect(snapshot!.hits.typeGroup).toBe(1);
      expect(snapshot!.refreshOps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            layer: "typeGroup",
            key: "DB1",
          }),
        ]),
      );
    });

    it("should record hit on successful getDatabases", () => {
      cache.setDatabases("conn1", [
        { DATABASE: "DB1", label: "DB1", kind: 17 },
      ]);
      cache.getDatabases("conn1");

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot).toBeDefined();
      expect(snapshot!.hits.database).toBe(1);
      expect(snapshot!.misses.database).toBe(0);
    });

    it("should record miss on missing getDatabases", () => {
      cache.getDatabases("conn1");

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot).toBeDefined();
      expect(snapshot!.hits.database).toBe(0);
      expect(snapshot!.misses.database).toBe(1);
    });

    it("should record hit/miss for getTables", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.T1", 1]]),
      );

      cache.getTables("conn1", "DB1.S1"); // hit
      cache.getTables("conn1", "DB1.S2"); // miss

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot!.hits.table).toBe(1);
      expect(snapshot!.misses.table).toBe(1);
    });

    it("should record hit/miss for getColumns", () => {
      const columns: ColumnMetadata[] = [
        {
          ATTNAME: "C1",
          FORMAT_TYPE: "INT",
          label: "C1",
          detail: "INT",
          kind: 5,
        },
      ];
      cache.setColumns("conn1", "DB1.S1.T1", columns);

      cache.getColumns("conn1", "DB1.S1.T1"); // hit
      cache.getColumns("conn1", "DB1.S1.T2"); // miss

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot!.hits.column).toBe(1);
      expect(snapshot!.misses.column).toBe(1);
    });

    it("should record hit/miss for findObjectWithType", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.T1", 1]]),
      );

      cache.findObjectWithType("conn1", "DB1", "S1", "T1"); // hit
      cache.findObjectWithType("conn1", "DB1", "S1", "NOPE"); // miss

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot!.hits.objectLookup).toBe(1);
      expect(snapshot!.misses.objectLookup).toBe(1);
    });

    it("should record refresh on setTables", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.T1", 1]]),
      );

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot!.refreshOps.length).toBe(1);
      expect(snapshot!.refreshOps[0].layer).toBe("table");
      expect(snapshot!.refreshOps[0].key).toBe("DB1.S1");
      expect(snapshot!.refreshOps[0].entryCount).toBe(1);
    });

    it("should record refreshes for database, schema, procedure, column, and typeGroup layers", () => {
      cache.setDatabases("conn1", [{ DATABASE: "DB1", label: "DB1", kind: 17 }]);
      cache.setSchemas("conn1", "DB1", [{ SCHEMA: "S1", label: "S1", kind: 19 }]);
      cache.setProcedures("conn1", "DB1.S1", [
        {
          PROCEDURE: "PROC1",
          PROCEDURESIGNATURE: "PROC1()",
          SCHEMA: "S1",
          label: "PROC1()",
        },
      ]);
      cache.setColumns("conn1", "DB1.S1.T1", [
        {
          ATTNAME: "C1",
          FORMAT_TYPE: "INT",
          label: "C1",
          detail: "INT",
          kind: 5,
        },
      ]);
      cache.setTypeGroups("conn1", "DB1", ["MATERIALIZED_VIEW"]);

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot).toBeDefined();

      const refreshLayers = snapshot!.refreshOps.map((entry) => entry.layer);
      expect(refreshLayers).toEqual(
        expect.arrayContaining(["database", "schema", "procedure", "column", "typeGroup"]),
      );
    });

    it("should record miss, refresh, and hit for objectsByType cache", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.T1", 1]]),
      );

      const first = cache.getObjectsByType("conn1", "DB1", "TABLE");
      const second = cache.getObjectsByType("conn1", "DB1", "TABLE");

      expect(first).toBeDefined();
      expect(second).toEqual(first);

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot).toBeDefined();
      expect(snapshot!.misses.objectsByType).toBe(1);
      expect(snapshot!.hits.objectsByType).toBe(1);
      expect(snapshot!.refreshOps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            layer: "objectsByType",
            key: "DB1|TABLE",
            entryCount: 1,
          }),
        ]),
      );
    });

    it("should record totalEntries across all caches", () => {
      cache.setDatabases("conn1", [
        { DATABASE: "DB1", label: "DB1", kind: 17 },
      ]);
      cache.setSchemas("conn1", "DB1", [
        { SCHEMA: "S1", label: "S1", kind: 19 },
      ]);
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.T1", 1]]),
      );
      cache.setColumns("conn1", "DB1.S1.T1", [
        {
          ATTNAME: "C1",
          FORMAT_TYPE: "INT",
          label: "C1",
          detail: "INT",
          kind: 5,
        },
      ]);
      cache.setTypeGroups("conn1", "DB1", ["MATERIALIZED_VIEW"]);

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot!.totalEntries).toBeGreaterThanOrEqual(7);
    });

    it("should clear stats on clearCache", () => {
      cache.setDatabases("conn1", [
        { DATABASE: "DB1", label: "DB1", kind: 17 },
      ]);
      cache.getDatabases("conn1"); // record a hit

      cache.clearCache();

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot).toBeUndefined();
    });

    it("should not throw when logStats is called", () => {
      cache.setDatabases("conn1", [
        { DATABASE: "DB1", label: "DB1", kind: 17 },
      ]);
      cache.getDatabases("conn1");

      expect(() => cache.logStats("conn1")).not.toThrow();
    });
  });

  describe("TTL Propagation to Lookup Indexes", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("should record TTL eviction in stats when table expires", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.T1", 1]]),
      );

      jest.advanceTimersByTime(25 * 60 * 60 * 1000);

      cache.getTables("conn1", "DB1.S1"); // triggers TTL eviction

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot!.ttlEvictions).toBe(1);
    });

    it("should evict lookup indexes when table cache entry expires via getTables", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.T1", 1]]),
      );

      expect(
        cache.findObjectWithType("conn1", "DB1", "S1", "T1"),
      ).toBeDefined();
      expect(
        cache.findObjectWithType("conn1", "DB1", undefined, "T1"),
      ).toBeDefined();

      jest.advanceTimersByTime(25 * 60 * 60 * 1000);

      // Access via getTables triggers removeTableCacheEntry
      expect(cache.getTables("conn1", "DB1.S1")).toBeUndefined();

      // Lookup indexes should also be cleaned
      expect(
        cache.findObjectWithType("conn1", "DB1", "S1", "T1"),
      ).toBeUndefined();
      expect(
        cache.findObjectWithType("conn1", "DB1", undefined, "T1"),
      ).toBeUndefined();
    });

    it("should evict stale entries during getTablesAllSchemas", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.T1", 1]]),
      );
      cache.setTables(
        "conn1",
        "DB1.S2",
        [{ OBJNAME: "T2", label: "T2", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S2.T2", 2]]),
      );

      // Advance 23h so S1 is stale
      jest.advanceTimersByTime(23 * 60 * 60 * 1000);

      // Refresh only S2 (resets its timestamp)
      cache.setTables(
        "conn1",
        "DB1.S2",
        [{ OBJNAME: "T2", label: "T2", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S2.T2", 2]]),
      );

      // Advance 3h → S1 is 26h old (>24h STALE_TTL), S2 is 3h old
      jest.advanceTimersByTime(3 * 60 * 60 * 1000);

      const all = cache.getTablesAllSchemas("conn1", "DB1");
      // Only T2 should remain (S1 expired)
      expect(all?.length).toBe(1);
      expect(all?.[0].OBJNAME).toBe("T2");

      // S1 lookup index should be cleaned up
      expect(
        cache.findObjectWithType("conn1", "DB1", "S1", "T1"),
      ).toBeUndefined();

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot!.ttlEvictions).toBeGreaterThanOrEqual(1);
    });

    it("should record TTL eviction when getObjectsWithSchema prunes stale table entries", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.T1", 1]]),
      );
      cache.setTables(
        "conn1",
        "DB1.S2",
        [{ OBJNAME: "T2", label: "T2", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S2.T2", 2]]),
      );

      jest.advanceTimersByTime(23 * 60 * 60 * 1000);

      cache.setTables(
        "conn1",
        "DB1.S2",
        [{ OBJNAME: "T2", label: "T2", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S2.T2", 2]]),
      );

      jest.advanceTimersByTime(3 * 60 * 60 * 1000);

      expect(cache.getObjectsWithSchema("conn1", "DB1")).toEqual([
        expect.objectContaining({
          schema: "S2",
          objId: 2,
        }),
      ]);
      expect(cache.getTables("conn1", "DB1.S1")).toBeUndefined();

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot!.ttlEvictions).toBeGreaterThanOrEqual(1);
    });

    it("should record TTL eviction when getObjectsByType prunes stale table entries", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "V1", label: "V1", objType: "VIEW", kind: 18 }],
        new Map([["DB1.S1.V1", 1]]),
      );
      cache.setTables(
        "conn1",
        "DB1.S2",
        [{ OBJNAME: "V2", label: "V2", objType: "VIEW", kind: 18 }],
        new Map([["DB1.S2.V2", 2]]),
      );

      jest.advanceTimersByTime(23 * 60 * 60 * 1000);

      cache.setTables(
        "conn1",
        "DB1.S2",
        [{ OBJNAME: "V2", label: "V2", objType: "VIEW", kind: 18 }],
        new Map([["DB1.S2.V2", 2]]),
      );

      jest.advanceTimersByTime(3 * 60 * 60 * 1000);

      expect(cache.getObjectsByType("conn1", "DB1", "VIEW")).toEqual([
        expect.objectContaining({
          schema: "S2",
          objId: 2,
        }),
      ]);
      expect(cache.getTables("conn1", "DB1.S1")).toBeUndefined();

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot!.ttlEvictions).toBeGreaterThanOrEqual(1);
    });

    it("should record TTL eviction for schemas", () => {
      cache.setSchemas("conn1", "DB1", [
        { SCHEMA: "S1", label: "S1", kind: 19 },
      ]);

      jest.advanceTimersByTime(25 * 60 * 60 * 1000);

      cache.getSchemas("conn1", "DB1");

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot!.ttlEvictions).toBeGreaterThanOrEqual(1);
    });

    it("should record TTL eviction for columns", () => {
      cache.setColumns("conn1", "DB1.S1.T1", [
        {
          ATTNAME: "C1",
          FORMAT_TYPE: "INT",
          label: "C1",
          detail: "INT",
          kind: 5,
        },
      ]);

      jest.advanceTimersByTime(25 * 60 * 60 * 1000);

      cache.getColumns("conn1", "DB1.S1.T1");

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot!.ttlEvictions).toBeGreaterThanOrEqual(1);
    });

    it("should record TTL eviction when getProceduresAllSchemas prunes stale procedure entries", () => {
      cache.setProcedures("conn1", "DB1.S1", [
        {
          PROCEDURE: "PROC1",
          PROCEDURESIGNATURE: "PROC1()",
          SCHEMA: "S1",
          label: "PROC1()",
        },
      ]);

      jest.advanceTimersByTime(25 * 60 * 60 * 1000);

      expect(cache.getProceduresAllSchemas("conn1", "DB1")).toBeUndefined();
      expect(cache._procedureCache.has("conn1|DB1.S1")).toBe(false);

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot!.ttlEvictions).toBeGreaterThanOrEqual(1);
    });

    it("should record TTL eviction when objectsByType cache entry expires", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.T1", 1]]),
      );

      expect(cache.getObjectsByType("conn1", "DB1", "TABLE")).toBeDefined();

      cache._objectsByTypeCache.set("conn1|DB1|TABLE", {
        data: cache._objectsByTypeCache.get("conn1|DB1|TABLE")!.data,
        timestamp: Date.now() - 25 * 60 * 60 * 1000,
      });

      expect(cache.getObjectsByType("conn1", "DB1", "TABLE")).toEqual([
        expect.objectContaining({ objId: 1 }),
      ]);

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot!.ttlEvictions).toBeGreaterThanOrEqual(1);
    });

    it("should evict stale schema entries during getColumnsAnySchema", () => {
      cache.setColumns("conn1", "DB1.S1.SHARED", [
        {
          ATTNAME: "S1_COL",
          FORMAT_TYPE: "INT",
          label: "S1_COL",
          detail: "INT",
          kind: 5,
        },
      ]);

      jest.advanceTimersByTime(23 * 60 * 60 * 1000);

      cache.setColumns("conn1", "DB1.S2.SHARED", [
        {
          ATTNAME: "S2_COL",
          FORMAT_TYPE: "INT",
          label: "S2_COL",
          detail: "INT",
          kind: 5,
        },
      ]);

      jest.advanceTimersByTime(3 * 60 * 60 * 1000);

      expect(cache.getColumnsAnySchema("conn1", "DB1", "SHARED")).toEqual([
        expect.objectContaining({ ATTNAME: "S2_COL" }),
      ]);
      expect(cache._columnCache.has("conn1|DB1.S1.SHARED")).toBe(false);

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot!.ttlEvictions).toBeGreaterThanOrEqual(1);
    });

    it("should evict stale duplicate schema entries even when a valid match is found first", () => {
      cache.setColumns("conn1", "DB1.S1.SHARED", [
        {
          ATTNAME: "S1_COL",
          FORMAT_TYPE: "INT",
          label: "S1_COL",
          detail: "INT",
          kind: 5,
        },
      ]);
      cache.setColumns("conn1", "DB1.S2.SHARED", [
        {
          ATTNAME: "S2_COL",
          FORMAT_TYPE: "INT",
          label: "S2_COL",
          detail: "INT",
          kind: 5,
        },
      ]);

      // Advance 25h — both S1 and S2 are older than STALE_TTL (24h)
      jest.advanceTimersByTime(25 * 60 * 60 * 1000);

      // Refreshing S1 resets its timestamp
      cache.setColumns("conn1", "DB1.S1.SHARED", [
        {
          ATTNAME: "S1_FRESH_COL",
          FORMAT_TYPE: "INT",
          label: "S1_FRESH_COL",
          detail: "INT",
          kind: 5,
        },
      ]);

      expect(cache.getColumnsAnySchema("conn1", "DB1", "SHARED")).toEqual([
        expect.objectContaining({ ATTNAME: "S1_FRESH_COL" }),
      ]);
      expect(cache._columnCache.has("conn1|DB1.S2.SHARED")).toBe(false);

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot!.ttlEvictions).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Multi-Schema Refresh Stability", () => {
    it("should not lose S2 tables when S1 is refreshed", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.T1", 1]]),
      );
      cache.setTables(
        "conn1",
        "DB1.S2",
        [{ OBJNAME: "T2", label: "T2", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S2.T2", 2]]),
      );

      // Refresh S1 with different tables
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "T1_NEW", label: "T1_NEW", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.T1_NEW", 3]]),
      );

      // S2 should be untouched
      expect(cache.getTables("conn1", "DB1.S2")).toEqual([
        expect.objectContaining({ OBJNAME: "T2" }),
      ]);
      expect(
        cache.findObjectWithType("conn1", "DB1", "S2", "T2"),
      ).toBeDefined();

      // Old T1 should be gone, new T1_NEW should exist
      expect(
        cache.findObjectWithType("conn1", "DB1", "S1", "T1"),
      ).toBeUndefined();
      expect(
        cache.findObjectWithType("conn1", "DB1", "S1", "T1_NEW"),
      ).toBeDefined();
    });

    it("should handle adding a new table to an existing schema", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.T1", 1]]),
      );

      // Re-set with old + new table
      cache.setTables(
        "conn1",
        "DB1.S1",
        [
          { OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 },
          { OBJNAME: "T2", label: "T2", objType: "VIEW", kind: 18 },
        ],
        new Map([
          ["DB1.S1.T1", 1],
          ["DB1.S1.T2", 2],
        ]),
      );

      expect(
        cache.findObjectWithType("conn1", "DB1", "S1", "T1"),
      ).toBeDefined();
      expect(
        cache.findObjectWithType("conn1", "DB1", "S1", "T2"),
      ).toBeDefined();
      expect(
        cache.findObjectWithType("conn1", "DB1", "S1", "T2")?.objType,
      ).toBe("VIEW");
    });

    it("should handle removing a table from an existing schema", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [
          { OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 },
          { OBJNAME: "T2", label: "T2", objType: "TABLE", kind: 6 },
        ],
        new Map([
          ["DB1.S1.T1", 1],
          ["DB1.S1.T2", 2],
        ]),
      );

      // Re-set with only T1
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.T1", 1]]),
      );

      expect(
        cache.findObjectWithType("conn1", "DB1", "S1", "T1"),
      ).toBeDefined();
      expect(
        cache.findObjectWithType("conn1", "DB1", "S1", "T2"),
      ).toBeUndefined();
      expect(
        cache.findObjectWithType("conn1", "DB1", undefined, "T2"),
      ).toBeUndefined();
    });
  });

  describe("DB..TABLE First-Match Stability", () => {
    it("should return first schema's object for DB..TABLE when multiple schemas have same table name", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "SHARED", label: "SHARED", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.SHARED", 1]]),
      );
      cache.setTables(
        "conn1",
        "DB1.S2",
        [{ OBJNAME: "SHARED", label: "SHARED", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S2.SHARED", 2]]),
      );

      // First-set should win for name-only index
      const result = cache.findObjectWithType(
        "conn1",
        "DB1",
        undefined,
        "SHARED",
      );
      expect(result).toBeDefined();
      expect(result?.objId).toBe(1); // S1 was set first
      expect(result?.schema).toBe("S1");
    });

    it("should update name-only index winner when first-match schema is removed", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "SHARED", label: "SHARED", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.SHARED", 1]]),
      );
      cache.setTables(
        "conn1",
        "DB1.S2",
        [{ OBJNAME: "SHARED", label: "SHARED", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S2.SHARED", 2]]),
      );

      // Remove S1
      cache.invalidateSchema("conn1", "DB1", "S1");

      // DB..SHARED should now resolve to S2
      const result = cache.findObjectWithType(
        "conn1",
        "DB1",
        undefined,
        "SHARED",
      );
      expect(result).toBeDefined();
      expect(result?.objId).toBe(2);
      expect(result?.schema).toBe("S2");
    });

    it("findTableId should work with DB..TABLE pattern", () => {
      cache.setTables(
        "conn1",
        "DB1.S1",
        [{ OBJNAME: "MY_TABLE", label: "MY_TABLE", objType: "TABLE", kind: 6 }],
        new Map([["DB1.S1.MY_TABLE", 42]]),
      );

      expect(cache.findTableId("conn1", "DB1..MY_TABLE")).toBe(42);
    });
  });

  describe("Invalidation Cascading", () => {
    it("invalidateSchema should remove procedures for the schema", () => {
      const procedures: ProcedureMetadata[] = [
        { PROCEDURE: "P1", label: "P1()", SCHEMA: "S1" },
      ];
      cache.setProcedures("conn1", "DB1.S1", procedures);

      cache.invalidateSchema("conn1", "DB1", "S1");

      expect(cache.getProcedures("conn1", "DB1.S1")).toBeUndefined();
    });

    it("invalidateSchema should also remove all-schema procedure cache", () => {
      cache.setProcedures("conn1", "DB1..", [
        { PROCEDURE: "P1", label: "P1()" },
      ]);
      cache.setProcedures("conn1", "DB1.S1", [
        { PROCEDURE: "P1", label: "P1()", SCHEMA: "S1" },
      ]);

      cache.invalidateSchema("conn1", "DB1", "S1");

      expect(cache.getProcedures("conn1", "DB1..")).toBeUndefined();
    });

    it("getProceduresForDatabase falls back to per-schema layers when aggregate was invalidated", () => {
      cache.setProcedures("conn1", "DB1..", [
        { PROCEDURE: "P1", label: "P1()" },
        { PROCEDURE: "P2", label: "P2()" },
      ]);
      cache.setProcedures("conn1", "DB1.S1", [
        { PROCEDURE: "P3", label: "P3()", SCHEMA: "S1" },
      ]);

      expect(cache.getProcedures("conn1", "DB1..")).toBeUndefined();
      expect(cache.getProceduresForDatabase("conn1", "DB1")).toEqual([
        expect.objectContaining({ PROCEDURE: "P3" }),
      ]);
    });

    it("schema-specific setProcedures should invalidate stale all-schema procedure cache", () => {
      cache.setProcedures("conn1", "DB1..", [
        { PROCEDURE: "P1", label: "P1()" },
        { PROCEDURE: "P2", label: "P2()" },
      ]);
      cache.setProcedures("conn1", "DB1.S1", [
        { PROCEDURE: "P3", label: "P3()", SCHEMA: "S1" },
      ]);

      expect(cache.getProcedures("conn1", "DB1..")).toBeUndefined();
      expect(cache.getProcedures("conn1", "DB1.S1")).toEqual([
        expect.objectContaining({ PROCEDURE: "P3" }),
      ]);
    });

    it("invalidateSchema should remove column cache for the schema", () => {
      cache.setColumns("conn1", "DB1.S1.T1", [
        {
          ATTNAME: "C1",
          FORMAT_TYPE: "INT",
          label: "C1",
          detail: "INT",
          kind: 5,
        },
      ]);
      cache.setColumns("conn1", "DB1.S1.T2", [
        {
          ATTNAME: "C2",
          FORMAT_TYPE: "TEXT",
          label: "C2",
          detail: "TEXT",
          kind: 5,
        },
      ]);

      cache.invalidateSchema("conn1", "DB1", "S1");

      expect(cache.getColumns("conn1", "DB1.S1.T1")).toBeUndefined();
      expect(cache.getColumns("conn1", "DB1.S1.T2")).toBeUndefined();
    });

    it("invalidateSchema should preserve columns for other schemas", () => {
      cache.setColumns("conn1", "DB1.S1.T1", [
        {
          ATTNAME: "C1",
          FORMAT_TYPE: "INT",
          label: "C1",
          detail: "INT",
          kind: 5,
        },
      ]);
      cache.setColumns("conn1", "DB1.S2.T2", [
        {
          ATTNAME: "C2",
          FORMAT_TYPE: "TEXT",
          label: "C2",
          detail: "TEXT",
          kind: 5,
        },
      ]);

      cache.invalidateSchema("conn1", "DB1", "S1");

      expect(cache.getColumns("conn1", "DB1.S1.T1")).toBeUndefined();
      expect(cache.getColumns("conn1", "DB1.S2.T2")).toBeDefined();
    });

    it("invalidateSchema without schema name should remove all-schemas entry", () => {
      cache.setTables(
        "conn1",
        "DB1..",
        [
          {
            OBJNAME: "T1",
            SCHEMA: "S1",
            label: "T1",
            objType: "TABLE",
            kind: 6,
          },
          {
            OBJNAME: "T2",
            SCHEMA: "S2",
            label: "T2",
            objType: "TABLE",
            kind: 6,
          },
        ],
        new Map([
          ["DB1.S1.T1", 1],
          ["DB1.S2.T2", 2],
        ]),
      );

      cache.invalidateSchema("conn1", "DB1");

      expect(cache.getTables("conn1", "DB1..")).toBeUndefined();
    });
  });

  describe("Large Schema Simulation", () => {
    it("should handle 1000 tables across 10 schemas without error", () => {
      const schemasCount = 10;
      const tablesPerSchema = 100;

      for (let s = 0; s < schemasCount; s++) {
        const schema = `S${s}`;
        const tables: TableMetadata[] = [];
        const idMap = new Map<string, number>();

        for (let t = 0; t < tablesPerSchema; t++) {
          const name = `TABLE_${s}_${t}`;
          tables.push({
            OBJNAME: name,
            label: name,
            objType: t % 3 === 0 ? "VIEW" : "TABLE",
            kind: t % 3 === 0 ? 18 : 6,
            SCHEMA: schema,
          });
          idMap.set(`DB1.${schema}.${name}`, s * 1000 + t);
        }

        cache.setTables("conn1", `DB1.${schema}`, tables, idMap);
      }

      // All schemas should be queryable
      const allTables = cache.getTablesAllSchemas("conn1", "DB1");
      expect(allTables?.length).toBe(schemasCount * tablesPerSchema);

      // Random lookups should work
      expect(
        cache.findObjectWithType("conn1", "DB1", "S5", "TABLE_5_42"),
      ).toBeDefined();
      expect(
        cache.findObjectWithType("conn1", "DB1", undefined, "TABLE_3_7"),
      ).toBeDefined();

      // getObjectsByType should filter correctly
      const views = cache.getObjectsByType("conn1", "DB1", "VIEW");
      expect(views).toBeDefined();
      // ~1/3 are views (indices 0, 3, 6, ...)
      expect(views!.length).toBeGreaterThan(0);
      for (const v of views!) {
        expect(v.item.objType).toBe("VIEW");
      }

      // Stats should show refreshes
      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot).toBeDefined();
      const refreshLayers = snapshot!.refreshOps.map((entry) => entry.layer);
      expect(
        refreshLayers.filter((layer) => layer === "table"),
      ).toHaveLength(schemasCount);
      expect(refreshLayers).toContain("objectsByType");
    });

    it("should handle invalidating a large schema without losing others", () => {
      for (let s = 0; s < 5; s++) {
        const tables: TableMetadata[] = [];
        const idMap = new Map<string, number>();
        for (let t = 0; t < 50; t++) {
          const name = `T_${s}_${t}`;
          tables.push({
            OBJNAME: name,
            label: name,
            objType: "TABLE",
            kind: 6,
            SCHEMA: `S${s}`,
          });
          idMap.set(`DB1.S${s}.${name}`, s * 100 + t);
        }
        cache.setTables("conn1", `DB1.S${s}`, tables, idMap);
      }

      // Invalidate S2
      cache.invalidateSchema("conn1", "DB1", "S2");

      // S2 should be gone
      expect(cache.getTables("conn1", "DB1.S2")).toBeUndefined();

      // Other schemas should remain
      expect(cache.getTables("conn1", "DB1.S0")?.length).toBe(50);
      expect(cache.getTables("conn1", "DB1.S4")?.length).toBe(50);

      // S2 lookups should fail
      expect(
        cache.findObjectWithType("conn1", "DB1", "S2", "T_2_0"),
      ).toBeUndefined();
      // Other lookups should succeed
      expect(
        cache.findObjectWithType("conn1", "DB1", "S0", "T_0_0"),
      ).toBeDefined();
    });
  });

  describe("Repeated setTables Merge Correctness", () => {
    it("should correctly rebuild indexes when setTables is called twice for same key", () => {
      // First set
      cache.setTables(
        "conn1",
        "DB1.S1",
        [
          { OBJNAME: "A", label: "A", objType: "TABLE", kind: 6 },
          { OBJNAME: "B", label: "B", objType: "TABLE", kind: 6 },
        ],
        new Map([
          ["DB1.S1.A", 1],
          ["DB1.S1.B", 2],
        ]),
      );

      // Second set (B removed, C added)
      cache.setTables(
        "conn1",
        "DB1.S1",
        [
          { OBJNAME: "A", label: "A", objType: "TABLE", kind: 6 },
          { OBJNAME: "C", label: "C", objType: "TABLE", kind: 6 },
        ],
        new Map([
          ["DB1.S1.A", 1],
          ["DB1.S1.C", 3],
        ]),
      );

      expect(cache.findObjectWithType("conn1", "DB1", "S1", "A")).toBeDefined();
      expect(
        cache.findObjectWithType("conn1", "DB1", "S1", "B"),
      ).toBeUndefined();
      expect(cache.findObjectWithType("conn1", "DB1", "S1", "C")).toBeDefined();

      // Name-only lookups
      expect(
        cache.findObjectWithType("conn1", "DB1", undefined, "A"),
      ).toBeDefined();
      expect(
        cache.findObjectWithType("conn1", "DB1", undefined, "B"),
      ).toBeUndefined();
      expect(
        cache.findObjectWithType("conn1", "DB1", undefined, "C"),
      ).toBeDefined();

      // ID lookups
      expect(cache.findTableId("conn1", "DB1.S1.A")).toBe(1);
      expect(cache.findTableId("conn1", "DB1.S1.C")).toBe(3);
    });

    it("should record two refresh operations for two setTables calls", () => {
      cache.setTables("conn1", "DB1.S1", [], new Map());
      cache.setTables("conn1", "DB1.S1", [], new Map());

      const snapshot = cache.getStatsSnapshot("conn1");
      expect(snapshot!.refreshOps.length).toBe(2);
    });
  });
});

describe("Concurrent Schema Refresh Simulation", () => {
  let cache: MetadataCache;
  let mockContext: vscode.ExtensionContext;

  beforeEach(() => {
    jest.clearAllMocks();
    mockContext = {} as vscode.ExtensionContext;
    const mockOutputChannel = {
      appendLine: jest.fn(),
      show: jest.fn(),
      dispose: jest.fn(),
    } as unknown as vscode.OutputChannel;
    Logger.initialize(mockOutputChannel);
    cache = new MetadataCache(mockContext);
  });

  it("should handle interleaved setTables calls for different schemas without cross-contamination", () => {
    cache.setTables(
      "conn1",
      "DB1.S1",
      [{ OBJNAME: "T1_S1_V1", label: "T1_S1_V1", objType: "TABLE", kind: 6 }],
      new Map([["DB1.S1.T1_S1_V1", 101]]),
    );

    cache.setTables(
      "conn1",
      "DB1.S2",
      [{ OBJNAME: "T1_S2_V1", label: "T1_S2_V1", objType: "TABLE", kind: 6 }],
      new Map([["DB1.S2.T1_S2_V1", 201]]),
    );

    cache.setTables(
      "conn1",
      "DB1.S1",
      [{ OBJNAME: "T1_S1_V2", label: "T1_S1_V2", objType: "TABLE", kind: 6 }],
      new Map([["DB1.S1.T1_S1_V2", 102]]),
    );

    cache.setTables(
      "conn1",
      "DB1.S3",
      [{ OBJNAME: "T1_S3_V1", label: "T1_S3_V1", objType: "TABLE", kind: 6 }],
      new Map([["DB1.S3.T1_S3_V1", 301]]),
    );

    expect(
      cache.findObjectWithType("conn1", "DB1", "S1", "T1_S1_V1"),
    ).toBeUndefined();
    expect(
      cache.findObjectWithType("conn1", "DB1", "S1", "T1_S1_V2"),
    ).toBeDefined();
    expect(
      cache.findObjectWithType("conn1", "DB1", "S2", "T1_S2_V1"),
    ).toBeDefined();
    expect(
      cache.findObjectWithType("conn1", "DB1", "S3", "T1_S3_V1"),
    ).toBeDefined();

    expect(cache.getTables("conn1", "DB1.S1")?.length).toBe(1);
    expect(cache.getTables("conn1", "DB1.S2")?.length).toBe(1);
    expect(cache.getTables("conn1", "DB1.S3")?.length).toBe(1);
  });

  it("should maintain name-only index integrity during rapid schema refreshes", () => {
    cache.setTables(
      "conn1",
      "DB1.S1",
      [
        { OBJNAME: "COMMON", label: "COMMON", objType: "TABLE", kind: 6 },
        { OBJNAME: "S1_ONLY", label: "S1_ONLY", objType: "TABLE", kind: 6 },
      ],
      new Map([
        ["DB1.S1.COMMON", 1],
        ["DB1.S1.S1_ONLY", 2],
      ]),
    );

    const firstCommon = cache.findObjectWithType(
      "conn1",
      "DB1",
      undefined,
      "COMMON",
    );
    expect(firstCommon?.objId).toBe(1);

    cache.setTables(
      "conn1",
      "DB1.S2",
      [
        { OBJNAME: "COMMON", label: "COMMON", objType: "TABLE", kind: 6 },
        { OBJNAME: "S2_ONLY", label: "S2_ONLY", objType: "TABLE", kind: 6 },
      ],
      new Map([
        ["DB1.S2.COMMON", 3],
        ["DB1.S2.S2_ONLY", 4],
      ]),
    );

    const stillFirstCommon = cache.findObjectWithType(
      "conn1",
      "DB1",
      undefined,
      "COMMON",
    );
    expect(stillFirstCommon?.objId).toBe(1);

    cache.setTables(
      "conn1",
      "DB1.S1",
      [{ OBJNAME: "S1_NEW", label: "S1_NEW", objType: "TABLE", kind: 6 }],
      new Map([["DB1.S1.S1_NEW", 5]]),
    );

    const nowSecondCommon = cache.findObjectWithType(
      "conn1",
      "DB1",
      undefined,
      "COMMON",
    );
    expect(nowSecondCommon?.objId).toBe(3);

    expect(
      cache.findObjectWithType("conn1", "DB1", undefined, "S1_ONLY"),
    ).toBeUndefined();
    expect(
      cache.findObjectWithType("conn1", "DB1", undefined, "S2_ONLY"),
    ).toBeDefined();
  });

  it("should correctly update objectsByType cache after multiple schema refreshes", () => {
    cache.setTables(
      "conn1",
      "DB1.S1",
      [{ OBJNAME: "V1", label: "V1", objType: "VIEW", kind: 18 }],
      new Map([["DB1.S1.V1", 1]]),
    );

    const viewsFirst = cache.getObjectsByType("conn1", "DB1", "VIEW");
    expect(viewsFirst?.length).toBe(1);

    cache.setTables(
      "conn1",
      "DB1.S2",
      [{ OBJNAME: "V2", label: "V2", objType: "VIEW", kind: 18 }],
      new Map([["DB1.S2.V2", 2]]),
    );

    const viewsSecond = cache.getObjectsByType("conn1", "DB1", "VIEW");
    expect(viewsSecond?.length).toBe(2);

    cache.setTables(
      "conn1",
      "DB1.S1",
      [{ OBJNAME: "T1", label: "T1", objType: "TABLE", kind: 6 }],
      new Map([["DB1.S1.T1", 3]]),
    );

    const viewsAfterS1Refresh = cache.getObjectsByType("conn1", "DB1", "VIEW");
    expect(viewsAfterS1Refresh?.length).toBe(1);
    expect(viewsAfterS1Refresh?.[0].item.OBJNAME).toBe("V2");
  });
});
