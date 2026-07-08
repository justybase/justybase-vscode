// Don't mock chevrotain - we need the real parser for these tests
import { describe, expect, it, jest } from "@jest/globals";

jest.unmock("chevrotain");

import {
  expectErrorCode,
  expectSyntaxError,
  expectValid,
  setupSqlValidatorTests,
  validator,
} from "./validator.test.shared";

/**
 * Stored procedure / NZPLSQL validation tests extracted from sqlValidator.test.ts.
 * Covers CREATE PROCEDURE, NZPLSQL syntax, and SQL037-041 semantic checks.
 */
describe("SQL Validator - Procedure tests", () => {
  setupSqlValidatorTests();

  // ========================================================================
  // Stored Procedures (NZPLSQL)
  // ========================================================================
  describe("Stored Procedures — valid syntax", () => {
    it("should validate minimal procedure (empty body)", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE MY_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate RETURN VARCHAR(ANY) in procedure (NZPLSQL)", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE PRC1()
RETURNS VARCHAR(ANY)
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RAISE NOTICE 'The customer name is alpha';
  RAISE NOTICE 'The customer location is beta';
  RETURN '1';
END;
END_PROC;`);
    });

    it("should validate RETURN CHAR(ANY) in procedure (NZPLSQL)", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE PRC2()
RETURNS CHAR(ANY)
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN '1';
END;
END_PROC;`);
    });

    it("should validate RETURN NCHAR(ANY) in procedure (NZPLSQL)", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE PRC3()
RETURNS NCHAR(ANY)
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN '1';
END;
END_PROC;`);
    });

    it("should validate procedure with EXECUTE AS OWNER", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE MY_PROC()
RETURNS INT4
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 0;
END;
END_PROC;`);
    });

    it("should validate procedure with EXECUTE AS CALLER", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE MY_PROC()
RETURNS INT4
EXECUTE AS CALLER
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 0;
END;
END_PROC;`);
    });

    it("should validate procedure with EXECUTE AS after LANGUAGE NZPLSQL", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE ADMIN.SP_COLOR_CHECK(IN p_account INT, OUT p_count INT)
RETURNS INT
LANGUAGE NZPLSQL
EXECUTE AS OWNER
AS BEGIN_PROC
DECLARE
  v_sql VARCHAR(2000);
BEGIN
  v_sql := 'SELECT COUNT(*) FROM JUST_DATA.ADMIN.COLOR_CHECK_FACT';
  EXECUTE IMMEDIATE v_sql;
  RAISE NOTICE 'color check ran';
  RETURN 1;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'color check failed';
    RETURN 0;
END;
END_PROC;`);
    });

    it("should validate procedure with EXECUTE AS before RETURNS", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE PROCEDURE_NAME(INTEGER, VARCHAR(100))
EXECUTE AS OWNER
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 0;
END;
END_PROC;`);
    });

    it("should validate procedure with typed parameters", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE ADD_NUMS(p_a INT4, p_b INT4)
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN p_a + p_b;
END;
END_PROC;`);
    });

    it("should validate procedure with VARARGS", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE VARARG_PROC(VARARGS)
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 0;
END;
END_PROC;`);
    });

    it("should validate procedure with DECLARE section and variable initialization", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE VAR_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_count INT4 := 0;
    v_name VARCHAR(50) := 'default';
    v_flag BOOLEAN;
BEGIN
    v_count := v_count + 1;
    RETURN v_count;
END;
END_PROC;`);
    });

    it("should validate procedure with CONSTANT variable", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE CONST_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_pi CONSTANT NUMERIC(10,5) := 3.14159;
BEGIN
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate procedure with NOT NULL variable", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE NOTNULL_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_id INT4 NOT NULL := 1;
BEGIN
    RETURN v_id;
END;
END_PROC;`);
    });

    it("should validate procedure with IF/ELSIF/ELSE/END IF", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE IF_PROC(p_val INT4)
RETURNS VARCHAR(20)
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    IF p_val > 100 THEN
        RETURN 'High';
    ELSIF p_val > 50 THEN
        RETURN 'Medium';
    ELSE
        RETURN 'Low';
    END IF;
END;
END_PROC;`);
    });

    it("should validate procedure with WHILE loop", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE WHILE_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_i INT4 := 0;
BEGIN
    WHILE v_i < 10 LOOP
        v_i := v_i + 1;
    END LOOP;
    RETURN v_i;
END;
END_PROC;`);
    });

    it("should validate procedure with simple LOOP and EXIT", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE LOOP_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_i INT4 := 0;
BEGIN
    LOOP
        v_i := v_i + 1;
        EXIT WHEN v_i >= 5;
    END LOOP;
    RETURN v_i;
END;
END_PROC;`);
    });

    it("should validate procedure with FOR ... IN range LOOP", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE FOR_RANGE_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_sum INT4 := 0;
BEGIN
    FOR i IN 1..10 LOOP
        v_sum := v_sum + i;
    END LOOP;
    RETURN v_sum;
END;
END_PROC;`);
    });

    it("should validate procedure with FOR ... IN SELECT LOOP", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE FOR_QUERY_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_cnt INT4 := 0;
BEGIN
    FOR rec IN SELECT EMPLOYEE_ID FROM TESTDB..EMPLOYEES LIMIT 5 LOOP
        v_cnt := v_cnt + 1;
    END LOOP;
    RETURN v_cnt;
END;
END_PROC;`);
    });

    it("should validate procedure with FOR ... IN EXECUTE dynamic SQL LOOP", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE FOR_DYN_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_cnt INT4 := 0;
BEGIN
    FOR rec IN EXECUTE 'SELECT 1 AS X' LOOP
        v_cnt := v_cnt + 1;
    END LOOP;
    RETURN v_cnt;
END;
END_PROC;`);
    });

    it("should validate procedure with EXCEPTION WHEN OTHERS THEN", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE EX_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 1;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Error occurred';
        RETURN 0;
END;
END_PROC;`);
    });

    it("should validate RAISE with different severity levels", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE RAISE_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RAISE DEBUG 'debug message';
    RAISE NOTICE 'notice message %', 42;
    RAISE EXCEPTION 'critical error';
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate EXECUTE IMMEDIATE", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE DYN_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_sql TEXT;
BEGIN
    v_sql := 'SELECT 1';
    EXECUTE IMMEDIATE v_sql;
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate EXECUTE IMMEDIATE with USING", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE DYN_USING_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    EXECUTE IMMEDIATE 'UPDATE TESTDB..FILMS SET KIND = ? WHERE CODE = ?' USING 'Drama', 'AA001';
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate CALL statement inside procedure", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE CALLER_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    CALL MY_PROC();
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate EXECUTE PROCEDURE statement", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE EXEC_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    EXECUTE PROCEDURE MY_PROC();
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate ROLLBACK/COMMIT statements", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE TX_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    ROLLBACK;
    COMMIT;
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate RETURNS REFTABLE(...)", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE RT_PROC()
RETURNS REFTABLE(TESTDB.PUBLIC.EMPLOYEES)
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN REFTABLE;
END;
END_PROC;`);
    });

    it("should validate procedure with array variable (VARRAY)", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE ARR_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    arr VARRAY(10) OF INT4;
    v_val INT4;
BEGIN
    arr(1) := 100;
    v_val := 42;
    RETURN v_val;
END;
END_PROC;`);
    });

    it("should validate procedure with RECORD variable", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE REC_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    rec RECORD;
BEGIN
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate procedure with nested BEGIN/END blocks", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE NESTED_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_outer INT4 := 0;
BEGIN
    DECLARE
        v_inner INT4 := 10;
    BEGIN
        v_outer := v_inner;
    END;
    RETURN v_outer;
END;
END_PROC;`);
    });

    it("should validate procedure with SQL DML inside body", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE DML_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    INSERT INTO TESTDB..FILMS (CODE, TITLE) VALUES ('ZZ', 'Test');
    UPDATE TESTDB..FILMS SET TITLE = 'Updated' WHERE CODE = 'ZZ';
    DELETE FROM TESTDB..FILMS WHERE CODE = 'ZZ';
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate procedure with DROP TABLE inside body", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE DROP_PROC()
RETURNS INT4
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RAISE NOTICE 'Before drop';
    DROP TABLE TESTDB..TMP_TO_DROP;
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate procedure with DDL chain in body", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE DDL_CHAIN_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    CREATE TEMP TABLE TMP_PROC_T (ID INT4, NAME VARCHAR(20));
    ALTER TABLE TMP_PROC_T ADD COLUMN FLAG CHAR(1);
    COMMENT ON TABLE TMP_PROC_T IS 'Temporary table for procedure flow';
    DROP TABLE TMP_PROC_T;
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate procedure with CREATE VIEW and DROP VIEW in body", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE VIEW_CHAIN_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    CREATE VIEW TESTDB..V_PROC_TMP AS SELECT EMPLOYEE_ID FROM TESTDB..EMPLOYEES;
    DROP VIEW TESTDB..V_PROC_TMP;
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate procedure with maintenance commands in body", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE MAINT_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    GROOM TABLE TESTDB..EMPLOYEES RECORDS ALL;
    GENERATE STATISTICS ON TESTDB..EMPLOYEES;
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate procedure with TRUNCATE TABLE in body", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE TRUNC_PROC()
RETURNS INTEGER
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
TRUNCATE TABLE XYZ;
RETURN 1;
END_PROC;`);
    });

    it("should validate procedure with TRUNCATE TABLE and semicolons", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE JUST_DATA.ADMIN.TEST_PROC()
RETURNS INTEGER
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
TRUNCATE TABLE XYZ;
RETURN 0;
END_PROC;`);
    });

    it("should validate procedure with GRANT in body", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE GRANT_PROC()
RETURNS INTEGER
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    GRANT SELECT ON TESTDB..EMPLOYEES TO PUBLIC;
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate procedure with REVOKE in body", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE REVOKE_PROC()
RETURNS INTEGER
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    REVOKE SELECT ON TESTDB..EMPLOYEES FROM PUBLIC;
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate procedure with IS instead of AS before body", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE IS_PROC()
RETURNS INT4
LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate procedure with multiple statements separated by semicolons", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE MULTI_STMT_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE

    v_a INT4 := 1;
    v_b VARCHAR(10) := 'hello';
BEGIN
    v_a := v_a + 1;
    v_b := v_b || ' world';
    RETURN v_a;
END;
END_PROC;`);
    });

    it("should validate procedure with CTAS containing CASE WHEN", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE JUST_DATA.ADMIN.CUSTOMER_DOTNET()
RETURNS INTEGER
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
V_NUM INTEGER;

 BEGIN

CREATE TEMP TABLE TT_1 AS (
    SELECT 1
    , CASE WHEN 1=2 THEN 1 ELSE 0 END AS COL2
     FROM JUST_DATA..DIMACCOUNT
    WHERE ACCOUNTCODEALTERNATEKEY > 0
)DISTRIBUTE ON RANDOM;


 return 1;
 END;
END_PROC;`);
    });
  });

  describe("Stored Procedures — syntax errors", () => {
    it("should detect missing RETURNS clause", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_PROC()
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 1;
END;
END_PROC;`);
    });

    it("should detect missing LANGUAGE keyword", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_PROC()
RETURNS INT4
NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 1;
END;
END_PROC;`);
    });

    it("should detect missing BEGIN_PROC", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN
    RETURN 1;
END;
END_PROC;`);
    });

    it("should detect missing END_PROC", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 1;
END;`);
    });

    it("should detect missing END IF in IF statement", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_IF()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    IF 1 = 1 THEN
        RETURN 1;
END;
END_PROC;`);
    });

    it("should detect missing THEN in IF statement", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_IF2()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    IF 1 = 1
        RETURN 1;
    END IF;
END;
END_PROC;`);
    });

    it("should detect missing END LOOP in WHILE", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_WHILE()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_i INT4 := 0;
BEGIN
    WHILE v_i < 10 LOOP
        v_i := v_i + 1;
END;
END_PROC;`);
    });

    it("should detect missing LOOP keyword in WHILE", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_WHILE2()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_i INT4 := 0;
BEGIN
    WHILE v_i < 10
        v_i := v_i + 1;
    END LOOP;
END;
END_PROC;`);
    });

    it("should detect missing END LOOP in FOR", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_FOR()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    FOR i IN 1..5 LOOP
        RAISE NOTICE 'i=%', i;
END;
END_PROC;`);
    });

    it("should detect RAISE without severity keyword", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_RAISE()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RAISE 'missing severity';
    RETURN 1;
END;
END_PROC;`);
    });

    it("should detect missing opening parenthesis in procedure args", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_ARGS p_id INT4)
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 1;
END;
END_PROC;`);
    });

    it("should detect missing closing parenthesis in procedure args", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_ARGS(p_id INT4
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 1;
END;
END_PROC;`);
    });

    it("should detect missing BEGIN inside procedure block", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE NO_BEGIN()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_i INT4 := 0;
    RETURN v_i;
END;
END_PROC;`);
    });

    it("should detect missing END inside procedure block", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE NO_END()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 1;
END_PROC;`);
    });
  });

  // ========================================================================
  // Procedure — semantic errors (visitor-detected)
  // ========================================================================
  describe("Stored Procedures — semantic errors", () => {
    it("should detect invalid data type in variable declaration", () => {
      expectErrorCode(
        `CREATE OR REPLACE PROCEDURE BAD_TYPE_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_bad INVALID_TYPE_XYZ;
BEGIN
    RETURN 1;
END;
END_PROC;`,
        "SQL013",
      );
    });

    it("should detect unknown function in procedure body", () => {
      expectErrorCode(
        `CREATE OR REPLACE PROCEDURE BAD_FN_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_x INT4;
BEGIN
    v_x := NONEXISTENT_FUNC_99(1, 2);
    RETURN v_x;
END;
END_PROC;`,
        "SQL011",
      );
    });
  });

  // ========================================================================
  // NZPLSQL Variable Type Validation
  // ========================================================================
  describe("NZPLSQL — variable type validation", () => {
    it("should validate INT4 variable type", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE INT4_VAR()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_int INT4 := 42;
BEGIN
    RETURN v_int;
END;
END_PROC;`);
    });

    it("should validate VARCHAR with length", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE VARCHAR_VAR()
RETURNS VARCHAR(100)
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_name VARCHAR(100) := 'test';
BEGIN
    RETURN v_name;
END;
END_PROC;`);
    });

    it("should validate NUMERIC with precision and scale", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE NUMERIC_VAR()
RETURNS NUMERIC(10,2)
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_amount NUMERIC(10,2) := 123.45;
BEGIN
    RETURN v_amount;
END;
END_PROC;`);
    });

    it("should validate BOOLEAN variable type", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE BOOL_VAR()
RETURNS BOOL
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_flag BOOL := TRUE;
BEGIN
    RETURN v_flag;
END;
END_PROC;`);
    });

    it("should validate DATE variable type", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE DATE_VAR()
RETURNS DATE
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_date DATE;
BEGIN
    RETURN v_date;
END;
END_PROC;`);
    });

    it("should validate TIMESTAMP variable type", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE TS_VAR()
RETURNS TIMESTAMP
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_ts TIMESTAMP;
BEGIN
    RETURN v_ts;
END;
END_PROC;`);
    });

    it("should detect unknown data type in variable declaration", () => {
      expectErrorCode(
        `CREATE OR REPLACE PROCEDURE BAD_TYPE()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_bad FOOBAR_TYPE;
BEGIN
    RETURN 1;
END;
END_PROC;`,
        "SQL013",
      );
    });

    it("should validate variable assignment with :=", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE ASSIGN_VAR()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_count INT4 := 0;
BEGIN
    RETURN v_count;
END;
END_PROC;`);
    });

    it("should validate CONSTANT variable", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE CONST_VAR()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_max CONSTANT INT4 := 100;
BEGIN
    RETURN v_max;
END;
END_PROC;`);
    });

    it("should validate NOT NULL variable", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE NOTNULL_VAR()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_id INT4 NOT NULL := 1;
BEGIN
    RETURN v_id;
END;
END_PROC;`);
    });
  });

  // ========================================================================
  // NZPLSQL RETURN Validation
  // ========================================================================
  describe("NZPLSQL — RETURN statement validation", () => {
    it("should validate RETURN with literal value", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE RET_LITERAL()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 42;
END;
END_PROC;`);
    });

    it("should validate RETURN with variable", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE RET_VAR()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_result INT4 := 100;
BEGIN
    RETURN v_result;
END;
END_PROC;`);
    });

    it("should validate RETURN with expression", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE RET_EXPR()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_a INT4 := 10;
    v_b INT4 := 20;
BEGIN
    RETURN v_a + v_b;
END;
END_PROC;`);
    });

    it("should validate RETURN with function call", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE RET_FUNC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN COALESCE(NULL, 1);
END;
END_PROC;`);
    });

    it("should validate RETURN REFTABLE", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE RET_REFTABLE()
RETURNS REFTABLE(TESTDB.PUBLIC.EMPLOYEES)
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN REFTABLE;
END;
END_PROC;`);
    });

    it("should validate RETURN in multiple branches", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE RET_BRANCHES(p_val INT4)
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    IF p_val > 0 THEN
        RETURN 1;
    ELSIF p_val < 0 THEN
        RETURN -1;
    ELSE
        RETURN 0;
    END IF;
END;
END_PROC;`);
    });

    it("should validate RETURN inside nested blocks", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE RET_NESTED()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_outer INT4 := 1;
BEGIN
    DECLARE
        v_inner INT4 := 2;
    BEGIN
        IF v_inner > 0 THEN
            RETURN v_inner;
        END IF;
    END;
    RETURN v_outer;
END;
END_PROC;`);
    });

    it("should validate RETURN with string literal for VARCHAR return", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE RET_STR()
RETURNS VARCHAR(50)
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 'Hello World';
END;
END_PROC;`);
    });

    it("should validate RETURN with boolean expression", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE RET_BOOL()
RETURNS BOOL
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 1 = 1;
END;
END_PROC;`);
    });
  });

  // ========================================================================
  // NZPLSQL Parameter Validation
  // ========================================================================
  describe("NZPLSQL — parameter validation", () => {
    it("should validate procedure with single parameter", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE SINGLE_PARAM(p_id INT4)
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN p_id;
END;
END_PROC;`);
    });

    it("should validate procedure with multiple parameters", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE MULTI_PARAM(p_a INT4, p_b VARCHAR(50), p_c NUMERIC(10,2))
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN p_a;
END;
END_PROC;`);
    });

    it("should validate procedure with VARARGS", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE VARARGS_PROC(VARARGS)
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 0;
END;
END_PROC;`);
    });

    it("should validate ALIAS FOR parameter reference", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE ALIAS_PROC(INT4, VARCHAR(100))
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    p_id ALIAS FOR $1;
    p_name ALIAS FOR $2;
BEGIN
    RETURN p_id;
END;
END_PROC;`);
    });

    it("should validate parameter usage in expressions", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE PARAM_EXPR(p_base INT4, p_multiplier INT4)
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN p_base * p_multiplier;
END;
END_PROC;`);
    });

    it("should validate parameter usage in SQL statements", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE PARAM_SQL(p_dept_id INT4)
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_count INT4;
BEGIN
    SELECT COUNT(*) INTO v_count FROM TESTDB..EMPLOYEES WHERE DEPARTMENT_ID = p_dept_id;
    RETURN v_count;
END;
END_PROC;`);
    });
  });

  // ========================================================================
  // Complex real-world scenarios
    it("should validate procedure with complete control flow", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE FULL_PROC(p_dept INT4, p_threshold NUMERIC(10,2))
RETURNS INT4
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_cnt INT4 := 0;
    v_total NUMERIC(12,2) := 0;
    v_msg VARCHAR(200);
BEGIN
    IF p_dept IS NULL THEN
        RAISE EXCEPTION 'Department cannot be NULL';
    END IF;

    FOR rec IN SELECT SALARY FROM TESTDB..EMPLOYEES WHERE DEPARTMENT_ID = p_dept LOOP
        v_cnt := v_cnt + 1;
        v_total := v_total + rec;
    END LOOP;

    IF v_cnt = 0 THEN
        RAISE NOTICE 'No employees found';
        RETURN 0;
    ELSIF v_total > p_threshold THEN
        v_msg := 'Over threshold: ' || v_total;
        RAISE NOTICE '%', v_msg;
    ELSE
        RAISE DEBUG 'Under threshold';
    END IF;

    WHILE v_cnt > 0 LOOP
        v_cnt := v_cnt - 1;
        EXIT WHEN v_cnt < 0;
    END LOOP;

    RETURN v_cnt;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Error in FULL_PROC';
        ROLLBACK;
        RETURN -1;
END;
END_PROC;`);
    });
    it("should detect CASE without END in procedure", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_CASE_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    DECLARE v_result VARCHAR(20);
    v_result := CASE WHEN 1 = 1 THEN 'yes';
    RETURN 1;
END;
END_PROC;`);
    });
  // ========================================================================
  // Additional procedure patterns
  // ========================================================================
  describe("Stored Procedures — additional valid patterns", () => {
    it("should validate procedure with IF/ELSIF/ELSE chain", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE IF_TEST(p_val INT4)
RETURNS VARCHAR(50)
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_result VARCHAR(50);
BEGIN
    IF p_val > 100 THEN
        v_result := 'High';
    ELSIF p_val > 50 THEN
        v_result := 'Medium';
    ELSIF p_val > 10 THEN
        v_result := 'Low';
    ELSE
        v_result := 'Very Low';
    END IF;
    RETURN v_result;
END;
END_PROC;`);
    });

    it("should validate procedure with nested IF statements", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE NESTED_IF(p_a INT4, p_b INT4)
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_result INT4;
BEGIN
    IF p_a > 0 THEN
        IF p_b > 0 THEN
            v_result := 1;
        ELSE
            v_result := 2;
        END IF;
    ELSE
        v_result := 3;
    END IF;
    RETURN v_result;
END;
END_PROC;`);
    });

    it("should validate procedure with FOR integer loop", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE FOR_LOOP_TEST()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_sum INT4 := 0;
    i INT4;
BEGIN
    FOR i IN 1..10 LOOP
        v_sum := v_sum + i;
    END LOOP;
    RETURN v_sum;
END;
END_PROC;`);
    });

    it("should validate procedure with RAISE NOTICE", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE RAISE_TEST()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RAISE NOTICE 'Starting procedure';
    RAISE NOTICE 'Value is: %', 42;
    RETURN 0;
END;
END_PROC;`);
    });

    it("should validate procedure with RAISE DEBUG", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE DEBUG_TEST()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RAISE DEBUG 'Debug message';
    RETURN 0;
END;
END_PROC;`);
    });

    it("should validate procedure with RAISE EXCEPTION", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE EXCEPTION_TEST(p_val INT4)
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    IF p_val < 0 THEN
        RAISE EXCEPTION 'Value must be non-negative: %', p_val;
    END IF;
    RETURN p_val;
END;
END_PROC;`);
    });

    it("should validate procedure with EXECUTE IMMEDIATE", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE DYN_SQL_TEST()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_sql VARCHAR(500);
BEGIN
    v_sql := 'SELECT COUNT(*) FROM EMPLOYEES';
    EXECUTE IMMEDIATE v_sql;
    RETURN 0;
END;
END_PROC;`);
    });

    it("should validate Netezza dynamic NZPLSQL block wrapper", () => {
      const result = validator.validate(`CREATE OR REPLACE PROCEDURE exec_nzplsql_block(text) RETURNS BOOLEAN
LANGUAGE NZPLSQL AS
BEGIN_PROC
    DECLARE lRet BOOLEAN;
    DECLARE sid INTEGER;
    DECLARE nm varchar;
    DECLARE cr varchar;
BEGIN
    sid := current_sid;
    nm := 'any_block' || sid || '()';
    cr = 'CREATE OR REPLACE PROCEDURE ' || nm ||
        ' RETURNS BOOL LANGUAGE NZPLSQL AS BEGIN_PROC '
        || $1 || ' END_PROC';
    EXECUTE IMMEDIATE cr;
    EXECUTE IMMEDIATE 'SELECT ' || nm;
    EXECUTE IMMEDIATE 'DROP PROCEDURE ' || nm;
    RETURN TRUE;
END;
END_PROC;`);

      expect(result.errors.some((error) => error.code === "PAR001")).toBe(
        false,
      );
      expect(result.errors.some((error) => error.code === "SQL038")).toBe(
        false,
      );
    });

    it("should validate procedure with EXIT WHEN in LOOP", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE EXIT_LOOP_TEST()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_counter INT4 := 0;
BEGIN
    LOOP
        v_counter := v_counter + 1;
        EXIT WHEN v_counter >= 10;
    END LOOP;
    RETURN v_counter;
END;
END_PROC;`);
    });

    it("should validate procedure with WHILE loop and complex condition", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE WHILE_COMPLEX()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_i INT4 := 0;
    v_j INT4 := 100;
BEGIN
    WHILE v_i < 10 AND v_j > 0 LOOP
        v_i := v_i + 1;
        v_j := v_j - 10;
    END LOOP;
    RETURN v_i;
END;
END_PROC;`);
    });

    it("should validate procedure with multiple RETURN paths", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE MULTI_RETURN(p_val INT4)
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    IF p_val > 0 THEN
        RETURN 1;
    END IF;
    IF p_val < 0 THEN
        RETURN -1;
    END IF;
    RETURN 0;
END;
END_PROC;`);
    });

    it("should validate procedure returning BOOL", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE BOOL_PROC(p_val INT4)
RETURNS BOOL
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    IF p_val > 0 THEN
        RETURN TRUE;
    END IF;
    RETURN FALSE;
END;
END_PROC;`);
    });

    it("should validate procedure with named parameters", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE NAMED_PARAMS(p_name VARCHAR(100), p_age INT4, p_salary NUMERIC(10,2))
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 0;
END;
END_PROC;`);
    });

    it("should validate procedure with multiple variable declarations", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE MULTI_VARS()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_int INT4 := 0;
    v_str VARCHAR(100) := 'hello';
    v_bool BOOL := TRUE;
    v_num NUMERIC(10,2) := 3.14;
BEGIN
    RETURN v_int;
END;
END_PROC;`);
    });

    it("should validate procedure with CALL to another procedure", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE CALLER_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    CALL NAMED_PARAMS('test', 25, 50000.00);
    RETURN 0;
END;
END_PROC;`);
    });
  });

  // ========================================================================
  // Additional procedure error cases
  // ========================================================================
  describe("Stored Procedures — additional syntax errors", () => {
    it("should detect missing RETURNS clause", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_PROC()
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 0;
END;
END_PROC;`);
    });

    it("should detect missing LANGUAGE clause", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_PROC()
RETURNS INT4
AS
BEGIN_PROC
BEGIN
    RETURN 0;
END;
END_PROC;`);
    });

    it("should detect missing END_PROC", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 0;
END;`);
    });

    it("should detect missing END in procedure body", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 0;
END_PROC;`);
    });

    it("should detect missing semicolons in procedure body statements", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_PROC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v INT4;
BEGIN
    v := 1
    RETURN v;
END;
END_PROC;`);
    });

    it("should detect missing LOOP after WHILE condition", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_WHILE()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v INT4 := 0;
BEGIN
    WHILE v < 10
        v := v + 1;
    END LOOP;
    RETURN v;
END;
END_PROC;`);
    });

    it("should detect missing THEN after IF condition", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE BAD_IF()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    IF 1 > 0
        RETURN 1;
    END IF;
    RETURN 0;
END;
END_PROC;`);
    });
  });
  // ========================================================================
  // NZPLSQL advanced features (from sqlValidator.netezzaDialect.test.ts)
  // ========================================================================
  describe("NZPLSQL advanced features", () => {
    it("should support AUTOCOMMIT ON blocks", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_AUTOCOMMIT()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    AUTOCOMMIT ON;
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate record field assignments (rec.field := ...)", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_REC_FIELD()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    rec RECORD;
BEGIN
    rec.employee_id := 1;
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate PERFORM statement", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_PERFORM()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    PERFORM do_work();
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate RAISE ERROR and RAISE WARNING", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_RAISE()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RAISE WARNING 'warn';
    RAISE ERROR 'fatal';
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate IN OUT INOUT parameters", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_MODES(
    IN p_id INT4,
    OUT p_cnt INT4,
    INOUT p_flag BOOLEAN
)
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    p_cnt := p_id;
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate VARRAY EXTEND method call", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_VARRAY()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_arr VARRAY(10) OF INT4;
BEGIN
    v_arr.EXTEND(1);
    v_arr(1) := 10;
    RETURN 1;
END;
END_PROC;`);
    });

    it("should validate EXCEPTION WHEN SQLSTATE and WHEN OTHERS", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_EXC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 1;
EXCEPTION
    WHEN SQLSTATE '23505' THEN
        RETURN 0;
    WHEN OTHERS THEN
        RETURN -1;
END;
END_PROC;`);
    });

    it("should validate CREATE PROCEDURE followed by COMMENT ON PROCEDURE", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_COMMENT()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 1;
END;
END_PROC;
COMMENT ON PROCEDURE TESTDB.PUBLIC.P_COMMENT() IS 'test procedure';`);
    });

    it("should validate string-body procedure with RETURN via inner parse", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_STR()
RETURNS INT4
LANGUAGE NZPLSQL AS
'BEGIN
    RETURN 1;
END;';`);
    });

    it("should report SQL037 as information for standalone SELECT without INTO in procedure", () => {
      const result = validator.validate(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_SELECT_NO_INTO()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_count INT4;
BEGIN
    SELECT COUNT(*) FROM TESTDB..EMPLOYEES;
    RETURN v_count;
END;
END_PROC;`);
      const diagnostic = result.warnings.find((e) => e.code === "SQL037");

      expect(diagnostic).toBeDefined();
      expect(diagnostic?.severity).toBe("information");
      expect(diagnostic?.message).toContain("Possibly standalone SELECT");
    });

    it("should not report SQL037 for SELECT with INTO in procedure", () => {
      const result = validator.validate(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_SELECT_INTO()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_count INT4;
BEGIN
    SELECT COUNT(*) INTO v_count FROM TESTDB..EMPLOYEES;
    RETURN v_count;
END;
END_PROC;`);
      expect(result.warnings.some((e) => e.code === "SQL037")).toBe(false);
    });

    it("should not report SQL037 for INSERT INTO SELECT in procedure", () => {
      const result = validator.validate(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_INSERT_SELECT()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    INSERT INTO TESTDB..EMPLOYEES_ARCHIVE
    SELECT * FROM TESTDB..EMPLOYEES;
    RETURN 1;
END;
END_PROC;`);
      expect(result.warnings.some((e) => e.code === "SQL037")).toBe(false);
    });

    it("should not report SQL037 for INSERT with CTE SELECT in procedure", () => {
      const result = validator.validate(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_INSERT_CTE()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    INSERT INTO TESTDB..EMPLOYEES_ARCHIVE
    WITH ABC AS (
        SELECT EMPLOYEE_ID FROM TESTDB..EMPLOYEES
    )
    SELECT EMPLOYEE_ID FROM ABC;
    RETURN 1;
END;
END_PROC;`);
      expect(result.warnings.some((e) => e.code === "SQL037")).toBe(false);
    });

    it("should not report SQL037 for CTAS SELECT in procedure", () => {
      const result = validator.validate(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_CTAS()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    CREATE TEMP TABLE TT_EMP AS (
        SELECT EMPLOYEE_ID FROM TESTDB..EMPLOYEES
    ) DISTRIBUTE ON RANDOM;
    RETURN 1;
END;
END_PROC;`);
      expect(result.warnings.some((e) => e.code === "SQL037")).toBe(false);
    });

    it("should not report SQL037 for embedded SELECT in WHERE IN subquery", () => {
      const result = validator.validate(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_EMBED_SELECT()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    DELETE FROM TESTDB..EMPLOYEES
    WHERE EMPLOYEE_ID IN (SELECT EMPLOYEE_ID FROM TESTDB..EMPLOYEES);
    RETURN 1;
END;
END_PROC;`);
      expect(result.warnings.some((e) => e.code === "SQL037")).toBe(false);
    });

    it("should report SQL038 warning for string-body procedure missing RETURN", () => {
      const result = validator.validate(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_STR_BAD()
RETURNS INT4
LANGUAGE NZPLSQL AS
'BEGIN
    SELECT 1;
END;';`);

      expect(result.errors.some((error) => error.code === "SQL038")).toBe(
        false,
      );
      expect(result.warnings.some((warning) => warning.code === "SQL038")).toBe(
        true,
      );
    });

    it("should warn, not error, when VARARGS procedure omits RETURN", () => {
      const result = validator.validate(`CREATE OR REPLACE PROCEDURE sp_varargs01(varargs)
  RETURNS INT4
  LANGUAGE NZPLSQL
  AS
  BEGIN_PROC
    DECLARE
      num_args int4;
      typ oid;
      idx int4;
    BEGIN
      num_args := PROC_ARGUMENT_TYPES.count;
      RAISE NOTICE 'Number of arguments is %',  num_args;
      for i IN 0 .. PROC_ARGUMENT_TYPES.count - 1 LOOP
        typ := PROC_ARGUMENT_TYPES(i);
        idx := i+1;
        RAISE NOTICE 'argument $% is type % value ''%''',  idx, typ,
                     $idx;
        END LOOP;
    END;
  END_PROC;`);

      expect(result.errors).toHaveLength(0);
      expect(result.warnings.some((warning) => warning.code === "SQL038")).toBe(
        true,
      );
    });

    it("should report SQL041 for string-body procedure CASE without END", () => {
      expectErrorCode(
        `CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_STR_CASE_BAD()
RETURNS INT4
LANGUAGE NZPLSQL AS
'BEGIN
    RETURN CASE WHEN 1 = 1 THEN 1;
END;';`,
        "SQL041",
      );
    });

    it("should validate FOR loop with REVERSE range", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_REVERSE()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    v_sum INT4 := 0;
BEGIN
    <<outer>> FOR i IN REVERSE 10..1 LOOP
        v_sum := v_sum + i;
    END LOOP;
    RETURN v_sum;
END;
END_PROC;`);
    });

    it("should validate EXIT with label and WHEN condition", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_EXIT_LABEL()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    x INT4 := 0;
BEGIN
    <<lbl>> LOOP
        x := x + 1;
        EXIT lbl WHEN x >= 5;
    END LOOP;
    RETURN x;
END;
END_PROC;`);
    });

    it("should validate EXCEPTION WHEN named exception", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_NAMED_EXC()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 1;
EXCEPTION
    WHEN NO_DATA_FOUND THEN
        RETURN 0;
END;
END_PROC;`);
    });

    it("should reject GOTO as unsupported NZPLSQL syntax", () => {
      expectSyntaxError(`CREATE OR REPLACE PROCEDURE TESTDB.PUBLIC.P_GOTO()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    GOTO lbl;
    RETURN 1;
END;
END_PROC;`);
    });
  });
});
