import type { DatabaseSessionMonitorProvider } from '@justybase/contracts';
import { ConnectionManager } from '../../../src/core/connectionManager';
import {
    emptySessionMonitorResources,
    executeSessionMonitorStatement,
    runSessionMonitorQuery,
    toNumber,
    validatePositiveIntegerSessionId
} from '../../../src/core/sessionMonitorProviderUtils';

export const oracleSessionMonitorProvider: DatabaseSessionMonitorProvider = {
    async getSessions(context, mgr) {
        const connectionManager = mgr as ConnectionManager;
        return runSessionMonitorQuery<Record<string, unknown>>(
            context,
            connectionManager,
            `
                SELECT
                    s.SID AS "ID",
                    s.SID AS "PID",
                    s.USERNAME AS "USERNAME",
                    NVL(SYS_CONTEXT('USERENV', 'CON_NAME'), SYS_CONTEXT('USERENV', 'DB_NAME')) AS "DBNAME",
                    COALESCE(s.MODULE, s.PROGRAM, 'oracle') AS "TYPE",
                    TO_CHAR(s.LOGON_TIME, 'YYYY-MM-DD HH24:MI:SS') AS "CONNTIME",
                    s.STATUS AS "STATUS",
                    SUBSTR(COALESCE(q.SQL_TEXT, s.EVENT, ''), 1, 200) AS "COMMAND",
                    0 AS "PRIORITY",
                    0 AS "CID",
                    COALESCE(s.MACHINE, '') AS "IPADDR",
                    COALESCE(s.OSUSER, '') AS "CLIENT_OS_USERNAME"
                FROM V$SESSION s
                LEFT JOIN V$SQL q ON q.SQL_ID = s.SQL_ID
                WHERE s.TYPE <> 'BACKGROUND'
                  AND s.USERNAME IS NOT NULL
                ORDER BY s.LOGON_TIME DESC
            `
        );
    },

    async getQueries(context, mgr) {
        const connectionManager = mgr as ConnectionManager;
        return runSessionMonitorQuery<Record<string, unknown>>(
            context,
            connectionManager,
            `
                SELECT
                    s.SID AS "QS_SESSIONID",
                    0 AS "QS_PLANID",
                    0 AS "QS_CLIENTID",
                    COALESCE(s.MACHINE, '') AS "QS_CLIIPADDR",
                    SUBSTR(COALESCE(q.SQL_TEXT, ''), 1, 300) AS "QS_SQL",
                    COALESCE(s.STATUS, 'ACTIVE') AS "QS_STATE",
                    TO_CHAR(SYSDATE - NUMTODSINTERVAL(COALESCE(s.LAST_CALL_ET, 0), 'SECOND'), 'YYYY-MM-DD HH24:MI:SS') AS "QS_TSUBMIT",
                    TO_CHAR(SYSDATE - NUMTODSINTERVAL(COALESCE(s.LAST_CALL_ET, 0), 'SECOND'), 'YYYY-MM-DD HH24:MI:SS') AS "QS_TSTART",
                    0 AS "QS_PRIORITY",
                    'Normal' AS "QS_PRITXT",
                    0 AS "QS_ESTCOST",
                    0 AS "QS_ESTDISK",
                    0 AS "QS_ESTMEM",
                    0 AS "QS_SNIPPETS",
                    0 AS "QS_CURSNIPT",
                    0 AS "QS_RESROWS",
                    0 AS "QS_RESBYTES",
                    s.USERNAME AS "USERNAME"
                FROM V$SESSION s
                LEFT JOIN V$SQL q ON q.SQL_ID = s.SQL_ID
                WHERE s.TYPE <> 'BACKGROUND'
                  AND s.USERNAME IS NOT NULL
                  AND s.STATUS = 'ACTIVE'
                  AND s.SQL_ID IS NOT NULL
                ORDER BY s.LAST_CALL_ET DESC
                FETCH FIRST 1000 ROWS ONLY
            `
        );
    },

    async getStorage(context, mgr) {
        const connectionManager = mgr as ConnectionManager;
        let rows: Record<string, unknown>[];

        try {
            rows = await runSessionMonitorQuery<Record<string, unknown>>(
                context,
                connectionManager,
                `
                    SELECT
                        NVL(SYS_CONTEXT('USERENV', 'CON_NAME'), SYS_CONTEXT('USERENV', 'DB_NAME')) AS "DATABASE",
                        OWNER AS "SCHEMA",
                        ROUND(SUM(BYTES) / 1024.0 / 1024.0, 2) AS "ALLOC_MB",
                        ROUND(SUM(BYTES) / 1024.0 / 1024.0, 2) AS "USED_MB",
                        0 AS "AVG_SKEW",
                        COUNT(DISTINCT SEGMENT_NAME) AS "TABLE_COUNT"
                    FROM ALL_SEGMENTS
                    WHERE SEGMENT_TYPE IN ('TABLE', 'TABLE PARTITION', 'TABLE SUBPARTITION')
                    GROUP BY OWNER
                    ORDER BY SUM(BYTES) DESC, OWNER
                `
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const canFallback = message.includes('ORA-00942') || message.includes('ORA-01031');

            if (!canFallback) {
                throw error;
            }

            rows = await runSessionMonitorQuery<Record<string, unknown>>(
                context,
                connectionManager,
                `
                    SELECT
                        NVL(SYS_CONTEXT('USERENV', 'CON_NAME'), SYS_CONTEXT('USERENV', 'DB_NAME')) AS "DATABASE",
                        SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS "SCHEMA",
                        ROUND(SUM(BYTES) / 1024.0 / 1024.0, 2) AS "ALLOC_MB",
                        ROUND(SUM(BYTES) / 1024.0 / 1024.0, 2) AS "USED_MB",
                        0 AS "AVG_SKEW",
                        COUNT(DISTINCT SEGMENT_NAME) AS "TABLE_COUNT"
                    FROM USER_SEGMENTS
                    WHERE SEGMENT_TYPE IN ('TABLE', 'TABLE PARTITION', 'TABLE SUBPARTITION')
                    GROUP BY SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')
                    ORDER BY SUM(BYTES) DESC
                `
            );
        }

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
        validatePositiveIntegerSessionId(sessionId, 'Oracle');
        const connectionManager = mgr as ConnectionManager;
        await executeSessionMonitorStatement(
            context,
            connectionManager,
            `
                DECLARE
                    v_sid CONSTANT NUMBER := ${sessionId};
                    v_serial NUMBER;
                BEGIN
                    SELECT serial# INTO v_serial
                    FROM V$SESSION
                    WHERE SID = v_sid;

                    EXECUTE IMMEDIATE 'ALTER SYSTEM KILL SESSION ''' || TO_CHAR(v_sid) || ',' || TO_CHAR(v_serial) || ''' IMMEDIATE';
                END;
            `
        );
    }
};
