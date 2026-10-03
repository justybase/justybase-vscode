import { ConnectionManager } from './connectionManager';
import { isBusyConnectionError } from './queryRunnerUtils';
import { normalizeUriKey } from './uriUtils';
import { logWithFallback } from '../utils/logger';
import type { ExecutionCurrentCheck } from './executionGuard';

export { isBusyConnectionError };

export interface WaitForConnectionReadyOptions {
    maxWaitMs?: number;
    pollIntervalMs?: number;
}

const DEFAULT_MAX_WAIT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

export function isTimeoutLikeError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /timeout|timed out|time.?out/i.test(message);
}

export function isConnectionRecoveryError(error: unknown): boolean {
    return isBusyConnectionError(error) || isTimeoutLikeError(error);
}

async function probeConnectionReady(
    connection: Awaited<ReturnType<ConnectionManager['getDocumentPersistentConnection']>>,
): Promise<void> {
    const cmd = connection.createCommand('SELECT CURRENT_SID');
    const reader = await cmd.executeReader();
    try {
        await reader.read();
    } finally {
        await reader.close();
    }
}

/**
 * Poll until the persistent tab connection accepts a new command after timeout/cancel.
 */
export async function waitForPersistentConnectionReady(
    connManager: ConnectionManager,
    documentUri: string,
    connectionName?: string,
    options?: WaitForConnectionReadyOptions,
): Promise<void> {
    const normalizedUri = normalizeUriKey(documentUri);
    if (!connManager.getDocumentKeepConnectionOpen(normalizedUri)) {
        return;
    }

    const connection = await connManager.getDocumentPersistentConnection(normalizedUri, connectionName);
    const maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + maxWaitMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
        try {
            await probeConnectionReady(connection);
            return;
        } catch (error) {
            lastError = error;
            if (!isBusyConnectionError(error)) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new Error(`Connection stayed busy for ${maxWaitMs}ms`);
}

/** Best-effort preflight before user-facing SQL on a persistent tab connection. */
export async function ensurePersistentConnectionReadyForQuery(
    connManager: ConnectionManager,
    documentUri: string | undefined,
    connectionName?: string,
    options?: WaitForConnectionReadyOptions,
): Promise<void> {
    if (!documentUri) {
        return;
    }
    try {
        await waitForPersistentConnectionReady(connManager, documentUri, connectionName, options);
    } catch {
        // Preflight is best-effort; callers may still retry after query failure.
    }
}

export interface ReestablishBrokenConnectionOptions {
    connectionName?: string;
    keepConnectionOpen?: boolean;
    isExecutionCurrent?: ExecutionCurrentCheck;
    onMessage?: (message: string) => void;
}

/**
 * Close + reopen a persistent tab connection after a broken-connection failure
 * whose SQL could not be proven safe to retry.
 *
 * The failed statement is never replayed here; this only drops the dead socket
 * so the next query starts fresh without manual Close/Open. Best-effort: never
 * throws, returns true when a fresh connection was established.
 */
export async function reestablishPersistentConnectionAfterBrokenError(
    connManager: ConnectionManager,
    documentUri: string | undefined,
    options: ReestablishBrokenConnectionOptions = {},
): Promise<boolean> {
    if (!documentUri) {
        return false;
    }
    const keepOpen = options.keepConnectionOpen
        ?? connManager.getDocumentKeepConnectionOpen(documentUri);
    if (!keepOpen) {
        return false;
    }
    if (options.isExecutionCurrent && !options.isExecutionCurrent()) {
        return false;
    }

    try {
        options.onMessage?.('Connection was lost. Resetting connection...');
        await connManager.closeDocumentPersistentConnection(documentUri);
        if (options.isExecutionCurrent && !options.isExecutionCurrent()) {
            return false;
        }
        await connManager.getDocumentPersistentConnection(documentUri, options.connectionName);
        options.onMessage?.('Connection reset. Verify the database state before running the statement again.');
        return true;
    } catch (resetError: unknown) {
        logWithFallback('warn', '[ConnectionManager] Failed to re-establish persistent connection after broken error:', resetError);
        options.onMessage?.('Connection reset failed. Reopen the connection manually before retrying.');
        return false;
    }
}
