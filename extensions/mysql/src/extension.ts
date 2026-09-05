import * as vscode from 'vscode';
import { activateCoreExtension } from '../../../src/api/companionActivation';
import { isMysqlMaintenanceApi } from './mysqlCommandContext';
import { registerMysqlDesignerCommands } from './mysqlDesignerCommands';
import { mysqlDialect } from './mysqlDialect';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const api = await activateCoreExtension();
    api.registerDatabaseDialect(mysqlDialect);
    if (!isMysqlMaintenanceApi(api)) {
        vscode.window.showWarningMessage('Update the JustyBase core extension to enable MySQL table, index, and partition designers.');
        return;
    }
    context.subscriptions.push(...registerMysqlDesignerCommands(context, api));
}

export function deactivate(): void {}
