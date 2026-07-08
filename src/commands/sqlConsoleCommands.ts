import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { SchemaItemData } from './schema/types';
import {
    openSqlConsole,
    resolveSqlConsoleContextFromTreeItem,
} from '../utils/sqlConsole';

export interface SqlConsoleCommandsContext {
    context: vscode.ExtensionContext;
    connectionManager: ConnectionManager;
}

/**
 * SQL Console: ephemeral editor with pinned connection and per-connection history.
 */
export function registerSqlConsoleCommands(
    ctx: SqlConsoleCommandsContext,
): vscode.Disposable[] {
    const { context, connectionManager } = ctx;

    return [
        vscode.commands.registerCommand(
            'netezza.openSqlConsole',
            async (item?: SchemaItemData) => {
                const treeContext = resolveSqlConsoleContextFromTreeItem(item);
                await openSqlConsole(context, connectionManager, {
                    connectionName: treeContext.connectionName,
                    database: treeContext.database,
                });
            },
        ),
    ];
}
