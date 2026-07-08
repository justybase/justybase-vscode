/**
 * Query Batch Executor
 * Shared logic for batch query execution (sequential and streaming).
 * Extracted from queryRunner.ts to eliminate duplication between
 * runQueriesSequentially and runQueriesWithStreaming.
 */

import * as vscode from "vscode";
import { getExtensionConfiguration } from "../compatibility/configuration";
import { ConnectionManager } from "./connectionManager";
import { QueryHistoryManager } from "./queryHistoryManager";
import {
    formatPutLogMessage,
} from "./variableUtils";
import { promptForVariableValues } from "./variableResolver";
import {
    MacroEnvironment,
    MacroPreprocessor,
    type MacroQueryExecutor,
    type MacroQueryExecutionResult,
} from "./macroPreprocessor";
import { NzConnection } from "../types";
import { streamingManager } from "./queryCancellation";
import {
    normalizeUriKey,
    getOutputChannel,
    isConnectionBrokenError,
} from "./queryRunnerUtils";
import {
    handleBusyConnectionError,
    executeDropSession,
} from "./queryRunnerHelpers";
import { logWithFallback } from "../utils/logger";

// Re-export for convenience
export { executeDropSession };

/**
 * Context for batch query execution (shared between sequential and streaming).
 */
export interface BatchExecutionContext {
    context: vscode.ExtensionContext;
    queries: string[];
    connectionManager?: ConnectionManager;
    documentUri?: string;
    logCallback?: (msg: string) => void;
    extensionUri?: vscode.Uri;
    maxRows?: number;
    queryStartCallback?: (
        queryIndex: number,
        sql: string,
        connectionName: string,
    ) => string;
    queryEndCallback?: (
        executionId: string,
        rowCount: number,
        durationMs: number,
        status: BatchExecutionStatus,
        error?: string,
    ) => void;
}

export type BatchExecutionStatus =
    | "success"
    | "error"
    | "cancelled"
    | "retrying";

export interface BatchQueryRunOptions {
    continueOnError?: boolean;
    onQueryError?: (queryIndex: number, sql: string, errorMessage: string) => void;
}

/**
 * Result of setting up a batch execution context.
 * Contains the resolved connection, session ID, variables, and cleanup handles.
 */
export interface BatchConnectionSetup {
    connection: NzConnection;
    shouldCloseConnection: boolean;
    sessionId: string | undefined;
    resolvedConnectionName: string;
    connManager: ConnectionManager;
    keepConnectionOpen: boolean;
    resolvedVars: Record<string, string>;
    outputChannel: vscode.OutputChannel | undefined;
    historyManager: QueryHistoryManager;
    details: { host: string; database: string };
    noticeHandler: (msg: unknown) => void;
}

/**
 * Resolve connection name for batch execution.
 * Uses document-specific connection if available, otherwise active connection.
 */
export function resolveBatchConnectionName(
    connManager: ConnectionManager,
    documentUri?: string,
): string {
    let resolvedConnectionName =
        connManager.getConnectionForExecution(documentUri);
    if (!resolvedConnectionName) {
        resolvedConnectionName = connManager.getActiveConnectionName() || undefined;
    }
    if (!resolvedConnectionName) {
        throw new Error("No connection selected");
    }
    return resolvedConnectionName;
}

/**
 * Resolve batch variables from all queries.
 * Scans queries in source order so @SET/%let declarations only satisfy
 * references that appear after them, then prompts once for unresolved values.
 */
export async function resolveBatchVariables(
    queries: string[],
    context: vscode.ExtensionContext,
): Promise<Record<string, string>> {
    const unresolvedVariables = new Set<string>();
    const scanEnvironment = new MacroEnvironment();
    const preprocessor = new MacroPreprocessor();

    for (const q of queries) {
        const result = preprocessor.processScriptSync(q, {
            environment: scanEnvironment,
            replaceVariables: false,
        });
        result.unresolvedVariables.forEach(variable => {
            unresolvedVariables.add(variable);
        });
    }

    if (unresolvedVariables.size > 0) {
        return await promptForVariableValues(
            unresolvedVariables,
            false,
            {},
            context,
        );
    }

    return {};
}

/**
 * Capture session ID from the connection.
 * Stores it in connection manager for later DROP SESSION if needed.
 */
export async function captureSessionId(
    connection: NzConnection,
    connManager: ConnectionManager,
    documentUri?: string,
    logCallback?: (msg: string) => void,
): Promise<string | undefined> {
    let sessionId: string | undefined;
    try {
        const sidCmd = connection.createCommand("SELECT CURRENT_SID");
        const sidReader = await sidCmd.executeReader();
        if (await sidReader.read()) {
            const sid = sidReader.getValue(0);
            if (sid !== undefined) {
                sessionId = String(sid);
                if (documentUri) {
                    connManager.setDocumentLastSessionId(
                        normalizeUriKey(documentUri),
                        sessionId,
                    );
                }
                if (logCallback) {
                    logCallback(`Connected. Session ID: ${sessionId}`);
                }
            }
        }
        await sidReader.close();
    } catch (sidErr) {
        logWithFallback("debug", "Could not retrieve session ID:", sidErr);
        if (logCallback) logCallback("Connected.");
    }
    return sessionId;
}

/**
 * Setup output channel or use log callback for batch execution.
 * @param logCallback Optional callback for logging messages
 * @param queryCount Number of queries being executed
 * @param mode Execution mode (sequential or streaming)
 * @param existingChannel Optional existing output channel to reuse (for retry scenarios)
 * @returns The output channel to use for logging
 */
export function setupBatchLogger(
  logCallback?: (msg: string) => void,
  queryCount?: number,
  mode: "sequential" | "streaming" = "sequential",
  existingChannel?: vscode.OutputChannel,
): vscode.OutputChannel | undefined {
  // Reuse existing channel if provided (e.g., during retry)
  if (existingChannel) {
    return existingChannel;
  }

  if (!logCallback) {
    const outputChannel = getOutputChannel();
    outputChannel.show(true);
    const modeLabel = mode === "streaming" ? "with streaming" : "sequentially";
    outputChannel.appendLine(
      `Executing ${queryCount ?? "?"} queries ${modeLabel}...`,
    );
    return outputChannel;
  }
  return undefined;
}

/**
 * Log a message to both output channel and callback (if present).
 */
export function logBatch(
    outputChannel: vscode.OutputChannel | undefined,
    logCallback: ((msg: string) => void) | undefined,
    message: string,
): void {
    if (outputChannel) outputChannel.appendLine(message);
    if (logCallback) logCallback(message);
}

/**
 * Prepare a single query for execution.
 * Strips directives, mutates the execution-scoped macro variables, and
 * replaces references visible at this point in the batch.
 */
export async function prepareQueryForExecution(
    query: string,
    resolvedVars: Record<string, string>,
    logCallback?: (message: string) => void,
    queryExecutor?: MacroQueryExecutor,
): Promise<string> {
    const environment = new MacroEnvironment(resolvedVars);
    const result = await new MacroPreprocessor().processScript(query, {
        environment,
        replaceVariables: true,
    }, {
        query: queryExecutor,
    });
    Object.assign(resolvedVars, result.variables);
    result.putMessages.forEach(message => logCallback?.(formatPutLogMessage(message)));
    return result.sql;
}

export async function executeMacroQuery(
    connection: NzConnection,
    sql: string,
    documentUri: string | undefined,
    sessionId: string | undefined,
    connManager: ConnectionManager,
    maxRows?: number,
): Promise<MacroQueryExecutionResult> {
    const { queryTimeout, rowLimit } = getQueryConfig();
    const { results, error } = await streamingManager.executeAndFetch(
        connection,
        sql,
        rowLimit,
        queryTimeout,
        documentUri,
        sessionId ? String(sessionId) : undefined,
        connManager,
        maxRows,
        createDropSessionCallback(connManager, documentUri),
    );

    if (error) {
        throw error;
    }

    const firstResult = results[0];
    return {
        columns: firstResult?.columns ?? [],
        rows: firstResult?.rows ?? [],
    };
}

/**
 * Log query execution to history (fire-and-forget).
 */
export function logQueryToHistoryAsync(
    historyManager: QueryHistoryManager,
    host: string,
    database: string,
    query: string,
    connectionName: string,
    tags?: string,
    status?: 'success' | 'error' | 'cancelled',
    durationMs?: number,
    rowsAffected?: number,
    errorMessage?: string,
): void {
    historyManager
        .addEntry(
            host,
            database,
            "unknown",
            query,
            connectionName,
            tags,
            undefined,
            true,
            status,
            durationMs,
            rowsAffected,
            errorMessage,
        )
        .catch((err: unknown) => {
            logWithFallback("error", "Failed to log query to history:", err);
        });
}

/**
 * Handle broken connection retry for batch execution.
 * Closes the broken persistent connection and retries once.
 *
 * @returns true if retry was initiated (caller should return), false if not a retry case
 */
export async function handleBatchRetry<T>(
    error: unknown,
    isRetry: boolean,
    connManager: ConnectionManager,
    documentUri: string | undefined,
    keepConnectionOpen: boolean,
    outputChannel: vscode.OutputChannel | undefined,
    logCallback: ((msg: string) => void) | undefined,
    retryFn: () => Promise<T>,
    onRetryStructuredLog?: (message: string) => void,
): Promise<{ handled: true; result: T } | { handled: false }> {
    if (
        !isRetry &&
        isConnectionBrokenError(error) &&
        documentUri &&
        keepConnectionOpen
    ) {
        const retryMsg =
            "Connection was closed by server. Reconnecting and retrying...";
        if (outputChannel) {
            outputChannel.appendLine(retryMsg);
        }
        if (onRetryStructuredLog) {
            onRetryStructuredLog(retryMsg);
        } else if (logCallback) {
            logCallback(retryMsg);
        }

        // Close the broken persistent connection
        await connManager.closeDocumentPersistentConnection(documentUri);

        try {
            const result = await retryFn();
            return { handled: true, result };
        } catch (retryError: unknown) {
            const retryErrObj = retryError as { message?: string };
            const retryErrorMessage = `Error (after reconnect attempt): ${retryErrObj.message || String(retryError)}`;
            if (outputChannel) {
                outputChannel.appendLine(retryErrorMessage);
            }
            if (!onRetryStructuredLog && logCallback) {
                logCallback(retryErrorMessage);
            }
            throw new Error(retryErrorMessage, { cause: retryError });
        }
    }
    return { handled: false };
}

/**
 * Handle error after batch execution fails.
 * Checks for busy connection and provides user-friendly error messages.
 */
export async function handleBatchError(
    error: unknown,
    connManager: ConnectionManager,
    outputChannel: vscode.OutputChannel | undefined,
    logCallback: ((msg: string) => void) | undefined,
    documentUri?: string,
): Promise<never> {
    const errObj = error as { message?: string };

    // Check for "Connection is already executing a command"
    if (
        await handleBusyConnectionError(
            error,
            connManager,
            { outputChannel, logCallback },
            documentUri,
            false,
        )
    ) {
        throw new Error(`Connection is busy. Use the popup actions to resolve.`);
    }

    const errorMessage = `Error: ${errObj.message || String(error)}`;
    logBatch(outputChannel, logCallback, errorMessage);
    throw new Error(errorMessage);
}

/**
 * Get the drop session callback for streaming manager.
 */
export function createDropSessionCallback(
    connManager: ConnectionManager,
    documentUri?: string,
): ((sid: string) => Promise<void>) | undefined {
    if (!documentUri) {
        return undefined;
    }
    return async (sid: string) =>
        await executeDropSession(sid, connManager, documentUri);
}

/**
 * Read query execution configuration from VS Code settings.
 */
export function getQueryConfig(): { queryTimeout: number; rowLimit: number } {
    const config = getExtensionConfiguration();
    const queryTimeout = config.get<number>("query.executionTimeout", 1800) ?? 1800;
    const rowLimit = config.get<number>("query.rowLimit", 200000) ?? 200000;
    return { queryTimeout, rowLimit };
}
