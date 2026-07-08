jest.unmock("chevrotain");

import {
  beginProcedureRuleEvaluation,
  endProcedureRuleEvaluation,
  isProcedureSql,
  shouldUseProcedureRegexFallback,
  warmProcedureParseGate,
} from "../../../sqlParser/procedure/procedureParseGate";
import { shouldSkipCstMigratedProcedureRule } from "../../../sqlParser/procedure/procedureAnalysis";
import { ruleNZP011 } from "../../../providers/procedureRules";

function buildProcedure(body: string): string {
  return `CREATE OR REPLACE PROCEDURE test_proc()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
${body}
END_PROC;`;
}

describe("procedureParseGate", () => {
  afterEach(() => {
    endProcedureRuleEvaluation();
  });

  describe("isProcedureSql", () => {
    it("detects CREATE PROCEDURE scripts", () => {
      expect(isProcedureSql(buildProcedure("BEGIN\nRETURN 1;\nEND;"))).toBe(true);
    });

    it("returns false for plain SQL", () => {
      expect(isProcedureSql("SELECT 1;")).toBe(false);
    });
  });

  describe("shouldUseProcedureRegexFallback", () => {
    it("returns true for non-procedure SQL", () => {
      expect(shouldUseProcedureRegexFallback("SELECT 1;")).toBe(true);
    });

    it("returns false when procedure parses without actionable errors", () => {
      const sql = buildProcedure(`BEGIN
RETURN 1;
END;`);
      expect(shouldUseProcedureRegexFallback(sql)).toBe(false);
    });

    it("returns true when procedure has actionable parse errors", () => {
      const sql = `${buildProcedure(`BEGIN
RETURN 1;
END;`)}
@@@`;
      expect(shouldUseProcedureRegexFallback(sql)).toBe(true);
    });

    it("caches parse result within a rule-evaluation pass", () => {
      const sql = buildProcedure(`BEGIN
RETURN 1;
END;`);

      beginProcedureRuleEvaluation();
      warmProcedureParseGate(sql);

      const parseSpy = jest.spyOn(
        require("../../../sqlParser/parsingRuntime"),
        "parseSqlStatements",
      );

      expect(shouldUseProcedureRegexFallback(sql)).toBe(false);
      expect(shouldUseProcedureRegexFallback(sql)).toBe(false);
      expect(parseSpy).not.toHaveBeenCalled();

      parseSpy.mockRestore();
    });

    it("clears cache between evaluation passes", () => {
      const sql = buildProcedure(`BEGIN
RETURN 1;
END;`);

      beginProcedureRuleEvaluation();
      warmProcedureParseGate(sql);
      endProcedureRuleEvaluation();

      const parseSpy = jest.spyOn(
        require("../../../sqlParser/parsingRuntime"),
        "parseSqlStatements",
      );

      beginProcedureRuleEvaluation();
      expect(shouldUseProcedureRegexFallback(sql)).toBe(false);
      expect(parseSpy).toHaveBeenCalledTimes(1);

      parseSpy.mockRestore();
      endProcedureRuleEvaluation();
    });
  });

  describe("CST migration gate for NZP011", () => {
    it("skips NZP011 regex when CST parse succeeds", () => {
      const sql = buildProcedure(`BEGIN
SELECT 1;
RETURN 1;
END;`);

      beginProcedureRuleEvaluation();
      warmProcedureParseGate(sql);

      expect(shouldUseProcedureRegexFallback(sql)).toBe(false);
      expect(shouldSkipCstMigratedProcedureRule(sql, "NZP011")).toBe(true);
      expect(ruleNZP011.check(sql)).toHaveLength(0);
    });

    it("runs NZP011 regex when CST parse fails", () => {
      const sql = `${buildProcedure(`BEGIN
SELECT 1;
RETURN 1;
END;`)}
@@@`;

      beginProcedureRuleEvaluation();
      warmProcedureParseGate(sql);

      expect(shouldUseProcedureRegexFallback(sql)).toBe(true);
      expect(shouldSkipCstMigratedProcedureRule(sql, "NZP011")).toBe(false);
      expect(ruleNZP011.check(sql).some((issue) => issue.ruleId === "NZP011")).toBe(
        true,
      );
    });
  });
});
