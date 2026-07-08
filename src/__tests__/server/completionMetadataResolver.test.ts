import { CompletionItemKind } from "vscode-languageserver/node";
import { CompletionMetadataResolver } from "../../server/completionMetadataResolver";
import { CompletionWildcardResolver } from "../../server/completionWildcardResolver";
import type { CompletionMetadataProvider } from "../../server/completionTypes";

function createMetadataProvider(): CompletionMetadataProvider {
  return {
    getContext: jest.fn(async () => ({
      effectiveDatabase: "MYDB",
      effectiveSchema: "ADMIN",
      databaseKind: "netezza" as const,
    })),
    getDatabases: jest.fn(async () => [{ name: "MYDB" }]),
    getSchemas: jest.fn(async () => [{ name: "ADMIN" }]),
    getTables: jest.fn(async () => [{ name: "USERS" }]),
    getViews: jest.fn(async () => []),
    getColumns: jest.fn(async () => [
      { name: "ID", type: "INTEGER" },
      { name: "NAME", type: "VARCHAR(100)" },
    ]),
    getProcedures: jest.fn(async () => []),
  };
}

describe("CompletionMetadataResolver", () => {
  it("returns column metadata for a qualified table source", async () => {
    const metadataProvider = createMetadataProvider();
    const resolver = new CompletionMetadataResolver(
      metadataProvider,
      new CompletionWildcardResolver(),
    );

    const items = await resolver.getMetadataColumnsForSource(
      "file:///test.sql",
      { db: "MYDB", schema: "ADMIN", table: "USERS" },
      "MYDB",
      "ADMIN",
      "netezza",
    );

    expect(items).toEqual([
      { name: "ID", type: "INTEGER" },
      { name: "NAME", type: "VARCHAR(100)" },
    ]);
    expect(metadataProvider.getColumns).toHaveBeenCalled();
  });

  it("returns table completions for db_schema_dot path context", async () => {
    const metadataProvider = createMetadataProvider();
    const resolver = new CompletionMetadataResolver(
      metadataProvider,
      new CompletionWildcardResolver(),
    );

    const items = await resolver.resolveTablePathCompletions(
      { kind: "db_schema_dot", dbName: "MYDB", schemaName: "ADMIN", partial: "" },
      [],
      "file:///test.sql",
      "MYDB",
      "netezza",
    );

    expect(items.some((item) => item.label === "USERS")).toBe(true);
    expect(items[0]?.kind).toBe(CompletionItemKind.Class);
  });

  it("resolves DB..TABLE without forcing effectiveSchema when schemas are disabled", async () => {
    const metadataProvider = createMetadataProvider();
    const resolver = new CompletionMetadataResolver(
      metadataProvider,
      new CompletionWildcardResolver(),
    );

    await resolver.getMetadataColumnsForSource(
      "file:///test.sql",
      { db: "JUST_DATA_5", table: "DIMACCOUNT_NS" },
      "MYDB",
      "ADMIN",
      "netezza",
      { netezzaSchemasEnabled: false },
    );

    expect(metadataProvider.getColumns).toHaveBeenCalledWith(
      "file:///test.sql",
      "JUST_DATA_5",
      "DIMACCOUNT_NS",
    );
    expect(metadataProvider.getColumns).not.toHaveBeenCalledWith(
      "file:///test.sql",
      "JUST_DATA_5",
      "DIMACCOUNT_NS",
      "ADMIN",
    );
  });

  it("resolves DB..TABLE using database default schema when schemas are enabled", async () => {
    const metadataProvider = {
      ...createMetadataProvider(),
      getNetezzaDefaultSchema: jest.fn(async () => "PUBLIC"),
    };
    const resolver = new CompletionMetadataResolver(
      metadataProvider,
      new CompletionWildcardResolver(),
    );

    await resolver.getMetadataColumnsForSource(
      "file:///test.sql",
      { db: "JUST_DATA_5", table: "DIMACCOUNT_NS" },
      "MYDB",
      "ADMIN",
      "netezza",
      { netezzaSchemasEnabled: true },
    );

    expect(metadataProvider.getNetezzaDefaultSchema).toHaveBeenCalledWith(
      "file:///test.sql",
      "JUST_DATA_5",
    );
    expect(metadataProvider.getColumns).toHaveBeenCalledWith(
      "file:///test.sql",
      "JUST_DATA_5",
      "DIMACCOUNT_NS",
      "PUBLIC",
    );
  });
});
