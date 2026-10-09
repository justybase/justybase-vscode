jest.unmock("chevrotain");
import {
  SqlColumnIdentityAnalysis,
  resolveSqlColumnIdentity,
  type SqlColumnCatalogLookup,
} from "../src/validation/columnIdentity";
import {
  buildSqlColumnRenameEdits,
  describeSqlColumnForHover,
  prepareSqlColumnRename,
  resolveSqlColumnCatalogTarget,
} from "../src/validation/columnAuthoring";
import { parseNetezzaSqlForAuthoringRecovery, parseNetezzaSqlStatements } from "../src/parser/runtime";

const TABLES: Record<string, Array<[string, string]>> = {
  CUSTOMERS: [["CUSTOMER_ID", "INTEGER"], ["CUSTOMER_NAME", "VARCHAR(120)"], ["EMAIL", "VARCHAR(255)"]],
  ORDERS: [["ORDER_ID", "BIGINT"], ["CUSTOMER_ID", "INTEGER"], ["ORDER_DATE", "DATE"]],
};

const lookup: SqlColumnCatalogLookup = (_database, _schema, table) => {
  const columns = TABLES[table.toUpperCase()];
  return columns
    ? { database: "SHOP", schema: "SALES", name: table.toUpperCase(), columns: columns.map(([name]) => name), columnTypes: columns.map(([, type]) => type) }
    : undefined;
};

function caret(sqlWithCaret: string): { sql: string; cursor: number } {
  return { sql: sqlWithCaret.replace("|", ""), cursor: sqlWithCaret.indexOf("|") };
}

function rename(sqlWithCaret: string, newName: string): string | undefined {
  const { sql, cursor } = caret(sqlWithCaret);
  const edits = buildSqlColumnRenameEdits(sql, cursor, () => newName, lookup);
  if (!edits) return undefined;
  let result = sql;
  for (const edit of [...edits].reverse()) result = result.slice(0, edit.startOffset) + edit.newText + result.slice(edit.endOffset);
  return result;
}

describe("column hover", () => {
  it("reports relation, physical origin and metadata type of a CTE column", () => {
    const { sql, cursor } = caret("WITH X AS (SELECT CUSTOMER_ID AS CID FROM SHOP.SALES.CUSTOMERS) SELECT X.|CID FROM X");
    const info = describeSqlColumnForHover(resolveSqlColumnIdentity(sql, cursor, lookup)!);
    expect(info).toEqual({
      name: "CID", status: "resolved", relationKind: "cte", relation: "X",
      origin: { database: "SHOP", schema: "SALES", relation: "CUSTOMERS", column: "CUSTOMER_ID" },
      type: "INTEGER", candidates: [],
    });
  });

  it("never fabricates an origin or type for a computed column", () => {
    const { sql, cursor } = caret("WITH X AS (SELECT CUSTOMER_ID + 1 AS NEXT_ID FROM SHOP.SALES.CUSTOMERS) SELECT X.|NEXT_ID FROM X");
    const info = describeSqlColumnForHover(resolveSqlColumnIdentity(sql, cursor, lookup)!);
    expect(info.origin).toBeUndefined();
    expect(info.type).toBeUndefined();
  });

  it("keeps the origin but no type when metadata is unknown", () => {
    const { sql, cursor } = caret("WITH X AS (SELECT CODE AS C FROM SHOP.SALES.UNKNOWN) SELECT X.|C FROM X");
    const info = describeSqlColumnForHover(resolveSqlColumnIdentity(sql, cursor, lookup)!);
    expect(info.origin).toEqual({ database: "SHOP", schema: "SALES", relation: "UNKNOWN", column: "CODE" });
    expect(info.type).toBeUndefined();
  });

  it("does not choose a source for an ambiguous column", () => {
    const { sql, cursor } = caret("SELECT |CUSTOMER_ID FROM SHOP.SALES.CUSTOMERS C JOIN SHOP.SALES.ORDERS O ON O.ORDER_ID = 1");
    const info = describeSqlColumnForHover(resolveSqlColumnIdentity(sql, cursor, lookup)!);
    expect(info.status).toBe("ambiguous");
    expect(info.origin).toBeUndefined();
    expect(info.candidates.sort()).toEqual(["CUSTOMERS", "ORDERS"]);
  });
});

describe("column catalog target", () => {
  it("targets a physical column itself and a local projection through its origin", () => {
    const physical = caret("SELECT C.|EMAIL FROM SHOP.SALES.CUSTOMERS C");
    expect(resolveSqlColumnCatalogTarget(resolveSqlColumnIdentity(physical.sql, physical.cursor, lookup)))
      .toEqual({ database: "SHOP", schema: "SALES", relation: "CUSTOMERS", column: "EMAIL", via: "catalog" });
    const local = caret("SELECT D.|K FROM (SELECT ORDER_ID AS K FROM SHOP.SALES.ORDERS) D");
    expect(resolveSqlColumnCatalogTarget(resolveSqlColumnIdentity(local.sql, local.cursor, lookup)))
      .toEqual({ database: "SHOP", schema: "SALES", relation: "ORDERS", column: "ORDER_ID", via: "origin" });
  });

  it("has no target for computed or unresolved columns", () => {
    const computed = caret("WITH X AS (SELECT 1 AS ONE) SELECT X.|ONE FROM X");
    expect(resolveSqlColumnCatalogTarget(resolveSqlColumnIdentity(computed.sql, computed.cursor, lookup))).toBeUndefined();
    const unknown = caret("SELECT C.|NOPE FROM SHOP.SALES.CUSTOMERS C");
    expect(resolveSqlColumnCatalogTarget(resolveSqlColumnIdentity(unknown.sql, unknown.cursor, lookup))).toBeUndefined();
  });
});

describe("local column rename", () => {
  it("renames a CTE alias and its references only", () => {
    expect(rename("WITH X AS (SELECT CUSTOMER_ID AS CID FROM SHOP.SALES.CUSTOMERS) SELECT X.|CID, CUSTOMER_ID FROM X JOIN SHOP.SALES.CUSTOMERS C ON C.CUSTOMER_ID = X.CID", "KEY_ID"))
      .toBe("WITH X AS (SELECT CUSTOMER_ID AS KEY_ID FROM SHOP.SALES.CUSTOMERS) SELECT X.KEY_ID, CUSTOMER_ID FROM X JOIN SHOP.SALES.CUSTOMERS C ON C.CUSTOMER_ID = X.KEY_ID");
  });

  it("renames an explicit CTE column list entry", () => {
    expect(rename("WITH X (|CID) AS (SELECT CUSTOMER_ID FROM SHOP.SALES.CUSTOMERS) SELECT CID FROM X", "K"))
      .toBe("WITH X (K) AS (SELECT CUSTOMER_ID FROM SHOP.SALES.CUSTOMERS) SELECT K FROM X");
  });

  it("rejects physical, ambiguous, pass-through and star columns", () => {
    expect(rename("SELECT C.|EMAIL FROM SHOP.SALES.CUSTOMERS C", "MAIL")).toBeUndefined();
    expect(rename("SELECT |CUSTOMER_ID FROM SHOP.SALES.CUSTOMERS C JOIN SHOP.SALES.ORDERS O ON O.ORDER_ID = 1", "K")).toBeUndefined();
    expect(rename("WITH X AS (SELECT CUSTOMER_ID FROM SHOP.SALES.CUSTOMERS) SELECT X.|CUSTOMER_ID FROM X", "K")).toBeUndefined();
    expect(rename("WITH X AS (SELECT * FROM SHOP.SALES.CUSTOMERS) SELECT X.|EMAIL FROM X", "MAIL")).toBeUndefined();
  });

  it("rejects a column that feeds an outer projection by name", () => {
    expect(rename("SELECT E.CID FROM (SELECT D.CID FROM (SELECT CUSTOMER_ID AS |CID FROM SHOP.SALES.CUSTOMERS) D) E", "K")).toBeUndefined();
  });

  it("rejects capture of another reference and new ambiguity", () => {
    const sql = "WITH X AS (SELECT CUSTOMER_ID AS CID FROM SHOP.SALES.CUSTOMERS) SELECT X.|CID, ORDER_DATE FROM X JOIN SHOP.SALES.ORDERS O ON O.CUSTOMER_ID = X.CID";
    expect(rename(sql, "ORDER_DATE")).toBeUndefined();
    // Qualified references stay bound to X, so this rename is safe.
    expect(rename(sql, "ORDER_ID")).toBeDefined();
    const unqualified = "WITH X AS (SELECT CUSTOMER_ID AS CID FROM SHOP.SALES.CUSTOMERS) SELECT |CID FROM X JOIN SHOP.SALES.ORDERS O ON O.CUSTOMER_ID = X.CID";
    expect(rename(unqualified, "ORDER_ID")).toBeUndefined();
  });

  it("rejects inner-scope capture of a correlated reference", () => {
    expect(rename("SELECT C.EMAIL FROM SHOP.SALES.CUSTOMERS C WHERE EXISTS (SELECT 1 FROM (SELECT ORDER_ID AS |OID FROM SHOP.SALES.ORDERS) D WHERE EMAIL IS NOT NULL)", "EMAIL"))
      .toBeUndefined();
  });

  it("rejects a sibling projected column collision", () => {
    expect(rename("WITH X AS (SELECT CUSTOMER_ID AS |CID, EMAIL AS NM FROM SHOP.SALES.CUSTOMERS) SELECT X.CID, X.NM FROM X", "NM")).toBeUndefined();
  });

  it("prepares only renamable columns", () => {
    const { sql, cursor } = caret("WITH X AS (SELECT CUSTOMER_ID AS CID FROM SHOP.SALES.CUSTOMERS) SELECT X.|CID FROM X");
    const analysis = SqlColumnIdentityAnalysis.analyze(sql, lookup)!;
    expect(prepareSqlColumnRename(analysis, sql, cursor)).toMatchObject({ startOffset: cursor, endOffset: cursor + 3 });
    const physical = sql.indexOf("CUSTOMER_ID");
    expect(prepareSqlColumnRename(analysis, sql, physical)).toBeUndefined();
  });
});

describe("incomplete SQL", () => {
  it("keeps column identity across a trailing select-list comma and an unfinished WHERE", () => {
    const comma = caret("SELECT C.CUSTOMER_ID,\nFROM SHOP.SALES.CUSTOMERS C\nWHERE C.|CUSTOMER_ID > 0");
    expect(resolveSqlColumnIdentity(comma.sql, comma.cursor, lookup)?.occurrences).toHaveLength(2);
    const where = caret("SELECT D.CID FROM (SELECT CUSTOMER_ID AS CID FROM SHOP.SALES.CUSTOMERS) D WHERE D.|CID =");
    expect(resolveSqlColumnIdentity(where.sql, where.cursor, lookup)?.relationKind).toBe("derived_table");
  });

  it("never reports the recovery placeholder as a column", () => {
    const { sql, cursor } = caret("SELECT C.| FROM SHOP.SALES.CUSTOMERS C");
    expect(resolveSqlColumnIdentity(sql, cursor, lookup)).toBeUndefined();
  });

  it("does not make invalid SQL valid for diagnostics", () => {
    const sql = "SELECT C.CUSTOMER_ID,\nFROM SHOP.SALES.CUSTOMERS C";
    expect(parseNetezzaSqlStatements({ sql }).parserErrors.length).toBeGreaterThan(0);
    expect(parseNetezzaSqlForAuthoringRecovery(sql)).toBeDefined();
  });

  it("fails gracefully when no bounded repair helps", () => {
    const { sql, cursor } = caret("SELECT C.|CUSTOMER_ID FROM SHOP.SALES.CUSTOMERS C WHERE = = = = = = 1");
    expect(resolveSqlColumnIdentity(sql, cursor, lookup)).toBeUndefined();
  });
});

describe("analysis reuse", () => {
  it("answers many offsets from one analysis with the same identities as fresh resolution", () => {
    const sql = "WITH X AS (SELECT CUSTOMER_ID AS CID FROM SHOP.SALES.CUSTOMERS) SELECT X.CID, X.CID + 1 FROM X WHERE X.CID > 0";
    const analysis = SqlColumnIdentityAnalysis.analyze(sql, lookup)!;
    for (let offset = 0; offset < sql.length; offset++) {
      expect(analysis.identityAt(offset)).toEqual(resolveSqlColumnIdentity(sql, offset, lookup));
    }
  });
});
