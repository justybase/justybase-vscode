jest.unmock("chevrotain");

import {
  CompletionItem,
  CompletionItemKind,
  CompletionTriggerKind,
  Position,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ensureBuiltInDialectsRegistered } from "../dialects";
import {
  __TEST_ONLY_resetDatabaseDialectRegistry,
  registerDatabaseDialect,
} from "../core/factories/databaseDialectRegistry";
import {
  LspCompletionEngine,
  type CompletionMetadataProvider,
} from "../server/completionEngine";
import { DocumentParseSession } from "../sqlParser/documentParseSession";
import * as parsingRuntime from "../sqlParser/parsingRuntime";
import type { DatabaseKind } from "../contracts/database";
import type { MetadataColumnItem, MetadataObjectItem } from "../lsp/protocol";
import { db2Dialect } from "../../extensions/db2/src/db2Dialect";
import { mssqlDialect } from "../../extensions/mssql/src/mssqlDialect";
import { postgresqlDialect } from "../../extensions/postgresql/src/postgresqlDialect";
import { mysqlDialect } from "../../extensions/mysql/src/mysqlDialect";
import { snowflakeDialect } from "../../extensions/snowflake/src/snowflakeDialect";
import { oracleDialect } from "../../extensions/oracle/src/oracleDialect";
import { duckdbDialect } from "../../extensions/duckdb/src/duckdbDialect";
import { verticaDialect } from "../../extensions/vertica/src/verticaDialect";

class MockCompletionMetadataProvider implements CompletionMetadataProvider {
  public effectiveDatabase: string | undefined = "BAZA";
  public effectiveSchema: string | undefined = undefined;
  public netezzaSchemasEnabled: boolean | undefined = undefined;
  public databaseKind: DatabaseKind = "netezza";

  private readonly databases = ["BAZA", "JUST_DATA"];
  private readonly schemasByDb = new Map<string, string[]>();
  private readonly tablesByDbSchema = new Map<string, string[]>();
  private readonly viewsByDbSchema = new Map<string, string[]>();
  private readonly proceduresByDbSchema = new Map<string, string[]>();
  private readonly columnsByTable = new Map<string, string[]>();

  readonly getContext = jest.fn(async (_documentUri: string) => ({
    effectiveDatabase: this.effectiveDatabase,
    effectiveSchema: this.effectiveSchema,
    databaseKind: this.databaseKind,
    netezzaSchemasEnabled: this.netezzaSchemasEnabled,
  }));

  readonly getDatabases = jest.fn(
    async (_documentUri: string): Promise<MetadataObjectItem[]> => {
      return this.databases.map((name) => ({ name, detail: "Database" }));
    },
  );

  readonly getSchemas = jest.fn(
    async (
      _documentUri: string,
      database: string,
    ): Promise<MetadataObjectItem[]> => {
      return this.getNames(this.schemasByDb, database).map((name) => ({
        name,
        database: this.normalize(database),
        detail: "Schema",
      }));
    },
  );

  readonly getTables = jest.fn(
    async (
      _documentUri: string,
      database: string,
      schema?: string,
    ): Promise<MetadataObjectItem[]> => {
      return this.getNames(this.tablesByDbSchema, database, schema).map(
        (name) => ({
          name,
          database: this.normalize(database),
          schema: schema ? this.normalize(schema) : undefined,
          objectType: "table",
          detail: "Table",
        }),
      );
    },
  );

  readonly getViews = jest.fn(
    async (
      _documentUri: string,
      database: string,
      schema?: string,
    ): Promise<MetadataObjectItem[]> => {
      return this.getNames(this.viewsByDbSchema, database, schema).map(
        (name) => ({
          name,
          database: this.normalize(database),
          schema: schema ? this.normalize(schema) : undefined,
          objectType: "view",
          detail: "View",
        }),
      );
    },
  );

  readonly getProcedures = jest.fn(
    async (
      _documentUri: string,
      database: string,
      schema?: string,
    ): Promise<MetadataObjectItem[]> => {
      return this.getNames(this.proceduresByDbSchema, database, schema).map(
        (name) => ({
          name,
          database: this.normalize(database),
          schema: schema ? this.normalize(schema) : undefined,
          objectType: "procedure",
          detail: "Procedure",
        }),
      );
    },
  );

  readonly getColumns = jest.fn(
    async (
      _documentUri: string,
      database: string,
      table: string,
      schema?: string,
    ): Promise<MetadataColumnItem[]> => {
      const names = this.getColumnsByPath(database, table, schema);
      return names.map((name) => ({ name, type: "VARCHAR" }));
    },
  );

  readonly getNetezzaDefaultSchema = jest.fn(
    async (_documentUri: string, database: string): Promise<string | undefined> => {
      return this.defaultSchemaByDatabase.get(this.normalize(database));
    },
  );

  private readonly defaultSchemaByDatabase = new Map<string, string>();

  constructor() {
    this.seedDefaultMetadata();
  }

  public setColumns(
    database: string,
    table: string,
    columns: string[],
    schema?: string,
  ): void {
    this.columnsByTable.set(this.columnKey(database, table, schema), [
      ...columns,
    ]);
  }

  public setDefaultSchema(database: string, schema: string): void {
    this.defaultSchemaByDatabase.set(this.normalize(database), schema);
  }

  public setSchemas(database: string, schemas: string[]): void {
    this.schemasByDb.set(this.objectKey(database), [...schemas]);
  }

  public setTables(database: string, tables: string[], schema?: string): void {
    this.tablesByDbSchema.set(this.objectKey(database, schema), [...tables]);
  }

  public setViews(database: string, views: string[], schema?: string): void {
    this.viewsByDbSchema.set(this.objectKey(database, schema), [...views]);
  }

  private seedDefaultMetadata(): void {
    this.schemasByDb.set(this.objectKey("BAZA"), ["PUBLIC", "ADMIN"]);
    this.schemasByDb.set(this.objectKey("JUST_DATA"), ["PUBLIC", "ADMIN"]);

    this.tablesByDbSchema.set(this.objectKey("BAZA"), [
      "USERS",
      "ORDERS",
      "DEPT",
    ]);
    this.tablesByDbSchema.set(this.objectKey("JUST_DATA"), [
      "DIMACCOUNT",
      "DIMDATE",
      "DIMEMPLOYEE",
      "FACTPRODUCTINVENTORY",
      "VASSOCSEQLINEITEMS",
    ]);
    this.tablesByDbSchema.set(this.objectKey("JUST_DATA", "ADMIN"), [
      "DEPARTMENT",
    ]);

    this.viewsByDbSchema.set(this.objectKey("BAZA"), ["EMPLOYEE_V"]);
    this.viewsByDbSchema.set(this.objectKey("JUST_DATA"), [
      "V_SALES",
      "EMPLOYEE_V",
    ]);
    this.viewsByDbSchema.set(this.objectKey("JUST_DATA", "ADMIN"), [
      "V_SALES",
      "EMPLOYEE_V",
    ]);

    this.proceduresByDbSchema.set(this.objectKey("BAZA"), ["MY_PROC"]);
    this.proceduresByDbSchema.set(this.objectKey("JUST_DATA"), [
      "MY_PROC",
      "SP_LOAD",
    ]);
    this.proceduresByDbSchema.set(this.objectKey("JUST_DATA", "ADMIN"), [
      "MY_PROC",
      "SP_LOAD",
    ]);

    this.setColumns("BAZA", "USERS", ["ID", "USER_ID", "USERNAME"]);
    this.setColumns("BAZA", "ORDERS", ["ID", "ORDER_ID", "USER_ID"]);
    this.setColumns("BAZA", "DEPT", ["ID"]);

    this.setColumns("JUST_DATA", "DIMACCOUNT", [
      "ACCOUNTKEY",
      "ACCOUNTCODEALTERNATEKEY",
      "ACCOUNTNAME",
      "OPERATOR",
      "CUSTOMMEMBERS",
    ]);
    this.setColumns("JUST_DATA", "DIMDATE", ["DATEKEY", "CALENDARQUARTER"]);
    this.setColumns("JUST_DATA", "DIMEMPLOYEE", ["EMPLOYEEKEY", "BASERATE"]);
    this.setColumns("JUST_DATA", "FACTPRODUCTINVENTORY", ["PRODUCTKEY"]);
    this.setColumns("JUST_DATA", "VASSOCSEQLINEITEMS", ["LINENUMBER"]);
    this.setColumns(
      "JUST_DATA",
      "DEPARTMENT",
      ["ID", "DEPARTMENT_ID", "NAME"],
      "ADMIN",
    );
  }

  private normalize(value: string): string {
    return value.replace(/^"|"$/g, "").trim().toUpperCase();
  }

  private objectKey(database: string, schema?: string): string {
    return `${this.normalize(database)}|${this.normalize(schema || "")}`;
  }

  private columnKey(database: string, table: string, schema?: string): string {
    return `${this.normalize(database)}|${this.normalize(schema || "")}|${this.normalize(table)}`;
  }

  private getNames(
    source: Map<string, string[]>,
    database: string,
    schema?: string,
  ): string[] {
    const exact = source.get(this.objectKey(database, schema));
    if (exact) {
      return [...exact];
    }
    if (schema) {
      return [];
    }
    const fallback = source.get(this.objectKey(database));
    return fallback ? [...fallback] : [];
  }

  private getColumnsByPath(
    database: string,
    table: string,
    schema?: string,
  ): string[] {
    const exact = this.columnsByTable.get(
      this.columnKey(database, table, schema),
    );
    if (exact) {
      return [...exact];
    }
    if (schema) {
      const fallbackNoSchema = this.columnsByTable.get(
        this.columnKey(database, table),
      );
      if (fallbackNoSchema) {
        return [...fallbackNoSchema];
      }
    }
    if (!schema) {
      const prefix = `${this.normalize(database)}|`;
      const suffix = `|${this.normalize(table)}`;
      for (const [key, columns] of this.columnsByTable.entries()) {
        if (key.startsWith(prefix) && key.endsWith(suffix)) {
          return [...columns];
        }
      }
    }
    return this.columnsByTable.get(this.columnKey(database, table)) ?? [];
  }
}

class StrictCaseMetadataProvider implements CompletionMetadataProvider {
  public effectiveDatabase: string | undefined;
  public effectiveSchema: string | undefined;
  public databaseKind: DatabaseKind;

  private readonly columnsByTable = new Map<string, string[]>();

  readonly getContext = jest.fn(async (_documentUri: string) => ({
    effectiveDatabase: this.effectiveDatabase,
    effectiveSchema: this.effectiveSchema,
    databaseKind: this.databaseKind,
  }));

  readonly getDatabases = jest.fn(
    async (_documentUri: string): Promise<MetadataObjectItem[]> => [],
  );

  readonly getSchemas = jest.fn(
    async (
      _documentUri: string,
      _database: string,
    ): Promise<MetadataObjectItem[]> => [],
  );

  readonly getTables = jest.fn(
    async (
      _documentUri: string,
      _database: string,
      _schema?: string,
    ): Promise<MetadataObjectItem[]> => [],
  );

  readonly getViews = jest.fn(
    async (
      _documentUri: string,
      _database: string,
      _schema?: string,
    ): Promise<MetadataObjectItem[]> => [],
  );

  readonly getProcedures = jest.fn(
    async (
      _documentUri: string,
      _database: string,
      _schema?: string,
    ): Promise<MetadataObjectItem[]> => [],
  );

  readonly getColumns = jest.fn(
    async (
      _documentUri: string,
      database: string,
      table: string,
      schema?: string,
    ): Promise<MetadataColumnItem[]> => {
      const names =
        this.columnsByTable.get(this.columnKey(database, table, schema)) ?? [];
      return names.map((name) => ({ name, type: "VARCHAR" }));
    },
  );

  constructor(
    databaseKind: DatabaseKind,
    effectiveDatabase?: string,
    effectiveSchema?: string,
  ) {
    this.databaseKind = databaseKind;
    this.effectiveDatabase = effectiveDatabase;
    this.effectiveSchema = effectiveSchema;
  }

  public setColumns(
    database: string,
    table: string,
    columns: string[],
    schema?: string,
  ): void {
    this.columnsByTable.set(this.columnKey(database, table, schema), [
      ...columns,
    ]);
  }

  private columnKey(database: string, table: string, schema?: string): string {
    return `${database}|${schema || ""}|${table}`;
  }
}

function createDocumentWithCursor(sqlWithCursor: string): {
  document: TextDocument;
  position: Position;
} {
  const cursorOffset = sqlWithCursor.indexOf("|");
  if (cursorOffset < 0) {
    throw new Error('Missing cursor marker "|"');
  }

  const sql = `${sqlWithCursor.slice(0, cursorOffset)}${sqlWithCursor.slice(cursorOffset + 1)}`;
  const document = TextDocument.create(
    "file:///completion-engine.sql",
    "sql",
    1,
    sql,
  );
  return {
    document,
    position: document.positionAt(cursorOffset),
  };
}

function labels(items: CompletionItem[]): string[] {
  return items.map((item) => item.label);
}

function labelsWithoutExpand(items: CompletionItem[]): string[] {
  return labels(items).filter((label) => label !== "* (Expand Columns)");
}

async function completeWithEngine(
  engine: LspCompletionEngine,
  sqlWithCursor: string,
  triggerKind: CompletionTriggerKind = CompletionTriggerKind.Invoked,
): Promise<CompletionItem[]> {
  const { document, position } = createDocumentWithCursor(sqlWithCursor);
  return engine.provideCompletionItems(document, position, triggerKind);
}

describe("LspCompletionEngine", () => {
  let metadataProvider: MockCompletionMetadataProvider;
  let engine: LspCompletionEngine;

  async function complete(
    sqlWithCursor: string,
    triggerKind: CompletionTriggerKind = CompletionTriggerKind.Invoked,
  ): Promise<CompletionItem[]> {
    const { document, position } = createDocumentWithCursor(sqlWithCursor);
    return engine.provideCompletionItems(document, position, triggerKind);
  }

  beforeEach(() => {
    ensureBuiltInDialectsRegistered();
    registerDatabaseDialect(db2Dialect);
    registerDatabaseDialect(mssqlDialect);
    registerDatabaseDialect(postgresqlDialect);
    registerDatabaseDialect(mysqlDialect);
    registerDatabaseDialect(snowflakeDialect);
    registerDatabaseDialect(oracleDialect);
    registerDatabaseDialect(duckdbDialect);
    registerDatabaseDialect(verticaDialect);
    metadataProvider = new MockCompletionMetadataProvider();
    engine = new LspCompletionEngine(metadataProvider);
  });

  describe("object path and target-context completions", () => {
    it("returns tables for schema dot completion in FROM context", async () => {
      metadataProvider.setTables("BAZA", ["ORDERS_TBL"], "ADMIN");
      const items = await complete("SELECT * FROM ADMIN.|");
      expect(labels(items)).toContain("ORDERS_TBL");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
        "ADMIN",
      );
      expect(metadataProvider.getSchemas).not.toHaveBeenCalledWith(
        expect.any(String),
        "ADMIN",
      );
    });

    it("returns schemas for known database dot completion in FROM context", async () => {
      const items = await complete("SELECT * FROM JUST_DATA.|");
      expect(labels(items)).toEqual(
        expect.arrayContaining(["PUBLIC", "ADMIN"]),
      );
      expect(metadataProvider.getSchemas).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
      );
      expect(metadataProvider.getTables).not.toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
        "JUST_DATA",
      );
    });

    it("returns schemas for known database dot completion inside multiline CTE FROM clause", async () => {
      const items = await complete(`WITH CTE1 AS (
    SELECT * FROM
        JUST_DATA.|
)
SELECT * FROM CTE1`);
      expect(labels(items)).toEqual(
        expect.arrayContaining(["PUBLIC", "ADMIN"]),
      );
      expect(metadataProvider.getSchemas).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
      );
    });

    it("returns tables for schema dot completion inside multiline CTE FROM clause", async () => {
      metadataProvider.setTables("BAZA", ["ORDERS_TBL"], "ADMIN");
      const items = await complete(`WITH CTE1 AS (
    SELECT * FROM
        ADMIN.|
)
SELECT * FROM CTE1`);
      expect(labels(items)).toContain("ORDERS_TBL");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
        "ADMIN",
      );
      expect(metadataProvider.getSchemas).not.toHaveBeenCalledWith(
        expect.any(String),
        "ADMIN",
      );
    });

    it("returns tables for schema dot completion in CREATE TEMP TABLE AS SELECT", async () => {
      metadataProvider.setTables("BAZA", ["ORDERS_TBL"], "ADMIN");
      await complete("CREATE TEMP TABLE TMP_X AS SELECT * FROM ADMIN.|");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
        "ADMIN",
      );
      expect(metadataProvider.getSchemas).not.toHaveBeenCalledWith(
        expect.any(String),
        "ADMIN",
      );
    });

    it("returns tables for DB.SCHEMA dot completion in CREATE TABLE AS SELECT", async () => {
      const items = await complete(
        "CREATE TABLE TMP_X AS SELECT * FROM JUST_DATA.ADMIN.|",
      );
      expect(labels(items)).toContain("DEPARTMENT");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "ADMIN",
      );
    });

    it("returns SQLite tables for catalog dot completion", async () => {
      metadataProvider.databaseKind = "sqlite";
      metadataProvider.effectiveDatabase = "main";
      metadataProvider.setTables("main", ["sales", "stock", "suppliers"]);

      const items = await complete("SELECT * FROM main.s|");

      expect(labels(items)).toEqual(
        expect.arrayContaining(["sales", "stock", "suppliers"]),
      );
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "main",
      );
    });

    it("returns DB2 tables for schema dot completion using the effective database", async () => {
      metadataProvider.databaseKind = "db2";
      metadataProvider.effectiveDatabase = "TESTDB";
      metadataProvider.setTables(
        "TESTDB",
        ["EMPLOYEES", "EMP_AUDIT"],
        "DB2INST1",
      );

      const items = await complete("SELECT * FROM DB2INST1.E|");

      expect(labels(items)).toEqual(
        expect.arrayContaining(["EMPLOYEES", "EMP_AUDIT"]),
      );
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
        "DB2INST1",
      );
      expect(metadataProvider.getSchemas).not.toHaveBeenCalled();
    });

    it("returns PostgreSQL tables for schema dot completion using the effective database", async () => {
      metadataProvider.databaseKind = "postgresql";
      metadataProvider.effectiveDatabase = "APPDB";
      metadataProvider.setTables("APPDB", ["orders", "order_items"], "public");

      const items = await complete("SELECT * FROM public.o|");

      expect(labels(items)).toEqual(
        expect.arrayContaining(["orders", "order_items"]),
      );
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "APPDB",
        "public",
      );
      expect(metadataProvider.getSchemas).not.toHaveBeenCalled();
    });

    it("returns PostgreSQL tables and views for schema dot completion in FROM clauses", async () => {
      metadataProvider.databaseKind = "postgresql";
      metadataProvider.effectiveDatabase = "APPDB";
      metadataProvider.setTables("APPDB", ["orders"], "public");
      metadataProvider.setViews("APPDB", ["v_order_summary"], "public");

      const items = await complete("SELECT * FROM public.|");

      expect(labels(items)).toEqual(
        expect.arrayContaining(["orders", "v_order_summary"]),
      );
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "APPDB",
        "public",
      );
      expect(metadataProvider.getViews).toHaveBeenCalledWith(
        expect.any(String),
        "APPDB",
        "public",
      );
    });

    it("returns PostgreSQL schemas in root FROM suggestions", async () => {
      metadataProvider.databaseKind = "postgresql";
      metadataProvider.effectiveDatabase = "APPDB";
      metadataProvider.setSchemas("APPDB", ["public", "sales"]);

      const items = await complete("SELECT * FROM pu|");

      expect(labels(items)).toEqual(expect.arrayContaining(["public"]));
      expect(metadataProvider.getSchemas).toHaveBeenCalledWith(
        expect.any(String),
        "APPDB",
      );
    });

    it("keeps PostgreSQL keyword completions dialect-specific when the runtime companion is registered", async () => {
      metadataProvider.databaseKind = "postgresql";
      metadataProvider.effectiveDatabase = "APPDB";

      const items = await complete("|");
      const upperLabels = labels(items).map((label) => label.toUpperCase());

      expect(upperLabels).toContain("ON CONFLICT");
      expect(upperLabels).toContain("RETURNING");
      expect(upperLabels).not.toContain("GROOM");
    });

    it("keeps PostgreSQL keyword completions available without runtime dialect registration", async () => {
      __TEST_ONLY_resetDatabaseDialectRegistry();
      ensureBuiltInDialectsRegistered();
      metadataProvider.databaseKind = "postgresql";
      metadataProvider.effectiveDatabase = "APPDB";

      const items = await complete("|");
      const upperLabels = labels(items).map((label) => label.toUpperCase());

      expect(upperLabels).toContain("ON CONFLICT");
      expect(upperLabels).toContain("RETURNING");
      expect(upperLabels).not.toContain("GROOM");
    });

    it("keeps Oracle keyword completions available without runtime dialect registration", async () => {
      __TEST_ONLY_resetDatabaseDialectRegistry();
      ensureBuiltInDialectsRegistered();
      metadataProvider.databaseKind = "oracle";
      metadataProvider.effectiveDatabase = "ORCL";

      const items = await complete("|");
      const upperLabels = labels(items).map((label) => label.toUpperCase());

      expect(upperLabels).toContain("CONNECT BY");
      expect(upperLabels).toContain("DUAL");
      expect(upperLabels).not.toContain("GROOM");
    });

    it("completes Oracle PL/SQL parameters and local variables", async () => {
      metadataProvider.databaseKind = "oracle";
      metadataProvider.effectiveDatabase = "ORCL";

      const items = await complete(`CREATE OR REPLACE FUNCTION F(P_AMOUNT IN NUMBER)
RETURN NUMBER IS
  V_TOTAL NUMBER;
BEGIN
  V_TOTAL := P_AMOUNT;
  RETURN |;
END;`);

      expect(items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          label: "V_TOTAL",
          kind: CompletionItemKind.Variable,
        }),
        expect.objectContaining({
          label: "P_AMOUNT",
          kind: CompletionItemKind.Variable,
        }),
      ]));
    });

    it("returns DB2 tables for schema dot completion even when no partial object name is typed yet", async () => {
      metadataProvider.databaseKind = "db2";
      metadataProvider.effectiveDatabase = "TESTDB";
      metadataProvider.setTables(
        "TESTDB",
        ["EMPLOYEES", "EMP_AUDIT"],
        "DB2INST1",
      );
      metadataProvider.setViews("TESTDB", ["EMP_VIEW"], "DB2INST1");

      const items = await complete("SELECT * FROM DB2INST1.|");

      expect(labels(items)).toEqual(
        expect.arrayContaining(["EMPLOYEES", "EMP_AUDIT", "EMP_VIEW"]),
      );
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
        "DB2INST1",
      );
      expect(metadataProvider.getViews).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
        "DB2INST1",
      );
    });

    it("returns DB2 tables for db.schema dot completion", async () => {
      metadataProvider.databaseKind = "db2";
      metadataProvider.effectiveDatabase = "TESTDB";
      metadataProvider.setTables(
        "TESTDB",
        ["EMPLOYEES", "EMP_AUDIT"],
        "DB2INST1",
      );

      const items = await complete("SELECT * FROM TESTDB.DB2INST1.|");

      expect(labels(items)).toEqual(
        expect.arrayContaining(["EMPLOYEES", "EMP_AUDIT"]),
      );
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
        "DB2INST1",
      );
      expect(metadataProvider.getSchemas).not.toHaveBeenCalled();
    });

    it("does not treat DB2 double-dot notation as a valid table path", async () => {
      metadataProvider.databaseKind = "db2";
      metadataProvider.effectiveDatabase = "TESTDB";
      metadataProvider.setTables("TESTDB", ["EMPLOYEES"], "DB2INST1");

      const items = await complete("SELECT * FROM DB2INST1..E|");

      expect(labels(items)).not.toContain("EMPLOYEES");
      expect(metadataProvider.getTables).not.toHaveBeenCalled();
      expect(metadataProvider.getSchemas).not.toHaveBeenCalled();
    });

    it("returns DB2 schemas for db dot completion when qualifier matches the database name", async () => {
      metadataProvider.databaseKind = "db2";
      metadataProvider.effectiveDatabase = "TESTDB";
      metadataProvider.setSchemas("TESTDB", ["DB2INST1", "HR"]);

      const items = await complete("SELECT * FROM TESTDB.|");

      expect(labels(items)).toEqual(expect.arrayContaining(["DB2INST1", "HR"]));
      expect(metadataProvider.getSchemas).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
      );
    });

    it("returns DB2 tables for db.schema partial completion", async () => {
      metadataProvider.databaseKind = "db2";
      metadataProvider.effectiveDatabase = "TESTDB";
      metadataProvider.setTables(
        "TESTDB",
        ["EMPLOYEES", "EMP_AUDIT"],
        "DB2INST1",
      );
      metadataProvider.setViews("TESTDB", ["EMP_VIEW"], "DB2INST1");

      const items = await complete("SELECT * FROM TESTDB.DB2INST1.E|");

      expect(labels(items)).toEqual(
        expect.arrayContaining(["EMPLOYEES", "EMP_AUDIT", "EMP_VIEW"]),
      );
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
        "DB2INST1",
      );
      expect(metadataProvider.getViews).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
        "DB2INST1",
      );
    });

    it("returns MSSQL schemas for db dot completion when qualifier matches the database name", async () => {
      metadataProvider.databaseKind = "mssql";
      metadataProvider.effectiveDatabase = "TESTDB";
      metadataProvider.setSchemas("TESTDB", ["dbo", "HR"]);

      const items = await complete("SELECT * FROM TESTDB.|");

      expect(labels(items)).toEqual(expect.arrayContaining(["dbo", "HR"]));
      expect(metadataProvider.getSchemas).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
      );
    });

    it("returns MSSQL schemas for db dot completion without relying on active database context", async () => {
      metadataProvider.databaseKind = "mssql";
      metadataProvider.effectiveDatabase = undefined;
      metadataProvider.setSchemas("TESTDB", ["dbo", "HR"]);

      const items = await complete("SELECT * FROM TESTDB.|");

      expect(labels(items)).toEqual(expect.arrayContaining(["dbo", "HR"]));
      expect(metadataProvider.getSchemas).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
      );
    });

    it("returns MSSQL schemas for bracket-quoted db dot completion", async () => {
      metadataProvider.databaseKind = "mssql";
      metadataProvider.effectiveDatabase = undefined;
      metadataProvider.setSchemas("TESTDB", ["dbo", "HR"]);

      const items = await complete("SELECT * FROM [TESTDB].|");

      expect(labels(items)).toEqual(expect.arrayContaining(["dbo", "HR"]));
      expect(metadataProvider.getSchemas).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
      );
    });

    it("returns MSSQL dbo fallback for db dot completion on trigger-character invocation when schema discovery is empty", async () => {
      metadataProvider.databaseKind = "mssql";
      metadataProvider.effectiveDatabase = "TESTDB";

      const items = await complete(
        "SELECT * FROM TESTDB.|",
        CompletionTriggerKind.TriggerCharacter,
      );

      expect(labels(items)).toContain("dbo");
      expect(metadataProvider.getSchemas).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
      );
    });

    it("returns MSSQL tables for db.schema dot completion", async () => {
      metadataProvider.databaseKind = "mssql";
      metadataProvider.effectiveDatabase = "TESTDB";
      metadataProvider.setTables("TESTDB", ["EMPLOYEES", "DEPARTMENTS"], "dbo");
      metadataProvider.setViews("TESTDB", ["V_EMPLOYEES"], "dbo");

      const items = await complete("SELECT * FROM TESTDB.dbo.|");

      expect(labels(items)).toEqual(
        expect.arrayContaining(["EMPLOYEES", "DEPARTMENTS", "V_EMPLOYEES"]),
      );
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
        "dbo",
      );
      expect(metadataProvider.getViews).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
        "dbo",
      );
    });

    it("returns MSSQL tables for db.. double-dot completion", async () => {
      metadataProvider.databaseKind = "mssql";
      metadataProvider.effectiveDatabase = "TESTDB";
      metadataProvider.setTables("TESTDB", ["EMPLOYEES", "DEPARTMENTS"]);

      const items = await complete("SELECT * FROM TESTDB..|");

      expect(labels(items)).toEqual(
        expect.arrayContaining(["EMPLOYEES", "DEPARTMENTS"]),
      );
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
      );
    });

    it("returns tables for schema dot completion in CREATE OR REPLACE TABLE target", async () => {
      metadataProvider.setTables("BAZA", ["ORDERS_TBL"], "ADMIN");
      await complete("CREATE OR REPLACE TABLE ADMIN.|");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
        "ADMIN",
      );
      expect(metadataProvider.getSchemas).not.toHaveBeenCalledWith(
        expect.any(String),
        "ADMIN",
      );
    });

    it("returns tables for DB.. completion in CTE FROM clause", async () => {
      const items = await complete(`WITH CTE1 AS (
    SELECT * FROM JUST_DATA..|
)
SELECT * FROM CTE1`);
      expect(labels(items)).toEqual(
        expect.arrayContaining(["DIMACCOUNT", "DIMDATE", "DIMEMPLOYEE"]),
      );
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
      );
    });

    it("returns database/table suggestions for UPDATE target table", async () => {
      const items = await complete("UPDATE |");
      expect(labels(items)).toEqual(
        expect.arrayContaining(["BAZA", "JUST_DATA", "USERS", "ORDERS"]),
      );
      expect(metadataProvider.getDatabases).toHaveBeenCalled();
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
      );
    });

    it("returns tables for schema dot completion in UPDATE target", async () => {
      metadataProvider.setTables("BAZA", ["ORDERS_TBL"], "ADMIN");
      await complete("UPDATE ADMIN.|");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
        "ADMIN",
      );
      expect(metadataProvider.getSchemas).not.toHaveBeenCalledWith(
        expect.any(String),
        "ADMIN",
      );
    });

    it("returns tables for DB.SCHEMA dot completion in UPDATE target", async () => {
      const items = await complete("UPDATE JUST_DATA.ADMIN.|");
      expect(labels(items)).toContain("DEPARTMENT");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "ADMIN",
      );
    });

    it("returns tables for schema dot completion in DROP TABLE target", async () => {
      metadataProvider.setTables("BAZA", ["ORDERS_TBL"], "ADMIN");
      await complete("DROP TABLE ADMIN.|");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
        "ADMIN",
      );
      expect(metadataProvider.getSchemas).not.toHaveBeenCalledWith(
        expect.any(String),
        "ADMIN",
      );
    });

    it("returns views for schema dot completion in DROP VIEW target", async () => {
      metadataProvider.setViews("BAZA", ["ADMIN_V"], "ADMIN");
      await complete("DROP VIEW ADMIN.|");
      expect(metadataProvider.getViews).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
        "ADMIN",
      );
      expect(metadataProvider.getSchemas).not.toHaveBeenCalledWith(
        expect.any(String),
        "ADMIN",
      );
    });

    it("returns only views for DROP VIEW target name completion", async () => {
      const items = await complete("DROP VIEW |");
      expect(labels(items)).toContain("EMPLOYEE_V");
      expect(labels(items)).not.toContain("USERS");
      expect(metadataProvider.getViews).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
      );
      expect(metadataProvider.getTables).not.toHaveBeenCalled();
    });

    it("returns only views for DB.SCHEMA dot completion in DROP VIEW target", async () => {
      const items = await complete("DROP VIEW JUST_DATA.ADMIN.|");
      expect(labels(items)).toContain("EMPLOYEE_V");
      expect(metadataProvider.getViews).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "ADMIN",
      );
      expect(metadataProvider.getTables).not.toHaveBeenCalled();
    });

    it("returns database and view suggestions for CREATE VIEW target", async () => {
      const items = await complete("CREATE VIEW |");
      expect(labels(items)).toEqual(
        expect.arrayContaining(["BAZA", "JUST_DATA", "EMPLOYEE_V"]),
      );
      expect(metadataProvider.getDatabases).toHaveBeenCalled();
      expect(metadataProvider.getViews).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
      );
      expect(metadataProvider.getTables).not.toHaveBeenCalled();
    });

    it("returns views for schema dot completion in CREATE VIEW target", async () => {
      metadataProvider.setViews("BAZA", ["ADMIN_V"], "ADMIN");
      await complete("CREATE VIEW ADMIN.|");
      expect(metadataProvider.getViews).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
        "ADMIN",
      );
      expect(metadataProvider.getSchemas).not.toHaveBeenCalledWith(
        expect.any(String),
        "ADMIN",
      );
      expect(metadataProvider.getTables).not.toHaveBeenCalled();
    });

    it("returns only views for DB.SCHEMA dot completion in CREATE OR REPLACE VIEW target", async () => {
      const items = await complete("CREATE OR REPLACE VIEW JUST_DATA.ADMIN.|");
      expect(labels(items)).toEqual(
        expect.arrayContaining(["V_SALES", "EMPLOYEE_V"]),
      );
      expect(metadataProvider.getViews).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "ADMIN",
      );
      expect(metadataProvider.getTables).not.toHaveBeenCalled();
    });

    it("returns database/procedure suggestions for DROP PROCEDURE target", async () => {
      const items = await complete("DROP PROCEDURE |");
      expect(labels(items)).toEqual(
        expect.arrayContaining(["BAZA", "JUST_DATA", "MY_PROC"]),
      );
      expect(metadataProvider.getDatabases).toHaveBeenCalled();
      expect(metadataProvider.getProcedures).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
      );
    });

    it("returns procedures for DB.SCHEMA dot completion in DROP PROCEDURE target", async () => {
      const items = await complete("DROP PROCEDURE JUST_DATA.ADMIN.|");
      expect(labels(items)).toEqual(
        expect.arrayContaining(["MY_PROC", "SP_LOAD"]),
      );
      expect(metadataProvider.getProcedures).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "ADMIN",
      );
    });

    it("returns procedures for DB.SCHEMA dot completion in ALTER PROCEDURE target", async () => {
      const items = await complete("ALTER PROCEDURE JUST_DATA.ADMIN.|");
      expect(labels(items)).toEqual(
        expect.arrayContaining(["MY_PROC", "SP_LOAD"]),
      );
      expect(metadataProvider.getProcedures).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "ADMIN",
      );
    });

    it("returns tables for DB.SCHEMA dot completion in TRUNCATE TABLE target", async () => {
      const items = await complete("TRUNCATE TABLE JUST_DATA.ADMIN.|");
      expect(labels(items)).toContain("DEPARTMENT");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "ADMIN",
      );
    });

    it("returns database and table suggestions for CREATE SYNONYM FOR target", async () => {
      const items = await complete("CREATE SYNONYM DIMACCOUNT_XYZ2 FOR |");
      expect(labels(items)).toEqual(
        expect.arrayContaining(["BAZA", "JUST_DATA", "USERS", "ORDERS"]),
      );
      expect(metadataProvider.getDatabases).toHaveBeenCalled();
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
      );
    });

    it("returns default-scope tables for DB dot completion in CREATE SYNONYM FOR target", async () => {
      const items = await complete(
        "CREATE SYNONYM DIMACCOUNT_XYZ2 FOR JUST_DATA.|",
      );
      expect(labels(items)).toEqual(
        expect.arrayContaining(["DIMACCOUNT", "DIMDATE", "DIMEMPLOYEE"]),
      );
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
      );
      expect(metadataProvider.getSchemas).not.toHaveBeenCalled();
    });

    it("returns tables for bracket-prefixed DB dot completion in CREATE SYNONYM FOR target", async () => {
      const items = await complete(
        "CREATE SYNONYM DIMACCOUNT_XYZ2 FOR JUST_DATA.[DIM|",
      );
      expect(labels(items)).toEqual(
        expect.arrayContaining(["DIMACCOUNT", "DIMDATE", "DIMEMPLOYEE"]),
      );
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
      );
    });

    it("returns tables for DB.SCHEMA dot completion in CREATE SYNONYM FOR target", async () => {
      const items = await complete(
        "CREATE SYNONYM DIMACCOUNT_XYZ2 FOR JUST_DATA.ADMIN.|",
      );
      expect(labels(items)).toContain("DEPARTMENT");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "ADMIN",
      );
    });

    it("returns MSSQL schemas for db dot completion in CREATE SYNONYM FOR target", async () => {
      metadataProvider.databaseKind = "mssql";
      metadataProvider.effectiveDatabase = "TESTDB";
      metadataProvider.setSchemas("TESTDB", ["dbo", "HR"]);

      await complete("CREATE SYNONYM MySyn FOR TESTDB.|");

      expect(metadataProvider.getSchemas).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
      );
      expect(metadataProvider.getTables).not.toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
      );
    });
  });

  describe("alias and scope-aware column completions", () => {
    it("returns CTE columns from parser-based local definitions", async () => {
      const items = await complete(
        "WITH CTE AS (SELECT ID, NAME FROM USERS) SELECT * FROM CTE C WHERE C.|",
      );
      expect(labels(items)).toEqual(expect.arrayContaining(["ID", "NAME"]));
      expect(metadataProvider.getColumns).not.toHaveBeenCalled();
    });

    it("uses parser alias binding for metadata column completion", async () => {
      const items = await complete("SELECT * FROM BAZA..USERS U WHERE U.|");
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ID", "USER_ID", "USERNAME"]),
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
        "USERS",
      );
    });

    it("uses base table metadata for simple SELECT * subquery alias completion", async () => {
      const items = await complete(`SELECT F1.|
FROM (SELECT * FROM JUST_DATA..FACTPRODUCTINVENTORY LIMIT 5000) F1`);
      expect(labels(items)).toContain("PRODUCTKEY");
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "FACTPRODUCTINVENTORY",
      );
    });

    it("prevents CTE alias leakage between different CTE definitions (#6)", async () => {
      const items = await complete(`WITH ABC_1 AS (
    SELECT A.| FROM JUST_DATA..DIMACCOUNT A
),
ABC_2 AS (
    SELECT * FROM JUST_DATA..DIMDATE A
)
SELECT * FROM ABC_2 X`);
      const itemLabels = labels(items);
      expect(itemLabels).toContain("ACCOUNTKEY");
      expect(itemLabels).not.toContain("DATEKEY");
    });

    it("uses base table metadata for simple SELECT * CTE completion", async () => {
      const items = await complete(`WITH CTE_1 AS (
    SELECT A.* FROM JUST_DATA..DIMACCOUNT A
)
SELECT Y.| FROM CTE_1 Y`);
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTCODEALTERNATEKEY"]),
      );
    });

    it("supports alias column completion in CTE select list before FROM alias definition", async () => {
      const items = await complete(`WITH CTE1 AS (
    SELECT
        A.|
    FROM
        JUST_DATA..DIMACCOUNT A
)
SELECT * FROM CTE1 C1`);
      expect(labels(items)).toContain("ACCOUNTKEY");
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "DIMACCOUNT",
      );
    });

    it("supports alias column completion for DB.SCHEMA.TABLE inside CTE select list", async () => {
      const items = await complete(`WITH CTE1 AS (
    SELECT C.| FROM JUST_DATA.ADMIN.DEPARTMENT C
)
SELECT * FROM CTE1 A`);
      expect(labels(items)).toEqual(
        expect.arrayContaining(["DEPARTMENT_ID", "NAME"]),
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "DEPARTMENT",
        "ADMIN",
      );
    });

    it("returns alias columns in SELECT list and does not switch to FROM context", async () => {
      const items = await complete("SELECT X.| FROM JUST_DATA..DIMACCOUNT X");
      expect(labels(items)).toContain("ACCOUNTKEY");
      expect(metadataProvider.getSchemas).not.toHaveBeenCalled();
      expect(metadataProvider.getTables).not.toHaveBeenCalled();
    });

    it("returns alias columns for OF alias inside incomplete NZPLSQL procedure", async () => {
      const items = await complete(`CREATE OR REPLACE PROCEDURE SOME_NAME()
RETURNS INTEGER
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
INSERT INTO JUST_DATA..DIMDATE(DATEKEY)
SELECT 1
FROM
    (SELECT DISTINCT 10 AS COL1 FROM DIMDATE) AS S
    JOIN JUST_DATA..DIMEMPLOYEE E ON E.EMPLOYEEKEY = S.COL1
    LEFT JOIN JUST_DATA..DIMACCOUNT OF ON E.BIRTHDATE = OF.|
RETURN 1;
END;
END_PROC;`);

      expect(labels(items)).toContain("ACCOUNTKEY");
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "DIMACCOUNT",
      );
    });

    it("returns only alias columns for partial qualifier prefix without SQL functions", async () => {
      const items = await complete(
        "SELECT * FROM JUST_DATA..DIMACCOUNT X WHERE X.ACC|",
      );
      const itemLabels = labelsWithoutExpand(items);
      expect(itemLabels).toEqual(
        expect.arrayContaining(["ACCOUNTCODEALTERNATEKEY", "ACCOUNTNAME"]),
      );
      expect(itemLabels).not.toContain("DATE_PART");
      expect(
        items.some(
          (item) =>
            item.kind === CompletionItemKind.Function &&
            String(item.label).toUpperCase() === "DATE_PART",
        ),
      ).toBe(false);
    });

    it("supports alias completion in unfinished CTE statement", async () => {
      const items = await complete(`WITH CTE1 AS (
    SELECT C.| FROM JUST_DATA.ADMIN.DEPARTMENT C`);
      expect(labels(items)).toContain("DEPARTMENT_ID");
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "DEPARTMENT",
        "ADMIN",
      );
    });

    it("does not expose inner subquery alias outside subquery scope", async () => {
      const items =
        await complete(`SELECT X.LINENUMBER FROM JUST_DATA..VASSOCSEQLINEITEMS X
JOIN (SELECT AA.ACCOUNTTYPE FROM JUST_DATA..DIMACCOUNT AA) ON 1=1
WHERE AA.|`);
      const itemLabels = labels(items);
      expect(itemLabels).not.toContain("ACCOUNTTYPE");
      expect(itemLabels).not.toContain("OPERATOR");
    });

    it("returns scope-aware unqualified columns in expression context", async () => {
      const items = await complete("SELECT * FROM BAZA..USERS U WHERE US|");
      expect(labels(items)).toEqual(
        expect.arrayContaining(["USER_ID", "USERNAME"]),
      );
    });

    it("returns qualified suggestions for ambiguous unqualified columns", async () => {
      const items = await complete(
        "SELECT ID FROM BAZA..USERS U JOIN BAZA..ORDERS O ON U.ID = O.USER_ID WHERE I|",
      );
      expect(labels(items)).toEqual(expect.arrayContaining(["U.ID", "O.ID"]));
    });

    it("returns CTE columns in second CTE referencing first CTE alias", async () => {
      const items = await complete(`WITH CTE1 AS (
    SELECT D.ACCOUNTKEY, D.ACCOUNTNAME FROM JUST_DATA..DIMACCOUNT D
),
CTE2 AS (
    SELECT C1.| FROM CTE1 C1
)
SELECT * FROM CTE2`);
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTNAME"]),
      );
    });

    it("does not suggest nested CTE outside its scope in JOIN context", async () => {
      const items = await complete(`WITH CTE1 AS (
    WITH CTE2 AS (
        SELECT 1 AS ID, 'Alice' AS NAME
        UNION ALL
        SELECT 2 AS ID, 'Bob' AS NAME
    )
    SELECT CTE2.ID AS ID_2 FROM CTE2
)
SELECT * FROM CTE1 C
JOIN |`);
      const upperLabels = labels(items).map((label) => label.toUpperCase());
      expect(upperLabels).toContain("CTE1");
      expect(upperLabels).not.toContain("CTE2");
    });

    it("returns columns in nested CTE contexts", async () => {
      const items = await complete(`WITH CTE1 AS (
    SELECT D.ID FROM BAZA..DEPT D
),
CTE2 AS (
    WITH CTE3 AS (
        SELECT C1.ID FROM CTE1 C1
    )
    SELECT C3.| FROM CTE3 C3
)
SELECT * FROM CTE2`);
      expect(labels(items)).toContain("ID");
    });

    it("returns columns for deep nested subquery aliases", async () => {
      const items = await complete(`SELECT SQ2.|
FROM (
    SELECT SQ1.ID
    FROM (
        SELECT D.ID FROM BAZA..DEPT D
    ) SQ1
) SQ2`);
      expect(labels(items)).toContain("ID");
    });

    it("returns column suggestions in UPDATE alias context", async () => {
      const items = await complete(
        "UPDATE JUST_DATA.ADMIN.DEPARTMENT C SET C.|",
      );
      expect(labels(items)).toContain("ID");
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "DEPARTMENT",
        "ADMIN",
      );
    });

    it("returns column suggestions in DELETE alias context", async () => {
      const items = await complete(
        "DELETE FROM JUST_DATA.ADMIN.DEPARTMENT C WHERE C.|",
      );
      expect(labels(items)).toContain("ID");
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "DEPARTMENT",
        "ADMIN",
      );
    });

    it("returns PostgreSQL alias columns for unqualified table references", async () => {
      metadataProvider.databaseKind = "postgresql";
      metadataProvider.effectiveDatabase = "APPDB";
      metadataProvider.setTables("APPDB", ["orders"]);
      metadataProvider.setColumns("APPDB", "orders", [
        "id",
        "customer_id",
        "status",
      ]);

      const items = await complete("SELECT * FROM orders x WHERE x.|");

      expect(labels(items)).toEqual(
        expect.arrayContaining(["id", "customer_id", "status"]),
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "APPDB",
        "orders",
        undefined,
      );
    });
  });

  describe("functions, variables, and wildcard expansion", () => {
    it("does not duplicate AND/OR/NOT keywords in WHERE expression context", async () => {
      metadataProvider.setTables("BAZA", ["USERS"], "ADMIN");
      metadataProvider.setColumns("BAZA", "USERS", ["ID", "NAME"], "ADMIN");

      const items = await complete("SELECT * FROM BAZA..USERS WHERE |");
      const keywordLabels = labels(items).filter((label) =>
        ["AND", "OR", "NOT"].includes(label.toUpperCase()),
      );

      expect(new Set(keywordLabels.map((label) => label.toUpperCase())).size).toBe(
        keywordLabels.length,
      );
      expect(keywordLabels.map((label) => label.toUpperCase())).toEqual(
        expect.arrayContaining(["AND", "OR", "NOT"]),
      );
    });

    it("returns SQL functions in expression context", async () => {
      const items = await complete("SELECT CO|");
      expect(labels(items)).toContain("COALESCE");
    });

    it("returns PostgreSQL SQL functions when the document context kind is postgresql", async () => {
      metadataProvider.databaseKind = "postgresql";

      const items = await complete("SELECT CO|");

      expect(labels(items)).toContain("COALESCE");
    });

    it("returns SQL functions at start of next SELECT expression after comma", async () => {
      const items = await complete(
        "SELECT A.ID AS COL, | FROM JUST_DATA..DEPARTMENT A",
      );
      expect(labels(items)).toContain("COALESCE");
    });

    it("ranks scoped columns before session variables, functions, and keywords in SELECT list", async () => {
      const items = await complete("SELECT | FROM JUST_DATA..DIMACCOUNT");
      const columnItem = items.find((item) => item.detail === "Column in scope");
      const sessionItem = items.find(
        (item) => item.detail === "Session variable",
      );
      const functionItem = items.find(
        (item) => item.kind === CompletionItemKind.Function,
      );
      const keywordItem = items.find((item) => item.detail === "SQL Keyword");

      expect(columnItem).toBeDefined();
      expect(sessionItem).toBeDefined();
      expect(functionItem).toBeDefined();
      expect(keywordItem).toBeDefined();
      expect(columnItem!.sortText!).toMatch(/^2_/);
      expect(columnItem!.sortText! < sessionItem!.sortText!).toBe(true);
      expect(sessionItem!.sortText! < functionItem!.sortText!).toBe(true);
      expect(functionItem!.sortText! < keywordItem!.sortText!).toBe(true);
    });

    it("ranks scoped columns first when table alias is used in SELECT list", async () => {
      const items = await complete("SELECT | FROM JUST_DATA..DIMACCOUNT X");
      const columnItem = items.find((item) => item.detail === "Column in scope");
      const sessionItem = items.find(
        (item) => item.detail === "Session variable",
      );

      expect(columnItem).toBeDefined();
      expect(sessionItem).toBeDefined();
      expect(columnItem!.sortText! < sessionItem!.sortText!).toBe(true);
    });

    it("does not return SQL functions after completed SELECT expression without comma", async () => {
      const items = await complete("SELECT 1 |");
      expect(labels(items)).not.toEqual(
        expect.arrayContaining(["COALESCE", "COUNT", "SUM"]),
      );
    });

    it("does not return SQL functions in SELECT AS alias position", async () => {
      const items = await complete("SELECT 1 AS |");
      expect(labels(items)).not.toEqual(
        expect.arrayContaining(["COALESCE", "COUNT", "SUM"]),
      );
    });

    it("proposes EXPAND when user types A.*", async () => {
      const items = await complete("SELECT A.*| FROM JUST_DATA..DIMACCOUNT A");
      const expandItem = items.find(
        (item) => item.label === "* (Expand Columns)",
      );
      expect(expandItem).toBeDefined();
      expect(expandItem?.kind).toBe(CompletionItemKind.Snippet);
      const expansion =
        expandItem?.textEdit?.newText ?? expandItem?.insertText ?? "";
      expect(expansion).toContain("A.ACCOUNTKEY");
      expect(expansion).toContain("A.ACCOUNTCODEALTERNATEKEY");
    });

    it("proposes EXPAND when user types alias .* with whitespace", async () => {
      const items = await complete("SELECT A .*| FROM JUST_DATA..DIMACCOUNT A");
      const expandItem = items.find(
        (item) => item.label === "* (Expand Columns)",
      );
      expect(expandItem).toBeDefined();
      const expansion =
        expandItem?.textEdit?.newText ?? expandItem?.insertText ?? "";
      expect(expansion).toContain("A.ACCOUNTKEY");
      expect(expansion).toContain("A.ACCOUNTCODEALTERNATEKEY");
    });

    it("returns variable completion when invoked", async () => {
      const items = await complete(`@SET RUN_ID = 1;
SELECT \${|`);
      const variableItem = items.find((item) => item.label === "${RUN_ID}");
      expect(variableItem?.kind).toBe(CompletionItemKind.Variable);
      expect(variableItem?.insertText).toBe("RUN_ID}");
    });

    it("does not return variable completion on trigger-character invocation", async () => {
      const items = await complete(
        `@SET RUN_ID = 1;
SELECT \${|`,
        CompletionTriggerKind.TriggerCharacter,
      );
      const variableItem = items.find((item) => item.label === "${RUN_ID}");
      expect(variableItem).toBeUndefined();
    });

    it("returns %let declaration snippet after percent trigger", async () => {
      const items = await complete(
        "%|",
        CompletionTriggerKind.TriggerCharacter,
      );
      const letItem = items.find((item) => item.label === "%let variable = value;");
      const sqlItem = items.find((item) => item.label === "%sql(SELECT ...)");
      const sqlListItem = items.find((item) => item.label === "%sqllist(SELECT ...)");
      const exportItem = items.find((item) => item.label === "%export(format, file, query);");
      const pythonItem = items.find((item) => item.label === "%python script.py [args...]");
      const doItem = items.find((item) => item.label === "%do; ... %end;");

      expect(letItem).toBeDefined();
      expect(letItem?.kind).toBe(CompletionItemKind.Snippet);
      expect(letItem?.textEdit?.newText).toBe("let ${1:variable_name} = ${2:value};");
      expect(sqlItem?.kind).toBe(CompletionItemKind.Snippet);
      expect(sqlItem?.textEdit?.newText).toBe("sql(SELECT ${1:expression} FROM ${2:table})");
      expect(sqlListItem?.kind).toBe(CompletionItemKind.Snippet);
      expect(sqlListItem?.textEdit?.newText).toBe("sqllist(SELECT ${1:column} FROM ${2:table})");
      expect(exportItem?.kind).toBe(CompletionItemKind.Snippet);
      expect(exportItem?.textEdit?.newText).toContain("export(format='${1:xlsx}'");
      expect(pythonItem?.kind).toBe(CompletionItemKind.Snippet);
      expect(pythonItem?.textEdit?.newText).toContain("python ${1:script.py}");
      expect(doItem?.kind).toBe(CompletionItemKind.Snippet);
      expect(doItem?.textEdit?.newText).toContain("do;\n");
    });

    it("returns inline macro variable completions after ampersand trigger", async () => {
      const items = await complete(
        `%let points_cutoff = 20;
SELECT &|`,
        CompletionTriggerKind.TriggerCharacter,
      );
      const variableItem = items.find((item) => item.label === "&points_cutoff");

      expect(variableItem).toBeDefined();
      expect(variableItem?.kind).toBe(CompletionItemKind.Variable);
      expect(variableItem?.textEdit?.newText).toBe("points_cutoff");
    });

    it("returns inline macro variable completions after dollar trigger", async () => {
      const items = await complete(
        `%let points_cutoff = 20;
SELECT $|`,
        CompletionTriggerKind.TriggerCharacter,
      );
      const variableItem = items.find((item) => item.label === "$points_cutoff");

      expect(variableItem).toBeDefined();
      expect(variableItem?.textEdit?.newText).toBe("points_cutoff");
    });

    it("returns inline macro variable completions inside braced dollar references", async () => {
      const items = await complete(
        `%let points_cutoff = 20;
SELECT \${po|`,
      );
      const variableItem = items.find((item) => item.label === "${points_cutoff}");

      expect(variableItem).toBeDefined();
      expect(variableItem?.textEdit?.newText).toBe("points_cutoff}");
    });

    it("does not return inline macro variables declared below the cursor", async () => {
      const items = await complete(
        `SELECT &|
%let points_cutoff = 20;`,
        CompletionTriggerKind.TriggerCharacter,
      );

      expect(items.find((item) => item.label === "&points_cutoff")).toBeUndefined();
    });
  });

  describe("CTE and CTAS wildcard column propagation", () => {
    it("expands CTAS SELECT * columns for later alias completion", async () => {
      const items = await complete(`CREATE TEMP TABLE TEST_TABLE AS
(
    SELECT * FROM JUST_DATA..DIMACCOUNT
) DISTRIBUTE ON RANDOM;

SELECT
    TT.|
FROM TEST_TABLE TT;`);
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTCODEALTERNATEKEY"]),
      );
    });

    it("combines explicit and wildcard columns for CTE alias completion", async () => {
      const items = await complete(`WITH TEST_TABLE AS
(
    SELECT DD.DATEKEY, DA.* FROM JUST_DATA..DIMACCOUNT DA
     JOIN JUST_DATA..DIMDATE DD ON 1=1
)
SELECT
    TT.|
 FROM TEST_TABLE TT;`);
      expect(labels(items)).toEqual(
        expect.arrayContaining([
          "DATEKEY",
          "ACCOUNTKEY",
          "ACCOUNTCODEALTERNATEKEY",
        ]),
      );
    });

    it("combines wildcard columns from both joined tables in CTE alias completion", async () => {
      const items = await complete(`WITH TEST_TABLE AS
(
    SELECT DD.*, DA.* FROM JUST_DATA..DIMACCOUNT DA
     JOIN JUST_DATA..DIMDATE DD ON 1=1
)
SELECT
    TT.|
 FROM TEST_TABLE TT;`);
      expect(labels(items)).toEqual(
        expect.arrayContaining([
          "DATEKEY",
          "CALENDARQUARTER",
          "ACCOUNTKEY",
          "ACCOUNTCODEALTERNATEKEY",
        ]),
      );
    });

    it("expands CTAS wildcard-derived columns for TT* snippet completion", async () => {
      const items = await complete(`CREATE TEMP TABLE TEST_TABLE AS
(
    SELECT DD.DATEKEY, DA.* FROM JUST_DATA..DIMACCOUNT DA
     JOIN JUST_DATA..DIMDATE DD ON 1=1
) DISTRIBUTE ON RANDOM;

SELECT
    TT*|
 FROM TEST_TABLE TT;`);
      const expandItem = items.find(
        (item) => item.label === "* (Expand Columns)",
      );
      expect(expandItem).toBeDefined();
      const expansion =
        expandItem?.textEdit?.newText ?? expandItem?.insertText ?? "";
      expect(expansion).toContain("TT.DATEKEY");
      expect(expansion).toContain("TT.ACCOUNTKEY");
      expect(expansion).toContain("TT.ACCOUNTCODEALTERNATEKEY");
    });

    it("expands wildcard sources across UNION ALL branches in CTE definitions", async () => {
      const sql = `WITH TEST_TABLE AS
(
    SELECT DA.* FROM JUST_DATA..DIMACCOUNT DA
    UNION ALL
    SELECT DD.* FROM JUST_DATA..DIMDATE DD
)
SELECT
    TT.|
 FROM TEST_TABLE TT;`;
      const items = await complete(sql);
      expect(labels(items)).toEqual(
        expect.arrayContaining([
          "ACCOUNTKEY",
          "ACCOUNTCODEALTERNATEKEY",
          "DATEKEY",
          "CALENDARQUARTER",
        ]),
      );
    });

    it("resolves wildcard columns through nested FROM subquery aliases", async () => {
      const sql = `WITH TEST_TABLE AS
(
    SELECT SQ.* FROM
    (
        SELECT DA.* FROM JUST_DATA..DIMACCOUNT DA
    ) SQ
)
SELECT
    TT.|
 FROM TEST_TABLE TT;`;
      const items = await complete(sql);
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTCODEALTERNATEKEY"]),
      );
    });

    it("does not treat COUNT(*) as wildcard table expansion", async () => {
      const items = await complete(`CREATE TEMP TABLE TEST_TABLE AS
(
    SELECT COUNT(*) AS CNT FROM JUST_DATA..DIMACCOUNT
) DISTRIBUTE ON RANDOM;

SELECT
    TT.|
FROM TEST_TABLE TT;`);
      const itemLabels = labelsWithoutExpand(items);
      expect(itemLabels).toContain("CNT");
      expect(itemLabels).not.toContain("ACCOUNTKEY");
      expect(itemLabels).not.toContain("ACCOUNTCODEALTERNATEKEY");
    });

    it("keeps wildcard-derived columns through chained CTE SELECT *", async () => {
      const items = await complete(`WITH TEST_TABLE AS
(
    SELECT DD.DATEKEY, DA.* FROM JUST_DATA..DIMACCOUNT DA
     JOIN JUST_DATA..DIMDATE DD ON 1=1
)
, TEST_TABLE_2 AS
(
    SELECT * FROM TEST_TABLE
)
SELECT
    TT.|
 FROM TEST_TABLE_2 TT;`);
      expect(labels(items)).toEqual(
        expect.arrayContaining([
          "DATEKEY",
          "ACCOUNTKEY",
          "ACCOUNTCODEALTERNATEKEY",
        ]),
      );
    });
  });

  describe("complex CTE scope edge-cases", () => {
    it("should suggest correct columns inside first CTE with WHERE clause", async () => {
      const items = await complete(`WITH SOME_NAME AS
(
    SELECT X.| FROM JUST_DATA..DIMACCOUNT X
    WHERE X.ACCOUNTCODEALTERNATEKEY IS NOT NULL
)
, SOME_NAME2 AS
(
    SELECT X.* FROM JUST_DATA..DIMEMPLOYEE X
    WHERE X.BASERATE IS NOT NULL
)
SELECT * FROM SOME_NAME SN
JOIN SOME_NAME2 SN2 ON 1 = 1`);
      const itemLabels = labels(items);
      expect(itemLabels).toContain("ACCOUNTKEY");
      expect(itemLabels).toContain("ACCOUNTCODEALTERNATEKEY");
      expect(itemLabels).not.toContain("EMPLOYEEKEY");
      expect(itemLabels).not.toContain("BASERATE");
    });

    it("should suggest correct columns inside second CTE with WHERE clause", async () => {
      const items = await complete(`WITH SOME_NAME AS
(
    SELECT X.* FROM JUST_DATA..DIMACCOUNT X
    WHERE X.ACCOUNTCODEALTERNATEKEY IS NOT NULL
)
, SOME_NAME2 AS
(
    SELECT X.| FROM JUST_DATA..DIMEMPLOYEE X
    WHERE X.BASERATE IS NOT NULL
)
SELECT * FROM SOME_NAME SN
JOIN SOME_NAME2 SN2 ON 1 = 1`);
      const itemLabels = labels(items);
      expect(itemLabels).toContain("EMPLOYEEKEY");
      expect(itemLabels).toContain("BASERATE");
      expect(itemLabels).not.toContain("ACCOUNTKEY");
      expect(itemLabels).not.toContain("ACCOUNTCODEALTERNATEKEY");
    });

    it("should correctly resolve SN2 alias to second CTE (SOME_NAME2 -> DIMEMPLOYEE) not first CTE", async () => {
      const items = await complete(`WITH SOME_NAME AS
(
    SELECT Y.* FROM JUST_DATA..DIMACCOUNT Y
)
, SOME_NAME2 AS
(
    SELECT X.* FROM JUST_DATA..DIMEMPLOYEE X
)
SELECT SN2.|
FROM SOME_NAME SN
JOIN SOME_NAME2 SN2 ON 1 = 1`);
      const itemLabels = labels(items);
      expect(itemLabels).toContain("EMPLOYEEKEY");
      expect(itemLabels).toContain("BASERATE");
      expect(itemLabels).not.toContain("ACCOUNTKEY");
    });

    it("resolves SN alias to first CTE columns in outer query", async () => {
      const items = await complete(`WITH SOME_NAME AS
(
    SELECT Y.* FROM JUST_DATA..DIMACCOUNT Y
)
, SOME_NAME2 AS
(
    SELECT X.* FROM JUST_DATA..DIMEMPLOYEE X
)
SELECT SN.|
FROM SOME_NAME SN
JOIN SOME_NAME2 SN2 ON 1 = 1`);
      const itemLabels = labels(items);
      expect(itemLabels).toContain("ACCOUNTKEY");
      expect(itemLabels).toContain("ACCOUNTCODEALTERNATEKEY");
      expect(itemLabels).not.toContain("EMPLOYEEKEY");
      expect(itemLabels).not.toContain("BASERATE");
    });

    it("should suggest correct columns for CTE aliases in outer JOIN query", async () => {
      const items = await complete(`WITH SOME_NAME AS
(
    SELECT * FROM JUST_DATA..DIMACCOUNT X
)
, SOME_NAME2 AS
(
    SELECT * FROM JUST_DATA..DIMEMPLOYEE X
)
SELECT SN2.|
FROM SOME_NAME SN
JOIN SOME_NAME2 SN2 ON 1 = 1
WHERE SN2.BASERATE IS NOT NULL
AND SN.ACCOUNTCODEALTERNATEKEY IS NOT NULL`);
      const itemLabels = labels(items);
      expect(itemLabels).toContain("EMPLOYEEKEY");
      expect(itemLabels).toContain("BASERATE");
      expect(itemLabels).not.toContain("ACCOUNTKEY");
      expect(itemLabels).not.toContain("ACCOUNTCODEALTERNATEKEY");
    });

    it("should suggest correct columns for first CTE alias in outer query WHERE clause", async () => {
      const items = await complete(`WITH SOME_NAME AS
(
    SELECT * FROM JUST_DATA..DIMACCOUNT X
)
, SOME_NAME2 AS
(
    SELECT * FROM JUST_DATA..DIMEMPLOYEE X
)
SELECT SN2.* FROM SOME_NAME SN
JOIN SOME_NAME2 SN2 ON 1 = 1
WHERE SN2.BASERATE IS NOT NULL
AND SN.|`);
      const itemLabels = labels(items);
      expect(itemLabels).toContain("ACCOUNTKEY");
      expect(itemLabels).toContain("ACCOUNTCODEALTERNATEKEY");
      expect(itemLabels).not.toContain("EMPLOYEEKEY");
      expect(itemLabels).not.toContain("BASERATE");
    });

    it("should suggest BASERATE but not ACCOUNTCODEALTERNATEKEY at Y. in second CTE", async () => {
      const items = await complete(`WITH SOME_NAME AS
(
    SELECT X.* FROM JUST_DATA..DIMACCOUNT X
    WHERE X.ACCOUNTCODEALTERNATEKEY IS NOT NULL
)
, SOME_NAME2 AS
(
    SELECT Y.| FROM JUST_DATA..DIMEMPLOYEE Y
    WHERE Y.BASERATE IS NOT NULL
)
SELECT * FROM SOME_NAME SN
JOIN SOME_NAME2 SN2 ON 1 = 1`);
      const itemLabels = labels(items);
      expect(itemLabels).toContain("BASERATE");
      expect(itemLabels).toContain("EMPLOYEEKEY");
      expect(itemLabels).not.toContain("ACCOUNTCODEALTERNATEKEY");
      expect(itemLabels).not.toContain("ACCOUNTKEY");
    });

    it("should suggest ACCOUNTCODEALTERNATEKEY but not BASERATE at SN. in outer SELECT", async () => {
      const items = await complete(`WITH SOME_NAME AS
(
    SELECT X.* FROM JUST_DATA..DIMACCOUNT X
    WHERE X.ACCOUNTCODEALTERNATEKEY IS NOT NULL
)
, SOME_NAME2 AS
(
    SELECT X.* FROM JUST_DATA..DIMEMPLOYEE X
    WHERE X.BASERATE IS NOT NULL
)
SELECT
  SN.|
FROM SOME_NAME SN
JOIN SOME_NAME2 SN2 ON 1 = 1`);
      const itemLabels = labels(items);
      expect(itemLabels).toContain("ACCOUNTCODEALTERNATEKEY");
      expect(itemLabels).toContain("ACCOUNTKEY");
      expect(itemLabels).not.toContain("BASERATE");
      expect(itemLabels).not.toContain("EMPLOYEEKEY");
    });

    it("should suggest BASERATE but not ACCOUNTCODEALTERNATEKEY at SN2. in outer SELECT (likely fails - known issue)", async () => {
      const items = await complete(`WITH SOME_NAME AS
(
    SELECT X.* FROM JUST_DATA..DIMACCOUNT X
    WHERE X.ACCOUNTCODEALTERNATEKEY IS NOT NULL
)
, SOME_NAME2 AS
(
    SELECT X.* FROM JUST_DATA..DIMEMPLOYEE X
    WHERE X.BASERATE IS NOT NULL
)
SELECT
  SN2.|
FROM SOME_NAME SN
JOIN SOME_NAME2 SN2 ON 1 = 1`);
      const itemLabels = labels(items);
      expect(itemLabels).toContain("BASERATE");
      expect(itemLabels).toContain("EMPLOYEEKEY");
      expect(itemLabels).not.toContain("ACCOUNTCODEALTERNATEKEY");
      expect(itemLabels).not.toContain("ACCOUNTKEY");
    });

    it("should correctly resolve SN alias when SN2 is defined first in outer SELECT list", async () => {
      const items = await complete(`WITH SOME_NAME AS
(
    SELECT Y.* FROM JUST_DATA..DIMACCOUNT Y
)
, SOME_NAME2 AS
(
    SELECT X.* FROM JUST_DATA..DIMEMPLOYEE X
)
SELECT
    SN2.*,
    SN.|
FROM SOME_NAME SN
JOIN SOME_NAME2 SN2 ON 1 = 1`);
      const itemLabels = labels(items);
      expect(itemLabels).toContain("ACCOUNTKEY");
      expect(itemLabels).toContain("ACCOUNTCODEALTERNATEKEY");
      expect(itemLabels).not.toContain("EMPLOYEEKEY");
      expect(itemLabels).not.toContain("BASERATE");
    });

    it("should resolve aliases correctly in complex user query", async () => {
      const sql = `WITH SOME_NAME AS
(
    SELECT X.* FROM JUST_DATA..DIMACCOUNT X
    WHERE X.ACCOUNTCODEALTERNATEKEY IS NOT NULL
)
, SOME_NAME2 AS
(
    SELECT X.* FROM JUST_DATA..DIMEMPLOYEE X
    WHERE X.BASERATE IS NOT NULL
)
SELECT
    SN2.*,
    SN.*
FROM SOME_NAME SN
JOIN SOME_NAME2 SN2 ON 1 = 1
WHERE SN2.BASERATE IS NOT NULL
AND SN.ACCOUNTCODEALTERNATEKEY IS NOT NULL`;

      const document = TextDocument.create(
        "file:///completion-engine.sql",
        "sql",
        1,
        sql,
      );

      const sn2Pos = document.positionAt(sql.indexOf("SN2.*") + "SN2.".length);
      const sn2Items = await engine.provideCompletionItems(
        document,
        sn2Pos,
        CompletionTriggerKind.Invoked,
      );
      const sn2Labels = labels(sn2Items);
      expect(sn2Labels).toContain("EMPLOYEEKEY");
      expect(sn2Labels).toContain("BASERATE");
      expect(sn2Labels).not.toContain("ACCOUNTKEY");

      const snPos = document.positionAt(sql.indexOf("SN.*") + "SN.".length);
      const snItems = await engine.provideCompletionItems(
        document,
        snPos,
        CompletionTriggerKind.Invoked,
      );
      const snLabels = labels(snItems);
      expect(snLabels).toContain("ACCOUNTKEY");
      expect(snLabels).toContain("ACCOUNTCODEALTERNATEKEY");
      expect(snLabels).not.toContain("EMPLOYEEKEY");
    });

    const sqlPrefix = `DROP TABLE SOM_TEMP IF EXISTS;
CREATE TEMP TABLE SOM_TEMP AS
(
SELECT
    A.ACCOUNTKEY
FROM
    JUST_DATA..DIMACCOUNT A
) DISTRIBUTE ON RANDOM;
WITH SOME_CTE AS
(
    WITH CTE_INNER_1 AS (
        SELECT
            X.ACCOUNTKEY, X.OPERATOR, X.CUSTOMMEMBERS, T1.KKK
        FROM
            JUST_DATA..DIMACCOUNT X
            JOIN (
                SELECT Z.ACCOUNTKEY AS KKK
                FROM JUST_DATA..DIMACCOUNT Z
                WHERE Z.ACCOUNTKEY IS NOT NULL
            ) T1 ON T1.KKK IS NOT NULL
    )
    SELECT T.ACCOUNTKEY, CI.OPERATOR, CI.CUSTOMMEMBERS
    FROM SOM_TEMP T
    JOIN CTE_INNER_1 CI ON CI.ACCOUNTKEY = T.ACCOUNTKEY
)`;

    it("suggests ACCOUNTKEY, OPERATOR, CUSTOMMEMBERS for CTE. in outer WHERE clause", async () => {
      const items = await complete(`${sqlPrefix}
SELECT * FROM
SOM_TEMP ST
JOIN SOME_CTE CTE ON CTE.ACCOUNTKEY = ST.ACCOUNTKEY
WHERE ST.ACCOUNTKEY IS NOT NULL
AND CTE.|`);
      const itemLabels = labelsWithoutExpand(items);
      expect(itemLabels).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "OPERATOR", "CUSTOMMEMBERS"]),
      );
      expect(itemLabels).toHaveLength(3);
    });

    it("suggests only SOM_TEMP columns for ST. in outer WHERE clause", async () => {
      const items = await complete(`${sqlPrefix}
SELECT * FROM
SOM_TEMP ST
JOIN SOME_CTE CTE ON CTE.ACCOUNTKEY = ST.ACCOUNTKEY
WHERE ST.ACCOUNTKEY IS NOT NULL
AND ST.|`);
      const itemLabels = labelsWithoutExpand(items);
      expect(itemLabels).toEqual(["ACCOUNTKEY"]);
    });

    it("returns no suggestions for out-of-scope CI. alias in outer WHERE clause", async () => {
      const items = await complete(`${sqlPrefix}
SELECT * FROM
SOM_TEMP ST
JOIN SOME_CTE CTE ON CTE.ACCOUNTKEY = ST.ACCOUNTKEY
WHERE ST.ACCOUNTKEY IS NOT NULL
AND CI.|`);
      expect(items).toHaveLength(0);
    });
  });

  describe("statement-scoped parsing with document cache", () => {
    it("keeps CTAS temp table columns available in a later statement", async () => {
      const items = await complete(`CREATE TEMP TABLE TMP_STAGE AS (
  SELECT A.ACCOUNTKEY, A.ACCOUNTCODEALTERNATEKEY
  FROM JUST_DATA..DIMACCOUNT A
);
SELECT T.|
FROM TMP_STAGE T`);
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTCODEALTERNATEKEY"]),
      );
      expect(metadataProvider.getColumns).not.toHaveBeenCalled();
    });

    it("keeps CTAS TEMPORARY table columns available in a later statement", async () => {
      const items = await complete(`CREATE TEMPORARY TABLE TMP_STAGE AS (
  SELECT A.ACCOUNTKEY, A.ACCOUNTCODEALTERNATEKEY
  FROM JUST_DATA..DIMACCOUNT A
);
SELECT T.|
FROM TMP_STAGE T`);
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTCODEALTERNATEKEY"]),
      );
      expect(metadataProvider.getColumns).not.toHaveBeenCalled();
    });

    it("keeps CTAS WITH temp table columns available in a later statement", async () => {
      const items = await complete(`CREATE TEMP TABLE TT1 AS
WITH BASE AS (
    SELECT ACCOUNTKEY, ACCOUNTNAME FROM JUST_DATA..DIMACCOUNT
)
SELECT * FROM BASE;
SELECT T.|
FROM TT1 T`);
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTNAME"]),
      );
      expect(metadataProvider.getColumns).not.toHaveBeenCalled();
    });

    it("keeps parenthesized CTAS WITH temp table columns with trailing qualifier dot in next statement", async () => {
      const items = await complete(`CREATE TEMP TABLE TT1 AS
(
    WITH ABC1 AS (
        SELECT 1 AS JEDEN
    )
    SELECT JEDEN FROM ABC1
);

SELECT * FROM TT1 T
WHERE T.|`);
      expect(labels(items)).toEqual(expect.arrayContaining(["JEDEN"]));
      expect(metadataProvider.getColumns).not.toHaveBeenCalled();
    });

    it("does not leak subquery aliases from a previous statement", async () => {
      metadataProvider.setColumns("BAZA", "SQ", ["REMOTE_COL"]);
      const items = await complete(`SELECT SQ.ID
FROM (SELECT 1 AS ID) SQ;
SELECT SQ.|`);
      const itemLabels = labels(items);
      expect(itemLabels).not.toContain("ID");
      expect(itemLabels).toContain("REMOTE_COL");
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
        "SQ",
      );
    });
  });

  describe("INSERT INTO completions", () => {
    it("returns database and table targets at INSERT INTO statement start", async () => {
      const items = await complete("INSERT INTO |");
      expect(labels(items)).toEqual(
        expect.arrayContaining(["BAZA", "JUST_DATA", "USERS", "ORDERS"]),
      );
      expect(metadataProvider.getDatabases).toHaveBeenCalled();
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
      );
    });

    it("returns columns inside INSERT column list", async () => {
      metadataProvider.setTables("JUST_DATA", ["FILMS"]);
      metadataProvider.setColumns("JUST_DATA", "FILMS", [
        "CODE",
        "TITLE",
        "DID",
      ]);

      const items = await complete("INSERT INTO JUST_DATA..FILMS (CODE, |");
      expect(labels(items)).toEqual(
        expect.arrayContaining(["CODE", "TITLE", "DID"]),
      );
    });

    it("returns columns for table alias in INSERT SELECT", async () => {
      const items = await complete(
        "INSERT INTO JUST_DATA..DIMACCOUNT SELECT A.| FROM JUST_DATA..DIMACCOUNT A",
      );
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTNAME"]),
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "DIMACCOUNT",
      );
    });
  });

  describe("MERGE statement completions", () => {
    it("returns columns for USING table alias in MERGE statement", async () => {
      // Test that columns are resolved for the USING table alias
      const items = await complete(`MERGE INTO JUST_DATA..DIMACCOUNT T
USING JUST_DATA..DIMEMPLOYEE S ON T.ACCOUNTKEY = S.EMPLOYEEKEY
WHEN MATCHED THEN UPDATE SET S.|`);
      expect(labels(items)).toEqual(
        expect.arrayContaining(["EMPLOYEEKEY", "BASERATE"]),
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "DIMEMPLOYEE",
      );
    });

    it("returns columns for target table alias in MERGE UPDATE clause", async () => {
      const items = await complete(`MERGE INTO JUST_DATA..DIMACCOUNT T
USING JUST_DATA..DIMEMPLOYEE S ON T.ACCOUNTKEY = S.EMPLOYEEKEY
WHEN MATCHED THEN UPDATE SET T.|`);
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTNAME"]),
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "DIMACCOUNT",
      );
    });

    it("returns columns for USING table alias in MERGE DELETE clause", async () => {
      const items = await complete(`MERGE INTO JUST_DATA..DIMACCOUNT T
USING JUST_DATA..DIMEMPLOYEE S ON T.ACCOUNTKEY = S.EMPLOYEEKEY
WHEN NOT MATCHED THEN DELETE WHERE S.|`);
      expect(labels(items)).toEqual(
        expect.arrayContaining(["EMPLOYEEKEY", "BASERATE"]),
      );
    });

    it("returns unqualified semantic columns in MERGE UPDATE SET clause", async () => {
      const items = await complete(`MERGE INTO JUST_DATA..DIMACCOUNT T
USING JUST_DATA..DIMEMPLOYEE S ON T.ACCOUNTKEY = S.EMPLOYEEKEY
WHEN MATCHED THEN UPDATE SET |`);
      const itemLabels = labels(items);
      expect(itemLabels).toContain("BASERATE");
      expect(itemLabels).toContain("ACCOUNTKEY");
    });

    it("returns qualified suggestions for ambiguous MERGE columns in UPDATE SET clause", async () => {
      metadataProvider.setColumns("JUST_DATA", "DIMEMPLOYEE", [
        "ACCOUNTKEY",
        "EMPLOYEEKEY",
        "BASERATE",
      ]);
      const items = await complete(`MERGE INTO JUST_DATA..DIMACCOUNT T
USING JUST_DATA..DIMEMPLOYEE S ON T.ACCOUNTKEY = S.EMPLOYEEKEY
WHEN MATCHED THEN UPDATE SET ACC|`);
      const itemLabels = labels(items);
      expect(itemLabels).toContain("T.ACCOUNTKEY");
      expect(itemLabels).toContain("S.ACCOUNTKEY");
      expect(itemLabels).not.toContain("ACCOUNTKEY");
    });
  });

  describe("CREATE TABLE AS SELECT completions", () => {
    it("returns tables for schema dot completion in CREATE TABLE AS SELECT", async () => {
      metadataProvider.setTables("BAZA", ["ORDERS_TBL"], "ADMIN");
      await complete("CREATE TABLE ADMIN.|");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
        "ADMIN",
      );
      expect(metadataProvider.getSchemas).not.toHaveBeenCalledWith(
        expect.any(String),
        "ADMIN",
      );
    });

    it("returns tables for schema dot completion in CREATE TEMP TABLE AS SELECT", async () => {
      metadataProvider.setTables("BAZA", ["ORDERS_TBL"], "ADMIN");
      await complete("CREATE TEMP TABLE ADMIN.|");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
        "ADMIN",
      );
      expect(metadataProvider.getSchemas).not.toHaveBeenCalledWith(
        expect.any(String),
        "ADMIN",
      );
    });

    it("returns tables for schema dot completion in CREATE TEMPORARY TABLE AS SELECT", async () => {
      metadataProvider.setTables("BAZA", ["ORDERS_TBL"], "ADMIN");
      await complete("CREATE TEMPORARY TABLE ADMIN.|");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
        "ADMIN",
      );
      expect(metadataProvider.getSchemas).not.toHaveBeenCalledWith(
        expect.any(String),
        "ADMIN",
      );
    });

    it("returns columns for table alias in CREATE TABLE AS SELECT", async () => {
      const items = await complete(
        "CREATE TABLE NEW_TBL AS SELECT A.| FROM JUST_DATA..DIMACCOUNT A",
      );
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTNAME"]),
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "DIMACCOUNT",
      );
    });
  });

  describe("SELECT INTO completions", () => {
    it("returns columns for source table alias in SELECT INTO", async () => {
      const items = await complete(
        "SELECT A.| INTO NEW_TABLE FROM JUST_DATA..DIMACCOUNT A",
      );
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTNAME"]),
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "DIMACCOUNT",
      );
    });
  });

  describe("procedure call completions (EXECUTE/CALL)", () => {
    it("returns database and procedure targets for EXECUTE statement start", async () => {
      const items = await complete("EXECUTE |");
      expect(labels(items)).toEqual(
        expect.arrayContaining(["BAZA", "JUST_DATA", "MY_PROC"]),
      );
      expect(metadataProvider.getDatabases).toHaveBeenCalled();
      expect(metadataProvider.getProcedures).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
      );
    });

    it("returns procedures for schema-qualified CALL targets", async () => {
      const items = await complete("CALL JUST_DATA.ADMIN.|");
      expect(labels(items)).toEqual(
        expect.arrayContaining(["MY_PROC", "SP_LOAD"]),
      );
      expect(metadataProvider.getProcedures).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "ADMIN",
      );
    });
  });

  describe("ALTER TABLE completions", () => {
    it("returns database/table suggestions for ALTER TABLE target", async () => {
      const items = await complete("ALTER TABLE |");
      expect(labels(items)).toEqual(
        expect.arrayContaining(["BAZA", "JUST_DATA", "USERS", "ORDERS"]),
      );
      expect(metadataProvider.getDatabases).toHaveBeenCalled();
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
      );
    });

    it("returns tables for schema dot completion in ALTER TABLE target", async () => {
      metadataProvider.setTables("BAZA", ["ORDERS_TBL"], "ADMIN");
      await complete("ALTER TABLE ADMIN.|");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
        "ADMIN",
      );
      expect(metadataProvider.getSchemas).not.toHaveBeenCalledWith(
        expect.any(String),
        "ADMIN",
      );
    });

    it("returns tables for DB.SCHEMA dot completion in ALTER TABLE target", async () => {
      const items = await complete("ALTER TABLE JUST_DATA.ADMIN.|");
      expect(labels(items)).toContain("DEPARTMENT");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "ADMIN",
      );
    });

    it("returns columns for table alias in ALTER TABLE subquery", async () => {
      const items = await complete(
        "ALTER TABLE T ADD COLUMN (SELECT A.| FROM JUST_DATA..DIMACCOUNT A)",
      );
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTNAME"]),
      );
    });

    it("returns ALTER TABLE actions after table name", async () => {
      const items = await complete("ALTER TABLE USERS |");
      const itemLabels = labels(items).map((label) => label.toUpperCase());
      expect(itemLabels).toEqual(
        expect.arrayContaining([
          "ADD COLUMN",
          "DROP COLUMN",
          "RENAME TO",
          "OWNER TO",
          "ORGANIZE ON",
        ]),
      );
      expect(itemLabels).not.toContain("USERS");
      expect(itemLabels).not.toContain("ORDERS");
    });

    it("does not re-suggest table name at end of unqualified ALTER TABLE target", async () => {
      const items = await complete("ALTER TABLE USERS|");
      const itemLabels = labels(items).map((label) => label.toUpperCase());
      expect(itemLabels).toEqual(
        expect.arrayContaining(["ADD COLUMN", "DROP COLUMN"]),
      );
      expect(itemLabels).not.toContain("USERS");
    });

    it("returns columns for DROP COLUMN", async () => {
      const items = await complete("ALTER TABLE USERS DROP COLUMN |");
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ID", "USER_ID", "USERNAME"]),
      );
    });

    it("returns columns for DROP without COLUMN keyword", async () => {
      const items = await complete("ALTER TABLE USERS DROP |");
      const itemLabels = labels(items).map((label) => label.toUpperCase());
      expect(itemLabels).toEqual(
        expect.arrayContaining(["COLUMN", "CONSTRAINT"]),
      );
    });

    it("completes additional columns after DROP col shorthand", async () => {
      const items = await complete("ALTER TABLE USERS DROP USERNAME, |");
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ID", "USER_ID", "USERNAME"]),
      );
    });

    it("returns data types for ADD COLUMN name", async () => {
      const items = await complete(
        "ALTER TABLE USERS ADD COLUMN NEW_COL |",
      );
      const itemLabels = labels(items).map((label) => label.toUpperCase());
      expect(itemLabels).toEqual(
        expect.arrayContaining(["VARCHAR", "INTEGER", "BIGINT", "DATE"]),
      );
    });
  });

  describe("JOIN context completions", () => {
    it("returns databases and tables for JOIN target", async () => {
      const items = await complete(
        "SELECT * FROM JUST_DATA..DIMACCOUNT A JOIN |",
      );
      // Should include databases and tables from effective database
      expect(labels(items)).toEqual(
        expect.arrayContaining(["BAZA", "JUST_DATA"]),
      );
      expect(metadataProvider.getDatabases).toHaveBeenCalled();
    });

    it("returns tables for schema dot completion in JOIN context", async () => {
      metadataProvider.setTables("BAZA", ["ORDERS_TBL"], "ADMIN");
      await complete("SELECT * FROM JUST_DATA..DIMACCOUNT A JOIN ADMIN.|");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
        "ADMIN",
      );
      expect(metadataProvider.getSchemas).not.toHaveBeenCalledWith(
        expect.any(String),
        "ADMIN",
      );
    });

    it("returns tables for DB.. completion in JOIN context", async () => {
      const items = await complete(
        "SELECT * FROM JUST_DATA..DIMACCOUNT A JOIN JUST_DATA..|",
      );
      expect(labels(items)).toEqual(
        expect.arrayContaining(["DIMDATE", "DIMEMPLOYEE"]),
      );
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
      );
    });

    it("returns columns for JOIN table alias in ON clause", async () => {
      const items = await complete(
        "SELECT * FROM JUST_DATA..DIMACCOUNT A JOIN JUST_DATA..DIMEMPLOYEE B ON A.|",
      );
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTNAME"]),
      );
    });

    it("returns columns for second JOIN table alias in ON clause", async () => {
      const items = await complete(
        "SELECT * FROM JUST_DATA..DIMACCOUNT A JOIN JUST_DATA..DIMEMPLOYEE B ON B.|",
      );
      expect(labels(items)).toEqual(
        expect.arrayContaining(["EMPLOYEEKEY", "BASERATE"]),
      );
    });
  });

  describe("keyword completions", () => {
    it("returns SQL keywords at statement start", async () => {
      const items = await complete("|");
      const labels_upper = labels(items).map((l) => l.toUpperCase());
      expect(labels_upper).toEqual(
        expect.arrayContaining([
          "SELECT",
          "INSERT",
          "UPDATE",
          "DELETE",
          "CREATE",
          "ALTER",
          "DROP",
        ]),
      );
    });

    it("returns WHERE keyword in SELECT context", async () => {
      const items = await complete("SELECT * FROM JUST_DATA..DIMACCOUNT |");
      const labels_upper = labels(items).map((l) => l.toUpperCase());
      expect(labels_upper).toContain("WHERE");
    });

    it("returns AND keyword in WHERE clause", async () => {
      const items = await complete(
        "SELECT * FROM JUST_DATA..DIMACCOUNT WHERE ACCOUNTKEY = 1 AND |",
      );
      const labels_upper = labels(items).map((l) => l.toUpperCase());
      expect(labels_upper).toContain("AND");
    });
  });

  describe("GROOM TABLE completions", () => {
    it("returns database/table suggestions for GROOM TABLE target", async () => {
      const items = await complete("GROOM TABLE |");
      expect(labels(items)).toEqual(
        expect.arrayContaining(["BAZA", "JUST_DATA", "USERS", "ORDERS"]),
      );
      expect(metadataProvider.getDatabases).toHaveBeenCalled();
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
      );
    });

    it("returns tables for schema dot completion in GROOM TABLE target", async () => {
      metadataProvider.setTables("BAZA", ["ORDERS_TBL"], "ADMIN");
      await complete("GROOM TABLE ADMIN.|");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
        "ADMIN",
      );
      expect(metadataProvider.getSchemas).not.toHaveBeenCalledWith(
        expect.any(String),
        "ADMIN",
      );
    });

    it("returns tables for DB.SCHEMA dot completion in GROOM TABLE target", async () => {
      const items = await complete("GROOM TABLE JUST_DATA.ADMIN.|");
      expect(labels(items)).toContain("DEPARTMENT");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "ADMIN",
      );
    });
  });

  describe("additional column resolution scenarios", () => {
    type QuotedAliasCompletionScenario = {
      name: string;
      databaseKind: DatabaseKind;
      effectiveDatabase: string | undefined;
      database: string;
      table: string;
      schema?: string;
      columns: string[];
      sql: string;
    };

    it("returns columns for qualified table reference without alias", async () => {
      const items = await complete(
        "SELECT JUST_DATA..DIMACCOUNT.| FROM JUST_DATA..DIMACCOUNT",
      );
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTNAME"]),
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "DIMACCOUNT",
      );
    });

    it("returns columns for qualified table reference with schema", async () => {
      const items = await complete(
        "SELECT JUST_DATA.ADMIN.DEPARTMENT.| FROM JUST_DATA.ADMIN.DEPARTMENT",
      );
      expect(labels(items)).toEqual(
        expect.arrayContaining(["DEPARTMENT_ID", "NAME"]),
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
        "DEPARTMENT",
        "ADMIN",
      );
    });

    it("returns columns for SQLite catalog.table qualifier", async () => {
      metadataProvider.databaseKind = "sqlite";
      metadataProvider.effectiveDatabase = "main";
      metadataProvider.setTables("main", ["sales"]);
      metadataProvider.setColumns("main", "sales", ["id", "sku"]);

      const items = await complete("SELECT main.sales.| FROM main.sales");

      expect(labels(items)).toEqual(expect.arrayContaining(["id", "sku"]));
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "main",
        "sales",
        undefined,
      );
    });

    it("returns columns for SQLite attached catalog.table qualifier using schema-style parser output", async () => {
      metadataProvider.databaseKind = "sqlite";
      metadataProvider.effectiveDatabase = "main";
      metadataProvider.setTables("salesdb", ["orders"]);
      metadataProvider.setColumns("salesdb", "orders", ["id", "amount"]);

      const items = await complete(
        "SELECT salesdb.orders.| FROM salesdb.orders",
      );

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["id", "amount"]),
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "salesdb",
        "orders",
        undefined,
      );
    });

    it("returns columns for DB2 schema.table qualifier using effective database", async () => {
      metadataProvider.databaseKind = "db2";
      metadataProvider.effectiveDatabase = "TESTDB";
      metadataProvider.setColumns(
        "TESTDB",
        "EM",
        ["EMPNO", "ENAME"],
        "DB2INST1",
      );

      const items = await complete("SELECT DB2INST1.EM.| FROM DB2INST1.EM");

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["EMPNO", "ENAME"]),
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
        "EM",
        "DB2INST1",
      );
    });

    it("returns columns for DB2 db.schema.table qualifier", async () => {
      metadataProvider.databaseKind = "db2";
      metadataProvider.effectiveDatabase = "TESTDB";
      metadataProvider.setColumns(
        "TESTDB",
        "EM",
        ["EMPNO", "ENAME"],
        "DB2INST1",
      );

      const items = await complete(
        "SELECT TESTDB.DB2INST1.EM.| FROM TESTDB.DB2INST1.EM",
      );

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["EMPNO", "ENAME"]),
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
        "EM",
        "DB2INST1",
      );
    });

    it("returns columns for DB2 alias binding over db.schema.table references", async () => {
      metadataProvider.databaseKind = "db2";
      metadataProvider.effectiveDatabase = "TESTDB";
      metadataProvider.setColumns(
        "TESTDB",
        "EM",
        ["EMPNO", "ENAME"],
        "DB2INST1",
      );

      const items = await complete("SELECT e.| FROM TESTDB.DB2INST1.EM e");

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["EMPNO", "ENAME"]),
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
        "EM",
        "DB2INST1",
      );
    });

    it("returns columns for DB2 nickname aliases as table-like objects", async () => {
      metadataProvider.databaseKind = "db2";
      metadataProvider.effectiveDatabase = "TESTDB";
      metadataProvider.setColumns(
        "TESTDB",
        "EM_REMOTE",
        ["EMPNO", "ENAME"],
        "DB2INST1",
      );

      const items = await complete("SELECT n.| FROM DB2INST1.EM_REMOTE n");

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["EMPNO", "ENAME"]),
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
        "EM_REMOTE",
        "DB2INST1",
      );
    });

    it("does not resolve DB2 double-dot aliases as valid table references", async () => {
      metadataProvider.databaseKind = "db2";
      metadataProvider.effectiveDatabase = "TESTDB";
      metadataProvider.setColumns(
        "TESTDB",
        "EM",
        ["EMPNO", "ENAME"],
        "DB2INST1",
      );

      await complete("SELECT e.| FROM DB2INST1..EM e");

      expect(metadataProvider.getColumns).not.toHaveBeenCalled();
    });

    it("returns columns for SQLite attached database alias bindings", async () => {
      metadataProvider.databaseKind = "sqlite";
      metadataProvider.effectiveDatabase = "main";
      metadataProvider.setTables("salesdb", ["orders"]);
      metadataProvider.setColumns("salesdb", "orders", ["id", "amount"]);

      const items = await complete("SELECT o.| FROM salesdb.orders o");

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["id", "amount"]),
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "salesdb",
        "orders",
        undefined,
      );
    });

    it("returns columns for MySQL database.table qualifier", async () => {
      metadataProvider.databaseKind = "mysql";
      metadataProvider.effectiveDatabase = "salesdb";
      metadataProvider.setTables("salesdb", ["orders"]);
      metadataProvider.setColumns("salesdb", "orders", ["id", "amount"]);

      const items = await complete(
        "SELECT salesdb.orders.| FROM salesdb.orders",
      );

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["id", "amount"]),
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "salesdb",
        "orders",
        undefined,
      );
    });

    const quotedAliasCompletionScenarios: QuotedAliasCompletionScenario[] = [
      {
        name: "Netezza double-quoted db..table alias",
        databaseKind: "netezza",
        effectiveDatabase: "JUST_DATA",
        database: "JUST_DATA",
        table: "DIMACCOUNT",
        columns: ["ACCOUNTKEY", "ACCOUNTNAME"],
        sql: 'SELECT "a".| FROM "JUST_DATA".."DIMACCOUNT" "a"',
      },
      {
        name: "SQLite double-quoted catalog.table alias",
        databaseKind: "sqlite",
        effectiveDatabase: "main",
        database: "salesdb",
        table: "orders",
        columns: ["id", "amount"],
        sql: 'SELECT "o".| FROM "salesdb"."orders" "o"',
      },
      {
        name: "DB2 double-quoted schema.table alias",
        databaseKind: "db2",
        effectiveDatabase: "TESTDB",
        database: "TESTDB",
        schema: "DB2INST1",
        table: "EM",
        columns: ["EMPNO", "ENAME"],
        sql: 'SELECT "e".| FROM "DB2INST1"."EM" "e"',
      },
      {
        name: "Oracle double-quoted schema.table alias",
        databaseKind: "oracle",
        effectiveDatabase: "ORCL",
        database: "ORCL",
        schema: "HR",
        table: "EMPLOYEES",
        columns: ["EMPLOYEE_ID", "LAST_NAME"],
        sql: 'SELECT "e".| FROM "HR"."EMPLOYEES" "e"',
      },
      {
        name: "PostgreSQL double-quoted schema.table alias",
        databaseKind: "postgresql",
        effectiveDatabase: "APPDB",
        database: "APPDB",
        schema: "public",
        table: "orders",
        columns: ["id", "customer_id", "status"],
        sql: 'SELECT "o".| FROM "public"."orders" "o"',
      },
      {
        name: "Snowflake double-quoted db.schema.table alias",
        databaseKind: "snowflake",
        effectiveDatabase: "ANALYTICS",
        database: "ANALYTICS",
        schema: "PUBLIC",
        table: "ORDERS",
        columns: ["ORDER_ID", "AMOUNT"],
        sql: 'SELECT "o".| FROM "ANALYTICS"."PUBLIC"."ORDERS" "o"',
      },
      {
        name: "Vertica double-quoted schema.table alias",
        databaseKind: "vertica",
        effectiveDatabase: "VMART",
        database: "VMART",
        schema: "public",
        table: "orders",
        columns: ["order_id", "amount"],
        sql: 'SELECT "o".| FROM "public"."orders" "o"',
      },
      {
        name: "MySQL backtick-quoted database.table alias",
        databaseKind: "mysql",
        effectiveDatabase: "salesdb",
        database: "salesdb",
        table: "orders",
        columns: ["id", "amount"],
        sql: "SELECT `o`.| FROM `salesdb`.`orders` `o`",
      },
      {
        name: "MSSQL bracket-quoted db.schema.table alias",
        databaseKind: "mssql",
        effectiveDatabase: "TESTDB",
        database: "TESTDB",
        schema: "dbo",
        table: "Orders",
        columns: ["OrderID", "CustomerID"],
        sql: "SELECT [o].| FROM [TESTDB].[dbo].[Orders] [o]",
      },
      {
        name: "DuckDB double-quoted schema.table alias",
        databaseKind: "duckdb",
        effectiveDatabase: "DUCKDB",
        database: "DUCKDB",
        schema: "main",
        table: "orders",
        columns: ["order_id", "amount"],
        sql: 'SELECT "o".| FROM "main"."orders" "o"',
      },
    ];

    it.each(quotedAliasCompletionScenarios)(
      "returns columns for $name",
      async (scenario) => {
        metadataProvider.databaseKind = scenario.databaseKind;
        metadataProvider.effectiveDatabase = scenario.effectiveDatabase;
        metadataProvider.setColumns(
          scenario.database,
          scenario.table,
          scenario.columns,
          scenario.schema,
        );

        const items = await complete(scenario.sql);

        expect(labelsWithoutExpand(items)).toEqual(
          expect.arrayContaining(scenario.columns),
        );
        const isNetezzaDoubleDot =
          scenario.databaseKind === "netezza" &&
          scenario.sql.includes("..") &&
          scenario.schema === undefined;
        if (isNetezzaDoubleDot) {
          expect(metadataProvider.getColumns).toHaveBeenCalledWith(
            expect.any(String),
            scenario.database,
            scenario.table,
          );
        } else {
          expect(metadataProvider.getColumns).toHaveBeenCalledWith(
            expect.any(String),
            scenario.database,
            scenario.table,
            scenario.schema,
          );
        }
      },
    );

    it("returns columns for MySQL backtick-quoted database.table qualifier", async () => {
      metadataProvider.databaseKind = "mysql";
      metadataProvider.effectiveDatabase = "salesdb";
      metadataProvider.setColumns("salesdb", "orders", ["id", "amount"]);

      const items = await complete(
        "SELECT `salesdb`.`orders`.| FROM `salesdb`.`orders`",
      );

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["id", "amount"]),
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "salesdb",
        "orders",
        undefined,
      );
    });

    it("returns tables for MySQL database dot completion", async () => {
      metadataProvider.databaseKind = "mysql";
      metadataProvider.effectiveDatabase = "salesdb";
      metadataProvider.setTables("salesdb", ["orders", "customers"]);

      const items = await complete("SELECT * FROM salesdb.|");

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["orders", "customers"]),
      );
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "salesdb",
      );
    });

    it("returns columns for alias with explicit column list CTE", async () => {
      const items = await complete(`WITH CTE1(ACCT_ID, ACCT_NAME) AS (
    SELECT ACCOUNTKEY, ACCOUNTNAME FROM JUST_DATA..DIMACCOUNT
)
SELECT C.| FROM CTE1 C`);
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCT_ID", "ACCT_NAME"]),
      );
    });

    it("returns only explicit CTE columns when CTE has column list and SELECT star", async () => {
      const session = new DocumentParseSession();
      const scopedEngine = new LspCompletionEngine(metadataProvider, session);
      const items = await completeWithEngine(
        scopedEngine,
        `WITH c(out_a, out_b) AS (
  SELECT * FROM JUST_DATA..DIMDATE
)
SELECT c.|
FROM c`,
      );

      expect(labelsWithoutExpand(items).sort()).toEqual(["out_a", "out_b"]);
    });

    it("does not shadow cached metadata with CTEs from earlier statements", async () => {
      const session = new DocumentParseSession();
      const scopedEngine = new LspCompletionEngine(metadataProvider, session);
      const items = await completeWithEngine(
        scopedEngine,
        `WITH DIMDATE AS (
  SELECT 999 AS cte_only_col
)
SELECT * FROM DIMDATE;

WITH cte2 AS (
  SELECT * FROM JUST_DATA..DIMDATE
)
SELECT cte2.|
FROM cte2`,
      );

      expect(labels(items)).toEqual(
        expect.arrayContaining(["DATEKEY", "CALENDARQUARTER"]),
      );
      expect(labels(items)).not.toContain("cte_only_col");
    });

    it("handles UNION query with column completion", async () => {
      const items = await complete(`SELECT A.| FROM JUST_DATA..DIMACCOUNT A
UNION ALL
SELECT ACCOUNTKEY FROM JUST_DATA..DIMEMPLOYEE`);
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTNAME"]),
      );
    });

    it("handles INTERSECT query with column completion", async () => {
      const items = await complete(`SELECT A.| FROM JUST_DATA..DIMACCOUNT A
INTERSECT
SELECT ACCOUNTKEY FROM JUST_DATA..DIMEMPLOYEE`);
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTNAME"]),
      );
    });

    it("handles EXCEPT query with column completion", async () => {
      const items = await complete(`SELECT A.| FROM JUST_DATA..DIMACCOUNT A
EXCEPT
SELECT ACCOUNTKEY FROM JUST_DATA..DIMEMPLOYEE`);
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTNAME"]),
      );
    });

    it("handles EXCEPT with parenthesized WITH query on the right-hand side", async () => {
      const items = await complete(`SELECT 1 AS A
EXCEPT
(
  WITH X AS (
    SELECT ACCOUNTKEY, ACCOUNTNAME FROM JUST_DATA..DIMACCOUNT
  )
  SELECT X.| FROM X
)`);
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTNAME"]),
      );
    });
  });

  describe("edge cases and error handling", () => {
    it("returns keywords for empty document", async () => {
      const items = await complete("|");
      expect(items.length).toBeGreaterThan(0); // Should still return keywords
    });

    it("handles completion at end of incomplete SQL", async () => {
      const items = await complete("SELECT * FROM|");
      expect(Array.isArray(items)).toBe(true);
    });

    it("handles completion in comment", async () => {
      const items = await complete(
        "SELECT * FROM JUST_DATA..DIMACCOUNT /* comment | */",
      );
      // Should still provide completions or gracefully handle
      expect(Array.isArray(items)).toBe(true);
    });

    it("handles completion after string literal", async () => {
      const items = await complete(
        "SELECT 'test' | FROM JUST_DATA..DIMACCOUNT",
      );
      // After string literal, should provide column suggestions from table
      const hasColumns = labels(items).some((l) =>
        ["ACCOUNTKEY", "ACCOUNTNAME"].includes(l),
      );
      expect(hasColumns || items.length > 0).toBe(true);
    });

    it("handles completion in subquery after ORDER BY", async () => {
      const items = await complete(
        "SELECT * FROM (SELECT A.| FROM JUST_DATA..DIMACCOUNT A ORDER BY ACCOUNTKEY) SQ",
      );
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTNAME"]),
      );
    });

    it("handles completion with nested parentheses", async () => {
      const items = await complete(
        "SELECT * FROM JUST_DATA..DIMACCOUNT WHERE (ACCOUNTKEY IN (SELECT |",
      );
      // Should provide column suggestions
      expect(Array.isArray(items)).toBe(true);
    });

    it("keeps alias completion when SQL suffix is unterminated", async () => {
      const items = await complete(
        `SELECT A.| FROM JUST_DATA..DIMACCOUNT A WHERE '`,
      );
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTNAME"]),
      );
    });

    it("keeps unqualified semantic completion with unterminated trailing literal", async () => {
      const items = await complete(
        `SELECT * FROM JUST_DATA..DIMACCOUNT A WHERE ACC|'`,
      );
      expect(labels(items)).toContain("ACCOUNTKEY");
    });
  });

  describe("database context inheritance", () => {
    it("uses effective database for unqualified table references", async () => {
      metadataProvider.effectiveDatabase = "JUST_DATA";
      await complete("SELECT * FROM |");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA",
      );
    });

    it("falls back to BAZA when no effective database set", async () => {
      metadataProvider.effectiveDatabase = "BAZA";
      await complete("SELECT * FROM |");
      expect(metadataProvider.getTables).toHaveBeenCalledWith(
        expect.any(String),
        "BAZA",
      );
    });

    it("includes DB2 schemas in root FROM suggestions", async () => {
      metadataProvider.databaseKind = "db2";
      metadataProvider.effectiveDatabase = "TESTDB";
      metadataProvider.setSchemas("TESTDB", ["DB2INST1", "HR"]);

      const items = await complete("SELECT * FROM |");

      expect(labels(items)).toEqual(expect.arrayContaining(["DB2INST1", "HR"]));
      expect(metadataProvider.getSchemas).toHaveBeenCalledWith(
        expect.any(String),
        "TESTDB",
      );
    });
  });

  describe("complex multi-CTE scenarios", () => {
    it("handles three chained CTEs correctly", async () => {
      const items = await complete(`WITH
CTE1 AS (SELECT ACCOUNTKEY, ACCOUNTNAME FROM JUST_DATA..DIMACCOUNT),
CTE2 AS (SELECT * FROM CTE1),
CTE3 AS (SELECT * FROM CTE2)
SELECT C.| FROM CTE3 C`);
      expect(labels(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTNAME"]),
      );
    });

    it("handles CTE referencing multiple base tables", async () => {
      const items = await complete(`WITH CTE1 AS (
    SELECT A.ACCOUNTKEY, D.DATEKEY
    FROM JUST_DATA..DIMACCOUNT A
    JOIN JUST_DATA..DIMDATE D ON 1=1
)
SELECT C.| FROM CTE1 C`);
      const itemLabels = labels(items);
      expect(itemLabels).toContain("ACCOUNTKEY");
      expect(itemLabels).toContain("DATEKEY");
    });

    it("handles recursive CTE (if supported)", async () => {
      const items = await complete(`WITH RECURSIVE CTE1 AS (
    SELECT 1 AS LEVEL, ACCOUNTKEY FROM JUST_DATA..DIMACCOUNT
    UNION ALL
    SELECT LEVEL + 1, ACCOUNTKEY FROM CTE1 WHERE LEVEL < 5
)
SELECT C.| FROM CTE1 C`);
      const itemLabels = labels(items);
      expect(itemLabels).toContain("LEVEL");
      expect(itemLabels).toContain("ACCOUNTKEY");
    });
  });

  describe("table-valued function and special syntax", () => {
    it("handles completion after TABLE keyword", async () => {
      const items = await complete("SELECT * FROM TABLE(|");
      expect(Array.isArray(items)).toBe(true);
    });

    it("handles completion in LIMIT clause", async () => {
      const items = await complete(
        "SELECT * FROM JUST_DATA..DIMACCOUNT LIMIT |",
      );
      // Should provide number suggestions or nothing
      expect(Array.isArray(items)).toBe(true);
    });

    it("handles completion in OFFSET clause", async () => {
      const items = await complete(
        "SELECT * FROM JUST_DATA..DIMACCOUNT LIMIT 10 OFFSET |",
      );
      expect(Array.isArray(items)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // P50: PARITY GATE — Completion Regression Smoke Tests
  // These tests form a protected CI gate. Do NOT remove or weaken
  // assertions without explicit approval.
  // ═══════════════════════════════════════════════════════════════════
  describe("PARITY GATE — completion regression smoke tests", () => {
    it("GATE: resolves columns correctly in 3-way JOIN with mixed alias paths", async () => {
      const items = await complete(`SELECT A.|
FROM JUST_DATA..DIMACCOUNT A
JOIN JUST_DATA..DIMDATE D ON D.DATEKEY = A.ACCOUNTKEY
JOIN JUST_DATA..DIMEMPLOYEE E ON E.EMPLOYEEKEY = A.ACCOUNTKEY`);
      const itemLabels = labels(items);
      expect(itemLabels).toContain("ACCOUNTKEY");
      expect(itemLabels).toContain("ACCOUNTNAME");
      expect(itemLabels).not.toContain("DATEKEY");
      expect(itemLabels).not.toContain("EMPLOYEEKEY");

      const itemsD = await complete(`SELECT D.|
FROM JUST_DATA..DIMACCOUNT A
JOIN JUST_DATA..DIMDATE D ON D.DATEKEY = A.ACCOUNTKEY
JOIN JUST_DATA..DIMEMPLOYEE E ON E.EMPLOYEEKEY = A.ACCOUNTKEY`);
      expect(labels(itemsD)).toContain("DATEKEY");
      expect(labels(itemsD)).toContain("CALENDARQUARTER");
      expect(labels(itemsD)).not.toContain("ACCOUNTKEY");
    });

    it("GATE: propagates wildcard columns through 3 chained CTEs correctly", async () => {
      const items = await complete(`WITH
CTE1 AS (SELECT ACCOUNTKEY, ACCOUNTNAME FROM JUST_DATA..DIMACCOUNT),
CTE2 AS (SELECT * FROM CTE1),
CTE3 AS (SELECT * FROM CTE2)
SELECT C.|
FROM CTE3 C`);
      const itemLabels = labels(items);
      expect(itemLabels).toContain("ACCOUNTKEY");
      expect(itemLabels).toContain("ACCOUNTNAME");
      expect(itemLabels).not.toContain("DATEKEY");
      expect(itemLabels).not.toContain("EMPLOYEEKEY");
    });

    it("GATE: CTAS temp table columns survive across statement boundary", async () => {
      const items = await complete(`CREATE TEMP TABLE STG AS (
  SELECT A.ACCOUNTKEY, A.ACCOUNTNAME FROM JUST_DATA..DIMACCOUNT A
) DISTRIBUTE ON RANDOM;
SELECT S.| FROM STG S`);
      const itemLabels = labels(items);
      expect(itemLabels).toContain("ACCOUNTKEY");
      expect(itemLabels).toContain("ACCOUNTNAME");
      expect(metadataProvider.getColumns).not.toHaveBeenCalled();
    });

    it("GATE: MERGE target and source aliases resolve independently", async () => {
      const itemsTarget = await complete(`MERGE INTO JUST_DATA..DIMACCOUNT T
USING JUST_DATA..DIMEMPLOYEE S ON T.ACCOUNTKEY = S.EMPLOYEEKEY
WHEN MATCHED THEN UPDATE SET T.|`);
      const targetLabels = labels(itemsTarget);
      expect(targetLabels).toContain("ACCOUNTKEY");
      expect(targetLabels).toContain("ACCOUNTNAME");
      expect(targetLabels).not.toContain("EMPLOYEEKEY");

      const itemsSource = await complete(`MERGE INTO JUST_DATA..DIMACCOUNT T
USING JUST_DATA..DIMEMPLOYEE S ON T.ACCOUNTKEY = S.EMPLOYEEKEY
WHEN MATCHED THEN UPDATE SET S.|`);
      const sourceLabels = labels(itemsSource);
      expect(sourceLabels).toContain("EMPLOYEEKEY");
      expect(sourceLabels).toContain("BASERATE");
      expect(sourceLabels).not.toContain("ACCOUNTNAME");
    });

    it("GATE: wildcard expansion excludes COUNT(*) but includes table wildcards", async () => {
      const items = await complete(`CREATE TEMP TABLE MIXED AS (
  SELECT COUNT(*) AS ROW_CNT, DA.* FROM JUST_DATA..DIMACCOUNT DA
) DISTRIBUTE ON RANDOM;
SELECT M.| FROM MIXED M`);
      const itemLabels = labelsWithoutExpand(items);
      expect(itemLabels).toContain("ROW_CNT");
      expect(itemLabels).toContain("ACCOUNTKEY");
      expect(itemLabels).toContain("ACCOUNTCODEALTERNATEKEY");
    });

    it("GATE: alias completion works with broken trailing SQL (error-tolerant)", async () => {
      const items1 = await complete(
        `SELECT A.| FROM JUST_DATA..DIMACCOUNT A WHERE '`,
      );
      expect(labels(items1)).toContain("ACCOUNTKEY");
      expect(labels(items1)).toContain("ACCOUNTNAME");

      const items2 = await complete(
        `SELECT A.| FROM JUST_DATA..DIMACCOUNT A WHERE ACCOUNTKEY =`,
      );
      expect(labels(items2)).toContain("ACCOUNTKEY");
    });

    it("returns columns for DB..TABLE alias when table lives outside effective schema", async () => {
      metadataProvider.effectiveSchema = "ADMIN";
      metadataProvider.netezzaSchemasEnabled = false;
      metadataProvider.setColumns(
        "JUST_DATA_5",
        "DIMACCOUNT_NS",
        ["ACCOUNTKEY", "ACCOUNTNAME"],
        "PUBLIC",
      );

      const items = await complete(
        "SELECT C.| FROM JUST_DATA_5..DIMACCOUNT_NS C",
      );

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTNAME"]),
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA_5",
        "DIMACCOUNT_NS",
      );
    });

    it("returns columns for DB..TABLE alias using database default schema when schemas are enabled", async () => {
      metadataProvider.effectiveSchema = "ADMIN";
      metadataProvider.netezzaSchemasEnabled = true;
      metadataProvider.setDefaultSchema("JUST_DATA_5", "PUBLIC");
      metadataProvider.setColumns(
        "JUST_DATA_5",
        "DIMACCOUNT_NS",
        ["ACCOUNTKEY", "ACCOUNTNAME"],
        "PUBLIC",
      );

      const items = await complete(
        "SELECT C.| FROM JUST_DATA_5..DIMACCOUNT_NS C",
      );

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["ACCOUNTKEY", "ACCOUNTNAME"]),
      );
      expect(metadataProvider.getNetezzaDefaultSchema).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA_5",
      );
      expect(metadataProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "JUST_DATA_5",
        "DIMACCOUNT_NS",
        "PUBLIC",
      );
    });
  });

  describe("alias resolution with qualified table names", () => {
    it("returns columns for PostgreSQL schema.table alias (public.orders)", async () => {
      metadataProvider.databaseKind = "postgresql";
      metadataProvider.effectiveDatabase = "appdb";
      metadataProvider.effectiveSchema = "public";
      metadataProvider.setColumns(
        "appdb",
        "orders",
        ["id", "customer_id", "status"],
        "public",
      );

      const items = await complete("SELECT o.| FROM public.orders o");

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["id", "customer_id", "status"]),
      );
    });

    it("returns columns for PostgreSQL plain table name with default schema", async () => {
      metadataProvider.databaseKind = "postgresql";
      metadataProvider.effectiveDatabase = "appdb";
      metadataProvider.effectiveSchema = "public";
      metadataProvider.setColumns(
        "appdb",
        "orders",
        ["id", "customer_id", "status"],
        "public",
      );

      const items = await complete("SELECT o.| FROM orders o");

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["id", "customer_id", "status"]),
      );
    });

    it("returns columns for Snowflake schema.table alias (PUBLIC.MY_CUSTOMER)", async () => {
      metadataProvider.databaseKind = "snowflake";
      metadataProvider.effectiveDatabase = "ANALYTICS";
      metadataProvider.effectiveSchema = "PUBLIC";
      metadataProvider.setColumns(
        "ANALYTICS",
        "MY_CUSTOMER",
        ["CUSTOMER_ID", "NAME"],
        "PUBLIC",
      );

      const items = await complete("SELECT c.| FROM PUBLIC.MY_CUSTOMER c");

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["CUSTOMER_ID", "NAME"]),
      );
    });

    it("returns columns for Snowflake fully qualified (DB.SCHEMA.TABLE)", async () => {
      metadataProvider.databaseKind = "snowflake";
      metadataProvider.effectiveDatabase = "SNOWFLAKE_LEARNING_DB";
      metadataProvider.effectiveSchema = "PUBLIC";
      metadataProvider.setColumns(
        "SNOWFLAKE_LEARNING_DB",
        "MY_CUSTOMER",
        ["CUSTOMER_ID", "NAME"],
        "PUBLIC",
      );

      const items = await complete(
        "SELECT c.| FROM SNOWFLAKE_LEARNING_DB.PUBLIC.MY_CUSTOMER c",
      );

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["CUSTOMER_ID", "NAME"]),
      );
    });

    it("returns columns for MSSQL plain table name with default schema", async () => {
      metadataProvider.databaseKind = "mssql";
      metadataProvider.effectiveDatabase = "TESTDB";
      metadataProvider.effectiveSchema = "dbo";
      metadataProvider.setColumns(
        "TESTDB",
        "employees",
        ["EmployeeID", "Name"],
        "dbo",
      );

      const items = await complete("SELECT e.| FROM employees e");

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["EmployeeID", "Name"]),
      );
    });

    it("returns columns for MSSQL double-dot notation (DB..TABLE)", async () => {
      metadataProvider.databaseKind = "mssql";
      metadataProvider.effectiveDatabase = "TESTDB";
      metadataProvider.effectiveSchema = "dbo";
      metadataProvider.setColumns(
        "TESTDB",
        "employees",
        ["EmployeeID", "Name"],
        "dbo",
      );

      const items = await complete("SELECT e.| FROM TESTDB..employees e");

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["EmployeeID", "Name"]),
      );
    });

    it("returns columns for Vertica schema.table alias (public.employees)", async () => {
      metadataProvider.databaseKind = "vertica";
      metadataProvider.effectiveDatabase = "VMART";
      metadataProvider.effectiveSchema = "public";
      metadataProvider.setColumns(
        "VMART",
        "employees",
        ["employee_id", "name"],
        "public",
      );

      const items = await complete("SELECT e.| FROM public.employees e");

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["employee_id", "name"]),
      );
    });

    it("returns columns for Vertica plain table name with default schema", async () => {
      metadataProvider.databaseKind = "vertica";
      metadataProvider.effectiveDatabase = "VMART";
      metadataProvider.effectiveSchema = "public";
      metadataProvider.setColumns(
        "VMART",
        "employees",
        ["employee_id", "name"],
        "public",
      );

      const items = await complete("SELECT e.| FROM employees e");

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["employee_id", "name"]),
      );
    });

    it("returns columns for MySQL database.table alias", async () => {
      metadataProvider.databaseKind = "mysql";
      metadataProvider.effectiveDatabase = "mydb";
      metadataProvider.effectiveSchema = undefined;
      metadataProvider.setColumns("mydb", "orders", ["id", "amount"]);

      const items = await complete("SELECT o.| FROM mydb.orders o");

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["id", "amount"]),
      );
    });
  });

  describe("case-normalized metadata lookup fallbacks", () => {
    it("falls back to lowercase catalog names for PostgreSQL unquoted aliases", async () => {
      const strictProvider = new StrictCaseMetadataProvider(
        "postgresql",
        "appdb",
        "public",
      );
      strictProvider.setColumns("appdb", "orders", ["id", "customer_id"], "public");
      const strictEngine = new LspCompletionEngine(strictProvider);

      const items = await completeWithEngine(
        strictEngine,
        "SELECT o.| FROM PUBLIC.ORDERS o",
      );

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["id", "customer_id"]),
      );
      expect(strictProvider.getColumns).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        "appdb",
        "ORDERS",
        "PUBLIC",
      );
      expect(strictProvider.getColumns).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        "appdb",
        "orders",
        "public",
      );
    });

    it("falls back to uppercase catalog names for Snowflake unquoted aliases", async () => {
      const strictProvider = new StrictCaseMetadataProvider(
        "snowflake",
        "ANALYTICS",
        "PUBLIC",
      );
      strictProvider.setColumns(
        "ANALYTICS",
        "MY_CUSTOMER",
        ["CUSTOMER_ID", "NAME"],
        "PUBLIC",
      );
      const strictEngine = new LspCompletionEngine(strictProvider);

      const items = await completeWithEngine(
        strictEngine,
        "SELECT c.| FROM analytics.public.my_customer c",
      );

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["CUSTOMER_ID", "NAME"]),
      );
      expect(strictProvider.getColumns).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        "analytics",
        "my_customer",
        "public",
      );
      expect(strictProvider.getColumns).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        "ANALYTICS",
        "MY_CUSTOMER",
        "PUBLIC",
      );
    });

    it("keeps exact-case lookups first for quoted PostgreSQL identifiers", async () => {
      const strictProvider = new StrictCaseMetadataProvider(
        "postgresql",
        "appdb",
        "public",
      );
      strictProvider.setColumns("appdb", "OrderLines", ["LineID"], "Sales");
      const strictEngine = new LspCompletionEngine(strictProvider);

      const items = await completeWithEngine(
        strictEngine,
        'SELECT "o".| FROM "Sales"."OrderLines" "o"',
      );

      expect(labelsWithoutExpand(items)).toEqual(
        expect.arrayContaining(["LineID"]),
      );
      expect(strictProvider.getColumns).toHaveBeenCalledTimes(1);
      expect(strictProvider.getColumns).toHaveBeenCalledWith(
        expect.any(String),
        "appdb",
        "OrderLines",
        "Sales",
      );
    });
  });

  describe("DocumentParseSession", () => {
    it("reuses parse cache for repeated qualifier completion on the same statement", async () => {
      metadataProvider.setColumns("JUST_DATA", "T1", ["COL1", "COL2"]);
      const session = new DocumentParseSession();
      const sessionEngine = new LspCompletionEngine(metadataProvider, session);
      const parseSpy = jest.spyOn(parsingRuntime, "parseSqlStatements");

      await completeWithEngine(
        sessionEngine,
        "SELECT X.| FROM JUST_DATA.ADMIN.T1 X",
      );
      const callsAfterFirst = parseSpy.mock.calls.length;
      await completeWithEngine(
        sessionEngine,
        "SELECT X.| FROM JUST_DATA.ADMIN.T1 X",
      );

      expect(callsAfterFirst).toBeGreaterThan(0);
      expect(parseSpy.mock.calls.length).toBe(callsAfterFirst);
      parseSpy.mockRestore();
    });
  });
});
