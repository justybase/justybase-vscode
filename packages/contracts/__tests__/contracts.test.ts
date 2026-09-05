import {
  SUPPORTED_DATABASE_KINDS,
  DEFAULT_DATABASE_KIND,
  DATABASE_KIND_DISPLAY_NAMES,
  DESIGNER_CAPABILITY_KEYS,
  DATABASE_DESIGNER_CAPABILITY_MANIFESTS,
  createDatabaseCapabilities,
  createDatabaseDialectTraits,
  getDatabaseDesignerCapabilities,
  resolveDatabaseDesignerCapabilities,
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

  describe("database designer capabilities", () => {
    it("defines every capability explicitly for all supported database kinds", () => {
      for (const kind of SUPPORTED_DATABASE_KINDS) {
        const manifest = getDatabaseDesignerCapabilities(kind);

        expect(manifest.kind).toBe(kind);
        expect(manifest.manifestVersion).toBe(1);
        expect(Object.keys(manifest.constructs).sort()).toEqual(
          [...DESIGNER_CAPABILITY_KEYS].sort(),
        );

        for (const capabilityKey of DESIGNER_CAPABILITY_KEYS) {
          const capability = manifest.constructs[capabilityKey];
          expect(capability.level).toBeDefined();
          expect(capability.reasonCode).toBeDefined();
          expect(capability.operations).toContain("read");
        }
      }

      expect(Object.keys(DATABASE_DESIGNER_CAPABILITY_MANIFESTS).sort()).toEqual(
        [...SUPPORTED_DATABASE_KINDS].sort(),
      );
    });

    it("models native alternatives and enforcement caveats", () => {
      const netezza = getDatabaseDesignerCapabilities("netezza");
      expect(netezza.constructs.indexes.level).toBe("alternative");
      expect(netezza.constructs.indexes.reason).toContain("ORGANIZE ON");
      expect(netezza.constructs.foreignKeys.level).toBe("unsupported");
      expect(netezza.nativeFeatures).toContain("netezza-distribution");

      const clickhouse = getDatabaseDesignerCapabilities("clickhouse");
      expect(clickhouse.constructs.indexes.alternative).toBe("table");
      expect(clickhouse.nativeFeatures).toContain("clickhouse-skipping-index");

      const snowflake = getDatabaseDesignerCapabilities("snowflake");
      expect(snowflake.constructs.foreignKeys.level).toBe("limited");
      expect(snowflake.constructs.foreignKeys.enforced).toBe(false);
      expect(snowflake.nativeFeatures).toContain("snowflake-clustering-key");

      const mysql = getDatabaseDesignerCapabilities("mysql");
      expect(mysql.constructs.triggers.trigger?.timings).toEqual(["BEFORE", "AFTER"]);
      expect(mysql.constructs.triggers.trigger?.levels).toEqual(["ROW"]);

      expect(getDatabaseDesignerCapabilities("postgresql").constructs.triggers.trigger?.bodyStyle).toBe("postgresql-function");
      expect(getDatabaseDesignerCapabilities("oracle").constructs.triggers.trigger?.bodyStyle).toBe("oracle-block");
      expect(getDatabaseDesignerCapabilities("mssql").constructs.triggers.trigger?.bodyStyle).toBe("mssql-batch");
      expect(getDatabaseDesignerCapabilities("db2").constructs.triggers.trigger?.bodyStyle).toBe("db2-atomic");
      expect(getDatabaseDesignerCapabilities("sqlite").constructs.triggers.trigger?.insteadOfObjectKinds).toEqual(["VIEW"]);
      expect(getDatabaseDesignerCapabilities("sqlite").constructs.triggers.trigger?.timingsByObjectKind?.VIEW).toEqual(["INSTEAD OF"]);
      expect(getDatabaseDesignerCapabilities("netezza").constructs.procedures.routine?.bodyStyle).toBe("netezza-nzplsql");
    });

    it("resolves aliases and unknown kinds conservatively", () => {
      expect(getDatabaseDesignerCapabilities("postgres").kind).toBe("postgresql");
      expect(getDatabaseDesignerCapabilities("file").kind).toBe("file");

      const unknown = getDatabaseDesignerCapabilities("new-database");
      expect(unknown.constructs.table.level).toBe("runtime-unavailable");
      expect(unknown.constructs.table.reasonCode).toBe("runtime");
    });

    it("does not advertise mutation operations for a read-only connection", () => {
      const base = getDatabaseDesignerCapabilities("postgresql");
      const resolved = resolveDatabaseDesignerCapabilities(base, {
        databaseKind: "postgresql",
        readOnly: true,
      });

      expect(resolved.constructs.table.level).toBe("privilege-blocked");
      expect(resolved.constructs.table.operations).toEqual(["read"]);
      expect(resolved.constructs.table.reason).toContain("read-only");
      expect(base.constructs.table.level).toBe("supported");
    });

    it("marks every capability unavailable when the runtime is absent", () => {
      const resolved = resolveDatabaseDesignerCapabilities(
        getDatabaseDesignerCapabilities("postgresql"),
        { databaseKind: "postgresql", runtimeAvailable: false },
      );

      for (const key of DESIGNER_CAPABILITY_KEYS) {
        expect(resolved.constructs[key].level).toBe("runtime-unavailable");
        expect(resolved.constructs[key].operations).toEqual(["read"]);
      }
    });

    it("resolves version, engine, and privilege requirements only when runtime context is known", () => {
      const mysql = getDatabaseDesignerCapabilities("mysql");
      const oldServer = resolveDatabaseDesignerCapabilities(mysql, {
        databaseKind: "mysql",
        serverVersion: "8.0.15",
      });
      expect(oldServer.constructs.checks.level).toBe("unsupported");
      expect(oldServer.constructs.checks.reasonCode).toBe("version");

      const wrongEngine = resolveDatabaseDesignerCapabilities(mysql, {
        databaseKind: "mysql",
        engine: "MyISAM",
      });
      expect(wrongEngine.constructs.foreignKeys.level).toBe("unsupported");
      expect(wrongEngine.constructs.foreignKeys.reasonCode).toBe("engine");

      const missingPrivilege = resolveDatabaseDesignerCapabilities(mysql, {
        databaseKind: "mysql",
        privileges: [],
      });
      expect(missingPrivilege.constructs.foreignKeys.level).toBe("privilege-blocked");
      expect(missingPrivilege.constructs.foreignKeys.reasonCode).toBe("privilege");
    });
  });
});
