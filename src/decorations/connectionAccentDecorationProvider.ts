import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import {
    CONNECTION_ACCENT_BADGE,
    getConnectionAccentBadge,
    getConnectionAccentOption,
    getConnectionNameFromAccentResourceUri
} from '../utils/connectionAccent';

function isDecoratedSqlDocument(document: vscode.TextDocument | undefined): document is vscode.TextDocument {
    if (!document || !document.uri || typeof document.languageId !== 'string') {
        return false;
    }

    const scheme = document.uri.scheme;
    if (scheme !== 'file' && scheme !== 'untitled') {
        return false;
    }

    const languageId = document.languageId.toLowerCase();
    return languageId === 'sql' || languageId === 'netezza-sql' || languageId.includes('sql');
}

export class ConnectionAccentDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
    private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<
        vscode.Uri | vscode.Uri[] | undefined
    >();

    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    constructor(private readonly connectionManager: ConnectionManager) { }

    provideFileDecoration(uri: vscode.Uri, _token: vscode.CancellationToken): vscode.FileDecoration | undefined {
        const connectionName = this._resolveConnectionName(uri);
        if (!connectionName) {
            return undefined;
        }

        const connectionDetails = this.connectionManager.getConnectionMetadata(connectionName);
        const accentOption = getConnectionAccentOption(connectionDetails?.accentColor);
        if (!accentOption) {
            return undefined;
        }

        return {
            badge: getConnectionAccentBadge(accentOption.id) || CONNECTION_ACCENT_BADGE,
            tooltip: `Connection accent: ${accentOption.label} (${connectionName})`,
            propagate: false
        };
    }

    refresh(uri?: vscode.Uri | readonly vscode.Uri[]): void {
        if (!uri) {
            this._onDidChangeFileDecorations.fire(undefined);
            return;
        }

        const resources = Array.isArray(uri) ? [...uri] : uri;
        this._onDidChangeFileDecorations.fire(resources as vscode.Uri | vscode.Uri[]);
    }

    dispose(): void {
        this._onDidChangeFileDecorations.dispose();
    }

    private _resolveConnectionName(uri: vscode.Uri): string | undefined {
        const connectionNameFromTree = getConnectionNameFromAccentResourceUri(uri);
        if (connectionNameFromTree) {
            return connectionNameFromTree;
        }

        const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
        if (isDecoratedSqlDocument(document)) {
            return this.connectionManager.getConnectionForExecution(uri.toString());
        }

        const activeDocument = vscode.window.activeTextEditor?.document;
        if (activeDocument?.uri.toString() === uri.toString() && isDecoratedSqlDocument(activeDocument)) {
            return this.connectionManager.getConnectionForExecution(uri.toString());
        }

        return undefined;
    }
}
