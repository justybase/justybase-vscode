import {
  ruleNZ002,
  ruleNZ003,
  ruleNZ006,
  ruleNZ009,
  ruleNZ015,
  ruleNZ017,
  ruleNZ019,
  ruleNZ021,
  ruleNZ022,
} from "../../providers/linterRules";
import { isInsideStringOrComment } from "../../providers/sqlCommentScanUtils";
import { SqlQualityEngine } from "../../providers/sqlQualityEngine";
import { SqlValidator } from "../../sqlParser";
import { getUnifiedSqlQualityRules } from "../../providers/sqlQualityEngine";

describe("linterRules comment regression", () => {
  describe("isInsideStringOrComment", () => {
    it("treats escaped single quotes as string content", () => {
      const sql = "SELECT 'O''Brien' FROM t";
      const quoteIndex = sql.indexOf("O");
      expect(isInsideStringOrComment(sql, quoteIndex)).toBe(true);
    });

    it("treats keywords in line comments as comments", () => {
      const sql = "SELECT 1  --case\nFROM t";
      const caseIndex = sql.indexOf("case");
      expect(isInsideStringOrComment(sql, caseIndex)).toBe(true);
    });

    it("treats keywords in block comments as comments", () => {
      const sql = "SELECT 1 /* WHERE backup */ FROM t";
      const whereIndex = sql.indexOf("WHERE");
      expect(isInsideStringOrComment(sql, whereIndex)).toBe(true);
    });
  });

  describe("NZ019", () => {
    it("ignores CASE keyword inside line comments", () => {
      const sql = `SELECT 1  --case
FROM DIMACCOUNT`;
      expect(ruleNZ019.check(sql)).toHaveLength(0);
    });

    it("still flags real CASE without END", () => {
      const sql = "SELECT CASE WHEN x = 1 THEN 1 FROM t";
      expect(ruleNZ019.check(sql)).toHaveLength(1);
    });
  });

  describe("NZ002 / NZ003 follow-up keyword scans", () => {
    it("NZ002 ignores WHERE mentioned only in comments", () => {
      const sql = "DELETE FROM t -- WHERE backup";
      expect(ruleNZ002.check(sql)).toHaveLength(1);
    });

    it("NZ002 accepts real WHERE clause", () => {
      const sql = "DELETE FROM t WHERE id = 1";
      expect(ruleNZ002.check(sql)).toHaveLength(0);
    });

    it("NZ003 ignores WHERE mentioned only in comments", () => {
      const sql = "UPDATE t SET x = 1 -- WHERE backup";
      expect(ruleNZ003.check(sql)).toHaveLength(1);
    });
  });

  describe("NZ006", () => {
    it("ignores LIMIT mentioned only in comments after ORDER BY", () => {
      const sql = "SELECT * FROM t ORDER BY id -- LIMIT 10";
      expect(ruleNZ006.check(sql)).toHaveLength(1);
    });

    it("accepts real LIMIT after ORDER BY", () => {
      const sql = "SELECT * FROM t ORDER BY id LIMIT 10";
      expect(ruleNZ006.check(sql)).toHaveLength(0);
    });
  });

  describe("NZ009", () => {
    it("ignores OR tokens that appear only in comments inside WHERE", () => {
      const sql = "SELECT * FROM t WHERE id = 1 -- OR id = 2";
      expect(ruleNZ009.check(sql)).toHaveLength(0);
    });

    it("still flags multiple real OR conditions", () => {
      const sql = "SELECT * FROM t WHERE id = 1 OR id = 2 OR id = 3";
      expect(ruleNZ009.check(sql)).toHaveLength(1);
    });
  });

  describe("NZ015", () => {
    it("ignores functions mentioned only in comments inside WHERE", () => {
      const sql = "SELECT * FROM t WHERE id = 1 /* NVL(x) */";
      expect(ruleNZ015.check(sql)).toHaveLength(0);
    });

    it("still flags real functions in WHERE", () => {
      const sql = "SELECT * FROM t WHERE NVL(id, 0) = 1";
      expect(ruleNZ015.check(sql)).toHaveLength(1);
    });
  });

  describe("NZ017", () => {
    it("ignores double quotes inside single-quoted strings", () => {
      const sql = "SELECT 'say \"hello\"' FROM t";
      expect(ruleNZ017.check(sql)).toHaveLength(0);
    });

    it("flags real double-quoted identifiers", () => {
      const sql = 'SELECT "MixedCase" FROM t';
      expect(ruleNZ017.check(sql)).toHaveLength(1);
    });
  });

  describe("NZ022", () => {
    it("ignores FROM mentioned only in comments before WHERE", () => {
      const sql = `SELECT 1
-- FROM fake
WHERE 1 = 1`;
      expect(ruleNZ022.check(sql)).toHaveLength(1);
    });

    it("does not flag SELECT with real FROM and WHERE", () => {
      const sql = `SELECT 1  --case
FROM DIMACCOUNT`;
      expect(ruleNZ022.check(sql)).toHaveLength(0);
    });

    it("respects semicolons inside string literals when splitting statements", () => {
      const sql = "SELECT 'a;b' WHERE 1=1; SELECT 2 WHERE 2=2";
      expect(ruleNZ022.check(sql)).toHaveLength(2);
    });

    it("does not flag nested SELECT inside DELETE subqueries", () => {
      const sql =
        "DELETE FROM t WHERE id IN (SELECT 1 WHERE 1 = 1)";
      expect(ruleNZ022.check(sql)).toHaveLength(0);
    });
  });

  describe("parser-owned quality rule deduplication", () => {
    const validator = new SqlValidator();
    const engine = new SqlQualityEngine(validator, getUnifiedSqlQualityRules());

    it("does not emit NZ021 from active quality rules", () => {
      const sql = "SELECT 1,,2;";
      const qualityOnly = engine.analyzeQualityRulesOnly(sql);
      expect(qualityOnly.issues.some((issue) => issue.ruleId === "NZ021")).toBe(
        false,
      );
    });

    it("ruleNZ021 still exists for direct unit tests", () => {
      expect(ruleNZ021.check("SELECT 1,,2")).toHaveLength(1);
    });
  });
});
