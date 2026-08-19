import type { Connection, CodeActionParams } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
jest.unmock("chevrotain");
import { registerCodeActionHandler } from "../../server/handlers/signatureAndCodeActionHandlers";

describe("signatureAndCodeActionHandlers code actions", () => {
  it("offers SQL048 qualification from diagnostic data", async () => {
    let handler:
      | ((params: CodeActionParams, token?: { isCancellationRequested: boolean }) => Promise<unknown>)
      | undefined;
    const connection = {
      onCodeAction: jest.fn((callback) => {
        handler = callback;
      }),
      console: {
        log: jest.fn(),
        error: jest.fn(),
      },
    } as unknown as Connection;
    const document = TextDocument.create(
      "file:///test.sql",
      "netezza-sql",
      1,
      "SELECT * FROM EMPLOYEES;",
    );
    const documents = {
      get: jest.fn(() => document),
    };

    registerCodeActionHandler({
      connection,
      documents: documents as never,
    });

    const actions = await handler?.(
      {
        textDocument: { uri: document.uri },
        range: {
          start: { line: 0, character: 14 },
          end: { line: 0, character: 23 },
        },
        context: {
          diagnostics: [
            {
              range: {
                start: { line: 0, character: 14 },
                end: { line: 0, character: 23 },
              },
              message: "SQL048",
              code: "SQL048",
              data: { suggestedFix: "DB1.PUBLIC.EMPLOYEES" },
            },
          ],
        },
      },
      { isCancellationRequested: false },
    );

    expect(actions).toEqual([
      expect.objectContaining({
        title: "Qualify as DB1.PUBLIC.EMPLOYEES",
        isPreferred: true,
      }),
    ]);
  });

  it("offers bounded SQL004, SQL051, and SQL052 edits", async () => {
    let handler:
      | ((params: CodeActionParams, token?: { isCancellationRequested: boolean }) => Promise<unknown>)
      | undefined;
    const connection = {
      onCodeAction: jest.fn((callback) => {
        handler = callback;
      }),
      console: {
        log: jest.fn(),
        error: jest.fn(),
      },
    } as unknown as Connection;
    const sql = "SELECT BAD_ID FROM DB..LEFT_TABLE L JOIN DB..RIGHT_TABLE ON L.ID = RIGHT_TABLE.ID CROSS JOIN DB..THIRD_TABLE;";
    const document = TextDocument.create("file:///typing.sql", "netezza-sql", 1, sql);
    const documents = { get: jest.fn(() => document) };
    registerCodeActionHandler({ connection, documents: documents as never });

    const actions = await handler?.(
      {
        textDocument: { uri: document.uri },
        range: { start: { line: 0, character: 7 }, end: { line: 0, character: 14 } },
        context: {
          diagnostics: [
            {
              range: { start: { line: 0, character: 7 }, end: { line: 0, character: 14 } },
              message: "SQL004",
              code: "SQL004",
              data: { suggestedFix: "ID" },
            },
            {
              range: {
                start: { line: 0, character: sql.indexOf("CROSS JOIN") },
                end: { line: 0, character: sql.indexOf("CROSS JOIN") + 10 },
              },
              message: "SQL051",
              code: "SQL051",
            },
            {
              range: {
                start: { line: 0, character: sql.indexOf("RIGHT_TABLE") },
                end: { line: 0, character: sql.indexOf("RIGHT_TABLE") + "RIGHT_TABLE".length },
              },
              message: "SQL052",
              code: "SQL052",
            },
          ],
        },
      },
      { isCancellationRequested: false },
    );

    expect(actions).toEqual([
      expect.objectContaining({ title: "Did you mean 'ID'?" }),
      expect.objectContaining({ title: "Replace CROSS JOIN with explicit INNER JOIN" }),
      expect.objectContaining({ title: expect.stringContaining("Add missing table alias") }),
    ]);
  });
});
