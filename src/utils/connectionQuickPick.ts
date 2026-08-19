import * as vscode from 'vscode';
import type { NamedConnectionDetails } from '../types';

export interface ConnectionQuickPickItem extends vscode.QuickPickItem {
    name: string;
}

/**
 * Format the connection target shown beneath a connection name in pickers.
 * Local profiles do not have a host/port, so their database/path is shown on
 * its own instead of producing a misleading `:undefined/…` label.
 */
export function formatConnectionTarget(connection: Pick<NamedConnectionDetails, 'host' | 'port' | 'database'>): string {
    const host = connection.host?.trim();
    const database = connection.database?.trim() || 'default';

    if (!host) {
        return database;
    }

    const port = typeof connection.port === 'number' ? `:${connection.port}` : '';
    return `${host}${port}/${database}`;
}

export function createConnectionQuickPickItems(
    connections: readonly NamedConnectionDetails[],
    currentConnectionName?: string | null,
): ConnectionQuickPickItem[] {
    return connections.map(connection => ({
        label: connection.name,
        description: `${connection.name === currentConnectionName ? '$(check) ' : ''}${formatConnectionTarget(connection)}`,
        name: connection.name,
    }));
}
