jest.unmock("chevrotain");

import { detectGroupByGhost } from "../../server/groupByGhost";

describe("GROUP BY ghost text", () => {
  it("offers the non-aggregated SELECT expressions in SELECT order", () => {
    expect(detectGroupByGhost(
      "SELECT p.COLOR, d.CALENDARYEAR AS Y, SUM(f.SALESAMOUNT) AS S\nFROM F f JOIN P p ON 1 = 1\nGROUP BY ",
      "",
    )).toBe("p.COLOR, d.CALENDARYEAR");
  });

  it("uses the SELECT at the cursor's level in sub-queries and CTEs", () => {
    expect(detectGroupByGhost("SELECT * FROM (SELECT a, SUM(b) FROM t GROUP BY ", ")")).toBe("a");
    expect(detectGroupByGhost("SELECT * FROM (SELECT a, SUM(b) FROM t GROUP BY ", ") q")).toBeUndefined();
    expect(detectGroupByGhost("WITH c AS (SELECT x, y FROM t) SELECT c.X, MAX(c.Y) FROM c GROUP BY ", ""))
      .toBe("c.X");
    // A scalar sub-query with its own aggregate is not grouped.
    expect(detectGroupByGhost("SELECT k, (SELECT MAX(z) FROM u) AS m, COUNT(*) FROM t GROUP BY ", ""))
      .toBe("k");
  });

  it("stays silent without an aggregate, before a space, or before text on the line", () => {
    expect(detectGroupByGhost("SELECT a, b FROM t GROUP BY ", "")).toBeUndefined();
    expect(detectGroupByGhost("SELECT a, SUM(b) FROM t GROUP BY", "")).toBeUndefined();
    expect(detectGroupByGhost("SELECT a, SUM(b) FROM t GROUP BY ", "a")).toBeUndefined();
    expect(detectGroupByGhost("SELECT a, SUM(b) FROM t ORDER BY ", "")).toBeUndefined();
    expect(detectGroupByGhost("SELECT a, SUM(b) FROM t GROUP BY a;\nSELECT x FROM u GROUP BY ", "")).toBeUndefined();
  });
});
