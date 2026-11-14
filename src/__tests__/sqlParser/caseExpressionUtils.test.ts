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

  it.each([
    "SELECT CASE WHEN X=Y THEN 1 ELSE 0 END + 1 FROM table1",
    "UPDATE table1 SET C = CASE WHEN X=Y THEN 1 ELSE 0 END WHERE ID = 1",
    "SELECT CASE WHEN X=Y THEN 1 ELSE 0 END::INT FROM table1",
    "SELECT CASE WHEN X=Y THEN 1 ELSE 0 END IS NULL FROM table1",
    "SELECT CASE WHEN X=Y THEN CASE WHEN A=B THEN 1 ELSE 0 END ELSE 2 END FROM table1",
    "SELECT CASE (X) WHEN 1 THEN 1 ELSE 0 END FROM table1",
    "SELECT CASE X + 1 WHEN 2 THEN 1 ELSE 0 END FROM table1",
    "SELECT CASE WHEN X=Y THEN 1 ELSE 0 END FROM table1 WHERE EXISTS (SELECT 1)",
  ])("treats a bare END as the CASE terminator in %s", (sql) => {
    expect(hasMatchingSqlCaseEnd(sql, /\bCASE\b/i.exec(sql)!.index)).toBe(true);
  });

  it("reports a CASE expression without END", () => {
    const sql = "SELECT CASE WHEN X=Y THEN 1 ELSE 0 FROM table1";
    expect(hasMatchingSqlCaseEnd(sql, /\bCASE\b/i.exec(sql)!.index)).toBe(false);
  });

  it("does not count END IF as a CASE terminator", () => {
    const sql = "SELECT CASE WHEN X=Y THEN 1 ELSE 0 END FROM table1; END IF;";
    expect(hasMatchingSqlCaseEnd(sql, /\bCASE\b/i.exec(sql)!.index)).toBe(true);
  });
});
