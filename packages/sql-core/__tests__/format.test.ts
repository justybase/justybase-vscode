import { formatNetezzaSql } from "../src/format";

describe("formatNetezzaSql", () => {
  it("keeps literals, comments, quoted identifiers, and DB..TABLE notation lossless", () => {
    const formatted = formatNetezzaSql(
      "select \"Odd Name\", 'A  B' -- comment\nfrom DB..ORDERS where id=1",
      { keywordCase: "upper" },
    );

    expect(formatted).toContain('"Odd Name"');
    expect(formatted).toContain("'A  B'");
    expect(formatted).toContain("-- comment");
    expect(formatted).toContain("FROM DB..ORDERS");
  });

  it("formats CTEs, joins, and separate statements with the configured spacing", () => {
    expect(formatNetezzaSql(
      "with cte as (select id from DB..ORDERS) select * from cte left join DB..DETAIL d on d.id = cte.id; select 2;",
      { keywordCase: "upper", linesBetweenQueries: 2 },
    )).toBe([
      "WITH cte AS",
      "(",
      "    SELECT id",
      "    FROM DB..ORDERS",
      ")",
      "",
      "SELECT",
      "    *",
      "FROM cte",
      "LEFT JOIN DB..DETAIL d ON d.id = cte.id;",
      "",
      "SELECT",
      "    2;",
    ].join("\n"));
  });
});
