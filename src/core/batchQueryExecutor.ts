import * as vscode from "vscode";
import { ConnectionManager } from "./connectionManager";
import { QueryHistoryManager } from "./queryHistoryManager";
import { QueryResult } from "../types";
import { StreamingChunk } from "./streaming";
import { streamingManager } from "./queryCancellation";
import { logWithFallback } from "../utils/logger";
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
    handleBatchRetry,
    handleBatchError,
    createDropSessionCallback,
    getQueryConfig,
} from "./queryBatchExecutor";
import {
    isSqlConsoleDocument,
    SQL_CONSOLE_HISTORY_TAG,
} from "../utils/sqlConsole";
import { isConnectionBrokenError } from "./queryRunnerUtils";

function handleBatchQueryFailure(params: {
    err: unknown;
    queryIndex: number;
    sql: string;
    executionId: string | undefined;
    startTime: number;
    batchOptions: BatchQueryRunOptions;
    queryEndCallback?: (
        executionId: string,
        rowCount: number,
        durationMs: number,
        status: BatchExecutionStatus,
        error?: string,
    ) => void;
    outputChannel?: vscode.OutputChannel;
    allResults?: QueryResult[];
    resultCallback?: (results: QueryResult[]) => void;
    connectionName: string;
    documentUri?: string;
}): void {
    const errorMsg = params.err instanceof Error ? params.err.message : String(params.err);
    const durationMs = Date.now() - params.startTime;

    if (params.queryEndCallback && params.executionId) {
        params.queryEndCallback(params.executionId, 0, durationMs, 'error', errorMsg);
    }
    if (params.outputChannel) {
        params.outputChannel.appendLine(`Error in query ${params.queryIndex + 1}: ${errorMsg}`);
    }
    params.batchOptions.onStatementFailed?.({
        sql: params.sql,
        connectionName: params.connectionName,
        documentUri: params.documentUri,
        errorMessage: errorMsg,
    });

    const shouldContinue =
        params.batchOptions.continueOnError === true &&
        !errorMsg.includes('Query cancelled') &&
        !isConnectionBrokenError(params.err);

    if (!shouldContinue) {
        throw new Error(errorMsg, { cause: params.err });
    }

    const errorResult: QueryResult = {
        columns: [],
        data: [],
        message: errorMsg,
        isError: true,
        sql: params.sql,
    };

    params.allResults?.push(errorResult);
    params.resultCallback?.([errorResult]);
    params.batchOptions.onQueryError?.(params.queryIndex, params.sql, errorMsg);
}

export type { BatchQueryRunOptions } from "./queryBatchExecutor";

async function resolveBatchHistorySchema(
    connManager: ConnectionManager,
    connectionName: string,
    documentUri?: string,
): Promise<string | undefined> {
    if (documentUri && typeof connManager.getEffectiveSchema === 'function') {
        return await connManager.getEffectiveSchema(documentUri) ?? undefined;
    }
    if (typeof connManager.getSchemaForConnection === 'function') {
        return connManager.getSchemaForConnection(connectionName) ?? undefined;
    }
    return undefined;
}

/**
 * Cooperatively yield after each statement so VS Code can process UI/editor
 * focus changes even when many statements finish almost instantly.
 */
async function yieldAfterStatement(statementDurationMs: number): Promise<void> {
    const fastStatementThresholdMs = 75;
    const fastStatementPauseMs = 400;

    logWithFallback("debug", `Statement executed in ${statementDurationMs}ms`);
    if (statementDurationMs <= fastStatementThresholdMs) {
        await new Promise<void>(resolve => setTimeout(resolve, fastStatementPauseMs));
        return;
    }

    await new Promise<void>(resolve => setImmediate(resolve));
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
  extensionUri?: vscode.Uri,
  _isRetry: boolean = false,
  maxRows?: number,
  queryStartCallback?: (
    queryIndex: number,
    sql: string,
    connectionName: string,
  ) => string,
  queryEndCallback?: (
    executionId: string,
    rowCount: number,
    durationMs: number,
    status: BatchExecutionStatus,
    error?: string,
  ) => void,
  _outputChannel?: vscode.OutputChannel,
  _startIndex: number = 0,
  _resumeExecutionId?: string,
  _existingResults: QueryResult[] = [],
  _batchOptions: BatchQueryRunOptions = {},
): Promise<QueryResult[]> {
  const connManager = connectionManager || new ConnectionManager(context);
  const keepConnectionOpen = documentUri
    ? connManager.getDocumentKeepConnectionOpen(documentUri)
    : true;

  const outputChannel = setupBatchLogger(logCallback, queries.length, "sequential", _outputChannel);
    const allResults: QueryResult[] = [..._existingResults];
    let currentQueryIndex = _startIndex;
    let currentExecutionId: string | undefined = _resumeExecutionId;
    let currentQueryAllowsRetry = _batchOptions.retryOnBrokenConnection !== false;

    const resolvedConnectionName = resolveBatchConnectionName(connManager, documentUri);
    if (documentUri) {
        streamingManager.clearAborted(documentUri);
    }

    if (!resolvedConnectionName) {
        logBatch(outputChannel, logCallback, "Error: No connection selected");
        throw new Error("No connection selected");
    }

    // Resolve variables BEFORE connecting so the user sees the prompt immediately
    const resolvedVars = await resolveBatchVariables(queries, context, documentUri);

    try {
        const details = await connManager.getConnection(resolvedConnectionName);
        if (!details) {
            throw new Error(`Connection '${resolvedConnectionName}' not found`);
        }
        const historySchema = await resolveBatchHistorySchema(
            connManager,
            resolvedConnectionName,
            documentUri,
        );

        logBatch(outputChannel, logCallback, `Using connection: ${resolvedConnectionName}`);
        logBatch(outputChannel, logCallback, "Connecting to database...");

        const { connection, shouldCloseConnection } =
            await getConnectionForDocument(
                connManager,
                resolvedConnectionName,
                keepConnectionOpen,
                documentUri,
            );

        const noticeHandler = (msg: unknown) => {
            const notification = msg as { message: string };
            logBatch(outputChannel, logCallback, notification.message);
        };
        connection.on("notice", noticeHandler);

        try {
            const sessionId = await captureSessionId(
                connection,
                connManager,
                documentUri,
                logCallback,
            );

            const historyManager = QueryHistoryManager.getInstance(context);
            const historyTags = documentUri && isSqlConsoleDocument(context, documentUri)
                ? SQL_CONSOLE_HISTORY_TAG
                : undefined;

            for (let i = _startIndex; i < queries.length; i++) {
                currentQueryIndex = i;
                if (documentUri && streamingManager.isAborted(documentUri)) {
                    throw new Error('Query cancelled');
                }
                const query = queries[i];
                logBatch(outputChannel, logCallback, `Executing query ${i + 1}/${queries.length}...`);

                let executionId: string | undefined =
                    i === _startIndex ? _resumeExecutionId : undefined;
                currentExecutionId = executionId;
                const startTime = Date.now();
                let queryToExecute = query;
                currentQueryAllowsRetry = _batchOptions.retryOnBrokenConnection !== false;

                try {
                    const preparedQuery = await prepareQueryForExecutionWithMetadata(
                        query,
                        resolvedVars,
                        message => logBatch(outputChannel, logCallback, message),
                        sql => executeMacroQuery(
                            connection,
                            sql,
                            documentUri,
                            sessionId ? String(sessionId) : undefined,
                            connManager,
                        ),
                        createMacroFileReadContext(documentUri),
                    );
                    queryToExecute = preparedQuery.sql;
                    currentQueryAllowsRetry =
                        _batchOptions.retryOnBrokenConnection !== false &&
                        !preparedQuery.hasMacroBranch;
                    if (queryToExecute.trim().length === 0) {
                        logBatch(outputChannel, logCallback, `Skipping query ${i + 1}/${queries.length}: variable directive only.`);
                        continue;
                    }

                    if (_batchOptions.confirmSafeExecute && !(await _batchOptions.confirmSafeExecute(queryToExecute, i))) {
                        logBatch(outputChannel, logCallback, `Skipping query ${i + 1}/${queries.length}: execution cancelled by user.`);
                        return allResults;
                    }

                    if (queryStartCallback && !executionId) {
                        executionId = queryStartCallback(i, queryToExecute, resolvedConnectionName);
                        currentExecutionId = executionId;
                    }

                    if (documentUri && streamingManager.isAborted(documentUri)) {
                        const durationMs = Date.now() - startTime;
                        if (queryEndCallback && executionId) {
                            queryEndCallback(executionId, 0, durationMs, 'cancelled', 'Query cancelled');
                        }
                        throw new Error('Query cancelled');
                    }

                    const { queryTimeout, rowLimit } = getQueryConfig();

                    const {
                        results: batchResults,
                        error: batchError,
                        recordsAffected: batchRecordsAffected,
                        status: batchStatus,
                    } = await streamingManager.executeAndFetch(
                        connection,
                        queryToExecute,
                        rowLimit,
                        queryTimeout,
                        documentUri,
                        sessionId ? String(sessionId) : undefined,
                        connManager,
                        maxRows,
                        createDropSessionCallback(connManager, documentUri),
                    );

                    const totalRows = batchResults?.reduce(
                        (sum, rs) => sum + (rs.rows?.length || 0),
                        0,
                    ) || 0;

                    if (batchStatus === 'cancelled' || (documentUri && streamingManager.isAborted(documentUri))) {
                        const durationMs = Date.now() - startTime;
                        if (queryEndCallback && executionId) {
                            queryEndCallback(executionId, totalRows, durationMs, 'cancelled', 'Query cancelled');
                        }
                        throw new Error('Query cancelled');
                    }

                    const durationMs = Date.now() - startTime;
                    if (logCallback) {
                        let logMessage = `Executed query ${i + 1}/${queries.length} in ${durationMs}ms`;
                        if (batchRecordsAffected !== undefined && batchRecordsAffected > 0) {
                            logMessage += ` (records affected: ${batchRecordsAffected})`;
                        }
                        logCallback(logMessage);
                    }

                    if (batchResults && batchResults.length > 0) {
                        for (const rs of batchResults) {
                            allResults.push({
                                columns: rs.columns.length > 0 ? rs.columns : [],
                                data: rs.columns.length > 0 ? rs.rows : [],
                                rowsAffected: undefined,
                                limitReached: rs.limitReached,
                                message: rs.columns.length > 0 ? undefined : "Query executed successfully",
                                sql: queryToExecute,
                                refreshSql: queryToExecute,
                            });
                        }
                    }

                    if (resultCallback && batchResults && batchResults.length > 0) {
                        resultCallback(batchResults.map((rs) => ({
                            columns: rs.columns.length > 0 ? rs.columns : [],
                            data: rs.columns.length > 0 ? rs.rows : [],
                            rowsAffected: undefined,
                            limitReached: rs.limitReached,
                            message: rs.columns.length > 0 ? undefined : "Query executed successfully",
                            sql: queryToExecute,
                            refreshSql: queryToExecute,
                        })));
                    }

                    if (batchError) {
                        throw batchError;
                    }

                    await _batchOptions.onStatementSucceeded?.({
                        sql: queryToExecute,
                        connectionName: resolvedConnectionName,
                        documentUri,
                        connection,
                    });
                    if (queryEndCallback && executionId) {
                        queryEndCallback(executionId, totalRows, durationMs, 'success');
                    }
                    logQueryToHistoryAsync(
                        historyManager,
                        details.host,
                        details.database,
                        queryToExecute,
                        resolvedConnectionName,
                        historyTags,
                        'success',
                        durationMs,
                        batchRecordsAffected !== undefined && batchRecordsAffected > 0 ? batchRecordsAffected : totalRows,
                        undefined,
                        historySchema,
                        details.dbType,
                    );
                } catch (err: unknown) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    const isCancelled = errMsg.toLowerCase().includes('cancelled');
                    logQueryToHistoryAsync(
                        historyManager,
                        details.host,
                        details.database,
                        queryToExecute,
                        resolvedConnectionName,
                        historyTags,
                        isCancelled ? 'cancelled' : 'error',
                        Date.now() - startTime,
                        undefined,
                        errMsg,
                        historySchema,
                        details.dbType,
                    );
                    handleBatchQueryFailure({
                        err,
                        queryIndex: i,
                        sql: queryToExecute,
                        executionId,
                        startTime,
                        batchOptions: _batchOptions,
                        queryEndCallback,
                        outputChannel,
                        allResults,
                        resultCallback,
                        connectionName: resolvedConnectionName,
                        documentUri,
                    });
                }

                if (i % 5 === 0) {
                    await yieldAfterStatement(Date.now() - startTime);
                }

            }
            if (outputChannel) outputChannel.appendLine("All queries completed.");
        } finally {
            connection.removeListener("notice", noticeHandler);
            if (shouldCloseConnection) {
                await connection.close();
            }
        }
    } catch (error: unknown) {
      const retryExecutionId = currentExecutionId;
      const retryQueryIndex = currentQueryIndex;
      if (!currentQueryAllowsRetry) {
        await handleBatchError(error, connManager, outputChannel, logCallback, documentUri);
      }
      const retryResult = await handleBatchRetry(
        error,
        _isRetry,
        connManager,
        documentUri,
        keepConnectionOpen,
        outputChannel,
        logCallback,
        () =>
          runQueriesSequentially(
            context,
            queries,
            connManager,
            documentUri,
            logCallback,
            resultCallback,
            extensionUri,
            true,
            maxRows,
            queryStartCallback,
            queryEndCallback,
            outputChannel,
            retryQueryIndex,
            retryExecutionId,
            allResults,
            _batchOptions,
          ),
        retryExecutionId && queryEndCallback
          ? retryMessage => {
              queryEndCallback(retryExecutionId, 0, 0, 'retrying', retryMessage);
            }
          : undefined,
      );
        if (retryResult.handled) {
            return retryResult.result;
        }

        await handleBatchError(error, connManager, outputChannel, logCallback, documentUri);
    }

    return allResults;
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
  extensionUri?: vscode.Uri,
  _isRetry: boolean = false,
  maxRows?: number,
  queryStartCallback?: (
    queryIndex: number,
    sql: string,
    connectionName: string,
  ) => string,
  queryEndCallback?: (
    executionId: string,
    rowCount: number,
    durationMs: number,
    status: BatchExecutionStatus,
    error?: string,
  ) => void,
  _outputChannel?: vscode.OutputChannel,
  _startIndex: number = 0,
  _resumeExecutionId?: string,
  _batchOptions: BatchQueryRunOptions = {},
): Promise<void> {
  const connManager = connectionManager || new ConnectionManager(context);
  const keepConnectionOpen = documentUri
    ? connManager.getDocumentKeepConnectionOpen(documentUri)
    : true;

  const outputChannel = setupBatchLogger(logCallback, queries.length, "streaming", _outputChannel);

    let currentQueryIndex = _startIndex;
    let currentExecutionId: string | undefined = _resumeExecutionId;
    let currentQueryAllowsRetry = _batchOptions.retryOnBrokenConnection !== false;

    const resolvedConnectionName = resolveBatchConnectionName(connManager, documentUri);
    if (documentUri) {
        streamingManager.clearAborted(documentUri);
    }

    if (!resolvedConnectionName) {
        logBatch(outputChannel, logCallback, "Error: No connection selected");
        throw new Error("No connection selected");
    }

    // Resolve variables BEFORE connecting so the user sees the prompt immediately
    const resolvedVars = await resolveBatchVariables(queries, context, documentUri);

    try {
        const details = await connManager.getConnection(resolvedConnectionName);
        if (!details) {
            throw new Error(`Connection '${resolvedConnectionName}' not found`);
        }
        const historySchema = await resolveBatchHistorySchema(
            connManager,
            resolvedConnectionName,
            documentUri,
        );

        const { connection, shouldCloseConnection } =
            await getConnectionForDocument(
                connManager,
                resolvedConnectionName,
                keepConnectionOpen,
                documentUri,
            );

        const noticeHandler = (msg: unknown) => {
            const notification = msg as { message: string };
            logBatch(outputChannel, logCallback, notification.message);
        };
        connection.on("notice", noticeHandler);

        try {
            const sessionId = await captureSessionId(
                connection,
                connManager,
                documentUri,
                logCallback,
            );

            const historyManager = QueryHistoryManager.getInstance(context);
            const historyTags = documentUri && isSqlConsoleDocument(context, documentUri)
                ? SQL_CONSOLE_HISTORY_TAG
                : undefined;

            for (let i = _startIndex; i < queries.length; i++) {
                currentQueryIndex = i;
                if (documentUri && streamingManager.isAborted(documentUri)) {
                    throw new Error('Query cancelled');
                }
                const query = queries[i];
                logBatch(outputChannel, logCallback, `Executing query ${i + 1}/${queries.length}...`);

                let executionId: string | undefined =
                    i === _startIndex ? _resumeExecutionId : undefined;
                currentExecutionId = executionId;
                const startTime = Date.now();
                let queryToExecute = query;
                currentQueryAllowsRetry = _batchOptions.retryOnBrokenConnection !== false;

                try {
                    const preparedQuery = await prepareQueryForExecutionWithMetadata(
                        query,
                        resolvedVars,
                        message => logBatch(outputChannel, logCallback, message),
                        sql => executeMacroQuery(
                            connection,
                            sql,
                            documentUri,
                            sessionId ? String(sessionId) : undefined,
                            connManager,
                        ),
                        createMacroFileReadContext(documentUri),
                    );
                    queryToExecute = preparedQuery.sql;
                    currentQueryAllowsRetry =
                        _batchOptions.retryOnBrokenConnection !== false &&
                        !preparedQuery.hasMacroBranch;
                    if (queryToExecute.trim().length === 0) {
                        logBatch(outputChannel, logCallback, `Skipping query ${i + 1}/${queries.length}: variable directive only.`);
                        continue;
                    }

                    if (_batchOptions.confirmSafeExecute && !(await _batchOptions.confirmSafeExecute(queryToExecute, i))) {
                        logBatch(outputChannel, logCallback, `Skipping query ${i + 1}/${queries.length}: execution cancelled by user.`);
                        return;
                    }

                    if (queryStartCallback && !executionId) {
                        executionId = queryStartCallback(i, queryToExecute, resolvedConnectionName);
                        currentExecutionId = executionId;
                    }

                    if (documentUri && streamingManager.isAborted(documentUri)) {
                        const durationMs = Date.now() - startTime;
                        if (queryEndCallback && executionId) {
                            queryEndCallback(executionId, 0, durationMs, 'cancelled', 'Query cancelled');
                        }
                        throw new Error('Query cancelled');
                    }

                    const { queryTimeout, rowLimit } = getQueryConfig();

                    const { totalRows, limitReached, error, recordsAffected, status } =
                        await streamingManager.executeWithStreaming(
                            connection,
                            queryToExecute,
                            rowLimit,
                            chunkSize,
                            queryTimeout,
                            documentUri,
                            (chunk: StreamingChunk) => {
                                if (chunkCallback) {
                                    chunkCallback(i, chunk, queryToExecute);
                                }
                            },
                            sessionId,
                            connManager,
                            maxRows,
                            createDropSessionCallback(connManager, documentUri),
                        );

                    if (status === 'cancelled' || (documentUri && streamingManager.isAborted(documentUri))) {
                        const durationMs = Date.now() - startTime;
                        if (queryEndCallback && executionId) {
                            queryEndCallback(executionId, totalRows, durationMs, 'cancelled', 'Query cancelled');
                        }
                        throw new Error('Query cancelled');
                    }

                    const durationMs = Date.now() - startTime;
                    if (logCallback) {
                        let logMessage = `Query ${i + 1}/${queries.length}: ${totalRows} rows`;
                        if (recordsAffected !== undefined && recordsAffected > 0) {
                            logMessage += ` (records affected: ${recordsAffected})`;
                        }
                        logMessage += ` in ${durationMs}ms${limitReached ? " (limit reached)" : ""}`;
                        logCallback(logMessage);
                    }

                    if (error) {
                        throw error;
                    }
                    await _batchOptions.onStatementSucceeded?.({
                        sql: queryToExecute,
                        connectionName: resolvedConnectionName,
                        documentUri,
                        connection,
                    });
                    if (queryEndCallback && executionId) {
                        queryEndCallback(executionId, totalRows, durationMs, 'success');
                    }
                    logQueryToHistoryAsync(
                        historyManager,
                        details.host,
                        details.database,
                        queryToExecute,
                        resolvedConnectionName,
                        historyTags,
                        'success',
                        durationMs,
                        recordsAffected !== undefined && recordsAffected > 0 ? recordsAffected : totalRows,
                        undefined,
                        historySchema,
                        details.dbType,
                    );
                } catch (err: unknown) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    const isCancelled = errMsg.toLowerCase().includes('cancelled');
                    logQueryToHistoryAsync(
                        historyManager,
                        details.host,
                        details.database,
                        queryToExecute,
                        resolvedConnectionName,
                        historyTags,
                        isCancelled ? 'cancelled' : 'error',
                        Date.now() - startTime,
                        undefined,
                        errMsg,
                        historySchema,
                        details.dbType,
                    );
                    handleBatchQueryFailure({
                        err,
                        queryIndex: i,
                        sql: queryToExecute,
                        executionId,
                        startTime,
                        batchOptions: _batchOptions,
                        queryEndCallback,
                        outputChannel,
                        resultCallback: undefined,
                        connectionName: resolvedConnectionName,
                        documentUri,
                    });
                }

                if (i % 5 === 0) {
                    await yieldAfterStatement(Date.now() - startTime);
                }
            }

            if (outputChannel) outputChannel.appendLine("All queries completed.");
        } finally {
            connection.removeListener("notice", noticeHandler);
            if (shouldCloseConnection) {
                await connection.close();
            }
        }
    } catch (error: unknown) {
      const retryExecutionId = currentExecutionId;
      const retryQueryIndex = currentQueryIndex;
      if (!currentQueryAllowsRetry) {
        await handleBatchError(error, connManager, outputChannel, logCallback, documentUri);
      }
      const retryResult = await handleBatchRetry(
        error,
        _isRetry,
        connManager,
        documentUri,
        keepConnectionOpen,
        outputChannel,
        logCallback,
        () =>
          runQueriesWithStreaming(
            context,
            queries,
            connManager,
            documentUri,
            logCallback,
            chunkCallback,
            chunkSize,
            extensionUri,
            true,
            maxRows,
            queryStartCallback,
            queryEndCallback,
            outputChannel,
            retryQueryIndex,
            retryExecutionId,
            _batchOptions,
          ),
        retryExecutionId && queryEndCallback
          ? retryMessage => {
              queryEndCallback(retryExecutionId, 0, 0, 'retrying', retryMessage);
            }
          : undefined,
      );
        if (retryResult.handled) {
            return retryResult.result;
        }

        await handleBatchError(error, connManager, outputChannel, logCallback, documentUri);
    }
}
