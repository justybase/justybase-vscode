jest.unmock("chevrotain");

import { Position } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getDatabaseSqlAuthoring } from "../../core/connectionFactory";
import type {
  MetadataColumnItem,
  MetadataContextResponse,
  MetadataObjectItem,
} from "../../lsp/protocol";
import { LspCompletionEngine } from "../../server/completionEngine";
import type { CompletionMetadataProvider } from "../../server/completionTypes";
import { DocumentParseSession, SqlValidator } from "../../sqlParser";
import * as parsingRuntime from "../../sqlParser/parsingRuntime";

class MockMetadataProvider implements CompletionMetadataProvider {
  readonly getContext = async (): Promise<MetadataContextResponse> => ({
    effectiveDatabase: "JUST_DATA",
    effectiveSchema: "ADMIN",
    databaseKind: "netezza",
  });

  readonly getDatabases = async (): Promise<MetadataObjectItem[]> => [
    { name: "JUST_DATA", detail: "Database" },
  ];

  readonly getSchemas = async (): Promise<MetadataObjectItem[]> => [
    { name: "ADMIN", detail: "Schema" },
  ];

  readonly getTables = async (): Promise<MetadataObjectItem[]> =>
    Array.from({ length: 20 }, (_, index) => ({
      name: `TABLE_${index}`,
      detail: "Table",
    }));

  readonly getViews = async (): Promise<MetadataObjectItem[]> => [];
  readonly getProcedures = async (): Promise<MetadataObjectItem[]> => [];

  readonly getColumns = async (): Promise<MetadataColumnItem[]> =>
    Array.from({ length: 10 }, (_, index) => ({
      name: `COL_${index}`,
      type: "INTEGER",
    }));

  readonly getTableInfo = async () => null;
  readonly getCachedTableInfo = async () => undefined;
}

function createLargeDocument(lineCount: number): TextDocument {
  const lines = Array.from(
    { length: lineCount },
    (_, index) =>
      `SELECT col_${index} FROM JUST_DATA.ADMIN.TABLE_${index % 20} t${index % 5};`,
  );
  return TextDocument.create(
    "file:///parse-session-lsp.sql",
    "sql",
    1,
    lines.join("\n"),
  );
}

describe("DocumentParseSession LSP integration", () => {
  let parseSpy: jest.SpyInstance;

  beforeEach(() => {
    parseSpy = jest.spyOn(parsingRuntime, "parseSqlStatements");
  });

  afterEach(() => {
    parseSpy.mockRestore();
  });

  it("reuses the full-document parse across repeated diagnostics validation", () => {
    const session = new DocumentParseSession();
    const document = createLargeDocument(500);
    const sql = document.getText();
    const validationProfile = getDatabaseSqlAuthoring("netezza").validation;
    const validator = new SqlValidator(undefined, validationProfile);
    const request = {
      documentUri: document.uri,
      documentVersion: document.version,
      sql,
      databaseKind: "netezza" as const,
      validationProfile,
    };

    validator.validateWithSession(sql, session, request);
    validator.validateWithSession(sql, session, request);

    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it("does not re-parse the full document when completion runs after diagnostics", async () => {
    const session = new DocumentParseSession();
    const document = createLargeDocument(500);
    const sql = document.getText();
    const validationProfile = getDatabaseSqlAuthoring("netezza").validation;
    const validator = new SqlValidator(undefined, validationProfile);
    const completionEngine = new LspCompletionEngine(
      new MockMetadataProvider(),
      session,
    );
    const request = {
      documentUri: document.uri,
      documentVersion: document.version,
      sql,
      databaseKind: "netezza" as const,
      validationProfile,
    };

    validator.validateWithSession(sql, session, request);

    const cursorLine = Math.min(document.lineCount - 1, 250);
    await completionEngine.provideCompletionItems(
      document,
      Position.create(cursorLine, 8),
    );

    const fullDocumentParseCalls = parseSpy.mock.calls.filter(
      (call) => call[0]?.sql === sql,
    ).length;
    expect(fullDocumentParseCalls).toBe(1);
  });
});
