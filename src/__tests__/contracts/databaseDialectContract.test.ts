import {
  createDatabaseCapabilities,
  DatabaseCapabilities,
  DatabaseConnectionConfig,
  DatabaseDialect,
  DatabaseMetadataProvider,
  DatabaseSourceSearchQueryOptions,
} from "../../contracts/database";
import {
  createDatabaseConnection,
  createDatabaseConnectionFromDetails,
  getDatabaseCapabilities,
  getDatabaseConnectionConstructor,
  getDatabaseDialect,
  getDatabaseMetadataProvider,
  getDatabaseSqlAuthoring,
  getRegisteredDatabaseDialects,
} from "../../core/connectionFactory";
import { ensureBuiltInDialectsRegistered } from "../../dialects";
import { netezzaDialect } from "../../dialects/netezza";
import { sqliteDialect, SqliteConnection } from "../../dialects/sqlite";
import { resetDatabaseDialectTestingState } from "../dialectTestUtils";

const mockNzConnectionConstructor = jest.fn();

jest.mock("@justybase/netezza-driver", () => ({
  NzConnection: mockNzConnectionConstructor,
}));

function createMockNetezzaConnection(config: DatabaseConnectionConfig) {
  return {
    config,
    connect: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
    createCommand: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn(),
  };
}

function expectSqlString(query: string): void {
  expect(typeof query).toBe("string");
  expect(query.trim().length).toBeGreaterThan(0);
}

function expectMetadataProviderContract(
  provider: DatabaseMetadataProvider,
): void {
  const sourceSearchOptions: DatabaseSourceSearchQueryOptions = {
    rawTerm: "CUSTOMERS",
    likePattern: "%CUSTOMERS%",
    useServerSideFilter: true,
  };

  expect(provider.defaultObjectTypes.length).toBeGreaterThan(0);
  expect(provider.defaultColumnObjectTypes.length).toBeGreaterThan(0);

  expectSqlString(provider.buildListDatabasesQuery());
  expectSqlString(provider.buildListSchemasQuery("TESTDB"));
  expectSqlString(provider.buildListTablesQuery("TESTDB", "PUBLIC"));
  expectSqlString(provider.buildListViewsQuery("TESTDB", "PUBLIC"));
  expectSqlString(provider.buildListProceduresQuery("TESTDB", "PUBLIC"));
  expectSqlString(provider.buildObjectTypeQuery("TESTDB", "TABLE"));
  expectSqlString(provider.buildTypeGroupsQuery("TESTDB"));
  expectSqlString(
    provider.buildColumnsWithKeysQuery("TESTDB", {
      schema: "PUBLIC",
      tableName: "CUSTOMERS",
    }),
  );
  expectSqlString(
    provider.buildTableColumnsQuery("TESTDB", "PUBLIC", "CUSTOMERS"),
  );
  expectSqlString(
    provider.buildColumnMetadataQuery("TESTDB", "PUBLIC", "CUSTOMERS"),
  );
  expectSqlString(
    provider.buildLookupColumnsQuery({
      database: "TESTDB",
      schema: "PUBLIC",
      tableName: "CUSTOMERS",
      objectId: 1,
    }),
  );
  expectSqlString(
    provider.buildTableCommentQuery("TESTDB", "PUBLIC", "CUSTOMERS"),
  );
  expectSqlString(provider.buildObjectSearchQuery("TESTDB", "%CUSTOMERS%"));
  expectSqlString(
    provider.buildViewSourceSearchQuery("TESTDB", sourceSearchOptions),
  );
  expectSqlString(
    provider.buildProcedureSourceSearchQuery("TESTDB", sourceSearchOptions),
  );
}

interface DialectContractCase {
  readonly label: string;
  readonly kind: "netezza" | "sqlite";
  readonly lookupKind: string;
  readonly dialect: DatabaseDialect;
  readonly sampleConfig: DatabaseConnectionConfig;
  readonly expectedCapabilities: DatabaseCapabilities;
  readonly expectedConnectionFieldKeys: readonly string[];
  readonly validationTypeName: string;
  readonly expectedTypeCanonical: string;
  registerDialect(): void;
  assertConnectionCreated(
    connection: unknown,
    expectedConfig: DatabaseConnectionConfig,
  ): void;
  assertConnectionCreatedFromDetails(connection: unknown): void;
}

const DIALECT_CASES: readonly DialectContractCase[] = [
  {
    label: "Netezza baseline",
    kind: "netezza",
    lookupKind: "NetezzaSQL",
    dialect: netezzaDialect,
    sampleConfig: {
      host: "localhost",
      database: "TESTDB",
      user: "admin",
      password: "secret",
    },
    expectedCapabilities: createDatabaseCapabilities({
      supportsExplainPlan: true,
      supportsExplainGraph: true,
      supportsTuningAdvisor: true,
      supportsExternalTables: true,
      supportsProcedures: true,
      supportsTableMaintenance: true,
      supportsSessionMonitor: true,
    }),
    expectedConnectionFieldKeys: [
      "host",
      "port",
      "database",
      "user",
      "password",
    ],
    validationTypeName: "VARCHAR",
    expectedTypeCanonical: "VARCHAR",
    registerDialect(): void {
      ensureBuiltInDialectsRegistered();
    },
    assertConnectionCreated(
      connection: unknown,
      expectedConfig: DatabaseConnectionConfig,
    ): void {
      expect(mockNzConnectionConstructor).toHaveBeenCalledWith(expectedConfig);
      expect(connection).toMatchObject({
        createCommand: expect.any(Function),
        connect: expect.any(Function),
        close: expect.any(Function),
      });
    },
    assertConnectionCreatedFromDetails(connection: unknown): void {
      expect(mockNzConnectionConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ port: 5480 }),
      );
      expect(connection).toMatchObject({
        createCommand: expect.any(Function),
      });
    },
  },
  {
    label: "SQLite built-in runtime",
    kind: "sqlite",
    lookupKind: "sqlite3",
    dialect: sqliteDialect,
    sampleConfig: {
      host: "",
      database: ":memory:",
      user: "",
      password: "",
    },
    expectedCapabilities: createDatabaseCapabilities(),
    expectedConnectionFieldKeys: ["mode", "database"],
    validationTypeName: "INTEGER",
    expectedTypeCanonical: "INTEGER",
    registerDialect(): void {
      ensureBuiltInDialectsRegistered();
    },
    assertConnectionCreated(
      connection: unknown,
      expectedConfig: DatabaseConnectionConfig,
    ): void {
      expect(connection).toBeInstanceOf(SqliteConnection);
      expect((connection as SqliteConnection).config).toEqual(expectedConfig);
    },
    assertConnectionCreatedFromDetails(connection: unknown): void {
      expect(connection).toBeInstanceOf(SqliteConnection);
      expect((connection as SqliteConnection).config.port).toBeUndefined();
    },
  },
];

describe.each(DIALECT_CASES)("$label dialect contract", (testCase) => {
  beforeEach(() => {
    resetDatabaseDialectTestingState();
    jest.clearAllMocks();
    mockNzConnectionConstructor.mockImplementation(
      (config: DatabaseConnectionConfig) => createMockNetezzaConnection(config),
    );
  });

  it("resolves through the public factory api", () => {
    testCase.registerDialect();

    const dialect = getDatabaseDialect(testCase.lookupKind);
    const registeredKinds = getRegisteredDatabaseDialects().map(
      (item) => item.kind,
    );

    expect(dialect).toBe(testCase.dialect);
    expect(dialect.kind).toBe(testCase.kind);
    expect(registeredKinds).toContain(testCase.kind);
  });

  it("exposes the expected capability baseline", () => {
    testCase.registerDialect();

    expect(getDatabaseCapabilities(testCase.lookupKind)).toEqual(
      testCase.expectedCapabilities,
    );
  });

  it("provides a connection form schema compatible with the dialect", () => {
    testCase.registerDialect();

    const fieldKeys = getDatabaseDialect(
      testCase.lookupKind,
    ).connectionForm?.fields.map((field) => field.key);

    expect(fieldKeys).toEqual(testCase.expectedConnectionFieldKeys);
  });

  it("provides metadata provider methods that satisfy the core contract", () => {
    testCase.registerDialect();

    expectMetadataProviderContract(
      getDatabaseMetadataProvider(testCase.lookupKind),
    );
  });

  it("provides SQL authoring assets that satisfy the core contract", () => {
    testCase.registerDialect();

    const authoring = getDatabaseSqlAuthoring(testCase.lookupKind);
    const typeSpec = authoring.validation.getTypeSpec(
      testCase.validationTypeName,
    );

    expect(authoring.completionKeywords.length).toBeGreaterThan(0);
    expect(authoring.signatures).toBeInstanceOf(Map);
    expect(authoring.signatures.size).toBeGreaterThan(0);
    expect(authoring.formatter.keywords).toBeInstanceOf(Set);
    expect(authoring.formatter.clauseKeywords).toBeInstanceOf(Set);
    expect(authoring.validation.builtinFunctions).toBeInstanceOf(Set);
    expect(authoring.validation.specialBuiltinValues).toBeInstanceOf(Set);
    expect(Array.isArray(authoring.qualityRules)).toBe(true);
    expect(typeSpec?.canonical).toBe(testCase.expectedTypeCanonical);
    expect(
      typeof authoring.validation.supportsProcedureAnySizeArgument(
        testCase.validationTypeName,
      ),
    ).toBe("boolean");
  });

  it("creates connection instances through the registered dialect constructor", () => {
    testCase.registerDialect();

    const connection = createDatabaseConnection(
      testCase.sampleConfig,
      testCase.lookupKind,
    );

    expect(typeof getDatabaseConnectionConstructor(testCase.lookupKind)).toBe(
      "function",
    );
    testCase.assertConnectionCreated(connection, testCase.sampleConfig);
  });

  it("applies default ports only when the dialect defines one", () => {
    testCase.registerDialect();

    const connection = createDatabaseConnectionFromDetails({
      host: testCase.sampleConfig.host,
      database: testCase.sampleConfig.database,
      user: testCase.sampleConfig.user,
      password: testCase.sampleConfig.password,
      dbType: testCase.lookupKind,
    });

    testCase.assertConnectionCreatedFromDetails(connection);
  });
});

describe("database dialect rollout guards", () => {
  const optionalDialectKinds = [
    "duckdb",
    "oracle",
    "postgresql",
    "vertica",
    "db2",
    "mssql",
    "mysql",
  ] as const;

  beforeEach(() => {
    resetDatabaseDialectTestingState();
    jest.clearAllMocks();
  });

  it("keeps duckdb, oracle, postgresql, vertica, db2, mssql, and mysql explicit while exposing sqlite as a built-in runtime dialect", () => {
    ensureBuiltInDialectsRegistered();

    expect(getDatabaseDialect("sqlite")).toBe(sqliteDialect);
    for (const kind of optionalDialectKinds) {
      expect(() => getDatabaseDialect(kind)).toThrow(
        `No database dialect registered for '${kind}'.`,
      );
    }
  });
});
