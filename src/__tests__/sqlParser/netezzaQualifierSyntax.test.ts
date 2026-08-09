// Don't mock chevrotain - we need the real parser for these tests
jest.unmock("chevrotain");

import { describe, it } from "@jest/globals";

import {
  expectSyntaxError,
  expectValid,
  setupSqlValidatorTests,
} from "./validator.test.shared";

/**
 * Experiment matrix: where is an alias/table qualifier path (E.COL) or a
 * wildcard (E.*) syntactically allowed in Netezza SQL?
 *
 * These tests document the parser/linter verdict (the "experiment") for each
 * position and back the completion-engine rule that qualifier completions
 * (E.|, E.*|) are only offered inside expression clauses, never right after
 * a completed FROM/JOIN target.
 */
describe("Netezza SQL - qualifier path syntax matrix (linter verdicts)", () => {
  setupSqlValidatorTests();

  describe("linter ACCEPTS qualifier paths (expression clauses)", () => {
    it("SELECT list: SELECT E.EMPLOYEE_ID FROM ... E", () => {
      expectValid("SELECT E.EMPLOYEE_ID FROM TESTDB.PUBLIC.EMPLOYEES E;");
    });

    it("SELECT list with wildcard: SELECT E.* FROM ... E", () => {
      expectValid("SELECT E.* FROM TESTDB.PUBLIC.EMPLOYEES E;");
    });

    it("table name as qualifier without alias: SELECT EMPLOYEES.EMPLOYEE_ID FROM ...", () => {
      expectValid(
        "SELECT EMPLOYEES.EMPLOYEE_ID FROM TESTDB.PUBLIC.EMPLOYEES;",
      );
    });

    it("WHERE clause: WHERE E.EMPLOYEE_ID = 1", () => {
      expectValid(
        "SELECT * FROM TESTDB.PUBLIC.EMPLOYEES E WHERE E.EMPLOYEE_ID = 1;",
      );
    });

    it("WHERE clause after AND: WHERE E.DEPARTMENT_ID = 1 AND E.SALARY > 100", () => {
      expectValid(
        "SELECT * FROM TESTDB.PUBLIC.EMPLOYEES E WHERE E.DEPARTMENT_ID = 1 AND E.SALARY > 100;",
      );
    });

    it("JOIN ON clause: ON E.DEPARTMENT_ID = D.DEPARTMENT_ID", () => {
      expectValid(
        "SELECT * FROM TESTDB.PUBLIC.EMPLOYEES E JOIN TESTDB.PUBLIC.DEPARTMENTS D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID;",
      );
    });

    it("GROUP BY clause: GROUP BY E.DEPARTMENT_ID", () => {
      expectValid(
        "SELECT * FROM TESTDB.PUBLIC.EMPLOYEES E GROUP BY E.DEPARTMENT_ID;",
      );
    });

    it("ORDER BY clause: ORDER BY E.DEPARTMENT_ID", () => {
      expectValid(
        "SELECT * FROM TESTDB.PUBLIC.EMPLOYEES E ORDER BY E.DEPARTMENT_ID;",
      );
    });

    it("HAVING clause: HAVING E.SALARY > 0", () => {
      expectValid(
        "SELECT * FROM TESTDB.PUBLIC.EMPLOYEES E HAVING E.SALARY > 0;",
      );
    });

    it("DELETE WHERE clause: DELETE FROM ... E WHERE E.EMPLOYEE_ID = 1", () => {
      expectValid(
        "DELETE FROM TESTDB.PUBLIC.EMPLOYEES E WHERE E.EMPLOYEE_ID = 1;",
      );
    });

    it("UPDATE SET clause: SET E.SALARY = E.SALARY + 1 (with WHERE)", () => {
      expectValid(
        "UPDATE TESTDB.PUBLIC.EMPLOYEES E SET E.SALARY = E.SALARY + 1 WHERE E.EMPLOYEE_ID = 1;",
      );
    });

    it("MERGE ON clause: ON E.DEPARTMENT_ID = D.DEPARTMENT_ID", () => {
      expectValid(
        "MERGE INTO TESTDB.PUBLIC.EMPLOYEES E USING TESTDB.PUBLIC.DEPARTMENTS D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID WHEN MATCHED THEN UPDATE SET E.SALARY = 1;",
      );
    });

    it("correlated subquery: WHERE EXISTS (SELECT 1 ... WHERE D.DEPARTMENT_ID = E.DEPARTMENT_ID)", () => {
      expectValid(
        "SELECT * FROM TESTDB.PUBLIC.EMPLOYEES E WHERE EXISTS (SELECT 1 FROM TESTDB.PUBLIC.DEPARTMENTS D WHERE D.DEPARTMENT_ID = E.DEPARTMENT_ID);",
      );
    });

    it("comma-separated FROM list: FROM ... E, TESTDB.PUBLIC.DEPARTMENTS D", () => {
      expectValid(
        "SELECT * FROM TESTDB.PUBLIC.EMPLOYEES E, TESTDB.PUBLIC.DEPARTMENTS D;",
      );
    });
  });

  describe("linter REJECTS qualifier paths after completed FROM/JOIN target", () => {
    it("right after the alias: FROM ... E E.EMPLOYEE_ID", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB.PUBLIC.EMPLOYEES E E.EMPLOYEE_ID;",
      );
    });

    it("right after the table name: FROM ... EMPLOYEES E.EMPLOYEE_ID", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB.PUBLIC.EMPLOYEES E.EMPLOYEE_ID;",
      );
    });

    it("after LIMIT: LIMIT E.EMPLOYEE_ID", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB.PUBLIC.EMPLOYEES E LIMIT E.EMPLOYEE_ID;",
      );
    });

    it("in INSERT column list: INSERT INTO ... (E.EMPLOYEE_ID)", () => {
      expectSyntaxError(
        "INSERT INTO TESTDB.PUBLIC.EMPLOYEES (E.EMPLOYEE_ID) VALUES (1);",
      );
    });

    it("after UNION: UNION E.EMPLOYEE_ID", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB.PUBLIC.EMPLOYEES E UNION E.EMPLOYEE_ID;",
      );
    });

    it("GROUP without BY: GROUP E.DEPARTMENT_ID", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB.PUBLIC.EMPLOYEES E GROUP E.DEPARTMENT_ID;",
      );
    });

    it("wildcard right after the alias: FROM ... E E.*", () => {
      expectSyntaxError("SELECT * FROM TESTDB.PUBLIC.EMPLOYEES E E.*;");
    });

    it("wildcard in WHERE expression: WHERE E.* = 1", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB.PUBLIC.EMPLOYEES E WHERE E.* = 1;",
      );
    });

    it("ON clause without JOIN: FROM ... E ON E.EMPLOYEE_ID = 1", () => {
      expectSyntaxError(
        "SELECT * FROM TESTDB.PUBLIC.EMPLOYEES E ON E.EMPLOYEE_ID = 1;",
      );
    });
  });
});
