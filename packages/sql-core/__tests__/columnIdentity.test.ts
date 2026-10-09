jest.unmock("chevrotain");
import { resolveSqlColumnIdentity, type SqlColumnCatalogLookup } from "../src/validation/columnIdentity";

const TABLES: Record<string, string[]> = {
  CUSTOMERS: ["CUSTOMER_ID", "CUSTOMER_NAME"],
  ORDERS: ["ORDER_ID", "CUSTOMER_ID"],
};

const lookup: SqlColumnCatalogLookup = (_database, _schema, table) => {
  const columns = TABLES[table.toUpperCase()];
  return columns ? { database: "SHOP", schema: "SALES", name: table.toUpperCase(), columns } : undefined;
};

function at(sqlWithCaret: string, catalog: SqlColumnCatalogLookup | undefined = lookup) {
  const cursor = sqlWithCaret.indexOf("|");
  const sql = sqlWithCaret.replace("|", "");
  const identity = resolveSqlColumnIdentity(sql, cursor, catalog);
  if (!identity) throw new Error("column identity was not resolved");
  return { sql, identity };
}

test("a qualified physical column resolves to a catalog target", () => {
  const { identity } = at("SELECT C.|CUSTOMER_ID FROM SHOP.SALES.CUSTOMERS C");
  expect(identity.status).toBe("resolved");
  expect(identity.definition).toBeUndefined();
  expect(identity.catalog).toEqual({ database: "SHOP", schema: "SALES", relation: "CUSTOMERS", column: "CUSTOMER_ID" });
});

test("an unqualified column in two sources is ambiguous, not guessed", () => {
  const { identity } = at("SELECT |CUSTOMER_ID FROM SHOP.SALES.CUSTOMERS C JOIN SHOP.SALES.ORDERS O ON O.ORDER_ID = 1");
  expect(identity.status).toBe("ambiguous");
  expect([...identity.candidates].sort()).toEqual(["CUSTOMERS", "ORDERS"]);
  expect(identity.catalog).toBeUndefined();
});

test("a CTE output column keeps its definition and physical origin", () => {
  const { identity } = at("WITH X AS (SELECT CUSTOMER_ID AS CID FROM SHOP.SALES.CUSTOMERS) SELECT X.|CID FROM X");
  expect(identity.relationKind).toBe("cte");
  expect(identity.relation).toBe("X");
  expect(identity.definition).toBeDefined();
  expect(identity.origin?.column).toBe("CUSTOMER_ID");
});

test("a nested derived projection chains its origin", () => {
  const { identity } = at("SELECT E.|CID FROM (SELECT D.CID FROM (SELECT CUSTOMER_ID AS CID FROM SHOP.SALES.CUSTOMERS) D) E");
  expect(identity.relationKind).toBe("derived_table");
  expect(identity.relation).toBe("E");
  expect(identity.origin?.column).toBe("CUSTOMER_ID");
});

test("ORDER BY binds an explicit output alias", () => {
  const { identity } = at("SELECT CUSTOMER_NAME AS NM FROM SHOP.SALES.CUSTOMERS ORDER BY |NM");
  expect(identity.relationKind).toBe("output_alias");
  expect(identity.origin?.column).toBe("CUSTOMER_NAME");
});

test("references exclude a same-named column from another source", () => {
  const { sql, identity } = at("SELECT C.CUSTOMER_ID, O.|CUSTOMER_ID FROM SHOP.SALES.CUSTOMERS C JOIN SHOP.SALES.ORDERS O ON O.CUSTOMER_ID = C.CUSTOMER_ID");
  const references = identity.occurrences.filter(occurrence => !occurrence.isDefinition);
  expect(references).toHaveLength(2);
  for (const reference of references) expect(sql.slice(reference.startOffset - 2, reference.startOffset)).toBe("O.");
});

test("without metadata a single source resolves and two sources stay unresolved", () => {
  const single = at("SELECT |ID FROM T", undefined).identity;
  expect(single.status).toBe("resolved");
  expect(single.catalog?.relation).toBe("T");
  expect(at("SELECT |ID FROM T JOIN U ON 1 = 1", undefined).identity.status).toBe("unresolved");
});

test("a script-local CTAS column resolves to its projection", () => {
  const { identity } = at("CREATE TEMP TABLE T1 AS SELECT CUSTOMER_ID AS CID FROM SHOP.SALES.CUSTOMERS;\nSELECT T1.|CID FROM T1");
  expect(identity.relationKind).toBe("script_local_table");
  expect(identity.relation).toBe("T1");
  expect(identity.origin?.column).toBe("CUSTOMER_ID");
});

test("incomplete SQL does not throw", () => {
  expect(() => resolveSqlColumnIdentity("SELECT C.CUSTOMER_ID FROM SHOP.SALES.CUSTOMERS C WHERE", 9, lookup)).not.toThrow();
});
