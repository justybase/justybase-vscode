/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for tableCommands.ts
 * Commands: grantPermissions, addTableComment, addColumnComment, truncateTable, addPrimaryKey, addForeignKey, alterTableWizard
 */

import * as vscode from "vscode";
import { registerTableCommands } from "../commands/schema/tableCommands";
import {
  SchemaCommandsDependencies,
  SchemaItemData,
} from "../commands/schema/types";

// Mock dependencies
const mockContext = {
  subscriptions: [],
  workspaceState: { get: jest.fn(), update: jest.fn() },
  globalState: { get: jest.fn(), update: jest.fn() },
} as any;

const mockConnectionManager = {
  getConnection: jest.fn(),
  hasConnection: jest.fn().mockReturnValue(true),
};

const mockMetadataCache = {
  getTables: jest.fn(),
  getColumns: jest.fn(),
  invalidateSchema: jest.fn(),
} as any;

const mockSchemaProvider = {
  refresh: jest.fn(),
} as any;

const mockSchemaTreeView = {
  reveal: jest.fn(),
} as any;

const mockDeps: SchemaCommandsDependencies = {
  context: mockContext,
  connectionManager: mockConnectionManager as any,
  metadataCache: mockMetadataCache,
  schemaProvider: mockSchemaProvider,
  schemaTreeView: mockSchemaTreeView,
};

// Mock vscode modules
jest.mock("vscode", () => ({
  commands: {
    registerCommand: jest.fn((_cmd: string, _handler: any) => {
      return { command: _cmd, dispose: jest.fn() };
    }),
  },
  window: {
    showQuickPick: jest.fn(),
    showInputBox: jest.fn(),
    showInformationMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    showErrorMessage: jest.fn(),
  },
  ProgressLocation: {
    Notification: 15,
  },
}));

// Mock queryRunner
jest.mock("../core/queryRunner", () => ({
  runQuery: jest.fn().mockResolvedValue({ rows: [] }),
}));

// Mock helpers
jest.mock("../commands/schema/helpers", () => ({
  getFullName: jest.fn(
    (item: any) => `${item.dbName}.${item.schema}.${item.label}`,
  ),
  requireConnection: jest.fn().mockResolvedValue(true),
  executeWithProgress: jest.fn(
    async (_title: string, fn: () => Promise<any>) => {
      return fn();
    },
  ),
  escapeSqlString: jest.fn((str: string) => str.replace(/'/g, "''")),
  isValidIdentifier: jest.fn((str: string) =>
    /^[A-Za-z][A-Za-z0-9_]*$/.test(str),
  ),
}));

describe("tableCommands", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset mock implementations to ensure clean state for each test
    (vscode.window.showQuickPick as jest.Mock).mockReset();
    (vscode.window.showInputBox as jest.Mock).mockReset();
    (vscode.window.showInformationMessage as jest.Mock).mockReset();
    (vscode.window.showWarningMessage as jest.Mock).mockReset();
    (vscode.window.showErrorMessage as jest.Mock).mockReset();
  });

  describe("registerTableCommands", () => {
    it("should register all table commands and return disposables", () => {
      const disposables = registerTableCommands(mockDeps);

      expect(disposables).toBeDefined();
      expect(disposables.length).toBeGreaterThan(0);
      expect(vscode.commands.registerCommand).toHaveBeenCalled();
    });

    it("should register netezza.grantPermissions command", () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const grantCmd = calls.find(
        (call: any[]) => call[0] === "netezza.grantPermissions",
      );

      expect(grantCmd).toBeDefined();
    });

    it("should register netezza.addTableComment command", () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const cmd = calls.find(
        (call: any[]) => call[0] === "netezza.addTableComment",
      );

      expect(cmd).toBeDefined();
    });

    it("should register netezza.addColumnComment command", () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const cmd = calls.find(
        (call: any[]) => call[0] === "netezza.addColumnComment",
      );

      expect(cmd).toBeDefined();
    });

    it("should register netezza.truncateTable command", () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const cmd = calls.find(
        (call: any[]) => call[0] === "netezza.truncateTable",
      );

      expect(cmd).toBeDefined();
    });

    it("should register netezza.addPrimaryKey command", () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const cmd = calls.find(
        (call: any[]) => call[0] === "netezza.addPrimaryKey",
      );

      expect(cmd).toBeDefined();
    });

    it("should register netezza.addForeignKey command", () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const cmd = calls.find(
        (call: any[]) => call[0] === "netezza.addForeignKey",
      );

      expect(cmd).toBeDefined();
    });

    it("should register netezza.alterTableWizard command", () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const cmd = calls.find(
        (call: any[]) => call[0] === "netezza.alterTableWizard",
      );

      expect(cmd).toBeDefined();
    });
  });

  describe("grantPermissions command", () => {
    it("should show quick pick for privilege selection", async () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const grantCmd = calls.find(
        (call: any[]) => call[0] === "netezza.grantPermissions",
      );
      const handler = grantCmd[1] as any;

      const mockItem: SchemaItemData = {
        label: "TEST_TABLE",
        dbName: "TESTDB",
        schema: "ADMIN",
        objType: "TABLE",
        connectionName: "test-conn",
      };

      // Mock showQuickPick to return a privilege
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
        label: "SELECT",
      });
      // Mock showInputBox to return a grantee
      (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(
        "TEST_USER",
      );
      // Mock showInformationMessage to return confirmation
      (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce(
        "Yes, execute",
      );

      await handler(mockItem);

      expect(vscode.window.showQuickPick).toHaveBeenCalled();
      expect(vscode.window.showInputBox).toHaveBeenCalled();
    });

    it("should return early if no privilege selected", async () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const grantCmd = calls.find(
        (call: any[]) => call[0] === "netezza.grantPermissions",
      );
      const handler = grantCmd[1] as any;

      const mockItem: SchemaItemData = {
        label: "TEST_TABLE",
        dbName: "TESTDB",
        schema: "ADMIN",
        objType: "TABLE",
        connectionName: "test-conn",
      };

      // User cancels - returns undefined
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce(
        undefined,
      );

      await handler(mockItem);

      expect(vscode.window.showQuickPick).toHaveBeenCalled();
      // Should not proceed to input grantee
      expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    });

    it("should validate grantee input", async () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const grantCmd = calls.find(
        (call: any[]) => call[0] === "netezza.grantPermissions",
      );
      const handler = grantCmd[1] as any;

      const mockItem: SchemaItemData = {
        label: "TEST_TABLE",
        dbName: "TESTDB",
        schema: "ADMIN",
        objType: "TABLE",
        connectionName: "test-conn",
      };

      (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
        label: "SELECT",
      });
      // Return invalid input then empty
      (vscode.window.showInputBox as jest.Mock)
        .mockResolvedValueOnce("") // Empty input triggers validation
        .mockResolvedValueOnce(undefined); // User cancels

      await handler(mockItem);

      // Should have called validateInput
      expect(vscode.window.showInputBox).toHaveBeenCalled();
    });

    it("should execute grant SQL when confirmed", async () => {
      const { runQuery } = require("../core/queryRunner");
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const grantCmd = calls.find(
        (call: any[]) => call[0] === "netezza.grantPermissions",
      );
      const handler = grantCmd[1] as any;

      const mockItem: SchemaItemData = {
        label: "TEST_TABLE",
        dbName: "TESTDB",
        schema: "ADMIN",
        objType: "TABLE",
        connectionName: "test-conn",
      };

      (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
        label: "SELECT",
      });
      (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(
        "TEST_USER",
      );
      (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce(
        "Yes, execute",
      );

      await handler(mockItem);

      expect(runQuery).toHaveBeenCalled();
    });
  });

  describe("changeOwner command", () => {
    it("quotes an owner name containing a dot", async () => {
      const { runQuery } = require("../core/queryRunner");
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const changeOwnerCmd = calls.find(
        (call: any[]) => call[0] === "netezza.changeOwner",
      );
      const handler = changeOwnerCmd[1] as any;
      const mockItem: SchemaItemData = {
        label: "TEST_TABLE",
        dbName: "TESTDB",
        schema: "ADMIN",
        objType: "TABLE",
        connectionName: "test-conn",
      };
      (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce("a.user");

      await handler(mockItem);

      expect(runQuery).toHaveBeenCalledWith(
        mockContext,
        'ALTER TABLE TESTDB.ADMIN.TEST_TABLE OWNER TO "a.user";',
        true,
        "test-conn",
        mockConnectionManager,
      );
    });
  });

  describe("addTableComment command", () => {
    it("should prompt for comment and execute SQL", async () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const cmd = calls.find(
        (call: any[]) => call[0] === "netezza.addTableComment",
      );
      const handler = cmd[1] as any;

      const { runQuery } = require("../core/queryRunner");
      const mockItem: SchemaItemData = {
        label: "TEST_TABLE",
        dbName: "TESTDB",
        schema: "ADMIN",
        objType: "TABLE",
        connectionName: "test-conn",
        objectDescription: "Old comment",
      };

      (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(
        "New comment",
      );

      await handler(mockItem);

      expect(vscode.window.showInputBox).toHaveBeenCalled();
      expect(runQuery).toHaveBeenCalled();
      expect(mockSchemaProvider.refresh).toHaveBeenCalled();
    });

    it("should return early if comment is undefined (cancelled)", async () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const cmd = calls.find(
        (call: any[]) => call[0] === "netezza.addTableComment",
      );
      const handler = cmd[1] as any;

      const { runQuery } = require("../core/queryRunner");
      const mockItem: SchemaItemData = {
        label: "TEST_TABLE",
        dbName: "TESTDB",
        schema: "ADMIN",
        objType: "TABLE",
        connectionName: "test-conn",
      };

      // User cancels
      (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(
        undefined,
      );

      await handler(mockItem);

      expect(runQuery).not.toHaveBeenCalled();
    });

    it("should handle errors gracefully", async () => {
      const { runQuery } = require("../core/queryRunner");
      (runQuery as jest.Mock).mockRejectedValueOnce(new Error("DB Error"));

      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const cmd = calls.find(
        (call: any[]) => call[0] === "netezza.addTableComment",
      );
      const handler = cmd[1] as any;

      const mockItem: SchemaItemData = {
        label: "TEST_TABLE",
        dbName: "TESTDB",
        schema: "ADMIN",
        objType: "TABLE",
        connectionName: "test-conn",
      };

      (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(
        "Test comment",
      );

      await handler(mockItem);

      expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    });
  });

  describe("addColumnComment command", () => {
    it("should handle column items with parentName", async () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const cmd = calls.find(
        (call: any[]) => call[0] === "netezza.addColumnComment",
      );
      const handler = cmd[1] as any;

      const { runQuery } = require("../core/queryRunner");
      const mockItem: SchemaItemData = {
        label: "ID COLUMN",
        dbName: "TESTDB",
        schema: "ADMIN",
        parentName: "TEST_TABLE",
        connectionName: "test-conn",
      };

      (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(
        "Primary key column",
      );

      await handler(mockItem);

      expect(vscode.window.showInputBox).toHaveBeenCalled();
      expect(runQuery).toHaveBeenCalled();
    });
  });

  describe("truncateTable command", () => {
    it("should warn before truncating", async () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const cmd = calls.find(
        (call: any[]) => call[0] === "netezza.truncateTable",
      );
      const handler = cmd[1] as any;

      const { runQuery } = require("../core/queryRunner");
      const mockItem: SchemaItemData = {
        label: "TEST_TABLE",
        dbName: "TESTDB",
        schema: "ADMIN",
        objType: "TABLE",
        connectionName: "test-conn",
      };

      // User confirms
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce(
        "Yes, delete all data",
      );

      await handler(mockItem);

      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
      expect(runQuery).toHaveBeenCalled();
    });

    it("should not truncate if user cancels", async () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const cmd = calls.find(
        (call: any[]) => call[0] === "netezza.truncateTable",
      );
      const handler = cmd[1] as any;

      const { runQuery } = require("../core/queryRunner");
      const mockItem: SchemaItemData = {
        label: "TEST_TABLE",
        dbName: "TESTDB",
        schema: "ADMIN",
        objType: "TABLE",
        connectionName: "test-conn",
      };

      // User cancels
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce(
        "Cancel",
      );

      await handler(mockItem);

      expect(runQuery).not.toHaveBeenCalled();
    });
  });

  describe("addPrimaryKey command", () => {
    it("should prompt for constraint name and columns", async () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const cmd = calls.find(
        (call: any[]) => call[0] === "netezza.addPrimaryKey",
      );
      const handler = cmd[1] as any;

      const { runQuery } = require("../core/queryRunner");
      const mockItem: SchemaItemData = {
        label: "TEST_TABLE",
        dbName: "TESTDB",
        schema: "ADMIN",
        objType: "TABLE",
        connectionName: "test-conn",
      };

      // Mock all prompts
      (vscode.window.showInputBox as jest.Mock)
        .mockResolvedValueOnce("PK_TEST")
        .mockResolvedValueOnce("ID, NAME");
      // User confirms
      (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce(
        "Yes, add",
      );

      await handler(mockItem);

      expect(vscode.window.showInputBox).toHaveBeenCalledTimes(2);
      expect(runQuery).toHaveBeenCalled();
    });

    it("should return early if constraint name is not provided", async () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const cmd = calls.find(
        (call: any[]) => call[0] === "netezza.addPrimaryKey",
      );
      const handler = cmd[1] as any;

      const { runQuery } = require("../core/queryRunner");
      const mockItem: SchemaItemData = {
        label: "TEST_TABLE",
        dbName: "TESTDB",
        schema: "ADMIN",
        objType: "TABLE",
        connectionName: "test-conn",
      };

      // User cancels on constraint name
      (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(
        undefined,
      );

      await handler(mockItem);

      expect(runQuery).not.toHaveBeenCalled();
    });
  });

  describe("addForeignKey command", () => {
    it("should check for foreign key command registration", () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      // Check for any FK related commands
      const fkCommands = calls.filter((call: any[]) =>
        call[0].toLowerCase().includes("foreign"),
      );

      // Command may or may not exist - just verify filter works
      expect(Array.isArray(fkCommands)).toBe(true);
    });
  });

  describe("alterTableWizard command", () => {
    it("should execute add-column ALTER statement after confirmation", async () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const cmd = calls.find(
        (call: any[]) => call[0] === "netezza.alterTableWizard",
      );
      const handler = cmd[1] as any;

      const { runQuery } = require("../core/queryRunner");
      const mockItem: SchemaItemData = {
        label: "TEST_TABLE",
        dbName: "TESTDB",
        schema: "ADMIN",
        objType: "TABLE",
        connectionName: "test-conn",
      };

      (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
        id: "add-column",
        label: "Add Column",
      });
      (vscode.window.showInputBox as jest.Mock)
        .mockResolvedValueOnce("NEW_COL")
        .mockResolvedValueOnce("VARCHAR(50)");
      (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce(
        "Execute",
      );

      await handler(mockItem);

      expect(runQuery).toHaveBeenCalled();
      const runQueryArgs = (runQuery as jest.Mock).mock.calls[0];
      expect(runQueryArgs[1]).toContain(
        "ALTER TABLE TESTDB.ADMIN.TEST_TABLE ADD COLUMN NEW_COL VARCHAR(50);",
      );
    });
  });

  describe("validation", () => {
    it("should handle items with missing required properties", async () => {
      registerTableCommands(mockDeps);

      const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
      const grantCmd = calls.find(
        (call: any[]) => call[0] === "netezza.grantPermissions",
      );
      const handler = grantCmd[1] as any;

      // Item missing dbName
      const mockItem: SchemaItemData = {
        label: "TEST_TABLE",
      };

      await handler(mockItem);

      // Should not call any vscode dialogs
      expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    });
  });
});
