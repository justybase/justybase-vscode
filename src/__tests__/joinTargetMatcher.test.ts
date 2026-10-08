import { computeJoinTargetCandidates, type JoinIndexTable } from "../server/joinTargetMatcher";

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
});
