import * as vscode from "vscode";
import { createExecutionId, ExecutionOrchestrator } from '@justybase/database-runtime/execution';
import type { ExecutionEvent, ExecutionSummary } from '@justybase/contracts';
import { ConnectionManager } from "./connectionManager";
import { QueryHistoryManager } from "./queryHistoryManager";
import { QueryResult } from "../types";
import type { NzConnection } from "../types";
import { StreamingChunk } from "./streaming";
import { streamingManager } from "./queryCancellation";
import { getConnectionForDocument } from "./queryRunnerHelpers";
import {
    BatchExecutionStatus,
    BatchQueryRunOptions,
    resolveBatchConnectionName,
    resolveBatchVariables,
    captureSessionId,
    setupBatchLogger,
    logBatch,
    createMacroFileReadContext,
    prepareQueryForExecutionWithMetadata,
    executeMacroQuery,
    logQueryToHistoryAsync,
    handleBatchError,
    isCancellationError,
    createDropSessionCallback,
    getQueryConfig,
} from "./queryBatchExecutor";
import {
    isSqlConsoleDocument,
    SQL_CONSOLE_HISTORY_TAG,
} from "../utils/sqlConsole";
import { isConnectionBrokenError } from "./queryRunnerUtils";
import { assertExecutionCurrent } from "./executionGuard";
import { DesktopExecutionBackend, type DesktopExecutionTarget } from './execution/desktopExecutionBackend';
import {
    createRetrySafetyError,
    getSingleExecutableStatement,
    isSafeToRetryAfterBrokenConnection,
    skipLeadingSqlTrivia,
} from './queryRetrySafety';

const SLOW_STREAMING_PHASE_MS = 1000;

type QueryEndCallback = (
    executionId: string,
    rowCount: number,
    durationMs: number,
    status: BatchExecutionStatus,
    error?: string,
) => void;

const TERMINAL_EXECUTION_STATUSES = new Set<BatchExecutionStatus>([
    'success',
    'error',
    'cancelled',
]);

interface SharedBatchStatement {
    originalIndex: number;
    originalSql: string;
    sql: string;
    hasExecutableMacro: boolean;
}

interface SharedBatchStatementState {
    readonly statement: SharedBatchStatement;
    startedAt: number;
    executionId?: string;
    commandType: string;
    resultSets: Array<{ columns: QueryResult['columns']; rows: unknown[][]; limitReached: boolean }>;
    currentResultSet?: { columns: QueryResult['columns']; rows: unknown[][]; limitReached: boolean };
    totalRows: number;
    deliveredRows: boolean;
    retrying: boolean;
    terminalized: boolean;
}

function isBatchCancellationRequested(documentUri: string | undefined): boolean {
    return documentUri !== undefined && streamingManager.isAborted(documentUri);
}

function emitQueryStatus(
    callback: QueryEndCallback | undefined,
    terminalExecutionIds: Set<string>,
    executionId: string | undefined,
    rowCount: number,
    durationMs: number,
    status: BatchExecutionStatus,
    error?: string,
): void {
    if (!callback || !executionId || terminalExecutionIds.has(executionId)) {
        return;
    }

    if (TERMINAL_EXECUTION_STATUSES.has(status)) {
        terminalExecutionIds.add(executionId);
    }
    if (error === undefined) {
        callback(executionId, rowCount, durationMs, status);
        return;
    }
    callback(executionId, rowCount, durationMs, status, error);
}

function isRowsAffectedStatement(sql: string): boolean {
    const start = skipLeadingSqlTrivia(sql);
    if (start === undefined) {
        return false;
    }
    return /^(INSERT|UPDATE|DELETE|REPLACE|MERGE|TRUNCATE)\b/i.test(sql.slice(start));
}

function sharedStatementCommandType(sql: string): string {
    const start = skipLeadingSqlTrivia(sql);
    if (start === undefined) return 'SQL';
    return /^[A-Za-z]+/u.exec(sql.slice(start))?.[0]?.toUpperCase() ?? 'SQL';
}

function sharedFailureError(
    state: SharedBatchStatementState,
    failure: { cause: unknown; message: string; kind?: string },
): Error {
    if (failure.kind === 'cancellation' || isCancellationError(failure.cause)) {
        return new Error(failure.message, { cause: failure.cause });
    }
    if (state.retrying) {
        return new Error(`Error (after reconnect attempt): ${failure.message}`, { cause: failure.cause });
    }
    if (isConnectionBrokenError(failure.cause)) {
        return createRetrySafetyError(failure.cause, state.deliveredRows);
    }
    return new Error(failure.message, { cause: failure.cause });
}

interface SharedBatchRunParams {
    context: vscode.ExtensionContext;
    queries: string[];
    connectionManager?: ConnectionManager;
    documentUri?: string;
    logCallback?: (msg: string) => void;
    mode: 'sequential' | 'streaming';
    chunkCallback?: (queryIndex: number, chunk: StreamingChunk, sql: string) => void | Promise<void>;
    chunkSize: number;
    maxRows?: number;
    queryStartCallback?: (queryIndex: number, sql: string, connectionName: string) => string;
    queryEndCallback?: QueryEndCallback;
    resultCallback?: (results: QueryResult[]) => void;
    batchOptions: BatchQueryRunOptions;
    startIndex: number;
    resumeExecutionId?: string;
    existingResults: QueryResult[];
    terminalExecutionIds: Set<string>;
}

/**
 * Product adapter for the shared execution lifecycle. Preparation, history,
 * result-panel callbacks and VS Code connection selection remain here; the
 * execution attempt/retry/cancel/cleanup state is owned by database-runtime.
 */
async function runBatchWithSharedOrchestrator(
    params: SharedBatchRunParams,
): Promise<QueryResult[]> {
    const connManager = params.connectionManager || new ConnectionManager(params.context);
    const keepConnectionOpen = params.documentUri
        ? connManager.getDocumentKeepConnectionOpen(params.documentUri)
        : false;
    const outputChannel = setupBatchLogger(
        params.logCallback,
        params.queries.length,
        params.mode,
    );
    const allResults: QueryResult[] = [...params.existingResults];
    const resolvedConnectionName = resolveBatchConnectionName(connManager, params.documentUri);
    if (params.documentUri && params.startIndex === 0) {
        streamingManager.clearAborted(params.documentUri);
    }
    assertExecutionCurrent(params.batchOptions.isExecutionCurrent);

    const resolvedVars = await resolveBatchVariables(
        params.queries,
        params.context,
        params.documentUri,
    );
    const details = await connManager.getConnection(resolvedConnectionName);
    if (!details) throw new Error(`Connection '${resolvedConnectionName}' not found`);
    const historySchema = await resolveBatchHistorySchema(
        connManager,
        resolvedConnectionName,
        params.documentUri,
    );
    const historyDatabase = params.documentUri && typeof connManager.getEffectiveDatabase === 'function'
        ? (await connManager.getEffectiveDatabase(params.documentUri, resolvedConnectionName)) ?? details.database
        : details.database;
    const historyManager = QueryHistoryManager.getInstance(params.context);
    const historyTags = params.documentUri && isSqlConsoleDocument(params.context, params.documentUri)
        ? SQL_CONSOLE_HISTORY_TAG
        : undefined;

    let connectionLease: { connection: NzConnection; shouldCloseConnection: boolean } | undefined;
    let preparationNoticeHandler: ((message: unknown) => void) | undefined;
    let executionStarted = false;
    let target: DesktopExecutionTarget | undefined;
    let finalReportedError: Error | undefined;
    let chunkCallbackIndex = -1;
    let chunkCallbackSql = '';

    try {
        connectionLease = await getConnectionForDocument(
            connManager,
            resolvedConnectionName,
            keepConnectionOpen,
            params.documentUri,
        );
        assertExecutionCurrent(params.batchOptions.isExecutionCurrent);

        const preparationNotice = (message: unknown): void => {
            const notification = message as { message?: unknown };
            logBatch(outputChannel, params.logCallback, String(notification.message ?? message));
        };
        preparationNoticeHandler = preparationNotice;
        connectionLease.connection.on('notice', preparationNotice);
        let sessionId = await captureSessionId(
            connectionLease.connection,
            connManager,
            params.documentUri,
            params.logCallback,
        );

        const statements: SharedBatchStatement[] = [];
        let hasExecutableMacro = false;
        for (let queryIndex = params.startIndex; queryIndex < params.queries.length; queryIndex += 1) {
            assertExecutionCurrent(params.batchOptions.isExecutionCurrent);
            const originalSql = params.queries[queryIndex] ?? '';
            logBatch(outputChannel, params.logCallback, `Preparing query ${queryIndex + 1}/${params.queries.length}...`);
            const prepared = await prepareQueryForExecutionWithMetadata(
                originalSql,
                resolvedVars,
                message => logBatch(outputChannel, params.logCallback, message),
                sql => executeMacroQuery(
                    connectionLease!.connection,
                    sql,
                    params.documentUri,
                    sessionId,
                    connManager,
                ),
                createMacroFileReadContext(params.documentUri),
            );
            assertExecutionCurrent(params.batchOptions.isExecutionCurrent);
            if (prepared.sql.trim().length === 0) {
                logBatch(outputChannel, params.logCallback, `Skipping query ${queryIndex + 1}/${params.queries.length}: variable directive only.`);
                continue;
            }
            if (params.batchOptions.confirmSafeExecute && !(await params.batchOptions.confirmSafeExecute(prepared.sql, queryIndex))) {
                params.batchOptions.onStatementFailed?.({
                    sql: prepared.sql,
                    connectionName: resolvedConnectionName,
                    documentUri: params.documentUri,
                    errorMessage: 'Query execution cancelled by user',
                });
                logBatch(outputChannel, params.logCallback, `Skipping query ${queryIndex + 1}/${params.queries.length}: execution cancelled by user.`);
                return allResults;
            }
            hasExecutableMacro = hasExecutableMacro || prepared.hasExecutableMacro;
            statements.push({
                originalIndex: queryIndex,
                originalSql,
                sql: prepared.sql,
                hasExecutableMacro: prepared.hasExecutableMacro,
            });
        }

        connectionLease.connection.removeListener('notice', preparationNotice);
        preparationNoticeHandler = undefined;
        if (statements.length === 0) return allResults;

        const stateByIndex = new Map<number, SharedBatchStatementState>();
        const executionId = params.resumeExecutionId ?? createExecutionId('desktop-batch');
        target = {
            connection: connectionLease.connection,
            shouldCloseConnection: connectionLease.shouldCloseConnection,
            keepConnectionOpen,
            documentUri: params.documentUri,
            sessionId,
            connectionManager: params.documentUri ? connManager : undefined,
            openConnection: async () => getConnectionForDocument(
                connManager,
                resolvedConnectionName,
                keepConnectionOpen,
                params.documentUri,
            ),
            onConnectionAcquired: async freshConnection => {
                sessionId = await captureSessionId(
                    freshConnection,
                    connManager,
                    params.documentUri,
                    params.logCallback,
                );
                return sessionId;
            },
            onNotice: preparationNotice,
            onTiming: timing => {
                if (params.mode !== 'streaming' || typeof timing !== 'object' || timing === null) return;
                const candidate = timing as Record<string, unknown>;
                const slow = [candidate.resultCompletionWaitMs, candidate.readerCloseMs, candidate.chunkDeliveryMs]
                    .some(value => typeof value === 'number' && value >= SLOW_STREAMING_PHASE_MS);
                if (slow) {
                    logBatch(
                        outputChannel,
                        params.logCallback,
                        `[StreamingTiming] rows=${String(candidate.rowsRead ?? '-')} `
                        + `executeReaderMs=${String(candidate.executeReaderMs ?? '-')} `
                        + `resultCompletionWaitMs=${String(candidate.resultCompletionWaitMs ?? '-')} `
                        + `readerCloseMs=${String(candidate.readerCloseMs ?? '-')} `
                        + `chunkDeliveryMs=${String(candidate.chunkDeliveryMs ?? '-')} `
                        + `totalMs=${String(candidate.totalMs ?? '-')}`,
                    );
                }
            },
            onChunk: params.mode === 'streaming'
                ? async chunk => {
                    const state = stateByIndex.get(chunkCallbackIndex);
                    if (state) {
                        state.deliveredRows = state.deliveredRows || chunk.rows.length > 0;
                        state.totalRows = Math.max(state.totalRows, chunk.totalRowsSoFar);
                    }
                    assertExecutionCurrent(params.batchOptions.isExecutionCurrent);
                    await params.chunkCallback?.(chunkCallbackIndex, chunk, chunkCallbackSql);
                    assertExecutionCurrent(params.batchOptions.isExecutionCurrent);
                }
                : undefined,
            isCancellationRequested: () => isBatchCancellationRequested(params.documentUri),
            onStatementSucceeded: async (freshConnection, sql) => {
                assertExecutionCurrent(params.batchOptions.isExecutionCurrent);
                await params.batchOptions.onStatementSucceeded?.({
                    sql,
                    connectionName: resolvedConnectionName,
                    documentUri: params.documentUri,
                    connection: freshConnection,
                });
                assertExecutionCurrent(params.batchOptions.isExecutionCurrent);
            },
            onDropSession: createDropSessionCallback(connManager, params.documentUri),
            chunkSize: params.chunkSize,
        };

        const backend = new DesktopExecutionBackend({
            streamingManager,
            isConnectionBrokenError,
            isSafeToRetrySql: isSafeToRetryAfterBrokenConnection,
        });
        const orchestrator = new ExecutionOrchestrator<DesktopExecutionTarget>({ backend });
        statements.forEach((statement, index) => {
            const state: SharedBatchStatementState = {
                statement,
                startedAt: Date.now(),
                commandType: sharedStatementCommandType(statement.sql),
                resultSets: [],
                totalRows: 0,
                deliveredRows: false,
                retrying: false,
                terminalized: false,
            };
            stateByIndex.set(index, state);
        });

        const getState = (index: number): SharedBatchStatementState => {
            const state = stateByIndex.get(index);
            if (!state) throw new Error(`Unknown desktop execution statement ${index}.`);
            return state;
        };
        const observer = {
            onEvent: async (event: ExecutionEvent): Promise<void> => {
                if (event.type === 'execution-started') return;
                if (event.type === 'execution-terminal') {
                    if (event.summary.status === 'success') return;
                    const state = [...stateByIndex.values()].find(candidate => !candidate.terminalized);
                    if (!state) return;
                    const reported = event.summary.error
                        ? sharedFailureError(state, event.summary.error)
                        : new Error(event.summary.status === 'cancelled' ? 'Query cancelled' : 'Query failed.');
                    finalReportedError = reported;
                    state.terminalized = true;
                    const cancelled = event.summary.status === 'cancelled';
                    const message = cancelled ? 'Query cancelled' : reported.message;
                    emitQueryStatus(
                        params.queryEndCallback,
                        params.terminalExecutionIds,
                        state.executionId,
                        state.totalRows,
                        Date.now() - state.startedAt,
                        cancelled ? 'cancelled' : 'error',
                        message,
                    );
                    params.batchOptions.onStatementFailed?.({
                        sql: state.statement.sql,
                        connectionName: resolvedConnectionName,
                        documentUri: params.documentUri,
                        errorMessage: message,
                    });
                    return;
                }
                if (event.type === 'batch-completed') return;
                if (event.context.statementIndex === undefined) {
                    throw new Error(`Desktop execution event ${event.type} is missing a statement index.`);
                }
                const stateIndex = event.context.statementIndex;
                if (event.type === 'statement-started') {
                    const state = getState(stateIndex);
                    state.executionId = params.queryStartCallback?.(
                        state.statement.originalIndex,
                        state.statement.sql,
                        resolvedConnectionName,
                    );
                    state.startedAt = Date.now();
                    chunkCallbackIndex = stateIndex;
                    chunkCallbackSql = state.statement.sql;
                    logBatch(outputChannel, params.logCallback, `Executing query ${state.statement.originalIndex + 1}/${params.queries.length}...`);
                    return;
                }
                if (event.type === 'columns') {
                    const state = getState(stateIndex);
                    state.currentResultSet = { columns: event.columns, rows: [], limitReached: false };
                    state.resultSets.push(state.currentResultSet);
                    return;
                }
                if (event.type === 'rows') {
                    const state = getState(stateIndex);
                    state.deliveredRows = state.deliveredRows || event.rows.length > 0;
                    state.totalRows = Math.max(state.totalRows, event.totalRows);
                    if (params.mode === 'sequential') {
                        if (!state.currentResultSet) {
                            state.currentResultSet = { columns: [], rows: [], limitReached: false };
                            state.resultSets.push(state.currentResultSet);
                        }
                        state.currentResultSet.rows.push(...event.rows);
                    }
                    return;
                }
                if (event.type === 'retrying') {
                    const state = getState(stateIndex);
                    state.retrying = true;
                    state.resultSets = [];
                    state.currentResultSet = undefined;
                    emitQueryStatus(
                        params.queryEndCallback,
                        params.terminalExecutionIds,
                        state.executionId,
                        state.totalRows,
                        0,
                        'retrying',
                        'Connection was closed by server. Reconnecting and retrying...',
                    );
                    return;
                }
                if (event.type === 'statement-completed') {
                    const state = getState(stateIndex);
                    const summary = event.summary;
                    state.terminalized = true;
                    state.totalRows = Math.max(state.totalRows, summary.totalRows);
                    if (state.currentResultSet) state.currentResultSet.limitReached = summary.limitReached;
                    const durationMs = Date.now() - state.startedAt;
                    if (params.mode === 'streaming') {
                        let logMessage = `Query ${state.statement.originalIndex + 1}/${params.queries.length}: ${state.totalRows} rows`;
                        if (summary.rowsAffected !== undefined && summary.rowsAffected > 0) {
                            logMessage += ` (records affected: ${summary.rowsAffected})`;
                        }
                        logMessage += ` in ${durationMs}ms${summary.limitReached ? ' (limit reached)' : ''}`;
                        logBatch(outputChannel, params.logCallback, logMessage);
                    } else {
                        let logMessage = `Executed query ${state.statement.originalIndex + 1}/${params.queries.length} in ${durationMs}ms`;
                        if (summary.rowsAffected !== undefined && summary.rowsAffected > 0) {
                            logMessage += ` (records affected: ${summary.rowsAffected})`;
                        }
                        logBatch(outputChannel, params.logCallback, logMessage);
                    }
                    if (params.mode === 'sequential') {
                        const mapped = state.resultSets.map(resultSet => mapBatchResult(
                            resultSet,
                            state.statement.sql,
                            getSingleExecutableStatement(state.statement.sql),
                            summary.rowsAffected,
                        ));
                        if (mapped.length > 0) {
                            allResults.push(...mapped);
                            if (params.resultCallback) params.resultCallback(mapped);
                        } else if (
                            isRowsAffectedStatement(state.statement.sql)
                            && summary.rowsAffected !== undefined
                            && summary.rowsAffected >= 0
                        ) {
                            const affected = createRowsAffectedResult(state.statement.sql, summary.rowsAffected);
                            allResults.push(affected);
                            params.resultCallback?.([affected]);
                        }
                    }
                    emitQueryStatus(
                        params.queryEndCallback,
                        params.terminalExecutionIds,
                        state.executionId,
                        state.totalRows,
                        durationMs,
                        'success',
                    );
                    logQueryToHistoryAsync(
                        historyManager,
                        details.host,
                        historyDatabase,
                        state.statement.sql,
                        resolvedConnectionName,
                        historyTags,
                        'success',
                        durationMs,
                        summary.rowsAffected !== undefined && summary.rowsAffected > 0 ? summary.rowsAffected : state.totalRows,
                        undefined,
                        historySchema,
                        details.dbType,
                    );
                    return;
                }
                if (event.type === 'statement-failed') {
                    const state = getState(stateIndex);
                    if (state.terminalized) return;
                    const failureMetadata = (event.failure.cause as { metadata?: { totalRows?: number } } | undefined)?.metadata;
                    state.totalRows = Math.max(
                        state.totalRows,
                        event.summary?.totalRows ?? 0,
                        failureMetadata?.totalRows ?? 0,
                        state.currentResultSet?.rows.length ?? 0,
                    );
                    const reported = sharedFailureError(state, event.failure);
                    finalReportedError = reported;
                    const cancelled = event.failure.kind === 'cancellation';
                    const message = cancelled
                        ? 'Query cancelled'
                        : state.retrying
                            ? event.failure.message
                            : reported.message;
                    state.terminalized = true;
                    const durationMs = Date.now() - state.startedAt;
                    emitQueryStatus(
                        params.queryEndCallback,
                        params.terminalExecutionIds,
                        state.executionId,
                        state.totalRows,
                        durationMs,
                        cancelled ? 'cancelled' : 'error',
                        message,
                    );
                    logQueryToHistoryAsync(
                        historyManager,
                        details.host,
                        historyDatabase,
                        state.statement.sql,
                        resolvedConnectionName,
                        historyTags,
                        cancelled ? 'cancelled' : 'error',
                        durationMs,
                        undefined,
                        message,
                        historySchema,
                        details.dbType,
                    );
                    params.batchOptions.onStatementFailed?.({
                        sql: state.statement.sql,
                        connectionName: resolvedConnectionName,
                        documentUri: params.documentUri,
                        errorMessage: message,
                    });
                    if (params.batchOptions.continueOnError && !cancelled) {
                        const errorResult: QueryResult = {
                            columns: [],
                            data: [],
                            message,
                            isError: true,
                            sql: state.statement.sql,
                        };
                        allResults.push(errorResult);
                        params.resultCallback?.([errorResult]);
                        params.batchOptions.onQueryError?.(state.statement.originalIndex, state.statement.sql, message);
                    }
                    return;
                }
                if (event.type === 'progress') return;
            },
        };

        // The callback context is selected by statement-started immediately
        // before the backend starts reading rows. Each batch is serial, so this
        // remains stable for the duration of one streaming statement.
        const execution = orchestrator.start({
            executionId,
            sourceKey: params.documentUri ?? `connection:${resolvedConnectionName}`,
            target,
            statements: statements.map((statement, index) => ({
                index,
                sql: statement.sql,
                originalSql: statement.originalSql,
                expandedSql: statement.sql,
            })),
            delivery: params.mode === 'streaming' ? 'streaming' : 'buffered',
            connectionMode: params.documentUri && keepConnectionOpen ? 'persistent' : 'transient',
            maxRows: params.maxRows ?? getQueryConfig().rowLimit,
            timeoutSeconds: getQueryConfig().queryTimeout,
            readOnly: false,
            retryPolicy: params.batchOptions.retryOnBrokenConnection === false || hasExecutableMacro
                ? 'disabled'
                : 'safe-read-only-on-broken-connection',
            continueOnError: params.batchOptions.continueOnError === true,
        }, observer);
        executionStarted = true;
        const summary: ExecutionSummary = await execution.settled;
        assertExecutionCurrent(params.batchOptions.isExecutionCurrent);
        if (summary.status !== 'success' && !params.batchOptions.continueOnError) {
            const error = finalReportedError
                ?? (summary.error ? new Error(summary.error.message, { cause: summary.error.cause }) : new Error(summary.status === 'cancelled' ? 'Query cancelled' : 'Query failed.'));
            await handleBatchError(error, connManager, outputChannel, params.logCallback, params.documentUri);
        }
        if (outputChannel && summary.status === 'success') outputChannel.appendLine('All queries completed.');
        return allResults;
    } finally {
        if (preparationNoticeHandler && connectionLease?.connection) {
            connectionLease.connection.removeListener('notice', preparationNoticeHandler);
        }
        if (!executionStarted && connectionLease?.shouldCloseConnection) {
            await connectionLease.connection.close();
        }
    }
}

function mapBatchResult(
    resultSet: { columns: QueryResult['columns']; rows: unknown[][]; limitReached: boolean },
    sql: string,
    statementSql: string | undefined,
    recordsAffected: number | undefined,
): QueryResult {
    const hasColumns = resultSet.columns.length > 0;
    const hasRowsAffected = !hasColumns
        && statementSql !== undefined
        && isRowsAffectedStatement(statementSql)
        && recordsAffected !== undefined
        && recordsAffected >= 0;

    return {
        columns: hasColumns ? resultSet.columns : [],
        data: hasColumns ? resultSet.rows : [],
        rowsAffected: hasRowsAffected ? recordsAffected : undefined,
        limitReached: resultSet.limitReached,
        message: hasColumns
            ? undefined
            : hasRowsAffected
                ? `Records affected: ${recordsAffected}`
                : "Query executed successfully",
        sql,
        refreshSql: sql,
    };
}

function createRowsAffectedResult(sql: string, recordsAffected: number): QueryResult {
    return {
        columns: [],
        data: [],
        rowsAffected: recordsAffected,
        message: `Records affected: ${recordsAffected}`,
        sql,
        refreshSql: sql,
    };
}

export type { BatchQueryRunOptions } from "./queryBatchExecutor";

async function resolveBatchHistorySchema(
    connManager: ConnectionManager,
    connectionName: string,
    documentUri?: string,
): Promise<string | undefined> {
    if (documentUri && typeof connManager.getEffectiveSchema === 'function') {
        return await connManager.getEffectiveSchema(documentUri, connectionName) ?? undefined;
    }
    if (typeof connManager.getSchemaForConnection === 'function') {
        return connManager.getSchemaForConnection(connectionName) ?? undefined;
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// runQueriesSequentially — using queryBatchExecutor
// ---------------------------------------------------------------------------

export async function runQueriesSequentially(
  context: vscode.ExtensionContext,
  queries: string[],
  connectionManager?: ConnectionManager,
  documentUri?: string,
  logCallback?: (msg: string) => void,
  resultCallback?: (results: QueryResult[]) => void,
  _extensionUri?: vscode.Uri,
  _isRetry: boolean = false,
  maxRows?: number,
  queryStartCallback?: (
    queryIndex: number,
    sql: string,
    connectionName: string,
  ) => string,
  queryEndCallback?: QueryEndCallback,
  _outputChannel?: vscode.OutputChannel,
  _startIndex: number = 0,
  _resumeExecutionId?: string,
  _existingResults: QueryResult[] = [],
  _batchOptions: BatchQueryRunOptions = {},
  _terminalExecutionIds: Set<string> = new Set(),
): Promise<QueryResult[]> {
  return runBatchWithSharedOrchestrator({
    context,
    queries,
    connectionManager,
    documentUri,
    logCallback,
    mode: "sequential",
    maxRows,
    queryStartCallback,
    queryEndCallback,
    resultCallback,
    batchOptions: _batchOptions,
    startIndex: _startIndex,
    resumeExecutionId: _resumeExecutionId,
    existingResults: _existingResults,
    terminalExecutionIds: _terminalExecutionIds,
    chunkSize: 1,
  });
}

// ---------------------------------------------------------------------------
// runQueriesWithStreaming — using queryBatchExecutor
// ---------------------------------------------------------------------------

/**
 * Run queries sequentially with streaming support.
 * Sends results in chunks for better memory efficiency and responsiveness.
 */
export async function runQueriesWithStreaming(
  context: vscode.ExtensionContext,
  queries: string[],
  connectionManager?: ConnectionManager,
  documentUri?: string,
  logCallback?: (msg: string) => void,
  chunkCallback?: (
    queryIndex: number,
    chunk: StreamingChunk,
    sql: string,
  ) => void,
  chunkSize: number = 5000,
  _extensionUri?: vscode.Uri,
  _isRetry: boolean = false,
  maxRows?: number,
  queryStartCallback?: (
    queryIndex: number,
    sql: string,
    connectionName: string,
  ) => string,
  queryEndCallback?: QueryEndCallback,
  _outputChannel?: vscode.OutputChannel,
  _startIndex: number = 0,
  _resumeExecutionId?: string,
  _batchOptions: BatchQueryRunOptions = {},
  _terminalExecutionIds: Set<string> = new Set(),
): Promise<void> {
  await runBatchWithSharedOrchestrator({
    context,
    queries,
    connectionManager,
    documentUri,
    logCallback,
    mode: "streaming",
    chunkCallback,
    chunkSize,
    maxRows,
    queryStartCallback,
    queryEndCallback,
    batchOptions: _batchOptions,
    startIndex: _startIndex,
    resumeExecutionId: _resumeExecutionId,
    existingResults: [],
    terminalExecutionIds: _terminalExecutionIds,
  });
}
