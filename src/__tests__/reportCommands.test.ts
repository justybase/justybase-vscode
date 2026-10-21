/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for reportCommands.ts (read-only catalog reports opened in SQL Results).
 */

import * as vscode from "vscode";
import { registerReportCommands } from "../commands/schema/reportCommands";
import type { SchemaCommandsDependencies } from "../commands/schema/types";
import { openAndRunSql } from "../commands/schema/helpers";

const mockProvider = {
  buildTableReportQuery: jest.fn((_db: string, schema: string, table: string, report: string) => `-- ${report} ${schema}.${table}`),
  buildDatabaseReportQuery: jest.fn((db: string, report: string) => (report === "locks" ? `-- locks ${db}` : undefined)),
};

jest.mock("vscode", () => ({
  commands: {
    registerCommand: jest.fn((command: string, handler: any) => ({ command, handler, dispose: jest.fn() })),
  },
  window: {
    showWarningMessage: jest.fn(),
    showErrorMessage: jest.fn(),
  },
}));

jest.mock("../core/connectionFactory", () => ({
  getDatabaseMetadataProvider: jest.fn(() => mockProvider),
}));

jest.mock("../commands/schema/helpers", () => ({
  getItemObjectName: jest.fn((item: any) => item.rawLabel || item.label || ""),
  openAndRunSql: jest.fn().mockResolvedValue(undefined),
}));

const connectionManager = {
  getConnectionDatabaseKind: jest.fn().mockReturnValue("db2"),
  supportsCapability: jest.fn().mockReturnValue(true),
};

const deps = {
  context: {} as any,
  connectionManager: connectionManager as any,
  metadataCache: {} as any,
  schemaProvider: {} as any,
  schemaTreeView: {} as any,
} as SchemaCommandsDependencies;

function handler(command: string): (item: any) => Promise<void> {
  const registered = registerReportCommands(deps) as unknown as Array<{ command: string; handler: (item: any) => Promise<void> }>;
  const found = registered.find(entry => entry.command === command);
  if (!found) throw new Error(`${command} not registered`);
  return found.handler;
}

describe("report commands", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.supportsCapability.mockReturnValue(true);
  });

  it("registers every table and database report", () => {
    const commands = (registerReportCommands(deps) as unknown as Array<{ command: string }>).map(entry => entry.command);
    expect(commands).toEqual([
      "netezza.showTableSize",
      "netezza.showTablePrivileges",
      "netezza.showTableMaintenanceStatus",
      "netezza.showLockWaits",
      "netezza.showInvalidObjects",
    ]);
  });

  it("runs the dialect SQL for the clicked table in SQL Results", async () => {
    await handler("netezza.showTableMaintenanceStatus")({ connectionName: "DB2DEV", dbName: "SAMPLE", schema: "APP", label: "ORDERS" });

    expect(mockProvider.buildTableReportQuery).toHaveBeenCalledWith("SAMPLE", "APP", "ORDERS", "maintenance");
    expect(openAndRunSql).toHaveBeenCalledWith(connectionManager, { connectionName: "DB2DEV", database: "SAMPLE" }, "-- maintenance APP.ORDERS", "Maintenance status: APP.ORDERS");
  });

  it("uses the database node label for database reports", async () => {
    await handler("netezza.showLockWaits")({ connectionName: "DB2DEV", label: "SAMPLE" });

    expect(openAndRunSql).toHaveBeenCalledWith(connectionManager, { connectionName: "DB2DEV", database: "SAMPLE" }, "-- locks SAMPLE", "Lock waits: SAMPLE");
  });

  it("does not run anything when the dialect does not offer the report", async () => {
    connectionManager.supportsCapability.mockReturnValue(false);
    await handler("netezza.showTableSize")({ connectionName: "SQLITE", dbName: "main", schema: "main", label: "T" });

    expect(openAndRunSql).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("not available"));
  });

  it("warns instead of running when the provider builds no SQL", async () => {
    await handler("netezza.showInvalidObjects")({ connectionName: "DB2DEV", label: "SAMPLE" });

    expect(openAndRunSql).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
  });
});
