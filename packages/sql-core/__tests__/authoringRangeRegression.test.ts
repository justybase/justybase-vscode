jest.unmock("chevrotain");
import { createNetezzaQualityEngine } from "../src/quality";

describe("editor UTF-16 ranges", () => {
  test.each(["SELECT 1::VARCHAR", "SELECT '😀', 1::VARCHAR", "CREATE TABLE t (name VARCHAR)"])("covers the entire character type in %s", sql => {
    const issue = createNetezzaQualityEngine().analyze(sql).issues.find(issue => issue.ruleId === "SQL012");
    expect(issue).toBeDefined();
    expect(issue!.startOffset).toBe(sql.indexOf("VARCHAR"));
    expect(issue!.endOffset).toBe(sql.indexOf("VARCHAR") + 7);
    expect(sql.slice(issue!.startOffset, issue!.endOffset)).toBe("VARCHAR");
  });
});
