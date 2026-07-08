import type { DatabaseSessionMonitorProvider } from '@justybase/contracts';
import { ConnectionManager } from '../../../src/core/connectionManager';
import {
    emptySessionMonitorResources,
    normalizeDatabaseFilter,
    runSessionMonitorQuery,
    toNumber
} from '../../../src/core/sessionMonitorProviderUtils';

function formatTimestamp(value: Date): string {
    return value.toISOString().slice(0, 19).replace('T', ' ');
}

async function resolveConnectionDetails(
    connectionManager: ConnectionManager
): Promise<{ databaseName: string; userName: string }> {
    const activeConnectionName = connectionManager.getActiveConnectionName();
    if (!activeConnectionName) {
        return {
            databaseName: 'DuckDB',
            userName: 'duckdb'
        };
    }

    const details = await connectionManager.getConnection(activeConnectionName);
    return {
        databaseName: normalizeDatabaseFilter(details?.database) ?? 'DuckDB',
        userName: normalizeDatabaseFilter(details?.user) ?? 'duckdb'
    };
}

export const duckdbSessionMonitorProvider: DatabaseSessionMonitorProvider = {
    async getSessions(_context, mgr, database) {
        const connectionManager = mgr as ConnectionManager;
        const details = await resolveConnectionDetails(connectionManager);
        const databaseName = normalizeDatabaseFilter(database) ?? details.databaseName;

        return [
            {
                ID: 1,
                PID: 1,
                USERNAME: details.userName,
                DBNAME: databaseName,
                TYPE: 'duckdb',
                CONNTIME: formatTimestamp(new Date()),
                STATUS: 'ACTIVE',
                COMMAND: '',
                PRIORITY: 0,
                CID: 0,
                IPADDR: '',
                CLIENT_OS_USERNAME: details.userName
            }
        ];
    },

    async getQueries() {
        return [];
    },

    async getStorage(context, mgr) {
        const connectionManager = mgr as ConnectionManager;
        const rows = await runSessionMonitorQuery<Record<string, unknown>>(
            context,
            connectionManager,
            `
                SELECT
                    database_name AS "DATABASE",
                    'main' AS "SCHEMA",
                    ROUND(total_blocks * block_size / 1024.0 / 1024.0, 2) AS "ALLOC_MB",
                    ROUND(used_blocks * block_size / 1024.0 / 1024.0, 2) AS "USED_MB",
                    0 AS "AVG_SKEW",
                    (SELECT COUNT(*) FROM duckdb_tables() WHERE NOT internal) AS "TABLE_COUNT"
                FROM pragma_database_size()
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

    async getResources(context, mgr) {
        const connectionManager = mgr as ConnectionManager;
        const systemUtil = await runSessionMonitorQuery<Record<string, unknown>>(
            context,
            connectionManager,
            `
                SELECT
                    tag AS "TAG",
                    memory_usage_bytes AS "MEMORY_USAGE_BYTES",
                    temporary_storage_bytes AS "TEMPORARY_STORAGE_BYTES"
                FROM duckdb_memory()
                ORDER BY memory_usage_bytes DESC
            `
        );

        if (systemUtil.length === 0) {
            return emptySessionMonitorResources();
        }

        return {
            gra: [],
            systemUtil: systemUtil.map((row) => ({
                ...row,
                MEMORY_USAGE_BYTES: toNumber(row.MEMORY_USAGE_BYTES),
                TEMPORARY_STORAGE_BYTES: toNumber(row.TEMPORARY_STORAGE_BYTES)
            })),
            sysUtilSummary: null
        };
    },

    async killSession() {
        throw new Error('DuckDB embedded sessions cannot be terminated from the session monitor.');
    }
};
