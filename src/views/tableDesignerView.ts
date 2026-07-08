import * as vscode from 'vscode';
import type {
    TableDesignerInboundMessage,
    TableDesignerOutboundMessage,
} from '../contracts/webviews/tableDesignerContracts';
import { ConnectionManager } from '../core/connectionManager';
import { runQuery } from '../core/queryRunner';
import { SQLITE_RESERVED_KEYWORD_LIST } from '../utils/identifierUtils';

export class TableDesignerView {
    public static readonly viewType = 'netezza.tableDesigner';

    public static createOrShow(
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager,
        dbName: string,
        schemaName: string | undefined,
        connectionName: string | undefined
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        const databaseKind = connectionManager.getConnectionDatabaseKind(connectionName);
        const targetDisplay = getTableDesignerTargetDisplay(databaseKind, dbName, schemaName);
        const panel = vscode.window.createWebviewPanel(
            TableDesignerView.viewType,
            `Table Designer (${targetDisplay})`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'media'),
                    vscode.Uri.joinPath(context.extensionUri, 'dist'),
                ],
                retainContextWhenHidden: true
            }
        );

        const designer = new TableDesignerView(panel, context, connectionManager, dbName, schemaName, connectionName);
        return designer;
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly context: vscode.ExtensionContext,
        private readonly connectionManager: ConnectionManager,
        private readonly dbName: string,
        private readonly schemaName: string | undefined,
        private readonly connectionName: string | undefined
    ) {
        this.update();

        this.panel.onDidDispose(() => this.dispose(), null);

        this.panel.webview.onDidReceiveMessage(
            async (message: TableDesignerInboundMessage) => {
                switch (message.command) {
                    case 'executeDDL':
                        await this.executeDDL(message.ddl);
                        return;
                    case 'saveAsSql':
                        await this.saveAsSql(message.ddl);
                        return;
                }
            },
            null
        );
    }

    private postToWebview(message: TableDesignerOutboundMessage): void {
        void this.panel.webview.postMessage(message);
    }

    private update() {
        this.panel.webview.html = this.getHtmlForWebview();
    }

    private getHtmlForWebview(): string {
        const scriptUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'media', 'tableDesigner.js'));
        const styleUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'tableDesigner.css'));
        const databaseKind = this.connectionManager.getConnectionDatabaseKind(this.connectionName);
        const targetDisplay = getTableDesignerTargetDisplay(databaseKind, this.dbName, this.schemaName);
        const initialContext = JSON.stringify({
            dbName: this.dbName,
            schemaName: this.schemaName ?? '',
            databaseKind,
            targetDisplay,
            sqliteKeywords: SQLITE_RESERVED_KEYWORD_LIST
        }).replace(/</g, '\\u003c');

        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <!--
                    Use a content security policy to only allow loading images from https or from our extension directory,
                    and only allow scripts that have a specific nonce.
                -->
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleUri}" rel="stylesheet">
                <title>Table Designer</title>
                <script nonce="${nonce}">
                    window.initialContext = ${initialContext};
                </script>
            </head>
            <body>
                <div id="statusBanner" class="status-banner hidden" role="alert" aria-live="polite"></div>
                <div class="designer-container">
                    <div class="header">
                        <h2>Visual Table Designer</h2>
                        <div class="table-info">
                            <div class="input-group">
                                <label for="tableName">Table Name *</label>
                                <input type="text" id="tableName" placeholder="Enter table name..." autofocus>
                            </div>
                            <div class="input-group">
                                <label>Target</label>
                                <span id="targetDisplay" class="read-only-field">${targetDisplay}</span>
                            </div>
                        </div>
                    </div>

                    <div class="main-content">
                        <div class="columns-panel">
                            <div class="panel-header">
                                <h3>Columns</h3>
                                <button id="addColumnBtn" class="vscode-button primary">Add Column</button>
                            </div>
                            
                            <div class="table-container">
                                <div id="columnsEmptyState" class="empty-state hidden">
                                    <p>No columns defined yet.</p>
                                    <p class="empty-state-hint">Use <strong>Add Column</strong> to define the table structure.</p>
                                </div>
                                <table id="columnsTable">
                                    <thead>
                                        <tr>
                                            <th></th> <!-- Drag handle -->
                                            <th>Name</th>
                                            <th>Data Type</th>
                                            <th>Length/Prec.</th>
                                            <th>Not Null</th>
                                            <th>PK</th>
                                            <th class="distribution-column">Distribute</th>
                                            <th>Default</th>
                                            <th>Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody id="columnsBody">
                                        <!-- Rows will be added dynamically -->
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        <div class="ddl-panel">
                            <div class="panel-header">
                                <h3>Generated DDL Preview</h3>
                            </div>
                            <div class="ddl-options">
                                <div class="option-grid">
                                    <div class="input-group">
                                        <label for="tableType">Table Type</label>
                                        <select id="tableType">
                                            <option value="PERMANENT">PERMANENT</option>
                                            <option value="TEMP">TEMP</option>
                                            <option value="TEMPORARY">TEMPORARY</option>
                                            <option value="GLOBAL TEMP">GLOBAL TEMP</option>
                                        </select>
                                    </div>
                                    <div class="input-group checkbox-group">
                                        <label>
                                            <input type="checkbox" id="ifNotExists">
                                            IF NOT EXISTS
                                        </label>
                                        <label id="organizeNoneLabel">
                                            <input type="checkbox" id="organizeNone">
                                            ORGANIZE ON NONE
                                        </label>
                                    </div>
                                </div>
                                <div class="input-group" id="organizeSection">
                                    <label for="organizeColumns">Organize Columns (comma separated)</label>
                                    <input type="text" id="organizeColumns" placeholder="e.g. CREATED_AT, REGION_ID">
                                </div>
                                <div class="input-group">
                                    <label for="tableConstraints">Additional Table Constraints (one per line)</label>
                                    <textarea id="tableConstraints" placeholder="e.g.&#10;UNIQUE (&quot;EMAIL&quot;)&#10;CHECK (&quot;AGE&quot; &gt;= 0)"></textarea>
                                </div>
                            </div>
                            <textarea id="ddlPreview" readonly></textarea>
                            
                            <div class="actions">
                                <button id="saveAsSqlBtn" class="vscode-button secondary">Open in Editor</button>
                                <button id="executeDdlBtn" class="vscode-button primary">Execute Table Creation</button>
                            </div>
                        </div>
                    </div>
                </div>

                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }

    private async executeDDL(ddl: string) {
        this.postToWebview({ command: 'clearError' });

        if (!ddl || ddl.trim() === '') {
            this.postToWebview({ command: 'setError', text: 'DDL is empty. Add a table name and at least one column.' });
            return;
        }

        const confirmation = await vscode.window.showWarningMessage(
            `Are you sure you want to execute this DDL on ${getTableDesignerTargetDisplay(this.connectionManager.getConnectionDatabaseKind(this.connectionName), this.dbName, this.schemaName)}?`,
            { modal: true },
            'Execute DDL',
            'Cancel'
        );

        if (confirmation === 'Execute DDL') {
            try {
                this.postToWebview({ command: 'setExecuting', executing: true });

                // Ensure there is a connection
                if (this.connectionName) {
                    const connection = await this.connectionManager.getConnection(this.connectionName);
                    if (!connection) {
                        throw new Error("No active connection");
                    }
                }
                
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Window,
                    title: "Executing DDL...",
                    cancellable: false
                }, async () => {
                    await runQuery(
                        this.context,
                        ddl,
                        false,
                        this.connectionName,
                        this.connectionManager
                    );
                    vscode.window.showInformationMessage('Table created successfully!');
                    
                    // Refresh schema view if possible
                    vscode.commands.executeCommand('netezza.refreshSchema');
                    
                    // Close the designer
                    this.dispose();
                });
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                this.postToWebview({ command: 'setError', text: `Failed to execute DDL: ${message}` });
                vscode.window.showErrorMessage(`Failed to execute DDL: ${message}`);
            } finally {
                this.postToWebview({ command: 'setExecuting', executing: false });
            }
        }
    }

    private async saveAsSql(ddl: string) {
        if (!ddl || ddl.trim() === '') return;
        
        try {
            const document = await vscode.workspace.openTextDocument({
                language: 'sql',
                content: ddl
            });
            await vscode.window.showTextDocument(document);
        } catch (err) {
            console.error(err);
        }
    }

    public dispose() {
        this.panel.dispose();
    }
}

function getTableDesignerTargetDisplay(
    databaseKind: string | undefined,
    dbName: string,
    schemaName: string | undefined
): string {
    if (databaseKind === 'sqlite' || !schemaName) {
        return dbName;
    }
    if (databaseKind === 'db2') {
        return `${dbName}.${schemaName}`;
    }
    return `${dbName}.${schemaName}`;
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
