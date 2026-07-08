/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for sqlShortcuts
 * Tests SQL shortcut expansion functionality
 */

import * as vscode from "vscode";
import { registerSqlShortcuts } from "../editors/sqlShortcuts";

describe("sqlShortcuts", () => {
  let mockContext: vscode.ExtensionContext;
  let changeHandler:
    | ((event: vscode.TextDocumentChangeEvent) => Promise<void>)
    | null = null;
  let mockEditor: jest.Mocked<vscode.TextEditor>;
  let mockDocument: jest.Mocked<vscode.TextDocument>;
  let editBuilder: { replace: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    changeHandler = null;
    editBuilder = { replace: jest.fn() };

    mockDocument = {
      languageId: "sql",
      lineAt: jest.fn(),
    } as unknown as jest.Mocked<vscode.TextDocument>;

    mockEditor = {
      document: mockDocument,
      edit: jest.fn().mockImplementation((callback) => {
        callback(editBuilder);
        return Promise.resolve(true);
      }),
      revealRange: jest.fn(),
    } as unknown as jest.Mocked<vscode.TextEditor>;

    mockContext = {
      subscriptions: [],
      extensionUri: { fsPath: "/test" } as vscode.Uri,
      extensionPath: "/test",
    } as unknown as vscode.ExtensionContext;

    (vscode.workspace.onDidChangeTextDocument as jest.Mock).mockImplementation(
      (handler) => {
        changeHandler = handler;
        return { dispose: jest.fn() };
      },
    );

    (vscode.window.activeTextEditor as any) = mockEditor;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("registerSqlShortcuts", () => {
    it("should register text document change handler", () => {
      registerSqlShortcuts(mockContext);

      expect(vscode.workspace.onDidChangeTextDocument).toHaveBeenCalled();
      expect(mockContext.subscriptions).toHaveLength(1);
    });

    it("should ignore non-SQL files", async () => {
      (mockDocument as any).languageId = "javascript";

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: new vscode.Range(
              new vscode.Position(0, 2),
              new vscode.Position(0, 3),
            ),
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).not.toHaveBeenCalled();
    });

    it("should ignore changes with multiple content changes", async () => {
      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: new vscode.Range(
              new vscode.Position(0, 2),
              new vscode.Position(0, 3),
            ),
          },
          {
            text: " ",
            range: new vscode.Range(
              new vscode.Position(0, 3),
              new vscode.Position(0, 4),
            ),
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).not.toHaveBeenCalled();
    });

    it("should ignore non-space characters", async () => {
      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: "x",
            range: new vscode.Range(
              new vscode.Position(0, 2),
              new vscode.Position(0, 3),
            ),
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).not.toHaveBeenCalled();
    });

    it("should ignore when editor is not active", async () => {
      (vscode.window.activeTextEditor as any) = undefined;

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: new vscode.Range(
              new vscode.Position(0, 2),
              new vscode.Position(0, 3),
            ),
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).not.toHaveBeenCalled();
    });

    it("should ignore when editor document does not match event document", async () => {
      const otherDocument = {
        uri: { fsPath: "/other.sql" },
      } as unknown as vscode.TextDocument;
      (mockEditor as any).document = otherDocument;

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: new vscode.Range(
              new vscode.Position(0, 2),
              new vscode.Position(0, 3),
            ),
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).not.toHaveBeenCalled();
    });

    it("should expand SX shortcut to SELECT", async () => {
      (mockDocument.lineAt as jest.Mock).mockReturnValue({
        text: "SX ",
      });

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: {
              start: { line: 0, character: 2 },
            },
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).toHaveBeenCalled();
      expect(editBuilder.replace).toHaveBeenCalledWith(
        expect.any(vscode.Range),
        "SELECT ",
      );
    });

    it("should expand FX shortcut to FROM", async () => {
      (mockDocument.lineAt as jest.Mock).mockReturnValue({
        text: "FX ",
      });

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: {
              start: { line: 0, character: 2 },
            },
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).toHaveBeenCalled();
      expect(editBuilder.replace).toHaveBeenCalledWith(
        expect.any(vscode.Range),
        "FROM ",
      );
    });

    it("should expand JX shortcut to JOIN and trigger IntelliSense", async () => {
      (mockDocument.lineAt as jest.Mock).mockReturnValue({
        text: "JX ",
      });

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: {
              start: { line: 0, character: 2 },
            },
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).toHaveBeenCalled();
      expect(editBuilder.replace).toHaveBeenCalledWith(
        expect.any(vscode.Range),
        "JOIN ",
      );

      jest.advanceTimersByTime(100);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "editor.action.triggerSuggest",
      );
    });

    it("should expand WX shortcut to WHERE", async () => {
      (mockDocument.lineAt as jest.Mock).mockReturnValue({
        text: "WX ",
      });

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: {
              start: { line: 0, character: 2 },
            },
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).toHaveBeenCalled();
      expect(editBuilder.replace).toHaveBeenCalledWith(
        expect.any(vscode.Range),
        "WHERE ",
      );
    });

    it("should expand GX shortcut to GROUP BY", async () => {
      (mockDocument.lineAt as jest.Mock).mockReturnValue({
        text: "GX ",
      });

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: {
              start: { line: 0, character: 2 },
            },
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).toHaveBeenCalled();
      expect(editBuilder.replace).toHaveBeenCalledWith(
        expect.any(vscode.Range),
        "GROUP BY ",
      );
    });

    it("should expand HX shortcut to HAVING", async () => {
      (mockDocument.lineAt as jest.Mock).mockReturnValue({
        text: "HX ",
      });

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: {
              start: { line: 0, character: 2 },
            },
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).toHaveBeenCalled();
      expect(editBuilder.replace).toHaveBeenCalledWith(
        expect.any(vscode.Range),
        "HAVING ",
      );
    });

    it("should expand OX shortcut to ORDER BY", async () => {
      (mockDocument.lineAt as jest.Mock).mockReturnValue({
        text: "OX ",
      });

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: {
              start: { line: 0, character: 2 },
            },
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).toHaveBeenCalled();
      expect(editBuilder.replace).toHaveBeenCalledWith(
        expect.any(vscode.Range),
        "ORDER BY ",
      );
    });

    it("should expand LX shortcut to LIMIT", async () => {
      (mockDocument.lineAt as jest.Mock).mockReturnValue({
        text: "LX ",
      });

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: {
              start: { line: 0, character: 2 },
            },
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).toHaveBeenCalled();
      expect(editBuilder.replace).toHaveBeenCalledWith(
        expect.any(vscode.Range),
        "LIMIT ",
      );
    });

    it("should expand IX shortcut to INSERT INTO", async () => {
      (mockDocument.lineAt as jest.Mock).mockReturnValue({
        text: "IX ",
      });

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: {
              start: { line: 0, character: 2 },
            },
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).toHaveBeenCalled();
      expect(editBuilder.replace).toHaveBeenCalledWith(
        expect.any(vscode.Range),
        "INSERT INTO ",
      );
    });

    it("should expand UX shortcut to UPDATE", async () => {
      (mockDocument.lineAt as jest.Mock).mockReturnValue({
        text: "UX ",
      });

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: {
              start: { line: 0, character: 2 },
            },
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).toHaveBeenCalled();
      expect(editBuilder.replace).toHaveBeenCalledWith(
        expect.any(vscode.Range),
        "UPDATE ",
      );
    });

    it("should expand DX shortcut to DELETE FROM", async () => {
      (mockDocument.lineAt as jest.Mock).mockReturnValue({
        text: "DX ",
      });

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: {
              start: { line: 0, character: 2 },
            },
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).toHaveBeenCalled();
      expect(editBuilder.replace).toHaveBeenCalledWith(
        expect.any(vscode.Range),
        "DELETE FROM ",
      );
    });

    it("should expand CX shortcut to CREATE TABLE", async () => {
      (mockDocument.lineAt as jest.Mock).mockReturnValue({
        text: "CX ",
      });

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: {
              start: { line: 0, character: 2 },
            },
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).toHaveBeenCalled();
      expect(editBuilder.replace).toHaveBeenCalledWith(
        expect.any(vscode.Range),
        "CREATE TABLE ",
      );
    });

    it("should handle lowercase shortcuts", async () => {
      (mockDocument.lineAt as jest.Mock).mockReturnValue({
        text: "sx ",
      });

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: {
              start: { line: 0, character: 2 },
            },
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).toHaveBeenCalled();
      expect(editBuilder.replace).toHaveBeenCalledWith(
        expect.any(vscode.Range),
        "SELECT ",
      );
    });

    it("should ignore text that does not match any shortcut", async () => {
      (mockDocument.lineAt as jest.Mock).mockReturnValue({
        text: "ABC ",
      });

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: {
              start: { line: 0, character: 3 },
            },
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).not.toHaveBeenCalled();
    });

    it("should expand shortcut inside parentheses before closing paren", async () => {
      (mockDocument.lineAt as jest.Mock).mockReturnValue({
        text: "(SX )",
      });

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: {
              start: { line: 0, character: 3 },
            },
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).toHaveBeenCalled();
      expect(editBuilder.replace).toHaveBeenCalledWith(
        expect.any(vscode.Range),
        "SELECT ",
      );
    });

    it("should expand shortcut before semicolon on the same line", async () => {
      (mockDocument.lineAt as jest.Mock).mockReturnValue({
        text: "SELECT 1 FROM SOME_TABLE WX ;",
      });

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: {
              start: { line: 0, character: 27 },
            },
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).toHaveBeenCalled();
      expect(editBuilder.replace).toHaveBeenCalledWith(
        expect.any(vscode.Range),
        "WHERE ",
      );
    });

    it("should only process one shortcut at a time", async () => {
      (mockDocument.lineAt as jest.Mock).mockReturnValue({
        text: "SX FX ",
      });

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: {
              start: { line: 0, character: 5 },
            },
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).toHaveBeenCalledTimes(1);
    });

    describe("LIKE auto-snippet", () => {
      it('should replace "LIKE " with "LIKE \'%%\'" and set cursor between %%', async () => {
        (mockDocument.lineAt as jest.Mock).mockReturnValue({
          text: "LIKE ",
        });

        registerSqlShortcuts(mockContext);

        const changeEvent = {
          document: mockDocument,
          contentChanges: [
            {
              text: " ",
              range: {
                start: { line: 0, character: 4 },
              },
            },
          ],
        } as unknown as vscode.TextDocumentChangeEvent;

        await changeHandler!(changeEvent);

        expect(mockEditor.edit).toHaveBeenCalled();
        expect(editBuilder.replace).toHaveBeenCalledWith(
          expect.any(vscode.Range),
          "LIKE '%%'",
        );
        expect(mockEditor.selection).toBeDefined();
      });

      it('should handle lowercase "like "', async () => {
        (mockDocument.lineAt as jest.Mock).mockReturnValue({
          text: "like ",
        });

        registerSqlShortcuts(mockContext);

        const changeEvent = {
          document: mockDocument,
          contentChanges: [
            {
              text: " ",
              range: {
                start: { line: 0, character: 4 },
              },
            },
          ],
        } as unknown as vscode.TextDocumentChangeEvent;

        await changeHandler!(changeEvent);

        expect(mockEditor.edit).toHaveBeenCalled();
        expect(editBuilder.replace).toHaveBeenCalledWith(
          expect.any(vscode.Range),
          "like '%%'",
        );
      });

      it('should handle "NOT LIKE "', async () => {
        (mockDocument.lineAt as jest.Mock).mockReturnValue({
          text: "NOT LIKE ",
        });

        registerSqlShortcuts(mockContext);

        const changeEvent = {
          document: mockDocument,
          contentChanges: [
            {
              text: " ",
              range: {
                start: { line: 0, character: 8 },
              },
            },
          ],
        } as unknown as vscode.TextDocumentChangeEvent;

        await changeHandler!(changeEvent);

        expect(mockEditor.edit).toHaveBeenCalled();
        expect(editBuilder.replace).toHaveBeenCalledWith(
          expect.any(vscode.Range),
          "LIKE '%%'",
        );
      });

      it("should not trigger when LIKE is not followed by space at line end", async () => {
        (mockDocument.lineAt as jest.Mock).mockReturnValue({
          text: "LIKE something",
        });

        registerSqlShortcuts(mockContext);

        const changeEvent = {
          document: mockDocument,
          contentChanges: [
            {
              text: " ",
              range: {
                start: { line: 0, character: 14 },
              },
            },
          ],
        } as unknown as vscode.TextDocumentChangeEvent;

        await changeHandler!(changeEvent);

        expect(mockEditor.edit).not.toHaveBeenCalled();
      });

      it("should not trigger when LIKE is part of a word", async () => {
        (mockDocument.lineAt as jest.Mock).mockReturnValue({
          text: "LIKEY ",
        });

        registerSqlShortcuts(mockContext);

        const changeEvent = {
          document: mockDocument,
          contentChanges: [
            {
              text: " ",
              range: {
                start: { line: 0, character: 5 },
              },
            },
          ],
        } as unknown as vscode.TextDocumentChangeEvent;

        await changeHandler!(changeEvent);

        expect(mockEditor.edit).not.toHaveBeenCalled();
      });
    });

    it("should handle mssql language files", async () => {
      (mockDocument as any).languageId = "mssql";
      (mockDocument.lineAt as jest.Mock).mockReturnValue({
        text: "SX ",
      });

      registerSqlShortcuts(mockContext);

      const changeEvent = {
        document: mockDocument,
        contentChanges: [
          {
            text: " ",
            range: {
              start: { line: 0, character: 2 },
            },
          },
        ],
      } as unknown as vscode.TextDocumentChangeEvent;

      await changeHandler!(changeEvent);

      expect(mockEditor.edit).toHaveBeenCalled();
    });
  });
});
