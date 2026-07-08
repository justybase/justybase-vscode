import { generateRecreateTableScript } from "../schema/tableRecreator";
import { getRequiredDatabaseDdlProvider } from "../core/connectionFactory";
import { ConnectionDetails } from "../types";

jest.mock("../core/connectionFactory", () => {
  const actual = jest.requireActual("../core/connectionFactory");
  return {
    ...actual,
    getRequiredDatabaseDdlProvider: jest.fn()
  };
});
jest.mock("@justybase/netezza-driver");

const getRequiredDatabaseDdlProviderMock =
  getRequiredDatabaseDdlProvider as unknown as jest.Mock;
const quoteNameIfNeededMock = jest.fn();
const getColumnsMock = jest.fn();
const getDistributionInfoMock = jest.fn();
const getOrganizeInfoMock = jest.fn();
const getKeysInfoMock = jest.fn();
const getTableCommentMock = jest.fn();
const getTableOwnerMock = jest.fn();

const mockNzConnectionConstructor = jest.fn();

jest.mock("@justybase/netezza-driver", () => ({
  NzConnection: mockNzConnectionConstructor,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createMockConnection = (): any => ({
  connect: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
});

describe("tableRecreator", () => {
  const connectionDetails: ConnectionDetails = {
    host: "localhost",
    port: 5480,
    database: "TESTDB",
    user: "admin",
    password: "secret",
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock implementations
    quoteNameIfNeededMock.mockImplementation((name: string) => name);
    getRequiredDatabaseDdlProviderMock.mockReturnValue({
      quoteNameIfNeeded: quoteNameIfNeededMock,
      getColumns: getColumnsMock,
      getDistributionInfo: getDistributionInfoMock,
      getOrganizeInfo: getOrganizeInfoMock,
      getKeysInfo: getKeysInfoMock,
      getTableComment: getTableCommentMock,
      getTableOwner: getTableOwnerMock,
    });
  });

  describe("generateRecreateTableScript", () => {
    it("should return error when table has no columns", async () => {
      const mockConnection = createMockConnection();
      mockNzConnectionConstructor.mockReturnValue(mockConnection);
      getColumnsMock.mockResolvedValue([]);

      const result = await generateRecreateTableScript(
        connectionDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        undefined,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found or has no columns");
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it("should generate script with basic table structure", async () => {
      const mockConnection = createMockConnection();
      mockNzConnectionConstructor.mockReturnValue(mockConnection);

      getColumnsMock.mockResolvedValue([
        {
          name: "ID",
          fullTypeName: "INTEGER",
          notNull: true,
          defaultValue: null,
          description: null,
        },
        {
          name: "NAME",
          fullTypeName: "VARCHAR(100)",
          notNull: false,
          defaultValue: null,
          description: null,
        },
      ]);
      getDistributionInfoMock.mockResolvedValue([]);
      getOrganizeInfoMock.mockResolvedValue([]);
      getKeysInfoMock.mockResolvedValue(new Map());
      getTableCommentMock.mockResolvedValue(null);
      getTableOwnerMock.mockResolvedValue(null);

      const result = await generateRecreateTableScript(
        connectionDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        undefined,
      );

      expect(result.success).toBe(true);
      expect(result.sqlScript).toBeDefined();
      expect(result.sqlScript).toContain("CREATE TABLE");
      expect(result.sqlScript).toContain("ID INTEGER NOT NULL");
      expect(result.sqlScript).toContain("NAME VARCHAR(100)");
      expect(result.sqlScript).toContain("DISTRIBUTE ON RANDOM");
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it("should generate script with distribution columns", async () => {
      const mockConnection = createMockConnection();
      mockNzConnectionConstructor.mockReturnValue(mockConnection);

      getColumnsMock.mockResolvedValue([
        {
          name: "ID",
          fullTypeName: "INTEGER",
          notNull: true,
          defaultValue: null,
          description: null,
        },
      ]);
      getDistributionInfoMock.mockResolvedValue(["ID"]);
      getOrganizeInfoMock.mockResolvedValue([]);
      getKeysInfoMock.mockResolvedValue(new Map());
      getTableCommentMock.mockResolvedValue(null);
      getTableOwnerMock.mockResolvedValue(null);

      const result = await generateRecreateTableScript(
        connectionDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        undefined,
      );

      expect(result.success).toBe(true);
      expect(result.sqlScript).toContain("DISTRIBUTE ON (ID)");
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it("should generate script with organize columns", async () => {
      const mockConnection = createMockConnection();
      mockNzConnectionConstructor.mockReturnValue(mockConnection);

      getColumnsMock.mockResolvedValue([
        {
          name: "ID",
          fullTypeName: "INTEGER",
          notNull: true,
          defaultValue: null,
          description: null,
        },
      ]);
      getDistributionInfoMock.mockResolvedValue([]);
      getOrganizeInfoMock.mockResolvedValue(["ID"]);
      getKeysInfoMock.mockResolvedValue(new Map());
      getTableCommentMock.mockResolvedValue(null);
      getTableOwnerMock.mockResolvedValue(null);

      const result = await generateRecreateTableScript(
        connectionDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        undefined,
      );

      expect(result.success).toBe(true);
      expect(result.sqlScript).toContain("ORGANIZE ON (ID)");
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it("should handle columns with default values", async () => {
      const mockConnection = createMockConnection();
      mockNzConnectionConstructor.mockReturnValue(mockConnection);

      getColumnsMock.mockResolvedValue([
        {
          name: "ID",
          fullTypeName: "INTEGER",
          notNull: true,
          defaultValue: "NEXT VALUE FOR SEQ",
          description: null,
        },
      ]);
      getDistributionInfoMock.mockResolvedValue([]);
      getOrganizeInfoMock.mockResolvedValue([]);
      getKeysInfoMock.mockResolvedValue(new Map());
      getTableCommentMock.mockResolvedValue(null);
      getTableOwnerMock.mockResolvedValue(null);

      const result = await generateRecreateTableScript(
        connectionDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        undefined,
      );

      expect(result.success).toBe(true);
      expect(result.sqlScript).toContain("DEFAULT NEXT VALUE FOR SEQ");
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it("should generate script with primary key constraint", async () => {
      const mockConnection = createMockConnection();
      mockNzConnectionConstructor.mockReturnValue(mockConnection);

      const keysMap = new Map();
      keysMap.set("PK_TEST", {
        type: "PRIMARY KEY",
        typeChar: "p",
        columns: ["ID"],
        pkDatabase: null,
        pkSchema: null,
        pkRelation: null,
        pkColumns: [],
        updateType: "NO ACTION",
        deleteType: "NO ACTION",
      });

      getColumnsMock.mockResolvedValue([
        {
          name: "ID",
          fullTypeName: "INTEGER",
          notNull: true,
          defaultValue: null,
          description: null,
        },
      ]);
      getDistributionInfoMock.mockResolvedValue([]);
      getOrganizeInfoMock.mockResolvedValue([]);
      getKeysInfoMock.mockResolvedValue(keysMap);
      getTableCommentMock.mockResolvedValue(null);
      getTableOwnerMock.mockResolvedValue(null);

      const result = await generateRecreateTableScript(
        connectionDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        undefined,
      );

      expect(result.success).toBe(true);
      expect(result.sqlScript).toContain("ADD CONSTRAINT PK_TEST PRIMARY KEY");
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it("should generate script with foreign key constraint", async () => {
      const mockConnection = createMockConnection();
      mockNzConnectionConstructor.mockReturnValue(mockConnection);

      const keysMap = new Map();
      keysMap.set("FK_TEST", {
        type: "FOREIGN KEY",
        typeChar: "f",
        columns: ["REF_ID"],
        pkDatabase: "TESTDB",
        pkSchema: "OTHERSCHEMA",
        pkRelation: "REFTABLE",
        pkColumns: ["ID"],
        updateType: "CASCADE",
        deleteType: "SET NULL",
      });

      getColumnsMock.mockResolvedValue([
        {
          name: "REF_ID",
          fullTypeName: "INTEGER",
          notNull: false,
          defaultValue: null,
          description: null,
        },
      ]);
      getDistributionInfoMock.mockResolvedValue([]);
      getOrganizeInfoMock.mockResolvedValue([]);
      getKeysInfoMock.mockResolvedValue(keysMap);
      getTableCommentMock.mockResolvedValue(null);
      getTableOwnerMock.mockResolvedValue(null);

      const result = await generateRecreateTableScript(
        connectionDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        undefined,
      );

      expect(result.success).toBe(true);
      expect(result.sqlScript).toContain("ADD CONSTRAINT FK_TEST FOREIGN KEY");
      expect(result.sqlScript).toContain(
        "REFERENCES TESTDB.OTHERSCHEMA.REFTABLE",
      );
      expect(result.sqlScript).toContain(
        "ON DELETE SET NULL ON UPDATE CASCADE",
      );
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it("should handle table and column comments", async () => {
      const mockConnection = createMockConnection();
      mockNzConnectionConstructor.mockReturnValue(mockConnection);

      getColumnsMock.mockResolvedValue([
        {
          name: "ID",
          fullTypeName: "INTEGER",
          notNull: true,
          defaultValue: null,
          description: "Primary key column",
        },
      ]);
      getDistributionInfoMock.mockResolvedValue([]);
      getOrganizeInfoMock.mockResolvedValue([]);
      getKeysInfoMock.mockResolvedValue(new Map());
      getTableCommentMock.mockResolvedValue("Test table description");
      getTableOwnerMock.mockResolvedValue(null);

      const result = await generateRecreateTableScript(
        connectionDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        undefined,
      );

      expect(result.success).toBe(true);
      expect(result.sqlScript).toContain("COMMENT ON TABLE");
      expect(result.sqlScript).toContain("COMMENT ON COLUMN");
      expect(result.sqlScript).toContain("Test table description");
      expect(result.sqlScript).toContain("Primary key column");
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it("should escape single quotes in comments", async () => {
      const mockConnection = createMockConnection();
      mockNzConnectionConstructor.mockReturnValue(mockConnection);

      getColumnsMock.mockResolvedValue([
        {
          name: "NAME",
          fullTypeName: "VARCHAR(100)",
          notNull: false,
          defaultValue: null,
          description: "User's name",
        },
      ]);
      getDistributionInfoMock.mockResolvedValue([]);
      getOrganizeInfoMock.mockResolvedValue([]);
      getKeysInfoMock.mockResolvedValue(new Map());
      getTableCommentMock.mockResolvedValue("It's a test");
      getTableOwnerMock.mockResolvedValue(null);

      const result = await generateRecreateTableScript(
        connectionDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        undefined,
      );

      expect(result.success).toBe(true);
      expect(result.sqlScript).toContain("It''s a test");
      expect(result.sqlScript).toContain("User''s name");
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it("should handle table owner", async () => {
      const mockConnection = createMockConnection();
      mockNzConnectionConstructor.mockReturnValue(mockConnection);

      getColumnsMock.mockResolvedValue([
        {
          name: "ID",
          fullTypeName: "INTEGER",
          notNull: true,
          defaultValue: null,
          description: null,
        },
      ]);
      getDistributionInfoMock.mockResolvedValue([]);
      getOrganizeInfoMock.mockResolvedValue([]);
      getKeysInfoMock.mockResolvedValue(new Map());
      getTableCommentMock.mockResolvedValue(null);
      getTableOwnerMock.mockResolvedValue("ADMIN");

      const result = await generateRecreateTableScript(
        connectionDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        undefined,
      );

      expect(result.success).toBe(true);
      expect(result.sqlScript).toContain("ALTER TABLE");
      expect(result.sqlScript).toContain("OWNER TO ADMIN");
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it("should use custom new table name when provided", async () => {
      const mockConnection = createMockConnection();
      mockNzConnectionConstructor.mockReturnValue(mockConnection);

      getColumnsMock.mockResolvedValue([
        {
          name: "ID",
          fullTypeName: "INTEGER",
          notNull: true,
          defaultValue: null,
          description: null,
        },
      ]);
      getDistributionInfoMock.mockResolvedValue([]);
      getOrganizeInfoMock.mockResolvedValue([]);
      getKeysInfoMock.mockResolvedValue(new Map());
      getTableCommentMock.mockResolvedValue(null);
      getTableOwnerMock.mockResolvedValue(null);

      const result = await generateRecreateTableScript(
        connectionDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        "CUSTOM_NEW_NAME",
      );

      expect(result.success).toBe(true);
      expect(result.sqlScript).toContain("CREATE TABLE");
      expect(result.sqlScript).toContain("CUSTOM_NEW_NAME");
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it("should handle connection errors gracefully", async () => {
      mockNzConnectionConstructor.mockImplementation(() => {
        throw new Error("Connection failed");
      });

      const result = await generateRecreateTableScript(
        connectionDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        undefined,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Error generating recreate script");
    });

    it("should handle database errors during metadata retrieval", async () => {
      const mockConnection = createMockConnection();
      mockNzConnectionConstructor.mockReturnValue(mockConnection);
      getColumnsMock.mockRejectedValue(new Error("Query failed"));

      const result = await generateRecreateTableScript(
        connectionDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        undefined,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Error generating recreate script");
      expect(result.error).toContain("Query failed");
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it("should include GENERATE EXPRESS STATISTICS", async () => {
      const mockConnection = createMockConnection();
      mockNzConnectionConstructor.mockReturnValue(mockConnection);

      getColumnsMock.mockResolvedValue([
        {
          name: "ID",
          fullTypeName: "INTEGER",
          notNull: true,
          defaultValue: null,
          description: null,
        },
      ]);
      getDistributionInfoMock.mockResolvedValue([]);
      getOrganizeInfoMock.mockResolvedValue([]);
      getKeysInfoMock.mockResolvedValue(new Map());
      getTableCommentMock.mockResolvedValue(null);
      getTableOwnerMock.mockResolvedValue(null);

      const result = await generateRecreateTableScript(
        connectionDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        undefined,
      );

      expect(result.success).toBe(true);
      expect(result.sqlScript).toContain("GENERATE EXPRESS STATISTICS");
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it("should handle unique key constraints", async () => {
      const mockConnection = createMockConnection();
      mockNzConnectionConstructor.mockReturnValue(mockConnection);

      const keysMap = new Map();
      keysMap.set("UK_TEST", {
        type: "UNIQUE",
        typeChar: "u",
        columns: ["EMAIL"],
        pkDatabase: null,
        pkSchema: null,
        pkRelation: null,
        pkColumns: [],
        updateType: "NO ACTION",
        deleteType: "NO ACTION",
      });

      getColumnsMock.mockResolvedValue([
        {
          name: "EMAIL",
          fullTypeName: "VARCHAR(255)",
          notNull: true,
          defaultValue: null,
          description: null,
        },
      ]);
      getDistributionInfoMock.mockResolvedValue([]);
      getOrganizeInfoMock.mockResolvedValue([]);
      getKeysInfoMock.mockResolvedValue(keysMap);
      getTableCommentMock.mockResolvedValue(null);
      getTableOwnerMock.mockResolvedValue(null);

      const result = await generateRecreateTableScript(
        connectionDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        undefined,
      );

      expect(result.success).toBe(true);
      expect(result.sqlScript).toContain("ADD CONSTRAINT UK_TEST UNIQUE");
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it("should skip foreign keys with no PK columns", async () => {
      const mockConnection = createMockConnection();
      mockNzConnectionConstructor.mockReturnValue(mockConnection);

      const keysMap = new Map();
      keysMap.set("FK_INVALID", {
        type: "FOREIGN KEY",
        typeChar: "f",
        columns: ["REF_ID"],
        pkDatabase: "TESTDB",
        pkSchema: "OTHERSCHEMA",
        pkRelation: "REFTABLE",
        pkColumns: [], // Empty PK columns
        updateType: "NO ACTION",
        deleteType: "NO ACTION",
      });

      getColumnsMock.mockResolvedValue([
        {
          name: "REF_ID",
          fullTypeName: "INTEGER",
          notNull: false,
          defaultValue: null,
          description: null,
        },
      ]);
      getDistributionInfoMock.mockResolvedValue([]);
      getOrganizeInfoMock.mockResolvedValue([]);
      getKeysInfoMock.mockResolvedValue(keysMap);
      getTableCommentMock.mockResolvedValue(null);
      getTableOwnerMock.mockResolvedValue(null);

      const result = await generateRecreateTableScript(
        connectionDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        undefined,
      );

      expect(result.success).toBe(true);
      // FK with no PK columns should not be in the script
      expect(result.sqlScript).not.toContain("FK_INVALID");
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it("should ignore connection close errors in finally block", async () => {
      const mockConnection = createMockConnection();
      mockConnection.close.mockRejectedValue(new Error("Close failed"));
      mockNzConnectionConstructor.mockReturnValue(mockConnection);

      getColumnsMock.mockResolvedValue([
        {
          name: "ID",
          fullTypeName: "INTEGER",
          notNull: true,
          defaultValue: null,
          description: null,
        },
      ]);
      getDistributionInfoMock.mockResolvedValue([]);
      getOrganizeInfoMock.mockResolvedValue([]);
      getKeysInfoMock.mockResolvedValue(new Map());
      getTableCommentMock.mockResolvedValue(null);
      getTableOwnerMock.mockResolvedValue(null);

      // Should not throw even though close fails
      const result = await generateRecreateTableScript(
        connectionDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        undefined,
      );

      expect(result.success).toBe(true);
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it("should include INSERT and RENAME operations in script", async () => {
      const mockConnection = createMockConnection();
      mockNzConnectionConstructor.mockReturnValue(mockConnection);

      getColumnsMock.mockResolvedValue([
        {
          name: "ID",
          fullTypeName: "INTEGER",
          notNull: true,
          defaultValue: null,
          description: null,
        },
      ]);
      getDistributionInfoMock.mockResolvedValue([]);
      getOrganizeInfoMock.mockResolvedValue([]);
      getKeysInfoMock.mockResolvedValue(new Map());
      getTableCommentMock.mockResolvedValue(null);
      getTableOwnerMock.mockResolvedValue(null);

      const result = await generateRecreateTableScript(
        connectionDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        undefined,
      );

      expect(result.success).toBe(true);
      expect(result.sqlScript).toContain("INSERT INTO");
      expect(result.sqlScript).toContain("SELECT * FROM");
      expect(result.sqlScript).toContain("RENAME TO");
      expect(result.sqlScript).toContain("DROP TABLE");
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it("should use port from connection details or default to 5480", async () => {
      const mockConnection = createMockConnection();
      mockNzConnectionConstructor.mockReturnValue(mockConnection);

      getColumnsMock.mockResolvedValue([
        {
          name: "ID",
          fullTypeName: "INTEGER",
          notNull: true,
          defaultValue: null,
          description: null,
        },
      ]);
      getDistributionInfoMock.mockResolvedValue([]);
      getOrganizeInfoMock.mockResolvedValue([]);
      getKeysInfoMock.mockResolvedValue(new Map());
      getTableCommentMock.mockResolvedValue(null);
      getTableOwnerMock.mockResolvedValue(null);

      // Test with custom port
      const customPortDetails = { ...connectionDetails, port: 1234 };
      await generateRecreateTableScript(
        customPortDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        undefined,
      );

      expect(mockNzConnectionConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ port: 1234 }),
      );

      // Test with default port
      const noPortDetails = { ...connectionDetails, port: undefined };
      await generateRecreateTableScript(
        noPortDetails,
        "TESTDB",
        "TESTSCHEMA",
        "TESTTABLE",
        undefined,
      );

      expect(mockNzConnectionConstructor).toHaveBeenLastCalledWith(
        expect.objectContaining({ port: 5480 }),
      );
    });
  });
});
