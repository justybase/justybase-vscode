import { EventEmitter } from "events";
import {
  createDatabaseConnection,
  getDatabaseCapabilities,
  getDatabaseDialect,
  getDatabaseMetadataProvider,
  getRegisteredDatabaseDialects,
  resolveConnectionDatabaseKind,
} from "../core/connectionFactory";
import { DatabaseConnectionConfig } from "../contracts/database";

const mockNzConnectionConstructor = jest.fn();

jest.mock("@justybase/netezza-driver", () => ({
  NzConnection: mockNzConnectionConstructor,
}));

const OPTIONAL_DIALECT_EXPECTATIONS = [
  {
    kind: "duckdb" as const,
    installHint:
      'Install the optional "DuckDB Tools (justybase)" extension to use DuckDB connections.',
  },
  {
    kind: "db2" as const,
    installHint:
      'Install the optional "Db2 Tools (justybase)" extension to use Db2 connections.',
  },
  {
    kind: "oracle" as const,
    installHint:
      'Install the optional "Oracle Tools (justybase)" extension to use Oracle connections.',
  },
  {
    kind: "vertica" as const,
    installHint:
      'Install the optional "Vertica Tools (justybase)" extension to use Vertica connections.',
  },
  {
    kind: "postgresql" as const,
    installHint:
      'Install the optional "PostgreSQL Tools (justybase)" extension to use PostgreSQL connections.',
  },
  {
    kind: "mssql" as const,
    installHint:
      'Install the optional "MSSQL Tools (justybase)" extension to use MS SQL Server connections.',
  },
  {
    kind: "mysql" as const,
    installHint:
      'Install the optional "MySQL Tools (justybase)" extension to use MySQL connections.',
  },
] as const;

function createMockConnection() {
  return Object.assign(new EventEmitter(), {
    connect: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
    createCommand: jest.fn(),
  });
}

describe("connectionFactory", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("normalizes legacy database kind aliases", () => {
    expect(resolveConnectionDatabaseKind()).toBe("netezza");
    expect(resolveConnectionDatabaseKind("NetezzaSQL")).toBe("netezza");
    expect(resolveConnectionDatabaseKind("postgres")).toBe("postgresql");
    expect(resolveConnectionDatabaseKind("verticadb")).toBe("vertica");
    expect(resolveConnectionDatabaseKind("sqlite3")).toBe("sqlite");
    expect(resolveConnectionDatabaseKind("duck db")).toBe("duckdb");
    expect(resolveConnectionDatabaseKind("db2luw")).toBe("db2");
    expect(resolveConnectionDatabaseKind("mysql")).toBe("mysql");
  });

  it("creates connection instances through the registered dialect", () => {
    const mockConnection = createMockConnection();
    mockNzConnectionConstructor.mockImplementation(() => mockConnection);

    const config: DatabaseConnectionConfig = {
      host: "localhost",
      port: 5480,
      database: "TESTDB",
      user: "admin",
      password: "secret",
    };

    const connection = createDatabaseConnection(config, "NetezzaSQL");

    expect(mockNzConnectionConstructor).toHaveBeenCalledWith({
      ...config,
      connectionTimeout: 5,
    });
    expect(connection).toBe(mockConnection);
  });

  it("exposes registered dialect metadata and capabilities", () => {
    const dialect = getDatabaseDialect("netezza");
    const sqliteDialect = getDatabaseDialect("sqlite");
    const capabilities = getDatabaseCapabilities("netezza");
    const registeredDialects = getRegisteredDatabaseDialects();
    const mysqlCapabilities = getDatabaseCapabilities("mysql");

    expect(dialect.displayName).toBe("Netezza");
    expect(sqliteDialect.displayName).toBe("SQLite");
    expect(dialect.defaultPort).toBe(5480);
    expect(capabilities).toEqual({
      supportsExplainPlan: true,
      supportsExplainGraph: true,
      supportsTuningAdvisor: true,
      supportsExternalTables: true,
      supportsProcedures: true,
      supportsTableMaintenance: true,
      supportsSessionMonitor: true,
    });
    expect(registeredDialects.some((item) => item.kind === "netezza")).toBe(
      true,
    );
    expect(registeredDialects.some((item) => item.kind === "sqlite")).toBe(
      true,
    );
    expect(mysqlCapabilities).toEqual({
      supportsExplainPlan: false,
      supportsExplainGraph: false,
      supportsTuningAdvisor: false,
      supportsExternalTables: false,
      supportsProcedures: false,
      supportsTableMaintenance: false,
      supportsSessionMonitor: false,
    });
    expect(getDatabaseMetadataProvider("netezza").defaultObjectTypes).toContain(
      "TABLE",
    );
    expect(dialect.connectionForm?.fields.map((field) => field.key)).toEqual(
      expect.arrayContaining(["host", "port", "database", "user", "password"]),
    );
    expect(
      sqliteDialect.connectionForm?.fields.map((field) => field.key),
    ).toEqual(["mode", "database"]);
  });

  it.each(OPTIONAL_DIALECT_EXPECTATIONS)(
    "returns safe default capabilities for an optional $kind dialect that is not registered",
    ({ kind }) => {
      expect(getDatabaseCapabilities(kind)).toEqual({
        supportsExplainPlan: false,
        supportsExplainGraph: false,
        supportsTuningAdvisor: false,
        supportsExternalTables: false,
        supportsProcedures: false,
        supportsTableMaintenance: false,
        supportsSessionMonitor: false,
      });
    },
  );

  it.each(OPTIONAL_DIALECT_EXPECTATIONS)(
    "surfaces an install hint when optional $kind dialect support is not registered",
    ({ kind, installHint }) => {
      expect(() => getDatabaseDialect(kind)).toThrow(
        `No database dialect registered for '${kind}'. ${installHint}`,
      );
    },
  );
});
