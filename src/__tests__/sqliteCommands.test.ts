/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for the SQLite rebuild-table command (script preparation flow).
 */

import * as vscode from "vscode";
import { registerSqliteCommands } from "../commands/schema/sqliteCommands";
import type { SchemaCommandsDependencies } from "../commands/schema/types";

const mockConnectionManager = {
  resolveConnectionName: jest.fn().mockReturnValue("sqlite-conn"),
  getConnectionDatabaseKind: jest.fn().mockReturnValue("sqlite"),
  getConnection: jest.fn(),
  setDocumentConnection: jest.fn(),
  setDocumentDatabase: jest.fn().mockResolvedValue(undefined),
};

const mockDeps = {
  context: {},
  connectionManager: mockConnectionManager,
  metadataCache: {},
  schemaProvider: { refresh: jest.fn() },
  schemaTreeView: {},
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
    showSaveDialog: jest.fn(),
    showTextDocument: jest.fn(),
  },
  workspace: {
    openTextDocument: jest.fn(),
  },
}));

jest.mock("../core/queryRunner", () => ({
  runQueryRaw: jest.fn(),
  queryResultToRows: jest.fn((result: any) => result?.rows ?? []),
}));

async function getHandler(command: string): Promise<any> {
  registerSqliteCommands(mockDeps);
  const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
  const cmd = calls.find((call: any[]) => call[0] === command);
  return cmd[1] as any;
}

const item = { label: "orders", dbName: "main", schema: "main", objType: "TABLE", connectionName: "sqlite-conn" } as any;

describe("netezza.sqlite.rebuildTable", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockConnectionManager.resolveConnectionName as jest.Mock).mockReturnValue("sqlite-conn");
    (mockConnectionManager.getConnectionDatabaseKind as jest.Mock).mockReturnValue("sqlite");
    (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({ uri: { toString: () => "untitled:sql" } });
  });

  it("opens a rebuild script prepared from live catalog reads", async () => {
    const { runQueryRaw } = require("../core/queryRunner");
    (runQueryRaw as jest.Mock).mockImplementation(async (options: any) => {
      if (options.query.includes("pragma_table_info")) {
        return { rows: [{ COLUMN_NAME: "id" }, { COLUMN_NAME: "note" }] };
      }
      if (options.query.includes("tbl_name")) {
        return { rows: [{ SQL_TEXT: 'CREATE INDEX "ix_orders_note" ON "orders" ("note")' }] };
      }
      return { rows: [{ SQL_TEXT: 'CREATE TABLE "orders" ("id" INTEGER PRIMARY KEY, "note" TEXT)' }] };
    });
    (vscode.window.showInputBox as jest.Mock).mockImplementation(async (options: any) => options.value);

    const handler = await getHandler("netezza.sqlite.rebuildTable");
    await handler(item);

    expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
    const doc = (vscode.workspace.openTextDocument as jest.Mock).mock.calls[0][0] as { content: string };
    expect(doc.content).toContain("BEGIN IMMEDIATE;");
    expect(doc.content).toContain('__JB_REBUILD_');
    expect(doc.content).toContain('CREATE INDEX "ix_orders_note" ON "orders" ("note");');
    expect(doc.content).toContain("-- COMMIT;");
  });

  it("rejects a replacement definition that renames the table", async () => {
    const { runQueryRaw } = require("../core/queryRunner");
    (runQueryRaw as jest.Mock).mockResolvedValue({
      rows: [{ SQL_TEXT: 'CREATE TABLE "orders" ("id" INTEGER PRIMARY KEY)' }],
    });
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('CREATE TABLE "other" ("id" INTEGER PRIMARY KEY)');

    const handler = await getHandler("netezza.sqlite.rebuildTable");
    await handler(item);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Keep the original table name"),
    );
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });
});
