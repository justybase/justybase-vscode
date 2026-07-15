import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { getErrorMessage } from './connectionUtils';
import { createConnectedDatabaseConnectionFromDetails, resolveConnectionDatabaseKind } from './connectionFactory';
import { QueryHistoryManager } from './queryHistoryManager';
import { NzConnection } from '../types';
import { OutputLogger, normalizeUriKey, logOutput } from './queryRunnerUtils';
import { logWithFallback } from '../utils/logger';
import {
    isSqlConsoleDocument,
    SQL_CONSOLE_HISTORY_TAG,
} from '../utils/sqlConsole';

export async function getConnectionForDocument(
    connManager: ConnectionManager,
    resolvedConnectionName: string,
    keepConnectionOpen: boolean,
    documentUri?: string
): Promise<{ connection: NzConnection; shouldCloseConnection: boolean }> {
    if (keepConnectionOpen && documentUri) {
        const connection = await connManager.getDocumentPersistentConnection(
            documentUri,
            resolvedConnectionName
        );
        return { connection, shouldCloseConnection: false };
    }

    const details = await connManager.getConnection(resolvedConnectionName);
    if (!details) {
        throw new Error(`Connection '${resolvedConnectionName}' not found`);
    }
    const connection = await createConnectedDatabaseConnectionFromDetails(details) as NzConnection;
    return { connection, shouldCloseConnection: true };
}

export async function executeDropSession(
    sessionId: string,
    connectionManager: ConnectionManager,
    documentUri?: string
): Promise<void> {
    try {
        const connName = connectionManager.getActiveConnectionName();
        if (connName) {
            const details = await connectionManager.getConnection(connName);
            if (details) {
                if (resolveConnectionDatabaseKind(details.dbType) === 'sqlite') {
                    vscode.window.showInformationMessage('Session cancellation is not supported for SQLite connections.');
                    return;
                }
                const connection = await createConnectedDatabaseConnectionFromDetails(details) as NzConnection;
                try {
                    const dropCmd = connection.createCommand(`DROP SESSION ${sessionId}`);
                    const r = await dropCmd.executeReader();
                    await r.close();
                    vscode.window.showInformationMessage(
                        `Session ${sessionId} dropped successfully.`
                    );

                    if (
                        documentUri
                        && connectionManager.getDocumentKeepConnectionOpen(documentUri)
                    ) {
                        await connectionManager.closeDocumentPersistentConnection(documentUri);
                        await connectionManager.getDocumentPersistentConnection(
                            documentUri,
                            connName
                        );
                        logWithFallback('info',
                            `[executeDropSession] Re-established per-document persistent connection for ${documentUri}`
                        );
                    }
                } finally {
                    await connection.close();
                }
            }
        }
    } catch (dropErr) {
        const dropMsg = getErrorMessage(dropErr);
        logWithFallback('error', `[executeDropSession] Failed to drop session ${sessionId}:`, dropErr);
        vscode.window.showErrorMessage(`Failed to drop session: ${dropMsg}`);
    }
}

export async function logQueryToHistory(
    context: vscode.ExtensionContext,
    connManager: ConnectionManager,
    resolvedConnectionName: string,
    query: string,
    isUserQuery: boolean = true,
    documentUri?: string,
    status?: 'success' | 'error' | 'cancelled',
    durationMs?: number,
    rowsAffected?: number,
    errorMessage?: string,
): Promise<void> {
    try {
        if (!isUserQuery) {
            return;
        }
        const details = await connManager.getConnection(resolvedConnectionName);
        if (!details) {
            logWithFallback('warn', '[History] No connection details found, skipping history log');
            return;
        }

        // Keep this tolerant of lightweight ConnectionManager test doubles and
        // older integrations that do not expose the optional resolver yet.
        const currentSchema = connManager.getSchemaForConnection?.(resolvedConnectionName)
            || (typeof details.schema === 'string' && details.schema.length > 0 ? details.schema : 'UNKNOWN');

        const historyManager = QueryHistoryManager.getInstance(context);
        const tags = documentUri && isSqlConsoleDocument(context, documentUri)
            ? SQL_CONSOLE_HISTORY_TAG
            : undefined;
        await historyManager.addEntry(
            details.host,
            details.database,
            currentSchema,
            query,
            resolvedConnectionName,
            tags,
            undefined,
            true,
            status,
            durationMs,
            rowsAffected,
            errorMessage,
        );
        logWithFallback('debug',
            `[History] Saved query to history: ${query.substring(0, 50)}...`
        );
    } catch (err) {
        logWithFallback('error', '[History] Failed to log query:', err);
    }
}

export async function handleBusyConnectionError(
    error: unknown,
    connManager: ConnectionManager,
    logger: OutputLogger,
    documentUri?: string,
    silent: boolean = false
): Promise<boolean> {
    const errObj = error as { message?: string };
    const errMsg = errObj.message || String(error);

    if (
        errMsg.includes('Connection is already executing a command')
        && documentUri
        && !silent
    ) {
        const lastSessionId = connManager.getDocumentLastSessionId(
            normalizeUriKey(documentUri)
        );
        logOutput(
            logger,
            `Error: Connection is busy (last known session: ${lastSessionId ?? 'unknown'})`
        );

        vscode.window
            .showWarningMessage(
                `The connection is busy executing another command. ${lastSessionId ? `Session ID: ${lastSessionId}` : ''}`,
                lastSessionId ? `Drop Session ${lastSessionId}` : '',
                'Reset Connection'
            )
            .then(async selection => {
                if (
                    selection
                    && lastSessionId
                    && selection === `Drop Session ${lastSessionId}`
                ) {
                    await executeDropSession(lastSessionId, connManager, documentUri);
                } else if (selection === 'Reset Connection') {
                    await connManager.closeDocumentPersistentConnection(documentUri);
                    vscode.window.showInformationMessage(
                        'Connection reset. You can try executing the query again.'
                    );
                }
            });
        return true;
    }
    return false;
}
