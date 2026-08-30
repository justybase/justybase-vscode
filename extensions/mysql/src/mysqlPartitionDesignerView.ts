import * as vscode from 'vscode';
import type {
    MysqlPartitionDesignerInboundMessage,
    MysqlPartitionDesignerInitialContext,
    MysqlPartitionDesignerOutboundMessage,
    MysqlPartitionOperationRequest,
} from '../../../src/contracts/webviews/mysqlPartitionDesignerContracts';
import {
    buildMysqlAddHashKeyPartitionSql,
    buildMysqlAddRangeListPartitionSql,
    buildMysqlCoalescePartitionSql,
    buildMysqlDropPartitionSql,
} from './mysqlDesignerDdl';
import { loadMysqlPartitionDesignerContext } from './mysqlDesignerOperations';
import type { MysqlDesignerOperationContext } from './mysqlCommandContext';

const CORE_EXTENSION_ID = 'krzysztof-d.justybaselite-netezza';

export class MysqlPartitionDesignerView {
    public static readonly viewType = 'justybase.mysqlPartitionDesigner';

    public static async createOrShow(
        _context: vscode.ExtensionContext,
        operation: MysqlDesignerOperationContext,
    ): Promise<void> {
        const coreExtension = vscode.extensions.getExtension(CORE_EXTENSION_ID);
        if (!coreExtension) {
            vscode.window.showErrorMessage('The JustyBase core extension is required to open the MySQL Partition Manager.');
            return;
        }

        const initialContext = await loadMysqlPartitionDesignerContext(operation.target, operation.services);
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        const panel = vscode.window.createWebviewPanel(
            MysqlPartitionDesignerView.viewType,
            `MySQL Partition Manager: ${operation.target.qualifiedName}`,
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

        new MysqlPartitionDesignerView(panel, coreExtension.extensionUri, operation, initialContext);
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly coreExtensionUri: vscode.Uri,
        private readonly operation: MysqlDesignerOperationContext,
        private initialContext: MysqlPartitionDesignerInitialContext,
    ) {
        this.panel.webview.html = this.getHtmlForWebview();
        this.panel.onDidDispose(() => this.dispose(), null);
        this.panel.webview.onDidReceiveMessage(
            async (message: MysqlPartitionDesignerInboundMessage) => this.handleMessage(message),
            null,
        );
    }

    private async handleMessage(message: MysqlPartitionDesignerInboundMessage): Promise<void> {
        switch (message.command) {
            case 'executeOperation':
                await this.executeOperation(message.request);
                return;
            case 'saveAsSql':
                await this.saveOperationAsSql(message.request);
                return;
            case 'copyDDL':
                await this.copyOperationDdl(message.request);
                return;
            case 'reload':
                await this.reloadContext();
                return;
        }
    }

    private postToWebview(message: MysqlPartitionDesignerOutboundMessage): void {
        void this.panel.webview.postMessage(message);
    }

    private buildDdl(request: MysqlPartitionOperationRequest): string {
        const capabilities = this.initialContext.capabilities;
        if (!request || typeof request !== 'object' || !capabilities.isPartitioned) {
            throw new Error(capabilities.reason || 'This table is not available for partition management.');
        }
        const schema = this.initialContext.schema;
        const tableName = this.initialContext.tableName;

        switch (request.operation) {
            case 'addRangeList':
                if (!capabilities.canAddPartition || (capabilities.partitionMethod !== 'RANGE' && capabilities.partitionMethod !== 'LIST')) {
                    throw new Error(capabilities.reason || 'Adding a partition is not supported for this table.');
                }
                ensureNewPartitionName(this.initialContext, request.partitionName);
                return buildMysqlAddRangeListPartitionSql({
                    schema,
                    tableName,
                    partitionName: request.partitionName,
                    valuesClause: request.valuesClause,
                    method: capabilities.partitionMethod,
                });
            case 'addHashKey':
                if (!capabilities.canAddPartition || !isHashKeyMethod(capabilities.partitionMethod)) {
                    throw new Error(capabilities.reason || 'Adding HASH/KEY partitions is not supported for this table.');
                }
                return buildMysqlAddHashKeyPartitionSql({ schema, tableName, partitionCount: request.partitionCount });
            case 'drop':
                if (!capabilities.canDropPartition || capabilities.dropMode !== 'named') {
                    throw new Error(capabilities.reason || 'Dropping a named partition is not supported for this table.');
                }
                ensureExistingPartition(this.initialContext, request.partitionName);
                return buildMysqlDropPartitionSql({ schema, tableName, partitionName: request.partitionName });
            case 'coalesce':
                if (!capabilities.canDropPartition || capabilities.dropMode !== 'coalesce' || !isHashKeyMethod(capabilities.partitionMethod)) {
                    throw new Error(capabilities.reason || 'Reducing HASH/KEY partitions is not supported for this table.');
                }
                const topLevelCount = topLevelPartitions(this.initialContext).length;
                if (!Number.isInteger(request.partitionCount) || request.partitionCount <= 0 || request.partitionCount >= topLevelCount) {
                    throw new Error(`Partitions to coalesce must be a positive integer smaller than the current partition count (${topLevelCount}).`);
                }
                return buildMysqlCoalescePartitionSql({ schema, tableName, partitionCount: request.partitionCount });
        }
    }

    private async executeOperation(request: MysqlPartitionOperationRequest): Promise<void> {
        let ddl: string;
        try {
            ddl = this.buildDdl(request);
        } catch (error) {
            this.postToWebview({ command: 'setError', text: getErrorMessage(error) });
            return;
        }
        const destructive = request.operation === 'drop';
        await this.executeDdl(ddl, {
            confirmation: destructive
                ? `Drop partition from ${this.operation.target.qualifiedName}? This deletes all rows stored in that partition.`
                : `Execute this partition operation on ${this.operation.target.qualifiedName}?`,
            progress: `Executing MySQL partition operation on ${this.operation.target.qualifiedName}...`,
            success: 'Partition operation completed successfully.',
            errorPrefix: 'Failed to execute MySQL partition operation',
        });
    }

    private async executeDdl(
        ddl: string,
        messages: { confirmation: string; progress: string; success: string; errorPrefix: string },
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
                this.postToWebview({ command: 'setInfo', text: `${messages.success} Schema refresh failed: ${getErrorMessage(error)}` });
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
        const context = await loadMysqlPartitionDesignerContext(this.operation.target, this.operation.services);
        this.initialContext = context;
        this.postToWebview({ command: 'setContext', context });
    }

    private async saveOperationAsSql(request: MysqlPartitionOperationRequest): Promise<void> {
        try {
            await this.operation.services.openSqlDocument(this.buildDdl(request), 'sql');
        } catch (error) {
            this.postToWebview({ command: 'setError', text: getErrorMessage(error) });
        }
    }

    private async copyOperationDdl(request: MysqlPartitionOperationRequest): Promise<void> {
        try {
            await vscode.env.clipboard.writeText(this.buildDdl(request));
            this.postToWebview({ command: 'setInfo', text: 'DDL copied to the clipboard.' });
        } catch (error) {
            this.postToWebview({ command: 'setError', text: getErrorMessage(error) });
        }
    }

    private getHtmlForWebview(): string {
        const scriptUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.coreExtensionUri, 'dist', 'media', 'mysqlPartitionDesigner.js'),
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
                <title>MySQL Partition Manager</title>
                <script nonce="${nonce}">window.initialContext = ${initialContext};</script>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </head>
            <body>
                <div id="statusBanner" class="status-banner hidden" role="alert" aria-live="polite"></div>
                <main class="mysql-designer">
                    <header class="designer-header">
                        <div><p class="eyebrow">MySQL 8+</p><h1>Partition Manager</h1><p class="subtitle">${targetDisplay}</p></div>
                        <div class="designer-actions"><button id="reloadBtn" class="vscode-button secondary">Refresh</button><button id="copyDdlBtn" class="vscode-button secondary">Copy DDL</button><button id="saveAsSqlBtn" class="vscode-button secondary">Open in Editor</button><button id="executeDdlBtn" class="vscode-button primary">Execute</button></div>
                    </header>
                    <section id="partitioningInfo" class="partitioning-info"></section>
                    <nav class="operation-tabs" aria-label="Partition operation"><button data-operation="add" class="active">Add partition</button><button data-operation="manage">Manage partitions</button></nav>
                    <section id="addSection" class="designer-card operation-section">
                        <h2>Add partition</h2>
                        <div id="rangeListForm"><p class="field-hint">Use the values clause for the current RANGE/LIST method, for example <code>VALUES LESS THAN ('2027-01-01')</code>.</p><div class="form-grid"><label>Partition name *<input id="addPartitionName" type="text"></label><label>Values clause *<input id="addValuesClause" type="text" placeholder="VALUES LESS THAN (...)" /></label></div></div>
                        <div id="hashKeyForm" class="hidden"><p class="field-hint">MySQL adds HASH/KEY partitions by count.</p><div class="form-grid"><label>Partitions to add *<input id="addPartitionCount" type="number" min="1" step="1" value="1"></label></div></div>
                    </section>
                    <section id="manageSection" class="designer-card operation-section hidden"><div class="card-heading"><h2>Existing partitions</h2><span id="partitionCount" class="field-hint"></span></div><div class="partition-table-wrap"><table><thead><tr><th>Name</th><th>Method</th><th>Definition</th><th>Rows (est.)</th><th>Data</th><th>Index</th><th>Actions</th></tr></thead><tbody id="partitionsBody"></tbody></table></div><div id="coalesceForm" class="manage-form hidden"><h3>Reduce HASH/KEY partitions</h3><p class="field-hint">COALESCE merges this many partitions into the remainder.</p><div class="form-grid"><label>Partitions to reduce *<input id="coalesceCount" type="number" min="1" step="1" value="1"></label></div></div></section>
                    <section class="designer-card ddl-card"><h2>DDL Preview</h2><textarea id="ddlPreview" readonly spellcheck="false"></textarea></section>
                </main>
            </body>
            </html>`;
    }

    private dispose(): void {
        // The panel owns no external resources.
    }
}

function topLevelPartitions(context: MysqlPartitionDesignerInitialContext) {
    return context.partitions.filter(partition => !partition.subpartitionName);
}

function isHashKeyMethod(method: MysqlPartitionDesignerInitialContext['capabilities']['partitionMethod']): boolean {
    return method === 'HASH' || method === 'LINEAR HASH' || method === 'KEY' || method === 'LINEAR KEY';
}

function ensureNewPartitionName(context: MysqlPartitionDesignerInitialContext, value: string): void {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name) {
        throw new Error('Partition name is required.');
    }
    if (context.partitions.some(partition => partition.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`Partition "${name}" already exists on this table.`);
    }
}

function ensureExistingPartition(context: MysqlPartitionDesignerInitialContext, value: string): void {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || !topLevelPartitions(context).some(partition => partition.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`Partition "${name}" is not present on this table. Refresh the designer and try again.`);
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
