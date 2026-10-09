jest.unmock("chevrotain");
import { parseSemanticScopeWithParser } from "../../providers/parsers/parserSqlContext";

describe("completion alias scope", () => {
  it("lets an alias in a nested query shadow the same alias of the outer query", () => {
    const sql = "SELECT * FROM SALES.CUSTOMERS X WHERE EXISTS (SELECT 1 FROM SALES.ORDERS X WHERE X.ORDER_ID > 0)";
    const inner = parseSemanticScopeWithParser(sql, sql.indexOf("X.ORDER_ID"), "netezza").preferredAliasBindings;
    expect(inner.get("X")?.table.toUpperCase()).toBe("ORDERS");
    const outer = parseSemanticScopeWithParser(sql, sql.indexOf("EXISTS"), "netezza").preferredAliasBindings;
    expect(outer.get("X")?.table.toUpperCase()).toBe("CUSTOMERS");
  });

  it("keeps outer aliases visible inside a correlated subquery", () => {
    const sql = "SELECT * FROM SALES.CUSTOMERS C WHERE EXISTS (SELECT 1 FROM SALES.ORDERS O WHERE O.CUSTOMER_ID = C.CUSTOMER_ID)";
    const bindings = parseSemanticScopeWithParser(sql, sql.lastIndexOf("C.CUSTOMER_ID"), "netezza").preferredAliasBindings;
    expect(bindings.get("C")?.table.toUpperCase()).toBe("CUSTOMERS");
    expect(bindings.get("O")?.table.toUpperCase()).toBe("ORDERS");
  });
});
