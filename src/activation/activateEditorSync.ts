import * as vscode from 'vscode';
import { logWithFallback } from '../utils/logger';
import type { ConnectionAccentDecorationProvider } from '../decorations/connectionAccentDecorationProvider';
import type { ConnectionManager } from '../core/connectionManager';
import type { ResultPanelView } from '../views/resultPanelView';
import type { MetadataPrefetchCoordinator } from './MetadataPrefetchCoordinator';

function isResultSyncSqlDocument(doc: vscode.TextDocument | undefined): doc is vscode.TextDocument {
    if (!doc?.uri || typeof doc.languageId !== 'string') {
        return false;
    }
    const scheme = doc.uri.scheme;
    if (!scheme || scheme === 'vscode-notebook-cell') {
        return false;
    }
    if (scheme === 'untitled') {
        return true;
    }
    if (scheme !== 'file') {
        return false;
    }
    const languageId = doc.languageId.toLowerCase();
    return languageId === 'sql' || languageId === 'netezza-sql' || languageId.includes('sql');
}

export interface ActivateEditorSyncParams {
    context: vscode.ExtensionContext;
    connectionManager: ConnectionManager;
    connectionAccentDecorationProvider: ConnectionAccentDecorationProvider;
    resultPanelProvider: ResultPanelView;
    metadataPrefetchCoordinator: MetadataPrefetchCoordinator;
}

export function activateEditorSync(params: ActivateEditorSyncParams): void {
    const {
        context,
        connectionManager,
        connectionAccentDecorationProvider,
        resultPanelProvider,
        metadataPrefetchCoordinator,
    } = params;

    const clearPrimedResultCopyContext = (): void => {
        void vscode.commands.executeCommand('setContext', 'netezza.resultsCopyPrimed', false);
    };

    const syncResultPanelSourceWithEditor = (editor: vscode.TextEditor | undefined) => {
        if (isResultSyncSqlDocument(editor?.document)) {
            resultPanelProvider.setActiveSource(editor.document.uri.toString());
        }
    };

    const refreshConnectionAccentForDocument = (document: vscode.TextDocument | undefined) => {
        if (isResultSyncSqlDocument(document)) {
            connectionAccentDecorationProvider.refresh(document.uri);
        }
    };

    const clearPrimedResultCopy = () => {
        clearPrimedResultCopyContext();
    };
    const clearResultPanelFocusContexts = () => {
        void vscode.commands.executeCommand('setContext', 'netezza.resultsFocused', false);
        void vscode.commands.executeCommand('setContext', 'netezza.resultsInputFocused', false);
    };

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            clearPrimedResultCopy();
            clearResultPanelFocusContexts();
            syncResultPanelSourceWithEditor(editor);
            refreshConnectionAccentForDocument(editor?.document);
        }),
        vscode.window.onDidChangeTextEditorSelection(event => {
            if (event.textEditor === vscode.window.activeTextEditor) {
                clearPrimedResultCopy();
                clearResultPanelFocusContexts();
                syncResultPanelSourceWithEditor(event.textEditor);
            }
        }),
        vscode.workspace.onDidOpenTextDocument(doc => {
            refreshConnectionAccentForDocument(doc);
            metadataPrefetchCoordinator.triggerForDocument(doc);
        }),
        vscode.workspace.onDidCloseTextDocument(doc => {
            if (isResultSyncSqlDocument(doc)) {
                const sourceUri = doc.uri.toString();
                resultPanelProvider.closeSource(sourceUri);
                connectionManager.closeDocumentPersistentConnection(sourceUri).catch(e => {
                    logWithFallback('error', 'Failed to close persistent connection for document:', e);
                });
            }
        }),
    );

    clearPrimedResultCopy();
    clearResultPanelFocusContexts();
    syncResultPanelSourceWithEditor(vscode.window.activeTextEditor);
    refreshConnectionAccentForDocument(vscode.window.activeTextEditor?.document);
}
