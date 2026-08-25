/**
 * Live Netezza tests for the metadata prefetch query split (F3).
 *
 * Verifies that the split prefetch queries — main catalog queries and the
 * separate external-table queries (never UNIONed) — execute correctly against
 * a real NPS instance, stay well below the 120s metadata query timeout, and
 * and that TypeScript-side merging keeps duplicate columns/tables out.
 *
 * Prerequisites:
 * - NZ_DEV_PASSWORD
 * - Optional: NZ_DEV_HOST, NZ_DEV_PORT, NZ_DEV_DATABASE, NZ_DEV_USER
 * - Optional target override: NZ_DEV_PREFETCH_DB
 *
 * Run:
 *   NZ_DEV_HOST=<host> NZ_DEV_PASSWORD=<password> npx jest --config jest.live.config.js --runInBand \
 *     src/__tests__/integration/netezzaPrefetchSplit.live.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { NzConnection } from "@justybase/netezza-driver";
import { ensureBuiltInDialectsRegistered } from "../../dialects";
import {
  buildNetezzaColumnsWithKeysQueries,
  loadNetezzaColumnsWithKeysRows,
} from "../../dialects/netezza/metadata/columnsWithKeys";
import {
  NZ_CONSTRAINT_TYPES,
  NZ_OBJECT_TYPES,
  NZ_QUERIES,
  NZ_SYSTEM_VIEWS,
  qualifySystemView,
} from "../../dialects/netezza/metadata/systemQueries";
import {
  buildColumnCacheKey,
  groupColumnRowsByTableKey,
  type RawColumnRowWithKeys,
} from "../../metadata/columnRowMapping";

const skipTests = !process.env.NZ_DEV_PASSWORD;
const describeIfDb = skipTests ? describe.skip : describe;
const itIfDb = skipTests ? it.skip : it;

const DB_CONFIG = {
  host: process.env.NZ_DEV_HOST || "localhost",
  port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
  database: process.env.NZ_DEV_DATABASE || "JUST_DATA",
  user: process.env.NZ_DEV_USER || "admin",
  password: process.env.NZ_DEV_PASSWORD || "",
};

const PREFETCH_TIMEOUT_MS = 120_000;

/** Frozen pre-split SQL used only as the live compatibility oracle. */
function buildLegacyColumnsWithKeysQuery(
  database: string,
  options?: { schema?: string; tableName?: string },
): string {
  const databaseLiteral = database.replace(/'/g, "''");
  const schemaPredicate = options?.schema
    ? ` AND O.SCHEMA = '${options.schema.replace(/'/g, "''")}'`
    : "";
  const tablePredicate = options?.tableName
    ? ` AND O.OBJNAME = '${options.tableName.replace(/'/g, "''")}'`
    : "";
  return `
    SELECT
      O.OBJNAME AS TABLENAME,
      O.SCHEMA,
      O.DBNAME,
      C.ATTNAME,
      C.FORMAT_TYPE,
      C.ATTNUM,
      COALESCE(C.DESCRIPTION, '') AS DESCRIPTION,
      MAX(CASE WHEN K.CONTYPE = '${NZ_CONSTRAINT_TYPES.PRIMARY_KEY}' THEN 1 ELSE 0 END) AS IS_PK,
      MAX(CASE WHEN K.CONTYPE = '${NZ_CONSTRAINT_TYPES.FOREIGN_KEY}' THEN 1 ELSE 0 END) AS IS_FK,
      MAX(CASE WHEN D.ATTNAME IS NOT NULL THEN 1 ELSE 0 END) AS IS_DISTRIBUTION_KEY
    FROM ${qualifySystemView(database, NZ_SYSTEM_VIEWS.RELATION_COLUMN)} C
    JOIN ${qualifySystemView(database, NZ_SYSTEM_VIEWS.OBJECT_DATA)} O ON C.OBJID = O.OBJID
    LEFT JOIN ${qualifySystemView(database, NZ_SYSTEM_VIEWS.RELATION_KEYDATA)} K
      ON K.OBJID = O.OBJID
      AND K.ATTNAME = C.ATTNAME
      AND K.CONTYPE IN ('${NZ_CONSTRAINT_TYPES.PRIMARY_KEY}', '${NZ_CONSTRAINT_TYPES.FOREIGN_KEY}')
    LEFT JOIN ${qualifySystemView(database, NZ_SYSTEM_VIEWS.TABLE_DIST_MAP)} D
      ON D.OBJID = O.OBJID
      AND D.ATTNAME = C.ATTNAME
    WHERE O.DBNAME = '${databaseLiteral}'
      AND O.OBJTYPE IN ('${NZ_OBJECT_TYPES.TABLE}', '${NZ_OBJECT_TYPES.VIEW}')
      ${schemaPredicate}
      ${tablePredicate}
    GROUP BY O.OBJNAME, O.SCHEMA, O.DBNAME, C.ATTNAME, C.FORMAT_TYPE, C.ATTNUM, C.DESCRIPTION
    ORDER BY SCHEMA, TABLENAME, ATTNUM
  `.trim();
}

async function queryRows(
    connection: NzConnection,
    sql: string,
    commandTimeout = 180,
): Promise<Record<string, unknown>[]> {
  const cmd = connection.createCommand(sql);
  cmd.commandTimeout = commandTimeout;
  const reader = await cmd.executeReader();
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

interface LiveQueryTiming {
  executeReaderMs: number;
  serverWaitToFirstRowMs: number;
  rowFetchMs: number;
  readerCloseMs: number;
  totalMs: number;
  rowsRead: number;
}

async function queryRowsWithTiming(
  connection: NzConnection,
  sql: string,
  label: string,
  commandTimeout = 180,
): Promise<{ rows: Record<string, unknown>[]; timing: LiveQueryTiming }> {
  // Use the monotonic clock: the wall clock can be corrected while a long
  // live catalog query is running, which otherwise yields negative timings.
  const totalStart = performance.now();
  const cmd = connection.createCommand(sql);
  cmd.commandTimeout = commandTimeout;
  const executeStart = performance.now();
  const reader = await cmd.executeReader();
  const executeReaderMs = performance.now() - executeStart;
  const rows: Record<string, unknown>[] = [];
  const fieldCount = reader.fieldCount;
  let firstReadCompletedAt: number | undefined;
  let lastReadCompletedAt: number | undefined;
  const rowFetchStart = performance.now();
  let readerCloseMs: number | undefined;

  try {
    while (true) {
      const hasRow = await reader.read();
      const readCompletedAt = performance.now();
      firstReadCompletedAt ??= readCompletedAt;
      lastReadCompletedAt = readCompletedAt;
      if (!hasRow) {
        break;
      }
      const row: Record<string, unknown> = {};
      for (let index = 0; index < fieldCount; index += 1) {
        const name = reader.getName(index) ?? `COL_${index}`;
        row[name] = reader.getValue(index);
      }
      rows.push(row);
    }
  } finally {
    const closeStart = performance.now();
    await reader.close();
    readerCloseMs = performance.now() - closeStart;
  }

  const firstRowOrEnd = firstReadCompletedAt ?? performance.now();
  const timing: LiveQueryTiming = {
    executeReaderMs: Math.round(executeReaderMs),
    serverWaitToFirstRowMs: Math.round(Math.max(0, firstRowOrEnd - (executeStart + executeReaderMs))),
    rowFetchMs: Math.round(Math.max(0, (lastReadCompletedAt ?? rowFetchStart) - firstRowOrEnd)),
    readerCloseMs: Math.round(readerCloseMs ?? 0),
    totalMs: Math.round(performance.now() - totalStart),
    rowsRead: rows.length,
  };
  console.log(`PROBE TIMING ${label} ${JSON.stringify(timing)}`);
  return { rows, timing };
}

async function querySplitColumnsWithTiming(
  connection: NzConnection,
  database: string,
  options?: { schema?: string; tableName?: string },
): Promise<{ rows: Record<string, unknown>[]; totalMs: number }> {
  const queries = buildNetezzaColumnsWithKeysQueries(database, options);
  let totalMs = 0;
  const rows = await loadNetezzaColumnsWithKeysRows(
    queries,
    async (sql, role) => {
      const probe = await queryRowsWithTiming(
        connection,
        sql,
        `columns-${role}:${database}`,
      );
      totalMs += probe.timing.totalMs;
      return probe.rows;
    },
  );
  return { rows, totalMs };
}

describeIfDb("Netezza metadata prefetch split - live", () => {
  let connection: NzConnection;
  let targetDatabase: string;
  let bigDatabase: string;
  let smallestDatabase: string;
  let largestDatabase: string;
  let sampleTable: { schema: string; name: string } | undefined;
  let sampleExternalTable: { schema: string; name: string } | undefined;

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

    const dbRows = await queryRows(connection, NZ_QUERIES.LIST_DATABASES);
    const dbNames = dbRows
      .map((row) => row.DATABASE)
      .filter(
        (name): name is string =>
          typeof name === "string" &&
          name.trim().length > 0 &&
          name !== "SYSTEM" &&
          name !== "MASTER_DB",
      );

    // Count objects per database through the connection database prefix
    // (always resolvable; some system databases cannot be used as a prefix).
    const connectionDb = DB_CONFIG.database.toUpperCase();
    const sizeRows = await queryRows(
      connection,
      `SELECT DBNAME, COUNT(*) AS OBJECT_COUNT FROM ${connectionDb}.._V_OBJECT_DATA GROUP BY DBNAME ORDER BY OBJECT_COUNT`,
    );
    const sizes = new Map<string, number>();
    for (const row of sizeRows) {
      const name = String(row.DBNAME).toUpperCase();
      if (name !== "SYSTEM" && name !== "MASTER_DB") {
        sizes.set(name, Number(row.OBJECT_COUNT ?? 0));
      }
    }
    const sorted = [...sizes.entries()].sort((a, b) => a[1] - b[1]);
    const smallest = sorted.find(([, count]) => count > 0)?.[0];
    const largest = sorted[sorted.length - 1]?.[0];

    targetDatabase =
      process.env.NZ_DEV_PREFETCH_DB ||
      smallest ||
      dbNames[0] ||
      connectionDb;
    bigDatabase =
      process.env.NZ_DEV_BIG_PREFETCH_DB || largest || targetDatabase;
    smallestDatabase = smallest || targetDatabase;
    largestDatabase = largest || bigDatabase;

    const tableRows = await queryRows(
      connection,
      NZ_QUERIES.listTablesAndViews([targetDatabase]),
    );
    sampleTable = tableRows[0]
      ? {
          schema: String(tableRows[0].SCHEMA ?? ""),
          name: String(tableRows[0].OBJNAME ?? ""),
        }
      : undefined;

    const externalRows = await queryRows(
      connection,
      NZ_QUERIES.listExternalTables([targetDatabase]),
    );
    sampleExternalTable = externalRows[0]
      ? {
          schema: String(externalRows[0].SCHEMA ?? ""),
          name: String(externalRows[0].OBJNAME ?? ""),
        }
      : undefined;
  }, PREFETCH_TIMEOUT_MS + 60_000);

  afterAll(async () => {
    if (connection) {
      await connection.close();
    }
  });

  itIfDb("T10: main tables query returns rows for a single database", async () => {
    const rows = await queryRows(
      connection,
      NZ_QUERIES.listTablesAndViews([targetDatabase]),
    );
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0];
    expect(first).toHaveProperty("OBJNAME");
    expect(first).toHaveProperty("OBJID");
    expect(first).toHaveProperty("DBNAME", targetDatabase);
  });

  itIfDb("T10b: main tables query for one database contains no UNION ALL", () => {
    const query = NZ_QUERIES.listTablesAndViews([targetDatabase]);
    expect(query).not.toContain("UNION ALL");
    expect(query).not.toContain("_V_EXTERNAL");
  });

  itIfDb("T10c: external tables query executes and returns EXTERNAL TABLE rows", async () => {
    const rows = await queryRows(
      connection,
      NZ_QUERIES.listExternalTables([targetDatabase]),
    );
    for (const row of rows) {
        expect(row.OBJTYPE).toBe("EXTERNAL TABLE");
        expect(row).toHaveProperty("OBJID");
        expect(row).toHaveProperty("DBNAME", targetDatabase);
    }
    expect(rows.length).toBeGreaterThan(0);
  });

  itIfDb(
    "T10d: stage 3 queries on the largest database stay below the 120s metadata timeout",
    async () => {
      const start = Date.now();
      const tableProbe = await queryRowsWithTiming(
        connection,
        NZ_QUERIES.listTablesAndViews([bigDatabase]),
        `objects-main:${bigDatabase}`,
      );
      const externalProbe = await queryRowsWithTiming(
        connection,
        NZ_QUERIES.listExternalTables([bigDatabase]),
        `objects-external:${bigDatabase}`,
      );
      const elapsed = Date.now() - start;
      console.log(
        `PROBE T10d ${bigDatabase}: ${tableProbe.rows.length} tables + ${externalProbe.rows.length} external in ${elapsed}ms`,
      );
      expect(tableProbe.rows.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(PREFETCH_TIMEOUT_MS);
    },
    PREFETCH_TIMEOUT_MS + 60_000,
  );

  itIfDb("T11: split columns snapshot returns rows with PK/FK flags", async () => {
    const { rows } = await querySplitColumnsWithTiming(connection, targetDatabase);
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0];
    expect(first).toHaveProperty("TABLENAME");
    expect(first).toHaveProperty("SCHEMA");
    expect(first).toHaveProperty("ATTNAME");
    expect(first).toHaveProperty("FORMAT_TYPE");
    expect(first).toHaveProperty("IS_PK");
    expect(first).toHaveProperty("IS_FK");
    expect(first).toHaveProperty("IS_DISTRIBUTION_KEY");
  });

  itIfDb(
    "T11 parity: legacy SQL and split in-memory merge are identical on the smallest and largest databases",
    async () => {
      const databases = [...new Set([smallestDatabase, largestDatabase])];
      for (const database of databases) {
        const legacy = await queryRowsWithTiming(
          connection,
          buildLegacyColumnsWithKeysQuery(database),
          `columns-legacy:${database}`,
          600,
        );
        const split = await querySplitColumnsWithTiming(connection, database);

        console.log(
          `PROBE PARITY ${database}: rows=${legacy.rows.length} legacy=${legacy.timing.totalMs}ms split=${split.totalMs}ms`,
        );
        expect(split.rows).toEqual(legacy.rows);
      }
    },
    900_000,
  );

  itIfDb(
    "T11 targeted parity: scoped auxiliary scans match the legacy query for one table",
    async () => {
      if (!sampleTable) {
        throw new Error(`Database '${targetDatabase}' has no table/view for targeted parity`);
      }
      const options = {
        schema: sampleTable.schema,
        tableName: sampleTable.name,
      };
      const legacy = await queryRows(
        connection,
        buildLegacyColumnsWithKeysQuery(targetDatabase, options),
      );
      const split = await querySplitColumnsWithTiming(
        connection,
        targetDatabase,
        options,
      );

      expect(split.rows).toEqual(legacy);
    },
    PREFETCH_TIMEOUT_MS + 60_000,
  );

  itIfDb(
    "T11a: every prefetched table/view layer has an exact Netezza column key",
    async () => {
      // One NzConnection permits one active reader. This matches the
      // production prefetcher, which serializes catalog reads per connection.
      const objectRows = await queryRows(
        connection,
        NZ_QUERIES.listTablesAndViews([targetDatabase]),
      );
      const mainColumnRows = (await querySplitColumnsWithTiming(
        connection,
        targetDatabase,
      )).rows;
      const externalColumnRows = await queryRows(
        connection,
        NZ_QUERIES.listExternalColumnsWithKeys(targetDatabase),
      );
      const columnsByKey = groupColumnRowsByTableKey(
        [...mainColumnRows, ...externalColumnRows] as RawColumnRowWithKeys[],
        undefined,
        { preserveCase: true, exactNetezza: true },
      );
      const relevantTypes = new Set(['TABLE', 'VIEW', 'EXTERNAL TABLE']);
      const missing = objectRows
        .filter(row => relevantTypes.has(String(row.OBJTYPE ?? '').trim().toUpperCase()))
        .map(row => ({
          name: `${String(row.DBNAME)}.${String(row.SCHEMA)}.${String(row.OBJNAME)}`,
          key: buildColumnCacheKey(
            String(row.DBNAME),
            String(row.SCHEMA ?? ''),
            String(row.OBJNAME),
            { preserveCase: true, exactNetezza: true },
          ),
        }))
        .filter(({ key }) => !columnsByKey.has(key));

      console.log(
        `PROBE T11a ${targetDatabase}: ${objectRows.length} object rows, `
        + `${columnsByKey.size} exact column layers, ${missing.length} missing`,
      );
      expect(missing).toEqual([]);
    },
    PREFETCH_TIMEOUT_MS + 60_000,
  );

  itIfDb("T11b: external columns query executes with the shared row shape", async () => {
    const probe = await queryRowsWithTiming(
      connection,
      NZ_QUERIES.listExternalColumnsWithKeys(targetDatabase),
      `columns-external:${targetDatabase}`,
    );
    const rows = probe.rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toHaveProperty("TABLENAME");
      expect(row).toHaveProperty("SCHEMA");
      expect(row).toHaveProperty("DBNAME", targetDatabase);
      expect(row).toHaveProperty("ATTNAME");
      expect(row).toHaveProperty("FORMAT_TYPE");
      expect(row).toHaveProperty("IS_PK", 0);
      expect(row).toHaveProperty("IS_FK", 0);
      expect(row).toHaveProperty("IS_DISTRIBUTION_KEY", 0);
    }
  });

  itIfDb("T11c: merged main + external columns have no duplicate ATTNAME per table", async () => {
    // Sequential awaits: the Netezza driver allows one active command per connection.
    const mainRows = (await querySplitColumnsWithTiming(
      connection,
      targetDatabase,
    )).rows;
    const externalRows = await queryRows(
      connection,
      NZ_QUERIES.listExternalColumnsWithKeys(targetDatabase),
    );

    const byTable = new Map<string, Map<string, number>>();
    const addRows = (rows: Record<string, unknown>[]) => {
      for (const row of rows) {
        const schema = String(row.SCHEMA ?? "").toUpperCase();
        const table = String(row.TABLENAME ?? "").toUpperCase();
        const attname = String(row.ATTNAME ?? "").toUpperCase();
        if (!table || !attname) {
          continue;
        }
        const key = `${schema}.${table}`;
        if (!byTable.has(key)) {
          byTable.set(key, new Map());
        }
        const counts = byTable.get(key)!;
        counts.set(attname, (counts.get(attname) ?? 0) + 1);
      }
    };
    addRows(mainRows);
    addRows(externalRows);

    expect(byTable.size).toBeGreaterThan(0);
    for (const attnames of byTable.values()) {
      expect(attnames.size).toBeGreaterThan(0);
      expect([...attnames.values()].some(count => count > 1)).toBe(false);
    }
  });

  itIfDb("T12: per-table columns query returns rows for a known table", async () => {
    expect(sampleTable?.name).toBeTruthy();
    const rows = await queryRows(
      connection,
      NZ_QUERIES.getTableColumns(
        targetDatabase,
        sampleTable!.schema,
        sampleTable!.name,
      ),
    );
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0];
    expect(first).toHaveProperty("OBJID");
    expect(first).toHaveProperty("ATTNUM");
    expect(first).toHaveProperty("ATTNAME");
    expect(first).toHaveProperty("FULL_TYPE");
  });

  itIfDb("T12b: per-table external columns query returns rows for a live external table", async () => {
    expect(sampleExternalTable?.name).toBeTruthy();
    const rows = await queryRows(
      connection,
      NZ_QUERIES.getExternalTableColumns(
        targetDatabase,
        sampleExternalTable!.schema,
        sampleExternalTable!.name,
      ),
    );
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0];
    expect(first).toHaveProperty("OBJID");
    expect(first).toHaveProperty("ATTNUM");
    expect(first).toHaveProperty("ATTNAME");
    expect(first).toHaveProperty("FULL_TYPE");
  });

  itIfDb("T12c: per-table main query never references _V_EXTERNAL", () => {
    const query = NZ_QUERIES.getTableColumns(
      targetDatabase,
      sampleTable?.schema ?? "ADMIN",
      sampleTable?.name ?? "NONEXISTENT",
    );
    expect(query).not.toContain("UNION ALL");
    expect(query).not.toContain("_V_EXTERNAL");
  });
});
