import * as vscode from 'vscode';
import {
    getErrorMessage,
    isTableItem,
    type MysqlMaintenanceApi,
    resolveOperationContext,
    type MysqlSchemaItemData,
} from './mysqlCommandContext';
import { MysqlIndexDesignerView } from './mysqlIndexDesignerView';
import { MysqlPartitionDesignerView } from './mysqlPartitionDesignerView';
import { MysqlAlterTableDesignerView } from './mysqlAlterTableDesignerView';

export function registerMysqlDesignerCommands(
    context: vscode.ExtensionContext,
    api: MysqlMaintenanceApi,
): vscode.Disposable[] {
    const alterTableDesigner = vscode.commands.registerCommand(
        'justybase.mysql.alterTableDesigner',
        async (item: MysqlSchemaItemData) => {
            if (!isTableItem(item)) {
                vscode.window.showErrorMessage('Please select a MySQL table to alter.');
                return;
            }
            const operation = await resolveOperationContext(context, api, item, 'Alter table');
            if (!operation) {
                return;
            }
            try {
                await MysqlAlterTableDesignerView.createOrShow(context, operation);
            } catch (error) {
                vscode.window.showErrorMessage(`Could not open MySQL Alter Table Designer: ${getErrorMessage(error)}`);
            }
        },
    );

    const createIndexWizard = vscode.commands.registerCommand(
        'justybase.mysql.createIndexWizard',
        async (item: MysqlSchemaItemData) => {
            if (!isTableItem(item)) {
                vscode.window.showErrorMessage('Please select a MySQL table to create an index.');
                return;
            }
            const operation = await resolveOperationContext(context, api, item, 'Create index');
            if (!operation) {
                return;
            }
            try {
                await MysqlIndexDesignerView.createOrShow(context, operation);
            } catch (error) {
                vscode.window.showErrorMessage(`Could not open MySQL Index Designer: ${getErrorMessage(error)}`);
            }
        },
    );

    const managePartitions = vscode.commands.registerCommand(
        'justybase.mysql.managePartitions',
        async (item: MysqlSchemaItemData) => {
            if (!isTableItem(item)) {
                vscode.window.showErrorMessage('Please select a MySQL table to manage partitions.');
                return;
            }
            const operation = await resolveOperationContext(context, api, item, 'Manage partitions');
            if (!operation) {
                return;
            }
            try {
                await MysqlPartitionDesignerView.createOrShow(context, operation);
            } catch (error) {
                vscode.window.showErrorMessage(`Could not open MySQL Partition Manager: ${getErrorMessage(error)}`);
            }
        },
    );

    return [alterTableDesigner, createIndexWizard, managePartitions];
}
