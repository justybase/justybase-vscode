/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for decorationManager
 * Tests SQL statement highlighting and decoration management
 */

import * as vscode from "vscode";
import {
  createSqlStatementDecoration,
  updateSqlHighlight,
  registerDecorationSubscriptions,
} from "../editors/decorationManager";
import { SqlParser } from "../sql/sqlParser";

// Mock SqlParser
jest.mock("../sql/sqlParser", () => ({
  SqlParser: {
    getStatementAtPosition: jest.fn(),
    clearDocumentCache: jest.fn(),
  },
}));

describe("decorationManager", () => {
  let mockDecorationType: jest.Mocked<vscode.TextEditorDecorationType>;
  let mockEditor: jest.Mocked<vscode.TextEditor>;
  let mockDocument: jest.Mocked<vscode.TextDocument>;
  let mockConfig: { get: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();

    mockDecorationType = {
      dispose: jest.fn(),
    } as unknown as jest.Mocked<vscode.TextEditorDecorationType>;

    mockDocument = {
      languageId: "sql",
      uri: { toString: jest.fn().mockReturnValue("file:///test.sql") },
      version: 1,
      getText: jest.fn(),
      offsetAt: jest.fn(),
      positionAt: jest.fn(),
      lineAt: jest.fn(),
      lineCount: 10,
    } as unknown as jest.Mocked<vscode.TextDocument>;

    mockEditor = {
      document: mockDocument,
      selection: {
        active: new vscode.Position(0, 0),
      } as vscode.Selection,
      setDecorations: jest.fn(),
    } as unknown as jest.Mocked<vscode.TextEditor>;

    mockConfig = {
      get: jest.fn().mockReturnValue(true),
    };

    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue(
      mockConfig,
    );
    (vscode.window.createTextEditorDecorationType as jest.Mock).mockReturnValue(
      mockDecorationType,
    );
  });

  describe("createSqlStatementDecoration", () => {
    it("should create decoration type with correct configuration", () => {
      createSqlStatementDecoration();

      expect(vscode.window.createTextEditorDecorationType).toHaveBeenCalledWith(
        {
          backgroundColor: "rgba(5, 115, 201, 0.10)",
          isWholeLine: false,
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        },
      );
    });
  });

  describe("updateSqlHighlight", () => {
    it("should clear decorations when highlighting is disabled", () => {
      mockConfig.get.mockReturnValue(false);

      updateSqlHighlight(mockDecorationType, mockEditor);

      expect(mockEditor.setDecorations).toHaveBeenCalledWith(
        mockDecorationType,
        [],
      );
    });

    it("should clear decorations when editor is undefined", () => {
      updateSqlHighlight(mockDecorationType, undefined);

      expect(mockEditor.setDecorations).not.toHaveBeenCalled();
    });

    it("should clear decorations for non-SQL files", () => {
      (mockDocument as any).languageId = "javascript";

      updateSqlHighlight(mockDecorationType, mockEditor);

      expect(mockEditor.setDecorations).toHaveBeenCalledWith(
        mockDecorationType,
        [],
      );
    });

    it("should highlight SQL statement at cursor position", () => {
      const mockStatement = {
        sql: "SELECT * FROM users",
        start: 10,
        end: 30,
      };
      (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue(
        mockStatement,
      );
      (mockDocument.offsetAt as jest.Mock).mockReturnValue(20);
      (mockDocument.getText as jest.Mock).mockReturnValue(
        "SELECT * FROM users",
      );
      (mockDocument.positionAt as jest.Mock)
        .mockReturnValueOnce(new vscode.Position(0, 10))
        .mockReturnValueOnce(new vscode.Position(0, 30));

      updateSqlHighlight(mockDecorationType, mockEditor);

      expect(SqlParser.getStatementAtPosition).toHaveBeenCalledWith(
        mockDocument.getText(),
        20,
        {
          documentId: "file:///test.sql",
          version: 1,
        },
      );
      expect(mockEditor.setDecorations).toHaveBeenCalled();
      const decorations = (mockEditor.setDecorations as jest.Mock).mock
        .calls[0][1];
      expect(decorations).toHaveLength(1);
      expect(decorations[0]).toBeInstanceOf(vscode.Range);
    });

    it("should clear decorations when no statement found at position", () => {
      (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue(null);
      (mockDocument.offsetAt as jest.Mock).mockReturnValue(20);
      (mockDocument.getText as jest.Mock).mockReturnValue("");

      updateSqlHighlight(mockDecorationType, mockEditor);

      expect(mockEditor.setDecorations).toHaveBeenCalledWith(
        mockDecorationType,
        [],
      );
    });

    it("should handle errors gracefully", () => {
      (mockDocument.offsetAt as jest.Mock).mockImplementation(() => {
        throw new Error("Test error");
      });

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      updateSqlHighlight(mockDecorationType, mockEditor);

      expect(consoleSpy).toHaveBeenCalledWith(
        "Error updating SQL highlight:",
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });

    it("should handle mssql language files", () => {
      (mockDocument as any).languageId = "mssql";
      (mockDocument.offsetAt as jest.Mock).mockReturnValue(20);
      (mockDocument.getText as jest.Mock).mockReturnValue("SELECT 1");
      (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
        sql: "SELECT 1",
        start: 0,
        end: 8,
      });
      (mockDocument.positionAt as jest.Mock)
        .mockReturnValueOnce(new vscode.Position(0, 0))
        .mockReturnValueOnce(new vscode.Position(0, 8));

      updateSqlHighlight(mockDecorationType, mockEditor);

      expect(mockEditor.setDecorations).toHaveBeenCalled();
    });

    it("should skip redundant decoration updates for the same cursor state", () => {
      const mockStatement = {
        sql: "SELECT * FROM users",
        start: 10,
        end: 30,
      };
      (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue(
        mockStatement,
      );
      (mockDocument.offsetAt as jest.Mock).mockReturnValue(20);
      (mockDocument.getText as jest.Mock).mockReturnValue(
        "SELECT * FROM users",
      );
      (mockDocument.positionAt as jest.Mock)
        .mockReturnValue(new vscode.Position(0, 10))
        .mockReturnValue(new vscode.Position(0, 30));

      updateSqlHighlight(mockDecorationType, mockEditor);
      updateSqlHighlight(mockDecorationType, mockEditor);

      expect(SqlParser.getStatementAtPosition).toHaveBeenCalledTimes(2);
      expect(mockEditor.setDecorations).toHaveBeenCalledTimes(1);
    });

    it("should not keep stale skip state after clearing decorations", () => {
      const mockStatement = {
        sql: "SELECT * FROM users",
        start: 10,
        end: 30,
      };
      (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue(
        mockStatement,
      );
      (mockDocument.offsetAt as jest.Mock).mockReturnValue(20);
      (mockDocument.getText as jest.Mock).mockReturnValue(
        "SELECT * FROM users",
      );
      (mockDocument.positionAt as jest.Mock).mockReturnValue(
        new vscode.Position(0, 10),
      );

      updateSqlHighlight(mockDecorationType, mockEditor);

      mockConfig.get.mockReturnValue(false);
      updateSqlHighlight(mockDecorationType, mockEditor);

      mockConfig.get.mockReturnValue(true);
      updateSqlHighlight(mockDecorationType, mockEditor);

      expect(mockEditor.setDecorations).toHaveBeenCalledTimes(3);
    });

    it("should track redundant updates per split editor instance", () => {
      const splitEditor = {
        ...mockEditor,
        setDecorations: jest.fn(),
      } as unknown as jest.Mocked<vscode.TextEditor>;
      const mockStatement = {
        sql: "SELECT * FROM users",
        start: 10,
        end: 30,
      };
      (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue(
        mockStatement,
      );
      (mockDocument.offsetAt as jest.Mock).mockReturnValue(20);
      (mockDocument.getText as jest.Mock).mockReturnValue(
        "SELECT * FROM users",
      );
      (mockDocument.positionAt as jest.Mock).mockReturnValue(
        new vscode.Position(0, 10),
      );

      updateSqlHighlight(mockDecorationType, mockEditor);
      updateSqlHighlight(mockDecorationType, splitEditor);

      expect(mockEditor.setDecorations).toHaveBeenCalledTimes(1);
      expect(splitEditor.setDecorations).toHaveBeenCalledTimes(1);
    });
  });

  describe("registerDecorationSubscriptions", () => {
    let mockContext: vscode.ExtensionContext;
    let eventHandlers: { [key: string]: (e: any) => void } = {};

    beforeEach(() => {
      eventHandlers = {};

      mockContext = {
        subscriptions: [],
        extensionUri: { fsPath: "/test" } as vscode.Uri,
        extensionPath: "/test",
      } as unknown as vscode.ExtensionContext;

      (
        vscode.window.onDidChangeTextEditorSelection as jest.Mock
      ).mockImplementation((handler) => {
        eventHandlers["selection"] = handler;
        return { dispose: jest.fn() };
      });

      (
        vscode.window.onDidChangeActiveTextEditor as jest.Mock
      ).mockImplementation((handler) => {
        eventHandlers["activeEditor"] = handler;
        return { dispose: jest.fn() };
      });

      (
        vscode.workspace.onDidChangeConfiguration as jest.Mock
      ).mockImplementation((handler) => {
        eventHandlers["config"] = handler;
        return { dispose: jest.fn() };
      });

      (
        vscode.workspace.onDidCloseTextDocument as jest.Mock
      ).mockImplementation((handler) => {
        eventHandlers["closeDocument"] = handler;
        return { dispose: jest.fn() };
      });

      (vscode.window.activeTextEditor as any) = mockEditor;
    });

    it("should register all event subscriptions", () => {
      registerDecorationSubscriptions(mockContext, mockDecorationType);

      expect(vscode.window.onDidChangeTextEditorSelection).toHaveBeenCalled();
      expect(vscode.window.onDidChangeActiveTextEditor).toHaveBeenCalled();
      expect(vscode.workspace.onDidChangeConfiguration).toHaveBeenCalled();
      expect(vscode.workspace.onDidCloseTextDocument).toHaveBeenCalled();
      expect(mockContext.subscriptions).toHaveLength(5);
    });

    it("should debounce highlight updates on text editor selection change", () => {
      jest.useFakeTimers();
      (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
        sql: "SELECT 1",
        start: 0,
        end: 8,
      });
      (mockDocument.getText as jest.Mock).mockReturnValue("SELECT 1;");
      (mockDocument.offsetAt as jest.Mock).mockReturnValue(5);
      (mockDocument.positionAt as jest.Mock)
        .mockReturnValueOnce(new vscode.Position(0, 0))
        .mockReturnValueOnce(new vscode.Position(0, 8));

      registerDecorationSubscriptions(mockContext, mockDecorationType);
      (mockEditor.setDecorations as jest.Mock).mockClear();
      (SqlParser.getStatementAtPosition as jest.Mock).mockClear();

      const mockEvent = { textEditor: mockEditor };
      eventHandlers["selection"](mockEvent);
      eventHandlers["selection"](mockEvent);

      expect(mockEditor.setDecorations).not.toHaveBeenCalled();
      expect(SqlParser.getStatementAtPosition).not.toHaveBeenCalled();

      (mockDocument.offsetAt as jest.Mock).mockReturnValue(12);
      jest.advanceTimersByTime(100);

      expect(SqlParser.getStatementAtPosition).toHaveBeenCalledTimes(1);
      expect(mockEditor.setDecorations).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    it("should update highlight immediately on active editor change", () => {
      (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
        sql: "SELECT 1",
        start: 0,
        end: 8,
      });
      (mockDocument.getText as jest.Mock).mockReturnValue("SELECT 1;");
      (mockDocument.offsetAt as jest.Mock).mockReturnValue(5);
      (mockDocument.positionAt as jest.Mock)
        .mockReturnValueOnce(new vscode.Position(0, 0))
        .mockReturnValueOnce(new vscode.Position(0, 8));

      registerDecorationSubscriptions(mockContext, mockDecorationType);
      (mockEditor.setDecorations as jest.Mock).mockClear();

      (mockDocument.offsetAt as jest.Mock).mockReturnValue(12);
      (mockDocument.positionAt as jest.Mock)
        .mockReturnValueOnce(new vscode.Position(0, 0))
        .mockReturnValueOnce(new vscode.Position(0, 8));

      eventHandlers["activeEditor"](mockEditor);

      expect(mockEditor.setDecorations).toHaveBeenCalled();
    });

    it("should flush pending selection highlight before active editor change", () => {
      jest.useFakeTimers();
      const splitEditor = {
        ...mockEditor,
        setDecorations: jest.fn(),
      } as unknown as jest.Mocked<vscode.TextEditor>;
      (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
        sql: "SELECT 1",
        start: 0,
        end: 8,
      });
      (mockDocument.getText as jest.Mock).mockReturnValue("SELECT 1;");
      (mockDocument.offsetAt as jest.Mock).mockReturnValue(5);
      (mockDocument.positionAt as jest.Mock)
        .mockReturnValue(new vscode.Position(0, 0))
        .mockReturnValue(new vscode.Position(0, 8));

      registerDecorationSubscriptions(mockContext, mockDecorationType);
      (mockEditor.setDecorations as jest.Mock).mockClear();
      (splitEditor.setDecorations as jest.Mock).mockClear();

      (mockDocument.offsetAt as jest.Mock).mockReturnValue(12);
      eventHandlers["selection"]({ textEditor: mockEditor });
      eventHandlers["activeEditor"](splitEditor);

      expect(mockEditor.setDecorations).toHaveBeenCalledTimes(1);
      expect(splitEditor.setDecorations).toHaveBeenCalledTimes(1);

      jest.useRealTimers();
    });

    it("should clear parser cache when document closes", () => {
      registerDecorationSubscriptions(mockContext, mockDecorationType);

      eventHandlers["closeDocument"](mockDocument);

      expect(SqlParser.clearDocumentCache).toHaveBeenCalledWith(
        "file:///test.sql",
      );
    });

    it("should update highlight when configuration changes", () => {
      const mockConfigChangeEvent = {
        affectsConfiguration: jest.fn().mockReturnValue(true),
      };

      (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
        sql: "SELECT 1",
        start: 0,
        end: 8,
      });
      (mockDocument.offsetAt as jest.Mock).mockReturnValue(5);
      (mockDocument.positionAt as jest.Mock)
        .mockReturnValueOnce(new vscode.Position(0, 0))
        .mockReturnValueOnce(new vscode.Position(0, 8));

      registerDecorationSubscriptions(mockContext, mockDecorationType);

      eventHandlers["config"](mockConfigChangeEvent);

	expect(mockConfigChangeEvent.affectsConfiguration).toHaveBeenCalledWith(
		"justybase.highlightActiveStatement",
	);
	expect(mockEditor.setDecorations).toHaveBeenCalled();
	});

	it("should not update highlight for unrelated configuration changes", () => {
		const mockConfigChangeEvent = {
			affectsConfiguration: jest.fn().mockReturnValue(false),
		};

		registerDecorationSubscriptions(mockContext, mockDecorationType);

      // Clear mock calls from initial update
      (mockEditor.setDecorations as jest.Mock).mockClear();

      eventHandlers["config"](mockConfigChangeEvent);

      expect(mockEditor.setDecorations).not.toHaveBeenCalled();
    });

    it("should perform initial highlight update", () => {
      (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
        sql: "SELECT 1",
        start: 0,
        end: 8,
      });
      (mockDocument.offsetAt as jest.Mock).mockReturnValue(5);
      (mockDocument.positionAt as jest.Mock)
        .mockReturnValueOnce(new vscode.Position(0, 0))
        .mockReturnValueOnce(new vscode.Position(0, 8));

      registerDecorationSubscriptions(mockContext, mockDecorationType);

      expect(mockEditor.setDecorations).toHaveBeenCalled();
    });
  });
});
