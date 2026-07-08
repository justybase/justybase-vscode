import {
  SUPPORTED_DATABASE_KINDS,
  DEFAULT_DATABASE_KIND,
  DATABASE_KIND_DISPLAY_NAMES,
  createDatabaseCapabilities,
  createDatabaseDialectTraits,
} from "../src/index";

describe("@justybase/contracts", () => {
  describe("SUPPORTED_DATABASE_KINDS", () => {
    it("contains expected dialects", () => {
      expect(SUPPORTED_DATABASE_KINDS).toContain("netezza");
      expect(SUPPORTED_DATABASE_KINDS).toContain("postgresql");
      expect(SUPPORTED_DATABASE_KINDS).toContain("sqlite");
      expect(SUPPORTED_DATABASE_KINDS).toContain("mysql");
      expect(SUPPORTED_DATABASE_KINDS).toContain("oracle");
      expect(SUPPORTED_DATABASE_KINDS).toContain("snowflake");
      expect(SUPPORTED_DATABASE_KINDS).toContain("vertica");
      expect(SUPPORTED_DATABASE_KINDS).toContain("duckdb");
      expect(SUPPORTED_DATABASE_KINDS).toContain("db2");
      expect(SUPPORTED_DATABASE_KINDS).toContain("mssql");
    });

    it("has at least 10 supported kinds", () => {
      expect(SUPPORTED_DATABASE_KINDS.length).toBeGreaterThanOrEqual(10);
    });
  });

  describe("DEFAULT_DATABASE_KIND", () => {
    it("is netezza", () => {
      expect(DEFAULT_DATABASE_KIND).toBe("netezza");
    });
  });

  describe("DATABASE_KIND_DISPLAY_NAMES", () => {
    it("has display name for all supported kinds", () => {
      for (const kind of SUPPORTED_DATABASE_KINDS) {
        expect(DATABASE_KIND_DISPLAY_NAMES[kind]).toBeDefined();
        expect(DATABASE_KIND_DISPLAY_NAMES[kind]!.length).toBeGreaterThan(0);
      }
    });

    it("returns correct display names", () => {
      expect(DATABASE_KIND_DISPLAY_NAMES["netezza"]).toBe("Netezza");
      expect(DATABASE_KIND_DISPLAY_NAMES["postgresql"]).toBe("PostgreSQL");
      expect(DATABASE_KIND_DISPLAY_NAMES["sqlite"]).toBe("SQLite");
      expect(DATABASE_KIND_DISPLAY_NAMES).toBeDefined();
    });
  });

  describe("createDatabaseCapabilities", () => {
    it("returns valid capabilities with defaults", () => {
      const caps = createDatabaseCapabilities({});
      expect(caps.supportsExplainPlan).toBe(false);
      expect(caps.supportsProcedures).toBe(false);
      expect(caps.supportsExternalTables).toBe(false);
      expect(caps.supportsTuningAdvisor).toBe(false);
      expect(caps.supportsSessionMonitor).toBe(false);
      expect(caps.supportsTableMaintenance).toBe(false);
    });

    it("merges provided capabilities", () => {
      const caps = createDatabaseCapabilities({
        supportsExplainPlan: true,
        supportsProcedures: true,
      });
      expect(caps.supportsExplainPlan).toBe(true);
      expect(caps.supportsProcedures).toBe(true);
      expect(caps.supportsExternalTables).toBe(false);
    });

    it("sets all capabilities when provided", () => {
      const caps = createDatabaseCapabilities({
        supportsExplainPlan: true,
        supportsProcedures: true,
        supportsExternalTables: true,
        supportsTuningAdvisor: true,
        supportsSessionMonitor: true,
        supportsTableMaintenance: true,
      });
      expect(caps.supportsExplainPlan).toBe(true);
      expect(caps.supportsProcedures).toBe(true);
      expect(caps.supportsExternalTables).toBe(true);
      expect(caps.supportsTuningAdvisor).toBe(true);
      expect(caps.supportsSessionMonitor).toBe(true);
      expect(caps.supportsTableMaintenance).toBe(true);
    });
  });

  describe("createDatabaseDialectTraits", () => {
    it("returns valid traits with defaults", () => {
      const traits = createDatabaseDialectTraits({});
      expect(traits.identifiers.quoteStyle).toBe("double");
      expect(traits.identifiers.generatedNameCase).toBe("upper");
      expect(traits.qualification.supportsThreePartName).toBe(true);
      expect(traits.completion.singleDotPathNamespace).toBe("database");
    });

    it("merges provided traits", () => {
      const traits = createDatabaseDialectTraits({
        completion: {
          singleDotPathNamespace: "schema",
        },
      });
      expect(traits.completion?.singleDotPathNamespace).toBe("schema");
    });

    it("sets identifier traits", () => {
      const traits = createDatabaseDialectTraits({
        identifiers: {
          unquotedIdentifierPattern: /^[a-z_][a-z0-9_]*$/,
          generatedNameCase: "lower",
        },
      });
      expect(traits.identifiers?.unquotedIdentifierPattern).toBeInstanceOf(
        RegExp,
      );
      expect(traits.identifiers?.generatedNameCase).toBe("lower");
    });

    it("sets qualification traits", () => {
      const traits = createDatabaseDialectTraits({
        qualification: {
          supportsThreePartName: true,
          twoPartNameStyle: "schema-object",
        },
      });
      expect(traits.qualification?.supportsThreePartName).toBe(true);
      expect(traits.qualification?.twoPartNameStyle).toBe("schema-object");
    });
  });
});
