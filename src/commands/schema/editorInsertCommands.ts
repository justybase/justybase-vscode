/**
 * Schema Commands - Editor Insert Commands
 * Commands: insertToEditor, favorites.openSql
 */

import * as vscode from 'vscode';
import { SchemaCommandsDependencies } from './types';
import { formatIdentifierForSql } from '../../utils/identifierUtils';
import { getFullName, getItemObjectName } from './helpers';
import { resolveQueryVariables } from '../../core/variableResolver';

export function registerEditorInsertCommands(deps: SchemaCommandsDependencies): vscode.Disposable[] {
    let lastTreeClickTime = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastClickedItem: any = null;

    return [
        // Insert object into current editor
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        vscode.commands.registerCommand('netezza.insertToEditor', async (item: any, options?: { fromTreeClick?: boolean }) => {
            if (options?.fromTreeClick) {
                const now = Date.now();
                const isDoubleClick = (now - lastTreeClickTime < 500) && (lastClickedItem?.id === item?.id || lastClickedItem?.label === item?.label);
                lastTreeClickTime = now;
                lastClickedItem = item;

                if (!isDoubleClick) {
                    return; // Ignore single clicks from the tree to allow normal selection/expansion
                }
            }

            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active text editor to insert into.');
                return;
            }

            let insertText = '';

            // Determine if it's a favorite sql snippet
            if (item && item.type === 'sql' && item.sqlContent) {
                insertText = item.sqlContent;
            } else if (item && typeof item === 'object') {
                // It's a SchemaItem or Favorite object
                let label = getItemObjectName(item);
                const databaseKind = deps.connectionManager.getConnectionDatabaseKind?.(item.connectionName);

                if (typeof label === 'string') {
                    // if it's a column with type in label like ID (INTEGER)
                    if (item.contextValue === 'column') {
                        // Extract just the column name using a simple regex or split
                        // Supports nested type suffixes, e.g. "AMOUNT (NUMERIC(10,2))"
                        const match = label.match(/^(.+)\s+\((.+)\)$/);
                        if (match) {
                            label = match[1];
                        }
                        insertText = formatIdentifierForSql(label, databaseKind);
                    } else {
                        insertText = getFullName(item, deps.connectionManager);
                    }
                }
            }

            if (insertText) {
                await editor.edit(editBuilder => {
                    editBuilder.insert(editor.selection.active, insertText);
                });
            }
        }),

        // Note: The argument here is the raw SchemaFavorite passed via TreeItem.command property
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        vscode.commands.registerCommand('netezza.favorites.openSql', async (item: any, options?: { fromTreeClick?: boolean }) => {
            if (!item || !item.sqlContent) return;

            if (options?.fromTreeClick) {
                const now = Date.now();
                const isDoubleClick = (now - lastTreeClickTime < 500) && (lastClickedItem?.id === item?.id || lastClickedItem?.label === item?.label);
                lastTreeClickTime = now;
                lastClickedItem = item;

                if (!isDoubleClick) {
                    return; // Ignore single clicks from the tree
                }
            }

            let resolvedSql = item.sqlContent as string;
            try {
                resolvedSql = await resolveQueryVariables(item.sqlContent as string, false, deps.context);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                if (message === 'Variable input cancelled by user') {
                    return;
                }
                vscode.window.showErrorMessage(`Failed to resolve snippet parameters: ${message}`);
                return;
            }

            const editor = vscode.window.activeTextEditor;
            if (editor) {
                await editor.edit(editBuilder => {
                    editBuilder.insert(editor.selection.active, resolvedSql);
                });
            } else {
                const doc = await vscode.workspace.openTextDocument({
                    content: resolvedSql,
                    language: 'sql'
                });
                await vscode.window.showTextDocument(doc);
            }
        })
    ];
}
