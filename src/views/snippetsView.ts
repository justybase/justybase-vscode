import * as vscode from 'vscode';
import { FavoritesManager } from '../core/favoritesManager';
import {
    toSnippetDto,
    type SnippetsHostToWebviewMessage,
    type SnippetsWebviewToHostMessage,
} from '../contracts/webviews';
import { isSqlAuthoringLanguageId } from '../utils/sqlLanguage';
import { logWithFallback } from '../utils/logger';

type SaveSnippetMessage = { id?: string; name: string; tags: string; sql: string };
type DeleteSnippetMessage = { id: string; name: string };

/**
 * Sidebar panel for saving, searching, inserting, and running reusable SQL
 * snippets. Snippets are stored as `type: 'sql'` favorites so they also remain
 * available in the schema tree, settings, and Copilot context.
 */
export class SnippetsView implements vscode.WebviewViewProvider {
    public static readonly viewType = 'netezza.snippets';

    private _view?: vscode.WebviewView;
    private _favoritesListener?: vscode.Disposable;
    private _pendingOpenForm?: { sql: string };

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext,
    ) { }

    public resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        const manager = FavoritesManager.getInstance(this._context);
        this._favoritesListener = manager.onDidChangeFavorites(() => {
            void this.sendSnippets();
        });

        webviewView.onDidDispose(() => {
            this._favoritesListener?.dispose();
            this._favoritesListener = undefined;
            if (this._view === webviewView) {
                this._view = undefined;
            }
        });

        webviewView.webview.onDidReceiveMessage(async (message: SnippetsWebviewToHostMessage) => {
            switch (message.type) {
                case 'getSnippets':
                    await this.sendSnippets();
                    break;
                case 'getCurrentSql':
                    await this.postMessage({ type: 'currentSql', sql: this.getCurrentSql() });
                    break;
                case 'saveSnippet':
                    await this.saveSnippet(message);
                    break;
                case 'deleteSnippet':
                    await this.deleteSnippet(message);
                    break;
                case 'insertSnippet':
                    await this.insertSnippet(message.sql);
                    break;
                case 'runSnippet':
                    await this.runSnippet(message.sql);
                    break;
            }
        });

        if (this._pendingOpenForm) {
            const { sql } = this._pendingOpenForm;
            this._pendingOpenForm = undefined;
            void this.postMessage({ type: 'openForm', sql });
        }
    }

    /** Opens the panel and starts a blank snippet form prefilled with the active SQL. */
    public async openNewSnippet(): Promise<void> {
        // Capture the SQL before moving focus to the panel.
        const sql = this.getCurrentSql();
        await this.focus();
        if (this._view) {
            await this.postMessage({ type: 'openForm', sql });
        } else {
            this._pendingOpenForm = { sql };
        }
    }

    /** Command entry point for "Save Current SQL as Snippet". */
    public async openFormWithCurrentSql(): Promise<void> {
        await this.openNewSnippet();
    }

    private async focus(): Promise<void> {
        await vscode.commands.executeCommand('workbench.view.extension.netezza-explorer');
        await vscode.commands.executeCommand('netezza.snippets.focus');
    }

    private async sendSnippets(): Promise<void> {
        if (!this._view) {
            return;
        }
        try {
            const manager = FavoritesManager.getInstance(this._context);
            const snippets = (await manager.getSqlSnippets()).map(toSnippetDto);
            await this.postMessage({
                type: 'snippetsData',
                snippets,
                currentSql: this.getCurrentSql(),
            });
        } catch (error) {
            await this.sendError('Could not load snippets', error);
        }
    }

    private async saveSnippet(message: SaveSnippetMessage): Promise<void> {
        const name = message.name.trim();
        const sql = message.sql.trim();
        const tags = message.tags.trim();
        if (!name) {
            await this.postMessage({ type: 'snippetsError', message: 'Give the snippet a name.' });
            return;
        }
        if (!sql) {
            await this.postMessage({ type: 'snippetsError', message: 'The SQL text is empty.' });
            return;
        }

        try {
            const manager = FavoritesManager.getInstance(this._context);
            let id = message.id;
            if (id) {
                const updated = await manager.updateSnippet(id, name, sql, tags);
                if (!updated) {
                    await this.postMessage({
                        type: 'snippetsError',
                        message: `Could not update "${name}". The name may already be in use.`,
                    });
                    return;
                }
            } else {
                id = await manager.addSqlSnippet(name, sql, undefined, tags);
            }
            await this.postMessage({ type: 'snippetSaved', id, name });
            await this.sendSnippets();
            vscode.window.showInformationMessage(`Snippet "${name}" saved.`);
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            await this.postMessage({ type: 'snippetsError', message: text });
        }
    }

    private async deleteSnippet(message: DeleteSnippetMessage): Promise<void> {
        const confirmation = await vscode.window.showWarningMessage(
            `Delete snippet "${message.name}"?`,
            { modal: true },
            'Delete',
        );
        if (confirmation !== 'Delete') {
            return;
        }

        try {
            await FavoritesManager.getInstance(this._context).removeFavoriteById(message.id);
            await this.postMessage({ type: 'snippetDeleted', id: message.id, name: message.name });
            await this.sendSnippets();
            vscode.window.showInformationMessage(`Snippet "${message.name}" deleted.`);
        } catch (error) {
            await this.sendError('Could not delete the snippet', error);
        }
    }

    private async insertSnippet(sql: string): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (editor && isSqlAuthoringLanguageId(editor.document.languageId)) {
            await editor.edit((builder) => {
                if (editor.selection.isEmpty) {
                    builder.insert(editor.selection.active, sql);
                } else {
                    builder.replace(editor.selection, sql);
                }
            });
            return;
        }
        await this.openSqlInEditor(sql);
    }

    private async runSnippet(sql: string): Promise<void> {
        await this.openSqlInEditor(sql);
        try {
            await vscode.commands.executeCommand('netezza.runQuery');
        } catch (error) {
            logWithFallback('error', '[SnippetsView] Failed to run snippet', error);
        }
    }

    private async openSqlInEditor(sql: string): Promise<void> {
        const document = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
        await vscode.window.showTextDocument(document, { preview: false });
    }

    private getCurrentSql(): string {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isSqlAuthoringLanguageId(editor.document.languageId)) {
            return '';
        }
        return editor.selection.isEmpty
            ? editor.document.getText()
            : editor.document.getText(editor.selection);
    }

    private async sendError(prefix: string, error: unknown): Promise<void> {
        const message = error instanceof Error ? error.message : String(error);
        logWithFallback('error', `[SnippetsView] ${prefix}`, error);
        await this.postMessage({ type: 'snippetsError', message: `${prefix}: ${message}` });
    }

    private async postMessage(message: SnippetsHostToWebviewMessage): Promise<void> {
        if (!this._view) {
            return;
        }
        await this._view.webview.postMessage(message);
    }

    private _getWebviewCsp(webview: vscode.Webview): string {
        return `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};`;
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const csp = this._getWebviewCsp(webview);
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'snippets.css'),
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'snippets.js'),
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Snippets</title>
    <link href="${styleUri}" rel="stylesheet">
</head>
<body>
    <div id="app"></div>
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
