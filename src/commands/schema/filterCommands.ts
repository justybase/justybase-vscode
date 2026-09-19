import * as vscode from 'vscode';
import { SchemaCommandsDependencies } from './types';

type SchemaFilterCommandDependencies = Pick<SchemaCommandsDependencies, 'schemaProvider' | 'schemaTreeView'>;

let activeTreeFilterInput: vscode.InputBox | undefined;

function getTreeFilter(schemaProvider: SchemaCommandsDependencies['schemaProvider']): string | undefined {
    // Keep command registration compatible with lightweight test doubles and
    // older embedders that only implement the original filter API.
    return typeof schemaProvider.getQuickFilter === 'function'
        ? schemaProvider.getQuickFilter()
        : schemaProvider.getFilter();
}

function setTreeFilter(
    schemaProvider: SchemaCommandsDependencies['schemaProvider'],
    filter: string | undefined,
): void {
    if (typeof schemaProvider.setQuickFilter === 'function') {
        schemaProvider.setQuickFilter(filter);
    } else {
        schemaProvider.setFilter(filter);
    }
}

function updateSchemaTreeDescription({ schemaProvider, schemaTreeView }: SchemaFilterCommandDependencies): void {
    const filter = getTreeFilter(schemaProvider);
    schemaTreeView.description = filter ? `(Filter: ${filter})` : '';
}

function openLiveTreeFilter({ schemaProvider, schemaTreeView }: SchemaFilterCommandDependencies): void {
    activeTreeFilterInput?.hide();

    const previousFilter = getTreeFilter(schemaProvider);
    const input = vscode.window.createInputBox();
    let accepted = false;
    activeTreeFilterInput = input;

    input.title = 'Filter Visible Objects';
    input.prompt = 'Filter loaded schema objects by name (local only)';
    input.placeholder = 'Object name...';
    input.value = previousFilter || '';
    input.ignoreFocusOut = true;

    input.onDidChangeValue((value) => {
        const trimmedFilter = value.trim();
        setTreeFilter(schemaProvider, trimmedFilter ? trimmedFilter : undefined);
        updateSchemaTreeDescription({ schemaProvider, schemaTreeView });
    });
    input.onDidAccept(() => {
        accepted = true;
        input.hide();
    });
    input.onDidHide(() => {
        if (!accepted) {
            setTreeFilter(schemaProvider, previousFilter);
            updateSchemaTreeDescription({ schemaProvider, schemaTreeView });
        }
        if (activeTreeFilterInput === input) {
            activeTreeFilterInput = undefined;
        }
        input.dispose();
    });

    input.show();
}

export function registerFilterCommands({ schemaProvider, schemaTreeView }: SchemaCommandsDependencies): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('netezza.schema.filter', () => {
            openLiveTreeFilter({ schemaProvider, schemaTreeView });
        }),

        vscode.commands.registerCommand('netezza.schema.clearFilter', () => {
            setTreeFilter(schemaProvider, undefined);
            updateSchemaTreeDescription({ schemaProvider, schemaTreeView });
        }),
    ];
}
