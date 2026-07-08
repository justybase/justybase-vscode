jest.unmock("chevrotain");

import { SqlValidator } from "../../sqlParser/validator";
import type { SchemaProvider } from "../../sqlParser/schemaProvider";
import type { QualificationProposal } from "../../core/tableQualificationResolver";

function createProvider(
  proposals: QualificationProposal[],
): SchemaProvider {
  return {
    getTable: jest.fn(() => undefined),
    tableExists: jest.fn(() => true),
    canValidateUnqualifiedTableReferences: jest.fn(() => true),
    proposeTableQualification: jest.fn(() => proposals),
  };
}

describe("table qualification diagnostics", () => {
  it("emits SQL048 with suggestedFix when a qualification proposal exists", () => {
    const validator = new SqlValidator(
      createProvider([
        {
          database: "DB1",
          schema: "PUBLIC",
          name: "EMPLOYEES",
          qualifiedText: "DB1.PUBLIC.EMPLOYEES",
          isPreferred: true,
        },
      ]),
    );

    const result = validator.validate("SELECT * FROM EMPLOYEES;");
    const diagnostic = result.warnings.find((warning) => warning.code === "SQL048");

    expect(diagnostic).toMatchObject({
      code: "SQL048",
      severity: "information",
      suggestedFix: "DB1.PUBLIC.EMPLOYEES",
    });
  });

  it("does not emit SQL048 when no qualification proposal exists", () => {
    const validator = new SqlValidator(createProvider([]));

    const result = validator.validate("SELECT * FROM EMPLOYEES;");

    expect(result.warnings.some((warning) => warning.code === "SQL048")).toBe(false);
  });

  it("covers the full DB..TABLE span for SQL048 quick fixes", () => {
    const sql = "SELECT * FROM JUST_DATA..DEPARTMENT;";
    const validator = new SqlValidator(
      createProvider([
        {
          database: "JUST_DATA",
          schema: "ADMIN",
          name: "DEPARTMENT",
          qualifiedText: "JUST_DATA.ADMIN.DEPARTMENT",
          isPreferred: true,
        },
      ]),
    );

    const result = validator.validate(sql);
    const diagnostic = result.warnings.find((warning) => warning.code === "SQL048");
    expect(diagnostic).toBeDefined();

    const spanLength =
      diagnostic!.position.endColumn - diagnostic!.position.startColumn;
    const highlighted = sql.substring(
      diagnostic!.position.offset,
      diagnostic!.position.offset + spanLength,
    );
    expect(highlighted).toBe("JUST_DATA..DEPARTMENT");
    expect(diagnostic?.suggestedFix).toBe("JUST_DATA.ADMIN.DEPARTMENT");
  });
});
