import type { DatabaseSessionMonitorProvider } from '@justybase/contracts';
import { runQueryRaw, queryResultToRows } from '../../../src/core/queryRunner';
import { ConnectionManager } from '../../../src/core/connectionManager';

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'bigint') {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : 0;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeDatabaseFilter(database: string | undefined): string | undefined {
  if (!database) return undefined;
  const normalized = database.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function validateSessionId(sessionId: number): void {
  if (!Number.isFinite(sessionId) || sessionId < 0 || !Number.isInteger(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
}

export const postgresqlSessionMonitorProvider: DatabaseSessionMonitorProvider = {
  async getSessions(context, mgr, database) {
    const connectionManager = mgr as ConnectionManager;
    const scopedDatabase = normalizeDatabaseFilter(database);
        const whereClause = scopedDatabase
            ? `WHERE upper(datname) = upper('${escapeSqlLiteral(scopedDatabase)}')`
            : '';
        const sql = `
            SELECT 
                pid AS "ID",
                pid AS "PID",
                usename AS "USERNAME",
                datname AS "DBNAME",
                backend_type AS "TYPE",
                to_char(backend_start, 'YYYY-MM-DD HH24:MI:SS') AS "CONNTIME",
                state AS "STATUS",
                left(query, 200) AS "COMMAND",
                0 AS "PRIORITY",
                0 AS "CID",
                client_addr::text AS "IPADDR",
                application_name AS "CLIENT_OS_USERNAME"
            FROM pg_stat_activity
            ${whereClause}
            ORDER BY backend_start DESC
        `;
        const result = await runQueryRaw(context, sql, true, connectionManager, undefined, undefined, undefined, undefined, 1000, false);
        if (!result || !result.data) {
            return [];
        }
        return queryResultToRows<Record<string, unknown>>(result);
    },

    async getQueries(context, mgr, database) {
      const connectionManager = mgr as ConnectionManager;
      const scopedDatabase = normalizeDatabaseFilter(database);
      let whereClause = `WHERE state = 'active' AND query IS NOT NULL AND query != ''`;
      if (scopedDatabase) {
        whereClause += ` AND upper(datname) = upper('${escapeSqlLiteral(scopedDatabase)}')`;
      }
            
        const sql = `
            SELECT 
                pid AS "QS_SESSIONID",
                0 AS "QS_PLANID",
                0 AS "QS_CLIENTID",
                client_addr::text AS "QS_CLIIPADDR",
                left(query, 300) AS "QS_SQL",
                state AS "QS_STATE",
                to_char(query_start, 'YYYY-MM-DD HH24:MI:SS') AS "QS_TSUBMIT",
                to_char(query_start, 'YYYY-MM-DD HH24:MI:SS') AS "QS_TSTART",
                0 AS "QS_PRIORITY",
                'Normal' AS "QS_PRITXT",
                0 AS "QS_ESTCOST",
                0 AS "QS_ESTDISK",
                0 AS "QS_ESTMEM",
                0 AS "QS_SNIPPETS",
                0 AS "QS_CURSNIPT",
                0 AS "QS_RESROWS",
                0 AS "QS_RESBYTES",
                usename AS "USERNAME"
            FROM pg_stat_activity
            ${whereClause}
            ORDER BY query_start DESC
            LIMIT 1000
        `;
        const result = await runQueryRaw(context, sql, true, connectionManager, undefined, undefined, undefined, undefined, 1000, false);
        if (!result || !result.data) {
            return [];
        }
        return queryResultToRows<Record<string, unknown>>(result);
    },

    async getStorage(context, mgr) {
        const connectionManager = mgr as ConnectionManager;
        const sql = `
            SELECT 
                datname AS "DATABASE",
                'public' AS "SCHEMA",
                ROUND(pg_database_size(datname) / 1024.0 / 1024.0, 2) AS "ALLOC_MB",
                ROUND(pg_database_size(datname) / 1024.0 / 1024.0, 2) AS "USED_MB",
                0 AS "AVG_SKEW",
                0 AS "TABLE_COUNT"
            FROM pg_database
            WHERE datistemplate = false
            ORDER BY pg_database_size(datname) DESC
        `;
        const result = await runQueryRaw(context, sql, true, connectionManager, undefined, undefined, undefined, undefined, 1000, false);
        if (!result || !result.data) return [];
        const rows = queryResultToRows<Record<string, unknown>>(result);
        return rows.map(r => ({
           ...r,
           ALLOC_MB: toNumber(r.ALLOC_MB),
           USED_MB: toNumber(r.USED_MB),
           AVG_SKEW: toNumber(r.AVG_SKEW),
           TABLE_COUNT: toNumber(r.TABLE_COUNT)
        })) as Record<string, unknown>[];
    },

    async getResources(_context, _mgr) {
        void _context;
        void _mgr;
        return {
            gra: [],
            systemUtil: [],
            sysUtilSummary: null
        };
    },

    async killSession(context, mgr, sessionId) {
      validateSessionId(sessionId);
      const connectionManager = mgr as ConnectionManager;
      const sql = `SELECT pg_terminate_backend(${sessionId});`;
      await runQueryRaw(context, sql, true, connectionManager, undefined);
    }
};
