import type { DatabaseSessionMonitorProvider } from '@justybase/contracts';
import { runQueryRaw, queryResultToRows } from '../../../src/core/queryRunner';
import { ConnectionManager } from '../../../src/core/connectionManager';

function escapeSqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

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

function toSessionId(value: unknown): string {
    return typeof value === 'string' ? value : String(value ?? '');
}

export const verticaSessionMonitorProvider: DatabaseSessionMonitorProvider = {
    async getSessions(context, mgr) {
        const connectionManager = mgr as ConnectionManager;
        const sql = `
            SELECT
                SESSION_ID AS "ID",
                SESSION_ID AS "PID",
                USER_NAME AS "USERNAME",
                CURRENT_DATABASE() AS "DBNAME",
                COALESCE(CLIENT_TYPE, 'client') AS "TYPE",
                TO_CHAR(LOGIN_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS "CONNTIME",
                CASE WHEN CURRENT_STATEMENT IS NOT NULL THEN 'ACTIVE' ELSE 'IDLE' END AS "STATUS",
                SUBSTR(COALESCE(CURRENT_STATEMENT, LAST_STATEMENT, ''), 1, 200) AS "COMMAND",
                0 AS "PRIORITY",
                0 AS "CID",
                COALESCE(CLIENT_HOSTNAME, '') AS "IPADDR",
                COALESCE(CLIENT_OS_USER_NAME, '') AS "CLIENT_OS_USERNAME"
            FROM V_MONITOR.SESSIONS
            WHERE USER_NAME IS NOT NULL
            ORDER BY LOGIN_TIMESTAMP DESC
        `;
        const result = await runQueryRaw(context, sql, true, connectionManager, undefined, undefined, undefined, undefined, 1000, false);
        if (!result?.data) {
            return [];
        }
        return queryResultToRows<Record<string, unknown>>(result);
    },

    async getQueries(context, mgr) {
        const connectionManager = mgr as ConnectionManager;
        const sql = `
            SELECT
                SESSION_ID AS "QS_SESSIONID",
                REQUEST_ID AS "QS_PLANID",
                0 AS "QS_CLIENTID",
                '' AS "QS_CLIIPADDR",
                SUBSTR(COALESCE(REQUEST, ''), 1, 300) AS "QS_SQL",
                CASE WHEN IS_EXECUTING THEN 'EXECUTING' ELSE 'DONE' END AS "QS_STATE",
                TO_CHAR(START_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS "QS_TSUBMIT",
                TO_CHAR(START_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS "QS_TSTART",
                0 AS "QS_PRIORITY",
                'Normal' AS "QS_PRITXT",
                0 AS "QS_ESTCOST",
                0 AS "QS_ESTDISK",
                COALESCE(MEMORY_ACQUIRED_MB, 0) AS "QS_ESTMEM",
                0 AS "QS_SNIPPETS",
                0 AS "QS_CURSNIPT",
                0 AS "QS_RESROWS",
                0 AS "QS_RESBYTES",
                USER_NAME AS "USERNAME"
            FROM V_MONITOR.QUERY_REQUESTS
            WHERE IS_EXECUTING
            ORDER BY START_TIMESTAMP DESC
            LIMIT 1000
        `;
        const result = await runQueryRaw(context, sql, true, connectionManager, undefined, undefined, undefined, undefined, 1000, false);
        if (!result?.data) {
            return [];
        }
        return queryResultToRows<Record<string, unknown>>(result);
    },

    async getStorage(context, mgr) {
        const connectionManager = mgr as ConnectionManager;
        const sql = `
            SELECT
                CURRENT_DATABASE() AS "DATABASE",
                TABLE_SCHEMA AS "SCHEMA",
                0 AS "ALLOC_MB",
                0 AS "USED_MB",
                0 AS "AVG_SKEW",
                COUNT(*) AS "TABLE_COUNT"
            FROM V_CATALOG.TABLES
            WHERE NOT IS_SYSTEM_TABLE
            GROUP BY TABLE_SCHEMA
            ORDER BY TABLE_COUNT DESC, TABLE_SCHEMA
        `;
        const result = await runQueryRaw(context, sql, true, connectionManager, undefined, undefined, undefined, undefined, 1000, false);
        if (!result?.data) {
            return [];
        }
        return queryResultToRows<Record<string, unknown>>(result).map((row) => ({
            ...row,
            ALLOC_MB: toNumber(row.ALLOC_MB),
            USED_MB: toNumber(row.USED_MB),
            AVG_SKEW: toNumber(row.AVG_SKEW),
            TABLE_COUNT: toNumber(row.TABLE_COUNT),
        }));
    },

    async getResources() {
        return {
            gra: [],
            systemUtil: [],
            sysUtilSummary: null,
        };
    },

    async killSession(context, mgr, sessionId) {
        const connectionManager = mgr as ConnectionManager;
        const normalizedSessionId = toSessionId(sessionId).trim();
        if (!normalizedSessionId) {
            throw new Error('Invalid Vertica session ID.');
        }
        const sql = `SELECT CLOSE_SESSION('${escapeSqlLiteral(normalizedSessionId)}');`;
        await runQueryRaw(context, sql, true, connectionManager, undefined);
    },
};
