import * as vscode from "vscode";
import { ConnectionManager } from "./connectionManager";
import {
  collectQueryVariableValues,
  resolveQueryVariablesWithValues,
} from "./variableResolver";
import { QueryResult } from "../types";
import { ResultFormatter } from "./streaming";
import { streamingManager } from "./queryCancellation";
import {
  OutputLogger,
  normalizeUriKey,
  createLogger,
  logOutput,
  isConnectionBrokenError,
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
  splitExpandedMacroStatements,
} from "./queryBatchExecutor";

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
  } = options;

  const connManager = connectionManager || new ConnectionManager(context);
  const keepConnectionOpen = documentUri
    ? connManager.getDocumentKeepConnectionOpen(documentUri)
    : true;
  const logger = createLogger(silent, logCallback);

  const queryStartTime = Date.now();

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
  } catch (resolveError: unknown) {
    const errObj = resolveError as { message?: string };
    const errorMessage = `Error: ${errObj.message || String(resolveError)}`;
    logOutput(logger, errorMessage);
    throw new Error(errorMessage, { cause: resolveError });
  }

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
    );

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
    const durationMs = Date.now() - queryStartTime;
    const errObj = error as { message?: string };
    const errMsg = errObj.message || String(error);
    const isCancelled = errMsg.toLowerCase().includes('cancelled') || errMsg.toLowerCase().includes('cancel');

    // Check if this is a broken connection error and we have a persistent connection
    if (isConnectionBrokenError(error) && documentUri && keepConnectionOpen) {
      logOutput(
        logger,
        "Connection was closed by server. Reconnecting and retrying...",
      );
      await connManager.closeDocumentPersistentConnection(documentUri);

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
        );

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
        const retryErrObj = retryError as { message?: string };
        const retryErrorMessage = `Error (after reconnect attempt): ${retryErrObj.message || String(retryError)}`;
        logOutput(logger, retryErrorMessage);

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
          retryErrorMessage,
        );

        throw new Error(retryErrorMessage, { cause: retryError });
      }
    }

    // Check for busy connection
    if (
      await handleBusyConnectionError(
        error,
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

    const errorMessage = `Error: ${errMsg}`;
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

    throw new Error(errorMessage, { cause: error });
  }
}

/**
 * Execute a raw query against a connection (extracted from runQueryRaw to eliminate retry duplication).
 *
 * Macro directives are expanded first, then the SQL is split into individual
 * statements and executed sequentially on one connection. {@link QueryResult.sql}
 * identifies the last executed statement; {@link QueryResult.expandedSql} holds
 * the full expanded script when preprocessing ran.
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
): Promise<QueryResult> {
  const { connection, shouldCloseConnection } = await getConnectionForDocument(
    connManager,
    resolvedConnectionName,
    keepConnectionOpen,
    documentUri,
  );
  logOutput(logger, "Connected.");

  // Attach listener for notices
  let noticeHandler: ((msg: unknown) => void) | undefined;
  if (logger.outputChannel) {
    noticeHandler = (msg: unknown) => {
      const notification = msg as { message: string };
      logger.outputChannel!.appendLine(`NOTICE: ${notification.message}`);
    };
    connection.on("notice", noticeHandler);
  }

  // Capture session ID
  let sessionId: string | undefined;
  try {
    const sidCmd = connection.createCommand("SELECT CURRENT_SID");
    const sidReader = await sidCmd.executeReader();
    if (await sidReader.read()) {
      sessionId = String(sidReader.getValue(0));
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

  try {
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
      },
    );
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

    const statementsToExecute = splitExpandedMacroStatements(queryToExecute);
    const expandedSql = queryToExecute;
    const { queryTimeout, rowLimit } = getQueryConfig();
    let lastResult: QueryResult | undefined;

    for (let subIndex = 0; subIndex < statementsToExecute.length; subIndex++) {
      const statementToExecute = statementsToExecute[subIndex];
      if (statementsToExecute.length > 1) {
        logOutput(
          logger,
          `Executing statement ${subIndex + 1}/${statementsToExecute.length}...`,
        );
      } else {
        logOutput(logger, "Executing SQL on server...");
      }

      const { results, error, recordsAffected } =
        await streamingManager.executeAndFetch(
          connection,
          statementToExecute,
          maxRows !== undefined ? maxRows : rowLimit,
          queryTimeout,
          documentUri,
          sessionId,
          connManager,
          undefined,
          createDropSessionCallback(connManager, documentUri),
        );
      if (error) {
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
        lastResult = {
          columns,
          data,
          rowsAffected: rowsAffectedValue >= 0 ? rowsAffectedValue : undefined,
          limitReached,
          sql: statementToExecute,
        };
      } else {
        const msg =
          rowsAffectedValue >= 0
            ? `Query executed successfully. Records affected: ${rowsAffectedValue}`
            : "Query executed successfully. Records affected: N/A";
        lastResult = {
          columns: [],
          data: [],
          rowsAffected: rowsAffectedValue >= 0 ? rowsAffectedValue : undefined,
          message:
            rowsAffectedValue >= 0
              ? `Records affected: ${rowsAffectedValue}`
              : "Query executed successfully.",
          sql: statementToExecute,
        };
        if (statementsToExecute.length === 1) {
          logOutput(logger, msg);
        }
      }
    }

    if (!lastResult) {
      return {
        columns: [],
        data: [],
        message: "No SQL to execute after processing variable directives.",
        sql: "",
        expandedSql,
      };
    }

    if (lastResult.columns.length > 0) {
      logOutput(logger, "Query completed.");
      logOutput(
        logger,
        lastResult.rowsAffected !== undefined
          ? `Records affected: ${lastResult.rowsAffected}`
          : "Records affected: N/A",
      );
    } else if (statementsToExecute.length > 1) {
      logOutput(logger, "Query completed.");
    }

    return {
      ...lastResult,
      expandedSql,
    };
  } finally {
    if (noticeHandler) {
      connection.removeListener("notice", noticeHandler);
    }
    if (shouldCloseConnection && connection) {
      await connection.close();
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

      let cancelSignal: AbortSignal | undefined;
      if (documentUri) {
        cancelSignal = streamingManager.registerCommand(documentUri, cmd).signal;
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
        if (documentUri) {
          streamingManager.unregisterCommand(documentUri);
        }
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
