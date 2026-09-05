import * as vscode from 'vscode';
import { activateCoreExtension } from '../../../src/api/companionActivation';
import { isPostgresqlMaintenanceApi } from './postgresqlCommandContext';
import { registerPostgresqlDesignerCommands } from './postgresqlDesignerCommands';
import { postgresqlDialect } from './postgresqlDialect';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const api = await activateCoreExtension();
    api.registerDatabaseDialect(postgresqlDialect);
    if (!isPostgresqlMaintenanceApi(api)) {
        vscode.window.showWarningMessage('Update the JustyBase core extension to enable PostgreSQL table, index, and constraint designers.');
        return;
    }
    context.subscriptions.push(...registerPostgresqlDesignerCommands(context, api));
}

export function deactivate(): void {}
