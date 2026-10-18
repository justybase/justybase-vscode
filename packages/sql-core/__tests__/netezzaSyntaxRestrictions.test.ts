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

  it("accepts a trailing DROP TABLE IF EXISTS and rejects every other position", () => {
    expect(preParseCodes("DROP TABLE T IF EXISTS")).not.toContain("NZS004");
    expect(preParseCodes("DROP TABLE TESTDB.PUBLIC.EMPLOYEES IF EXISTS")).not.toContain("NZS004");
    expect(preParseCodes("DROP TABLE A, B IF EXISTS")).not.toContain("NZS004");
    expect(preParseCodes("DROP TABLE JUST_DATA..T IF EXISTS")).not.toContain("NZS004");
    for (const keywordName of ["VALUE", "COMMENT", "TYPE", "KEY", "OWNER", "ACTION"]) {
      expect(preParseCodes(`DROP TABLE ${keywordName} IF EXISTS`)).not.toContain("NZS004");
    }
    expect(preParseCodes("DROP TABLE IF EXISTS T")).toContain("NZS004");
    expect(preParseCodes("DROP TABLE T")).not.toContain("NZS004");
    expect(preParseCodes("DROP VIEW V IF EXISTS")).toContain("NZS004");
    expect(preParseCodes("DROP SEQUENCE S IF EXISTS")).toContain("NZS004");
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

  it("rejects WITH ... INSERT but accepts SELECT after WITH (NZS013, live-verified)", () => {
    // Live Netezza 11.2.2.1: found "INSERT" expecting SELECT or `(`.
    expect(preParseCodes(
      "WITH SRC AS (SELECT 1 AS CODE) INSERT INTO T (CODE) SELECT CODE FROM SRC;",
    )).toContain("NZS013");
    // INSERT ... WITH (CTE in query position) stays accepted.
    expect(preParseCodes(
      "INSERT INTO T (CODE) WITH SRC AS (SELECT 1 AS CODE) SELECT CODE FROM SRC;",
    )).not.toContain("NZS013");
    expect(preParseCodes(
      "WITH A AS (SELECT 1 AS X) SELECT * FROM A;",
    )).not.toContain("NZS013");
  });

  it("rejects INSERT ... WITH without AS but accepts WITH ... AS (NZS016, live-verified)", () => {
    // Live Netezza 11.2.2.1: found "SELECT" expecting an identifier.
    expect(preParseCodes(
      "INSERT INTO T WITH ABC (SELECT 1 AS CODE) SELECT CODE FROM ABC;",
    )).toContain("NZS016");
    expect(preParseCodes(
      "INSERT INTO T (CODE) WITH SRC AS (SELECT 1 AS CODE) SELECT CODE FROM SRC;",
    )).not.toContain("NZS016");
    expect(preParseCodes(
      "INSERT INTO T WITH ABC (C1) AS (SELECT 1 AS C1) SELECT C1 FROM ABC;",
    )).not.toContain("NZS016");
  });

  it("rejects SERIAL/BIGSERIAL column types but accepts a column named serial (NZS014, live-verified)", () => {
    expect(preParseCodes(
      "CREATE TABLE SERIAL_TYPES (ID SERIAL, BIG_ID BIGSERIAL);",
    )).toContain("NZS014");
    expect(preParseCodes("CREATE TABLE T (serial INTEGER);")).not.toContain("NZS014");
    expect(preParseCodes("CREATE TABLE T (a INT, b VARCHAR(10));")).not.toContain("NZS014");
    expect(preParseCodes(
      "CREATE TABLE T (a INT, CONSTRAINT serial PRIMARY KEY (a));",
    )).not.toContain("NZS014");
  });

  it("rejects CLOB(n)/NCLOB(n) and bare BLOB column types (NZS015, live-verified)", () => {
    expect(preParseCodes(
      "CREATE TABLE LOB_TYPES (DATA CLOB(1000), NDATA NCLOB(500), RAW BLOB);",
    )).toContain("NZS015");
    expect(preParseCodes("CREATE TABLE T (a INT, b VARCHAR(10));")).not.toContain("NZS015");
    expect(preParseCodes("CREATE TABLE T (clob VARCHAR(10));")).not.toContain("NZS015");
  });

  it("accepts standalone OFFSET and ORDER BY followed by OFFSET", () => {
    expect(validator.validate("SELECT 1 OFFSET 1").valid).toBe(true);
    expect(validator.validate("SELECT 1 ORDER BY 1 OFFSET 1").valid).toBe(true);
    expect(validator.validate("SELECT 1 LIMIT 2 OFFSET 1").valid).toBe(true);
  });
});
