import {
  classifyLiteralToken,
  classifyNetezzaDataType,
  getArithmeticMixedTypeWarning,
  getColumnTypeMismatchWarning,
  getTypeMismatchWarning,
} from "../../sqlParser/visitor/typeComparisonUtils";

describe("typeComparisonUtils", () => {
  it("classifies Netezza data types into families", () => {
    expect(classifyNetezzaDataType("INTEGER")).toBe("numeric");
    expect(classifyNetezzaDataType("VARCHAR(100)")).toBe("string");
    expect(classifyNetezzaDataType("TIMESTAMP")).toBe("datetime");
    expect(classifyNetezzaDataType("BOOLEAN")).toBe("boolean");
  });

  it("classifies literal token kinds", () => {
    expect(classifyLiteralToken("StringLiteral")).toBe("string");
    expect(classifyLiteralToken("NumberLiteral")).toBe("number");
    expect(classifyLiteralToken("Null")).toBe("null");
  });

  it("returns SQL025 for numeric column vs string literal", () => {
    const warning = getTypeMismatchWarning("numeric", "string", "Equals");
    expect(warning?.code).toBe("SQL025");
  });

  it("returns SQL026 for text column vs numeric ordered comparison", () => {
    const warning = getTypeMismatchWarning("string", "number", "GreaterThan");
    expect(warning?.code).toBe("SQL026");
  });

  it("returns SQL025 for numeric column vs text column", () => {
    const warning = getColumnTypeMismatchWarning("numeric", "string", "Equals");
    expect(warning?.code).toBe("SQL025");
  });

  it("returns SQL026 for text column vs numeric ordered column comparison", () => {
    const warning = getColumnTypeMismatchWarning(
      "string",
      "numeric",
      "GreaterThan",
    );
    expect(warning?.code).toBe("SQL026");
  });

  describe("getArithmeticMixedTypeWarning", () => {
    it("returns SQL025 for numeric vs string in arithmetic", () => {
      const warning = getArithmeticMixedTypeWarning("numeric", "string");
      expect(warning?.code).toBe("SQL025");
    });

    it("returns SQL025 for string vs numeric in arithmetic", () => {
      const warning = getArithmeticMixedTypeWarning("string", "numeric");
      expect(warning?.code).toBe("SQL025");
    });

    it("returns undefined for same types", () => {
      expect(getArithmeticMixedTypeWarning("numeric", "numeric")).toBeUndefined();
      expect(getArithmeticMixedTypeWarning("string", "string")).toBeUndefined();
    });

    it("returns undefined for unknown types", () => {
      expect(getArithmeticMixedTypeWarning("unknown", "string")).toBeUndefined();
      expect(getArithmeticMixedTypeWarning("numeric", "unknown")).toBeUndefined();
    });

    it("returns undefined for datetime or boolean", () => {
      expect(getArithmeticMixedTypeWarning("datetime", "numeric")).toBeUndefined();
      expect(getArithmeticMixedTypeWarning("boolean", "string")).toBeUndefined();
    });
  });
});
