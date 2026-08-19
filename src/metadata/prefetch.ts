/**
 * Metadata Cache - Prefetch Module
 * Background data fetching logic for eager cache population
 */

import type { MetadataPrefetchTarget } from './cache/MetadataPrefetchTarget';
import { normalizeCompletionDescription } from '../utils/completionDescriptionUtils';

/**
 * Minimum interval between automatic (warmup-triggered) full prefetches.
 * Prevents a failed prefetch from being retriggered on every cache miss,
 * which floods the database with heavy catalog queries.
 */
export const PREFETCH_RETRY_BACKOFF_MS = 5 * 60 * 1000;

/**
 * Returns true for expected errors that occur during DDL scripts when metadata is
 * fetched before objects exist. These are harmless and should be logged as warn.
 */
export function isExpectedCatalogError(e: unknown): boolean {
    if (!(e instanceof Error)) {
        return false;
    }
    const msg = e.message;
    return isDatabaseLevelCatalogError(e)
        || msg.includes('does not exist')
        || msg.includes('relation does not exist')
        || msg.includes('object not found');
}

/** Database-level catalog failures — safe to skip further queries for that database. */
export function isDatabaseLevelCatalogError(e: unknown): boolean {
    if (!(e instanceof Error)) {
        return false;
    }
    const msg = e.message;
    return msg.includes('ResolveCatalog')
        || msg.includes('error retrieving database');
}

function logPrefetchError(message: string, e: unknown): void {
    if (isExpectedCatalogError(e)) {
        Logger.getInstance().warn(message, e);
    } else {
        Logger.getInstance().error(message, e);
    }
}
import {
    buildColumnCacheKey,
    groupColumnRowsByTableKey,
    normalizeCatalogPart,
    type RawColumnRowWithKeys,
} from './columnRowMapping';
import {
    buildDbSchemaCacheKey,
    buildNetezzaDbSchemaCacheKey,
    buildNetezzaCacheDatabasePart,
    extractLabel,
} from './helpers';
import {
    getMetadataQueryConcurrencyLimit,
    runWithMetadataQueryConcurrencyLimit,
} from './metadataQueryLimiter';
import { mirrorSynonymColumnsForConnection } from './synonymColumns';
import { TableMetadata, ProcedureMetadata } from './types';
import { QueryResult } from '../types';
import { NZ_QUERIES } from './systemQueries';
import {
    createNetezzaCatalogIdentifier,
    createNetezzaUserIdentifier,
} from '../dialects/netezza/metadata/identifierUtils';
import { Logger } from '../utils/logger';
import type {
    MetadataQueryContext,
    MetadataQueryKind,
    MetadataRequestSource,
} from './metadataQueryDiagnostics';

/**
 * Type for query execution function (legacy - returns JSON string)
 */
export type QueryRunnerFn = (query: string) => Promise<string | undefined>;

/**
 * Type for raw query execution function (returns QueryResult directly - no JSON serialization)
 */
export type QueryRunnerRawFn = (
    query: string,
    metadataContext?: MetadataQueryContext,
) => Promise<QueryResult | undefined>;

/**
 * A query runner may own a short-lived connection shared by one full metadata
 * refresh. The prefetcher disposes it after every terminal path, including a
 * rejected lock acquisition, so the scoped session can never leak.
 */
export type DisposableQueryRunnerRawFn = QueryRunnerRawFn & {
    dispose?: () => Promise<void>;
};

async function runPrefetchQuery(
    connectionName: string,
    runQueryFn: QueryRunnerRawFn,
    query: string,
    context: Omit<MetadataQueryContext, 'connectionName'> & { source: MetadataRequestSource; kind: MetadataQueryKind },
): Promise<QueryResult | undefined> {
    return runWithMetadataQueryConcurrencyLimit(connectionName, (queueWaitMs) =>
        runQueryFn(query, {
            ...context,
            connectionName,
            queueWaitMs,
        }),
    );
}

export type MetadataPrefetchProgressStage =
    | 'start'
    | 'databases'
    | 'schemas'
    | 'objects'
    | 'procedures'
    | 'columns'
    | 'complete'
    | 'error';

export interface MetadataPrefetchProgress {
    connectionName: string;
    stage: MetadataPrefetchProgressStage;
    percent: number;
    message: string;
    completed?: number;
    total?: number;
}

export type PrefetchProgressReporter = (progress: MetadataPrefetchProgress) => void;

/**
 * Convert QueryResult (columns[] + data[][]) to array of typed objects
 * This replaces JSON.parse() and avoids double serialization/deserialization
 */
function queryResultToRows<T extends Record<string, unknown>>(result: QueryResult): T[] {
    if (!result.columns || !result.data || result.data.length === 0) {
        return [];
    }

    return result.data.map(row => {
        const obj: Record<string, unknown> = {};
        result.columns.forEach((col, index) => {
            obj[col.name] = row[index];
        });
        return obj as T;
    });
}

interface RawObjectRow {
    OBJNAME: string;
    OBJID: number;
    SCHEMA: string;
    DBNAME: string;
    OBJTYPE?: string;
    REFOBJNAME?: string;
    OWNER?: string;
    DESCRIPTION?: string;
    [key: string]: unknown;
}

interface RawSchemaRow {
    SCHEMA: string;
    [key: string]: unknown;
}

interface RawDatabaseRow {
    DATABASE: string;
    [key: string]: unknown;
}

interface RawProcedureRow {
    SCHEMA?: string | null;
    PROCEDURE?: string | null;
    PROCEDURESIGNATURE?: string | null;
    OWNER?: string | null;
    DATABASE?: string | null;
    [key: string]: unknown;
}

interface RawTypeGroupRow {
    OBJTYPE: string;
    [key: string]: unknown;
}

function mapPrefetchObjectRow(row: RawObjectRow, preserveCatalogIdentity = false): TableMetadata {
    const normalizedObjectType = row.OBJTYPE?.trim().toUpperCase() || 'TABLE';
    const identityOptions = preserveCatalogIdentity ? { preserveWhitespace: true } : undefined;
    const objectName = normalizeCatalogPart(row.OBJNAME, identityOptions);
    const schemaName = normalizeCatalogPart(row.SCHEMA, identityOptions);
    const databaseName = normalizeCatalogPart(row.DBNAME, identityOptions);
    const isViewLike =
        normalizedObjectType === 'VIEW'
        || normalizedObjectType === 'MATERIALIZED VIEW'
        || normalizedObjectType === 'SYSTEM VIEW';
    const typeLabelByObjType: Record<string, string> = {
        SYNONYM: 'Synonym',
        VIEW: 'View',
        'MATERIALIZED VIEW': 'Materialized View',
        'SYSTEM VIEW': 'System View',
        'SYSTEM TABLE': 'System Table',
        SEQUENCE: 'Sequence',
        TABLE: 'Table',
        'EXTERNAL TABLE': 'External Table',
    };
    const typeLabel = typeLabelByObjType[normalizedObjectType] ?? normalizedObjectType;

    return {
        OBJNAME: objectName,
        label: objectName,
        kind: isViewLike ? 18 : 6,
        detail: schemaName ? typeLabel : `${typeLabel} (${schemaName})`,
        objType: normalizedObjectType,
        OBJID: row.OBJID,
        SCHEMA: schemaName,
        DBNAME: databaseName,
        OWNER: normalizeCatalogPart(row.OWNER, identityOptions),
        DESCRIPTION: normalizeCompletionDescription(row.DESCRIPTION),
        REFOBJNAME: normalizeCatalogPart(row.REFOBJNAME, identityOptions),
    };
}

function normalizeRawObjectRow(row: RawObjectRow, preserveCatalogIdentity = false): RawObjectRow {
    const identityOptions = preserveCatalogIdentity ? { preserveWhitespace: true } : undefined;
    return {
        ...row,
        OBJNAME: normalizeCatalogPart(row.OBJNAME, identityOptions),
        SCHEMA: normalizeCatalogPart(row.SCHEMA, identityOptions),
        DBNAME: normalizeCatalogPart(row.DBNAME, identityOptions),
        OBJTYPE: normalizeCatalogPart(row.OBJTYPE).toUpperCase(),
        OWNER: normalizeCatalogPart(row.OWNER),
        REFOBJNAME: normalizeCatalogPart(row.REFOBJNAME),
        DESCRIPTION: normalizeCompletionDescription(row.DESCRIPTION),
    };
}

function objectMergeKey(row: RawObjectRow, preserveCatalogIdentity = false): string {
    const normalized = normalizeRawObjectRow(row, preserveCatalogIdentity);
    const identity = normalized.OBJID !== undefined
        ? `id:${String(normalized.OBJID)}`
        : `type:${normalized.OBJTYPE ?? ''}`;
    const parts = [normalized.DBNAME, normalized.SCHEMA, normalized.OBJNAME, identity];
    return preserveCatalogIdentity
        ? parts.join('|')
        : parts.map((part) => String(part ?? '').toUpperCase()).join('|');
}

function mergeObjectRows(
    primaryRows: RawObjectRow[],
    fallbackRows: RawObjectRow[],
    preserveCatalogIdentity = false,
): RawObjectRow[] {
    const rowsByKey = new Map<string, RawObjectRow>();
    for (const row of [...primaryRows, ...fallbackRows]) {
        const normalized = normalizeRawObjectRow(row, preserveCatalogIdentity);
        const key = objectMergeKey(normalized, preserveCatalogIdentity);
        if (!rowsByKey.has(key)) {
            rowsByKey.set(key, normalized);
        }
    }
    return [...rowsByKey.values()];
}

function tableMetadataMergeKey(
    table: TableMetadata,
    fallbackDatabase: string,
    preserveCatalogIdentity = false,
): string {
    const label = typeof table.label === 'string'
        ? table.label
        : table.label?.label;
    const parts = [
        normalizeCatalogPart(String(table.DBNAME ?? fallbackDatabase), { preserveWhitespace: preserveCatalogIdentity }),
        normalizeCatalogPart(table.SCHEMA, { preserveWhitespace: preserveCatalogIdentity }),
        normalizeCatalogPart(table.OBJNAME ?? table.TABLENAME ?? label, { preserveWhitespace: preserveCatalogIdentity }),
        String(table.OBJID ?? table.objType ?? table.TYPE ?? ''),
    ];
    return preserveCatalogIdentity
        ? parts.join('|')
        : parts.map((part) => String(part ?? '').toUpperCase()).join('|');
}

/**
 * Add newly discovered external objects to a hydrated cache without replacing
 * unrelated objects already present in the schema/DB layer.
 */
function mergeCachedObjectRows(
    existingRows: TableMetadata[],
    discoveredRows: TableMetadata[],
    fallbackDatabase: string,
    preserveCatalogIdentity = false,
): TableMetadata[] {
    const rowsByKey = new Map<string, TableMetadata>();
    for (const row of existingRows) {
        rowsByKey.set(tableMetadataMergeKey(row, fallbackDatabase, preserveCatalogIdentity), row);
    }
    for (const row of discoveredRows) {
        const key = tableMetadataMergeKey(row, fallbackDatabase, preserveCatalogIdentity);
        const existing = rowsByKey.get(key);
        // An external row is a compatibility supplement. It may refresh an
        // old EXTERNAL TABLE entry, but it must never replace a regular object
        // with the same normalized name from the primary catalog.
        if (!existing || String(existing.objType ?? existing.TYPE ?? '').trim().toUpperCase() === 'EXTERNAL TABLE') {
            rowsByKey.set(key, row);
        }
    }
    return [...rowsByKey.values()];
}

function buildObjectIdMap(
    database: string,
    rows: TableMetadata[],
    preserveCatalogIdentity = false,
): Map<string, number> {
    const idMap = new Map<string, number>();
    for (const row of rows) {
        const objectName = normalizeCatalogPart(row.OBJNAME ?? row.TABLENAME ?? (
            typeof row.label === 'string' ? row.label : row.label?.label
        ), { preserveWhitespace: preserveCatalogIdentity });
        if (!objectName || typeof row.OBJID !== 'number') {
            continue;
        }
        idMap.set(
            buildColumnCacheKey(
                normalizeCatalogPart(String(row.DBNAME ?? database), { preserveWhitespace: preserveCatalogIdentity }),
                normalizeCatalogPart(row.SCHEMA, { preserveWhitespace: preserveCatalogIdentity }) || undefined,
                objectName,
                preserveCatalogIdentity
                    ? { preserveCase: true, exactNetezza: true }
                    : undefined,
            ),
            row.OBJID,
        );
    }
    return idMap;
}

function normalizeRawColumnRow(row: RawColumnRowWithKeys, preserveCatalogIdentity = false): RawColumnRowWithKeys {
    const identityOptions = preserveCatalogIdentity ? { preserveWhitespace: true } : undefined;
    return {
        ...row,
        TABLENAME: normalizeCatalogPart(row.TABLENAME, identityOptions),
        SCHEMA: normalizeCatalogPart(row.SCHEMA, identityOptions),
        DBNAME: normalizeCatalogPart(row.DBNAME, identityOptions),
        ATTNAME: normalizeCatalogPart(row.ATTNAME, identityOptions),
    };
}

function columnMergeKey(row: RawColumnRowWithKeys, preserveCatalogIdentity = false): string {
    const normalized = normalizeRawColumnRow(row, preserveCatalogIdentity);
    const parts = [normalized.DBNAME, normalized.SCHEMA, normalized.TABLENAME, normalized.ATTNAME];
    return preserveCatalogIdentity
        ? parts.join('|')
        : parts.map((part) => (part ?? '').toUpperCase()).join('|');
}

function mergeColumnRows(
    primaryRows: RawColumnRowWithKeys[],
    fallbackRows: RawColumnRowWithKeys[],
    preserveCatalogIdentity = false,
): RawColumnRowWithKeys[] {
    const rowsByKey = new Map<string, RawColumnRowWithKeys>();
    for (const row of [...primaryRows, ...fallbackRows]) {
        const normalized = normalizeRawColumnRow(row, preserveCatalogIdentity);
        const key = columnMergeKey(normalized, preserveCatalogIdentity);
        if (!rowsByKey.has(key)) {
            rowsByKey.set(key, normalized);
        }
    }
    return [...rowsByKey.values()];
}

function hasExternalTableForDatabase(
    cache: MetadataPrefetchTarget,
    connectionName: string,
    dbName: string,
    schemaName?: string,
): boolean {
    const preserveCatalogIdentity = cache.isNetezzaConnection?.(connectionName) === true;
    const normalizedDb = preserveCatalogIdentity
        ? buildNetezzaCacheDatabasePart(dbName)
        : dbName.trim().toUpperCase();
    const normalizedSchema = preserveCatalogIdentity
        ? schemaName
        : schemaName?.trim().toUpperCase();
    const prefix = `${connectionName}|${normalizedDb}.`;

    for (const [key, entry] of cache.tableCache) {
        if (!key.startsWith(prefix)) {
            continue;
        }
        for (const table of entry.data) {
            if (String(table.objType ?? table.TYPE ?? '').trim().toUpperCase() !== 'EXTERNAL TABLE') {
                continue;
            }
            if (!normalizedSchema || String(table.SCHEMA ?? '').trim().toUpperCase() === normalizedSchema) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Handles background prefetching of metadata for cache population
 */
export class CachePrefetcher {
    // Background prefetch tracking
    private columnPrefetchInProgress: Set<string> = new Set();
    private databaseColumnPrefetchInFlight: Map<string, Promise<void>> = new Map();
    private allObjectsPrefetchTriggeredSet: Set<string> = new Set();
    /** Main _V_OBJECT_DATA catalog completed successfully for this connection. */
    private primaryObjectsPrefetchCompletedSet: Set<string> = new Set();
    private externalObjectsPrefetchTriggeredSet: Set<string> = new Set();
    private connectionPrefetchTriggered: Map<string, number> = new Map();
    private connectionPrefetchInProgress: Set<string> = new Set();

    /** Throttle: minimum ms between checkpoint saves during a prefetch. */
    private static readonly CHECKPOINT_THROTTLE_MS = 5_000;
    /** Last checkpoint save time per connection. */
    private lastCheckpointTime = new Map<string, number>();

    constructor(
        private cache: MetadataPrefetchTarget,
        private reportProgress?: PrefetchProgressReporter
    ) { }

    private emitProgress(progress: MetadataPrefetchProgress): void {
        if (!this.reportProgress) {
            return;
        }

        this.reportProgress({
            ...progress,
            percent: Math.max(0, Math.min(100, Math.round(progress.percent)))
        });
    }

    // ========== Column Prefetch for Schema ==========

    async prefetchColumnsForSchema(
        connectionName: string,
        dbName: string,
        schemaName: string | undefined,
        runQueryFn: QueryRunnerRawFn
    ): Promise<void> {
        const preserveCatalogIdentity = this.cache.isNetezzaConnection?.(connectionName) === true;
        const userDatabase = preserveCatalogIdentity
            ? createNetezzaUserIdentifier(dbName).value
            : dbName;
        const userSchema = preserveCatalogIdentity && schemaName !== undefined
            ? createNetezzaUserIdentifier(schemaName).value
            : schemaName;
        const userDatabaseCachePart = preserveCatalogIdentity
            ? buildNetezzaCacheDatabasePart(userDatabase)
            : dbName;
        if (this.cache.isDatabaseDead(connectionName, userDatabaseCachePart)) {
            return;
        }

        const prefetchKey = preserveCatalogIdentity
            ? buildNetezzaDbSchemaCacheKey(userDatabase, userSchema)
            : buildDbSchemaCacheKey(dbName, schemaName);
        const fullPrefetchKey = `${connectionName}|${prefetchKey}`;

        if (this.columnPrefetchInProgress.has(fullPrefetchKey)) {
            return;
        }
        this.columnPrefetchInProgress.add(fullPrefetchKey);

        const tables = this.cache.getTables(connectionName, prefetchKey);
        if (!tables || tables.length === 0) {
            this.columnPrefetchInProgress.delete(fullPrefetchKey);
            return;
        }

        try {
            const tablesToFetch: string[] = [];
            for (const table of tables) {
                const tableName = extractLabel(table);
                if (!tableName) continue;

                const columnKey = buildColumnCacheKey(
                    userDatabaseCachePart,
                    userSchema,
                    tableName,
                    preserveCatalogIdentity
                        ? { preserveCase: true, exactNetezza: true }
                        : undefined,
                );
                if (!this.cache.getColumns(connectionName, columnKey)) {
                    tablesToFetch.push(tableName);
                }
            }

            if (tablesToFetch.length === 0) {
                await mirrorSynonymColumnsForConnection(this.cache, connectionName);
                return;
            }

            // Use centralized query builder for columns with PK/FK info. The
            // external query is only needed when this schema actually contains
            // an external table; it never runs as a completion-side fallback.
            const query = NZ_QUERIES.listColumnsWithKeys(
                preserveCatalogIdentity ? createNetezzaUserIdentifier(dbName) : dbName,
                {
                    schema: preserveCatalogIdentity && schemaName !== undefined
                        ? createNetezzaUserIdentifier(schemaName)
                        : schemaName,
                },
            );
            let mainRows: RawColumnRowWithKeys[] = [];
            let mainCatalogFailure = false;

            try {
                const result = await runPrefetchQuery(
                    connectionName,
                    runQueryFn,
                    query,
                    {
                        source: 'schema-prefetch',
                        kind: 'columns',
                        database: dbName,
                        schema: schemaName,
                        reason: 'schema-column-prefetch',
                    },
                );
                if (result) {
                    mainRows = queryResultToRows<RawColumnRowWithKeys>(result);
                }
            } catch (e: unknown) {
                logPrefetchError(`[CachePrefetcher] Error fetching columns:`, e);
                mainCatalogFailure = isDatabaseLevelCatalogError(e);
                if (mainCatalogFailure) {
                    this.cache.markDatabaseDead(connectionName, userDatabaseCachePart);
                }
            }

            let externalRows: RawColumnRowWithKeys[] = [];
            if (!mainCatalogFailure
                && !this.cache.isDatabaseDead(connectionName, userDatabaseCachePart)
                && hasExternalTableForDatabase(this.cache, connectionName, userDatabaseCachePart, userSchema)) {
                try {
                    const externalResult = await runPrefetchQuery(
                        connectionName,
                        runQueryFn,
                        NZ_QUERIES.listExternalColumnsWithKeys(
                            preserveCatalogIdentity ? createNetezzaUserIdentifier(dbName) : dbName,
                            {
                                schema: preserveCatalogIdentity && schemaName !== undefined
                                    ? createNetezzaUserIdentifier(schemaName)
                                    : schemaName,
                            },
                        ),
                        {
                            source: 'schema-prefetch',
                            kind: 'external-columns',
                            database: dbName,
                            schema: schemaName,
                            reason: 'external-table-columns',
                        },
                    );
                    if (externalResult) {
                        externalRows = queryResultToRows<RawColumnRowWithKeys>(externalResult);
                    }
                } catch (e: unknown) {
                    logPrefetchError(`[CachePrefetcher] Error fetching external columns:`, e);
                }
            }

            const columnsByKey = groupColumnRowsByTableKey(mergeColumnRows(mainRows, externalRows, preserveCatalogIdentity), {
                dbName,
                schemaName,
            }, preserveCatalogIdentity
                ? { preserveCase: true, exactNetezza: true }
                : undefined);

            for (const [key, columns] of columnsByKey) {
                if (!this.cache.getColumns(connectionName, key)) {
                    this.cache.setColumns(connectionName, key, columns);
                }
            }

            await mirrorSynonymColumnsForConnection(this.cache, connectionName);
        } finally {
            this.columnPrefetchInProgress.delete(fullPrefetchKey);
        }
    }

    // ========== All Objects Prefetch ==========

    async prefetchAllObjects(
        connectionName: string,
        runQueryFn: QueryRunnerRawFn,
        skipIfCached = false,
        databases?: string[],
        forceRefresh = false,
    ): Promise<boolean> {
        const key = `ALL_OBJECTS|${connectionName}`;
        const primaryCatalogComplete = this.primaryObjectsPrefetchCompletedSet.has(key);
        const externalCatalogComplete = this.externalObjectsPrefetchTriggeredSet.has(key);
        const hasCachedTables = skipIfCached && this.cache.hasTableCacheForConnection(connectionName);
        if (!forceRefresh && primaryCatalogComplete && externalCatalogComplete) {
            Logger.getInstance().debug(
                `[CachePrefetcher] Skipping objects prefetch — catalogs already complete for ${connectionName}`,
            );
            return true;
        }
        // Cached external rows alone do not prove that the primary catalog was
        // ever fetched successfully. Keep that success state separately so a
        // transient primary failure is retried rather than becoming an
        // external-only refresh forever.
        const externalOnly = hasCachedTables
            && primaryCatalogComplete
            && !forceRefresh
            && !externalCatalogComplete;
        Logger.getInstance().info(`[CachePrefetcher] Starting background prefetch of all objects (Connection: ${connectionName})`);

        try {
            // Ensure we have a list of databases (required for listTablesAndViews to populate descriptions)
            let targetDatabases = databases;
            if (!targetDatabases || targetDatabases.length === 0) {
                targetDatabases = await this.prefetchDatabases(connectionName, runQueryFn);
            }

            if (!targetDatabases || targetDatabases.length === 0) {
                Logger.getInstance().warn(`[CachePrefetcher] prefetchAllObjects aborted - no databases found for ${connectionName}`);
                this.allObjectsPrefetchTriggeredSet.delete(key);
                return false;
            }

            const preserveCatalogIdentity = this.cache.isNetezzaConnection?.(connectionName) === true;
            const liveDatabases = targetDatabases.filter(
                (db) => !this.cache.isDatabaseDead(
                    connectionName,
                    preserveCatalogIdentity
                        ? buildNetezzaCacheDatabasePart(db)
                        : db,
                ),
            );

            if (liveDatabases.length === 0) {
                Logger.getInstance().warn(
                    `[CachePrefetcher] prefetchAllObjects aborted - all databases marked dead for ${connectionName}`,
                );
                this.allObjectsPrefetchTriggeredSet.delete(key);
                return false;
            }

            if (liveDatabases.length < targetDatabases.length) {
                Logger.getInstance().debug(
                    `[CachePrefetcher] Skipping ${targetDatabases.length - liveDatabases.length} dead database(s) in objects prefetch`,
                );
            }

            // Per-database serial queries (main tables + separate external-table
            // query). A timeout/error in one database must not abort the rest,
            // so each query is isolated in its own try/catch.
            let anyQueryError = false;
            let primaryCatalogError = false;
            let externalCatalogError = false;
            for (const db of liveDatabases) {
                const cacheDatabase = preserveCatalogIdentity
                    ? buildNetezzaCacheDatabasePart(db)
                    : db;
                const queryStart = Date.now();
                let mainResults: RawObjectRow[] = [];
                let externalResults: RawObjectRow[] = [];
                let mainCatalogFailure = false;

                if (!externalOnly) {
                    try {
                        const result = await runPrefetchQuery(
                            connectionName,
                            runQueryFn,
                            NZ_QUERIES.listTablesAndViews([
                                preserveCatalogIdentity
                                    ? createNetezzaCatalogIdentifier(db)
                                    : db,
                            ]),
                            {
                                source: 'connection-prefetch',
                                kind: 'objects',
                                database: db,
                                reason: 'object-catalog-prefetch',
                            },
                        );
                        if (!result) {
                            anyQueryError = true;
                            primaryCatalogError = true;
                            Logger.getInstance().warn(
                                `[CachePrefetcher] Empty result while fetching tables for DB ${db}; object stage is incomplete`,
                            );
                        } else {
                            mainResults = queryResultToRows<RawObjectRow>(result);
                        }
                    } catch (e: unknown) {
                        anyQueryError = true;
                        primaryCatalogError = true;
                        logPrefetchError(`[CachePrefetcher] Error fetching tables for DB ${db}:`, e);
                        mainCatalogFailure = isDatabaseLevelCatalogError(e);
                        if (mainCatalogFailure) {
                            this.cache.markDatabaseDead(connectionName, cacheDatabase);
                        }
                    }
                }

                if (!mainCatalogFailure && !this.cache.isDatabaseDead(connectionName, cacheDatabase)) {
                    try {
                        const externalResult = await runPrefetchQuery(
                            connectionName,
                            runQueryFn,
                            NZ_QUERIES.listExternalTables([
                                preserveCatalogIdentity
                                    ? createNetezzaCatalogIdentifier(db)
                                    : db,
                            ]),
                            {
                                source: 'connection-prefetch',
                                kind: 'external-objects',
                                database: db,
                                reason: 'external-object-discovery',
                            },
                        );
                        if (!externalResult) {
                            anyQueryError = true;
                            externalCatalogError = true;
                            Logger.getInstance().warn(
                                `[CachePrefetcher] Empty result while fetching external tables for DB ${db}; object stage is incomplete`,
                            );
                        } else {
                            externalResults = queryResultToRows<RawObjectRow>(externalResult);
                        }
                    } catch (e: unknown) {
                        anyQueryError = true;
                        externalCatalogError = true;
                        logPrefetchError(`[CachePrefetcher] Error fetching external tables for DB ${db}:`, e);
                    }
                }

                const results = mergeObjectRows(mainResults, externalResults, preserveCatalogIdentity);
                if (results.length === 0) {
                    continue;
                }

                const tablesByKey = new Map<string, { tables: TableMetadata[]; idMap: Map<string, number> }>();

                for (const row of results) {
                    const cacheKey = buildDbSchemaCacheKey(
                        row.DBNAME,
                        row.SCHEMA ?? undefined,
                        preserveCatalogIdentity
                            ? { preserveCase: true, exactNetezza: true }
                            : undefined,
                    );
                    if (!tablesByKey.has(cacheKey)) {
                        tablesByKey.set(cacheKey, { tables: [], idMap: new Map() });
                    }
                    const entry = tablesByKey.get(cacheKey)!;
                    entry.tables.push(mapPrefetchObjectRow(row, preserveCatalogIdentity));

                    const fullKey = buildColumnCacheKey(
                        row.DBNAME,
                        row.SCHEMA ?? undefined,
                        row.OBJNAME,
                        preserveCatalogIdentity
                            ? { preserveCase: true, exactNetezza: true }
                            : undefined,
                    );
                    entry.idMap.set(fullKey, row.OBJID);
                }

                for (const [tableKey, entry] of tablesByKey) {
                    const existingTables = skipIfCached
                        ? this.cache.getTables(connectionName, tableKey)
                        : undefined;
                    // An old hydrated cache may contain only the DB.. aggregate
                    // layer. Merge external rows into that aggregate as a unit,
                    // otherwise setting one schema would hide the other ones.
                    const aggregateKey = buildDbSchemaCacheKey(
                        preserveCatalogIdentity ? buildNetezzaCacheDatabasePart(db) : db,
                        undefined,
                        preserveCatalogIdentity
                            ? { preserveCase: true, exactNetezza: true }
                            : undefined,
                    );
                    const existingAggregate = externalOnly && tableKey !== aggregateKey
                        ? this.cache.getTables(connectionName, aggregateKey)
                        : undefined;
                    if (existingAggregate) {
                        const discovered = entry.tables;
                        const merged = mergeCachedObjectRows(existingAggregate, discovered, db, preserveCatalogIdentity);
                        this.cache.setTables(
                            connectionName,
                            aggregateKey,
                            merged,
                            buildObjectIdMap(db, merged, preserveCatalogIdentity),
                        );
                        this.cache.markPrefetchObjectTypesCatalogLoaded(connectionName, aggregateKey);
                        continue;
                    }
                    // Preserve the old skip behavior for ordinary cached data;
                    // the external-only compatibility pass merges its supplement.
                    if (skipIfCached && existingTables && !externalOnly) {
                        continue;
                    }
                    const tablesToStore = externalOnly && existingTables
                        ? mergeCachedObjectRows(existingTables, entry.tables, db, preserveCatalogIdentity)
                        : entry.tables;
                    const idMap = externalOnly && existingTables
                        ? buildObjectIdMap(db, tablesToStore, preserveCatalogIdentity)
                        : entry.idMap;
                    this.cache.setTables(connectionName, tableKey, tablesToStore, idMap);
                    this.cache.markPrefetchObjectTypesCatalogLoaded(connectionName, tableKey);
                }

                const queryDuration = Date.now() - queryStart;
                Logger.getInstance().debug(
                    `[CachePrefetcher] [TIMING]   Objects query for ${db}: ${queryDuration}ms — ${results.length} objects (${tablesByKey.size} schema(s))`,
                );
            }

            if (anyQueryError) {
                // Keep whatever rows were successfully read, but never mark a
                // split catalog stage as fresh. A later attempt must re-run the
                // primary branch after a partial external-only result.
                this.allObjectsPrefetchTriggeredSet.delete(key);
                if (!externalOnly && primaryCatalogError) {
                    this.primaryObjectsPrefetchCompletedSet.delete(key);
                }
                if (externalCatalogError) {
                    this.externalObjectsPrefetchTriggeredSet.delete(key);
                }
                return false;
            }
            if (!externalOnly) {
                this.primaryObjectsPrefetchCompletedSet.add(key);
            }
            this.externalObjectsPrefetchTriggeredSet.add(key);
            this.allObjectsPrefetchTriggeredSet.add(key);
            Logger.getInstance().info(`[CachePrefetcher] Prefetched tables for ${liveDatabases.length} database(s) on ${connectionName}`);
            return true;
        } catch (e: unknown) {
            this.allObjectsPrefetchTriggeredSet.delete(key);
            if (!externalOnly) {
                this.primaryObjectsPrefetchCompletedSet.delete(key);
            }
            this.externalObjectsPrefetchTriggeredSet.delete(key);
            logPrefetchError(`[CachePrefetcher] Error in prefetchAllObjects:`, e);
            return false;
        }
    }

    hasAllObjectsPrefetchTriggered(connectionName: string): boolean {
        return this.allObjectsPrefetchTriggeredSet.has(`ALL_OBJECTS|${connectionName}`);
    }

    markAllObjectsPrefetchTriggered(connectionName: string): void {
        const key = `ALL_OBJECTS|${connectionName}`;
        // Disk metadata proves the primary table layer is present, but older
        // snapshots may predate the separate external-table companion query.
        // Leave that companion pending so the next refresh can supplement it.
        this.allObjectsPrefetchTriggeredSet.add(key);
        this.primaryObjectsPrefetchCompletedSet.add(key);
        this.externalObjectsPrefetchTriggeredSet.delete(key);
    }

    // ========== Eager Connection Prefetch ==========

    hasConnectionPrefetchInProgress(connectionName: string): boolean {
        return this.connectionPrefetchInProgress.has(connectionName);
    }

    hasConnectionPrefetchTriggered(connectionName: string): boolean {
        return this.connectionPrefetchTriggered.has(connectionName);
    }

    getConnectionPrefetchTimestamp(connectionName: string): number | undefined {
        return this.connectionPrefetchTriggered.get(connectionName);
    }

    getConnectionPrefetchTimestamps(): Map<string, number> {
        return new Map(this.connectionPrefetchTriggered);
    }

    restorePrefetchTimestamps(entries: Map<string, number>): void {
        for (const [connectionName, timestamp] of entries) {
            this.connectionPrefetchTriggered.set(connectionName, timestamp);
        }
    }

    clearConnectionPrefetchTimestamp(connectionName: string): void {
        this.connectionPrefetchTriggered.delete(connectionName);
        this.lastPrefetchAttemptTime.delete(connectionName);
    }

    /**
     * Trigger full column prefetch for all tables in a connection (fills missing entries only).
     */
    triggerFullColumnPrefetch(connectionName: string, runQueryFn: QueryRunnerRawFn): void {
        const key = `FULL_COL_PREFETCH|${connectionName}`;
        if (this.columnPrefetchInProgress.has(key)) {
            return;
        }

        this.columnPrefetchInProgress.add(key);
        this.prefetchAllColumnsForConnection(connectionName, runQueryFn)
            .catch(e => logPrefetchError(`[CachePrefetcher] Full column prefetch error:`, e))
            .finally(() => {
                this.columnPrefetchInProgress.delete(key);
            });
    }

    /**
     * Batch-fetch column metadata for a single database (one listColumnsWithKeys query).
     */
    async prefetchColumnsForDatabase(
        connectionName: string,
        dbName: string,
        runQueryFn: QueryRunnerRawFn,
    ): Promise<void> {
        const preserveCatalogIdentity = this.cache.isNetezzaConnection?.(connectionName) === true;
        const userDatabase = preserveCatalogIdentity
            ? createNetezzaUserIdentifier(dbName).value
            : dbName;
        const inflightDatabase = preserveCatalogIdentity
            ? buildNetezzaCacheDatabasePart(userDatabase)
            : dbName.toUpperCase();
        const inflightKey = `${connectionName}|${inflightDatabase}`;
        const existing = this.databaseColumnPrefetchInFlight.get(inflightKey);
        if (existing) {
            return existing;
        }

        const promise = this.executePrefetchColumnsForDatabase(connectionName, dbName, runQueryFn)
            .finally(() => {
                this.databaseColumnPrefetchInFlight.delete(inflightKey);
            });
        this.databaseColumnPrefetchInFlight.set(inflightKey, promise);
        return promise;
    }

    private async executePrefetchColumnsForDatabase(
        connectionName: string,
        dbName: string,
        runQueryFn: QueryRunnerRawFn,
    ): Promise<void> {
        const preserveCatalogIdentity = this.cache.isNetezzaConnection?.(connectionName) === true;
        const userDatabase = preserveCatalogIdentity
            ? createNetezzaUserIdentifier(dbName).value
            : dbName;
        const cacheDatabase = preserveCatalogIdentity
            ? buildNetezzaCacheDatabasePart(userDatabase)
            : dbName;
        if (this.cache.isDatabaseDead(connectionName, cacheDatabase)) {
            return;
        }

        const query = NZ_QUERIES.listColumnsWithKeys(
            preserveCatalogIdentity ? createNetezzaUserIdentifier(dbName) : dbName,
        );
        let mainRows: RawColumnRowWithKeys[] = [];
        let mainCatalogFailure = false;

        try {
            const result = await runPrefetchQuery(
                connectionName,
                runQueryFn,
                query,
                {
                    source: 'database-prefetch',
                    kind: 'columns',
                    database: dbName,
                    reason: 'database-column-prefetch',
                },
            );
            if (result) {
                mainRows = queryResultToRows<RawColumnRowWithKeys>(result);
            }
        } catch (e: unknown) {
            logPrefetchError(`[CachePrefetcher] prefetchColumnsForDatabase error for ${dbName}:`, e);
            mainCatalogFailure = isDatabaseLevelCatalogError(e);
            if (mainCatalogFailure) {
                this.cache.markDatabaseDead(connectionName, cacheDatabase);
            }
        }

        let externalRows: RawColumnRowWithKeys[] = [];

        // External table columns are fetched only when the object stage
        // proved that this database contains an external table. Keep this
        // query independent from the regular catalog query: a transient
        // failure in one catalog branch must not discard the other branch.
        if (!mainCatalogFailure
            && !this.cache.isDatabaseDead(connectionName, cacheDatabase)
            && hasExternalTableForDatabase(this.cache, connectionName, cacheDatabase)) {
            try {
                const externalResult = await runPrefetchQuery(
                    connectionName,
                    runQueryFn,
                    NZ_QUERIES.listExternalColumnsWithKeys(
                        preserveCatalogIdentity ? createNetezzaUserIdentifier(dbName) : dbName,
                    ),
                    {
                        source: 'database-prefetch',
                        kind: 'external-columns',
                        database: dbName,
                        reason: 'external-table-columns',
                    },
                );
                if (externalResult) {
                    externalRows = queryResultToRows<RawColumnRowWithKeys>(externalResult);
                }
            } catch (e: unknown) {
                logPrefetchError(`[CachePrefetcher] Error fetching external columns for DB ${dbName}:`, e);
            }
        }

        const results = mergeColumnRows(mainRows, externalRows, preserveCatalogIdentity);
        const columnsByKey = groupColumnRowsByTableKey(
            results,
            undefined,
            preserveCatalogIdentity
                ? { preserveCase: true, exactNetezza: true }
                : undefined,
        );

        for (const [key, columns] of columnsByKey) {
            if (!this.cache.getColumns(connectionName, key)) {
                this.cache.setColumns(connectionName, key, columns);
            }
        }

        await mirrorSynonymColumnsForConnection(this.cache, connectionName);
    }

    triggerConnectionPrefetch(
        connectionName: string,
        runQueryFn: DisposableQueryRunnerRawFn,
    ): void {
        void this.cache.whenDiskReady()
            .then(async () => {
                if (this.cache.isConnectionMetadataHydrating(connectionName)) {
                    await this.cache.whenConnectionMetadataHydrated(connectionName);
                }
                await this.runConnectionPrefetch(connectionName, runQueryFn);
            })
            .catch((error: unknown) => {
                logPrefetchError(
                    `[CachePrefetcher] Failed to start connection prefetch for ${connectionName}:`,
                    error,
                );
            })
            .finally(async () => {
                try {
                    await runQueryFn.dispose?.();
                } catch (error: unknown) {
                    logPrefetchError(
                        `[CachePrefetcher] Failed to close metadata session for ${connectionName}:`,
                        error,
                    );
                }
            });
    }

    /** Threshold in ms for considering a prefetch 'slow' — used to suggest disk persistence. */
    private static readonly SLOW_PREFETCH_MS = 30_000;

    private readonly lastPrefetchAttemptTime: Map<string, number> = new Map();

    getLastPrefetchAttemptTime(connectionName: string): number | undefined {
        return this.lastPrefetchAttemptTime.get(connectionName);
    }

    private async runConnectionPrefetch(connectionName: string, runQueryFn: QueryRunnerRawFn): Promise<void> {
        const isInProgress = this.connectionPrefetchInProgress.has(connectionName);
        const lastPrefetchTime = this.connectionPrefetchTriggered.get(connectionName);
        const cacheTTL = this.cache.getCacheTTL();
        const isPrefetchStale = lastPrefetchTime !== undefined && Date.now() - lastPrefetchTime >= cacheTTL;

        if (isInProgress) {
            return;
        }

        if (lastPrefetchTime !== undefined && !isPrefetchStale) {
            // Data in RAM is fresh — skip prefetch only if tables are present.
            // Without this check, a partial checkpoint recovery (Phase 4) would skip
            // prefetch even though tables/procedures are missing from RAM.
            if (this.cache.hasTableCacheForConnection(connectionName)) {
                return;
            }
        }

        // Mark in-progress BEFORE any await: concurrent triggerConnectionPrefetch
        // calls otherwise both pass the check while the disk lock is being acquired,
        // resulting in two parallel full prefetches (seen in production logs).
        this.connectionPrefetchInProgress.add(connectionName);
        this.lastPrefetchAttemptTime.set(connectionName, Date.now());

        let prefetchLease: import('./diskStorage/metadataDiskStorage').PrefetchLease | undefined;
        try {
            prefetchLease = await this.cache.tryAcquirePrefetchLock(connectionName);
        } catch (error: unknown) {
            // The in-progress marker is set before awaiting the cross-process
            // lock. Always clear it when lock acquisition itself fails, or all
            // later metadata refreshes would be suppressed until restart.
            this.connectionPrefetchInProgress.delete(connectionName);
            logPrefetchError(
                `[CachePrefetcher] Failed to acquire prefetch lock for ${connectionName}:`,
                error,
            );
            this.emitProgress({
                connectionName,
                stage: 'error',
                percent: 100,
                message: error instanceof Error ? error.message : String(error),
            });
            return;
        }
        if (!prefetchLease) {
            this.connectionPrefetchInProgress.delete(connectionName);
            return;
        }

        try {
            if (isPrefetchStale) {
                Logger.getInstance().info(`[CachePrefetcher] Prefetch stale for ${connectionName}, re-triggering`);
            }

            Logger.getInstance().info(`[CachePrefetcher] Starting eager prefetch for connection: ${connectionName}`);
            this.emitProgress({
                connectionName,
                stage: 'start',
                percent: 0,
                message: 'Starting metadata refresh...'
            });
        } catch (e) {
            await this.cache.releasePrefetchLock(prefetchLease);
            this.connectionPrefetchInProgress.delete(connectionName);
            throw e;
        }

        let hasError = false;
        let prefetchSucceeded = false;
        const prefetchStartMs = Date.now();

        try {
            prefetchSucceeded = await this.executeConnectionPrefetch(
                connectionName,
                runQueryFn,
                isPrefetchStale,
                prefetchLease,
            );
            if (!prefetchSucceeded) {
                hasError = true;
                Logger.getInstance().warn(
                    `[CachePrefetcher] Connection prefetch is incomplete for ${connectionName}; freshness was not advanced`,
                );
            }
        } catch (e) {
            hasError = true;
            logPrefetchError(`[CachePrefetcher] Connection prefetch error:`, e);
            this.emitProgress({
                connectionName,
                stage: 'error',
                percent: 100,
                message: e instanceof Error ? e.message : String(e)
            });
        } finally {
            this.connectionPrefetchInProgress.delete(connectionName);

            // Cold-start / slow-prefetch suggestion: if prefetch took >30s and disk persistence
            // is disabled, log a suggestion to enable it.
            const prefetchDurationMs = Date.now() - prefetchStartMs;
            Logger.getInstance().info(`[CachePrefetcher] Completed eager prefetch for connection: ${connectionName} (${prefetchDurationMs}ms)`);
            if (
                prefetchDurationMs > CachePrefetcher.SLOW_PREFETCH_MS
                && !this.cache.isDiskPersistenceEnabled()
            ) {
                Logger.getInstance().info(
                    `[CachePrefetcher] Slow prefetch (${prefetchDurationMs}ms) detected for ${connectionName} — `
                    + 'consider enabling justybase.metadataCache.diskPersistence to cache metadata on disk',
                );
            }

            if (!hasError) {
                this.emitProgress({
                    connectionName,
                    stage: 'complete',
                    percent: 100,
                    message: 'Metadata refresh complete'
                });
            }

            if (
                prefetchSucceeded
                && !hasError
            ) {
                this.connectionPrefetchTriggered.set(connectionName, Date.now());
                try {
                    await this.cache.saveConnectionToDiskAfterPrefetch(connectionName, hasError, prefetchLease);
                } catch (error: unknown) {
                    Logger.getInstance().warn(
                        `[CachePrefetcher] Failed to persist metadata cache for ${connectionName}:`,
                        error,
                    );
                }
            }

            await this.cache.releasePrefetchLock(prefetchLease);
        }
    }

    private async executeConnectionPrefetch(
        connectionName: string,
        runQueryFn: QueryRunnerRawFn,
        forceRefresh = false,
        prefetchLease: import('./diskStorage/metadataDiskStorage').PrefetchLease,
    ): Promise<boolean> {
        const prefetchStartOverall = Date.now();
        const log = Logger.getInstance();

        // 1. Fetch all databases
        this.emitProgress({
            connectionName,
            stage: 'databases',
            percent: 5,
            message: 'Fetching databases...'
        });
        const stage1Start = Date.now();
        const databases = await this.prefetchDatabases(connectionName, runQueryFn, forceRefresh);
        const stage1Duration = Date.now() - stage1Start;
        if (!databases || databases.length === 0) {
            log.debug(`[CachePrefetcher] [TIMING] Stage 1/5 DATABASES: ${stage1Duration}ms — 0 databases, aborting`);
            this.emitProgress({
                connectionName,
                stage: 'databases',
                percent: 100,
                message: 'No databases found to refresh'
            });
            return false;
        }
        log.debug(`[CachePrefetcher] [TIMING] Stage 1/5 DATABASES: ${stage1Duration}ms — ${databases.length} databases found`);
        this.emitProgress({
            connectionName,
            stage: 'databases',
            percent: 20,
            message: `Fetched ${databases.length} database(s)`,
            completed: databases.length,
            total: databases.length
        });

        // 2. Fetch schemas per database (bounded concurrency)
        const stage2Start = Date.now();
        const stage2Complete = await this.runPerDatabaseBatched(
            connectionName,
            databases,
            async (dbName) => {
                const schemasComplete = await this.prefetchSchemasForDb(
                    connectionName,
                    dbName,
                    runQueryFn,
                    forceRefresh,
                );
                const typeGroupsComplete = await this.prefetchTypeGroupsForDb(
                    connectionName,
                    dbName,
                    runQueryFn,
                    forceRefresh,
                );
                return schemasComplete && typeGroupsComplete;
            },
            (schemaCompleted, total) => {
                this.emitProgress({
                    connectionName,
                    stage: 'schemas',
                    percent: 20 + (schemaCompleted / total) * 20,
                    message: `Fetching schemas (${schemaCompleted}/${total})`,
                    completed: schemaCompleted,
                    total,
                });
            },
        );
        const stage2Duration = Date.now() - stage2Start;
        log.debug(`[CachePrefetcher] [TIMING] Stage 2/5 SCHEMAS: ${stage2Duration}ms`);
        // Phase 4 checkpoint: databases + schemas saved
        await this.checkpointAfterStage(connectionName, prefetchLease);

        // 3. Fetch all tables and views (reuse prefetchAllObjects with skipIfCached)
        this.emitProgress({
            connectionName,
            stage: 'objects',
            percent: 45,
            message: 'Fetching tables and views...'
        });
        const stage3Start = Date.now();
        const stage3Complete = await this.prefetchAllObjects(
            connectionName,
            runQueryFn,
            !forceRefresh,
            databases,
            forceRefresh,
        );
        const stage3Duration = Date.now() - stage3Start;
        log.debug(`[CachePrefetcher] [TIMING] Stage 3/5 TABLES+VIEWS: ${stage3Duration}ms`);
        this.emitProgress({
            connectionName,
            stage: 'objects',
            percent: 60,
            message: 'Tables and views loaded'
        });
        // Phase 4 checkpoint: databases + schemas + tables/views saved
        await this.checkpointAfterStage(connectionName, prefetchLease);

        // 4. Fetch procedures per database (bounded concurrency)
        const stage4Start = Date.now();
        const stage4Complete = await this.runPerDatabaseBatched(
            connectionName,
            databases,
            (dbName) => this.prefetchProceduresForDb(connectionName, dbName, runQueryFn, forceRefresh),
            (procedureCompleted, total) => {
                this.emitProgress({
                    connectionName,
                    stage: 'procedures',
                    percent: 60 + (procedureCompleted / total) * 20,
                    message: `Fetching procedures (${procedureCompleted}/${total})`,
                    completed: procedureCompleted,
                    total,
                });
            },
        );
        const stage4Duration = Date.now() - stage4Start;
        log.debug(`[CachePrefetcher] [TIMING] Stage 4/5 PROCEDURES: ${stage4Duration}ms`);
        // Phase 4 checkpoint: databases + schemas + tables/views + procedures saved
        await this.checkpointAfterStage(connectionName, prefetchLease);

        // 5. Fetch columns in batches
        this.emitProgress({
            connectionName,
            stage: 'columns',
            percent: 80,
            message: 'Fetching columns...'
        });
        const stage5Start = Date.now();
        const stage5Complete = await this.prefetchAllColumnsForConnection(connectionName, runQueryFn, forceRefresh, progress => {
            const denominator = progress.totalDatabases > 0 ? progress.totalDatabases : 1;
            this.emitProgress({
                connectionName,
                stage: 'columns',
                percent: 80 + (progress.completedDatabases / denominator) * 20,
                message: `Fetching columns (${progress.completedDatabases}/${progress.totalDatabases || denominator})`,
                completed: progress.completedTables,
                total: progress.totalTables
            });
        });
        const stage5Duration = Date.now() - stage5Start;

        const snapshotComplete = this.cache.verifyCompleteSnapshot?.(connectionName)
            ?? this.cache.verifyStagesComplete(connectionName);
        const stagesComplete = stage2Complete && stage3Complete && stage4Complete && stage5Complete;

        // ─── SUMMARY ───
        const totalDuration = Date.now() - prefetchStartOverall;
        log.debug(`[CachePrefetcher] [TIMING] ════════════════════════════════════════════════`);
        log.debug(`[CachePrefetcher] [TIMING] METADATA REFRESH COMPLETE — ${connectionName}`);
        log.debug(`[CachePrefetcher] [TIMING]   1/5 DATABASES:     ${String(stage1Duration).padStart(6)}ms  → ${databases.length} databases`);
        log.debug(`[CachePrefetcher] [TIMING]   2/5 SCHEMAS:       ${String(stage2Duration).padStart(6)}ms`);
        log.debug(`[CachePrefetcher] [TIMING]   3/5 TABLES+VIEWS:  ${String(stage3Duration).padStart(6)}ms`);
        log.debug(`[CachePrefetcher] [TIMING]   4/5 PROCEDURES:    ${String(stage4Duration).padStart(6)}ms`);
        log.debug(`[CachePrefetcher] [TIMING]   5/5 COLUMNS:       ${String(stage5Duration).padStart(6)}ms`);
        log.debug(`[CachePrefetcher] [TIMING]   ───────────────────────────────────────`);
        const pctCol = totalDuration > 0 ? (stage5Duration / totalDuration * 100).toFixed(1) : '?';
        log.debug(`[CachePrefetcher] [TIMING]   TOTAL:             ${String(totalDuration).padStart(6)}ms  (columns=${pctCol}%)`);
        log.debug(`[CachePrefetcher] [TIMING] ════════════════════════════════════════════════`);
        if (!stagesComplete) {
            log.warn(
                `[CachePrefetcher] One or more metadata stages failed for ${connectionName}; snapshot is intentionally incomplete`,
            );
        }
        return stagesComplete && snapshotComplete;
    }

    private async runPerDatabaseBatched(
        connectionName: string,
        databases: string[],
        operation: (database: string) => Promise<boolean>,
        onItemComplete?: (completed: number, total: number) => void,
    ): Promise<boolean> {
        const concurrencyLimit = getMetadataQueryConcurrencyLimit();
        const preserveCatalogIdentity = this.cache.isNetezzaConnection?.(connectionName) === true;
        let completed = 0;
        let allComplete = true;

        for (let i = 0; i < databases.length; i += concurrencyLimit) {
            const batch = databases.slice(i, i + concurrencyLimit);
            const results = await Promise.all(
                batch.map(async (database) => {
                    const cacheDatabase = preserveCatalogIdentity
                        ? buildNetezzaCacheDatabasePart(database)
                        : database;
                    if (this.cache.isDatabaseDead(connectionName, cacheDatabase)) {
                        completed += 1;
                        onItemComplete?.(completed, databases.length);
                        return true;
                    }
                    const complete = await operation(database);
                    completed += 1;
                    onItemComplete?.(completed, databases.length);
                    return complete;
                }),
            );
            if (results.some((complete) => !complete)) {
                allComplete = false;
            }
        }
        return allComplete;
    }

    private async prefetchDatabases(
        connectionName: string,
        runQueryFn: QueryRunnerRawFn,
        forceRefresh = false,
    ): Promise<string[]> {
        if (!forceRefresh && this.cache.getDatabases(connectionName)) {
            const cached = this.cache.getDatabases(connectionName);
            const dbNames = cached?.map((item) => extractLabel(item)).filter(Boolean) as string[] || [];
            Logger.getInstance().debug(`[CachePrefetcher] [TIMING]   Databases: ${dbNames.length} from cache: ${dbNames.join(', ')}`);
            return dbNames;
        }

        try {
            const query = NZ_QUERIES.LIST_DATABASES;
            const result = await runPrefetchQuery(
                connectionName,
                runQueryFn,
                query,
                {
                    source: 'connection-prefetch',
                    kind: 'databases',
                    reason: 'database-list-prefetch',
                },
            );
            if (!result) return [];

            const results = queryResultToRows<RawDatabaseRow>(result);
            const items = results.map((row) => ({
                DATABASE: row.DATABASE,
                label: row.DATABASE,
                kind: 9,
                detail: 'Database'
            }));

            this.cache.setDatabases(connectionName, items);
            const dbNames = results.map(row => row.DATABASE);
            Logger.getInstance().debug(`[CachePrefetcher] [TIMING]   Databases: ${dbNames.length} fetched: ${dbNames.join(', ')}`);
            return dbNames;
        } catch (e: unknown) {
            logPrefetchError('[CachePrefetcher] prefetchDatabases error:', e);
            return [];
        }
    }

    private async prefetchTypeGroupsForDb(
        connectionName: string,
        dbName: string,
        runQueryFn: QueryRunnerRawFn,
        forceRefresh = false,
    ): Promise<boolean> {
        const preserveCatalogIdentity = this.cache.isNetezzaConnection?.(connectionName) === true;
        const cacheDatabase = preserveCatalogIdentity
            ? buildNetezzaCacheDatabasePart(dbName)
            : dbName;
        if (!forceRefresh && this.cache.hasCachedTypeGroups(connectionName, cacheDatabase)) {
            Logger.getInstance().debug(`[CachePrefetcher] [TIMING]   TypeGroups ${dbName}: skipped (cached)`);
            return true;
        }

        try {
            const queryStart = Date.now();
            const query = NZ_QUERIES.listTypeGroups(
                preserveCatalogIdentity
                    ? createNetezzaCatalogIdentifier(dbName)
                    : dbName,
            );
            const result = await runPrefetchQuery(
                connectionName,
                runQueryFn,
                query,
                {
                    source: 'connection-prefetch',
                    kind: 'type-groups',
                    database: dbName,
                    reason: 'type-group-prefetch',
                },
            );
            const queryDuration = Date.now() - queryStart;
            if (!result) {
                return false;
            }

            const results = queryResultToRows<RawTypeGroupRow>(result);
            const typeList = results
                .map((row) => row.OBJTYPE?.trim())
                .filter((type): type is string => Boolean(type));
            this.cache.setTypeGroups(connectionName, cacheDatabase, typeList);
            Logger.getInstance().debug(
                `[CachePrefetcher] [TIMING]   TypeGroups ${dbName}: ${typeList.length} types in ${queryDuration}ms`,
            );
            return true;
        } catch (e: unknown) {
            logPrefetchError(`[CachePrefetcher] prefetchTypeGroupsForDb error for ${dbName}:`, e);
            if (isDatabaseLevelCatalogError(e)) {
                this.cache.markDatabaseDead(connectionName, cacheDatabase);
            }
            return false;
        }
    }

    private async prefetchSchemasForDb(
        connectionName: string,
        dbName: string,
        runQueryFn: QueryRunnerRawFn,
        forceRefresh = false,
    ): Promise<boolean> {
        const preserveCatalogIdentity = this.cache.isNetezzaConnection?.(connectionName) === true;
        const cacheDatabase = preserveCatalogIdentity
            ? buildNetezzaCacheDatabasePart(dbName)
            : dbName;
        if (!forceRefresh && this.cache.getSchemas(connectionName, cacheDatabase)) {
            Logger.getInstance().debug(`[CachePrefetcher] [TIMING]   Schemas ${dbName}: skipped (cached)`);
            return true;
        }

        try {
            const queryStart = Date.now();
            const query = NZ_QUERIES.listSchemas(
                preserveCatalogIdentity
                    ? createNetezzaCatalogIdentifier(dbName)
                    : dbName,
            );
            const result = await runPrefetchQuery(
                connectionName,
                runQueryFn,
                query,
                {
                    source: 'connection-prefetch',
                    kind: 'schemas',
                    database: dbName,
                    reason: 'schema-prefetch',
                },
            );
            const queryDuration = Date.now() - queryStart;
            if (!result) return false;

            const results = queryResultToRows<RawSchemaRow>(result);
            const items = results
                .filter(row => row.SCHEMA != null && row.SCHEMA !== '')
                .map(row => ({
                    SCHEMA: row.SCHEMA,
                    label: row.SCHEMA,
                    kind: 19,
                    detail: `Schema in ${dbName}`,
                    insertText: row.SCHEMA,
                    sortText: row.SCHEMA,
                    filterText: row.SCHEMA
                }));

            this.cache.setSchemas(connectionName, cacheDatabase, items);
            Logger.getInstance().debug(`[CachePrefetcher] [TIMING]   Schemas ${dbName}: ${items.length} schemas in ${queryDuration}ms`);
            return true;
        } catch (e: unknown) {
            logPrefetchError(`[CachePrefetcher] prefetchSchemasForDb error for ${dbName}:`, e);
            if (isDatabaseLevelCatalogError(e)) {
                this.cache.markDatabaseDead(connectionName, cacheDatabase);
            }
            return false;
        }
    }

    private async prefetchProceduresForDb(
        connectionName: string,
        dbName: string,
        runQueryFn: QueryRunnerRawFn,
        forceRefresh = false,
    ): Promise<boolean> {
        const preserveCatalogIdentity = this.cache.isNetezzaConnection?.(connectionName) === true;
        const cacheDatabase = preserveCatalogIdentity
            ? buildNetezzaCacheDatabasePart(dbName)
            : dbName;
        const dbCacheKey = `${cacheDatabase}..`;
        if (
            !forceRefresh &&
            (
                this.cache.getProcedures(connectionName, dbCacheKey) !== undefined
                || this.cache.isProcedureCatalogLoaded(connectionName, cacheDatabase)
            )
        ) {
            Logger.getInstance().debug(`[CachePrefetcher] [TIMING]   Procedures ${dbName}: skipped (cached)`);
            return true;
        }

        try {
            const query = NZ_QUERIES.listProcedures(
                preserveCatalogIdentity
                    ? createNetezzaCatalogIdentifier(dbName)
                    : dbName,
            );
            if (!query) {
                return true;
            }

            const queryStart = Date.now();
            const result = await runPrefetchQuery(
                connectionName,
                runQueryFn,
                query,
                {
                    source: 'connection-prefetch',
                    kind: 'procedures',
                    database: dbName,
                    reason: 'procedure-prefetch',
                },
            );
            const queryDuration = Date.now() - queryStart;
            if (!result) {
                return false;
            }

            const results = queryResultToRows<RawProcedureRow>(result);
            const proceduresByKey = new Map<string, ProcedureMetadata[]>();
            const allProcedures: ProcedureMetadata[] = [];

            for (const row of results) {
                const procedureName = row.PROCEDURE?.trim();
                if (!procedureName) {
                    continue;
                }

                const normalizedSchema = preserveCatalogIdentity
                    ? (row.SCHEMA ?? '')
                    : (row.SCHEMA?.trim() || '');
                const signature = row.PROCEDURESIGNATURE?.trim();
                const label = signature && signature.length > 0 ? signature : procedureName;
                const key = normalizedSchema
                    ? preserveCatalogIdentity
                        ? buildDbSchemaCacheKey(
                            buildNetezzaCacheDatabasePart(dbName),
                            normalizedSchema,
                            { preserveCase: true, exactNetezza: true },
                        )
                        : `${dbName}.${normalizedSchema}`
                    : dbCacheKey;

                const item: ProcedureMetadata = {
                    PROCEDURE: procedureName,
                    PROCEDURESIGNATURE: signature && signature.length > 0 ? signature : undefined,
                    SCHEMA: normalizedSchema || undefined,
                    OWNER: row.OWNER || undefined,
                    DATABASE: row.DATABASE || dbName,
                    label: label,
                    kind: 3,
                    detail: normalizedSchema ? `Procedure (${normalizedSchema})` : 'Procedure',
                    sortText: label
                };

                if (!proceduresByKey.has(key)) {
                    proceduresByKey.set(key, []);
                }
                proceduresByKey.get(key)!.push(item);
                allProcedures.push(item);
            }

            for (const [key, items] of proceduresByKey) {
                if (key !== dbCacheKey) {
                    this.cache.setProcedures(connectionName, key, items);
                }
            }
            // Aggregate must be written last — per-schema setProcedures invalidates DB..
            this.cache.setProcedures(connectionName, dbCacheKey, allProcedures);
            this.cache.markProcedureCatalogLoaded(connectionName, cacheDatabase);

            Logger.getInstance().debug(`[CachePrefetcher] [TIMING]   Procedures ${dbName}: ${allProcedures.length} procedures in ${queryDuration}ms`);
            return true;
        } catch (e: unknown) {
            logPrefetchError(`[CachePrefetcher] prefetchProceduresForDb error for ${dbName}:`, e);
            if (isDatabaseLevelCatalogError(e)) {
                this.cache.markDatabaseDead(connectionName, cacheDatabase);
            }
            return false;
        }
    }



    private async prefetchAllColumnsForConnection(
        connectionName: string,
        runQueryFn: QueryRunnerRawFn,
        forceRefresh = false,
        onProgress?: (progress: {
            completedDatabases: number;
            totalDatabases: number;
            completedTables: number;
            totalTables: number;
        }) => void
    ): Promise<boolean> {
        try {
            const connPrefix = `${connectionName}|`;

            // Database list comes from the cached database layer (stage 1) —
            // NOT from the tables cache. A failed stage 3 must not silently
            // starve stage 5 (columns would never be prefetched).
            let databases: string[] = [];
            const cachedDatabases = this.cache.getDatabases(connectionName);
            if (cachedDatabases && cachedDatabases.length > 0) {
                databases = cachedDatabases
                    .map((item) => extractLabel(item))
                    .filter(Boolean) as string[];
            }

            let totalTables = 0;
            if (databases.length === 0) {
                // Fall back to databases present in the table cache (legacy path).
                const seen = new Set<string>();
                for (const [key, entry] of this.cache.tableCache) {
                    if (!key.startsWith(connPrefix)) continue;

                    const parts = key.split('|');
                    if (parts.length < 2) continue;

                    const dbParts = parts[1].split('.');
                    const dbName = dbParts[0];
                    if (dbName && !seen.has(dbName)) {
                        seen.add(dbName);
                        databases.push(dbName);
                    }
                    totalTables += entry.data.length;
                }
            } else {
                for (const [key, entry] of this.cache.tableCache) {
                    if (key.startsWith(connPrefix)) {
                        totalTables += entry.data.length;
                    }
                }
            }

            if (databases.length === 0) {
                Logger.getInstance().debug(
                    `[CachePrefetcher] Skipping columns prefetch — no databases known for ${connectionName}`,
                );
                return false;
            }

            let fetchedCount = 0;
            const prefetchStartTime = Date.now();

            const totalDatabases = databases.length;
            let completedDatabases = 0;
            let allQueriesComplete = true;
            const preserveCatalogIdentity = this.cache.isNetezzaConnection?.(connectionName) === true;

            // Per-database serial execution: main columns query followed by the
            // separate external-table columns query, merged in code. Serial order
            // avoids flooding the database with concurrent sessions.
            for (const dbName of databases) {
                const cacheDatabase = preserveCatalogIdentity
                    ? buildNetezzaCacheDatabasePart(dbName)
                    : dbName;
                if (this.cache.isDatabaseDead(connectionName, cacheDatabase)) {
                    completedDatabases += 1;
                    onProgress?.({
                        completedDatabases,
                        totalDatabases,
                        completedTables: fetchedCount,
                        totalTables,
                    });
                    continue;
                }

                const query = NZ_QUERIES.listColumnsWithKeys(
                    preserveCatalogIdentity ? createNetezzaCatalogIdentifier(dbName) : dbName,
                );
                const queryStartTime = Date.now();
                let queryDuration = 0;
                let mainRows: RawColumnRowWithKeys[] = [];
                let mainCatalogFailure = false;

                try {
                    const result = await runPrefetchQuery(
                        connectionName,
                        runQueryFn,
                        query,
                        {
                            source: 'connection-prefetch',
                            kind: 'columns',
                            database: dbName,
                            reason: 'full-column-prefetch',
                        },
                    );
                    queryDuration = Date.now() - queryStartTime;
                    if (result) {
                        mainRows = queryResultToRows<RawColumnRowWithKeys>(result);
                    } else {
                        allQueriesComplete = false;
                    }
                } catch (e: unknown) {
                    queryDuration = Date.now() - queryStartTime;
                    allQueriesComplete = false;
                    logPrefetchError(`[CachePrefetcher] Error fetching columns for DB ${dbName}:`, e);
                    mainCatalogFailure = isDatabaseLevelCatalogError(e);
                    if (mainCatalogFailure) {
                        this.cache.markDatabaseDead(connectionName, cacheDatabase);
                    }
                }

                let externalRows: RawColumnRowWithKeys[] = [];
                if (!mainCatalogFailure
                    && !this.cache.isDatabaseDead(connectionName, cacheDatabase)
                    && hasExternalTableForDatabase(this.cache, connectionName, cacheDatabase)) {
                    try {
                        const externalResult = await runPrefetchQuery(
                            connectionName,
                            runQueryFn,
                            NZ_QUERIES.listExternalColumnsWithKeys(
                                preserveCatalogIdentity ? createNetezzaCatalogIdentifier(dbName) : dbName,
                            ),
                            {
                                source: 'connection-prefetch',
                                kind: 'external-columns',
                                database: dbName,
                                reason: 'external-table-columns',
                            },
                        );
                        if (externalResult) {
                            externalRows = queryResultToRows<RawColumnRowWithKeys>(externalResult);
                        } else {
                            allQueriesComplete = false;
                        }
                    } catch (e: unknown) {
                        allQueriesComplete = false;
                        logPrefetchError(`[CachePrefetcher] Error fetching external columns for DB ${dbName}:`, e);
                    }
                }

                const results = mergeColumnRows(mainRows, externalRows, this.cache.isNetezzaConnection?.(connectionName) === true);
                const columnsByKey = groupColumnRowsByTableKey(
                    results,
                    undefined,
                    this.cache.isNetezzaConnection?.(connectionName) === true
                        ? { preserveCase: true, exactNetezza: true }
                        : undefined,
                );

                for (const [key, columns] of columnsByKey) {
                    if (forceRefresh || !this.cache.getColumns(connectionName, key)) {
                        this.cache.setColumns(connectionName, key, columns);
                        fetchedCount++;
                    }
                }

                Logger.getInstance().debug(
                    `[CachePrefetcher] [TIMING]     Columns ${dbName}: ${results.length} columns | query=${queryDuration}ms`,
                );

                completedDatabases += 1;
                onProgress?.({
                    completedDatabases,
                    totalDatabases,
                    completedTables: fetchedCount,
                    totalTables,
                });
            }

            const totalDuration = Date.now() - prefetchStartTime;
            Logger.getInstance().debug(`[CachePrefetcher] [TIMING]   Columns total: ${fetchedCount} tables cached in ${totalDuration}ms`);
            Logger.getInstance().debug(`[CachePrefetcher] [TIMING]   Columns processed: ${totalDatabases} databases, ${totalTables} tables total`);
            return allQueriesComplete;
        } catch (e: unknown) {
            logPrefetchError(`[CachePrefetcher] prefetchAllColumnsForConnection error:`, e);
            return false;
        } finally {
            const mirroredSynonyms = await mirrorSynonymColumnsForConnection(this.cache, connectionName);
            if (mirroredSynonyms > 0) {
                Logger.getInstance().info(
                    `[CachePrefetcher] Mirrored column metadata for ${mirroredSynonyms} synonym(s) on ${connectionName}`,
                );
            }
        }
    }

    /**
     * Save partial prefetch progress as a checkpoint, throttled to avoid
     * excessive disk writes during fast stages.
     * Phase 4: checkpointing — incremental disk save during long prefetch.
     */
    private async checkpointAfterStage(connectionName: string, prefetchLease: import('./diskStorage/metadataDiskStorage').PrefetchLease): Promise<void> {
        const lastTime = this.lastCheckpointTime.get(connectionName) ?? 0;
        if (Date.now() - lastTime < CachePrefetcher.CHECKPOINT_THROTTLE_MS) {
            return;
        }
        this.lastCheckpointTime.set(connectionName, Date.now());
        try {
            await this.cache.checkpointSave(connectionName, prefetchLease);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            Logger.getInstance().warn(
                `[CachePrefetcher] Checkpoint save failed for ${connectionName}: ${message}`,
            );
        }
    }

    /**
     * Reset all prefetch tracking state.
     * This clears all internal tracking sets, causing the prefetcher to
     * behave as if it was just initialized (like on first connection).
     */
    reset(): void {
        this.columnPrefetchInProgress.clear();
        this.databaseColumnPrefetchInFlight.clear();
        this.allObjectsPrefetchTriggeredSet.clear();
        this.primaryObjectsPrefetchCompletedSet.clear();
        this.externalObjectsPrefetchTriggeredSet.clear();
        this.connectionPrefetchTriggered.clear();
        this.connectionPrefetchInProgress.clear();
        this.lastPrefetchAttemptTime.clear();
        this.lastCheckpointTime.clear();
        Logger.getInstance().info('[CachePrefetcher] Prefetch tracking state reset');
    }
}
