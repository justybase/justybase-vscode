/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for dataCommands.ts (schema-tree data exploration actions).
 */

import * as vscode from "vscode";
import { registerDataCommands } from "../commands/schema/dataCommands";
import {
  SchemaCommandsDependencies,
} from "../commands/schema/types";

const mockContext = {
  subscriptions: [],
  workspaceState: { get: jest.fn(), update: jest.fn() },
  globalState: { get: jest.fn(), update: jest.fn() },
} as any;

const mockConnectionManager = {
  getConnection: jest.fn(),
  getConnectionDatabaseKind: jest.fn(),
  resolveConnectionName: jest.fn(),
  supportsCapability: jest.fn().mockReturnValue(true),
  setDocumentConnection: jest.fn(),
  setDocumentDatabase: jest.fn(),
};

const mockMetadataCache = {
  getColumns: jest.fn(),
  getTables: jest.fn(),
} as any;

const mockSchemaProvider = { refresh: jest.fn() } as any;
const mockSchemaTreeView = { reveal: jest.fn() } as any;

const mockDeps: SchemaCommandsDependencies = {
  context: mockContext,
  connectionManager: mockConnectionManager as any,
  metadataCache: mockMetadataCache,
  schemaProvider: mockSchemaProvider,
  schemaTreeView: mockSchemaTreeView,
};

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
  ProgressLocation: { Notification: 15 },
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

jest.mock("../metadata/cache/schemaTreeDataSource", () => ({
  getTablesForScope: jest.fn(),
}));

async function getHandler(command: string): Promise<any> {
  registerDataCommands(mockDeps);
  const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
  const cmd = calls.find((call: any[]) => call[0] === command);
  return cmd[1] as any;
}

describe("dataCommands", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockConnectionManager.supportsCapability as jest.Mock).mockReturnValue(true);
    (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({ uri: { toString: () => "untitled:sql" } });
    (vscode.window.showTextDocument as jest.Mock) = jest.fn();
  });

  it("registers all data commands", () => {
    registerDataCommands(mockDeps);
    const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
    for (const command of [
      "netezza.countRows",
      "netezza.findDuplicateRows",
      "netezza.createTableFromTable",
      "netezza.callRoutine",
      "netezza.setTableStorage",
      "netezza.searchSchemaValues",
      "netezza.createIndex",
      "netezza.alterColumnQuick",
    ]) {
      expect(calls.some((call: any[]) => call[0] === command)).toBe(true);
    }
  });

  it("countRows executes a COUNT query", async () => {
    const handler = await getHandler("netezza.countRows");
    const { runQuery } = require("../core/queryRunner");
    await handler({ label: "ORDERS", dbName: "DB", schema: "S", objType: "TABLE", connectionName: "c" });
    expect(runQuery).toHaveBeenCalledWith(
      expect.anything(),
      "SELECT COUNT(*) AS row_count FROM DB.S.ORDERS;",
      true,
      "c",
      expect.anything(),
    );
  });

  it("findDuplicateRows builds a GROUP BY query from prompted columns", async () => {
    (mockConnectionManager.getConnectionDatabaseKind as jest.Mock).mockReturnValue("postgresql");
    const handler = await getHandler("netezza.findDuplicateRows");
    const { runQuery } = require("../core/queryRunner");
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce("account_id, order_no");
    await handler({ label: "ORDERS", dbName: "DB", schema: "S", objType: "TABLE", connectionName: "c" });
    const sql = runQuery.mock.calls[0][1] as string;
    expect(sql).toContain("GROUP BY");
    expect(sql).toContain("HAVING COUNT(*) > 1");
  });

  it("createTableFromTable opens Db2 CTAS with WITH DATA in an editor", async () => {
    (mockConnectionManager.getConnectionDatabaseKind as jest.Mock).mockReturnValue("db2");
    const handler = await getHandler("netezza.createTableFromTable");
    (vscode.window.showInputBox as jest.Mock)
      .mockResolvedValueOnce("COPY_ORDERS")
      .mockResolvedValueOnce("");
    await handler({ label: "ORDERS", dbName: "DB", schema: "S", objType: "TABLE", connectionName: "c" });
    expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
    const doc = (vscode.workspace.openTextDocument as jest.Mock).mock.calls[0][0] as { content: string };
    expect(doc.content).toContain("WITH DATA");
  });

  it("callRoutine executes a Db2 function as VALUES", async () => {
    (mockConnectionManager.getConnectionDatabaseKind as jest.Mock).mockReturnValue("db2");
    const handler = await getHandler("netezza.callRoutine");
    const { runQuery } = require("../core/queryRunner");
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce("7");
    await handler({ label: "NEXT_VALUE", dbName: "DB", schema: "S", objType: "FUNCTION", connectionName: "c" });
    expect(runQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("VALUES"),
      true,
      "c",
      expect.anything(),
    );
  });

  it("setTableStorage executes fillfactor SQL for PostgreSQL", async () => {
    (mockConnectionManager.getConnectionDatabaseKind as jest.Mock).mockReturnValue("postgresql");
    const handler = await getHandler("netezza.setTableStorage");
    const { runQuery } = require("../core/queryRunner");
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ label: "Set fillfactor", action: "setFillfactor" });
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce("80");
    await handler({ label: "ORDERS", dbName: "DB", schema: "public", objType: "TABLE", connectionName: "c" });
    expect(runQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("fillfactor = 80"),
      true,
      "c",
      expect.anything(),
    );
  });

  it("searchSchemaValues opens generated search SQL from cached columns", async () => {
    (mockConnectionManager.getConnectionDatabaseKind as jest.Mock).mockReturnValue("postgresql");
    (mockConnectionManager.resolveConnectionName as jest.Mock).mockReturnValue("c");
    const { getTablesForScope } = require("../metadata/cache/schemaTreeDataSource");
    (getTablesForScope as jest.Mock).mockReturnValue([{ OBJNAME: "ORDERS" }]);
    (mockMetadataCache.getColumns as jest.Mock).mockReturnValue([
      { ATTNAME: "customer_name", FORMAT_TYPE: "VARCHAR(80)" },
      { ATTNAME: "amount", FORMAT_TYPE: "DECIMAL(12,2)" },
    ]);
    const handler = await getHandler("netezza.searchSchemaValues");
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce("Neil");
    await handler({ label: "ORDERS", dbName: "DB", schema: "public", objType: "TABLE", connectionName: "c" });
    expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
    const doc = (vscode.workspace.openTextDocument as jest.Mock).mock.calls[0][0] as { content: string };
    expect(doc.content).toContain("match_value");
    expect(doc.content).toContain("customer_name");
  });

  it("createIndex executes quick CREATE INDEX for Oracle", async () => {
    (mockConnectionManager.getConnectionDatabaseKind as jest.Mock).mockReturnValue("oracle");
    const handler = await getHandler("netezza.createIndex");
    const { runQuery } = require("../core/queryRunner");
    (vscode.window.showInputBox as jest.Mock)
      .mockResolvedValueOnce("created_at")
      .mockResolvedValueOnce("");
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ label: "No", value: false });
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce("Yes, create");
    await handler({ label: "ORDERS", dbName: "DB", schema: "S", objType: "TABLE", connectionName: "c" });
    expect(runQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("CREATE INDEX"),
      true,
      "c",
      expect.anything(),
    );
  });

  it("alterColumnQuick executes a DuckDB type change", async () => {
    (mockConnectionManager.getConnectionDatabaseKind as jest.Mock).mockReturnValue("duckdb");
    const handler = await getHandler("netezza.alterColumnQuick");
    const { runQuery } = require("../core/queryRunner");
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ label: "CHANGE COLUMN TYPE", action: "type" });
    (vscode.window.showInputBox as jest.Mock)
      .mockResolvedValueOnce("salary")
      .mockResolvedValueOnce("DECIMAL(18,2)")
      .mockResolvedValueOnce("");
    await handler({ label: "EMP", dbName: "DB", schema: "main", objType: "TABLE", connectionName: "c" });
    expect(runQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("SET DATA TYPE DECIMAL(18,2)"),
      true,
      "c",
      expect.anything(),
    );
  });
});
