import { ConnectionManager } from './connectionManager';
import { isBusyConnectionError } from './queryRunnerUtils';
import { normalizeUriKey } from './uriUtils';

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
