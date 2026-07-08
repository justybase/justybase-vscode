// Don't mock chevrotain - we need the real parser for these tests
import { describe, expect, it, jest } from "@jest/globals";

jest.unmock("chevrotain");

import { SqlValidator } from "../../sqlParser/validator";
import {
  createMockSchemaProvider,
} from "../../sqlParser/schemaProvider";

/**
 * Comprehensive SQL validation tests for Netezza dialect.
 *
 * Covers: SELECT, INSERT, UPDATE, DELETE, CTE, subqueries, window functions,
 * CASE expressions,
 * parenthesis balancing, missing keywords, typos, and edge cases derived from
 * the IBM Netezza SQL Command Reference documentation.
 */
import {
  expectErrorCode,
  expectSyntaxError,
  expectValid,
  expectWarningCode,
  getSyntaxErrors,
  mockTableDefinitions,
  setupSqlValidatorTests,
  validator,
} from "./validator.test.shared";

describe("SQL Validator - Comprehensive Netezza SQL tests", () => {
  setupSqlValidatorTests();

  describe("SELECT — valid syntax", () => {
    it("should validate SELECT with literal only", () => {
      expectValid("SELECT 1;");
    });

    it("should validate SELECT with multiple literals and aliases", () => {
      expectValid("SELECT 1 AS A, 'hello' AS B, 3.14 AS C;");
    });

    it("should validate SELECT DISTINCT", () => {
      expectValid("SELECT DISTINCT DEPARTMENT_ID FROM TESTDB..EMPLOYEES;");
    });

    it("should validate SELECT ALL", () => {
      expectValid("SELECT ALL DEPARTMENT_ID FROM TESTDB..EMPLOYEES;");
    });

    it("should validate SELECT with arithmetic expressions", () => {
      expectValid(
        "SELECT E.SALARY * 1.1 AS RAISED_SALARY FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate SELECT with string concatenation (||)", () => {
      expectValid(
        "SELECT E.FIRST_NAME || ' ' || E.LAST_NAME AS FULL_NAME FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate SELECT with unary minus", () => {
      expectValid("SELECT -1 AS NEG;");
    });

    it("should validate SELECT with NEXT VALUE FOR sequence expression", () => {
      expectValid("SELECT NEXT VALUE FOR sequence1, 1;");
      expectValid("SELECT NEXT VALUE FOR TESTDB..sequence1, 1;");
    });

    it("should validate SELECT with nested parenthesized expressions", () => {
      expectValid("SELECT (1 + 2) * (3 - 4) AS CALC;");
    });

    it("should validate SELECT with IS NULL / IS NOT NULL", () => {
      expectValid("SELECT * FROM TESTDB..EMPLOYEES WHERE MANAGER_ID IS NULL;");
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE MANAGER_ID IS NOT NULL;",
      );
    });

    it("should validate SELECT with BETWEEN", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE SALARY BETWEEN 1000 AND 5000;",
      );
    });

    it("should validate SELECT with NOT BETWEEN", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE NOT SALARY BETWEEN 1000 AND 5000;",
      );
    });

    it("should validate SELECT with IN list", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE DEPARTMENT_ID IN (1, 2, 3);",
      );
    });

    it("should validate SELECT with IN subquery", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES E WHERE E.DEPARTMENT_ID IN (SELECT D.DEPARTMENT_ID FROM TESTDB..DEPARTMENTS D);",
      );
    });

    it("should validate SELECT with LIKE", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE FIRST_NAME LIKE 'J%';",
      );
    });

    it("should validate SELECT with LIKE ESCAPE", () => {
      expectValid("SELECT 'TXT' LIKE 'A' ESCAPE '\\';");
    });

    it("should validate SELECT FROM TABLE WITH FINAL function source", () => {
      expectValid(
        "SELECT F.* FROM TABLE WITH FINAL (TESTDB.PUBLIC.FLUID_FN()) F;",
      );
    });

    it("should validate SELECT with GROUP BY and HAVING", () => {
      expectValid(
        "SELECT DEPARTMENT_ID, COUNT(*) AS CNT FROM TESTDB..EMPLOYEES GROUP BY DEPARTMENT_ID HAVING COUNT(*) > 5;",
      );
    });

    it("should validate SELECT with ORDER BY ASC/DESC", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES ORDER BY SALARY DESC, FIRST_NAME ASC;",
      );
    });

    it("should validate SELECT with LIMIT and OFFSET", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES ORDER BY EMPLOYEE_ID LIMIT 10 OFFSET 20;",
      );
    });

    it("should validate SELECT with multiple table comma-join", () => {
      expectValid(
        "SELECT E.FIRST_NAME, D.DEPARTMENT_NAME FROM TESTDB..EMPLOYEES E, TESTDB..DEPARTMENTS D WHERE E.DEPARTMENT_ID = D.DEPARTMENT_ID;",
      );
    });

    it("should validate SELECT with CROSS JOIN", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES CROSS JOIN TESTDB..DEPARTMENTS;",
      );
    });

    it("should validate SELECT with FULL OUTER JOIN", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES E FULL OUTER JOIN TESTDB..DEPARTMENTS D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID;",
      );
    });

    it("should validate SELECT with RIGHT JOIN", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES E RIGHT JOIN TESTDB..DEPARTMENTS D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID;",
      );
    });

    it("should validate SELECT with RIGHT OUTER JOIN", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES E RIGHT OUTER JOIN TESTDB..DEPARTMENTS D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID;",
      );
    });

    it("should validate SELECT with FULL JOIN (without OUTER)", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES E FULL JOIN TESTDB..DEPARTMENTS D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID;",
      );
    });

    it("should validate SELECT with multiple JOINs chained", () => {
      expectValid(`SELECT OI.ITEM_ID, P.PRODUCT_NAME, O.ORDER_DATE
FROM TESTDB..ORDER_ITEMS OI
JOIN TESTDB..ORDERS O ON OI.ORDER_ID = O.ORDER_ID
JOIN TESTDB..PRODUCTS P ON OI.PRODUCT_ID = P.PRODUCT_ID;`);
    });

    it("should validate SELECT with aliased subquery in FROM", () => {
      expectValid(
        "SELECT S.TOTAL FROM (SELECT SUM(SALARY) AS TOTAL FROM TESTDB..EMPLOYEES) S;",
      );
    });

    it("should validate SELECT with nested subquery in WHERE", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE SALARY > (SELECT AVG(SALARY) FROM TESTDB..EMPLOYEES);",
      );
    });

    it("should validate complex SELECT with comments", () => {
      expectValid(`-- Get top employees
SELECT /* columns */ E.FIRST_NAME, E.SALARY
FROM TESTDB..EMPLOYEES E
WHERE E.SALARY > 1000 -- filter low salaries
ORDER BY E.SALARY DESC
LIMIT 10;`);
    });
  });

  // ========================================================================
  // SELECT — syntax errors
  // ========================================================================
  describe("SELECT — syntax errors", () => {
    it("should detect missing FROM keyword (SELECT cols table)", () => {
      expectSyntaxError("SELECT EMPLOYEE_ID TESTDB..EMPLOYEES;");
    });

    it("should detect double comma in SELECT list", () => {
      expectSyntaxError("SELECT 1, , 2;");
    });

    it("should produce PAR002 error code for double comma", () => {
      expectErrorCode("SELECT 1,,2;", "PAR002");
    });

    it("should produce PAR005 for CASE expression without END", () => {
      expectErrorCode("SELECT CASE WHEN EMPLOYEE_ID = 1 THEN 1 FROM TESTDB..EMPLOYEES;", "PAR005");
    });

    it("should ignore CASE text inside comments", () => {
      const result = validator.validate("SELECT 1 -- CASE without END\nFROM TESTDB..EMPLOYEES;");
      expect(result.errors.some((e) => e.code === "PAR005")).toBe(false);
    });

    it("should produce PAR003 for duplicate FROM keyword", () => {
      expectErrorCode("SELECT 1 FROM FROM DIMACCOUNT;", "PAR003");
    });

    it("should produce PAR003 for duplicate WHERE keyword", () => {
      expectErrorCode("SELECT * FROM t WHERE WHERE x = 1;", "PAR003");
    });

    it("should not produce PAR003 for single FROM", () => {
      const result = validator.validate("SELECT 1 FROM DIMACCOUNT;");
      expect(result.errors.some((e) => e.code === "PAR003")).toBe(false);
    });

    it("should produce PAR004 for keyword typo WHERR", () => {
      const result = validator.validate("SELECT 1 FROM t WHERR 1=1;");
      expect(result.errors.some((e) => e.code === "PAR004")).toBe(true);
    });

    it("should produce PAR004 for keyword typo SELECX", () => {
      const result = validator.validate("SELECX 1 FROM t;");
      expect(result.errors.some((e) => e.code === "PAR004")).toBe(true);
    });

    it("should suggest correct keyword in PAR004 message", () => {
      const result = validator.validate("SELECT 1 FROM t WHERR 1=1;");
      const err = result.errors.find((e) => e.code === "PAR004");
      expect(err).toBeDefined();
      expect(err!.message).toContain("WHERE");
      expect(err!.suggestedFix).toBe("WHERE");
    });

    it("should detect FROM typo FRM (missing O)", () => {
      const result = validator.validate("SELECT 1 FRM t;");
      expect(result.errors.some((e) => e.code === "PAR004" && e.suggestedFix === "FROM")).toBe(true);
    });

    it("should detect FROM typo FORM (transposed OR)", () => {
      const result = validator.validate("SELECT 1 FORM t;");
      expect(result.errors.some((e) => e.code === "PAR004" && e.suggestedFix === "FROM")).toBe(true);
    });

    it("should detect FROM typo OFRM (transposed FO)", () => {
      const result = validator.validate("SELECT 1 OFRM t;");
      expect(result.errors.some((e) => e.code === "PAR004" && e.suggestedFix === "FROM")).toBe(true);
    });

    it("should detect FROM typo FRXM (extra X)", () => {
      const result = validator.validate("SELECT 1 FRXM t;");
      expect(result.errors.some((e) => e.code === "PAR004" && e.suggestedFix === "FROM")).toBe(true);
    });

    it("should detect SELECT typo SELCT (missing E)", () => {
      const result = validator.validate("SELCT 1 FROM t;");
      expect(result.errors.some((e) => e.code === "PAR004" && e.suggestedFix === "SELECT")).toBe(true);
    });

    it("should detect SELECT typo SELET (missing C)", () => {
      const result = validator.validate("SELET 1 FROM t;");
      expect(result.errors.some((e) => e.code === "PAR004" && e.suggestedFix === "SELECT")).toBe(true);
    });

    it("should detect SELECT typo SELCET (transposed CE)", () => {
      const result = validator.validate("SELCET 1 FROM t;");
      expect(result.errors.some((e) => e.code === "PAR004" && e.suggestedFix === "SELECT")).toBe(true);
    });

    it("should detect trailing comma in SELECT list", () => {
      expectSyntaxError("SELECT 1, 2, FROM TESTDB..EMPLOYEES;");
    });

    it("should detect empty SELECT list", () => {
      expectSyntaxError("SELECT FROM TESTDB..EMPLOYEES;");
    });

    it("should detect missing FROM in SELECT * TABLENAME", () => {
      expectErrorCode("SELECT * TABLENAME;", "SQL016");
    });

    it("should produce SQL042 for WHERE without FROM", () => {
      expectWarningCode("SELECT 1 WHERE 1 = 1;", "SQL042");
    });

    it("should not produce SQL042 for nested SELECT in DELETE IN subquery", () => {
      const result = validator.validate(
        "DELETE FROM t WHERE id IN (SELECT 1 WHERE 1 = 1)",
      );
      expect(result.warnings.some((e) => e.code === "SQL042")).toBe(false);
      expect(result.errors.some((e) => e.code === "SQL042")).toBe(false);
    });

    it("should not produce SQL042 for nested SELECT in FROM subquery", () => {
      const result = validator.validate(
        "SELECT * FROM (SELECT 1 WHERE 1 = 1) t",
      );
      expect(result.warnings.some((e) => e.code === "SQL042")).toBe(false);
      expect(result.errors.some((e) => e.code === "SQL042")).toBe(false);
    });

    it("should produce SQL042 for CTE body SELECT with WHERE without FROM", () => {
      expectWarningCode(
        "WITH c AS (SELECT 1 WHERE 1 = 1) SELECT * FROM c",
        "SQL042",
      );
    });

    it("should detect missing FROM in SELECT 1 TABLENAME", () => {
      expectErrorCode("SELECT 1 TABLENAME;", "SQL016");
    });

    it("should not flag SELECT * AS TABLENAME (explicit alias)", () => {
      const result = validator.validate("SELECT * AS TABLENAME;");
      expect(result.errors.some((e) => e.code === "SQL016")).toBe(false);
    });

    it("should not flag SELECT 1 (no alias, no FROM)", () => {
      const result = validator.validate("SELECT 1;");
      expect(result.errors.some((e) => e.code === "SQL016")).toBe(false);
    });

    it("should not flag SELECT * FROM TABLENAME", () => {
      const result = validator.validate("SELECT * FROM TABLENAME;");
      expect(result.errors.some((e) => e.code === "SQL016")).toBe(false);
    });

    it("should detect missing WHERE condition", () => {
      expectSyntaxError("SELECT * FROM TESTDB..EMPLOYEES WHERE;");
    });

    it("should detect missing right operand after =", () => {
      expectSyntaxError("SELECT * FROM TESTDB..EMPLOYEES WHERE SALARY = ;");
    });

    it("should detect unclosed parenthesis in expression", () => {
      expectSyntaxError("SELECT (1 + 2 AS X;");
    });

    it("should detect extra closing parenthesis", () => {
      expectSyntaxError("SELECT 1 + 2) AS X;");
    });

    it("should detect missing ON in JOIN", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB..EMPLOYEES E JOIN TESTDB..DEPARTMENTS D E.DEPARTMENT_ID = D.DEPARTMENT_ID;",
      );
    });

    it("should detect typo in keyword (SELCET instead of SELECT)", () => {
      expectSyntaxError("SELCET 1;");
    });

    it("should detect typo in JOIN (LEFFT JOIN)", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB..EMPLOYEES E LEFFT JOIN TESTDB..DEPARTMENTS D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID;",
      );
    });

    it("should detect typo FORM instead of FROM", () => {
      expectSyntaxError("SELECT 1 FORM TESTDB..EMPLOYEES;");
    });

    it("should detect typo WHER instead of WHERE", () => {
      expectSyntaxError("SELECT * FROM TESTDB..EMPLOYEES WHER SALARY > 100;");
    });

    it("should detect missing GROUP BY expression", () => {
      expectSyntaxError(
        "SELECT DEPARTMENT_ID, COUNT(*) FROM TESTDB..EMPLOYEES GROUP BY;",
      );
    });

    it("should detect missing HAVING expression", () => {
      expectSyntaxError(
        "SELECT DEPARTMENT_ID FROM TESTDB..EMPLOYEES GROUP BY DEPARTMENT_ID HAVING;",
      );
    });

    it("should detect missing ORDER BY expression", () => {
      expectSyntaxError("SELECT * FROM TESTDB..EMPLOYEES ORDER BY;");
    });

    it("should detect missing LIMIT value", () => {
      expectSyntaxError("SELECT * FROM TESTDB..EMPLOYEES LIMIT;");
    });

    it("should detect empty IN list", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE DEPARTMENT_ID IN ();",
      );
    });

    it("should detect missing AND in BETWEEN", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE SALARY BETWEEN 1000 5000;",
      );
    });

    it("should detect double operators (e.g. = =)", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE SALARY = = 100;",
      );
    });

    it("should detect missing THEN in CASE", () => {
      expectSyntaxError("SELECT CASE WHEN 1 = 1 'yes' END;");
    });

    it("should detect missing END in CASE", () => {
      expectSyntaxError("SELECT CASE WHEN 1 = 1 THEN 'yes';");
    });

    it("should detect missing WHEN in CASE", () => {
      expectSyntaxError("SELECT CASE 1 = 1 THEN 'yes' END;");
    });
  });

  // ========================================================================
  // CASE expressions (valid)
  // ========================================================================
  describe("CASE expressions — valid", () => {
    it("should validate simple CASE (searched)", () => {
      expectValid("SELECT CASE WHEN 1 = 1 THEN 'yes' ELSE 'no' END AS RESULT;");
    });

    it("should validate simple CASE (value-based)", () => {
      expectValid(
        "SELECT CASE STATUS WHEN 'A' THEN 'Active' WHEN 'I' THEN 'Inactive' ELSE 'Unknown' END AS LABEL FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate CASE without ELSE", () => {
      expectValid(
        "SELECT CASE WHEN SALARY > 5000 THEN 'High' END AS TIER FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate nested CASE", () => {
      expectValid(`SELECT CASE
    WHEN SALARY > 5000 THEN CASE WHEN DEPARTMENT_ID = 1 THEN 'High-Sales' ELSE 'High-Other' END
    ELSE 'Low'
END AS TIER
FROM TESTDB..EMPLOYEES;`);
    });

    it("should validate CASE with multiple WHEN clauses", () => {
      expectValid(`SELECT CASE
    WHEN SALARY > 10000 THEN 'Executive'
    WHEN SALARY > 5000 THEN 'Senior'
    WHEN SALARY > 2000 THEN 'Mid'
    ELSE 'Junior'
END AS LEVEL
FROM TESTDB..EMPLOYEES;`);
    });
  });

  // ========================================================================
  // INSERT — valid and invalid
  // ========================================================================
  describe("INSERT — valid syntax", () => {
    it("should validate INSERT INTO ... VALUES with single row", () => {
      expectValid(
        "INSERT INTO TESTDB..FILMS (CODE, TITLE, DID) VALUES ('AA001', 'Test Film', 100);",
      );
    });

    it("should validate INSERT INTO ... VALUES with multiple rows", () => {
      expectValid(
        "INSERT INTO TESTDB..FILMS (CODE, TITLE) VALUES ('A', 'Film A'), ('B', 'Film B'), ('C', 'Film C');",
      );
    });

    it("should validate INSERT INTO ... SELECT", () => {
      expectValid(
        "INSERT INTO TESTDB..FILMS (CODE, TITLE) SELECT PRODUCT_ID, PRODUCT_NAME FROM TESTDB..PRODUCTS;",
      );
    });

    it("should validate INSERT INTO without column list with VALUES", () => {
      expectValid(
        "INSERT INTO TESTDB..FILMS VALUES ('AA001', 'Test', 100, '2020-01-01', 'Drama', '02:00:00');",
      );
    });

    it("should validate INSERT INTO without column list with SELECT", () => {
      expectValid("INSERT INTO TESTDB..ORDERS SELECT * FROM TESTDB..ORDERS;");
    });
  });

  describe("INSERT — syntax errors", () => {
    it("should detect missing INTO keyword", () => {
      expectSyntaxError("INSERT TESTDB..FILMS VALUES ('A', 'B');");
    });

    it("should detect missing VALUES keyword", () => {
      expectSyntaxError("INSERT INTO TESTDB..FILMS ('A', 'B');");
    });

    it("should detect missing parentheses in VALUES", () => {
      expectSyntaxError("INSERT INTO TESTDB..FILMS VALUES 'A', 'B';");
    });

    it("should detect trailing comma in column list", () => {
      expectSyntaxError(
        "INSERT INTO TESTDB..FILMS (CODE, TITLE,) VALUES ('A', 'B');",
      );
    });

    it("should detect empty column list", () => {
      expectSyntaxError("INSERT INTO TESTDB..FILMS () VALUES ('A');");
    });

    it("should detect empty VALUES row", () => {
      expectSyntaxError("INSERT INTO TESTDB..FILMS (CODE) VALUES ();");
    });

    it("should detect INSERT with neither VALUES nor SELECT", () => {
      expectSyntaxError("INSERT INTO TESTDB..FILMS (CODE);");
    });
  });

  // ========================================================================
  // UPDATE — valid and invalid
  // ========================================================================
  describe("UPDATE — valid syntax", () => {
    it("should validate simple UPDATE", () => {
      expectValid(
        "UPDATE TESTDB..FILMS SET KIND = 'Dramatic' WHERE KIND = 'Drama';",
      );
    });

    it("should validate UPDATE with multiple SET columns", () => {
      expectValid(
        "UPDATE TESTDB..FILMS SET KIND = 'Dramatic', TITLE = 'New Title' WHERE CODE = 'AA001';",
      );
    });

    it("should validate UPDATE with alias", () => {
      expectValid(
        "UPDATE TESTDB..FILMS F SET F.KIND = 'Dramatic' WHERE F.CODE = 'AA001';",
      );
    });

    it("should report SQL044 for UPDATE without WHERE (update all rows)", () => {
      expectErrorCode("UPDATE TESTDB..FILMS SET KIND = 'Unknown';", "SQL044");
    });

    it("should validate UPDATE with complex WHERE", () => {
      expectValid(
        "UPDATE TESTDB..FILMS SET KIND = 'Drama' WHERE KIND = 'D' AND DID > 100 OR TITLE LIKE '%test%';",
      );
    });

    it("should validate UPDATE with expression in SET", () => {
      expectValid(
        "UPDATE TESTDB..EMPLOYEES SET SALARY = SALARY * 1.1 WHERE DEPARTMENT_ID = 1;",
      );
    });

    it("should validate UPDATE with subquery in WHERE", () => {
      expectValid(
        "UPDATE TESTDB..EMPLOYEES SET SALARY = 0 WHERE DEPARTMENT_ID IN (1, 2, 3);",
      );
    });
  });

  describe("UPDATE — syntax errors", () => {
    it("should detect missing SET keyword", () => {
      expectSyntaxError("UPDATE TESTDB..FILMS KIND = 'Dramatic';");
    });

    it("should detect WHERE without SET", () => {
      expectSyntaxError("UPDATE JUST_DATA..DIMACCOUNT A WHERE A.ACCOUNTCODEALTERNATEKEY = 1;");
    });

    it("should detect missing = in SET clause", () => {
      expectSyntaxError("UPDATE TESTDB..FILMS SET KIND 'Dramatic';");
    });

    it("should detect missing value after = in SET", () => {
      expectSyntaxError("UPDATE TESTDB..FILMS SET KIND = WHERE CODE = 'A';");
    });

    it("should detect double comma in SET list", () => {
      expectSyntaxError("UPDATE TESTDB..FILMS SET KIND = 'A',, TITLE = 'B';");
    });

    it("should detect missing table name", () => {
      expectSyntaxError("UPDATE SET KIND = 'Dramatic';");
    });
  });

  // ========================================================================
  // DELETE — valid and invalid
  // ========================================================================
  describe("DELETE — valid syntax", () => {
    it("should validate simple DELETE", () => {
      expectValid("DELETE FROM TESTDB..FILMS WHERE KIND <> 'Musical';");
    });

    it("should report SQL043 for DELETE without WHERE (clear table)", () => {
      expectErrorCode("DELETE FROM TESTDB..FILMS;", "SQL043");
    });

    it("should validate DELETE with alias", () => {
      expectValid("DELETE FROM TESTDB..FILMS F WHERE F.KIND = 'Drama';");
    });

    it("should validate DELETE with complex WHERE", () => {
      expectValid(
        "DELETE FROM TESTDB..FILMS WHERE KIND = 'Horror' AND DID < 100 OR TITLE LIKE '%Old%';",
      );
    });

    it("should validate DELETE with subquery in WHERE", () => {
      expectValid(
        "DELETE FROM TESTDB..EMPLOYEES WHERE DEPARTMENT_ID IN (SELECT D.DEPARTMENT_ID FROM TESTDB..DEPARTMENTS D);",
      );
    });

    it("should validate DELETE with CTE-backed subquery in WHERE IN", () => {
      expectValid(`DELETE FROM TESTDB..EMPLOYEES E
WHERE E.DEPARTMENT_ID IN (
  WITH ACTIVE_DEPARTMENTS AS (
    SELECT D.DEPARTMENT_ID
    FROM TESTDB..DEPARTMENTS D
  )
  SELECT * FROM ACTIVE_DEPARTMENTS
);`);
    });
  });

  describe("DELETE — syntax errors", () => {
    it("should detect missing FROM keyword", () => {
      expectSyntaxError("DELETE TESTDB..FILMS WHERE CODE = 1;");
    });

    it("should detect missing table after FROM", () => {
      expectSyntaxError("DELETE FROM WHERE CODE = 'A';");
    });

    it("should detect incomplete WHERE", () => {
      expectSyntaxError("DELETE FROM TESTDB..FILMS WHERE;");
    });

    it("should detect missing comparison value in WHERE", () => {
      expectSyntaxError("DELETE FROM TESTDB..FILMS WHERE CODE = ;");
    });
  });

  // ========================================================================
  // CTE (WITH clause) — valid and invalid
  // ========================================================================
  describe("CTE — valid syntax", () => {
    it("should validate simple CTE", () => {
      expectValid(`WITH CTE AS (SELECT 1 AS VAL)
SELECT VAL FROM CTE;`);
    });

    it("should validate multiple CTEs", () => {
      expectValid(`WITH
    CTE_A AS (SELECT 1 AS A),
    CTE_B AS (SELECT 2 AS B)
SELECT CTE_A.A, CTE_B.B FROM CTE_A CROSS JOIN CTE_B;`);
    });

    it("should validate CTE referencing a real table", () => {
      expectValid(`WITH EMP_CTE AS (
    SELECT E.EMPLOYEE_ID, E.FIRST_NAME, E.SALARY
    FROM TESTDB..EMPLOYEES E
    WHERE E.SALARY > 3000
)
SELECT C.EMPLOYEE_ID, C.FIRST_NAME
FROM EMP_CTE C
ORDER BY C.SALARY DESC;`);
    });

    it("should validate CTE with JOIN in final SELECT", () => {
      expectValid(`WITH DEPT_CTE AS (
    SELECT DEPARTMENT_ID, DEPARTMENT_NAME FROM TESTDB..DEPARTMENTS
)
SELECT E.FIRST_NAME, D.DEPARTMENT_NAME
FROM TESTDB..EMPLOYEES E
JOIN DEPT_CTE D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID;`);
    });

    it("should validate chained CTEs where later CTE references earlier one", () => {
      expectValid(`WITH
    CTE_1 AS (SELECT 1 AS X),
    CTE_2 AS (SELECT X + 1 AS Y FROM CTE_1)
SELECT Y FROM CTE_2;`);
    });

    it("should validate CTE with subquery in WHERE", () => {
      expectValid(`WITH ACTIVE_DEPTS AS (
    SELECT D.DEPARTMENT_ID FROM TESTDB..DEPARTMENTS D
)
SELECT E.* FROM TESTDB..EMPLOYEES E
WHERE E.DEPARTMENT_ID IN (SELECT AD.DEPARTMENT_ID FROM ACTIVE_DEPTS AD);`);
    });
  });

  describe("CTE — WITH RECURSIVE", () => {
    it("should validate simple recursive CTE", () => {
      expectValid(`WITH RECURSIVE CTE AS (
    SELECT 1 AS N
    UNION ALL
    SELECT N + 1 FROM CTE WHERE N < 10
)
SELECT N FROM CTE;`);
    });

    it("should validate recursive CTE with anchor and recursive member", () => {
      expectValid(`WITH RECURSIVE EMP_HIERARCHY AS (
    SELECT EMPLOYEE_ID, MANAGER_ID, FIRST_NAME, 1 AS LEVEL
    FROM TESTDB..EMPLOYEES
    WHERE MANAGER_ID IS NULL
    UNION ALL
    SELECT E.EMPLOYEE_ID, E.MANAGER_ID, E.FIRST_NAME, EH.LEVEL + 1
    FROM TESTDB..EMPLOYEES E
    JOIN EMP_HIERARCHY EH ON E.MANAGER_ID = EH.EMPLOYEE_ID
)
SELECT * FROM EMP_HIERARCHY;`);
    });

    it("should validate recursive CTE with multiple columns", () => {
      expectValid(`WITH RECURSIVE NUMBERS AS (
    SELECT 1 AS ID, 'Start' AS LABEL
    UNION ALL
    SELECT ID + 1, 'Next'
    FROM NUMBERS
    WHERE ID < 5
)
SELECT * FROM NUMBERS;`);
    });

    it("should detect column in recursive CTE that does not exist", () => {
      expectErrorCode(
        `WITH RECURSIVE CTE AS (
    SELECT EMPLOYEE_ID, NONEXISTENT_COL FROM TESTDB..EMPLOYEES
    UNION ALL
    SELECT EMPLOYEE_ID, NONEXISTENT_COL FROM CTE WHERE EMPLOYEE_ID < 100
)
SELECT * FROM CTE;`,
        "SQL004",
      );
    });
  });

  describe("CTE — name shadowing", () => {
    it("should detect CTE shadowing table name (CTE takes precedence)", () => {
      // CTE with same name as table - CTE should be used
      expectValid(`WITH EMPLOYEES AS (SELECT 1 AS ID)
SELECT ID FROM EMPLOYEES;`);
    });

    it("should validate CTE referencing earlier CTE with same column name", () => {
      // CTE2 references CTE1's COL_A and renames output to COL_A
      // The final SELECT from CTE2 should be unambiguous
      expectValid(`WITH
    CTE1 AS (SELECT 1 AS COL_A),
    CTE2 AS (SELECT COL_A + 1 AS COL_B FROM CTE1)
SELECT COL_B FROM CTE2;`);
    });

    it("should detect ambiguous column when CTE and table have same alias", () => {
      // When both a CTE and table are in scope with same alias
      // This creates ambiguity for unqualified columns - EMPLOYEE_ID exists in both EMP (CTE) and E (table alias)
      expectErrorCode(
        `WITH EMP AS (SELECT 1 AS EMPLOYEE_ID)
SELECT EMPLOYEE_ID FROM EMP, TESTDB..EMPLOYEES E WHERE EMP.EMPLOYEE_ID = E.EMPLOYEE_ID;`,
        "SQL008",
      );
    });

    it("should validate nested CTE scope (inner references outer)", () => {
      expectValid(`WITH OUTER_CTE AS (SELECT 1 AS X)
SELECT * FROM (
    SELECT X FROM OUTER_CTE
) AS INNER_Q;`);
    });
  });

  describe("CTE — nested WITH (Netezza extension)", () => {
    it("should validate nested WITH inside CTE body", () => {
      expectValid(`WITH ABC AS
(
    WITH DEF AS (
        SELECT 1 AS ONE FROM TESTDB..EMPLOYEES
    )
    SELECT 9 AS NINE
)
SELECT * FROM ABC;`);
    });

    it("should validate nested WITH with multiple inner CTEs", () => {
      expectValid(`WITH ABC AS
(
    WITH DEF AS (
        SELECT 1 AS ONE FROM TESTDB..EMPLOYEES
    )
    , EFG AS (
        SELECT 2 AS TWO FROM TESTDB..EMPLOYEES
    )
    SELECT 9 AS NINE
)
SELECT * FROM ABC;`);
    });

    it("should validate AS ALL modifier on CTE (Netezza materialization hint)", () => {
      expectValid(`WITH ABC AS ALL (
    SELECT 1 AS ONE FROM TESTDB..EMPLOYEES
)
SELECT * FROM ABC;`);
    });

    it("should validate AS ALL with nested WITH", () => {
      expectValid(`WITH ABC AS
(
    WITH DEF AS (
        SELECT 1 AS ONE FROM TESTDB..EMPLOYEES
    )
    , EFG AS ALL
    (
        SELECT 2 AS TWO FROM TESTDB..EMPLOYEES
    )
    SELECT 9 AS NINE
)
SELECT * FROM ABC;`);
    });

    it("should validate deeply nested WITH clauses", () => {
      expectValid(`WITH OUTER_CTE AS (
    WITH INNER_CTE AS (
        WITH DEEPEST_CTE AS (
            SELECT 1 AS VAL
        )
        SELECT VAL FROM DEEPEST_CTE
    )
    SELECT VAL FROM INNER_CTE
)
SELECT * FROM OUTER_CTE;`);
    });

    it("should validate nested CTE with column list", () => {
      expectValid(`WITH ABC (COL1) AS (
    WITH DEF AS (SELECT 1 AS ONE)
    SELECT ONE FROM DEF
)
SELECT COL1 FROM ABC;`);
    });

    it("should validate multiple outer CTEs where one has nested WITH", () => {
      expectValid(`WITH
    CTE_A AS (SELECT 1 AS A),
    CTE_B AS (
        WITH INNER_CTE AS (SELECT 2 AS B)
        SELECT B FROM INNER_CTE
    )
SELECT CTE_A.A, CTE_B.B FROM CTE_A CROSS JOIN CTE_B;`);
    });

    it("should validate nested WITH with UNION ALL inside CTE", () => {
      expectValid(`WITH ABC AS (
    WITH DEF AS (
        SELECT 1 AS X
        UNION ALL
        SELECT 2 AS X
    )
    SELECT X FROM DEF
)
SELECT * FROM ABC;`);
    });
  });

  describe("CTE — syntax errors", () => {
    it("should detect missing parentheses around CTE query", () => {
      expectSyntaxError("WITH CTE AS SELECT 1 AS VAL SELECT * FROM CTE;");
    });

    it("should detect missing final SELECT after CTE", () => {
      expectSyntaxError("WITH CTE AS (SELECT 1 AS VAL);");
    });

    it("should detect empty CTE body", () => {
      expectSyntaxError("WITH CTE AS () SELECT 1;");
    });

    it("should detect trailing comma after last CTE definition", () => {
      expectSyntaxError("WITH CTE AS (SELECT 1 AS VAL), SELECT * FROM CTE;");
    });

    it("should detect missing CTE name", () => {
      expectSyntaxError("WITH AS (SELECT 1 AS VAL) SELECT 1;");
    });
  });

  // ========================================================================
  // Subqueries
  // ========================================================================
  describe("Subqueries — valid syntax", () => {
    it("should validate scalar subquery in SELECT list", () => {
      expectValid(
        "SELECT E.FIRST_NAME, (SELECT COUNT(*) FROM TESTDB..ORDERS) AS ORDER_CNT FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate correlated subquery in WHERE", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES E WHERE E.SALARY > (SELECT AVG(E2.SALARY) FROM TESTDB..EMPLOYEES E2 WHERE E2.DEPARTMENT_ID = E.DEPARTMENT_ID);",
      );
    });

    it("should validate subquery as table source in FROM", () => {
      expectValid(
        "SELECT SUB.EMPLOYEE_ID FROM (SELECT EMPLOYEE_ID, SALARY FROM TESTDB..EMPLOYEES WHERE SALARY > 1000) SUB;",
      );
    });

    it("should validate deeply nested subqueries", () => {
      expectValid(
        "SELECT * FROM (SELECT * FROM (SELECT 1 AS X) INNER_Q) OUTER_Q;",
      );
    });
  });

  describe("Subqueries — syntax errors", () => {
    it("should detect missing closing paren in subquery", () => {
      expectSyntaxError("SELECT * FROM (SELECT 1 AS X;");
    });

    it("should detect missing opening paren in subquery", () => {
      expectSyntaxError("SELECT * FROM SELECT 1 AS X) S;");
    });
  });

  // ========================================================================
  // Window functions
  // ========================================================================
  describe("Window functions — valid syntax", () => {
    it("should validate ROW_NUMBER() OVER (ORDER BY ...)", () => {
      expectValid(
        "SELECT ROW_NUMBER() OVER (ORDER BY SALARY DESC) AS RN FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate RANK() with PARTITION BY and ORDER BY", () => {
      expectValid(
        "SELECT RANK() OVER (PARTITION BY DEPARTMENT_ID ORDER BY SALARY DESC) AS RK FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate DENSE_RANK()", () => {
      expectValid(
        "SELECT DENSE_RANK() OVER (ORDER BY SALARY) AS DR FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate LAG with offset argument", () => {
      expectValid(
        "SELECT LAG(SALARY, 1) OVER (ORDER BY EMPLOYEE_ID) AS PREV_SAL FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate LEAD with offset and default", () => {
      expectValid(
        "SELECT LEAD(SALARY, 1, 0) OVER (ORDER BY EMPLOYEE_ID) AS NEXT_SAL FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate SUM as window function", () => {
      expectValid(
        "SELECT SUM(SALARY) OVER (PARTITION BY DEPARTMENT_ID ORDER BY EMPLOYEE_ID) AS RUN_TOTAL FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate NTILE()", () => {
      expectValid(
        "SELECT NTILE(4) OVER (ORDER BY SALARY DESC) AS QUARTILE FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate FIRST_VALUE / LAST_VALUE", () => {
      expectValid(
        "SELECT FIRST_VALUE(SALARY) OVER (PARTITION BY DEPARTMENT_ID ORDER BY SALARY) AS MIN_SAL FROM TESTDB..EMPLOYEES;",
      );
      expectValid(
        "SELECT LAST_VALUE(SALARY) OVER (PARTITION BY DEPARTMENT_ID ORDER BY SALARY) AS MAX_SAL FROM TESTDB..EMPLOYEES;",
      );
    });
  });

  // ========================================================================
  // Type casting
  // ========================================================================
  describe("Type casting — valid syntax", () => {
    it("should validate :: operator with simple type", () => {
      expectValid("SELECT 1::INT4 AS X;");
    });

    it("should validate :: operator with parameterized type", () => {
      expectValid("SELECT 1::VARCHAR(20) AS X;");
    });

    it("should validate :: operator chained", () => {
      expectValid("SELECT '123'::INT4::VARCHAR(10) AS X;");
    });

    it("should validate CAST(expr AS type)", () => {
      expectValid("SELECT CAST('2020-01-01' AS DATE) AS D;");
    });

    it("should validate CAST with NUMERIC precision", () => {
      expectValid("SELECT CAST(3.14159 AS NUMERIC(10,2)) AS PI;");
    });

    it("should validate EXTRACT(field FROM expr)", () => {
      expectValid("SELECT EXTRACT(MONTH FROM '2020-06-15') AS M;");
    });
  });


  describe("TRUNCATE — valid syntax", () => {
    it("should validate TRUNCATE TABLE", () => {
      expectValid("TRUNCATE TABLE TESTDB.PUBLIC.EMPLOYEES;");
    });

    it("should validate TRUNCATE without TABLE keyword", () => {
      expectValid("TRUNCATE TESTDB.PUBLIC.EMPLOYEES;");
    });
  });

  describe("EXPLAIN — valid syntax", () => {
    it("should validate EXPLAIN SELECT", () => {
      expectValid("EXPLAIN SELECT * FROM TESTDB..EMPLOYEES;");
    });

    it("should validate EXPLAIN VERBOSE SELECT", () => {
      expectValid("EXPLAIN VERBOSE SELECT * FROM TESTDB..EMPLOYEES;");
    });

    it("should validate EXPLAIN VERBOSE DISTRIBUTION PLANTEXT SELECT", () => {
      expectValid("EXPLAIN VERBOSE DISTRIBUTION PLANTEXT SELECT 1;");
    });

    it("should validate EXPLAIN PLANGRAPH SELECT", () => {
      expectValid("EXPLAIN PLANGRAPH SELECT * FROM TESTDB..EMPLOYEES;");
    });

    it("should validate EXPLAIN with CTAS", () => {
      expectValid("EXPLAIN CREATE TABLE TMP_EX AS (SELECT 1 AS C);");
    });
  });

  // ========================================================================
  // GROOM / GENERATE STATISTICS
  // ========================================================================
  describe("GROOM TABLE — valid syntax", () => {
    it("should validate GROOM TABLE VERSIONS", () => {
      expectValid("GROOM TABLE TESTDB.PUBLIC.EMPLOYEES VERSIONS;");
    });

    it("should validate GROOM TABLE RECORDS ALL", () => {
      expectValid("GROOM TABLE TESTDB.PUBLIC.EMPLOYEES RECORDS ALL;");
    });

    it("should validate GROOM TABLE PAGES START with RECLAIM BACKUPSET DEFAULT", () => {
      expectValid(
        "GROOM TABLE TESTDB.PUBLIC.EMPLOYEES PAGES START RECLAIM BACKUPSET DEFAULT;",
      );
    });
  });

  describe("GENERATE STATISTICS — valid syntax", () => {
    it("should validate bare GENERATE STATISTICS", () => {
      expectValid("GENERATE STATISTICS;");
    });

    it("should validate GENERATE STATISTICS ON table", () => {
      expectValid("GENERATE STATISTICS ON TESTDB..EMPLOYEES;");
    });

    it("should validate GENERATE EXPRESS STATISTICS FOR TABLE", () => {
      expectValid("GENERATE EXPRESS STATISTICS FOR TABLE TESTDB..EMPLOYEES;");
    });

    it("should validate GENERATE STATISTICS with column list", () => {
      expectValid(
        "GENERATE STATISTICS ON TESTDB..EMPLOYEES (EMPLOYEE_ID, SALARY);",
      );
    });
  });


  // ========================================================================
  // COMMENT ON
  // ========================================================================
  describe("COMMENT ON — valid syntax", () => {
    it("should validate COMMENT ON TABLE", () => {
      expectValid(
        "COMMENT ON TABLE TESTDB.PUBLIC.EMPLOYEES IS 'Main employee table';",
      );
    });

    it("should validate COMMENT ON VIEW", () => {
      expectValid("COMMENT ON VIEW V_EMP IS 'Employee view';");
    });

    it("should validate COMMENT ON COLUMN", () => {
      expectValid(
        "COMMENT ON COLUMN TESTDB.PUBLIC.EMPLOYEES.SALARY IS 'Annual salary';",
      );
    });

    it("should validate COMMENT ON PROCEDURE", () => {
      expectValid("COMMENT ON PROCEDURE MY_PROC IS 'Helper procedure';");
    });

    it("should validate COMMENT ON PROCEDURE with empty parens", () => {
      expectValid(
        "COMMENT ON PROCEDURE EXISTING_PROC_WITH_NO_PARAMS() IS 'TEST TEST';",
      );
    });

    it("should validate COMMENT ON PROCEDURE with single param type", () => {
      expectValid(
        "COMMENT ON PROCEDURE EXISTING_PROC_WITH_ONE_PARAM(INT) IS 'TEST TEST';",
      );
    });

    it("should validate COMMENT ON PROCEDURE with multiple param types", () => {
      expectValid(
        "COMMENT ON PROCEDURE MY_PROC(INT, VARCHAR) IS 'Multi-param proc';",
      );
    });

    it("should validate COMMENT ON PROCEDURE with schema-qualified name and params", () => {
      expectValid(
        "COMMENT ON PROCEDURE ADMIN.MY_PROC(INT, VARCHAR(50)) IS 'Schema qualified';",
      );
    });
  });

  // ========================================================================
  // Multi-statement scripts
  // ========================================================================
  describe("Multi-statement scripts", () => {
    it("should validate multiple statements separated by semicolons", () => {
      expectValid(`SELECT 1;
SELECT 2;
SELECT 3;`);
    });

    it("should validate mixed statement types", () => {
      expectValid(`CREATE TEMP TABLE TMP_MIX AS (SELECT 1 AS ID);
SELECT * FROM TMP_MIX;
DROP TABLE TMP_MIX;`);
    });

    it("should allow trailing semicolons", () => {
      expectValid("SELECT 1;;;");
    });

    it("should validate CTAS followed by INSERT followed by SELECT", () => {
      expectValid(`CREATE TEMP TABLE TMP_SCRIPT (ID INT4, NAME VARCHAR(20));
INSERT INTO TMP_SCRIPT (ID, NAME) VALUES (1, 'Alice');
SELECT * FROM TMP_SCRIPT;`);
    });
  });

  // ========================================================================
  // Parenthesis balancing errors
  // ========================================================================
  describe("Parenthesis balancing errors", () => {
    it("should detect unmatched open paren in SELECT expression", () => {
      expectSyntaxError("SELECT (1 + 2;");
    });

    it("should detect unmatched close paren in SELECT expression", () => {
      expectSyntaxError("SELECT 1 + 2);");
    });

    it("should detect unmatched open paren in subquery", () => {
      expectSyntaxError("SELECT * FROM (SELECT 1 AS X;");
    });

    it("should detect unmatched paren in function call", () => {
      expectSyntaxError("SELECT COUNT(;");
    });

    it("should detect unmatched paren in IN list", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE DEPARTMENT_ID IN (1, 2, 3;",
      );
    });

    it("should detect unmatched paren in CASE expression", () => {
      expectSyntaxError("SELECT CASE WHEN (1 = 1 THEN 'yes' END;");
    });

    it("should detect double close paren", () => {
      expectSyntaxError("SELECT (1 + 2)) AS X;");
    });
  });

  // ========================================================================
  describe("Complex real-world scenarios", () => {
    it("should validate deeply nested CASE inside window function", () => {
      expectValid(`SELECT
    EMPLOYEE_ID,
    CASE
        WHEN SALARY > 10000 THEN 'Executive'
        WHEN SALARY > 5000 THEN 'Senior'
        ELSE 'Junior'
    END AS TIER,
    ROW_NUMBER() OVER (
        PARTITION BY DEPARTMENT_ID
        ORDER BY SALARY DESC
    ) AS DEPT_RANK
FROM TESTDB..EMPLOYEES;`);
    });

    it("should validate multiple window functions in same query", () => {
      expectValid(`SELECT
    EMPLOYEE_ID,
    SALARY,
    ROW_NUMBER() OVER (ORDER BY SALARY DESC) AS OVERALL_RANK,
    RANK() OVER (PARTITION BY DEPARTMENT_ID ORDER BY SALARY DESC) AS DEPT_RANK,
    SUM(SALARY) OVER (PARTITION BY DEPARTMENT_ID) AS DEPT_TOTAL
FROM TESTDB..EMPLOYEES;`);
    });

    it("should validate complex multi-join with subquery and CASE", () => {
      expectValid(`SELECT
    E.FIRST_NAME,
    E.LAST_NAME,
    D.DEPARTMENT_NAME,
    CASE WHEN OI.TOTAL_ITEMS > 10 THEN 'High' ELSE 'Low' END AS ACTIVITY
FROM TESTDB..EMPLOYEES E
JOIN TESTDB..DEPARTMENTS D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID
LEFT JOIN (
    SELECT ORDER_ID, COUNT(*) AS TOTAL_ITEMS
    FROM TESTDB..ORDER_ITEMS
    GROUP BY ORDER_ID
) OI ON E.EMPLOYEE_ID = OI.ORDER_ID
WHERE E.SALARY > 1000
ORDER BY E.SALARY DESC
LIMIT 50;`);
    });

  });

  // ========================================================================
  // Semantic validation (error codes)
  // ========================================================================
  describe("Semantic validation — column/table errors", () => {
    it("should detect reference to non-existent table (qualified)", () => {
      expectErrorCode(
        "SELECT * FROM TESTDB.PUBLIC.NONEXISTENT_TABLE;",
        "SQL006",
      );
    });

    it("should detect non-existent database in 3-part qualified name", () => {
      expectErrorCode(
        "SELECT * FROM NO_SUCH_DATABSE.ADMIN.FACT_SALES_2;",
        "SQL006",
      );
    });

    it("should detect non-existent database in GROOM TABLE", () => {
      expectErrorCode(
        "GROOM TABLE NO_SUCH_DATABASE.ADMIN.DIMACCOUNT;",
        "SQL006",
      );
    });

    it("should detect non-existent table in GROOM TABLE", () => {
      expectErrorCode(
        "GROOM TABLE EXISTING_DATABASE.ADMIN.NO_SUCH_TABLE;",
        "SQL006",
      );
    });

    it("should detect non-existent procedure in COMMENT ON PROCEDURE", () => {
      expectErrorCode(
        "COMMENT ON PROCEDURE EXISTING_DATABASE.ADMIN.NO_SUCH_PROCEDURE() IS 'TEST COMMENT';",
        "SQL006",
      );
    });

    it("should detect non-existent database in COMMENT ON PROCEDURE", () => {
      expectErrorCode(
        "COMMENT ON PROCEDURE NO_SUCH_DATABASE.ADMIN.EXISTING_PROCEDURE() IS 'TEST COMMENT';",
        "SQL006",
      );
    });

    it("should detect non-existent target table in INSERT INTO", () => {
      expectErrorCode(
        "INSERT INTO NO_SUCH_DATABASE.ADMIN.NO_SUCH_TABLE VALUES (1);",
        "SQL006",
      );
    });

    it("should detect non-existent column in INSERT INTO column list", () => {
      expectErrorCode(
        "INSERT INTO TESTDB..EMPLOYEES (FAKE_COLUMN, SALARY) VALUES (1, 100);",
        "SQL004",
      );
    });

    it("should not report column error for existing columns in INSERT INTO", () => {
      expectValid(
        "INSERT INTO TESTDB..EMPLOYEES (EMPLOYEE_ID, SALARY) VALUES (1, 100);",
      );
    });

    it("should detect non-existent table in DROP TABLE", () => {
      expectErrorCode(
        "DROP TABLE NO_SUCH_DATABASE.ADMIN.NO_SUCH_TABLE;",
        "SQL006",
      );
    });

    it("should detect non-existent table in TRUNCATE TABLE", () => {
      expectErrorCode(
        "TRUNCATE TABLE NO_SUCH_DATABASE.ADMIN.NO_SUCH_TABLE;",
        "SQL006",
      );
    });

    it("should detect non-existent table in LOCK TABLE", () => {
      expectErrorCode(
        "LOCK TABLE NO_SUCH_DATABASE.ADMIN.NO_SUCH_TABLE IN EXCLUSIVE MODE;",
        "SQL006",
      );
    });

    it("should detect non-existent table in ALTER TABLE", () => {
      expectErrorCode(
        "ALTER TABLE NO_SUCH_DATABASE.ADMIN.NO_SUCH_TABLE ADD COLUMN X INT;",
        "SQL006",
      );
    });

    it("should detect reference to non-existent column (qualified)", () => {
      expectErrorCode(
        "SELECT E.FAKE_COLUMN FROM TESTDB..EMPLOYEES E;",
        "SQL004",
      );
    });

    it("should detect non-existent column in UPDATE SET", () => {
      expectErrorCode(
        "UPDATE TESTDB..EMPLOYEES SET FAKE_COLUMN = 'x';",
        "SQL004",
      );
    });

    it("should produce SQL044 for UPDATE without WHERE", () => {
      expectErrorCode(
        "UPDATE TESTDB..EMPLOYEES SET SALARY = SALARY + 1;",
        "SQL044",
      );
    });

    it("should produce SQL046 for UPDATE alias using AS", () => {
      expectErrorCode(
        "UPDATE TESTDB..EMPLOYEES AS E SET SALARY = SALARY + 1 WHERE EMPLOYEE_ID = 1;",
        "SQL046",
      );
    });

    it("should detect non-existent column in DELETE WHERE", () => {
      expectErrorCode(
        "DELETE FROM TESTDB..EMPLOYEES WHERE FAKE_COLUMN = 1;",
        "SQL004",
      );
    });

    it("should produce SQL043 for DELETE without WHERE", () => {
      expectErrorCode("DELETE FROM TESTDB..EMPLOYEES;", "SQL043");
    });

    it("should detect invalid DB.TABLE form (should be DB..TABLE)", () => {
      const result = validator.validate("SELECT 1 FROM TESTDB.EMPLOYEES;");
      expect(result.errors.some((e) => e.code === "SQL007")).toBe(true);
    });

    it("should detect ambiguous unqualified column across JOINed tables", () => {
      expectErrorCode(
        `SELECT DEPARTMENT_ID FROM TESTDB..EMPLOYEES E JOIN TESTDB..DEPARTMENTS D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID;`,
        "SQL008",
      );
    });
  });

  // ========================================================================
  // Boolean expression validation
  // ========================================================================
  describe("Boolean expression validation", () => {
    it("should detect non-boolean expression in WHERE", () => {
      expectErrorCode(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE SALARY + 1;",
        "SQL010",
      );
    });

    it("should detect non-boolean expression in ON clause", () => {
      expectErrorCode(
        "SELECT * FROM TESTDB..EMPLOYEES E JOIN TESTDB..DEPARTMENTS D ON E.DEPARTMENT_ID + D.DEPARTMENT_ID;",
        "SQL010",
      );
    });
  });

  describe("Netezza parser coverage gaps", () => {
    it("should validate ILIKE predicates", () => {
      expectValid("SELECT EMPLOYEE_ID FROM TESTDB..EMPLOYEES WHERE FIRST_NAME ILIKE 'A%';");
    });

    it("should validate LIKE ESCAPE predicates", () => {
      expectValid("SELECT EMPLOYEE_ID FROM TESTDB..EMPLOYEES WHERE FIRST_NAME LIKE 'A!_%' ESCAPE '!';");
    });

    it("should validate GROUP BY ROLLUP", () => {
      expectValid(
        "SELECT DEPARTMENT_ID, COUNT(*) FROM TESTDB..EMPLOYEES GROUP BY ROLLUP(DEPARTMENT_ID);",
      );
    });

    it("should validate GROUP BY CUBE", () => {
      expectValid(
        "SELECT DEPARTMENT_ID, STATUS, COUNT(*) FROM TESTDB..EMPLOYEES GROUP BY CUBE(DEPARTMENT_ID, STATUS);",
      );
    });

    it("should validate GROUP BY GROUPING SETS", () => {
      expectValid(
        "SELECT DEPARTMENT_ID, STATUS, COUNT(*) FROM TESTDB..EMPLOYEES GROUP BY GROUPING SETS ((DEPARTMENT_ID), (STATUS));",
      );
    });
  });

  // ========================================================================
  // Aggregate/window functions in WHERE (SQL021)
  // ========================================================================
  describe("SQL021: aggregate/window functions in WHERE clause", () => {
    it("should report STDDEV in WHERE", () => {
      expectErrorCode(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE STDDEV(SALARY) > 0;",
        "SQL021",
      );
    });

    it("should report VARIANCE in WHERE", () => {
      expectErrorCode(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE VARIANCE(SALARY) > 0;",
        "SQL021",
      );
    });

    it("should report ROW_NUMBER in WHERE", () => {
      expectErrorCode(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE ROW_NUMBER() OVER (ORDER BY SALARY) > 0;",
        "SQL021",
      );
    });

    it("should report RANK in WHERE", () => {
      expectErrorCode(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE RANK() OVER (ORDER BY SALARY) > 0;",
        "SQL021",
      );
    });

    it("should report DENSE_RANK in WHERE", () => {
      expectErrorCode(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE DENSE_RANK() OVER (ORDER BY SALARY) > 0;",
        "SQL021",
      );
    });

    it("should report LAG in WHERE", () => {
      expectErrorCode(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE LAG(SALARY) OVER (ORDER BY EMPLOYEE_ID) > 0;",
        "SQL021",
      );
    });

    it("should report LEAD in WHERE", () => {
      expectErrorCode(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE LEAD(SALARY) OVER (ORDER BY EMPLOYEE_ID) > 0;",
        "SQL021",
      );
    });

    it("should report NTILE in WHERE", () => {
      expectErrorCode(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE NTILE(4) OVER (ORDER BY SALARY) > 0;",
        "SQL021",
      );
    });

    it("should not report error for aggregate in HAVING", () => {
      expectValid(
        "SELECT DEPARTMENT_ID, SUM(SALARY) FROM TESTDB..EMPLOYEES GROUP BY DEPARTMENT_ID HAVING SUM(SALARY) > 10000;",
      );
    });

    it("should not report error for aggregate in subquery within WHERE", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE SALARY > (SELECT AVG(SALARY) FROM TESTDB..EMPLOYEES);",
      );
    });

    it("should not report error for multi-arg MIN in WHERE (scalar function)", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE MIN(SALARY, 0) > 0;",
      );
    });
  });

  // ========================================================================
  // Functions
  // ========================================================================
  describe("Function validation", () => {
    it("should validate known aggregate functions", () => {
      expectValid(
        "SELECT SUM(SALARY), AVG(SALARY), MIN(SALARY), MAX(SALARY), COUNT(*) FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate known string functions", () => {
      expectValid(
        "SELECT UPPER(FIRST_NAME), LOWER(LAST_NAME), LENGTH(FIRST_NAME), TRIM(FIRST_NAME), SUBSTR(FIRST_NAME, 1, 3) FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate known conditional functions", () => {
      expectValid(
        "SELECT COALESCE(MANAGER_ID, 0), NVL(MANAGER_ID, 0), NULLIF(SALARY, 0), DECODE(STATUS, 'A', 1, 0) FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate known numeric functions", () => {
      expectValid(
        "SELECT ABS(-1), CEIL(1.5), FLOOR(1.5), ROUND(1.234, 2), MOD(10, 3), POWER(2, 3), SQRT(16);",
      );
    });

    it("should validate SQL extensions date part functions (YEAR/MONTH/DAY)", () => {
      expectValid(
        "SELECT YEAR(HIRE_DATE), MONTH(HIRE_DATE), DAY(HIRE_DATE) FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate SQL extensions date-time utility functions", () => {
      expectValid(
        "SELECT DAYS_BETWEEN(NOW(), NOW()), HOURS_BETWEEN(NOW(), NOW()), MINUTES_BETWEEN(NOW(), NOW()), SECONDS_BETWEEN(NOW(), NOW()), WEEKS_BETWEEN(NOW(), NOW()), NEXT_WEEK(HIRE_DATE), NEXT_MONTH(HIRE_DATE), NEXT_QUARTER(HIRE_DATE), NEXT_YEAR(HIRE_DATE), THIS_WEEK(HIRE_DATE), THIS_MONTH(HIRE_DATE), THIS_QUARTER(HIRE_DATE), THIS_YEAR(HIRE_DATE) FROM TESTDB..EMPLOYEES;",
      );
    });

    const netezzaDocumentedExtensionFunctionQueries: Array<
      [string, string]
    > = [
      ["BTRIM", "SELECT BTRIM('  hi  ');"] ,
      ["INSTR", "SELECT INSTR('Hello World', 'o');"],
      ["STRPOS", "SELECT STRPOS('Hello World', 'o');"],
      ["UNICHR", "SELECT UNICHR(65);"],
      ["UNICODE", "SELECT UNICODE('A');"],
      ["UNICODES", "SELECT UNICODES('AZ');"],
      ["OVERLAPS", "SELECT OVERLAPS(1, 2, 3, 4);"],
      ["DURATION_ADD", "SELECT DURATION_ADD(1, 2);"],
      ["DURATION_SUBTRACT", "SELECT DURATION_SUBTRACT(2, 1);"],
      ["TIMEOFDAY", "SELECT TIMEOFDAY();"],
      ["TIMEZONE", "SELECT TIMEZONE(NOW(), 'UTC', 'UTC');"],
      ["HEX_TO_BINARY", "SELECT HEX_TO_BINARY('DEADBEEF');"],
      ["HEX_TO_GEOMETRY", "SELECT HEX_TO_GEOMETRY('00');"],
      ["INT_TO_STRING", "SELECT INT_TO_STRING(42, 16);"],
      ["STRING_TO_INT", "SELECT STRING_TO_INT('2A', 16);"],
      ["ISFALSE", "SELECT ISFALSE(1 = 0);"],
      ["ISNOTFALSE", "SELECT ISNOTFALSE(1 = 1);"],
      ["ISTRUE", "SELECT ISTRUE(1 = 1);"],
      ["ISNOTTRUE", "SELECT ISNOTTRUE(1 = 0);"],
      ["VERSION", "SELECT VERSION();"],
      ["GET_VIEWDEF", "SELECT GET_VIEWDEF('EMP_VIEW');"],
      ["SETSEED", "SELECT SETSEED(0.5);"],
      ["DCEIL", "SELECT DCEIL(42.8);"],
      ["DFLOOR", "SELECT DFLOOR(42.8);"],
      ["FPOW", "SELECT FPOW(9.0, 3.0);"],
      ["NUMERIC_SQRT", "SELECT NUMERIC_SQRT(2);"],
      ["POW", "SELECT POW(9.0, 3.0);"],
      ["INT1AND", "SELECT INT1AND(3, 6);"],
      ["INT1OR", "SELECT INT1OR(3, 6);"],
      ["INT1XOR", "SELECT INT1XOR(3, 6);"],
      ["INT1NOT", "SELECT INT1NOT(3);"],
      ["INT1SHL", "SELECT INT1SHL(3, 1, 6);"],
      ["INT1SHR", "SELECT INT1SHR(3, 1, 6);"],
      ["INT2AND", "SELECT INT2AND(3, 6);"],
      ["INT2OR", "SELECT INT2OR(3, 6);"],
      ["INT2XOR", "SELECT INT2XOR(3, 6);"],
      ["INT2NOT", "SELECT INT2NOT(3);"],
      ["INT2SHL", "SELECT INT2SHL(3, 1, 6);"],
      ["INT2SHR", "SELECT INT2SHR(3, 1, 6);"],
      ["INT4AND", "SELECT INT4AND(3, 6);"],
      ["INT4OR", "SELECT INT4OR(3, 6);"],
      ["INT4XOR", "SELECT INT4XOR(3, 6);"],
      ["INT4NOT", "SELECT INT4NOT(3);"],
      ["INT4SHL", "SELECT INT4SHL(3, 1, 6);"],
      ["INT4SHR", "SELECT INT4SHR(3, 1, 6);"],
      ["INT8AND", "SELECT INT8AND(3, 6);"],
      ["INT8OR", "SELECT INT8OR(3, 6);"],
      ["INT8XOR", "SELECT INT8XOR(3, 6);"],
      ["INT8NOT", "SELECT INT8NOT(3);"],
      ["INT8SHL", "SELECT INT8SHL(3, 1, 6);"],
      ["INT8SHR", "SELECT INT8SHR(3, 1, 6);"],
    ];

    it.each(netezzaDocumentedExtensionFunctionQueries)(
      "should validate IBM-documented Netezza extension function %s",
      (_functionName, sql) => {
        expectValid(sql);
      },
    );

    it("should detect unknown function name (typo)", () => {
      expectErrorCode("SELECT SUMM(SALARY) FROM TESTDB..EMPLOYEES;", "SQL011");
    });

    it("should detect unknown function (random name)", () => {
      expectErrorCode("SELECT TOTALLY_FAKE_FUNC(1, 2, 3);", "SQL011");
    });

    it("should validate COUNT(*) specifically", () => {
      expectValid("SELECT COUNT(*) FROM TESTDB..EMPLOYEES;");
    });

    it("should validate COUNT(DISTINCT col)", () => {
      expectValid(
        "SELECT COUNT(DISTINCT DEPARTMENT_ID) FROM TESTDB..EMPLOYEES;",
      );
    });
  });

  // ========================================================================
  // Edge cases and tricky SQL
  // ========================================================================
  describe("Edge cases", () => {
    it("should validate keywords used as aliases", () => {
      expectValid("SELECT 1 AS TABLE_COL;");
    });

    it("should validate OWNER as column name and alias", () => {
      // OWNER is a keyword in Netezza but can be used as identifier
      expectValid("SELECT OWNER FROM T1;");
      expectValid("SELECT T.OWNER FROM T1 T;");
      expectValid("SELECT 1 AS OWNER;");
      expectValid("SELECT 1 AS OWNER FROM T1 OWNER;");
    });

    it("should validate START as column name and alias", () => {
      // START is a keyword in Netezza but can be used as identifier
      expectValid("SELECT START FROM T1;");
      expectValid("SELECT T.START FROM T1 T;");
      expectValid("SELECT 1 AS START;");
      expectValid("SELECT 1 AS START FROM T1 START;");
    });

    it("should validate HASH as column name and alias", () => {
      // HASH is a keyword in Netezza (for DISTRIBUTE ON HASH) but can be used as identifier
      expectValid("SELECT HASH FROM T1;");
      expectValid("SELECT T.HASH FROM T1 T;");
      expectValid("SELECT 1 AS HASH;");
      expectValid("SELECT 1 AS HASH FROM T1 HASH;");
    });

    it("should validate metadata-backed columns named HASH and SUM", () => {
      const metadataAwareValidator = new SqlValidator(
        createMockSchemaProvider([
          ...mockTableDefinitions,
          {
            database: "JUST_DATA",
            schema: "PUBLIC",
            name: "TST",
            columns: ["HASH", "SUM", "OTHER_COL"],
          },
        ]),
      );

      const result = metadataAwareValidator.validate(
        "SELECT D.HASH, D.SUM FROM JUST_DATA..TST D;",
      );

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("should propagate metadata-backed HASH columns through subqueries", () => {
      const metadataAwareValidator = new SqlValidator(
        createMockSchemaProvider([
          ...mockTableDefinitions,
          {
            database: "JUST_DATA",
            schema: "PUBLIC",
            name: "TST",
            columns: ["HASH", "SUM", "OTHER_COL"],
          },
        ]),
      );

      const result = metadataAwareValidator.validate(`SELECT SUB.HASH, SUB.SUM
FROM (
    SELECT D.HASH, D.SUM FROM JUST_DATA..TST D
) SUB;`);

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("should validate lower-case SQL", () => {
      expectValid("select employee_id from testdb..employees;");
    });

    it("should validate mixed-case SQL", () => {
      expectValid("Select Employee_Id From TESTDB..Employees;");
    });

    it("should validate negative number literal", () => {
      expectValid("SELECT -42 AS NEG;");
    });

    it("should validate scientific notation literal", () => {
      expectValid("SELECT 1.5e10 AS BIG;");
    });

    it("should validate string with escaped single quotes", () => {
      expectValid("SELECT 'it''s a test' AS TXT;");
    });

    it("should validate empty string literal", () => {
      expectValid("SELECT '' AS EMPTY;");
    });

    it("should validate type literal syntax (ABSTIME, TIMESTAMP, DATE, etc.)", () => {
      expectValid("SELECT ABSTIME 'now';");
      expectValid("SELECT TIMESTAMP '2023-01-01 12:00:00';");
      expectValid("SELECT DATE '2023-01-01';");
      expectValid("SELECT TIME '12:00:00';");
      expectValid("SELECT INTERVAL '1 day';");
      expectValid("SELECT TIMESTAMPTZ '2023-01-01 12:00:00 UTC';");
    });

    it("should validate expression with multiple parentheses levels", () => {
      expectValid("SELECT ((((1 + 2)))) AS DEEP;");
    });

    it("should validate SELECT with only line comment", () => {
      expectValid("SELECT 1 -- this is a comment\n;");
    });

    it("should validate SELECT with block comment between keywords", () => {
      expectValid("SELECT /* columns */ 1 /* end */ AS X;");
    });
  });

  // ========================================================================
  // Additional SELECT patterns
  // ========================================================================
  describe("SELECT — additional valid patterns", () => {
    it("should validate SELECT with multiple conditions using AND/OR", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE SALARY > 1000 AND DEPARTMENT_ID = 1 OR STATUS = 'ACTIVE';",
      );
    });

    it("should validate SELECT with nested AND/OR and parentheses", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE (SALARY > 1000 AND DEPARTMENT_ID = 1) OR (STATUS = 'ACTIVE');",
      );
    });

    it("should validate SELECT with BETWEEN on dates", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE HIRE_DATE BETWEEN '2020-01-01' AND '2023-12-31';",
      );
    });

    it("should validate SELECT with multiple LIKE conditions", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE FIRST_NAME LIKE 'J%' AND LAST_NAME LIKE '%son';",
      );
    });

    it("should validate SELECT with NULL literal in expression", () => {
      expectValid("SELECT NULL AS EMPTY_COL;");
    });

    it("should validate SELECT with COALESCE", () => {
      expectValid(
        "SELECT COALESCE(E.MANAGER_ID, 0) AS MGR FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate SELECT with NULLIF", () => {
      expectValid(
        "SELECT NULLIF(E.SALARY, 0) AS SAFE_SALARY FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate SELECT with NVL (Netezza function)", () => {
      expectValid(
        "SELECT NVL(E.MANAGER_ID, -1) AS MGR FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate SELECT with NVL2 (Netezza function)", () => {
      expectValid(
        "SELECT NVL2(E.MANAGER_ID, 'HAS_MANAGER', 'NO_MANAGER') AS MGR_FLAG FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate SELECT with GREATEST and LEAST", () => {
      expectValid("SELECT GREATEST(1, 2, 3) AS G, LEAST(1, 2, 3) AS L;");
    });

    it("should validate SELECT with DECODE", () => {
      expectValid(
        "SELECT DECODE(E.DEPARTMENT_ID, 1, 'HR', 2, 'IT', 'Other') AS DEPT_NAME FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate SELECT with multiple ORDER BY columns", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES ORDER BY DEPARTMENT_ID ASC, SALARY DESC, FIRST_NAME;",
      );
    });

    it("should validate SELECT with GROUP BY multiple columns", () => {
      expectValid(
        "SELECT DEPARTMENT_ID, STATUS, COUNT(*) AS CNT FROM TESTDB..EMPLOYEES GROUP BY DEPARTMENT_ID, STATUS;",
      );
    });

    it("should validate SELECT with aggregate functions SUM, AVG, MIN, MAX", () => {
      expectValid(
        "SELECT SUM(SALARY) AS TOTAL, AVG(SALARY) AS AVERAGE, MIN(SALARY) AS LOWEST, MAX(SALARY) AS HIGHEST FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate SELECT with string concatenation in SELECT list", () => {
      expectValid(
        "SELECT E.FIRST_NAME || ' ' || E.LAST_NAME AS FULL_NAME FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate SELECT with mathematical operations", () => {
      expectValid(
        "SELECT E.SALARY * 12 AS ANNUAL, E.SALARY / 160 AS HOURLY FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate SELECT with modulo operator", () => {
      expectValid(
        "SELECT E.EMPLOYEE_ID % 2 AS MOD_VAL FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate SELECT with nested function calls", () => {
      expectValid(
        "SELECT UPPER(TRIM(E.FIRST_NAME)) AS CLEAN_NAME FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate SELECT with SUBSTR function", () => {
      expectValid(
        "SELECT SUBSTR(E.FIRST_NAME, 1, 3) AS SHORT_NAME FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate SELECT with LENGTH function", () => {
      expectValid(
        "SELECT LENGTH(E.FIRST_NAME) AS NAME_LEN FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate SELECT with REPLACE function", () => {
      expectValid(
        "SELECT REPLACE(E.FIRST_NAME, 'A', 'X') AS REPLACED FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate SELECT with CAST function", () => {
      expectValid(
        "SELECT CAST(E.SALARY AS VARCHAR(20)) AS SALARY_STR FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate SELECT with multiple CAST expressions", () => {
      expectValid(
        "SELECT CAST(E.EMPLOYEE_ID AS VARCHAR(10)) || '-' || CAST(E.DEPARTMENT_ID AS VARCHAR(10)) AS COMBO FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate SELECT with NOW() function", () => {
      expectValid("SELECT NOW() AS CURRENT_TS;");
    });

    it("should validate SELECT with CURRENT_DATE, CURRENT_TIME, CURRENT_TIMESTAMP", () => {
      expectValid(
        "SELECT CURRENT_DATE AS D, CURRENT_TIME AS T, CURRENT_TIMESTAMP AS TS;",
      );
    });

    it("should validate SELECT with simple HAVING after GROUP BY", () => {
      expectValid(
        "SELECT DEPARTMENT_ID, SUM(SALARY) AS TOTAL_SALARY FROM TESTDB..EMPLOYEES GROUP BY DEPARTMENT_ID HAVING SUM(SALARY) > 50000;",
      );
    });

    it("should validate SELECT with table alias in all clauses", () => {
      expectValid(
        "SELECT E.FIRST_NAME, E.SALARY FROM TESTDB..EMPLOYEES E WHERE E.SALARY > 1000 ORDER BY E.SALARY;",
      );
    });

    it("should validate SELECT with self-join", () => {
      expectValid(
        "SELECT E1.FIRST_NAME, E2.FIRST_NAME AS MANAGER_NAME FROM TESTDB..EMPLOYEES E1 JOIN TESTDB..EMPLOYEES E2 ON E1.MANAGER_ID = E2.EMPLOYEE_ID;",
      );
    });

    it("should validate SELECT with expression in ORDER BY", () => {
      expectValid(
        "SELECT E.FIRST_NAME, E.SALARY FROM TESTDB..EMPLOYEES E ORDER BY E.SALARY * 12 DESC;",
      );
    });

    it("should validate SELECT with LIMIT 0", () => {
      expectValid("SELECT * FROM TESTDB..EMPLOYEES LIMIT 0;");
    });

    it("should validate SELECT 1 without table", () => {
      expectValid("SELECT 1;");
    });

    it("should validate SELECT with negative number", () => {
      expectValid("SELECT -1 AS NEG;");
    });

    it("should validate SELECT with boolean expressions", () => {
      expectValid("SELECT TRUE AS T, FALSE AS F;");
    });

    it("should validate SELECT with lowercase TRUE/FALSE literals and wildcard from table", () => {
      expectValid("SELECT true, false, * FROM TESTDB..EMPLOYEES;");
    });

    it("should validate SELECT with string comparison", () => {
      expectValid("SELECT * FROM TESTDB..EMPLOYEES WHERE FIRST_NAME = 'John';");
    });

    it("should validate SELECT with inequality operators", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE SALARY != 0 AND SALARY <> 0;",
      );
    });

    it("should validate SELECT with >= and <= operators", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE SALARY >= 1000 AND SALARY <= 5000;",
      );
    });

    it("should validate SELECT with complex WHERE combining multiple operators", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE SALARY > 1000 AND DEPARTMENT_ID IN (1, 2) AND FIRST_NAME LIKE 'A%' AND HIRE_DATE BETWEEN '2020-01-01' AND '2023-12-31';",
      );
    });

    it("should validate SELECT with subquery in SELECT list (scalar)", () => {
      expectValid(
        "SELECT E.FIRST_NAME, (SELECT COUNT(*) FROM TESTDB..DEPARTMENTS) AS DEPT_COUNT FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate SELECT with multiple subqueries in FROM", () => {
      expectValid(
        "SELECT A.CNT, B.TOTAL FROM (SELECT COUNT(*) AS CNT FROM TESTDB..EMPLOYEES) A, (SELECT SUM(SALARY) AS TOTAL FROM TESTDB..EMPLOYEES) B;",
      );
    });

    it("should validate SELECT with correlated subquery", () => {
      expectValid(
        "SELECT E.FIRST_NAME, E.SALARY FROM TESTDB..EMPLOYEES E WHERE E.SALARY > (SELECT AVG(E2.SALARY) FROM TESTDB..EMPLOYEES E2 WHERE E2.DEPARTMENT_ID = E.DEPARTMENT_ID);",
      );
    });
  });

  // ========================================================================
  // Error Recovery Tests
  // ========================================================================
  describe("Error Recovery — unclosed strings", () => {
    it("should detect unclosed single-quoted string", () => {
      expectSyntaxError("SELECT 'unclosed string;");
    });

    it("should detect unclosed double-quoted identifier", () => {
      expectSyntaxError('SELECT "unclosed_id FROM t;');
    });

    it("should detect unclosed string in WHERE clause", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE FIRST_NAME = 'John;",
      );
    });

    it("should detect unclosed string in INSERT VALUES", () => {
      expectSyntaxError(
        "INSERT INTO TESTDB..EMPLOYEES (FIRST_NAME) VALUES ('John);",
      );
    });
  });

  describe("Error Recovery — CASE without END", () => {
    it("should detect CASE without END in SELECT", () => {
      expectSyntaxError("SELECT CASE WHEN 1 = 1 THEN 'yes';");
    });

    it("should detect CASE with multiple WHEN but no END", () => {
      expectSyntaxError(`SELECT CASE
    WHEN SALARY > 5000 THEN 'High'
    WHEN SALARY > 3000 THEN 'Medium'
    ELSE 'Low'
FROM TESTDB..EMPLOYEES;`);
    });

    it("should detect nested CASE without inner END", () => {
      expectSyntaxError(`SELECT CASE
    WHEN 1 = 1 THEN CASE WHEN 2 = 2 THEN 'nested'
    ELSE 'outer'
END;`);
    });

  });

  describe("Error Recovery — parenthesis mismatch", () => {
    it("should detect unclosed parenthesis in function call", () => {
      expectSyntaxError("SELECT UPPER(name FROM TESTDB..EMPLOYEES;");
    });

    it("should detect extra closing parenthesis", () => {
      expectSyntaxError("SELECT UPPER(name)) FROM TESTDB..EMPLOYEES;");
    });

    it("should detect unclosed parenthesis in nested expression", () => {
      expectSyntaxError("SELECT ((a + b) * c FROM t;");
    });

    it("should detect mismatched parentheses in IN clause", () => {
      expectSyntaxError("SELECT * FROM t WHERE id IN (1, 2, 3;");
    });
  });

  describe("Error Recovery — IN () edge cases", () => {
    it("should detect empty IN clause", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE EMPLOYEE_ID IN ();",
      );
    });

    it("should detect IN with trailing comma", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE EMPLOYEE_ID IN (1, 2,);",
      );
    });

    it("should detect IN without closing parenthesis", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE EMPLOYEE_ID IN (1, 2;",
      );
    });
  });

  // ========================================================================
  // Additional SELECT error cases
  // ========================================================================
  describe("SELECT — additional syntax errors", () => {
    it("should detect missing table name after FROM", () => {
      expectSyntaxError("SELECT * FROM;");
    });

    it("should detect missing semicolon (parser should still accept)", () => {
      // Parser typically recovers or ignores missing semicolon
      const result = validator.validate("SELECT 1");
      // This should NOT produce a PAR001 error - missing semicolons are tolerated
      expect(getSyntaxErrors(result).length).toBe(0);
    });

    it("should detect missing column after SELECT keyword", () => {
      expectSyntaxError("SELECT FROM TESTDB..EMPLOYEES;");
    });

    it("should detect duplicate FROM keyword", () => {
      expectSyntaxError("SELECT * FROM FROM TESTDB..EMPLOYEES;");
    });

    it("should detect WHERE without any condition", () => {
      expectSyntaxError("SELECT * FROM TESTDB..EMPLOYEES WHERE;");
    });

    it("should detect GROUP BY without column", () => {
      expectSyntaxError("SELECT * FROM TESTDB..EMPLOYEES GROUP BY;");
    });

    it("should detect ORDER BY without expression", () => {
      expectSyntaxError("SELECT * FROM TESTDB..EMPLOYEES ORDER BY;");
    });

    it("should detect LIMIT without number", () => {
      expectSyntaxError("SELECT * FROM TESTDB..EMPLOYEES LIMIT;");
    });

    it("should detect missing alias after AS in SELECT list", () => {
      expectSyntaxError("SELECT 1 AS;");
    });

    it("should report SQL027 for JOIN without ON or USING", () => {
      const result = validator.validate(
        "SELECT * FROM TESTDB..EMPLOYEES E JOIN TESTDB..DEPARTMENTS D;",
      );
      expect(result.errors.some((e) => e.code === "SQL027")).toBe(true);
    });

    it("should report SQL027 for JOIN without ON on qualified table names", () => {
      const sql = `SELECT A.ACCOUNTCODEALTERNATEKEY, B.ID FROM JUST_DATA..DIMACCOUNT A
JOIN JUST_DATA.ADMIN.DEPARTMENT B`;
      const result = validator.validate(sql);
      expect(result.errors.some((e) => e.code === "SQL027")).toBe(true);
    });

    it("should not report SQL027 for CROSS JOIN without ON", () => {
      const result = validator.validate(
        "SELECT * FROM TESTDB..EMPLOYEES CROSS JOIN TESTDB..DEPARTMENTS;",
      );
      expect(result.errors.some((e) => e.code === "SQL027")).toBe(false);
    });

    it("should not report SQL027 for NATURAL JOIN without ON", () => {
      const result = validator.validate(
        "SELECT * FROM TESTDB..EMPLOYEES NATURAL JOIN TESTDB..DEPARTMENTS;",
      );
      expect(result.errors.some((e) => e.code === "SQL027")).toBe(false);
    });

    it("should not report SQL027 for JOIN with USING clause", () => {
      const result = validator.validate(
        "SELECT * FROM TESTDB..EMPLOYEES E JOIN TESTDB..DEPARTMENTS D USING (DEPARTMENT_ID);",
      );
      expect(result.errors.some((e) => e.code === "SQL027")).toBe(false);
    });

    it("should detect missing JOIN keyword between tables with ON", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB..EMPLOYEES E TESTDB..DEPARTMENTS D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID;",
      );
    });

    it("should detect missing joined table after JOIN keyword", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB..EMPLOYEES E JOIN ON E.DEPARTMENT_ID = 1;",
      );
    });

    it("should detect invalid join type keyword sequence", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB..EMPLOYEES E LEFT RIGHT JOIN TESTDB..DEPARTMENTS D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID;",
      );
    });

    it("should detect incomplete ON predicate in JOIN", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB..EMPLOYEES E JOIN TESTDB..DEPARTMENTS D ON E.DEPARTMENT_ID = ;",
      );
    });

    it("should detect incomplete BETWEEN expression (missing AND)", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE SALARY BETWEEN 1000;",
      );
    });

    it("should detect incomplete CASE without END", () => {
      expectSyntaxError("SELECT CASE WHEN 1 = 1 THEN 'yes';");
    });

    it("should detect extra keyword after LIMIT value", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB..EMPLOYEES LIMIT 10 WHERE SALARY > 0;",
      );
    });
  });

  // ========================================================================
  // Additional INSERT patterns
  // ========================================================================
  describe("INSERT — additional valid patterns", () => {
    it("should validate INSERT with multiple rows in VALUES", () => {
      expectValid(
        "INSERT INTO TESTDB..FILMS (CODE, TITLE) VALUES (1, 'Film A'), (2, 'Film B'), (3, 'Film C');",
      );
    });

    it("should validate INSERT with NULL values", () => {
      expectValid(
        "INSERT INTO TESTDB..FILMS (CODE, TITLE, DID) VALUES (1, 'Test', NULL);",
      );
    });

    it("should validate INSERT with expression in VALUES", () => {
      expectValid(
        "INSERT INTO TESTDB..FILMS (CODE, TITLE) VALUES (1 + 1, 'Computed');",
      );
    });

    it("should validate INSERT INTO ... SELECT with WHERE", () => {
      expectValid(
        "INSERT INTO TESTDB..FILMS (CODE, TITLE) SELECT E.EMPLOYEE_ID, E.FIRST_NAME FROM TESTDB..EMPLOYEES E WHERE E.DEPARTMENT_ID = 1;",
      );
    });

    it("should validate INSERT with all columns implied", () => {
      expectValid(
        "INSERT INTO TESTDB..FILMS VALUES (1, 'Title', 2, '2023-01-01', 'Drama', 120);",
      );
    });

    it("should validate INSERT INTO ... WITH ... SELECT after target table", () => {
      expectValid(`INSERT INTO TESTDB..FILMS
WITH ABC (SELECT 1 AS CODE, 'Test' AS TITLE)
SELECT CODE, TITLE FROM ABC;`);
    });

    it("should validate INSERT INTO with nested WITH inside CTE body", () => {
      expectValid(`INSERT INTO XXX

  WITH ABC AS
  (
    WITH DEF AS
    (
      SELECT 1 AS ID, 'John' AS Name
      UNION ALL
      SELECT 2 AS ID, 'Jane' AS Name
    )
    SELECT * FROM DEF
  )
  SELECT * FROM ABC`);
    });
  });

  // ========================================================================
  // Additional INSERT error cases
  // ========================================================================
  describe("INSERT — additional syntax errors", () => {
    it("should detect missing table name after INSERT INTO", () => {
      expectSyntaxError("INSERT INTO VALUES (1, 'test');");
    });

    it("should detect VALUES without parentheses", () => {
      expectSyntaxError("INSERT INTO TESTDB..FILMS VALUES 1, 'test';");
    });

    it("should detect missing comma between VALUES", () => {
      expectSyntaxError(
        "INSERT INTO TESTDB..FILMS (CODE, TITLE) VALUES (1 'test');",
      );
    });

    it("should detect INSERT without INTO or VALUES", () => {
      expectSyntaxError("INSERT TESTDB..FILMS;");
    });

    it("should detect extra closing paren in column list", () => {
      expectSyntaxError(
        "INSERT INTO TESTDB..FILMS (CODE, TITLE)) VALUES (1, 'test');",
      );
    });
  });

  // ========================================================================
  // Additional UPDATE patterns
  // ========================================================================
  describe("UPDATE — additional valid patterns", () => {
    it("should validate UPDATE with multiple SET assignments", () => {
      expectValid(
        "UPDATE TESTDB..EMPLOYEES SET SALARY = 5000, STATUS = 'ACTIVE', MANAGER_ID = 10 WHERE EMPLOYEE_ID = 1;",
      );
    });

    it("should validate UPDATE with expression in SET", () => {
      expectValid(
        "UPDATE TESTDB..EMPLOYEES SET SALARY = SALARY * 1.1 WHERE DEPARTMENT_ID = 1;",
      );
    });

    it("should validate UPDATE with function in SET", () => {
      expectValid(
        "UPDATE TESTDB..EMPLOYEES SET FIRST_NAME = UPPER(FIRST_NAME) WHERE EMPLOYEE_ID = 1;",
      );
    });

    it("should validate UPDATE with NULL in SET", () => {
      expectValid(
        "UPDATE TESTDB..EMPLOYEES SET MANAGER_ID = NULL WHERE EMPLOYEE_ID = 1;",
      );
    });

    it("should validate UPDATE with complex WHERE", () => {
      expectValid(
        "UPDATE TESTDB..EMPLOYEES SET SALARY = 0 WHERE DEPARTMENT_ID = 1 AND STATUS = 'INACTIVE' AND SALARY > 0;",
      );
    });
  });

  // ========================================================================
  // Additional UPDATE error cases
  // ========================================================================
  describe("UPDATE — additional syntax errors", () => {
    it("should detect missing SET keyword in UPDATE", () => {
      expectSyntaxError("UPDATE TESTDB..EMPLOYEES SALARY = 5000;");
    });

    it("should detect missing table name after UPDATE", () => {
      expectSyntaxError("UPDATE SET SALARY = 5000;");
    });

    it("should detect missing column name in SET", () => {
      expectSyntaxError("UPDATE TESTDB..EMPLOYEES SET = 5000;");
    });

    it("should detect double equals sign in SET", () => {
      expectSyntaxError("UPDATE TESTDB..EMPLOYEES SET SALARY == 5000;");
    });

    it("should detect missing WHERE value", () => {
      expectSyntaxError("UPDATE TESTDB..EMPLOYEES SET SALARY = 5000 WHERE;");
    });
  });

  // ========================================================================
  // Additional DELETE patterns
  // ========================================================================
  describe("DELETE — additional valid patterns", () => {
    it("should validate DELETE with multiple AND conditions", () => {
      expectValid(
        "DELETE FROM TESTDB..EMPLOYEES WHERE DEPARTMENT_ID = 1 AND STATUS = 'INACTIVE' AND SALARY = 0;",
      );
    });

    it("should validate DELETE with OR conditions", () => {
      expectValid(
        "DELETE FROM TESTDB..EMPLOYEES WHERE SALARY = 0 OR SALARY IS NULL;",
      );
    });

    it("should validate DELETE with BETWEEN in WHERE", () => {
      expectValid(
        "DELETE FROM TESTDB..EMPLOYEES WHERE EMPLOYEE_ID BETWEEN 100 AND 200;",
      );
    });

    it("should validate DELETE with LIKE in WHERE", () => {
      expectValid(
        "DELETE FROM TESTDB..EMPLOYEES WHERE FIRST_NAME LIKE 'TEST%';",
      );
    });
  });

  // ========================================================================
  // Additional DELETE error cases
  // ========================================================================
  describe("DELETE — additional syntax errors", () => {
    it("should detect missing FROM in DELETE", () => {
      expectSyntaxError("DELETE TESTDB..EMPLOYEES WHERE EMPLOYEE_ID = 1;");
    });

    it("should detect missing table name in DELETE FROM", () => {
      expectSyntaxError("DELETE FROM WHERE EMPLOYEE_ID = 1;");
    });

    it("should detect extra keyword after DELETE FROM table WHERE", () => {
      expectSyntaxError(
        "DELETE FROM TESTDB..EMPLOYEES WHERE WHERE EMPLOYEE_ID = 1;",
      );
    });
  });

  // ========================================================================
  // Additional CTE patterns
  // ========================================================================
  describe("CTE — additional valid patterns", () => {
    it("should validate CTE with explicit column list", () => {
      expectValid(`WITH DEPT_MAP (DEPT_ID, DEPT_NAME) AS (
    SELECT D.DEPARTMENT_ID, D.DEPARTMENT_NAME FROM TESTDB..DEPARTMENTS D
)
SELECT DM.DEPT_ID, DM.DEPT_NAME FROM DEPT_MAP DM;`);
    });

    it("should respect renamed CTE column list in outer SELECT", () => {
      expectValid(`WITH DEPT_KEYS (KEY_ID) AS (
    SELECT D.DEPARTMENT_ID FROM TESTDB..DEPARTMENTS D
)
SELECT DK.KEY_ID FROM DEPT_KEYS DK;`);
    });

    it("should validate CTE with aggregation and final ORDER BY", () => {
      expectValid(`WITH SALARY_STATS AS (
    SELECT DEPARTMENT_ID, AVG(SALARY) AS AVG_SAL FROM TESTDB..EMPLOYEES GROUP BY DEPARTMENT_ID
)
SELECT DEPARTMENT_ID, AVG_SAL FROM SALARY_STATS ORDER BY AVG_SAL DESC;`);
    });

    it("should validate CTE referencing earlier CTE", () => {
      expectValid(`WITH CTE1 AS (
    SELECT DEPARTMENT_ID FROM TESTDB..DEPARTMENTS
), CTE2 AS (
    SELECT DEPARTMENT_ID FROM CTE1
)
SELECT * FROM CTE2;`);
    });

    it("should validate CTE with LIMIT in final query", () => {
      expectValid(`WITH TOP_EARNERS AS (
    SELECT EMPLOYEE_ID, SALARY FROM TESTDB..EMPLOYEES ORDER BY SALARY DESC
)
SELECT * FROM TOP_EARNERS LIMIT 10;`);
    });
  });

  // ========================================================================
  // Additional CTE error cases
  // ========================================================================
  describe("CTE — additional syntax errors", () => {
    it("should detect missing WITH keyword (direct CTE-like)", () => {
      expectSyntaxError("CTE AS (SELECT 1) SELECT * FROM CTE;");
    });

    it("should detect missing closing paren in CTE body", () => {
      expectSyntaxError("WITH CTE AS (SELECT 1 SELECT * FROM CTE;");
    });

    it("should detect missing SELECT after CTE definitions", () => {
      expectSyntaxError("WITH CTE AS (SELECT 1);");
    });

    it("should detect double AS in CTE definition", () => {
      expectSyntaxError("WITH CTE AS AS (SELECT 1) SELECT * FROM CTE;");
    });
  });

  // ========================================================================
  // Additional DDL patterns
  // ========================================================================


  // ========================================================================
  // Window functions — additional patterns
  // ========================================================================
  describe("Window Functions — additional patterns", () => {
    it("should validate ROW_NUMBER() OVER with ORDER BY only", () => {
      expectValid(
        "SELECT ROW_NUMBER() OVER (ORDER BY E.SALARY DESC) AS RN, E.FIRST_NAME FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate SUM() as window function", () => {
      expectValid(
        "SELECT E.FIRST_NAME, E.SALARY, SUM(E.SALARY) OVER (PARTITION BY E.DEPARTMENT_ID) AS DEPT_TOTAL FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate AVG() as window function", () => {
      expectValid(
        "SELECT E.FIRST_NAME, E.SALARY, AVG(E.SALARY) OVER (PARTITION BY E.DEPARTMENT_ID) AS DEPT_AVG FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate COUNT() as window function", () => {
      expectValid(
        "SELECT E.FIRST_NAME, COUNT(*) OVER (PARTITION BY E.DEPARTMENT_ID) AS DEPT_COUNT FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate aggregate FILTER clause", () => {
      expectValid(
        "SELECT COUNT(*) FILTER (WHERE E.SALARY > 0) AS POSITIVE_SALARIES FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate FILTER clause combined with OVER", () => {
      expectValid(
        "SELECT COUNT(*) FILTER (WHERE E.SALARY > 0) OVER (PARTITION BY E.DEPARTMENT_ID) AS POSITIVE_SALARIES FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate LAG() window function", () => {
      expectValid(
        "SELECT E.FIRST_NAME, E.SALARY, LAG(E.SALARY, 1, 0) OVER (ORDER BY E.HIRE_DATE) AS PREV_SALARY FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate DENSE_RANK() window function", () => {
      expectValid(
        "SELECT E.FIRST_NAME, DENSE_RANK() OVER (ORDER BY E.SALARY DESC) AS DRANK FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate FIRST_VALUE and LAST_VALUE window functions", () => {
      expectValid(
        "SELECT E.FIRST_NAME, FIRST_VALUE(E.SALARY) OVER (PARTITION BY E.DEPARTMENT_ID ORDER BY E.SALARY) AS LOWEST FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate multiple window functions in same query", () => {
      expectValid(
        "SELECT E.FIRST_NAME, ROW_NUMBER() OVER (ORDER BY E.SALARY) AS RN, RANK() OVER (ORDER BY E.SALARY) AS RNK, DENSE_RANK() OVER (ORDER BY E.SALARY) AS DRNK FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW frame", () => {
      expectValid(
        "SELECT E.EMPLOYEE_ID, SUM(E.SALARY) OVER (ORDER BY E.EMPLOYEE_ID ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS RUN_SUM FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate ROWS BETWEEN numeric PRECEDING/FOLLOWING frame", () => {
      expectValid(
        "SELECT E.EMPLOYEE_ID, AVG(E.SALARY) OVER (ORDER BY E.EMPLOYEE_ID ROWS BETWEEN 2 PRECEDING AND 1 FOLLOWING) AS MOVING_AVG FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW frame", () => {
      expectValid(
        "SELECT E.EMPLOYEE_ID, MAX(E.SALARY) OVER (ORDER BY E.SALARY RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS RUN_MAX FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate GROUPS frame clause", () => {
      expectValid(
        "SELECT E.EMPLOYEE_ID, SUM(E.SALARY) OVER (ORDER BY E.EMPLOYEE_ID GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) AS GROUP_SUM FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate EXCLUDE CURRENT ROW frame modifier", () => {
      expectValid(
        "SELECT E.EMPLOYEE_ID, SUM(E.SALARY) OVER (ORDER BY E.EMPLOYEE_ID ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW) AS RUN_SUM FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate EXCLUDE GROUP frame modifier", () => {
      expectValid(
        "SELECT E.EMPLOYEE_ID, SUM(E.SALARY) OVER (ORDER BY E.EMPLOYEE_ID GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE GROUP) AS GROUP_SUM FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate EXCLUDE TIES frame modifier", () => {
      expectValid(
        "SELECT E.EMPLOYEE_ID, SUM(E.SALARY) OVER (ORDER BY E.SALARY RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE TIES) AS RANGE_SUM FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should detect missing frame bound value before PRECEDING", () => {
      expectSyntaxError(
        "SELECT E.EMPLOYEE_ID, SUM(E.SALARY::INT4) OVER (ORDER BY E.EMPLOYEE_ID ROWS BETWEEN PRECEDING AND CURRENT ROW) AS RUN_SUM FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should detect missing second frame bound after AND", () => {
      expectSyntaxError(
        "SELECT E.EMPLOYEE_ID, AVG(E.SALARY) OVER (ORDER BY E.EMPLOYEE_ID ROWS BETWEEN 1 PRECEDING AND ) AS MOVING_AVG FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should detect missing ORDER BY expression in OVER clause", () => {
      expectSyntaxError(
        "SELECT E.EMPLOYEE_ID, SUM(E.SALARY) OVER (ORDER BY ) AS RUN_SUM FROM TESTDB..EMPLOYEES E;",
      );
    });
  });

  // ========================================================================
  // CASE expressions — additional patterns
  // ========================================================================
  describe("CASE expressions — additional patterns", () => {
    it("should validate searched CASE with multiple WHEN", () => {
      expectValid(`SELECT
    CASE
        WHEN E.SALARY > 10000 THEN 'Executive'
        WHEN E.SALARY > 5000 THEN 'Senior'
        WHEN E.SALARY > 2000 THEN 'Mid'
        ELSE 'Junior'
    END AS LEVEL
FROM TESTDB..EMPLOYEES E;`);
    });

    it("should validate CASE without ELSE", () => {
      expectValid(`SELECT
    CASE WHEN E.SALARY > 5000 THEN 'High' END AS LEVEL
FROM TESTDB..EMPLOYEES E;`);
    });

    it("should validate CASE in WHERE clause", () => {
      expectValid(`SELECT * FROM TESTDB..EMPLOYEES E
WHERE CASE WHEN E.DEPARTMENT_ID = 1 THEN E.SALARY ELSE 0 END > 5000;`);
    });

    it("should validate CASE in ORDER BY", () => {
      expectValid(`SELECT * FROM TESTDB..EMPLOYEES E
ORDER BY CASE WHEN E.DEPARTMENT_ID = 1 THEN 0 ELSE 1 END, E.SALARY DESC;`);
    });

    it("should validate nested CASE expressions", () => {
      expectValid(`SELECT
    CASE
        WHEN E.DEPARTMENT_ID = 1 THEN
            CASE WHEN E.SALARY > 5000 THEN 'HR-High' ELSE 'HR-Low' END
        ELSE 'Other'
    END AS CATEGORY
FROM TESTDB..EMPLOYEES E;`);
    });

    it("should validate simple CASE with expressions", () => {
      expectValid(`SELECT
    CASE E.DEPARTMENT_ID
        WHEN 1 THEN 'HR'
        WHEN 2 THEN 'IT'
        WHEN 3 THEN 'Finance'
        ELSE 'Unknown'
    END AS DEPT_NAME
FROM TESTDB..EMPLOYEES E;`);
    });
  });

  // ========================================================================
  // Type casting — additional patterns
  // ========================================================================
  describe("Type casting — additional patterns", () => {
    it("should validate CAST to INT4", () => {
      expectValid("SELECT CAST('123' AS INT4) AS NUM;");
    });

    it("should validate CAST to NUMERIC with precision", () => {
      expectValid("SELECT CAST('3.14' AS NUMERIC(10,2)) AS NUM;");
    });

    it("should validate CAST to DATE", () => {
      expectValid("SELECT CAST('2023-01-01' AS DATE) AS D;");
    });

    it("should validate CAST to TIMESTAMP", () => {
      expectValid("SELECT CAST('2023-01-01 12:00:00' AS TIMESTAMP) AS TS;");
    });

    it("should validate :: operator with VARCHAR", () => {
      expectValid(
        "SELECT E.EMPLOYEE_ID::VARCHAR(10) AS ID_STR FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate :: operator with NUMERIC", () => {
      expectValid(
        "SELECT E.SALARY::NUMERIC(10,2) AS SAL FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate :: operator chained", () => {
      expectValid("SELECT '123'::INT4::VARCHAR(10) AS ROUND_TRIP;");
    });
  });

  // ========================================================================
  // EXPLAIN and utility commands — additional patterns
  // ========================================================================
  describe("Utility commands — additional patterns", () => {
    it("should validate EXPLAIN simple SELECT", () => {
      expectValid("EXPLAIN SELECT * FROM TESTDB..EMPLOYEES;");
    });

    it("should validate EXPLAIN VERBOSE SELECT", () => {
      expectValid("EXPLAIN VERBOSE SELECT * FROM TESTDB..EMPLOYEES;");
    });

    it("should validate GROOM TABLE basic", () => {
      expectValid("GROOM TABLE TESTDB..EMPLOYEES;");
    });

    it("should validate GROOM TABLE VERSIONS", () => {
      expectValid("GROOM TABLE TESTDB..EMPLOYEES VERSIONS;");
    });

    it("should validate GENERATE STATISTICS ON table", () => {
      expectValid("GENERATE STATISTICS ON TESTDB..EMPLOYEES;");
    });

    it("should validate GENERATE EXPRESS STATISTICS ON table", () => {
      expectValid("GENERATE EXPRESS STATISTICS ON TESTDB..EMPLOYEES;");
    });

    it("should validate COMMENT ON TABLE", () => {
      expectValid(
        "COMMENT ON TABLE TESTDB..EMPLOYEES IS 'Employee master table';",
      );
    });

    it("should validate COMMENT ON COLUMN", () => {
      expectValid(
        "COMMENT ON COLUMN TESTDB..EMPLOYEES.SALARY IS 'Monthly salary in USD';",
      );
    });

    it("should validate SHOW SCHEMA", () => {
      expectValid("SHOW SCHEMA;");
    });

    it("should validate SHOW SESSION", () => {
      expectValid("SHOW SESSION;");
    });

    it("should validate COPY command", () => {
      expectValid("COPY TESTDB..EMPLOYEES TO '/tmp/employees.csv';");
    });

    it("should validate LOCK TABLE command", () => {
      expectValid("LOCK TABLE TESTDB..EMPLOYEES IN EXCLUSIVE MODE;");
    });

    it("should validate MERGE command", () => {
      expectValid(
        "MERGE INTO TESTDB..EMPLOYEES E USING TESTDB..DEPARTMENTS D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID WHEN MATCHED THEN UPDATE SET STATUS = 'A';",
      );
    });

    it("should validate REINDEX DATABASE command", () => {
      expectValid("REINDEX DATABASE TESTDB;");
    });

    it("should validate RESET SESSION command", () => {
      expectValid("RESET SESSION;");
    });

    it("should validate BEGIN transaction command", () => {
      expectValid("BEGIN;");
    });
  });


  // ========================================================================
  // Edge cases and special patterns
  // ========================================================================
  describe("Edge cases and special patterns", () => {
    it("should validate empty statement (just semicolon)", () => {
      const result = validator.validate(";");
      // Empty statement may or may not be valid depending on parser
      // We just verify it doesn't crash
      expect(result).toBeDefined();
    });

    it("should validate multiple semicolons", () => {
      const result = validator.validate(";;;");
      expect(result).toBeDefined();
    });

    it("should validate SELECT with very long column list", () => {
      expectValid(
        "SELECT E.EMPLOYEE_ID, E.FIRST_NAME, E.LAST_NAME, E.DEPARTMENT_ID, E.SALARY, E.HIRE_DATE, E.MANAGER_ID, E.STATUS FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate deeply nested subqueries", () => {
      expectValid("SELECT * FROM (SELECT * FROM (SELECT 1 AS A) T1) T2;");
    });

    it("should validate SELECT with line breaks in various positions", () => {
      expectValid(`SELECT
    E.EMPLOYEE_ID,
    E.FIRST_NAME,
    E.LAST_NAME
FROM
    TESTDB..EMPLOYEES E
WHERE
    E.SALARY > 1000
ORDER BY
    E.SALARY DESC;`);
    });

    it("should validate SELECT with tab characters", () => {
      expectValid("SELECT\t1\tAS\tA;");
    });

    it("should validate SELECT with mixed case keywords", () => {
      expectValid("select * from TESTDB..EMPLOYEES where SALARY > 0;");
    });

    it("should validate SELECT with all uppercase", () => {
      expectValid("SELECT * FROM TESTDB..EMPLOYEES WHERE SALARY > 0;");
    });

    it("should validate long string literal", () => {
      const longStr = "a".repeat(500);
      expectValid(`SELECT '${longStr}' AS LONG_STR;`);
    });

    it("should validate numeric literal with decimal", () => {
      expectValid("SELECT 3.14159265358979 AS PI;");
    });

    it("should validate numeric literal with scientific notation", () => {
      expectValid("SELECT 1.5E10 AS BIG_NUM;");
    });

    it("should validate negative in expression", () => {
      expectValid(
        "SELECT E.SALARY * -1 AS NEG_SALARY FROM TESTDB..EMPLOYEES E;",
      );
    });

    it("should validate multiple statements separated by semicolons", () => {
      const result = validator.validate("SELECT 1; SELECT 2;");
      expect(result).toBeDefined();
    });

    it("should handle SQL with only whitespace", () => {
      const result = validator.validate("   \n\t  ");
      expect(result).toBeDefined();
    });

    it("should handle empty string input", () => {
      const result = validator.validate("");
      expect(result).toBeDefined();
    });

    it("should validate database..table notation", () => {
      expectValid("SELECT * FROM TESTDB..EMPLOYEES;");
    });

    it("should validate database.schema.table notation", () => {
      expectValid("SELECT * FROM TESTDB.PUBLIC.EMPLOYEES;");
    });

    it("should validate mixed comment styles in complex query", () => {
      expectValid(`-- Line comment at start
SELECT
    E.EMPLOYEE_ID, /* block comment inline */
    E.FIRST_NAME -- trailing comment
FROM TESTDB..EMPLOYEES E
/* multi-line
   block comment */
WHERE E.SALARY > 0;`);
    });
  });

  // ========================================================================
  // Semantic validation — additional patterns
  // ========================================================================
  describe("Semantic validation — additional patterns", () => {
    it("should detect column not in table", () => {
      expectErrorCode(
        "SELECT NONEXISTENT_COL FROM TESTDB..EMPLOYEES;",
        "SQL004",
      );
    });

    it("should detect table not in database", () => {
      expectErrorCode("SELECT * FROM TESTDB..NONEXISTENT_TABLE;", "SQL006");
    });

    it("should detect invalid database..table form with schema", () => {
      expectErrorCode("SELECT * FROM TESTDB.EMPLOYEES;", "SQL007");
    });

    it("should detect ambiguous column without qualifier", () => {
      expectErrorCode(
        "SELECT DEPARTMENT_ID FROM TESTDB..EMPLOYEES E JOIN TESTDB..DEPARTMENTS D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID;",
        "SQL008",
      );
    });

    it("should validate qualified column resolves ambiguity", () => {
      expectValid(
        "SELECT E.DEPARTMENT_ID FROM TESTDB..EMPLOYEES E JOIN TESTDB..DEPARTMENTS D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID;",
      );
    });

    it("should validate unqualified column in subquery when inner scope shadows outer", () => {
      expectValid(
        "SELECT 1 FROM TESTDB..EMPLOYEES E WHERE E.DEPARTMENT_ID = (SELECT MAX(DEPARTMENT_ID) FROM TESTDB..DEPARTMENTS)",
      );
    });

    it("should validate unqualified column in UNION ALL branch when branch scope isolates outer", () => {
      expectValid(
        "SELECT 1 FROM TESTDB..EMPLOYEES E1 WHERE DEPARTMENT_ID = 5 UNION ALL SELECT 1 FROM TESTDB..DEPARTMENTS D WHERE DEPARTMENT_ID = 5",
      );
    });

    it("should validate unqualified column in UNION ALL branch with same table different aliases", () => {
      expectValid(
        "SELECT 1 FROM TESTDB..EMPLOYEES E1 WHERE DEPARTMENT_ID = 5 UNION ALL SELECT 1 FROM TESTDB..EMPLOYEES E2 WHERE DEPARTMENT_ID = 5",
      );
    });

    it("should validate unqualified column in UNION ALL branch without aliases", () => {
      expectValid(
        "SELECT 1 FROM TESTDB..EMPLOYEES WHERE DEPARTMENT_ID = 5 UNION ALL SELECT 1 FROM TESTDB..EMPLOYEES WHERE DEPARTMENT_ID = 5",
      );
    });

    it("should detect non-boolean expression in WHERE", () => {
      expectErrorCode(
        "SELECT * FROM TESTDB..EMPLOYEES E WHERE E.SALARY + 1;",
        "SQL010",
      );
    });

    it("should detect unknown function name", () => {
      expectErrorCode("SELECT TOTALLY_FAKE_FUNCTION(1) AS X;", "SQL011");
    });

    it("should warn about VARCHAR without length in cast", () => {
      expectWarningCode("SELECT 1::VARCHAR;", "SQL012");
    });

    it("should detect invalid data type in CREATE TABLE", () => {
      expectErrorCode(
        "CREATE TABLE TESTDB..BAD_TYPE (ID FAKE_TYPE);",
        "SQL013",
      );
    });

    it("should detect excess type parameters", () => {
      expectErrorCode(
        "CREATE TABLE TESTDB..BAD_PARAMS (ID INT4(10,2));",
        "SQL014",
      );
    });

    it("should validate known aggregate functions", () => {
      expectValid(
        "SELECT COUNT(*) AS C, SUM(SALARY) AS S, AVG(SALARY) AS A, MIN(SALARY) AS MN, MAX(SALARY) AS MX FROM TESTDB..EMPLOYEES;",
      );
    });

    it("should validate known string functions", () => {
      expectValid(
        "SELECT UPPER('hello') AS U, LOWER('HELLO') AS L, TRIM('  hi  ') AS T, LENGTH('abc') AS LN;",
      );
    });

    it("should validate known numeric functions", () => {
      expectValid(
        "SELECT ABS(-5) AS A, CEIL(3.2) AS C, FLOOR(3.8) AS F, ROUND(3.456, 2) AS R, MOD(10, 3) AS M;",
      );
    });

    it("should validate known date functions", () => {
      expectValid("SELECT DATE_PART('year', CURRENT_DATE) AS Y, NOW() AS N;");
    });

    it("should detect non-existent column in WHERE clause", () => {
      expectErrorCode(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE FAKE_COLUMN = 1;",
        "SQL004",
      );
    });

    it("should detect non-existent column in ORDER BY", () => {
      expectErrorCode(
        "SELECT * FROM TESTDB..EMPLOYEES ORDER BY FAKE_COLUMN;",
        "SQL004",
      );
    });

    it("should detect non-existent column in GROUP BY", () => {
      expectErrorCode(
        "SELECT FAKE_COLUMN, COUNT(*) FROM TESTDB..EMPLOYEES GROUP BY FAKE_COLUMN;",
        "SQL004",
      );
    });

    it("should detect usage of original name when CTE column list renames it", () => {
      expectErrorCode(
        `WITH DEPT_KEYS (KEY_ID) AS (
    SELECT D.DEPARTMENT_ID FROM TESTDB..DEPARTMENTS D
)
SELECT DK.DEPARTMENT_ID FROM DEPT_KEYS DK;`,
        "SQL004",
      );
    });
  });

  // ========================================================================
  // Advanced grammar coverage (previous parser limitations)
  // ========================================================================
  describe("Advanced grammar coverage", () => {
    it("should validate UNION", () => {
      expectValid("SELECT 1 AS A UNION SELECT 2 AS A;");
    });

    it("should validate UNION ALL", () => {
      expectValid("SELECT 1 AS A UNION ALL SELECT 2 AS A;");
    });

    it("should validate INTERSECT", () => {
      expectValid("SELECT 1 AS A INTERSECT SELECT 1 AS A;");
    });

    it("should validate EXCEPT", () => {
      expectValid("SELECT 1 AS A EXCEPT SELECT 2 AS A;");
    });

    it("should validate MINUS", () => {
      expectValid(
        "SELECT 1 FROM SOME_TABLE1 MINUS SELECT 2 FROM SOME_TABLE2;",
      );
    });

    it("should validate chained UNION ALL", () => {
      expectValid(
        "SELECT 1 AS A UNION ALL SELECT 2 AS A UNION ALL SELECT 3 AS A;",
      );
    });

    it("should validate SELECT with NOT IN list", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES WHERE DEPARTMENT_ID NOT IN (1, 2, 3);",
      );
    });

    it("should validate SELECT with EXISTS subquery", () => {
      expectValid(
        "SELECT * FROM TESTDB..EMPLOYEES E WHERE EXISTS (SELECT 1 FROM TESTDB..DEPARTMENTS D WHERE D.DEPARTMENT_ID = E.DEPARTMENT_ID);",
      );
    });

    it("should validate DELETE with EXISTS in WHERE", () => {
      expectValid(
        "DELETE FROM TESTDB..EMPLOYEES E WHERE EXISTS (SELECT 1 FROM TESTDB..ORDERS O WHERE O.CUSTOMER_ID = E.EMPLOYEE_ID);",
      );
    });

    it("should validate CTE followed by INSERT INTO ... SELECT", () => {
      expectValid(`WITH SRC AS (SELECT 1 AS CODE, 'Test' AS TITLE)
INSERT INTO TESTDB..FILMS (CODE, TITLE) SELECT CODE, TITLE FROM SRC;`);
    });

    it("should validate CTE + CTAS + subsequent SELECT", () => {
      expectValid(`CREATE TABLE TESTDB..CTE_RESULT AS
    WITH CTE AS (SELECT 1 AS VAL)
    SELECT * FROM CTE;`);
    });

    it("should validate INSERT INTO ... SELECT with CTE", () => {
      expectValid(`WITH SRC AS (
    SELECT EMPLOYEE_ID, FIRST_NAME || ' ' || LAST_NAME AS FULL_NAME
    FROM TESTDB..EMPLOYEES
    WHERE DEPARTMENT_ID = 1
)
INSERT INTO TESTDB..FILMS (CODE, TITLE) SELECT EMPLOYEE_ID, FULL_NAME FROM SRC;`);
    });

    it("should validate quoted identifiers", () => {
      expectValid('SELECT "EMPLOYEE_ID", "FIRST_NAME" FROM TESTDB..EMPLOYEES;');
    });

    it("should validate parameter markers (?)", () => {
      expectValid("SELECT * FROM TESTDB..EMPLOYEES WHERE EMPLOYEE_ID = ?;");
    });

    it("should validate procedure with ALIAS FOR $n", () => {
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

    it("should validate START and OWNER as variable names in procedure", () => {
      expectValid(`CREATE OR REPLACE PROCEDURE TEST_PROC(INT4, VARCHAR(50), VARCHAR(50))
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
    START ALIAS FOR $1;
    OWNER ALIAS FOR $3;
BEGIN
    RETURN START;
END;
END_PROC;`);
    });

    it("should detect missing AS in CTE definition", () => {
      expectSyntaxError("WITH CTE (SELECT 1 AS VAL) SELECT * FROM CTE;");
    });

    it("should detect unmatched paren in CTAS", () => {
      expectSyntaxError("CREATE TABLE TESTDB..T AS (SELECT 1 AS COL;");
    });
  });

});

