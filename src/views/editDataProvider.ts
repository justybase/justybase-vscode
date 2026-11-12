import * as vscode from 'vscode';
import type {
    EditDataChanges,
    EditDataColumnMetadata,
    EditDataMetadata,
    EditDataObjectKind,
    EditDataPanelInboundMessage,
    EditDataPanelOutboundMessage,
    EditDataProperty,
} from '../contracts/webviews';
import { runQuery, runQueryRaw, runQueriesSequentially, queryResultToRows } from '../core/queryRunner';
import { ConnectionManager } from '../core/connectionManager';
import { getTableMetadata, toWebviewFormat, type TableMetadata } from '../providers/tableMetadataProvider';
import type { MetadataQueryKind } from '../metadata/metadataQueryDiagnostics';
import { runWithMetadataQueryConcurrencyLimit } from '../metadata/metadataQueryLimiter';
import type { ConnectionManagerMetadataCache } from '../core/connectionManagerPorts';
import type { ColumnMetadata } from '../metadata/types';
import { getCachedColumnsFromMetadataCache, getCachedColumnsFromMetadataCacheAsync } from '../metadata/columnCacheLookup';
import type { DatabaseKind } from '../contracts/database';
import { formatIdentifierForSql } from '../utils/identifierUtils';
import { splitCommaSeparatedTopLevel } from '../core/parenAwareText';

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
    objType?: string;
    rawLabel?: string;
    owner?: string;
    [key: string]: unknown;
}

/** Tab that receives focus when the panel opens. */
export type EditDataInitialTab = 'data' | 'structure' | 'ddl';

export interface EditDataPanelOptions {
    initialTab?: EditDataInitialTab;
    /** Overrides the object-derived default (tables are editable, views/procedures are not). */
    readOnly?: boolean;
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
    metadataGeneration: number;
    disposed: boolean;
    saveInFlight: boolean;
    /** Row data has been delivered at least once; later Data activations reuse it. */
    dataLoaded: boolean;
    /** A row-data load is in flight; duplicate `requestData` messages are ignored. */
    dataInFlight: boolean;
    /** Column names returned by the last load; DML may only reference these. */
    knownColumns: Set<string>;
    /** Last live catalog read, reused for the projection fallback. */
    lastTableMetadata?: TableMetadata;
    /** Last Structure payload; bundled into setData so the grid keeps column types. */
    lastMetadataPayload?: EditDataMetadata;
    objectType: string;
    objectKind: EditDataObjectKind;
    readOnly: boolean;
    /** Catalog name used for DDL (the procedure signature for routines). */
    ddlObjectName: string;
    properties: EditDataProperty[];
}

const panelStates = new WeakMap<vscode.WebviewPanel, EditDataPanelState>();

/** Messages that change catalog or data state; rejected in read-only panels. */
const READ_ONLY_BLOCKED_COMMANDS: ReadonlySet<EditDataPanelInboundMessage['command']> = new Set([
    'save',
    'previewSql',
    'updateTableComment',
    'updateColumnComment',
    'addColumn',
    'dropColumn',
]);

function normalizeObjectType(item: EditDataItem): string {
    const contextValue = typeof item.contextValue === 'string' ? item.contextValue : '';
    const raw = item.objType
        || contextValue.replace(/^(?:netezza|favoritesObject):/, '')
        || 'TABLE';
    return raw.split(':')[0].toUpperCase();
}

function objectKindFor(objectType: string): EditDataObjectKind {
    if (objectType === 'PROCEDURE' || objectType === 'FUNCTION' || objectType === 'AGGREGATE') {
        return 'procedure';
    }
    return objectType.includes('VIEW') ? 'view' : 'table';
}

/** Splits a catalog signature such as `MY_PROC(INT, VARCHAR)` into positional argument types. */
function parseProcedureArguments(signature: string): { position: number; type: string }[] {
    const open = signature.indexOf('(');
    const close = signature.lastIndexOf(')');
    if (open < 0 || close <= open) {
        return [];
    }
    return splitCommaSeparatedTopLevel(signature.slice(open + 1, close).trim())
        .map((argument, index) => ({ position: index + 1, type: argument.trim() }))
        .filter(argument => argument.type.length > 0);
}

function buildProcedureProperties(item: EditDataItem, objectType: string, signature: string): EditDataProperty[] {
    const properties: EditDataProperty[] = [
        { label: 'Kind', value: objectType },
        { label: 'Database', value: item.dbName },
        { label: 'Schema', value: item.schema },
        { label: 'Signature', value: signature },
    ];
    if (item.owner) {
        properties.push({ label: 'Owner', value: item.owner });
    }
    return properties;
}

function normalizeLookupName(value: unknown): string {
    return String(value ?? '').trim().toUpperCase();
}

/**
 * Cached table rows carry the catalog `DESCRIPTION`. The row is matched by
 * schema + name when the entry records its schema, and by name alone otherwise.
 */
function findCachedTableComment(
    cache: ConnectionManagerMetadataCache,
    connectionName: string,
    database: string,
    schema: string,
    table: string,
): string {
    const rows = cache.getTablesAllSchemas(connectionName, database);
    if (!rows || rows.length === 0) {
        return '';
    }
    const wantedTable = normalizeLookupName(table);
    const wantedSchema = normalizeLookupName(schema);
    const match = rows.find(entry => {
        const name = entry.OBJNAME ?? entry.TABLENAME
            ?? (typeof entry.label === 'string' ? entry.label : entry.label?.label);
        if (normalizeLookupName(name) !== wantedTable) {
            return false;
        }
        return !entry.SCHEMA || normalizeLookupName(entry.SCHEMA) === wantedSchema;
    });
    return typeof match?.DESCRIPTION === 'string' ? match.DESCRIPTION : '';
}

/**
 * Cache-first Structure payload. Column cache entries written by the schema
 * tree include keys, defaults and comments, so the tab can render before the
 * catalog round trip completes.
 */
async function readCachedTableMetadata(
    cache: ConnectionManagerMetadataCache,
    connectionName: string,
    database: string,
    schema: string,
    table: string,
    databaseKind: DatabaseKind | undefined,
): Promise<{ tableComment: string; columns: ColumnMetadata[] } | undefined> {
    // A warm in-memory entry must not wait for disk hydration; only a miss needs it.
    const columns = getCachedColumnsFromMetadataCache(
        cache,
        connectionName,
        database,
        schema,
        table,
        databaseKind,
    ) ?? await getCachedColumnsFromMetadataCacheAsync(
        cache,
        connectionName,
        database,
        schema,
        table,
        databaseKind,
    );
    if (!columns || columns.length === 0) {
        return undefined;
    }
    return {
        tableComment: findCachedTableComment(cache, connectionName, database, schema, table),
        columns,
    };
}

/** Maps cache column metadata onto the uppercase keys the Structure tab renders. */
export function cachedColumnsToWebviewFormat(
    columns: readonly ColumnMetadata[],
): EditDataColumnMetadata[] {
    return columns.map(column => ({
        ATTNAME: column.ATTNAME,
        FORMAT_TYPE: column.FORMAT_TYPE,
        IS_NOT_NULL: column.isNotNull === true ? 1 : 0,
        COLDEFAULT: column.colDefault ?? null,
        DESCRIPTION: column.documentation ?? '',
        IS_PK: column.isPk === true ? 1 : 0,
        IS_FK: column.isFk === true ? 1 : 0,
        IS_DISTRIBUTION_KEY: column.isDistributionKey === true ? 1 : 0,
    }));
}

export class EditDataProvider {
    public static readonly viewType = 'netezza.editData';

    public static async createOrShow(
        extensionUri: vscode.Uri,
        item: EditDataItem,
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager,
        options: EditDataPanelOptions = {}
    ) {
        if (!item || !item.label || !item.dbName || !item.schema) {
            vscode.window.showErrorMessage('Invalid table selection');
            return;
        }

        const tableName = item.label;
        const schema = item.schema;
        const database = item.dbName;
        const fullTableName = `${database}.${schema}.${tableName}`;
        const objectType = normalizeObjectType(item);
        const objectKind = objectKindFor(objectType);
        // External tables are inspected, never mutated from this panel.
        const readOnly = options.readOnly ?? (objectKind !== 'table' || objectType === 'EXTERNAL TABLE');
        const ddlObjectName = String(item.rawLabel || item.label);
        const detailView = options.initialTab === 'structure' || readOnly;

        // Create Webview Panel
        const panel = vscode.window.createWebviewPanel(
            EditDataProvider.viewType,
            `${detailView ? 'Details' : 'Edit'}: ${tableName}`,
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
            objectType,
            objectKind,
            readOnly,
            initialTab: options.initialTab ?? 'data',
        });

        const state: EditDataPanelState = {
            loadGeneration: 0,
            metadataGeneration: 0,
            disposed: false,
            saveInFlight: false,
            dataLoaded: false,
            dataInFlight: false,
            knownColumns: new Set(),
            objectType,
            objectKind,
            readOnly,
            ddlObjectName,
            properties: objectKind === 'procedure'
                ? buildProcedureProperties(item, objectType, ddlObjectName)
                : [],
        };
        panelStates.set(panel, state);
        panel.onDidDispose(() => {
            state.disposed = true;
            // Invalidate any in-flight request so late results are discarded.
            state.loadGeneration += 1;
            state.metadataGeneration += 1;
        });

        const loadMetadata = () => {
            void this._loadMetadata(panel, database, schema, tableName, item.connectionName, context, connectionManager);
        };

        const reload = (options: EditDataQueryOptions = {}) => {
            loadMetadata();
            void this._loadData(panel, database, schema, tableName, item.connectionName, context, connectionManager, options);
        };

        // Message Handling
        panel.webview.onDidReceiveMessage(async (message: EditDataPanelInboundMessage) => {
            try {
                if (state.readOnly && READ_ONLY_BLOCKED_COMMANDS.has(message.command)) {
                    vscode.window.showWarningMessage(`${objectType} ${fullTableName} is read-only in this panel.`);
                    return;
                }
                switch (message.command) {
                    case 'ready':
                        // Object details opens on Structure: render cached metadata
                        // right away and defer the row query until the Data tab asks.
                        if ((options.initialTab ?? 'data') === 'data' || objectKind === 'procedure') {
                            reload();
                        } else {
                            loadMetadata();
                        }
                        break;
                    case 'requestData':
                        if (!state.dataLoaded && !state.dataInFlight) {
                            void this._loadData(
                                panel,
                                database,
                                schema,
                                tableName,
                                item.connectionName,
                                context,
                                connectionManager,
                            );
                        }
                        break;
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
                        await this._loadDdl(panel, connectionManager, item.connectionName, database, schema, state.ddlObjectName, state.objectType);
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
        objectName: string,
        objectType: string,
    ): Promise<void> {
        try {
            const connectionDetails = await connectionManager.getConnection(connectionName);
            if (!connectionDetails) {
                this._postMessage(panel, { command: 'setDdl', error: `Connection "${connectionName}" is not available.` });
                return;
            }
            // Loaded lazily: DDL generation pulls in the dialect DDL providers.
            const { generateDDL } = await import('../ddlGenerator');
            const result = await generateDDL(connectionDetails, database, schema, objectName, objectType);
            if (result.success && result.ddlCode) {
                this._postMessage(panel, { command: 'setDdl', ddl: result.ddlCode });
            } else {
                this._postMessage(panel, { command: 'setDdl', error: result.error || `DDL is not available for this ${objectType.toLowerCase()}.` });
            }
        } catch (e: unknown) {
            this._postMessage(panel, { command: 'setDdl', error: e instanceof Error ? e.message : String(e) });
        }
    }

    /**
     * Catalog queries for this panel share the per-connection metadata limit and
     * are tagged so the metadata diagnostics can attribute the queue wait.
     */
    private static _createMetadataQueryRunner(
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager,
        connectionName: string,
        db: string,
        schema: string,
        table: string,
    ): Parameters<typeof getTableMetadata>[0] {
        return (query: string, queryKind: MetadataQueryKind = 'table-columns') =>
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
    }

    /**
     * Structure payload: cached columns/comments first, then the live catalog.
     * The live read never blocks the Data tab; it only refreshes the Structure
     * tab once the server answers.
     */
    private static async _loadMetadata(
        panel: vscode.WebviewPanel,
        db: string,
        schema: string,
        table: string,
        connectionName: string,
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager,
    ): Promise<void> {
        const state = panelStates.get(panel);
        if (state?.disposed) return;
        // Procedures have no column catalog rows; their Structure payload ships with setData.
        if ((state?.objectKind ?? 'table') === 'procedure') return;

        const metadataGeneration = state ? ++state.metadataGeneration : 0;
        const isStale = (): boolean => Boolean(state && (state.disposed || state.metadataGeneration !== metadataGeneration));
        const databaseKind = connectionManager.getConnectionDatabaseKind?.(connectionName);
        const objectTypeOption = state?.objectType && state.objectType.toUpperCase() !== 'TABLE'
            ? state.objectType
            : undefined;
        let renderedFromCache = false;

        // Cache read failures (disk hydration, cache ports) must never block the
        // live catalog read; treat them as a cache miss.
        let cached: { tableComment: string; columns: ColumnMetadata[] } | undefined;
        try {
            const cache = connectionManager.getMetadataCache?.();
            if (cache) {
                cached = await readCachedTableMetadata(cache, connectionName, db, schema, table, databaseKind);
            }
        } catch {
            cached = undefined;
        }
        if (isStale()) return;
        if (cached) {
            renderedFromCache = true;
            const payload: EditDataMetadata = {
                tableComment: cached.tableComment,
                columns: cachedColumnsToWebviewFormat(cached.columns),
                objectKind: state?.objectKind ?? 'table',
            };
            if (state) state.lastMetadataPayload = payload;
            this._postMessage(panel, {
                command: 'setMetadata',
                metadata: payload,
                readOnly: state?.readOnly ?? false,
                source: 'cache',
            });
        }

        try {
            const metadata = await getTableMetadata(
                this._createMetadataQueryRunner(context, connectionManager, connectionName, db, schema, table),
                db,
                schema,
                table,
                databaseKind,
                { objectType: objectTypeOption },
            );
            if (isStale()) return;
            if (state) state.lastTableMetadata = metadata;
            const payload: EditDataMetadata = {
                tableComment: metadata.tableComment || '',
                columns: toWebviewFormat(metadata.columns),
                objectKind: state?.objectKind ?? 'table',
            };
            if (state) state.lastMetadataPayload = payload;
            this._postMessage(panel, {
                command: 'setMetadata',
                metadata: payload,
                readOnly: state?.readOnly ?? false,
                source: 'live',
            });
        } catch (err: unknown) {
            if (isStale()) return;
            // A cached render is still useful; only surface the failure when the
            // Structure tab has nothing to show.
            if (renderedFromCache) return;
            const message = err instanceof Error ? err.message : String(err);
            this._postMessage(panel, {
                command: 'setMetadata',
                metadata: null,
                readOnly: state?.readOnly ?? false,
                error: message,
            });
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
        const objectKind = state?.objectKind ?? 'table';
        const readOnly = state?.readOnly ?? false;
        const generation = state ? ++state.loadGeneration : 0;
        const isStale = (): boolean => Boolean(state && (state.disposed || state.loadGeneration !== generation));
        if (state?.disposed) return;
        if (state) state.dataInFlight = true;
        const startedAt = Date.now();
        try {
            this._postMessage(panel, { command: 'setLoading', loading: true, message: 'Fetching data...' });

            if (objectKind === 'procedure') {
                const signature = state?.ddlObjectName ?? table;
                if (isStale()) return;
                if (state) state.dataLoaded = true;
                this._postMessage(panel, {
                    command: 'setData',
                    data: [],
                    columns: [],
                    metadata: {
                        tableComment: '',
                        columns: [],
                        objectKind: 'procedure',
                        properties: state?.properties ?? [],
                        arguments: parseProcedureArguments(signature),
                    },
                    info: {
                        rowLimit: 0,
                        elapsedMs: Date.now() - startedAt,
                        tableName: fullTableName,
                        connectionName,
                    },
                    readOnly: true,
                });
                return;
            }

            const editable = objectKind === 'table' && !readOnly;

            // Prepare Query. ROWID only exists on regular tables; views are read through a plain projection.
            let selectList = editable ? 'ROWID, *' : '*';
            if (options.columns && options.columns.trim()) {
                const cols = options.columns.trim();
                selectList = editable && !/\bROWID\b/i.test(cols) ? 'ROWID, ' + cols : cols;
            }

            const where = stripLeadingKeyword(options.whereClause, /^WHERE\s+/i);
            const orderBy = stripLeadingKeyword(options.orderBy, /^ORDER\s+BY\s+/i);
            let query = `SELECT ${selectList} FROM ${fullTableName}`;
            if (where) {
                query += ` WHERE ${where}`;
            }
            if (editable) {
                query += ` ORDER BY ${orderBy || 'ROWID'} LIMIT ${EDIT_DATA_ROW_LIMIT}`;
            } else {
                if (orderBy) {
                    query += ` ORDER BY ${orderBy}`;
                }
                query += ` LIMIT ${EDIT_DATA_ROW_LIMIT}`;
            }

            const dataResult = await runQueryRaw(
                context,
                query,
                true,
                connectionManager,
                connectionName
            );

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
                columns = editable && !hasRowId ? ['ROWID', ...cols] : cols;
            } else {
                // Last-resort projection when the server returns neither rows nor
                // column descriptors: reuse the Structure catalog read.
                let metaColumns = (state?.lastTableMetadata?.columns ?? []).map(c => c.attname);
                if (metaColumns.length === 0) {
                    const databaseKind = connectionManager.getConnectionDatabaseKind?.(connectionName);
                    const metadata = await getTableMetadata(
                        this._createMetadataQueryRunner(context, connectionManager, connectionName, db, schema, table),
                        db,
                        schema,
                        table,
                        databaseKind,
                        {
                            objectType: state?.objectType && state.objectType.toUpperCase() !== 'TABLE'
                                ? state.objectType
                                : undefined,
                        },
                    ).catch(() => undefined);
                    if (isStale()) return;
                    if (metadata) {
                        if (state) state.lastTableMetadata = metadata;
                        metaColumns = metadata.columns.map(c => c.attname);
                    }
                }
                columns = editable ? ['ROWID', ...metaColumns] : metaColumns;
            }
            if (editable && columns.includes('ROWID')) {
                columns = ['ROWID', ...columns.filter(c => c !== 'ROWID')];
            }

            if (isStale()) return;
            if (state) {
                state.knownColumns = new Set(columns);
                state.dataLoaded = true;
            }
            this._postMessage(panel, {
                command: 'setData',
                data,
                columns,
                // Structure is delivered by setMetadata; bundling the last payload
                // keeps grid column types while a null payload preserves the tab.
                metadata: state?.lastMetadataPayload ?? null,
                info: {
                    rowLimit: EDIT_DATA_ROW_LIMIT,
                    elapsedMs: Date.now() - startedAt,
                    tableName: fullTableName,
                    connectionName,
                },
                readOnly,
            });
        } catch (err: unknown) {
            if (isStale()) return;
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to load data: ${msg}`);
            this._postMessage(panel, { command: 'setError', text: msg });
        } finally {
            if (state && state.loadGeneration === generation) {
                state.dataInFlight = false;
            }
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
        target: {
            database: string;
            schema: string;
            table: string;
            connectionName: string;
            objectType?: string;
            objectKind?: EditDataObjectKind;
            readOnly?: boolean;
            initialTab?: EditDataInitialTab;
        },
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
            <title>${target.initialTab === 'structure' || target.readOnly ? 'Details' : 'Edit Data'}: ${esc(fullName)}</title>
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
 *
 * Defaults render the editable table view; `objectType`, `readOnly` and
 * `initialTab` switch the same panel into the read-only object-details mode
 * used for tables, views and procedures.
 */
export function renderEditDataShell(target: {
    database: string;
    schema: string;
    table: string;
    connectionName: string;
    objectType?: string;
    objectKind?: EditDataObjectKind;
    readOnly?: boolean;
    initialTab?: EditDataInitialTab;
}): string {
    const esc = escapeHtml;
    const objectType = (target.objectType ?? 'TABLE').toUpperCase();
    const objectKind: EditDataObjectKind = target.objectKind
        ?? (objectType === 'PROCEDURE' ? 'procedure' : objectType.includes('VIEW') ? 'view' : 'table');
    const isProcedure = objectKind === 'procedure';
    const readOnly = target.readOnly ?? false;
    const initialTab = target.initialTab ?? 'data';
    const activeTab = initialTab === 'structure' || isProcedure && initialTab === 'data'
        ? 'tab-metadata'
        : initialTab === 'ddl'
            ? 'tab-ddl'
            : 'tab-data';
    const tabClass = (id: string): string => id === activeTab ? 'tab active' : 'tab';
    const tabPanelClass = (id: string): string => id === activeTab ? 'tab-content active' : 'tab-content';
    const objectIcon = objectKind === 'procedure' ? ICONS.procedure : objectKind === 'view' ? ICONS.view : ICONS.table;
    const tabs = isProcedure
        ? `<button class="${tabClass('tab-metadata')}" role="tab" data-target="tab-metadata">Structure</button>
                        <button class="${tabClass('tab-ddl')}" role="tab" data-target="tab-ddl">DDL</button>`
        : `<button class="${tabClass('tab-data')}" role="tab" data-target="tab-data">Data</button>
                        <button class="${tabClass('tab-metadata')}" role="tab" data-target="tab-metadata">Structure</button>
                        <button class="${tabClass('tab-ddl')}" role="tab" data-target="tab-ddl">DDL</button>`;
    const dataToolbar = readOnly
        ? `<div class="toolbar">
                        <div class="toolbar-group">
                            <button id="refreshBtn" class="icon-only" title="Refresh (F5)">${ICONS.refresh}</button>
                        </div>
                        <span class="toolbar-spacer"></span>
                        <span id="status" class="status" aria-live="polite"></span>
                        <button id="closeBtn" class="icon-only ghost" title="Close the editor">${ICONS.close}</button>
                    </div>`
        : `<div class="toolbar">
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
                    </div>`;
    const dataPanel = isProcedure
        ? ''
        : `<section id="tab-data" class="${tabPanelClass('tab-data')}" role="tabpanel">
                    ${dataToolbar}
                    <div class="filter-bar">
                        <label class="filter-field filter-field--where">
                            <span class="filter-field__label">WHERE</span>
                            <input type="text" id="filterWhere" spellcheck="false" placeholder="e.g. ID > 100 AND STATUS = 'A'" title="Server-side filter, applied with Enter">
                        </label>
                        <label class="filter-field filter-field--order">
                            <span class="filter-field__label">ORDER BY</span>
                            <input type="text" id="filterOrderBy" spellcheck="false" placeholder="${readOnly ? 'optional' : 'ROWID'}" title="Server-side sort, applied with Enter">
                        </label>
                        <label class="filter-field filter-field--columns">
                            <span class="filter-field__label">COLUMNS</span>
                            <input type="text" id="filterColumns" spellcheck="false" placeholder="*" title="Columns to select${readOnly ? '' : ' (ROWID is always included)'}">
                        </label>
                        <button id="clearFilterBtn" class="icon-only ghost" title="Clear filter and reload" hidden>${ICONS.clear}</button>
                    </div>
                    <div id="errorBanner" class="error-banner" role="alert" hidden></div>
                    <div id="gridContainer" class="grid-container" tabindex="0" aria-label="${readOnly ? 'Object data' : 'Table data'}"></div>
                    <footer class="status-bar">
                        <span id="statusLeft"></span>
                        <span id="statusRight" class="status-bar__right"></span>
                    </footer>
                </section>`;

    return `<div class="main-layout">
                <header class="panel-header">
                    <div class="object-path" title="${esc(`${target.connectionName} · ${target.database}.${target.schema}.${target.table}`)}">
                        <span class="object-icon" aria-hidden="true">${objectIcon}</span>
                        <span class="object-path__muted">${esc(target.database)}.${esc(target.schema)}.</span><span class="object-path__name">${esc(target.table)}</span>
                        <span class="object-path__conn">${esc(target.connectionName)}</span>
                    </div>
                    <nav class="tabs-header" role="tablist">
                        ${tabs}
                    </nav>
                </header>

                ${dataPanel}

                <section id="tab-metadata" class="${tabPanelClass('tab-metadata')}" role="tabpanel">
                    <div id="metadataContent" class="metadata-content"><div class="empty-state"><span class="spinner"></span>Loading metadata…</div></div>
                </section>

                <section id="tab-ddl" class="${tabPanelClass('tab-ddl')}" role="tabpanel">
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
    view: '<svg viewBox="0 0 16 16"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>',
    procedure: '<svg viewBox="0 0 16 16"><path d="M5 2.5h6M5 13.5h6"/><path d="M3.5 2.5v11M12.5 2.5v11"/><path d="M6.5 6.5 8 8l-1.5 1.5M9.5 6.5 8 8l1.5 1.5"/></svg>',
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
