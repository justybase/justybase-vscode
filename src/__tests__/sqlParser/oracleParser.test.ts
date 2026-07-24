import { jest } from "@jest/globals";
import { describe, expect, it } from "@jest/globals";

jest.unmock("chevrotain");

import { ORACLE_SQL_PARSING_RUNTIME, parseSqlStatements } from "../../sqlParser";
import { SqlLexer as directOracleLexer } from "../../dialects/oracle/sql/lexer";
import { createSqlParserInstance as createOracleParser } from "../../dialects/oracle/sql/parser";

function parse(sql: string) {
  const result = parseSqlStatements({ sql, runtime: ORACLE_SQL_PARSING_RUNTIME });
  return result;
}

describe("Oracle SQL parser", () => {
  it("lexes Oracle-only keywords and bind variables", () => {
    expect(directOracleLexer.tokenize("CONNECT BY PRIOR :x ORDER SIBLINGS BY").tokens.map((token) => token.tokenType.name)).toEqual([
      "OracleConnect",
      "OracleBy",
      "OraclePrior",
      "OracleBindVariable",
      "OracleOrderSiblingsBy",
    ]);
  });

  it("lexes Oracle parameter modes as keyword tokens", () => {
    expect(directOracleLexer.tokenize("p IN NUMBER").tokens.map((token) => token.tokenType.name)).toEqual([
      "Identifier",
      "In",
      "Identifier",
    ]);
  });

  it("parses Oracle qualified binds, package calls, database links, and timestamp time zones", () => {
    const statements = [
      "SELECT DBMS_METADATA.GET_DDL('TABLE', 'T') FROM HR.EMPLOYEES@PROD;",
      "CREATE TABLE t (event_at TIMESTAMP WITH TIME ZONE);",
      "CREATE OR REPLACE SYNONYM s FOR HR.EMPLOYEES;",
      "BEGIN IF :NEW.ID IS NULL THEN :NEW.ID := seq.NEXTVAL; END IF; END;",
      "BEGIN COMMIT; ROLLBACK; BEGIN NULL; END; END;",
    ];

    for (const sql of statements) {
      const result = parse(sql);
      expect(result.lexResult.errors).toHaveLength(0);
      expect(result.actionableParserErrors).toHaveLength(0);
    }
  });

  it.each([
    "SELECT * FROM dual LIMIT 1;",
    "SELECT * FROM DB..TABLE;",
  ])("rejects Netezza-only Oracle syntax: %s", (sql) => {
    const result = parse(sql);
    expect(result.actionableParserErrors.length).toBeGreaterThan(0);
  });

  it("constructs the Oracle parser", () => {
    expect(createOracleParser()).toBeDefined();
  });

  it.each([
    [
      "hierarchical query",
      `SELECT employee_id, manager_id FROM employees START WITH manager_id IS NULL CONNECT BY NOCYCLE PRIOR employee_id = manager_id ORDER SIBLINGS BY employee_id;`,
    ],
    [
      "pivot query",
      `SELECT * FROM (SELECT department_id, job_id, salary FROM employees) PIVOT (SUM(salary) FOR job_id IN ('IT' AS it, 'SALES' AS sales));`,
    ],
    [
      "DML returning",
      `INSERT INTO employees (employee_id, last_name) VALUES (:id, :name) RETURNING employee_id INTO :out_id;`,
    ],
    [
      "quoted identifiers and CTE",
      `WITH "Sales" AS (SELECT "EmployeeId" FROM employees) SELECT "EmployeeId" FROM "Sales";`,
    ],
    [
      "alternative quoted string",
      `SELECT q'[Oracle ''quoted'' text]' FROM DUAL;`,
    ],
  ])("parses %s without actionable errors", (_name, sql) => {
    const result = parse(sql);

    expect(result.lexResult.errors).toHaveLength(0);
    expect(result.actionableParserErrors).toHaveLength(0);
    expect(result.cst).toBeDefined();
  });

  it("recognizes anonymous PL/SQL blocks and routine units as one CST statement", () => {
    const result = parse(`DECLARE
  v_count NUMBER := 0;
BEGIN
  SELECT COUNT(*) INTO v_count FROM employees;
  DBMS_OUTPUT.PUT_LINE(v_count);
EXCEPTION
  WHEN OTHERS THEN NULL;
END;`);

    expect(result.lexResult.errors).toHaveLength(0);
    expect(result.actionableParserErrors).toHaveLength(0);
    expect(result.cst).toBeDefined();
  });

  it("keeps nested PL/SQL control blocks inside the outer block", () => {
    const result = parse(`BEGIN
  IF 1 = 1 THEN
    NULL;
  END IF;
  NULL;
END;`);

    expect(result.lexResult.errors).toHaveLength(0);
    expect(result.actionableParserErrors).toHaveLength(0);
  });

  it("parses Oracle FOR and WHILE loop bodies", () => {
    const result = parse(`BEGIN
      FOR i IN 1..3 LOOP
        WHILE i > 0 LOOP
          NULL;
        END LOOP;
      END LOOP;
    END;`);

    expect(result.lexResult.errors).toHaveLength(0);
    expect(result.actionableParserErrors).toHaveLength(0);
  });

  it("rejects an unterminated anonymous block", () => {
    const result = parse("BEGIN NULL;");

    expect(result.actionableParserErrors.length).toBeGreaterThan(0);
  });

  it.each([
    "CREATE OR REPLACE PACKAGE BODY pkg AS BEGIN NULL;",
    "CREATE OR REPLACE TRIGGER trg BEFORE INSERT ON employees FOR EACH ROW BEGIN NULL;",
  ])("rejects an unterminated Oracle unit: %s", (sql) => {
    const result = parse(sql);

    expect(result.actionableParserErrors.length).toBeGreaterThan(0);
  });

  it.each([
    ["procedure", "CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;"],
    ["function", "CREATE OR REPLACE FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END;"],
    ["parameterized function", "CREATE OR REPLACE FUNCTION f(p IN NUMBER, q IN OUT VARCHAR2 DEFAULT 'x') RETURN NUMBER IS v NUMBER := p; BEGIN RETURN v; END f;"],
    ["qualified function", "CREATE OR REPLACE FUNCTION HR.CALC_TOTAL(P_AMOUNT IN NUMBER) RETURN NUMBER IS V_TOTAL NUMBER; BEGIN V_TOTAL := P_AMOUNT; RETURN V_TOTAL; END;"],
    ["package", "CREATE OR REPLACE PACKAGE pkg AS FUNCTION value RETURN NUMBER; END pkg;"],
    ["package body", "CREATE OR REPLACE PACKAGE BODY pkg AS FUNCTION value RETURN NUMBER IS BEGIN RETURN 1; END value; END pkg;"],
    ["trigger", "CREATE OR REPLACE TRIGGER trg BEFORE INSERT ON employees FOR EACH ROW BEGIN NULL; END;"],
  ])("parses Oracle %s units", (_name, sql) => {
    const result = parse(sql);

    expect(result.lexResult.errors).toHaveLength(0);
    expect(result.actionableParserErrors).toHaveLength(0);
    expect(result.cst).toBeDefined();
  });

  it.each([
    "SELECT * FROM sales DISTRIBUTE ON (id);",
    "CREATE EXTERNAL TABLE ext_sales (id NUMBER);",
    "GROOM TABLE sales VERSIONS;",
    "GENERATE STATISTICS ON sales;",
    "CREATE TABLE sales (id NUMBER) DISTRIBUTE ON (id);",
    "CREATE TABLE sales (id NUMBER) ORGANIZE ON (id);",
  ])("does not enable Netezza-only syntax: %s", (sql) => {
    const result = parse(sql);

    expect(result.actionableParserErrors.length).toBeGreaterThan(0);
  });
});
