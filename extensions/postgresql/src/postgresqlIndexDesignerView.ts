import * as vscode from 'vscode';
import type {
    PostgresqlIndexDesign,
    PostgresqlIndexDesignerInboundMessage,
    PostgresqlIndexDesignerInitialContext,
    PostgresqlIndexDesignerOutboundMessage,
} from '../../../src/contracts/webviews/postgresqlIndexDesignerContracts';
import {
    buildPostgresqlCreateIndexSql,
    buildPostgresqlDropIndexSql,
} from './postgresqlIndexDdl';
import { loadPostgresqlIndexDesignerContext } from './postgresqlDesignerOperations';
import type { PostgresqlDesignerOperationContext } from './postgresqlCommandContext';

const CORE_EXTENSION_ID = 'krzysztof-d.justybaselite-netezza';

export class PostgresqlIndexDesignerView {
    public static readonly viewType = 'justybase.postgresqlIndexDesigner';

    public static async createOrShow(
        _context: vscode.ExtensionContext,
        operation: PostgresqlDesignerOperationContext,
    ): Promise<void> {
        const coreExtension = vscode.extensions.getExtension(CORE_EXTENSION_ID);
        if (!coreExtension) {
            vscode.window.showErrorMessage('The JustyBase core extension is required to open the PostgreSQL Index Designer.');
            return;
        }

        const initialContext = await loadPostgresqlIndexDesignerContext(operation.target, operation.services);
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        const panel = vscode.window.createWebviewPanel(
            PostgresqlIndexDesignerView.viewType,
            `PostgreSQL Index Designer: ${operation.target.qualifiedName}`,
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

        new PostgresqlIndexDesignerView(panel, coreExtension.extensionUri, operation, initialContext);
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly coreExtensionUri: vscode.Uri,
        private readonly operation: PostgresqlDesignerOperationContext,
        private initialContext: PostgresqlIndexDesignerInitialContext,
    ) {
        this.panel.webview.html = this.getHtmlForWebview();
        this.panel.onDidDispose(() => this.dispose(), null);
        this.panel.webview.onDidReceiveMessage(
            async (message: PostgresqlIndexDesignerInboundMessage) => this.handleMessage(message),
            null,
        );
    }

    private async handleMessage(message: PostgresqlIndexDesignerInboundMessage): Promise<void> {
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
            case 'dropIndex':
                await this.dropIndex(message.indexName);
                return;
            case 'reload':
                await this.reloadContext();
                return;
        }
    }

    private postToWebview(message: PostgresqlIndexDesignerOutboundMessage): void {
        void this.panel.webview.postMessage(message);
    }

    private buildDdl(design: PostgresqlIndexDesign): string {
        if (!design || typeof design !== 'object') {
            throw new Error('The index design is invalid. Reopen the designer and try again.');
        }
        const indexName = typeof design.indexName === 'string' ? design.indexName.trim() : '';
        if (!indexName) {
            throw new Error('Enter an index name.');
        }
        if (this.initialContext.existingIndexes.some(index => index.name.toLowerCase() === indexName.toLowerCase())) {
            throw new Error(`An index named ${indexName} already exists on this table.`);
        }

        const columnsByKey = new Map(this.initialContext.columns.map(column => [column.name.toLowerCase(), column.name]));
        const keyColumns = Array.isArray(design.keyColumns) ? design.keyColumns.map(column => {
            const requestedName = typeof column?.name === 'string' ? column.name.trim() : '';
            const canonicalName = columnsByKey.get(requestedName.toLowerCase());
            if (!canonicalName) {
                throw new Error(`Column "${requestedName}" does not belong to ${this.initialContext.qualifiedTable}.`);
            }
            return {
                name: canonicalName,
                order: column.order === 'DESC' ? 'DESC' as const : 'ASC' as const,
                nulls: column.nulls === 'FIRST' ? 'FIRST' as const : 'LAST' as const,
            };
        }) : [];
        const includeColumns = Array.isArray(design.includeColumns) ? design.includeColumns.map(name => {
            const requestedName = typeof name === 'string' ? name.trim() : '';
            const canonicalName = columnsByKey.get(requestedName.toLowerCase());
            if (!canonicalName) {
                throw new Error(`Column "${requestedName}" does not belong to ${this.initialContext.qualifiedTable}.`);
            }
            return canonicalName;
        }) : [];

        return buildPostgresqlCreateIndexSql({
            schema: this.initialContext.schema,
            tableName: this.initialContext.tableName,
            design: {
                ...design,
                indexName,
                keyColumns,
                includeColumns,
            },
        });
    }

    private async executeDesign(design: PostgresqlIndexDesign): Promise<void> {
        let ddl: string;
        try {
            ddl = this.buildDdl(design);
        } catch (error) {
            this.postToWebview({ command: 'setError', text: getErrorMessage(error) });
            return;
        }
        await this.executeDdl(ddl, {
            confirmation: `Create this index on ${this.operation.target.qualifiedName}?`,
            progress: `Creating PostgreSQL index on ${this.operation.target.qualifiedName}...`,
            success: 'Index created successfully.',
            errorPrefix: 'Failed to create PostgreSQL index',
        });
    }

    private async dropIndex(indexName: string): Promise<void> {
        const requestedName = typeof indexName === 'string' ? indexName.trim() : '';
        const existingIndex = this.initialContext.existingIndexes.find(index => index.name.toLowerCase() === requestedName.toLowerCase());
        if (!existingIndex) {
            this.postToWebview({ command: 'setError', text: `Index "${requestedName}" is not present on this table. Refresh the designer and try again.` });
            return;
        }
        if (existingIndex.isPrimary) {
            this.postToWebview({ command: 'setError', text: 'The PRIMARY KEY index cannot be dropped from the PostgreSQL Index Designer.' });
            return;
        }

        const ddl = buildPostgresqlDropIndexSql(
            this.initialContext.schema,
            existingIndex.name,
        );
        await this.executeDdl(ddl, {
            confirmation: `Drop index ${existingIndex.name} from ${this.operation.target.qualifiedName}? This action cannot be undone.`,
            progress: `Dropping PostgreSQL index ${existingIndex.name}...`,
            success: `Index ${existingIndex.name} dropped successfully.`,
            errorPrefix: 'Failed to drop PostgreSQL index',
        });
    }

    private async executeDdl(
        ddl: string,
        messages: {
            confirmation: string;
            progress: string;
            success: string;
            errorPrefix: string;
        },
    ): Promise<void> {
        const confirmation = await vscode.window.showWarningMessage(
            `${messages.confirmation}\n\n${ddl}`,
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
                messages.progress,
                () => this.operation.services.executeSql(
                    ddl,
                    this.operation.target.connectionName,
                    messages.progress,
                ),
            );
            await vscode.commands.executeCommand('netezza.refreshSchema', this.operation.target.connectionName);
            try {
                await this.reloadContext();
            } catch (error) {
                this.postToWebview({
                    command: 'setInfo',
                    text: `${messages.success} Schema refresh failed: ${getErrorMessage(error)}`,
                });
                return;
            }
            this.postToWebview({ command: 'setInfo', text: `${messages.success} The schema tree has been refreshed.` });
        } catch (error) {
            this.postToWebview({ command: 'setError', text: `${messages.errorPrefix}: ${getErrorMessage(error)}` });
        } finally {
            this.postToWebview({ command: 'setExecuting', executing: false });
        }
    }

    private async reloadContext(): Promise<void> {
        const context = await loadPostgresqlIndexDesignerContext(this.operation.target, this.operation.services);
        this.initialContext = context;
        this.postToWebview({ command: 'setContext', context });
    }

    private async saveDesignAsSql(design: PostgresqlIndexDesign): Promise<void> {
        try {
            await this.operation.services.openSqlDocument(this.buildDdl(design), 'sql');
        } catch (error) {
            this.postToWebview({ command: 'setError', text: getErrorMessage(error) });
        }
    }

    private async copyDesignDdl(design: PostgresqlIndexDesign): Promise<void> {
        try {
            const ddl = this.buildDdl(design);
            await vscode.env.clipboard.writeText(ddl);
            this.postToWebview({ command: 'setInfo', text: 'DDL copied to the clipboard.' });
        } catch (error) {
            this.postToWebview({ command: 'setError', text: getErrorMessage(error) });
        }
    }

    private getHtmlForWebview(): string {
        const scriptUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.coreExtensionUri, 'dist', 'media', 'postgresqlIndexDesigner.js'),
        );
        const styleUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.coreExtensionUri, 'media', 'db2Designer.css'),
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
                <title>PostgreSQL Index Designer</title>
                <script nonce="${nonce}">window.initialContext = ${initialContext};</script>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </head>
            <body>
                <div id="statusBanner" class="status-banner hidden" role="alert" aria-live="polite"></div>
                <main class="mysql-designer">
                    <header class="designer-header">
                        <div><p class="eyebrow">PostgreSQL</p><h1>Index Designer</h1><p class="subtitle">${targetDisplay}</p></div>
                        <div class="designer-actions"><button id="reloadBtn" class="vscode-button secondary">Refresh</button><button id="copyDdlBtn" class="vscode-button secondary">Copy DDL</button><button id="saveAsSqlBtn" class="vscode-button secondary">Open in Editor</button><button id="executeDdlBtn" class="vscode-button primary">Execute</button></div>
                    </header>
                    <section class="designer-grid index-grid">
                        <section class="designer-card">
                            <h2>Index Definition</h2>
                            <div class="form-grid">
                                <label>Index name *<input id="indexName" type="text" autocomplete="off"></label>
                                <label>Method<select id="method"></select></label>
                                <label class="checkbox-row"><input id="unique" type="checkbox"> UNIQUE</label>
                                <label>Tablespace<select id="tablespace"></select></label>
                            </div>
                            <h3>Key columns</h3><div id="keyColumns" class="repeating-rows"></div>
                            <h3>INCLUDE columns</h3><div id="includeColumns" class="repeating-rows"></div>
                            <label>Predicate (optional)<input id="predicate" type="text" placeholder="status = 'active'"></label>
                        </section>
                        <section class="designer-card">
                            <h2>Available columns</h2><input id="columnSearch" type="search" placeholder="Filter columns">
                            <div id="availableColumns" class="column-picker"></div>
                            <p id="methodHint" class="field-hint"></p>
                        </section>
                        <section class="designer-card index-list-card"><div class="card-heading"><h2>Existing indexes</h2><span id="existingIndexesHint" class="field-hint"></span></div><div class="index-table-wrap"><table><thead><tr><th>Name</th><th>Key columns</th><th>INCLUDE</th><th>Type</th><th>Properties</th><th>Actions</th></tr></thead><tbody id="existingIndexesBody"></tbody></table></div></section>
                        <section class="designer-card ddl-card"><h2>DDL Preview</h2><textarea id="ddlPreview" readonly spellcheck="false"></textarea></section>
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