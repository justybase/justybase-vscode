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

function handleBatchQueryFailure(params: {
    err: unknown;
    queryIndex: number;
    sql: string;
    executionId: string | undefined;
    startTime: number;
    batchOptions: BatchQueryRunOptions;
    queryEndCallback?: QueryEndCallback;
    terminalExecutionIds: Set<string>;
    rowCount?: number;
    outputChannel?: vscode.OutputChannel;
    allResults?: QueryResult[];
    resultCallback?: (results: QueryResult[]) => void;
    connectionName: string;
    documentUri?: string;
}): void {
    assertExecutionCurrent(params.batchOptions.isExecutionCurrent);
    const errorMsg = params.err instanceof Error ? params.err.message : String(params.err);
    const durationMs = Date.now() - params.startTime;
    const isCancelled = isCancellationError(params.err);

    emitQueryStatus(
        params.queryEndCallback,
        params.terminalExecutionIds,
        params.executionId,
        params.rowCount ?? 0,
        durationMs,
        isCancelled ? 'cancelled' : 'error',
        errorMsg,
    );
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
        !isCancelled &&
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
        return await connManager.getEffectiveSchema(documentUri, connectionName) ?? undefined;
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
  queryEndCallback?: QueryEndCallback,
  _outputChannel?: vscode.OutputChannel,
  _startIndex: number = 0,
  _resumeExecutionId?: string,
  _existingResults: QueryResult[] = [],
  _batchOptions: BatchQueryRunOptions = {},
  _terminalExecutionIds: Set<string> = new Set(),
): Promise<QueryResult[]> {
  const connManager = connectionManager || new ConnectionManager(context);
  const keepConnectionOpen = documentUri
    ? connManager.getDocumentKeepConnectionOpen(documentUri)
    : true;

  const outputChannel = setupBatchLogger(logCallback, queries.length, "sequential", _outputChannel);
    const allResults: QueryResult[] = [..._existingResults];
    let currentQueryIndex = _startIndex;
    let currentExecutionId: string | undefined = _resumeExecutionId;
    let currentQueryAllowsRetry: boolean;
    let currentFailureWillRetry = false;
    let currentFailureCameFromExecution: boolean;

    const resolvedConnectionName = resolveBatchConnectionName(connManager, documentUri);
    if (documentUri && !_isRetry) {
        streamingManager.clearAborted(documentUri);
    }
    assertExecutionCurrent(_batchOptions.isExecutionCurrent);

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
        const historyDatabase = documentUri && typeof connManager.getEffectiveDatabase === 'function'
            ? (await connManager.getEffectiveDatabase(documentUri, resolvedConnectionName)) ?? details.database
            : details.database;

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

        try {
            assertExecutionCurrent(_batchOptions.isExecutionCurrent);
            connection.on("notice", noticeHandler);

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
                assertExecutionCurrent(_batchOptions.isExecutionCurrent);
                currentQueryIndex = i;
                const query = queries[i];
                if (documentUri && streamingManager.isAborted(documentUri)) {
                    _batchOptions.onStatementFailed?.({
                        sql: query,
                        connectionName: resolvedConnectionName,
                        documentUri,
                        errorMessage: 'Query cancelled',
                    });
                    throw new Error('Query cancelled');
                }
                logBatch(outputChannel, logCallback, `Executing query ${i + 1}/${queries.length}...`);

                let executionId: string | undefined =
                    i === _startIndex ? _resumeExecutionId : undefined;
                currentExecutionId = executionId;
                const startTime = Date.now();
                let queryToExecute = query;
                currentQueryAllowsRetry = false;
                currentFailureWillRetry = false;
                currentFailureCameFromExecution = false;

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
                    assertExecutionCurrent(_batchOptions.isExecutionCurrent);
                    queryToExecute = preparedQuery.sql;
                    currentQueryAllowsRetry =
                        _batchOptions.retryOnBrokenConnection !== false &&
                        !preparedQuery.hasExecutableMacro &&
                        isSafeToRetryAfterBrokenConnection(queryToExecute);
                    if (queryToExecute.trim().length === 0) {
                        logBatch(outputChannel, logCallback, `Skipping query ${i + 1}/${queries.length}: variable directive only.`);
                        continue;
                    }

                    if (_batchOptions.confirmSafeExecute && !(await _batchOptions.confirmSafeExecute(queryToExecute, i))) {
                        _batchOptions.onStatementFailed?.({
                            sql: queryToExecute,
                            connectionName: resolvedConnectionName,
                            documentUri,
                            errorMessage: 'Query execution cancelled by user',
                        });
                        logBatch(outputChannel, logCallback, `Skipping query ${i + 1}/${queries.length}: execution cancelled by user.`);
                        return allResults;
                    }
                    assertExecutionCurrent(_batchOptions.isExecutionCurrent);

                    if (queryStartCallback && !executionId) {
                        executionId = queryStartCallback(i, queryToExecute, resolvedConnectionName);
                        currentExecutionId = executionId;
                    }

                    if (documentUri && streamingManager.isAborted(documentUri)) {
                        const durationMs = Date.now() - startTime;
                        emitQueryStatus(
                            queryEndCallback,
                            _terminalExecutionIds,
                            executionId,
                            0,
                            durationMs,
                            'cancelled',
                            'Query cancelled',
                        );
                        throw new Error('Query cancelled');
                    }

                    const { queryTimeout, rowLimit } = getQueryConfig();

                    let executionResult: Awaited<ReturnType<typeof streamingManager.executeAndFetch>>;
                    try {
                        executionResult = await streamingManager.executeAndFetch(
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
                    } catch (executionError: unknown) {
                        currentFailureCameFromExecution = true;
                        throw executionError;
                    }
                    assertExecutionCurrent(_batchOptions.isExecutionCurrent);

                    const {
                        results: batchResults,
                        error: batchError,
                        recordsAffected: batchRecordsAffected,
                        status: batchStatus,
                    } = executionResult;

                    const totalRows = batchResults?.reduce(
                        (sum, rs) => sum + (rs.rows?.length || 0),
                        0,
                    ) || 0;

                    if (batchStatus === 'cancelled' || (documentUri && streamingManager.isAborted(documentUri))) {
                        const durationMs = Date.now() - startTime;
                        emitQueryStatus(
                            queryEndCallback,
                            _terminalExecutionIds,
                            executionId,
                            totalRows,
                            durationMs,
                            'cancelled',
                            'Query cancelled',
                        );
                        throw new Error('Query cancelled');
                    }

                    if (batchError) {
                        currentFailureCameFromExecution = true;
                        throw batchError;
                    }

                    const durationMs = Date.now() - startTime;
                    if (logCallback) {
                        let logMessage = `Executed query ${i + 1}/${queries.length} in ${durationMs}ms`;
                        if (batchRecordsAffected !== undefined && batchRecordsAffected > 0) {
                            logMessage += ` (records affected: ${batchRecordsAffected})`;
                        }
                        logCallback(logMessage);
                    }

                    const statementSql = getSingleExecutableStatement(queryToExecute);
                    const mappedBatchResults = batchResults?.map(rs =>
                        mapBatchResult(rs, queryToExecute, statementSql, batchRecordsAffected),
                    );
                    if (mappedBatchResults && mappedBatchResults.length > 0) {
                        allResults.push(...mappedBatchResults);
                    } else if (
                        statementSql !== undefined
                        && isRowsAffectedStatement(statementSql)
                        && batchRecordsAffected !== undefined
                        && batchRecordsAffected >= 0
                    ) {
                        allResults.push(createRowsAffectedResult(queryToExecute, batchRecordsAffected));
                    }

                    if (resultCallback) {
                        if (mappedBatchResults && mappedBatchResults.length > 0) {
                            resultCallback(mappedBatchResults);
                        } else if (
                            statementSql !== undefined
                            && isRowsAffectedStatement(statementSql)
                            && batchRecordsAffected !== undefined
                            && batchRecordsAffected >= 0
                        ) {
                            resultCallback([createRowsAffectedResult(queryToExecute, batchRecordsAffected)]);
                        }
                    }

                    await _batchOptions.onStatementSucceeded?.({
                        sql: queryToExecute,
                        connectionName: resolvedConnectionName,
                        documentUri,
                        connection,
                    });
                    assertExecutionCurrent(_batchOptions.isExecutionCurrent);
                    emitQueryStatus(
                        queryEndCallback,
                        _terminalExecutionIds,
                        executionId,
                        totalRows,
                        durationMs,
                        'success',
                    );
                    logQueryToHistoryAsync(
                        historyManager,
                        details.host,
                        historyDatabase,
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
                    currentQueryAllowsRetry = false;
                } catch (err: unknown) {
                    const cancellationRequested =
                        isBatchCancellationRequested(documentUri) || isCancellationError(err);
                    const brokenConnection = currentFailureCameFromExecution
                        && !cancellationRequested
                        && isConnectionBrokenError(err);
                    currentFailureWillRetry =
                        !cancellationRequested
                        && !_isRetry
                        && brokenConnection
                        && currentQueryAllowsRetry
                        && documentUri !== undefined
                        && keepConnectionOpen;
                    if (currentFailureWillRetry) {
                        throw err;
                    }

                    const reportedError = cancellationRequested
                        ? new Error('Query cancelled', { cause: err })
                        : brokenConnection
                        && !_isRetry
                        && !currentQueryAllowsRetry
                        && _batchOptions.retryOnBrokenConnection !== false
                        && documentUri !== undefined
                        && keepConnectionOpen
                        ? createRetrySafetyError(err, false)
                        : err;
                    const errMsg = reportedError instanceof Error
                        ? reportedError.message
                        : String(reportedError);
                    const isCancelled = isCancellationError(reportedError);
                    logQueryToHistoryAsync(
                        historyManager,
                        details.host,
                        historyDatabase,
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
                        err: reportedError,
                        queryIndex: i,
                        sql: queryToExecute,
                        executionId,
                        startTime,
                        batchOptions: _batchOptions,
                        queryEndCallback,
                        terminalExecutionIds: _terminalExecutionIds,
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
            // A cancel can arrive while the broken connection is being
            // unwound. Do this check before cleanup completes so the outer
            // handler cannot turn that cancellation into a reconnect retry.
            if (currentFailureWillRetry && isBatchCancellationRequested(documentUri)) {
                currentFailureWillRetry = false;
            }
            if (shouldCloseConnection) {
                await connection.close();
            }
        }
    } catch (error: unknown) {
      assertExecutionCurrent(_batchOptions.isExecutionCurrent);
      const retryExecutionId = currentExecutionId;
      const retryQueryIndex = currentQueryIndex;
      if (isBatchCancellationRequested(documentUri)) {
        currentFailureWillRetry = false;
        const alreadyTerminal = retryExecutionId !== undefined
          && _terminalExecutionIds.has(retryExecutionId);
        if (!alreadyTerminal) {
          emitQueryStatus(
            queryEndCallback,
            _terminalExecutionIds,
            retryExecutionId,
            0,
            0,
            'cancelled',
            'Query cancelled',
          );
          const cancelledQuery = queries[retryQueryIndex];
          if (cancelledQuery !== undefined) {
            _batchOptions.onStatementFailed?.({
              sql: cancelledQuery,
              connectionName: resolvedConnectionName,
              documentUri,
              errorMessage: 'Query cancelled',
            });
          }
        }
        await handleBatchError(new Error('Query cancelled', { cause: error }), connManager, outputChannel, logCallback, documentUri);
      }
      if (currentFailureWillRetry) {
        try {
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
                _terminalExecutionIds,
              ),
            retryExecutionId && queryEndCallback
              ? retryMessage => {
                  emitQueryStatus(
                    queryEndCallback,
                    _terminalExecutionIds,
                    retryExecutionId,
                    0,
                    0,
                    'retrying',
                    retryMessage,
                  );
                }
              : undefined,
            _batchOptions.isExecutionCurrent,
          );
          if (retryResult.handled) {
              return retryResult.result;
          }
        } catch (retryError: unknown) {
          const retryErrorMessage = retryError instanceof Error
            ? retryError.message
            : String(retryError);
          const retryWasCancelled =
            isCancellationError(retryError) || isBatchCancellationRequested(documentUri);
          const retryWasAlreadyTerminal =
            retryExecutionId !== undefined && _terminalExecutionIds.has(retryExecutionId);
          emitQueryStatus(
            queryEndCallback,
            _terminalExecutionIds,
            retryExecutionId,
            0,
            0,
            retryWasCancelled ? 'cancelled' : 'error',
            retryWasCancelled ? 'Query cancelled' : retryErrorMessage,
          );
          if (retryWasCancelled && retryExecutionId !== undefined && !retryWasAlreadyTerminal) {
            _batchOptions.onStatementFailed?.({
              sql: queries[retryQueryIndex] ?? '',
              connectionName: resolvedConnectionName,
              documentUri,
              errorMessage: 'Query cancelled',
            });
          }
          throw retryError;
        }
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
  queryEndCallback?: QueryEndCallback,
  _outputChannel?: vscode.OutputChannel,
  _startIndex: number = 0,
  _resumeExecutionId?: string,
  _batchOptions: BatchQueryRunOptions = {},
  _terminalExecutionIds: Set<string> = new Set(),
): Promise<void> {
  const connManager = connectionManager || new ConnectionManager(context);
  const keepConnectionOpen = documentUri
    ? connManager.getDocumentKeepConnectionOpen(documentUri)
    : true;

  const outputChannel = setupBatchLogger(logCallback, queries.length, "streaming", _outputChannel);

    let currentQueryIndex = _startIndex;
    let currentExecutionId: string | undefined = _resumeExecutionId;
    let currentQueryAllowsRetry: boolean;
    let currentFailureWillRetry = false;
    let currentFailureCameFromExecution: boolean;
    let currentQueryDeliveredChunk: boolean;
    let currentQueryRows = 0;

    const resolvedConnectionName = resolveBatchConnectionName(connManager, documentUri);
    if (documentUri && !_isRetry) {
        streamingManager.clearAborted(documentUri);
    }
    assertExecutionCurrent(_batchOptions.isExecutionCurrent);

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
        const historyDatabase = documentUri && typeof connManager.getEffectiveDatabase === 'function'
            ? (await connManager.getEffectiveDatabase(documentUri, resolvedConnectionName)) ?? details.database
            : details.database;

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

        try {
            assertExecutionCurrent(_batchOptions.isExecutionCurrent);
            connection.on("notice", noticeHandler);

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
                assertExecutionCurrent(_batchOptions.isExecutionCurrent);
                currentQueryIndex = i;
                const query = queries[i];
                if (documentUri && streamingManager.isAborted(documentUri)) {
                    _batchOptions.onStatementFailed?.({
                        sql: query,
                        connectionName: resolvedConnectionName,
                        documentUri,
                        errorMessage: 'Query cancelled',
                    });
                    throw new Error('Query cancelled');
                }
                logBatch(outputChannel, logCallback, `Executing query ${i + 1}/${queries.length}...`);

                let executionId: string | undefined =
                    i === _startIndex ? _resumeExecutionId : undefined;
                currentExecutionId = executionId;
                const startTime = Date.now();
                let queryToExecute = query;
                currentQueryAllowsRetry = false;
                currentFailureWillRetry = false;
                currentFailureCameFromExecution = false;
                currentQueryDeliveredChunk = false;
                currentQueryRows = 0;

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
                    assertExecutionCurrent(_batchOptions.isExecutionCurrent);
                    queryToExecute = preparedQuery.sql;
                    currentQueryAllowsRetry =
                        _batchOptions.retryOnBrokenConnection !== false &&
                        !preparedQuery.hasExecutableMacro &&
                        isSafeToRetryAfterBrokenConnection(queryToExecute);
                    if (queryToExecute.trim().length === 0) {
                        logBatch(outputChannel, logCallback, `Skipping query ${i + 1}/${queries.length}: variable directive only.`);
                        continue;
                    }

                    if (_batchOptions.confirmSafeExecute && !(await _batchOptions.confirmSafeExecute(queryToExecute, i))) {
                        _batchOptions.onStatementFailed?.({
                            sql: queryToExecute,
                            connectionName: resolvedConnectionName,
                            documentUri,
                            errorMessage: 'Query execution cancelled by user',
                        });
                        logBatch(outputChannel, logCallback, `Skipping query ${i + 1}/${queries.length}: execution cancelled by user.`);
                        return;
                    }
                    assertExecutionCurrent(_batchOptions.isExecutionCurrent);

                    if (queryStartCallback && !executionId) {
                        executionId = queryStartCallback(i, queryToExecute, resolvedConnectionName);
                        currentExecutionId = executionId;
                    }

                    if (documentUri && streamingManager.isAborted(documentUri)) {
                        const durationMs = Date.now() - startTime;
                        emitQueryStatus(
                            queryEndCallback,
                            _terminalExecutionIds,
                            executionId,
                            0,
                            durationMs,
                            'cancelled',
                            'Query cancelled',
                        );
                        throw new Error('Query cancelled');
                    }

                    const { queryTimeout, rowLimit } = getQueryConfig();

                    let executionResult: Awaited<ReturnType<typeof streamingManager.executeWithStreaming>>;
                    try {
                        executionResult = await streamingManager.executeWithStreaming(
                            connection,
                            queryToExecute,
                            rowLimit,
                            chunkSize,
                            queryTimeout,
                            documentUri,
                            async (chunk: StreamingChunk) => {
                                assertExecutionCurrent(_batchOptions.isExecutionCurrent);
                                currentQueryDeliveredChunk = true;
                                currentQueryRows = Math.max(currentQueryRows, chunk.totalRowsSoFar);
                                if (chunkCallback) {
                                    await chunkCallback(i, chunk, queryToExecute);
                                }
                                assertExecutionCurrent(_batchOptions.isExecutionCurrent);
                            },
                            sessionId,
                            connManager,
                            maxRows,
                            createDropSessionCallback(connManager, documentUri),
                        );
                    } catch (executionError: unknown) {
                        currentFailureCameFromExecution = true;
                        throw executionError;
                    }
                    assertExecutionCurrent(_batchOptions.isExecutionCurrent);

                    const { totalRows, limitReached, error, recordsAffected, status, timing } = executionResult;
                    currentQueryRows = Math.max(currentQueryRows, totalRows);

                    if (timing && [
                        timing.resultCompletionWaitMs,
                        timing.readerCloseMs,
                        timing.chunkDeliveryMs,
                    ].some(durationMs => (durationMs ?? 0) >= SLOW_STREAMING_PHASE_MS)) {
                        logBatch(
                            outputChannel,
                            logCallback,
                            `[StreamingTiming] rows=${timing.rowsRead ?? totalRows} `
                            + `executeReaderMs=${timing.executeReaderMs ?? '-'} `
                            + `resultCompletionWaitMs=${timing.resultCompletionWaitMs ?? '-'} `
                            + `readerCloseMs=${timing.readerCloseMs ?? '-'} `
                            + `chunkDeliveryMs=${timing.chunkDeliveryMs ?? '-'} `
                            + `totalMs=${timing.totalMs ?? '-'}`,
                        );
                    }

                    if (status === 'cancelled' || (documentUri && streamingManager.isAborted(documentUri))) {
                        const durationMs = Date.now() - startTime;
                        emitQueryStatus(
                            queryEndCallback,
                            _terminalExecutionIds,
                            executionId,
                            totalRows,
                            durationMs,
                            'cancelled',
                            'Query cancelled',
                        );
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
                        currentFailureCameFromExecution = true;
                        throw error;
                    }
                    await _batchOptions.onStatementSucceeded?.({
                        sql: queryToExecute,
                        connectionName: resolvedConnectionName,
                        documentUri,
                        connection,
                    });
                    assertExecutionCurrent(_batchOptions.isExecutionCurrent);
                    emitQueryStatus(
                        queryEndCallback,
                        _terminalExecutionIds,
                        executionId,
                        totalRows,
                        durationMs,
                        'success',
                    );
                    logQueryToHistoryAsync(
                        historyManager,
                        details.host,
                        historyDatabase,
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
                    currentQueryAllowsRetry = false;
                } catch (err: unknown) {
                    const cancellationRequested =
                        isBatchCancellationRequested(documentUri) || isCancellationError(err);
                    const brokenConnection = currentFailureCameFromExecution
                        && !cancellationRequested
                        && isConnectionBrokenError(err);
                    currentFailureWillRetry =
                        !cancellationRequested
                        && !_isRetry
                        && brokenConnection
                        && currentQueryAllowsRetry
                        && !currentQueryDeliveredChunk
                        && documentUri !== undefined
                        && keepConnectionOpen;
                    if (currentFailureWillRetry) {
                        throw err;
                    }

                    const shouldExplainRetryRefusal =
                        brokenConnection
                        && _batchOptions.retryOnBrokenConnection !== false
                        && documentUri !== undefined
                        && keepConnectionOpen
                        && (currentQueryDeliveredChunk || (!_isRetry && !currentQueryAllowsRetry));
                    const reportedError = cancellationRequested
                        ? new Error('Query cancelled', { cause: err })
                        : shouldExplainRetryRefusal
                        ? createRetrySafetyError(err, currentQueryDeliveredChunk)
                        : err;
                    const errMsg = reportedError instanceof Error
                        ? reportedError.message
                        : String(reportedError);
                    const isCancelled = isCancellationError(reportedError);
                    logQueryToHistoryAsync(
                        historyManager,
                        details.host,
                        historyDatabase,
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
                        err: reportedError,
                        queryIndex: i,
                        sql: queryToExecute,
                        executionId,
                        startTime,
                        batchOptions: _batchOptions,
                        queryEndCallback,
                        terminalExecutionIds: _terminalExecutionIds,
                        rowCount: currentQueryRows,
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
            // Preserve a cancellation which races with broken-connection
            // cleanup; a retry is never valid after the user aborts.
            if (currentFailureWillRetry && isBatchCancellationRequested(documentUri)) {
                currentFailureWillRetry = false;
            }
            if (shouldCloseConnection) {
                await connection.close();
            }
        }
    } catch (error: unknown) {
      assertExecutionCurrent(_batchOptions.isExecutionCurrent);
      const retryExecutionId = currentExecutionId;
      const retryQueryIndex = currentQueryIndex;
      if (isBatchCancellationRequested(documentUri)) {
        currentFailureWillRetry = false;
        const alreadyTerminal = retryExecutionId !== undefined
          && _terminalExecutionIds.has(retryExecutionId);
        if (!alreadyTerminal) {
          emitQueryStatus(
            queryEndCallback,
            _terminalExecutionIds,
            retryExecutionId,
            currentQueryRows,
            0,
            'cancelled',
            'Query cancelled',
          );
          const cancelledQuery = queries[retryQueryIndex];
          if (cancelledQuery !== undefined) {
            _batchOptions.onStatementFailed?.({
              sql: cancelledQuery,
              connectionName: resolvedConnectionName,
              documentUri,
              errorMessage: 'Query cancelled',
            });
          }
        }
        await handleBatchError(new Error('Query cancelled', { cause: error }), connManager, outputChannel, logCallback, documentUri);
      }
      if (currentFailureWillRetry) {
        try {
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
                _terminalExecutionIds,
              ),
            retryExecutionId && queryEndCallback
              ? retryMessage => {
                  emitQueryStatus(
                    queryEndCallback,
                    _terminalExecutionIds,
                    retryExecutionId,
                    0,
                    0,
                    'retrying',
                    retryMessage,
                  );
                }
              : undefined,
            _batchOptions.isExecutionCurrent,
          );
          if (retryResult.handled) {
              return retryResult.result;
          }
        } catch (retryError: unknown) {
          const retryErrorMessage = retryError instanceof Error
            ? retryError.message
            : String(retryError);
          const retryWasCancelled =
            isCancellationError(retryError) || isBatchCancellationRequested(documentUri);
          const retryWasAlreadyTerminal =
            retryExecutionId !== undefined && _terminalExecutionIds.has(retryExecutionId);
          emitQueryStatus(
            queryEndCallback,
            _terminalExecutionIds,
            retryExecutionId,
            currentQueryRows,
            0,
            retryWasCancelled ? 'cancelled' : 'error',
            retryWasCancelled ? 'Query cancelled' : retryErrorMessage,
          );
          if (retryWasCancelled && retryExecutionId !== undefined && !retryWasAlreadyTerminal) {
            _batchOptions.onStatementFailed?.({
              sql: queries[retryQueryIndex] ?? '',
              connectionName: resolvedConnectionName,
              documentUri,
              errorMessage: 'Query cancelled',
            });
          }
          throw retryError;
        }
      }

        await handleBatchError(error, connManager, outputChannel, logCallback, documentUri);
    }
}
