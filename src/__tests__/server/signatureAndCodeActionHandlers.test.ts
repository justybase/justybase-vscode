import type { Connection, CodeActionParams } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
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
});
