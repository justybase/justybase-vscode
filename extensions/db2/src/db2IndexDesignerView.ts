import * as vscode from 'vscode';
import type {
    DatabaseMaintenanceProvider,
    DatabaseMaintenanceServices,
    DatabaseMaintenanceTarget
} from '@justybase/contracts';
import type {
    Db2DesignerColumn,
    Db2DesignerExistingIndex,
    Db2IndexDesignerInboundMessage,
    Db2IndexDesignerInitialContext,
    Db2IndexDesignerOutboundMessage
} from '../../../src/contracts/webviews/db2IndexDesignerContracts';
import { buildColumnMetadataQuery, buildListTablespacesQuery } from './db2SystemQueries';

const CORE_EXTENSION_ID = 'krzysztof-d.justybaselite-netezza';

interface Db2ColumnRow extends Record<string, unknown> {
    ATTNAME?: string;
    FORMAT_TYPE?: string;
    IS_NOT_NULL?: number | string | boolean;
}

interface Db2TablespaceRow extends Record<string, unknown> {
    TBSPACE?: string;
}

interface Db2DesignerOperationContext {
    provider: DatabaseMaintenanceProvider;
    target: DatabaseMaintenanceTarget;
    services: DatabaseMaintenanceServices;
}

export class Db2IndexDesignerView {
    public static readonly viewType = 'justybase.db2IndexDesigner';

    public static async createOrShow(
        _context: vscode.ExtensionContext,
        operation: Db2DesignerOperationContext
    ): Promise<void> {
        const coreExtension = vscode.extensions.getExtension(CORE_EXTENSION_ID);
        if (!coreExtension) {
            vscode.window.showErrorMessage('The JustyBase core extension is required to open the Db2 Index Designer.');
            return;
        }

        try {
            const initialContext = await Db2IndexDesignerView.loadInitialContext(operation);
            const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
            const panel = vscode.window.createWebviewPanel(
                Db2IndexDesignerView.viewType,
                `Db2 Index Designer: ${operation.target.qualifiedName}`,
                column,
                {
                    enableScripts: true,
                    localResourceRoots: [
                        vscode.Uri.joinPath(coreExtension.extensionUri, 'media'),
                        vscode.Uri.joinPath(coreExtension.extensionUri, 'dist')
                    ],
                    retainContextWhenHidden: true
                }
            );

            new Db2IndexDesignerView(panel, coreExtension.extensionUri, operation, initialContext);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Could not open Db2 Index Designer: ${message}`);
        }
    }

    private static async loadInitialContext(operation: Db2DesignerOperationContext): Promise<Db2IndexDesignerInitialContext> {
        const { target, services, provider } = operation;
        const indexesPromise = provider.listIndexes
            ? provider.listIndexes(target, services).catch(() => [])
            : Promise.resolve([]);
        const tablespacesPromise = services.executeQuery<Db2TablespaceRow>(
            buildListTablespacesQuery(),
            target.connectionName
        ).catch(() => []);
        const [columnRows, indexes, tablespaceRows] = await Promise.all([
            services.executeQuery<Db2ColumnRow>(
                buildColumnMetadataQuery(target.schemaName, target.tableName),
                target.connectionName
            ),
            indexesPromise,
            tablespacesPromise
        ]);

        const columns: Db2DesignerColumn[] = columnRows
            .map(row => ({
                name: row.ATTNAME?.trim() ?? '',
                type: row.FORMAT_TYPE?.trim() ?? '',
                notNull: row.IS_NOT_NULL === 1 || row.IS_NOT_NULL === true || row.IS_NOT_NULL === '1'
            }))
            .filter(column => column.name.length > 0);
        if (columns.length === 0) {
            throw new Error(`Db2 did not return columns for ${target.qualifiedName}.`);
        }

        const existingIndexes: Db2DesignerExistingIndex[] = indexes.map(index => ({
            name: index.name,
            columns: index.columns,
            isUnique: index.isUnique,
            isPrimary: index.isPrimary,
            indexType: index.indexType
        }));

        return {
            schema: target.schemaName,
            tableName: target.tableName,
            qualifiedTable: target.qualifiedName,
            columns,
            existingIndexes,
            tablespaces: tablespaceRows
                .map(row => row.TBSPACE?.trim() ?? '')
                .filter(tablespace => tablespace.length > 0)
        };
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly coreExtensionUri: vscode.Uri,
        private readonly operation: Db2DesignerOperationContext,
        private readonly initialContext: Db2IndexDesignerInitialContext
    ) {
        this.panel.webview.html = this.getHtmlForWebview();
        this.panel.onDidDispose(() => this.dispose(), null);
        this.panel.webview.onDidReceiveMessage(
            async (message: Db2IndexDesignerInboundMessage) => this.handleMessage(message),
            null
        );
    }

    private async handleMessage(message: Db2IndexDesignerInboundMessage): Promise<void> {
        switch (message.command) {
            case 'executeDDL':
                await this.executeDdl(message.ddl);
                return;
            case 'saveAsSql':
                await this.saveAsSql(message.ddl);
                return;
            case 'copyDDL':
                await this.copyDdl(message.ddl);
                return;
        }
    }

    private postToWebview(message: Db2IndexDesignerOutboundMessage): void {
        void this.panel.webview.postMessage(message);
    }

    private async executeDdl(ddl: string): Promise<void> {
        if (!ddl.trim()) {
            this.postToWebview({ command: 'setError', text: 'DDL is empty. Select key columns and enter an index name.' });
            return;
        }

        const confirmation = await vscode.window.showWarningMessage(
            `Create this index on ${this.operation.target.qualifiedName}?`,
            { modal: true },
            'Execute DDL',
            'Cancel'
        );
        if (confirmation !== 'Execute DDL') {
            return;
        }

        this.postToWebview({ command: 'clearStatus' });
        this.postToWebview({ command: 'setExecuting', executing: true });
        try {
            await this.operation.services.executeWithProgress(
                `Creating index on ${this.operation.target.qualifiedName}...`,
                async () => this.operation.services.executeSql(
                    ddl,
                    this.operation.target.connectionName,
                    `Creating index on ${this.operation.target.qualifiedName}...`
                )
            );
            await vscode.commands.executeCommand('netezza.refreshSchema', this.operation.target.connectionName);
            this.postToWebview({ command: 'setInfo', text: 'Index created successfully. The schema tree has been refreshed.' });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.postToWebview({ command: 'setError', text: `Failed to create index: ${message}` });
        } finally {
            this.postToWebview({ command: 'setExecuting', executing: false });
        }
    }

    private async saveAsSql(ddl: string): Promise<void> {
        if (!ddl.trim()) {
            this.postToWebview({ command: 'setError', text: 'DDL is empty.' });
            return;
        }
        await this.operation.services.openSqlDocument(ddl, 'sql');
    }

    private async copyDdl(ddl: string): Promise<void> {
        if (!ddl.trim()) {
            return;
        }
        await vscode.env.clipboard.writeText(ddl);
        this.postToWebview({ command: 'setInfo', text: 'DDL copied to the clipboard.' });
    }

    private getHtmlForWebview(): string {
        const scriptUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.coreExtensionUri, 'dist', 'media', 'db2IndexDesigner.js')
        );
        const styleUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.coreExtensionUri, 'media', 'db2Designer.css')
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
                <title>Db2 Index Designer</title>
                <script nonce="${nonce}">window.initialContext = ${initialContext};</script>
            </head>
            <body>
                <div id="statusBanner" class="status-banner hidden" role="alert" aria-live="polite"></div>
                <main class="db2-designer">
                    <header class="designer-header">
                        <div>
                            <p class="eyebrow">Db2 LUW</p>
                            <h1>Create Index</h1>
                            <p class="subtitle">${targetDisplay}</p>
                        </div>
                        <div class="designer-actions compact-actions">
                            <button id="copyDdlBtn" class="vscode-button secondary">Copy DDL</button>
                            <button id="saveAsSqlBtn" class="vscode-button secondary">Open in Editor</button>
                            <button id="executeDdlBtn" class="vscode-button primary">Execute</button>
                        </div>
                    </header>
                    <section class="designer-grid index-grid">
                        <section class="designer-card">
                            <h2>Index Definition</h2>
                            <div class="form-grid">
                                <label>Index name *<input id="indexName" type="text" autocomplete="off"></label>
                                <label>Tablespace<input id="tablespace" type="text" list="tablespaces" autocomplete="off" placeholder="Optional"></label>
                            </div>
                            <datalist id="tablespaces"></datalist>
                            <div class="toggle-grid">
                                <label><input id="unique" type="checkbox"> UNIQUE</label>
                                <label><input id="clustered" type="checkbox"> CLUSTER</label>
                                <label>Reverse scans<select id="reverseScans"><option value="">Default</option><option value="allow">Allow</option><option value="disallow">Disallow</option></select></label>
                                <label>Compression<select id="compress"><option value="">Default</option><option value="yes">Yes</option><option value="no">No</option></select></label>
                            </div>
                        </section>
                        <section class="designer-card">
                            <div class="card-heading"><h2>Key Columns *</h2><button id="addKeyColumnBtn" class="vscode-button secondary">Add column</button></div>
                            <div id="keyColumns" class="repeating-rows"></div>
                            <p class="field-hint">Use the arrows to define composite-index order. INCLUDE columns must not also be key columns.</p>
                        </section>
                        <section class="designer-card">
                            <h2>Include Columns</h2>
                            <select id="includeColumns" multiple size="6" aria-label="Include columns"></select>
                        </section>
                        <section class="designer-card advanced-options">
                            <h2>Advanced Options</h2>
                            <div class="form-grid three-columns">
                                <label>PCTFREE<input id="pctFree" type="number" min="0" max="99" placeholder="Default"></label>
                                <label>LEVEL2 PCTFREE<input id="level2PctFree" type="number" min="0" max="99" placeholder="Default"></label>
                                <label>MINPCTUSED<input id="minPctUsed" type="number" min="0" max="99" placeholder="Default"></label>
                                <label>Page split<select id="pageSplit"><option value="">Default</option><option value="symmetric">Symmetric</option><option value="high">High</option></select></label>
                                <label>Statistics<select id="collectStatistics"><option value="">Do not collect</option><option value="sampled">Sampled detailed</option><option value="detailed">Detailed</option></select></label>
                            </div>
                            <label>Additional Db2 clause<textarea id="additionalClause" rows="2" placeholder="Optional, for a supported clause not exposed above"></textarea></label>
                        </section>
                    </section>
                    <section class="designer-card ddl-card"><div class="card-heading"><h2>Generated DDL</h2><span id="existingIndexesHint" class="field-hint"></span></div><textarea id="ddlPreview" readonly spellcheck="false"></textarea></section>
                </main>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }

    private dispose(): void {
        this.panel.dispose();
    }
}

function getNonce(): string {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let index = 0; index < 32; index++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>'"]/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
    })[character] ?? character);
}
