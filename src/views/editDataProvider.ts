import * as vscode from 'vscode';
import type {
    EditDataChanges,
    EditDataPanelInboundMessage,
    EditDataPanelOutboundMessage
} from '../contracts/webviews';
import { runQuery, runQueryRaw, runQueriesSequentially, queryResultToRows } from '../core/queryRunner';
import { ConnectionManager } from '../core/connectionManager';
import { getTableMetadata, toWebviewFormat } from '../providers/tableMetadataProvider';

export interface EditDataItem {
    label: string;
    dbName: string;
    schema: string;
    connectionName: string;
    [key: string]: unknown;
}

export class EditDataProvider {
    public static readonly viewType = 'netezza.editData';

    public static async createOrShow(
        extensionUri: vscode.Uri,
        item: EditDataItem,
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager
    ) {
        if (!item || !item.label || !item.dbName || !item.schema) {
            vscode.window.showErrorMessage('Invalid table selection');
            return;
        }

        const tableName = item.label;
        const schema = item.schema;
        const database = item.dbName;
        const fullTableName = `${database}.${schema}.${tableName}`;

        // Create Webview Panel
        const panel = vscode.window.createWebviewPanel(
            EditDataProvider.viewType,
            `Edit: ${tableName}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                    vscode.Uri.joinPath(extensionUri, 'dist')
                ],
                retainContextWhenHidden: true
            }
        );

        // Set HTML
        panel.webview.html = this._getHtmlForWebview(panel.webview, extensionUri, fullTableName);

        // Load Data and Metadata
        this._loadData(panel, database, schema, tableName, item.connectionName, context, connectionManager);

        // Message Handling
        panel.webview.onDidReceiveMessage(async (message: EditDataPanelInboundMessage) => {
            try {
                switch (message.command) {
                    case 'save':
                        await this._handleSave(
                            panel,
                            message.changes,
                            fullTableName,
                            item.connectionName,
                            context,
                            connectionManager
                        );
                        // Refresh after save with same filter options
                        this._loadData(
                            panel,
                            database,
                            schema,
                            tableName,
                            item.connectionName,
                            context,
                            connectionManager,
                            {
                                whereClause: message.whereClause,
                                columns: message.columns
                            }
                        );
                        break;
                    case 'refresh':
                        this._loadData(
                            panel,
                            database,
                            schema,
                            tableName,
                            item.connectionName,
                            context,
                            connectionManager,
                            {
                                whereClause: message.whereClause,
                                columns: message.columns
                            }
                        );
                        break;

                    // Metadata Actions
                    case 'updateTableComment':
                        await this._execSimpleCommand(
                            context,
                            connectionManager,
                            item.connectionName,
                            `COMMENT ON TABLE ${fullTableName} IS '${(message.comment || '').replace(/'/g, "''")}'`,
                            'Table comment updated'
                        );
                        break;
                    case 'updateColumnComment':
                        await this._execSimpleCommand(
                            context,
                            connectionManager,
                            item.connectionName,
                            `COMMENT ON COLUMN ${fullTableName}.${message.column} IS '${(message.comment || '').replace(/'/g, "''")}'`,
                            'Column comment updated'
                        );
                        break;
                    case 'addColumn':
                        await this._execSimpleCommand(
                            context,
                            connectionManager,
                            item.connectionName,
                            `ALTER TABLE ${fullTableName} ADD COLUMN ${message.name} ${message.type}`,
                            `Column ${message.name} added`,
                            true // refresh after
                        );
                        this._loadData(
                            panel,
                            database,
                            schema,
                            tableName,
                            item.connectionName,
                            context,
                            connectionManager
                        );
                        break;
                    case 'dropColumn':
                        await this._execSimpleCommand(
                            context,
                            connectionManager,
                            item.connectionName,
                            `ALTER TABLE ${fullTableName} DROP COLUMN ${message.column}`,
                            `Column ${message.column} dropped`,
                            true
                        );
                        this._loadData(
                            panel,
                            database,
                            schema,
                            tableName,
                            item.connectionName,
                            context,
                            connectionManager
                        );
                        break;

                    case 'error':
                        vscode.window.showErrorMessage(message.text);
                        break;
                    case 'info':
                        vscode.window.showInformationMessage(message.text);
                        break;
                }
            } catch (e: unknown) {
                vscode.window.showErrorMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
            }
        });
    }

    private static async _execSimpleCommand(
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager,
        connectionName: string,
        sql: string,
        successMsg: string,
        _refresh = false
    ) {
        try {
            await runQuery(context, sql, true, connectionName, connectionManager);
            vscode.window.showInformationMessage(successMsg);
        } catch (e: unknown) {
            vscode.window.showErrorMessage(`Operation failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private static async _loadData(
        panel: vscode.WebviewPanel,
        db: string,
        schema: string,
        table: string,
        connectionName: string,
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager,
        options: { whereClause?: string; columns?: string } = {}
    ) {
        const fullTableName = `${db}.${schema}.${table}`;
        try {
            this._postMessage(panel, { command: 'setLoading', loading: true, message: 'Fetching data...' });

            // Use centralized tableMetadataProvider for metadata queries
            const queryRunner = (query: string) => runQueryRaw(context, query, true, connectionManager, connectionName);

            // Prepare Query
            let selectList = 'ROWID, *';
            if (options.columns && options.columns.trim()) {
                const cols = options.columns.trim();
                // Ensure ROWID is included if not present
                if (!/\bROWID\b/i.test(cols)) {
                    selectList = 'ROWID, ' + cols;
                } else {
                    selectList = cols;
                }
            }

            let query = `SELECT ${selectList} FROM ${fullTableName}`;
            if (options.whereClause && options.whereClause.trim()) {
                const where = options.whereClause.trim();
                if (/^\s*WHERE\s/i.test(where)) {
                    query += ` ${where}`;
                } else {
                    query += ` WHERE ${where}`;
                }
            }
            query += ' ORDER BY ROWID LIMIT 50000';

            const [dataResult, metadata] = await Promise.all([
                runQueryRaw(
                    context,
                    query,
                    true,
                    connectionManager,
                    connectionName
                ),
                getTableMetadata(queryRunner, db, schema, table)
            ]);

            // Convert to webview format (uppercase keys for JS compatibility)
            const tableComment = metadata.tableComment || '';
            const columnsMeta = toWebviewFormat(metadata.columns);

            // Parse Data
            let data: Record<string, unknown>[] = [];
            try {
                if (dataResult && dataResult.data) {
                    data = queryResultToRows(dataResult);
                    console.log('[EditDataProvider] Parsed data rows:', data.length);
                } else {
                    console.log('[EditDataProvider] No data returned');
                }
            } catch (e: unknown) {
                console.error('[EditDataProvider] Data Parse Error', e);
            }

            // Columns extraction
            // Columns extraction
            let columns: string[] = [];

            // 1. If we have data, use the keys from data (most accurate for what was returned)
            if (data.length > 0) {
                columns = Object.keys(data[0]);
                // Ensure ROWID is first if present
                if (columns.includes('ROWID')) {
                    columns = ['ROWID', ...columns.filter(c => c !== 'ROWID')];
                }
            }
            // 2. If no data but we have user-selected columns, use those
            else if (options.columns && options.columns.trim()) {
                const cols = options.columns.trim().split(',').map(c => c.trim()).filter(c => c);
                // We assume user wanted these, ensuring ROWID is there
                const hasRowId = cols.some(c => c.toUpperCase() === 'ROWID');
                columns = hasRowId ? cols : ['ROWID', ...cols];
            }
            // 3. Fallback to all columns from metadata
            else if (columnsMeta.length > 0) {
                columns = ['ROWID', ...columnsMeta.map((c: { ATTNAME: string }) => c.ATTNAME)];
            }

            console.log('[EditDataProvider] Sending to webview:', { dataRows: data.length, columns: columns.length });

            this._postMessage(panel, {
                command: 'setData',
                data,
                columns,
                metadata: {
                    tableComment,
                    columns: columnsMeta
                }
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to load data: ${msg}`);
            this._postMessage(panel, { command: 'setError', text: msg });
        } finally {
            this._postMessage(panel, { command: 'setLoading', loading: false });
        }
    }

    private static async _handleSave(
        _panel: vscode.WebviewPanel,
        changes: EditDataChanges,
        tableName: string,
        _connectionName: string,
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager
    ) {
        // changes: { updates: [], deletes: [], inserts: [] }
        // updates: { rowId, updates: { col: val, ... } }
        // deletes: [rowId, ...]
        // inserts: [{ col: val, ... }, ...]

        const queries: string[] = [];

        // 1. Process Deletes
        if (changes.deletes && changes.deletes.length > 0) {
            const ids = changes.deletes.join(',');
            queries.push(`DELETE FROM ${tableName} WHERE ROWID IN (${ids})`);
        }

        // 2. Process Updates
        if (changes.updates && changes.updates.length > 0) {
            for (const update of changes.updates) {
                const setClauses: string[] = [];
                for (const [col, val] of Object.entries(update.changes)) {
                    if (col === 'ROWID') continue; // Skip ROWID
                    setClauses.push(`${col} = ${this._formatValue(val)}`);
                }
                if (setClauses.length > 0) {
                    queries.push(`UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE ROWID = ${update.rowId}`);
                }
            }
        }

        // 3. Process Inserts
        if (changes.inserts && changes.inserts.length > 0) {
            for (const insert of changes.inserts) {
                const cols = Object.keys(insert).filter(k => k !== 'ROWID'); // Exclude ROWID placeholder if any
                if (cols.length === 0) continue;

                const vals = cols.map(c => this._formatValue(insert[c]));
                queries.push(`INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${vals.join(', ')})`);
            }
        }

        if (queries.length === 0) {
            vscode.window.showInformationMessage('No changes to save.');
            return;
        }

        try {
            // Execute as batch/sequential
            // Wrapped in explicit BEGIN/COMMIT transaction block
            const batch = ['BEGIN', ...queries, 'COMMIT'];

            // To ensure they run in one transaction, we need simple query mode usually,
            // but runQueriesSequentially does item by item.
            // If any fails, we want rollback.
            // Netezza via ODBC usually auto-commits unless in transaction.

            await runQueriesSequentially(context, batch, connectionManager);

            vscode.window.showInformationMessage(`Successfully executed ${queries.length} changes.`);
        } catch (err: unknown) {
            vscode.window.showErrorMessage(`Failed to save changes: ${err instanceof Error ? err.message : String(err)}`);
            // Attempt rollback if mid-way? (Requires session persistence which runQueriesSequentially *might* not guarantee if it opens new conns?
            // Actually runQueriesSequentially in this ext opens one connection and reuses it?
            // Checking runQueriesSequentially implementation is out of scope but assuming it works for now.
        }
    }

    private static _postMessage(panel: vscode.WebviewPanel, message: EditDataPanelOutboundMessage) {
        void panel.webview.postMessage(message);
    }

    private static _formatValue(val: unknown): string {
        if (val === null || val === undefined || val === '') return 'NULL'; // Empty string as NULL? For editing usually yes
        if (typeof val === 'number') return val.toString();
        if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
        // String escaping
        return `'${String(val).replace(/'/g, "''")}'`;
    }

    private static _getHtmlForWebview(webview: vscode.Webview, extensionUri: vscode.Uri, title: string) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'tanstack-table-core.js'));
        const virtualUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'tanstack-virtual-core.js'));
        const mainScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'media', 'editDataPanel.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'editDataPanel.css'));
        // codiconsUri not used, font loaded via inline style
        const codiconsFontUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'codicon.ttf'));

        const nonce = getNonce();

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link href="${styleUri}" rel="stylesheet">
            <style>
                @font-face {
                    font-family: 'codicon';
                    src: url('${codiconsFontUri}') format('truetype');
                }
                .codicon { font-family: 'codicon'; }
            </style>
            <script nonce="${nonce}" src="${scriptUri}"></script>
            <script nonce="${nonce}" src="${virtualUri}"></script>
            <title>Edit Data: ${title}</title>
        </head>
        <body>
            <div class="main-layout">
                <!-- Tabs Header -->
                <div class="tabs-header">
                    <div class="tab active" data-target="tab-data">
                        Data
                    </div>
                    <div class="tab" data-target="tab-metadata">
                        Table Description
                    </div>
                </div>

                <!-- Tab: Data -->
                <div id="tab-data" class="tab-content active">
                    <div class="toolbar">
                        <div class="filter-container">
                            <input type="text" id="filterColumns" class="toolbar-input" placeholder="Columns (e.g. ID, NAME)" title="Columns to select">
                            <input type="text" id="filterWhere" class="toolbar-input" placeholder="WHERE clause (e.g. ID > 100)" title="WHERE filter condition">
                        </div>
                        <span id="status" class="status"></span>
                        <div class="actions">
                            <button id="refreshBtn" title="Apply Filter / Refresh">Refresh</button>
                            <button id="addRowBtn">Add Row</button>
                            <button id="saveBtn" class="primary">Save Changes</button>
                        </div>
                    </div>
                    <div id="gridContainer" class="grid-container"></div>
                </div>

                <!-- Tab: Metadata -->
                <div id="tab-metadata" class="tab-content">
                    <div id="metadataContent" class="metadata-content">
                        <!-- Populated by JS -->
                        Loading metadata...
                    </div>
                </div>
            </div>
            
            <script nonce="${nonce}" src="${mainScriptUri}"></script>
        </body>
        </html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
