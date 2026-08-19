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

  it("builds the CROSS JOIN fix from the affected statement only", async () => {
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
    const sql = "SELECT * FROM T1 CROSS JOIN T2; SELECT FROM;";
    const document = TextDocument.create("file:///cross-join.sql", "netezza-sql", 1, sql);
    const documents = { get: jest.fn(() => document) };
    registerCodeActionHandler({ connection, documents: documents as never });

    const crossOffset = sql.indexOf("CROSS JOIN");
    const actions = await handler?.(
      {
        textDocument: { uri: document.uri },
        range: {
          start: { line: 0, character: crossOffset },
          end: { line: 0, character: crossOffset + "CROSS JOIN".length },
        },
        context: {
          diagnostics: [
            {
              range: {
                start: { line: 0, character: crossOffset },
                end: { line: 0, character: crossOffset + "CROSS JOIN".length },
              },
              message: "SQL051",
              code: "SQL051",
            },
          ],
        },
      },
      { isCancellationRequested: false },
    );

    expect(actions).toEqual([
      expect.objectContaining({
        title: "Replace CROSS JOIN with explicit INNER JOIN",
      }),
    ]);
  });

  it("avoids aliases already used by FROM sources", async () => {
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
    const sql = "SELECT customers.id FROM orders C1 JOIN customers ON C1.id = customers.id;";
    const document = TextDocument.create("file:///join-alias.sql", "netezza-sql", 1, sql);
    const documents = { get: jest.fn(() => document) };
    registerCodeActionHandler({ connection, documents: documents as never });

    const joinTableOffset = sql.indexOf("customers", sql.indexOf("JOIN"));
    const actions = await handler?.(
      {
        textDocument: { uri: document.uri },
        range: {
          start: { line: 0, character: joinTableOffset },
          end: { line: 0, character: joinTableOffset + "customers".length },
        },
        context: {
          diagnostics: [
            {
              range: {
                start: { line: 0, character: joinTableOffset },
                end: { line: 0, character: joinTableOffset + "customers".length },
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
      expect.objectContaining({
        title: "Add missing table alias 'C2' and update references",
      }),
    ]);
  });

  it.each(["mssql", "mysql"] as const)(
    "uses the %s lexer for SQL052 sources",
    async (databaseKind) => {
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
      const quote = String.fromCharCode(96);
      const sql =
        databaseKind === "mysql"
          ? "SELECT customers.id FROM " +
            quote +
            "orders" +
            quote +
            " JOIN " +
            quote +
            "customers" +
            quote +
            " ON orders.id = customers.id;"
          : "SELECT customers.id FROM [dbo].[orders] JOIN [dbo].[customers] ON orders.id = customers.id;";
      const document = TextDocument.create(
        "file:///" + databaseKind + "-join.sql",
        databaseKind + "-sql",
        1,
        sql,
      );
      const documents = { get: jest.fn(() => document) };
      const metadataBridge = {
        getContext: jest.fn(async () => ({ databaseKind })),
      };
      registerCodeActionHandler({
        connection,
        documents: documents as never,
        metadataBridge: metadataBridge as never,
      });

      const joinTableOffset = sql.indexOf(
        "customers",
        sql.indexOf("JOIN"),
      );
      const actions = await handler?.(
        {
          textDocument: { uri: document.uri },
          range: {
            start: { line: 0, character: joinTableOffset },
            end: {
              line: 0,
              character: joinTableOffset + "customers".length,
            },
          },
          context: {
            diagnostics: [
              {
                range: {
                  start: { line: 0, character: joinTableOffset },
                  end: {
                    line: 0,
                    character: joinTableOffset + "customers".length,
                  },
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
        expect.objectContaining({
          title: "Add missing table alias 'C1' and update references",
        }),
      ]);
    },
  );
});
