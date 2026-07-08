import * as vscode from 'vscode';

export class ResultView {
    public static currentPanel: ResultView | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private readonly _extensionUri: vscode.Uri;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, results: Record<string, unknown>[]) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getHtmlForWebview(results);
        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'exportCsv':
                        this.exportCsv(message.data);
                        return;
                    case 'copyToClipboard':
                        this.copyToClipboard(message.text);
                        return;
                    case 'error':
                        vscode.window.showErrorMessage(message.text);
                        return;
                    case 'info':
                        vscode.window.showInformationMessage(message.text);
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    public static createOrShow(extensionUri: vscode.Uri, results: Record<string, unknown>[]) {
        const column = vscode.ViewColumn.Two;

        if (ResultView.currentPanel) {
            ResultView.currentPanel._panel.reveal(column);
            ResultView.currentPanel._update(results);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'netezzaResult',
            'Query Results',
            { viewColumn: column, preserveFocus: true },
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );

        ResultView.currentPanel = new ResultView(panel, extensionUri, results);
    }

    private _update(results: Record<string, unknown>[]) {
        this._panel.webview.html = this._getHtmlForWebview(results);
    }

    public dispose() {
        ResultView.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private async exportCsv(csvContent: string) {
        const uri = await vscode.window.showSaveDialog({
            filters: {
                'CSV Files': ['csv']
            },
            saveLabel: 'Export'
        });

        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(csvContent));
            vscode.window.showInformationMessage(`Results exported to ${uri.fsPath}`);
        }
    }

    private async copyToClipboard(text: string) {
        try {
            await vscode.env.clipboard.writeText(text);
            vscode.window.showInformationMessage('Selection copied to clipboard');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to copy to clipboard: ${error}`);
        }
    }

    private _getHtmlForWebview(results: Record<string, unknown>[]) {
        const rowData = JSON.stringify(results);
        const columns =
            results.length > 0
                ? Object.keys(results[0]).map(key => ({
                    accessorKey: key,
                    header: key
                }))
                : [];

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${this._panel.webview.cspSource} 'unsafe-inline'; style-src ${this._panel.webview.cspSource} 'unsafe-inline';">
            <title>Query Results</title>
            <link href="${this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'resultPanel.css'))}" rel="stylesheet">
            <script src="${this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'tanstack-table-core.js'))}"></script>
            <script src="${this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'tanstack-virtual-core.js'))}"></script>
            <script src="${this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'resultPanel.js'))}"></script>
        </head>
        <body>
            <div id="sourceTabs" class="source-tabs"></div>
            
            <div class="controls">
                <input type="text" id="globalFilter" class="filter-input" placeholder="Filter all columns..." onkeyup="onFilterChanged()">
                <button onclick="copySelection(false)">📋 Copy Selected</button>
                <button onclick="copySelection(true)">📋 Copy with Headers</button>
                <button onclick="exportToCsv()">📥 Export CSV</button>
                <span id="rowCountInfo"></span>
            </div>

            <div id="groupingPanel" class="grouping-panel" ondrop="onDropGroup(event)" ondragover="onDragOverGroup(event)" ondragleave="onDragLeaveGroup(event)">
                <span style="opacity: 0.5;">Drag headers here to group</span>
            </div>

            <div id="gridContainer"></div>
            
            <script>
                const vscode = acquireVsCodeApi();
                let grids = [];
                const data = ${rowData};
                const columns = ${JSON.stringify(columns)};
                initializeResultView(data, columns);
            </script>

        </body>
        </html>`;
    }
}
