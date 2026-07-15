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
import { formatIdentifierForSql } from '../../utils/identifierUtils';
import { runWithMetadataQueryConcurrencyLimit } from '../../metadata/metadataQueryLimiter';
import {
    normalizeCompletionDescription,
    toInlineCompletionDescription,
} from '../../utils/completionDescriptionUtils';
import { getMetadataQueryConcurrencyLimit } from '../../metadata/metadataQueryLimiter';
import {
    buildSynonymTargetQuery,
    parseSynonymTargetReference,
} from '../../metadata/synonymColumns';
import { buildColumnMetadataQuery, parseColumnMetadata } from '../tableMetadataProvider';
import type { DatabaseKind } from '../../contracts/database';
import { stripIdentifierQuoting } from '../../utils/identifierUtils';
import { logWithFallback } from '../../utils/logger';

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
                return ci;
            });
        }

        try {
            const query = this.getMetadataProvider(connectionName).buildListDatabasesQuery();
            const result = await runQueryRaw(this.context, query, true, this.connectionManager, connectionName, undefined, undefined, undefined, undefined, false);
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
        const cached = this.metadataCache.getSchemas(connectionName, dbName);
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
            const result = await runQueryRaw(this.context, query, true, this.connectionManager, connectionName, undefined, undefined, undefined, undefined, false);
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

            this.metadataCache.setSchemas(connectionName, dbName, items);

            return items.map(item => {
                const ci = new vscode.CompletionItem(item.label!, item.kind);
                ci.detail = item.detail;
                ci.insertText = item.insertText;
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
        const cacheKey = buildSchemaCacheKey(dbName, schemaName);

        const cached = getTablesForScope(
            this.metadataCache,
            connectionName,
            dbName,
            schemaName,
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
                    this.buildTableIdMapForCacheKey(dbName, undefined, cachedWithSystemCatalog)
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

            const result = await runQueryRaw(this.context, query, true, this.connectionManager, connectionName, undefined, undefined, undefined, undefined, false);
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
                    DESCRIPTION: row.DESCRIPTION,
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
                this.buildTableIdMapForCacheKey(dbName, schemaName, itemsWithSystemCatalog)
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
        const cacheKey = buildSchemaCacheKey(dbName, schemaName);
        const cached = getTablesForScope(
            this.metadataCache,
            connectionName,
            dbName,
            schemaName,
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
                    ci.insertText = formatIdentifierForSql(label, databaseKind);
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
            if (cached.length === 0) {
                return [];
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

            const result = await runQueryRaw(
                this.context,
                query,
                true,
                this.connectionManager,
                connectionName,
                undefined,
                undefined,
                undefined,
                undefined,
                false
            );
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
                DESCRIPTION: row.DESCRIPTION
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
                    this.buildTableIdMapForCacheKey(dbName, schemaName, merged),
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
        const cacheKey = buildSchemaCacheKey(dbName, schemaName);
        const cached = schemaName
            ? this.metadataCache.getProcedures(connectionName, cacheKey)
            : this.metadataCache.getProceduresForDatabase(connectionName, dbName);

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
                runQueryRaw(
                    this.context,
                    query,
                    true,
                    this.connectionManager,
                    connectionName,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    false,
                ),
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
        tableName: string
    ): Promise<vscode.CompletionItem[]> {
        const items = await this.getTableColumnsMetadata(connectionName, dbName, schemaName, tableName);
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
        visited = new Set<string>()
    ): Promise<ColumnMetadata[]> {
        if (!connectionName) return [];

        const connectionKind = this.getConnectionDatabaseKind(connectionName);
        const normalizedDbName = dbName ? stripIdentifierQuoting(dbName, connectionKind) : dbName;
        const normalizedSchemaName = schemaName ? stripIdentifierQuoting(schemaName, connectionKind) : schemaName;
        const normalizedTableName = stripIdentifierQuoting(tableName, connectionKind);
        const recursionKey = `${(normalizedDbName || 'CURRENT').toUpperCase()}|${(normalizedSchemaName || '').toUpperCase()}|${normalizedTableName.toUpperCase()}`;

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
            const cacheKey = buildColumnCacheKey(
                normalizedDbName || 'CURRENT',
                normalizedSchemaName,
                normalizedTableName,
                { preserveCase: preserveColumnKeyCase },
            );
            const diskCacheKey = buildColumnCacheKey(
                normalizedDbName || 'CURRENT',
                cacheResolvedSchemaName,
                normalizedTableName,
                { preserveCase: preserveColumnKeyCase },
            );
            if (normalizedDbName) {
                if (typeof this.metadataCache.ensureColumnsLoadedForTableKey === 'function') {
                    await this.metadataCache.ensureColumnsLoadedForTableKey(
                        connectionName,
                        diskCacheKey,
                    );
                } else {
                    await this.metadataCache.ensureColumnsLoaded(connectionName, normalizedDbName);
                }
            }
            const cached = this.metadataCache.getColumns(connectionName, cacheKey)
                || (diskCacheKey !== cacheKey
                    ? this.metadataCache.getColumns(connectionName, diskCacheKey)
                    : undefined);
            if (cached) {
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
                        buildColumnCacheKey(
                            metadataDbName || '',
                            normalizedSchemaName,
                            normalizedTableName,
                            { preserveCase: preserveColumnKeyCase },
                        ),
                    ) ||
                    (metadataDbName
                        ? this.metadataCache.getColumnsAnySchema(connectionName, metadataDbName, normalizedTableName)
                        : undefined);

                if (cachedMirroredColumns) {
                    this.metadataCache.setColumns(connectionName, cacheKey, cachedMirroredColumns);
                    return cachedMirroredColumns;
                }
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
                        visited
                    );
                    if (synonymColumns.length > 0) {
                        this.metadataCache.setColumns(connectionName, cacheKey, synonymColumns);
                        return synonymColumns;
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

            const query = effectiveDb && effectiveSchema
                ? buildColumnMetadataQuery(
                    effectiveDb,
                    effectiveSchema,
                    normalizedTableName,
                    connectionKind
                )
                : this.buildSimpleColumnQuery(connectionName, {
                    database: metadataDbName,
                    schema: resolvedSchemaName,
                    tableName: normalizedTableName,
                    objectId: objId
                });

            const result = await runWithMetadataQueryConcurrencyLimit(connectionName, () =>
                runQueryRaw(this.context, query, true, this.connectionManager, connectionName, undefined, undefined, undefined, undefined, false)
            );
            if (!result) return [];

            let items: ColumnMetadata[];
            if (effectiveDb && effectiveSchema) {
                const parsed = parseColumnMetadata(result);
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
                    documentation: row.DESCRIPTION || '',
                }));
            }

            this.metadataCache.setColumns(connectionName, cacheKey, items);
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
        if (!normalizedDbName || !supportsLegacyMetadataPrefetch(this.tryGetConnectionDatabaseKind(connectionName))) {
            return;
        }

        const context = this.context;
        const cache = this.metadataCache;
        const connectionManager = this.connectionManager;
        const runMetadataQuery = (q: string) =>
            runQueryRaw(context, q, true, connectionManager, connectionName, undefined, undefined, undefined, 1000000, false);

        setImmediate(() => {
            try {
                if (!cache.isConnectionPrefetchFresh(connectionName)) {
                    cache.triggerConnectionPrefetch(connectionName, runMetadataQuery);
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

        const uniqueDatabases = Array.from(new Set(databases.map(db => db.trim()).filter(Boolean)));
        const runMetadataQuery = (q: string) =>
            runQueryRaw(this.context, q, true, this.connectionManager, connectionName, undefined, undefined, undefined, 1000000, false);

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
            this.metadataCache.triggerConnectionPrefetch(connectionName, runMetadataQuery);
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
            const isView =
                (item.objType || '').toUpperCase() === 'VIEW'
                || detailText.startsWith('VIEW')
                || (detailText.length === 0 && (item.kind === 18 || item.kind === vscode.CompletionItemKind.Interface));
            const ci = new vscode.CompletionItem(
                label,
                isView ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Class
            );
            ci.insertText = formatIdentifierForSql(label, databaseKind);
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

        const result = await runQueryRaw(
            this.context,
            query,
            true,
            this.connectionManager,
            connectionName,
            undefined,
            undefined,
            undefined,
            undefined,
            false
        );

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
                DESCRIPTION: row.DESCRIPTION
            };
        });

        this.metadataCache.setTables(
            connectionName,
            cacheKey,
            items,
            this.buildTableIdMapForCacheKey(mirroredSystemCatalog.sourceDatabase, undefined, items)
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
        const lookupName = objectName.toUpperCase();
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
            const candidateSchema = typeof item.SCHEMA === 'string' ? item.SCHEMA.trim() : '';
            if (!candidateName || candidateName.toUpperCase() !== lookupName) {
                return false;
            }
            if (!schemaName) {
                return true;
            }
            return candidateSchema.toUpperCase() === schemaName.toUpperCase();
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

        const query = buildSynonymTargetQuery(
            dbName,
            tableName,
            cachedObject?.schema || schemaName,
        );
        const result = await runWithMetadataQueryConcurrencyLimit(connectionName, () =>
            runQueryRaw(
                this.context,
                query,
                true,
                this.connectionManager,
                connectionName,
                undefined,
                undefined,
                undefined,
                undefined,
                false,
            ),
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

    private buildTableIdMapForCacheKey(
        dbName: string,
        schemaName: string | undefined,
        items: TableMetadata[]
    ): Map<string, number> {
        const idMap = new Map<string, number>();

        for (const item of items) {
            const name = this.getTableMetadataName(item);
            if (!name || item.OBJID === undefined) {
                continue;
            }

            const itemSchemaName =
                schemaName ||
                (typeof item.SCHEMA === 'string' && item.SCHEMA.trim().length > 0 ? item.SCHEMA.trim() : undefined);
            const lookupKey = itemSchemaName
                ? `${dbName}.${itemSchemaName}.${name}`
                : `${dbName}..${name}`;
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
