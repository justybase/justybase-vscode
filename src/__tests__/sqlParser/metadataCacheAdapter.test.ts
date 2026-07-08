import {
  MetadataCacheSchemaProvider,
  createMetadataCacheSchemaProvider,
} from "../../sqlParser/metadataCacheAdapter";
import type { MetadataCache } from "../../metadataCache";
import type { ColumnMetadata, DatabaseMetadata } from "../../metadata/types";
import type { ConnectionManager } from "../../core/connectionManager";

describe("MetadataCacheSchemaProvider", () => {
  const createMockCache = (
    overrides: Partial<MetadataCache> = {},
  ): MetadataCache => {
    return {
      getDatabases: jest.fn(
        () =>
          [
            { DATABASE: "TESTDB" },
            { DATABASE: "TESTDB2" },
          ] as DatabaseMetadata[],
      ),
      getTables: jest.fn(),
      getTablesAllSchemas: jest.fn(),
      getColumns: jest.fn(),
      getColumnsAnySchema: jest.fn(),
      ...overrides,
    } as MetadataCache;
  };

  const createMockConnectionManager = (
    activeConnection?: string,
  ): ConnectionManager => {
    return {
      getActiveConnectionName: jest.fn(() => activeConnection),
    getConnectionMetadata: jest.fn(() => ({ database: "TESTDB" })),
    } as unknown as ConnectionManager;
  };

  describe("getTable", () => {
    it("should return table info when columns are in cache", () => {
      const mockCache = createMockCache({
        getColumns: jest.fn(
          () => [{ ATTNAME: "COL1" }, { ATTNAME: "COL2" }] as ColumnMetadata[],
        ),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.getTable("TESTDB", "PUBLIC", "EMPLOYEES");

      expect(result).toBeDefined();
      expect(result?.name).toBe("EMPLOYEES");
      expect(result?.database).toBe("TESTDB");
      expect(result?.schema).toBe("PUBLIC");
      expect(result?.columns).toHaveLength(2);
      expect(result?.columns[0].name).toBe("COL1");
    });

    it("should resolve uppercase cache keys when SQL identifiers are lowercase", () => {
      const columnStore = new Map<string, ColumnMetadata[]>([
        [
          "CONN_1|DB1.PUBLIC.ORDERS",
          [{ ATTNAME: "ID", FORMAT_TYPE: "INT4" } as ColumnMetadata],
        ],
      ]);
      const mockCache = createMockCache({
        getColumns: jest.fn((connectionName: string, key: string) =>
          columnStore.get(`${connectionName}|${key}`),
        ),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.getTable("db1", "public", "orders");

      expect(mockCache.getColumns).toHaveBeenCalledWith(
        "CONN_1",
        "DB1.PUBLIC.ORDERS",
      );
      expect(result?.columns).toEqual([
        { name: "ID", dataType: "INT4" },
      ]);
    });

    it("should return undefined when no active connection", () => {
      const mockCache = createMockCache();
      const mockConnManager = createMockConnectionManager(undefined);
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.getTable("TESTDB", "PUBLIC", "EMPLOYEES");

      expect(result).toBeUndefined();
    });

    it("should return undefined when columns not in cache", () => {
      const mockCache = createMockCache({
        getColumns: jest.fn(() => undefined),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.getTable("TESTDB", "PUBLIC", "UNKNOWN_TABLE");

      expect(result).toBeUndefined();
    });

    it("should search across schemas when database is provided but not schema", () => {
      const mockCache = createMockCache({
        getColumnsAnySchema: jest.fn(
          () => [{ ATTNAME: "ID" }] as ColumnMetadata[],
        ),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.getTable("TESTDB", undefined, "EMPLOYEES");

      expect(mockCache.getColumnsAnySchema).toHaveBeenCalledWith(
        "CONN_1",
        "TESTDB",
        "EMPLOYEES",
      );
      expect(result).toBeDefined();
    });

    it("should preserve FORMAT_TYPE as column dataType for type-aware validation", () => {
      const mockCache = createMockCache({
        getColumnsAnySchema: jest.fn(
          () =>
            [
              { ATTNAME: "ACCOUNTCODEALTERNATEKEY", FORMAT_TYPE: "INTEGER" },
            ] as ColumnMetadata[],
        ),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.getTable("JUST_DATA", undefined, "DIMACCOUNT");

      expect(result?.columns[0]).toEqual({
        name: "ACCOUNTCODEALTERNATEKEY",
        dataType: "INTEGER",
      });
    });

    it("should resolve quoted table name when looking up columns", () => {
      const mockCache = createMockCache({
        getColumnsAnySchema: jest.fn(
          () => [{ ATTNAME: "ID" }] as ColumnMetadata[],
        ),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.getTable("TESTDB", undefined, '"lower_case_name"');

      expect(mockCache.getColumnsAnySchema).toHaveBeenCalledWith(
        "CONN_1",
        "TESTDB",
        "lower_case_name",
      );
      expect(result).toBeDefined();
    });

    it("should use defaultConnectionName when provided", () => {
      const mockCache = createMockCache({
        getColumns: jest.fn(() => [{ ATTNAME: "ID" }] as ColumnMetadata[]),
      });
      const mockConnManager = createMockConnectionManager("ACTIVE_CONN");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
        "DEFAULT_CONN",
      );

      provider.getTable("TESTDB", "PUBLIC", "EMPLOYEES");

      expect(mockCache.getColumns).toHaveBeenCalledWith(
        "DEFAULT_CONN",
        "TESTDB.PUBLIC.EMPLOYEES",
      );
    });
  });

  describe("tableExists", () => {
    it("should return true when table exists with full path DB.SCHEMA.TABLE", () => {
      const mockCache = createMockCache({
        getTables: jest.fn(() => [{ OBJNAME: "EMPLOYEES" }]),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.tableExists("TESTDB", "PUBLIC", "EMPLOYEES");

      expect(result).toBe(true);
    });

    it("should return false when table does not exist with full path", () => {
      const mockCache = createMockCache({
        getTables: jest.fn(() => [{ OBJNAME: "OTHER_TABLE" }]),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.tableExists("TESTDB", "PUBLIC", "EMPLOYEES");

      expect(result).toBe(false);
    });

    it("should return true for DB..TABLE pattern", () => {
      const mockCache = createMockCache({
        getTablesAllSchemas: jest.fn(() => [{ OBJNAME: "EMPLOYEES" }]),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.tableExists("TESTDB", undefined, "EMPLOYEES");

      expect(result).toBe(true);
    });

    it("should treat mirrored system catalog objects as available across cached databases", () => {
      const mockCache = createMockCache({
        getDatabases: jest.fn(() => [{ DATABASE: "TESTDB" }, { DATABASE: "SYSTEM" }]),
        getTablesAllSchemas: jest.fn((_conn: string, db: string) => {
          if (db === "TESTDB") {
            return [{ OBJNAME: "EMPLOYEES" }];
          }
          if (db === "SYSTEM") {
            return [{ OBJNAME: "_V_SESSION" }];
          }
          return undefined;
        }),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.tableExists("TESTDB", undefined, "_V_SESSION");

      expect(result).toBe(true);
    });

    it("should match quoted table names against cache values without quotes", () => {
      const mockCache = createMockCache({
        getTablesAllSchemas: jest.fn(() => [{ OBJNAME: "lower_case_name" }]),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.tableExists(
        "TESTDB",
        undefined,
        '"lower_case_name"',
      );

      expect(result).toBe(true);
    });

    it("should return true when no active connection (assumes table exists)", () => {
      const mockCache = createMockCache();
      const mockConnManager = createMockConnectionManager(undefined);
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.tableExists("TESTDB", "PUBLIC", "EMPLOYEES");

      expect(result).toBe(true);
    });

    it("should search across databases when only schema provided", () => {
      const mockCache = createMockCache({
        getDatabases: jest.fn(() => [{ DATABASE: "DB1" }, { DATABASE: "DB2" }]),
        getTables: jest.fn((_conn: string, key: string) => {
          if (key === "DB1.PUBLIC") return [{ OBJNAME: "EMPLOYEES" }];
          return undefined;
        }),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.tableExists(undefined, "PUBLIC", "EMPLOYEES");

      expect(result).toBe(true);
    });

    it("should return true when cache returns undefined (unknown)", () => {
      const mockCache = createMockCache({
        getTables: jest.fn(() => undefined),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.tableExists("TESTDB", "PUBLIC", "EMPLOYEES");

      expect(result).toBe(true);
    });

    it("should return false when database does not exist in cached list (3-part name)", () => {
      const mockCache = createMockCache({
        getDatabases: jest.fn(
          () =>
            [
              { DATABASE: "TESTDB" },
              { DATABASE: "TESTDB2" },
            ] as DatabaseMetadata[],
        ),
        getTables: jest.fn(() => undefined),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.tableExists(
        "NO_SUCH_DATABSE",
        "ADMIN",
        "FACT_SALES_2",
      );

      expect(result).toBe(false);
    });

    it("should return true for known database even when schema tables not cached (3-part name)", () => {
      const mockCache = createMockCache({
        getDatabases: jest.fn(
          () =>
            [
              { DATABASE: "TESTDB" },
              { DATABASE: "TESTDB2" },
            ] as DatabaseMetadata[],
        ),
        getTables: jest.fn(() => undefined),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.tableExists("TESTDB", "PUBLIC", "EMPLOYEES");

      expect(result).toBe(true);
    });

    it("should return false when database does not exist (double-dot pattern)", () => {
      const mockCache = createMockCache({
        getDatabases: jest.fn(
          () =>
            [
              { DATABASE: "TESTDB" },
            ] as DatabaseMetadata[],
        ),
        getTablesAllSchemas: jest.fn(() => undefined),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.tableExists(
        "NO_SUCH_DATABSE",
        undefined,
        "SOME_TABLE",
      );

      expect(result).toBe(false);
    });

    it("should return false for known database with uncached table list (double-dot pattern)", () => {
      const mockCache = createMockCache({
        getDatabases: jest.fn(
          () =>
            [
              { DATABASE: "JUST_DATA" },
            ] as DatabaseMetadata[],
        ),
        getTablesAllSchemas: jest.fn(() => undefined),
        getColumnsAnySchema: jest.fn(() => undefined),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.tableExists(
        "JUST_DATA",
        undefined,
        "NO_SUCH_TABLE",
      );

      expect(result).toBe(false);
    });

    it("should still return true for unknown database when database list is not yet cached", () => {
      const mockCache = createMockCache({
        getDatabases: jest.fn(() => undefined),
        getTables: jest.fn(() => undefined),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.tableExists(
        "NO_SUCH_DATABSE",
        "ADMIN",
        "FACT_SALES_2",
      );

      expect(result).toBe(true);
    });
  });

  describe("canValidateUnqualifiedTableReferences", () => {
    it("should return true when preferred database has cached tables", () => {
      const mockCache = createMockCache({
        getDatabases: jest.fn(() => [{ DATABASE: "SINGLE_DB" }]),
        getTablesAllSchemas: jest.fn(() => [{ OBJNAME: "TABLE1" }]),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      expect(provider.canValidateUnqualifiedTableReferences()).toBe(true);
    });

    it("should return false when no active connection", () => {
      const mockCache = createMockCache();
      const mockConnManager = createMockConnectionManager(undefined);
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      expect(provider.canValidateUnqualifiedTableReferences()).toBe(false);
    });

    it("should return true when any database has cached tables", () => {
      const mockCache = createMockCache({
        getDatabases: jest.fn(() => [{ DATABASE: "DB1" }, { DATABASE: "DB2" }]),
        getTablesAllSchemas: jest.fn((_conn: string, db: string) => {
          if (db === "DB1") return [{ OBJNAME: "T1" }];
          return undefined;
        }),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      expect(provider.canValidateUnqualifiedTableReferences()).toBe(true);
    });

    it("should return false when no databases have cached tables", () => {
      const mockCache = createMockCache({
        getDatabases: jest.fn(() => [{ DATABASE: "DB1" }]),
        getTablesAllSchemas: jest.fn(() => undefined),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      expect(provider.canValidateUnqualifiedTableReferences()).toBe(false);
    });
  });

  describe("getDatabases", () => {
    it("should return list of database names", () => {
      const mockCache = createMockCache({
        getDatabases: jest.fn(() => [{ DATABASE: "DB1" }, { DATABASE: "DB2" }]),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.getDatabases();

      expect(result).toEqual(["DB1", "DB2"]);
    });

    it("should return undefined when no active connection", () => {
      const mockCache = createMockCache();
      const mockConnManager = createMockConnectionManager(undefined);
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.getDatabases();

      expect(result).toBeUndefined();
    });

    it("should return undefined when getDatabases returns undefined", () => {
      const mockCache = createMockCache({
        getDatabases: jest.fn(() => undefined),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.getDatabases();

      expect(result).toBeUndefined();
    });

    it("should handle databases with label property", () => {
      const mockCache = createMockCache({
        getDatabases: jest.fn(
          () => [{ label: "DB_WITH_LABEL" }] as DatabaseMetadata[],
        ),
      });
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.getDatabases();

      expect(result).toEqual(["DB_WITH_LABEL"]);
    });
  });

  describe("getTablesInSchema", () => {
    it("should return empty array (not implemented)", () => {
      const mockCache = createMockCache();
      const mockConnManager = createMockConnectionManager("CONN_1");
      const provider = new MetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
      );

      const result = provider.getTablesInSchema("TESTDB", "PUBLIC");

      expect(result).toEqual([]);
    });
  });

  describe("createMetadataCacheSchemaProvider factory", () => {
    it("should create a SchemaProvider instance", () => {
      const mockCache = createMockCache();
      const mockConnManager = createMockConnectionManager("CONN_1");

      const provider = createMetadataCacheSchemaProvider(
        mockCache,
        mockConnManager,
        "DEFAULT",
      );

      expect(provider).toBeDefined();
      expect(provider.tableExists).toBeDefined();
      expect(provider.getTable).toBeDefined();
    });
  });
});
