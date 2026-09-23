import {
  editValuesEqual,
  isNumericEditType,
  parseTypedEditValue,
  toEditableCellText,
} from "../../media/resultPanel/editValue";

describe("typed staged result edits", () => {
  it("keeps high precision numeric text without converting through Number", () => {
    const value = "12345678901234567890.12345678901234567890";
    expect(parseTypedEditValue(value, "DECIMAL(38,20)", false)).toEqual({ valid: true, value });
    expect(parseTypedEditValue("12,3", "DECIMAL", false).valid).toBe(false);
    expect(parseTypedEditValue("", "INTEGER", true)).toEqual({ valid: true, value: null });
    expect(parseTypedEditValue("12.5", "INTEGER", false).valid).toBe(false);
    expect(parseTypedEditValue("-12", "BIGINT", false)).toEqual({ valid: true, value: "-12" });
    expect(parseTypedEditValue("1 day", "INTERVAL", false)).toEqual({ valid: true, value: "1 day" });
    expect(isNumericEditType("INTERVAL DAY")).toBe(false);
    expect(isNumericEditType("MONEY")).toBe(true);
  });

  it("preserves NULL separately from empty text and parses boolean choices", () => {
    expect(parseTypedEditValue("", "VARCHAR", false)).toEqual({ valid: true, value: "" });
    expect(parseTypedEditValue("", "VARCHAR", true)).toEqual({ valid: true, value: null });
    expect(parseTypedEditValue("true", "BOOLEAN", false)).toEqual({ valid: true, value: true });
    expect(parseTypedEditValue("no", "BOOLEAN", false).valid).toBe(false);
    expect(parseTypedEditValue("101", "BIT VARYING", false)).toEqual({ valid: true, value: "101" });
  });

  it("validates dates and JSON while keeping timestamp text lossless", () => {
    expect(parseTypedEditValue("2024-02-29", "DATE", false).valid).toBe(true);
    expect(parseTypedEditValue("2023-02-29", "DATE", false).valid).toBe(false);
    expect(parseTypedEditValue('{"name":"x"}', "JSON", false).valid).toBe(true);
    expect(parseTypedEditValue("{bad", "JSON", false).valid).toBe(false);
    expect(toEditableCellText("2024-01-01 12:30:00.123456", "TIMESTAMP")).toBe("2024-01-01 12:30:00.123456");
  });

  it("treats equivalent string and numeric cells as unchanged", () => {
    expect(editValuesEqual(42, "42")).toBe(true);
    expect(editValuesEqual("", null)).toBe(false);
  });
});
