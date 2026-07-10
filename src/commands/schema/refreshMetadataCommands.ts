import * as vscode from 'vscode';
import type { SchemaItem } from '../../providers/schemaProvider';
import type { SchemaCommandsDependencies } from './types';

const REFRESHABLE_TABLE_TYPES = new Set(['TABLE', 'GLOBAL TEMP TABLE']);

export function registerRefreshMetadataCommands(
    deps: SchemaCommandsDependencies,
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand(
            'netezza.refreshSchemaSelection',
            async (item?: SchemaItem) => {
                const synchronizer = deps.tableDdlSynchronizer;
                const connectionName = item?.connectionName;
                const database = item?.dbName;
                const objectType = item?.objType?.toUpperCase();
                if (!synchronizer || !item || !connectionName || !database || !objectType) {
                    vscode.window.showWarningMessage('Select a Netezza table or table group to refresh.');
                    return;
                }
                if (!REFRESHABLE_TABLE_TYPES.has(objectType)) {
                    vscode.window.showWarningMessage('Lightweight refresh is available for TABLE and GLOBAL TEMP TABLE.');
                    return;
                }

                try {
                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Window,
                            title: `Refreshing ${objectType.toLowerCase()} metadata...`,
                            cancellable: false,
                        },
                        async () => {
                            if (item.contextValue.startsWith('typeGroup')) {
                                await synchronizer.refreshObjectType(connectionName, database, objectType);
                                return;
                            }
                            const schema = item.schema;
                            const table = item.rawLabel || item.label;
                            if (!schema || !table) {
                                throw new Error('The selected object has no resolved schema or name.');
                            }
                            await synchronizer.refreshObject(connectionName, {
                                database,
                                schema,
                                table,
                            });
                        },
                    );
                } catch (error: unknown) {
                    const message = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`Failed to refresh metadata: ${message}`);
                }
            },
        ),
    ];
}
