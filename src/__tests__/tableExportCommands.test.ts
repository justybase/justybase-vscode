/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for tableExportCommands.ts (schema-tree table data export).
 */

import * as vscode from "vscode";
import { registerTableExportCommands } from "../commands/schema/tableExportCommands";
import type { SchemaCommandsDependencies } from "../commands/schema/types";

const mockConnectionManager = {
  resolveConnectionName: jest.fn().mockReturnValue("c"),
  getConnectionDatabaseKind: jest.fn().mockReturnValue("postgresql"),
  getConnection: jest.fn().mockResolvedValue({ name: "c" }),
};

const mockDeps = {
  context: {},
  connectionManager: mockConnectionManager,
} as unknown as SchemaCommandsDependencies;

jest.mock("vscode", () => ({
  CancellationError: class CancellationError extends Error {},
  ProgressLocation: { Notification: 15 },
  commands: {
    registerCommand: jest.fn((_cmd: string, _handler: any) => ({ command: _cmd, dispose: jest.fn() })),
    executeCommand: jest.fn().mockResolvedValue(undefined),
  },
  window: {
    showQuickPick: jest.fn(),
    showSaveDialog: jest.fn(),
    showInformationMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    showErrorMessage: jest.fn(),
    withProgress: jest.fn(async (_options: any, task: any) => task({ report: jest.fn() }, { isCancellationRequested: false })),
  },
  Uri: { file: jest.fn((p: string) => ({ fsPath: p })) },
}));

jest.mock("../core/queryRunnerHelpers", () => ({
  getConnectionForDocument: jest.fn(),
}));

jest.mock("../compatibility/configuration", () => ({
  getExtensionConfiguration: jest.fn(() => ({ get: jest.fn().mockReturnValue(1800) })),
}));

const mockExportQueryToStreamFile = jest.fn().mockResolvedValue(10);
jest.mock("../export/queryStreamExporter", () => ({
  exportQueryToStreamFile: (...args: any[]) => mockExportQueryToStreamFile(...args),
}));

const mockExportQueryToParquet = jest.fn().mockResolvedValue({ success: true });
jest.mock("../export/parquetExporter", () => ({
  exportQueryToParquet: (...args: any[]) => mockExportQueryToParquet(...args),
}));

async function getHandler(): Promise<any> {
  registerTableExportCommands(mockDeps);
  const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
  return calls.find((call: any[]) => call[0] === "netezza.exportTableData")[1] as any;
}

const item = { label: "ORDERS", rawLabel: "ORDERS", dbName: "DB", schema: "public", objType: "TABLE", connectionName: "c" } as any;

describe("tableExportCommands", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExportQueryToStreamFile.mockResolvedValue(10);
    mockExportQueryToParquet.mockResolvedValue({ success: true });
    (mockConnectionManager.resolveConnectionName as jest.Mock).mockReturnValue("c");
    (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue({ fsPath: "/tmp/orders.csv" });
  });

  it("registers the export command", () => {
    registerTableExportCommands(mockDeps);
    const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
    expect(calls.some((call: any[]) => call[0] === "netezza.exportTableData")).toBe(true);
  });

  it("streams all rows through an isolated connection", async () => {
    const { getConnectionForDocument } = require("../core/queryRunnerHelpers");
    const fakeConnection = { close: jest.fn().mockResolvedValue(undefined) };
    (getConnectionForDocument as jest.Mock).mockResolvedValue({ connection: fakeConnection, shouldCloseConnection: true });
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: "CSV", value: "csv", extension: "csv" });

    const handler = await getHandler();
    await handler(item);

    expect(getConnectionForDocument).toHaveBeenCalledWith(mockConnectionManager, "c", false);
    expect(mockExportQueryToStreamFile).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.stringContaining("SELECT * FROM"),
      filePath: "/tmp/orders.csv",
      format: "csv",
    }));
    expect(fakeConnection.close).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("/tmp/orders.csv"));
  });

  it("uses the Parquet exporter for parquet format", async () => {
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: "Parquet", value: "parquet", extension: "parquet" });
    (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue({ fsPath: "/tmp/orders.parquet" });

    const handler = await getHandler();
    await handler(item);

    expect(mockExportQueryToParquet).toHaveBeenCalledWith(
      expect.objectContaining({ name: "c" }),
      expect.stringContaining("SELECT * FROM"),
      "/tmp/orders.parquet",
      false,
      expect.any(Function),
      expect.any(Number),
      expect.anything(),
    );
    expect(mockExportQueryToStreamFile).not.toHaveBeenCalled();
  });

  it("rejects non-table objects", async () => {
    const handler = await getHandler();
    await handler({ label: "X", dbName: "DB", objType: "PROCEDURE", connectionName: "c" });
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect(mockExportQueryToStreamFile).not.toHaveBeenCalled();
  });
});
