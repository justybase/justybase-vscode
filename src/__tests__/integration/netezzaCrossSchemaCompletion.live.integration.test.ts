/**
 * Live Netezza cross-schema completion fixture.
 *
 * Prerequisites:
 * - NZ_DEV_PASSWORD (and optionally NZ_DEV_HOST/PORT/DATABASE/USER)
 * - NZ_DEV_ALLOW_FIXTURE_DDL=1 (creates and drops two uniquely named tables)
 *
 * Run:
 *   NZ_DEV_ALLOW_FIXTURE_DDL=1 npx jest --config jest.live.config.js --runInBand \
 *     src/__tests__/integration/netezzaCrossSchemaCompletion.live.integration.test.ts
 */

jest.unmock("chevrotain");

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { NzConnection } from "@justybase/netezza-driver";
import { ensureBuiltInDialectsRegistered } from "../../dialects";
import type { MetadataColumnItem, MetadataObjectItem } from "../../lsp/protocol";
import {
  LspCompletionEngine,
  type CompletionMetadataProvider,
} from "../../server/completionEngine";
import {
  buildNetezzaLiveDetails,
  createNetezzaLiveConnection,
  executeNetezza,
  quoteNetezzaLiteral,
  readRecordRows,
  readScalar,
  tryExecuteNetezza,
  uniqueNetezzaName,
} from "./netezzaLiveTestHarness";

const fixtureDdlEnabled =
  Boolean(process.env.NZ_DEV_PASSWORD)
  && process.env.NZ_DEV_ALLOW_FIXTURE_DDL === "1";
const describeIfFixture = fixtureDdlEnabled ? describe : describe.skip;
const itIfFixture = fixtureDdlEnabled ? it : it.skip;

interface CapturedRelation {
  TABLENAME: string;
  SCHEMA: string;
}

function createDocumentWithCursor(sqlWithCursor: string): {
  document: TextDocument;
  cursorOffset: number;
} {
  const cursorOffset = sqlWithCursor.indexOf("|");
  if (cursorOffset < 0) {
    throw new Error('Missing cursor marker "|"');
  }
  const sql = `${sqlWithCursor.slice(0, cursorOffset)}${sqlWithCursor.slice(cursorOffset + 1)}`;
  return {
    document: TextDocument.create(
      "file:///netezza-cross-schema-live.sql",
      "sql",
      1,
      sql,
    ),
    cursorOffset,
  };
}

class CapturedCatalogProvider implements CompletionMetadataProvider {
  public readonly getTablesCalls: Array<{
    database: string;
    schema?: string;
  }> = [];

  public constructor(
    private readonly databaseName: string,
    private readonly defaultSchema: string,
    private readonly rows: CapturedRelation[],
  ) {}

  public async getContext(): Promise<{
    effectiveDatabase: string;
    effectiveSchema: string;
    databaseKind: "netezza";
    netezzaSchemasEnabled: boolean;
  }> {
    return {
      effectiveDatabase: this.databaseName,
      effectiveSchema: this.defaultSchema,
      databaseKind: "netezza",
      netezzaSchemasEnabled: true,
    };
  }

  public async getDatabases(): Promise<MetadataObjectItem[]> {
    return [{ name: this.databaseName, detail: "Database" }];
  }

  public async getSchemas(): Promise<MetadataObjectItem[]> {
    return [...new Set([
      this.defaultSchema,
      ...this.rows.map((row) => row.SCHEMA),
    ])].map((name) => ({
      name,
      database: this.databaseName,
      detail: "Schema",
    }));
  }

  public async getTables(
    _documentUri: string,
    database: string,
    schema?: string,
  ): Promise<MetadataObjectItem[]> {
    this.getTablesCalls.push({ database, schema });
    return this.rows
      .filter((row) => schema === undefined || row.SCHEMA === schema)
      .map((row) => ({
        name: row.TABLENAME,
        database,
        schema: row.SCHEMA,
        objectType: "table",
        detail: "Table",
      }));
  }

  public async getViews(): Promise<MetadataObjectItem[]> {
    return [];
  }

  public async getProcedures(): Promise<MetadataObjectItem[]> {
    return [];
  }

  public async getNetezzaDefaultSchema(): Promise<string> {
    return this.defaultSchema;
  }

  public async getColumns(): Promise<MetadataColumnItem[]> {
    return [
      { name: "ID", type: "INTEGER" },
      { name: "LABEL", type: "VARCHAR" },
    ];
  }
}

describeIfFixture("Netezza cross-schema completion - live fixture", () => {
  let connection: NzConnection;
  let database: string;
  let defaultSchema: string;
  let otherSchema: string;
  let tableName: string;
  let createdDefault = false;
  let createdOther = false;
  let createdSchema = false;
  let rows: CapturedRelation[] = [];

  beforeAll(async () => {
    ensureBuiltInDialectsRegistered();
    database = buildNetezzaLiveDetails().database;
    connection = createNetezzaLiveConnection(database);
    await connection.connect();

    const resolvedDefault = await readScalar(
      connection,
      "SELECT DEFSCHEMA FROM _V_DATABASE "
        + `WHERE DATABASE = ${quoteNetezzaLiteral(database)}`,
    );
    defaultSchema = String(resolvedDefault ?? "").trim().toUpperCase();
    if (!defaultSchema) {
      throw new Error(`Netezza fixture database ${database} has no DEFSCHEMA.`);
    }

    // Use a dedicated schema instead of assuming PUBLIC exists or is writable.
    otherSchema = uniqueNetezzaName("JK_CROSS_S");
    tableName = uniqueNetezzaName("JK_CROSS");
    const columnList = "ID INTEGER, LABEL VARCHAR(32)";

    await executeNetezza(
      connection,
      `CREATE SCHEMA ${database}.${otherSchema}`,
    );
    createdSchema = true;
    await executeNetezza(
      connection,
      `CREATE TABLE ${database}.${defaultSchema}.${tableName} (${columnList})`,
    );
    createdDefault = true;
    await executeNetezza(
      connection,
      `CREATE TABLE ${database}.${otherSchema}.${tableName} (${columnList})`,
    );
    createdOther = true;
    await executeNetezza(
      connection,
      `INSERT INTO ${database}.${defaultSchema}.${tableName} VALUES (1, 'DEFAULT')`,
    );
    await executeNetezza(
      connection,
      `INSERT INTO ${database}.${otherSchema}.${tableName} VALUES (1, 'OTHER')`,
    );

    rows = await readRecordRows(
      connection,
      `SELECT TABLENAME, SCHEMA FROM ${database}.._V_TABLE `
        + `WHERE TABLENAME = ${quoteNetezzaLiteral(tableName)} `
        + `AND SCHEMA IN (${quoteNetezzaLiteral(defaultSchema)}, `
        + `${quoteNetezzaLiteral(otherSchema)}) ORDER BY SCHEMA`,
    ).then((captured) => captured.map((row) => ({
      TABLENAME: String(row.TABLENAME),
      SCHEMA: String(row.SCHEMA),
    })));
  }, 60000);

  afterAll(async () => {
    if (connection) {
      if (createdOther) {
        await tryExecuteNetezza(
          connection,
          `DROP TABLE ${database}.${otherSchema}.${tableName}`,
        );
      }
      if (createdDefault) {
        await tryExecuteNetezza(
          connection,
          `DROP TABLE ${database}.${defaultSchema}.${tableName}`,
        );
      }
      if (createdSchema) {
        await tryExecuteNetezza(
          connection,
          `DROP SCHEMA ${database}.${otherSchema} CASCADE`,
        );
      }
      await connection.close();
    }
  });

  itIfFixture("keeps the same object name in two schemas", () => {
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.SCHEMA).sort()).toEqual(
      [defaultSchema, otherSchema].sort(),
    );
    expect(new Set(rows.map((row) => row.TABLENAME))).toEqual(new Set([tableName]));
  });

  itIfFixture("executes DB.. and DB.SCHEMA. against the intended schemas", async () => {
    const defaultValue = await readScalar(
      connection,
      `SELECT LABEL FROM ${database}..${tableName}`,
    );
    const otherValue = await readScalar(
      connection,
      `SELECT LABEL FROM ${database}.${otherSchema}.${tableName}`,
    );

    expect(String(defaultValue)).toBe("DEFAULT");
    expect(String(otherValue)).toBe("OTHER");
  });

  itIfFixture("offers only the default-schema object under DB..", async () => {
    const provider = new CapturedCatalogProvider(database, defaultSchema, rows);
    const engine = new LspCompletionEngine(provider);
    const { document, cursorOffset } = createDocumentWithCursor(
      `SELECT * FROM ${database}..|`,
    );

    const items = await engine.provideCompletionItems(
      document,
      document.positionAt(cursorOffset),
    );
    const matches = items.filter((item) => item.label === tableName);
    expect(matches).toHaveLength(1);
    expect((matches[0].data as { schema?: string }).schema).toBe(defaultSchema);
    expect(provider.getTablesCalls).toEqual([{
      database,
      schema: defaultSchema,
    }]);
  });

  itIfFixture("accepts a DB.. item without rewriting the typed prefix", async () => {
    const provider = new CapturedCatalogProvider(database, defaultSchema, rows);
    const engine = new LspCompletionEngine(provider);
    const prefix = tableName.slice(0, Math.min(6, tableName.length));
    const { document, cursorOffset } = createDocumentWithCursor(
      `SELECT * FROM ${database}..${prefix}|`,
    );

    const items = await engine.provideCompletionItems(
      document,
      document.positionAt(cursorOffset),
    );
    const item = items.find((candidate) => candidate.label === tableName);
    expect(item).toBeDefined();
    expect(item?.insertText).toBe(tableName);
    expect(item?.textEdit).toBeUndefined();
  });

  itIfFixture("offers the other schema under DB.SCHEMA. and inserts only the name", async () => {
    const provider = new CapturedCatalogProvider(database, defaultSchema, rows);
    const engine = new LspCompletionEngine(provider);
    const prefix = tableName.slice(0, Math.min(6, tableName.length));
    const { document, cursorOffset } = createDocumentWithCursor(
      `SELECT * FROM ${database}.${otherSchema}.${prefix}|`,
    );

    const items = await engine.provideCompletionItems(
      document,
      document.positionAt(cursorOffset),
    );
    const item = items.find((candidate) => candidate.label === tableName);
    expect(item).toBeDefined();
    expect((item?.data as { schema?: string }).schema).toBe(otherSchema);
    expect(item?.insertText).toBe(tableName);
    expect(item?.textEdit).toBeUndefined();
  });
});
