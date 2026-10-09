import { TextDocument } from "vscode-languageserver-textdocument";
jest.unmock("chevrotain");
import { resolveColumnIdentityWithMetadata } from "../../server/handlers/symbolHandlers";

function bridge(tables: Record<string, string[]>) {
  const getTableInfo = jest.fn(async (_uri: string, database: string, table: string, schema?: string) => {
    const columns = tables[table.toUpperCase()];
    return columns
      ? { exists: true, table: table.toUpperCase(), database, schema, columns: columns.map(name => ({ name })) }
      : undefined;
  });
  return { getTableInfo } as unknown as Parameters<typeof resolveColumnIdentityWithMetadata>[2] & { getTableInfo: jest.Mock };
}

describe("resolveColumnIdentityWithMetadata", () => {
  const sql = "SELECT C.CUSTOMER_ID FROM SALES.CUSTOMERS C JOIN SALES.ORDERS O ON O.ORDER_ID = 1";

  it("loads metadata only for tables referenced by the document and resolves the catalog target", async () => {
    const document = TextDocument.create("file:///a.sql", "sql", 1, sql);
    const metadata = bridge({ CUSTOMERS: ["CUSTOMER_ID"], ORDERS: ["ORDER_ID", "CUSTOMER_ID"], OTHER: ["X"] });
    const identity = await resolveColumnIdentityWithMetadata(
      document, sql.indexOf("CUSTOMER_ID"), metadata, { databaseKind: "netezza", effectiveDatabase: "SHOP" });
    expect(identity?.catalog).toEqual({ database: "SHOP", schema: "SALES", relation: "CUSTOMERS", column: "CUSTOMER_ID" });
    const requested = metadata.getTableInfo.mock.calls.map(call => call[2]).sort();
    expect(requested).toEqual(["CUSTOMERS", "ORDERS"]);
  });

  it("returns a local definition for a CTE column without any metadata", async () => {
    const text = "WITH X AS (SELECT 1 AS CID) SELECT X.CID FROM X";
    const document = TextDocument.create("file:///b.sql", "sql", 1, text);
    const identity = await resolveColumnIdentityWithMetadata(
      document, text.lastIndexOf("CID"), bridge({}), { databaseKind: "netezza" });
    expect(identity?.definition?.startOffset).toBe(text.indexOf("CID"));
  });

  it("does not resolve columns for other dialects", async () => {
    const document = TextDocument.create("file:///c.sql", "sql", 1, sql);
    const identity = await resolveColumnIdentityWithMetadata(
      document, sql.indexOf("CUSTOMER_ID"), bridge({}), { databaseKind: "postgresql" } as never);
    expect(identity).toBeUndefined();
  });

  it("requests each referenced table once, not once per column reference", async () => {
    const text = "SELECT C.CUSTOMER_ID FROM SALES.CUSTOMERS C WHERE "
      + Array.from({ length: 500 }, () => "C.CUSTOMER_ID = 1").join(" OR ");
    const document = TextDocument.create("file:///d.sql", "sql", 1, text);
    const metadata = bridge({ CUSTOMERS: ["CUSTOMER_ID"] });
    const identity = await resolveColumnIdentityWithMetadata(
      document, text.indexOf("CUSTOMER_ID"), metadata, { databaseKind: "netezza", effectiveDatabase: "SHOP" });
    expect(identity?.occurrences).toHaveLength(501);
    expect(metadata.getTableInfo).toHaveBeenCalledTimes(1);
  });
});
