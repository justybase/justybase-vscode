import { findJoinColumnMatches, normalizeJoinColumnName } from "../server/completionJoinConditions";

describe("JOIN condition column matching", () => {
  it("normalizes catalog key and column prefixes without fuzzy matches", () => {
    expect(normalizeJoinColumnName("UK_COL_ACCOUNT_ID")).toBe("ACCOUNT_ID");
    expect(normalizeJoinColumnName('"FK_ACCOUNT_ID"')).toBe("ACCOUNT_ID");
    expect(normalizeJoinColumnName("ACCOUNT_ID_EXTRA")).not.toBe("ACCOUNT_ID");
  });

  it("matches exact normalized names and marks key-backed candidates", () => {
    const matches = findJoinColumnMatches(
      [{ name: "PK_ACCOUNT_ID", isPk: true }, { name: "CUSTOMER_ID" }],
      [{ name: "FK_ACCOUNT_ID", isFk: true }, { name: "CUSTOMER_ID" }, { name: "ACCOUNT_ID_EXTRA" }],
    );

    expect(matches).toEqual([
      expect.objectContaining({ isKeyMatch: true, left: { name: "PK_ACCOUNT_ID", isPk: true }, right: { name: "FK_ACCOUNT_ID", isFk: true } }),
      expect.objectContaining({ isKeyMatch: false, left: { name: "CUSTOMER_ID" }, right: { name: "CUSTOMER_ID" } }),
    ]);
  });
});
