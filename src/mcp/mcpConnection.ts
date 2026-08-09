import { getExtensionConfiguration } from '../compatibility/configuration';
import type { ConnectionDetails } from '../types';
import type { DatabaseKind } from '../contracts/database';

/** The small part of ConnectionManager needed by the MCP connection gate. */
export interface McpConnectionManagerLike {
    getConnectionDatabaseKind(name?: string): DatabaseKind | undefined;
    getConnection(name: string): Promise<ConnectionDetails | undefined>;
}

export interface McpConnectionListManagerLike extends McpConnectionManagerLike {
    getConnections(): Promise<ConnectionDetails[]>;
}

export interface ResolvedMcpConnection {
    connectionName: string;
    details: ConnectionDetails;
}

export interface McpConnectionResolutionError {
    error: string;
}

export type McpConnectionResolution = ResolvedMcpConnection | McpConnectionResolutionError;

export function getConfiguredMcpConnectionName(): string | undefined {
    const configured = getExtensionConfiguration('mcp').get<string>('connectionName', '');
    const trimmed = configured?.trim();
    return trimmed || undefined;
}

export function normalizeMcpConnectionName(connectionName: string | undefined): string | undefined {
    const trimmed = connectionName?.trim();
    return trimmed || undefined;
}

/**
 * Performs the synchronous part of the MCP target validation. This deliberately
 * never consults the active editor connection.
 */
export function getMcpConnectionSelectionError(
    connectionManager: McpConnectionManagerLike,
    connectionName: string | undefined,
): string | undefined {
    const selectedName = normalizeMcpConnectionName(connectionName);
    if (!selectedName) {
        return 'Select an Netezza connection in JustyBase Settings → MCP Server before starting the server.';
    }

    const kind = connectionManager.getConnectionDatabaseKind(selectedName);
    if (!kind) {
        return `Selected MCP connection "${selectedName}" was not found or its credentials are not accessible. Select an available Netezza connection.`;
    }
    if (kind !== 'netezza') {
        return `Selected MCP connection "${selectedName}" is not a Netezza connection. Select a Netezza connection.`;
    }
    return undefined;
}

export async function resolveSelectedMcpConnection(
    connectionManager: McpConnectionManagerLike,
    connectionName: string | undefined,
): Promise<McpConnectionResolution> {
    const selectedName = normalizeMcpConnectionName(connectionName);
    const selectionError = getMcpConnectionSelectionError(connectionManager, selectedName);
    if (selectionError) {
        return { error: selectionError };
    }

    try {
        const details = await connectionManager.getConnection(selectedName!);
        if (!details) {
            return {
                error: `Selected MCP connection "${selectedName}" was found, but its credentials are unavailable or access was denied.`
            };
        }
        return { connectionName: selectedName!, details };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            error: `Selected MCP connection "${selectedName}" could not be accessed: ${message}`
        };
    }
}

export async function getAvailableNetezzaConnectionNames(
    connectionManager: McpConnectionListManagerLike,
): Promise<string[]> {
    const connections = await connectionManager.getConnections();
    return connections
        .filter(connection => {
            const name = normalizeMcpConnectionName(connection.name);
            return Boolean(name && connectionManager.getConnectionDatabaseKind(name) === 'netezza');
        })
        .map(connection => connection.name!.trim())
        .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}
