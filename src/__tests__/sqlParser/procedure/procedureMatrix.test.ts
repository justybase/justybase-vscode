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

describe("NZPLSQL procedure matrix (SQL038 regression)", () => {
  setupSqlValidatorTests();

  const MATRIX_PROC = "ADMIN.MATRIX_PROC";
  const MATRIX_TABLE = "JUST_DATA.ADMIN.DIMDATE";

  // Live-verified on Netezza 11.2.2.1: RETURNS without RETURN is legal
  // (CREATE ok, CALL ok, result NULL). These cases must not emit SQL038.
  for (const id of ["hdr_minimal_int4", "hdr_no_return_raise_only"]) {
    it(`${id} emits no SQL038`, () => {
      const testCase = PROCEDURE_MATRIX_CASES.find((entry) => entry.id === id);
      expect(testCase).toBeDefined();
      const sql = renderProcedureMatrixSql(
        testCase!.sql,
        MATRIX_PROC,
        MATRIX_TABLE,
      );
      const result = validator.validate(sql);
      expect(getSyntaxErrors(result)).toHaveLength(0);
      expect(
        [...result.errors, ...result.warnings].some((e) => e.code === "SQL038"),
      ).toBe(false);
    });
  }
});
