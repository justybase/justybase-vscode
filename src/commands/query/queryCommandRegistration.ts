/**
 * Query Commands - command registration and execution flows
 */

import * as vscode from 'vscode';
import type { DatabaseKind } from '../../contracts/database';
import {
    runQueryRaw,
    runQueriesSequentially,
    cancelQueryByUri
} from '../../core/queryRunner';
import { DuckDbResultBridge } from '../../services/duckdbResultBridge';
import { SqlParser } from '../../sql/sqlParser';
import { formatSql } from '../../services/sqlFormatter';
import { buildExecCommand } from '../../utils/shellUtils';
import { createPerformanceTimer, formatPerformanceEvent } from '../../services/perf/performanceEvents';
import type { ViewTableDataCommandArgs } from '../../providers/sqlDataAffordanceResolver';
import { QueryCommandsDependencies } from './queryCommandTypes';
import { formatQualifiedObjectName, formatQualifiedObjectPathForDisplay } from '../../utils/identifierUtils';
import {
    confirmSafeExecute,
    detectPythonScript,
    handleExecutionCompletion
} from './queryCommandSafety';
import {
    executeExplainQuery,
    executeTuningAdvisor,
    toPerfErrorCode
} from './queryCommandTuning';
import { getExtensionConfiguration } from '../../compatibility/configuration';
import { runSmartSequentialQuery } from './querySmartSequentialRun';
import { tryAcquireQueryExecution } from './queryExecutionGate';

const VIEW_DATA_ROW_LIMIT = 100;

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

function buildQualifiedObjectPath(
    databaseName: string | undefined,
    schemaName: string | undefined,
    tableName: string,
    kind?: string | DatabaseKind
): string {
    if (kind !== 'sqlite') {
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

    return [
        vscode.commands.registerCommand(
            'netezza.cancelQuery',
            async (sourceUri?: string | vscode.Uri, currentRowCounts?: number[]) => {
                const uriToCancel =
                    typeof sourceUri === 'string' ? sourceUri : sourceUri?.toString();

                if (uriToCancel) {
                    console.log(`[netezza.cancelQuery] Cancelling: ${uriToCancel}`);
                    // 1. Update UI immediately (optimistic)
                    resultPanelProvider.cancelExecution(uriToCancel, currentRowCounts);

                    // 2. Perform backend cancellation (async)
                    try {
                        await cancelQueryByUri(uriToCancel);
                    } catch (err) {
                        console.error('[netezza.cancelQuery] Backend cancel failed:', err);
                    }
                } else {
                    const executingUris = resultPanelProvider.getExecutingSources();
                    if (executingUris.length > 0) {
                        const uniqueExecutingUris = [...new Set(executingUris)];
                        for (const executingUri of uniqueExecutingUris) {
                            console.log(
                                `[netezza.cancelQuery] Cancelling running source: ${executingUri}`
                            );
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
                        resultPanelProvider.cancelExecution(activeUri, currentRowCounts);
                        await cancelQueryByUri(activeUri);
                    } else {
                        vscode.window.showWarningMessage('No active query to cancel.');
                    }
                }
            }
        ),
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

            resultPanelProvider.setActiveSource(sourceUri);
            resultPanelProvider.startExecution(sourceUri);
            const executionId = resultPanelProvider.logExecutionStart(sourceUri, query, connectionName);

            try {
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
                            logCallback: message => resultPanelProvider.log(sourceUri, message),
                            maxRows: VIEW_DATA_ROW_LIMIT,
                            isUserQuery: false
                        })
                );

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
                const message = err instanceof Error ? err.message : String(err);
                const status: 'error' | 'cancelled' = message.includes('Query cancelled') ? 'cancelled' : 'error';

                if (status === 'cancelled') {
                    resultPanelProvider.log(sourceUri, 'View Data request cancelled by user.');
                    resultPanelProvider.logExecutionEnd(executionId, 0, 'cancelled', message);
                    resultPanelProvider.finalizeExecution(sourceUri);
                    return;
                }

                resultPanelProvider.updateResults(
                    [
                        {
                            columns: [],
                            data: [],
                            message,
                            isError: true,
                            sql: query
                        }
                    ],
                    sourceUri,
                    true
                );
                resultPanelProvider.logExecutionEnd(executionId, 0, 'error', message);
                resultPanelProvider.finalizeExecution(sourceUri);
                vscode.window.showErrorMessage(`View Data failed: ${message}`);
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
          
            await bridge.streamToDuckDb(query, connectionManager, connName, targetTable, mode, documentUri);
          }),

        // Run Query Batch
        vscode.commands.registerCommand('netezza.runQueryBatch', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor found');
                return;
            }

            const document = editor.document;

            // Notebook cell execution is handled by the notebook controller.
            if (document.uri.scheme === 'vscode-notebook-cell') {
                return;
            }

            const selection = editor.selection;
            const sourceUri = document.uri.toString();
            const executionGate = tryAcquireQueryExecution(sourceUri, resultPanelProvider);
            if (!executionGate) {
                return;
            }

            let text = '';
            let runBatchTimer: ReturnType<typeof createPerformanceTimer> | undefined;
            let executionStarted = false;

            try {
                text = !selection.isEmpty
                    ? document.getText(selection)
                    : document.getText();

                if (!text.trim()) {
                    vscode.window.showWarningMessage('No SQL query to execute');
                    return;
                }

                // Check for Python script
                const scriptDetection = detectPythonScript(text.trim());
                if (scriptDetection.isPython && scriptDetection.script) {
                    const config = getExtensionConfiguration();
                    const pythonPath = config.get<string>('pythonPath') || 'python';

                    const python = scriptDetection.pythonPath || pythonPath;
                    const cmd = buildExecCommand(
                        python,
                        scriptDetection.script,
                        scriptDetection.args || []
                    );

                    const term = vscode.window.createTerminal({ name: 'JustyBase: Script' });
                    term.show(true);
                    term.sendText(cmd, true);
                    vscode.window.showInformationMessage(`Running script: ${cmd}`);
                    return;
                }

                const statementsForSafeExecute = SqlParser.splitStatements(text).filter(
                    q => q.trim().length > 0
                );
                if (
                    !(await confirmSafeExecute(
                        statementsForSafeExecute.length > 0 ? statementsForSafeExecute : [text]
                    ))
                ) {
                    return;
                }

                runBatchTimer = createPerformanceTimer('query.run_batch', {
                    payloadSize: text.length
                });

                resultPanelProvider.setActiveSource(sourceUri);
                resultPanelProvider.startExecution(sourceUri);
                executionStarted = true;
                resultPanelProvider.log(sourceUri, 'Preparing SQL batch execution...');

                // Per-query logging callbacks
                const queryStartCallback = (
                    _queryIndex: number,
                    sql: string,
                    connName: string
                ): string => {
                    return resultPanelProvider.logExecutionStart(
                        sourceUri,
                        sql.trim(),
                        connName
                    );
                };

                const queryEndCallback = (
                    executionId: string,
                    rowCount: number,
                    _durationMs: number,
                    status: 'success' | 'error' | 'cancelled' | 'retrying',
                    error?: string
                ) => {
                    resultPanelProvider.logExecutionEnd(
                        executionId,
                        rowCount,
                        status,
                        error
                    );
                };

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Window,
                        title: `Executing batch SQL for ${sourceUri.split(/[\\/]/).pop()}...`,
                        cancellable: false
                    },
                    async () => {
                        await runQueriesSequentially(
                            context,
                            [text],
                            connectionManager,
                            sourceUri,
                            msg => resultPanelProvider.log(sourceUri, msg),
                            queryResults =>
                                resultPanelProvider.updateResults(
                                    queryResults,
                                    sourceUri,
                                    true
                                ),
                            undefined, // extensionUri
                            false, // _isRetry
                            undefined, // maxRows
                            queryStartCallback,
                            queryEndCallback
                        );
                    }
                );

                resultPanelProvider.finalizeExecution(sourceUri);
                await handleExecutionCompletion(sourceUri);
                if (runBatchTimer) {
                    const successEvent = runBatchTimer.finish({
                        result: 'ok',
                        metadata: {
                            query_count: statementsForSafeExecute.length > 0 ? statementsForSafeExecute.length : 1
                        }
                    });
                    console.log(formatPerformanceEvent(successEvent));
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);

                // If it's a cancellation error, log info but don't show error dialog or error result
                if (msg.includes('Query cancelled')) {
                    if (executionStarted) {
                        resultPanelProvider.log(
                            sourceUri,
                            'Query execution cancelled by user.'
                        );
                        resultPanelProvider.finalizeExecution(sourceUri);
                    }
                    if (runBatchTimer) {
                        const cancelledEvent = runBatchTimer.finish({
                            result: 'cancelled',
                            errorCode: 'QUERY_CANCELLED'
                        });
                        console.log(formatPerformanceEvent(cancelledEvent));
                    }
                    return;
                }

                // Add error result BEFORE finalizing so it gets properly pinned
                if (executionStarted) {
                    resultPanelProvider.updateResults(
                        [
                            {
                                columns: [],
                                data: [],
                                message: msg,
                                isError: true,
                                sql: text
                            }
                        ],
                        sourceUri,
                        true
                    );

                    // Finalize AFTER adding error so the error pin is preserved
                    resultPanelProvider.finalizeExecution(sourceUri);
                }
                if (runBatchTimer) {
                    const errorEvent = runBatchTimer.finish({
                        result: 'error',
                        errorCode: toPerfErrorCode(msg)
                    });
                    console.log(formatPerformanceEvent(errorEvent));
                }
                vscode.window.showErrorMessage(`Error executing query: ${msg}`);
            } finally {
                executionGate.dispose();
            }
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
            await executeExplainQuery(context, connectionManager, false);
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
            await executeExplainQuery(context, connectionManager, true);
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
        vscode.commands.registerCommand('netezza.formatSQL', async () => {
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

            const selection = editor.selection;
            const text = selection.isEmpty
                ? editor.document.getText()
                : editor.document.getText(selection);

            try {
                const result = formatSql(text, {
                    tabWidth,
                    keywordCase,
                    linesBetweenQueries: 2
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
