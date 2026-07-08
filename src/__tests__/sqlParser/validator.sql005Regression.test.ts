jest.unmock("chevrotain");

import { SqlValidator } from "../../sqlParser/validator";
import { createMockSchemaProvider } from "../../sqlParser/schemaProvider";

describe("SQL005 regression - aliased double-dot table with star select", () => {
  const sql =
    "SELECT 1 AS COL1, * FROM JUST_DATA_2..FACT_SALES_2 X WHERE X.PRODUCT_ID > 0";

  it("should not emit SQL005 when schema cache contains FACT_SALES_2 columns", () => {
    const schemaProvider = createMockSchemaProvider([
      {
        database: "JUST_DATA_2",
        name: "FACT_SALES_2",
        columns: [{ name: "PRODUCT_ID", dataType: "INTEGER" }],
      },
    ]);
    const validator = new SqlValidator(schemaProvider);
    const result = validator.validate(sql);

    expect(result.warnings.some((warning) => warning.code === "SQL005")).toBe(
      false,
    );
    expect(result.errors.some((error) => error.code === "SQL004")).toBe(false);
  });

  it("should not emit SQL005 when validating the same statement incrementally", () => {
    const schemaProvider = createMockSchemaProvider([
      {
        database: "JUST_DATA_2",
        name: "FACT_SALES_2",
        columns: [{ name: "PRODUCT_ID", dataType: "INTEGER" }],
      },
    ]);
    const validator = new SqlValidator(schemaProvider);
    const result = validator.validateIncrementalFromStatements(
      sql,
      [
        {
          index: 0,
          startOffset: 0,
          endOffset: sql.length - 1,
          sql,
          contentHash: "test",
        },
      ],
      [0],
      new Map(),
    );

    expect(result.warnings.some((warning) => warning.code === "SQL005")).toBe(
      false,
    );
  });
});
