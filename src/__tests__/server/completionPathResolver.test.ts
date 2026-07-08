import { CompletionItemKind } from "vscode-languageserver/node";
import { CompletionContextExtractor } from "../../server/completionContextExtractor";
import { CompletionMetadataResolver } from "../../server/completionMetadataResolver";
import { CompletionPathResolver } from "../../server/completionPathResolver";
import type { CompletionRequestContext } from "../../server/completionTypes";

function makeRequestContext(
  overrides: Partial<CompletionRequestContext> = {},
): CompletionRequestContext {
  return {
    documentUri: "file:///test.sql",
    documentVersion: 1,
    position: { line: 0, character: 20 },
    databaseKind: "netezza",
    effectiveDb: "MYDB",
    effectiveSchema: "PUBLIC",
    linePrefix: "SELECT * FROM ",
    prevLine: "",
    cursorOffset: 14,
    documentText: "SELECT * FROM ",
    statement: { sql: "SELECT * FROM ", start: 0, end: 14 },
    statementOffset: 14,
    statementPrefix: "SELECT * FROM ",
    localDefs: [],
    resolutionLocalDefs: [],
    variables: [],
    completionKeywords: [],
    sqlFunctionNames: [],
    specialBuiltinValues: [],
    ...overrides,
  };
}

describe("CompletionPathResolver", () => {
  const contextExtractor = new CompletionContextExtractor();
  let metadataResolver: CompletionMetadataResolver;
  let resolver: CompletionPathResolver;

  beforeEach(() => {
    metadataResolver = {
      resolveTablePathCompletions: jest.fn(async () => [
        { label: "ORDERS", kind: CompletionItemKind.Class },
      ]),
      resolveProcedurePathCompletions: jest.fn(async () => []),
      resolveViewPathCompletions: jest.fn(async () => []),
      getMetadataColumnsForSource: jest.fn(async () => []),
    } as unknown as CompletionMetadataResolver;
    resolver = new CompletionPathResolver(contextExtractor, metadataResolver);
  });

  it("resolves FROM/JOIN table path completions", async () => {
    const result = await resolver.resolveRequestPathCompletions(
      makeRequestContext({
        statementPrefix: "SELECT * FROM ",
        linePrefix: "SELECT * FROM ",
      }),
    );

    expect(result).toEqual([{ label: "ORDERS", kind: CompletionItemKind.Class }]);
    expect(metadataResolver.resolveTablePathCompletions).toHaveBeenCalledWith(
      { kind: "from_join_name", partial: "" },
      [],
      "file:///test.sql",
      "MYDB",
      "netezza",
      true,
    );
  });

  it("returns undefined when no path context matches", async () => {
    const result = await resolver.resolveRequestPathCompletions(
      makeRequestContext({
        statementPrefix: "SELECT 1",
        linePrefix: "SELECT 1",
      }),
    );

    expect(result).toBeUndefined();
    expect(metadataResolver.resolveTablePathCompletions).not.toHaveBeenCalled();
  });

  it("resolveDotPathFallbackCompletions returns empty array without context", async () => {
    const result = await resolver.resolveDotPathFallbackCompletions(
      makeRequestContext({
        statementPrefix: "SELECT 1",
        linePrefix: "SELECT 1",
      }),
    );

    expect(result).toEqual([]);
  });
});
