import { formatJoinTargetPath } from "../server/completionJoinRelationUtils";

describe("formatJoinTargetPath Netezza qualification", () => {
  it("uses the double-dot form when the schema is the database default", () => {
    expect(formatJoinTargetPath(
      { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
      "netezza",
      "BAZA",
      true,
    )).toBe("BAZA..ORDERS");
  });

  it("uses the three-part form for an explicit non-default schema", () => {
    expect(formatJoinTargetPath(
      { database: "BAZA", schema: "PUBLIC", table: "ORDERS" },
      "netezza",
      "BAZA",
      false,
    )).toBe("BAZA.PUBLIC.ORDERS");
  });

  it("never emits the unsupported DB.TABLE two-part form", () => {
    expect(formatJoinTargetPath(
      { database: "BAZA", table: "ORDERS" },
      "netezza",
      "BAZA",
    )).toBe("BAZA..ORDERS");
    expect(formatJoinTargetPath(
      { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
      "netezza",
      "BAZA",
    )).toBe("BAZA.ADMIN.ORDERS");
    expect(formatJoinTargetPath(
      { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
      "netezza",
      "BAZA",
      false,
    )).not.toBe("BAZA.ORDERS");
  });

  it("does not strip or rewrite a quoted mixed-case table name", () => {
    expect(formatJoinTargetPath(
      { database: "BAZA", schema: "ADMIN", table: "lower_table" },
      "netezza",
      "BAZA",
      false,
    )).toBe('BAZA.ADMIN."lower_table"');
  });
});
