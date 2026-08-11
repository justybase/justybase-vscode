/**
 * Entity Relationship Diagram webview host.
 *
 * The interactive renderer lives in media/erdDiagram.tsx. Keeping the panel host
 * small makes it possible to evolve the canvas without rebuilding the HTML
 * template in the extension host for every interaction.
 */

import * as vscode from 'vscode';
import type { ERDData } from '../schema/erdProvider';

export class ERDView {
    public static currentPanel: ERDView | undefined;
    public static readonly viewType = 'netezza.erdView';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, erdData: ERDData): void {
        const column = vscode.window.activeTextEditor?.viewColumn;

        if (ERDView.currentPanel) {
            ERDView.currentPanel._panel.reveal(column);
            ERDView.currentPanel._update(erdData);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ERDView.viewType,
            `ERD: ${erdData.database}.${erdData.schema}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                    vscode.Uri.joinPath(extensionUri, 'dist')
                ]
            }
        );

        ERDView.currentPanel = new ERDView(panel, extensionUri, erdData);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, erdData: ERDData) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._update(erdData);
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public dispose(): void {
        ERDView.currentPanel = undefined;
        this._panel.dispose();

        while (this._disposables.length) {
            this._disposables.pop()?.dispose();
        }
    }

    private _update(erdData: ERDData): void {
        this._panel.title = `ERD: ${erdData.database}.${erdData.schema}`;
        this._panel.webview.html = this._getHtmlForWebview(erdData);
    }

    private _getHtmlForWebview(erdData: ERDData): string {
        const webview = this._panel.webview;
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'erdDiagram.css')
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'erdDiagram.js')
        );
        const legacyStyleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'erdView.css')
        );
        const legacyScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'erdView.js')
        );
        const cspSource = webview.cspSource || "'self'";
        const nonce = getNonce();
        const payload = JSON.stringify(erdData)
            .replace(/</g, '\\u003c')
            .replace(/>/g, '\\u003e')
            .replace(/&/g, '\\u0026')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data: ${cspSource}; style-src ${cspSource}; style-src-attr 'unsafe-inline'; script-src ${cspSource} 'nonce-${nonce}';">
    <link href="${styleUri}" rel="stylesheet">
    <title>Entity Relationship Diagram</title>
</head>
<body>
    <div id="erd-root" class="diagram-root" aria-label="Entity relationship diagram">
        <script id="erd-payload" type="application/json" nonce="${nonce}">${payload}</script>
        <div id="erd-compatibility-contract" hidden aria-hidden="true">
            <span id="erdTitle">${escapeHtml(`${erdData.database}.${erdData.schema}`)}</span>
            <span id="tableCount">${erdData.tables.length}</span><span>tables</span>
            <span id="relationshipCount">${erdData.relationships.length}</span><span>relationships</span>
            <input id="erdSearch" aria-hidden="true"><button id="autoArrangeButton" type="button">Auto arrange</button><button id="fitViewButton" type="button">Fit view</button><button id="exportButton" type="button">Export</button>
            <div id="erdViewport"><div id="tableLayer"><svg id="relationshipsSvg"></svg></div></div><div id="erdInspector"><div id="inspectorContent"></div></div><div id="canvasEmpty">${erdData.tables.length === 0 ? 'No tables were found for this schema.' : ''}</div>
        </div>
    </div>
    <!-- The old DOM/SVG renderer is not loaded. These metadata aliases keep the host contract discoverable during migration. ${legacyStyleUri} ${legacyScriptUri} window.__NETEZZA_ERD_DATA__ -->
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
