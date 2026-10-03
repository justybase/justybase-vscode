import { describe, expect, it, jest } from "@jest/globals";

jest.unmock("chevrotain");

import {
  getSyntaxErrors,
  setupSqlValidatorTests,
  validator,
} from "../validator.test.shared";
import {
  PROCEDURE_MATRIX_CASES,
  renderProcedureMatrixSql,
} from "./procedureMatrixCases";

/**
 * Deterministic counterpart of the live NZPLSQL matrix. Each case is executed
 * against the real Chevrotain parser/validator; the live suite verifies the
 * same SQL against a running Netezza instance.
 *
 * `parse: 'accept'` cases must produce no syntax errors. `parse: 'reject'`
 * cases must produce at least one PAR/LEX syntax error.
 */
describe("NZPLSQL procedure matrix (parser)", () => {
  setupSqlValidatorTests();

  const MATRIX_PROC = "ADMIN.MATRIX_PROC";
  const MATRIX_TABLE = "JUST_DATA.ADMIN.DIMDATE";

  for (const testCase of PROCEDURE_MATRIX_CASES) {
    it(`${testCase.group}/${testCase.id} should ${testCase.parse}`, () => {
      const sql = renderProcedureMatrixSql(
        testCase.sql,
        MATRIX_PROC,
        MATRIX_TABLE,
      );
      const result = validator.validate(sql);
      const syntaxErrors = getSyntaxErrors(result);
      if (testCase.parse === "accept") {
        expect(syntaxErrors).toHaveLength(0);
      } else {
        expect(syntaxErrors.length).toBeGreaterThan(0);
      }
    });
  }
});
