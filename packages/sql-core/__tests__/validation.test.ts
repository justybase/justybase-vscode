import { NetezzaSqlValidationCore } from "../src/validation";

describe("NetezzaSqlValidationCore", () => {
  it("forwards validation through the platform-neutral boundary", () => {
    const core = new NetezzaSqlValidationCore({
      validate: (sql) => ({
        valid: sql === "SELECT 1",
        errors: [],
        warnings: [],
      }),
    });

    expect(core.validate("SELECT 1").valid).toBe(true);
    expect(core.validate("SELECT 2").valid).toBe(false);
  });

  it("uses the parsed-result path when the backend provides one", () => {
    const core = new NetezzaSqlValidationCore({
      validate: () => ({ valid: false, errors: [], warnings: [] }),
      validateParsed: (_sql, parseResult) => ({
        valid: parseResult === "parsed",
        errors: [],
        warnings: [],
      }),
    });

    expect(core.validateParsed("SELECT 1", "parsed").valid).toBe(true);
    expect(core.validateParsed("SELECT 1", "other").valid).toBe(false);
  });

  it("fails clearly when parsing is not available on the transitional backend", () => {
    const core = new NetezzaSqlValidationCore({
      validate: () => ({ valid: true, errors: [], warnings: [] }),
    });

    expect(() => core.parse("SELECT 1")).toThrow(
      "does not expose parsing yet",
    );
  });
});
