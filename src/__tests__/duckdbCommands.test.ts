/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for duckdbCommands.ts (DuckDB index list/drop actions).
 */

import * as vscode from "vscode";
import { registerDuckdbCommands } from "../commands/schema/duckdbCommands";
import type {
  SchemaCommandsDependencies,
} from "../commands/schema/types";

const mockConnectionManager = {
  resolveConnectionName: jest.fn().mockReturnValue("c"),
  getConnectionDatabaseKind: jest.fn().mockReturnValue("duckdb"),
  setDocumentConnection: jest.fn(),
  setDocumentDatabase: jest.fn().mockResolvedValue(undefined),
};

const mockDeps = {
  context: {},
  connectionManager: mockConnectionManager,
} as unknown as SchemaCommandsDependencies;

jest.mock("vscode", () => ({
  commands: {
    registerCommand: jest.fn((_cmd: string, _handler: any) => ({ command: _cmd, dispose: jest.fn() })),
    executeCommand: jest.fn().mockResolvedValue(undefined),
  },
  window: {
    showQuickPick: jest.fn(),
    showInputBox: jest.fn(),
    showInformationMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    showErrorMessage: jest.fn(),
  },
  workspace: {
    openTextDocument: jest.fn(),
  },
}));

jest.mock("../core/queryRunner", () => ({
  runQuery: jest.fn().mockResolvedValue({ rows: [] }),
}));

jest.mock("../commands/schema/helpers", () => ({
  getFullName: jest.fn((item: any) => `${item.dbName}.${item.schema}.${item.label}`),
  getItemObjectName: jest.fn((item: any) => item.rawLabel || item.label || ""),
  requireConnection: jest.fn().mockResolvedValue(true),
  executeWithProgress: jest.fn(async (_title: string, fn: () => Promise<any>) => fn()),
  escapeSqlString: jest.fn((str: string) => str.replace(/'/g, "''")),
  isValidIdentifier: jest.fn((str: string) => /^[A-Za-z][A-Za-z0-9_]*$/.test(str)),
}));

async function getHandler(command: string): Promise<any> {
  registerDuckdbCommands(mockDeps);
  const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
  const cmd = calls.find((call: any[]) => call[0] === command);
  return cmd[1] as any;
}

describe("duckdbCommands", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockConnectionManager.resolveConnectionName as jest.Mock).mockReturnValue("c");
    (mockConnectionManager.getConnectionDatabaseKind as jest.Mock).mockReturnValue("duckdb");
    (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({ uri: { toString: () => "untitled:sql" } });
    (vscode.window.showTextDocument as jest.Mock) = jest.fn();
  });

  it("registers the DuckDB index commands", () => {
    registerDuckdbCommands(mockDeps);
    const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
    expect(calls.some((call: any[]) => call[0] === "netezza.duckdb.listIndexes")).toBe(true);
    expect(calls.some((call: any[]) => call[0] === "netezza.duckdb.dropIndex")).toBe(true);
  });

  it("lists indexes through duckdb_indexes()", async () => {
    const handler = await getHandler("netezza.duckdb.listIndexes");
    await handler({ label: "ORDERS", dbName: "DB", schema: "main", objType: "TABLE", connectionName: "c" });
    expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
    const doc = (vscode.workspace.openTextDocument as jest.Mock).mock.calls[0][0] as { content: string };
    expect(doc.content).toContain("duckdb_indexes()");
    expect(doc.content).toContain("table_name = 'ORDERS'");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("netezza.runQuery");
  });

  it("drops a prompted index after confirmation", async () => {
    const handler = await getHandler("netezza.duckdb.dropIndex");
    const { runQuery } = require("../core/queryRunner");
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce("ix_orders");
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce("Yes, drop");
    await handler({ label: "ORDERS", dbName: "DB", schema: "main", objType: "TABLE", connectionName: "c" });
    expect(runQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("DROP INDEX"),
      true,
      "c",
      expect.anything(),
    );
  });
});
