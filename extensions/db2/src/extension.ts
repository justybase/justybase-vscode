import * as vscode from 'vscode';
import { db2Dialect } from './db2Dialect';
import { registerDb2PartitionCommands } from './db2PartitionCommands';
import { registerDb2IndexCommands } from './db2IndexCommands';
import { registerDb2DesignerCommands } from './db2DesignerCommands';
import { isDb2MaintenanceApi } from './db2CommandContext';
import { activateCoreExtension } from '@justybase/vscode-companion-adapter';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const api = await activateCoreExtension();
    api.registerDatabaseDialect(db2Dialect);
    if (!isDb2MaintenanceApi(api)) {
        vscode.window.showWarningMessage('Update the JustyBase core extension to enable Db2 maintenance commands.');
        return;
    }

    // Register DB2 specific commands
    context.subscriptions.push(
        ...registerDb2PartitionCommands(context, api),
        ...registerDb2IndexCommands(context, api),
        ...registerDb2DesignerCommands(context, api)
    );
}

export function deactivate(): void {}
