import * as vscode from 'vscode';
import type {
    DatabaseMaintenanceServices,
    DatabaseMaintenanceTarget
} from '@justybase/contracts';
import type { Db2DesignerColumn } from '../../../src/contracts/webviews/db2IndexDesignerContracts';
import type {
    Db2DesignerPartition,
    Db2PartitionDesignerInboundMessage,
    Db2PartitionDesignerInitialContext,
    Db2PartitionDesignerOutboundMessage,
    Db2PartitionExecutionRequest
} from '../../../src/contracts/webviews/db2PartitionDesignerContracts';
import { buildColumnMetadataQuery, buildListPartitionsQuery, buildListTablespacesQuery, buildTablePartitionExpressionsQuery } from './db2SystemQueries';

const CORE_EXTENSION_ID = 'krzysztof-d.justybaselite-netezza';

interface Db2ColumnRow extends Record<string, unknown> {
    ATTNAME?: string;
    FORMAT_TYPE?: string;
    IS_NOT_NULL?: number | string | boolean;
}

interface Db2PartitionRow extends Record<string, unknown> {
    PARTITION_NAME?: string;
    LOWVALUE?: string;
    HIGHVALUE?: string;
    LOWINCLUSIVE?: string;
    HIGHINCLUSIVE?: string;
    TBSPACE?: string;
    ROW_COUNT?: number;
}

interface Db2PartitionExpressionRow extends Record<string, unknown> {
    PARTITION_EXPRESSION?: string;
    NULLSFIRST?: string;
}

interface Db2TablespaceRow extends Record<string, unknown> {
    TBSPACE?: string;
}

interface Db2DesignerOperationContext {
    target: DatabaseMaintenanceTarget;
    services: DatabaseMaintenanceServices;
}

export class Db2PartitionDesignerView {
    public static readonly viewType = 'justybase.db2PartitionDesigner';

    public static async createOrShow(
        _context: vscode.ExtensionContext,
        operation: Db2DesignerOperationContext
    ): Promise<void> {
        const coreExtension = vscode.extensions.getExtension(CORE_EXTENSION_ID);
        if (!coreExtension) {
            vscode.window.showErrorMessage('The JustyBase core extension is required to open the Db2 Partition Manager.');
            return;
        }

        try {
            const initialContext = await Db2PartitionDesignerView.loadInitialContext(operation);
            const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
            const panel = vscode.window.createWebviewPanel(
                Db2PartitionDesignerView.viewType,
                `Db2 Partition Manager: ${operation.target.qualifiedName}`,
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
            new Db2PartitionDesignerView(panel, coreExtension.extensionUri, operation, initialContext);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Could not open Db2 Partition Manager: ${message}`);
        }
    }

    private static async loadInitialContext(operation: Db2DesignerOperationContext): Promise<Db2PartitionDesignerInitialContext> {
        const { target, services } = operation;
        const tablespacesPromise = services.executeQuery<Db2TablespaceRow>(
            buildListTablespacesQuery(),
            target.connectionName
        ).catch(() => []);
        const [columnRows, partitionRows, expressionRows, tablespaceRows] = await Promise.all([
            services.executeQuery<Db2ColumnRow>(
                buildColumnMetadataQuery(target.schemaName, target.tableName),
                target.connectionName
            ),
            services.executeQuery<Db2PartitionRow>(
                buildListPartitionsQuery(target.schemaName, target.tableName),
                target.connectionName
            ),
            services.executeQuery<Db2PartitionExpressionRow>(
                buildTablePartitionExpressionsQuery(target.schemaName, target.tableName),
                target.connectionName
            ),
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

        const partitions: Db2DesignerPartition[] = partitionRows
            .map(row => ({
                name: row.PARTITION_NAME?.trim() ?? '',
                lowValue: row.LOWVALUE?.trim() ?? '',
                highValue: row.HIGHVALUE?.trim() ?? '',
                lowInclusive: row.LOWINCLUSIVE?.trim().toUpperCase() === 'Y',
                highInclusive: row.HIGHINCLUSIVE?.trim().toUpperCase() === 'Y',
                tablespace: row.TBSPACE?.trim() ?? '',
                rowCount: typeof row.ROW_COUNT === 'number' && row.ROW_COUNT >= 0 ? row.ROW_COUNT : undefined
            }))
            .filter(partition => partition.name.length > 0);
        const partitionExpressions = expressionRows
            .map(row => {
                const expression = row.PARTITION_EXPRESSION?.trim() ?? '';
                return expression && row.NULLSFIRST?.trim().toUpperCase() === 'N'
                    ? `${expression} NULLS LAST`
                    : expression;
            })
            .filter(expression => expression.length > 0);

        return {
            schema: target.schemaName,
            tableName: target.tableName,
            qualifiedTable: target.qualifiedName,
            columns,
            partitionExpressions,
            partitions,
            tablespaces: tablespaceRows
                .map(row => row.TBSPACE?.trim() ?? '')
                .filter(tablespace => tablespace.length > 0)
        };
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly coreExtensionUri: vscode.Uri,
        private readonly operation: Db2DesignerOperationContext,
        private readonly initialContext: Db2PartitionDesignerInitialContext
    ) {
        this.panel.webview.html = this.getHtmlForWebview();
        this.panel.onDidDispose(() => this.dispose(), null);
        this.panel.webview.onDidReceiveMessage(
            async (message: Db2PartitionDesignerInboundMessage) => this.handleMessage(message),
            null
        );
    }

    private async handleMessage(message: Db2PartitionDesignerInboundMessage): Promise<void> {
        switch (message.command) {
            case 'executeStatements':
                await this.executeStatements(message.request);
                return;
            case 'saveAsSql':
                await this.saveAsSql(message.ddl);
                return;
            case 'copyDDL':
                await this.copyDdl(message.ddl);
                return;
        }
    }

    private postToWebview(message: Db2PartitionDesignerOutboundMessage): void {
        void this.panel.webview.postMessage(message);
    }

    private async executeStatements(request: Db2PartitionExecutionRequest): Promise<void> {
        const statements = request.statements.map(statement => statement.trim()).filter(statement => statement.length > 0);
        if (statements.length === 0) {
            this.postToWebview({ command: 'setError', text: 'There is no SQL to execute.' });
            return;
        }

        const confirmation = await vscode.window.showWarningMessage(
            `${request.title} on ${this.operation.target.qualifiedName}?`,
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
            await this.operation.services.executeWithProgress(request.title, async () => {
                for (const statement of statements) {
                    await this.operation.services.executeSql(statement, this.operation.target.connectionName, request.title);
                }
            });
            await vscode.commands.executeCommand('netezza.refreshSchema', this.operation.target.connectionName);
            this.postToWebview({ command: 'setInfo', text: `${request.successMessage} The schema tree has been refreshed.` });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.postToWebview({ command: 'setError', text: `Failed to execute partition operation: ${message}` });
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
            vscode.Uri.joinPath(this.coreExtensionUri, 'dist', 'media', 'db2PartitionDesigner.js')
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
                <title>Db2 Partition Manager</title>
                <script nonce="${nonce}">window.initialContext = ${initialContext};</script>
            </head>
            <body>
                <div id="statusBanner" class="status-banner hidden" role="alert" aria-live="polite"></div>
                <main class="db2-designer">
                    <header class="designer-header">
                        <div><p class="eyebrow">Db2 LUW</p><h1>Partition Manager</h1><p class="subtitle">${targetDisplay}</p></div>
                        <div class="designer-actions compact-actions"><button id="copyDdlBtn" class="vscode-button secondary">Copy DDL</button><button id="saveAsSqlBtn" class="vscode-button secondary">Open in Editor</button><button id="executeDdlBtn" class="vscode-button primary">Execute</button></div>
                    </header>
                    <section id="partitioningInfo" class="partitioning-info"></section>
                    <nav class="operation-tabs" aria-label="Partition operation">
                        <button data-operation="add" class="active">Add Partition</button>
                        <button data-operation="attach">Attach / Roll-In</button>
                        <button data-operation="manage">Detach / Drop</button>
                    </nav>
                    <section id="addSection" class="designer-card operation-section">
                        <h2>Add Partition</h2><p class="field-hint">Boundary values are Db2 SQL expressions. For a date use <code>('2024-01-01')</code>; use <code>MINVALUE</code>/<code>MAXVALUE</code> where appropriate.</p>
                        <div class="form-grid three-columns"><label>Partition name *<input id="addPartitionName" type="text"></label><label>Starting from *<input id="addStartingFrom" type="text" placeholder="('2024-01-01')"></label><label>Ending at *<input id="addEndingAt" type="text" placeholder="('2024-02-01')"></label><label>Starting boundary<select id="addStartingInclusive"><option value="inclusive">Inclusive</option><option value="exclusive">Exclusive</option></select></label><label>Ending boundary<select id="addEndingInclusive"><option value="exclusive">Exclusive</option><option value="inclusive">Inclusive</option></select></label><label>Data tablespace<input id="addTablespace" list="tablespaces" type="text" placeholder="Optional"></label><label>Index tablespace<input id="addIndexTablespace" list="tablespaces" type="text" placeholder="Optional"></label><label>Long tablespace<input id="addLongTablespace" list="tablespaces" type="text" placeholder="Optional"></label></div>
                    </section>
                    <section id="attachSection" class="designer-card operation-section hidden">
                        <h2>Attach Partition / Roll-In</h2><p class="field-hint">The source table must meet Db2 ATTACH requirements. Integrity validation is recommended and enabled by default.</p>
                        <div class="form-grid three-columns"><label>Partition name *<input id="attachPartitionName" type="text"></label><label>Source schema *<input id="attachSourceSchema" type="text"></label><label>Source table *<input id="attachSourceTable" type="text"></label><label>Starting from *<input id="attachStartingFrom" type="text" placeholder="('2024-01-01')"></label><label>Ending at *<input id="attachEndingAt" type="text" placeholder="('2024-02-01')"></label><label>Starting boundary<select id="attachStartingInclusive"><option value="inclusive">Inclusive</option><option value="exclusive">Exclusive</option></select></label><label>Ending boundary<select id="attachEndingInclusive"><option value="exclusive">Exclusive</option><option value="inclusive">Inclusive</option></select></label></div>
                        <label class="checkbox-row"><input id="runSetIntegrity" type="checkbox" checked> Run <code>SET INTEGRITY ... IMMEDIATE CHECKED</code> after attach</label>
                    </section>
                    <section id="manageSection" class="designer-card operation-section hidden"><div class="card-heading"><h2>Existing Partitions</h2><span id="partitionCount" class="field-hint"></span></div><div class="partition-table-wrap"><table><thead><tr><th>Name</th><th>Starting from</th><th>Ending at</th><th>Tablespace</th><th>Rows</th><th>Actions</th></tr></thead><tbody id="partitionsBody"></tbody></table></div><div id="manageForm" class="manage-form hidden"><h3 id="manageTitle"></h3><p id="manageHint" class="field-hint"></p><div class="form-grid"><label>Detached table name *<input id="detachedTableName" type="text"></label></div></div></section>
                    <datalist id="tablespaces"></datalist>
                    <section class="designer-card ddl-card"><div class="card-heading"><h2>Generated DDL</h2><span class="field-hint">Review before execution.</span></div><textarea id="ddlPreview" readonly spellcheck="false"></textarea></section>
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
