import {
  indexOfStatementSemicolon,
  indexOfWhereClauseEnd,
  splitSqlStatementsWithOffsets,
} from "../src/quality/sourceScan";

function whereClauseEnd(sql: string, from = sql.indexOf("WHERE") + "WHERE".length) {
  return indexOfWhereClauseEnd(
    sql,
    from,
    indexOfStatementSemicolon(sql, sql.indexOf("WHERE")),
  );
}

describe("quality source scan", () => {
  it("finds the first clause keyword after WHERE", () => {
    const sql = "SELECT * FROM t WHERE a = 1 GROUP BY a";
    expect(whereClauseEnd(sql)).toBe(sql.indexOf("GROUP"));
  });

  it("recognizes every WHERE terminator", () => {
    for (const keyword of [
      "GROUP BY a",
      "ORDER BY a",
      "HAVING count(*) > 1",
      "LIMIT 1",
      "UNION ALL SELECT 2",
      "INTERSECT SELECT 2",
      "EXCEPT SELECT 2",
    ]) {
      const sql = `SELECT * FROM t WHERE a = 1 ${keyword}`;
      expect(whereClauseEnd(sql)).toBe(sql.indexOf(keyword));
    }
  });

  it("keeps clause keywords inside comments and literals out of the scan", () => {
    const comment = "SELECT * FROM t WHERE a = 1 /* GROUP BY */ LIMIT 2";
    expect(whereClauseEnd(comment)).toBe(comment.indexOf("LIMIT"));

    const lineComment = "SELECT * FROM t WHERE a = 1 -- GROUP BY\nLIMIT 2";
    expect(whereClauseEnd(lineComment)).toBe(lineComment.indexOf("LIMIT"));

    const literal = "SELECT * FROM t WHERE a = 'GROUP BY' ORDER BY a";
    expect(whereClauseEnd(literal)).toBe(literal.indexOf("ORDER"));
  });

  it("ignores clause keywords nested in parentheses", () => {
    const sql =
      "SELECT * FROM t WHERE a IN (SELECT b FROM u GROUP BY b) ORDER BY a";
    expect(whereClauseEnd(sql)).toBe(sql.indexOf("ORDER"));
  });

  it("stops at a closing parenthesis that leaves the WHERE depth", () => {
    const sql = "SELECT * FROM t WHERE (a = 1) AND b = 2) ORDER BY c";
    expect(whereClauseEnd(sql)).toBe(sql.indexOf(") ORDER"));
  });

  it("keeps the historical substring boundary before a keyword", () => {
    const sql = "SELECT * FROM t WHERE XGROUP BY a";
    expect(whereClauseEnd(sql)).toBe(sql.indexOf("GROUP"));
  });

  it("requires a complete keyword at the end", () => {
    const sql = "SELECT * FROM t WHERE a = 1 LIMITX 2 ORDER BY a";
    expect(whereClauseEnd(sql)).toBe(sql.indexOf("ORDER"));
  });

  it("returns the statement end when no terminator exists", () => {
    const sql = "SELECT * FROM t WHERE a = 1 AND b = 2";
    expect(whereClauseEnd(sql)).toBe(sql.length);
  });

  it("ignores semicolons in strings and comments", () => {
    const sql = "SELECT ';' FROM t -- ;\n; SELECT 2;";
    expect(indexOfStatementSemicolon(sql, 0)).toBe(sql.indexOf("; SELECT"));
  });

  it("splits statements without scanning string contents", () => {
    expect(splitSqlStatementsWithOffsets("SELECT ';' FROM t; SELECT 2;")).toEqual([
      { startOffset: 0, endOffset: 17, sql: "SELECT ';' FROM t" },
      { startOffset: 18, endOffset: 27, sql: " SELECT 2" },
    ]);
  });
});
