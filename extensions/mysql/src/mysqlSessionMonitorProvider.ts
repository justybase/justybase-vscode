import type { DatabaseSessionMonitorProvider } from '@justybase/contracts';
import { ConnectionManager } from '../../../src/core/connectionManager';
import {
    emptySessionMonitorResources,
    escapeSqlLiteral,
    executeSessionMonitorStatement,
    normalizeDatabaseFilter,
    runSessionMonitorQuery,
    toNumber,
    validatePositiveIntegerSessionId
} from '../../../src/core/sessionMonitorProviderUtils';

export const mysqlSessionMonitorProvider: DatabaseSessionMonitorProvider = {
    async getSessions(context, mgr, database) {
        const connectionManager = mgr as ConnectionManager;
        const scopedDatabase = normalizeDatabaseFilter(database);
        const whereClause = scopedDatabase
            ? `AND UPPER(COALESCE(DB, DATABASE(), '')) = UPPER('${escapeSqlLiteral(scopedDatabase)}')`
            : '';

        return runSessionMonitorQuery<Record<string, unknown>>(
            context,
            connectionManager,
            `
                SELECT
                    ID AS "ID",
                    ID AS "PID",
                    USER AS "USERNAME",
                    COALESCE(DB, DATABASE()) AS "DBNAME",
                    COMMAND AS "TYPE",
                    '' AS "CONNTIME",
                    COALESCE(STATE, COMMAND, 'ACTIVE') AS "STATUS",
                    LEFT(COALESCE(INFO, ''), 200) AS "COMMAND",
                    0 AS "PRIORITY",
                    0 AS "CID",
                    COALESCE(HOST, '') AS "IPADDR",
                    '' AS "CLIENT_OS_USERNAME"
                FROM information_schema.PROCESSLIST
                WHERE USER IS NOT NULL
                  AND USER <> 'system user'
                  ${whereClause}
                ORDER BY TIME DESC
                LIMIT 1000
            `
        );
    },

    async getQueries(context, mgr, database) {
        const connectionManager = mgr as ConnectionManager;
        const scopedDatabase = normalizeDatabaseFilter(database);
        const whereClause = scopedDatabase
            ? `AND UPPER(COALESCE(DB, DATABASE(), '')) = UPPER('${escapeSqlLiteral(scopedDatabase)}')`
            : '';

        return runSessionMonitorQuery<Record<string, unknown>>(
            context,
            connectionManager,
            `
                SELECT
                    ID AS "QS_SESSIONID",
                    0 AS "QS_PLANID",
                    0 AS "QS_CLIENTID",
                    COALESCE(HOST, '') AS "QS_CLIIPADDR",
                    LEFT(COALESCE(INFO, ''), 300) AS "QS_SQL",
                    COALESCE(STATE, COMMAND, 'ACTIVE') AS "QS_STATE",
                    '' AS "QS_TSUBMIT",
                    '' AS "QS_TSTART",
                    0 AS "QS_PRIORITY",
                    'Normal' AS "QS_PRITXT",
                    0 AS "QS_ESTCOST",
                    0 AS "QS_ESTDISK",
                    0 AS "QS_ESTMEM",
                    0 AS "QS_SNIPPETS",
                    0 AS "QS_CURSNIPT",
                    0 AS "QS_RESROWS",
                    0 AS "QS_RESBYTES",
                    USER AS "USERNAME"
                FROM information_schema.PROCESSLIST
                WHERE INFO IS NOT NULL
                  AND INFO <> ''
                  AND COMMAND <> 'Sleep'
                  ${whereClause}
                ORDER BY TIME DESC
                LIMIT 1000
            `
        );
    },

    async getStorage(context, mgr) {
        const connectionManager = mgr as ConnectionManager;
        const rows = await runSessionMonitorQuery<Record<string, unknown>>(
            context,
            connectionManager,
            `
                SELECT
                    TABLE_SCHEMA AS "DATABASE",
                    TABLE_SCHEMA AS "SCHEMA",
                    ROUND(SUM(COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0)) / 1024.0 / 1024.0, 2) AS "ALLOC_MB",
                    ROUND(SUM(COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0)) / 1024.0 / 1024.0, 2) AS "USED_MB",
                    0 AS "AVG_SKEW",
                    COUNT(*) AS "TABLE_COUNT"
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
                GROUP BY TABLE_SCHEMA
                ORDER BY USED_MB DESC, TABLE_SCHEMA
            `
        );

        return rows.map((row) => ({
            ...row,
            ALLOC_MB: toNumber(row.ALLOC_MB),
            USED_MB: toNumber(row.USED_MB),
            AVG_SKEW: toNumber(row.AVG_SKEW),
            TABLE_COUNT: toNumber(row.TABLE_COUNT)
        }));
    },

    async getResources() {
        return emptySessionMonitorResources();
    },

    async killSession(context, mgr, sessionId) {
        validatePositiveIntegerSessionId(sessionId, 'MySQL');
        const connectionManager = mgr as ConnectionManager;
        await executeSessionMonitorStatement(context, connectionManager, `KILL ${sessionId}`);
    }
};
