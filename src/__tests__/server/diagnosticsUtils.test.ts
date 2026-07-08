import {
  extractTableReferences,
  parseQualifiedReference,
  normalizeIdentifier,
  toDiagnostic,
  toDiagnosticSeverity,
  validationPositionToRange,
  isDiagnosticsSuperseded,
  nextDiagnosticsGeneration,
} from "../../server/diagnosticsUtils";
import { DiagnosticSeverity } from "vscode-languageserver/node";
import type { ValidationError } from "../../sqlParser";

describe("diagnosticsUtils", () => {
  describe("normalizeIdentifier", () => {
    it("returns undefined for undefined input", () => {
      expect(normalizeIdentifier(undefined)).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      expect(normalizeIdentifier("")).toBeUndefined();
    });

    it("returns undefined for whitespace-only string", () => {
      expect(normalizeIdentifier("   ")).toBeUndefined();
    });

    it("trims whitespace", () => {
      expect(normalizeIdentifier("  foo  ")).toBe("foo");
    });

    it("strips surrounding quotes", () => {
      expect(normalizeIdentifier('"MyTable"')).toBe("MyTable");
    });

    it("does not strip single quote", () => {
      expect(normalizeIdentifier('"')).toBe('"');
    });

    it("does not strip mismatched quotes", () => {
      expect(normalizeIdentifier('"foo')).toBe('"foo');
      expect(normalizeIdentifier('foo"')).toBe('foo"');
    });
  });

  describe("parseQualifiedReference", () => {
    it("returns undefined for undefined input", () => {
      expect(parseQualifiedReference(undefined)).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      expect(parseQualifiedReference("")).toBeUndefined();
    });

    it("returns undefined for parenthesized expression", () => {
      expect(parseQualifiedReference("(subquery)")).toBeUndefined();
    });

    it("parses unqualified table name", () => {
      expect(parseQualifiedReference("my_table")).toEqual({
        table: "my_table",
      });
    });

    it("parses schema.table", () => {
      expect(parseQualifiedReference("my_schema.my_table")).toEqual({
        schema: "my_schema",
        table: "my_table",
      });
    });

    it("parses database.schema.table", () => {
      expect(parseQualifiedReference("my_db.my_schema.my_table")).toEqual({
        database: "my_db",
        schema: "my_schema",
        table: "my_table",
      });
    });

    it("parses database..table (Netezza double-dot notation)", () => {
      expect(parseQualifiedReference("my_db..my_table")).toEqual({
        database: "my_db",
        table: "my_table",
      });
    });

    it("strips trailing semicolons and commas", () => {
      expect(parseQualifiedReference("my_table;")).toEqual({
        table: "my_table",
      });
      expect(parseQualifiedReference("my_table,")).toEqual({
        table: "my_table",
      });
    });

    it("handles quoted identifiers", () => {
      expect(parseQualifiedReference('"MySchema"."MyTable"')).toEqual({
        schema: "MySchema",
        table: "MyTable",
      });
    });
  });

  describe("extractTableReferences", () => {
    it("returns empty array for empty SQL", () => {
      expect(extractTableReferences("")).toEqual([]);
    });

    it("extracts table from simple SELECT", () => {
      const refs = extractTableReferences("SELECT * FROM users");
      expect(refs).toHaveLength(1);
      expect(refs[0].table).toBe("users");
    });

    it("extracts table from JOIN", () => {
      const refs = extractTableReferences(
        "SELECT * FROM users JOIN orders ON users.id = orders.user_id",
      );
      expect(refs).toHaveLength(2);
      const tables = refs.map((r) => r.table).sort();
      expect(tables).toEqual(["orders", "users"]);
    });

    it("extracts table from UPDATE", () => {
      const refs = extractTableReferences("UPDATE users SET name = 'foo'");
      expect(refs).toHaveLength(1);
      expect(refs[0].table).toBe("users");
    });

    it("extracts table from INSERT INTO", () => {
      const refs = extractTableReferences(
        "INSERT INTO users (name) VALUES ('foo')",
      );
      expect(refs).toHaveLength(1);
      expect(refs[0].table).toBe("users");
    });

    it("extracts table from DELETE FROM", () => {
      const refs = extractTableReferences("DELETE FROM users WHERE id = 1");
      expect(refs).toHaveLength(1);
      expect(refs[0].table).toBe("users");
    });

    it("extracts table from TRUNCATE TABLE", () => {
      const refs = extractTableReferences("TRUNCATE TABLE users");
      expect(refs).toHaveLength(1);
      expect(refs[0].table).toBe("users");
    });

    it("deduplicates same table referenced multiple times", () => {
      const refs = extractTableReferences(
        "SELECT * FROM users u1 JOIN users u2 ON u1.id = u2.parent_id",
      );
      expect(refs).toHaveLength(1);
      expect(refs[0].table).toBe("users");
    });

    it("extracts schema-qualified tables", () => {
      const refs = extractTableReferences("SELECT * FROM admin.users");
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({ schema: "admin", table: "users" });
    });

    it("extracts fully-qualified tables", () => {
      const refs = extractTableReferences("SELECT * FROM mydb.admin.users");
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({
        database: "mydb",
        schema: "admin",
        table: "users",
      });
    });

    it("extracts Netezza double-dot notation", () => {
      const refs = extractTableReferences("SELECT * FROM mydb..users");
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({ database: "mydb", table: "users" });
    });

    it("extracts table from GROOM TABLE", () => {
      const refs = extractTableReferences(
        "GROOM TABLE EXISTING_DATABASE.ADMIN.DIMACCOUNT VERSIONS",
      );
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({
        database: "EXISTING_DATABASE",
        schema: "ADMIN",
        table: "DIMACCOUNT",
      });
    });

    it("extracts table from COMMENT ON TABLE", () => {
      const refs = extractTableReferences(
        "COMMENT ON TABLE TESTDB.PUBLIC.EMPLOYEES IS 'Main employee table';",
      );
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({
        database: "TESTDB",
        schema: "PUBLIC",
        table: "EMPLOYEES",
      });
    });

    it("extracts object from COMMENT ON PROCEDURE with empty parens", () => {
      const refs = extractTableReferences(
        "COMMENT ON PROCEDURE EXISTING_DATABASE.ADMIN.NO_SUCH_PROCEDURE() IS 'TEST COMMENT';",
      );
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({
        database: "EXISTING_DATABASE",
        schema: "ADMIN",
        table: "NO_SUCH_PROCEDURE",
      });
    });

    it("extracts object from COMMENT ON PROCEDURE with params", () => {
      const refs = extractTableReferences(
        "COMMENT ON PROCEDURE MY_PROC(INT, VARCHAR) IS 'text';",
      );
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({ table: "MY_PROC" });
    });

    it("extracts table from COMMENT ON VIEW", () => {
      const refs = extractTableReferences(
        "COMMENT ON VIEW ADMIN.MY_VIEW IS 'text';",
      );
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({ schema: "ADMIN", table: "MY_VIEW" });
    });

    it("extracts table from DROP TABLE", () => {
      const refs = extractTableReferences(
        "DROP TABLE TESTDB.PUBLIC.OLD_TABLE;",
      );
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({
        database: "TESTDB",
        schema: "PUBLIC",
        table: "OLD_TABLE",
      });
    });

    it("extracts table from ALTER TABLE", () => {
      const refs = extractTableReferences(
        "ALTER TABLE TESTDB.PUBLIC.EMPLOYEES ADD COLUMN NEW_COL INT;",
      );
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({
        database: "TESTDB",
        schema: "PUBLIC",
        table: "EMPLOYEES",
      });
    });

    it("extracts table from LOCK TABLE", () => {
      const refs = extractTableReferences(
        "LOCK TABLE ADMIN.ORDERS IN EXCLUSIVE MODE;",
      );
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({ schema: "ADMIN", table: "ORDERS" });
    });

    it("handles multiple tables in complex query", () => {
      const sql = `
        SELECT u.name, o.total, p.name as product
        FROM users u
        JOIN orders o ON u.id = o.user_id
        JOIN order_items oi ON o.id = oi.order_id
        JOIN products p ON oi.product_id = p.id
        WHERE u.active = true
      `;
      const refs = extractTableReferences(sql);
      expect(refs).toHaveLength(4);
      const tables = refs.map((r) => r.table).sort();
      expect(tables).toEqual(["order_items", "orders", "products", "users"]);
    });
  });

  describe("toDiagnosticSeverity", () => {
    it("maps error to DiagnosticSeverity.Error", () => {
      expect(toDiagnosticSeverity("error")).toBe(DiagnosticSeverity.Error);
    });

    it("maps warning to DiagnosticSeverity.Warning", () => {
      expect(toDiagnosticSeverity("warning")).toBe(DiagnosticSeverity.Warning);
    });

    it("maps information to DiagnosticSeverity.Information", () => {
      expect(toDiagnosticSeverity("information")).toBe(
        DiagnosticSeverity.Information,
      );
    });

    it("maps hint to DiagnosticSeverity.Hint", () => {
      expect(toDiagnosticSeverity("hint")).toBe(DiagnosticSeverity.Hint);
    });

    it("defaults to Warning for unknown severity", () => {
      expect(toDiagnosticSeverity("unknown" as ValidationError["severity"])).toBe(
        DiagnosticSeverity.Warning,
      );
    });
  });

  describe("validationPositionToRange", () => {
    it("converts 1-based positions to 0-based range", () => {
      const issue: ValidationError = {
        message: "test",
        severity: "error",
        code: "TEST",
        position: {
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 5,
          offset: 0,
        },
      };
      const range = validationPositionToRange(issue);
      expect(range.start.line).toBe(0);
      expect(range.start.character).toBe(0);
      expect(range.end.line).toBe(0);
      expect(range.end.character).toBe(4);
    });

    it("handles multi-line range", () => {
      const issue: ValidationError = {
        message: "test",
        severity: "error",
        code: "TEST",
        position: {
          startLine: 1,
          startColumn: 10,
          endLine: 3,
          endColumn: 5,
          offset: 0,
        },
      };
      const range = validationPositionToRange(issue);
      expect(range.start.line).toBe(0);
      expect(range.start.character).toBe(9);
      expect(range.end.line).toBe(2);
      expect(range.end.character).toBe(4);
    });

    it("ensures minimum range of 1 character on same line", () => {
      const issue: ValidationError = {
        message: "test",
        severity: "error",
        code: "TEST",
        position: {
          startLine: 1,
          startColumn: 5,
          endLine: 1,
          endColumn: 5,
          offset: 0,
        },
      };
      const range = validationPositionToRange(issue);
      expect(range.start.character).toBe(4);
      expect(range.end.character).toBe(5);
    });
  });

  describe("toDiagnostic", () => {
    it("converts ValidationError to LSP Diagnostic", () => {
      const issue: ValidationError = {
        message: "Unknown column 'foo'",
        severity: "error",
        code: "SQL007",
        position: {
          startLine: 1,
          startColumn: 8,
          endLine: 1,
          endColumn: 11,
          offset: 0,
        },
      };
      const diagnostic = toDiagnostic(issue);

      expect(diagnostic.message).toBe("SQL007: Unknown column 'foo'");
      expect(diagnostic.severity).toBe(DiagnosticSeverity.Error);
      expect(diagnostic.source).toBe("SQL LSP");
      expect(diagnostic.code).toBe("SQL007");
      expect(diagnostic.range.start.line).toBe(0);
      expect(diagnostic.range.start.character).toBe(7);
      expect(diagnostic.range.end.line).toBe(0);
      expect(diagnostic.range.end.character).toBe(10);
    });

    it("handles warning severity", () => {
      const issue: ValidationError = {
        message: "Unused alias",
        severity: "warning",
        code: "SQL018",
        position: {
          startLine: 2,
          startColumn: 1,
          endLine: 2,
          endColumn: 5,
          offset: 0,
        },
      };
      const diagnostic = toDiagnostic(issue);
      expect(diagnostic.severity).toBe(DiagnosticSeverity.Warning);
    });
  });

  describe("nextDiagnosticsGeneration", () => {
    it("returns 1 for first call on a URI", () => {
      const map = new Map<string, number>();
      const gen = nextDiagnosticsGeneration(map, "file://doc1");
      expect(gen).toBe(1);
      expect(map.get("file://doc1")).toBe(1);
    });

    it("increments on subsequent calls", () => {
      const map = new Map<string, number>();
      expect(nextDiagnosticsGeneration(map, "file://doc1")).toBe(1);
      expect(nextDiagnosticsGeneration(map, "file://doc1")).toBe(2);
      expect(nextDiagnosticsGeneration(map, "file://doc1")).toBe(3);
    });

    it("tracks URIs independently", () => {
      const map = new Map<string, number>();
      expect(nextDiagnosticsGeneration(map, "file://doc1")).toBe(1);
      expect(nextDiagnosticsGeneration(map, "file://doc2")).toBe(1);
      expect(nextDiagnosticsGeneration(map, "file://doc1")).toBe(2);
      expect(nextDiagnosticsGeneration(map, "file://doc2")).toBe(2);
      expect(nextDiagnosticsGeneration(map, "file://doc3")).toBe(1);
    });
  });

  describe("isDiagnosticsSuperseded", () => {
    it("returns false when generation and version match", () => {
      const map = new Map<string, number>();
      map.set("file://doc1", 5);

      expect(
        isDiagnosticsSuperseded(map, "file://doc1", 5, 10, 10),
      ).toBe(false);
    });

    it("returns true when generation was incremented (newer call started)", () => {
      const map = new Map<string, number>();
      map.set("file://doc1", 6);

      expect(
        isDiagnosticsSuperseded(map, "file://doc1", 5, 10, 10),
      ).toBe(true);
    });

    it("returns true when document version changed", () => {
      const map = new Map<string, number>();
      map.set("file://doc1", 5);

      expect(
        isDiagnosticsSuperseded(map, "file://doc1", 5, 11, 10),
      ).toBe(true);
    });

    it("returns true when URI is not in map (was cleaned up)", () => {
      const map = new Map<string, number>();

      expect(
        isDiagnosticsSuperseded(map, "file://doc1", 5, 10, 10),
      ).toBe(true);
    });

    it("returns true when both generation and version are stale", () => {
      const map = new Map<string, number>();
      map.set("file://doc1", 7);

      expect(
        isDiagnosticsSuperseded(map, "file://doc1", 5, 12, 10),
      ).toBe(true);
    });

    it("simulates race condition: older call detects supersession", () => {
      const map = new Map<string, number>();

      const gen1 = nextDiagnosticsGeneration(map, "file://doc1");
      expect(gen1).toBe(1);

      const gen2 = nextDiagnosticsGeneration(map, "file://doc1");
      expect(gen2).toBe(2);

      expect(
        isDiagnosticsSuperseded(map, "file://doc1", gen1, 10, 10),
      ).toBe(true);

      expect(
        isDiagnosticsSuperseded(map, "file://doc1", gen2, 10, 10),
      ).toBe(false);
    });

    it("simulates race condition: version change during async work", () => {
      const map = new Map<string, number>();
      const gen = nextDiagnosticsGeneration(map, "file://doc1");

      expect(
        isDiagnosticsSuperseded(map, "file://doc1", gen, 10, 10),
      ).toBe(false);

      expect(
        isDiagnosticsSuperseded(map, "file://doc1", gen, 11, 10),
      ).toBe(true);
    });

    it("simulates onDidClose cleanup: deleted URI causes supersession", () => {
      const map = new Map<string, number>();
      const gen = nextDiagnosticsGeneration(map, "file://doc1");

      expect(
        isDiagnosticsSuperseded(map, "file://doc1", gen, 10, 10),
      ).toBe(false);

      map.delete("file://doc1");

      expect(
        isDiagnosticsSuperseded(map, "file://doc1", gen, 10, 10),
      ).toBe(true);
    });
  });
});
