/**
 * Live Netezza tests for DB..TABLE completion semantics (SchemasOn).
 *
 * Prerequisites:
 * - NZ_DEV_PASSWORD (loaded from .env.local by jest setup or shell)
 * - Optional: NZ_DEV_HOST, NZ_DEV_PORT, NZ_DEV_DATABASE, NZ_DEV_USER
 *
 * Run:
 *   npm run test -- --testPathPatterns=netezzaDoubleDotCompletion.live --runInBand
 */

jest.unmock("chevrotain");

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { NzConnection } from "@justybase/netezza-driver";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { DatabaseConnection } from "../../contracts/database";
import { ensureBuiltInDialectsRegistered } from "../../dialects";
import { detectNetezzaSchemasEnabled } from "../../dialects/netezza/metadata/schemasOn";
import { netezzaMetadataProvider } from "../../dialects/netezza/metadata/provider";
import { NZ_QUERIES } from "../../dialects/netezza/metadata/systemQueries";
import {
  LspCompletionEngine,
  type CompletionMetadataProvider,
} from "../../server/completionEngine";
import { buildMetadataLookupTargets } from "../../server/completionPathUtils";
import type { MetadataColumnItem, MetadataObjectItem } from "../../lsp/protocol";

const skipTests = !process.env.NZ_DEV_PASSWORD;
const describeIfDb = skipTests ? describe.skip : describe;
const itIfDb = skipTests ? it.skip : it;

const DB_CONFIG = {
  host: process.env.NZ_DEV_HOST || "192.168.0.144",
  port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
  database: process.env.NZ_DEV_DATABASE || "JUST_DATA",
  user: process.env.NZ_DEV_USER || "admin",
  password: process.env.NZ_DEV_PASSWORD || "password",
};

const TARGET_DATABASE = process.env.NZ_DEV_DOUBLE_DOT_DB || "JUST_DATA_5";
const TARGET_TABLE = process.env.NZ_DEV_DOUBLE_DOT_TABLE || "DIMACCOUNT_NS";

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
      "file:///netezza-live-double-dot.sql",
      "sql",
      1,
      sql,
    ),
    cursorOffset,
  };
}

function columnLabels(items: { label: string }[]): string[] {
  return items
    .map((item) => item.label)
    .filter((label) => label !== "* (Expand Columns)");
}

class LiveNetezzaCompletionMetadataProvider
  implements CompletionMetadataProvider
{
  public readonly getColumnsCalls: Array<{
    database: string;
    table: string;
    schema?: string;
  }> = [];

  public readonly getNetezzaDefaultSchemaCalls: string[] = [];

  public constructor(
    private readonly connection: NzConnection,
    private readonly effectiveDatabase: string,
    private readonly options: {
      netezzaSchemasEnabled: boolean;
      defaultSchema?: string;
    },
  ) {}

  public async getContext(_documentUri: string): Promise<{
    effectiveDatabase?: string;
    effectiveSchema?: string;
    databaseKind?: "netezza";
    netezzaSchemasEnabled?: boolean;
  }> {
    return {
      effectiveDatabase: this.effectiveDatabase,
      effectiveSchema: "ADMIN",
      databaseKind: "netezza",
      netezzaSchemasEnabled: this.options.netezzaSchemasEnabled,
    };
  }

  public async getDatabases(_documentUri: string): Promise<MetadataObjectItem[]> {
    return [{ name: TARGET_DATABASE, detail: "Database" }];
  }

  public async getSchemas(
    _documentUri: string,
    _database: string,
  ): Promise<MetadataObjectItem[]> {
    return [];
  }

  public async getTables(
    _documentUri: string,
    _database: string,
    _schema?: string,
  ): Promise<MetadataObjectItem[]> {
    return [];
  }

  public async getViews(
    _documentUri: string,
    _database: string,
    _schema?: string,
  ): Promise<MetadataObjectItem[]> {
    return [];
  }

  public async getProcedures(
    _documentUri: string,
    _database: string,
    _schema?: string,
  ): Promise<MetadataObjectItem[]> {
    return [];
  }

  public async getNetezzaDefaultSchema(
    _documentUri: string,
    database: string,
  ): Promise<string | undefined> {
    this.getNetezzaDefaultSchemaCalls.push(database);
    return this.options.defaultSchema;
  }

  public async getColumns(
    _documentUri: string,
    database: string,
    table: string,
    schema?: string,
  ): Promise<MetadataColumnItem[]> {
    this.getColumnsCalls.push({ database, table, schema });

    const rows = await queryRows(
      this.connection,
      netezzaMetadataProvider.buildLookupColumnsQuery({
        database,
        schema,
        tableName: table,
      }),
    );

    const columns: MetadataColumnItem[] = [];
    for (const row of rows) {
      const name = row.ATTNAME;
      if (typeof name !== "string" || name.trim().length === 0) {
        continue;
      }

      const type = row.FORMAT_TYPE;
      columns.push({
        name,
        type:
          typeof type === "string" && type.trim().length > 0 ? type : "TEXT",
      });
    }

    return columns;
  }
}

async function queryRows(
  connection: NzConnection,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const reader = await connection.createCommand(sql).executeReader();
  const rows: Record<string, unknown>[] = [];
  try {
    const fieldCount = reader.fieldCount;
    while (await reader.read()) {
      const row: Record<string, unknown> = {};
      for (let index = 0; index < fieldCount; index += 1) {
        const name = reader.getName(index) ?? `COL_${index}`;
        row[name] = reader.getValue(index);
      }
      rows.push(row);
    }
  } finally {
    await reader.close();
  }
  return rows;
}

async function queryScalar(
  connection: NzConnection,
  sql: string,
  column?: string,
): Promise<string | undefined> {
  const rows = await queryRows(connection, sql);
  if (rows.length === 0) {
    return undefined;
  }
  const key = column ?? Object.keys(rows[0])[0];
  const value = rows[0][key];
  return value === null || value === undefined
    ? undefined
    : String(value).trim();
}

describeIfDb("Netezza DB..TABLE completion - live", () => {
  let connection: NzConnection;
  let schemasEnabled = false;
  let defaultSchema: string | undefined;
  let resolvedTableSchema: string | undefined;
  let sampleColumn: string | undefined;

  beforeAll(async () => {
    ensureBuiltInDialectsRegistered();

    connection = new NzConnection({
      host: DB_CONFIG.host,
      port: DB_CONFIG.port,
      database: DB_CONFIG.database,
      user: DB_CONFIG.user,
      password: DB_CONFIG.password,
    });
    await connection.connect();

    schemasEnabled = await detectNetezzaSchemasEnabled(
      connection as unknown as DatabaseConnection,
    );
    defaultSchema = await queryScalar(
      connection,
      `SELECT DEFSCHEMA FROM ${TARGET_DATABASE}.._V_DATABASE WHERE DATABASE = '${TARGET_DATABASE}'`,
      "DEFSCHEMA",
    );
    resolvedTableSchema = await queryScalar(
      connection,
      NZ_QUERIES.findTableSchema(TARGET_DATABASE, TARGET_TABLE),
      "SCHEMA",
    );

    if (resolvedTableSchema) {
      const columnRows = await queryRows(
        connection,
        `SELECT ATTNAME FROM ${TARGET_DATABASE}.._V_RELATION_COLUMN c
         JOIN ${TARGET_DATABASE}.._V_TABLE t ON c.OBJID = t.OBJID
         WHERE t.TABLENAME = '${TARGET_TABLE}' AND t.SCHEMA = '${resolvedTableSchema}'
         ORDER BY ATTNAME
         LIMIT 5`,
      );
      sampleColumn = columnRows[0]?.ATTNAME
        ? String(columnRows[0].ATTNAME)
        : undefined;
    }
  }, 60000);

  afterAll(async () => {
    if (connection) {
      await connection.close();
    }
  });

  itIfDb("live instance reports schemas enabled (SchemasOn)", () => {
    expect(schemasEnabled).toBe(true);
  });

  itIfDb("resolves DEFSCHEMA for target database", () => {
    expect(defaultSchema).toBeTruthy();
  });

  itIfDb("finds target table schema via catalog search (owner-mode path)", () => {
    expect(resolvedTableSchema).toBeTruthy();
    expect(sampleColumn).toBeTruthy();
  });

  itIfDb("schemas-ON lookup uses DEFSCHEMA, not connection ADMIN fallback", () => {
    const targets = buildMetadataLookupTargets(
      { db: TARGET_DATABASE, table: TARGET_TABLE },
      DB_CONFIG.database,
      "ADMIN",
      "netezza",
      {
        netezzaSchemasEnabled: true,
        netezzaDefaultSchemaForDatabase: defaultSchema,
      },
    );

    expect(targets[0].schema).toBe(defaultSchema?.toUpperCase());
  });

  itIfDb("schemas-OFF lookup omits schema for cross-schema search", () => {
    const targets = buildMetadataLookupTargets(
      { db: TARGET_DATABASE, table: TARGET_TABLE },
      DB_CONFIG.database,
      "ADMIN",
      "netezza",
      { netezzaSchemasEnabled: false },
    );

    expect(targets[0]).toEqual({
      database: TARGET_DATABASE,
      schema: undefined,
      table: TARGET_TABLE,
    });
  });

  itIfDb("schemas-ON: columns exist when table is in DEFSCHEMA", async () => {
    if (!defaultSchema || !resolvedTableSchema) {
      return;
    }

    const columnsInDefaultSchema = await queryRows(
      connection,
      `SELECT ATTNAME FROM ${TARGET_DATABASE}.._V_RELATION_COLUMN c
       JOIN ${TARGET_DATABASE}.._V_TABLE t ON c.OBJID = t.OBJID
       WHERE t.TABLENAME = '${TARGET_TABLE}' AND t.SCHEMA = '${defaultSchema}'
       LIMIT 1`,
    );

    if (resolvedTableSchema.toUpperCase() === defaultSchema.toUpperCase()) {
      expect(columnsInDefaultSchema.length).toBeGreaterThan(0);
      return;
    }

    // Table outside DEFSCHEMA: schemas-ON path correctly has no columns in default schema.
    expect(columnsInDefaultSchema.length).toBe(0);
  });

  itIfDb("schemas-OFF simulation: catalog finds columns without default schema", async () => {
    expect(resolvedTableSchema).toBeTruthy();
    expect(sampleColumn).toBeTruthy();

    const columns = await queryRows(
      connection,
      `SELECT ATTNAME FROM ${TARGET_DATABASE}.._V_RELATION_COLUMN c
       JOIN ${TARGET_DATABASE}.._V_TABLE t ON c.OBJID = t.OBJID
       WHERE t.TABLENAME = '${TARGET_TABLE}' AND t.SCHEMA = '${resolvedTableSchema}'
       ORDER BY ATTNAME
       LIMIT 10`,
    );

    expect(columns.length).toBeGreaterThan(0);
  });

  itIfDb("schemas-ON: DB..TABLE SQL fails when table is outside DEFSCHEMA", async () => {
    if (!defaultSchema || !resolvedTableSchema || !sampleColumn) {
      return;
    }

    if (
      resolvedTableSchema.toUpperCase() === defaultSchema.toUpperCase()
    ) {
      return;
    }

    const sql = `SELECT C.${sampleColumn} FROM ${TARGET_DATABASE}..${TARGET_TABLE} C LIMIT 1`;
    await expect(queryRows(connection, sql)).rejects.toThrow(
      /relation does not exist/i,
    );
  });

  itIfDb("schemas-ON: DB..TABLE SQL succeeds when table is in DEFSCHEMA", async () => {
    if (!defaultSchema) {
      return;
    }

    const tableInDefaultSchema = await queryScalar(
      connection,
      `SELECT TABLENAME FROM ${TARGET_DATABASE}.._V_TABLE
       WHERE SCHEMA = '${defaultSchema}'
       ORDER BY TABLENAME
       LIMIT 1`,
      "TABLENAME",
    );
    if (!tableInDefaultSchema) {
      return;
    }

    const column = await queryScalar(
      connection,
      `SELECT c.ATTNAME FROM ${TARGET_DATABASE}.._V_RELATION_COLUMN c
       JOIN ${TARGET_DATABASE}.._V_TABLE t ON c.OBJID = t.OBJID
       WHERE t.TABLENAME = '${tableInDefaultSchema}' AND t.SCHEMA = '${defaultSchema}'
       ORDER BY c.ATTNAME
       LIMIT 1`,
      "ATTNAME",
    );
    if (!column) {
      return;
    }

    const sql = `SELECT C.${column} FROM ${TARGET_DATABASE}..${tableInDefaultSchema} C LIMIT 1`;
    await expect(queryRows(connection, sql)).resolves.toEqual(
      expect.any(Array),
    );
  });

  itIfDb("owner-mode path: explicit schema SQL executes for cross-schema table", async () => {
    if (!resolvedTableSchema || !sampleColumn) {
      return;
    }

    const sql = `SELECT C.${sampleColumn} FROM ${TARGET_DATABASE}.${resolvedTableSchema}.${TARGET_TABLE} C LIMIT 1`;
    await expect(queryRows(connection, sql)).resolves.toEqual(
      expect.any(Array),
    );
  });

  describe("LspCompletionEngine E2E with forced SchemasOn flag", () => {
    itIfDb("SchemasOff: completion returns cross-schema columns for DB..TABLE", async () => {
      if (!sampleColumn) {
        return;
      }

      const provider = new LiveNetezzaCompletionMetadataProvider(
        connection,
        DB_CONFIG.database,
        { netezzaSchemasEnabled: false },
      );
      const engine = new LspCompletionEngine(provider);
      const { document, cursorOffset } = createDocumentWithCursor(
        `SELECT C.| FROM ${TARGET_DATABASE}..${TARGET_TABLE} C`,
      );

      const items = await engine.provideCompletionItems(
        document,
        document.positionAt(cursorOffset),
      );

      expect(provider.getColumnsCalls).toEqual([
        { database: TARGET_DATABASE, table: TARGET_TABLE, schema: undefined },
      ]);
      expect(columnLabels(items)).toEqual(
        expect.arrayContaining([sampleColumn]),
      );
    });

    itIfDb("SchemasOn: completion uses DEFSCHEMA only and misses cross-schema table", async () => {
      if (!defaultSchema || !resolvedTableSchema || !sampleColumn) {
        return;
      }

      if (
        resolvedTableSchema.toUpperCase() === defaultSchema.toUpperCase()
      ) {
        return;
      }

      const provider = new LiveNetezzaCompletionMetadataProvider(
        connection,
        DB_CONFIG.database,
        {
          netezzaSchemasEnabled: true,
          defaultSchema,
        },
      );
      const engine = new LspCompletionEngine(provider);
      const { document, cursorOffset } = createDocumentWithCursor(
        `SELECT C.| FROM ${TARGET_DATABASE}..${TARGET_TABLE} C`,
      );

      const items = await engine.provideCompletionItems(
        document,
        document.positionAt(cursorOffset),
      );

      expect(provider.getNetezzaDefaultSchemaCalls).toEqual([TARGET_DATABASE]);
      expect(provider.getColumnsCalls).toEqual([
        {
          database: TARGET_DATABASE,
          table: TARGET_TABLE,
          schema: defaultSchema.toUpperCase(),
        },
      ]);
      expect(columnLabels(items)).not.toEqual(
        expect.arrayContaining([sampleColumn]),
      );
    });
  });
});
