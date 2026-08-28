jest.unmock("chevrotain");

import { describe, expect, it } from "@jest/globals";
import { sqliteSqlAuthoring } from "../../dialects/sqlite/sql/authoring";
import { SqlValidator } from "../../sqlParser/validator";

describe("SQLite SQL validator", () => {
  it("resolves an aliased subquery in the outer SELECT list", () => {
    const result = new SqlValidator(
      undefined,
      sqliteSqlAuthoring.validation,
    ).validate(`
SELECT 1 AS COL1, SUB1.COL2, SUB1.COL3
FROM
(
    SELECT 2 AS COL2
) AS SUB1`);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: "SQL004" });
    expect(result.errors[0].message).toContain("COL3");
    expect(result.errors.some((error) => error.code === "SQL003")).toBe(false);
    expect(result.errors.some((error) => error.code === "SQL020")).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it("resolves a subquery alias without AS", () => {
    const result = new SqlValidator(
      undefined,
      sqliteSqlAuthoring.validation,
    ).validate(`
SELECT SUB1.COL2
FROM (
    SELECT 2 AS COL2
) SUB1`);

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("resolves aliases through nested subqueries", () => {
    const result = new SqlValidator(
      undefined,
      sqliteSqlAuthoring.validation,
    ).validate(`
SELECT OUTER_SUB.COL2
FROM (
    SELECT INNER_SUB.COL2
    FROM (
        SELECT 2 AS COL2
    ) INNER_SUB
) OUTER_SUB`);

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});
