/**
 * Provider for database metadata (databases, schemas, tables, columns)
 */

import * as vscode from 'vscode';
import { getDatabaseMetadataProvider } from '../../core/connectionFactory';
import { runQueryRaw, queryResultToRows } from '../../core/queryRunner';
import { MetadataCache } from '../../metadataCache';
import { ConnectionManager } from '../../core/connectionManager';
import { buildColumnCacheKey } from '../../metadata/columnRowMapping';
import { mergeAndSetTables } from '../../metadata/cache/tableLikeMerge';
import { getTablesForScope, buildSchemaCacheKey } from '../../metadata/cache/schemaTreeDataSource';
import { DatabaseMetadata, SchemaMetadata, TableMetadata, ProcedureMetadata, ColumnMetadata } from '../../metadata/types';
import { supportsLegacyMetadataPrefetch } from '../../metadata/prefetchSupport';
import { PREFETCH_RETRY_BACKOFF_MS } from '../../metadata/prefetch';
import { createConnectionScopedMetadataQueryRunner } from '../../metadata/connectionScopedMetadataQueryRunner';
import { formatIdentifierForSql } from '../../utils/identifierUtils';
import {
    METADATA_QUERY_TIMEOUT_SECONDS,
    runWithMetadataQueryConcurrencyLimit,
} from '../../metadata/metadataQueryLimiter';
import {
    normalizeCompletionDescription,
    toInlineCompletionDescription,
} from '../../utils/completionDescriptionUtils';
import { getMetadataQueryConcurrencyLimit } from '../../metadata/metadataQueryLimiter';
import {
    buildNetezzaSynonymTargetQuery,
    parseSynonymTargetReference,
} from '../../metadata/synonymColumns';
import {
    fetchTableColumnsWithFallback,
} from '../tableMetadataProvider';
import type { DatabaseKind } from '../../contracts/database';
import { stripIdentifierQuoting } from '../../utils/identifierUtils';
import { logWithFallback } from '../../utils/logger';
import {
    createNetezzaCatalogIdentifier,
    formatNetezzaIdentifier,
    createNetezzaUserIdentifier,
} from '../../dialects/netezza/metadata/identifierUtils';
import {
    buildNetezzaDatabaseCacheKey,
    buildNetezzaDbSchemaCacheKey,
    buildNetezzaCacheDatabasePart,
} from '../../metadata/helpers';
import type {
    MetadataColumnLookupOptions,
    MetadataQueryContext,
    MetadataQueryKind,
    MetadataRequestSource,
} from '../../metadata/metadataQueryDiagnostics';

export class MetadataProvider {
    private readonly columnFetchInFlight = new Map<string, Promise<ColumnMetadata[]>>();

    constructor(
        private context: vscode.ExtensionContext,
        private metadataCache: MetadataCache,
        private connectionManager: ConnectionManager
    ) { }

    private tryGetConnectionDatabaseKind(connectionName?: string): DatabaseKind | undefined {
        return this.connectionManager.getConnectionDatabaseKind(connectionName);
    }

    private supportsLegacyMetadataPrefetch(connectionName: string): boolean {
        const cache = this.metadataCache as MetadataCache & {
            supportsLegacyMetadataPrefetch?: (name: string) => boolean;
        };
        if (typeof cache.supportsLegacyMetadataPrefetch === 'function') {
            return cache.supportsLegacyMetadataPrefetch(connectionName);
        }
        return supportsLegacyMetadataPrefetch(this.tryGetConnectionDatabaseKind(connectionName));
    }

    private getConnectionDatabaseKind(connectionName?: string): DatabaseKind {
        if (!connectionName) {
            throw new Error('Connection name is required for metadata lookup.');
        }

        const databaseKind = this.tryGetConnectionDatabaseKind(connectionName);
        if (!databaseKind) {
            throw new Error(`Connection '${connectionName}' is missing a database type. Open the connection settings and save it again.`);
        }

        return databaseKind;
    }

    private tryGetMetadataProvider(connectionName?: string) {
        const databaseKind = this.tryGetConnectionDatabaseKind(connectionName);
        return databaseKind ? getDatabaseMetadataProvider(databaseKind) : undefined;
    }

    private getMetadataProvider(connectionName?: string) {
        return getDatabaseMetadataProvider(this.getConnectionDatabaseKind(connectionName));
    }

    private formatMetadataIdentifier(
        value: string,
        databaseKind: DatabaseKind | undefined,
    ): string {
        return databaseKind === 'netezza'
            ? formatNetezzaIdentifier(createNetezzaCatalogIdentifier(value))
            : formatIdentifierForSql(value, databaseKind);
    }

    private normalizeNetezzaUserPart(
        value: string | undefined,
        databaseKind: DatabaseKind | undefined,
    ): string | undefined {
        if (value === undefined) {
            return undefined;
        }
        return databaseKind === 'netezza'
            ? createNetezzaUserIdentifier(value).value
            : value;
    }

    private buildMetadataSchemaCacheKey(
        connectionName: string,
        database: string,
        schema?: string,
    ): string {
        const databaseKind = this.connectionManager.getConnectionDatabaseKind(connectionName);
        if (databaseKind !== 'netezza') {
            return buildSchemaCacheKey(database, schema);
        }
        return buildNetezzaDbSchemaCacheKey(
            database,
            schema,
        );
    }

    private buildMetadataCacheDatabaseName(
        connectionName: string,
        database: string,
    ): string {
        const databaseKind = this.connectionManager.getConnectionDatabaseKind(connectionName);
        return databaseKind === 'netezza'
            ? buildNetezzaCacheDatabasePart(createNetezzaUserIdentifier(database).value)
            : database;
    }

    private buildMetadataColumnCacheKey(
        connectionName: string,
        database: string,
        schema: string | undefined,
        table: string,
    ): string {
        const databaseKind = this.connectionManager.getConnectionDatabaseKind(connectionName);
        const normalizedDatabase = databaseKind === 'netezza'
            ? buildNetezzaCacheDatabasePart(database)
            : database;
        return buildColumnCacheKey(
            normalizedDatabase,
            this.normalizeNetezzaUserPart(schema, databaseKind),
            this.normalizeNetezzaUserPart(table, databaseKind) ?? table,
            { preserveCase: true },
        );
    }

    private async waitForConnectionMetadataReady(connectionName: string): Promise<void> {
        const cacheWithReadiness = this.metadataCache as MetadataCache & {
            whenConnectionMetadataReady?: (name: string) => Promise<void>;
        };
        if (typeof cacheWithReadiness.whenConnectionMetadataReady === 'function') {
            await cacheWithReadiness.whenConnectionMetadataReady(connectionName);
            return;
        }

        // Keep lightweight test doubles and older embedders compatible while
        // the concrete MetadataCache uses the stronger startup barrier.
        await this.metadataCache.whenConnectionMetadataHydrated?.(connectionName);
    }

    /**
     * Get all databases for a connection
     */
    async getDatabases(connectionName?: string): Promise<vscode.CompletionItem[]> {
        if (!connectionName) return [];

        await this.connectionManager.ensureFullyLoaded();
        await this.waitForConnectionMetadataReady(connectionName);
        const cached = this.metadataCache.getDatabases(connectionName);
        if (cached) {
            return cached.map((item) => {
                const ci = new vscode.CompletionItem(item.label || item.DATABASE, item.kind || vscode.CompletionItemKind.Module);
                ci.detail = item.detail;
                ci.insertText = this.formatMetadataIdentifier(
                    item.label || item.DATABASE,
                    this.connectionManager.getConnectionDatabaseKind(connectionName),
                );
                return ci;
            });
        }

        try {
            const query = this.getMetadataProvider(connectionName).buildListDatabasesQuery();
            const result = await runQueryRaw({
                context: this.context,
                query,
                silent: true,
                connectionManager: this.connectionManager,
                connectionName,
                isUserQuery: false,
                timeoutSeconds: METADATA_QUERY_TIMEOUT_SECONDS,
            });
            if (!result) return [];

            const results = queryResultToRows<{ DATABASE: string }>(result);
            const items: DatabaseMetadata[] = results.map(row => ({
                DATABASE: row.DATABASE,
                label: row.DATABASE,
                kind: 9, // Module
                detail: 'Database'
            }));

            this.metadataCache.setDatabases(connectionName, items);

            return items.map(item => {
                const ci = new vscode.CompletionItem(item.label!, item.kind);
                ci.detail = item.detail;
                return ci;
            });
        } catch (e: unknown) {
            logWithFallback('error', 'Error', e);
            return [];
        }
    }

    /**
     * Get all schemas for a database
     */
    async getSchemas(connectionName: string | undefined, dbName: string): Promise<vscode.CompletionItem[]> {
        if (!connectionName) return [];

        await this.connectionManager.ensureFullyLoaded();
        await this.waitForConnectionMetadataReady(connectionName);
        const cacheDatabase = this.buildMetadataCacheDatabaseName(connectionName, dbName);
        const cached = this.metadataCache.getSchemas(connectionName, cacheDatabase);
        if (cached) {
            return cached.map((item) => {
                const ci = new vscode.CompletionItem(item.label || item.SCHEMA, item.kind || vscode.CompletionItemKind.Folder);
                ci.detail = item.detail;
                ci.insertText = item.insertText;
                ci.sortText = item.sortText;
                ci.filterText = item.filterText;
                return ci;
            });
        }

        const statusBarDisposable = vscode.window.setStatusBarMessage(`Fetching schemas for ${dbName}...`);
        try {
            const query = this.getMetadataProvider(connectionName).buildListSchemasQuery(dbName);
            const result = await runQueryRaw({
                context: this.context,
                query,
                silent: true,
                connectionManager: this.connectionManager,
                connectionName,
                isUserQuery: false,
                timeoutSeconds: METADATA_QUERY_TIMEOUT_SECONDS,
            });
            if (!result) {
                return [];
            }

            const results = queryResultToRows<{ SCHEMA: string | null }>(result);
            const items: SchemaMetadata[] = results
                .filter(row => row.SCHEMA != null && row.SCHEMA !== '')
                .map(row => {
                    const schemaName = row.SCHEMA!;
                    return {
                        SCHEMA: schemaName,
                        label: schemaName,
                        kind: 19, // Folder
                        detail: `Schema in ${dbName}`,
                        insertText: schemaName,
                        sortText: schemaName,
                        filterText: schemaName
                    };
                });

            this.metadataCache.setSchemas(connectionName, cacheDatabase, items);

            return items.map(item => {
                const ci = new vscode.CompletionItem(item.label!, item.kind);
                ci.detail = item.detail;
                ci.insertText = item.insertText;
                if (this.connectionManager.getConnectionDatabaseKind(connectionName) === 'netezza') {
                    ci.insertText = this.formatMetadataIdentifier(item.label!, 'netezza');
                }
                ci.sortText = item.sortText;
                ci.filterText = item.filterText;
                return ci;
            });
        } catch (e: unknown) {
            logWithFallback('error', '[MetadataProvider] Error in getSchemas:', e);
            return [];
        } finally {
            statusBarDisposable.dispose();
        }
    }

    /**
     * Get all tables for a database/schema
     */
    async getTables(
        connectionName: string | undefined,
        dbName: string,
        schemaName?: string
    ): Promise<vscode.CompletionItem[]> {
        if (!connectionName) return [];

        await this.connectionManager.ensureFullyLoaded();
        await this.waitForConnectionMetadataReady(connectionName);
        const cacheDatabase = this.buildMetadataCacheDatabaseName(connectionName, dbName);
        const cacheSchema = this.normalizeNetezzaUserPart(
            schemaName,
            this.connectionManager.getConnectionDatabaseKind(connectionName),
        );
        const cacheKey = this.buildMetadataSchemaCacheKey(connectionName, dbName, schemaName);

        const cached = getTablesForScope(
            this.metadataCache,
            connectionName,
            cacheDatabase,
            cacheSchema,
        );

        if (cached) {
            const cachedWithSystemCatalog = schemaName
                ? cached
                : await this.mergeMirroredSystemCatalogObjects(connectionName, dbName, cached);

            if (!schemaName && cachedWithSystemCatalog.length !== cached.length) {
                this.metadataCache.setTables(
                    connectionName,
                    cacheKey,
                    cachedWithSystemCatalog,
                    this.buildTableIdMapForCacheKey(connectionName, dbName, undefined, cachedWithSystemCatalog)
                );
            }

            return this.createTableCompletionItems(
                cachedWithSystemCatalog,
                this.connectionManager.getConnectionDatabaseKind(connectionName),
            );
        }

        const statusBarMessage = schemaName
            ? `Fetching tables for ${dbName}.${schemaName}...`
            : `Fetching tables for ${dbName}...`;
        const statusBarDisposable = vscode.window.setStatusBarMessage(statusBarMessage);

        try {
            const query = this.getMetadataProvider(connectionName).buildListTablesQuery(dbName, schemaName);

            const result = await runQueryRaw({
                context: this.context,
                query,
                silent: true,
                connectionManager: this.connectionManager,
                connectionName,
                isUserQuery: false,
                timeoutSeconds: METADATA_QUERY_TIMEOUT_SECONDS,
            });
            if (!result) return [];

            const results = queryResultToRows<{ OBJNAME: string; OBJID: number; OBJTYPE: string; SCHEMA?: string; DESCRIPTION?: string; REFOBJNAME?: string }>(result);
            const items: TableMetadata[] = results.map(row => {
                const label = row.OBJNAME;
                const schema = row.SCHEMA || schemaName;
                const normalizedObjectType = row.OBJTYPE?.toUpperCase() || 'TABLE';
                const isView = normalizedObjectType === 'VIEW';
                const kind = isView ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Class;
                const typeLabel =
                    normalizedObjectType === 'NICKNAME'
                        ? 'Nickname'
                        : normalizedObjectType === 'ALIAS'
                            ? 'Alias'
                            : normalizedObjectType === 'SYNONYM'
                                ? 'Synonym'
                            : isView
                                ? 'View'
                                : 'Table';

                return {
                    OBJNAME: row.OBJNAME,
                    TABLENAME: row.OBJNAME,
                    OBJID: row.OBJID,
                    SCHEMA: schema,
                    label: label,
                    kind: kind,
                    objType: normalizedObjectType,
                    detail: schemaName ? typeLabel : (schema ? `${typeLabel} (${schema})` : typeLabel),
                    sortText: row.OBJNAME,
                    DESCRIPTION: normalizeCompletionDescription(row.DESCRIPTION),
                    REFOBJNAME: row.REFOBJNAME
                };
            });

            const itemsWithSystemCatalog = schemaName
                ? items
                : await this.mergeMirroredSystemCatalogObjects(connectionName, dbName, items);

            this.metadataCache.setTables(
                connectionName,
                cacheKey,
                itemsWithSystemCatalog,
                this.buildTableIdMapForCacheKey(connectionName, dbName, schemaName, itemsWithSystemCatalog)
            );

            return this.createTableCompletionItems(
                itemsWithSystemCatalog,
                this.connectionManager.getConnectionDatabaseKind(connectionName),
            );
        } catch (e: unknown) {
            logWithFallback('error', 'Error', e);
            return [];
        } finally {
            statusBarDisposable.dispose();
        }
    }

    /**
     * Get views for a database/schema
     */
    async getViews(
        connectionName: string | undefined,
        dbName: string,
        schemaName?: string
    ): Promise<vscode.CompletionItem[]> {
        if (!connectionName) return [];

        await this.connectionManager.ensureFullyLoaded();
        await this.waitForConnectionMetadataReady(connectionName);
        const cacheDatabase = this.buildMetadataCacheDatabaseName(connectionName, dbName);
        const cacheSchema = this.normalizeNetezzaUserPart(
            schemaName,
            this.connectionManager.getConnectionDatabaseKind(connectionName),
        );
        const cacheKey = this.buildMetadataSchemaCacheKey(connectionName, dbName, schemaName);
        const cached = getTablesForScope(
            this.metadataCache,
            connectionName,
            cacheDatabase,
            cacheSchema,
        );

        const databaseKind = this.connectionManager.getConnectionDatabaseKind(connectionName);
        const toCompletionItems = (items: TableMetadata[]): vscode.CompletionItem[] =>
            items
                .filter(item => {
                    const detailText = (item.detail || '').toUpperCase();
                    return (
                        (item.objType || '').toUpperCase() === 'VIEW'
                        || detailText.startsWith('VIEW')
                        || (detailText.length === 0 && (item.kind === 18 || item.kind === vscode.CompletionItemKind.Interface))
                    );
                })
                .map(item => {
                    const label = typeof item.label === 'string' ? item.label : (item.label?.label || item.OBJNAME || '?');
                    const ci = new vscode.CompletionItem(label, vscode.CompletionItemKind.Interface);
                    ci.insertText = this.formatMetadataIdentifier(label, databaseKind);
                    const schemaSuffix = schemaName ? '' : (item.SCHEMA ? ` (${item.SCHEMA})` : '');
                    const detail = `View${schemaSuffix}`;
                    this.applySuggestDescription(ci, label, detail, item.DESCRIPTION);
                    ci.sortText = item.sortText || label;
                    return ci;
                });

        if (cached) {
            const cachedWithSystemCatalog = schemaName
                ? cached
                : await this.mergeMirroredSystemCatalogObjects(connectionName, dbName, cached)
                    .catch(() => cached);
            const cachedViews = toCompletionItems(cachedWithSystemCatalog);
            if (cachedViews.length > 0) {
                return cachedViews;
            }
            if (this.metadataCache.isViewsCatalogLoaded(connectionName, cacheKey)) {
                return [];
            }
            if (
                !schemaName
                && this.metadataCache.areViewsCatalogLoadedForDatabase(
                    connectionName,
                    dbName,
                )
            ) {
                return [];
            }
            // Cache has objects but views not yet enumerated for this scope — fetch below.
        }

        const statusBarMessage = schemaName
            ? `Fetching views for ${dbName}.${schemaName}...`
            : `Fetching views for ${dbName}...`;
        const statusBarDisposable = vscode.window.setStatusBarMessage(statusBarMessage);

        try {
            const query = this.getMetadataProvider(connectionName).buildListViewsQuery(dbName, schemaName);

            const result = await runQueryRaw({
                context: this.context,
                query,
                silent: true,
                connectionManager: this.connectionManager,
                connectionName,
                isUserQuery: false,
                timeoutSeconds: METADATA_QUERY_TIMEOUT_SECONDS,
            });
            if (!result) return [];

            const results = queryResultToRows<{ OBJNAME: string; SCHEMA?: string; DESCRIPTION?: string }>(result);
            const viewItems: TableMetadata[] = results.map(row => ({
                OBJNAME: row.OBJNAME,
                TABLENAME: row.OBJNAME,
                SCHEMA: row.SCHEMA || schemaName,
                label: row.OBJNAME,
                kind: vscode.CompletionItemKind.Interface,
                objType: 'VIEW',
                detail: schemaName ? 'View' : `View${row.SCHEMA ? ` (${row.SCHEMA})` : ''}`,
                sortText: row.OBJNAME,
                DESCRIPTION: normalizeCompletionDescription(row.DESCRIPTION)
            }));

            const itemsWithSystemCatalog = schemaName
                ? viewItems
                : await this.mergeMirroredSystemCatalogObjects(connectionName, dbName, viewItems);

            const mergedTableLikeItems = mergeAndSetTables(
                this.metadataCache,
                connectionName,
                cacheKey,
                itemsWithSystemCatalog,
                'VIEW',
                (merged) =>
                    this.buildTableIdMapForCacheKey(connectionName, dbName, schemaName, merged),
            );
            this.metadataCache.markViewsCatalogLoaded(connectionName, cacheKey);

            return toCompletionItems(mergedTableLikeItems);
        } catch (e: unknown) {
            logWithFallback('error', 'Error', e);
            return [];
        } finally {
            statusBarDisposable.dispose();
        }
    }

    /**
     * Get relation-like objects that can be used directly after FROM/JOIN.
     * Oracle uses this for materialized views and synonyms in addition to
     * regular tables and views.
     */
    async getSourceObjects(
        connectionName: string | undefined,
        dbName: string,
        schemaName?: string,
    ): Promise<vscode.CompletionItem[]> {
        if (!connectionName) return [];

        await this.connectionManager.ensureFullyLoaded();
        await this.waitForConnectionMetadataReady(connectionName);

        const metadataProvider = this.getMetadataProvider(connectionName);
        const queryBuilder = metadataProvider.buildListSourceObjectsQuery;
        if (!queryBuilder) {
            return [
                ...(await this.getTables(connectionName, dbName, schemaName)),
                ...(await this.getViews(connectionName, dbName, schemaName)),
            ];
        }

        const cacheKey = this.buildMetadataSchemaCacheKey(connectionName, dbName, schemaName);
        const statusBarMessage = schemaName
            ? `Fetching source objects for ${dbName}.${schemaName}...`
            : `Fetching source objects for ${dbName}...`;
        const statusBarDisposable = vscode.window.setStatusBarMessage(statusBarMessage);

        try {
            const result = await runQueryRaw({
                context: this.context,
                query: queryBuilder.call(metadataProvider, dbName, schemaName),
                silent: true,
                connectionManager: this.connectionManager,
                connectionName,
                isUserQuery: false,
                timeoutSeconds: METADATA_QUERY_TIMEOUT_SECONDS,
            });
            if (!result) return [];

            const results = queryResultToRows<{
                OBJNAME: string;
                OBJID?: number;
                OBJTYPE?: string;
                SCHEMA?: string;
                DESCRIPTION?: string;
                OWNER?: string;
                TARGET_SCHEMA?: string;
                TARGET_NAME?: string;
                DB_LINK?: string;
            }>(result);
            const items: TableMetadata[] = results
                .filter((row) => !!row.OBJNAME)
                .map((row) => {
                    const normalizedObjectType = row.OBJTYPE?.trim().toUpperCase() || 'TABLE';
                    const isView = normalizedObjectType.includes('VIEW');
                    const typeLabel = normalizedObjectType === 'MATERIALIZED VIEW'
                        ? 'Materialized view'
                        : normalizedObjectType === 'SYNONYM'
                            ? row.OWNER?.toUpperCase() === 'PUBLIC' ? 'Public synonym' : 'Synonym'
                            : isView ? 'View' : 'Table';
                    const targetDetail = normalizedObjectType === 'SYNONYM' && row.TARGET_NAME
                        ? ` → ${row.TARGET_SCHEMA ? `${row.TARGET_SCHEMA}.` : ''}${row.TARGET_NAME}${row.DB_LINK ? `@${row.DB_LINK}` : ''}`
                        : '';

                    return {
                        OBJNAME: row.OBJNAME,
                        TABLENAME: row.OBJNAME,
                        OBJID: row.OBJID,
                        SCHEMA: row.SCHEMA || schemaName,
                        OWNER: row.OWNER,
                        label: row.OBJNAME,
                        kind: normalizedObjectType === 'SYNONYM'
                            ? vscode.CompletionItemKind.Reference
                            : isView
                                ? vscode.CompletionItemKind.Interface
                                : vscode.CompletionItemKind.Class,
                        objType: normalizedObjectType,
                        detail: `${typeLabel}${schemaName ? '' : row.SCHEMA ? ` (${row.SCHEMA})` : ''}${targetDetail}`,
                        sortText: row.OBJNAME,
                        DESCRIPTION: normalizeCompletionDescription(row.DESCRIPTION),
                        TARGET_SCHEMA: row.TARGET_SCHEMA,
                        TARGET_NAME: row.TARGET_NAME,
                        DB_LINK: row.DB_LINK,
                    };
                });

            this.metadataCache.setTables(
                connectionName,
                cacheKey,
                items,
                this.buildTableIdMapForCacheKey(connectionName, dbName, schemaName, items),
            );

            return this.createTableCompletionItems(
                items,
                this.connectionManager.getConnectionDatabaseKind(connectionName),
            );
        } catch (e: unknown) {
            logWithFallback('error', '[MetadataProvider] Error in getSourceObjects:', e);
            return [];
        } finally {
            statusBarDisposable.dispose();
        }
    }

    /**
     * Get procedures for a database/schema
     */
    async getProcedures(
        connectionName: string | undefined,
        dbName: string,
        schemaName?: string
    ): Promise<vscode.CompletionItem[]> {
        if (!connectionName) return [];

        await this.connectionManager.ensureFullyLoaded();
        await this.waitForConnectionMetadataReady(connectionName);
        const cacheDatabase = this.buildMetadataCacheDatabaseName(connectionName, dbName);
        const cacheKey = this.buildMetadataSchemaCacheKey(connectionName, dbName, schemaName);
        const cached = schemaName
            ? this.metadataCache.getProcedures(connectionName, cacheKey)
            : this.metadataCache.getProceduresForDatabase(connectionName, cacheDatabase);

        const toCompletionItems = (items: ProcedureMetadata[]): vscode.CompletionItem[] =>
            items.map(item => {
                const label = typeof item.label === 'string' ? item.label : item.PROCEDURESIGNATURE || item.PROCEDURE;
                const ci = new vscode.CompletionItem(label, item.kind || vscode.CompletionItemKind.Function);
                ci.detail = item.detail || (item.SCHEMA ? `Procedure (${item.SCHEMA})` : 'Procedure');
                ci.sortText = item.sortText || label;
                return ci;
            });

        if (cached) {
            return toCompletionItems(cached);
        }

        const statusBarMessage = schemaName
            ? `Fetching procedures for ${dbName}.${schemaName}...`
            : `Fetching procedures for ${dbName}...`;
        const statusBarDisposable = vscode.window.setStatusBarMessage(statusBarMessage);

        try {
            const query = this.getMetadataProvider(connectionName).buildListProceduresQuery(dbName, schemaName);

            const result = await runWithMetadataQueryConcurrencyLimit(connectionName, () =>
                runQueryRaw({
                    context: this.context,
                    query,
                    silent: true,
                    connectionManager: this.connectionManager,
                    connectionName,
                    isUserQuery: false,
                    timeoutSeconds: METADATA_QUERY_TIMEOUT_SECONDS,
                }),
            );

            if (!result) return [];

            const results = queryResultToRows<{
                SCHEMA?: string | null;
                PROCEDURE?: string | null;
                PROCEDURESIGNATURE?: string | null;
                OWNER?: string | null;
                DATABASE?: string | null;
            }>(result);

            const proceduresByKey = new Map<string, ProcedureMetadata[]>();
            const allProcedures: ProcedureMetadata[] = [];

            for (const row of results) {
                const procedureName = row.PROCEDURE?.trim();
                if (!procedureName) {
                    continue;
                }

                const normalizedSchema = row.SCHEMA?.trim() || '';
                const signature = row.PROCEDURESIGNATURE?.trim();
                const label = signature && signature.length > 0 ? signature : procedureName;
                const key = buildSchemaCacheKey(dbName, normalizedSchema || undefined);

                const item: ProcedureMetadata = {
                    PROCEDURE: procedureName,
                    PROCEDURESIGNATURE: signature && signature.length > 0 ? signature : undefined,
                    SCHEMA: normalizedSchema || undefined,
                    OWNER: row.OWNER || undefined,
                    DATABASE: row.DATABASE || dbName,
                    label: label,
                    kind: vscode.CompletionItemKind.Function,
                    detail: normalizedSchema ? `Procedure (${normalizedSchema})` : 'Procedure',
                    sortText: label
                };

                if (!proceduresByKey.has(key)) {
                    proceduresByKey.set(key, []);
                }
                proceduresByKey.get(key)!.push(item);
                allProcedures.push(item);
            }

            if (schemaName) {
                const schemaItems = proceduresByKey.get(cacheKey) || [];
                this.metadataCache.setProcedures(connectionName, cacheKey, schemaItems);
                return toCompletionItems(schemaItems);
            }

            for (const [key, items] of proceduresByKey) {
                if (key !== cacheKey) {
                    this.metadataCache.setProcedures(connectionName, key, items);
                }
            }
            this.metadataCache.setProcedures(connectionName, cacheKey, allProcedures);

            return toCompletionItems(allProcedures);
        } catch (e: unknown) {
            logWithFallback('error', 'Error', e);
            return [];
        } finally {
            statusBarDisposable.dispose();
        }
    }

    /**
     * Get columns for a table
     */
    async getColumns(
        connectionName: string | undefined,
        dbName: string | undefined,
        schemaName: string | undefined,
        tableName: string,
        options?: MetadataColumnLookupOptions,
    ): Promise<vscode.CompletionItem[]> {
        const items = await this.getTableColumnsMetadata(
            connectionName,
            dbName,
            schemaName,
            tableName,
            options,
        );
        return items.map(item => this.createColumnCompletionItem(item));
    }

    /**
     * Get column metadata for a table
     */
    async getTableColumnsMetadata(
        connectionName: string | undefined,
        dbName: string | undefined,
        schemaName: string | undefined,
        tableName: string,
        options?: MetadataColumnLookupOptions,
        visited = new Set<string>(),
    ): Promise<ColumnMetadata[]> {
        if (!connectionName) return [];

        const connectionKind = this.getConnectionDatabaseKind(connectionName);
        const normalizedDbName = connectionKind === 'netezza'
            ? this.normalizeNetezzaUserPart(dbName, connectionKind)
            : dbName ? stripIdentifierQuoting(dbName, connectionKind) : dbName;
        const normalizedSchemaName = connectionKind === 'file'
            ? stripIdentifierQuoting(schemaName || 'main', connectionKind)
            : connectionKind === 'netezza'
                ? this.normalizeNetezzaUserPart(schemaName, connectionKind)
                : schemaName ? stripIdentifierQuoting(schemaName, connectionKind) : schemaName;
        const normalizedTableName = connectionKind === 'netezza'
            ? this.normalizeNetezzaUserPart(tableName, connectionKind) ?? tableName
            : stripIdentifierQuoting(tableName, connectionKind);
        const recursionKey = connectionKind === 'netezza'
            ? `${normalizedDbName || 'CURRENT'}|${normalizedSchemaName || ''}|${normalizedTableName}`
            : `${(normalizedDbName || 'CURRENT').toUpperCase()}|${(normalizedSchemaName || '').toUpperCase()}|${normalizedTableName.toUpperCase()}`;
        const queryDbName = connectionKind === 'netezza' && dbName
            ? formatNetezzaIdentifier(createNetezzaUserIdentifier(dbName))
            : normalizedDbName;
        const querySchemaName = connectionKind === 'netezza' && schemaName
            ? formatNetezzaIdentifier(createNetezzaUserIdentifier(schemaName))
            : normalizedSchemaName;
        const queryTableName = connectionKind === 'netezza'
            ? formatNetezzaIdentifier(createNetezzaUserIdentifier(tableName))
            : normalizedTableName;

        if (visited.has(recursionKey)) {
            return [];
        }
        visited.add(recursionKey);

        try {
            await this.connectionManager.ensureFullyLoaded();
            await this.waitForConnectionMetadataReady(connectionName);
            const metadataProvider = this.tryGetMetadataProvider(connectionName);
            const mirroredSystemCatalog = metadataProvider?.mirroredSystemCatalog;
            const shouldMirrorSystemCatalog = !normalizedSchemaName && mirroredSystemCatalog?.isMirroredObjectName(normalizedTableName) === true;
            const metadataDbName = shouldMirrorSystemCatalog ? mirroredSystemCatalog?.sourceDatabase : normalizedDbName;
            const effectiveQueryDbName = shouldMirrorSystemCatalog && metadataDbName
                ? connectionKind === 'netezza'
                    ? formatNetezzaIdentifier(createNetezzaCatalogIdentifier(metadataDbName))
                    : metadataDbName
                : queryDbName;
            const effectiveQuerySchemaName = shouldMirrorSystemCatalog
                ? undefined
                : querySchemaName;
            const cachedObjectSchema = connectionKind === 'netezza' && !normalizedSchemaName && metadataDbName
                ? this.metadataCache.findObjectWithType(
                    connectionName,
                    metadataDbName,
                    undefined,
                    normalizedTableName,
                )?.schema
                : undefined;
            const cacheResolvedSchemaName = normalizedSchemaName || cachedObjectSchema;
            let objId: number | undefined;

            const lookupKey =
                cacheResolvedSchemaName && metadataDbName
                    ? `${metadataDbName}.${cacheResolvedSchemaName}.${normalizedTableName}`
                    : metadataDbName
                        ? `${metadataDbName}..${normalizedTableName}`
                        : undefined;

            if (lookupKey) {
                objId = this.metadataCache.findTableId(connectionName, lookupKey);
            }

            const preserveColumnKeyCase = connectionKind !== 'netezza';
            const cacheKey = normalizedDbName
                ? this.buildMetadataColumnCacheKey(
                    connectionName,
                    normalizedDbName,
                    normalizedSchemaName,
                    normalizedTableName,
                )
                : buildColumnCacheKey(
                    'CURRENT',
                    normalizedSchemaName,
                    normalizedTableName,
                    { preserveCase: preserveColumnKeyCase },
                );
            const diskCacheKey = normalizedDbName
                ? this.buildMetadataColumnCacheKey(
                    connectionName,
                    normalizedDbName,
                    cacheResolvedSchemaName,
                    normalizedTableName,
                )
                : cacheKey;
            if (normalizedDbName) {
                if (typeof this.metadataCache.ensureColumnsLoadedForTableKey === 'function') {
                    await this.metadataCache.ensureColumnsLoadedForTableKey(
                        connectionName,
                        diskCacheKey,
                    );
                } else {
                    await this.metadataCache.ensureColumnsLoaded(
                        connectionName,
                        connectionKind === 'netezza'
                            ? buildNetezzaDatabaseCacheKey(normalizedDbName)
                            : normalizedDbName,
                    );
                }
            }
            const cached = this.metadataCache.getColumns(connectionName, cacheKey)
                || (diskCacheKey !== cacheKey
                    ? this.metadataCache.getColumns(connectionName, diskCacheKey)
                    : undefined);
            if (cached && (connectionKind !== 'file' || cached.length > 0)) {
                if (diskCacheKey !== cacheKey) {
                    this.metadataCache.setColumns(connectionName, cacheKey, cached);
                }
                return cached;
            }

            // When schema is not specified (double-dot pattern), try to find columns from any schema
            if (!normalizedSchemaName && normalizedDbName) {
                const cachedAny = this.metadataCache.getColumnsAnySchema(connectionName, normalizedDbName, normalizedTableName);
                if (cachedAny) {
                    return cachedAny;
                }
            }

            if (shouldMirrorSystemCatalog) {
                const cachedMirroredColumns =
                    this.metadataCache.getColumns(
                        connectionName,
                        metadataDbName
                            ? this.buildMetadataColumnCacheKey(
                                connectionName,
                                metadataDbName,
                                normalizedSchemaName,
                                normalizedTableName,
                            )
                            : cacheKey,
                    ) ||
                    (metadataDbName
                        ? this.metadataCache.getColumnsAnySchema(connectionName, metadataDbName, normalizedTableName)
                        : undefined);

                if (cachedMirroredColumns) {
                    this.metadataCache.setColumns(connectionName, cacheKey, cachedMirroredColumns);
                    return cachedMirroredColumns;
                }
            }

            if (options?.allowDatabaseFetch === false) {
                logWithFallback(
                    'debug',
                    `[MetadataProvider] Cache-only column lookup miss for ${connectionName}/${normalizedDbName ?? 'CURRENT'}.${normalizedSchemaName ?? ''}.${normalizedTableName}; source=${options.requestSource ?? 'unknown'}`,
                );
                return [];
            }

            if (connectionKind === 'netezza' && normalizedDbName) {
                const synonymTarget = await this.resolveNetezzaSynonymReference(
                    connectionName,
                    normalizedDbName,
                    normalizedSchemaName,
                    normalizedTableName
                );
                if (synonymTarget) {
                    const synonymColumns = await this.getTableColumnsMetadata(
                        connectionName,
                            synonymTarget.database,
                            synonymTarget.schema,
                            synonymTarget.table,
                            undefined,
                            visited
                    );
                    if (synonymColumns.length > 0) {
                        this.metadataCache.setColumns(connectionName, cacheKey, synonymColumns);
                        return synonymColumns;
                    }
                }
            }

            if (connectionKind === 'oracle' && normalizedDbName) {
                const cachedObject = this.metadataCache.findObjectWithType(
                    connectionName,
                    normalizedDbName,
                    normalizedSchemaName,
                    normalizedTableName,
                );
                const cachedType = cachedObject?.objType?.toUpperCase();
                if (!cachedType || cachedType === 'SYNONYM') {
                    const synonymTarget = await this.resolveOracleSynonymReference(
                        connectionName,
                        normalizedDbName,
                        normalizedSchemaName,
                        normalizedTableName,
                        options?.allowPublicSynonym === true,
                    );
                    if (synonymTarget) {
                        const synonymColumns = await this.getTableColumnsMetadata(
                            connectionName,
                            synonymTarget.database,
                            synonymTarget.schema,
                            synonymTarget.table,
                            undefined,
                            visited,
                        );
                        if (synonymColumns.length > 0) {
                            this.metadataCache.setColumns(connectionName, cacheKey, synonymColumns);
                            return synonymColumns;
                        }
                    }
                }
            }

            const inflightKey = `${connectionName}|${cacheKey}`;
            const inflight = this.columnFetchInFlight.get(inflightKey);
            if (inflight) {
                return inflight;
            }

            const fetchPromise = this.fetchTableColumnsFromDatabase(
                connectionName,
                cacheKey,
                normalizedDbName,
                cacheResolvedSchemaName,
                normalizedTableName,
                metadataDbName,
                shouldMirrorSystemCatalog,
                connectionKind,
                objId,
                tableName,
                options?.requestSource ?? 'schema-tree',
                effectiveQueryDbName,
                effectiveQuerySchemaName,
                queryTableName,
            );
            this.columnFetchInFlight.set(inflightKey, fetchPromise);

            try {
                return await fetchPromise;
            } finally {
                this.columnFetchInFlight.delete(inflightKey);
            }
        } catch (e: unknown) {
            logWithFallback('error', 'Error', e);
            return [];
        } finally {
            visited.delete(recursionKey);
        }
    }

    private async fetchTableColumnsFromDatabase(
        connectionName: string,
        cacheKey: string,
        normalizedDbName: string | undefined,
        normalizedSchemaName: string | undefined,
        normalizedTableName: string,
        metadataDbName: string | undefined,
        shouldMirrorSystemCatalog: boolean,
        connectionKind: DatabaseKind,
        objId: number | undefined,
        tableName: string,
        requestSource: MetadataRequestSource,
        queryDatabaseName: string | undefined,
        querySchemaName: string | undefined,
        queryTableName: string,
    ): Promise<ColumnMetadata[]> {
        if (this.metadataCache.isDatabaseDead(connectionName, normalizedDbName)) {
            return [];
        }

        const statusMsg = vscode.window.setStatusBarMessage(`Fetching columns for ${tableName}...`);

        try {
            let resolvedSchemaName = normalizedSchemaName;
            if (!resolvedSchemaName && normalizedDbName) {
                const cachedObject = this.metadataCache.findObjectWithType(
                    connectionName,
                    normalizedDbName,
                    undefined,
                    normalizedTableName,
                );
                resolvedSchemaName = cachedObject?.schema;
            }

            const effectiveSchema = resolvedSchemaName || '';
            const effectiveDb = metadataDbName || '';
            const cachedObject = effectiveDb && effectiveSchema
                ? this.metadataCache.findObjectWithType(
                    connectionName,
                    queryDatabaseName || effectiveDb,
                    querySchemaName || effectiveSchema,
                    queryTableName,
                )
                : undefined;
            const queryReason = cachedObject
                ? 'explicit-column-fetch'
                : 'column-cache-miss';

            let items: ColumnMetadata[];
            if (effectiveDb && effectiveSchema) {
                const parsed = await fetchTableColumnsWithFallback(
                    (columnQuery, queryKind: MetadataQueryKind = 'table-columns') => runWithMetadataQueryConcurrencyLimit(connectionName, (queueWaitMs) =>
                        runQueryRaw({
                            context: this.context,
                            query: columnQuery,
                            silent: true,
                            connectionManager: this.connectionManager,
                            connectionName,
                            isUserQuery: false,
                            timeoutSeconds: METADATA_QUERY_TIMEOUT_SECONDS,
                            metadataContext: {
                                source: requestSource,
                                kind: queryKind,
                                connectionName,
                                database: effectiveDb,
                                schema: effectiveSchema,
                                table: normalizedTableName,
                                reason: queryReason,
                            },
                            metadataQueueWaitMs: queueWaitMs,
                        }),
                    ),
                    effectiveDb,
                    effectiveSchema,
                    normalizedTableName,
                    connectionKind,
                    { objectType: cachedObject?.objType },
                );
                items = parsed.map(col => ({
                    ATTNAME: col.attname,
                    FORMAT_TYPE: col.formatType,
                    label: col.attname,
                    kind: 5,
                    detail: col.formatType,
                    isPk: col.isPk,
                    isFk: col.isFk,
                    isDistributionKey: col.isDistributionKey,
                    documentation: col.description
                }));
            } else {
                const query = this.buildSimpleColumnQuery(connectionName, {
                    database: queryDatabaseName || metadataDbName,
                    schema: querySchemaName || resolvedSchemaName,
                    tableName: queryTableName,
                    objectId: objId
                });
                const result = await runWithMetadataQueryConcurrencyLimit(connectionName, (queueWaitMs) =>
                    runQueryRaw({
                        context: this.context,
                        query,
                        silent: true,
                        connectionManager: this.connectionManager,
                        connectionName,
                        isUserQuery: false,
                        timeoutSeconds: METADATA_QUERY_TIMEOUT_SECONDS,
                        metadataContext: {
                            source: requestSource,
                            kind: 'table-columns',
                            connectionName,
                            database: effectiveDb,
                            schema: effectiveSchema,
                            table: normalizedTableName,
                            reason: queryReason,
                        },
                        metadataQueueWaitMs: queueWaitMs,
                    }),
                );
                if (!result) return [];
                const results = queryResultToRows<{
                    ATTNAME: string;
                    FORMAT_TYPE: string;
                    DESCRIPTION?: string;
                }>(result);
                items = results.map(row => ({
                    ATTNAME: row.ATTNAME,
                    FORMAT_TYPE: row.FORMAT_TYPE,
                    label: row.ATTNAME,
                    kind: 5,
                    detail: row.FORMAT_TYPE,
                    documentation: normalizeCompletionDescription(row.DESCRIPTION) || '',
                }));
            }

            // File SQL views are created when the in-memory connection starts.
            // Do not persist an empty result from a race with that setup: the
            // next completion request must be able to retry the same view.
            if (items.length > 0 || connectionKind !== 'file') {
                this.metadataCache.setColumns(connectionName, cacheKey, items);
            }
            if (shouldMirrorSystemCatalog && metadataDbName) {
                this.metadataCache.setColumns(
                    connectionName,
                    buildColumnCacheKey(
                        metadataDbName,
                        normalizedSchemaName,
                        normalizedTableName,
                        { preserveCase: connectionKind !== 'netezza' },
                    ),
                    items,
                );
            }

            this.scheduleColumnMetadataWarmup(connectionName, normalizedDbName);

            return items;
        } finally {
            statusMsg.dispose();
        }
    }

    private scheduleColumnMetadataWarmup(
        connectionName: string,
        normalizedDbName: string | undefined,
    ): void {
        if (!normalizedDbName || !this.supportsLegacyMetadataPrefetch(connectionName)) {
            return;
        }

        const context = this.context;
        const cache = this.metadataCache;
        const connectionManager = this.connectionManager;
        const runMetadataQuery = (q: string, metadataContext?: MetadataQueryContext) =>
            runQueryRaw({
                context,
                query: q,
                silent: true,
                connectionManager,
                connectionName,
                maxRows: 1000000,
                isUserQuery: false,
                timeoutSeconds: METADATA_QUERY_TIMEOUT_SECONDS,
                metadataContext,
            });

        setImmediate(() => {
            try {
                if (!cache.isConnectionPrefetchFresh(connectionName)) {
                    // Backoff: after a failed/slow prefetch, do not immediately
                    // retrigger the full prefetch on every cache miss — that
                    // floods the database with heavy catalog queries. Warm only
                    // the requested database columns until the backoff elapses.
                    const lastAttempt = cache.getLastPrefetchAttemptTime?.(connectionName);
                    if (lastAttempt !== undefined && Date.now() - lastAttempt < PREFETCH_RETRY_BACKOFF_MS) {
                        void cache.prefetchColumnsForDatabase(connectionName, normalizedDbName, runMetadataQuery);
                        return;
                    }
                    cache.triggerConnectionPrefetch(
                        connectionName,
                        createConnectionScopedMetadataQueryRunner({
                            context,
                            connectionManager,
                            connectionName,
                            maxRows: 1000000,
                            timeoutSeconds: METADATA_QUERY_TIMEOUT_SECONDS,
                        }),
                    );
                    return;
                }

                void cache.prefetchColumnsForDatabase(connectionName, normalizedDbName, runMetadataQuery);
            } catch (e: unknown) {
                logWithFallback('error', '[MetadataProvider] Column metadata warmup error:', e);
            }
        });
    }

    /**
     * Batch-warm column metadata for databases (one listColumnsWithKeys per DB).
     */
    async warmDatabaseColumns(
        connectionName: string,
        databases: string[],
    ): Promise<void> {
        if (databases.length === 0) {
            return;
        }
        if (!this.supportsLegacyMetadataPrefetch(connectionName)) {
            return;
        }

        const uniqueDatabases = Array.from(new Set(databases.map(db => db.trim()).filter(Boolean)));
        const runMetadataQuery = (q: string, metadataContext?: MetadataQueryContext) =>
            runQueryRaw({
                context: this.context,
                query: q,
                silent: true,
                connectionManager: this.connectionManager,
                connectionName,
                maxRows: 1000000,
                isUserQuery: false,
                timeoutSeconds: METADATA_QUERY_TIMEOUT_SECONDS,
                metadataContext,
            });

        const prefetchFresh =
            this.metadataCache.isConnectionPrefetchFresh(connectionName);

        const concurrencyLimit = getMetadataQueryConcurrencyLimit();
        for (let i = 0; i < uniqueDatabases.length; i += concurrencyLimit) {
            const batch = uniqueDatabases.slice(i, i + concurrencyLimit);
            await Promise.all(
                batch.map(dbName =>
                    this.metadataCache.prefetchColumnsForDatabase(connectionName, dbName, runMetadataQuery)
                ),
            );
        }

        if (!prefetchFresh) {
            this.metadataCache.triggerConnectionPrefetch(
                connectionName,
                createConnectionScopedMetadataQueryRunner({
                    context: this.context,
                    connectionManager: this.connectionManager,
                    connectionName,
                    maxRows: 1000000,
                    timeoutSeconds: METADATA_QUERY_TIMEOUT_SECONDS,
                }),
            );
        }
    }

    /**
     * Build simple column query for cases when we don't have full database and schema info
     */
    private buildSimpleColumnQuery(
        connectionName: string,
        params: {
            database?: string;
            schema?: string;
            tableName: string;
            objectId?: number;
        }
    ): string {
        return this.getMetadataProvider(connectionName).buildLookupColumnsQuery(params);
    }

    private applySuggestDescription(
        ci: vscode.CompletionItem,
        label: string,
        detail: string | undefined,
        description: string | undefined,
    ): void {
        const documentation = normalizeCompletionDescription(description);
        if (!documentation) {
            ci.detail = detail;
            return;
        }
        ci.documentation = new vscode.MarkdownString(documentation);
        ci.label = {
            label,
            detail,
            description: toInlineCompletionDescription(documentation),
        };
    }

    private createTableCompletionItems(
        items: TableMetadata[],
        databaseKind?: ReturnType<ConnectionManager['getConnectionDatabaseKind']>,
    ): vscode.CompletionItem[] {
        return items.map(item => {
            const label = typeof item.label === 'string' ? item.label : (item.label?.label || item.OBJNAME || item.TABLENAME || '?');
            const detailText = (item.detail || '').toUpperCase();
            const objectType = (item.objType || '').toUpperCase();
            const isView =
                objectType === 'VIEW'
                || objectType === 'MATERIALIZED VIEW'
                || detailText.startsWith('VIEW')
                || detailText.startsWith('MATERIALIZED VIEW')
                || (detailText.length === 0 && (item.kind === 18 || item.kind === vscode.CompletionItemKind.Interface));
            const ci = new vscode.CompletionItem(
                label,
                objectType === 'SYNONYM'
                    ? vscode.CompletionItemKind.Reference
                    : isView ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Class
            );
            ci.insertText = this.formatMetadataIdentifier(label, databaseKind);
            this.applySuggestDescription(ci, label, item.detail, item.DESCRIPTION);
            ci.sortText = item.sortText;
            return ci;
        });
    }

    private async mergeMirroredSystemCatalogObjects(
        connectionName: string,
        dbName: string,
        items: TableMetadata[]
    ): Promise<TableMetadata[]> {
        const mirroredSystemCatalog = this.tryGetMetadataProvider(connectionName)?.mirroredSystemCatalog;
        if (!mirroredSystemCatalog || dbName.toUpperCase() === mirroredSystemCatalog.sourceDatabase) {
            return items;
        }

        const mirroredSystemCatalogItems = await this.getMirroredSystemCatalogObjects(connectionName);
        if (mirroredSystemCatalogItems.length === 0) {
            return items;
        }

        const mergedItems = [...items];
        const seenNames = new Set(
            items
                .map(item => this.getTableMetadataName(item)?.toUpperCase())
                .filter((name): name is string => !!name)
        );

        for (const item of mirroredSystemCatalogItems) {
            const name = this.getTableMetadataName(item);
            if (!name) {
                continue;
            }

            const upperName = name.toUpperCase();
            if (seenNames.has(upperName)) {
                continue;
            }

            seenNames.add(upperName);
            mergedItems.push({
                ...item,
                SCHEMA: undefined
            });
        }

        return mergedItems;
    }

    private async getMirroredSystemCatalogObjects(connectionName: string): Promise<TableMetadata[]> {
        const mirroredSystemCatalog = this.tryGetMetadataProvider(connectionName)?.mirroredSystemCatalog;
        if (!mirroredSystemCatalog) {
            return [];
        }

        const cacheKey = buildSchemaCacheKey(
            mirroredSystemCatalog.sourceDatabase,
        );
        const cachedSystemObjects = getTablesForScope(
            this.metadataCache,
            connectionName,
            mirroredSystemCatalog.sourceDatabase,
        );
        const filteredCachedObjects = this.filterSystemCatalogObjects(connectionName, cachedSystemObjects);
        if (filteredCachedObjects.length > 0) {
            return filteredCachedObjects;
        }

        const query = mirroredSystemCatalog.buildMirroredObjectsQuery();

        const result = await runQueryRaw({
            context: this.context,
            query,
            silent: true,
            connectionManager: this.connectionManager,
            connectionName,
            isUserQuery: false,
            timeoutSeconds: METADATA_QUERY_TIMEOUT_SECONDS,
        });

        if (!result) {
            return [];
        }

        const rows = queryResultToRows<{ OBJNAME: string; OBJID: number; OBJTYPE: string; DESCRIPTION?: string }>(result);
        const items: TableMetadata[] = rows.map(row => {
            const isView = row.OBJTYPE === 'VIEW';
            return {
                OBJNAME: row.OBJNAME,
                TABLENAME: row.OBJNAME,
                OBJID: row.OBJID,
                label: row.OBJNAME,
                kind: isView ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Class,
                objType: row.OBJTYPE,
                detail: isView ? 'System View' : 'System Table',
                sortText: row.OBJNAME,
                DESCRIPTION: normalizeCompletionDescription(row.DESCRIPTION)
            };
        });

        this.metadataCache.setTables(
            connectionName,
            cacheKey,
            items,
            this.buildTableIdMapForCacheKey(connectionName, mirroredSystemCatalog.sourceDatabase, undefined, items)
        );

        return items;
    }

    private filterSystemCatalogObjects(connectionName: string, items: TableMetadata[] | undefined): TableMetadata[] {
        const mirroredSystemCatalog = this.tryGetMetadataProvider(connectionName)?.mirroredSystemCatalog;
        if (!items || !mirroredSystemCatalog) {
            return [];
        }

        return items.filter(item => mirroredSystemCatalog.isMirroredObjectName(this.getTableMetadataName(item)));
    }

    private getTableMetadataName(item: TableMetadata): string | undefined {
        return typeof item.label === 'string' ? item.label : (item.OBJNAME || item.TABLENAME);
    }

    private findCachedTableMetadata(
        connectionName: string,
        dbName: string,
        schemaName: string | undefined,
        objectName: string
    ): TableMetadata | undefined {
        const isNetezza = this.getConnectionDatabaseKind(connectionName) === 'netezza';
        const lookupName = isNetezza
            ? createNetezzaUserIdentifier(objectName).value
            : objectName.toUpperCase();
        const candidates = getTablesForScope(
            this.metadataCache,
            connectionName,
            dbName,
            schemaName,
        );

        if (!candidates) {
            return undefined;
        }

        return candidates.find(item => {
            const candidateName = this.getTableMetadataName(item);
            const normalizedCandidateName = candidateName === undefined
                ? undefined
                : isNetezza
                    ? candidateName
                    : candidateName.toUpperCase();
            const candidateSchema = typeof item.SCHEMA === 'string'
                ? (isNetezza ? item.SCHEMA : item.SCHEMA.trim())
                : '';
            const normalizedSchemaName = schemaName === undefined
                ? undefined
                : isNetezza
                    ? createNetezzaUserIdentifier(schemaName).value
                    : schemaName.toUpperCase();
            if (!normalizedCandidateName || normalizedCandidateName !== lookupName) {
                return false;
            }
            if (!schemaName) {
                return true;
            }
            return isNetezza
                ? candidateSchema === normalizedSchemaName
                : candidateSchema.toUpperCase() === normalizedSchemaName;
        });
    }

    private async resolveNetezzaSynonymReference(
        connectionName: string,
        dbName: string,
        schemaName: string | undefined,
        tableName: string
    ): Promise<{ database: string; schema?: string; table: string } | undefined> {
        const cachedObject = this.metadataCache.findObjectWithType(connectionName, dbName, schemaName, tableName);
        if (cachedObject && cachedObject.objType.toUpperCase() !== 'SYNONYM') {
            return undefined;
        }

        const cachedTableMetadata = this.findCachedTableMetadata(
            connectionName,
            dbName,
            cachedObject?.schema || schemaName,
            tableName
        );
        const resolvedType = (
            cachedObject?.objType ||
            cachedTableMetadata?.objType ||
            ''
        ).toUpperCase();

        if (resolvedType && resolvedType !== 'SYNONYM') {
            return undefined;
        }

        const cachedReferenceName =
            typeof cachedTableMetadata?.REFOBJNAME === 'string' && cachedTableMetadata.REFOBJNAME.trim().length > 0
                ? cachedTableMetadata.REFOBJNAME
                : undefined;
        if (cachedReferenceName) {
            return parseSynonymTargetReference(
                dbName,
                cachedObject?.schema || schemaName,
                cachedReferenceName,
            );
        }

        if (resolvedType !== 'SYNONYM') {
            return undefined;
        }

        const query = buildNetezzaSynonymTargetQuery(
            dbName,
            tableName,
            cachedObject?.schema || schemaName,
        );
        const result = await runWithMetadataQueryConcurrencyLimit(connectionName, () =>
            runQueryRaw({
                context: this.context,
                query,
                silent: true,
                connectionManager: this.connectionManager,
                connectionName,
                isUserQuery: false,
                timeoutSeconds: METADATA_QUERY_TIMEOUT_SECONDS,
            }),
        );
        if (!result) {
            return undefined;
        }

        const synonymRows = queryResultToRows<{ REFOBJNAME?: string }>(result);
        const refObjName = synonymRows[0]?.REFOBJNAME;
        if (!refObjName) {
            return undefined;
        }

        return parseSynonymTargetReference(
            dbName,
            cachedObject?.schema || schemaName,
            refObjName,
        );
    }

    private async resolveOracleSynonymReference(
        connectionName: string,
        dbName: string,
        schemaName: string | undefined,
        tableName: string,
        allowPublicSynonym: boolean,
    ): Promise<{ database: string; schema: string; table: string } | undefined> {
        const provider = this.tryGetMetadataProvider(connectionName);
        const queryBuilder = provider?.buildSynonymTargetQuery;
        if (!queryBuilder) {
            return undefined;
        }

        const query = queryBuilder(
            dbName,
            tableName,
            allowPublicSynonym ? undefined : schemaName,
        );
        const result = await runWithMetadataQueryConcurrencyLimit(connectionName, () =>
            runQueryRaw({
                context: this.context,
                query,
                silent: true,
                connectionManager: this.connectionManager,
                connectionName,
                isUserQuery: false,
                timeoutSeconds: METADATA_QUERY_TIMEOUT_SECONDS,
            }),
        );
        if (!result) {
            return undefined;
        }

        const rows = queryResultToRows<{
            TARGET_SCHEMA?: string;
            TARGET_NAME?: string;
            DB_LINK?: string;
        }>(result);
        const target = rows.find(
            (row) => row.TARGET_SCHEMA?.trim() && row.TARGET_NAME?.trim() && !row.DB_LINK?.trim(),
        );
        if (!target?.TARGET_SCHEMA || !target.TARGET_NAME) {
            return undefined;
        }

        return {
            database: dbName,
            schema: target.TARGET_SCHEMA.trim(),
            table: target.TARGET_NAME.trim(),
        };
    }

    private buildTableIdMapForCacheKey(
        connectionName: string,
        dbName: string,
        schemaName: string | undefined,
        items: TableMetadata[]
    ): Map<string, number> {
        const idMap = new Map<string, number>();
        const databaseKind = this.tryGetConnectionDatabaseKind(connectionName);
        const normalizedDatabase = databaseKind === 'netezza'
            ? createNetezzaUserIdentifier(dbName).value
            : dbName;

        for (const item of items) {
            const name = this.getTableMetadataName(item);
            if (!name || item.OBJID === undefined) {
                continue;
            }

            const itemSchemaName =
                schemaName ||
                (typeof item.SCHEMA === 'string' && item.SCHEMA.length > 0
                    ? (databaseKind === 'netezza' ? item.SCHEMA : item.SCHEMA.trim())
                    : undefined);
            const lookupKey = itemSchemaName
                ? `${normalizedDatabase}.${itemSchemaName}.${name}`
                : `${normalizedDatabase}..${name}`;
            idMap.set(lookupKey, item.OBJID);
        }

        return idMap;
    }

    /**
     * Create a CompletionItem for a column with PK/FK indicators
     */
    private createColumnCompletionItem(item: ColumnMetadata): vscode.CompletionItem {
        const name = item.label || item.ATTNAME;

        // Add key indicator to label
        let label = name;
        if (item.isPk) {
            label = `🔑 ${name}`;
        } else if (item.isFk) {
            label = `🔗 ${name}`;
        }

        const ci = new vscode.CompletionItem(label, item.kind || vscode.CompletionItemKind.Field);

        // Set insertText to just the column name (without emoji)
        ci.insertText = name;

        // Build detail with type and key info
        let detail = item.detail || '';
        if (item.isPk && item.isFk) {
            detail += ' (PK, FK)';
        } else if (item.isPk) {
            detail += ' (PK)';
        } else if (item.isFk) {
            detail += ' (FK)';
        }
        this.applySuggestDescription(ci, label, detail, item.documentation);

        // Sort PK first, then FK, then regular columns
        if (item.isPk) {
            ci.sortText = `0_${name}`;
        } else if (item.isFk) {
            ci.sortText = `1_${name}`;
        } else {
            ci.sortText = `2_${name}`;
        }

        return ci;
    }
}
