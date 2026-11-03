import * as vscode from 'vscode';
import type {
    EditDataChanges,
    EditDataPanelInboundMessage,
    EditDataPanelOutboundMessage
} from '../contracts/webviews';
import { runQuery, runQueryRaw, runQueriesSequentially, queryResultToRows } from '../core/queryRunner';
import { ConnectionManager } from '../core/connectionManager';
import { getTableMetadata, toWebviewFormat } from '../providers/tableMetadataProvider';
import type { MetadataQueryKind } from '../metadata/metadataQueryDiagnostics';
import { runWithMetadataQueryConcurrencyLimit } from '../metadata/metadataQueryLimiter';
import { formatIdentifierForSql } from '../utils/identifierUtils';

/** Maximum number of rows fetched into the editor. */
export const EDIT_DATA_ROW_LIMIT = 50000;

/**
 * The webview supplies column names and type expressions for DDL. Validate them
 * before interpolating into SQL: identifiers must be plain, and a type
 * expression may only contain the characters a column type uses.
 */
function assertValidIdentifier(value: unknown, label: string): string {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Invalid ${label}: "${String(value)}". Use only letters, numbers, and underscores.`);
    }
    return name;
}

function assertSafeTypeExpression(value: unknown): string {
    const type = typeof value === 'string' ? value.trim() : '';
    if (!type || !/^[A-Za-z][A-Za-z0-9_ (),.]*$/.test(type)) {
        throw new Error(`Invalid column type: "${String(value)}".`);
    }
    return type;
}

/** ROWID values come from the webview; only integers may reach the SQL text. */
function assertRowId(value: unknown): string {
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (!/^-?\d+$/.test(text)) {
        throw new Error(`Invalid ROWID: "${String(value)}".`);
    }
    return text;
}

function stripLeadingKeyword(clause: string | undefined, keyword: RegExp): string {
    return (clause || '').trim().replace(keyword, '').trim();
}

export interface EditDataItem {
    label: string;
    dbName: string;
    schema: string;
    connectionName: string;
    [key: string]: unknown;
}

interface EditDataQueryOptions {
    whereClause?: string;
    columns?: string;
    orderBy?: string;
}

/**
 * Per-panel lifecycle state. A panel is a single-shot owner of one table view,
 * so the state is keyed by the panel and dropped with it.
 */
interface EditDataPanelState {
    loadGeneration: number;
    disposed: boolean;
    saveInFlight: boolean;
    /** Column names returned by the last load; DML may only reference these. */
    knownColumns: Set<string>;
}

const panelStates = new WeakMap<vscode.WebviewPanel, EditDataPanelState>();

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

        panel.webview.html = this._getHtmlForWebview(panel.webview, extensionUri, {
            database,
            schema,
            table: tableName,
            connectionName: item.connectionName,
        });

        const state: EditDataPanelState = {
            loadGeneration: 0,
            disposed: false,
            saveInFlight: false,
            knownColumns: new Set(),
        };
        panelStates.set(panel, state);
        panel.onDidDispose(() => {
            state.disposed = true;
            // Invalidate any in-flight request so late results are discarded.
            state.loadGeneration += 1;
        });

        const reload = (options: EditDataQueryOptions = {}) => {
            void this._loadData(panel, database, schema, tableName, item.connectionName, context, connectionManager, options);
        };

        reload();

        // Message Handling
        panel.webview.onDidReceiveMessage(async (message: EditDataPanelInboundMessage) => {
            try {
                switch (message.command) {
                    case 'save': {
                        const saved = await this._handleSave(
                            panel,
                            message.changes,
                            fullTableName,
                            item.connectionName,
                            context,
                            connectionManager
                        );
                        // Reload only after a successful save; on failure the
                        // webview keeps the pending edits so they can be fixed.
                        if (saved) {
                            reload({ whereClause: message.whereClause, columns: message.columns, orderBy: message.orderBy });
                        }
                        break;
                    }
                    case 'refresh':
                        reload({ whereClause: message.whereClause, columns: message.columns, orderBy: message.orderBy });
                        break;
                    case 'previewSql': {
                        try {
                            const statements = this._buildSaveQueries(message.changes, fullTableName, state.knownColumns);
                            this._postMessage(panel, { command: 'sqlPreview', statements });
                        } catch (e: unknown) {
                            this._postMessage(panel, {
                                command: 'sqlPreview',
                                statements: [],
                                error: e instanceof Error ? e.message : String(e),
                            });
                        }
                        break;
                    }
                    case 'requestDdl':
                        await this._loadDdl(panel, connectionManager, item.connectionName, database, schema, tableName);
                        break;
                    case 'openSqlInEditor': {
                        const doc = await vscode.workspace.openTextDocument({ content: message.sql, language: 'sql' });
                        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                        break;
                    }
                    case 'copyText':
                        await vscode.env.clipboard.writeText(message.text);
                        vscode.window.setStatusBarMessage('$(check) Copied to clipboard', 2000);
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
                    case 'updateColumnComment': {
                        const commentColumn = assertValidIdentifier(message.column, 'column name');
                        await this._execSimpleCommand(
                            context,
                            connectionManager,
                            item.connectionName,
                            `COMMENT ON COLUMN ${fullTableName}.${formatIdentifierForSql(commentColumn)} IS '${(message.comment || '').replace(/'/g, "''")}'`,
                            'Column comment updated'
                        );
                        break;
                    }
                    case 'addColumn': {
                        const newColumn = assertValidIdentifier(message.name, 'column name');
                        const newType = assertSafeTypeExpression(message.type);
                        await this._execSimpleCommand(
                            context,
                            connectionManager,
                            item.connectionName,
                            `ALTER TABLE ${fullTableName} ADD COLUMN ${formatIdentifierForSql(newColumn)} ${newType}`,
                            `Column ${newColumn} added`
                        );
                        reload();
                        break;
                    }
                    case 'dropColumn': {
                        // The webview asks for confirmation in its own dialog
                        // because window.confirm() is blocked in the sandbox.
                        const dropColumn = assertValidIdentifier(message.column, 'column name');
                        await this._execSimpleCommand(
                            context,
                            connectionManager,
                            item.connectionName,
                            `ALTER TABLE ${fullTableName} DROP COLUMN ${formatIdentifierForSql(dropColumn)}`,
                            `Column ${dropColumn} dropped`
                        );
                        reload();
                        break;
                    }

                    case 'closePanel':
                        panel.dispose();
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
        successMsg: string
    ) {
        try {
            await runQuery(context, sql, true, connectionName, connectionManager);
            vscode.window.showInformationMessage(successMsg);
        } catch (e: unknown) {
            vscode.window.showErrorMessage(`Operation failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private static async _loadDdl(
        panel: vscode.WebviewPanel,
        connectionManager: ConnectionManager,
        connectionName: string,
        database: string,
        schema: string,
        table: string,
    ): Promise<void> {
        try {
            const connectionDetails = await connectionManager.getConnection(connectionName);
            if (!connectionDetails) {
                this._postMessage(panel, { command: 'setDdl', error: `Connection "${connectionName}" is not available.` });
                return;
            }
            // Loaded lazily: DDL generation pulls in the dialect DDL providers.
            const { generateDDL } = await import('../ddlGenerator');
            const result = await generateDDL(connectionDetails, database, schema, table, 'TABLE');
            if (result.success && result.ddlCode) {
                this._postMessage(panel, { command: 'setDdl', ddl: result.ddlCode });
            } else {
                this._postMessage(panel, { command: 'setDdl', error: result.error || 'DDL is not available for this table.' });
            }
        } catch (e: unknown) {
            this._postMessage(panel, { command: 'setDdl', error: e instanceof Error ? e.message : String(e) });
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
        options: EditDataQueryOptions = {}
    ) {
        const fullTableName = `${db}.${schema}.${table}`;
        const state = panelStates.get(panel);
        const generation = state ? ++state.loadGeneration : 0;
        const isStale = (): boolean => Boolean(state && (state.disposed || state.loadGeneration !== generation));
        if (state?.disposed) return;
        const startedAt = Date.now();
        try {
            this._postMessage(panel, { command: 'setLoading', loading: true, message: 'Fetching data...' });

            // Use centralized tableMetadataProvider for metadata queries
            const queryRunner = (query: string, queryKind: MetadataQueryKind = 'table-columns') =>
                runWithMetadataQueryConcurrencyLimit(connectionName, (queueWaitMs) =>
                    runQueryRaw({
                        context,
                        query,
                        silent: true,
                        connectionManager,
                        connectionName,
                        isUserQuery: false,
                        metadataContext: {
                            source: 'schema-tree',
                            kind: queryKind,
                            connectionName,
                            database: db,
                            schema,
                            table,
                            reason: 'edit-data-metadata',
                            queueWaitMs,
                        },
                        metadataQueueWaitMs: queueWaitMs,
                    }),
                );

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
            const where = stripLeadingKeyword(options.whereClause, /^WHERE\s+/i);
            if (where) {
                query += ` WHERE ${where}`;
            }
            const orderBy = stripLeadingKeyword(options.orderBy, /^ORDER\s+BY\s+/i);
            query += ` ORDER BY ${orderBy || 'ROWID'} LIMIT ${EDIT_DATA_ROW_LIMIT}`;

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

            let data: Record<string, unknown>[] = [];
            if (dataResult && dataResult.data) {
                data = queryResultToRows(dataResult);
            }

            let columns: string[] = [];
            const resultColumns = (dataResult?.columns || [])
                .map((column: { name?: string }) => column?.name)
                .filter((name: unknown): name is string => typeof name === 'string' && name.length > 0);

            if (resultColumns.length > 0) {
                // The result set describes the projection even when it has no rows.
                columns = resultColumns;
            } else if (data.length > 0) {
                columns = Object.keys(data[0]);
            } else if (options.columns && options.columns.trim()) {
                const cols = options.columns.trim().split(',').map(c => c.trim()).filter(c => c);
                const hasRowId = cols.some(c => c.toUpperCase() === 'ROWID');
                columns = hasRowId ? cols : ['ROWID', ...cols];
            } else if (columnsMeta.length > 0) {
                columns = ['ROWID', ...columnsMeta.map((c: { ATTNAME: string }) => c.ATTNAME)];
            }
            if (columns.includes('ROWID')) {
                columns = ['ROWID', ...columns.filter(c => c !== 'ROWID')];
            }

            if (isStale()) return;
            if (state) state.knownColumns = new Set(columns);
            this._postMessage(panel, {
                command: 'setData',
                data,
                columns,
                metadata: {
                    tableComment,
                    columns: columnsMeta
                },
                info: {
                    rowLimit: EDIT_DATA_ROW_LIMIT,
                    elapsedMs: Date.now() - startedAt,
                    tableName: fullTableName,
                    connectionName,
                },
            });
        } catch (err: unknown) {
            if (isStale()) return;
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to load data: ${msg}`);
            this._postMessage(panel, { command: 'setError', text: msg });
        } finally {
            if (!isStale()) {
                this._postMessage(panel, { command: 'setLoading', loading: false });
            }
        }
    }

    /** Returns true when the batch committed (or there was nothing to save). */
    private static async _handleSave(
        panel: vscode.WebviewPanel,
        changes: EditDataChanges,
        tableName: string,
        connectionName: string,
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager
    ): Promise<boolean> {
        const state = panelStates.get(panel);
        if (state?.saveInFlight) {
            vscode.window.showInformationMessage('A save is already in progress.');
            return false;
        }
        if (state) state.saveInFlight = true;
        try {
            return await this._executeSave(panel, changes, tableName, connectionName, context, connectionManager);
        } finally {
            if (state) state.saveInFlight = false;
        }
    }

    /**
     * Builds the DML for a change set. Column names are restricted to the last
     * loaded projection and ROWIDs to integers, because both are supplied by the
     * webview and interpolated into SQL.
     */
    private static _buildSaveQueries(
        changes: EditDataChanges,
        tableName: string,
        knownColumns: ReadonlySet<string>,
    ): string[] {
        const queries: string[] = [];
        const columnSql = (column: string): string => {
            if (knownColumns.size > 0 && !knownColumns.has(column)) {
                throw new Error(`Unknown column: "${column}".`);
            }
            return formatIdentifierForSql(column, 'netezza');
        };

        if (changes.deletes && changes.deletes.length > 0) {
            const ids = changes.deletes.map(assertRowId).join(', ');
            queries.push(`DELETE FROM ${tableName} WHERE ROWID IN (${ids})`);
        }

        if (changes.updates && changes.updates.length > 0) {
            for (const update of changes.updates) {
                const setClauses: string[] = [];
                for (const [col, val] of Object.entries(update.changes || {})) {
                    if (col === 'ROWID') continue;
                    setClauses.push(`${columnSql(col)} = ${this._formatValue(val)}`);
                }
                if (setClauses.length > 0) {
                    queries.push(`UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE ROWID = ${assertRowId(update.rowId)}`);
                }
            }
        }

        if (changes.inserts && changes.inserts.length > 0) {
            for (const insert of changes.inserts) {
                const cols = Object.keys(insert).filter(k => k !== 'ROWID' && k !== '__tempId');
                if (cols.length === 0) continue;

                const vals = cols.map(c => this._formatValue(insert[c]));
                queries.push(`INSERT INTO ${tableName} (${cols.map(columnSql).join(', ')}) VALUES (${vals.join(', ')})`);
            }
        }

        return queries;
    }

    private static async _executeSave(
        panel: vscode.WebviewPanel,
        changes: EditDataChanges,
        tableName: string,
        connectionName: string,
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager
    ): Promise<boolean> {
        let queries: string[];
        try {
            queries = this._buildSaveQueries(changes, tableName, panelStates.get(panel)?.knownColumns ?? new Set());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to save changes: ${message}`);
            this._postMessage(panel, { command: 'saveFailed', text: message });
            return false;
        }

        if (queries.length === 0) {
            vscode.window.showInformationMessage('No changes to save.');
            return true;
        }

        try {
            // Execute as batch/sequential and wrap in an explicit transaction so a
            // mid-batch failure does not leave partial writes behind. The batch
            // runs on the panel's connection, not the editor's active one.
            const batch = ['BEGIN', ...queries, 'COMMIT'];
            await runQueriesSequentially(
                context,
                batch,
                connectionManager,
                undefined,
                undefined,
                undefined,
                undefined,
                false,
                undefined,
                undefined,
                undefined,
                undefined,
                0,
                undefined,
                [],
                { connectionName },
            );

            vscode.window.showInformationMessage(`Successfully executed ${queries.length} changes.`);
            return true;
        } catch (err: unknown) {
            // Best-effort rollback: if the failed batch left an open transaction
            // on the pooled session, release it instead of holding locks.
            try {
                await runQueryRaw(context, 'ROLLBACK', true, connectionManager, connectionName);
            } catch {
                // The pooled session may already have rolled back or disconnected.
            }
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to save changes: ${message}`);
            this._postMessage(panel, { command: 'saveFailed', text: message });
            return false;
        }
    }

    private static _postMessage(panel: vscode.WebviewPanel, message: EditDataPanelOutboundMessage) {
        const state = panelStates.get(panel);
        if (state?.disposed) return;
        void panel.webview.postMessage(message).then(undefined, () => {
            // The panel can be disposed between the guard and the post; the
            // rejection is expected and must not surface as unhandled.
        });
    }

    private static _formatValue(val: unknown): string {
        if (val === null || val === undefined || val === '') return 'NULL';
        if (typeof val === 'number') return val.toString();
        if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
        return `'${String(val).replace(/'/g, "''")}'`;
    }

    private static _getGridFont(): { family: string; size: number } {
        const fallback = "'JetBrains Mono', monospace";
        const getConfiguration = typeof vscode.workspace.getConfiguration === 'function'
            ? vscode.workspace.getConfiguration.bind(vscode.workspace)
            : undefined;
        const results = getConfiguration?.('justybase.results');
        let family = String(results?.get<string>('gridFontFamily', fallback) || fallback).trim() || fallback;
        if (family.toLowerCase() === 'editor') {
            family = getConfiguration?.('editor')?.get<string>('fontFamily', fallback) || fallback;
        }
        const size = Number(results?.get<number>('gridFontSize', 12));
        return { family, size: Number.isFinite(size) && size >= 8 && size <= 32 ? size : 12 };
    }

    private static _getHtmlForWebview(
        webview: vscode.Webview,
        extensionUri: vscode.Uri,
        target: { database: string; schema: string; table: string; connectionName: string },
    ) {
        const asset = (...segments: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segments));
        const mainScriptUri = asset('dist', 'media', 'editDataPanel.js');
        const styleUri = asset('media', 'editDataPanel.css');
        const fontRegular = asset('media', 'fonts', 'JetBrainsMono-Regular.woff2');
        const fontMedium = asset('media', 'fonts', 'JetBrainsMono-Medium.woff2');
        const fontBold = asset('media', 'fonts', 'JetBrainsMono-Bold.woff2');
        const gridFont = this._getGridFont();

        const nonce = getNonce();
        const esc = escapeHtml;
        const fullName = `${target.database}.${target.schema}.${target.table}`;

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                @font-face { font-family: 'JetBrains Mono'; src: url('${fontRegular}') format('woff2'); font-weight: 400; }
                @font-face { font-family: 'JetBrains Mono'; src: url('${fontMedium}') format('woff2'); font-weight: 500; }
                @font-face { font-family: 'JetBrains Mono'; src: url('${fontBold}') format('woff2'); font-weight: 700; }
                :root { --grid-font: ${gridFont.family}; --grid-font-size: ${gridFont.size}px; }
            </style>
            <link href="${styleUri}" rel="stylesheet">
            <title>Edit Data: ${esc(fullName)}</title>
        </head>
        <body>
            ${renderEditDataShell(target)}
            <script nonce="${nonce}" src="${mainScriptUri}"></script>
        </body>
        </html>`;
    }
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Static panel skeleton. Kept separate from the CSP/asset wrapper so the
 * browser harness can render exactly the same markup.
 */
export function renderEditDataShell(target: { database: string; schema: string; table: string; connectionName: string }): string {
    const esc = escapeHtml;
    return `<div class="main-layout">
                <header class="panel-header">
                    <div class="object-path" title="${esc(`${target.connectionName} · ${target.database}.${target.schema}.${target.table}`)}">
                        <span class="object-icon" aria-hidden="true">${ICONS.table}</span>
                        <span class="object-path__muted">${esc(target.database)}.${esc(target.schema)}.</span><span class="object-path__name">${esc(target.table)}</span>
                        <span class="object-path__conn">${esc(target.connectionName)}</span>
                    </div>
                    <nav class="tabs-header" role="tablist">
                        <button class="tab active" role="tab" data-target="tab-data">Data</button>
                        <button class="tab" role="tab" data-target="tab-metadata">Structure</button>
                        <button class="tab" role="tab" data-target="tab-ddl">DDL</button>
                    </nav>
                </header>

                <section id="tab-data" class="tab-content active" role="tabpanel">
                    <div class="toolbar">
                        <div class="toolbar-group">
                            <button id="refreshBtn" class="icon-only" title="Refresh (F5)">${ICONS.refresh}</button>
                        </div>
                        <div class="toolbar-group">
                            <button id="addRowBtn" class="icon-only" title="Add row (Alt+Insert)">${ICONS.add}</button>
                            <button id="duplicateRowBtn" class="icon-only" title="Duplicate row (Ctrl+D)">${ICONS.duplicate}</button>
                            <button id="deleteRowBtn" class="icon-only" title="Delete selected rows (Delete)">${ICONS.remove}</button>
                        </div>
                        <div class="toolbar-group">
                            <button id="revertBtn" title="Revert all pending changes">${ICONS.revert}<span>Revert</span></button>
                            <button id="previewSqlBtn" title="Preview the SQL that Submit will run">${ICONS.eye}<span>Preview</span></button>
                            <button id="saveBtn" class="primary" title="Submit changes in one transaction (Ctrl+S)">${ICONS.check}<span>Submit</span><span id="pendingCount" class="pending-count" hidden></span></button>
                        </div>
                        <span class="toolbar-spacer"></span>
                        <span id="status" class="status" aria-live="polite"></span>
                        <button id="closeBtn" class="icon-only ghost" title="Close the editor">${ICONS.close}</button>
                    </div>
                    <div class="filter-bar">
                        <label class="filter-field filter-field--where">
                            <span class="filter-field__label">WHERE</span>
                            <input type="text" id="filterWhere" spellcheck="false" placeholder="e.g. ID > 100 AND STATUS = 'A'" title="Server-side filter, applied with Enter">
                        </label>
                        <label class="filter-field filter-field--order">
                            <span class="filter-field__label">ORDER BY</span>
                            <input type="text" id="filterOrderBy" spellcheck="false" placeholder="ROWID" title="Server-side sort, applied with Enter">
                        </label>
                        <label class="filter-field filter-field--columns">
                            <span class="filter-field__label">COLUMNS</span>
                            <input type="text" id="filterColumns" spellcheck="false" placeholder="*" title="Columns to select (ROWID is always included)">
                        </label>
                        <button id="clearFilterBtn" class="icon-only ghost" title="Clear filter and reload" hidden>${ICONS.clear}</button>
                    </div>
                    <div id="errorBanner" class="error-banner" role="alert" hidden></div>
                    <div id="gridContainer" class="grid-container" tabindex="0" aria-label="Table data"></div>
                    <footer class="status-bar">
                        <span id="statusLeft"></span>
                        <span id="statusRight" class="status-bar__right"></span>
                    </footer>
                </section>

                <section id="tab-metadata" class="tab-content" role="tabpanel">
                    <div id="metadataContent" class="metadata-content">Loading metadata...</div>
                </section>

                <section id="tab-ddl" class="tab-content" role="tabpanel">
                    <div class="toolbar">
                        <div class="toolbar-group">
                            <button id="ddlRefreshBtn" class="icon-only" title="Regenerate DDL">${ICONS.refresh}</button>
                        </div>
                        <div class="toolbar-group">
                            <button id="ddlCopyBtn" title="Copy DDL">${ICONS.copy}<span>Copy</span></button>
                            <button id="ddlOpenBtn" title="Open DDL in a SQL editor">${ICONS.open}<span>Open in editor</span></button>
                        </div>
                    </div>
                    <div id="ddlContent" class="ddl-content"></div>
                </section>
            </div>
            <div id="dialogHost"></div>
            <div id="contextMenu" class="context-menu" role="menu" hidden></div>`;
}

/** 16px stroke icons (codicon-like) rendered inline so they follow currentColor. */
const ICONS = {
    table: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 6.5h13M1.5 10h13M6 6.5v7"/></svg>',
    refresh: '<svg viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>',
    add: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
    duplicate: '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1"/></svg>',
    remove: '<svg viewBox="0 0 16 16"><path d="M3 8h10"/></svg>',
    revert: '<svg viewBox="0 0 16 16"><path d="M3.5 6.5h6a3.5 3.5 0 0 1 0 7h-3"/><path d="M6 4L3.5 6.5 6 9"/></svg>',
    eye: '<svg viewBox="0 0 16 16"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>',
    check: '<svg viewBox="0 0 16 16"><path d="M3 8.5l3.2 3L13 4.5"/></svg>',
    close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    clear: '<svg viewBox="0 0 16 16"><path d="M5 5l6 6M11 5l-6 6"/></svg>',
    copy: '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1"/></svg>',
    open: '<svg viewBox="0 0 16 16"><path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5"/><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/></svg>',
};

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
