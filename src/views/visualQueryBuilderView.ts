import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import type {
    VisualQueryBuilderBootstrapState,
    VisualQueryBuilderData,
    VisualQueryBuilderInboundMessage,
    VisualQueryBuilderRelationship,
    VisualQueryBuilderOutboundMessage,
    VisualQueryBuilderState
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

function normalizeSourcePart(value: string): string {
    const trimmed = value.trim();
    const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"')
        ? trimmed.slice(1, -1).replace(/""/g, '"')
        : trimmed;
    return unquoted.toLocaleUpperCase();
}

function sourceKey(value: string): string {
    const parts = value.split('.');
    return parts.slice(-2).map(normalizeSourcePart).join('\u0000');
}

function filterDataToSchema(data: VisualQueryBuilderData, selectedSchema: string): VisualQueryBuilderData {
    const normalizedSelectedSchema = selectedSchema.trim().toLocaleUpperCase();
    if (!normalizedSelectedSchema || !data.allSchemas?.length) {
        return data;
    }

    const actualSchema = data.allSchemas.find(schema =>
        schema.trim().toLocaleUpperCase() === normalizedSelectedSchema
    );
    if (!actualSchema) {
        return data;
    }

    const tables = data.tables.filter(table =>
        table.schema.trim().toLocaleUpperCase() === actualSchema.trim().toLocaleUpperCase()
    );
    const tableKeys = new Set(tables.map(table => sourceKey(`${table.schema}.${table.tableName}`)));
    const relationships = data.relationships.filter((relationship: VisualQueryBuilderRelationship) =>
        tableKeys.has(sourceKey(relationship.fromTable)) && tableKeys.has(sourceKey(relationship.toTable))
    );

    return {
        ...data,
        schema: actualSchema,
        tables,
        relationships,
    };
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
            case 'saveState':
                await this._context.workspaceState.update(this._stateKey(), message.state);
                return;
        }
    }

    private _stateKey(): string {
        return `vqb.state.${this._connectionName}.${this._data.schema}`;
    }

    private _loadSavedState(): VisualQueryBuilderState | undefined {
        return this._context.workspaceState.get<VisualQueryBuilderState>(this._stateKey());
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
            this._data = filterDataToSchema(data, selectedSchema);
            this._availableSchemas = data.allSchemas || this._availableSchemas;
            this._panel.title = `Visual Query Builder: ${this._data.database}.${this._data.schema}`;

            await this._postMessage({
                command: 'schemaData',
                payload: {
                    connectionName: this._connectionName,
                    availableSchemas: this._availableSchemas,
                    data: this._data,
                    state: this._loadSavedState()
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
            // File SQL sources are DuckDB views local to the selected
            // connection, so the generated document must keep that binding.
            await this._connectionManager.setDocumentConnection(
                document.uri.toString(),
                this._connectionName
            );
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
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'visualQueryBuilder.css'));

        const bootstrapState: VisualQueryBuilderBootstrapState = {
            connectionName: this._connectionName,
            availableSchemas: this._availableSchemas,
            data: this._data,
            state: this._loadSavedState()
        };
        const bootstrapStateJson = JSON.stringify(bootstrapState).replace(/</g, '\\u003c');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; style-src-attr 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
    <link href="${styleUri}" rel="stylesheet">
    <title>Visual Query Builder</title>
</head>
<body>
    <div id="visual-query-builder-root" class="diagram-root" aria-label="Visual query builder">
        <script id="visual-query-builder-payload" type="application/json" nonce="${nonce}">${bootstrapStateJson}</script>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
