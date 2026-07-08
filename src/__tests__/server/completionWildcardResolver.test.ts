jest.unmock("chevrotain");

import { CompletionWildcardResolver } from "../../server/completionWildcardResolver";

describe("CompletionWildcardResolver", () => {
  let resolver: CompletionWildcardResolver;

  beforeEach(() => {
    resolver = new CompletionWildcardResolver();
  });

  it("returns empty array when definition query is not found", () => {
    const sources = resolver.extractWildcardTableSources(
      "SELECT 1",
      "MISSING_VIEW",
      "netezza",
    );

    expect(sources).toEqual([]);
  });

  it("extracts wildcard table sources from a CTE definition", () => {
    const sql = `
WITH MY_VIEW AS (
  SELECT o.*, c.NAME
  FROM ORDERS o
  JOIN CUSTOMERS c ON o.CUSTOMER_ID = c.ID
)
SELECT * FROM MY_VIEW;
`;
    const sources = resolver.extractWildcardTableSources(
      sql,
      "MY_VIEW",
      "netezza",
    );

    expect(sources.length).toBeGreaterThan(0);
    expect(sources.some((source) => source.table.toUpperCase() === "ORDERS")).toBe(
      true,
    );
  });

  it("extracts wildcard table sources from CREATE TABLE AS", () => {
    const sql = "CREATE TABLE CACHE_VIEW AS SELECT t.* FROM ITEMS t;";
    const sources = resolver.extractWildcardTableSources(
      sql,
      "CACHE_VIEW",
      "netezza",
    );

    expect(sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "ITEMS" }),
      ]),
    );
  });

  it("caches wildcard source lookups for identical inputs", () => {
    const sql = `
CREATE VIEW CACHE_VIEW AS
SELECT t.* FROM ITEMS t;
`;
    const first = resolver.extractWildcardTableSources(
      sql,
      "CACHE_VIEW",
      "netezza",
      "file:///cache.sql",
      1,
    );
    const second = resolver.extractWildcardTableSources(
      sql,
      "CACHE_VIEW",
      "netezza",
      "file:///cache.sql",
      1,
    );

    expect(second).toBe(first);
  });
});
