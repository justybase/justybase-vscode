import * as vscode from "vscode";
import { ConnectionManager } from "./connectionManager";
import {
  collectQueryVariableValues,
  resolveQueryVariablesWithValues,
} from "./variableResolver";
import { QueryResult } from "../types";
import { isConnectionTimeoutError } from "./connectionUtils";
import { ResultFormatter } from "./streaming";
import { streamingManager } from "./queryCancellation";
import {
  OutputLogger,
  normalizeUriKey,
  createLogger,
  logOutput,
  isConnectionBrokenError,
  formatQueryRunnerErrorMessage,
  resolveConnectionName as resolveConnectionNameUtil,
} from "./queryRunnerUtils";
import {
  getConnectionForDocument,
  logQueryToHistory,
  handleBusyConnectionError,
} from "./queryRunnerHelpers";
import {
  createDropSessionCallback,
  createMacroFileReadContext,
  executeMacroExport,
  executeMacroQuery,
  getQueryConfig,
  isCancellationError,
} from "./queryBatchExecutor";
import {
  isBusyConnectionError,
  isConnectionRecoveryError,
  waitForPersistentConnectionReady,
} from "./connectionReadiness";
import { metadataSessionSweeper } from "../metadata/metadataSessionSweeper";
import {
  logMetadataQueryTiming,
  type MetadataQueryContext,
  type MetadataQueryTiming,
} from "../metadata/metadataQueryDiagnostics";
import type { NzConnection } from "../types";
import {
  assertExecutionCurrent,
  isExecutionSuperseded,
  type ExecutionCurrentCheck,
} from "./executionGuard";
import {
  createRetrySafetyError,
  isSafeToRetryAfterBrokenConnection,
} from './queryRetrySafety';

// ---------------------------------------------------------------------------
// Connection resolution
// ---------------------------------------------------------------------------

export function resolveConnectionName(
  connManager: ConnectionManager,
  connectionName?: string,
  documentUri?: string,
): string {
  return resolveConnectionNameUtil(connManager, {
    connectionName,
    documentUri,
  });
}

// ---------------------------------------------------------------------------
// runQueryRaw — single query execution
// ---------------------------------------------------------------------------

export interface RunQueryRawOptions {
  context: vscode.ExtensionContext;
  query: string;
  silent?: boolean;
  connectionManager?: ConnectionManager;
  connectionName?: string;
  documentUri?: string;
  logCallback?: (msg: string) => void;
  extensionUri?: vscode.Uri;
  maxRows?: number;
  isUserQuery?: boolean;
  /** Overrides global query.executionTimeout for this call only (seconds). */
  timeoutSeconds?: number;
  /** Called once with the server-side session id when it can be captured. */
  onSessionId?: (sessionId: string) => void;
  /** Optional context for client-observed metadata query diagnostics. */
  metadataContext?: MetadataQueryContext;
  /** Queue wait measured by the shared metadata limiter. */
  metadataQueueWaitMs?: number;
  /** Receives driver-observed execution timing for one metadata SQL command. */
  onMetadataExecutionComplete?: (timing: MetadataQueryTiming) => void;
  /**
   * Caller-owned, already connected session. Used by one bounded metadata
   * refresh to avoid a new TCP/login handshake for every catalog query.
   */
  connectionOverride?: NzConnection;
  /** Shared state associated with `connectionOverride`, including its SID. */
  metadataSession?: MetadataQuerySession;
  /** Prevents a retired execution from reconnecting or reporting stale success. */
  isExecutionCurrent?: ExecutionCurrentCheck;
}

/** State shared by sequential metadata queries on one physical connection. */
export interface MetadataQuerySession {
  connection: NzConnection;
  sessionId?: string;
}

class ExecutedSqlError extends Error {
  public readonly expandedSql: string;
  public readonly hadExecutableMacro: boolean;

  public constructor(error: unknown, expandedSql: string, hadExecutableMacro: boolean) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = 'ExecutedSqlError';
    this.expandedSql = expandedSql;
    this.hadExecutableMacro = hadExecutableMacro;
  }
}

function isSafeExecutedSqlRetry(originalSql: string, error: unknown): boolean {
  return error instanceof ExecutedSqlError
    && !error.hadExecutableMacro
    && isSafeToRetryAfterBrokenConnection(originalSql)
    && isSafeToRetryAfterBrokenConnection(error.expandedSql);
}

export function isRunQueryRawOptions(
  value: unknown | RunQueryRawOptions,
): value is RunQueryRawOptions {
  return typeof (value as RunQueryRawOptions).query === "string";
}

export async function runQueryRaw(
  options: RunQueryRawOptions,
): Promise<QueryResult>;
export async function runQueryRaw(
  context: unknown,
  query: string,
  silent?: boolean,
  connectionManager?: ConnectionManager,
  connectionName?: string,
  documentUri?: string,
  logCallback?: (msg: string) => void,
  extensionUri?: vscode.Uri,
  maxRows?: number,
  isUserQuery?: boolean,
): Promise<QueryResult>;
export async function runQueryRaw(
  contextOrOptions: unknown | RunQueryRawOptions,
  queryInput?: string,
  silentInput: boolean = false,
  connectionManagerInput?: ConnectionManager,
  connectionNameInput?: string,
  documentUriInput?: string,
  logCallbackInput?: (msg: string) => void,
  _extensionUriInput?: vscode.Uri,
  maxRowsInput?: number,
  isUserQueryInput: boolean = true,
): Promise<QueryResult> {
  const options: RunQueryRawOptions = isRunQueryRawOptions(contextOrOptions)
    ? contextOrOptions
    : {
        context: contextOrOptions as vscode.ExtensionContext,
        query: queryInput || "",
        silent: silentInput,
        connectionManager: connectionManagerInput,
        connectionName: connectionNameInput,
        documentUri: documentUriInput,
        logCallback: logCallbackInput,
        extensionUri: _extensionUriInput,
        maxRows: maxRowsInput,
        isUserQuery: isUserQueryInput,
      };

  const {
    context,
    query,
    silent = false,
    connectionManager,
    connectionName,
    documentUri,
    logCallback,
    maxRows,
    isUserQuery = true,
    timeoutSeconds,
    onSessionId,
    metadataContext,
    metadataQueueWaitMs,
    onMetadataExecutionComplete,
    connectionOverride,
    metadataSession,
    isExecutionCurrent,
  } = options;

  const connManager = connectionManager || new ConnectionManager(context);
  const keepConnectionOpen = documentUri
    ? connManager.getDocumentKeepConnectionOpen(documentUri)
    : true;
  const logger = createLogger(silent, logCallback);

  const queryStartTime = Date.now();
  assertExecutionCurrent(isExecutionCurrent);

  logOutput(logger, "Executing query...");
  if (connectionName) {
    logOutput(logger, `Target Connection: ${connectionName}`);
  }

  // Resolve variables and connection name BEFORE try block so they're available in catch for retry
  let queryToExecute: string;
  let resolvedConnectionName: string;
  let promptValues: Record<string, string>;

  try {
    const macroFileContext = createMacroFileReadContext(documentUri);
    promptValues = await collectQueryVariableValues(
      query,
      silent,
      context,
      macroFileContext,
    );
    queryToExecute = query;
    resolvedConnectionName = resolveConnectionName(
      connManager,
      connectionName,
      documentUri,
    );
    assertExecutionCurrent(isExecutionCurrent);
  } catch (resolveError: unknown) {
    const errObj = resolveError as { message?: string };
    const errorMessage = `Error: ${errObj.message || String(resolveError)}`;
    logOutput(logger, errorMessage);
    throw new Error(errorMessage, { cause: resolveError });
  }

  const trackMetadataSession = !documentUri && !isUserQuery;

  if (queryToExecute.trim().length === 0) {
    const message = "No SQL to execute after processing variable directives.";
    logOutput(logger, message);
    return {
      columns: [],
      data: [],
      message,
      sql: queryToExecute,
    };
  }

  logOutput(logger, `Using connection: ${resolvedConnectionName}`);
  logOutput(logger, "Connecting to database...");

  try {
    const result = await executeRawQuery(
      connManager,
      resolvedConnectionName,
      keepConnectionOpen,
      documentUri,
      queryToExecute,
      maxRows,
      logger,
      promptValues,
      timeoutSeconds,
      false,
      onSessionId,
      metadataContext,
      trackMetadataSession,
      metadataQueueWaitMs,
      connectionOverride,
      metadataSession,
      isExecutionCurrent,
      onMetadataExecutionComplete,
    );
    assertExecutionCurrent(isExecutionCurrent);

    const durationMs = Date.now() - queryStartTime;

    // Log to history with status
    await logQueryToHistory(
      context,
      connManager,
      resolvedConnectionName,
      query,
      isUserQuery,
      documentUri,
      'success',
      durationMs,
      result.rowsAffected,
    );

    return result;
  } catch (error: unknown) {
    if (isExecutionSuperseded(error) || (isExecutionCurrent && !isExecutionCurrent())) {
      assertExecutionCurrent(isExecutionCurrent);
    }
    let activeError: unknown = error;
    const durationMs = Date.now() - queryStartTime;
    const isCancelled = isCancellationError(error);
    if (
      isConnectionTimeoutError(error)
      && !isCancelled
      && documentUri
      && keepConnectionOpen
      && isSafeExecutedSqlRetry(queryToExecute, error)
    ) {
      assertExecutionCurrent(isExecutionCurrent);
      logOutput(
        logger,
        "Netezza connection timeout detected. Resetting the tab connection and retrying once...",
      );
      await connManager.closeDocumentPersistentConnection(documentUri);
      assertExecutionCurrent(isExecutionCurrent);

      try {
        const result = await executeRawQuery(
          connManager,
          resolvedConnectionName,
          keepConnectionOpen,
          documentUri,
          queryToExecute,
          maxRows,
          logger,
          promptValues,
          timeoutSeconds,
          false,
          onSessionId,
          metadataContext,
          trackMetadataSession,
          metadataQueueWaitMs,
          connectionOverride,
          metadataSession,
          isExecutionCurrent,
          onMetadataExecutionComplete,
        );
        assertExecutionCurrent(isExecutionCurrent);

        const retryDurationMs = Date.now() - queryStartTime;
        await logQueryToHistory(
          context,
          connManager,
          resolvedConnectionName,
          query,
          isUserQuery,
          documentUri,
          'success',
          retryDurationMs,
          result.rowsAffected,
        );
        return result;
      } catch (retryError: unknown) {
        assertExecutionCurrent(isExecutionCurrent);
        activeError = retryError;
        logOutput(
          logger,
          `Netezza connection retry failed: ${(retryError as { message?: string }).message || String(retryError)}`,
        );
      }
    } else if (
      isConnectionTimeoutError(error)
      && !isCancelled
      && documentUri
      && keepConnectionOpen
      && error instanceof ExecutedSqlError
    ) {
      activeError = createRetrySafetyError(error, false);
    }

    // Silent auxiliary queries (refresh, All rows): wait and retry once when connection is still busy.
    if (
      isBusyConnectionError(error)
      && !isCancelled
      && documentUri
      && keepConnectionOpen
      && silent
    ) {
      logOutput(
        logger,
        "Connection is busy. Waiting for the previous command to finish...",
      );
      try {
        await waitForPersistentConnectionReady(
          connManager,
          documentUri,
          resolvedConnectionName,
        );
        assertExecutionCurrent(isExecutionCurrent);
        const result = await executeRawQuery(
          connManager,
          resolvedConnectionName,
          keepConnectionOpen,
          documentUri,
          queryToExecute,
          maxRows,
          logger,
          promptValues,
          timeoutSeconds,
          false,
          onSessionId,
          metadataContext,
          trackMetadataSession,
          metadataQueueWaitMs,
          connectionOverride,
          metadataSession,
          isExecutionCurrent,
          onMetadataExecutionComplete,
        );
        assertExecutionCurrent(isExecutionCurrent);

        const retryDurationMs = Date.now() - queryStartTime;
        await logQueryToHistory(
          context,
          connManager,
          resolvedConnectionName,
          query,
          isUserQuery,
          documentUri,
          'success',
          retryDurationMs,
          result.rowsAffected,
        );

        return result;
      } catch (retryError: unknown) {
        assertExecutionCurrent(isExecutionCurrent);
        activeError = retryError;
      }
    }

    assertExecutionCurrent(isExecutionCurrent);

    // Check for busy connection
    if (
      await handleBusyConnectionError(
        activeError,
        connManager,
        logger,
        documentUri,
        silent,
      )
    ) {
      const busyMsg = `Connection is busy. Use the popup actions to resolve.`;
      await logQueryToHistory(
        context,
        connManager,
        resolvedConnectionName,
        query,
        isUserQuery,
        documentUri,
        'error',
        durationMs,
        undefined,
        busyMsg,
      );
      throw new Error(busyMsg, {
        cause: error,
      });
    }

    const finalErrMsg =
      activeError instanceof Error
        ? activeError.message
        : String(activeError);
    const errorMessage = formatQueryRunnerErrorMessage(finalErrMsg);
    logOutput(logger, errorMessage);

    await logQueryToHistory(
      context,
      connManager,
      resolvedConnectionName,
      query,
      isUserQuery,
      documentUri,
      isCancelled ? 'cancelled' : 'error',
      durationMs,
      undefined,
      errorMessage,
    );

    throw activeError instanceof Error
      ? activeError
      : new Error(finalErrMsg, { cause: activeError });
  }
}

/**
 * Execute a raw query against a connection (extracted from runQueryRaw to eliminate retry duplication).
 *
 * Macro directives are expanded first, then the complete SQL payload is sent
 * to the driver without statement splitting. {@link QueryResult.expandedSql}
 * preserves that full expanded payload.
 */
export async function executeRawQuery(
  connManager: ConnectionManager,
  resolvedConnectionName: string,
  keepConnectionOpen: boolean,
  documentUri: string | undefined,
  queryToExecute: string,
  maxRows: number | undefined,
  logger: OutputLogger,
  macroValues: Record<string, string> = {},
  timeoutSeconds?: number,
  isRetryAttempt = false,
  onSessionId?: (sessionId: string) => void,
  metadataContext?: MetadataQueryContext,
  trackMetadataSession = false,
  metadataQueueWaitMs?: number,
  connectionOverride?: NzConnection,
  metadataSession?: MetadataQuerySession,
  isExecutionCurrent?: ExecutionCurrentCheck,
  onMetadataExecutionComplete?: (timing: MetadataQueryTiming) => void,
): Promise<QueryResult> {
  assertExecutionCurrent(isExecutionCurrent);
  try {
    const result = await executeRawQueryOnce(
      connManager,
      resolvedConnectionName,
      keepConnectionOpen,
      documentUri,
      queryToExecute,
      maxRows,
      logger,
      macroValues,
      timeoutSeconds,
      onSessionId,
      metadataContext,
      trackMetadataSession,
      metadataQueueWaitMs,
      connectionOverride,
      metadataSession,
      isExecutionCurrent,
      onMetadataExecutionComplete,
    );
    assertExecutionCurrent(isExecutionCurrent);
    return result;
  } catch (error: unknown) {
    assertExecutionCurrent(isExecutionCurrent);
    const brokenPersistentConnection =
      !isRetryAttempt
      && !isCancellationError(error)
      && keepConnectionOpen
      && documentUri
      && isConnectionBrokenError(error);
    if (brokenPersistentConnection && isSafeExecutedSqlRetry(queryToExecute, error)) {
      logOutput(
        logger,
        "Connection was closed by server. Reconnecting and retrying...",
      );
      await connManager.closeDocumentPersistentConnection(documentUri);
      assertExecutionCurrent(isExecutionCurrent);
      try {
        return await executeRawQuery(
          connManager,
          resolvedConnectionName,
          keepConnectionOpen,
          documentUri,
          queryToExecute,
          maxRows,
          logger,
          macroValues,
          timeoutSeconds,
          true,
          onSessionId,
          metadataContext,
          trackMetadataSession,
          metadataQueueWaitMs,
          connectionOverride,
          metadataSession,
          isExecutionCurrent,
          onMetadataExecutionComplete,
        );
      } catch (retryError: unknown) {
        assertExecutionCurrent(isExecutionCurrent);
        const retryErrObj = retryError as { message?: string };
        const retryErrorMessage = `Error (after reconnect attempt): ${retryErrObj.message || String(retryError)}`;
        logOutput(logger, retryErrorMessage);
        throw new Error(retryErrorMessage, { cause: retryError });
      }
    }
    if (brokenPersistentConnection && error instanceof ExecutedSqlError) {
      throw createRetrySafetyError(error, false);
    }
    throw error;
  }
}

async function executeRawQueryOnce(
  connManager: ConnectionManager,
  resolvedConnectionName: string,
  keepConnectionOpen: boolean,
  documentUri: string | undefined,
  queryToExecute: string,
  maxRows: number | undefined,
  logger: OutputLogger,
  macroValues: Record<string, string> = {},
  timeoutSeconds?: number,
  onSessionId?: (sessionId: string) => void,
  metadataContext?: MetadataQueryContext,
  trackMetadataSession = false,
  metadataQueueWaitMs?: number,
  connectionOverride?: NzConnection,
  metadataSession?: MetadataQuerySession,
  isExecutionCurrent?: ExecutionCurrentCheck,
  onMetadataExecutionComplete?: (timing: MetadataQueryTiming) => void,
): Promise<QueryResult> {
  assertExecutionCurrent(isExecutionCurrent);
  const { connection, shouldCloseConnection } = connectionOverride
    ? { connection: connectionOverride, shouldCloseConnection: false }
    : await getConnectionForDocument(
      connManager,
      resolvedConnectionName,
      keepConnectionOpen,
      documentUri,
    );
  const timingStartedAt = Date.now();
  let executionTiming: MetadataQueryTiming | undefined;
  let operationStatus: MetadataQueryTiming['status'] = 'success';
  let expandedSqlForRetry: string | undefined;
  let executionAttempted = false;
  let executedExternalMacro = false;
  let noticeHandler: ((msg: unknown) => void) | undefined;
  let sessionId = metadataSession?.sessionId;

  try {
    // The connection may have finished opening after this execution was
    // retired. Enter cleanup ownership before checking the lease.
    assertExecutionCurrent(isExecutionCurrent);
    logOutput(logger, "Connected.");

    if (logger.outputChannel) {
      noticeHandler = (msg: unknown) => {
        const notification = msg as { message: string };
        logger.outputChannel!.appendLine(`NOTICE: ${notification.message}`);
      };
      connection.on("notice", noticeHandler);
    }

    if (!sessionId) {
      try {
        const sidCmd = connection.createCommand("SELECT CURRENT_SID");
        const sidReader = await sidCmd.executeReader();
        if (await sidReader.read()) {
          sessionId = String(sidReader.getValue(0));
          if (metadataSession) {
            metadataSession.sessionId = sessionId;
          }
          if (documentUri) {
            connManager.setDocumentLastSessionId(
              normalizeUriKey(documentUri),
              sessionId,
            );
          }
        }
        await sidReader.close();
      } catch {
        // Ignore if we can't get SID
      }
    }
    assertExecutionCurrent(isExecutionCurrent);

    if (sessionId) {
      if (trackMetadataSession) {
        metadataSessionSweeper.register(resolvedConnectionName, sessionId);
      }
      onSessionId?.(sessionId);
    }

    queryToExecute = await resolveQueryVariablesWithValues(
      queryToExecute,
      macroValues,
      (message) => logOutput(logger, message),
      {
        query: sql => executeMacroQuery(
          connection,
          sql,
          documentUri,
          sessionId,
          connManager,
        ),
        exporter: request => executeMacroExport(
          request,
          sql => executeMacroQuery(
            connection,
            sql,
            documentUri,
            sessionId,
            connManager,
          ),
          (message) => logOutput(logger, message),
        ),
        ...createMacroFileReadContext(documentUri),
        onExecutableMacro: () => {
          executedExternalMacro = true;
        },
      },
    );
    assertExecutionCurrent(isExecutionCurrent);
    if (queryToExecute.trim().length === 0) {
      const message = "No SQL to execute after processing variable directives.";
      logOutput(logger, message);
      return {
        columns: [],
        data: [],
        message,
        sql: queryToExecute,
      };
    }

    const expandedSql = queryToExecute;
    expandedSqlForRetry = expandedSql;
    const { queryTimeout, rowLimit } = getQueryConfig();
    const effectiveTimeout = timeoutSeconds ?? queryTimeout;
    logOutput(logger, "Executing SQL on server...");

    executionAttempted = true;
    const { results, error, recordsAffected, timing } =
      await streamingManager.executeAndFetch(
        connection,
        queryToExecute,
        maxRows !== undefined ? maxRows : rowLimit,
        effectiveTimeout,
        documentUri,
        sessionId,
        connManager,
        undefined,
        createDropSessionCallback(connManager, documentUri),
      );
    assertExecutionCurrent(isExecutionCurrent);
    executionTiming = timing;
    if (error) {
      operationStatus = timing?.status ?? 'error';
      if (keepConnectionOpen && documentUri && isConnectionRecoveryError(error)) {
        void waitForPersistentConnectionReady(
          connManager,
          documentUri,
          resolvedConnectionName,
        ).catch(() => {
          // Best-effort recovery after surfacing the error to callers.
        });
      }
      throw error;
    }

    const columns = results[0]?.columns || [];
    const data = results[0]?.rows || [];
    const limitReached = results[0]?.limitReached || false;
    const rowsAffectedValue =
      recordsAffected !== undefined && recordsAffected >= 0
        ? recordsAffected
        : -1;

    if (columns.length > 0) {
      logOutput(logger, "Query completed.");
      logOutput(
        logger,
        rowsAffectedValue >= 0
          ? `Records affected: ${rowsAffectedValue}`
          : "Records affected: N/A",
      );
      return {
        columns,
        data,
        rowsAffected: rowsAffectedValue >= 0 ? rowsAffectedValue : undefined,
        limitReached,
        sql: queryToExecute,
        refreshSql: queryToExecute,
        expandedSql,
      };
    }

    const message = rowsAffectedValue >= 0
      ? `Records affected: ${rowsAffectedValue}`
      : "Query executed successfully.";
    logOutput(
      logger,
      rowsAffectedValue >= 0
        ? `Query executed successfully. Records affected: ${rowsAffectedValue}`
        : "Query executed successfully. Records affected: N/A",
    );
    return {
      columns: [],
      data: [],
      rowsAffected: rowsAffectedValue >= 0 ? rowsAffectedValue : undefined,
      message,
      sql: queryToExecute,
      refreshSql: queryToExecute,
      expandedSql,
    };
  } catch (error: unknown) {
    if (operationStatus === 'success') {
      operationStatus = isCancellationError(error)
        ? 'cancelled'
        : /timeout|timed out/i.test(error instanceof Error ? error.message : String(error))
          ? 'timeout'
          : 'error';
    }
    if (
      executionAttempted
      && expandedSqlForRetry !== undefined
      && !isExecutionSuperseded(error)
    ) {
      throw new ExecutedSqlError(error, expandedSqlForRetry, executedExternalMacro);
    }
    throw error;
  } finally {
    if (noticeHandler) {
      connection.removeListener("notice", noticeHandler);
    }
    if (shouldCloseConnection && connection) {
      await connection.close();
    }
    if (trackMetadataSession && sessionId) {
      metadataSessionSweeper.complete(resolvedConnectionName, sessionId);
    }
    const metadataTiming: MetadataQueryTiming = {
      ...executionTiming,
      queueWaitMs: metadataQueueWaitMs ?? executionTiming?.queueWaitMs ?? metadataContext?.queueWaitMs,
      sessionId,
      status: executionTiming?.status ?? operationStatus ?? 'success',
      totalMs: executionTiming?.totalMs ?? Date.now() - timingStartedAt,
    };
    onMetadataExecutionComplete?.(metadataTiming);
    if (metadataContext) {
      logMetadataQueryTiming(
        {
          ...metadataContext,
          connectionName: metadataContext.connectionName ?? resolvedConnectionName,
        },
        metadataTiming,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// runQuery — legacy wrapper returning JSON string
// ---------------------------------------------------------------------------

export async function runQuery(
  context: vscode.ExtensionContext,
  query: string,
  silent: boolean = false,
  connectionName?: string,
  connectionManager?: ConnectionManager,
  documentUri?: string,
): Promise<string | undefined> {
  const result = await runQueryRaw(
    context,
    query,
    silent,
    connectionManager,
    connectionName,
    documentUri,
  );

  if (result.data && result.data.length > 0) {
    const mapped = result.data.map((row) => {
      const obj: Record<string, unknown> = {};
      result.columns.forEach((col, index) => {
        obj[col.name] = row[index];
      });
      return obj;
    });

    const jsonOutput = JSON.stringify(
      mapped,
      (_key, value) => {
        if (typeof value === "bigint") {
          if (
            value >= Number.MIN_SAFE_INTEGER &&
            value <= Number.MAX_SAFE_INTEGER
          ) {
            return Number(value);
          }
          return value.toString();
        }
        return value;
      },
      2,
    );
    return jsonOutput;
  } else if (result.message) {
    return result.message;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// queryResultToRows — backward compat wrapper
// ---------------------------------------------------------------------------

/**
 * Convert QueryResult (columns[] + data[][]) to array of typed objects.
 * This is a wrapper for backward compatibility - delegates to ResultFormatter.
 */
export function queryResultToRows<T extends Record<string, unknown>>(
  result: QueryResult,
): T[] {
  return ResultFormatter.queryResultToRows<T>(result);
}

// ---------------------------------------------------------------------------
// runQueryWithCatalog
// ---------------------------------------------------------------------------

/**
 * Run a query with a temporary catalog (database) change.
 * This is needed for queries like _V_VIEW.DEFINITION which require
 * an active connection to the specific database.
 */
export async function runQueryWithCatalog(
  targetDatabase: string,
  query: string,
  connectionManager: ConnectionManager,
  connectionName: string,
): Promise<QueryResult> {
  const connManager = connectionManager;
  const { connection, shouldCloseConnection } = await getConnectionForDocument(
    connManager,
    connectionName,
    true,
    undefined,
  );

  try {
    // Get current catalog to restore later
    let originalCatalog: string | undefined;
    try {
      const catalogCmd = connection.createCommand("SELECT CURRENT_CATALOG");
      const catalogReader = await catalogCmd.executeReader();
      if (await catalogReader.read()) {
        originalCatalog = String(catalogReader.getValue(0));
      }
      await catalogReader.close();
    } catch {
      // Ignore if we can't get current catalog
    }

    // Set target catalog
    try {
      const setCatalogCmd = connection.createCommand(
        `SET CATALOG ${targetDatabase}`,
      );
      const setCatalogReader = await setCatalogCmd.executeReader();
      try {
        await setCatalogReader.close();
      } catch {
        // Ignore close errors
      }
    } catch (catalogError) {
      console.debug(
        `[runQueryWithCatalog] Failed to SET CATALOG ${targetDatabase}:`,
        catalogError,
      );
      return {
        columns: [],
        data: [],
        rowsAffected: undefined,
        limitReached: false,
        sql: query,
      };
    }

    try {
      const { queryTimeout, rowLimit } = getQueryConfig();
      const { results, error } = await streamingManager.executeAndFetch(
        connection,
        query,
        rowLimit,
        queryTimeout,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      if (error) {
        throw error;
      }

      return {
        columns: results[0]?.columns || [],
        data: results[0]?.rows || [],
        rowsAffected: undefined,
        limitReached: results[0]?.limitReached || false,
        sql: query,
      };
    } finally {
      if (originalCatalog && originalCatalog !== targetDatabase) {
        try {
          const restoreCmd = connection.createCommand(
            `SET CATALOG ${originalCatalog}`,
          );
          const restoreReader = await restoreCmd.executeReader();
          try {
            await restoreReader.close();
          } catch {
            // Ignore close errors
          }
        } catch {
          // Ignore restore errors
        }
      }
    }
  } finally {
    if (shouldCloseConnection && connection) {
      await connection.close();
    }
  }
}

// ---------------------------------------------------------------------------
// parseQueryJsonResult
// ---------------------------------------------------------------------------

/**
 * Parse JSON result from runQuery() safely.
 * Handles empty results and "Query executed successfully" messages.
 * This is a transitional helper for legacy code using runQuery + JSON.parse.
 * New code should use runQueryRaw + queryResultToRows instead.
 */
export function parseQueryJsonResult<T>(resultJson: string | undefined): T[] {
  if (!resultJson) {
    return [];
  }
  if (
    resultJson.startsWith("Query executed successfully") ||
    resultJson === "Query executed successfully (no results)."
  ) {
    return [];
  }
  try {
    return JSON.parse(resultJson) as T[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// runExplainQuery
// ---------------------------------------------------------------------------

function formatExplainValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

/**
 * Run EXPLAIN query and capture either NOTICE messages or regular result rows.
 * Netezza returns EXPLAIN output via NOTICE messages, while PostgreSQL returns row data.
 */
export async function runExplainQuery(
  context: vscode.ExtensionContext,
  query: string,
  connectionName?: string,
  connectionManager?: ConnectionManager,
  documentUri?: string,
): Promise<string> {
  const connManager = connectionManager || new ConnectionManager(context);
  const keepConnectionOpen = documentUri
    ? connManager.getDocumentKeepConnectionOpen(documentUri)
    : true;

  const notices: string[] = [];
  const rows: string[] = [];
  if (documentUri) {
    streamingManager.clearAborted(documentUri);
  }
  const resolvedConnectionName = resolveConnectionName(
    connManager,
    connectionName,
    documentUri,
  );

  const { connection, shouldCloseConnection } = await getConnectionForDocument(
    connManager,
    resolvedConnectionName,
    keepConnectionOpen,
    documentUri,
  );

  try {
    const noticeHandler = (msg: unknown) => {
      const notification = msg as { message: string };
      notices.push(notification.message);
    };
    connection.on("notice", noticeHandler);

    try {
      const { queryTimeout } = getQueryConfig();
      const cmd = connection.createCommand(query);
      cmd.commandTimeout = queryTimeout;

      let commandHandle:
        | ReturnType<typeof streamingManager.registerCommand>
        | undefined;
      let cancelSignal: AbortSignal | undefined;
      if (documentUri) {
        commandHandle = streamingManager.registerCommand(documentUri, cmd);
        cancelSignal = commandHandle.signal;
      }

      try {
        const reader = await cmd.executeReader();
        try {
          do {
            while (await reader.read()) {
              if (cancelSignal?.aborted) {
                break;
              }

              const values: string[] = [];
              for (
                let columnIndex = 0;
                columnIndex < reader.fieldCount;
                columnIndex++
              ) {
                values.push(formatExplainValue(reader.getValue(columnIndex)));
              }

              if (values.length > 0) {
                rows.push(values.length === 1 ? values[0] : values.join("\t"));
              }
            }
          } while (await reader.nextResult());
        } finally {
          await reader.close();
        }

        if (cancelSignal?.aborted) {
          return notices.join("\n");
        }
      } finally {
        commandHandle?.unregister();
      }
    } finally {
      connection.removeListener("notice", noticeHandler);
    }
  } finally {
    if (shouldCloseConnection && connection) {
      await connection.close();
    }
  }

  if (notices.length > 0) {
    return notices.join("\n");
  }

  return rows.join("\n");
}
