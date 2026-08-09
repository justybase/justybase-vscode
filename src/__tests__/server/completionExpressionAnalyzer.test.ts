jest.unmock("chevrotain");

import {
  buildContextualKeywordItems,
  resolveExpressionClauseContext,
} from "../../server/completionExpressionAnalyzer";
import { Position } from "vscode-languageserver/node";

describe("resolveExpressionClauseContext", () => {
  it("returns from clause after FROM with completed target and alias", () => {
    expect(
      resolveExpressionClauseContext(
        "SELECT * FROM JUST_DATA..DIMACCOUNT A ",
      ),
    ).toBe("from");
  });

  it("returns from clause after FROM with completed target without alias", () => {
    expect(
      resolveExpressionClauseContext("SELECT * FROM JUST_DATA..DIMACCOUNT "),
    ).toBe("from");
  });

  it("returns from clause when JOIN is the last clause token", () => {
    expect(
      resolveExpressionClauseContext(
        "SELECT * FROM JUST_DATA..DIMACCOUNT A JOIN JUST_DATA..DIMEMPLOYEE ",
      ),
    ).toBe("from");
  });

  it("returns group clause for bare GROUP token", () => {
    expect(
      resolveExpressionClauseContext("SELECT * FROM T GROUP "),
    ).toBe("group");
  });

  it("returns group clause for combined GROUP BY token", () => {
    expect(
      resolveExpressionClauseContext("SELECT * FROM T GROUP BY "),
    ).toBe("group");
  });

  it("returns order clause for combined ORDER BY token", () => {
    expect(
      resolveExpressionClauseContext("SELECT * FROM T ORDER BY "),
    ).toBe("order");
  });

  it("returns values clause inside VALUES parentheses", () => {
    expect(
      resolveExpressionClauseContext("INSERT INTO T VALUES ("),
    ).toBe("values");
  });

  it("returns union clause after UNION", () => {
    expect(
      resolveExpressionClauseContext("SELECT * FROM T A UNION "),
    ).toBe("union");
  });

  it("returns union clause after INTERSECT", () => {
    expect(
      resolveExpressionClauseContext("SELECT * FROM T A INTERSECT "),
    ).toBe("union");
  });

  it("returns union clause after EXCEPT", () => {
    expect(
      resolveExpressionClauseContext("SELECT * FROM T A EXCEPT "),
    ).toBe("union");
  });

  it("returns where clause for WHERE expression context", () => {
    expect(
      resolveExpressionClauseContext("SELECT * FROM T WHERE X = 1 AND "),
    ).toBe("where");
  });

  it("returns on clause for JOIN ON context", () => {
    expect(
      resolveExpressionClauseContext("SELECT * FROM T1 JOIN T2 ON "),
    ).toBe("on");
  });

  it("returns undefined for DDL targets without clause context", () => {
    expect(resolveExpressionClauseContext("CREATE TABLE ")).toBeUndefined();
    expect(resolveExpressionClauseContext("DROP ")).toBeUndefined();
  });
});

describe("buildContextualKeywordItems", () => {
  const keywords = [
    "SELECT",
    "FROM",
    "WHERE",
    "JOIN",
    "INNER",
    "LEFT",
    "RIGHT",
    "FULL",
    "CROSS",
    "AS",
    "GROUP",
    "ORDER",
    "ALL",
  ];

  it("suggests join/where keywords in from clause context", () => {
    const items = buildContextualKeywordItems(
      "SELECT * FROM T A ",
      "",
      Position.create(0, 0),
      keywords,
    );
    expect(items.map((item) => item.label)).toEqual(
      expect.arrayContaining(["JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "WHERE", "GROUP", "ORDER"]),
    );
  });

  it("filters keywords by typed prefix in from clause context", () => {
    const items = buildContextualKeywordItems(
      "SELECT * FROM T A ",
      "L",
      Position.create(0, 0),
      keywords,
    );
    expect(items.map((item) => item.label)).toEqual(["LEFT"]);
  });

  it("keeps AS available after a FROM target", () => {
    const items = buildContextualKeywordItems(
      "SELECT * FROM T A",
      "A",
      Position.create(0, 0),
      keywords,
    );
    expect(items.map((item) => item.label)).toEqual(["AS"]);
  });

  it("keeps ALL available after UNION", () => {
    const items = buildContextualKeywordItems(
      "SELECT * FROM T UNION ",
      "A",
      Position.create(0, 0),
      keywords,
    );
    expect(items.map((item) => item.label)).toEqual(["ALL"]);
  });

  it.each([
    ["LIMIT", "limit"],
    ["OFFSET", "offset"],
  ] as const)("enters %s value context", (keyword, expected) => {
    expect(
      resolveExpressionClauseContext(`SELECT * FROM T ${keyword} `),
    ).toBe(expected);
  });
});
