import * as vscode from 'vscode';
import type {
    MysqlIndexDesign,
    MysqlIndexDesignerInboundMessage,
    MysqlIndexDesignerInitialContext,
    MysqlIndexDesignerOutboundMessage,
} from '../../../src/contracts/webviews/mysqlIndexDesignerContracts';
import {
    areMysqlIdentifiersEqual,
    buildMysqlCreateIndexSql,
    buildMysqlDropIndexSql,
} from './mysqlDesignerDdl';
import {
    loadMysqlIndexDesignerContext,
} from './mysqlDesignerOperations';
import type { MysqlDesignerOperationContext } from './mysqlCommandContext';

const CORE_EXTENSION_ID = 'krzysztof-d.justybaselite-netezza';

export class MysqlIndexDesignerView {
    public static readonly viewType = 'justybase.mysqlIndexDesigner';

    public static async createOrShow(
        _context: vscode.ExtensionContext,
        operation: MysqlDesignerOperationContext,
    ): Promise<void> {
        const coreExtension = vscode.extensions.getExtension(CORE_EXTENSION_ID);
        if (!coreExtension) {
            vscode.window.showErrorMessage('The JustyBase core extension is required to open the MySQL Index Designer.');
            return;
        }

        const initialContext = await loadMysqlIndexDesignerContext(operation.target, operation.services);
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        const panel = vscode.window.createWebviewPanel(
            MysqlIndexDesignerView.viewType,
            `MySQL Index Designer: ${operation.target.qualifiedName}`,
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

        new MysqlIndexDesignerView(panel, coreExtension.extensionUri, operation, initialContext);
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly coreExtensionUri: vscode.Uri,
        private readonly operation: MysqlDesignerOperationContext,
        private initialContext: MysqlIndexDesignerInitialContext,
    ) {
        this.panel.webview.html = this.getHtmlForWebview();
        this.panel.onDidDispose(() => this.dispose(), null);
        this.panel.webview.onDidReceiveMessage(
            async (message: MysqlIndexDesignerInboundMessage) => this.handleMessage(message),
            null,
        );
    }

    private async handleMessage(message: MysqlIndexDesignerInboundMessage): Promise<void> {
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

    private postToWebview(message: MysqlIndexDesignerOutboundMessage): void {
        void this.panel.webview.postMessage(message);
    }

    private buildDdl(design: MysqlIndexDesign): string {
        if (!design || typeof design !== 'object') {
            throw new Error('The index design is invalid. Reopen the designer and try again.');
        }
        const indexName = typeof design.indexName === 'string' ? design.indexName.trim() : '';
        if (!indexName) {
            throw new Error('Enter an index name.');
        }
        if (this.initialContext.existingIndexes.some(index => areMysqlIdentifiersEqual(index.name, indexName))) {
            throw new Error(`An index named ${indexName} already exists on this table.`);
        }

        const columnsByKey = new Map(this.initialContext.columns.map(column => [identifierKey(column.name), column.name]));
        const keyColumns = Array.isArray(design.keyColumns) ? design.keyColumns.map(column => {
            const requestedName = typeof column?.name === 'string' ? column.name.trim() : '';
            const canonicalName = columnsByKey.get(identifierKey(requestedName));
            if (!canonicalName) {
                throw new Error(`Column "${requestedName}" does not belong to ${this.initialContext.qualifiedTable}.`);
            }
            return {
                name: canonicalName,
                order: column.order === 'DESC' ? 'DESC' as const : 'ASC' as const,
            };
        }) : [];

        return buildMysqlCreateIndexSql({
            schema: this.initialContext.schema,
            tableName: this.initialContext.tableName,
            indexName,
            keyColumns,
            unique: design.unique === true,
            allowDescending: this.initialContext.supportsDescendingIndexes,
        });
    }

    private async executeDesign(design: MysqlIndexDesign): Promise<void> {
        let ddl: string;
        try {
            ddl = this.buildDdl(design);
        } catch (error) {
            this.postToWebview({ command: 'setError', text: getErrorMessage(error) });
            return;
        }
        await this.executeDdl(ddl, {
            confirmation: `Create this index on ${this.operation.target.qualifiedName}?`,
            progress: `Creating MySQL index on ${this.operation.target.qualifiedName}...`,
            success: 'Index created successfully.',
            errorPrefix: 'Failed to create MySQL index',
        });
    }

    private async dropIndex(indexName: string): Promise<void> {
        const requestedName = typeof indexName === 'string' ? indexName.trim() : '';
        const existingIndex = this.initialContext.existingIndexes.find(index => areMysqlIdentifiersEqual(index.name, requestedName));
        if (!existingIndex) {
            this.postToWebview({ command: 'setError', text: `Index "${requestedName}" is not present on this table. Refresh the designer and try again.` });
            return;
        }
        if (existingIndex.isPrimary) {
            this.postToWebview({ command: 'setError', text: 'The PRIMARY index cannot be dropped from the MySQL Index Designer.' });
            return;
        }

        const ddl = buildMysqlDropIndexSql(
            this.initialContext.schema,
            this.initialContext.tableName,
            existingIndex.name,
        );
        await this.executeDdl(ddl, {
            confirmation: `Drop index ${existingIndex.name} from ${this.operation.target.qualifiedName}? This action cannot be undone.`,
            progress: `Dropping MySQL index ${existingIndex.name}...`,
            success: `Index ${existingIndex.name} dropped successfully.`,
            errorPrefix: 'Failed to drop MySQL index',
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
        const context = await loadMysqlIndexDesignerContext(this.operation.target, this.operation.services);
        this.initialContext = context;
        this.postToWebview({ command: 'setContext', context });
    }

    private async saveDesignAsSql(design: MysqlIndexDesign): Promise<void> {
        try {
            await this.operation.services.openSqlDocument(this.buildDdl(design), 'sql');
        } catch (error) {
            this.postToWebview({ command: 'setError', text: getErrorMessage(error) });
        }
    }

    private async copyDesignDdl(design: MysqlIndexDesign): Promise<void> {
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
            vscode.Uri.joinPath(this.coreExtensionUri, 'dist', 'media', 'mysqlIndexDesigner.js'),
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
                <title>MySQL Index Designer</title>
                <script nonce="${nonce}">window.initialContext = ${initialContext};</script>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </head>
            <body>
                <div id="statusBanner" class="status-banner hidden" role="alert" aria-live="polite"></div>
                <main class="mysql-designer">
                    <header class="designer-header">
                        <div><p class="eyebrow">MySQL 8+</p><h1>Index Designer</h1><p class="subtitle">${targetDisplay}</p></div>
                        <div class="designer-actions"><button id="reloadBtn" class="vscode-button secondary">Refresh</button><button id="copyDdlBtn" class="vscode-button secondary">Copy DDL</button><button id="saveAsSqlBtn" class="vscode-button secondary">Open in Editor</button><button id="executeDdlBtn" class="vscode-button primary">Execute</button></div>
                    </header>
                    <section class="designer-grid index-grid">
                        <section class="designer-card">
                            <h2>Index Definition</h2>
                            <p class="field-hint">Engine: <code id="engineName"></code>. Standard and UNIQUE indexes are supported.</p>
                            <div class="form-grid"><label>Index name *<input id="indexName" type="text" autocomplete="off"></label><label class="checkbox-row"><input id="unique" type="checkbox"> UNIQUE</label></div>
                            <h3>Key columns</h3><div id="keyColumns" class="repeating-rows"></div>
                        </section>
                        <section class="designer-card">
                            <h2>Available columns</h2><input id="columnSearch" type="search" placeholder="Filter columns">
                            <div id="availableColumns" class="column-picker"></div>
                            <p id="descendingHint" class="field-hint"></p>
                        </section>
                        <section class="designer-card index-list-card"><div class="card-heading"><h2>Existing indexes</h2><span id="existingIndexesHint" class="field-hint"></span></div><div class="index-table-wrap"><table><thead><tr><th>Name</th><th>Columns</th><th>Type</th><th>Properties</th><th>Actions</th></tr></thead><tbody id="existingIndexesBody"></tbody></table></div></section>
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

function identifierKey(value: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2) {
        return trimmed.slice(1, -1).replace(/``/g, '`').toLowerCase();
    }
    return trimmed.toLowerCase();
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
