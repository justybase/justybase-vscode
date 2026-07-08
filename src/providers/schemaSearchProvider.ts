import * as vscode from 'vscode';
import { queryResultToRows, QueryResult } from '../core/queryRunner';
import { DatabaseKind } from '../contracts/database';
import type {
    SchemaSearchConnectionOption,
    SchemaSearchInboundMessage,
    SchemaSearchOutboundMessage,
    SchemaSearchResultItem,
    SchemaSearchSourceMode
} from '../contracts/webviews';
import { createConnectedDatabaseConnectionFromDetails, getDatabaseMetadataProvider } from '../core/connectionFactory';
import { SchemaSearchHtmlGenerator } from '../views/schemaSearchHtmlGenerator';
import { MetadataCache } from '../metadataCache';
import { ConnectionManager, ConnectionDetails } from '../core/connectionManager';
import { compareSearchResultsByObjectPriority } from '../metadata/objectTypeSortPriority';
import { searchInCodeWithMode } from '../sql/sqlTextUtils';
import { logWithFallback } from '../utils/logger';
import { SchemaObjectSearchService, buildEscapedLikePattern } from '../services/schemaObjectSearchService';
import { SchemaRecentObjectsService } from '../services/schemaRecentObjects';

export { buildEscapedLikePattern };

interface SearchQueryRow {
    NAME?: string;
    SCHEMA?: string;
    DATABASE?: string;
    TYPE?: string;
    PARENT?: string;
    DESCRIPTION?: string;
    MATCH_TYPE?: string;
}

export class SchemaSearchProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'netezza.search';
    private static readonly REQUEST_TIMEOUT_MS = 60000;
    private static readonly DATABASE_SEARCH_TIMEOUT_MS = 15000;
    private _view?: vscode.WebviewView;
    private _disposables: vscode.Disposable[] = [];
    private readonly _sessionId: string;
    private readonly _searchService: SchemaObjectSearchService;
    private readonly _recentObjects: SchemaRecentObjectsService;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        extensionContext: vscode.ExtensionContext,
        metadataCache: MetadataCache,
        private connectionManager: ConnectionManager
    ) {
        this._searchService = new SchemaObjectSearchService(extensionContext, metadataCache, connectionManager);
        this._recentObjects = new SchemaRecentObjectsService(extensionContext);
        // Generate a unique session ID for this VS Code session
        this._sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this.disposeViewResources();
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        this._disposables.push(webviewView.webview.onDidReceiveMessage(async (data: SchemaSearchInboundMessage) => {
            logWithFallback('debug', '[SchemaSearch] received message from webview:', data.type);
            await this.handleMessage(data);
        }));

        this._disposables.push(this.connectionManager.onDidChangeConnections(() => {
            logWithFallback('debug', '[SchemaSearch] onDidChangeConnections fired');
            void this.postAvailableConnections();
        }));
        this._disposables.push(this.connectionManager.onDidChangeActiveConnection(() => {
            logWithFallback('debug', '[SchemaSearch] onDidChangeActiveConnection fired');
            void this.postAvailableConnections();
        }));
        this._disposables.push(this.connectionManager.onDidChangeDocumentConnection(() => {
            logWithFallback('debug', '[SchemaSearch] onDidChangeDocumentConnection fired');
            void this.postAvailableConnections();
        }));

        webviewView.webview.html = new SchemaSearchHtmlGenerator(this._sessionId).generateHtml();
        logWithFallback('debug', '[SchemaSearch] resolveWebviewView: HTML set, calling postAvailableConnections');
        void this.postAvailableConnections();
    }

    public dispose(): void {
        this.disposeViewResources();
    }

    private disposeViewResources(): void {
        for (const disposable of this._disposables) {
            disposable.dispose();
        }
        this._disposables = [];
    }

    private async handleMessage(data: SchemaSearchInboundMessage): Promise<void> {
        const requestPromise = (async () => {
            switch (data.type) {
                case 'search':
                    await this.search(data.value, data.connectionName);
                    return;
                case 'searchSource':
                    await this.searchSourceCode(data.value, data.mode || 'noCommentsNoLiterals', undefined, undefined, undefined, undefined, data.connectionName);
                    return;
                case 'searchCombined':
                    await this.doCombinedSearch(data.value, data.mode || 'raw', data.connectionName);
                    return;
                case 'requestConnections':
                    await this.postAvailableConnections();
                    return;
                case 'requestRecents':
                    await this.postRecentObjects(data.connectionName);
                    return;
                case 'navigate':
                    this._recentObjects.addFromSearchResult(
                        {
                            NAME: data.name,
                            SCHEMA: data.schema,
                            DATABASE: data.database,
                            TYPE: data.objType,
                            PARENT: data.parent,
                            DESCRIPTION: '',
                            MATCH_TYPE: 'NAME',
                            connectionName: data.connectionName,
                        },
                        data.connectionName || '',
                    );
                    void this.postRecentObjects(data.connectionName);
                    vscode.commands.executeCommand('netezza.revealInSchema', data);
                    return;
                case 'cancel':
                    this.currentSearchId++;
                    this.postMessage({ type: 'cancelled' });
                    return;
                case 'reset':
                    this.currentSearchId++;
                    this.postMessage({ type: 'reset' });
                    return;
                case 'exportXlsb':
                    this.handleExportXlsb(data.results);
                    return;
            }
        })();

        try {
            await this.runWithTimeout(requestPromise, this.describeRequest(data));
        } catch (error: unknown) {
            if (this.isSearchRequest(data.type)) {
                this.currentSearchId++;
            }

            const message = error instanceof Error ? error.message : String(error);
            this.postMessage({ type: 'error', message });
        }
    }

    private isSearchRequest(type: SchemaSearchInboundMessage['type']): boolean {
        return type === 'search' || type === 'searchSource' || type === 'searchCombined';
    }

    private describeRequest(data: SchemaSearchInboundMessage): string {
        switch (data.type) {
            case 'search':
                return 'Object search';
            case 'searchSource':
                return 'Source search';
            case 'searchCombined':
                return 'Combined search';
            case 'requestConnections':
                return 'Connection list refresh';
            case 'requestRecents':
                return 'Recent objects';
            case 'navigate':
                return 'Schema navigation';
            case 'cancel':
                return 'Search cancellation';
            case 'reset':
                return 'Search reset';
            case 'exportXlsb':
                return 'Search export';
        }
    }

    private async runWithTimeout<T>(
        promise: Promise<T>,
        label: string,
        timeoutMs: number = SchemaSearchProvider.REQUEST_TIMEOUT_MS
    ): Promise<T> {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

        try {
            return await Promise.race([
                promise,
                new Promise<T>((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                        reject(new Error(`${label} timed out after ${timeoutMs / 1000}s.`));
                    }, timeoutMs);
                })
            ]);
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    private getCachedResultsForSearch(
        term: string,
        connectionName: string,
        selectedConnectionName?: string
    ) {
        return this._searchService.searchCacheResults(term, connectionName, undefined, selectedConnectionName);
    }

    private async resolveSearchDatabases(
        connectionName: string,
        details: ConnectionDetails,
        preloadedDatabases?: string[]
    ): Promise<string[]> {
        return this._searchService.resolveSearchDatabases(connectionName, details, preloadedDatabases);
    }

    private async runSearchOnDatabaseWithTimeout(
        details: ConnectionDetails,
        databaseName: string,
        sql: string,
        kind: DatabaseKind,
        label: string
    ): Promise<QueryResult> {
        return this.runWithTimeout(
            this.runSearchOnDatabase(details, databaseName, sql, kind),
            `${label} for ${databaseName}`,
            SchemaSearchProvider.DATABASE_SEARCH_TIMEOUT_MS
        );
    }

    private postMessage(message: SchemaSearchOutboundMessage): void {
        if (!this._view) {
            return;
        }

        void this._view.webview.postMessage(message);
    }

    private resolveAutoConnectionName(): string | undefined {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.languageId === 'sql') {
            const conn = this.connectionManager.getConnectionForExecution(activeEditor.document.uri.toString());
            logWithFallback('debug', '[SchemaSearch] resolveAutoConnectionName: from active SQL editor =', conn);
            return conn;
        }

        const active = this.connectionManager.getActiveConnectionName() || undefined;
        logWithFallback('debug', '[SchemaSearch] resolveAutoConnectionName: from getActiveConnectionName =', active);
        return active;
    }

    private resolveSearchConnectionName(selectedConnectionName?: string): string | undefined {
        const normalizedSelection = selectedConnectionName?.trim();
        if (normalizedSelection) {
            return this.connectionManager.resolveConnectionName(undefined, normalizedSelection);
        }

        return this.resolveAutoConnectionName();
    }

    private async resolveSearchConnectionOrNotify(selectedConnectionName?: string): Promise<string | undefined> {
        const resolvedConnectionName = this.resolveSearchConnectionName(selectedConnectionName);
        if (resolvedConnectionName) {
            return resolvedConnectionName;
        }

        const connections = await this.connectionManager.getConnections();
        if (connections.length === 1) {
            return connections[0].name;
        }

        this.postMessage({
            type: 'error',
            message: connections.length === 0
                ? 'No database connections are configured.'
                : 'No active connection selected. Open Search Settings and choose a connection.'
        });
        return undefined;
    }

    private async postAvailableConnections(): Promise<void> {
        if (!this._view) {
            logWithFallback('debug', '[SchemaSearch] postAvailableConnections: no view, skipping');
            return;
        }

        logWithFallback('debug', '[SchemaSearch] postAvailableConnections: calling getConnections...');
        const connections = await this.connectionManager.getConnections();
        logWithFallback('debug', '[SchemaSearch] postAvailableConnections: got', connections.length, 'connections:', connections.map(c => c.name));
        const options: SchemaSearchConnectionOption[] = connections
            .map(connection => {
                const detailParts = [connection.dbType?.toUpperCase(), connection.database].filter(Boolean);
                return {
                    name: connection.name,
                    label: detailParts.length > 0
                        ? `${connection.name} (${detailParts.join(' · ')})`
                        : connection.name
                };
            })
            .sort((left, right) => left.label.localeCompare(right.label));

        logWithFallback('debug', '[SchemaSearch] postAvailableConnections: posting', options.length, 'options to webview');
        this.postMessage({
            type: 'connections',
            connections: options
        });
        await this.postRecentObjects();
    }

    private async postRecentObjects(selectedConnectionName?: string): Promise<void> {
        if (!this._view) {
            return;
        }

        const connectionName = await this._searchService.resolveSearchConnectionName(selectedConnectionName);
        if (!connectionName) {
            this.postMessage({ type: 'recents', data: [] });
            return;
        }

        const data = this._recentObjects
            .getRecents(connectionName)
            .map((entry) => this._recentObjects.toSearchResultItem(entry));

        this.postMessage({ type: 'recents', data });
    }

    private handleExportXlsb(results: SchemaSearchResultItem[]) {
        if (!results || results.length === 0) {
            vscode.window.showWarningMessage('No results to export.');
            return;
        }

        const structuredData = [
            {
                name: 'Object Search Results',
                columns: [
                    { name: 'TYPE', type: 'VARCHAR' },
                    { name: 'NAME', type: 'VARCHAR' },
                    { name: 'DATABASE', type: 'VARCHAR' },
                    { name: 'SCHEMA', type: 'VARCHAR' },
                    { name: 'PARENT', type: 'VARCHAR' },
                    { name: 'DESCRIPTION', type: 'VARCHAR' }
                ],
                rows: results.map(r => [
                    r.TYPE || '',
                    r.NAME || '',
                    r.DATABASE || '',
                    r.SCHEMA || '',
                    r.PARENT || '',
                    r.DESCRIPTION === 'Result from Cache' ? 'Cached' : (r.DESCRIPTION || '')
                ]),
                isActive: true
            }
        ];

        vscode.commands.executeCommand('netezza.exportCurrentResultToXlsbAndOpen', structuredData, 'Object Search Export');
    }

    private currentSearchId = 0;

    private getConnectionKind(connectionName: string): DatabaseKind {
        return typeof this.connectionManager.getConnectionDatabaseKind === 'function'
            ? this.connectionManager.getConnectionDatabaseKind(connectionName) ?? 'netezza'
            : 'netezza';
    }

    private async loadSupplementalDatabaseResults(
        term: string,
        connectionName: string,
        details: ConnectionDetails,
        preloadedDatabases?: string[],
    ): Promise<SchemaSearchResultItem[]> {
        const connectionKind = this.getConnectionKind(connectionName);
        if (connectionKind !== 'snowflake') {
            return [];
        }

        const databases = await this.resolveSearchDatabases(connectionName, details, preloadedDatabases);
        const normalizedTerm = term.toUpperCase();
        const supplementalRows: SearchQueryRow[] = [];

        for (const database of databases) {
            supplementalRows.push(
                ...(await this.searchSnowflakeSupplementalObjects(details, database, normalizedTerm, connectionKind)),
            );
        }

        return supplementalRows.map((row) => ({
            NAME: row.NAME || '',
            SCHEMA: row.SCHEMA || '',
            DATABASE: row.DATABASE || '',
            TYPE: row.TYPE || '',
            PARENT: row.PARENT || '',
            DESCRIPTION: row.DESCRIPTION || '',
            MATCH_TYPE: row.MATCH_TYPE || 'NAME',
            connectionName,
        }));
    }

    private async searchSnowflakeSupplementalObjects(
        details: ConnectionDetails,
        database: string,
        normalizedTerm: string,
        connectionKind: DatabaseKind
    ): Promise<SearchQueryRow[]> {
        if (connectionKind !== 'snowflake') {
            return [];
        }

        const metadataProvider = getDatabaseMetadataProvider(connectionKind);
        const supplementalTypes = ['STREAM', 'TASK'] as const;
        const supplementalResults: SearchQueryRow[] = [];

        for (const objectType of supplementalTypes) {
            try {
                const query = metadataProvider.buildObjectTypeQuery(database, objectType);
                const result = await this.runSearchOnDatabaseWithTimeout(
                    details,
                    database,
                    query,
                    connectionKind,
                    `${objectType} metadata search`
                );

                if (!result?.data) {
                    continue;
                }

                const rows = queryResultToRows<{
                    OBJNAME?: string;
                    SCHEMA?: string;
                    DATABASE?: string;
                    OBJTYPE?: string;
                    DESCRIPTION?: string;
                } & { [key: string]: unknown }>(result);

                for (const row of rows) {
                    const name = typeof row.OBJNAME === 'string' ? row.OBJNAME.trim() : '';

                    if (!name || !name.toUpperCase().includes(normalizedTerm)) {
                        continue;
                    }

                    supplementalResults.push({
                        NAME: name,
                        SCHEMA: typeof row.SCHEMA === 'string' ? row.SCHEMA : '',
                        DATABASE: typeof row.DATABASE === 'string' ? row.DATABASE : database,
                        TYPE: typeof row.OBJTYPE === 'string' ? row.OBJTYPE.toUpperCase() : objectType,
                        PARENT: '',
                        DESCRIPTION: typeof row.DESCRIPTION === 'string' ? row.DESCRIPTION : '',
                        MATCH_TYPE: 'NAME',
                    });
                }
            } catch (e) {
                logWithFallback('debug', `Error searching Snowflake ${objectType.toLowerCase()}s in database ${database}:`, e);
            }
        }

        return supplementalResults;
    }

    private buildResultDedupKey(
        item: { NAME?: string; SCHEMA?: string; DATABASE?: string; PARENT?: string },
        type: string | undefined
    ): string | undefined {
        const normalizedName = item.NAME?.trim();
        const normalizedType = type?.trim().toUpperCase();

        if (!normalizedName || !normalizedType) {
            logWithFallback('warn', 'Skipping malformed search result row missing NAME or TYPE.', item);
            return undefined;
        }

        return `${(item.DATABASE || '').toUpperCase().trim()}|${(item.SCHEMA || '').toUpperCase().trim()}|${normalizedName.toUpperCase()}|${normalizedType}|${(item.PARENT || '').toUpperCase().trim()}`;
    }

    private async search(
        term: string,
        selectedConnectionName?: string,
        searchId?: number,
        _combined?: boolean,
        preloadedDatabases?: string[],
        sentIdsParam?: Set<string>
    ) {
        if (!term || term.length < 2) {
            this.postMessage({ type: 'error', message: 'Search term must be at least 2 characters.' });
            return;
        }
        const sentIds = sentIdsParam ?? new Set<string>();

        logWithFallback('debug', '[SchemaSearch] search: term=', term, 'selectedConnectionName=', selectedConnectionName);
        const connectionName = await this.resolveSearchConnectionOrNotify(selectedConnectionName);
        logWithFallback('debug', '[SchemaSearch] search: resolvedConnectionName=', connectionName);

        if (!connectionName) {
            return;
        }

        if (searchId === undefined) {
            searchId = ++this.currentSearchId;
        }

        let cachePosted = false;

        // 1. Search in Cache first (Immediate results) - CONNECTION SCOPED
        if (this._view) {
            const cachedResults = this.getCachedResultsForSearch(term, connectionName, selectedConnectionName);
            if (cachedResults.length > 0) {
                const mappedResults: SchemaSearchResultItem[] = [];

                for (const item of cachedResults) {
                    const key = this._searchService.buildResultDedupKey(item, item.TYPE);
                    if (!key || sentIds.has(key)) {
                        continue;
                    }

                    sentIds.add(key);
                    mappedResults.push({
                        ...item,
                        connectionName: item.connectionName || connectionName,
                    });
                }

                if (mappedResults.length > 0 && searchId === this.currentSearchId) {
                    this.postMessage({ type: 'results', data: mappedResults, append: false });
                    cachePosted = true;
                }
            } else if (searchId === this.currentSearchId) {
                this.postMessage({ type: 'searching', message: 'Searching in database...' });
            }

            this._searchService.maybeTriggerPrefetch(connectionName);
        }

        const details = await this.connectionManager.getConnection(connectionName);
        if (!details) {
            this.postMessage({
                type: 'error',
                message: `Connection '${connectionName}' is no longer available. Select a valid connection and try again.`
            });
            return;
        }

        try {
            const databaseResults = await this._searchService.searchDatabase(term, connectionName, {
                databases: preloadedDatabases,
                isCancelled: () => searchId !== this.currentSearchId,
            });

            if (searchId !== this.currentSearchId) {
                return;
            }

            const supplementalResults = await this.loadSupplementalDatabaseResults(
                term,
                connectionName,
                details,
                preloadedDatabases,
            );

            const freshResults: SchemaSearchResultItem[] = [];
            for (const item of [...databaseResults, ...supplementalResults]) {
                const key = this._searchService.buildResultDedupKey(item, item.TYPE);
                if (!key || sentIds.has(key)) {
                    continue;
                }
                sentIds.add(key);
                freshResults.push(item);
            }
            freshResults.sort(compareSearchResultsByObjectPriority);

            if (!this._view) {
                return;
            }

            if (freshResults.length > 0) {
                this.postMessage({ type: 'results', data: freshResults, append: cachePosted });
            } else if (!cachePosted && sentIds.size === 0) {
                this.postMessage({ type: 'results', data: [], append: false });
            }
        } catch (e: unknown) {
            logWithFallback('error', 'Search error:', e);
            if (this._view && searchId === this.currentSearchId) {
                this.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
            }
        }
    }

    private async runSearchOnDatabase(
        details: ConnectionDetails,
        db: string,
        sql: string,
        kind: DatabaseKind
    ): Promise<QueryResult> {
        const conn = await createConnectedDatabaseConnectionFromDetails(
            details,
            kind === 'sqlite' ? undefined : db
        );

        try {
            const cmd = conn.createCommand(sql);
            // Default timeout for search 30s
            cmd.commandTimeout = 30;
            const reader = await cmd.executeReader();

            const columns: Array<{ name: string }> = [];
            for (let i = 0; i < reader.fieldCount; i++) {
                columns.push({ name: reader.getName(i) }); // minimal for queryResultToRows
            }

            const data: Array<Array<unknown>> = [];
            while (await reader.read()) {
                const row: Array<unknown> = [];
                for (let i = 0; i < reader.fieldCount; i++) {
                    row.push(reader.getValue(i));
                }
                data.push(row);
            }
            await reader.close();

            return {
                columns,
                data,
                rowsAffected: undefined,
                limitReached: false,
                sql
            };
        } finally {
            try {
                await conn.close();
            } catch {
                // Ignore close errors
            }
        }
    }

    /**
     * Helper: Run up to N promises with max concurrency limit
     * Useful for limiting database connections to prevent overload
     * 
     * Uses a worker pool pattern to avoid race conditions
     */
    private async runWithConcurrencyLimit<T>(
        tasks: Array<() => Promise<T>>,
        maxConcurrency: number,
        shouldStop?: () => boolean
    ): Promise<T[]> {
        if (tasks.length === 0) {
            return [];
        }

        const results: T[] = new Array(tasks.length);
        let nextIndex = 0;

        // Worker function that processes tasks from the queue
        const worker = async (): Promise<void> => {
            while (true) {
                if (shouldStop && shouldStop()) {
                    break;
                }

                // Claim the next task index synchronously before awaiting the task.
                const currentIndex = nextIndex;
                if (currentIndex >= tasks.length) {
                    break; // No more tasks
                }
                nextIndex = currentIndex + 1;

                try {
                    const result = await tasks[currentIndex]();
                    results[currentIndex] = result;
                } catch (e) {
                    // Log error but continue processing other tasks
                    logWithFallback('debug', `Task ${currentIndex} failed:`, e);
                    // Store empty array for failed tasks to avoid undefined
                    results[currentIndex] = [] as unknown as T;
                }

                if (shouldStop && shouldStop()) {
                    break;
                }
            }
        };

        // Start worker pool - each worker processes tasks sequentially
        const workerCount = Math.min(maxConcurrency, tasks.length);
        const workers: Promise<void>[] = [];
        for (let i = 0; i < workerCount; i++) {
            workers.push(worker());
        }

        // Wait for all workers to complete
        await Promise.all(workers);

        // Filter out any undefined values (shouldn't happen now, but safety check)
        return results.filter((r): r is T => r !== undefined);
    }

    /**
     * Search in VIEW/PROCEDURE source code with configurable mode
     * @param mode Search mode: 'raw', 'noComments', 'noCommentsNoLiterals'
     */
    private async searchSourceCode(
        term: string,
        mode: SchemaSearchSourceMode,
        searchId?: number,
        _combined?: boolean,
        preloadedDatabases?: string[],
        sentIdsParam?: Set<string>,
        selectedConnectionName?: string
    ) {
        if (!term || term.length < 2) {
            this.postMessage({ type: 'error', message: 'Search term must be at least 2 characters.' });
            return;
        }
        const sentIds = sentIdsParam ?? new Set<string>();

        const connectionName = await this.resolveSearchConnectionOrNotify(selectedConnectionName);
        if (!connectionName) {
            return;
        }

        const details = await this.connectionManager.getConnection(connectionName);
        if (!details) {
            this.postMessage({
                type: 'error',
                message: `Connection '${connectionName}' is no longer available. Select a valid connection and try again.`
            });
            return;
        }

        if (searchId === undefined) {
            searchId = ++this.currentSearchId;
        }

        // Human readable mode description
        const modeDesc = mode === 'raw' ? 'raw source' :
            mode === 'noComments' ? 'source (excl. comments)' :
                'source (excl. comments/strings)';

        try {
            // Send searching status to panel
            if (this._view && searchId === this.currentSearchId) {
                this.postMessage({ type: 'searching', message: `Searching in ${modeDesc}...` });
            }

            const safeTerm = term.toUpperCase();
            const likeTerm = buildEscapedLikePattern(term);

            const results: SchemaSearchResultItem[] = [];

            // First, get list of all databases to search across (for procedures)
            let databases: string[] = [];

            if (preloadedDatabases) {
                databases = preloadedDatabases.filter(db => db !== 'SYSTEM');
            } else {
                const allDbs = await this.resolveSearchDatabases(connectionName, details);
                databases = allDbs.filter(db => db !== 'SYSTEM');
            }

            const connectionKind = this.getConnectionKind(connectionName);
            const metadataProvider = getDatabaseMetadataProvider(connectionKind);
            const useServerSideFilter = mode === 'raw';
            const MAX_CONCURRENCY = 8;
            const sourceSearchOptions = {
                rawTerm: term,
                likePattern: likeTerm,
                useServerSideFilter
            };

            // 1. Search in VIEW definitions across all databases
            // Create all view search tasks upfront
            const viewTasks = databases.map(db => async () => {
                if (searchId !== this.currentSearchId) {
                    return [];
                }

                const resolvedViewQuery = metadataProvider.buildViewSourceSearchQuery(db, sourceSearchOptions);

                try {
                    const viewResult = await this.runSearchOnDatabaseWithTimeout(
                        details,
                        db,
                        resolvedViewQuery,
                        connectionKind,
                        'View source search'
                    );

                    if (viewResult && viewResult.data && searchId === this.currentSearchId) {
                        const views = queryResultToRows<{ NAME: string; SCHEMA: string; DATABASE: string; SOURCE?: string } & { [key: string]: unknown }>(viewResult);
                        const batchResults: SchemaSearchResultItem[] = [];
                        for (const view of views) {
                            // For RAW mode with server-side filter, all results match
                            // For other modes, check in-memory
                            if (useServerSideFilter || (view.SOURCE && searchInCodeWithMode(view.SOURCE, safeTerm, mode))) {
                                const key = this.buildResultDedupKey(view, 'VIEW');

                                if (!key) {
                                    continue;
                                }

                                if (!sentIds.has(key)) {
                                    batchResults.push({
                                        NAME: view.NAME,
                                        SCHEMA: view.SCHEMA,
                                        DATABASE: view.DATABASE,
                                        TYPE: 'VIEW',
                                        PARENT: '',
                                        DESCRIPTION: `Found in view ${modeDesc}`,
                                        MATCH_TYPE: 'SOURCE_CODE',
                                        connectionName: connectionName!
                                    });
                                    sentIds.add(key);
                                }
                            }
                        }
                        return batchResults;
                    }
                } catch (e) {
                    logWithFallback('debug', `Error searching views in database ${db}:`, e);
                }
                return [];
            });

            // Run all view searches with concurrency limit
            const viewResultBatches = await this.runWithConcurrencyLimit(
                viewTasks,
                MAX_CONCURRENCY,
                () => searchId !== this.currentSearchId
            );
            for (const batchResults of viewResultBatches) {
                results.push(...batchResults);
            }

            // 2. Search in PROCEDURE sources across all databases
            // Create all procedure search tasks upfront
            const procTasks = databases.map(db => async () => {
                if (searchId !== this.currentSearchId) {
                    return [];
                }

                const procQuery = metadataProvider.buildProcedureSourceSearchQuery(db, sourceSearchOptions);

                try {
                    const procResult = await this.runSearchOnDatabaseWithTimeout(
                        details,
                        db,
                        procQuery,
                        connectionKind,
                        'Routine source search'
                    );
                    if (procResult && procResult.data && searchId === this.currentSearchId) {
                        const procs = queryResultToRows<{ NAME: string; SCHEMA: string; DATABASE: string; SOURCE?: string; TYPE?: string } & { [key: string]: unknown }>(procResult);
                        const batchResults: SchemaSearchResultItem[] = [];
                        for (const proc of procs) {
                            // For RAW mode with server-side filter, all results match
                            // For other modes, check in-memory
                            if (useServerSideFilter || (proc.SOURCE && searchInCodeWithMode(proc.SOURCE, safeTerm, mode))) {
                                const normalizedType = typeof proc.TYPE === 'string' && proc.TYPE.trim().length > 0
                                    ? proc.TYPE.trim().toUpperCase()
                                    : 'PROCEDURE';
                                const typeLabel = normalizedType.toLowerCase();
                                const key = this.buildResultDedupKey(proc, normalizedType);

                                if (!key) {
                                    continue;
                                }

                                if (!sentIds.has(key)) {
                                    batchResults.push({
                                        NAME: proc.NAME,
                                        SCHEMA: proc.SCHEMA,
                                        DATABASE: proc.DATABASE,
                                        TYPE: normalizedType,
                                        PARENT: '',
                                        DESCRIPTION: `Found in ${typeLabel} ${modeDesc}`,
                                        MATCH_TYPE: 'SOURCE_CODE',
                                        connectionName: connectionName!
                                    });
                                    sentIds.add(key);
                                }
                            }
                        }
                        return batchResults;
                    }
                } catch (e) {
                    logWithFallback('debug', `Error searching procedures in database ${db}:`, e);
                }
                return [];
            });

            // Run all procedure searches with concurrency limit
            const procResultBatches = await this.runWithConcurrencyLimit(
                procTasks,
                MAX_CONCURRENCY,
                () => searchId !== this.currentSearchId
            );
            for (const batchResults of procResultBatches) {
                results.push(...batchResults);
            }

            // Send results (append so combined "objects + source raw" mode sums both sets)
            if (this._view && searchId === this.currentSearchId) {
                this.postMessage({ type: 'results', data: results, append: true });
            }
        } catch (e: unknown) {
            logWithFallback('error', 'Source code search error:', e);
            if (this._view && searchId === this.currentSearchId) {
                this.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
            }
        }
    }

    private async doCombinedSearch(term: string, mode: SchemaSearchSourceMode, selectedConnectionName?: string) {
        const searchId = ++this.currentSearchId;

        // Optimization: Fetch databases once and share
        const connectionName = this.resolveSearchConnectionName(selectedConnectionName);

        let databases: string[] | undefined;
        if (connectionName) {
            const details = await this.connectionManager.getConnection(connectionName);
            if (details) {
                databases = await this.resolveSearchDatabases(connectionName, details);
            }
        }

        // Run both with the same searchId and shared sentIds
        const sentIds = new Set<string>();
        await Promise.all([
            this.search(term, selectedConnectionName, searchId, true, databases, sentIds),
            this.searchSourceCode(term, mode, searchId, true, databases, sentIds, selectedConnectionName)
        ]);
    } // End of doCombinedSearch
}
