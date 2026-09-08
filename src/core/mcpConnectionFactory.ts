import {
  createConnectedNetezzaConnection,
  type NetezzaDriverConnection,
  type NetezzaDriverConfig,
} from '@justybase/netezza-runtime';
import type { ConnectionDetails } from '../types';
import { getOptionNumber } from './connectionUtils';

/**
 * Netezza-only connection helpers used by the standalone MCP process.
 *
 * Keeping this path independent from the dialect registry is important: the
 * registry also loads VS Code-facing optional providers, while the MCP child
 * process must run without the `vscode` module being installed.
 */
export async function createConnectedNetezzaConnectionFromDetails(
    details: ConnectionDetails,
    databaseOverride?: string,
): Promise<NetezzaDriverConnection> {
    const connectionConfig: NetezzaDriverConfig = {
        host: details.host,
        port: details.port ?? 5480,
        database: databaseOverride ?? details.database,
        user: details.user,
        password: details.password ?? '',
        clientType: 11,
        connectionTimeout: getOptionNumber({
            host: details.host,
            port: details.port,
            database: details.database,
            user: details.user,
            password: details.password,
            options: details.options,
        }, 'connectionTimeout')
    };
    return createConnectedNetezzaConnection(connectionConfig);
}

export async function executeNetezzaDatabaseQuery<T = Record<string, unknown>>(
    connection: NetezzaDriverConnection,
    sql: string,
): Promise<T[]> {
    const reader = await connection.createCommand(sql).executeReader();
    const results: Record<string, unknown>[] = [];
    try {
        while (await reader.read()) {
            const row: Record<string, unknown> = {};
            for (let index = 0; index < reader.fieldCount; index++) {
                row[reader.getName(index)] = reader.getValue(index);
            }
            results.push(row);
        }
        return results as T[];
    } finally {
        await reader.close();
    }
}
