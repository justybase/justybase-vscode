import * as vscode from "vscode";
import {
  getForeignKeysForSchema,
  getTablesInSchema,
  buildERDData,
} from "../schema/erdProvider";
import { ConnectionManager } from "../core/connectionManager";
import { runQueryRaw, queryResultToRows } from "../core/queryRunner";
import { NZ_QUERIES } from "../metadata/systemQueries";

jest.mock("../core/queryRunner");
jest.mock("../metadata/systemQueries");

const runQueryRawMock = runQueryRaw as jest.MockedFunction<typeof runQueryRaw>;
const queryResultToRowsMock = queryResultToRows as jest.MockedFunction<
  typeof queryResultToRows
>;
const getForeignKeyRelationshipsMock =
  NZ_QUERIES.getForeignKeyRelationships as jest.MockedFunction<
    typeof NZ_QUERIES.getForeignKeyRelationships
  >;

describe("erdProvider", () => {
  let mockContext: vscode.ExtensionContext;
  let mockConnectionManager: jest.Mocked<ConnectionManager>;
  let mockProgress: jest.Mocked<
    vscode.Progress<{ message?: string; increment?: number }>
  >;

  beforeEach(() => {
    jest.clearAllMocks();

    mockContext = {
      extensionUri: { fsPath: "/test" },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;

    mockConnectionManager = {
      getConnection: jest.fn(),
      setConnection: jest.fn(),
    } as unknown as jest.Mocked<ConnectionManager>;

    mockProgress = {
      report: jest.fn(),
    } as unknown as jest.Mocked<
      vscode.Progress<{ message?: string; increment?: number }>
    >;
  });

  describe("getForeignKeysForSchema", () => {
    it("should return empty array when no data is returned", async () => {
      getForeignKeyRelationshipsMock.mockReturnValue("SELECT * FROM FK_QUERY");
      runQueryRawMock.mockResolvedValue({ columns: [], data: [] });

      const result = await getForeignKeysForSchema(
        mockContext,
        mockConnectionManager,
        "test-connection",
        "TESTDB",
        "TESTSCHEMA",
      );

      expect(result).toEqual([]);
      expect(getForeignKeyRelationshipsMock).toHaveBeenCalledWith(
        "TESTDB",
        "TESTSCHEMA",
      );
    });

    it("should return empty array when data is null", async () => {
      getForeignKeyRelationshipsMock.mockReturnValue("SELECT * FROM FK_QUERY");
      runQueryRawMock.mockResolvedValue({ columns: [], data: [] });

      const result = await getForeignKeysForSchema(
        mockContext,
        mockConnectionManager,
        "test-connection",
        "TESTDB",
        "TESTSCHEMA",
      );

      expect(result).toEqual([]);
    });

    it("should group multiple columns into single relationship", async () => {
      getForeignKeyRelationshipsMock.mockReturnValue("SELECT * FROM FK_QUERY");

      const mockRows = [
        {
          CONSTRAINTNAME: "FK_ORDERS_CUSTOMERS",
          SCHEMA: "SALES",
          FROM_TABLE: "ORDERS",
          FROM_COLUMN: "CUSTOMER_ID",
          PKDATABASE: "TESTDB",
          PKSCHEMA: "SALES",
          TO_TABLE: "CUSTOMERS",
          TO_COLUMN: "ID",
          UPDT_TYPE: "CASCADE",
          DEL_TYPE: "SET NULL",
          CONSEQ: 1,
        },
        {
          CONSTRAINTNAME: "FK_ORDERS_CUSTOMERS",
          SCHEMA: "SALES",
          FROM_TABLE: "ORDERS",
          FROM_COLUMN: "REGION_ID",
          PKDATABASE: "TESTDB",
          PKSCHEMA: "SALES",
          TO_TABLE: "CUSTOMERS",
          TO_COLUMN: "REGION_CODE",
          UPDT_TYPE: "CASCADE",
          DEL_TYPE: "SET NULL",
          CONSEQ: 2,
        },
      ];

      runQueryRawMock.mockResolvedValue({
        columns: [
          { name: "CONSTRAINTNAME" },
          { name: "SCHEMA" },
          { name: "FROM_TABLE" },
          { name: "FROM_COLUMN" },
        ],
        data: [[]],
      });
      queryResultToRowsMock.mockReturnValue(mockRows as Record<string, unknown>[]);

      const result = await getForeignKeysForSchema(
        mockContext,
        mockConnectionManager,
        "test-connection",
        "TESTDB",
        "TESTSCHEMA",
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        constraintName: "FK_ORDERS_CUSTOMERS",
        fromTable: "SALES.ORDERS",
        toTable: "SALES.CUSTOMERS",
        fromColumns: ["CUSTOMER_ID", "REGION_ID"],
        toColumns: ["ID", "REGION_CODE"],
        onDelete: "SET NULL",
        onUpdate: "CASCADE",
      });
    });

    it("should handle errors gracefully and return empty array", async () => {
      getForeignKeyRelationshipsMock.mockReturnValue("SELECT * FROM FK_QUERY");
      runQueryRawMock.mockRejectedValue(new Error("Database error"));

      const result = await getForeignKeysForSchema(
        mockContext,
        mockConnectionManager,
        "test-connection",
        "TESTDB",
        "TESTSCHEMA",
      );

      expect(result).toEqual([]);
    });

    it("should handle multiple separate relationships", async () => {
      getForeignKeyRelationshipsMock.mockReturnValue("SELECT * FROM FK_QUERY");

      const mockRows = [
        {
          CONSTRAINTNAME: "FK_ORDERS_CUSTOMERS",
          SCHEMA: "SALES",
          FROM_TABLE: "ORDERS",
          FROM_COLUMN: "CUSTOMER_ID",
          PKDATABASE: "TESTDB",
          PKSCHEMA: "SALES",
          TO_TABLE: "CUSTOMERS",
          TO_COLUMN: "ID",
          UPDT_TYPE: "NO ACTION",
          DEL_TYPE: "NO ACTION",
          CONSEQ: 1,
        },
        {
          CONSTRAINTNAME: "FK_ITEMS_PRODUCTS",
          SCHEMA: "SALES",
          FROM_TABLE: "ITEMS",
          FROM_COLUMN: "PRODUCT_ID",
          PKDATABASE: "TESTDB",
          PKSCHEMA: "INVENTORY",
          TO_TABLE: "PRODUCTS",
          TO_COLUMN: "ID",
          UPDT_TYPE: "CASCADE",
          DEL_TYPE: "CASCADE",
          CONSEQ: 1,
        },
      ];

      runQueryRawMock.mockResolvedValue({
        columns: [{ name: "CONSTRAINTNAME" }],
        data: [[]],
      });
      queryResultToRowsMock.mockReturnValue(mockRows as Record<string, unknown>[]);

      const result = await getForeignKeysForSchema(
        mockContext,
        mockConnectionManager,
        "test-connection",
        "TESTDB",
        "TESTSCHEMA",
      );

      expect(result).toHaveLength(2);
      expect(result[0].constraintName).toBe("FK_ORDERS_CUSTOMERS");
      expect(result[1].constraintName).toBe("FK_ITEMS_PRODUCTS");
    });

    it("should use default values for missing update/delete types", async () => {
      getForeignKeyRelationshipsMock.mockReturnValue("SELECT * FROM FK_QUERY");

      const mockRows = [
        {
          CONSTRAINTNAME: "FK_TEST",
          SCHEMA: "SALES",
          FROM_TABLE: "TABLE1",
          FROM_COLUMN: "COL1",
          PKDATABASE: "TESTDB",
          PKSCHEMA: "SALES",
          TO_TABLE: "TABLE2",
          TO_COLUMN: "COL2",
          UPDT_TYPE: null,
          DEL_TYPE: null,
          CONSEQ: 1,
        },
      ];

      runQueryRawMock.mockResolvedValue({
        columns: [{ name: "CONSTRAINTNAME" }],
        data: [[]],
      });
      queryResultToRowsMock.mockReturnValue(mockRows as Record<string, unknown>[]);

      const result = await getForeignKeysForSchema(
        mockContext,
        mockConnectionManager,
        "test-connection",
        "TESTDB",
        "TESTSCHEMA",
      );

      expect(result[0].onDelete).toBe("NO ACTION");
      expect(result[0].onUpdate).toBe("NO ACTION");
    });
  });

  describe("getTablesInSchema", () => {
    it("should return empty array when tables query fails", async () => {
      runQueryRawMock.mockRejectedValue(new Error("Connection failed"));

      const result = await getTablesInSchema(
        mockContext,
        mockConnectionManager,
        "test-connection",
        "TESTDB",
        "TESTSCHEMA",
        mockProgress,
      );

      expect(result).toEqual([]);
    });

    it("should return tables with columns and primary keys", async () => {
      const mockTables = [{ TABLENAME: "CUSTOMERS", OWNER: "ADMIN", DATABASE: "TESTDB" }];

      const mockColumns = [
        { TABLENAME: "CUSTOMERS", ATTNAME: "ID", FORMAT_TYPE: "INTEGER" },
        {
          TABLENAME: "CUSTOMERS",
          ATTNAME: "NAME",
          FORMAT_TYPE: "VARCHAR(100)",
        },
      ];

      const mockPKs = [{ RELATION: "CUSTOMERS", ATTNAME: "ID" }];

      runQueryRawMock
        .mockResolvedValueOnce({
          columns: [{ name: "TABLENAME" }, { name: "OWNER" }, { name: "DATABASE" }],
          data: [[]],
        })
        .mockResolvedValueOnce({
          columns: [
            { name: "TABLENAME" },
            { name: "ATTNAME" },
            { name: "FORMAT_TYPE" },
          ],
          data: [[]],
        })
        .mockResolvedValueOnce({
          columns: [{ name: "RELATION" }, { name: "ATTNAME" }],
          data: [[]],
        });

      queryResultToRowsMock
        .mockReturnValueOnce(mockTables as Record<string, unknown>[])
        .mockReturnValueOnce(mockColumns as Record<string, unknown>[])
        .mockReturnValueOnce(mockPKs as Record<string, unknown>[]);

      const result = await getTablesInSchema(
        mockContext,
        mockConnectionManager,
        "test-connection",
        "TESTDB",
        "TESTSCHEMA",
        mockProgress,
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        database: "TESTDB",
        schema: "TESTSCHEMA",
        tableName: "CUSTOMERS",
        fullName: "TESTDB.TESTSCHEMA.CUSTOMERS",
        primaryKeyColumns: ["ID"],
      });
      expect(result[0].columns).toHaveLength(2);
      expect(result[0].columns[0].isPrimaryKey).toBe(true);
      expect(result[0].columns[1].isPrimaryKey).toBe(false);
    });

    it("should handle multiple tables", async () => {
      const mockTables = [
        { TABLENAME: "CUSTOMERS", OWNER: "ADMIN" },
        { TABLENAME: "ORDERS", OWNER: "ADMIN" },
        { TABLENAME: "PRODUCTS", OWNER: "ADMIN" },
      ];

      const mockColumns = [
        { TABLENAME: "CUSTOMERS", ATTNAME: "ID", FORMAT_TYPE: "INTEGER" },
        { TABLENAME: "ORDERS", ATTNAME: "ID", FORMAT_TYPE: "INTEGER" },
        { TABLENAME: "ORDERS", ATTNAME: "CUSTOMER_ID", FORMAT_TYPE: "INTEGER" },
        { TABLENAME: "PRODUCTS", ATTNAME: "ID", FORMAT_TYPE: "INTEGER" },
      ];

      const mockPKs = [
        { RELATION: "CUSTOMERS", ATTNAME: "ID" },
        { RELATION: "ORDERS", ATTNAME: "ID" },
        { RELATION: "PRODUCTS", ATTNAME: "ID" },
      ];

      runQueryRawMock
        .mockResolvedValueOnce({
          columns: [{ name: "TABLENAME" }, { name: "OWNER" }, { name: "DATABASE" }],
          data: [[]],
        })
        .mockResolvedValueOnce({
          columns: [
            { name: "TABLENAME" },
            { name: "ATTNAME" },
            { name: "FORMAT_TYPE" },
          ],
          data: [[]],
        })
        .mockResolvedValueOnce({
          columns: [{ name: "RELATION" }, { name: "ATTNAME" }],
          data: [[]],
        });

      queryResultToRowsMock
        .mockReturnValueOnce(mockTables as Record<string, unknown>[])
        .mockReturnValueOnce(mockColumns as Record<string, unknown>[])
        .mockReturnValueOnce(mockPKs as Record<string, unknown>[]);

      const result = await getTablesInSchema(
        mockContext,
        mockConnectionManager,
        "test-connection",
        "TESTDB",
        "TESTSCHEMA",
      );

      expect(result).toHaveLength(3);
      expect(result.map((t) => t.tableName)).toEqual([
        "CUSTOMERS",
        "ORDERS",
        "PRODUCTS",
      ]);
    });

    it("should report progress during data fetching", async () => {
      const mockTables = [{ TABLENAME: "TEST", OWNER: "ADMIN" }];
      const mockColumns: unknown[] = [];
      const mockPKs: unknown[] = [];

      runQueryRawMock
        .mockResolvedValueOnce({
          columns: [{ name: "TABLENAME" }, { name: "OWNER" }, { name: "DATABASE" }],
          data: [[]],
        })
        .mockResolvedValueOnce({
          columns: [
            { name: "TABLENAME" },
            { name: "ATTNAME" },
            { name: "FORMAT_TYPE" },
          ],
          data: [[]],
        })
        .mockResolvedValueOnce({
          columns: [{ name: "RELATION" }, { name: "ATTNAME" }],
          data: [[]],
        });

      queryResultToRowsMock
        .mockReturnValueOnce(mockTables as Record<string, unknown>[])
        .mockReturnValueOnce(mockColumns as Record<string, unknown>[])
        .mockReturnValueOnce(mockPKs as Record<string, unknown>[]);

      await getTablesInSchema(
        mockContext,
        mockConnectionManager,
        "test-connection",
        "TESTDB",
        "TESTSCHEMA",
        mockProgress,
      );

      expect(mockProgress.report).toHaveBeenCalledWith({
        message: "Fetching tables list...",
      });
      expect(mockProgress.report).toHaveBeenCalledWith({
        message: "Fetching columns...",
      });
      expect(mockProgress.report).toHaveBeenCalledWith({
        message: "Fetching primary keys...",
      });
    });

    it("should handle columns for non-existent tables gracefully", async () => {
      const mockTables = [{ TABLENAME: "EXISTING", OWNER: "ADMIN" }];
      const mockColumns = [
        { TABLENAME: "NON_EXISTENT", ATTNAME: "COL1", FORMAT_TYPE: "INTEGER" },
      ];
      const mockPKs: unknown[] = [];

      runQueryRawMock
        .mockResolvedValueOnce({
          columns: [{ name: "TABLENAME" }, { name: "OWNER" }, { name: "DATABASE" }],
          data: [[]],
        })
        .mockResolvedValueOnce({
          columns: [
            { name: "TABLENAME" },
            { name: "ATTNAME" },
            { name: "FORMAT_TYPE" },
          ],
          data: [[]],
        })
        .mockResolvedValueOnce({
          columns: [{ name: "RELATION" }, { name: "ATTNAME" }],
          data: [[]],
        });

      queryResultToRowsMock
        .mockReturnValueOnce(mockTables as Record<string, unknown>[])
        .mockReturnValueOnce(mockColumns as Record<string, unknown>[])
        .mockReturnValueOnce(mockPKs as Record<string, unknown>[]);

      const result = await getTablesInSchema(
        mockContext,
        mockConnectionManager,
        "test-connection",
        "TESTDB",
        "TESTSCHEMA",
      );

      expect(result).toHaveLength(1);
      expect(result[0].columns).toHaveLength(0);
    });

    it("should handle primary keys for non-existent tables gracefully", async () => {
      const mockTables = [{ TABLENAME: "EXISTING", OWNER: "ADMIN" }];
      const mockColumns = [
        { TABLENAME: "EXISTING", ATTNAME: "ID", FORMAT_TYPE: "INTEGER" },
      ];
      const mockPKs = [{ RELATION: "NON_EXISTENT", ATTNAME: "ID" }];

      runQueryRawMock
        .mockResolvedValueOnce({
          columns: [{ name: "TABLENAME" }, { name: "OWNER" }, { name: "DATABASE" }],
          data: [[]],
        })
        .mockResolvedValueOnce({
          columns: [
            { name: "TABLENAME" },
            { name: "ATTNAME" },
            { name: "FORMAT_TYPE" },
          ],
          data: [[]],
        })
        .mockResolvedValueOnce({
          columns: [{ name: "RELATION" }, { name: "ATTNAME" }],
          data: [[]],
        });

      queryResultToRowsMock
        .mockReturnValueOnce(mockTables as Record<string, unknown>[])
        .mockReturnValueOnce(mockColumns as Record<string, unknown>[])
        .mockReturnValueOnce(mockPKs as Record<string, unknown>[]);

      const result = await getTablesInSchema(
        mockContext,
        mockConnectionManager,
        "test-connection",
        "TESTDB",
        "TESTSCHEMA",
      );

      expect(result).toHaveLength(1);
      expect(result[0].primaryKeyColumns).toHaveLength(0);
      expect(result[0].columns[0].isPrimaryKey).toBe(false);
    });
  });

  describe("buildERDData", () => {
    it("should build complete ERD data with tables and relationships", async () => {
      const mockTablesRows = [
        { TABLENAME: "ORDERS" },
        { TABLENAME: "CUSTOMERS" },
      ];
      const mockColumnsRows: unknown[] = [];
      const mockPKRows: unknown[] = [];
      const mockFKRows: unknown[] = [];

      runQueryRawMock
        .mockResolvedValueOnce({ columns: [{ name: "TABLENAME" }], data: [[]] })
        .mockResolvedValueOnce({
          columns: [
            { name: "TABLENAME" },
            { name: "ATTNAME" },
            { name: "FORMAT_TYPE" },
          ],
          data: [[]],
        })
        .mockResolvedValueOnce({
          columns: [{ name: "RELATION" }, { name: "ATTNAME" }],
          data: [[]],
        })
        .mockResolvedValueOnce({
          columns: [{ name: "CONSTRAINTNAME" }],
          data: [[]],
        });

      getForeignKeyRelationshipsMock.mockReturnValue("FK_QUERY");
      queryResultToRowsMock
        .mockReturnValueOnce(mockTablesRows as Record<string, unknown>[])
        .mockReturnValueOnce(mockColumnsRows as Record<string, unknown>[])
        .mockReturnValueOnce(mockPKRows as Record<string, unknown>[])
        .mockReturnValueOnce(mockFKRows as Record<string, unknown>[]);

      const result = await buildERDData(
        mockContext,
        mockConnectionManager,
        "test-connection",
        "TESTDB",
        "TESTSCHEMA",
        mockProgress,
      );

      expect(result).toMatchObject({
        database: "TESTDB",
        schema: "TESTSCHEMA",
      });
      expect(result.tables).toBeDefined();
      expect(result.relationships).toBeDefined();
    });

    it("should return empty relationships when FK query fails", async () => {
      runQueryRawMock
        .mockResolvedValueOnce({ columns: [{ name: "TABLENAME" }], data: [[]] })
        .mockResolvedValueOnce({
          columns: [
            { name: "TABLENAME" },
            { name: "ATTNAME" },
            { name: "FORMAT_TYPE" },
          ],
          data: [[]],
        })
        .mockResolvedValueOnce({
          columns: [{ name: "RELATION" }, { name: "ATTNAME" }],
          data: [[]],
        })
        .mockRejectedValueOnce(new Error("FK query failed"));

      getForeignKeyRelationshipsMock.mockReturnValue("FK_QUERY");
      queryResultToRowsMock
        .mockReturnValueOnce([{ TABLENAME: "TEST" }] as Record<string, unknown>[])
        .mockReturnValueOnce([] as Record<string, unknown>[])
        .mockReturnValueOnce([] as Record<string, unknown>[])
        .mockReturnValueOnce([] as Record<string, unknown>[]);

      const result = await buildERDData(
        mockContext,
        mockConnectionManager,
        "test-connection",
        "TESTDB",
        "TESTSCHEMA",
      );

      expect(result.tables).toBeDefined();
      expect(result.relationships).toEqual([]);
    });

    it("should filter tables to only those in relationships when more than 20 tables", async () => {
      const mockTablesRows = Array.from({ length: 25 }, (_, i) => ({
        TABLENAME: `TABLE${i}`,
        OWNER: "ADMIN",
      }));

      const mockFKRows = [
        {
          CONSTRAINTNAME: "FK_TEST",
          SCHEMA: "TESTSCHEMA",
          FROM_TABLE: "TABLE0",
          FROM_COLUMN: "COL1",
          PKDATABASE: "TESTDB",
          PKSCHEMA: "TESTSCHEMA",
          TO_TABLE: "TABLE1",
          TO_COLUMN: "ID",
          UPDT_TYPE: "NO ACTION",
          DEL_TYPE: "NO ACTION",
          CONSEQ: 1,
        },
      ];

      runQueryRawMock
        .mockResolvedValueOnce({
          columns: [{ name: "TABLENAME" }, { name: "OWNER" }, { name: "DATABASE" }],
          data: [[]],
        })
        .mockResolvedValueOnce({
          columns: [{ name: "TABLENAME" }, { name: "ATTNAME" }],
          data: [[]],
        })
        .mockResolvedValueOnce({
          columns: [{ name: "RELATION" }, { name: "ATTNAME" }],
          data: [[]],
        })
        .mockResolvedValueOnce({
          columns: [{ name: "CONSTRAINTNAME" }],
          data: [[]],
        });

      getForeignKeyRelationshipsMock.mockReturnValue("FK_QUERY");
      queryResultToRowsMock
        .mockReturnValueOnce(mockTablesRows as Record<string, unknown>[])
        .mockReturnValueOnce([] as Record<string, unknown>[])
        .mockReturnValueOnce([] as Record<string, unknown>[])
        .mockReturnValueOnce(mockFKRows as Record<string, unknown>[]);

      const result = await buildERDData(
        mockContext,
        mockConnectionManager,
        "test-connection",
        "TESTDB",
        "TESTSCHEMA",
      );

      expect(result.tables.length).toBeLessThan(25);
    });

    it("should return valid ERD structure", async () => {
      runQueryRawMock
        .mockResolvedValueOnce({
          columns: [{ name: "TABLENAME" }, { name: "OWNER" }, { name: "DATABASE" }],
          data: [[]],
        })
        .mockResolvedValueOnce({
          columns: [{ name: "TABLENAME" }, { name: "ATTNAME" }],
          data: [[]],
        })
        .mockResolvedValueOnce({
          columns: [{ name: "RELATION" }, { name: "ATTNAME" }],
          data: [[]],
        })
        .mockResolvedValueOnce({
          columns: [{ name: "CONSTRAINTNAME" }],
          data: [[]],
        });

      getForeignKeyRelationshipsMock.mockReturnValue("FK_QUERY");
      queryResultToRowsMock
        .mockReturnValueOnce([{ TABLENAME: "TABLE1", OWNER: "ADMIN" }] as Record<string, unknown>[])
        .mockReturnValueOnce([] as Record<string, unknown>[])
        .mockReturnValueOnce([] as Record<string, unknown>[])
        .mockReturnValueOnce([] as Record<string, unknown>[]);

      const result = await buildERDData(
        mockContext,
        mockConnectionManager,
        "test-connection",
        "TESTDB",
        "TESTSCHEMA",
      );

      expect(result).toHaveProperty("database", "TESTDB");
      expect(result).toHaveProperty("schema", "TESTSCHEMA");
      expect(result).toHaveProperty("tables");
      expect(result).toHaveProperty("relationships");
      expect(Array.isArray(result.tables)).toBe(true);
      expect(Array.isArray(result.relationships)).toBe(true);
    });
  });
});
