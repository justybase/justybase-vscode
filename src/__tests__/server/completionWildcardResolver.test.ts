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

  it("detects explicit CTE column lists", () => {
    const sql = `
WITH CTE1 (out_col1, out_col2) AS (
  SELECT * FROM DIMDATE
)
SELECT * FROM CTE1;
`;

    expect(
      resolver.definitionHasExplicitColumnList(sql, "CTE1", "netezza"),
    ).toBe(true);
    expect(
      resolver.definitionHasExplicitColumnList(sql, "DIMDATE", "netezza"),
    ).toBe(false);
  });

  it("returns statement-scoped offsets for CTE definitions", () => {
    const sql = `
WITH DIMDATE AS (SELECT 1 AS cte_col)
SELECT * FROM DIMDATE;

WITH cte2 AS (SELECT * FROM DIMDATE)
SELECT * FROM cte2;
`;
    const cte2Offset = resolver.findDefinitionScopeOffset(sql, "cte2", "netezza");
    const dimdateOffset = resolver.findDefinitionScopeOffset(sql, "DIMDATE", "netezza");

    expect(cte2Offset).toBeDefined();
    expect(dimdateOffset).toBeDefined();
    expect(cte2Offset).toBeGreaterThan(dimdateOffset ?? 0);
  });

  it("detects explicit CTE column lists from tokens when CST parse fails", () => {
    const sql = `
WITH c(out_a, out_b) AS (
  SELECT * FROM DIMDATE
)
SELECT c.
FROM c`;

    expect(
      resolver.definitionHasExplicitColumnList(sql, "c", "netezza"),
    ).toBe(true);
  });
});
