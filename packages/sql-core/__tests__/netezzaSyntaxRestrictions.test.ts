jest.unmock("chevrotain");

import { parseNetezzaSqlStatements } from "../src/parser/runtime";
import { NetezzaSqlSemanticValidator } from "../src/validation";

describe("Netezza compatibility-profile syntax restrictions", () => {
  const validator = new NetezzaSqlSemanticValidator();

  const preParseCodes = (sql: string): string[] => {
    const parsed = parseNetezzaSqlStatements({ sql });
    return validator
      .runPreParseChecks(parsed.lexResult)
      .errors.map((error) => error.code);
  };

  it.each([
    "SELECT 1 FETCH FIRST 1 ROWS ONLY",
    "SELECT 1 OFFSET 1 FETCH NEXT 1 ROWS ONLY",
  ])("rejects FETCH FIRST/NEXT in the Netezza profile: %s", (sql) => {
    expect(preParseCodes(sql)).toContain("NZS002");
  });

  it("rejects standalone OUTER JOIN but permits typed OUTER JOIN", () => {
    expect(
      preParseCodes("SELECT 1 FROM _V_DATABASE A OUTER JOIN _V_DATABASE B ON 1=1"),
    ).toContain("NZS003");
    expect(
      preParseCodes("SELECT 1 FROM _V_DATABASE A LEFT OUTER JOIN _V_DATABASE B ON 1=1"),
    ).not.toContain("NZS003");
  });

  it("rejects DROP IF EXISTS and permits ordinary DROP", () => {
    expect(preParseCodes("DROP TABLE T IF EXISTS")).toContain("NZS004");
    expect(preParseCodes("DROP TABLE IF EXISTS T")).toContain("NZS004");
    expect(preParseCodes("DROP TABLE T")).not.toContain("NZS004");
  });

  it("requires RESTRICT or CASCADE on ALTER TABLE column drops", () => {
    expect(preParseCodes("ALTER TABLE T DROP COLUMN C")).toContain("NZS005");
    expect(preParseCodes("ALTER TABLE T DROP C")).toContain("NZS005");
    expect(preParseCodes("ALTER TABLE T DROP COLUMN C RESTRICT")).not.toContain("NZS005");
    expect(preParseCodes("ALTER TABLE T DROP COLUMN C CASCADE")).not.toContain("NZS005");
  });

  it("rejects multi-row VALUES and accepts one row", () => {
    expect(preParseCodes("INSERT INTO T (A) VALUES (1), (2)")).toContain("NZS006");
    expect(preParseCodes("INSERT INTO T (A) VALUES (1)")).not.toContain("NZS006");
  });

  it("accepts standalone OFFSET and ORDER BY followed by OFFSET", () => {
    expect(validator.validate("SELECT 1 OFFSET 1").valid).toBe(true);
    expect(validator.validate("SELECT 1 ORDER BY 1 OFFSET 1").valid).toBe(true);
    expect(validator.validate("SELECT 1 LIMIT 2 OFFSET 1").valid).toBe(true);
  });
});
