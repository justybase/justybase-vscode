import { computeJoinTargetCandidates, type JoinIndexTable } from "../server/joinTargetMatcher";
import { isSelfNamedKeyColumn, keyColumnStem } from "../utils/relatedColumnNames";

const col = (name: string, isKey = false, joinReferences?: JoinIndexTable["columns"][number]["joinReferences"]) => ({
  name,
  normalizedName: name.toUpperCase(),
  isKey,
  joinReferences,
});
const ref = (toTable: string, toColumn: string, constraintName: string, ordinalPosition = 1) => ({
  fromSchema: "S", fromTable: "", fromColumn: "", toSchema: "S", toTable, toColumn, constraintName, ordinalPosition,
});

describe("computeJoinTargetCandidates", () => {
  const customer: JoinIndexTable = { name: "CUSTOMER", schema: "S", columns: [col("CUSTOMER_ID", true), col("NAME")] };
  const orders: JoinIndexTable = {
    name: "ORDERS", schema: "S",
    columns: [col("ORDER_ID", true), col("CUSTOMER_ID", false, [ref("CUSTOMER", "CUSTOMER_ID", "FK_O_C")])],
  };
  const unrelated: JoinIndexTable = { name: "AUDIT", schema: "S", columns: [col("EVENT"), col("PAYLOAD")] };

  it("finds declared FKs in the forward and reverse direction", () => {
    const fromCustomer = computeJoinTargetCandidates("DB", "S", [{ schema: "S", table: "CUSTOMER" }], [customer, orders, unrelated]);
    expect(fromCustomer.map((c) => c.table.name)).toEqual(["ORDERS"]);
    expect(fromCustomer[0].matches[0]).toMatchObject({ relationType: "foreignKey", sourceColumn: "CUSTOMER_ID", targetColumn: "CUSTOMER_ID" });

    const fromOrders = computeJoinTargetCandidates("DB", "S", [{ schema: "S", table: "ORDERS" }], [customer, orders, unrelated]);
    expect(fromOrders.map((c) => c.table.name)).toEqual(["CUSTOMER"]);
    expect(fromOrders[0].joinUsesDefaultSchema).toBe(true);
  });

  it("keeps composite FK column pairs together on one target", () => {
    const a: JoinIndexTable = { name: "A", schema: "S", columns: [col("K1"), col("K2")] };
    const b: JoinIndexTable = {
      name: "B", schema: "S",
      columns: [col("K1", false, [ref("A", "K1", "FK_B_A", 1)]), col("K2", false, [ref("A", "K2", "FK_B_A", 2)])],
    };
    const [target] = computeJoinTargetCandidates("DB", "S", [{ schema: "S", table: "A" }], [a, b]);
    expect(target.matches.map((m) => [m.sourceColumn, m.targetColumn, m.constraintName, m.ordinalPosition])).toEqual([
      ["K1", "K1", "FK_B_A", 1],
      ["K2", "K2", "FK_B_A", 2],
    ]);
  });

  it("uses the key-name heuristic only when no declared FK exists", () => {
    const history: JoinIndexTable = { name: "HISTORY", schema: "S", columns: [col("CUSTOMER_ID")] };
    const [target] = computeJoinTargetCandidates("DB", "S", [{ schema: "S", table: "CUSTOMER" }], [customer, history]);
    expect(target.matches).toEqual([expect.objectContaining({ relationType: "heuristic" })]);
  });

  it("labels catalog FK targets as parent (outbound) or child (inbound)", () => {
    const [parent] = computeJoinTargetCandidates("DB", "S", [{ schema: "S", table: "ORDERS" }], [customer, orders]);
    expect(parent.matches[0].targetRole).toBe("parent");
    const [child] = computeJoinTargetCandidates("DB", "S", [{ schema: "S", table: "CUSTOMER" }], [customer, orders]);
    expect(child.matches[0].targetRole).toBe("child");
  });
});

describe("self-named key heuristics (FK-less star schemas)", () => {
  const selfCol = (name: string, table: string) => ({
    ...col(name),
    selfNamedKey: isSelfNamedKeyColumn(name, table),
  });
  const table = (name: string, columns: string[]): JoinIndexTable => ({
    name,
    schema: "S",
    columns: columns.map((column) => selfCol(column, name)),
  });
  const fact = table("FACTINTERNETSALES", ["PRODUCTKEY", "ORDERDATEKEY", "SHIPDATEKEY", "CUSTOMERKEY", "SALESAMOUNT"]);
  const reseller = table("FACTRESELLERSALES", ["PRODUCTKEY", "ORDERDATEKEY"]);
  const product = table("DIMPRODUCT", ["PRODUCTKEY", "PRODUCTSUBCATEGORYKEY", "COLOR"]);
  const date = table("DIMDATE", ["DATEKEY", "CALENDARYEAR"]);

  it("recognizes keys named after their own table", () => {
    expect(keyColumnStem("PRODUCT_ID")).toBe("PRODUCT");
    expect(keyColumnStem("ID")).toBeUndefined();
    expect(isSelfNamedKeyColumn("PRODUCTKEY", "DIMPRODUCT")).toBe(true);
    expect(isSelfNamedKeyColumn("BRANCH_ID", "MIS_DIM_BRANCH")).toBe(true);
    expect(isSelfNamedKeyColumn("CUSTOMER_ID", "CUSTOMERS")).toBe(true);
    expect(isSelfNamedKeyColumn("CATEGORY_ID", "CATEGORIES")).toBe(true);
    expect(isSelfNamedKeyColumn("SALE_ID", "MIS_FACT_SALES")).toBe(true);
    expect(isSelfNamedKeyColumn("PRODUCTKEY", "DIMPRODUCTSUBCATEGORY")).toBe(false);
    expect(isSelfNamedKeyColumn("PRODUCTKEY", "FACTINTERNETSALES")).toBe(false);
    expect(isSelfNamedKeyColumn("COLOR", "DIMPRODUCT")).toBe(false);
  });

  it("pairs a fact with its dimensions without declared keys, never fact with fact", () => {
    const targets = computeJoinTargetCandidates("DB", "S", [{ schema: "S", table: "FACTINTERNETSALES" }], [fact, reseller, product, date]);
    expect(targets.map((target) => target.table.name).sort()).toEqual(["DIMDATE", "DIMPRODUCT"]);
    const productTarget = targets.find((target) => target.table.name === "DIMPRODUCT")!;
    expect(productTarget.matches).toEqual([
      expect.objectContaining({ sourceColumn: "PRODUCTKEY", targetColumn: "PRODUCTKEY", targetRole: "parent" }),
    ]);
  });

  it("offers role-playing date keys as separate alternatives", () => {
    const [dateTarget] = computeJoinTargetCandidates("DB", "S", [{ schema: "S", table: "FACTINTERNETSALES" }], [fact, date]);
    expect(dateTarget.matches.map((match) => [match.sourceColumn, match.targetColumn, match.targetRole])).toEqual([
      ["ORDERDATEKEY", "DATEKEY", "parent"],
      ["SHIPDATEKEY", "DATEKEY", "parent"],
    ]);
    expect(new Set(dateTarget.matches.map((match) => match.group)).size).toBe(2);
    const [factTarget] = computeJoinTargetCandidates("DB", "S", [{ schema: "S", table: "DIMDATE" }], [fact, date]);
    expect(factTarget.matches.every((match) => match.targetRole === "child")).toBe(true);
  });
});
