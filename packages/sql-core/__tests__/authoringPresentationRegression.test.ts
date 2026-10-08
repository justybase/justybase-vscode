jest.unmock('chevrotain');
import { formatNetezzaSql } from "../src/format";
import { createNetezzaQualityEngine } from "../src/quality";

describe("authoring presentation regressions", () => {
  test.each(["SELECT 1", "select 1", "SELECT 1;"])("keeps atomic projection compact: %s", sql => {
    expect(formatNetezzaSql(sql)).toBe(sql.toUpperCase());
  });
  test("preserves literal and quoted identifier case", () => {
    expect(formatNetezzaSql("select 'MiXeD'", { keywordCase: "lower" })).toBe("select 'MiXeD'");
    expect(formatNetezzaSql('select "MiXeD"')).toBe('SELECT "MiXeD"');
    expect(formatNetezzaSql("select 1", { keywordCase: "preserve" })).toBe("select 1");
  });
  test("keeps comments and multi-item layout", () => {
    expect(formatNetezzaSql("SELECT 1, 2")).toContain("\n");
    expect(formatNetezzaSql("SELECT -- note\n1")).toContain("-- note");
  });
  test("reports an actionable ELSEIF in an incomplete procedural fragment", () => {
    const sql = "-- 😀 zażółć\r\nIF x THEN ELSE ELSEIF y THEN END IF;";
    const issues = createNetezzaQualityEngine().analyze(sql).issues.filter(item => item.ruleId === "NZP012");
    expect(issues).toHaveLength(1);
    expect(sql.slice(issues[0].startOffset, issues[0].endOffset)).toBe("ELSEIF");
  });
  test.each(["SELECT 'ELSEIF'", 'SELECT "ELSEIF"', "-- ELSEIF\nSELECT 1"])("does not diagnose quoted/comment text: %s", sql => {
    expect(createNetezzaQualityEngine().analyze(sql).issues.some(item => item.ruleId === "NZP012")).toBe(false);
  });
});
