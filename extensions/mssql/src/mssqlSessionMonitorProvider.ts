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

export const mssqlSessionMonitorProvider: DatabaseSessionMonitorProvider = {
    async getSessions(context, mgr, database) {
        const connectionManager = mgr as ConnectionManager;
        const scopedDatabase = normalizeDatabaseFilter(database);
        const whereClause = scopedDatabase
            ? `AND UPPER(COALESCE(DB_NAME(COALESCE(r.database_id, s.database_id)), '')) = UPPER('${escapeSqlLiteral(scopedDatabase)}')`
            : '';

        return runSessionMonitorQuery<Record<string, unknown>>(
            context,
            connectionManager,
            `
                SELECT
                    s.session_id AS [ID],
                    s.session_id AS [PID],
                    s.login_name AS [USERNAME],
                    DB_NAME(COALESCE(r.database_id, s.database_id)) AS [DBNAME],
                    COALESCE(s.program_name, 'mssql') AS [TYPE],
                    CONVERT(varchar(19), s.login_time, 120) AS [CONNTIME],
                    COALESCE(r.status, s.status, '') AS [STATUS],
                    LEFT(COALESCE(t.text, ''), 200) AS [COMMAND],
                    0 AS [PRIORITY],
                    0 AS [CID],
                    COALESCE(c.client_net_address, '') AS [IPADDR],
                    COALESCE(s.host_name, '') AS [CLIENT_OS_USERNAME]
                FROM sys.dm_exec_sessions s
                LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
                LEFT JOIN sys.dm_exec_connections c ON c.session_id = s.session_id
                OUTER APPLY sys.dm_exec_sql_text(COALESCE(r.sql_handle, c.most_recent_sql_handle)) t
                WHERE s.is_user_process = 1
                  ${whereClause}
                ORDER BY s.login_time DESC
            `
        );
    },

    async getQueries(context, mgr, database) {
        const connectionManager = mgr as ConnectionManager;
        const scopedDatabase = normalizeDatabaseFilter(database);
        const whereClause = scopedDatabase
            ? `AND UPPER(COALESCE(DB_NAME(r.database_id), '')) = UPPER('${escapeSqlLiteral(scopedDatabase)}')`
            : '';

        return runSessionMonitorQuery<Record<string, unknown>>(
            context,
            connectionManager,
            `
                SELECT
                    r.session_id AS [QS_SESSIONID],
                    r.request_id AS [QS_PLANID],
                    0 AS [QS_CLIENTID],
                    COALESCE(c.client_net_address, '') AS [QS_CLIIPADDR],
                    LEFT(COALESCE(t.text, ''), 300) AS [QS_SQL],
                    COALESCE(r.status, '') AS [QS_STATE],
                    CONVERT(varchar(19), r.start_time, 120) AS [QS_TSUBMIT],
                    CONVERT(varchar(19), r.start_time, 120) AS [QS_TSTART],
                    0 AS [QS_PRIORITY],
                    'Normal' AS [QS_PRITXT],
                    0 AS [QS_ESTCOST],
                    0 AS [QS_ESTDISK],
                    CAST(COALESCE(r.granted_query_memory, 0) AS bigint) AS [QS_ESTMEM],
                    0 AS [QS_SNIPPETS],
                    0 AS [QS_CURSNIPT],
                    CAST(COALESCE(r.row_count, 0) AS bigint) AS [QS_RESROWS],
                    0 AS [QS_RESBYTES],
                    s.login_name AS [USERNAME]
                FROM sys.dm_exec_requests r
                INNER JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
                LEFT JOIN sys.dm_exec_connections c ON c.session_id = r.session_id
                OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
                WHERE s.is_user_process = 1
                  ${whereClause}
                ORDER BY r.start_time DESC
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
                    DB_NAME() AS [DATABASE],
                    s.name AS [SCHEMA],
                    ROUND(SUM(COALESCE(a.total_pages, 0)) * 8.0 / 1024.0, 2) AS [ALLOC_MB],
                    ROUND(SUM(COALESCE(a.used_pages, 0)) * 8.0 / 1024.0, 2) AS [USED_MB],
                    0 AS [AVG_SKEW],
                    COUNT(DISTINCT t.object_id) AS [TABLE_COUNT]
                FROM sys.tables t
                INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
                LEFT JOIN sys.indexes i ON i.object_id = t.object_id
                LEFT JOIN sys.partitions p ON p.object_id = i.object_id AND p.index_id = i.index_id
                LEFT JOIN sys.allocation_units a ON a.container_id = p.partition_id
                GROUP BY s.name
                ORDER BY USED_MB DESC, s.name
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
        validatePositiveIntegerSessionId(sessionId, 'MS SQL Server');
        const connectionManager = mgr as ConnectionManager;
        await executeSessionMonitorStatement(context, connectionManager, `KILL ${sessionId};`);
    }
};
