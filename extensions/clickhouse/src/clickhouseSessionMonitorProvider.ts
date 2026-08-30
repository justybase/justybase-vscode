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

function databaseFilter(database: string | undefined, column = 'database'): string {
    const normalized = normalizeDatabaseFilter(database);
    return normalized ? `AND ${column} = '${escapeSqlLiteral(normalized)}'` : '';
}

function queryIdLiteral(queryId: string): string {
    const normalized = queryId.trim();
    if (!normalized) {
        throw new Error('ClickHouse query_id cannot be empty.');
    }
    if (normalized.length > 512) {
        throw new Error('ClickHouse query_id is unexpectedly long.');
    }
    return `'${escapeSqlLiteral(normalized)}'`;
}

// Keep the UI-facing session ID below Number.MAX_SAFE_INTEGER. ClickHouse's
// native UInt64 hash is commonly serialized as a string and cannot be safely
// round-tripped through the existing numeric session-monitor contract.
const SESSION_ID_EXPRESSION = 'toUInt64(1 + cityHash64(query_id) % 9000000000000000)';

/**
 * ClickHouse exposes active work as queries rather than durable server
 * sessions. The UI receives a stable numeric hash of query_id and uses the
 * same hash in KILL QUERY, so the existing session-monitor contract remains
 * usable without pretending ClickHouse has numeric PIDs.
 */
export const clickhouseSessionMonitorProvider: DatabaseSessionMonitorProvider = {
    async getSessions(context, mgr, database, connectionName) {
        const connectionManager = mgr as ConnectionManager;
        return runSessionMonitorQuery<Record<string, unknown>>(
            context,
            connectionManager,
            `
                SELECT
                    ${SESSION_ID_EXPRESSION} AS "ID",
                    ${SESSION_ID_EXPRESSION} AS "PID",
                    query_id AS "QUERY_ID",
                    user AS "USERNAME",
                    current_database AS "DBNAME",
                    query_kind AS "TYPE",
                    toString(now() - toIntervalSecond(toUInt32(elapsed))) AS "CONNTIME",
                    if(is_cancelled = 1, 'CANCELLED', 'RUNNING') AS "STATUS",
                    substring(query, 1, 200) AS "COMMAND",
                    0 AS "PRIORITY",
                    0 AS "CID",
                    address AS "IPADDR",
                    '' AS "CLIENT_OS_USERNAME"
                FROM system.processes
                WHERE query_id != ''
                  ${databaseFilter(database, 'current_database')}
                ORDER BY elapsed DESC
                LIMIT 1000
            `,
            1000,
            connectionName,
        );
    },

    async getQueries(context, mgr, database, connectionName) {
        const connectionManager = mgr as ConnectionManager;
        return runSessionMonitorQuery<Record<string, unknown>>(
            context,
            connectionManager,
            `
                SELECT
                    ${SESSION_ID_EXPRESSION} AS "QS_SESSIONID",
                    query_id AS "QS_QUERY_ID",
                    0 AS "QS_PLANID",
                    0 AS "QS_CLIENTID",
                    address AS "QS_CLIIPADDR",
                    substring(query, 1, 300) AS "QS_SQL",
                    if(is_cancelled = 1, 'CANCELLED', 'RUNNING') AS "QS_STATE",
                    toString(now() - toIntervalSecond(toUInt32(elapsed))) AS "QS_TSUBMIT",
                    toString(now() - toIntervalSecond(toUInt32(elapsed))) AS "QS_TSTART",
                    0 AS "QS_PRIORITY",
                    'Normal' AS "QS_PRITXT",
                    read_rows AS "QS_ESTCOST",
                    read_bytes AS "QS_ESTDISK",
                    memory_usage AS "QS_ESTMEM",
                    0 AS "QS_SNIPPETS",
                    0 AS "QS_CURSNIPT",
                    written_rows AS "QS_RESROWS",
                    written_bytes AS "QS_RESBYTES",
                    user AS "USERNAME"
                FROM system.processes
                WHERE query_id != ''
                  AND query != ''
                  ${databaseFilter(database, 'current_database')}
                ORDER BY elapsed DESC
                LIMIT 1000
            `,
            1000,
            connectionName,
        );
    },

    async getStorage(context, mgr, connectionName) {
        const connectionManager = mgr as ConnectionManager;
        const rows = await runSessionMonitorQuery<Record<string, unknown>>(
            context,
            connectionManager,
            `
                SELECT
                    database AS "DATABASE",
                    database AS "SCHEMA",
                    round(sum(bytes_on_disk) / 1024.0 / 1024.0, 2) AS "ALLOC_MB",
                    round(sum(data_compressed_bytes) / 1024.0 / 1024.0, 2) AS "USED_MB",
                    0 AS "AVG_SKEW",
                    uniqExact(table) AS "TABLE_COUNT"
                FROM system.parts
                WHERE active = 1
                GROUP BY database
                ORDER BY USED_MB DESC, database
            `,
            1000,
            connectionName,
        );
        return rows.map(row => ({
            ...row,
            ALLOC_MB: toNumber(row.ALLOC_MB),
            USED_MB: toNumber(row.USED_MB),
            AVG_SKEW: toNumber(row.AVG_SKEW),
            TABLE_COUNT: toNumber(row.TABLE_COUNT),
        }));
    },

    async getResources() {
        return emptySessionMonitorResources();
    },

    async killSession(context, mgr, sessionId, connectionName) {
        validatePositiveIntegerSessionId(sessionId, 'ClickHouse');
        const connectionManager = mgr as ConnectionManager;
        await executeSessionMonitorStatement(
            context,
            connectionManager,
            `KILL QUERY WHERE ${SESSION_ID_EXPRESSION} = toUInt64(${sessionId}) SYNC`,
            connectionName,
        );
    },

    async killQuery(context, mgr, queryId, connectionName) {
        const connectionManager = mgr as ConnectionManager;
        await executeSessionMonitorStatement(
            context,
            connectionManager,
            `KILL QUERY WHERE query_id = ${queryIdLiteral(queryId)} SYNC`,
            connectionName,
        );
    },
};
