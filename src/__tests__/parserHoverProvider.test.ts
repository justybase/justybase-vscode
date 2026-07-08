import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import * as vscode from "vscode";
import type { ColumnMetadata } from "../metadata/types";
import type { MetadataCache } from "../metadataCache";
import type { ConnectionManager } from "../core/connectionManager";

const mockParseSemanticScope = jest.fn(() => ({
  preferredAliasBindings: new Map(),
  visibleLocalDefinitions: [],
}));

const mockGetStatementAtPosition = jest.fn(() => ({
  sql: "SELECT 1",
  start: 0,
}));

const mockResolveSqlRenameSymbol = jest.fn(() => null);

jest.mock("../providers/parsers/parserSqlContext", () => ({
  parseSemanticScopeWithParser: jest.fn((..._args: unknown[]) =>
    mockParseSemanticScope()
  ),
}));

jest.mock("../sql/sqlParser", () => ({
  SqlParser: {
    getStatementAtPosition: jest.fn((..._args: unknown[]) =>
      mockGetStatementAtPosition()
    ),
  },
}));

jest.mock("../sqlParser/symbols", () => ({
  resolveSqlRenameSymbol: jest.fn((..._args: unknown[]) =>
    mockResolveSqlRenameSymbol()
  ),
}));

jest.mock("../compatibility/configuration", () => ({
  getExtensionConfiguration: jest.fn(() => ({
    get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
  })),
}));

const isSqlLanguageClientRunningMock = jest.fn(() => false);
const isSqlLanguageClientReadyMock = jest.fn(() => false);
jest.mock("../activation/lspRegistration", () => {
  const actual = jest.requireActual("../activation/lspRegistration") as Record<
    string,
    unknown
  >;
  const lspDocumentSchemes = new Set([
    "file",
    "untitled",
    "vscode-notebook-cell",
  ]);
  return {
    ...actual,
    isSqlLanguageClientRunning: () => isSqlLanguageClientRunningMock(),
    isSqlLanguageClientReady: () => isSqlLanguageClientReadyMock(),
    isSqlLanguageClientReadyForDocument: (document: {
      uri: { scheme: string };
    }) =>
      isSqlLanguageClientReadyMock() &&
      lspDocumentSchemes.has(document.uri.scheme),
  };
});

import { NetezzaParserHoverProvider } from "../providers/parserHoverProvider";

function createMockColumn(
  name: string,
  type: string,
  description?: string
): ColumnMetadata {
  return {
    ATTNAME: name,
    FORMAT_TYPE: type,
    detail: type,
    label: name,
    documentation: description || "",
  };
}

function createMockMetadataCache(
  tables: Record<string, { description?: string; columns: ColumnMetadata[] }>
) {
  const objects: Array<{
    item: { OBJNAME?: string; TABLENAME?: string; label?: string };
    schema: string;
    description?: string;
  }> = [];

  for (const [key, table] of Object.entries(tables)) {
    const parts = key.split(".");
    const tableName = parts[parts.length - 1];
    const schema = parts.length > 1 ? parts[parts.length - 2] : "ADMIN";
    objects.push({
      item: { OBJNAME: tableName, TABLENAME: tableName },
      schema,
      description: table.description,
    });
  }

  return {
    getObjectsWithSchema: jest.fn((_conn: string, _db: string) => objects),
    getColumns: jest.fn((_conn: string, key: string) => {
      const normalizedKey = key.toUpperCase();
      for (const [k, table] of Object.entries(tables)) {
        const parts = k.split(".");
        const tableName = parts[parts.length - 1];
        const schema = parts.length > 1 ? parts[parts.length - 2] : "ADMIN";
        const fullKey = `JUST_DATA_2.${schema}.${tableName}`.toUpperCase();
        if (fullKey === normalizedKey) {
          return table.columns;
        }
      }
      return undefined;
    }),
    getColumnsAnySchema: jest.fn(() => undefined),
    findObjectWithType: jest.fn(
      (_conn: string, _db: string, _schema: string, table: string) => {
        const normalizedTable = table.toUpperCase();
        for (const [k] of Object.entries(tables)) {
          const parts = k.split(".");
          const tableName = parts[parts.length - 1];
          if (tableName.toUpperCase() === normalizedTable) {
            const schema = parts.length > 1 ? parts[parts.length - 2] : "ADMIN";
            return { objType: "TABLE", schema };
          }
        }
        return undefined;
      }
    ),
  };
}

function createMockConnectionManager() {
  return {
    getConnectionForExecution: jest.fn(() => "TEST_CONN"),
    getActiveConnectionName: jest.fn(() => "TEST_CONN"),
    getEffectiveDatabase: jest.fn(async () => "JUST_DATA_2"),
    getConnectionDatabaseKind: jest.fn(() => "netezza"),
  };
}

function createMockCancellationToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => {} }),
  } as unknown as vscode.CancellationToken;
}

function buildDocument(
  text: string,
  line: number,
  character: number,
  uri: vscode.Uri = {
    scheme: "file",
    path: "/test.sql",
    toString: () => "file:///test.sql",
  } as vscode.Uri,
) {
  const lines = text.split("\n");
  return {
    document: {
      getText: (range?: vscode.Range) => {
        if (!range) return text;
        const startOffset = text.split("\n").slice(0, range.start.line).reduce((acc, l) => acc + l.length + 1, 0) + range.start.character;
        const endOffset = text.split("\n").slice(0, range.end.line).reduce((acc, l) => acc + l.length + 1, 0) + range.end.character;
        return text.substring(startOffset, endOffset);
      },
      lineAt: (l: number) => ({ text: lines[l] || "" }),
      getWordRangeAtPosition: (_pos: vscode.Position, _regex: RegExp) => {
        const lineText = lines[line] || "";
        const wordRegex = /[A-Za-z_][A-Za-z0-9_$]*/g;
        let match: RegExpExecArray | null;
        while ((match = wordRegex.exec(lineText)) !== null) {
          const start = match.index;
          const end = start + match[0].length;
          if (character >= start && character <= end) {
            return new vscode.Range(
              new vscode.Position(line, start),
              new vscode.Position(line, end)
            );
          }
        }
        return undefined;
      },
      offsetAt: (pos: vscode.Position) => {
        let offset = 0;
        for (let i = 0; i < pos.line; i++) {
          offset += (lines[i] || "").length + 1;
        }
        return offset + pos.character;
      },
      uri,
    } as unknown as vscode.TextDocument,
    position: new vscode.Position(line, character),
  };
}

describe("NetezzaParserHoverProvider — description regression guard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isSqlLanguageClientRunningMock.mockReturnValue(false);
    isSqlLanguageClientReadyMock.mockReturnValue(false);
    mockParseSemanticScope.mockReturnValue({
      preferredAliasBindings: new Map(),
      visibleLocalDefinitions: [],
    });
    mockGetStatementAtPosition.mockReturnValue({ sql: "SELECT 1", start: 0 });
    mockResolveSqlRenameSymbol.mockReturnValue(null);
  });

  describe("table hover — columns with descriptions", () => {
    it("shows column description in table hover via alias X", async () => {
      mockParseSemanticScope.mockReturnValue({
        preferredAliasBindings: new Map([
          ["X", { schema: "ADMIN", table: "FACT_SALES_2", db: "JUST_DATA_2" }],
        ]),
        visibleLocalDefinitions: [],
      });

      const cache = createMockMetadataCache({
        "FACT_SALES_2": {
          description: "Daily sales facts",
          columns: [
            createMockColumn("PRODUCT_ID", "INTEGER", "Foreign key to DIMPRODUCT"),
            createMockColumn("SALES_AMOUNT", "DECIMAL(18,2)", "Net sales amount"),
          ],
        },
      });
      const connMgr = createMockConnectionManager();
      const provider = new NetezzaParserHoverProvider(
        cache as unknown as MetadataCache,
        connMgr as unknown as ConnectionManager
      );

      const { document, position } = buildDocument(
        "SELECT * FROM JUST_DATA_2.ADMIN.FACT_SALES_2 X\nWHERE X.PRODUCT_ID IS NOT NULL",
        0,
        45
      );

      const hover = await provider.provideHover(document, position, createMockCancellationToken());

      expect(hover).toBeDefined();
      const md = (hover as vscode.Hover).contents as unknown as vscode.MarkdownString;
      const text = md.value;
      expect(text).toContain("Foreign key to DIMPRODUCT");
      expect(text).toContain("Net sales amount");
    });

    it("truncates column description longer than 500 chars", async () => {
      mockParseSemanticScope.mockReturnValue({
        preferredAliasBindings: new Map([
          ["X", { schema: "ADMIN", table: "FACT_SALES_2", db: "JUST_DATA_2" }],
        ]),
        visibleLocalDefinitions: [],
      });

      const longDesc = "A".repeat(600);
      const cache = createMockMetadataCache({
        "FACT_SALES_2": {
          description: "Sales",
          columns: [
            createMockColumn("PRODUCT_ID", "INTEGER", longDesc),
          ],
        },
      });
      const connMgr = createMockConnectionManager();
      const provider = new NetezzaParserHoverProvider(
        cache as unknown as MetadataCache,
        connMgr as unknown as ConnectionManager
      );

      const { document, position } = buildDocument(
        "SELECT * FROM JUST_DATA_2.ADMIN.FACT_SALES_2 X\nWHERE X.PRODUCT_ID IS NOT NULL",
        0,
        45
      );

      const hover = await provider.provideHover(document, position, createMockCancellationToken());

      expect(hover).toBeDefined();
      const md = (hover as vscode.Hover).contents as unknown as vscode.MarkdownString;
      const text = md.value;
      expect(text).toContain("A".repeat(500) + "…");
      expect(text).not.toContain("A".repeat(600));
    });

    it("omits description suffix when column has no description", async () => {
      mockParseSemanticScope.mockReturnValue({
        preferredAliasBindings: new Map([
          ["X", { schema: "ADMIN", table: "FACT_SALES_2", db: "JUST_DATA_2" }],
        ]),
        visibleLocalDefinitions: [],
      });

      const cache = createMockMetadataCache({
        "FACT_SALES_2": {
          description: "Sales",
          columns: [
            createMockColumn("PRODUCT_ID", "INTEGER"),
            createMockColumn("SALES_AMOUNT", "DECIMAL(18,2)", "Amount"),
          ],
        },
      });
      const connMgr = createMockConnectionManager();
      const provider = new NetezzaParserHoverProvider(
        cache as unknown as MetadataCache,
        connMgr as unknown as ConnectionManager
      );

      const { document, position } = buildDocument(
        "SELECT * FROM JUST_DATA_2.ADMIN.FACT_SALES_2 X\nWHERE X.PRODUCT_ID IS NOT NULL",
        0,
        45
      );

      const hover = await provider.provideHover(document, position, createMockCancellationToken());

      expect(hover).toBeDefined();
      const md = (hover as vscode.Hover).contents as unknown as vscode.MarkdownString;
      const text = md.value;
      expect(text).toContain("`PRODUCT_ID` (INTEGER)");
      expect(text).toContain("`SALES_AMOUNT` (DECIMAL(18,2)) — Amount");
      expect(text).not.toContain("`PRODUCT_ID` (INTEGER) —");
    });

    it("shows table description in table hover", async () => {
      mockParseSemanticScope.mockReturnValue({
        preferredAliasBindings: new Map([
          ["X", { schema: "ADMIN", table: "FACT_SALES_2", db: "JUST_DATA_2" }],
        ]),
        visibleLocalDefinitions: [],
      });

      const cache = createMockMetadataCache({
        "FACT_SALES_2": {
          description: "Daily sales facts from all regions",
          columns: [],
        },
      });
      const connMgr = createMockConnectionManager();
      const provider = new NetezzaParserHoverProvider(
        cache as unknown as MetadataCache,
        connMgr as unknown as ConnectionManager
      );

      const { document, position } = buildDocument(
        "SELECT * FROM JUST_DATA_2.ADMIN.FACT_SALES_2 X\nWHERE X.PRODUCT_ID IS NOT NULL",
        0,
        45
      );

      const hover = await provider.provideHover(document, position, createMockCancellationToken());

      expect(hover).toBeDefined();
      const md = (hover as vscode.Hover).contents as unknown as vscode.MarkdownString;
      expect(md.value).toContain("Daily sales facts from all regions");
    });
  });

  describe("column hover — type and description", () => {
    it("shows column type and description when hovering qualified column", async () => {
      mockParseSemanticScope.mockReturnValue({
        preferredAliasBindings: new Map([
          ["X", { schema: "ADMIN", table: "FACT_SALES_2", db: "JUST_DATA_2" }],
        ]),
        visibleLocalDefinitions: [],
      });

      const cache = createMockMetadataCache({
        "FACT_SALES_2": {
          description: "Sales",
          columns: [
            createMockColumn("PRODUCT_ID", "INTEGER", "Foreign key to DIMPRODUCT"),
          ],
        },
      });
      const connMgr = createMockConnectionManager();
      const provider = new NetezzaParserHoverProvider(
        cache as unknown as MetadataCache,
        connMgr as unknown as ConnectionManager
      );

      const { document, position } = buildDocument(
        "SELECT * FROM JUST_DATA_2.ADMIN.FACT_SALES_2 X\nWHERE X.PRODUCT_ID IS NOT NULL",
        1,
        10
      );

      const hover = await provider.provideHover(document, position, createMockCancellationToken());

      expect(hover).toBeDefined();
      const md = (hover as vscode.Hover).contents as unknown as vscode.MarkdownString;
      const text = md.value;
      expect(text).toContain("**Column** `PRODUCT_ID`");
      expect(text).toContain("Type: `INTEGER`");
      expect(text).toContain("Description: Foreign key to DIMPRODUCT");
    });

    it("omits type and description lines when column metadata is missing", async () => {
      mockParseSemanticScope.mockReturnValue({
        preferredAliasBindings: new Map([
          ["X", { schema: "ADMIN", table: "FACT_SALES_2", db: "JUST_DATA_2" }],
        ]),
        visibleLocalDefinitions: [],
      });

      const cache = createMockMetadataCache({
        "FACT_SALES_2": {
          columns: [],
        },
      });
      const connMgr = createMockConnectionManager();
      const provider = new NetezzaParserHoverProvider(
        cache as unknown as MetadataCache,
        connMgr as unknown as ConnectionManager
      );

      const { document, position } = buildDocument(
        "SELECT * FROM JUST_DATA_2.ADMIN.FACT_SALES_2 X\nWHERE X.PRODUCT_ID IS NOT NULL",
        1,
        10
      );

      const hover = await provider.provideHover(document, position, createMockCancellationToken());

      expect(hover).toBeDefined();
      const md = (hover as vscode.Hover).contents as unknown as vscode.MarkdownString;
      const text = md.value;
      expect(text).toContain("**Column** `PRODUCT_ID`");
      expect(text).not.toContain("Type:");
      expect(text).not.toContain("Description:");
    });

    it("shows column type and description for unqualified column without table alias", async () => {
      mockParseSemanticScope.mockReturnValue({
        preferredAliasBindings: new Map([
          ["FACT_SALES_2", { schema: "ADMIN", table: "FACT_SALES_2", db: "JUST_DATA_2" }],
        ]),
        visibleLocalDefinitions: [],
      });

      const cache = createMockMetadataCache({
        "FACT_SALES_2": {
          columns: [
            createMockColumn("PRODUCT_ID", "INTEGER", "Foreign key to DIMPRODUCT"),
          ],
        },
      });
      const connMgr = createMockConnectionManager();
      const provider = new NetezzaParserHoverProvider(
        cache as unknown as MetadataCache,
        connMgr as unknown as ConnectionManager
      );

      const { document, position } = buildDocument(
        "SELECT PRODUCT_ID FROM JUST_DATA_2..FACT_SALES_2",
        0,
        10,
      );

      const hover = await provider.provideHover(document, position, createMockCancellationToken());

      expect(hover).toBeDefined();
      const md = (hover as vscode.Hover).contents as unknown as vscode.MarkdownString;
      const text = md.value;
      expect(text).toContain("**Column** `PRODUCT_ID`");
      expect(text).toContain("Type: `INTEGER`");
      expect(text).toContain("Description: Foreign key to DIMPRODUCT");
    });
  });

  it("skips parser-based hover when the SQL language client is ready for the document", async () => {
    isSqlLanguageClientReadyMock.mockReturnValue(true);
    const provider = new NetezzaParserHoverProvider(
      createMockMetadataCache({}) as unknown as import("../metadataCache").MetadataCache,
      createMockConnectionManager() as unknown as import("../core/connectionManager").ConnectionManager,
    );
    const { document, position } = buildDocument(
      "SELECT * FROM JUST_DATA_2.ADMIN.FACT_SALES_2",
      0,
      20,
    );

    const hover = await provider.provideHover(
      document,
      position,
      createMockCancellationToken(),
    );

    expect(hover).toBeUndefined();
    expect(mockParseSemanticScope).not.toHaveBeenCalled();
  });

  it("keeps parser-based hover for netezza-catalog documents when LSP is ready", async () => {
    isSqlLanguageClientReadyMock.mockReturnValue(true);
    const provider = new NetezzaParserHoverProvider(
      createMockMetadataCache({}) as unknown as import("../metadataCache").MetadataCache,
      createMockConnectionManager() as unknown as import("../core/connectionManager").ConnectionManager,
    );
    const { document, position } = buildDocument(
      "SELECT * FROM JUST_DATA_2.ADMIN.FACT_SALES_2",
      0,
      20,
      { scheme: "netezza-catalog", path: "/ddl", toString: () => "netezza-catalog:/ddl" } as vscode.Uri,
    );

    await provider.provideHover(
      document,
      position,
      createMockCancellationToken(),
    );

    expect(mockParseSemanticScope).toHaveBeenCalled();
  });

  it("returns only View Data affordance when LSP handles table metadata hover", async () => {
    isSqlLanguageClientReadyMock.mockReturnValue(true);
    const { document, position } = buildDocument(
      "SELECT * FROM JUST_DATA_2..FACT_SALES_2",
      1,
      5,
    );
    const tableRange = new vscode.Range(
      new vscode.Position(1, 0),
      new vscode.Position(1, 13),
    );
    const dataAffordanceResolver = {
      getReferenceAtPosition: jest.fn(async () => ({
        source: "from",
        notation: "double_dot",
        objectType: "TABLE",
        databaseName: "JUST_DATA_2",
        schemaName: "ADMIN",
        tableName: "FACT_SALES_2",
        resolvedPath: "JUST_DATA_2.ADMIN.FACT_SALES_2",
        description: "some comment",
        columnCount: 6,
        range: tableRange,
        commandArgs: {
          documentUri: document.uri.toString(),
          databaseName: "JUST_DATA_2",
          schemaName: "ADMIN",
          tableName: "FACT_SALES_2",
        },
      })),
    };
    const provider = new NetezzaParserHoverProvider(
      createMockMetadataCache({
        "FACT_SALES_2": {
          description: "some comment",
          columns: [
            createMockColumn("PRODUCT_ID", "INTEGER", "test column comment"),
          ],
        },
      }) as unknown as MetadataCache,
      createMockConnectionManager() as unknown as ConnectionManager,
      dataAffordanceResolver as unknown as import("../providers/sqlDataAffordanceResolver").SqlDataAffordanceResolver,
    );

    const hover = await provider.provideHover(
      document,
      position,
      createMockCancellationToken(),
    );

    expect(hover).toBeDefined();
    const md = (hover as vscode.Hover).contents as unknown as vscode.MarkdownString;
    expect(md.value).toContain("[View Data](command:netezza.action.viewTableData?");
    expect(md.value).not.toContain("Cached stats:");
    expect(md.value).not.toContain("Path:");
    expect(md.value).not.toContain("Description: some comment");
    expect(mockParseSemanticScope).not.toHaveBeenCalled();
  });
});
