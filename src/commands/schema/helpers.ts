/**
 * Schema Commands - Helper Functions
 */

import * as vscode from 'vscode';
import { ConnectionManager } from '../../core/connectionManager';
import { SchemaItemData } from './types';
import { formatQualifiedObjectName } from '../../utils/identifierUtils';
export { escapeSqlString } from '../../utils/sqlUtils';

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
 * Validate identifier name (e.g., constraint name, user name)
 */
export function isValidIdentifier(value: string): boolean {
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value.trim());
}

/**
 * Open SQL in a new editor bound to the given connection and database, then run
 * it so the rows land in SQL Results. Silent `runQuery` calls only return the
 * rows to the caller, which is right for DDL but loses the result of a report.
 */
export async function openAndRunSql(
    connectionManager: Pick<ConnectionManager, 'setDocumentConnection' | 'setDocumentDatabase'>,
    target: { connectionName?: string; database?: string },
    sql: string,
    title: string,
): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: `-- ${title}\n${sql}` });
    if (target.connectionName) {
        connectionManager.setDocumentConnection(doc.uri.toString(), target.connectionName);
        if (target.database) {
            await connectionManager.setDocumentDatabase(doc.uri.toString(), target.database);
        }
    }
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand('netezza.runQuery');
}
