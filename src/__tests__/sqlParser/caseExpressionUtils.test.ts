import {
  findPatternMatches,
  ruleNZ019,
} from "../../providers/linterRules";
import { hasMatchingSqlCaseEnd } from "../../sqlParser/caseExpressionUtils";

describe("caseExpressionUtils", () => {
  it("recognizes END before FROM", () => {
    const sql = "SELECT CASE WHEN X=Y THEN 1 END FROM table1";
    const caseStart = findPatternMatches(sql, /\bCASE\b/gi)[0];
    expect(hasMatchingSqlCaseEnd(sql, caseStart.index)).toBe(true);
  });

  it("handles multiple CASE expressions in select list", () => {
    const sql =
      "SELECT CASE WHEN X=Y THEN 1 END, CASE WHEN A=B THEN 2 END FROM table1";
    const caseStarts = findPatternMatches(sql, /\bCASE\b/gi);
    expect(caseStarts).toHaveLength(2);
    expect(hasMatchingSqlCaseEnd(sql, caseStarts[0].index)).toBe(true);
    expect(hasMatchingSqlCaseEnd(sql, caseStarts[1].index)).toBe(true);
    expect(ruleNZ019.check(sql)).toHaveLength(0);
  });
});
