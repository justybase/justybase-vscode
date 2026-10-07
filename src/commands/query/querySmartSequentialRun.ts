import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import {
    runQueriesSequentially,
    runQueriesWithStreaming,
    StreamingChunk,
    BatchQueryRunOptions,
} from '../../core/queryRunner';
import { SqlParser } from '../../sql/sqlParser';
import { createPerformanceTimer, formatPerformanceEvent } from '../../services/perf/performanceEvents';
import { QueryCommandsDependencies } from './queryCommandTypes';
import {
    confirmSafeExecute,
    createExpandedQuerySafetyChecker,
    handleExecutionCompletion,
} from './queryCommandSafety';
import { toPerfErrorCode } from './queryCommandTuning';
import { getExtensionConfiguration } from '../../compatibility/configuration';
import {
    getQueryExecutionCoordinator,
    QueryExecutionLease,
    QueryQueueOutcome,
} from './queryExecutionGate';
import { streamingManager } from '../../core/queryCancellation';
import { isConnectionBrokenError } from '../../core/queryRunnerUtils';
import { isCancellationError } from '../../core/cancellation';
import { executionTargetFingerprint, prepareQueuedQuery } from './queryQueuePreparation';
import { createQueryExecutionRecovery } from './queryExecutionRecovery';
import {
    formatAccessFailureMessage,
    presentAccessError,
} from '../../utils/accessErrorHandling';
import type { DatabaseErrorDetails } from '@justybase/contracts';
import { extractDatabaseErrorDetails } from '@justybase/database-runtime';

export interface SmartSequentialRunOptions {
    continueOnError?: boolean;
    wholeDocument?: boolean;
}

function resolveSmartSequentialQueries(
    editor: vscode.TextEditor,
    wholeDocument = false,
): { queries: string[]; sourceUri: string } | null {
    const document = editor.document;

    if (document.uri.scheme === 'vscode-notebook-cell') {
        return null;
    }

    const selection = editor.selection;
    const text = document.getText();
    const sourceUri = document.uri.toString();
    let queries: string[];

    if (wholeDocument) {
        const sql = selection.isEmpty ? text : document.getText(selection);
        if (!sql.trim()) {
            vscode.window.showWarningMessage('No SQL query to execute');
            return null;
        }
        queries = SqlParser.splitStatements(sql).filter(q => q.trim().length > 0);
        if (!queries.length) queries = [sql];
    } else if (!selection.isEmpty) {
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

function buildQueryErrorResult(
    sql: string | undefined,
    message: string,
    databaseKind?: string,
    errorDetails?: DatabaseErrorDetails,
) {
    const userMessage = formatAccessFailureMessage(message, { databaseKind, sql }) ?? message;
    return {
        columns: [],
        data: [],
        message: userMessage,
        isError: true,
        sql,
        ...(errorDetails === undefined ? {} : { errorDetails }),
    };
}

export async function runSmartSequentialQuery(
    deps: QueryCommandsDependencies,
    options: SmartSequentialRunOptions = {},
): Promise<void> {
    options = Object.freeze({ ...options });
    const { context, connectionManager } = deps;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor found');
        return;
    }

    const sourceUri = editor.document.uri.toString();
    const connectionName = connectionManager.getConnectionForExecution(sourceUri)
        || connectionManager.getActiveConnectionName();
    const databaseKind = connectionName
        ? connectionManager.getConnectionDatabaseKind(connectionName)
        : undefined;

    const resolved = resolveSmartSequentialQueries(editor, options.wholeDocument);
    if (!resolved) return;
    const queries = resolved.queries;
    const sourceRange = new vscode.Range(editor.selection.start, editor.selection.end);
    const keepConnectionOpen = connectionManager.getDocumentKeepConnectionOpen?.(sourceUri) ?? true;
    const independentConnection = !keepConnectionOpen;
    const executionUri = independentConnection ? `${sourceUri}#query-${randomUUID()}` : sourceUri;
    const recovery = createQueryExecutionRecovery(connectionManager, executionUri, connectionName ?? undefined);
    if (independentConnection) {
        recovery.allowForcedRecovery = false;
        recovery.resetConnection = async () => false;
        recovery.openFreshConnection = async () => false;
        recovery.forcedRecoveryUnavailableMessage = 'This request owns a transient session. Cancel it and wait for its cleanup; other independent requests remain isolated.';
    }
    const databaseOverride = connectionManager.getDocumentDatabase(sourceUri);
    const profile = connectionName ? connectionManager.getConnection(connectionName).then(executionTargetFingerprint) : Promise.resolve(undefined);
    const coordinator = getQueryExecutionCoordinator();
    // Snapshot overlap synchronously before enqueue: preserve prior result tabs
    // only when the new SQL starts while previous results are not fully
    // completed (running or still queued/preparing). A fresh run after idle
    // must clear unpinned tabs instead of pinning them. The queue serializes
    // work, so by the time this job's run() starts the predecessor has already
    // finalized — checking at run() time would always see idle.
    const preserveExistingResults = coordinator.hasPendingWork(sourceUri);
    deps.resultPanelProvider.registerExecutionSource?.(sourceUri, executionUri);
    await coordinator.enqueue({ sourceUri, sql: queries.join(';\n\n'), connectionName: connectionName ?? undefined,
        database: databaseOverride, sourceRange, executionUri }, {
        document: editor.document,
        origin: options.wholeDocument ? 'Run Query Batch' : options.continueOnError ? 'Run Query Continue on Error' : 'Run Query',
        recovery, independentConnection,
    }, async signal => {
        try {
            if (!(await confirmSafeExecute(queries))) return undefined;
            if (signal.aborted) throw new Error('Query preparation cancelled');
            const prepared = await prepareQueuedQuery(queries, context, sourceUri, connectionManager,
                connectionName ?? undefined, databaseOverride, await profile, signal);
            return lease => executePreparedQuery(deps, options, executionUri, databaseKind, queries, lease, { ...prepared, sourceDocumentUri: sourceUri, keepConnectionOpenOverride: keepConnectionOpen }, preserveExistingResults);
        } catch (error: unknown) {
            if (signal.aborted) throw error;
            void vscode.window.showErrorMessage(`Could not prepare queued query: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    });
}

async function executePreparedQuery(
    deps: QueryCommandsDependencies,
    options: SmartSequentialRunOptions,
    executionUri: string,
    databaseKind: string | undefined,
    queries: string[],
    executionGate: QueryExecutionLease,
    prepared: BatchQueryRunOptions,
    preserveExistingResults = false,
): Promise<QueryQueueOutcome> {
    const { context, connectionManager, resultPanelProvider } = deps;
    const documentUri = prepared.sourceDocumentUri ?? executionGate.documentUri ?? executionUri;
    const queriesForError = queries;
    let hadFailure = false;
    let hadCancellation = false;
    let runQueryTimer: ReturnType<typeof createPerformanceTimer> | undefined;
    let executionStarted = false;

    try {
        streamingManager.clearAborted(executionUri);
        const continueOnError = options.continueOnError === true;
        runQueryTimer = createPerformanceTimer(
            options.wholeDocument ? 'query.run_batch' : continueOnError ? 'query.run_continue_on_error' : 'query.run',
            {
                payloadSize: queries.reduce((sum, q) => sum + q.length, 0),
            },
        );

        resultPanelProvider.beginWorkspaceExecution?.(documentUri, executionUri, preserveExistingResults);
        resultPanelProvider.setActiveSource(documentUri);
        // Preserve prior tabs only when this SQL was enqueued while previous
        // results were still incomplete (see enqueue-time snapshot above).
        // A fresh run after idle clears unpinned tabs instead of pinning them.
        resultPanelProvider.startExecution(executionUri, preserveExistingResults ? { preserveExistingResults: true } : undefined);
        executionStarted = true;
        resultPanelProvider.log(executionUri, 'Preparing SQL execution...');

        const config = getExtensionConfiguration();
        const enableStreaming = !options.wholeDocument && (config.get<boolean>('enableStreaming', true) ?? true);
        const streamingChunkSize = config.get<number>('streamingChunkSize', 5000) ?? 5000;

        const queryStartCallback = (
            _queryIndex: number,
            sql: string,
            connName: string,
        ): string => {
            if (!executionGate?.isCurrent()) {
                return `stale-${executionGate?.executionId ?? 'query'}`;
            }
            return resultPanelProvider.logExecutionStart(executionUri, sql.trim(), connName);
        };

        const queryEndCallback = (
            executionId: string,
            rowCount: number,
            _durationMs: number,
            status: 'success' | 'error' | 'cancelled' | 'retrying',
            error?: string,
        ) => {
            if (!executionGate?.isCurrent()) {
                return;
            }
            if (status === 'error') {
                hadFailure = true;
                if (error) executionGate.recordError(error);
            }
            if (status === 'cancelled') hadCancellation = true;
            resultPanelProvider.logExecutionEnd(executionId, rowCount, status, error);
        };

        const confirmExpandedQuery = createExpandedQuerySafetyChecker(queries);

        const batchOptions: BatchQueryRunOptions = {
            ...prepared,
            macroFileContext: {
                ...prepared.macroFileContext,
                onExecutableMacro: kind => {
                    if (kind === 'python' || kind === 'export') executionGate.disableForcedRecovery(
                        'This request has external macro side effects. Cancel it and wait for completion before continuing.');
                },
            },
            cancellationPrepared: true,
            onSessionIsolated: () => executionGate.markSessionIsolated(),
            onExecutionSettled: summary => {
                if (summary.status === 'cancelled' || summary.error?.kind === 'timeout' || (summary.error && isConnectionBrokenError(summary.error.cause)) || summary.cleanupErrors?.length) {
                    executionGate.requireSessionIsolation();
                }
            },
            retryOnBrokenConnection: !options.wholeDocument,
            isExecutionCurrent: () => executionGate?.isCurrent() === true,
            confirmSafeExecute: confirmExpandedQuery,
            onStatementSucceeded: event => deps.tableDdlSynchronizer?.handleStatementSucceeded(event) ?? Promise.resolve(),
            onStatementFailed: event => {
                if (isCancellationError(event.errorMessage)) hadCancellation = true;
                else hadFailure = true;
                deps.tableDdlSynchronizer?.handleExecutionFailure(event.connectionName, event.documentUri);
            },
            ...(continueOnError
            ? {
                continueOnError: true,
                onQueryError: (queryIndex, sql, errorMessage, errorDetails) => {
                    void presentAccessError(errorMessage, {
                        databaseKind,
                        sql: queries[queryIndex] ?? sql,
                        operation: 'SQL execution',
                    });
                    resultPanelProvider.updateResults(
                        [buildQueryErrorResult(queries[queryIndex] ?? sql, errorMessage, databaseKind, errorDetails)],
                        executionUri,
                        true,
                    );
                },
            }
            : {}),
        };

        const progressTitle = continueOnError
            ? `Executing SQL (continue on error) for ${documentUri.split(/[\\/]/).pop()}...`
            : `Executing SQL for ${documentUri.split(/[\\/]/).pop()}...`;

        executionGate.markRunning();
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: progressTitle,
                cancellable: false,
            },
            async progress => {
                const cancelListener = resultPanelProvider.onDidCancel(cancelledUri => {
                    if (cancelledUri === executionUri) {
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
                            executionUri,
                            msg => {
                                if (executionGate?.isCurrent()) {
                                    resultPanelProvider.log(executionUri, msg);
                                }
                            },
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
                                if (executionGate?.isCurrent()) {
                                    resultPanelProvider.appendStreamingChunk(
                                        executionUri,
                                        queryIndex,
                                        chunk,
                                        fullSql,
                                        sql,
                                    );
                                }
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
                            executionUri,
                            msg => {
                                if (executionGate?.isCurrent()) {
                                    resultPanelProvider.log(executionUri, msg);
                                }
                            },
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
                                if (executionGate?.isCurrent()) {
                                    resultPanelProvider.updateResults(queryResults, executionUri, true);
                                }
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

        const executionStillCurrent = executionGate.isCurrent();
        if (!executionStillCurrent) {
            return 'cancelled';
        }
        resultPanelProvider.finalizeExecution(executionUri);
        void handleExecutionCompletion(documentUri);
        if (runQueryTimer) {
            const successEvent = runQueryTimer.finish({
                result: 'ok',
                metadata: {
                    query_count: queries.length,
                    streaming_enabled: enableStreaming,
                    continue_on_error: continueOnError,
                },
            });
            console.log(formatPerformanceEvent(successEvent));
        }
        return hadCancellation ? 'cancelled' : hadFailure ? 'failed' : 'completed';
    } catch (err: unknown) {
        const executionStillCurrent = executionGate?.isCurrent() ?? true;
        if (!executionStillCurrent) {
            return 'cancelled';
        }
        const msg = err instanceof Error ? err.message : String(err);
        executionGate.recordError(msg);
        if (isConnectionBrokenError(err)) executionGate.requireSessionIsolation();

        if (isCancellationError(err)) {
            executionGate.requireSessionIsolation();
            if (executionStarted) {
                resultPanelProvider.log(executionUri, 'Query execution cancelled by user.');
                resultPanelProvider.finalizeExecution(executionUri);
            }
            if (runQueryTimer) {
                const cancelledEvent = runQueryTimer.finish({
                    result: 'cancelled',
                    errorCode: 'QUERY_CANCELLED',
                    metadata: {
                        query_count: queriesForError.length,
                        continue_on_error: options.continueOnError === true,
                    },
                });
                console.log(formatPerformanceEvent(cancelledEvent));
            }
            return 'cancelled';
        }

        if (executionStarted) {
            resultPanelProvider.updateResults(
                [buildQueryErrorResult(
                    queriesForError.length === 1 ? queriesForError[0] : undefined,
                    msg,
                    databaseKind,
                    extractDatabaseErrorDetails(err),
                )],
                executionUri,
                true,
            );
            resultPanelProvider.finalizeExecution(executionUri);
        }
        if (runQueryTimer) {
            const errorEvent = runQueryTimer.finish({
                result: 'error',
                errorCode: toPerfErrorCode(msg),
                metadata: {
                    query_count: queriesForError.length,
                    continue_on_error: options.continueOnError === true,
                },
            });
            console.log(formatPerformanceEvent(errorEvent));
        }
        if (!(await presentAccessError(msg, {
            databaseKind,
            sql: queriesForError.length === 1 ? queriesForError[0] : undefined,
            operation: 'SQL execution',
        }))) {
            vscode.window.showErrorMessage(`Error executing query: ${msg}`);
        }
        return 'failed';
    } finally {
        if (prepared.keepConnectionOpenOverride === false) {
            streamingManager.clearAborted(executionUri);
            if (executionStarted && !executionGate.isCurrent()) resultPanelProvider.finalizeExecution(executionUri);
        }
    }
}
