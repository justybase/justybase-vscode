import { jest } from "@jest/globals";
import { describe, expect, it } from "@jest/globals";

jest.unmock("chevrotain");

import {
  BASE_SQL_PARSING_RUNTIME,
  NETEZZA_SQL_PARSING_RUNTIME,
  parseSqlStatements,
  runWithSqlParserSession,
} from "../../sqlParser";
import { isIgnorableTrailingDotParserError } from "../../sqlParser/parserErrorUtils";

describe("sqlParser/parsingRuntime", () => {
  it("falls back to an isolated parser instance for nested runtime sessions", () => {
    const runtime = NETEZZA_SQL_PARSING_RUNTIME;
    const sharedParser = runtime.getSqlParserInstance();
    let outerParser = sharedParser;
    let innerParser = sharedParser;

    const innerUsedIsolatedParser = runWithSqlParserSession(
      runtime,
      (outerSession) => {
        outerParser = outerSession.parser;
        return runWithSqlParserSession(runtime, (innerSession) => {
          innerParser = innerSession.parser;
          return innerSession.usedIsolatedParser;
        });
      },
    );

    expect(outerParser).toBe(sharedParser);
    expect(innerUsedIsolatedParser).toBe(true);
    expect(innerParser).not.toBe(sharedParser);
  });

  it("reports isolated parser usage only for nested parse execution", () => {
    const runtime = NETEZZA_SQL_PARSING_RUNTIME;

    const topLevelResult = parseSqlStatements({
      sql: "SELECT 1;",
      runtime,
    });
    const nestedResult = runWithSqlParserSession(runtime, () =>
      parseSqlStatements({
        sql: "SELECT 1;",
        runtime,
      }),
    );

    expect(topLevelResult.usedIsolatedParser).toBe(false);
    expect(topLevelResult.cst).toBeDefined();
    expect(nestedResult.usedIsolatedParser).toBe(true);
    expect(nestedResult.cst).toBeDefined();
  });

  it("keeps trailing-dot recovery opt-in for callers that request it", () => {
    const sql = "SELECT A. FROM JUST_DATA..DIMACCOUNT A;";

    const tolerantResult = parseSqlStatements({
      sql,
      runtime: NETEZZA_SQL_PARSING_RUNTIME,
      ignoreParserError: isIgnorableTrailingDotParserError,
    });
    const strictResult = parseSqlStatements({
      sql,
      runtime: NETEZZA_SQL_PARSING_RUNTIME,
    });

    expect(tolerantResult.lexResult.errors).toHaveLength(0);
    expect(tolerantResult.parserErrors.length).toBeGreaterThan(0);
    expect(tolerantResult.actionableParserErrors).toHaveLength(0);
    expect(strictResult.parserErrors.length).toBeGreaterThan(0);
    expect(strictResult.actionableParserErrors.length).toBeGreaterThan(0);
  });

  it("preserves runtime-specific parsing behavior through the shared helper", () => {
    const sql = "SELECT * FROM DB1..TABLE1;";

    const baseResult = parseSqlStatements({
      sql,
      runtime: BASE_SQL_PARSING_RUNTIME,
    });
    const netezzaResult = parseSqlStatements({
      sql,
      runtime: NETEZZA_SQL_PARSING_RUNTIME,
    });

    expect(baseResult.lexResult.errors).toHaveLength(0);
    expect(baseResult.actionableParserErrors.length).toBeGreaterThan(0);
    expect(netezzaResult.lexResult.errors).toHaveLength(0);
    expect(netezzaResult.actionableParserErrors).toHaveLength(0);
    expect(netezzaResult.cst).toBeDefined();
  });

  it("sanitizes extension macro declarations and macro references before parsing", () => {
    const result = parseSqlStatements({
      sql: "%let x=5;\n%put Value is &x;\nSELECT &x, ${ x }, $x;",
      runtime: NETEZZA_SQL_PARSING_RUNTIME,
    });

    expect(result.lexResult.errors).toHaveLength(0);
    expect(result.actionableParserErrors).toHaveLength(0);
    expect(result.cst).toBeDefined();
  });

  it("preserves macro references used as relation identifiers", () => {
    const result = parseSqlStatements({
      sql: "SELECT * FROM &table_name;\nSELECT * FROM $table_name;\nSELECT * FROM ${ table_name };",
      runtime: NETEZZA_SQL_PARSING_RUNTIME,
    });

    expect(result.lexResult.errors).toHaveLength(0);
    expect(result.actionableParserErrors).toHaveLength(0);
    expect(result.cst).toBeDefined();
  });

  it("sanitizes chained macro directives on the same line", () => {
    const result = parseSqlStatements({
      sql: "%let x=1; %put &x; SELECT 1;",
      runtime: NETEZZA_SQL_PARSING_RUNTIME,
    });

    expect(result.lexResult.errors).toHaveLength(0);
    expect(result.actionableParserErrors).toHaveLength(0);
    expect(result.cst).toBeDefined();
  });

  it("does not treat macro markers inside strings or comments as syntax", () => {
    const result = parseSqlStatements({
      sql: "SELECT '&x' AS literal -- &comment\n;",
      runtime: NETEZZA_SQL_PARSING_RUNTIME,
    });

    expect(result.lexResult.errors).toHaveLength(0);
    expect(result.actionableParserErrors).toHaveLength(0);
    expect(result.cst).toBeDefined();
  });

  it("sanitizes SQL-backed macro functions before parsing", () => {
    const result = parseSqlStatements({
      sql: "SELECT %sql(SELECT MAX(DATEKEY) FROM JUST_DATA.ADMIN.DIMDATE) AS max_key FROM JUST_DATA.ADMIN.DIMDATE WHERE REGION IN (%sqllist(SELECT REGION FROM JUST_DATA.ADMIN.REGIONS));",
      runtime: NETEZZA_SQL_PARSING_RUNTIME,
    });

    expect(result.lexResult.errors).toHaveLength(0);
    expect(result.actionableParserErrors).toHaveLength(0);
    expect(result.cst).toBeDefined();
  });

  it("sanitizes embedded %eval macro functions before parsing", () => {
    const result = parseSqlStatements({
      sql: "SELECT * FROM JUST_DATA.ADMIN.DIMDATE WHERE DATEKEY >= %eval(20240731 - 30);",
      runtime: NETEZZA_SQL_PARSING_RUNTIME,
    });

    expect(result.lexResult.errors).toHaveLength(0);
    expect(result.actionableParserErrors).toHaveLength(0);
    expect(result.cst).toBeDefined();
  });

  it("sanitizes multiline macro declarations before parsing and validation", () => {
    const result = parseSqlStatements({
      sql: `%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET as_of_key = %SQL(
  SELECT MAX(DATEKEY)
  FROM &dim_table
);
%PUT as_of=&as_of_key;
SELECT &as_of_key AS as_of_key FROM &dim_table;`,
      runtime: NETEZZA_SQL_PARSING_RUNTIME,
    });

    expect(result.lexResult.errors).toHaveLength(0);
    expect(result.actionableParserErrors).toHaveLength(0);
    expect(result.cst).toBeDefined();
  });
});
