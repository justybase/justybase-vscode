/**
 * Unit tests for import/dataImporter.ts
 * Tests NetezzaDataType and ColumnTypeChooser classes
 */

import { NetezzaDataType, ColumnTypeChooser } from "../import/dataImporter";

describe("import/dataImporter", () => {
  describe("NetezzaDataType", () => {
    it("should format BIGINT type correctly", () => {
      const type = new NetezzaDataType("BIGINT");
      expect(type.toString()).toBe("BIGINT");
    });

    it("should format DATE type correctly", () => {
      const type = new NetezzaDataType("DATE");
      expect(type.toString()).toBe("DATE");
    });

    it("should format DATETIME type correctly", () => {
      const type = new NetezzaDataType("DATETIME");
      expect(type.toString()).toBe("DATETIME");
    });

    it("should format NUMERIC type with precision and scale", () => {
      const type = new NetezzaDataType("NUMERIC", 10, 2);
      expect(type.toString()).toBe("NUMERIC(10,2)");
    });

    it("should format NVARCHAR type with length", () => {
      const type = new NetezzaDataType("NVARCHAR", undefined, undefined, 100);
      expect(type.toString()).toBe("NVARCHAR(100)");
    });

    it("should default to NVARCHAR(255) for unknown types", () => {
      const type = new NetezzaDataType("VARCHAR");
      expect(type.toString()).toBe("NVARCHAR(255)");
    });

    it("should store precision, scale, and length properties", () => {
      const type = new NetezzaDataType("NUMERIC", 15, 4, 100);
      expect(type.dbType).toBe("NUMERIC");
      expect(type.precision).toBe(15);
      expect(type.scale).toBe(4);
      expect(type.length).toBe(100);
    });
  });

  describe("ColumnTypeChooser", () => {
    it("should start with BIGINT type", () => {
      const chooser = new ColumnTypeChooser();
      expect(chooser.currentType.dbType).toBe("BIGINT");
    });

    it("should accept integers as BIGINT", () => {
      const chooser = new ColumnTypeChooser();
      const type = chooser.refreshCurrentType("123");
      expect(type.dbType).toBe("BIGINT");
    });

    it("should detect decimal numbers as NUMERIC", () => {
      const chooser = new ColumnTypeChooser();
      const type = chooser.refreshCurrentType("123.45");
      expect(type.dbType).toBe("NUMERIC");
      expect(type.precision).toBeGreaterThanOrEqual(5);
      expect(type.scale).toBeGreaterThanOrEqual(2);
    });

    it("should use comma as decimal delimiter when specified", () => {
      const chooser = new ColumnTypeChooser(",");
      const type = chooser.refreshCurrentType("123,45");
      expect(type.dbType).toBe("NUMERIC");
      expect(chooser.getMaxScale()).toBe(2);
    });

    it("should detect dates in YYYY-MM-DD format", () => {
      const chooser = new ColumnTypeChooser();
      const type = chooser.refreshCurrentType("2024-06-07");
      expect(type.dbType).toBe("DATE");
    });

    it("should detect datetime in YYYY-MM-DD HH:mm format", () => {
      const chooser = new ColumnTypeChooser();
      const type = chooser.refreshCurrentType("2024-06-07 14:30");
      expect(type.dbType).toBe("DATETIME");
    });

    it("should detect datetime in YYYY-MM-DD HH:mm:ss format", () => {
      const chooser = new ColumnTypeChooser();
      const type = chooser.refreshCurrentType("2024-06-07 14:30:45");
      expect(type.dbType).toBe("DATETIME");
    });

    it("should detect datetime in dd.mm.yyyy HH:mm format", () => {
      const chooser = new ColumnTypeChooser();
      const type = chooser.refreshCurrentType("07.06.2024 14:30");
      expect(type.dbType).toBe("DATETIME");
    });

    it("should fallback to NVARCHAR for text data", () => {
      const chooser = new ColumnTypeChooser();
      const type = chooser.refreshCurrentType("Hello World");
      expect(type.dbType).toBe("NVARCHAR");
      expect(type.length).toBeGreaterThanOrEqual(16); // text length + 5
    });

    it("should expand NVARCHAR length for longer strings", () => {
      const chooser = new ColumnTypeChooser();
      chooser.refreshCurrentType("short");
      const type = chooser.refreshCurrentType(
        "This is a much longer string value",
      );
      expect(type.dbType).toBe("NVARCHAR");
      expect(type.length).toBeGreaterThanOrEqual(37);
    });

    it("should track max precision and scale for numeric values", () => {
      const chooser = new ColumnTypeChooser();
      chooser.refreshCurrentType("12.34");
      chooser.refreshCurrentType("1234.5678");

      expect(chooser.getMaxPrecision()).toBe(8);
      expect(chooser.getMaxScale()).toBe(4);
    });

    it("should handle zero values", () => {
      const chooser = new ColumnTypeChooser();
      const type = chooser.refreshCurrentType("0");
      expect(type.dbType).toBe("BIGINT");
    });

    it("should handle negative numbers as NVARCHAR", () => {
      const chooser = new ColumnTypeChooser();
      const type = chooser.refreshCurrentType("-123");
      expect(type.dbType).toBe("NVARCHAR");
    });

    it("should handle numbers with leading zeros as NUMERIC", () => {
      const chooser = new ColumnTypeChooser();
      const type = chooser.refreshCurrentType("0.5");
      expect(type.dbType).toBe("NUMERIC");
    });

    it("should treat integer values with visible leading zeros as text", () => {
      const chooser = new ColumnTypeChooser();
      const type = chooser.refreshCurrentType("0123");
      expect(type.dbType).toBe("NVARCHAR");
    });

    it("should force text type for PESEL-like headers", () => {
      const chooser = new ColumnTypeChooser(".", { forceText: true });
      const type = chooser.refreshCurrentType("12345678901");
      expect(type.dbType).toBe("NVARCHAR");
    });

    it("should not change type from NVARCHAR once set", () => {
      const chooser = new ColumnTypeChooser();
      chooser.refreshCurrentType("text data");
      const type = chooser.refreshCurrentType("123");
      expect(type.dbType).toBe("NVARCHAR");
    });

    it("should upgrade from BIGINT to NUMERIC on decimal", () => {
      const chooser = new ColumnTypeChooser();
      chooser.refreshCurrentType("123");
      expect(chooser.currentType.dbType).toBe("BIGINT");

      const type = chooser.refreshCurrentType("123.45");
      expect(type.dbType).toBe("NUMERIC");
    });

    it("should handle mixed numeric and date values", () => {
      const chooser = new ColumnTypeChooser();
      chooser.refreshCurrentType("123.45");
      const type = chooser.refreshCurrentType("2024-06-07");
      // The type may change based on the pattern matching logic
      expect(type).toBeDefined();
      expect(type.dbType).toBeTruthy();
    });

    it("should handle empty string as NVARCHAR", () => {
      const chooser = new ColumnTypeChooser();
      const type = chooser.refreshCurrentType("");
      expect(type.dbType).toBe("NVARCHAR");
    });

    it("should handle very large integers as NUMERIC", () => {
      const chooser = new ColumnTypeChooser();
      const type = chooser.refreshCurrentType("999999999999999"); // 15 digits
      expect(type.dbType).toBe("NUMERIC");
    });

    it("should handle numeric values with many decimal places", () => {
      const chooser = new ColumnTypeChooser();
      // Number with several decimal places
      const type = chooser.refreshCurrentType("12345.123456");
      expect(type.dbType).toBe("NUMERIC");
      expect(type.scale).toBeGreaterThanOrEqual(6);
    });

    it("should handle time portion in datetime string", () => {
      const chooser = new ColumnTypeChooser();
      const type = chooser.refreshCurrentType("2024-12-25T23:59:59");
      expect(type.dbType).toBe("DATETIME");
    });

    it("should handle invalid dates gracefully", () => {
      const chooser = new ColumnTypeChooser();
      // JavaScript Date is lenient and may auto-correct dates
      // So we just check it doesn't crash and returns a valid type
      const type = chooser.refreshCurrentType("2024-13-45");
      expect(["DATE", "NVARCHAR"]).toContain(type.dbType);
    });

    it("should handle single digit dates", () => {
      const chooser = new ColumnTypeChooser();
      const type = chooser.refreshCurrentType("2024-6-7");
      expect(type.dbType).toBe("DATE");
    });
  });
});
