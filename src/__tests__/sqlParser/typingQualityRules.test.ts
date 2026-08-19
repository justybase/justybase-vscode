jest.unmock("chevrotain");

import { describe, expect, it } from "@jest/globals";
import { SqlValidator } from "../../sqlParser/validator";
import { createMockSchemaProvider } from "../../sqlParser/schemaProvider";

describe("typing quality rules", () => {
  it("emits SQL051 for a CROSS JOIN in the existing CST visitor pass", () => {
    const result = new SqlValidator().validate("SELECT * FROM T1 CROSS JOIN T2;");

    expect(result.warnings.some((warning) => warning.code === "SQL051")).toBe(true);
  });

  it("emits SQL052 for an unaliased JOIN source and stays quiet when it has an alias", () => {
    const validator = new SqlValidator(
      createMockSchemaProvider([
        { database: "DB", name: "LEFT_TABLE", columns: ["ID"] },
        { database: "DB", name: "RIGHT_TABLE", columns: ["ID"] },
      ]),
    );

    const missingAlias = validator.validate(
      "SELECT L.ID FROM DB..LEFT_TABLE L JOIN DB..RIGHT_TABLE ON L.ID = RIGHT_TABLE.ID;",
    );
    const withAlias = validator.validate(
      "SELECT L.ID FROM DB..LEFT_TABLE L JOIN DB..RIGHT_TABLE R ON L.ID = R.ID;",
    );

    expect(missingAlias.warnings.some((warning) => warning.code === "SQL052")).toBe(true);
    expect(withAlias.warnings.some((warning) => warning.code === "SQL052")).toBe(false);
  });

  it("emits SQL053 for a string literal used in a JOIN comparison", () => {
    const result = new SqlValidator().validate(
      "SELECT * FROM DB..LEFT_TABLE L JOIN DB..RIGHT_TABLE R ON L.ID = '1';",
    );

    expect(result.warnings.some((warning) => warning.code === "SQL053")).toBe(true);
  });

  it("suggests a visible column only when the candidate set is bounded and unambiguous", () => {
    const validator = new SqlValidator(
      createMockSchemaProvider([
        {
          database: "DB",
          name: "CUSTOMERS",
          columns: ["CUSTOMER_ID", "NAME"],
        },
      ]),
    );

    const result = validator.validate(
      "SELECT CUSTMER_ID FROM DB..CUSTOMERS;",
    );
    const diagnostic = result.errors.find((error) => error.code === "SQL004");

    expect(diagnostic?.suggestedFix).toBe("CUSTOMER_ID");
  });

  it("does not suggest SQL004 fixes for an oversized visible scope", () => {
    const columns = Array.from({ length: 257 }, (_, index) => `COLUMN_${index}`);
    const validator = new SqlValidator(
      createMockSchemaProvider([{ database: "DB", name: "WIDE_TABLE", columns }]),
    );

    const result = validator.validate("SELECT COLUMN_999 FROM DB..WIDE_TABLE;");
    const diagnostic = result.errors.find((error) => error.code === "SQL004");

    expect(diagnostic).toBeDefined();
    expect(diagnostic?.suggestedFix).toBeUndefined();
  });
});
