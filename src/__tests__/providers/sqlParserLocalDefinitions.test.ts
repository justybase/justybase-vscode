import { parseLocalDefinitions } from "../../providers/parsers/sqlParser";

describe("parseLocalDefinitions legacy fallback", () => {
  it("parses CTE definitions with explicit column lists", () => {
    const definitions = parseLocalDefinitions(`
      WITH c(out_a, out_b) AS (
        SELECT * FROM DIMDATE
      )
      SELECT c.
      FROM c;
    `);

    expect(definitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "c",
          type: "CTE",
          columns: ["out_a", "out_b"],
        }),
      ]),
    );
  });
});
