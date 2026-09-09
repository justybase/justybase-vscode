jest.unmock("chevrotain");

import {
  parseNetezzaSqlStatements,
  sanitizeNetezzaSql,
} from "../src/validation";

describe("package-owned Netezza parser", () => {
  it("builds the same statement CST shape used by the desktop validator", () => {
    const sql = "SELECT ORDER_ID FROM DB.PUBLIC.ORDERS WHERE ORDER_ID = 1;";
    const result = parseNetezzaSqlStatements({ sql });

    expect(result.lexResult.errors).toEqual([]);
    expect(result.parserErrors).toEqual([]);
    expect(result.actionableParserErrors).toEqual([]);
    expect(result.cst?.name).toBe("statements");
    expect(result.cst?.children.statement).toHaveLength(1);
    expect(result.lexResult.tokens.map((token) => token.image)).toEqual(
      expect.arrayContaining(["SELECT", "DB", ".", "PUBLIC", "ORDERS"]),
    );
  });

  it("preserves offsets while masking expression and identifier macros", () => {
    const sql = "SELECT &VALUE FROM DB..$TABLE WHERE ID = %sql(SELECT 1);";
    const sanitized = sanitizeNetezzaSql(sql);

    expect(sanitized).toHaveLength(sql.length);
    expect(sanitized.slice(0, 7)).toBe("SELECT ");
    expect(sanitized.indexOf("FROM")).toBe(sql.indexOf("FROM"));
    expect(sanitized.indexOf("WHERE")).toBe(sql.indexOf("WHERE"));
    expect(parseNetezzaSqlStatements({ sql }).lexResult.errors).toEqual([]);
  });

  it("accepts DECLARE macro declarations and leaves procedural declarations intact", () => {
    const sql = "DECLARE &TABLE_NAME = 'ORDERS'; SELECT * FROM &TABLE_NAME;";
    const result = parseNetezzaSqlStatements({ sql });

    expect(result.lexResult.errors).toEqual([]);
    expect(result.actionableParserErrors).toEqual([]);
    expect(result.macroReferenceRanges).toHaveLength(1);
    expect(sanitizeNetezzaSql("DECLARE value INTEGER;")).toBe(
      "DECLARE value INTEGER;",
    );
  });

  it.each([
    ["%put", "%put 😀;\nSELECT 1;", "SELECT 1;"],
    ["%include", "%include '😀.sql';\nSELECT 1;", "SELECT 1;"],
    [
      "%if",
      "%if 😀 = 😀 %then %do;\n  SELECT 1;\n%end;\nSELECT 2;",
      "SELECT 2;",
    ],
  ])("preserves UTF-16 offsets for astral characters in %s", (_name, sql, followingSql) => {
    const sanitized = sanitizeNetezzaSql(sql);
    const expectedOffset = sql.indexOf(followingSql);
    const result = parseNetezzaSqlStatements({ sql });

    expect(sanitized).toHaveLength(sql.length);
    expect(sanitized.indexOf(followingSql)).toBe(expectedOffset);
    expect(
      result.lexResult.tokens.find(
        (token) => token.image === "SELECT" && token.startOffset === expectedOffset,
      )?.startOffset,
    ).toBe(expectedOffset);
  });

  it("reports malformed SQL through the parser result without throwing", () => {
    const result = parseNetezzaSqlStatements({ sql: "SELECT FROM ;" });

    expect(result.cst).toBeUndefined();
    expect(result.actionableParserErrors.length).toBeGreaterThan(0);
  });

  it.each([
    ["macro declarations and references", "%let x=5;\n%put Value is &x;\nSELECT &x, ${ x }, $x;"],
    ["relation identifier references", "SELECT * FROM &table_name;\nSELECT * FROM $table_name;\nSELECT * FROM ${ table_name };"],
    ["chained directives", "%let x=1; %put &x; SELECT 1;"],
    ["python and standalone do directives", "%python script.py --value 1;\n%do;\nSELECT 1;\n%end;"],
    ["SQL-backed macro functions", "SELECT %sql(SELECT MAX(DATEKEY) FROM DB.PUBLIC.DIMDATE) AS max_key FROM DB.PUBLIC.DIMDATE WHERE REGION IN (%sqllist(SELECT REGION FROM DB.PUBLIC.REGIONS));"],
    ["embedded eval macro functions", "SELECT * FROM DB.PUBLIC.DIMDATE WHERE DATEKEY >= %eval(20240731 - 30);"],
    ["multiline declarations", `%LET dim_table = DB.PUBLIC.DIMDATE;
@SET run_id = 1;
%LET as_of_key = %SQL(
  SELECT MAX(DATEKEY)
  FROM &dim_table
);
%PUT as_of=&as_of_key;
SELECT &as_of_key AS as_of_key FROM &dim_table;`],
    ["multiline export directive", `%LET dim_table = DB.PUBLIC.DIMDATE;
%EXPORT(
  format='xlsx',
  file='/tmp/dimdate.xlsx',
  sheet='Dim Date',
  update=true,
  query=(
    SELECT DATEKEY, CALENDARQUARTER
    FROM &dim_table
  )
);
SELECT 1;`],
    ["conditional blocks", `%LET run_bad_sql = 0;
%IF &run_bad_sql = 1 %THEN %DO;
  THIS IS NOT VALID SQL FROM A SKIPPED BRANCH
%ELSE %DO;
  %PUT skipped invalid branch;
%END;
SELECT 1;`],
    ["nested conditional blocks", `%IF 1 = 1 %THEN %DO;
  %DO;
    SELECT 1;
  %END;
%ELSE %DO;
  THIS IS NOT VALID SQL;
%END;
SELECT 2;`],
    ["include directive", "%INCLUDE 'shared.sql';\nSELECT 1;"],
  ])("preserves the authoring recovery contract for %s", (_name, sql) => {
    const result = parseNetezzaSqlStatements({ sql });

    expect(result.lexResult.errors).toHaveLength(0);
    expect(result.actionableParserErrors).toHaveLength(0);
    expect(result.cst).toBeDefined();
    expect(sanitizeNetezzaSql(sql)).toHaveLength(sql.length);
  });

  it("does not treat macro markers inside strings or comments as syntax", () => {
    const result = parseNetezzaSqlStatements({
      sql: "SELECT '&x' AS literal -- &comment\n;",
    });

    expect(result.lexResult.errors).toHaveLength(0);
    expect(result.actionableParserErrors).toHaveLength(0);
    expect(result.cst).toBeDefined();
  });

  it("filters only parser errors explicitly marked as ignorable", () => {
    const sql = "SELECT A. FROM DB..DIMACCOUNT A;";
    const strictResult = parseNetezzaSqlStatements({ sql });
    const tolerantResult = parseNetezzaSqlStatements({
      sql,
      ignoreParserError: () => true,
    });

    expect(strictResult.parserErrors.length).toBeGreaterThan(0);
    expect(strictResult.actionableParserErrors.length).toBeGreaterThan(0);
    expect(tolerantResult.parserErrors.length).toBe(strictResult.parserErrors.length);
    expect(tolerantResult.actionableParserErrors).toHaveLength(0);
  });

  it("keeps parser session state isolated after each top-level parse", () => {
    const first = parseNetezzaSqlStatements({ sql: "SELECT 1;" });
    const second = parseNetezzaSqlStatements({ sql: "SELECT 2;" });

    expect(first.usedIsolatedParser).toBe(false);
    expect(second.usedIsolatedParser).toBe(false);
  });
});
