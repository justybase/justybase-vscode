/**
 * Schema Commands - Copy/Clipboard Operations
 * Commands: copySelectAll, copyDrop, copyName
 */

import * as vscode from 'vscode';
import { runQuery } from '../../core/queryRunner';
import { SchemaCommandsDependencies, SchemaItemData } from './types';
import { getFullName, executeWithProgress, getItemObjectName } from './helpers';
import { buildSchemaItemMetadataComment } from './tableMetadataCommentService';

/**
 * Register copy-related commands
 */
export function registerCopyCommands(deps: SchemaCommandsDependencies): vscode.Disposable[] {
    const { context, connectionManager, schemaProvider } = deps;

    return [
        // Copy Select All
        vscode.commands.registerCommand('netezza.copySelectAll', async (item: SchemaItemData) => {
            if (item && getItemObjectName(item) && item.dbName) {
                const sql = `SELECT * FROM ${getFullName(item, connectionManager)} LIMIT 1000;`;

                const action = await vscode.window.showQuickPick(
                    [
                        { label: 'Open in Editor', description: 'Open SQL in a new editor', value: 'editor' },
                        { label: 'Copy to Clipboard', description: 'Copy SQL to clipboard', value: 'clipboard' }
                    ],
                    {
                        placeHolder: 'How would you like to access the SQL?'
                    }
                );

                if (action) {
                    if (action.value === 'editor') {
                        const doc = await vscode.workspace.openTextDocument({
                            content: sql,
                            language: 'sql'
                        });
                        await vscode.window.showTextDocument(doc);
                    } else {
                        await vscode.env.clipboard.writeText(sql);
                        vscode.window.showInformationMessage('Copied to clipboard');
                    }
                }
            }
        }),

        // Copy Drop
        vscode.commands.registerCommand('netezza.copyDrop', async (item: SchemaItemData) => {
            if (item && getItemObjectName(item) && item.dbName && item.objType) {
                const fullName = getFullName(item, connectionManager);
                const sql = `DROP ${item.objType} ${fullName};`;

                const confirmation = await vscode.window.showWarningMessage(
                    `Are you sure you want to delete ${item.objType.toLowerCase()} "${fullName}"?`,
                    { modal: true },
                    'Yes, delete',
                    'Cancel'
                );

                if (confirmation === 'Yes, delete') {
                    // Note: runQuery uses connectionManager internally, no need to pre-fetch connection

                    try {
                        await executeWithProgress(
                            `Deleting ${item.objType.toLowerCase()} ${fullName}...`,
                            async () => {
                                await runQuery(context, sql, true, item.connectionName, connectionManager);
                            }
                        );

                        vscode.window.showInformationMessage(`Deleted ${item.objType.toLowerCase()}: ${fullName}`);
                        schemaProvider.refresh();
                    } catch (err: unknown) {
                        const message = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(`Error during deletion: ${message}`);
                    }
                }
            }
        }),

        // Copy Name
        vscode.commands.registerCommand('netezza.copyName', (item: SchemaItemData) => {
            if (item && getItemObjectName(item) && item.dbName) {
                const name = getFullName(item, connectionManager);
                vscode.env.clipboard.writeText(name);
                vscode.window.showInformationMessage('Copied to clipboard');
            }
        }),

        vscode.commands.registerCommand(
            'netezza.schema.copyTableMetadataComment',
            async (item: SchemaItemData) => {
                if (!item || !getItemObjectName(item) || !item.dbName) {
                    return;
                }

                try {
                    const comment = await buildSchemaItemMetadataComment(deps, item);
                    if (!comment) {
                        vscode.window.showWarningMessage(
                            'No table metadata available to copy.',
                        );
                        return;
                    }

                    await vscode.env.clipboard.writeText(comment);
                    vscode.window.showInformationMessage(
                        `Copied metadata comment for ${getItemObjectName(item)}`,
                    );
                } catch (error: unknown) {
                    const message = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(
                        `Failed to copy table metadata comment: ${message}`,
                    );
                }
            },
        ),
    ];
}
