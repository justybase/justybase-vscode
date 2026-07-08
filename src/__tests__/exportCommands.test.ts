/**
 * Unit tests for commands/exportCommands.ts
 * Tests export command registration and helper functions
 */

import * as vscode from "vscode";
import {
  registerExportCommands,
  ExportCommandsDependencies,
} from "../commands/exportCommands";
import {
  exportQueryToXlsb,
  exportCsvToXlsb,
  exportStructuredToXlsb,
  getTempFilePath,
} from "../export/xlsbExporter";
import { exportToCsv } from "../export/csvExporter";
import {
  exportCsvToXlsx,
  exportStructuredToXlsx,
  exportQueryToXlsx,
} from "../export/xlsxExporter";

// Mock vscode module
jest.mock("vscode", () => ({
  commands: {
    registerCommand: jest.fn((_id, _callback) => ({ dispose: jest.fn() })),
  },
  window: {
    activeTextEditor: undefined,
    showErrorMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    showInformationMessage: jest.fn(),
    showSaveDialog: jest.fn(),
    withProgress: jest.fn(),
    showQuickPick: jest.fn(),
  },
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
    })),
  },
  ProgressLocation: {
    Notification: 1,
  },
  env: {
    openExternal: jest.fn(),
  },
  Uri: {
    file: jest.fn((path) => ({ fsPath: path })),
  },
}));

// Mock connection manager
jest.mock("../core/connectionManager", () => ({
  ConnectionManager: jest.fn(),
}));

// Mock exporters
jest.mock("../export/xlsbExporter", () => ({
  exportQueryToXlsb: jest
    .fn()
    .mockResolvedValue({ success: true, message: "OK" }),
  getTempFilePath: jest.fn().mockReturnValue("/tmp/test.xlsb"),
  exportCsvToXlsb: jest
    .fn()
    .mockResolvedValue({ success: true, message: "OK" }),
  exportStructuredToXlsb: jest
    .fn()
    .mockResolvedValue({ success: true, message: "OK" }),
}));

jest.mock("../export/csvExporter", () => ({
  exportToCsv: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../export/xlsxExporter", () => ({
  exportStructuredToXlsx: jest
    .fn()
    .mockResolvedValue({ success: true, message: "OK" }),
  exportCsvToXlsx: jest
    .fn()
    .mockResolvedValue({ success: true, message: "OK" }),
  exportQueryToXlsx: jest
    .fn()
    .mockResolvedValue({ success: true, message: "OK" }),
  getTempFilePath: jest.fn().mockReturnValue("/tmp/test.xlsx"),
}));

describe("commands/exportCommands", () => {
  let mockContext: vscode.ExtensionContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockConnectionManager: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockOutputChannel: any;

  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.window.withProgress as jest.Mock).mockImplementation(
      async (_options, callback) => {
        return callback(
          { report: jest.fn() },
          { isCancellationRequested: false },
        );
      },
    );
    (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue({
      fsPath: "D:\\out\\export.xlsb",
    });
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
      value: "xlsb",
    });
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "query.executionTimeout") return 120;
        return defaultValue;
      }),
    });

    mockContext = {} as vscode.ExtensionContext;
    mockConnectionManager = {
      getConnectionForExecution: jest.fn().mockReturnValue("test-connection"),
      getConnection: jest.fn().mockResolvedValue({
        name: "test-connection",
        host: "localhost",
        port: 5480,
        database: "testdb",
        username: "user",
      }),
    };
    mockOutputChannel = {
      appendLine: jest.fn(),
      show: jest.fn(),
    };
  });

  describe("registerExportCommands", () => {
    it("should register all export commands", () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      const disposables = registerExportCommands(deps);

      // Should register 11 commands
      expect(disposables).toHaveLength(11);
      expect(vscode.commands.registerCommand).toHaveBeenCalledTimes(11);
    });

    it("should register netezza.exportToXlsb command", () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      registerExportCommands(deps);

      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        "netezza.exportToXlsb",
        expect.any(Function),
      );
    });

    it("should register netezza.exportToCsv command", () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      registerExportCommands(deps);

      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        "netezza.exportToCsv",
        expect.any(Function),
      );
    });

    it("should register netezza.exportToXlsx command", () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      registerExportCommands(deps);

      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        "netezza.exportToXlsx",
        expect.any(Function),
      );
    });

    it("should register netezza.copyXlsbToClipboard command", () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      registerExportCommands(deps);

      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        "netezza.copyXlsbToClipboard",
        expect.any(Function),
      );
    });

    it("should register netezza.exportQueryAndOpenXlsb command", () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      registerExportCommands(deps);

      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        "netezza.exportQueryAndOpenXlsb",
        expect.any(Function),
      );
    });

    it("should register netezza.exportQueryAndOpenXlsx command", () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      registerExportCommands(deps);

      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        "netezza.exportQueryAndOpenXlsx",
        expect.any(Function),
      );
    });

    it("should register netezza.exportToXlsbAndOpen command", () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      registerExportCommands(deps);

      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        "netezza.exportToXlsbAndOpen",
        expect.any(Function),
      );
    });

    it("should register netezza.exportCurrentResultToXlsbAndOpen command", () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      registerExportCommands(deps);

      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        "netezza.exportCurrentResultToXlsbAndOpen",
        expect.any(Function),
      );
    });

    it("should register netezza.copyCurrentResultToXlsbClipboard command", () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      registerExportCommands(deps);

      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        "netezza.copyCurrentResultToXlsbClipboard",
        expect.any(Function),
      );
    });

    it("should register netezza.exportCurrentResultToXlsxAndOpen command", () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      registerExportCommands(deps);

      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        "netezza.exportCurrentResultToXlsxAndOpen",
        expect.any(Function),
      );
    });

    it("should return disposables for cleanup", () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      const disposables = registerExportCommands(deps);

      disposables.forEach((d) => {
        expect(d).toHaveProperty("dispose");
      });
    });
  });

  describe("exportToXlsb command handler", () => {
    it("should show error when no active editor", async () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      registerExportCommands(deps);

      // Get the command handler
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find((call) => call[0] === "netezza.exportToXlsb")?.[1];

      // Execute handler with no active editor
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = undefined;
      await handler();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "No active editor found",
      );
    });

    it("should export SQL query to xlsb file", async () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find((call) => call[0] === "netezza.exportToXlsb")?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "SELECT 1"),
        },
      };

      await handler();
      expect(exportQueryToXlsb).toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("Results exported"),
      );
    });

    it("should export SQL query to xlsb file without showing the format picker when format is provided", async () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find((call) => call[0] === "netezza.exportToXlsb")?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "SELECT 1"),
        },
      };

      await handler({ format: "xlsb" });

      expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
      expect(exportQueryToXlsb).toHaveBeenCalled();
    });

    it("should export SQL query to xlsx file", async () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find((call) => call[0] === "netezza.exportToXlsx")?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "SELECT 1"),
        },
      };

      await handler();

      expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
      expect(exportQueryToXlsx).toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("Results exported"),
      );
    });

    it("should show warning message when text is empty", async () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find((call) => call[0] === "netezza.exportToXlsb")?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "  "), // White spaces
        },
      };

      await handler();
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        "No SQL query to export",
      );
    });

    it("should return early if save dialog is cancelled", async () => {
      // Mock save dialog to return undefined
      (vscode.window.showSaveDialog as jest.Mock).mockResolvedValueOnce(
        undefined,
      );
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find((call) => call[0] === "netezza.exportToXlsb")?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "SELECT 1"),
        },
      };

      await handler();
      // Should not show success or throw error, just silently exit
      expect(exportQueryToXlsb).not.toHaveBeenCalled();
    });

    it("should show error if connection is missing", async () => {
      mockConnectionManager.getConnection.mockResolvedValueOnce(null);
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find((call) => call[0] === "netezza.exportToXlsb")?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "SELECT 1"),
        },
      };

      await handler();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Connection not configured"),
      );
    });

    it("should show error message if exportToXlsb fails", async () => {
      (exportQueryToXlsb as jest.Mock).mockResolvedValueOnce({
        success: false,
        message: "Export failed",
      });
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find((call) => call[0] === "netezza.exportToXlsb")?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "SELECT 1"),
        },
      };

      await handler();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Error exporting: Export failed"),
      );
    });
  });

  describe("exportToCsv command handler", () => {
    it("should show error when no active editor", async () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      registerExportCommands(deps);

      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find((call) => call[0] === "netezza.exportToCsv")?.[1];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = undefined;
      await handler();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "No active editor found",
      );
    });

    it("should export SQL query to csv file", async () => {
      (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue({
        fsPath: "D:\\out\\export.csv",
      });
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find((call) => call[0] === "netezza.exportToCsv")?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "SELECT 1"),
        },
      };

      await handler();
      expect(exportToCsv).toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("Results exported"),
      );
    });

    it("should show warning message when text is empty", async () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find((call) => call[0] === "netezza.exportToCsv")?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "  "), // White spaces
        },
      };

      await handler();
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        "No SQL query to export",
      );
    });

    it("should return early if save dialog is cancelled", async () => {
      // Mock save dialog to return undefined
      (vscode.window.showSaveDialog as jest.Mock).mockResolvedValueOnce(
        undefined,
      );
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find((call) => call[0] === "netezza.exportToCsv")?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "SELECT 1"),
        },
      };

      await handler();
      expect(exportToCsv).not.toHaveBeenCalled();
    });

    it("should show error if connection is missing", async () => {
      mockConnectionManager.getConnection.mockResolvedValueOnce(null);
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find((call) => call[0] === "netezza.exportToCsv")?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "SELECT 1"),
        },
      };

      await handler();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Connection not configured"),
      );
    });
  });

  describe("copyXlsbToClipboard command handler", () => {
    it("should show error when no active editor", async () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      registerExportCommands(deps);

      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.copyXlsbToClipboard",
      )?.[1];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = undefined;
      await handler();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "No active editor found",
      );
    });

    it("should copy query result xlsb to clipboard and open temp folder", async () => {
      (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(
        "Show Temp Folder",
      );
      (exportQueryToXlsb as jest.Mock).mockResolvedValue({
        success: true,
        details: { clipboard_success: true },
      });
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.copyXlsbToClipboard",
      )?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "SELECT 1"),
        },
      };

      await handler();
      expect(exportQueryToXlsb).toHaveBeenCalled();
      expect(vscode.env.openExternal).toHaveBeenCalled();
    });

    it("should show warning message when text is empty", async () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.copyXlsbToClipboard",
      )?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "  "), // White spaces
        },
      };

      await handler();
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        "No SQL query to export",
      );
    });

    it("should show error if connection is missing", async () => {
      mockConnectionManager.getConnection.mockResolvedValueOnce(null);
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.copyXlsbToClipboard",
      )?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "SELECT 1"),
        },
      };

      await handler();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Connection not configured"),
      );
    });

    it("should show error message if exportToXlsb fails", async () => {
      (exportQueryToXlsb as jest.Mock).mockResolvedValueOnce({
        success: false,
        message: "Export failed",
      });
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.copyXlsbToClipboard",
      )?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "SELECT 1"),
        },
      };

      await handler();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining(
          "Error copying XLSB to clipboard: Export failed",
        ),
      );
    });

    it("should show error message if clipboard copy fails", async () => {
      // Mock success but missing clipboard_success flag
      (exportQueryToXlsb as jest.Mock).mockResolvedValueOnce({
        success: true,
        details: { clipboard_success: false },
      });
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.copyXlsbToClipboard",
      )?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "SELECT 1"),
        },
      };

      await handler();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Failed to copy file to clipboard"),
      );
    });
  });

  describe("exportToXlsbAndOpen command handler", () => {
    it("should show error when no active editor", async () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      registerExportCommands(deps);

      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportToXlsbAndOpen",
      )?.[1];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = undefined;
      await handler();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "No active editor found",
      );
    });

    it("should export and open xlsb file", async () => {
      (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue({
        fsPath: "D:\\out\\open.xlsb",
      });
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportToXlsbAndOpen",
      )?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "SELECT 1"),
        },
      };

      await handler();
      expect(exportQueryToXlsb).toHaveBeenCalled();
      expect(vscode.env.openExternal).toHaveBeenCalledWith({
        fsPath: "D:\\out\\open.xlsb",
      });
    });

    it("should show warning message when text is empty", async () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportToXlsbAndOpen",
      )?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "  "), // White spaces
        },
      };

      await handler();
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        "No SQL query to export",
      );
    });

    it("should return early if save dialog is cancelled", async () => {
      // Mock save dialog to return undefined
      (vscode.window.showSaveDialog as jest.Mock).mockResolvedValueOnce(
        undefined,
      );
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportToXlsbAndOpen",
      )?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "SELECT 1"),
        },
      };

      await handler();
      expect(exportQueryToXlsb).not.toHaveBeenCalled();
    });

    it("should show error if connection is missing", async () => {
      mockConnectionManager.getConnection.mockResolvedValueOnce(null);
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportToXlsbAndOpen",
      )?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "SELECT 1"),
        },
      };

      await handler();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Connection not configured"),
      );
    });

    it("should show error message if exportToXlsb fails", async () => {
      (exportQueryToXlsb as jest.Mock).mockResolvedValueOnce({
        success: false,
        message: "Export failed",
      });
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportToXlsbAndOpen",
      )?.[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).activeTextEditor = {
        selection: { isEmpty: true },
        document: {
          uri: { toString: () => "file:///query.sql" },
          getText: jest.fn(() => "SELECT 1"),
        },
      };

      await handler();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Error exporting: Export failed"),
      );
    });
  });

  describe("exportCurrentResultToXlsbAndOpen command handler", () => {
    it("should show error when no data to export", async () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      registerExportCommands(deps);

      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportCurrentResultToXlsbAndOpen",
      )?.[1];

      // Execute with empty data
      await handler([]);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "No data to export",
      );
    });

    it("should show error when no data provided", async () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      registerExportCommands(deps);

      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportCurrentResultToXlsbAndOpen",
      )?.[1];

      // Execute with null
      await handler(null);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "No data to export",
      );
    });

    it("should export structured active result only to xlsb and open", async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(
        "Export Active Result Only",
      );
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportCurrentResultToXlsbAndOpen",
      )?.[1];

      await handler([
        { columns: ["a"], rows: [[1]], isActive: false },
        { columns: ["b"], rows: [[2]], isActive: true },
      ]);
      expect(exportStructuredToXlsb).toHaveBeenCalled();
      expect(vscode.env.openExternal).toHaveBeenCalled();
    });

    it("should return early if quick pick is cancelled", async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportCurrentResultToXlsbAndOpen",
      )?.[1];

      await handler([
        { columns: ["a"], rows: [[1]], isActive: false },
        { columns: ["b"], rows: [[2]], isActive: true },
      ]);
      expect(exportStructuredToXlsb).not.toHaveBeenCalled();
      expect(exportCsvToXlsb).not.toHaveBeenCalled();
    });

    it("should fallback to first result if no active result found", async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(
        "Export Active Result Only",
      );
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportCurrentResultToXlsbAndOpen",
      )?.[1];

      await handler([
        { columns: ["a"], rows: [[1]], isActive: false },
        { columns: ["b"], rows: [[2]], isActive: false },
      ]);
      expect(exportStructuredToXlsb).toHaveBeenCalled();
      expect(vscode.env.openExternal).toHaveBeenCalled();
    });

    it("should export all results without filtering when exporting all", async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(
        "Export All Results",
      );
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportCurrentResultToXlsbAndOpen",
      )?.[1];

      await handler([
        { columns: ["a"], rows: [[1]], isActive: false },
        { columns: ["b"], rows: [[2]], isActive: true },
      ]);
      expect(exportStructuredToXlsb).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ columns: ["a"] }),
          expect.objectContaining({ columns: ["b"] }),
        ]),
        expect.any(String),
        false,
        expect.any(Function),
      );
    });

    it("should show error if structured export fails", async () => {
      (exportStructuredToXlsb as jest.Mock).mockResolvedValueOnce({
        success: false,
        message: "Export structured failed",
      });
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportCurrentResultToXlsbAndOpen",
      )?.[1];

      await handler([{ columns: ["a"], rows: [[1]], isActive: true }]);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining(
          "Error exporting to Excel: Export structured failed",
        ),
      );
    });

    it("should call legacy export for csv data and show error if it fails", async () => {
      (exportCsvToXlsb as jest.Mock).mockResolvedValueOnce({
        success: false,
        message: "Export legacy failed",
      });
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportCurrentResultToXlsbAndOpen",
      )?.[1];

      await handler([{ csv: "a\n1", isActive: true }]);
      expect(exportCsvToXlsb).toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining(
          "Error exporting to Excel: Export legacy failed",
        ),
      );
    });
  });

  describe("copyCurrentResultToXlsbClipboard command handler", () => {
    it("should show error when no data to copy", async () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      registerExportCommands(deps);

      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.copyCurrentResultToXlsbClipboard",
      )?.[1];

      // Execute with empty data
      await handler([]);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "No data to copy",
      );
    });

    it("should copy csv current result to xlsb clipboard", async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(
        "Export All Results",
      );
      (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(
        "OK",
      );
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.copyCurrentResultToXlsbClipboard",
      )?.[1];

      await handler([{ csv: "c1\n1", isActive: true }], "SELECT 1");
      expect(getTempFilePath).toHaveBeenCalled();
      expect(exportCsvToXlsb).toHaveBeenCalled();
    });

    it("should return early if quick pick is cancelled", async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.copyCurrentResultToXlsbClipboard",
      )?.[1];

      await handler([
        { columns: ["a"], rows: [[1]], isActive: false },
        { columns: ["b"], rows: [[2]], isActive: true },
      ]);
      expect(exportStructuredToXlsb).not.toHaveBeenCalled();
      expect(exportCsvToXlsb).not.toHaveBeenCalled();
    });

    it("should fallback to first result if no active result found", async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(
        "Export Active Result Only",
      );
      (exportStructuredToXlsb as jest.Mock).mockResolvedValueOnce({
        success: true,
        details: { clipboard_success: true },
      });
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.copyCurrentResultToXlsbClipboard",
      )?.[1];

      await handler([
        { columns: ["a"], rows: [[1]], isActive: false },
        { columns: ["b"], rows: [[2]], isActive: false },
      ]);
      expect(exportStructuredToXlsb).toHaveBeenCalled();
    });

    it("should export all results without filtering when exporting all", async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(
        "Export All Results",
      );
      (exportStructuredToXlsb as jest.Mock).mockResolvedValueOnce({
        success: true,
        details: { clipboard_success: true },
      });
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.copyCurrentResultToXlsbClipboard",
      )?.[1];

      await handler([
        { columns: ["a"], rows: [[1]], isActive: false },
        { columns: ["b"], rows: [[2]], isActive: true },
      ]);
      expect(exportStructuredToXlsb).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ columns: ["a"] }),
          expect.objectContaining({ columns: ["b"] }),
        ]),
        expect.any(String),
        true,
        expect.any(Function),
      );
    });

    it("should show error if structured export fails", async () => {
      (exportStructuredToXlsb as jest.Mock).mockResolvedValueOnce({
        success: false,
        message: "Export structured failed",
      });
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.copyCurrentResultToXlsbClipboard",
      )?.[1];

      await handler([{ columns: ["a"], rows: [[1]], isActive: true }]);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining(
          "Error copying to Excel: Export structured failed",
        ),
      );
    });

    it("should call legacy export for csv data and show error if it fails", async () => {
      (exportCsvToXlsb as jest.Mock).mockResolvedValueOnce({
        success: false,
        message: "Export legacy failed",
      });
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.copyCurrentResultToXlsbClipboard",
      )?.[1];

      await handler([{ csv: "a\n1", isActive: true }]);
      expect(exportCsvToXlsb).toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Error copying to Excel: Export legacy failed"),
      );
    });
  });

  describe("exportCurrentResultToXlsxAndOpen command handler", () => {
    it("should show error when no data to export", async () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };

      registerExportCommands(deps);

      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportCurrentResultToXlsxAndOpen",
      )?.[1];

      // Execute with empty data
      await handler([]);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "No data to export",
      );
    });

    it("should export csv current result to xlsx and open", async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(
        "Export All Results",
      );
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportCurrentResultToXlsxAndOpen",
      )?.[1];

      await handler([{ csv: "c1\n1", isActive: true }], "SELECT 1");
      expect(exportCsvToXlsx).toHaveBeenCalled();
      expect(vscode.env.openExternal).toHaveBeenCalled();
    });

    it("should export structured current result to xlsx", async () => {
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportCurrentResultToXlsxAndOpen",
      )?.[1];

      await handler([{ columns: ["a"], rows: [[1]], isActive: true }]);
      expect(exportStructuredToXlsx).toHaveBeenCalled();
    });

    it("should return early if quick pick is cancelled", async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportCurrentResultToXlsxAndOpen",
      )?.[1];

      await handler([
        { columns: ["a"], rows: [[1]], isActive: false },
        { columns: ["b"], rows: [[2]], isActive: true },
      ]);
      expect(exportStructuredToXlsx).not.toHaveBeenCalled();
      expect(exportCsvToXlsx).not.toHaveBeenCalled();
      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });

    it("should fallback to first result if no active result found", async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(
        "Export Active Result Only",
      );
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportCurrentResultToXlsxAndOpen",
      )?.[1];

      await handler([
        { columns: ["a"], rows: [[1]], isActive: false },
        { columns: ["b"], rows: [[2]], isActive: false },
      ]);
      expect(exportStructuredToXlsx).toHaveBeenCalled();
      expect(vscode.env.openExternal).toHaveBeenCalled();
    });

    it("should export all results without filtering when exporting all", async () => {
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(
        "Export All Results",
      );
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportCurrentResultToXlsxAndOpen",
      )?.[1];

      await handler([
        { columns: ["a"], rows: [[1]], isActive: false },
        { columns: ["b"], rows: [[2]], isActive: true },
      ]);
      expect(exportStructuredToXlsx).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ columns: ["a"] }),
          expect.objectContaining({ columns: ["b"] }),
        ]),
        expect.any(String),
        false,
        expect.any(Function),
      );
      expect(vscode.env.openExternal).toHaveBeenCalled();
    });

    it("should show error if structured export fails", async () => {
      (exportStructuredToXlsx as jest.Mock).mockResolvedValueOnce({
        success: false,
        message: "Export structured failed",
      });
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportCurrentResultToXlsxAndOpen",
      )?.[1];

      await handler([{ columns: ["a"], rows: [[1]], isActive: true }]);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining(
          "Error exporting to Excel XLSX: Export structured failed",
        ),
      );
    });

    it("should call legacy export for csv data and show error if it fails", async () => {
      (exportCsvToXlsx as jest.Mock).mockResolvedValueOnce({
        success: false,
        message: "Export legacy failed",
      });
      const deps: ExportCommandsDependencies = {
        context: mockContext,
        connectionManager: mockConnectionManager,
        outputChannel: mockOutputChannel,
      };
      registerExportCommands(deps);
      const handler = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find(
        (call) => call[0] === "netezza.exportCurrentResultToXlsxAndOpen",
      )?.[1];

      await handler([{ csv: "a\n1", isActive: true }]);
      expect(exportCsvToXlsx).toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining(
          "Error exporting to Excel XLSX: Export legacy failed",
        ),
      );
    });
  });
});
