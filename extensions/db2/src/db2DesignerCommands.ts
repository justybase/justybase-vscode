import * as vscode from 'vscode';
import { Db2MaintenanceApi, getErrorMessage, isTableItem, resolveOperationContext, SchemaItemData } from './db2CommandContext';
import { Db2IndexDesignerView } from './db2IndexDesignerView';
import { Db2PartitionDesignerView } from './db2PartitionDesignerView';

export function registerDb2DesignerCommands(
    context: vscode.ExtensionContext,
    api: Db2MaintenanceApi
): vscode.Disposable[] {
    const createIndexWizard = vscode.commands.registerCommand(
        'justybase.db2.createIndexWizard',
        async (item: SchemaItemData) => {
            if (!isTableItem(item)) {
                vscode.window.showErrorMessage('Please select a table to create an index.');
                return;
            }
            const operation = await resolveOperationContext(context, api, item, 'Create index');
            if (!operation) {
                return;
            }
            try {
                await Db2IndexDesignerView.createOrShow(context, operation);
            } catch (error) {
                vscode.window.showErrorMessage(`Could not open Db2 Index Designer: ${getErrorMessage(error)}`);
            }
        }
    );

    const managePartitions = vscode.commands.registerCommand(
        'justybase.db2.managePartitions',
        async (item: SchemaItemData) => {
            if (!isTableItem(item)) {
                vscode.window.showErrorMessage('Please select a table to manage partitions.');
                return;
            }
            const operation = await resolveOperationContext(context, api, item, 'Manage partitions');
            if (!operation) {
                return;
            }
            try {
                await Db2PartitionDesignerView.createOrShow(context, operation);
            } catch (error) {
                vscode.window.showErrorMessage(`Could not open Db2 Partition Manager: ${getErrorMessage(error)}`);
            }
        }
    );

    return [createIndexWizard, managePartitions];
}
