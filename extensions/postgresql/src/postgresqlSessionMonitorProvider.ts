import type { DatabaseSessionMonitorProvider } from '@justybase/contracts';
import { ConnectionManager } from '../../../src/core/connectionManager';
import {
  emptySessionMonitorResources,
  escapeSqlLiteral,
  executeSessionMonitorStatement,
  normalizeDatabaseFilter,
  runSessionMonitorQuery,
  toNumber,
  validatePositiveIntegerSessionId,
} from '../../../src/core/sessionMonitorProviderUtils';

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
        return runSessionMonitorQuery<Record<string, unknown>>(
            context,
            connectionManager,
            sql,
        );
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
        return runSessionMonitorQuery<Record<string, unknown>>(
            context,
            connectionManager,
            sql,
        );
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
        const rows = await runSessionMonitorQuery<Record<string, unknown>>(
            context,
            connectionManager,
            sql,
        );
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
        return emptySessionMonitorResources();
    },

    async killSession(context, mgr, sessionId) {
      validatePositiveIntegerSessionId(sessionId, 'PostgreSQL');
      const connectionManager = mgr as ConnectionManager;
      const sql = `SELECT pg_terminate_backend(${sessionId});`;
      await executeSessionMonitorStatement(context, connectionManager, sql);
    }
};
