import { getSqlStatementAtPosition, splitSqlStatements } from "../src/statements";

describe("sql-core statement boundaries", () => {
  it("splits executable statements while ignoring comments, literals, and procedures", () => {
    const sql = [
      "  ;",
      "SELECT ';' AS value;",
      "/* outer /* nested */ comment; */ SELECT 2;",
      "-- ignored;\nSELECT 3;",
      "BEGIN_PROC SELECT 4; END_PROC; SELECT 5",
    ].join("\n");

    expect(splitSqlStatements(sql).map((statement) => statement.sql)).toEqual([
      "SELECT ';' AS value",
      "/* outer /* nested */ comment; */ SELECT 2",
      "-- ignored;\nSELECT 3",
      "BEGIN_PROC SELECT 4; END_PROC",
      "SELECT 5",
    ]);
  });

  it("handles escaped quotes, empty input, and position clamping", () => {
    expect(splitSqlStatements("   \"a;\"\"b\";   ")).toEqual([
      expect.objectContaining({ sql: "\"a;\"\"b\"" }),
    ]);
    expect(splitSqlStatements("  \n  ")).toEqual([]);

    const sql = "SELECT 1; SELECT 2";
    expect(getSqlStatementAtPosition(sql, -10)?.sql).toBe("SELECT 1");
    expect(getSqlStatementAtPosition(sql, sql.length + 10)?.sql).toBe("SELECT 2");
    expect(getSqlStatementAtPosition(sql, 9)).toBeNull();
  });
});
