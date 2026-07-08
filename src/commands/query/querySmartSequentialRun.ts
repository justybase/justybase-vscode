import * as vscode from 'vscode';
import {
    runQueriesSequentially,
    runQueriesWithStreaming,
    StreamingChunk,
    BatchQueryRunOptions,
} from '../../core/queryRunner';
import { SqlParser } from '../../sql/sqlParser';
import { buildExecCommand } from '../../utils/shellUtils';
import { createPerformanceTimer, formatPerformanceEvent } from '../../services/perf/performanceEvents';
import { QueryCommandsDependencies } from './queryCommandTypes';
import { confirmSafeExecute, detectPythonScript, handleExecutionCompletion } from './queryCommandSafety';
import { toPerfErrorCode } from './queryCommandTuning';
import { getExtensionConfiguration } from '../../compatibility/configuration';

export interface SmartSequentialRunOptions {
    continueOnError?: boolean;
}

function resolveSmartSequentialQueries(
    editor: vscode.TextEditor,
): { queries: string[]; sourceUri: string } | null {
    const document = editor.document;

    if (document.uri.scheme === 'vscode-notebook-cell') {
        return null;
    }

    const selection = editor.selection;
    const text = document.getText();
    const sourceUri = document.uri.toString();
    let queries: string[];

    if (!selection.isEmpty) {
        const selectedText = document.getText(selection);
        if (!selectedText.trim()) {
            vscode.window.showWarningMessage('No SQL query selected');
            return null;
        }
        if (/^\s*CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\b/i.test(selectedText)) {
            queries = [selectedText];
        } else {
            queries = SqlParser.splitStatements(selectedText).filter(q => q.trim().length > 0);
        }
    } else {
        const offset = document.offsetAt(selection.active);
        const statement = SqlParser.getStatementAtPosition(text, offset);

        if (statement) {
            queries = [statement.sql];
            const startPos = document.positionAt(statement.start);
            const endPos = document.positionAt(statement.end);
            editor.selection = new vscode.Selection(startPos, endPos);
        } else {
            vscode.window.showWarningMessage('No SQL statement found at cursor');
            return null;
        }
    }

    if (queries.length === 0) {
        return null;
    }

    return { queries, sourceUri };
}

function buildQueryErrorResult(sql: string | undefined, message: string) {
    return {
        columns: [],
        data: [],
        message,
        isError: true,
        sql,
    };
}

export async function runSmartSequentialQuery(
    deps: QueryCommandsDependencies,
    options: SmartSequentialRunOptions = {},
): Promise<void> {
    const { context, connectionManager, resultPanelProvider } = deps;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor found');
        return;
    }

    const resolved = resolveSmartSequentialQueries(editor);
    if (!resolved) {
        return;
    }

    const { queries, sourceUri } = resolved;
    const continueOnError = options.continueOnError === true;

    const single = queries.length === 1 ? queries[0].trim() : null;
    if (single) {
        const scriptDetection = detectPythonScript(single);
        if (scriptDetection.isPython && scriptDetection.script) {
            const config = getExtensionConfiguration();
            const pythonPath = config.get<string>('pythonPath') || 'python';
            const python = scriptDetection.pythonPath || pythonPath;
            const cmd = buildExecCommand(
                python,
                scriptDetection.script,
                scriptDetection.args || [],
            );

            const term = vscode.window.createTerminal({ name: 'JustyBase: Script' });
            term.show(true);
            term.sendText(cmd, true);
            vscode.window.showInformationMessage(`Running script: ${cmd}`);
            return;
        }
    }

    if (!(await confirmSafeExecute(queries))) {
        return;
    }

    const runQueryTimer = createPerformanceTimer(
        continueOnError ? 'query.run_continue_on_error' : 'query.run',
        {
            payloadSize: queries.reduce((sum, q) => sum + q.length, 0),
        },
    );

    try {
        resultPanelProvider.setActiveSource(sourceUri);
        resultPanelProvider.startExecution(sourceUri);

        const config = getExtensionConfiguration();
        const enableStreaming = config.get<boolean>('enableStreaming', true) ?? true;
        const streamingChunkSize = config.get<number>('streamingChunkSize', 5000) ?? 5000;

        const queryStartCallback = (
            _queryIndex: number,
            sql: string,
            connName: string,
        ): string => {
            return resultPanelProvider.logExecutionStart(sourceUri, sql.trim(), connName);
        };

        const queryEndCallback = (
            executionId: string,
            rowCount: number,
            _durationMs: number,
            status: 'success' | 'error' | 'cancelled' | 'retrying',
            error?: string,
        ) => {
            resultPanelProvider.logExecutionEnd(executionId, rowCount, status, error);
        };

        const batchOptions: BatchQueryRunOptions = continueOnError
            ? {
                continueOnError: true,
                onQueryError: (queryIndex, sql, errorMessage) => {
                    resultPanelProvider.updateResults(
                        [buildQueryErrorResult(queries[queryIndex] ?? sql, errorMessage)],
                        sourceUri,
                        true,
                    );
                },
            }
            : {};

        const progressTitle = continueOnError
            ? `Executing SQL (continue on error) for ${sourceUri.split(/[\\/]/).pop()}...`
            : `Executing SQL for ${sourceUri.split(/[\\/]/).pop()}...`;

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: progressTitle,
                cancellable: false,
            },
            async progress => {
                const cancelListener = resultPanelProvider.onDidCancel(cancelledUri => {
                    if (cancelledUri === sourceUri) {
                        progress.report({ message: 'Cancelling query...' });
                    }
                });

                try {
                    if (enableStreaming) {
                        const allQueriesText = queries.join(';\n\n');
                        await runQueriesWithStreaming(
                            context,
                            queries,
                            connectionManager,
                            sourceUri,
                            msg => resultPanelProvider.log(sourceUri, msg),
                            (queryIndex: number, chunk: StreamingChunk, sql: string) => {
                                const currentQuery = queries[queryIndex];
                                const queryStartIndex = allQueriesText.indexOf(currentQuery);
                                const fullSql =
                                    queryStartIndex >= 0
                                        ? allQueriesText.substring(
                                            0,
                                            queryStartIndex + currentQuery.length,
                                        )
                                        : sql;
                                resultPanelProvider.appendStreamingChunk(
                                    sourceUri,
                                    queryIndex,
                                    chunk,
                                    fullSql,
                                );
                            },
                            streamingChunkSize,
                            undefined,
                            false,
                            undefined,
                            queryStartCallback,
                            queryEndCallback,
                            undefined,
                            0,
                            undefined,
                            batchOptions,
                        );
                    } else {
                        await runQueriesSequentially(
                            context,
                            queries,
                            connectionManager,
                            sourceUri,
                            msg => resultPanelProvider.log(sourceUri, msg),
                            queryResults => {
                                for (const qr of queryResults) {
                                    if (qr.sql && qr.sql.trim()) {
                                        const trimmedQrSql = qr.sql.trim();
                                        for (let i = 0; i < queries.length; i++) {
                                            if (queries[i].trim() === trimmedQrSql) {
                                                qr.sql = queries[i];
                                                break;
                                            }
                                        }
                                    }
                                }
                                resultPanelProvider.updateResults(queryResults, sourceUri, true);
                            },
                            undefined,
                            false,
                            undefined,
                            queryStartCallback,
                            queryEndCallback,
                            undefined,
                            0,
                            undefined,
                            [],
                            batchOptions,
                        );
                    }
                } finally {
                    cancelListener.dispose();
                }
            },
        );

        resultPanelProvider.finalizeExecution(sourceUri);
        await handleExecutionCompletion(sourceUri);
        const successEvent = runQueryTimer.finish({
            result: 'ok',
            metadata: {
                query_count: queries.length,
                streaming_enabled: enableStreaming,
                continue_on_error: continueOnError,
            },
        });
        console.log(formatPerformanceEvent(successEvent));
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);

        if (msg.includes('Query cancelled')) {
            resultPanelProvider.log(sourceUri, 'Query execution cancelled by user.');
            resultPanelProvider.finalizeExecution(sourceUri);
            const cancelledEvent = runQueryTimer.finish({
                result: 'cancelled',
                errorCode: 'QUERY_CANCELLED',
                metadata: {
                    query_count: queries.length,
                    continue_on_error: continueOnError,
                },
            });
            console.log(formatPerformanceEvent(cancelledEvent));
            return;
        }

        resultPanelProvider.updateResults(
            [buildQueryErrorResult(queries.length === 1 ? queries[0] : undefined, msg)],
            sourceUri,
            true,
        );

        resultPanelProvider.finalizeExecution(sourceUri);
        const errorEvent = runQueryTimer.finish({
            result: 'error',
            errorCode: toPerfErrorCode(msg),
            metadata: {
                query_count: queries.length,
                continue_on_error: continueOnError,
            },
        });
        console.log(formatPerformanceEvent(errorEvent));
        vscode.window.showErrorMessage(`Error executing query: ${msg}`);
    }
}
