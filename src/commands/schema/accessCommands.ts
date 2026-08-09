import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SchemaItem } from '../../providers/schemaProvider';
import type { SchemaCommandsDependencies } from './types';

/** Register commands specific to the local Access database file. */
export function registerAccessCommands(
    { connectionManager }: SchemaCommandsDependencies,
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('netezza.revealAccessFile', async (item?: SchemaItem) => {
            const connectionName = item?.connectionName ?? connectionManager.getActiveConnectionName() ?? undefined;
            if (!connectionName) {
                vscode.window.showWarningMessage('Select an Access connection in Schema first.');
                return;
            }

            const databaseKind = connectionManager.getConnectionDatabaseKind(connectionName);
            if (databaseKind !== 'access') {
                vscode.window.showWarningMessage('The selected connection is not a Microsoft Access connection.');
                return;
            }

            const details = await connectionManager.getConnection(connectionName);
            const databasePath = details?.database?.trim();
            if (!databasePath) {
                vscode.window.showErrorMessage(`No Access database file is configured for '${connectionName}'.`);
                return;
            }

            const resolvedPath = path.resolve(databasePath);
            if (!fs.existsSync(resolvedPath)) {
                vscode.window.showWarningMessage(`Access database file was not found: ${resolvedPath}`);
                return;
            }

            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(resolvedPath));
        }),
    ];
}
