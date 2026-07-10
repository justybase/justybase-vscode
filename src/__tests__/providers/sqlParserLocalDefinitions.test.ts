import { parseLocalDefinitions } from "../../providers/parsers/sqlParser";
import { findLocalDefinition } from "../../server/completionLocalDefinitionUtils";

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

  it("parses qualified CTAS and global temp tables in legacy fallback", () => {
    const definitions = parseLocalDefinitions(`
      CREATE TABLE JUST_DATA..TEST2 AS (SELECT 1 AS id);
      CREATE GLOBAL TEMP TABLE JUST_DATA.ADMIN.TEST11 AS (SELECT 2 AS id);
    `);

    expect(definitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "JUST_DATA..TEST2",
          type: "Table",
          columns: ["id"],
        }),
        expect.objectContaining({
          name: "JUST_DATA.ADMIN.TEST11",
          type: "Global Temp Table",
          columns: ["id"],
        }),
      ]),
    );
  });

  it("finds local definitions by short table name when stored qualified", () => {
    const definitions = parseLocalDefinitions(
      "CREATE TABLE JUST_DATA..TEST2 AS (SELECT 1 AS id);",
    );

    expect(findLocalDefinition(definitions, "TEST2")).toEqual(
      expect.objectContaining({ name: "JUST_DATA..TEST2" }),
    );
  });
});
