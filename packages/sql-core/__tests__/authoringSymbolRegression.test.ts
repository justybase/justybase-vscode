jest.unmock("chevrotain");
import { resolveSqlRenameSymbol } from "../src/validation/symbols";

test("a later local FROM alias shadows the parent alias in the SELECT projection", () => {
  const sql = "SELECT c.CUSTOMER_ID FROM customers c WHERE EXISTS (SELECT c.ORDER_ID FROM orders c)";
  const symbol = resolveSqlRenameSymbol(sql, sql.indexOf("c.ORDER_ID"));
  const definition = symbol?.occurrences.find(occurrence => occurrence.role === "definition");
  expect(definition?.startOffset).toBe(sql.lastIndexOf("c"));
});
