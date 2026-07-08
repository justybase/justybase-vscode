import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { runQueryRaw, queryResultToRows, QueryResult } from '../core/queryRunner';
import { DatabaseKind } from '../contracts/database';
import type { SchemaSearchResultItem } from '../contracts/webviews/schemaSearchContracts';
import {
    createConnectedDatabaseConnectionFromDetails,
    getDatabaseMetadataProvider,
} from '../core/connectionFactory';
import { MetadataCache } from '../metadataCache';
import { ConnectionManager, ConnectionDetails } from '../core/connectionManager';
import { supportsLegacyMetadataPrefetch } from '../metadata/prefetchSupport';
import { compareSearchResultsByObjectPriority } from '../metadata/objectTypeSortPriority';
import { buildEscapedLikePattern } from '../metadata/searchPatterns';
import {
    applySearchIndexFilters,
    searchMetadataIndex,
    searchResultToSchemaItem,
    type SearchIndexFilters,
} from '../metadata/searchIndex';
import { logWithFallback } from '../utils/logger';

interface SearchQueryRow {
    NAME?: string;
    SCHEMA?: string;
    DATABASE?: string;
    TYPE?: string;
    PARENT?: string;
    DESCRIPTION?: string;
    MATCH_TYPE?: string;
}

export interface SchemaObjectDatabaseSearchOptions {
    databases?: string[];
    filters?: SearchIndexFilters;
    isCancelled?: () => boolean;
    onBatch?: (results: SchemaSearchResultItem[], sentIds: Set<string>) => void;
}

export class SchemaObjectSearchService {
    static readonly DATABASE_DISCOVERY_TIMEOUT_MS = 10000;
    static readonly DATABASE_SEARCH_TIMEOUT_MS = 15000;

    constructor(
        private readonly context: ExtensionContext,
        private readonly metadataCache: MetadataCache,
        private readonly connectionManager: ConnectionManager,
    ) {}

    searchCacheResults(
        term: string,
        connectionName: string,
        filters?: SearchIndexFilters,
        selectedConnectionName?: string,
    ): SchemaSearchResultItem[] {
        const scopedResults = searchMetadataIndex(this.metadataCache, term, {
            ...filters,
            connectionName,
        });

        const results =
            scopedResults.length > 0 || selectedConnectionName?.trim()
                ? scopedResults
                : searchMetadataIndex(this.metadataCache, term, filters);

        return results
            .map((result) => searchResultToSchemaItem(result, connectionName))
            .sort(compareSearchResultsByObjectPriority);
    }

    buildResultDedupKey(
        item: { NAME?: string; SCHEMA?: string; DATABASE?: string; PARENT?: string },
        type: string | undefined,
    ): string | undefined {
        const normalizedName = item.NAME?.trim();
        const normalizedType = type?.trim().toUpperCase();

        if (!normalizedName || !normalizedType) {
            return undefined;
        }

        return `${(item.DATABASE || '').toUpperCase().trim()}|${(item.SCHEMA || '').toUpperCase().trim()}|${normalizedName.toUpperCase()}|${normalizedType}|${(item.PARENT || '').toUpperCase().trim()}`;
    }

    maybeTriggerPrefetch(connectionName: string): void {
        if (
            !supportsLegacyMetadataPrefetch(this.connectionManager.getConnectionDatabaseKind(connectionName))
            || this.metadataCache.hasAllObjectsPrefetchTriggered(connectionName)
            || this.metadataCache.isConnectionPrefetchFresh(connectionName)
        ) {
            return;
        }

        this.metadataCache.prefetchAllObjects(connectionName, async (query) =>
            runQueryRaw(
                this.context,
                query,
                true,
                this.connectionManager,
                connectionName,
                undefined,
                undefined,
                undefined,
                1000000,
                false,
            ),
        );
    }

    async resolveSearchConnectionName(selectedConnectionName?: string): Promise<string | undefined> {
        const normalizedSelection = selectedConnectionName?.trim();
        if (normalizedSelection) {
            return this.connectionManager.resolveConnectionName(undefined, normalizedSelection);
        }

        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.languageId === 'sql') {
            const conn = this.connectionManager.getConnectionForExecution(activeEditor.document.uri.toString());
            if (conn) {
                return conn;
            }
        }

        return this.connectionManager.getActiveConnectionName() || undefined;
    }

    async resolveSearchConnectionOrNotify(selectedConnectionName?: string): Promise<string | undefined> {
        const resolvedConnectionName = await this.resolveSearchConnectionName(selectedConnectionName);
        if (resolvedConnectionName) {
            return resolvedConnectionName;
        }

        const connections = await this.connectionManager.getConnections();
        if (connections.length === 1) {
            return connections[0].name;
        }

        const message =
            connections.length === 0
                ? 'No database connections are configured.'
                : 'No active connection selected. Open Search Settings and choose a connection.';
        void vscode.window.showErrorMessage(message);
        return undefined;
    }

    getConnectionKind(connectionName: string): DatabaseKind {
        return typeof this.connectionManager.getConnectionDatabaseKind === 'function'
            ? this.connectionManager.getConnectionDatabaseKind(connectionName) ?? 'netezza'
            : 'netezza';
    }

    shouldSearchAllDatabases(): boolean {
        return vscode.workspace
            .getConfiguration('justybase.schemaSearch')
            .get<boolean>('searchAllDatabases', false);
    }

    async resolveSearchDatabases(
        connectionName: string,
        details: ConnectionDetails,
        preloadedDatabases?: string[],
    ): Promise<string[]> {
        const kind = this.getConnectionKind(connectionName);

        if (preloadedDatabases && preloadedDatabases.length > 0) {
            return this.prioritizeDatabases(preloadedDatabases, details, kind);
        }

        if (!this.shouldSearchAllDatabases()) {
            return this.prioritizeDatabases([], details, kind);
        }

        try {
            const databases = await this.runWithTimeout(
                this.getDatabases(connectionName, details),
                'Database discovery',
                SchemaObjectSearchService.DATABASE_DISCOVERY_TIMEOUT_MS,
            );

            if (databases.length > 0) {
                return this.prioritizeDatabases(databases, details, kind);
            }
        } catch (error) {
            logWithFallback('warn', 'Falling back to the current database after database discovery failed.', error);
        }

        return this.prioritizeDatabases([], details, kind);
    }

    async searchDatabase(
        term: string,
        connectionName: string,
        options: SchemaObjectDatabaseSearchOptions = {},
    ): Promise<SchemaSearchResultItem[]> {
        if (!term || term.length < 2) {
            return [];
        }

        const details = await this.connectionManager.getConnection(connectionName);
        if (!details) {
            return [];
        }

        const likeTerm = buildEscapedLikePattern(term);
        const databases = await this.resolveSearchDatabases(connectionName, details, options.databases);
        if (databases.length === 0) {
            return [];
        }

        const sentIds = new Set<string>();
        const connectionKind = this.getConnectionKind(connectionName);
        const searchTasks = databases.map((databaseName) => async () => {
            if (options.isCancelled?.()) {
                return [] as SchemaSearchResultItem[];
            }

            const query = getDatabaseMetadataProvider(connectionKind).buildObjectSearchQuery(databaseName, likeTerm);

            try {
                const result = await this.runSearchOnDatabaseWithTimeout(
                    details,
                    databaseName,
                    query,
                    connectionKind,
                    'Object search query',
                );

                if (!result?.data) {
                    return [] as SchemaSearchResultItem[];
                }

                const rows = queryResultToRows<SearchQueryRow & { [key: string]: unknown }>(result);
                const mappedResults: SchemaSearchResultItem[] = [];

                for (const row of rows) {
                    const normalizedType = row.TYPE?.trim().toUpperCase();
                    const key = this.buildResultDedupKey(row, normalizedType);
                    if (!key || !normalizedType || sentIds.has(key)) {
                        continue;
                    }

                    const item: SchemaSearchResultItem = {
                        NAME: row.NAME || '',
                        SCHEMA: row.SCHEMA || '',
                        DATABASE: row.DATABASE || databaseName,
                        TYPE: normalizedType,
                        PARENT: row.PARENT || '',
                        DESCRIPTION: row.DESCRIPTION || '',
                        MATCH_TYPE: row.MATCH_TYPE || 'NAME',
                        connectionName,
                    };

                    if (options.filters && applySearchIndexFilters([{
                        name: item.NAME,
                        type: item.TYPE,
                        database: item.DATABASE,
                        schema: item.SCHEMA,
                        parent: item.PARENT,
                        matchType: item.MATCH_TYPE,
                    }], options.filters).length === 0) {
                        continue;
                    }

                    sentIds.add(key);
                    mappedResults.push(item);
                }

                if (mappedResults.length > 0) {
                    options.onBatch?.(mappedResults, sentIds);
                }

                return mappedResults;
            } catch (error) {
                logWithFallback('debug', `Error searching in database ${databaseName}:`, error);
                return [] as SchemaSearchResultItem[];
            }
        });

        const resultBatches = await this.runWithConcurrencyLimit(
            searchTasks,
            8,
            options.isCancelled,
        );

        const mappedResults = resultBatches.flat();
        mappedResults.sort(compareSearchResultsByObjectPriority);
        return mappedResults;
    }

    private prioritizeDatabases(
        databases: string[],
        details: ConnectionDetails,
        kind: DatabaseKind,
    ): string[] {
        const prioritized: string[] = [];
        const pushUnique = (databaseName: string | undefined) => {
            const normalized = databaseName?.trim();
            if (!normalized) {
                return;
            }

            if (!prioritized.some((existing) => existing.toUpperCase() === normalized.toUpperCase())) {
                prioritized.push(normalized);
            }
        };

        pushUnique(kind === 'sqlite' ? 'main' : details.database);
        for (const databaseName of databases) {
            pushUnique(databaseName);
        }

        return prioritized;
    }

    private async getDatabases(connectionName: string, details?: ConnectionDetails): Promise<string[]> {
        let databases: string[] = [];
        const kind = this.getConnectionKind(connectionName);
        try {
            const metadataProvider = getDatabaseMetadataProvider(kind);
            const dbResult = await runQueryRaw(
                this.context,
                metadataProvider.buildListDatabasesQuery(),
                true,
                this.connectionManager,
                connectionName,
                undefined,
                undefined,
                undefined,
                1000000,
                false,
            );
            if (dbResult?.data) {
                const dbRows = queryResultToRows<{ DATABASE: string }>(dbResult);
                databases = dbRows.map((row) => row.DATABASE);
            }
        } catch (error) {
            logWithFallback('error', 'Error fetching databases for search:', error);
        }

        if (databases.length === 0 && details?.database) {
            databases = [kind === 'sqlite' ? 'main' : details.database];
        }

        return databases;
    }

    private async runSearchOnDatabaseWithTimeout(
        details: ConnectionDetails,
        databaseName: string,
        sql: string,
        kind: DatabaseKind,
        label: string,
    ): Promise<QueryResult> {
        return this.runWithTimeout(
            this.runSearchOnDatabase(details, databaseName, sql, kind),
            `${label} for ${databaseName}`,
            SchemaObjectSearchService.DATABASE_SEARCH_TIMEOUT_MS,
        );
    }

    private async runSearchOnDatabase(
        details: ConnectionDetails,
        db: string,
        sql: string,
        kind: DatabaseKind,
    ): Promise<QueryResult> {
        const conn = await createConnectedDatabaseConnectionFromDetails(
            details,
            kind === 'sqlite' ? undefined : db,
        );

        try {
            const cmd = conn.createCommand(sql);
            cmd.commandTimeout = 30;
            const reader = await cmd.executeReader();

            const columns: Array<{ name: string }> = [];
            for (let i = 0; i < reader.fieldCount; i++) {
                columns.push({ name: reader.getName(i) });
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
                sql,
            };
        } finally {
            try {
                await conn.close();
            } catch {
                // Ignore close errors
            }
        }
    }

    private async runWithTimeout<T>(
        promise: Promise<T>,
        label: string,
        timeoutMs: number,
    ): Promise<T> {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

        try {
            return await Promise.race([
                promise,
                new Promise<T>((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                        reject(new Error(`${label} timed out after ${timeoutMs / 1000}s.`));
                    }, timeoutMs);
                }),
            ]);
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    private async runWithConcurrencyLimit<T>(
        tasks: Array<() => Promise<T>>,
        maxConcurrency: number,
        shouldStop?: () => boolean,
    ): Promise<T[]> {
        if (tasks.length === 0) {
            return [];
        }

        const results: T[] = new Array(tasks.length);
        let nextIndex = 0;

        const worker = async (): Promise<void> => {
            while (true) {
                if (shouldStop?.()) {
                    break;
                }

                const currentIndex = nextIndex;
                if (currentIndex >= tasks.length) {
                    break;
                }
                nextIndex = currentIndex + 1;

                try {
                    results[currentIndex] = await tasks[currentIndex]();
                } catch (error) {
                    logWithFallback('debug', `Task ${currentIndex} failed:`, error);
                    results[currentIndex] = [] as unknown as T;
                }

                if (shouldStop?.()) {
                    break;
                }
            }
        };

        const workerCount = Math.min(maxConcurrency, tasks.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));

        return results.filter((result): result is T => result !== undefined);
    }
}

// Re-export for backward compatibility with existing imports.
export { buildEscapedLikePattern };
