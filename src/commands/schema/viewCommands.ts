/**
 * Schema Commands - Visualization Commands
 * Commands: showERD, openVisualQueryBuilder, openSecurityPanel, showSessionMonitor
 */

import * as vscode from 'vscode';
import { runQueryRaw, queryResultToRows } from '../../core/queryRunner';
import { SchemaCommandsDependencies, SchemaItemData } from './types';
import { requireConnection, executeWithProgress } from './helpers';

/**
 * Register view/visualization commands
 */
export function registerViewCommands(deps: SchemaCommandsDependencies): vscode.Disposable[] {
    const { context, connectionManager, metadataCache } = deps;

    return [
        // Show ERD
        vscode.commands.registerCommand('netezza.showERD', async (item: SchemaItemData) => {
            try {
                if (!item || !item.contextValue || !item.contextValue.startsWith('typeGroup:')) {
                    vscode.window.showErrorMessage('Please right-click on a TABLE type group to show ERD');
                    return;
                }

                const database = item.dbName;
                const connectionName = item.connectionName;

                if (!connectionName) {
                    vscode.window.showErrorMessage('No connection selected');
                    return;
                }

                const schemaQuery = `SELECT DISTINCT SCHEMA FROM ${database}.._V_TABLE ORDER BY SCHEMA`;
                const schemaResult = await runQueryRaw(context, schemaQuery, true, connectionManager, connectionName, undefined, undefined, undefined, 1000000, false);

                if (!schemaResult || !schemaResult.data) {
                    vscode.window.showErrorMessage('Could not retrieve schemas');
                    return;
                }

                const schemas = queryResultToRows<{ SCHEMA: string }>(schemaResult);
                if (schemas.length === 0) {
                    vscode.window.showWarningMessage('No tables found in this database');
                    return;
                }

                let selectedSchema: string;
                if (schemas.length === 1) {
                    selectedSchema = schemas[0].SCHEMA;
                } else {
                    const schemaOptions: vscode.QuickPickItem[] = schemas.map((s: { SCHEMA: string }) => ({
                        label: s.SCHEMA as string,
                        description: `${database}.${s.SCHEMA}`
                    }));

                    const selected = await vscode.window.showQuickPick(schemaOptions, {
                        placeHolder: 'Select schema to show ERD for'
                    });

                    if (!selected) return;
                    selectedSchema = selected.label;
                }

                let tableCount = 0;
                let relCount = 0;
                await executeWithProgress(
                    `Building ERD for ${database}.${selectedSchema}...`,
                    async (progress) => {
                        const { buildERDData } = await import('../../schema/erdProvider');
                        const { ERDView } = await import('../../views/erdView');

                        const erdData = await buildERDData(
                            context,
                            connectionManager,
                            connectionName,
                            database!,
                            selectedSchema,
                            progress
                        );

                        tableCount = erdData.tables.length;
                        relCount = erdData.relationships.length;

                        ERDView.createOrShow(context.extensionUri, erdData);
                    }
                );

                vscode.window.showInformationMessage(`ERD generated: ${tableCount} tables, ${relCount} relationships`);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Error generating ERD: ${message}`);
            }
        }),

        // Open Visual Query Builder
        vscode.commands.registerCommand('netezza.openVisualQueryBuilder', async (item: SchemaItemData) => {
            try {
                if (!item || item.contextValue !== 'typeGroup:TABLE') {
                    vscode.window.showErrorMessage('Please right-click on a TABLE type group to open Visual Query Builder');
                    return;
                }

                const database = item.dbName || item.label;
                const connectionName = item.connectionName;

                if (!database) {
                    vscode.window.showErrorMessage('No database selected');
                    return;
                }

                if (!connectionName) {
                    vscode.window.showErrorMessage('No connection selected');
                    return;
                }

                const { buildVisualQueryBuilderDataForAllSchemas } = await import('../../schema/queryBuilderProvider');
                
                let tableCount = 0;
                let relCount = 0;
                let availableSchemas: string[] = [];
                
                await executeWithProgress(
                    `Loading Visual Query Builder for ${database}...`,
                    async () => {
                        const data = await buildVisualQueryBuilderDataForAllSchemas(
                            context,
                            connectionManager,
                            connectionName,
                            database.toUpperCase()
                        );
                        tableCount = data.tables.length;
                        relCount = data.relationships.length;
                        availableSchemas = data.allSchemas || [];

                        if (availableSchemas.length === 0) {
                            vscode.window.showWarningMessage('No tables found in this database');
                            return;
                        }

                        const { VisualQueryBuilderView } = await import('../../views/visualQueryBuilderView');
                        VisualQueryBuilderView.createOrShow(
                            context.extensionUri,
                            context,
                            connectionManager,
                            connectionName,
                            availableSchemas,
                            data
                        );
                    }
                );

                vscode.window.showInformationMessage(
                    `Visual Query Builder ready: ${tableCount} tables, ${relCount} relationships from ${availableSchemas.length} schema(s)`
                );
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Error opening Visual Query Builder: ${message}`);
            }
        }),

        // Show Session Monitor
        vscode.commands.registerCommand('netezza.openSecurityPanel', async () => {
            try {
                if (!await requireConnection(connectionManager)) {
                    vscode.window.showErrorMessage('Please connect to a database first.');
                    return;
                }

                const { SecurityPanelView } = await import('../../views/securityPanelView');
                SecurityPanelView.createOrShow(context.extensionUri, context, connectionManager);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Error opening Security Panel: ${message}`);
            }
        }),

        // Show Session Monitor
        vscode.commands.registerCommand('netezza.showSessionMonitor', async () => {
            try {
                if (!await requireConnection(connectionManager)) {
                    vscode.window.showErrorMessage('Please connect to a database first.');
                    return;
                }

                if (!connectionManager.supportsCapability('supportsSessionMonitor')) {
                    vscode.window.showErrorMessage('Session monitor is not supported for the active database dialect.');
                    return;
                }

                const { SessionMonitorView } = await import('../../views/sessionMonitorView');
                SessionMonitorView.createOrShow(context.extensionUri, context, connectionManager);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Error opening Session Monitor: ${message}`);
            }
        }),

        // Open Test Data Generator
        vscode.commands.registerCommand('netezza.openTestDataGenerator', async (item: SchemaItemData) => {
            try {
                if (!item || !item.objType || item.objType !== 'TABLE' || !item.label) {
                    vscode.window.showErrorMessage('Please right-click on a table to generate test data');
                    return;
                }

                const connectionName = item.connectionName;
                if (!connectionName) {
                    vscode.window.showErrorMessage('No connection selected');
                    return;
                }

                const database = item.dbName;
                const schema = item.schema;
                const table = item.label;

                if (!database || !schema || !table) {
                    vscode.window.showErrorMessage('Unable to determine table information');
                    return;
                }

                const { TestDataGeneratorView } = await import('../../views/testDataGeneratorView');
                await TestDataGeneratorView.createOrShow(
                    context.extensionUri,
                    connectionManager,
                    metadataCache,
                    connectionName,
                    database,
                    schema,
                    table
                );
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Error opening Test Data Generator: ${message}`);
            }
        })
    ];
}
