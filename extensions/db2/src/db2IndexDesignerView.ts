import * as vscode from 'vscode';
import type {
    DatabaseMaintenanceProvider,
    DatabaseMaintenanceServices,
    DatabaseMaintenanceTarget
} from '@justybase/contracts';
import type {
    Db2DesignerColumn,
    Db2DesignerExistingIndex,
    Db2IndexDesign,
    Db2IndexDesignerInboundMessage,
    Db2IndexDesignerInitialContext,
    Db2IndexDesignerOutboundMessage
} from '../../../src/contracts/webviews/db2IndexDesignerContracts';
import { buildColumnMetadataQuery, buildListTablespacesQuery } from './db2SystemQueries';
import { buildDb2CreateIndexSql, type Db2CreateIndexDdlOptions } from './db2DesignerDdl';

const CORE_EXTENSION_ID = 'krzysztof-d.justybaselite-netezza';

interface Db2ColumnRow extends Record<string, unknown> {
    ATTNAME?: string;
    FORMAT_TYPE?: string;
    IS_NOT_NULL?: number | string | boolean;
    COLDEFAULT?: string;
    DESCRIPTION?: string;
    IS_PK?: number | string | boolean;
    IS_FK?: number | string | boolean;
    ATTNUM?: number | string;
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
            .map((row, index) => ({
                name: toText(row.ATTNAME),
                type: toText(row.FORMAT_TYPE),
                notNull: toBoolean(row.IS_NOT_NULL),
                ordinal: toNumber(row.ATTNUM) || index + 1,
                defaultValue: toText(row.COLDEFAULT),
                description: toText(row.DESCRIPTION),
                isPrimaryKey: toBoolean(row.IS_PK),
                isForeignKey: toBoolean(row.IS_FK)
            }))
            .filter(column => column.name.length > 0);
        if (columns.length === 0) {
            throw new Error(`Db2 did not return columns for ${target.qualifiedName}.`);
        }

        const existingIndexes: Db2DesignerExistingIndex[] = indexes.map(index => ({
            name: index.name,
            columns: index.columns,
            columnOrders: index.columnOrders ?? index.columns.map(column => ({ name: column, order: 'ASC' as const })),
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
                .map(row => toText(row.TBSPACE))
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
            case 'executeDesign':
                await this.executeDesign(message.design);
                return;
            case 'saveAsSql':
                await this.saveDesignAsSql(message.design);
                return;
            case 'copyDDL':
                await this.copyDesignDdl(message.design);
                return;
        }
    }

    private postToWebview(message: Db2IndexDesignerOutboundMessage): void {
        void this.panel.webview.postMessage(message);
    }

    private async executeDesign(design: Db2IndexDesign): Promise<void> {
        let ddl: string;
        try {
            ddl = this.buildDdl(design);
        } catch (error) {
            this.postToWebview({ command: 'setError', text: getErrorMessage(error) });
            return;
        }

        await this.executeDdl(ddl);
    }

    private buildDdl(design: Db2IndexDesign): string {
        if (!design || typeof design !== 'object') {
            throw new Error('The index design is invalid. Reopen the designer and try again.');
        }

        const columnsByName = new Map(
            this.initialContext.columns.map(column => [column.name.toUpperCase(), column.name])
        );
        const rawKeyColumns = Array.isArray(design.keyColumns) ? design.keyColumns : [];
        const keyColumns = rawKeyColumns.map(column => {
            const name = typeof column?.name === 'string' ? column.name.trim() : '';
            const canonicalName = columnsByName.get(name.toUpperCase());
            if (!canonicalName) {
                throw new Error(`Column "${name}" does not belong to ${this.initialContext.qualifiedTable}.`);
            }
            return {
                name: canonicalName,
                order: column.order === 'DESC' ? 'DESC' as const : 'ASC' as const
            };
        });

        const keyNames = new Set<string>();
        for (const column of keyColumns) {
            const normalizedName = column.name.toUpperCase();
            if (!keyNames.add(normalizedName)) {
                throw new Error(`Column "${column.name}" can only be selected once.`);
            }
        }

        const includeColumns = (Array.isArray(design.includeColumns) ? design.includeColumns : [])
            .map(column => typeof column === 'string' ? column.trim() : '')
            .filter(column => column.length > 0)
            .map(column => {
                const canonicalName = columnsByName.get(column.toUpperCase());
                if (!canonicalName) {
                    throw new Error(`Included column "${column}" does not belong to ${this.initialContext.qualifiedTable}.`);
                }
                if (keyNames.has(canonicalName.toUpperCase())) {
                    throw new Error(`Column "${canonicalName}" cannot be both a key and an included column.`);
                }
                return canonicalName;
            });

        const includeNames = new Set<string>();
        for (const column of includeColumns) {
            if (!includeNames.add(column.toUpperCase())) {
                throw new Error(`Included column "${column}" can only be selected once.`);
            }
        }

        const additionalClause = typeof design.additionalClause === 'string'
            ? design.additionalClause.trim()
            : '';
        if (additionalClause.includes(';')) {
            throw new Error('Additional Db2 clause cannot contain a semicolon.');
        }

        const options: Db2CreateIndexDdlOptions = {
            schema: this.initialContext.schema,
            tableName: this.initialContext.tableName,
            indexName: typeof design.indexName === 'string' ? design.indexName.trim() : '',
            keyColumns,
            includeColumns,
            unique: design.unique === true,
            clustered: design.clustered === true,
            reverseScans: design.reverseScans === 'allow' || design.reverseScans === 'disallow'
                ? design.reverseScans
                : undefined,
            compress: design.compress === 'yes' || design.compress === 'no' ? design.compress : undefined,
            pctFree: validatePercent(design.pctFree, 'PCTFREE'),
            level2PctFree: validatePercent(design.level2PctFree, 'LEVEL2 PCTFREE'),
            minPctUsed: validatePercent(design.minPctUsed, 'MINPCTUSED'),
            pageSplit: design.pageSplit === 'symmetric' || design.pageSplit === 'high' ? design.pageSplit : undefined,
            collectStatistics: design.collectStatistics === 'sampled' || design.collectStatistics === 'detailed'
                ? design.collectStatistics
                : undefined,
            tablespace: typeof design.tablespace === 'string' ? design.tablespace.trim() : undefined,
            additionalClause
        };

        if (this.initialContext.existingIndexes.some(index =>
            index.name.toUpperCase() === options.indexName.toUpperCase()
        )) {
            throw new Error(`An index named ${options.indexName} already exists on this table.`);
        }

        return buildDb2CreateIndexSql(options);
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

    private async saveDesignAsSql(design: Db2IndexDesign): Promise<void> {
        let ddl: string;
        try {
            ddl = this.buildDdl(design);
        } catch (error) {
            this.postToWebview({ command: 'setError', text: getErrorMessage(error) });
            return;
        }
        await this.saveAsSql(ddl);
    }

    private async saveAsSql(ddl: string): Promise<void> {
        if (!ddl.trim()) {
            this.postToWebview({ command: 'setError', text: 'DDL is empty.' });
            return;
        }
        await this.operation.services.openSqlDocument(ddl, 'sql');
    }

    private async copyDesignDdl(design: Db2IndexDesign): Promise<void> {
        let ddl: string;
        try {
            ddl = this.buildDdl(design);
        } catch (error) {
            this.postToWebview({ command: 'setError', text: getErrorMessage(error) });
            return;
        }
        await this.copyDdl(ddl);
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
                            </div>
                            <datalist id="tablespaces"></datalist>
                            <div class="toggle-grid">
                                <label><input id="unique" type="checkbox"> UNIQUE</label>
                            </div>
                        </section>
                        <section class="designer-card">
                            <div class="card-heading"><h2>Key Columns *</h2><span class="field-hint">Select from the table metadata.</span></div>
                            <label>Search columns<input id="columnSearch" type="search" autocomplete="off" placeholder="Filter by name or type"></label>
                            <div id="availableColumns" class="column-picker" role="listbox" aria-label="Available table columns"></div>
                            <p class="field-hint">Click a column to add it. Selected columns appear below, where their order and direction can be changed.</p>
                            <div id="keyColumns" class="repeating-rows selected-columns"></div>
                        </section>
                        <details class="designer-card advanced-options">
                            <summary>Included Columns <span class="field-hint">Optional covering columns</span></summary>
                            <select id="includeColumns" multiple size="6" aria-label="Include columns"></select>
                        </details>
                        <details class="designer-card advanced-options">
                            <summary>Storage and Performance <span class="field-hint">Optional Db2-specific settings</span></summary>
                            <div class="form-grid three-columns">
                                <label>Tablespace<input id="tablespace" type="text" list="tablespaces" autocomplete="off" placeholder="Optional"></label>
                                <label>Reverse scans<select id="reverseScans"><option value="">Default</option><option value="allow">Allow</option><option value="disallow">Disallow</option></select></label>
                                <label>Compression<select id="compress"><option value="">Default</option><option value="yes">Yes</option><option value="no">No</option></select></label>
                                <label><span>Cluster</span><input id="clustered" type="checkbox"></label>
                                <label>PCTFREE<input id="pctFree" type="number" min="0" max="99" placeholder="Default"></label>
                                <label>LEVEL2 PCTFREE<input id="level2PctFree" type="number" min="0" max="99" placeholder="Default"></label>
                                <label>MINPCTUSED<input id="minPctUsed" type="number" min="0" max="99" placeholder="Default"></label>
                                <label>Page split<select id="pageSplit"><option value="">Default</option><option value="symmetric">Symmetric</option><option value="high">High</option></select></label>
                                <label>Statistics<select id="collectStatistics"><option value="">Do not collect</option><option value="sampled">Sampled detailed</option><option value="detailed">Detailed</option></select></label>
                            </div>
                        </details>
                        <details class="designer-card advanced-options">
                            <summary>Expert Options <span class="field-hint">For Db2 clauses not exposed above</span></summary>
                            <label>Additional Db2 clause<textarea id="additionalClause" rows="2" placeholder="Optional supported clause, without a semicolon"></textarea></label>
                        </details>
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

function validatePercent(value: unknown, label: string): number | undefined {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 99) {
        throw new Error(`${label} must be an integer from 0 to 99.`);
    }
    return parsed;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toText(value: unknown): string {
    return value === undefined || value === null ? '' : String(value).trim();
}

function toBoolean(value: unknown): boolean {
    return value === true || value === 1 || String(value).trim() === '1' || String(value).trim().toUpperCase() === 'Y';
}

function toNumber(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
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
