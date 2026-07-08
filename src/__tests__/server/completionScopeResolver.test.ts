jest.unmock("chevrotain");

import { CompletionItemKind, Position } from "vscode-languageserver/node";
import { CompletionContextExtractor } from "../../server/completionContextExtractor";
import { CompletionMetadataResolver } from "../../server/completionMetadataResolver";
import { CompletionScopeResolver } from "../../server/completionScopeResolver";
import type { SemanticScopeCompletionRequest } from "../../server/completionScopeResolver";

function makeScopeRequest(
  overrides: Partial<SemanticScopeCompletionRequest> = {},
): SemanticScopeCompletionRequest {
  return {
    statement: {
      sql: "SELECT ",
      start: 0,
      end: 7,
    },
    statementOffset: 7,
    statementPrefix: "SELECT ",
    linePrefix: "SELECT ",
    position: Position.create(0, 7),
    localDefs: [],
    documentUri: "file:///scope.sql",
    documentVersion: 1,
    effectiveDb: "MYDB",
    effectiveSchema: "PUBLIC",
    databaseKind: "netezza",
    completionKeywords: ["FROM", "WHERE", "GROUP"],
    sqlFunctionNames: ["COUNT", "SUM"],
    specialBuiltinValues: ["NULL", "TRUE", "FALSE"],
    ...overrides,
  };
}

describe("CompletionScopeResolver", () => {
  const contextExtractor = new CompletionContextExtractor();
  let metadataResolver: CompletionMetadataResolver;
  let resolver: CompletionScopeResolver;

  beforeEach(() => {
    metadataResolver = {
      getMetadataColumnsForSource: jest.fn(async () => []),
      resolveLocalDefinitionColumns: jest.fn(async () => []),
    } as unknown as CompletionMetadataResolver;
    resolver = new CompletionScopeResolver(
      contextExtractor,
      metadataResolver,
    );
  });

  it("returns undefined outside expression clause context", async () => {
    const result = await resolver.getSemanticScopeCompletions(
      makeScopeRequest({
        statementPrefix: "CREATE TABLE T (",
        linePrefix: "CREATE TABLE T (",
      }),
    );

    expect(result).toBeUndefined();
  });

  it("returns expression completions in SELECT clause", async () => {
    const result = await resolver.getSemanticScopeCompletions(
      makeScopeRequest({
        statementPrefix: "SELECT ",
        linePrefix: "SELECT ",
      }),
    );

    expect(result).toBeDefined();
    expect(result?.length).toBeGreaterThan(0);
    expect(
      result?.some(
        (item) =>
          item.kind === CompletionItemKind.Function && item.label === "COUNT",
      ),
    ).toBe(true);
    expect(
      result?.some(
        (item) =>
          item.kind === CompletionItemKind.Keyword && item.label === "FROM",
      ),
    ).toBe(true);
  });

  it("resolves direct table qualifier columns via metadata", async () => {
    (metadataResolver.getMetadataColumnsForSource as jest.Mock).mockResolvedValue([
      { name: "ID", type: "INT4" },
      { name: "NAME", type: "VARCHAR" },
    ]);

    const columns = await resolver.resolveColumnsForQualifier({
      qualifier: "ORDERS",
      statement: { sql: "SELECT ORDERS. FROM ORDERS", start: 0, end: 26 },
      statementOffset: 14,
      documentText: "SELECT ORDERS. FROM ORDERS",
      cursorOffset: 14,
      localDefs: [],
      resolutionLocalDefs: [],
      documentUri: "file:///scope.sql",
      documentVersion: 1,
      effectiveDb: "MYDB",
      effectiveSchema: "PUBLIC",
      databaseKind: "netezza",
    });

    expect(columns).toHaveLength(2);
    expect(columns.map((item) => item.label)).toEqual(["ID", "NAME"]);
    expect(metadataResolver.getMetadataColumnsForSource).toHaveBeenCalledWith(
      "file:///scope.sql",
      expect.objectContaining({ table: "ORDERS" }),
      "MYDB",
      "PUBLIC",
      "netezza",
      expect.objectContaining({ netezzaSchemasEnabled: undefined }),
    );
  });
});
