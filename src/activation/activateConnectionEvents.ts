import * as vscode from 'vscode';
import type { ConnectionAccentDecorationProvider } from '../decorations/connectionAccentDecorationProvider';
import type { ConnectionManager } from '../core/connectionManager';
import { normalizeUriKey } from '../core/queryRunnerUtils';
import { isSqlAuthoringLanguageId } from '../utils/sqlLanguage';

export interface ConnectionStatusBarHandlers {
    updateActiveConnectionStatusBar: () => void;
    updateActiveDatabaseStatusBar: () => void;
    updateKeepConnectionStatusBar: () => void;
}

export interface ActivateConnectionEventsParams {
    context: vscode.ExtensionContext;
    connectionManager: ConnectionManager;
    connectionAccentDecorationProvider: ConnectionAccentDecorationProvider;
    statusBarHandlers: ConnectionStatusBarHandlers;
    onPrefetchConnection: (connectionName: string | undefined) => void;
    onRefreshCurrentSchemaForDocument?: (documentUri: string) => void;
}

function isActiveDocumentUri(documentUri: string): boolean {
    const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
    if (!activeUri) {
        return false;
    }
    return normalizeUriKey(activeUri) === normalizeUriKey(documentUri);
}

function refreshStatusBars(statusBarHandlers: ConnectionStatusBarHandlers): void {
    const {
        updateActiveConnectionStatusBar,
        updateActiveDatabaseStatusBar,
        updateKeepConnectionStatusBar,
    } = statusBarHandlers;

    updateActiveConnectionStatusBar();
    void updateActiveDatabaseStatusBar();
    updateKeepConnectionStatusBar();
}

function refreshStatusBarsForOpenedSqlDocument(
    document: vscode.TextDocument,
    statusBarHandlers: ConnectionStatusBarHandlers,
): void {
    if (!isSqlAuthoringLanguageId(document.languageId)) {
        return;
    }

    const documentUri = normalizeUriKey(document.uri.toString());
    const isVisible = vscode.window.visibleTextEditors.some(
        (editor) => normalizeUriKey(editor.document.uri.toString()) === documentUri,
    );
    if (!isVisible) {
        return;
    }

    // Language-mode changes close/reopen the document; defer until the active editor catches up.
    queueMicrotask(() => refreshStatusBars(statusBarHandlers));
}

/**
 * Wires connection-manager and editor events to status bars, accent decorations, and metadata prefetch.
 */
export function activateConnectionEvents(params: ActivateConnectionEventsParams): void {
    const {
        context,
        connectionManager,
        connectionAccentDecorationProvider,
        statusBarHandlers,
        onPrefetchConnection,
        onRefreshCurrentSchemaForDocument,
    } = params;

    const {
        updateActiveConnectionStatusBar,
        updateActiveDatabaseStatusBar,
    } = statusBarHandlers;

    connectionManager.onDidChangeActiveConnection(connectionName => {
        connectionAccentDecorationProvider.refresh();
        refreshStatusBars(statusBarHandlers);
        onPrefetchConnection(connectionName ?? undefined);
    });
    connectionManager.onDidChangeConnections(() => {
        connectionAccentDecorationProvider.refresh();
        updateActiveConnectionStatusBar();
        onPrefetchConnection(connectionManager.getActiveConnectionName() ?? undefined);
    });
    connectionManager.onDidChangeDocumentConnection((documentUri: string) => {
        connectionAccentDecorationProvider.refresh();
        if (isActiveDocumentUri(documentUri)) {
            refreshStatusBars(statusBarHandlers);
        }
        onPrefetchConnection(connectionManager.getDocumentConnection(documentUri) ?? undefined);
    });
    connectionManager.onDidChangeDocumentDatabase((documentUri: string) => {
        onRefreshCurrentSchemaForDocument?.(documentUri);
        if (isActiveDocumentUri(documentUri)) {
            updateActiveDatabaseStatusBar();
        }
    });

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
            refreshStatusBars(statusBarHandlers);
        }),
        vscode.window.onDidChangeVisibleTextEditors(() => {
            refreshStatusBars(statusBarHandlers);
        }),
        vscode.workspace.onDidOpenTextDocument((document) => {
            refreshStatusBarsForOpenedSqlDocument(document, statusBarHandlers);
        }),
    );
}
