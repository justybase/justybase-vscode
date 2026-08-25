import { cancelQueryByUri } from '../../core/queryRunner';
import { executeDropSession } from '../../core/queryRunnerHelpers';
import { streamingManager } from '../../core/queryCancellation';
import type { ConnectionManager } from '../../core/connectionManager';

import type { QueryExecutionRecovery } from './queryExecutionGate';

const CONNECTION_RESET_TIMEOUT_MS = 5_000;

async function completesWithin(action: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            action.then(() => true, () => false),
            new Promise<boolean>(resolve => {
                timer = setTimeout(() => resolve(false), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

/** Recovery operations are deliberately bound to the originating tab and connection. */
export function createQueryExecutionRecovery(
    connectionManager: ConnectionManager,
    sourceUri: string,
    connectionName?: string,
): QueryExecutionRecovery {
    const usesPersistentConnection = connectionManager.getDocumentKeepConnectionOpen?.(sourceUri) ?? true;
    return {
        requestCancel: () => cancelQueryByUri(sourceUri),
        getSessionId: () => connectionManager.getDocumentLastSessionId?.(sourceUri),
        dropSession: (sessionId) => executeDropSession(
            sessionId,
            connectionManager,
            sourceUri,
            connectionName,
            { reconnectDocument: false },
        ),
        resetConnection: () => {
            // A transient connection is owned by the active executor and is not
            // present in ConnectionManager's persistent cache. Claiming that an
            // empty cache was reset would allow a second command to start while
            // the first server session may still be running.
            const keepConnectionOpenNow = connectionManager.getDocumentKeepConnectionOpen?.(sourceUri)
                ?? usesPersistentConnection;
            if (!keepConnectionOpenNow) {
                return Promise.resolve(false);
            }
            return completesWithin(
                connectionManager.closeDocumentPersistentConnection(sourceUri),
                CONNECTION_RESET_TIMEOUT_MS,
            );
        },
        openFreshConnection: async () => {
            try {
                // There is no manager-owned socket to detach in transient mode.
                // The active executor must finish and close it before retrying.
                const keepConnectionOpenNow = connectionManager.getDocumentKeepConnectionOpen?.(sourceUri)
                    ?? usesPersistentConnection;
                if (!keepConnectionOpenNow) {
                    return false;
                }
                await connectionManager.abandonAndRecreateDocumentPersistentConnection(
                    sourceUri,
                    connectionName,
                );
                return true;
            } catch {
                return false;
            }
        },
        clearCancellation: () => streamingManager.clearAborted(sourceUri),
        allowForcedRecovery: usesPersistentConnection,
        forcedRecoveryUnavailableMessage: usesPersistentConnection
            ? undefined
            : 'This tab uses transient connections; cancel the current operation and wait for it to finish before retrying.',
    };
}
