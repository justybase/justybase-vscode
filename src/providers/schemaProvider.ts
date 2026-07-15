import * as vscode from 'vscode';
import * as path from 'path';
import { DatabaseKind } from '../contracts/database';
import { getDatabaseMetadataProvider } from '../core/connectionFactory';
import { applyGeneratedIdentifierCase } from '../core/dialectTraits';
import { runQueryRaw, queryResultToRows } from '../core/queryRunner';
import { ConnectionManager } from '../core/connectionManager';
import type { DocumentParseSession } from '../sqlParser/documentParseSession';
import { MetadataCache } from '../metadataCache';
import { buildColumnMetadataQuery, parseColumnMetadata } from './tableMetadataProvider';
import { buildIdLookupKey, extractLabel } from '../metadata/helpers';
import { getTablesForScope, refreshTableLikeTypeForSchema, hasTreeReadyColumnCache, normalizeColumnCacheEntry, isTableCacheObjectType, buildSchemaCacheKey } from '../metadata/cache/schemaTreeDataSource';
import { buildColumnCacheKey } from '../metadata/columnRowMapping';
import { DatabaseMetadata, TableMetadata, ColumnMetadata, ProcedureMetadata } from '../metadata/types';
import type { LocalDefinition } from './types';
import { buildMetadataLookupTargets } from '../server/completionPathUtils';
import { findLocalDefinition, dedupeColumnNames, normalizeColumnNames, getWildcardResolutionLocalDefinitions } from '../server/completionLocalDefinitionUtils';
import { CompletionWildcardResolver } from '../server/completionWildcardResolver';
import type { WildcardTableSource } from '../server/completionQualifierUtils';
import { FavoritesManager } from '../core/favoritesManager';
import { formatIdentifierForSql, formatQualifiedObjectName, unquoteIdentifier, stripIdentifierQuoting } from '../utils/identifierUtils';
import { escapeSqlIdentifier, escapeSqlLiteral } from '../utils/sqlUtils';
import { getConnectionAccentResourceUri } from '../utils/connectionAccent';
import { getDialectIconUri } from '../utils/dialectIcons';
import { supportsLegacyMetadataPrefetch } from '../metadata/prefetchSupport';
import { logWithFallback } from '../utils/logger';
import { isSqlAuthoringLanguageId } from '../utils/sqlLanguage';
import {
    buildSchemaFilterRegex,
    columnVisibleInSchemaFilter,
    tableMatchesSchemaFilter,
} from './schemaFilterUtils';

/**
 * Default timeout for schema queries (60 seconds)
 */
const SCHEMA_QUERY_TIMEOUT = 60000;
const CTE_TREE_REFRESH_DEBOUNCE_MS = 400;

const DB2_GLOBAL_TYPE_GROUPS = new Set([
    'SERVER',
    'SERVER OPTION',
    'WRAPPER',
    'WRAPPER OPTION',
    'USER MAPPING',
    'PASSTHRU AUTH',
]);

const DB2_SCHEMA_SCOPED_TYPE_GROUPS = new Set(['TABLE', 'VIEW', 'NICKNAME', 'ALIAS', 'PROCEDURE', 'FUNCTION']);

interface ActiveCteDefinition {
    name: string;
    type: string;
    columns: string[];
}

interface ActiveSqlDocumentContext {
    document: vscode.TextDocument;
    documentUri: string;
    connectionName?: string;
    databaseKind?: DatabaseKind;
    effectiveDb?: string;
    effectiveSchema?: string;
}

/**
 * Error thrown when schema query times out
 */
export class SchemaQueryTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SchemaQueryTimeoutError';
    }
}

async function runQueryWithTimeout(
    context: vscode.ExtensionContext,
    query: string,
    connectionManager: ConnectionManager,
    connectionName: string | undefined,
    timeoutMs: number = SCHEMA_QUERY_TIMEOUT,
): Promise<{ columns: { name: string }[]; data: unknown[][] } | undefined> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    let isTimedOut = false;

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
            isTimedOut = true;
            reject(new SchemaQueryTimeoutError(`Query timed out after ${timeoutMs}ms. Server may be unreachable.`));
        }, timeoutMs);
    });

    const queryPromise = (async () => {
        const result = await runQueryRaw(
            context,
            query,
            true,
            connectionManager,
            connectionName,
            undefined,
            undefined,
            undefined,
            1000000,
            false,
        );
        if (isTimedOut) {
            return undefined;
        }
        return result;
    })();

    try {
        return await Promise.race([queryPromise, timeoutPromise]);
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}

/**
 * Extracts pure function for generating auto table name - testable without VS Code dependencies
 */
export function generateAutoTableNameFromDbInfo(
    dbInfo: { CURRENT_CATALOG?: string; CURRENT_SCHEMA?: string } | undefined,
    kind?: string | DatabaseKind,
    dateGenerator: () => Date = () => new Date(),
    randomGenerator: () => number = () => Math.floor(Math.random() * 10000),
): string | null {
    if (!dbInfo) return null;

    const database = dbInfo.CURRENT_CATALOG || 'SYSTEM';
    const schema = dbInfo.CURRENT_SCHEMA || 'ADMIN';

    const now = dateGenerator();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const random = randomGenerator().toString().padStart(4, '0');
    const generatedTableName = applyGeneratedIdentifierCase(`IMPORT_${dateStr}_${random}`, kind);

    return `${database}.${schema}.${generatedTableName}`;
}

/**
 * Extracts pure function for building object type query - testable
 */
export function buildObjectTypeQuery(dbName: string, objType: string): string {
    return buildObjectTypeQueryForKind(dbName, objType);
}

/**
 * Extracts pure function for building type groups query - testable
 */
export function buildTypeGroupsQuery(dbName: string): string {
    return buildTypeGroupsQueryForKind(dbName);
}

function buildObjectTypeQueryForKind(dbName: string, objType: string, kind?: string | DatabaseKind): string {
    return getDatabaseMetadataProvider(kind).buildObjectTypeQuery(dbName, objType);
}

function buildTypeGroupsQueryForKind(dbName: string, kind?: string | DatabaseKind): string {
    return getDatabaseMetadataProvider(kind).buildTypeGroupsQuery(dbName);
}

function buildSchemaTableIdMap(
    dbName: string,
    schemaName: string | undefined,
    tables: readonly TableMetadata[],
): Map<string, number> {
    const idMap = new Map<string, number>();
    for (const table of tables) {
        const label = extractLabel(table) || table.OBJNAME || table.TABLENAME;
        if (!label || typeof table.OBJID !== 'number') {
            continue;
        }
        idMap.set(buildIdLookupKey(dbName, schemaName, label), table.OBJID);
    }
    return idMap;
}

/**
 * Extracts pure function for filtering cached objects by type - testable
 */
export function filterObjectsByType(
    cachedObjects: {
        item: { objType?: string; kind?: number; detail?: string };
        schema?: string;
        objId?: number;
        description?: string;
        owner?: string;
    }[],
    targetType: string,
): {
    item: { objType?: string; kind?: number; detail?: string };
    schema?: string;
    objId?: number;
    description?: string;
    owner?: string;
}[] {
    return cachedObjects.filter((obj) => {
        const item = obj.item;
        // Check objType if available (preferred)
        if (item.objType) {
            return item.objType === targetType;
        }
        // Fallback to strict kind check if objType missing (legacy cache?)
        if (targetType === 'VIEW') return item.kind === 18;
        if (targetType === 'TABLE') return item.kind !== 18 && item.detail !== 'EXTERNAL TABLE';
        if (targetType === 'EXTERNAL TABLE')
            return item.detail === 'EXTERNAL TABLE' || item.detail?.startsWith('EXTERNAL TABLE');
        return false;
    });
}

/**
 * Extracts pure function for building insert text from schema item data - testable
 */
export function buildInsertText(label: string, schema?: string, dbName?: string, kind?: string | DatabaseKind): string {
    return formatQualifiedObjectName(dbName, schema, label, kind);
}

/**
 * Extracts pure function for determining if object type is expandable - testable
 */
export function isExpandableType(objType: string | undefined): boolean {
    const expandableTypes = ['TABLE', 'GLOBAL TEMP TABLE', 'VIEW', 'NICKNAME', 'ALIAS', 'SYNONYM', 'EXTERNAL TABLE', 'SYSTEM VIEW', 'SYSTEM TABLE'];
    return objType ? expandableTypes.includes(objType) : false;
}

export function normalizeInlineTreeMetadata(value: string | undefined): string {
    return value ? value.replace(/\s+/g, ' ').trim() : '';
}

export function getTypeGroupInlineDescription(objType: string | undefined, kind?: string | DatabaseKind): string {
    const normalizedType = objType?.trim().toUpperCase();
    if (!normalizedType || kind !== 'db2') {
        return '';
    }

    if (DB2_GLOBAL_TYPE_GROUPS.has(normalizedType)) {
        return 'global federated';
    }

    if (DB2_SCHEMA_SCOPED_TYPE_GROUPS.has(normalizedType)) {
        return 'schema-scoped';
    }

    return '';
}

export function getTypeGroupContextValue(objType: string | undefined, kind?: string | DatabaseKind): string {
    const normalizedType = objType?.trim().toUpperCase() || 'UNKNOWN';
    if (normalizedType === 'DYNAMIC TABLE' && kind === 'snowflake') {
        return 'typeGroup:DYNAMIC TABLE:snowflake';
    }

    return `typeGroup:${normalizedType}`;
}

export function getSchemaObjectContextValue(objType: string | undefined, kind?: string | DatabaseKind): string {
    const normalizedType = objType?.trim().toUpperCase() || 'UNKNOWN';
    if (normalizedType === 'DYNAMIC TABLE' && kind === 'snowflake') {
        return 'netezza:DYNAMIC TABLE:snowflake';
    }

    return `netezza:${normalizedType}`;
}

export function getColumnTypeIndicator(dataType: string | undefined): string {
    if (!dataType) {
        return '';
    }

    const normalizedType = dataType.toUpperCase();
    if (/\b(TIMESTAMP|DATE|TIME|INTERVAL)\b/.test(normalizedType)) {
        return '📅';
    }

    if (
        /\b(BYTEINT|SMALLINT|INTEGER|BIGINT|DECIMAL|NUMERIC|NUMBER|REAL|DOUBLE|FLOAT|MONEY|INT)\b/.test(normalizedType)
    ) {
        return '123';
    }

    if (/\b(CHARACTER|VARCHAR|NVARCHAR|CHAR|NCHAR|TEXT|CLOB|XML|JSON)\b/.test(normalizedType)) {
        return 'txt';
    }

    return '';
}

export function buildInlineTreeDescription(
    contextValue: string,
    schema?: string,
    objectDescription?: string,
    dataType?: string,
): string {
    const inlineDescription = normalizeInlineTreeMetadata(objectDescription);

    if (contextValue === 'column') {
        const indicator = getColumnTypeIndicator(dataType);
        if (indicator && inlineDescription) {
            return `${indicator} - ${inlineDescription}`;
        }
        return indicator || inlineDescription;
    }

    if (contextValue.startsWith('typeGroup')) {
        return inlineDescription;
    }

    if (contextValue.startsWith('netezza:')) {
        const schemaDescription = schema ? `(${schema})` : '';
        if (schemaDescription && inlineDescription) {
            return `${schemaDescription} - ${inlineDescription}`;
        }
        return schemaDescription || inlineDescription;
    }

    return schema ? `(${schema})` : '';
}

export class SchemaProvider
    implements vscode.TreeDataProvider<SchemaItem>, vscode.TreeDragAndDropController<SchemaItem>
{
    private _onDidChangeTreeData: vscode.EventEmitter<SchemaItem | undefined | null | void> = new vscode.EventEmitter<
        SchemaItem | undefined | null | void
    >();
    readonly onDidChangeTreeData: vscode.Event<SchemaItem | undefined | null | void> = this._onDidChangeTreeData.event;

    // Error state tracking per connection
    private _connectionErrors: Map<string, { message: string; timestamp: Date }> = new Map();

    // Filter state
    private _filterString?: string;
    private _filterRegex?: RegExp;
    private _cteRootItem?: SchemaItem;
    private _cteRefreshTimer?: NodeJS.Timeout;
    private _cteDefinitionsSnapshot?: ActiveCteDefinition[];
    private readonly _cteWildcardResolver: CompletionWildcardResolver;

    // Drag and Drop support
    readonly dragMimeTypes = ['application/vnd.code.tree.netezza', 'text/plain'];
    readonly dropMimeTypes = ['application/vnd.code.tree.netezza', 'text/uri-list'];

    constructor(
        private context: vscode.ExtensionContext,
        private connectionManager: ConnectionManager,
        private metadataCache: MetadataCache,
        private readonly parseSession?: DocumentParseSession,
    ) {
        this._cteWildcardResolver = new CompletionWildcardResolver(parseSession);

        // Listen for connection changes to refresh tree and clear errors
        this.connectionManager.onDidChangeConnections(() => {
            this._connectionErrors.clear();
            this.refresh();
        });

        // Listen for favorite changes
        const favoritesManager = FavoritesManager.getInstance(context);
        favoritesManager.onDidChangeFavorites(() => {
            this.refresh();
        });

        // Listen for external cache updates from another VS Code window
        metadataCache.onDidExternalRefresh(() => {
            this.refresh();
        });

        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(() => {
                this.clearPendingCteRefresh();
                this._cteRootItem = undefined;
                this._cteDefinitionsSnapshot = undefined;
                this.refresh();
            }),
            vscode.workspace.onDidChangeTextDocument((event) => {
                const activeEditor = vscode.window.activeTextEditor;
                if (
                    activeEditor?.document === event.document &&
                    isSqlAuthoringLanguageId(activeEditor.document.languageId)
                ) {
                    this.scheduleCteTreeRefresh();
                }
            }),
            {
                dispose: () => this.clearPendingCteRefresh(),
            },
        );
    }

    private getConnectionDatabaseKind(connectionName?: string): DatabaseKind | undefined {
        return this.connectionManager.getConnectionDatabaseKind(connectionName);
    }

    private requireConnectionDatabaseKind(connectionName: string | undefined, operation: string): DatabaseKind {
        if (!connectionName) {
            throw new Error(`Connection name is required to ${operation}.`);
        }

        const databaseKind = this.getConnectionDatabaseKind(connectionName);
        if (!databaseKind) {
            throw new Error(
                `Connection '${connectionName}' is missing a database type. Open the connection settings and save it again.`,
            );
        }

        return databaseKind;
    }

    private getMetadataProvider(connectionName: string) {
        return getDatabaseMetadataProvider(this.requireConnectionDatabaseKind(connectionName, 'load schema metadata'));
    }

    private getActiveSqlDocumentContext(): ActiveSqlDocumentContext | undefined {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isSqlAuthoringLanguageId(editor.document.languageId)) {
            return undefined;
        }

        const documentUri = editor.document.uri.toString();
        const connectionName =
            this.connectionManager.getConnectionForExecution(documentUri) ||
            this.connectionManager.getActiveConnectionName?.();
        const databaseKind = connectionName ? this.getConnectionDatabaseKind(connectionName) : undefined;
        const connectionMetadata = connectionName ? this.connectionManager.getConnectionMetadata(connectionName) : undefined;
        const effectiveDb = this.connectionManager.getDocumentDatabase(documentUri) || connectionMetadata?.database;
        const effectiveSchema = connectionName
            ? this.connectionManager.getEffectiveSchemaSync(documentUri, effectiveDb)
            : undefined;

        return {
            document: editor.document,
            documentUri,
            connectionName: connectionName || undefined,
            databaseKind,
            effectiveDb,
            effectiveSchema,
        };
    }

    private createCteRootItem(): SchemaItem | undefined {
        if (!this.getActiveSqlDocumentContext()) {
            this._cteRootItem = undefined;
            return undefined;
        }

        const item = new SchemaItem('CTEs / Temp Tables', vscode.TreeItemCollapsibleState.Collapsed, 'cteRoot');
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.description = 'active SQL';
        this._cteRootItem = item;
        return item;
    }

    private getActiveCteDefinitions(): ActiveCteDefinition[] {
        if (this._cteRefreshTimer !== undefined && this._cteDefinitionsSnapshot !== undefined) {
            return this._cteDefinitionsSnapshot;
        }

        const fresh = this.buildActiveCteDefinitions();
        this._cteDefinitionsSnapshot = fresh;
        return fresh;
    }

    private buildActiveCteDefinitions(): ActiveCteDefinition[] {
        const activeContext = this.getActiveSqlDocumentContext();
        if (!activeContext || !this.parseSession) {
            return [];
        }

        const localDefinitions = this.getActiveLocalDefinitions(activeContext);
        if (!localDefinitions) {
            return [];
        }

        const ctes = new Map<string, ActiveCteDefinition>();
        for (const definition of localDefinitions) {
            const definitionType = definition.type.toUpperCase();
            if (
                definitionType !== 'CTE' &&
                definitionType !== 'TEMP TABLE' &&
                definitionType !== 'GLOBAL TEMP TABLE' &&
                definitionType !== 'TABLE'
            ) {
                continue;
            }

            const name = definition.name.trim();
            if (!name) {
                continue;
            }

            const normalizedName = name.toUpperCase();
            if (ctes.has(normalizedName)) {
                continue;
            }

            ctes.set(normalizedName, {
                name,
                type: definition.type,
                columns: definition.columns,
            });
        }

        return Array.from(ctes.values()).sort((left, right) =>
            left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }),
        );
    }

    private createEmptyCteItem(label: string): SchemaItem {
        const item = new SchemaItem(label, vscode.TreeItemCollapsibleState.None, 'emptyCtes');
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
    }

    private getActiveLocalDefinitions(activeContext: ActiveSqlDocumentContext): LocalDefinition[] | undefined {
        if (!this.parseSession) {
            return undefined;
        }

        try {
            return this.parseSession.getSemanticScope({
                documentUri: activeContext.documentUri,
                documentVersion: activeContext.document.version,
                sql: activeContext.document.getText(),
                databaseKind: activeContext.databaseKind,
            }).localDefinitions;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            logWithFallback('debug', `[SchemaProvider] Failed to parse active SQL CTEs: ${message}`);
            return undefined;
        }
    }

    private resolveCteColumnsForTreeItem(element: SchemaItem): string[] {
        const existingColumns = this.normalizeResolvedColumnNames(element.cteColumns ?? []);

        const activeContext = this.getActiveSqlDocumentContext();
        if (!activeContext) {
            return existingColumns;
        }

        const localDefinitions = this.getActiveLocalDefinitions(activeContext);
        if (!localDefinitions) {
            return existingColumns;
        }

        const definition = findLocalDefinition(localDefinitions, element.rawLabel || element.label);
        if (!definition) {
            return existingColumns;
        }

        const resolvedColumns = this.resolveLocalDefinitionColumnsForSchemaTree(
            definition,
            activeContext,
            new Set<string>(),
        );
        return resolvedColumns.length > 0 ? resolvedColumns : existingColumns;
    }

    private resolveLocalDefinitionColumnsForSchemaTree(
        definition: LocalDefinition,
        activeContext: ActiveSqlDocumentContext,
        resolving: Set<string>,
    ): string[] {
        const definitionKey = definition.name.toUpperCase();
        if (resolving.has(definitionKey)) {
            return this.normalizeResolvedColumnNames(definition.columns);
        }

        const nextResolving = new Set(resolving);
        nextResolving.add(definitionKey);

        const explicitColumns = this.normalizeResolvedColumnNames(definition.columns);
        const fullSql = activeContext.document.getText();

        if (
            this._cteWildcardResolver.definitionHasExplicitColumnList(
                fullSql,
                definition.name,
                activeContext.databaseKind,
                activeContext.documentUri,
                activeContext.document.version,
            )
        ) {
            return explicitColumns;
        }

        const wildcardSources = this._cteWildcardResolver.extractWildcardTableSources(
            fullSql,
            definition.name,
            activeContext.databaseKind,
            activeContext.documentUri,
            activeContext.document.version,
        );
        if (wildcardSources.length === 0) {
            return explicitColumns;
        }

        const resolutionLocalDefinitions = getWildcardResolutionLocalDefinitions(
            this.parseSession,
            this._cteWildcardResolver,
            {
                documentUri: activeContext.documentUri,
                documentVersion: activeContext.document.version,
                sql: fullSql,
                databaseKind: activeContext.databaseKind,
            },
            definition,
        );
        const wildcardColumns: string[] = [];
        for (const source of wildcardSources) {
            const localSourceDefinition = findLocalDefinition(
                resolutionLocalDefinitions,
                source.table,
            );
            if (localSourceDefinition) {
                wildcardColumns.push(
                    ...this.resolveLocalDefinitionColumnsForSchemaTree(
                        localSourceDefinition,
                        activeContext,
                        nextResolving,
                    ),
                );
                continue;
            }

            wildcardColumns.push(
                ...this.getCachedColumnsForWildcardSource(activeContext, source)
                    .map((column) => column.label || column.ATTNAME),
            );
        }

        return dedupeColumnNames([...explicitColumns, ...wildcardColumns]);
    }

    private normalizeResolvedColumnNames(columns: string[]): string[] {
        return dedupeColumnNames(
            normalizeColumnNames(columns).filter((column) => column !== '*' && !column.endsWith('.*')),
        );
    }

    private mapCteTreeObjectType(type: string): string {
        const upperType = type.toUpperCase();
        if (upperType === 'GLOBAL TEMP TABLE') {
            return 'GLOBAL TEMP TABLE';
        }
        if (upperType === 'TEMP TABLE') {
            return 'TEMP TABLE';
        }
        if (upperType === 'TABLE') {
            return 'TABLE';
        }
        return 'CTE';
    }

    private formatCteTreeTypeLabel(objectType: string): string {
        switch (objectType) {
            case 'GLOBAL TEMP TABLE':
                return 'Global Temp Table';
            case 'TEMP TABLE':
                return 'Temp Table';
            case 'TABLE':
                return 'Table';
            default:
                return 'CTE';
        }
    }

    private getCachedColumnsForWildcardSource(
        activeContext: ActiveSqlDocumentContext,
        source: WildcardTableSource,
    ): ColumnMetadata[] {
        if (!activeContext.connectionName) {
            return [];
        }

        const lookupTargets = buildMetadataLookupTargets(
            source,
            activeContext.effectiveDb,
            activeContext.effectiveSchema,
            activeContext.databaseKind,
        );

        for (const target of lookupTargets) {
            if (!target.database) {
                continue;
            }

            let columns = target.schema
                ? this.metadataCache.getColumns(
                    activeContext.connectionName,
                    buildColumnCacheKey(target.database, target.schema, target.table),
                )
                : this.metadataCache.getColumnsAnySchema(
                    activeContext.connectionName,
                    target.database,
                    target.table,
                );
            if ((!columns || columns.length === 0) && target.schema) {
                columns = this.metadataCache.getColumnsAnySchema(
                    activeContext.connectionName,
                    target.database,
                    target.table,
                );
            }
            if (columns && columns.length > 0) {
                return columns;
            }
        }

        const databases = this.metadataCache.getDatabases(activeContext.connectionName) ?? [];
        for (const database of databases) {
            const dbName = database.DATABASE || database.label;
            if (!dbName) {
                continue;
            }
            const columns = this.metadataCache.getColumnsAnySchema(
                activeContext.connectionName,
                dbName,
                source.table,
            );
            if (columns && columns.length > 0) {
                return columns;
            }
        }

        return [];
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    private scheduleCteTreeRefresh(): void {
        this.clearPendingCteRefresh();
        this._cteRefreshTimer = setTimeout(() => {
            this._cteRefreshTimer = undefined;
            this._cteDefinitionsSnapshot = this.buildActiveCteDefinitions();
            if (this._cteRootItem) {
                this._onDidChangeTreeData.fire(this._cteRootItem);
            } else {
                this.refresh();
            }
        }, CTE_TREE_REFRESH_DEBOUNCE_MS);
    }

    private clearPendingCteRefresh(): void {
        if (this._cteRefreshTimer) {
            clearTimeout(this._cteRefreshTimer);
            this._cteRefreshTimer = undefined;
        }
    }

    /**
     * Clear all connection errors (called on refresh)
     */
    clearAllErrors(): void {
        this._connectionErrors.clear();
    }

    /**
     * Set error state for a connection
     */
    setConnectionError(connectionName: string, errorMessage: string): void {
        const existing = this._connectionErrors.get(connectionName);
        if (existing && existing.message === errorMessage) {
            return;
        }
        this._connectionErrors.set(connectionName, {
            message: errorMessage,
            timestamp: new Date(),
        });
        this._onDidChangeTreeData.fire();
    }

    /**
     * Clear error state for a connection
     */
    clearConnectionError(connectionName: string): void {
        this._connectionErrors.delete(connectionName);
    }

    /**
     * Get error for a specific connection
     */
    getConnectionError(connectionName: string): { message: string; timestamp: Date } | undefined {
        return this._connectionErrors.get(connectionName);
    }

    /**
     * Set filter for the schema tree
     */
    setFilter(filter: string | undefined): void {
        if (this._filterString !== filter) {
            this._filterString = filter;
            this._filterRegex = filter ? buildSchemaFilterRegex(filter) : undefined;
            if (filter && !this._filterRegex) {
                logWithFallback('warn', `[SchemaProvider] Invalid filter regex generated: ${filter}`);
            }

            this.refresh();
        }
    }

    private getCachedColumnsForTable(
        connectionName: string,
        dbName: string,
        schemaName: string | undefined,
        tableName: string,
    ): ColumnMetadata[] | undefined {
        const columnKey = buildColumnCacheKey(dbName, schemaName, tableName);
        const direct = this.metadataCache.getColumns(connectionName, columnKey);
        if (direct && direct.length > 0) {
            return direct;
        }
        if (!schemaName) {
            return this.metadataCache.getColumnsAnySchema(connectionName, dbName, tableName);
        }
        return undefined;
    }

    private tableMatchesFilter(
        connectionName: string | undefined,
        dbName: string | undefined,
        schemaName: string | undefined,
        tableName: string,
        tableDescription?: string,
    ): boolean {
        const columns =
            connectionName && dbName
                ? this.getCachedColumnsForTable(connectionName, dbName, schemaName, tableName)
                : undefined;
        return tableMatchesSchemaFilter({
            regex: this._filterRegex,
            tableName,
            tableDescription,
            columns,
        });
    }

    private filterVisibleColumns(
        tableName: string,
        tableDescription: string | undefined,
        columns: ColumnMetadata[],
    ): ColumnMetadata[] {
        if (!this._filterRegex) {
            return columns;
        }
        return columns.filter((column) =>
            columnVisibleInSchemaFilter({
                regex: this._filterRegex,
                tableName,
                tableDescription,
                column,
            }),
        );
    }

    /**
     * Get the current filter string
     */
    getFilter(): string | undefined {
        return this._filterString;
    }

    /**
     * Generate auto table name from current database and schema
     * Uses the extracted pure function for testability
     */
    private async generateAutoTableName(
        connectionName: string | undefined,
        connectionManager: ConnectionManager,
        documentUri?: string,
    ): Promise<string | null> {
        if (!connectionName) return null;

        try {
            const currentDbQuery = 'SELECT CURRENT_CATALOG, CURRENT_SCHEMA';
            const currentDbResult = await runQueryRaw(
                this.context,
                currentDbQuery,
                true,
                connectionManager,
                connectionName,
                documentUri,
                undefined,
                undefined,
                SCHEMA_QUERY_TIMEOUT,
                false,
            );

            if (currentDbResult && currentDbResult.data) {
                const dbInfo = queryResultToRows<{
                    CURRENT_CATALOG?: string;
                    CURRENT_SCHEMA?: string;
                }>(currentDbResult);
                // Use the extracted pure function
                return generateAutoTableNameFromDbInfo(
                    dbInfo?.[0],
                    connectionManager.getConnectionDatabaseKind(connectionName),
                );
            }
        } catch (err: unknown) {
            vscode.window.showErrorMessage(
                `Error getting current database/schema: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        return null;
    }

    /**
     * Handle drag events - enable dragging for schema items
     */
    handleDrag(source: SchemaItem[], dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): void {
        if (source.length === 0) return;

        const item = source[0];

        // Enable drag for favorites items
        if (item.contextValue?.startsWith('favorites') && item.id) {
            const dragUri = vscode.Uri.parse(`netezza-favorite://${item.id}`);
            dataTransfer.set('application/vnd.code.tree.netezza', new vscode.DataTransferItem(dragUri.toString()));

            const favoritesManager = FavoritesManager.getInstance(this.context);
            const favorite = favoritesManager.getFavoriteById(item.id);
            if (favorite) {
                if (favorite.type === 'sql' && favorite.sqlContent) {
                    dataTransfer.set('text/plain', new vscode.DataTransferItem(favorite.sqlContent));
                } else if (favorite.type === 'object' && favorite.label) {
                    const insertText = buildInsertText(
                        favorite.label,
                        favorite.schema,
                        favorite.dbName,
                        favorite.connectionName
                            ? this.connectionManager.getConnectionDatabaseKind(favorite.connectionName)
                            : undefined,
                    );
                    dataTransfer.set('text/plain', new vscode.DataTransferItem(insertText));
                }
            }
        }
        // Enable drag for regular table/view items
        else if (item.contextValue?.startsWith('netezza:')) {
            const itemName = item.rawLabel || item.label;
            const dragUri = vscode.Uri.parse(
                `netezza-drag://${item.connectionName}/${item.dbName}/${item.schema || ''}/${itemName}`,
            );
            dataTransfer.set('application/vnd.code.tree.netezza', new vscode.DataTransferItem(dragUri.toString()));

            const insertText = buildInsertText(
                itemName,
                item.schema,
                item.dbName,
                item.connectionName ? this.connectionManager.getConnectionDatabaseKind(item.connectionName) : undefined,
            );
            dataTransfer.set('text/plain', new vscode.DataTransferItem(insertText));
        }
        // Enable drag for active SQL local definitions (CTEs and temp tables)
        else if (item.contextValue === 'cteObject' || item.contextValue === 'cteColumn') {
            const itemName = item.rawLabel || item.label;
            const activeContext = this.getActiveSqlDocumentContext();
            const dragUri = vscode.Uri.parse(`netezza-local-sql://${item.contextValue}/${encodeURIComponent(itemName)}`);
            dataTransfer.set('application/vnd.code.tree.netezza', new vscode.DataTransferItem(dragUri.toString()));
            const insertText =
                item.contextValue === 'cteColumn'
                    ? formatIdentifierForSql(itemName, activeContext?.databaseKind)
                    : itemName;
            dataTransfer.set(
                'text/plain',
                new vscode.DataTransferItem(insertText),
            );
        }
    }

    /**
     * Handle drop events - import xlsx/xlsb files
     */
    async handleDrop(
        target: SchemaItem | undefined,
        sources: vscode.DataTransfer,
        token: vscode.CancellationToken,
    ): Promise<void> {
        // First check for internal drag (favorites reordering)
        const internalDrop = sources.get('application/vnd.code.tree.netezza');
        if (internalDrop) {
            let uriString: string;
            try {
                uriString = typeof internalDrop.value === 'string' ? internalDrop.value : await internalDrop.asString();
                const uri = vscode.Uri.parse(uriString);

                if (uri.scheme === 'netezza-favorite') {
                    const sourceId = uri.authority;
                    let targetId: string | undefined = undefined;

                    if (target === undefined || target?.contextValue === 'favoritesRoot') {
                        // Dropped on empty space or the 'Favorites' root node
                        targetId = undefined;
                    } else if (target?.contextValue === 'favoritesFolder') {
                        // Dropped on a specific folder
                        targetId = target.id;
                    } else if (target?.contextValue?.startsWith('favorites')) {
                        return;
                    } else {
                        return;
                    }

                    if (sourceId) {
                        const favoritesManager = FavoritesManager.getInstance(this.context);
                        await favoritesManager.moveItem(sourceId, targetId);
                    }
                }
            } catch (e) {
                logWithFallback('warn', 'Could not parse internal drop uri', e);
            }
            return;
        }

        // Then check for file drop (text/uri-list) for xlsx/xlsb import
        const dataTransferItem = sources.get('text/uri-list');
        if (!dataTransferItem) return;

        let uriList: string;
        try {
            uriList =
                typeof dataTransferItem.value === 'string' ? dataTransferItem.value : await dataTransferItem.asString();
        } catch (e) {
            logWithFallback('warn', 'Could not read drop dataTransfer', e);
            return;
        }

        const uris: vscode.Uri[] = uriList
            .split('\r\n')
            .filter((u) => u.trim())
            .map((u) => {
                try {
                    return vscode.Uri.parse(u);
                } catch {
                    return null;
                }
            })
            .filter((u) => u !== null) as vscode.Uri[];

        for (const uri of uris) {
            if (token.isCancellationRequested) return;

            // Check if it's a file drop
            if (uri.scheme === 'file') {
                const filePath = uri.fsPath;
                const ext = path.extname(filePath).toLowerCase();

                // Check if it's an xlsx or xlsb file
                if (ext === '.xlsx' || ext === '.xlsb') {
                    await this.importFileToNetezza(filePath, target);
                }
            }
        }
    }

    /**
     * Import xlsx/xlsb file to Netezza
     */
    private async importFileToNetezza(filePath: string, targetItem?: SchemaItem): Promise<void> {
        // Get active connection
        const editor = vscode.window.activeTextEditor;
        const documentUri = editor?.document?.uri?.toString();
        let connectionName = this.connectionManager.getConnectionForExecution(documentUri);

        if (!connectionName) {
            // Try to get any active connection
            const connections = await this.connectionManager.getConnections();
            if (connections.length === 0) {
                vscode.window.showErrorMessage('No Netezza connection available. Please connect first.');
                return;
            }
            // Use first available connection
            connectionName = connections[0].name;
        }

        const connectionDetails = await this.connectionManager.getConnectionDetailsForImport(
            documentUri,
            connectionName,
            targetItem?.dbName,
        );
        if (!connectionDetails) {
            vscode.window.showErrorMessage('Connection not configured. Please connect via Netezza: Connect...');
            return;
        }

        // Ask for target table name
        const targetTable = await vscode.window.showInputBox({
            prompt: 'Enter target table name (leave empty for auto-generated name)',
            placeHolder: 'e.g. my_schema.my_table or leave empty',
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return null; // Allow empty for auto-generated name
                }
                if (
                    !/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/.test(value.trim())
                ) {
                    return 'Invalid table name format. Use: [database.]schema.table';
                }
                return null;
            },
        });

        let finalTableName: string;
        if (!targetTable || targetTable.trim().length === 0) {
            const autoName = await this.generateAutoTableName(connectionName, this.connectionManager, documentUri);
            if (!autoName) return;
            finalTableName = autoName;
            vscode.window.showInformationMessage(`Auto-generated table name: ${finalTableName}`);
        } else {
            finalTableName = targetTable.trim();
        }

        const fileName = path.basename(filePath);
        const { getImportDialectLabel, importDataForConnection } = await import('../import/importDispatcher');

        // Show progress notification
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: `Importing ${fileName} to ${getImportDialectLabel(connectionDetails.dbType)}...`,
                cancellable: false,
            },
            async (progress) => {
                try {
                    const result = await importDataForConnection(
                        filePath,
                        finalTableName,
                        connectionDetails,
                        (message: string, increment?: number) => {
                            progress.report({ message, increment });
                        },
                    );

                    const workflowMarkdown = result.details?.snowflakeWorkflow?.workflowMarkdown;
                    if (workflowMarkdown && connectionName) {
                        const document = await vscode.workspace.openTextDocument({
                            content: workflowMarkdown,
                            language: 'markdown',
                        });
                        this.connectionManager.setDocumentConnection(document.uri.toString(), connectionName);
                        await vscode.window.showTextDocument(document, { preview: false });
                        vscode.window.showInformationMessage(
                            'Snowflake staged load workflow generated. Upload the file to a stage and execute the generated SQL when ready.',
                        );
                        return;
                    }

                    if (!result.success) {
                        throw new Error(result.message);
                    }

                    // Success!
                    const msg = result.details
                        ? `Imported ${result.details.rowsProcessed} rows, ${result.details.columns} columns to ${finalTableName}`
                        : `Successfully imported ${fileName} to ${finalTableName}`;

                    vscode.window.showInformationMessage(msg, 'Copy Table Name').then((action) => {
                        if (action === 'Copy Table Name') {
                            vscode.env.clipboard.writeText(finalTableName);
                            vscode.window.showInformationMessage('Table name copied to clipboard');
                        }
                    });

                    // Refresh schema to show new table
                    void vscode.commands.executeCommand('netezza.refreshSchema');
                } catch (err: unknown) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Import failed: ${errorMsg}`);
                }
            },
        );
    }

    /**
     * Trigger background prefetch for a connection when database is expanded.
     * This warms up the cache shared with autocomplete and revealInSchema.
     */
    private triggerDatabasePrefetch(connectionName: string, _dbName: string): void {
        const databaseKind = this.getConnectionDatabaseKind(connectionName);
        if (!supportsLegacyMetadataPrefetch(databaseKind)) {
            return;
        }

        // Don't block UI - run prefetch in background
        if (!this.metadataCache.isConnectionPrefetchFresh(connectionName)) {
            logWithFallback('debug', `[SchemaProvider] Triggering connection prefetch for: ${connectionName}`);
            void this.metadataCache.whenDiskReady().then(() => {
                if (this.metadataCache.isConnectionPrefetchFresh(connectionName)) {
                    return;
                }
                this.metadataCache.triggerConnectionPrefetch(connectionName, async (query) => {
                    try {
                        return await runQueryWithTimeout(
                            this.context,
                            query,
                            this.connectionManager,
                            connectionName,
                            SCHEMA_QUERY_TIMEOUT,
                        );
                    } catch (e: unknown) {
                        if (e instanceof SchemaQueryTimeoutError) {
                            logWithFallback('warn', '[SchemaProvider] Prefetch query timeout:', e.message);
                        } else {
                            logWithFallback('error', '[SchemaProvider] Prefetch query error:', e);
                        }
                        return undefined;
                    }
                });
            });
        }
    }

    /**
     * Track which typeGroups refreshes are in progress to avoid duplicate queries.
     */
    private typeGroupsRefreshInProgress: Set<string> = new Set();

    /**
     * Trigger background refresh of typeGroups for a database.
     * This updates the cache with real data from the database.
     * Does not block UI - runs in background.
     */
    private triggerTypeGroupsRefresh(connectionName: string, dbName: string): void {
        const key = `${connectionName}|${dbName}`;
        if (this.typeGroupsRefreshInProgress.has(key)) {
            return;
        }
        this.typeGroupsRefreshInProgress.add(key);

        // Run in background without awaiting
        (async () => {
            try {
                const databaseKind = this.requireConnectionDatabaseKind(connectionName, 'refresh schema object groups');
                const query = buildTypeGroupsQueryForKind(dbName, databaseKind);
                const result = await runQueryWithTimeout(
                    this.context,
                    query,
                    this.connectionManager,
                    connectionName,
                    SCHEMA_QUERY_TIMEOUT,
                );
                const types = result ? queryResultToRows<{ OBJTYPE: string }>(result) : [];
                const typeList = types.map((t: { OBJTYPE: string }) => t.OBJTYPE);
                this.metadataCache.setTypeGroups(connectionName, dbName, typeList);
                logWithFallback('debug', `[SchemaProvider] Refreshed typeGroups for ${dbName}: ${typeList.join(', ')}`);
                this.refresh();
            } catch (e: unknown) {
                if (e instanceof SchemaQueryTimeoutError) {
                    logWithFallback('warn', `[SchemaProvider] Timeout refreshing typeGroups for ${dbName}:`, e.message);
                } else {
                    logWithFallback('error', `[SchemaProvider] Failed to refresh typeGroups for ${dbName}:`, e);
                }
            } finally {
                this.typeGroupsRefreshInProgress.delete(key);
            }
        })().catch((e) => logWithFallback('error', '[SchemaProvider] typeGroups refresh error:', e));
    }

    private mapCachedTableObjectsToSchemaItems(
        cachedObjects: {
            item: { label?: string | { label: string } };
            schema?: string;
            objId?: number;
            description?: string;
            owner?: string;
        }[],
        dbName: string,
        objType: string,
        connectionName: string,
        databaseKind: string | DatabaseKind | undefined,
    ): SchemaItem[] {
        let finalCachedObjects = cachedObjects;
        if (this._filterRegex) {
            finalCachedObjects = cachedObjects.filter((obj) => {
                const it = obj.item;
                const rawObjectName =
                    typeof it.label === 'string' ? it.label : it.label?.label || 'unknown';
                return this.tableMatchesFilter(
                    connectionName,
                    dbName,
                    obj.schema,
                    rawObjectName,
                    obj.description,
                );
            });
        }

        return finalCachedObjects.map((obj) => {
            const it = obj.item;
            const rawObjectName =
                typeof it.label === 'string' ? it.label : it.label?.label || 'unknown';
            return new SchemaItem(
                rawObjectName,
                isExpandableType(objType)
                    ? vscode.TreeItemCollapsibleState.Collapsed
                    : vscode.TreeItemCollapsibleState.None,
                getSchemaObjectContextValue(objType, databaseKind),
                dbName,
                objType,
                obj.schema,
                obj.objId,
                obj.description,
                connectionName,
                undefined,
                undefined,
                undefined,
                undefined,
                obj.owner,
                rawObjectName,
            );
        });
    }

    private mapCachedProceduresToSchemaItems(
        cachedProcedures: ProcedureMetadata[],
        dbName: string,
        connectionName: string,
        databaseKind: string | DatabaseKind | undefined,
    ): SchemaItem[] {
        const filtered = this._filterRegex
            ? cachedProcedures.filter((item) => {
                const label = typeof item.label === 'string'
                    ? item.label
                    : item.PROCEDURESIGNATURE || item.PROCEDURE || '';
                return this.tableMatchesFilter(
                    connectionName,
                    dbName,
                    item.SCHEMA,
                    label,
                    item.detail,
                );
            })
            : cachedProcedures;

        return filtered.map((item) => {
            const label = typeof item.label === 'string'
                ? item.label
                : item.PROCEDURESIGNATURE || item.PROCEDURE || 'unknown';
            return new SchemaItem(
                label,
                vscode.TreeItemCollapsibleState.None,
                getSchemaObjectContextValue('PROCEDURE', databaseKind),
                dbName,
                'PROCEDURE',
                item.SCHEMA,
                undefined,
                item.detail,
                connectionName,
                undefined,
                undefined,
                undefined,
                undefined,
                item.OWNER,
                label,
            );
        });
    }

    private writeBackProceduresToCache(
        connectionName: string,
        dbName: string,
        objects: {
            OBJNAME: string;
            SCHEMA?: string;
            OWNER?: string;
            DESCRIPTION?: string;
        }[],
    ): void {
        const dbCacheKey = `${dbName}..`;
        const proceduresByKey = new Map<string, ProcedureMetadata[]>();
        const allProcedures: ProcedureMetadata[] = [];

        for (const row of objects) {
            const signature = row.OBJNAME?.trim();
            if (!signature) {
                continue;
            }
            const normalizedSchema = row.SCHEMA?.trim() || '';
            const procedureName = signature.split('(')[0]?.trim() || signature;
            const key = normalizedSchema ? `${dbName}.${normalizedSchema}` : dbCacheKey;
            const item: ProcedureMetadata = {
                PROCEDURE: procedureName,
                PROCEDURESIGNATURE: signature,
                SCHEMA: normalizedSchema || undefined,
                OWNER: row.OWNER || undefined,
                DATABASE: dbName,
                label: signature,
                kind: vscode.CompletionItemKind.Function,
                detail: normalizedSchema ? `Procedure (${normalizedSchema})` : 'Procedure',
                sortText: signature,
            };
            if (!proceduresByKey.has(key)) {
                proceduresByKey.set(key, []);
            }
            proceduresByKey.get(key)!.push(item);
            allProcedures.push(item);
        }

        for (const [key, items] of proceduresByKey) {
            if (key !== dbCacheKey) {
                this.metadataCache.setProcedures(connectionName, key, items);
            }
        }
        // Aggregate last so per-schema writes do not leave tree without DB.. layer.
        this.metadataCache.setProcedures(connectionName, dbCacheKey, allProcedures);
    }

    private async resolveNetezzaSynonymTarget(
        connectionName: string,
        dbName: string,
        schemaName: string | undefined,
        objectName: string
    ): Promise<{ database: string; schema?: string; table: string } | undefined> {
        const cachedObject = this.metadataCache.findObjectWithType(connectionName, dbName, schemaName, objectName);
        if (cachedObject && cachedObject.objType.toUpperCase() !== 'SYNONYM') {
            return undefined;
        }

        const cachedTables = getTablesForScope(
            this.metadataCache,
            connectionName,
            dbName,
            schemaName,
        );

        const lookupName = objectName.toUpperCase();
        const cachedSynonym = cachedTables?.find(item => {
            const candidateName = extractLabel(item)?.toUpperCase();
            const candidateSchema = typeof item.SCHEMA === 'string' ? item.SCHEMA.trim().toUpperCase() : '';
            if (candidateName !== lookupName) return false;
            if (!schemaName) return true;
            return candidateSchema === schemaName.toUpperCase();
        });

        let refObjName: string | undefined;
        if (typeof cachedSynonym?.REFOBJNAME === 'string' && cachedSynonym.REFOBJNAME.trim().length > 0) {
            refObjName = cachedSynonym.REFOBJNAME;
        }

        if (refObjName) {
            return this.parseNetezzaSynonymReference(dbName, cachedObject?.schema || schemaName, refObjName);
        }

        const query = `SELECT REFOBJNAME FROM ${escapeSqlIdentifier(dbName)}.._V_SYNONYM WHERE UPPER(DATABASE) = UPPER(${escapeSqlLiteral(dbName)}) AND UPPER(SYNONYM_NAME) = UPPER(${escapeSqlLiteral(objectName)})${schemaName ? ` AND UPPER(SCHEMA) = UPPER(${escapeSqlLiteral(schemaName)})` : ''}`;
        const result = await runQueryRaw(this.context, query, true, this.connectionManager, connectionName, undefined, undefined, undefined, undefined, false);
        if (!result) return undefined;
        const rows = queryResultToRows<{ REFOBJNAME: string }>(result);
        const matchedRow = rows[0];
        if (!matchedRow?.REFOBJNAME) return undefined;

        return this.parseNetezzaSynonymReference(dbName, schemaName, matchedRow.REFOBJNAME);
    }

    private parseNetezzaSynonymReference(
        database: string,
        schema: string | undefined,
        referenceName: string
    ): { database: string; schema?: string; table: string } | undefined {
        const trimmedReference = referenceName.trim();
        if (!trimmedReference) {
            return undefined;
        }

        const strip = (value: string): string => stripIdentifierQuoting(value, 'netezza');
        const doubleDotIndex = trimmedReference.indexOf('..');
        if (doubleDotIndex > 0) {
            const refDatabase = strip(trimmedReference.slice(0, doubleDotIndex));
            const refTable = strip(trimmedReference.slice(doubleDotIndex + 2));
            if (!refDatabase || !refTable) {
                return undefined;
            }
            return {
                database: refDatabase,
                table: refTable
            };
        }

        const parts = trimmedReference.split('.').map(part => strip(part)).filter(part => part.length > 0);
        if (parts.length === 1) {
            return {
                database,
                schema,
                table: parts[0]
            };
        }

        if (parts.length === 2) {
            return {
                database,
                schema: parts[0],
                table: parts[1]
            };
        }

        return {
            database: parts[0],
            schema: parts[1],
            table: parts.slice(2).join('.')
        };
    }

    getTreeItem(element: SchemaItem): vscode.TreeItem {
        return element;
    }

    getParent(element: SchemaItem): SchemaItem | undefined {
        // Return parent based on context value
        if (element.contextValue === 'serverInstance') {
            return undefined; // Root
        } else if (element.contextValue === 'database') {
            return new SchemaItem(
                element.connectionName!,
                vscode.TreeItemCollapsibleState.Collapsed,
                'serverInstance',
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                element.connectionName,
                undefined, // customIconPath - we can't easily resolve it here without context, potentially issue?
            );
        } else if (element.contextValue.startsWith('typeGroup')) {
            // Parent is database
            return new SchemaItem(
                element.dbName!,
                vscode.TreeItemCollapsibleState.Collapsed,
                'database',
                element.dbName,
                undefined,
                undefined,
                undefined,
                undefined,
                element.connectionName,
            );
        } else if (element.contextValue.startsWith('netezza:')) {
            // Parent is typeGroup
            return new SchemaItem(
                element.objType!,
                vscode.TreeItemCollapsibleState.Collapsed,
                getTypeGroupContextValue(
                    element.objType,
                    this.getConnectionDatabaseKind(element.connectionName),
                ),
                element.dbName,
                element.objType,
                undefined,
                undefined,
                undefined,
                element.connectionName,
            );
        }
        return undefined;
    }

    async getChildren(element?: SchemaItem): Promise<SchemaItem[]> {
        await this.connectionManager.ensureFullyLoaded();

        if (element?.connectionName) {
            const cacheWithReadiness = this.metadataCache as MetadataCache & {
                whenConnectionMetadataReady?: (name: string) => Promise<void>;
            };
            if (typeof cacheWithReadiness.whenConnectionMetadataReady === 'function') {
                await cacheWithReadiness.whenConnectionMetadataReady(element.connectionName);
            } else {
                // Keep lightweight test doubles and older embedders compatible
                // while the concrete MetadataCache uses the startup barrier.
                await this.metadataCache.whenConnectionMetadataHydrated?.(element.connectionName);
            }
        }

        if (!element) {
            // Root: Filter item + Server Instances
            const t0 = performance.now();
            const connections = await this.connectionManager.getConnections();
            logWithFallback('debug', `[perf] SchemaProvider.getChildren(root): getConnections took ${(performance.now() - t0).toFixed(1)}ms, ${connections.length} connections`);
            const items: SchemaItem[] = [];

            // Add connection items
            connections.forEach((conn) => {
                items.push(
                    new SchemaItem(
                        conn.name,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'serverInstance',
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        conn.name,
                        undefined, // parentName
                        getDialectIconUri(this.context.extensionUri, conn.dbType), // Pass custom icon
                    ),
                );
            });

            // Add error indicators for connections with errors
            for (const conn of connections) {
                const error = this._connectionErrors.get(conn.name);
                if (error) {
                    items.push(this.createErrorItem(conn.name, error.message, 'root'));
                }
            }

            const cteRootItem = this.createCteRootItem();
            if (cteRootItem) {
                items.push(cteRootItem);
            }

            // Add Favorites node at the end
            const favoritesItem = new SchemaItem(
                'Favorites',
                vscode.TreeItemCollapsibleState.Collapsed,
                'favoritesRoot',
            );
            items.push(favoritesItem);

            return items;
        } else if (element.contextValue === 'cteRoot') {
            const ctes = this.getActiveCteDefinitions();
            if (ctes.length === 0) {
                return [this.createEmptyCteItem('(No CTEs in active SQL)')];
            }

            return ctes.map((cte) => {
                const objectType = this.mapCteTreeObjectType(cte.type);
                const item = new SchemaItem(
                    cte.name,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'cteObject',
                    undefined,
                    objectType,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    cte.name,
                    undefined,
                    undefined,
                    cte.columns,
                );
                const typeLabel = this.formatCteTreeTypeLabel(objectType);
                item.tooltip = new vscode.MarkdownString(`**${typeLabel}:** ${cte.name}`);
                return item;
            });
        } else if (element.contextValue === 'cteObject') {
            const columns = this.resolveCteColumnsForTreeItem(element);
            if (columns.length > 0) {
                element.cteColumns = columns;
            }
            if (columns.length === 0) {
                return [this.createEmptyCteItem('(Columns not inferred)')];
            }

            return columns.map((columnName) => {
                const item = new SchemaItem(
                    columnName,
                    vscode.TreeItemCollapsibleState.None,
                    'cteColumn',
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    element.rawLabel || element.label,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    columnName,
                );
                item.sourceContext = 'cte';
                item.id = `${item.id}|cte`;
                return item;
            });
        } else if (element.contextValue === 'favoritesRoot' || element.contextValue === 'favoritesFolder') {
            const favoritesManager = FavoritesManager.getInstance(this.context);
            // Provide undefined when it's the root node, else provide the element's id
            const parentId = element.contextValue === 'favoritesRoot' ? undefined : element.id;
            const favs = await favoritesManager.getFavoritesByParent(parentId);

            if (favs.length === 0) {
                const emptyMsg = element.contextValue === 'favoritesRoot' ? '(No favorites yet)' : '(Empty folder)';
                const emptyItem = new SchemaItem(emptyMsg, vscode.TreeItemCollapsibleState.None, 'emptyFavorites');
                return [emptyItem];
            }

            return favs.map((f) => {
                if (f.type === 'folder') {
                    const item = new SchemaItem(
                        f.label,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'favoritesFolder',
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        f.customNote || undefined,
                    );
                    item.id = f.id;
                    item.iconPath = new vscode.ThemeIcon('folder');
                    if (f.customNote) {
                        item.tooltip = new vscode.MarkdownString(`**Folder:** ${f.label}\n\n*Note:* ${f.customNote}`);
                    }
                    return item;
                } else if (f.type === 'sql') {
                    const item = new SchemaItem(
                        f.label,
                        vscode.TreeItemCollapsibleState.None,
                        'favoritesSql',
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        f.customNote || undefined,
                    );
                    item.id = f.id;
                    item.iconPath = new vscode.ThemeIcon('code');
                    item.command = {
                        command: 'netezza.favorites.openSql',
                        title: 'Open SQL Snippet',
                        arguments: [f, { fromTreeClick: true }],
                    };

                    let tooltip = `**SQL Snippet:** ${f.label}\n\n`;
                    if (f.customNote) {
                        tooltip += `*Note:* ${f.customNote}\n\n`;
                    }
                    if (f.sqlContent) {
                        const preview =
                            f.sqlContent.length > 500 ? f.sqlContent.substring(0, 500) + '...' : f.sqlContent;
                        tooltip += `\`\`\`sql\n${preview}\n\`\`\``;
                    }
                    item.tooltip = new vscode.MarkdownString(tooltip);
                    return item;
                } else {
                    const isExpandable = ['TABLE', 'VIEW', 'SYNONYM', 'EXTERNAL TABLE'].includes(f.objType || '');
                    const isCopilotEnabled = f.enabled !== false;
                    const isAutoInclude = f.autoInclude !== false;
                    const isTableOrView = ['TABLE', 'VIEW', 'SYNONYM', 'EXTERNAL TABLE'].includes(f.objType || '');
                    const rawLabel = unquoteIdentifier(f.label);

                    // Build description with Copilot status
                    let description = f.schema ? `(${f.schema})` : '';
                    if (isTableOrView) {
                        const copilotBadge = isCopilotEnabled
                            ? isAutoInclude
                                ? ' 🤖 auto'
                                : ' 🤖 manual'
                            : ' 🤖 disabled';
                        description += copilotBadge;
                    }

                    const item = new SchemaItem(
                        rawLabel,
                        isExpandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                        `favoritesObject:${f.objType}`, // allows standard interactions + favorite specific menus
                        f.dbName,
                        f.objType,
                        f.schema,
                        undefined,
                        f.customNote || f.description,
                        f.connectionName,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        f.owner,
                        rawLabel,
                    );
                    item.id = f.id;
                    item.description = description;

                    // Build tooltip with Copilot info
                    let tooltip = `**Favorite:** ${rawLabel} (${f.objType})\n\nDB: ${f.dbName}.${f.schema}`;
                    if (f.customNote) {
                        tooltip += `\n\n*Note:* ${f.customNote}`;
                    }
                    if (isTableOrView) {
                        tooltip += `\n\n---\n\n**Copilot Context:**`;
                        tooltip += `\n- Status: ${isCopilotEnabled ? '✅ Enabled' : '❌ Disabled'}`;
                        tooltip += `\n- Auto-include: ${isAutoInclude ? '✅ Yes' : '❌ No'}`;
                    }
                    item.tooltip = new vscode.MarkdownString(tooltip);

                    return item;
                }
            });
        } else if (element.contextValue.startsWith('favoritesObject:')) {
            // Children: Columns for TABLE/VIEW/SYNONYM/EXTERNAL TABLE favorites
            const tableName = element.rawLabel || element.label;
            const schemaName = element.schema;
            const dbName = element.dbName;

            // Try cache first
            if (element.connectionName && dbName) {
                const columnKey = buildColumnCacheKey(dbName, schemaName, tableName as string);
                await this.metadataCache.ensureColumnsLoadedForTableKey(element.connectionName, columnKey);
                const cachedCols = this.metadataCache.getColumns(element.connectionName, columnKey);

                if (hasTreeReadyColumnCache(cachedCols)) {
                    const visibleColumns = this.filterVisibleColumns(
                        tableName as string,
                        element.objectDescription,
                        cachedCols,
                    );
                    return visibleColumns.map((col: ColumnMetadata) => {
                        const item = new SchemaItem(
                            col.label || col.ATTNAME,
                            vscode.TreeItemCollapsibleState.None,
                            'column',
                            element.dbName,
                            undefined,
                            undefined,
                            undefined,
                            col.documentation || '',
                            element.connectionName,
                            tableName as string,
                            undefined,
                            col.isPk,
                            col.isFk,
                            undefined,
                            undefined,
                            col.detail || col.FORMAT_TYPE,
                            col.isDistributionKey,
                        );
                        // Mark as favorites source to differentiate from regular schema columns
                        item.sourceContext = 'favorites';
                        item.id = `${item.id}|favorites`;
                        return item;
                    });
                }
            }

            // If no cached columns, try to query
            if (!element.connectionName || !dbName) {
                return [];
            }

            try {
                const databaseKind = this.requireConnectionDatabaseKind(element.connectionName, 'load column metadata');

                let effectiveDbName = dbName;
                let effectiveSchemaName = schemaName || '';
                let effectiveTableName = tableName as string;
                if (element.objType === 'SYNONYM') {
                    const synonymTarget = await this.resolveNetezzaSynonymTarget(
                        element.connectionName!,
                        dbName,
                        schemaName || undefined,
                        tableName as string
                    );
                    if (synonymTarget) {
                        effectiveDbName = synonymTarget.database;
                        effectiveSchemaName = synonymTarget.schema || '';
                        effectiveTableName = synonymTarget.table;
                    }
                }

                const query = buildColumnMetadataQuery(effectiveDbName, effectiveSchemaName, effectiveTableName, databaseKind);

                const results = await runQueryWithTimeout(
                    this.context,
                    query,
                    this.connectionManager,
                    element.connectionName,
                    SCHEMA_QUERY_TIMEOUT,
                );
                const parsedColumns = parseColumnMetadata(results);

                // Cache the results
                const columnKey = buildColumnCacheKey(dbName, schemaName, tableName as string);
                const cacheItems = parsedColumns.map((col) =>
                    normalizeColumnCacheEntry({
                        ATTNAME: col.attname,
                        FORMAT_TYPE: col.formatType,
                        label: col.attname,
                        kind: 5,
                        detail: col.formatType,
                        documentation: col.description,
                        isPk: col.isPk,
                        isFk: col.isFk,
                        isDistributionKey: col.isDistributionKey,
                    }),
                );
                this.metadataCache.setColumns(element.connectionName, columnKey, cacheItems);

                const visibleParsedColumns = parsedColumns.filter((col) =>
                    columnVisibleInSchemaFilter({
                        regex: this._filterRegex,
                        tableName: tableName as string,
                        tableDescription: element.objectDescription,
                        column: {
                            ATTNAME: col.attname,
                            label: col.attname,
                            documentation: col.description,
                            FORMAT_TYPE: col.formatType,
                            detail: col.formatType,
                        },
                    }),
                );

                return visibleParsedColumns.map((col) => {
                    const item = new SchemaItem(
                        col.attname,
                        vscode.TreeItemCollapsibleState.None,
                        'column',
                        element.dbName,
                        undefined,
                        undefined,
                        undefined,
                        col.description,
                        element.connectionName,
                        tableName as string,
                        undefined,
                        col.isPk,
                        col.isFk,
                        undefined,
                        undefined,
                        col.formatType,
                        col.isDistributionKey,
                    );
                    // Mark as favorites source to differentiate from regular schema columns
                    item.sourceContext = 'favorites';
                    item.id = `${item.id}|favorites`;
                    return item;
                });
            } catch (e: unknown) {
                const errorMsg = e instanceof Error ? e.message : String(e);
                if (e instanceof SchemaQueryTimeoutError) {
                    vscode.window.showWarningMessage(`Schema load timeout: ${errorMsg}`);
                } else {
                    vscode.window.showErrorMessage('Failed to load columns: ' + errorMsg);
                }
                if (element.connectionName) {
                    this.setConnectionError(element.connectionName, errorMsg);
                }
                return [this.createErrorItem(element.connectionName, errorMsg, 'favoritesObject')];
            }
        } else if (element.contextValue === 'serverInstance') {
            // Children: Databases for this connection
            // Check cache first
            if (!element.connectionName) return [];

            const cachedDbs = this.metadataCache.getDatabases(element.connectionName);
            if (cachedDbs) {
                return cachedDbs.map(
                    (db: DatabaseMetadata) =>
                        new SchemaItem(
                            db.label || db.DATABASE, // simplified, dependent on what's stored
                            vscode.TreeItemCollapsibleState.Collapsed,
                            'database',
                            db.label || db.DATABASE,
                            undefined,
                            undefined,
                            undefined,
                            undefined,
                            element.connectionName,
                        ),
                );
            }

            try {
                const metadataProvider = this.getMetadataProvider(element.connectionName);
                const result = await runQueryWithTimeout(
                    this.context,
                    metadataProvider.buildListDatabasesQuery(),
                    this.connectionManager,
                    element.connectionName,
                    SCHEMA_QUERY_TIMEOUT,
                );
                if (!result) {
                    return [];
                }
                const databases = queryResultToRows<{ DATABASE: string }>(result);

                // Update Cache
                const cacheItems: DatabaseMetadata[] = databases.map((row: { DATABASE: string }) => ({
                    DATABASE: row.DATABASE,
                    label: row.DATABASE,
                    kind: 9, // Module
                    detail: 'Database',
                }));
                this.metadataCache.setDatabases(element.connectionName, cacheItems);

                return databases.map(
                    (db: { DATABASE: string }) =>
                        new SchemaItem(
                            db.DATABASE,
                            vscode.TreeItemCollapsibleState.Collapsed,
                            'database',
                            db.DATABASE,
                            undefined,
                            undefined,
                            undefined,
                            undefined,
                            element.connectionName,
                        ),
                );
            } catch (e: unknown) {
                const errorMsg = e instanceof Error ? e.message : String(e);
                if (e instanceof SchemaQueryTimeoutError) {
                    vscode.window.showWarningMessage(`Schema load timeout: ${errorMsg}`);
                } else {
                    vscode.window.showErrorMessage(
                        `Failed to load databases for ${element.connectionName}: ${errorMsg}`,
                    );
                }
                if (element.connectionName) {
                    this.setConnectionError(element.connectionName, errorMsg);
                }
                return [this.createErrorItem(element.connectionName, errorMsg, 'serverInstance')];
            }
        } else if (element.contextValue === 'database') {
            // Children: Object Types (Groups)
            const databaseKind = this.getConnectionDatabaseKind(element.connectionName);
            // Trigger background prefetch for this connection to warm up cache
            if (element.connectionName && element.dbName) {
                this.triggerDatabasePrefetch(element.connectionName, element.dbName);
            }
            // Get typeGroups - returns defaults if not cached (instant revealInSchema)
            if (element.connectionName && element.dbName) {
                const cachedTypes = this.metadataCache.getTypeGroups(element.connectionName, element.dbName);
                if (cachedTypes && cachedTypes.length > 0) {
                    // If using defaults (not real cached data), trigger background refresh
                    if (!this.metadataCache.hasCachedTypeGroups(element.connectionName, element.dbName)) {
                        this.triggerTypeGroupsRefresh(element.connectionName, element.dbName);
                    }
                    return cachedTypes.map(
                        (t: string) =>
                            new SchemaItem(
                                t,
                                vscode.TreeItemCollapsibleState.Collapsed,
                                getTypeGroupContextValue(t, databaseKind),
                                element.dbName,
                                t,
                                undefined,
                                undefined,
                                getTypeGroupInlineDescription(t, databaseKind),
                                element.connectionName,
                            ),
                    );
                }
            }

            // Fallback: query database (should rarely happen with defaults)
            try {
                const requiredDatabaseKind = this.requireConnectionDatabaseKind(
                    element.connectionName,
                    'load schema object groups',
                );
                const metadataProvider = this.getMetadataProvider(element.connectionName!);
                const query = metadataProvider.buildTypeGroupsQuery(element.dbName!);
                const result = await runQueryWithTimeout(
                    this.context,
                    query,
                    this.connectionManager,
                    element.connectionName,
                    SCHEMA_QUERY_TIMEOUT,
                );
                const types = result ? queryResultToRows<{ OBJTYPE: string }>(result) : [];

                // Cache the type groups
                if (element.connectionName && element.dbName) {
                    const typeList = types.map((t: { OBJTYPE: string }) => t.OBJTYPE);
                    this.metadataCache.setTypeGroups(element.connectionName, element.dbName, typeList);
                }

                return types.map(
                    (t: { OBJTYPE: string }) =>
                        new SchemaItem(
                            t.OBJTYPE,
                            vscode.TreeItemCollapsibleState.Collapsed,
                            getTypeGroupContextValue(t.OBJTYPE, requiredDatabaseKind),
                            element.dbName,
                            t.OBJTYPE,
                            undefined,
                            undefined,
                            getTypeGroupInlineDescription(t.OBJTYPE, requiredDatabaseKind),
                            element.connectionName,
                        ),
                );
            } catch (e: unknown) {
                const errorMsg = e instanceof Error ? e.message : String(e);
                if (e instanceof SchemaQueryTimeoutError) {
                    vscode.window.showWarningMessage(`Schema load timeout: ${errorMsg}`);
                } else {
                    vscode.window.showErrorMessage('Failed to load object types: ' + errorMsg);
                }
                if (element.connectionName) {
                    this.setConnectionError(element.connectionName, errorMsg);
                }
                return [this.createErrorItem(element.connectionName, errorMsg, 'database')];
            }
        } else if (element.contextValue.startsWith('typeGroup')) {
            // Children: Objects of specific type
            const databaseKind = this.getConnectionDatabaseKind(element.connectionName);
            const connectionName = element.connectionName;
            const dbName = element.dbName;
            const objType = element.objType;

            if (connectionName && dbName && objType) {
                if (objType === 'PROCEDURE') {
                    const cachedProcedures = this.metadataCache.getProceduresForDatabase(
                        connectionName,
                        dbName,
                    );
                    if (cachedProcedures !== undefined) {
                        return this.mapCachedProceduresToSchemaItems(
                            cachedProcedures,
                            dbName,
                            connectionName,
                            databaseKind,
                        );
                    }
                    if (this.metadataCache.isProcedureCatalogLoaded(connectionName, dbName)) {
                        return [];
                    }
                } else if (isTableCacheObjectType(objType)) {
                    const cachedObjectsByType = this.metadataCache.getObjectsByType(
                        connectionName,
                        dbName,
                        objType,
                    );
                    if (cachedObjectsByType !== undefined) {
                        if (cachedObjectsByType.length === 0) {
                            if (
                                this.metadataCache.areObjectsCatalogLoadedForDatabase(
                                    connectionName,
                                    dbName,
                                    objType,
                                )
                            ) {
                                return [];
                            }
                        } else {
                            return this.mapCachedTableObjectsToSchemaItems(
                                cachedObjectsByType,
                                dbName,
                                objType,
                                connectionName,
                                databaseKind,
                            );
                        }
                    }
                }
            }

            try {
                const requiredDatabaseKind = this.requireConnectionDatabaseKind(
                    element.connectionName,
                    'load schema objects',
                );
                const query = this.getMetadataProvider(element.connectionName!).buildObjectTypeQuery(
                    element.dbName!,
                    element.objType!,
                );
                const result = await runQueryWithTimeout(
                    this.context,
                    query,
                    this.connectionManager,
                    element.connectionName,
                    SCHEMA_QUERY_TIMEOUT,
                );
                const objects = result
                    ? queryResultToRows<{
                          OBJNAME: string;
                          TABLENAME?: string;
                          SCHEMA?: string;
                          OBJID?: number;
                          DESCRIPTION?: string;
                          detail?: string;
                          OWNER?: string;
                          label?: string | { label: string };
                      }>(result)
                    : [];

                // Write-back to cache to warm it up
                if (connectionName && dbName && objType === 'PROCEDURE') {
                    this.writeBackProceduresToCache(connectionName, dbName, objects);
                    this.metadataCache.markProcedureCatalogLoaded(connectionName, dbName);
                } else if (connectionName && dbName && objType && isTableCacheObjectType(objType)) {
                    const objectsBySchema = new Map<string, { tables: TableMetadata[] }>();

                    for (const obj of objects) {
                        const schemaKey = obj.SCHEMA ? `${element.dbName}.${obj.SCHEMA}` : `${element.dbName}..`;
                        if (!objectsBySchema.has(schemaKey)) {
                            objectsBySchema.set(schemaKey, { tables: [] });
                        }
                        const entry = objectsBySchema.get(schemaKey)!;

                        entry.tables.push({
                            OBJNAME: obj.OBJNAME,
                            OBJID: obj.OBJID,
                            SCHEMA: obj.SCHEMA,
                            OWNER: obj.OWNER,
                            DESCRIPTION: obj.DESCRIPTION,
                            label: obj.OBJNAME,
                            kind:
                                objType === 'VIEW'
                                || objType === 'MATERIALIZED VIEW'
                                || objType === 'SYSTEM VIEW'
                                    ? vscode.CompletionItemKind.Interface
                                    : vscode.CompletionItemKind.Class,
                            objType,
                            detail: obj.SCHEMA ? `${objType} (${obj.SCHEMA})` : objType,
                            sortText: obj.OBJNAME,
                        });
                    }

                    // Save to cache for autocomplete
                    for (const [, entry] of objectsBySchema) {
                        const schemaName = entry.tables[0]?.SCHEMA as string | undefined;
                        const dbName = element.dbName;
                        const connectionName = element.connectionName;
                        if (!dbName || !connectionName) {
                            continue;
                        }
                        refreshTableLikeTypeForSchema(
                            this.metadataCache,
                            connectionName,
                            dbName,
                            schemaName,
                            objType,
                            entry.tables,
                            (mergedTables) =>
                                buildSchemaTableIdMap(
                                    dbName,
                                    schemaName,
                                    mergedTables,
                                ),
                        );
                        this.metadataCache.markObjectsCatalogLoaded(
                            connectionName,
                            buildSchemaCacheKey(dbName, schemaName),
                            objType,
                        );
                    }
                }

                let finalObjects = objects;
                if (this._filterRegex) {
                    finalObjects = objects.filter((obj) =>
                        this.tableMatchesFilter(
                            element.connectionName,
                            element.dbName,
                            obj.SCHEMA,
                            obj.OBJNAME,
                            obj.DESCRIPTION || obj.detail,
                        ),
                    );
                }

                return finalObjects.map(
                    (obj: {
                        OBJNAME: string;
                        TABLENAME?: string;
                        SCHEMA?: string;
                        OBJID?: number;
                        DESCRIPTION?: string;
                        detail?: string;
                        OWNER?: string;
                        label?: string | { label: string };
                    }) => {
                        const expandableTypes = [
                            'TABLE',
                            'GLOBAL TEMP TABLE',
                            'VIEW',
                            'NICKNAME',
                            'ALIAS',
                            'SYNONYM',
                            'EXTERNAL TABLE',
                            'DYNAMIC TABLE',
                            'SYSTEM VIEW',
                            'SYSTEM TABLE',
                        ];
                        const isExpandable = expandableTypes.includes(element.objType || '');
                        const rawObjectName =
                            obj.OBJNAME ||
                            obj.TABLENAME ||
                            (typeof obj.label === 'string' ? obj.label : obj.label?.label || '');
                        return new SchemaItem(
                            rawObjectName,
                            isExpandable
                                ? vscode.TreeItemCollapsibleState.Collapsed
                                : vscode.TreeItemCollapsibleState.None,
                            getSchemaObjectContextValue(element.objType, requiredDatabaseKind),
                            element.dbName,
                            element.objType,
                            obj.SCHEMA,
                            obj.OBJID,
                            obj.DESCRIPTION || obj.detail,
                            element.connectionName,
                            undefined, // parentName
                            undefined, // customIconPath
                            undefined, // isPk
                            undefined, // isFk
                            obj.OWNER, // owner
                            rawObjectName,
                        );
                    },
                );
            } catch (e: unknown) {
                const errorMsg = e instanceof Error ? e.message : String(e);
                if (e instanceof SchemaQueryTimeoutError) {
                    vscode.window.showWarningMessage(`Schema load timeout: ${errorMsg}`);
                } else {
                    vscode.window.showErrorMessage('Failed to load objects: ' + errorMsg);
                }
                if (element.connectionName) {
                    this.setConnectionError(element.connectionName, errorMsg);
                }
                return [this.createErrorItem(element.connectionName, errorMsg, 'typeGroup')];
            }
        } else if (element.contextValue.startsWith('netezza:')) {
            // Children: Columns
            const tableName = element.rawLabel || element.label;
            const schemaName = element.schema;
            const dbName = element.dbName;

            // Try cache first (works even without objId)
            if (element.connectionName && dbName) {
                const columnKey = buildColumnCacheKey(dbName, schemaName, tableName as string);
                await this.metadataCache.ensureColumnsLoadedForTableKey(element.connectionName, columnKey);
                const cachedCols = this.metadataCache.getColumns(element.connectionName, columnKey);

                // Check if cache has isPk — if not, refetch for PK/FK tree badges
                if (hasTreeReadyColumnCache(cachedCols)) {
                    const visibleColumns = this.filterVisibleColumns(
                        tableName as string,
                        element.objectDescription,
                        cachedCols,
                    );
                    return visibleColumns.map((col: ColumnMetadata) => {
                        const item = new SchemaItem(
                            col.label || col.ATTNAME,
                            vscode.TreeItemCollapsibleState.None,
                            'column',
                            element.dbName,
                            undefined,
                            undefined,
                            undefined,
                            col.documentation || '', // Assuming description stored in documentation or similar
                            element.connectionName,
                            tableName, // Parent (Table) Name
                            undefined,
                            col.isPk, // Retrieve isPk from cache
                            col.isFk, // Retrieve isFk from cache
                            undefined,
                            undefined,
                            col.detail || col.FORMAT_TYPE,
                            col.isDistributionKey,
                        );
                        // Mark as schema source to differentiate from favorites columns
                        item.sourceContext = 'schema';
                        item.id = `${item.id}|schema`;
                        return item;
                    });
                }
                // If cache is stale (no isPk), fall through to refetch
            }

            // If no cached columns, try to query (need connection)
            if (!element.connectionName || !dbName) {
                return [];
            }

            try {
                const databaseKind = this.requireConnectionDatabaseKind(element.connectionName, 'load column metadata');

                let effectiveDbName = dbName;
                let effectiveSchemaName = schemaName || '';
                let effectiveTableName = tableName as string;
                if (element.objType === 'SYNONYM') {
                    const synonymTarget = await this.resolveNetezzaSynonymTarget(
                        element.connectionName!,
                        dbName,
                        schemaName || undefined,
                        tableName as string
                    );
                    if (synonymTarget) {
                        effectiveDbName = synonymTarget.database;
                        effectiveSchemaName = synonymTarget.schema || '';
                        effectiveTableName = synonymTarget.table;
                    }
                }

                const query = buildColumnMetadataQuery(effectiveDbName, effectiveSchemaName, effectiveTableName, databaseKind);

                const results = await runQueryWithTimeout(
                    this.context,
                    query,
                    this.connectionManager,
                    element.connectionName,
                    SCHEMA_QUERY_TIMEOUT,
                );
                const parsedColumns = parseColumnMetadata(results);

                // Cache the results under the synonym's own key
                const columnKey = buildColumnCacheKey(dbName, schemaName, tableName as string);
                const cacheItems = parsedColumns.map((col) =>
                    normalizeColumnCacheEntry({
                        ATTNAME: col.attname,
                        FORMAT_TYPE: col.formatType,
                        label: col.attname,
                        kind: 5,
                        detail: col.formatType,
                        documentation: col.description,
                        isPk: col.isPk,
                        isFk: col.isFk,
                        isDistributionKey: col.isDistributionKey,
                    }),
                );
                this.metadataCache.setColumns(element.connectionName, columnKey, cacheItems);

                const visibleParsedColumns = parsedColumns.filter((col) =>
                    columnVisibleInSchemaFilter({
                        regex: this._filterRegex,
                        tableName: tableName as string,
                        tableDescription: element.objectDescription,
                        column: {
                            ATTNAME: col.attname,
                            label: col.attname,
                            documentation: col.description,
                            FORMAT_TYPE: col.formatType,
                            detail: col.formatType,
                        },
                    }),
                );

                return visibleParsedColumns.map((col) => {
                    const item = new SchemaItem(
                        col.attname,
                        vscode.TreeItemCollapsibleState.None,
                        'column',
                        element.dbName,
                        undefined,
                        undefined,
                        undefined,
                        col.description,
                        element.connectionName,
                        tableName as string, // Parent (Table) Name
                        undefined,
                        col.isPk,
                        col.isFk,
                        undefined,
                        undefined,
                        col.formatType,
                        col.isDistributionKey,
                    );
                    // Mark as schema source to differentiate from favorites columns
                    item.sourceContext = 'schema';
                    item.id = `${item.id}|schema`;
                    return item;
                });
            } catch (e: unknown) {
                const errorMsg = e instanceof Error ? e.message : String(e);
                if (e instanceof SchemaQueryTimeoutError) {
                    vscode.window.showWarningMessage(`Schema load timeout: ${errorMsg}`);
                } else {
                    vscode.window.showErrorMessage('Failed to load columns: ' + errorMsg);
                }
                if (element.connectionName) {
                    this.setConnectionError(element.connectionName, errorMsg);
                }
                return [this.createErrorItem(element.connectionName, errorMsg, 'netezza')];
            }
        }

        return [];
    }

    /**
     * Create an error item to display in the tree
     */
    private createErrorItem(
        connectionName: string | undefined,
        errorMessage: string,
        parentContext?: string,
    ): SchemaItem {
        const item = new SchemaItem(
            `Error: ${errorMessage}`,
            vscode.TreeItemCollapsibleState.None,
            'schemaError',
            parentContext === 'database' ? undefined : parentContext === 'typeGroup' ? undefined : undefined,
            undefined,
            undefined,
            undefined,
            errorMessage,
            connectionName,
        );
        item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
        return item;
    }
}

export class SchemaItem extends vscode.TreeItem {
    /**
     * Source context for the item - used to differentiate between Favorites and regular schema items
     * to prevent duplicate ID errors when the same table is expanded in both views.
     */
    public sourceContext?: string;
    public readonly rawLabel: string;

    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string,
        public readonly dbName?: string,
        public readonly objType?: string,
        public readonly schema?: string,
        public readonly objId?: number,
        public readonly objectDescription?: string,
        public readonly connectionName?: string,
        public readonly parentName?: string, // Add parent (Table) name for stable ID
        customIconPath?: vscode.Uri,
        public readonly isPk?: boolean,
        public readonly isFk?: boolean,
        public readonly owner?: string,
        rawLabel?: string,
        public readonly dataType?: string,
        public readonly isDistributionKey?: boolean,
        public cteColumns?: string[],
    ) {
        super(label, collapsibleState);
        this.rawLabel = rawLabel ?? label;

        // Build tooltip with Description if available
        let tooltipText = this.label;
        if (connectionName) {
            tooltipText += `\n[Server: ${connectionName}]`;
        }
        if (contextValue === 'column' && dataType) {
            tooltipText += `\nType: ${dataType}`;
        }
        if (schema && contextValue.startsWith('netezza:')) {
            tooltipText += `\nSchema: ${schema}`;
        }
        if (owner && contextValue.startsWith('netezza:')) {
            tooltipText += `\nOwner: ${owner}`;
        }

        if (this.isPk) tooltipText += `\n🔑 Primary Key`;
        if (this.isFk) tooltipText += `\n🔗 Foreign Key`;
        if (this.isDistributionKey) tooltipText += `\n📊 Distribution Key`;
        if (objectDescription && objectDescription.trim()) {
            tooltipText += `\n\n${objectDescription.trim()}`;
        }

        this.tooltip = tooltipText;

        this.description = buildInlineTreeDescription(contextValue, schema, objectDescription, dataType);

        if (contextValue === 'serverInstance') {
            this.resourceUri = getConnectionAccentResourceUri(connectionName || this.rawLabel);
        }

        // Generate a stable ID for the tree item to support reveal()
        // Format: connection|context|database|schema|objType|parentName|label|objId
        // Include sourceContext if available to differentiate Favorites from regular schema items
        const parts = [
            connectionName || 'global',
            contextValue,
            dbName || '',
            schema || '',
            objType || '',
            parentName || '',
            this.rawLabel,
            objId ? objId.toString() : '',
        ];
        // Note: sourceContext is appended after construction for Favorites items
        this.id = parts.join('|');

        if (customIconPath) {
            this.iconPath = customIconPath;
        } else if (contextValue === 'serverInstance') {
            this.iconPath = new vscode.ThemeIcon('server');
        } else if (contextValue === 'database') {
            this.iconPath = new vscode.ThemeIcon('database');
        } else if (contextValue.startsWith('typeGroup')) {
            this.iconPath = new vscode.ThemeIcon('folder');
        } else if (contextValue === 'favoritesRoot') {
            this.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'));
        } else if (contextValue === 'cteRoot') {
            this.iconPath = new vscode.ThemeIcon('symbol-namespace');
        } else if (contextValue === 'cteObject') {
            this.iconPath = objType === 'TEMP TABLE' ? new vscode.ThemeIcon('table') : new vscode.ThemeIcon('symbol-struct');
        } else if (contextValue === 'cteColumn') {
            this.iconPath = new vscode.ThemeIcon('symbol-field');
        } else if (contextValue === 'emptyCtes') {
            this.iconPath = new vscode.ThemeIcon('info');
        } else if (contextValue.startsWith('netezza:') || contextValue.startsWith('favoritesObject:')) {
            this.iconPath = this.getIconForType(objType);
        } else if (contextValue === 'column') {
            this.iconPath = this.isPk
                ? new vscode.ThemeIcon('key', new vscode.ThemeColor('charts.yellow'))
                : this.isDistributionKey
                  ? new vscode.ThemeIcon('symbol-structure', new vscode.ThemeColor('charts.green'))
                  : this.isFk
                    ? new vscode.ThemeIcon('link', new vscode.ThemeColor('charts.blue'))
                    : new vscode.ThemeIcon('symbol-field');
        }

        // Add command for insert to editor
        const insertableContexts = [
            'netezza:TABLE',
            'netezza:GLOBAL TEMP TABLE',
            'netezza:VIEW',
            'netezza:NICKNAME',
            'netezza:ALIAS',
            'netezza:SYNONYM',
            'netezza:EXTERNAL TABLE',
            'netezza:SYSTEM TABLE',
            'netezza:SYSTEM VIEW',
            'netezza:PROCEDURE',
            'netezza:FUNCTION',
            'column',
            'favoritesObject:TABLE',
            'favoritesObject:VIEW',
            'favoritesObject:NICKNAME',
            'favoritesObject:ALIAS',
            'favoritesObject:SYNONYM',
            'favoritesObject:EXTERNAL TABLE',
            'favoritesObject:PROCEDURE',
            'favoritesObject:FUNCTION',
            'cteObject',
            'cteColumn',
        ];
        if (insertableContexts.includes(contextValue)) {
            this.command = {
                command: 'netezza.insertToEditor',
                title: 'Insert to Editor',
                arguments: [this, { fromTreeClick: true }],
            };
        }
    }

    private getIconForType(type?: string): vscode.ThemeIcon {
        switch (type) {
            case 'TABLE':
            case 'GLOBAL TEMP TABLE':
                return new vscode.ThemeIcon('table');
            case 'VIEW':
                return new vscode.ThemeIcon('eye');
            case 'NICKNAME':
                return new vscode.ThemeIcon('references');
            case 'ALIAS':
                return new vscode.ThemeIcon('symbol-namespace');
            case 'SYNONYM':
                return new vscode.ThemeIcon('references');
            case 'PROCEDURE':
                return new vscode.ThemeIcon('gear');
            case 'FUNCTION':
                return new vscode.ThemeIcon('symbol-function');
            case 'AGGREGATE':
                return new vscode.ThemeIcon('symbol-operator');
            case 'EXTERNAL TABLE':
                return new vscode.ThemeIcon('server');
            case 'SERVER':
                return new vscode.ThemeIcon('server');
            case 'WRAPPER':
                return new vscode.ThemeIcon('package');
            case 'SERVER OPTION':
            case 'WRAPPER OPTION':
                return new vscode.ThemeIcon('gear');
            case 'USER MAPPING':
                return new vscode.ThemeIcon('account');
            case 'PASSTHRU AUTH':
                return new vscode.ThemeIcon('shield');
            default:
                return new vscode.ThemeIcon('file');
        }
    }
}
