import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import type {
    VisualQueryBuilderBootstrapState,
    VisualQueryBuilderData,
    VisualQueryBuilderInboundMessage,
    VisualQueryBuilderOutboundMessage
} from '../contracts/webviews';
import {
    buildVisualQueryBuilderDataForAllSchemas
} from '../schema/queryBuilderProvider';

function getNonce(): string {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export class VisualQueryBuilderView {
    public static readonly viewType = 'netezza.visualQueryBuilder';
    private static _currentPanel: VisualQueryBuilderView | undefined;

    public static createOrShow(
        extensionUri: vscode.Uri,
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager,
        connectionName: string,
        availableSchemas: string[],
        data: VisualQueryBuilderData
    ): void {
        const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;

        if (VisualQueryBuilderView._currentPanel) {
            VisualQueryBuilderView._currentPanel._panel.reveal(column);
            VisualQueryBuilderView._currentPanel._setState(connectionName, availableSchemas, data);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            VisualQueryBuilderView.viewType,
            `Visual Query Builder: ${data.database}.${data.schema}`,
            column,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                    vscode.Uri.joinPath(extensionUri, 'dist'),
                ],
                retainContextWhenHidden: true
            }
        );

        VisualQueryBuilderView._currentPanel = new VisualQueryBuilderView(
            panel,
            extensionUri,
            context,
            connectionManager,
            connectionName,
            availableSchemas,
            data
        );
    }

    private _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _context: vscode.ExtensionContext;
    private readonly _connectionManager: ConnectionManager;
    private _connectionName: string;
    private _availableSchemas: string[];
    private _data: VisualQueryBuilderData;
    private readonly _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager,
        connectionName: string,
        availableSchemas: string[],
        data: VisualQueryBuilderData
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._context = context;
        this._connectionManager = connectionManager;
        this._connectionName = connectionName;
        this._availableSchemas = availableSchemas;
        this._data = data;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(
            async (message: VisualQueryBuilderInboundMessage) => {
                await this._handleMessage(message);
            },
            null,
            this._disposables
        );
    }

    public dispose(): void {
        VisualQueryBuilderView._currentPanel = undefined;
        this._panel.dispose();

        while (this._disposables.length > 0) {
            const disposable = this._disposables.pop();
            disposable?.dispose();
        }
    }

    private _setState(connectionName: string, availableSchemas: string[], data: VisualQueryBuilderData): void {
        this._connectionName = connectionName;
        this._availableSchemas = availableSchemas;
        this._data = data;
        this._update();
    }

    private _update(): void {
        this._panel.title = `Visual Query Builder: ${this._data.database}.${this._data.schema}`;
        this._panel.webview.html = this._getHtml();
    }

    private async _handleMessage(message: VisualQueryBuilderInboundMessage): Promise<void> {
        switch (message.command) {
            case 'openSql':
                await this._openSqlInEditor(message.sql, false);
                return;
            case 'runSql':
                await this._openSqlInEditor(message.sql, true);
                return;
            case 'loadSchema':
                await this._loadAllSchemas(message.schema);
                return;
        }
    }

    private _postMessage(message: VisualQueryBuilderOutboundMessage): Thenable<boolean> {
        return this._panel.webview.postMessage(message);
    }

    private async _loadAllSchemas(selectedSchema: string): Promise<void> {
        await this._postMessage({ command: 'loadingState', loading: true });

        try {
            const data = await buildVisualQueryBuilderDataForAllSchemas(
                this._context,
                this._connectionManager,
                this._connectionName,
                this._data.database
            );
            const normalizedSelectedSchema = selectedSchema.trim().toUpperCase();
            this._data = normalizedSelectedSchema && data.allSchemas?.includes(normalizedSelectedSchema)
                ? { ...data, schema: normalizedSelectedSchema }
                : data;
            this._availableSchemas = data.allSchemas || this._availableSchemas;
            this._panel.title = `Visual Query Builder: ${this._data.database}.${this._data.schema}`;

            await this._postMessage({
                command: 'schemaData',
                payload: {
                    connectionName: this._connectionName,
                    availableSchemas: this._availableSchemas,
                    data: this._data
                } as VisualQueryBuilderBootstrapState
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to reload schemas for Query Builder: ${message}`);
            await this._postMessage({ command: 'error', message });
        } finally {
            await this._postMessage({ command: 'loadingState', loading: false });
        }
    }

    private async _openSqlInEditor(sql: string, runAfterOpen: boolean): Promise<void> {
        const normalizedSql = sql.trim();
        if (!normalizedSql) {
            vscode.window.showErrorMessage('Generated SQL is empty.');
            return;
        }

        try {
            const document = await vscode.workspace.openTextDocument({
                language: 'sql',
                content: normalizedSql
            });
            await vscode.window.showTextDocument(document, { preview: false });

            if (runAfterOpen) {
                await vscode.commands.executeCommand('netezza.runQuery');
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to open generated SQL: ${message}`);
        }
    }

    private _getHtml(): string {
        const webview = this._panel.webview;
        const nonce = getNonce();
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'visualQueryBuilder.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'visualQueryBuilder.css'));

        const bootstrapState: VisualQueryBuilderBootstrapState = {
            connectionName: this._connectionName,
            availableSchemas: this._availableSchemas,
            data: this._data
        };
        const bootstrapStateJson = JSON.stringify(bootstrapState).replace(/</g, '\\u003c');

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
                <title>Visual Query Builder</title>
                <link href="${styleUri}" rel="stylesheet">
                <script nonce="${nonce}">
                    window.visualQueryBuilderInitialState = ${bootstrapStateJson};
                </script>
            </head>
            <body>
                <div class="builder-shell">
                    <header class="builder-header">
                        <div class="header-main">
                            <h2>Visual Query Builder</h2>
                            <span id="dbSchemaBadge" class="badge"></span>
                            <span id="builderStats" class="stats"></span>
                        </div>
                        <div class="header-actions">
                            <label for="schemaSelect">Schema</label>
                            <select id="schemaSelect"></select>
                            <button id="reloadSchemaBtn" class="vscode-button secondary">Reload</button>
                            <button id="autoLayoutBtn" class="vscode-button secondary">Auto Layout</button>
                            <button id="clearCanvasBtn" class="vscode-button secondary">Clear Canvas</button>
                        </div>
                    </header>

                    <main class="builder-content">
                        <aside class="panel panel-left">
                            <div class="panel-title">Tables</div>
                            <input id="tableSearch" type="text" placeholder="Filter tables..." />
                            <div id="tablePalette" class="table-palette"></div>
                            <div class="panel-footnote">Drag tables to canvas; drag column dots between tables to create joins.</div>
                        </aside>

                        <section class="canvas-wrapper">
                            <div id="canvasViewport" class="canvas-viewport">
                                <svg id="joinLines" class="join-lines"></svg>
                                <div id="canvas" class="canvas"></div>
                            </div>
                        </section>

                        <aside class="panel panel-right">
                            <div class="panel-title">Query Controls</div>
                            <label class="checkbox-label">
                                <input id="distinctToggle" type="checkbox" />
                                <span>SELECT DISTINCT</span>
                            </label>

                            <div class="section">
                                <h3>Manual Join</h3>
                                <select id="joinLeftTable"></select>
                                <select id="joinLeftColumn"></select>
                                <select id="joinType">
                                    <option value="INNER">INNER JOIN</option>
                                    <option value="LEFT">LEFT JOIN</option>
                                    <option value="RIGHT">RIGHT JOIN</option>
                                    <option value="FULL">FULL JOIN</option>
                                </select>
                                <select id="joinRightTable"></select>
                                <select id="joinRightColumn"></select>
                                <button id="addJoinBtn" class="vscode-button secondary">Add Join</button>
                                <div id="joinList" class="join-list"></div>
                            </div>

                            <div class="section">
                                <h3>Selected Columns</h3>
                                <div id="selectedColumnsList" class="selected-columns-list"></div>
                            </div>

                            <div class="section">
                                <h3>WHERE</h3>
                                <textarea id="whereClause" rows="3" placeholder="e.g. t1.STATUS = 'ACTIVE'"></textarea>
                            </div>

                            <div class="section">
                                <h3>GROUP BY (optional)</h3>
                                <textarea id="groupByClause" rows="2" placeholder="e.g. t1.REGION, t2.CATEGORY"></textarea>
                            </div>

                            <div class="section">
                                <h3>HAVING (optional)</h3>
                                <textarea id="havingClause" rows="2" placeholder="e.g. COUNT(*) > 10"></textarea>
                            </div>

                            <div class="section">
                                <h3>ORDER BY (optional)</h3>
                                <textarea id="orderByClause" rows="2" placeholder="e.g. t1.CREATED_AT DESC"></textarea>
                            </div>

                            <div class="section">
                                <h3>LIMIT</h3>
                                <input id="limitValue" type="number" min="1" placeholder="1000" />
                            </div>
                        </aside>
                    </main>

                    <footer class="sql-footer">
                        <div class="footer-header">
                            <h3>Generated SQL</h3>
                            <div class="footer-actions">
                                <button id="copySqlBtn" class="vscode-button secondary">Copy SQL</button>
                                <button id="openSqlBtn" class="vscode-button secondary">Open in Editor</button>
                                <button id="runSqlBtn" class="vscode-button primary">Run Query</button>
                            </div>
                        </div>
                        <textarea id="sqlPreview" readonly></textarea>
                    </footer>
                </div>

                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}
