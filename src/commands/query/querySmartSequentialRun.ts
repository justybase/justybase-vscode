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
import { recordJoinKnowledgeSuccessfulStatement } from '../../knowledge/joinKnowledgeRuntime';
import { describeQueryError, ensureQueryErrorMessage } from '../../core/errorPresentation';
import {
    clearRuntimeErrorDiagnostic,
    publishRuntimeErrorDiagnostic,
} from '../../providers/runtimeErrorDiagnostics';

/** A one-off execution on a saved profile without changing the tab's connection. */
export interface RunAsExecutionOptions {
    /** Saved connection profile that owns the transient run-as session. */
    connectionName: string;
}

export interface SmartSequentialRunOptions {
    continueOnError?: boolean;
    wholeDocument?: boolean;
    /** Explicit SQL that already reflects the caller's scope; skips editor resolution. */
    queries?: readonly string[];
    runAs?: RunAsExecutionOptions;
}

function resolveSmartSequentialQueries(
    editor: vscode.TextEditor,
    wholeDocument = false,
    databaseKind?: string,
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
        queries = SqlParser.splitStatements(sql, databaseKind).filter(q => q.trim().length > 0);
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
            queries = SqlParser.splitStatements(selectedText, databaseKind).filter(q => q.trim().length > 0);
        }
    } else {
        const offset = document.offsetAt(selection.active);
        const statement = SqlParser.getStatementAtPosition(text, offset, undefined, databaseKind);

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
        message: ensureQueryErrorMessage(userMessage),
        isError: true,
        sql,
        ...(errorDetails === undefined ? {} : { errorDetails }),
    };
}

export async function runSmartSequentialQuery(
    deps: QueryCommandsDependencies,
    options: SmartSequentialRunOptions = {},
): Promise<QueryQueueOutcome | undefined> {
    options = Object.freeze({ ...options });
    const { context, connectionManager } = deps;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor found');
        return undefined;
    }

    const runAs = options.runAs;
    const sourceUri = editor.document.uri.toString();
    const connectionName = runAs
        ? runAs.connectionName
        : connectionManager.getConnectionForExecution(sourceUri)
            || connectionManager.getActiveConnectionName();
    const databaseKind = connectionName
        ? connectionManager.getConnectionDatabaseKind(connectionName)
        : undefined;

    const resolved = options.queries
        ? { queries: [...options.queries], sourceUri }
        : resolveSmartSequentialQueries(editor, options.wholeDocument, databaseKind);
    if (!resolved) return undefined;
    const queries = resolved.queries;
    const sourceRange = new vscode.Range(editor.selection.start, editor.selection.end);
    // A run-as request owns a transient session on the selected profile; it
    // must never reuse or replace the tab's persistent connection.
    const keepConnectionOpen = runAs
        ? false
        : connectionManager.getDocumentKeepConnectionOpen?.(sourceUri) ?? true;
    const independentConnection = !keepConnectionOpen;
    const executionUri = independentConnection
        ? `${sourceUri}#${runAs ? 'run-as' : 'query'}-${randomUUID()}`
        : sourceUri;
    const recovery = createQueryExecutionRecovery(connectionManager, executionUri, connectionName ?? undefined);
    if (independentConnection) {
        recovery.allowForcedRecovery = false;
        recovery.resetConnection = async () => false;
        recovery.openFreshConnection = async () => false;
        recovery.forcedRecoveryUnavailableMessage = runAs
            ? 'Run As owns a transient session on the selected profile. Cancel it and wait for cleanup; this tab\'s session is untouched.'
            : 'This request owns a transient session. Cancel it and wait for its cleanup; other independent requests remain isolated.';
    }
    // The tab's database override belongs to its own connection; a run-as
    // request must keep the selected profile's default database.
    const databaseOverride = runAs ? undefined : connectionManager.getDocumentDatabase(sourceUri);
    const profile = connectionName ? connectionManager.getConnection(connectionName).then(executionTargetFingerprint) : Promise.resolve(undefined);
    const coordinator = getQueryExecutionCoordinator();
    // Snapshot overlap synchronously before enqueue: preserve prior result tabs
    // only when the new SQL starts while previous results are not fully
    // completed (running or still queued/preparing). A fresh run after idle
    // must clear unpinned tabs instead of pinning them. The queue serializes
    // work, so by the time this job's run() starts the predecessor has already
    // finalized — checking at run() time would always see idle.
    const preserveExistingResults = runAs !== undefined || coordinator.hasPendingWork(sourceUri);
    // A run-as request keeps its own transient session identity so the tab's
    // persistent connection, database override and metadata context are never touched.
    const executionContext = runAs ? executionUri : sourceUri;
    const logPrefix = runAs ? `[Run As: ${runAs.connectionName}] ` : '';
    deps.resultPanelProvider.registerExecutionSource?.(sourceUri, executionUri);
    if (runAs) {
        // Result refresh/filter must keep the run-as identity, never the tab's.
        deps.resultPanelProvider.markOneOffExecution?.(executionUri, runAs.connectionName);
    }
    return coordinator.enqueue({
        sourceUri,
        sql: queries.join(';\n\n'),
        connectionName: connectionName ?? undefined,
        database: databaseOverride, sourceRange, executionUri,
    }, {
        document: editor.document,
        origin: runAs
            ? 'Run As'
            : options.wholeDocument ? 'Run Query Batch' : options.continueOnError ? 'Run Query Continue on Error' : 'Run Query',
        recovery, independentConnection,
    }, async signal => {
        try {
            // Run As already confirmed risky SQL against the selected profile;
            // the standard safe-execute prompt must not ask a second time.
            if (!runAs && !(await confirmSafeExecute(queries))) return undefined;
            if (signal.aborted) throw new Error('Query preparation cancelled');
            const prepared = await prepareQueuedQuery(queries, context, sourceUri, connectionManager,
                connectionName ?? undefined, databaseOverride, await profile, signal, {
                    explicitConnection: runAs !== undefined,
                    // A Run As request targets the selected profile's dialect;
                    // the tab's document dialect must not shape macro expansion.
                    ...(runAs ? { databaseKind } : {}),
                });
            return lease => executePreparedQuery(deps, options, executionUri, databaseKind, queries, lease, {
                ...prepared,
                sourceDocumentUri: runAs ? executionContext : sourceUri,
                keepConnectionOpenOverride: keepConnectionOpen,
            }, preserveExistingResults, logPrefix, runAs ? sourceUri : undefined);
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
    logPrefix = '',
    editorUri?: string,
): Promise<QueryQueueOutcome> {
    const { context, connectionManager, resultPanelProvider } = deps;
    // Execution identity may be synthetic (Run As); the panel workspace must
    // still be the real editor document.
    const executionDocumentUri = prepared.sourceDocumentUri ?? executionGate.documentUri ?? executionUri;
    const documentUri = editorUri ?? executionDocumentUri;
    const runAs = options.runAs;
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
        clearRuntimeErrorDiagnostic(documentUri);
        if (runAs) {
            resultPanelProvider.log(
                executionUri,
                `${logPrefix}One-off session on "${runAs.connectionName}". This tab's connection, session and results are preserved.`,
            );
        }
        resultPanelProvider.log(executionUri, `${logPrefix}Preparing SQL execution...`);

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
            onStatementSucceeded: async event => {
                await deps.tableDdlSynchronizer?.handleStatementSucceeded(event);
                await recordJoinKnowledgeSuccessfulStatement(event, connectionManager);
            },
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
                    if (!runAs) {
                        publishRuntimeErrorDiagnostic(
                            documentUri,
                            queries[queryIndex] ?? sql,
                            errorMessage,
                            errorDetails,
                            databaseKind ?? '',
                            queryIndex,
                        );
                    }
                    resultPanelProvider.updateResults(
                        [buildQueryErrorResult(queries[queryIndex] ?? sql, errorMessage, databaseKind, errorDetails)],
                        executionUri,
                        true,
                    );
                },
            }
            : {}),
        };

        const progressTitle = runAs
            ? `Run As ${runAs.connectionName}: executing ${queries.length} statement(s)...`
            : continueOnError
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
                                    resultPanelProvider.log(executionUri, `${logPrefix}${msg}`);
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
                                    resultPanelProvider.log(executionUri, `${logPrefix}${msg}`);
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
        if (!hadFailure) {
            clearRuntimeErrorDiagnostic(documentUri);
        }
        resultPanelProvider.finalizeExecution(executionUri);
        // A run-as batch keeps focus in the SQL editor: results are already
        // visible in the tab's panel and the caller reports the outcome.
        if (!runAs) void handleExecutionCompletion(documentUri);
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
        const msg = describeQueryError(err);
        executionGate.recordError(msg);
        if (isConnectionBrokenError(err)) executionGate.requireSessionIsolation();
        const errorDetails = extractDatabaseErrorDetails(err);
        // A run-as failure belongs to the one-off identity, not to the tab's
        // own diagnostics; the result panel and notification carry it.
        if (!runAs && !isCancellationError(err) && queriesForError.length === 1) {
            publishRuntimeErrorDiagnostic(documentUri, queriesForError[0], msg, errorDetails, databaseKind ?? '', 0);
        }

        if (isCancellationError(err)) {
            executionGate.requireSessionIsolation();
            if (executionStarted) {
                resultPanelProvider.log(executionUri, `${logPrefix}Query execution cancelled by user.`);
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
                    errorDetails,
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
            void vscode.window.showErrorMessage(runAs
                ? `Run As failed on connection "${runAs.connectionName}": ${msg}`
                : `Error executing query: ${msg}`);
        }
        return 'failed';
    } finally {
        if (prepared.keepConnectionOpenOverride === false) {
            streamingManager.clearAborted(executionUri);
            if (executionStarted && !executionGate.isCurrent()) resultPanelProvider.finalizeExecution(executionUri);
        }
    }
}
