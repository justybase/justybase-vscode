/**
 * Schema Commands - Helper Functions
 */

import * as vscode from 'vscode';
import { ConnectionManager } from '../../core/connectionManager';
import { SchemaItemData } from './types';
import { formatQualifiedObjectName } from '../../utils/identifierUtils';

export function getItemObjectName(item: SchemaItemData): string {
    return item.rawLabel || item.label || '';
}

/**
 * Build fully qualified name from schema item
 */
export function getFullName(
    item: SchemaItemData,
    connectionManager?: Pick<ConnectionManager, 'getConnectionDatabaseKind'>
): string {
    const objectName = getItemObjectName(item);
    const databaseKind = connectionManager?.getConnectionDatabaseKind?.(item.connectionName);
    return formatQualifiedObjectName(item.dbName, item.schema, objectName, databaseKind);
}

export function getDialectAwareFullName(
    item: SchemaItemData,
    connectionManager: Pick<ConnectionManager, 'getConnectionDatabaseKind'>
): string {
    return getFullName(item, connectionManager);
}

/**
 * Validate connection exists and show error if not
 * @returns true if connection is available, false otherwise
 */
export async function requireConnection(
    connectionManager: ConnectionManager,
    connectionName?: string
): Promise<boolean> {
    const connectionDetails = await connectionManager.getConnection(connectionName || connectionManager.getActiveConnectionName() || '');
    if (!connectionDetails) {
        vscode.window.showErrorMessage('No database connection');
        return false;
    }
    return true;
}

/**
 * Execute an async task with VS Code progress notification
 */
export async function executeWithProgress<T>(
    title: string,
    task: (progress: vscode.Progress<{ message?: string; increment?: number }>) => Promise<T>
): Promise<T> {
    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title,
            cancellable: false
        },
        task
    );
}

/**
 * Escape single quotes in SQL strings
 */
export function escapeSqlString(value: string): string {
    return value.replace(/'/g, "''");
}

/**
 * Validate identifier name (e.g., constraint name, user name)
 */
export function isValidIdentifier(value: string): boolean {
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value.trim());
}
