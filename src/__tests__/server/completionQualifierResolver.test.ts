import {
  CompletionItemKind,
  InsertTextFormat,
  Position,
} from "vscode-languageserver/node";
import { CompletionContextExtractor } from "../../server/completionContextExtractor";
import { CompletionPathResolver } from "../../server/completionPathResolver";
import { CompletionQualifierResolver } from "../../server/completionQualifierResolver";
import { CompletionScopeResolver } from "../../server/completionScopeResolver";
import type { CompletionRequestContext } from "../../server/completionTypes";

function makeRequestContext(
  overrides: Partial<CompletionRequestContext> = {},
): CompletionRequestContext {
  return {
    documentUri: "file:///test.sql",
    documentVersion: 1,
    position: Position.create(0, 10),
    databaseKind: "netezza",
    effectiveDb: "MYDB",
    effectiveSchema: "PUBLIC",
    linePrefix: "T.",
    prevLine: "",
    cursorOffset: 10,
    documentText: "SELECT T. FROM ORDERS T",
    statement: {
      sql: "SELECT T. FROM ORDERS T",
      start: 0,
      end: 24,
    },
    statementOffset: 10,
    statementPrefix: "SELECT T.",
    localDefs: [],
    resolutionLocalDefs: [],
    variables: [],
    completionKeywords: [],
    sqlFunctionNames: [],
    specialBuiltinValues: [],
    ...overrides,
  };
}

describe("CompletionQualifierResolver", () => {
  const contextExtractor = new CompletionContextExtractor();
  let scopeResolver: CompletionScopeResolver;
  let pathResolver: CompletionPathResolver;
  let resolver: CompletionQualifierResolver;

  beforeEach(() => {
    scopeResolver = {
      resolveColumnsForQualifier: jest.fn(async () => [
        { label: "ID", kind: CompletionItemKind.Field, insertText: "ID" },
        { label: "NAME", kind: CompletionItemKind.Field, insertText: "NAME" },
      ]),
    } as unknown as CompletionScopeResolver;
    pathResolver = {
      resolveDotPathFallbackCompletions: jest.fn(async () => []),
    } as unknown as CompletionPathResolver;
    resolver = new CompletionQualifierResolver(
      contextExtractor,
      scopeResolver,
      pathResolver,
    );
  });

  it("returns column completions for alias qualifier", async () => {
    const result = await resolver.resolveQualifierCompletions(
      makeRequestContext({
        linePrefix: "SELECT T.",
        statementPrefix: "SELECT T.",
        position: Position.create(0, 9),
      }),
    );

    expect(result).toBeDefined();
    expect(result?.some((item) => item.label === "ID")).toBe(true);
    expect(result?.some((item) => item.label === "NAME")).toBe(true);
    expect(scopeResolver.resolveColumnsForQualifier).toHaveBeenCalledWith(
      expect.objectContaining({ qualifier: "T" }),
    );
  });

  it("returns undefined when line has no qualifier context", async () => {
    const result = await resolver.resolveQualifierCompletions(
      makeRequestContext({
        linePrefix: "SELECT ",
        statementPrefix: "SELECT ",
      }),
    );

    expect(result).toBeUndefined();
    expect(scopeResolver.resolveColumnsForQualifier).not.toHaveBeenCalled();
  });

  it("expands wildcard columns for alias.* pattern", async () => {
    const result = await resolver.resolveWildcardExpansionCompletions(
      makeRequestContext({
        linePrefix: "SELECT T.*",
        statementPrefix: "SELECT T.*",
        position: Position.create(0, 10),
      }),
    );

    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({
      label: "* (Expand Columns)",
      kind: CompletionItemKind.Snippet,
      insertTextFormat: InsertTextFormat.PlainText,
    });
    expect(result?.[0].textEdit?.newText).toBe("T.ID, T.NAME");
  });
});
