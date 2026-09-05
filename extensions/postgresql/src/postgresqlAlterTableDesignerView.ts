import * as vscode from 'vscode';
import type {
    PostgresqlAlterTableDesign,
    PostgresqlAlterTableDesignerInboundMessage,
    PostgresqlAlterTableDesignerInitialContext,
    PostgresqlAlterTableDesignerOutboundMessage,
} from '../../../src/contracts/webviews/postgresqlAlterTableDesignerContracts';
import { buildPostgresqlAlterTableSql } from './postgresqlAlterTableDdl';
import { loadPostgresqlAlterTableDesignerContext } from './postgresqlDesignerOperations';
import type { PostgresqlDesignerOperationContext } from './postgresqlCommandContext';

const CORE_EXTENSION_ID = 'krzysztof-d.justybaselite-netezza';

export class PostgresqlAlterTableDesignerView {
    public static readonly viewType = 'justybase.postgresqlAlterTableDesigner';

    public static async createOrShow(
        _context: vscode.ExtensionContext,
        operation: PostgresqlDesignerOperationContext,
    ): Promise<void> {
        const coreExtension = vscode.extensions.getExtension(CORE_EXTENSION_ID);
        if (!coreExtension) {
            vscode.window.showErrorMessage('The JustyBase core extension is required to open the PostgreSQL Alter Table Designer.');
            return;
        }

        const initialContext = await loadPostgresqlAlterTableDesignerContext(operation.target, operation.services);
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        const panel = vscode.window.createWebviewPanel(
            PostgresqlAlterTableDesignerView.viewType,
            `PostgreSQL Alter Table Designer: ${operation.target.qualifiedName}`,
            column,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(coreExtension.extensionUri, 'media'),
                    vscode.Uri.joinPath(coreExtension.extensionUri, 'dist'),
                ],
                retainContextWhenHidden: true,
            },
        );

        new PostgresqlAlterTableDesignerView(panel, coreExtension.extensionUri, operation, initialContext);
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly coreExtensionUri: vscode.Uri,
        private readonly operation: PostgresqlDesignerOperationContext,
        private initialContext: PostgresqlAlterTableDesignerInitialContext,
    ) {
        this.panel.webview.html = this.getHtmlForWebview();
        this.panel.onDidDispose(() => this.dispose(), null);
        this.panel.webview.onDidReceiveMessage(
            async (message: PostgresqlAlterTableDesignerInboundMessage) => this.handleMessage(message),
            null,
        );
    }

    private async handleMessage(message: PostgresqlAlterTableDesignerInboundMessage): Promise<void> {
        switch (message.command) {
            case 'executeDesign':
                await this.executeDesign(message.design);
                return;
            case 'saveAsSql':
                await this.saveDesignAsSql(message.design);
                return;
            case 'copyDDL':
                await this.copyDesignDdl(message.design);
                return;
            case 'reload':
                await this.reloadContext();
                return;
        }
    }

    private postToWebview(message: PostgresqlAlterTableDesignerOutboundMessage): void {
        void this.panel.webview.postMessage(message);
    }

    private buildDdl(design: PostgresqlAlterTableDesign): string {
        if (!design || typeof design !== 'object' || !Array.isArray(design.columns) || !design.options) {
            throw new Error('The table design is invalid. Reopen the designer and try again.');
        }
        return buildPostgresqlAlterTableSql(this.initialContext, design);
    }

    private async executeDesign(design: PostgresqlAlterTableDesign): Promise<void> {
        let ddl: string;
        try {
            ddl = this.buildDdl(design);
        } catch (error) {
            this.postToWebview({ command: 'setError', text: getErrorMessage(error) });
            return;
        }

        if (!ddl) {
            this.postToWebview({ command: 'setInfo', text: 'No changes detected. Adjust a column or a table option first.' });
            return;
        }

        const confirmation = await vscode.window.showWarningMessage(
            `Apply these changes to ${this.operation.target.qualifiedName}?\n\n${ddl}`,
            { modal: true },
            'Execute DDL',
            'Cancel',
        );
        if (confirmation !== 'Execute DDL') {
            return;
        }

        this.postToWebview({ command: 'clearStatus' });
        this.postToWebview({ command: 'setExecuting', executing: true });
        try {
            await this.operation.services.executeWithProgress(
                `Applying PostgreSQL table changes to ${this.operation.target.qualifiedName}...`,
                () => this.operation.services.executeSql(
                    ddl,
                    this.operation.target.connectionName,
                    `Applying PostgreSQL table changes to ${this.operation.target.qualifiedName}...`,
                ),
            );
            await vscode.commands.executeCommand('netezza.refreshSchema', this.operation.target.connectionName);
            try {
                await this.reloadContext();
            } catch (error) {
                this.postToWebview({
                    command: 'setInfo',
                    text: `Table updated. Schema refresh failed: ${getErrorMessage(error)}`,
                });
                return;
            }
            this.postToWebview({ command: 'setInfo', text: 'Table updated. The schema tree has been refreshed.' });
        } catch (error) {
            this.postToWebview({ command: 'setError', text: `Failed to apply table changes: ${getErrorMessage(error)}` });
        } finally {
            this.postToWebview({ command: 'setExecuting', executing: false });
        }
    }

    private async reloadContext(): Promise<void> {
        const context = await loadPostgresqlAlterTableDesignerContext(this.operation.target, this.operation.services);
        this.initialContext = context;
        this.postToWebview({ command: 'setContext', context });
    }

    private async saveDesignAsSql(design: PostgresqlAlterTableDesign): Promise<void> {
        try {
            const ddl = this.buildDdl(design);
            if (!ddl) {
                this.postToWebview({ command: 'setInfo', text: 'No changes detected. Nothing to save.' });
                return;
            }
            await this.operation.services.openSqlDocument(ddl, 'sql');
        } catch (error) {
            this.postToWebview({ command: 'setError', text: getErrorMessage(error) });
        }
    }

    private async copyDesignDdl(design: PostgresqlAlterTableDesign): Promise<void> {
        try {
            const ddl = this.buildDdl(design);
            if (!ddl) {
                this.postToWebview({ command: 'setInfo', text: 'No changes detected. Nothing to copy.' });
                return;
            }
            await vscode.env.clipboard.writeText(ddl);
            this.postToWebview({ command: 'setInfo', text: 'DDL copied to the clipboard.' });
        } catch (error) {
            this.postToWebview({ command: 'setError', text: getErrorMessage(error) });
        }
    }

    private getHtmlForWebview(): string {
        const scriptUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.coreExtensionUri, 'dist', 'media', 'postgresqlAlterTableDesigner.js'),
        );
        const styleUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.coreExtensionUri, 'media', 'db2Designer.css'),
        );
        const alterStyleUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.coreExtensionUri, 'media', 'mysqlAlterTableDesigner.css'),
        );
        const initialContext = JSON.stringify(this.initialContext).replace(/</g, '\\u003c');
        const nonce = getNonce();
        const targetDisplay = escapeHtml(this.initialContext.qualifiedTable);

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource}; script-src 'nonce-${nonce}';">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleUri}" rel="stylesheet">
                <link href="${alterStyleUri}" rel="stylesheet">
                <title>PostgreSQL Alter Table Designer</title>
                <script nonce="${nonce}">window.initialContext = ${initialContext};</script>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </head>
            <body>
                <div id="statusBanner" class="status-banner hidden" role="alert" aria-live="polite"></div>
                <main class="mysql-designer">
                    <header class="designer-header">
                        <div><p class="eyebrow">PostgreSQL</p><h1>Alter Table Designer</h1><p class="subtitle">${targetDisplay}</p></div>
                        <div class="designer-actions"><button id="reloadBtn" class="vscode-button secondary">Refresh</button><button id="copyDdlBtn" class="vscode-button secondary">Copy DDL</button><button id="saveAsSqlBtn" class="vscode-button secondary">Open in Editor</button><button id="executeDdlBtn" class="vscode-button primary">Execute</button></div>
                    </header>
                    <section class="designer-grid index-grid">
                        <section class="designer-card">
                            <h2>Table Options</h2>
                            <div class="form-grid three-columns">
                                <label>Tablespace<select id="tablespace"></select></label>
                                <label>Fillfactor<input id="fillfactor" type="text" inputmode="numeric" placeholder="e.g. 90 (empty = table default)"></label>
                                <label class="table-comment-field">Comment<input id="tableComment" type="text" placeholder="Table comment"></label>
                            </div>
                            <p class="field-hint">A non-empty fillfactor emits <code>SET (fillfactor = N)</code>; clearing an existing value emits <code>RESET (fillfactor)</code>.</p>
                        </section>
                        <section class="designer-card">
                            <h2>Columns</h2>
                            <p class="field-hint">PK and FK columns cannot be dropped here. Existing column names are read-only; use the schema tools for renames.</p>
                            <div class="alter-actions"><button id="addColumnBtn" class="vscode-button primary">Add Column</button></div>
                            <div class="alter-columns-wrap">
                                <table class="alter-columns-table">
                                    <thead>
                                        <tr>
                                            <th>#</th>
                                            <th>Name</th>
                                            <th>Type</th>
                                            <th>NULL</th>
                                            <th>Default</th>
                                            <th>Comment</th>
                                            <th>Flags</th>
                                            <th></th>
                                        </tr>
                                    </thead>
                                    <tbody id="columnsBody"></tbody>
                                </table>
                            </div>
                        </section>
                        <section class="designer-card ddl-card">
                            <h2>DDL Preview</h2>
                            <textarea id="ddlPreview" readonly spellcheck="false"></textarea>
                            <p class="field-hint">The preview shows the exact statements that will execute. Dropping a column is permanent; comments are applied with COMMENT ON statements.</p>
                        </section>
                    </section>
                </main>
            </body>
            </html>`;
    }

    private dispose(): void {
        // The panel owns no external resources. Keeping this method makes the
        // lifecycle explicit and mirrors the other designer webviews.
    }
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[character] ?? character);
}

function getNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let index = 0; index < 32; index += 1) {
        nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return nonce;
}