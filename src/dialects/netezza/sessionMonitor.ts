import type {
  DatabaseSessionMonitorProvider,
  DatabaseSessionMonitorServices,
} from "@justybase/contracts";
import {
  escapeSqlLiteral,
  executeSessionMonitorStatement,
  normalizeDatabaseFilter,
  runSessionMonitorQuery,
  toNumber,
  validatePositiveIntegerSessionId,
} from "@justybase/database-utils/sessionMonitorProviderUtils";

async function runWithConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  maxConcurrency: number,
): Promise<T[]> {
  if (tasks.length === 0) {
    return [];
  }

  const limitedConcurrency = Math.max(
    1,
    Math.min(maxConcurrency, tasks.length),
  );
  const results: Array<T | undefined> = new Array(tasks.length);
  let nextTaskIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const currentIndex = nextTaskIndex;
      if (currentIndex >= tasks.length) {
        return;
      }
      nextTaskIndex = currentIndex + 1;
      results[currentIndex] = await tasks[currentIndex]();
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < limitedConcurrency; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results.filter((value): value is T => value !== undefined);
}

async function fetchStorageDatabases(
  services: DatabaseSessionMonitorServices,
  connectionName: string | undefined,
  fallbackDatabase: string,
): Promise<string[]> {
  const databases = new Set<string>();
  const sql = `
        SELECT DATABASE
        FROM _V_DATABASE
        ORDER BY DATABASE
    `;

  try {
    const rows = await services.query<{ DATABASE: string }>(sql, 1000, connectionName);
    for (const row of rows) {
      const normalized = String(row.DATABASE || "")
        .trim()
        .toUpperCase();
      if (normalized) {
        databases.add(normalized);
      }
    }
  } catch (e: unknown) {
    console.warn(
      "[netezzaSessionMonitor] Failed to enumerate databases for storage scan:",
      e,
    );
  }

  const fallback = String(fallbackDatabase || "")
    .trim()
    .toUpperCase();
  if (fallback) {
    databases.add(fallback);
  }

  return Array.from(databases).sort((a, b) => a.localeCompare(b));
}

async function fetchStorageForDatabase(
  services: DatabaseSessionMonitorServices,
  database: string,
  connectionName: string | undefined,
): Promise<Record<string, unknown>[]> {
  const escapedDatabase = database.replace(/'/g, "''");
  const sql = `
        SELECT '${escapedDatabase}' AS DATABASE,
               TS.SCHEMA,
               ROUND(SUM(TS.ALLOCATED_BYTES) / 1024.0 / 1024.0, 2) AS ALLOC_MB,
               ROUND(SUM(TS.USED_BYTES) / 1024.0 / 1024.0, 2) AS USED_MB,
               ROUND(SUM(TS.SKEW * TS.USED_BYTES) / NULLIF(SUM(TS.USED_BYTES), 0), 2) AS AVG_SKEW,
               COUNT(*) AS TABLE_COUNT
        FROM _V_TABLE_STORAGE_STAT TS
        GROUP BY TS.SCHEMA
    `;

  if (!services.queryDatabase) {
    return [];
  }

  const rows = await services.queryDatabase<Record<string, unknown>>(database, sql, connectionName);
  return rows.map((row) => ({
    DATABASE: String(row.DATABASE || database),
    SCHEMA: String(row.SCHEMA || ""),
    ALLOC_MB: toNumber(row.ALLOC_MB),
    USED_MB: toNumber(row.USED_MB),
    AVG_SKEW: toNumber(row.AVG_SKEW),
    TABLE_COUNT: toNumber(row.TABLE_COUNT),
  }));
}

export const netezzaSessionMonitorProvider: DatabaseSessionMonitorProvider = {
  async getSessions(context, services, database, connectionName) {
    const scopedDatabase = normalizeDatabaseFilter(database)?.toUpperCase();
    const whereClause = scopedDatabase
      ? `WHERE DBNAME = '${escapeSqlLiteral(scopedDatabase)}'`
      : "";
    const sql = `
            SELECT ID, PID, USERNAME, DBNAME, TYPE, CONNTIME, STATUS, 
                   SUBSTR(COMMAND, 1, 200) AS COMMAND, PRIORITY, CID, IPADDR, CLIENT_OS_USERNAME
            FROM _V_SESSION
            ${whereClause}
            ORDER BY CONNTIME DESC
        `;
    return runSessionMonitorQuery<Record<string, unknown>>(
      context,
      services,
      sql,
      1000,
      connectionName,
    );
  },

  async getQueries(context, services, database, connectionName) {
    const scopedDatabase = normalizeDatabaseFilter(database)?.toUpperCase();
    const whereClause = scopedDatabase
      ? `WHERE S.DBNAME = '${escapeSqlLiteral(scopedDatabase)}'`
      : "";
    const sql = `
            SELECT Q.QS_SESSIONID, Q.QS_PLANID, Q.QS_CLIENTID, Q.QS_CLIIPADDR,
                   SUBSTR(Q.QS_SQL, 1, 300) AS QS_SQL, 
                   Q.QS_STATE, Q.QS_TSUBMIT, Q.QS_TSTART, 
                   Q.QS_PRIORITY, Q.QS_PRITXT, Q.QS_ESTCOST, 
                   Q.QS_ESTDISK, Q.QS_ESTMEM, Q.QS_SNIPPETS, Q.QS_CURSNIPT,
                   Q.QS_RESROWS, Q.QS_RESBYTES,
                   S.USERNAME
            FROM _V_QRYSTAT Q
            LEFT JOIN _V_SESSION S ON Q.QS_SESSIONID = S.ID
            ${whereClause}
            ORDER BY Q.QS_TSTART DESC
            LIMIT 1000
        `;
    return runSessionMonitorQuery<Record<string, unknown>>(
      context,
      services,
      sql,
      1000,
      connectionName,
    );
  },

  async getStorage(_context, services, connectionName) {
    if (!services.queryDatabase) return [];
    const details = await services.getConnectionDetails?.(connectionName);
    if (!details) return [];

    const databases = await fetchStorageDatabases(
      services,
      connectionName,
      details.database,
    );
    const tasks = databases.map((db) => async () => {
      try {
        return await fetchStorageForDatabase(services, db, connectionName);
      } catch (databaseError: unknown) {
        console.warn(
          `[netezzaSessionMonitor] Failed storage fetch for database ${db}:`,
          databaseError,
        );
        return [];
      }
    });

    const batches = await runWithConcurrencyLimit(tasks, 4);
    const storageRows = batches.flat();

    storageRows.sort((a, b) => {
      const usedDiff = toNumber(b.USED_MB) - toNumber(a.USED_MB);
      if (usedDiff !== 0) return usedDiff;
      const dbDiff = ((a.DATABASE as string) || "").localeCompare(
        (b.DATABASE as string) || "",
      );
      if (dbDiff !== 0) return dbDiff;
      return ((a.SCHEMA as string) || "").localeCompare(
        (b.SCHEMA as string) || "",
      );
    });

    return storageRows;
  },

  async getResources(context, services, connectionName) {
    let graData: unknown[] = [];
    let sysUtil: unknown[] = [];
    let sysUtilSummary: unknown = null;

    try {
      graData = await runSessionMonitorQuery<Record<string, unknown>>(
        context,
        services,
        `SELECT * FROM _V_SCHED_GRA_EXT LIMIT 50`,
        1000,
        connectionName,
      );
    } catch (e: unknown) {
      console.warn("[_V_SCHED_GRA_EXT not available]:", e);
    }

    try {
      sysUtil = await runSessionMonitorQuery<Record<string, unknown>>(
        context,
        services,
        `SELECT * FROM _V_SYSTEM_UTIL ORDER BY 1 DESC LIMIT 50`,
        1000,
        connectionName,
      );
    } catch (e: unknown) {
      console.warn("[_V_SYSTEM_UTIL not available]:", e);
    }

    try {
      const parsed = await runSessionMonitorQuery<Record<string, unknown>>(
        context,
        services,
        `SELECT 
                    ROUND(AVG(HOST_CPU) * 100, 1) AS AVG_HOST_CPU_PCT,
                    ROUND(AVG(SPU_CPU) * 100, 1) AS AVG_SPU_CPU_PCT,
                    ROUND(AVG(HOST_DISK) * 100, 1) AS AVG_DISK_PCT,
                    ROUND(AVG(HOST_MEMORY) * 100, 1) AS AVG_MEMORY_PCT,
                    ROUND(AVG(HOST_FABRIC) * 100, 1) AS AVG_FABRIC_PCT,
                    COUNT(*) AS SAMPLE_COUNT
                FROM _V_SYSTEM_UTIL`,
        1000,
        connectionName,
      );
      sysUtilSummary = parsed.length > 0 ? parsed[0] : null;
    } catch (e: unknown) {
      console.warn("[_V_SYSTEM_UTIL summary not available]:", e);
    }

    return { gra: graData, systemUtil: sysUtil, sysUtilSummary };
  },

  async killSession(context, services, sessionId, connectionName) {
    validatePositiveIntegerSessionId(sessionId, 'Netezza');
    const sql = `DROP SESSION ${sessionId}`;
    await executeSessionMonitorStatement(context, services, sql, connectionName);
  },
};
