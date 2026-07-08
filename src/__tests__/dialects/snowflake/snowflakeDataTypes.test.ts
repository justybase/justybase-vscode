import {
  getSnowflakeTypeSpec,
  supportsProcedureAnySizeArgument,
  getCanonicalTypeName,
  isNumericType,
  isStringType,
  isDateTimeType,
  isSemiStructuredType,
  isGeospatialType,
  normalizeTypeName,
} from "../../../../extensions/snowflake/src/sql/dataTypes";

describe("Snowflake data types", () => {
  describe("normalizeTypeName", () => {
    it("converts to uppercase and trims whitespace", () => {
      expect(normalizeTypeName("  varchar  ")).toBe("VARCHAR");
      expect(normalizeTypeName("double  precision")).toBe("DOUBLE PRECISION");
    });
  });

  describe("getSnowflakeTypeSpec", () => {
    it("returns undefined for empty or unknown types", () => {
      expect(getSnowflakeTypeSpec("")).toBeUndefined();
      expect(getSnowflakeTypeSpec("UNKNOWN_TYPE")).toBeUndefined();
    });

    // Numeric types
    const numericTypes = [
      { name: "NUMBER", canonical: "NUMBER", paramsMax: 2 },
      { name: "DECIMAL", canonical: "NUMBER", paramsMax: 2 },
      { name: "DEC", canonical: "NUMBER", paramsMax: 2 },
      { name: "NUMERIC", canonical: "NUMBER", paramsMax: 2 },
      { name: "INT", canonical: "INT", paramsMax: 0 },
      { name: "INTEGER", canonical: "INT", paramsMax: 0 },
      { name: "BIGINT", canonical: "BIGINT", paramsMax: 0 },
      { name: "SMALLINT", canonical: "SMALLINT", paramsMax: 0 },
      { name: "FLOAT", canonical: "FLOAT", paramsMax: 1 },
      { name: "DOUBLE", canonical: "DOUBLE", paramsMax: 0 },
      { name: "DOUBLE PRECISION", canonical: "DOUBLE", paramsMax: 0 },
    ];

    it.each(numericTypes)(
      "resolves numeric type: $name → $canonical (paramsMax=$paramsMax)",
      ({ name, canonical, paramsMax }) => {
        const spec = getSnowflakeTypeSpec(name);
        expect(spec).toBeDefined();
        expect(spec!.canonical).toBe(canonical);
        expect(spec!.paramsMax).toBe(paramsMax);
      },
    );

    // String types
    const stringTypes = [
      { name: "VARCHAR", canonical: "VARCHAR", warnIfNoLength: true },
      { name: "CHAR", canonical: "CHAR", warnIfNoLength: true },
      { name: "CHARACTER", canonical: "CHAR", warnIfNoLength: true },
      { name: "STRING", canonical: "STRING", warnIfNoLength: false },
      { name: "TEXT", canonical: "TEXT", warnIfNoLength: false },
      { name: "BINARY", canonical: "BINARY", warnIfNoLength: false },
      { name: "VARBINARY", canonical: "VARBINARY", warnIfNoLength: false },
    ];

    it.each(stringTypes)(
      "resolves string type: $name → $canonical",
      ({ name, canonical, warnIfNoLength }) => {
        const spec = getSnowflakeTypeSpec(name);
        expect(spec).toBeDefined();
        expect(spec!.canonical).toBe(canonical);
        if (warnIfNoLength) {
          expect(spec!.warnIfNoLength).toBe(true);
        }
      },
    );

    // Boolean types
    it.each(["BOOLEAN", "BOOL"])("resolves boolean type: %s", (name) => {
      const spec = getSnowflakeTypeSpec(name);
      expect(spec).toBeDefined();
      expect(spec!.canonical).toBe("BOOLEAN");
    });

    // Date/Time types
    const dateTimeTypes = [
      { name: "DATE", canonical: "DATE" },
      { name: "DATETIME", canonical: "DATETIME" },
      { name: "TIME", canonical: "TIME" },
      { name: "TIMESTAMP", canonical: "TIMESTAMP" },
      { name: "TIMESTAMP_LTZ", canonical: "TIMESTAMP_LTZ" },
      { name: "TIMESTAMP_NTZ", canonical: "TIMESTAMP_NTZ" },
      { name: "TIMESTAMP_TZ", canonical: "TIMESTAMP_TZ" },
    ];

    it.each(dateTimeTypes)(
      "resolves date/time type: $name → $canonical",
      ({ name, canonical }) => {
        const spec = getSnowflakeTypeSpec(name);
        expect(spec).toBeDefined();
        expect(spec!.canonical).toBe(canonical);
      },
    );

    // Semi-structured types
    it.each(["VARIANT", "OBJECT", "ARRAY"])(
      "resolves semi-structured type: %s",
      (name) => {
        const spec = getSnowflakeTypeSpec(name);
        expect(spec).toBeDefined();
        expect(spec!.canonical).toBe(name);
        expect(spec!.paramsMin).toBe(0);
        expect(spec!.paramsMax).toBe(0);
      },
    );

    // Geospatial types
    it.each(["GEOGRAPHY", "GEOMETRY"])(
      "resolves geospatial type: %s",
      (name) => {
        const spec = getSnowflakeTypeSpec(name);
        expect(spec).toBeDefined();
        expect(spec!.canonical).toBe(name);
      },
    );

    // Interval types
    it("resolves INTERVAL type", () => {
      const spec = getSnowflakeTypeSpec("INTERVAL");
      expect(spec).toBeDefined();
      expect(spec!.canonical).toBe("INTERVAL");
    });

    it("resolves qualified interval forms", () => {
      const spec = getSnowflakeTypeSpec("INTERVAL YEAR TO MONTH");
      expect(spec).toBeDefined();
      expect(spec!.canonical).toBe("INTERVAL");
    });

    // NUMBER parameter bounds
    it("NUMBER accepts 0 to 2 parameters", () => {
      const spec = getSnowflakeTypeSpec("NUMBER");
      expect(spec!.paramsMin).toBe(0);
      expect(spec!.paramsMax).toBe(2);
    });

    it("VARCHAR warns if no length", () => {
      const spec = getSnowflakeTypeSpec("VARCHAR");
      expect(spec!.warnIfNoLength).toBe(true);
    });
  });

  describe("getCanonicalTypeName", () => {
    it("returns canonical name for known aliases", () => {
      expect(getCanonicalTypeName("DECIMAL")).toBe("NUMBER");
      expect(getCanonicalTypeName("INTEGER")).toBe("INT");
      expect(getCanonicalTypeName("BOOL")).toBe("BOOLEAN");
      expect(getCanonicalTypeName("CHARACTER")).toBe("CHAR");
    });

    it("returns undefined for unknown types", () => {
      expect(getCanonicalTypeName("UNKNOWN")).toBeUndefined();
    });
  });

  describe("supportsProcedureAnySizeArgument", () => {
    const supportedTypes = [
      "CHAR",
      "VARCHAR",
      "NCHAR",
      "NVARCHAR",
      "STRING",
      "TEXT",
    ];
    it.each(supportedTypes)("returns true for text type: %s", (name) => {
      expect(supportsProcedureAnySizeArgument(name)).toBe(true);
    });

    const unsupportedTypes = [
      "INT",
      "NUMBER",
      "BOOLEAN",
      "DATE",
      "VARIANT",
      "ARRAY",
    ];
    it.each(unsupportedTypes)("returns false for non-text type: %s", (name) => {
      expect(supportsProcedureAnySizeArgument(name)).toBe(false);
    });
  });

  describe("type category utilities", () => {
    it("isNumericType identifies numeric types", () => {
      expect(isNumericType("NUMBER")).toBe(true);
      expect(isNumericType("INT")).toBe(true);
      expect(isNumericType("BIGINT")).toBe(true);
      expect(isNumericType("FLOAT")).toBe(true);
      expect(isNumericType("DOUBLE")).toBe(true);
      expect(isNumericType("VARCHAR")).toBe(false);
      expect(isNumericType("DATE")).toBe(false);
    });

    it("isStringType identifies string types", () => {
      expect(isStringType("VARCHAR")).toBe(true);
      expect(isStringType("CHAR")).toBe(true);
      expect(isStringType("STRING")).toBe(true);
      expect(isStringType("TEXT")).toBe(true);
      expect(isStringType("BINARY")).toBe(true);
      expect(isStringType("INT")).toBe(false);
    });

    it("isDateTimeType identifies date/time types", () => {
      expect(isDateTimeType("DATE")).toBe(true);
      expect(isDateTimeType("TIMESTAMP")).toBe(true);
      expect(isDateTimeType("TIMESTAMP_LTZ")).toBe(true);
      expect(isDateTimeType("TIMESTAMP_NTZ")).toBe(true);
      expect(isDateTimeType("TIMESTAMP_TZ")).toBe(true);
      expect(isDateTimeType("TIME")).toBe(true);
      expect(isDateTimeType("INT")).toBe(false);
    });

    it("isSemiStructuredType identifies semi-structured types", () => {
      expect(isSemiStructuredType("VARIANT")).toBe(true);
      expect(isSemiStructuredType("OBJECT")).toBe(true);
      expect(isSemiStructuredType("ARRAY")).toBe(true);
      expect(isSemiStructuredType("VARCHAR")).toBe(false);
    });

    it("isGeospatialType identifies geospatial types", () => {
      expect(isGeospatialType("GEOGRAPHY")).toBe(true);
      expect(isGeospatialType("GEOMETRY")).toBe(true);
      expect(isGeospatialType("VARCHAR")).toBe(false);
    });

    it("all utilities return false for unknown types", () => {
      expect(isNumericType("UNKNOWN")).toBe(false);
      expect(isStringType("UNKNOWN")).toBe(false);
      expect(isDateTimeType("UNKNOWN")).toBe(false);
      expect(isSemiStructuredType("UNKNOWN")).toBe(false);
      expect(isGeospatialType("UNKNOWN")).toBe(false);
    });
  });
});
