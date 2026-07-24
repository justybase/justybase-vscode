import * as vscode from 'vscode';
import { getExtensionConfiguration } from '../../compatibility/configuration';
import { NzConnection, NzCommand, NzDataReader, ColumnDefinition } from '../../types';
import { getErrorMessage } from '../connectionUtils';
import { normalizeUriKey } from '../uriUtils';
import { logWithFallback } from '../../utils/logger';
import {
    getEffectiveResultColumnType,
    getResultReaderNumericScale
} from './resultColumnMetadata';
import { isConnectionRecoveryError } from '../connectionReadiness';
import {
    cancelCommandAndCloseReader,
    isCancellationError,
    isTimeoutError,
    type CancellationCleanupContext,
    type OperationStatus,
} from '../cancellation';

/**
 * Streaming chunk callback interface for progressive result delivery
 */
export interface StreamingChunk {
    columns: { name: string; type?: string; scale?: number }[];
    rows: unknown[][];
    isFirstChunk: boolean;
    isLastChunk: boolean;
    totalRowsSoFar: number;
    limitReached: boolean;
    isCancelled?: boolean;
}

/**
 * Internal result set interface for batch fetching
 */
interface InternalResultSet {
    columns: ColumnDefinition[];
    rows: unknown[][];
    limitReached: boolean;
}

const CANCEL_TIMEOUT_MS = 5000;
const EXTENDED_CANCEL_TIMEOUT_MS = 15000;
const DRAIN_YIELD_INTERVAL = 200;
const STALE_ABORT_CLEANUP_MS = 30000;

type ReaderColumn = { name: string; type?: string; scale?: number };

async function closeReaderBestEffort(reader: NzDataReader | undefined, context: string): Promise<void> {
    if (!reader) {
        return;
    }

    try {
        await reader.close();
    } catch (closeErr: unknown) {
        logWithFallback('warn', `[StreamingManager] Failed to close reader after ${context}:`, closeErr);
    }
}

function extractNumericScale(reader: NzDataReader, index: number): number | undefined {
    return getResultReaderNumericScale(reader, index);
}

interface ExecutingCommandEntry {
    command: NzCommand;
    controller: AbortController;
    sessionId?: string;
}

export interface RegisteredCommandHandle {
    signal: AbortSignal;
    abort(reason?: string): void;
}

/**
 * Manages progressive data streaming and batch fetching for query results.
 * Handles chunked streaming, row limits, and cancellation.
 *
 * Cancellation uses the standard AbortController/AbortSignal pattern.
 * Each registered command owns its own AbortController; `abortQuery`
 * propagates the abort signal to consumers and the stale entry is
 * auto-cleaned up after STALE_ABORT_CLEANUP_MS to prevent memory leaks.
 */
export class StreamingManager {
    private executingCommands = new Map<string, ExecutingCommandEntry>();
    private pendingAborts = new Set<string>();

    /**
     * Register a command for cancellation tracking and return a handle
     * exposing the AbortSignal and a convenience `abort` function.
     *
     * If a previous entry exists for the same URI it is aborted first to
     * prevent orphaned commands retaining memory.
     *
     * If a cancellation was requested between command registrations (via
     * `pendingAborts`), the newly created controller is aborted immediately
     * so the batch-query loop can detect it before the next iteration.
     */
    registerCommand(documentUri: string, cmd: NzCommand, sessionId?: string): RegisteredCommandHandle {
        const normalizedKey = normalizeUriKey(documentUri);
        const existing = this.executingCommands.get(normalizedKey);
        if (existing) {
            existing.controller.abort('superseded by new command registration');
        }

        const controller = new AbortController();
        const entry: ExecutingCommandEntry = { command: cmd, controller, sessionId };
        this.executingCommands.set(normalizedKey, entry);
        this.scheduleStaleCleanup(normalizedKey, controller);

        // Consume any pending abort that arrived between command registrations
        const pendingAbort = this.pendingAborts.has(normalizedKey);
        if (pendingAbort) {
            this.pendingAborts.delete(normalizedKey);
            controller.abort('pending abort');
        }

        return {
            signal: controller.signal,
            abort: (reason?: string) => controller.abort(reason),
        };
    }

    /**
     * Unregister a command after completion. The underlying controller is
     * aborted to release any pending listeners; subsequent calls to
     * `getCommand` / `isActive` for the URI will return the cleared state.
     */
    unregisterCommand(documentUri: string): void {
        const normalizedKey = normalizeUriKey(documentUri);
        const entry = this.executingCommands.get(normalizedKey);
        if (entry) {
            entry.controller.abort('unregisterCommand');
            this.executingCommands.delete(normalizedKey);
        }
    }

    /**
     * Mark the given document URI as cancelled.  If an active command is
     * currently registered its AbortController is aborted immediately.
     * Otherwise the abort request is stored in a pending set so that the
     * next `registerCommand` for that URI picks it up.
     *
     * Returns `true` when the abort request was stored (always, since
     * storing is unconditional).
     */
    abortQuery(documentUri: string, reason?: string): boolean {
        const normalizedKey = normalizeUriKey(documentUri);
        const entry = this.executingCommands.get(normalizedKey);
        if (entry) {
            entry.controller.abort(reason ?? 'Query cancelled');
        }
        // Always store the pending flag so cancellation survives across
        // command boundaries (e.g. between batch statements). The next
        // registerCommand will consume it.
        this.pendingAborts.add(normalizedKey);
        return true;
    }

    /**
     * Check if the given document URI has been cancelled.  Returns `true`
     * either when an active command's AbortSignal has been triggered or
     * when a pending abort request exists for the URI.
     */
    isAborted(documentUri: string): boolean {
        const normalizedKey = normalizeUriKey(documentUri);
        if (this.pendingAborts.has(normalizedKey)) {
            return true;
        }
        const entry = this.executingCommands.get(normalizedKey);
        return entry?.controller.signal.aborted ?? false;
    }

    /**
     * Clear any pending abort flag for the given document URI.
     * This is called at the start of a query execution sequence so that
     * a previous cancellation does not inadvertently block a fresh run.
     */
    clearAborted(documentUri: string): void {
        this.pendingAborts.delete(normalizeUriKey(documentUri));
    }

    /**
     * Check if a query is currently active for the given document URI
     */
    isActive(documentUri: string): boolean {
        return this.executingCommands.has(normalizeUriKey(documentUri));
    }

    /**
     * Get the command for a document URI (if active)
     */
    getCommand(documentUri: string): NzCommand | undefined {
        const entry = this.executingCommands.get(normalizeUriKey(documentUri));
        return entry?.command;
    }

    /**
     * Get the AbortSignal for the command registered for a document URI.
     * Returns undefined when no active entry exists.
     */
    getSignal(documentUri: string): AbortSignal | undefined {
        const entry = this.executingCommands.get(normalizeUriKey(documentUri));
        return entry?.controller.signal;
    }

    /**
     * Get all active URIs
     */
    getActiveUris(): string[] {
        return Array.from(this.executingCommands.keys());
    }

    private scheduleStaleCleanup(normalizedKey: string, controller: AbortController): void {
        const onAbort = () => {
            controller.signal.removeEventListener('abort', onAbort);
            setTimeout(() => {
                const current = this.executingCommands.get(normalizedKey);
                if (current && current.controller === controller) {
                    this.executingCommands.delete(normalizedKey);
                }
            }, STALE_ABORT_CLEANUP_MS).unref?.();
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });
    }

    /**
     * Consume remaining data and cancel the command gracefully.
     * Includes timeout handling and DROP SESSION option for stuck queries.
     *
     * @param onDropSession - Optional callback to execute DROP SESSION when user requests it.
     *                       If not provided, the session will not be dropped even if user requests it.
     */
    async consumeRestAndCancel(
        reader: NzDataReader,
        cmd: NzCommand,
        documentUri?: string,
        sessionId?: string,
        _connectionManager?: { closeDocumentPersistentConnection(uri: string): Promise<void> },
        onDropSession?: (sessionId: string) => Promise<void>,
        cancelFirst: boolean = false,
        cleanupContext?: CancellationCleanupContext,
    ): Promise<void> {
        const startTime = Date.now();
        const timeoutMs = CANCEL_TIMEOUT_MS;
        const signal = documentUri ? this.getSignal(documentUri) : undefined;

        try {
            if (cancelFirst) {
                const cleanup = await cancelCommandAndCloseReader(cmd, reader, cleanupContext ?? { timeoutMs });
                if (cleanup.cancelError) {
                    logWithFallback('warn', `[StreamingManager] Immediate cmd.cancel() failed for session ${sessionId}:`, cleanup.cancelError);
                }
                if (cleanup.closeError) {
                    logWithFallback('warn', `[StreamingManager] Immediate reader.close() after cancel failed for session ${sessionId}:`, cleanup.closeError);
                    // Some drivers reject close while a fetch is unwinding. A
                    // bounded drain gives those readers a chance to release
                    // their server cursor before the final cleanup attempt.
                    try {
                        const drainStarted = Date.now();
                        while (await reader.read()) {
                            if (Date.now() - drainStarted >= timeoutMs) break;
                        }
                    } catch (drainError) {
                        logWithFallback('warn', `[StreamingManager] Reader drain after close failure failed for session ${sessionId}:`, drainError);
                    }
                }
                return;
            }

            let timedOut = false;
            let drainReadCount = 0;
            do {
                while (await reader.read()) {
                    // Respect cancellation even during draining
                    if (signal?.aborted) {
                        break;
                    }

                    drainReadCount++;
                    if (drainReadCount % DRAIN_YIELD_INTERVAL === 0) {
                        await new Promise(resolve => setImmediate(resolve));
                    }

                    if (Date.now() - startTime > timeoutMs) {
                        timedOut = true;
                        break;
                    }
                }
                if (timedOut) break;
            } while (await reader.nextResult());

            if (timedOut) {
                logWithFallback('warn', `[StreamingManager] consumeRestAndCancel timed out after ${timeoutMs}ms for session ${sessionId}, forcing cancel`);

                // If we timed out and have a session ID, offer to Drop Session
                if (sessionId) {
                    const msg = `Cancellation is taking longer than expected. Do you want to force DROP SESSION ${sessionId}?`;
                    const selection = await vscode.window.showWarningMessage(
                        msg,
                        `Drop Session ${sessionId}`,
                        'Keep Waiting'
                    );

                    if (selection === `Drop Session ${sessionId}`) {
                        // Execute DROP SESSION callback if provided
                        logWithFallback('info', `[StreamingManager] User requested DROP SESSION ${sessionId}`);
                        if (onDropSession) {
                            try {
                                await onDropSession(sessionId);
                            } catch (dropErr: unknown) {
                                logWithFallback('error', `[StreamingManager] Failed to execute DROP SESSION ${sessionId}:`, dropErr);
                                vscode.window.showErrorMessage(
                                    `Failed to drop session ${sessionId}: ${getErrorMessage(dropErr)}`
                                );
                            }
                        }
                    } else if (selection === 'Keep Waiting') {
                        // Continue consuming for another 15 seconds
                        const extendedTimeoutMs = EXTENDED_CANCEL_TIMEOUT_MS;
                        const extendedStartTime = Date.now();
                        let extendedTimedOut = false;
                        let extendedReadCount = 0;

                        try {
                            do {
                                while (await reader.read()) {
                                    if (signal?.aborted) {
                                        break;
                                    }

                                    extendedReadCount++;
                                    if (extendedReadCount % DRAIN_YIELD_INTERVAL === 0) {
                                        await new Promise(resolve => setImmediate(resolve));
                                    }

                                    if (Date.now() - extendedStartTime > extendedTimeoutMs) {
                                        extendedTimedOut = true;
                                        break;
                                    }
                                }
                                if (extendedTimedOut) break;
                            } while (await reader.nextResult());
                        } catch (extendedErr: unknown) {
                            logWithFallback('warn', `[StreamingManager] Error during extended consume for session ${sessionId}:`, extendedErr);
                            extendedTimedOut = true;
                        }

                        if (extendedTimedOut) {
                            logWithFallback('warn', `[StreamingManager] Extended consume timed out after ${extendedTimeoutMs}ms for session ${sessionId}`);
                        }
                    }
                }
            }

            await cancelCommandAndCloseReader(cmd, reader, { timeoutMs });
        } catch (e: unknown) {
            logWithFallback('warn', '[StreamingManager] Failed to cancel command after limit reached:', e);
        }
    }

    /**
     * Execute query and fetch results in batches (non-streaming).
     * Supports multiple result sets and row limits.
     */
    async executeAndFetch(
        connection: NzConnection,
        query: string,
        limit: number,
        timeoutSeconds?: number,
        documentUri?: string,
        sessionId?: string,
        connectionManager?: { closeDocumentPersistentConnection(uri: string): Promise<void> },
        maxRows?: number,
        onDropSession?: (sessionId: string) => Promise<void>
    ): Promise<{ results: InternalResultSet[]; error?: Error; recordsAffected?: number; status: OperationStatus }> {
        const cmd = connection.createCommand(query);
        if (timeoutSeconds && timeoutSeconds > 0) {
            cmd.commandTimeout = timeoutSeconds;
        }

        // Track command
        const signal = documentUri
            ? this.registerCommand(documentUri, cmd, sessionId).signal
            : undefined;
        const cancellationContext: CancellationCleanupContext = { timeoutMs: CANCEL_TIMEOUT_MS };
        let abortListener: (() => void) | undefined;
        if (signal) {
            abortListener = () => {
                void cancelCommandAndCloseReader(cmd, reader, cancellationContext);
            };
            signal.addEventListener('abort', abortListener, { once: true });
        }

        const alertTimeout = this.setupLongQueryAlert();

        let reader: NzDataReader | undefined;
        let caughtError: Error | undefined;
        let operationStatus: OperationStatus = 'success';
        let commandCleanupDone = false;

        try {
            try {
                reader = await cmd.executeReader();
            } catch (executeErr: unknown) {
                caughtError = executeErr instanceof Error ? executeErr : new Error(String(executeErr));
                operationStatus = signal?.aborted || isCancellationError(executeErr)
                    ? 'cancelled'
                    : isTimeoutError(executeErr) ? 'timeout' : 'error';
                await cancelCommandAndCloseReader(cmd, reader, cancellationContext);
                return { results: [], error: caughtError, recordsAffected: cmd._recordsAffected, status: operationStatus };
            }

            const results: InternalResultSet[] = [];
            const finalRowLimit = maxRows !== undefined ? maxRows : limit;
            let hasMore = true;

            try {
                do {
                    const columns: ReaderColumn[] = [];
                    const rows: unknown[][] = [];
                    let fetchedCount = 0;
                    let limitReached = false;

                    // Read column metadata BEFORE the fetch loop (even if there are 0 rows)
                    for (let i = 0; i < reader.fieldCount; i++) {
                        const column: ReaderColumn = {
                            name: reader.getName(i),
                            type: getEffectiveResultColumnType(reader, i)
                        };
                        const scale = extractNumericScale(reader, i);
                        if (typeof scale === 'number') {
                            column.scale = scale;
                        }
                        columns.push(column);
                    }

                    // Fetch loop
                    let rowsSinceYield = 0;
                    while (await reader.read()) {
                        // Check for cancellation
                        if (signal?.aborted) {
                            operationStatus = 'cancelled';
                            await this.consumeRestAndCancel(
                                reader,
                                cmd,
                                documentUri,
                                sessionId,
                                connectionManager,
                                onDropSession,
                                true,
                                cancellationContext,
                            );
                            commandCleanupDone = true;
                            throw new Error('Query cancelled by user');
                        }

                        if (fetchedCount < finalRowLimit) {
                            const row: unknown[] = [];
                            for (let i = 0; i < reader.fieldCount; i++) {
                                row.push(reader.getValue(i));
                            }
                            rows.push(row);
                            fetchedCount++;
                        }

                        rowsSinceYield++;
                        if (rowsSinceYield % 200 === 0) {
                            await new Promise(resolve => setImmediate(resolve));
                        }

                        if (fetchedCount >= finalRowLimit) {
                            limitReached = true;
                            // Cancel the command on the server side since we don't need more data
                            await this.consumeRestAndCancel(
                                reader,
                                cmd,
                                documentUri,
                                sessionId,
                                connectionManager,
                                onDropSession,
                                true,
                                cancellationContext,
                            );
                            commandCleanupDone = true;
                            break;
                        }
                    }

                    results.push({
                        columns,
                        rows,
                        limitReached
                    });

                    hasMore = await reader.nextResult();
                } while (hasMore);
            } catch (readErr: unknown) {
                caughtError = readErr instanceof Error ? readErr : new Error(String(readErr));
                operationStatus = signal?.aborted || isCancellationError(readErr)
                    ? 'cancelled'
                    : isTimeoutError(readErr) ? 'timeout' : 'error';
                // Don't throw loop error immediately, return what we have so far
            }

            if (signal?.aborted && operationStatus === 'success') {
                operationStatus = 'cancelled';
                caughtError ??= new Error('Query cancelled');
            }

            return { results, error: caughtError, recordsAffected: cmd._recordsAffected, status: operationStatus };
        } finally {
            if (reader && !commandCleanupDone) {
                if (caughtError && isConnectionRecoveryError(caughtError)) {
                    await this.consumeRestAndCancel(
                        reader,
                        cmd,
                        documentUri,
                        sessionId,
                        connectionManager,
                        onDropSession,
                        true,
                        cancellationContext,
                    );
                } else {
                    await closeReaderBestEffort(reader, 'executeAndFetch');
                }
            }
            if (alertTimeout) {
                clearTimeout(alertTimeout);
            }
            if (documentUri) {
                if (signal && abortListener) {
                    signal.removeEventListener('abort', abortListener);
                }
                this.unregisterCommand(documentUri);
            }
        }
    }

    /**
     * Execute query with progressive chunk-based streaming.
     * Calls onChunk callback for each chunk of data for real-time UI updates.
     */
    async executeWithStreaming(
        connection: NzConnection,
        query: string,
        limit: number,
        chunkSize: number,
        timeoutSeconds: number | undefined,
        documentUri: string | undefined,
        onChunk: (chunk: StreamingChunk) => void,
        sessionId?: string,
        connectionManager?: { closeDocumentPersistentConnection(uri: string): Promise<void> },
        maxRows?: number,
        onDropSession?: (sessionId: string) => Promise<void>
    ): Promise<{ totalRows: number; limitReached: boolean; error?: Error; recordsAffected?: number; status: OperationStatus }> {
        const cmd = connection.createCommand(query);
        if (timeoutSeconds && timeoutSeconds > 0) {
            cmd.commandTimeout = timeoutSeconds;
        }

        // Track command
        const signal = documentUri
            ? this.registerCommand(documentUri, cmd, sessionId).signal
            : undefined;
        const cancellationContext: CancellationCleanupContext = { timeoutMs: CANCEL_TIMEOUT_MS };
        let abortListener: (() => void) | undefined;
        if (signal) {
            abortListener = () => {
                void cancelCommandAndCloseReader(cmd, reader, cancellationContext);
            };
            signal.addEventListener('abort', abortListener, { once: true });
        }

        const alertTimeout = this.setupLongQueryAlert();

        let reader: NzDataReader | undefined;
        let caughtError: Error | undefined;
        let operationStatus: OperationStatus = 'success';
        let commandCleanupDone = false;

        try {
            try {
                reader = await cmd.executeReader();
            } catch (executeErr: unknown) {
                caughtError = executeErr instanceof Error ? executeErr : new Error(String(executeErr));
                operationStatus = signal?.aborted || isCancellationError(executeErr)
                    ? 'cancelled'
                    : isTimeoutError(executeErr) ? 'timeout' : 'error';
                await cancelCommandAndCloseReader(cmd, reader, cancellationContext);
                return { totalRows: 0, limitReached: false, error: caughtError, recordsAffected: cmd._recordsAffected, status: operationStatus };
            }

            let totalRows = 0;
            let limitReached = false;
            const finalRowLimit = maxRows !== undefined ? maxRows : limit;

            try {
                // We only handle the first result set for streaming (common case)
                const columns: ReaderColumn[] = [];
                let chunk: unknown[][] = [];
                let isFirstChunk = true;
                let rowsSinceYield = 0;

                // Read column metadata BEFORE the fetch loop (even if there are 0 rows)
                for (let i = 0; i < reader.fieldCount; i++) {
                    const column: ReaderColumn = {
                        name: reader.getName(i),
                        type: getEffectiveResultColumnType(reader, i)
                    };
                    const scale = extractNumericScale(reader, i);
                    if (typeof scale === 'number') {
                        column.scale = scale;
                    }
                    columns.push(column);
                }

                let userCancelled = false;
                while (await reader.read()) {
                    // Check for cancellation
                    if (signal?.aborted) {
                        userCancelled = true;
                        operationStatus = 'cancelled';
                        // User cancelled during fetch - consume remaining data and cancel properly
                        await this.consumeRestAndCancel(
                            reader,
                            cmd,
                            documentUri,
                            sessionId,
                            connectionManager,
                            onDropSession,
                            true,
                            cancellationContext,
                        );
                        commandCleanupDone = true;
                        break;
                    }

                    // Add row to chunk
                    const row: unknown[] = [];
                    for (let i = 0; i < reader.fieldCount; i++) {
                        row.push(reader.getValue(i));
                    }
                    chunk.push(row);
                    totalRows++;
                    rowsSinceYield++;

                    if (rowsSinceYield % 200 === 0) {
                        await new Promise(resolve => setImmediate(resolve));
                    }

                    // Send chunk when it reaches chunk size
                    if (chunk.length >= chunkSize) {
                        onChunk({
                            columns: isFirstChunk ? columns : [],
                            rows: chunk,
                            isFirstChunk,
                            isLastChunk: false,
                            totalRowsSoFar: totalRows,
                            limitReached: false
                        });
                        chunk = [];
                        isFirstChunk = false;

                        // Yield to event loop periodically to allow Cancel messages to be processed
                        await new Promise(resolve => setImmediate(resolve));
                    }

                    // Check limit
                    if (totalRows >= finalRowLimit) {
                        limitReached = true;
                        await this.consumeRestAndCancel(
                            reader,
                            cmd,
                            documentUri,
                            sessionId,
                            connectionManager,
                            onDropSession,
                            true,
                            cancellationContext,
                        );
                        commandCleanupDone = true;
                        break;
                    }
                }

                // If user cancelled, return early with an error
                if (userCancelled) {
                    if (chunk.length > 0) {
                        onChunk({
                            columns: isFirstChunk ? columns : [],
                            rows: chunk,
                            isFirstChunk,
                            isLastChunk: true,
                            totalRowsSoFar: totalRows,
                            limitReached,
                            isCancelled: true,
                        });
                    }
                    return { totalRows, limitReached, error: new Error('Query cancelled'), recordsAffected: cmd._recordsAffected, status: 'cancelled' };
                }

                // Send final chunk (even if empty, to signal completion)
                // But skip it if we were cancelled in the meantime
                if (signal?.aborted) {
                    operationStatus = 'cancelled';
                    if (chunk.length > 0) {
                        onChunk({
                            columns: isFirstChunk ? columns : [],
                            rows: chunk,
                            isFirstChunk,
                            isLastChunk: true,
                            totalRowsSoFar: totalRows,
                            limitReached,
                            isCancelled: true,
                        });
                    }
                    return { totalRows, limitReached, error: caughtError || new Error('Query cancelled'), recordsAffected: cmd._recordsAffected, status: 'cancelled' };
                }

                onChunk({
                    columns: isFirstChunk ? columns : [],
                    rows: chunk,
                    isFirstChunk,
                    isLastChunk: true,
                    totalRowsSoFar: totalRows,
                    limitReached
                });
            } catch (readErr: unknown) {
                caughtError = readErr instanceof Error ? readErr : new Error(String(readErr));
                operationStatus = signal?.aborted || isCancellationError(readErr)
                    ? 'cancelled'
                    : isTimeoutError(readErr) ? 'timeout' : 'error';
            }

            return { totalRows, limitReached, error: caughtError, recordsAffected: cmd._recordsAffected, status: operationStatus };
        } finally {
            if (reader && !commandCleanupDone) {
                if (caughtError && isConnectionRecoveryError(caughtError)) {
                    await this.consumeRestAndCancel(
                        reader,
                        cmd,
                        documentUri,
                        sessionId,
                        connectionManager,
                        onDropSession,
                        true,
                        cancellationContext,
                    );
                } else {
                    await closeReaderBestEffort(reader, 'executeWithStreaming');
                }
            }
            if (alertTimeout) {
                clearTimeout(alertTimeout);
            }
            if (documentUri) {
                if (signal && abortListener) {
                    signal.removeEventListener('abort', abortListener);
                }
                this.unregisterCommand(documentUri);
            }
        }
    }

    /**
     * Sets up a timeout to alert the user when a query exceeds the configured threshold.
     * Returns the timeout handle for cleanup, or undefined if alerts are disabled.
     */
    private setupLongQueryAlert(): ReturnType<typeof setTimeout> | undefined {
        const config = getExtensionConfiguration();
        const alertThresholdMinutes = config.get<number>("longQueryAlertThreshold", 10) ?? 10;

        if (alertThresholdMinutes > 0) {
            return setTimeout(() => {
                vscode.window.showWarningMessage(
                    `Query is taking longer than ${alertThresholdMinutes} minute(s) to execute.`
                );
            }, alertThresholdMinutes * 60 * 1000);
        }
        return undefined;
    }
}
