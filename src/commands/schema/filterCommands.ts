import * as vscode from 'vscode';
import { SchemaCommandsDependencies } from './types';

export function registerFilterCommands({ schemaProvider, schemaTreeView }: SchemaCommandsDependencies): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('netezza.schema.filter', async () => {
            const currentFilter = schemaProvider.getFilter() || '';
            const filterString = await vscode.window.showInputBox({
                prompt: 'Filter by name, type, or comment/description (e.g. *sales*, account key)',
                placeHolder: 'Name, type, or comment...',
                value: currentFilter
            });

            if (filterString !== undefined) {
                const trimmedFilter = filterString.trim();
                schemaProvider.setFilter(trimmedFilter ? trimmedFilter : undefined);
                schemaTreeView.description = trimmedFilter ? `(Filter: ${trimmedFilter})` : '';
            }
        }),

        vscode.commands.registerCommand('netezza.schema.clearFilter', () => {
            schemaProvider.setFilter(undefined);
            schemaTreeView.description = '';
        })
    ];
}
