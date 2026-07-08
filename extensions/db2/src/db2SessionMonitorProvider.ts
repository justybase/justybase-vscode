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

export const db2SessionMonitorProvider: DatabaseSessionMonitorProvider = {
    async getSessions(context, mgr, database) {
        const connectionManager = mgr as ConnectionManager;
        const scopedDatabase = normalizeDatabaseFilter(database);
        const whereClause = scopedDatabase
            ? `AND UPPER('${escapeSqlLiteral(scopedDatabase)}') = UPPER(CURRENT SERVER)`
            : '';

        return runSessionMonitorQuery<Record<string, unknown>>(
            context,
            connectionManager,
            `
                SELECT
                    APPLICATION_HANDLE AS "ID",
                    APPLICATION_HANDLE AS "PID",
                    SESSION_AUTH_ID AS "USERNAME",
                    CURRENT SERVER AS "DBNAME",
                    COALESCE(CLIENT_APPLNAME, APPLICATION_NAME, 'db2') AS "TYPE",
                    VARCHAR_FORMAT(CONNECTION_START_TIME, 'YYYY-MM-DD HH24:MI:SS') AS "CONNTIME",
                    'CONNECTED' AS "STATUS",
                    SUBSTR(COALESCE(CLIENT_APPLNAME, APPLICATION_NAME, ''), 1, 200) AS "COMMAND",
                    0 AS "PRIORITY",
                    0 AS "CID",
                    COALESCE(CLIENT_WRKSTNNAME, '') AS "IPADDR",
                    COALESCE(CLIENT_USERID, '') AS "CLIENT_OS_USERNAME"
                FROM TABLE(MON_GET_CONNECTION(NULL, -2))
                WHERE APPLICATION_HANDLE IS NOT NULL
                  ${whereClause}
                ORDER BY CONNECTION_START_TIME DESC
            `
        );
    },

    async getQueries(context, mgr, database) {
        const connectionManager = mgr as ConnectionManager;
        const scopedDatabase = normalizeDatabaseFilter(database);
        const whereClause = scopedDatabase
            ? `AND UPPER('${escapeSqlLiteral(scopedDatabase)}') = UPPER(CURRENT SERVER)`
            : '';

        return runSessionMonitorQuery<Record<string, unknown>>(
            context,
            connectionManager,
            `
                SELECT
                    a.APPLICATION_HANDLE AS "QS_SESSIONID",
                    a.ACTIVITY_ID AS "QS_PLANID",
                    0 AS "QS_CLIENTID",
                    COALESCE(c.CLIENT_WRKSTNNAME, '') AS "QS_CLIIPADDR",
                    SUBSTR(COALESCE(a.STMT_TEXT, ''), 1, 300) AS "QS_SQL",
                    COALESCE(a.ACTIVITY_STATE, 'EXECUTING') AS "QS_STATE",
                    VARCHAR_FORMAT(COALESCE(a.ACTIVITY_START_TIME, CURRENT TIMESTAMP), 'YYYY-MM-DD HH24:MI:SS') AS "QS_TSUBMIT",
                    VARCHAR_FORMAT(COALESCE(a.ACTIVITY_START_TIME, CURRENT TIMESTAMP), 'YYYY-MM-DD HH24:MI:SS') AS "QS_TSTART",
                    0 AS "QS_PRIORITY",
                    'Normal' AS "QS_PRITXT",
                    0 AS "QS_ESTCOST",
                    0 AS "QS_ESTDISK",
                    0 AS "QS_ESTMEM",
                    0 AS "QS_SNIPPETS",
                    0 AS "QS_CURSNIPT",
                    0 AS "QS_RESROWS",
                    0 AS "QS_RESBYTES",
                    COALESCE(c.SESSION_AUTH_ID, '') AS "USERNAME"
                FROM TABLE(MON_GET_ACTIVITY(NULL, -2)) AS a
                LEFT JOIN TABLE(MON_GET_CONNECTION(NULL, -2)) AS c
                    ON c.APPLICATION_HANDLE = a.APPLICATION_HANDLE
                WHERE a.STMT_TEXT IS NOT NULL
                  ${whereClause}
                ORDER BY a.ACTIVITY_START_TIME DESC
                FETCH FIRST 1000 ROWS ONLY
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
                    CURRENT SERVER AS "DATABASE",
                    TABSCHEMA AS "SCHEMA",
                    0 AS "ALLOC_MB",
                    0 AS "USED_MB",
                    0 AS "AVG_SKEW",
                    COUNT(*) AS "TABLE_COUNT"
                FROM SYSCAT.TABLES
                WHERE TYPE = 'T'
                GROUP BY TABSCHEMA
                ORDER BY TABSCHEMA
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
        validatePositiveIntegerSessionId(sessionId, 'Db2');
        const connectionManager = mgr as ConnectionManager;
        await executeSessionMonitorStatement(context, connectionManager, `FORCE APPLICATION (${sessionId})`);
    }
};
