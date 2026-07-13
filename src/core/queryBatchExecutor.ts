/**
 * Query Batch Executor
 * Shared logic for batch query execution (sequential and streaming).
 * Extracted from queryRunner.ts to eliminate duplication between
 * runQueriesSequentially and runQueriesWithStreaming.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { getExtensionConfiguration } from "../compatibility/configuration";
import { ConnectionManager } from "./connectionManager";
import { QueryHistoryManager } from "./queryHistoryManager";
import {
    logMacroPreprocessResult,
} from "./variableUtils";
import { promptForVariableValues } from "./variableResolver";
import {
    MacroEnvironment,
    MacroPreprocessor,
    type MacroExportExecutionResult,
    type MacroExportRequest,
    type MacroPreprocessorContext,
    type MacroQueryExecutor,
    type MacroQueryExecutionResult,
} from "./macroPreprocessor";
import { createMacroPythonExecutor } from "./macroPythonExecutor";
import { NzConnection } from "../types";
import type { DatabaseConnection } from "../contracts/database";
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
    retryOnBrokenConnection?: boolean;
    /** Confirm the fully expanded SQL immediately before database execution. */
    confirmSafeExecute?: (sql: string, queryIndex: number) => Promise<boolean>;
    onQueryError?: (queryIndex: number, sql: string, errorMessage: string) => void;
    onStatementSucceeded?: (event: {
        sql: string;
        connectionName: string;
        documentUri?: string;
        connection: DatabaseConnection;
    }) => Promise<void>;
    onStatementFailed?: (event: {
        sql: string;
        connectionName: string;
        documentUri?: string;
        errorMessage: string;
    }) => void;
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
    documentUri?: string,
): Promise<Record<string, string>> {
    const unresolvedVariables = new Set<string>();
    const scanEnvironment = new MacroEnvironment();
    const preprocessor = new MacroPreprocessor();
    const macroContext = createMacroFileReadContext(documentUri);

    for (const q of queries) {
        const result = await preprocessor.processScript(q, {
            environment: scanEnvironment,
            replaceVariables: false,
        }, macroContext);
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
    macroContext: MacroPreprocessorContext = {},
): Promise<string> {
    return (await prepareQueryForExecutionWithMetadata(
        query,
        resolvedVars,
        logCallback,
        queryExecutor,
        macroContext,
    )).sql;
}

export interface PreparedQueryExecution {
    sql: string;
    hasMacroBranch: boolean;
}

/**
 * Prepare a query and retain execution-safety metadata from macro processing.
 */
export async function prepareQueryForExecutionWithMetadata(
    query: string,
    resolvedVars: Record<string, string>,
    logCallback?: (message: string) => void,
    queryExecutor?: MacroQueryExecutor,
    macroContext: MacroPreprocessorContext = {},
): Promise<PreparedQueryExecution> {
    const environment = new MacroEnvironment(resolvedVars);
    const result = await new MacroPreprocessor().processScript(query, {
        environment,
        replaceVariables: true,
    }, {
        ...macroContext,
        query: queryExecutor ?? macroContext.query,
        pythonExecutor: macroContext.pythonExecutor ?? createMacroPythonExecutor(),
        exporter: queryExecutor
            ? request => executeMacroExport(request, queryExecutor, logCallback)
            : macroContext.exporter,
    });
    Object.assign(resolvedVars, result.variables);
    logMacroPreprocessResult(result, logCallback);
    return {
        sql: result.sql,
        hasMacroBranch: result.scriptEvents?.some(event => event.type === 'branch') === true,
    };
}

export function createMacroFileReadContext(
    documentUri?: string,
): Pick<MacroPreprocessorContext, "readFile" | "sourceName"> {
    const sourceName = documentUri ? uriToFsPath(documentUri) ?? documentUri : undefined;

    return {
        sourceName,
        readFile: async (includePath: string, fromSource?: string) => {
            const resolvedPath = resolveMacroIncludePath(includePath, fromSource, sourceName);
            const content = await readMacroIncludeFile(resolvedPath);
            return {
                path: resolvedPath,
                content,
            };
        },
    };
}

async function readMacroIncludeFile(filePath: string): Promise<string> {
    const workspaceFs = vscode.workspace.fs;
    if (workspaceFs && vscode.Uri?.file) {
        const bytes = await workspaceFs.readFile(vscode.Uri.file(filePath));
        return new TextDecoder("utf-8").decode(bytes);
    }

    return await fs.promises.readFile(filePath, "utf8");
}

function resolveMacroIncludePath(
    includePath: string,
    fromSource?: string,
    mainSource?: string,
): string {
    const trimmedPath = includePath.trim();
    const workspaceFolder = getWorkspaceFolderPath(mainSource);
    const resolvedPath = path.isAbsolute(trimmedPath)
        ? path.normalize(trimmedPath)
        : path.resolve(resolveMacroIncludeBasePath(fromSource, mainSource, workspaceFolder), trimmedPath);

    assertMacroIncludePathAllowed(resolvedPath, includePath, mainSource, workspaceFolder);

    return resolvedPath;
}

function assertMacroIncludePathAllowed(
    resolvedPath: string,
    includePath: string,
    mainSource?: string,
    workspaceFolder?: string,
): void {
    const normalizedPath = path.normalize(resolvedPath);
    const allowedRoots = getMacroIncludeAllowedRoots(mainSource, workspaceFolder);

    if (allowedRoots.some(root => isPathWithinAllowedRoot(normalizedPath, root))) {
        return;
    }

    throw new Error(
        workspaceFolder
            ? `%INCLUDE path escapes the workspace: ${includePath}`
            : `%INCLUDE path escapes allowed directories: ${includePath}`,
    );
}

function getMacroIncludeAllowedRoots(
    mainSource?: string,
    workspaceFolder?: string,
): string[] {
    const roots = new Set<string>();

    if (workspaceFolder) {
        roots.add(path.normalize(workspaceFolder));
    }
    if (mainSource && path.isAbsolute(mainSource)) {
        roots.add(path.normalize(path.dirname(mainSource)));
    }
    roots.add(path.normalize(process.cwd()));

    return Array.from(roots);
}

function isPathWithinAllowedRoot(resolvedPath: string, root: string): boolean {
    const relative = path.relative(root, resolvedPath);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveMacroIncludeBasePath(
    fromSource: string | undefined,
    mainSource: string | undefined,
    workspaceFolder: string | undefined,
): string {
    if (fromSource && path.isAbsolute(fromSource)) {
        return path.dirname(fromSource);
    }
    if (mainSource && path.isAbsolute(mainSource)) {
        return path.dirname(mainSource);
    }
    return workspaceFolder ?? process.cwd();
}

function getWorkspaceFolderPath(sourceName?: string): string | undefined {
    const sourceUri = sourceName && vscode.Uri?.file ? vscode.Uri.file(sourceName) : undefined;
    const folder = sourceUri && vscode.workspace.getWorkspaceFolder
        ? vscode.workspace.getWorkspaceFolder(sourceUri)
        : vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.fsPath;
}

function uriToFsPath(uriText: string): string | undefined {
    try {
        if (!vscode.Uri?.parse) {
            return undefined;
        }
        const uri = vscode.Uri.parse(uriText);
        return uri.scheme === "file" ? uri.fsPath : undefined;
    } catch {
        return undefined;
    }
}

export async function executeMacroExport(
    request: MacroExportRequest,
    queryExecutor: MacroQueryExecutor,
    _logCallback?: (message: string) => void,
): Promise<MacroExportExecutionResult> {
    if (fs.existsSync(request.filePath) && !request.overwrite) {
        throw new Error(`%EXPORT target already exists: ${request.filePath}`);
    }

    const queryResult = await queryExecutor(request.query);
    const rows = queryResult.rows.map(row => Array.from(row));
    const columns = normalizeMacroExportColumns(queryResult, rows);

    if (columns.length === 0) {
        throw new Error('%EXPORT query returned no columns to export');
    }

    const item = {
        columns,
        rows,
        sql: request.query,
        name: request.sheetName,
    };

    let result: { success: boolean; message: string; details?: { rows_exported?: number; columns?: number } };
    if (request.format === 'xlsx') {
        result = await (await import('../export/xlsxExporter')).exportStructuredToXlsx(
            [item], request.filePath, false,
        );
    } else if (request.format === 'xlsb') {
        result = await (await import('../export/xlsbExporter')).exportStructuredToXlsb(
            [item], request.filePath, false,
        );
    } else if (request.format === 'parquet') {
        result = await (await import('../export/parquetExporter')).exportStructuredToParquet(
            [item], request.filePath, false,
        );
    } else if (request.format === 'xpt') {
        result = await (await import('../export/xptExporter')).exportStructuredToXpt(
            [item], request.filePath, false,
        );
    } else {
        // CSV
        const csvWriter = (await import('../export/csvStream')).createCsvFileWriter(request.filePath);
        try {
            csvWriter.stream.write(item.columns.map((c: { name: string }) => c.name).join(',') + '\n');
            for (const row of item.rows) {
                csvWriter.stream.write(row.map((v: unknown) => String(v)).join(',') + '\n');
            }
        } finally {
            await csvWriter.finalize();
        }
        result = { success: true, message: 'CSV export from %EXPORT completed' };
    }

    if (!result.success) {
        throw new Error(result.message);
    }

    const rowsExported = result.details?.rows_exported ?? rows.length;
    const columnCount = result.details?.columns ?? columns.length;
    const message = `>>> %EXPORT: Exported ${rowsExported} rows to ${request.filePath}`;

    return {
        filePath: request.filePath,
        format: request.format,
        rowsExported,
        columns: columnCount,
        message,
    };
}

function normalizeMacroExportColumns(
    queryResult: MacroQueryExecutionResult,
    rows: unknown[][],
): { name: string; type?: string }[] {
    if (queryResult.columns && queryResult.columns.length > 0) {
        return queryResult.columns.map((column, index) => ({
            name: column.name || `COL${index + 1}`,
            type: column.type,
        }));
    }

    const firstRow = rows[0];
    if (!firstRow) {
        return [];
    }

    return firstRow.map((_, index) => ({ name: `COL${index + 1}` }));
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
