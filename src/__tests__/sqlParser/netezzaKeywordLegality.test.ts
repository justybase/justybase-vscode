// Don't mock chevrotain - we need the real parser for these tests
jest.unmock("chevrotain");

import { describe, it } from "@jest/globals";

import {
  expectSyntaxError,
  expectValid,
  setupSqlValidatorTests,
} from "./validator.test.shared";

/**
 * Experiment matrix: which FROM-continuation / WHERE keywords are
 * syntactically legal right after a completed table reference or after a
 * complete WHERE predicate in Netezza SQL?
 *
 * Backs the from-clause keyword map in completionExpressionAnalyzer.ts and
 * documents the verdicts for the proposal lists of both completion engines
 * (this extension vs. the JustyBase.NetezzaSql engine).
 *
 * Live-database verdicts (see
 * netezzaCompletionKeywordLegality.live.integration.test.ts) override the
 * parser in three cases:
 *   - standalone OUTER JOIN: parser accepts, live NPS rejects  -> not suggested
 *   - FETCH FIRST:           parser accepts, live NPS rejects  -> not suggested
 *   - OFFSET without LIMIT:  parser rejects (PAR001), live NPS accepts
 *                           -> still suggested
 */
describe("Netezza SQL - completion keyword legality matrix", () => {
  setupSqlValidatorTests();

  const E = "SELECT * FROM TESTDB.PUBLIC.EMPLOYEES E";

  describe("FROM-continuation keywords (after completed table reference)", () => {
    it("JOIN", () => {
      expectValid(`${E} JOIN TESTDB.PUBLIC.DEPARTMENTS D ON 1=1;`);
    });

    it("INNER", () => {
      expectValid(`${E} INNER JOIN TESTDB.PUBLIC.DEPARTMENTS D ON 1=1;`);
    });

    it("LEFT / LEFT OUTER", () => {
      expectValid(`${E} LEFT JOIN TESTDB.PUBLIC.DEPARTMENTS D ON 1=1;`);
      expectValid(`${E} LEFT OUTER JOIN TESTDB.PUBLIC.DEPARTMENTS D ON 1=1;`);
    });

    it("RIGHT", () => {
      expectValid(`${E} RIGHT JOIN TESTDB.PUBLIC.DEPARTMENTS D ON 1=1;`);
    });

    it("FULL / FULL OUTER", () => {
      expectValid(`${E} FULL JOIN TESTDB.PUBLIC.DEPARTMENTS D ON 1=1;`);
      expectValid(`${E} FULL OUTER JOIN TESTDB.PUBLIC.DEPARTMENTS D ON 1=1;`);
    });

    it("OUTER (standalone)", () => {
      expectValid(`${E} OUTER JOIN TESTDB.PUBLIC.DEPARTMENTS D ON 1=1;`);
    });

    it("CROSS", () => {
      expectValid(`${E} CROSS JOIN TESTDB.PUBLIC.DEPARTMENTS D;`);
    });

    it("NATURAL", () => {
      expectValid(`${E} NATURAL JOIN TESTDB.PUBLIC.DEPARTMENTS D;`);
    });

    it("WHERE", () => {
      expectValid(`${E} WHERE 1=1;`);
    });

    it("GROUP BY", () => {
      expectValid(`${E} GROUP BY E.EMPLOYEE_ID;`);
    });

    it("ORDER BY", () => {
      expectValid(`${E} ORDER BY E.EMPLOYEE_ID;`);
    });

    it("HAVING without GROUP BY", () => {
      expectValid(`${E} HAVING E.SALARY > 0;`);
    });

    it("LIMIT", () => {
      expectValid(`${E} LIMIT 10;`);
    });

    it("FETCH FIRST n ROWS ONLY", () => {
      expectValid(`${E} FETCH FIRST 1 ROWS ONLY;`);
    });

    it("UNION", () => {
      expectValid(`${E} UNION SELECT 1 FROM TESTDB.PUBLIC.DEPARTMENTS;`);
    });

    it("INTERSECT", () => {
      expectValid(`${E} INTERSECT SELECT 1 FROM TESTDB.PUBLIC.DEPARTMENTS;`);
    });

    it("EXCEPT", () => {
      expectValid(`${E} EXCEPT SELECT 1 FROM TESTDB.PUBLIC.DEPARTMENTS;`);
    });

    it("OFFSET is ILLEGAL without a preceding LIMIT", () => {
      expectSyntaxError(`${E} OFFSET 5;`);
      expectSyntaxError(`${E} ORDER BY E.EMPLOYEE_ID OFFSET 5;`);
      expectValid(`${E} LIMIT 10 OFFSET 5;`);
    });
  });

  describe("WHERE keywords at predicate start vs. after a complete predicate", () => {
    it("IN at predicate start", () => {
      expectValid(`${E} WHERE E.DEPARTMENT_ID IN (1,2);`);
    });

    it("BETWEEN at predicate start", () => {
      expectValid(`${E} WHERE E.DEPARTMENT_ID BETWEEN 1 AND 2;`);
    });

    it("AND continuation after a complete predicate", () => {
      expectValid(`${E} WHERE E.DEPARTMENT_ID = 1 AND E.SALARY > 0;`);
    });

    it("OR continuation after a complete predicate", () => {
      expectValid(`${E} WHERE E.DEPARTMENT_ID = 1 OR E.SALARY > 0;`);
    });

    it("IN is ILLEGAL after a complete predicate", () => {
      expectSyntaxError(`${E} WHERE E.DEPARTMENT_ID = 1 IN (2);`);
    });

    it("BETWEEN is ILLEGAL after a complete predicate", () => {
      expectSyntaxError(`${E} WHERE E.DEPARTMENT_ID = 1 BETWEEN 1 AND 2;`);
    });

    it("NOT is ILLEGAL after a complete predicate", () => {
      expectSyntaxError(`${E} WHERE E.DEPARTMENT_ID = 1 NOT E.SALARY > 0;`);
    });
  });
});
