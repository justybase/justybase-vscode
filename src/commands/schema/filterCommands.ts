import * as vscode from 'vscode';
import { SchemaCommandsDependencies } from './types';

const QUICK_FILTER_CONTEXT_KEY = 'justybase.schema.quickFilterActive';
type SchemaFilterCommandDependencies = Pick<SchemaCommandsDependencies, 'schemaProvider' | 'schemaTreeView'>;

function getQuickFilter(schemaProvider: SchemaCommandsDependencies['schemaProvider']): string | undefined {
    // Keep command registration compatible with lightweight test doubles and
    // older embedders that only implement the original filter API.
    return typeof schemaProvider.getQuickFilter === 'function'
        ? schemaProvider.getQuickFilter()
        : undefined;
}

function updateSchemaTreeDescription({ schemaProvider, schemaTreeView }: SchemaFilterCommandDependencies): void {
    const descriptions: string[] = [];
    const filter = schemaProvider.getFilter();
    const quickFilter = getQuickFilter(schemaProvider);
    if (filter) {
        descriptions.push(`Filter: ${filter}`);
    }
    if (quickFilter) {
        descriptions.push(`Quick: ${quickFilter}`);
    }
    schemaTreeView.description = descriptions.length > 0
        ? `(${descriptions.join(' · ')})`
        : '';
}

export function registerFilterCommands({ schemaProvider, schemaTreeView }: SchemaCommandsDependencies): vscode.Disposable[] {
    void vscode.commands.executeCommand(
        'setContext',
        QUICK_FILTER_CONTEXT_KEY,
        Boolean(getQuickFilter(schemaProvider)),
    );

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
                updateSchemaTreeDescription({ schemaProvider, schemaTreeView });
            }
        }),

        vscode.commands.registerCommand('netezza.schema.clearFilter', () => {
            schemaProvider.setFilter(undefined);
            updateSchemaTreeDescription({ schemaProvider, schemaTreeView });
        }),

        vscode.commands.registerCommand('netezza.schema.quickFilter', async () => {
            const currentFilter = getQuickFilter(schemaProvider) || '';
            const filterString = await vscode.window.showInputBox({
                prompt: 'Quickly filter loaded schema objects by name (local only)',
                placeHolder: 'Object name...',
                value: currentFilter,
            });

            if (filterString !== undefined) {
                const trimmedFilter = filterString.trim();
                schemaProvider.setQuickFilter(trimmedFilter ? trimmedFilter : undefined);
                void vscode.commands.executeCommand(
                    'setContext',
                    QUICK_FILTER_CONTEXT_KEY,
                    Boolean(trimmedFilter),
                );
                updateSchemaTreeDescription({ schemaProvider, schemaTreeView });
            }
        }),

        vscode.commands.registerCommand('netezza.schema.clearQuickFilter', () => {
            schemaProvider.setQuickFilter(undefined);
            void vscode.commands.executeCommand('setContext', QUICK_FILTER_CONTEXT_KEY, false);
            updateSchemaTreeDescription({ schemaProvider, schemaTreeView });
        }),
    ];
}
