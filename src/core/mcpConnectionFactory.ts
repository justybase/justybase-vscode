import { ClientTypeId, NzConnection } from '@justybase/netezza-driver';
import type { NzConnectionConfig } from '@justybase/netezza-driver';
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
): Promise<NzConnection> {
    const connectionConfig: NzConnectionConfig = {
        host: details.host,
        port: details.port ?? 5480,
        database: databaseOverride ?? details.database,
        user: details.user,
        password: details.password ?? '',
        clientType: ClientTypeId?.SqlDotnet ?? 11,
        connectionTimeout: getOptionNumber({
            host: details.host,
            port: details.port,
            database: details.database,
            user: details.user,
            password: details.password,
            options: details.options,
        }, 'connectionTimeout')
    };
    const connection = new NzConnection(connectionConfig);

    try {
        await connection.connect();
        return connection;
    } catch (error: unknown) {
        try {
            await connection.close();
        } catch {
            // Preserve the original connection failure.
        }
        throw error;
    }
}

export async function executeNetezzaDatabaseQuery<T = Record<string, unknown>>(
    connection: NzConnection,
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
