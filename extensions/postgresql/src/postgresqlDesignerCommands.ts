import * as vscode from 'vscode';
import {
    getErrorMessage,
    isTableItem,
    type PostgresqlMaintenanceApi,
    resolveOperationContext,
    type PostgresqlSchemaItemData,
} from './postgresqlCommandContext';
import { PostgresqlAlterTableDesignerView } from './postgresqlAlterTableDesignerView';
import { PostgresqlIndexDesignerView } from './postgresqlIndexDesignerView';

export function registerPostgresqlDesignerCommands(
    context: vscode.ExtensionContext,
    api: PostgresqlMaintenanceApi,
): vscode.Disposable[] {
    const alterTableDesigner = vscode.commands.registerCommand(
        'justybase.postgresql.alterTableDesigner',
        async (item: PostgresqlSchemaItemData) => {
            if (!isTableItem(item)) {
                vscode.window.showErrorMessage('Please select a PostgreSQL table to alter.');
                return;
            }
            const operation = await resolveOperationContext(context, api, item, 'Alter table');
            if (!operation) {
                return;
            }
            try {
                await PostgresqlAlterTableDesignerView.createOrShow(context, operation);
            } catch (error) {
                vscode.window.showErrorMessage(`Could not open PostgreSQL Alter Table Designer: ${getErrorMessage(error)}`);
            }
        },
    );

    const createIndexWizard = vscode.commands.registerCommand(
        'justybase.postgresql.createIndexWizard',
        async (item: PostgresqlSchemaItemData) => {
            if (!isTableItem(item)) {
                vscode.window.showErrorMessage('Please select a PostgreSQL table to create an index.');
                return;
            }
            const operation = await resolveOperationContext(context, api, item, 'Create index');
            if (!operation) {
                return;
            }
            try {
                await PostgresqlIndexDesignerView.createOrShow(context, operation);
            } catch (error) {
                vscode.window.showErrorMessage(`Could not open PostgreSQL Index Designer: ${getErrorMessage(error)}`);
            }
        },
    );

    return [alterTableDesigner, createIndexWizard];
}