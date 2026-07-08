import * as vscode from "vscode";
import { MetadataCache } from "../../metadataCache";
import { proposeTableQualification } from "../../core/tableQualificationResolver";
import type { ConnectionManager } from "../../core/connectionManager";

jest.mock("vscode");

function createConnectionManager(overrides: Partial<ConnectionManager> = {}): ConnectionManager {
  return {
    resolveConnectionName: jest.fn(() => "conn1"),
    getActiveConnectionName: jest.fn(() => "conn1"),
    getDocumentDatabase: jest.fn(() => undefined),
    getConnectionMetadata: jest.fn(() => ({
      name: "conn1",
      host: "host",
      database: "DB1",
      user: "user",
    })),
    ...overrides,
  } as unknown as ConnectionManager;
}

function createCache(): MetadataCache {
  return new MetadataCache({} as vscode.ExtensionContext);
}

describe("tableQualificationResolver", () => {
  it("qualifies unqualified table names with the cached schema", () => {
    const cache = createCache();
    cache.setDatabases("conn1", [{ DATABASE: "DB1" }]);
    cache.setTables(
      "conn1",
      "DB1.PUBLIC",
      [{ OBJNAME: "EMPLOYEES", SCHEMA: "PUBLIC", label: "EMPLOYEES", objType: "TABLE" }],
      new Map([["DB1.PUBLIC.EMPLOYEES", 1]]),
    );

    const proposals = proposeTableQualification(
      {
        metadataCache: cache,
        connectionManager: createConnectionManager(),
      },
      { name: "EMPLOYEES", documentUri: "file:///test.sql" },
    );

    expect(proposals.map((proposal) => proposal.qualifiedText)).toEqual([
      "DB1.PUBLIC.EMPLOYEES",
    ]);
  });

  it("qualifies DB..TABLE using current schema as preferred among cached schemas", () => {
    const cache = createCache();
    cache.setDatabases("conn1", [{ DATABASE: "DB1" }]);
    cache.setCurrentSchema("conn1", "DB1", "SALES");
    cache.setTables(
      "conn1",
      "DB1.ADMIN",
      [{ OBJNAME: "ORDERS", SCHEMA: "ADMIN", label: "ORDERS", objType: "TABLE" }],
      new Map([["DB1.ADMIN.ORDERS", 1]]),
    );
    cache.setTables(
      "conn1",
      "DB1.SALES",
      [{ OBJNAME: "ORDERS", SCHEMA: "SALES", label: "ORDERS", objType: "TABLE" }],
      new Map([["DB1.SALES.ORDERS", 2]]),
    );

    const proposals = proposeTableQualification(
      {
        metadataCache: cache,
        connectionManager: createConnectionManager(),
      },
      { database: "DB1", name: "ORDERS" },
    );

    expect(proposals[0]).toMatchObject({
      qualifiedText: "DB1.SALES.ORDERS",
      isPreferred: true,
    });
    expect(proposals.map((proposal) => proposal.qualifiedText)).toContain(
      "DB1.ADMIN.ORDERS",
    );
  });

  it("returns no proposal without a connection or effective database", () => {
    const cache = createCache();
    const proposals = proposeTableQualification(
      {
        metadataCache: cache,
        connectionManager: createConnectionManager({
          resolveConnectionName: jest.fn(() => undefined),
          getActiveConnectionName: jest.fn(() => null),
        } as Partial<ConnectionManager>),
      },
      { name: "EMPLOYEES" },
    );

    expect(proposals).toEqual([]);
  });

  it("qualifies SCHEMA.TABLE using the effective database", () => {
    const cache = createCache();
    cache.setDatabases("conn1", [{ DATABASE: "DB1" }, { DATABASE: "DB2" }]);
    cache.setTables(
      "conn1",
      "DB1.PUBLIC",
      [{ OBJNAME: "EMPLOYEES", SCHEMA: "PUBLIC", label: "EMPLOYEES", objType: "TABLE" }],
      new Map([["DB1.PUBLIC.EMPLOYEES", 1]]),
    );

    const proposals = proposeTableQualification(
      {
        metadataCache: cache,
        connectionManager: createConnectionManager({
          getDocumentDatabase: jest.fn(() => "DB1"),
        }),
      },
      { schema: "PUBLIC", name: "EMPLOYEES", documentUri: "file:///test.sql" },
    );

    expect(proposals.map((proposal) => proposal.qualifiedText)).toEqual([
      "DB1.PUBLIC.EMPLOYEES",
    ]);
  });
});
