/**
 * Query Commands - command registration and execution flows
 */

import * as vscode from 'vscode';
import { extractDatabaseErrorDetails } from '@justybase/database-runtime';
import type { DatabaseKind } from '../../contracts/database';
import {
    runQueryRaw,
    cancelQueryByUri
} from '../../core/queryRunner';
import { DuckDbResultBridge } from '../../services/duckdbResultBridge';
import { SqlParser } from '../../sql/sqlParser';
import { formatSql } from '../../services/sqlFormatting';
import type { ViewTableDataCommandArgs } from '../../providers/sqlDataAffordanceResolver';
import { QueryCommandsDependencies } from './queryCommandTypes';
import { formatQualifiedObjectName, formatQualifiedObjectPathForDisplay, quoteIdentifier } from '../../utils/identifierUtils';
import {
    executeExplainQuery,
    executeTuningAdvisor
} from './queryCommandTuning';
import { getExtensionConfiguration } from '../../compatibility/configuration';
import { runSmartSequentialQuery } from './querySmartSequentialRun';
import {
    markQueryExecutionCancelling, getQueryExecutionCoordinator,
    tryAcquireQueryExecution,
} from './queryExecutionGate';
import { createQueryExecutionRecovery } from './queryExecutionRecovery';
import { isSqlAuthoringLanguageId } from '../../utils/sqlLanguage';

const VIEW_DATA_ROW_LIMIT = 100;

function buildQualifiedObjectPath(
    databaseName: string | undefined,
    schemaName: string | undefined,
    tableName: string,
    kind?: string | DatabaseKind
): string {
    if (kind !== 'sqlite' && kind !== 'access') {
        if (databaseName && schemaName) {
            return `${quoteIdentifier(databaseName)}.${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
        }
        if (databaseName) {
            return `${quoteIdentifier(databaseName)}..${quoteIdentifier(tableName)}`;
        }
        if (schemaName) {
            return `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
        }
        return quoteIdentifier(tableName);
    }

    return formatQualifiedObjectName(databaseName, schemaName, tableName, kind);
}

function buildDisplayObjectPath(
    databaseName: string | undefined,
    schemaName: string | undefined,
    tableName: string,
    kind?: string | DatabaseKind
): string {
    return formatQualifiedObjectPathForDisplay(databaseName, schemaName, tableName, kind);
}

function ensureDialectCapability(
    connectionManager: QueryCommandsDependencies['connectionManager'],
    capability: 'supportsExplainPlan' | 'supportsTuningAdvisor',
    unsupportedMessage: string,
    documentUri?: string
): boolean {
    if (connectionManager.supportsCapability(capability, documentUri)) {
        return true;
    }
    vscode.window.showErrorMessage(unsupportedMessage);
    return false;
}

/**
 * Register all query execution commands
 */
export function registerQueryCommands(
    deps: QueryCommandsDependencies
): vscode.Disposable[] {
    const { context, connectionManager, resultPanelProvider } = deps;

    const cancelQueryForSource = async (
        sourceUri: string,
        currentRowCounts?: number[],
        commandId = 'netezza.cancelQuery',
    ): Promise<void> => {
        const lane = getQueryExecutionCoordinator().getSnapshot().find(item => item.sourceUri === sourceUri);
        const selected = resultPanelProvider.getSelectedExecutionSource?.(sourceUri);
        const running = lane?.runningExecutions ?? [];
        const target = running.find(job => job.executionUri === selected)?.executionUri
            ?? running[running.length - 1]?.executionUri ?? sourceUri;
        const targets = [target];
        for (const target of new Set(targets)) {
            console.log(`[${commandId}] Cancelling: ${target}`);
            markQueryExecutionCancelling(target);
            resultPanelProvider.cancelExecution(target, currentRowCounts);
            try { await cancelQueryByUri(target); }
            catch (err) { console.error(`[${commandId}] Backend cancel failed:`, err); }
        }
    };

    return [
        vscode.commands.registerCommand(
            'netezza.cancelQuery',
            async (sourceUri?: string | vscode.Uri, currentRowCounts?: number[]) => {
                const uriToCancel =
                    typeof sourceUri === 'string' ? sourceUri : sourceUri?.toString();

                if (uriToCancel) {
                    await cancelQueryForSource(uriToCancel, currentRowCounts);
                } else {
                    const executingUris = resultPanelProvider.getExecutingSources();
                    if (executingUris.length > 0) {
                        const uniqueExecutingUris = [...new Set(executingUris)];
                        for (const executingUri of uniqueExecutingUris) {
                            console.log(
                                `[netezza.cancelQuery] Cancelling running source: ${executingUri}`
                            );
                            markQueryExecutionCancelling(executingUri);
                            resultPanelProvider.cancelExecution(executingUri, currentRowCounts);
                            try {
                                await cancelQueryByUri(executingUri);
                            } catch (err) {
                                console.error(
                                    `[netezza.cancelQuery] Backend cancel failed for ${executingUri}:`,
                                    err
                                );
                            }
                        }
                        return;
                    }

                    let activeEditorUri: string | undefined;
                    const editor = vscode.window.activeTextEditor;
                    if (editor) {
                        activeEditorUri = editor.document.uri.toString();
                    }

                    if (activeEditorUri) {
                        console.log(
                            `[netezza.cancelQuery] No explicit URI, cancelling active editor source: ${activeEditorUri}`
                        );
                        markQueryExecutionCancelling(activeEditorUri);
                        resultPanelProvider.cancelExecution(activeEditorUri, currentRowCounts);
                        await cancelQueryByUri(activeEditorUri);
                        return;
                    }

                    // If we don't have a specific URI, try to cancel the "active" execution in the provider
                    const activeUri = resultPanelProvider.getActiveSource();
                    if (activeUri) {
                        console.log(
                            `[netezza.cancelQuery] No URI provided, falling back to active source: ${activeUri}`
                        );
                        markQueryExecutionCancelling(activeUri);
                        resultPanelProvider.cancelExecution(activeUri, currentRowCounts);
                        await cancelQueryByUri(activeUri);
                    } else {
                        vscode.window.showWarningMessage('No active query to cancel.');
                    }
                }
            }
        ),
        vscode.commands.registerCommand('netezza.cancelActiveQuery', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isSqlAuthoringLanguageId(editor.document.languageId)) {
                vscode.window.showWarningMessage('Open a SQL editor with an active query to cancel it.');
                return;
            }

            const documentUri = editor.document.uri.toString();
            const lane = getQueryExecutionCoordinator().getSnapshot().find(item => item.sourceUri === documentUri);
            const activeResultSource = resultPanelProvider.getSelectedExecutionSource?.(documentUri) ?? resultPanelProvider.getActiveSource();
            const activeJobs = lane?.runningExecutions ?? [];
            const sourceUri = activeJobs.find(job => job.executionUri === activeResultSource)?.executionUri
                ?? activeJobs[activeJobs.length - 1]?.executionUri ?? documentUri;
            if (!resultPanelProvider.getExecutingSources().includes(sourceUri)) {
                vscode.window.showWarningMessage('No active query to cancel.');
                return;
            }

            await cancelQueryForSource(sourceUri, undefined, 'netezza.cancelActiveQuery');
        }),
        vscode.commands.registerCommand('netezza.action.viewTableData', async (args?: ViewTableDataCommandArgs) => {
            const tableName = args?.tableName?.trim();
            if (!tableName) {
                vscode.window.showErrorMessage('No table or view was provided for View Data.');
                return;
            }

            const activeEditorUri = vscode.window.activeTextEditor?.document.uri.toString();
            const sourceUri = args?.documentUri || activeEditorUri;
            if (!sourceUri) {
                vscode.window.showErrorMessage('No active SQL editor found for View Data.');
                return;
            }

            const connectionName =
                connectionManager.getConnectionForExecution(sourceUri)
                || connectionManager.getActiveConnectionName()
                || undefined;
            if (!connectionName) {
                vscode.window.showErrorMessage('No database connection. Please connect first.');
                return;
            }

            const databaseName = args?.databaseName || (await connectionManager.getEffectiveDatabase(sourceUri)) || undefined;
            if (!databaseName) {
                vscode.window.showErrorMessage('Unable to resolve the database for this table reference.');
                return;
            }

            const schemaName = args?.schemaName;
            const databaseKind = connectionManager.getConnectionDatabaseKind(connectionName);
            const resolvedObjectPath = buildQualifiedObjectPath(databaseName, schemaName, tableName, databaseKind);
            const displayObjectPath = buildDisplayObjectPath(databaseName, schemaName, tableName, databaseKind);
            const query = `SELECT * FROM ${resolvedObjectPath} LIMIT ${VIEW_DATA_ROW_LIMIT}`;
            const sourceDocument = vscode.workspace.textDocuments?.find(
                document => document.uri.toString() === sourceUri,
            );
            const executionGate = await tryAcquireQueryExecution(sourceUri, resultPanelProvider, {
                document: sourceDocument,
                origin: 'View Data',
                recovery: createQueryExecutionRecovery(connectionManager, sourceUri, connectionName),
            });
            if (!executionGate) {
                return;
            }

            resultPanelProvider.setActiveSource(sourceUri);
            resultPanelProvider.startExecution(sourceUri);
            const executionId = resultPanelProvider.logExecutionStart(sourceUri, query, connectionName);

            try {
                executionGate.markRunning();
                const result = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Viewing data for ${displayObjectPath}...`,
                        cancellable: false
                    },
                    async () =>
                        runQueryRaw({
                            context,
                            query,
                            silent: true,
                            connectionManager,
                            connectionName,
                            documentUri: sourceUri,
                            logCallback: message => {
                                if (executionGate.isCurrent()) {
                                    resultPanelProvider.log(sourceUri, message);
                                }
                            },
                            maxRows: VIEW_DATA_ROW_LIMIT,
                            isUserQuery: false,
                            isExecutionCurrent: () => executionGate.isCurrent(),
                        })
                );

                const executionStillCurrent = executionGate.isCurrent();
                executionGate.dispose();
                if (!executionStillCurrent) {
                    return;
                }
                resultPanelProvider.updateResults(
                    [
                        {
                            ...result,
                            sql: query,
                            name: `${tableName} (TOP ${VIEW_DATA_ROW_LIMIT})`,
                            executionTimestamp: Date.now()
                        }
                    ],
                    sourceUri,
                    true
                );
                resultPanelProvider.logExecutionEnd(executionId, result.data.length, 'success');
                resultPanelProvider.finalizeExecution(sourceUri);
                await vscode.commands.executeCommand('netezza.results.focus');
            } catch (err: unknown) {
                const executionStillCurrent = executionGate.isCurrent();
                executionGate.dispose();
                if (!executionStillCurrent) {
                    return;
                }
                const message = err instanceof Error ? err.message : String(err);
                const status: 'error' | 'cancelled' = message.includes('Query cancelled') ? 'cancelled' : 'error';

                if (status === 'cancelled') {
                    resultPanelProvider.log(sourceUri, 'View Data request cancelled by user.');
                    resultPanelProvider.logExecutionEnd(executionId, 0, 'cancelled', message);
                    resultPanelProvider.finalizeExecution(sourceUri);
                    return;
                }

                const errorDetails = extractDatabaseErrorDetails(err);
                resultPanelProvider.updateResults(
                    [
                        {
                            columns: [],
                            data: [],
                            message,
                            isError: true,
                            sql: query,
                            ...(errorDetails === undefined ? {} : { errorDetails }),
                        }
                    ],
                    sourceUri,
                    true
                );
                resultPanelProvider.logExecutionEnd(executionId, 0, 'error', message);
                resultPanelProvider.finalizeExecution(sourceUri);
                vscode.window.showErrorMessage(`View Data failed: ${message}`);
            } finally {
                executionGate.dispose();
            }
        }),
        // Run Query (Smart/Sequential Execution)
        vscode.commands.registerCommand('netezza.runQuery', async () => {
            await runSmartSequentialQuery(deps);
        }),

        // Run Query (Smart/Sequential, continue after statement errors)
        vscode.commands.registerCommand('netezza.runQueryContinueOnError', async () => {
            await runSmartSequentialQuery(deps, { continueOnError: true });
        }),

        // Execute & Load to DuckDB directly
        vscode.commands.registerCommand('netezza.executeAndLoadToDuckDb', async (_uriOrArgs?: vscode.Uri | unknown, passedSql?: string) => {
            const editor = vscode.window.activeTextEditor;
            const documentUri = editor?.document.uri.toString();
            let query = passedSql;

            if (!query && editor) {
                const document = editor.document;
                const selection = editor.selection;
                if (!selection.isEmpty) {
                    query = document.getText(selection);
                } else {
                    const offset = document.offsetAt(selection.active);
                    const statement = SqlParser.getStatementAtPosition(document.getText(), offset);
                    if (statement) {
                        query = statement.sql;
                    }
                }
            }

            if (!query) {
                vscode.window.showWarningMessage('No SQL query found to execute.');
                return;
            }

            const connName = connectionManager.getConnectionForExecution(documentUri) || connectionManager.getActiveConnectionName();
            if (!connName) {
                vscode.window.showErrorMessage('No active database connection found. Please connect first.');
                return;
            }

            const targetTable = await vscode.window.showInputBox({
                prompt: 'Enter DuckDB Target Table Name',
                value: 'results_export',
                validateInput: (value) => {
                    if (!value.match(/^[a-zA-Z0-9_]+$/)) {
                        return 'Table name must consist of letters, numbers, and underscores.';
                    }
                    return null;
                }
            });

            if (!targetTable) {
                return; // User cancelled
            }

            const modePick = await vscode.window.showQuickPick(['Overwrite', 'Append'], {
                placeHolder: 'Select Load Mode'
            });

            if (!modePick) {
                return; // User cancelled
            }

            const mode = modePick.toLowerCase() as 'overwrite' | 'append';
          
            // Create bridge with empty results map (streamToDuckDb doesn't use the results map)
            const bridge = new DuckDbResultBridge(new Map(), connectionManager);
            const duckDbRecovery = documentUri
                ? {
                    ...createQueryExecutionRecovery(connectionManager, documentUri, connName),
                    allowForcedRecovery: false,
                    forcedRecoveryUnavailableMessage:
                        'A local DuckDB load cannot be force-unlocked safely; cancel it or wait for it to finish.',
                }
                : undefined;
            const executionGate = documentUri
                ? await tryAcquireQueryExecution(documentUri, resultPanelProvider, {
                    document: editor?.document,
                    origin: 'Execute and Load to DuckDB',
                    recovery: duckDbRecovery,
                })
                : undefined;
            if (documentUri && !executionGate) {
                return;
            }

            try {
                executionGate?.markRunning();
                await bridge.streamToDuckDb(
                    query,
                    connectionManager,
                    connName,
                    targetTable,
                    mode,
                    documentUri,
                    () => executionGate?.isCurrent() !== false,
                );
            } finally {
                executionGate?.dispose();
            }
          }),

        // Run Query Batch
        vscode.commands.registerCommand('netezza.runQueryBatch', async () => {
            await runSmartSequentialQuery(deps, { wholeDocument: true });
        }),

        // Explain Query
        vscode.commands.registerCommand('netezza.explainQuery', async () => {
            const documentUri = vscode.window.activeTextEditor?.document.uri.toString();
            if (
                documentUri
                && !ensureDialectCapability(
                    connectionManager,
                    'supportsExplainPlan',
                    'Explain plan is not supported for the active database dialect.',
                    documentUri
                )
            ) {
                return;
            }
            await executeExplainQuery(context, connectionManager, resultPanelProvider, false);
        }),

        // Explain Query Verbose
        vscode.commands.registerCommand('netezza.explainQueryVerbose', async () => {
            const documentUri = vscode.window.activeTextEditor?.document.uri.toString();
            if (
                documentUri
                && !ensureDialectCapability(
                    connectionManager,
                    'supportsExplainPlan',
                    'Explain plan is not supported for the active database dialect.',
                    documentUri
                )
            ) {
                return;
            }
            await executeExplainQuery(context, connectionManager, resultPanelProvider, true);
        }),

        // Tuning Advisor
        vscode.commands.registerCommand('netezza.tuningAdvisor', async () => {
            const documentUri = vscode.window.activeTextEditor?.document.uri.toString();
            if (
                documentUri
                && !ensureDialectCapability(
                    connectionManager,
                    'supportsTuningAdvisor',
                    'Tuning Advisor is not supported for the active database dialect.',
                    documentUri
                )
            ) {
                return;
            }
            await executeTuningAdvisor(context, connectionManager, resultPanelProvider);
        }),

        // Format SQL
        vscode.commands.registerCommand('netezza.formatSQL', async (options?: { startOffset?: number; endOffset?: number }) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor');
                return;
            }

            if (
                editor.document.languageId !== 'sql' &&
                editor.document.languageId !== 'mssql'
            ) {
                vscode.window.showWarningMessage(
                    'Format SQL is only available for SQL files'
                );
                return;
            }

            const config = getExtensionConfiguration();
            const tabWidth = config.get<number>('formatSQL.tabWidth', 4);
            const keywordCase = config.get<'upper' | 'lower' | 'preserve'>(
                'formatSQL.keywordCase',
                'upper'
            );

            // Optional statement range (used by the Ctrl+. action hub).
            // Falls back to the previous selection-or-document behavior.
            const hasRange = typeof options?.startOffset === 'number'
                && typeof options?.endOffset === 'number'
                && (options.endOffset as number) > (options.startOffset as number);
            const range = hasRange
                ? new vscode.Range(
                    editor.document.positionAt(options.startOffset as number),
                    editor.document.positionAt(options.endOffset as number),
                )
                : undefined;
            const selection = range ?? editor.selection;
            const text = selection.isEmpty
                ? editor.document.getText()
                : editor.document.getText(selection);

            try {
                const documentUri = editor.document.uri?.toString();
                const databaseKind = documentUri
                    ? connectionManager.getExecutionDatabaseKind?.(documentUri)
                    : undefined;
                const result = formatSql(text, {
                    tabWidth,
                    keywordCase,
                    linesBetweenQueries: 2,
                    databaseKind
                });

                await editor.edit(editBuilder => {
                    if (selection.isEmpty) {
                        const fullRange = new vscode.Range(
                            editor.document.positionAt(0),
                            editor.document.positionAt(editor.document.getText().length)
                        );
                        editBuilder.replace(fullRange, result);
                    } else {
                        editBuilder.replace(selection, result);
                    }
                });

                vscode.window.showInformationMessage('SQL formatted successfully');
            } catch (err: unknown) {
                const errMsg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Format SQL failed: ${errMsg}`);
            }
        })
    ];
}
