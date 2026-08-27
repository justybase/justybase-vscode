import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import { isSqlAuthoringLanguageId } from '../utils/sqlLanguage';

export const NEW_SQL_TAB_WITH_CONTEXT_COMMAND = 'netezza.newSqlTabWithContext';

const NEW_UNTITLED_FILE_COMMAND = 'workbench.action.files.newUntitledFile';

/**
 * Open a fresh SQL editor and copy the execution context from the active SQL tab.
 * The target gets its own persistent session because sessions remain keyed by URI.
 */
export async function openNewSqlTabWithContext(connectionManager: ConnectionManager): Promise<void> {
    const sourceEditor = vscode.window.activeTextEditor;
    if (!sourceEditor || !isSqlAuthoringLanguageId(sourceEditor.document.languageId)) {
        await vscode.commands.executeCommand(NEW_UNTITLED_FILE_COMMAND);
        return;
    }

    const sourceDocument = sourceEditor.document;
    const sourceUri = sourceDocument.uri.toString();
    const sourceLanguageId = sourceDocument.languageId;
    const connectionName = connectionManager.getConnectionForExecution(sourceUri);
    const databaseOverride = connectionManager.getDocumentDatabase(sourceUri);

    await vscode.commands.executeCommand(NEW_UNTITLED_FILE_COMMAND);

    const targetEditor = vscode.window.activeTextEditor;
    if (
        !targetEditor
        || targetEditor.document.uri.scheme !== 'untitled'
        || targetEditor.document.uri.toString() === sourceUri
    ) {
        return;
    }

    let targetDocument = targetEditor.document;
    if (targetDocument.languageId !== sourceLanguageId) {
        // Changing a language can emit a close/open lifecycle for the same
        // untitled document. Apply the connection context only afterwards so
        // activateEditorSync cannot clear the newly copied values.
        targetDocument = await vscode.languages.setTextDocumentLanguage(
            targetDocument,
            sourceLanguageId,
        );
    }

    if (!connectionName) {
        return;
    }

    const targetUri = targetDocument.uri.toString();
    await connectionManager.setDocumentConnection(targetUri, connectionName);
    if (databaseOverride !== undefined) {
        await connectionManager.setDocumentDatabase(targetUri, databaseOverride);
    }
}

export function registerNewSqlTabCommand(connectionManager: ConnectionManager): vscode.Disposable {
    return vscode.commands.registerCommand(
        NEW_SQL_TAB_WITH_CONTEXT_COMMAND,
        () => openNewSqlTabWithContext(connectionManager),
    );
}
