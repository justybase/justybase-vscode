import * as vscode from 'vscode';
import type { FileSearchInboundMessage, FileSearchOptions, FileSearchOutboundMessage } from '../contracts/webviews/fileSearchContracts';
import { FileSearchHtmlGenerator } from '../views/fileSearchHtmlGenerator';
import { fileSearch, replaceInFiles } from '../services/fileSearchService';

export class FileSearchProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'netezza.fileSearch';
    private _view?: vscode.WebviewView;
    private _disposables: vscode.Disposable[] = [];
    private readonly _sessionId: string;
    private _abortController: AbortController | undefined;

    private static _revealDecoration: vscode.TextEditorDecorationType | undefined;
    private _revealTimeout: ReturnType<typeof setTimeout> | undefined;
    private _revealedEditor: vscode.TextEditor | undefined;

    constructor(
        private readonly _extensionUri: vscode.Uri
    ) {
        this._sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    private static getRevealDecoration(): vscode.TextEditorDecorationType {
        if (!FileSearchProvider._revealDecoration) {
            FileSearchProvider._revealDecoration = vscode.window.createTextEditorDecorationType({
                backgroundColor: 'rgba(66, 133, 244, 0.20)',
                border: '1px solid rgba(66, 133, 244, 0.60)',
                isWholeLine: true,
                rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
            });
        }
        return FileSearchProvider._revealDecoration;
    }

    private clearRevealHighlight(): void {
        if (this._revealTimeout) {
            clearTimeout(this._revealTimeout);
            this._revealTimeout = undefined;
        }
        if (this._revealedEditor) {
            this._revealedEditor.setDecorations(FileSearchProvider.getRevealDecoration(), []);
            this._revealedEditor = undefined;
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.disposeViewResources();
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        this._disposables.push(webviewView.webview.onDidReceiveMessage(async (data: FileSearchInboundMessage) => {
            await this.handleMessage(data);
        }));

        webviewView.webview.html = new FileSearchHtmlGenerator(this._sessionId).generateHtml();
    }

    public dispose(): void {
        this.clearRevealHighlight();
        this.disposeViewResources();
    }

    private disposeViewResources(): void {
        for (const disposable of this._disposables) {
            disposable.dispose();
        }
        this._disposables = [];
    }

    private async handleMessage(data: FileSearchInboundMessage): Promise<void> {
        switch (data.type) {
            case 'search':
                await this.runSearch(data.options);
                return;
            case 'cancel':
                this.cancelSearch();
                return;
            case 'openFile':
                await this.openFile(data.fileUri, data.line);
                return;
            case 'reset':
                this.postMessage({ type: 'reset' });
                return;
            case 'replaceAll':
                await this.runReplaceAll(data.options);
                return;
        }
    }

    private async runSearch(options: FileSearchOptions): Promise<void> {
        this.cancelSearch();
        this._abortController = new AbortController();
        const token = this._abortController.signal;

        if (!this._view) return;

        this.postMessage({ type: 'searching', message: 'Searching...' });

        try {
            const { results, fileMatches } = await fileSearch(
                options,
                token as unknown as vscode.CancellationToken
            );

            if (token.aborted) {
                this.postMessage({ type: 'cancelled' });
                return;
            }

            this.postMessage({
                type: 'results',
                data: results,
                fileMatches,
                groupMode: options.groupMode
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (!token.aborted) {
                this.postMessage({ type: 'error', message: errorMessage });
            }
        }
    }

    private async runReplaceAll(options: FileSearchOptions): Promise<void> {
        const confirmResult = await vscode.window.showWarningMessage(
            `Replace all occurrences of "${options.term}" with "${options.replaceText}" across all files?`,
            { modal: true },
            'Replace All'
        );
        if (confirmResult !== 'Replace All') return;

        this.cancelSearch();
        this._abortController = new AbortController();
        const token = this._abortController.signal;

        this.postMessage({ type: 'searching', message: 'Replacing...' });

        try {
            const { modifiedCount, matchCount, skippedDirtyCount } = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Window,
                    title: `Replacing "${options.term}" → "${options.replaceText}"...`,
                    cancellable: false,
                },
                () => replaceInFiles(options, token as unknown as vscode.CancellationToken)
            );

            if (token.aborted) {
                this.postMessage({ type: 'cancelled' });
                return;
            }

            this.postMessage({
                type: 'replaceDone',
                modifiedCount,
                matchCount
            });

            const messages: string[] = [];
            messages.push(`Replaced ${matchCount} occurrence${matchCount !== 1 ? 's' : ''} in ${modifiedCount} file${modifiedCount !== 1 ? 's' : ''}.`);
            if (skippedDirtyCount > 0) {
                messages.push(` ${skippedDirtyCount} file${skippedDirtyCount !== 1 ? 's' : ''} skipped (has unsaved changes).`);
            }

            void vscode.window.showInformationMessage(messages.join(''));

            // Yield before re-running search to let document changes settle
            await new Promise(resolve => setTimeout(resolve, 200));

            // Re-run search with same options (replace mode -> find mode) to refresh results
            const searchOptions = { ...options, mode: 'find' as const };
            await this.runSearch(searchOptions);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (!token.aborted) {
                this.postMessage({ type: 'error', message: errorMessage });
            }
        }
    }

    private cancelSearch(): void {
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = undefined;
        }
    }

    private async openFile(fileUri: string, line: number): Promise<void> {
        try {
            const uri = vscode.Uri.parse(fileUri);
            const document = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(document);
            const position = new vscode.Position(line - 1, 0);
            const range = new vscode.Range(position, position);

            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

            this.clearRevealHighlight();

            const lineRange = document.lineAt(position).range;
            editor.setDecorations(FileSearchProvider.getRevealDecoration(), [lineRange]);
            this._revealedEditor = editor;

            this._revealTimeout = setTimeout(() => {
                if (this._revealedEditor) {
                    this._revealedEditor.setDecorations(FileSearchProvider.getRevealDecoration(), []);
                    this._revealedEditor = undefined;
                }
                this._revealTimeout = undefined;
            }, 2500);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Failed to open file: ${errorMessage}`);
        }
    }

    private postMessage(message: FileSearchOutboundMessage): void {
        this._view?.webview.postMessage(message);
    }
}
