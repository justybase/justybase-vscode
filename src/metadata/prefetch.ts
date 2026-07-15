/**
 * Metadata Cache - Prefetch Module
 * Background data fetching logic for eager cache population
 */

import type { MetadataPrefetchTarget } from './cache/MetadataPrefetchTarget';

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
import { buildColumnCacheKey, groupColumnRowsByTableKey, type RawColumnRowWithKeys } from './columnRowMapping';
import { buildDbSchemaCacheKey, extractLabel } from './helpers';
import {
    getMetadataQueryConcurrencyLimit,
    runWithMetadataQueryConcurrencyLimit,
} from './metadataQueryLimiter';
import { mirrorSynonymColumnsForConnection } from './synonymColumns';
import { TableMetadata, ProcedureMetadata } from './types';
import { QueryResult } from '../types';
import { NZ_QUERIES } from './systemQueries';
import { Logger } from '../utils/logger';

/**
 * Type for query execution function (legacy - returns JSON string)
 */
export type QueryRunnerFn = (query: string) => Promise<string | undefined>;

/**
 * Type for raw query execution function (returns QueryResult directly - no JSON serialization)
 */
export type QueryRunnerRawFn = (query: string) => Promise<QueryResult | undefined>;

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

function mapPrefetchObjectRow(row: RawObjectRow): TableMetadata {
    const normalizedObjectType = row.OBJTYPE?.toUpperCase() || 'TABLE';
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
        OBJNAME: row.OBJNAME,
        label: row.OBJNAME,
        kind: isViewLike ? 18 : 6,
        detail: row.SCHEMA ? typeLabel : `${typeLabel} (${row.SCHEMA})`,
        objType: normalizedObjectType,
        OBJID: row.OBJID,
        SCHEMA: row.SCHEMA,
        OWNER: row.OWNER,
        DESCRIPTION: row.DESCRIPTION,
        REFOBJNAME: row.REFOBJNAME,
    };
}

/**
 * Handles background prefetching of metadata for cache population
 */
export class CachePrefetcher {
    // Background prefetch tracking
    private columnPrefetchInProgress: Set<string> = new Set();
    private databaseColumnPrefetchInFlight: Map<string, Promise<void>> = new Map();
    private allObjectsPrefetchTriggeredSet: Set<string> = new Set();
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
        if (this.cache.isDatabaseDead(connectionName, dbName)) {
            return;
        }

        const prefetchKey = buildDbSchemaCacheKey(dbName, schemaName);
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

                const columnKey = buildColumnCacheKey(dbName, schemaName, tableName);
                if (!this.cache.getColumns(connectionName, columnKey)) {
                    tablesToFetch.push(tableName);
                }
            }

            if (tablesToFetch.length === 0) {
                await mirrorSynonymColumnsForConnection(this.cache, connectionName);
                return;
            }

            // Use centralized query builder for columns with PK/FK info
            const query = NZ_QUERIES.listColumnsWithKeys(dbName, { schema: schemaName });

            try {
                const result = await runWithMetadataQueryConcurrencyLimit(connectionName, () => runQueryFn(query));
                if (result) {
                    const results = queryResultToRows<RawColumnRowWithKeys>(result);
                    const columnsByKey = groupColumnRowsByTableKey(results, {
                        dbName,
                        schemaName,
                    });

                    for (const [key, columns] of columnsByKey) {
                        if (!this.cache.getColumns(connectionName, key)) {
                            this.cache.setColumns(connectionName, key, columns);
                        }
                    }

                    await mirrorSynonymColumnsForConnection(this.cache, connectionName);
                }
            } catch (e: unknown) {
                logPrefetchError(`[CachePrefetcher] Error fetching columns:`, e);
                if (isDatabaseLevelCatalogError(e)) {
                    this.cache.markDatabaseDead(connectionName, dbName);
                }
            }
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
    ): Promise<void> {
        const key = `ALL_OBJECTS|${connectionName}`;
        if (!forceRefresh && this.allObjectsPrefetchTriggeredSet.has(key)) {
            return;
        }
        this.allObjectsPrefetchTriggeredSet.add(key);

        if (skipIfCached && this.cache.hasTableCacheForConnection(connectionName)) {
            Logger.getInstance().debug(
                `[CachePrefetcher] Skipping objects prefetch — tables already cached for ${connectionName}`,
            );
            return;
        }

        Logger.getInstance().info(`[CachePrefetcher] Starting background prefetch of all objects (Connection: ${connectionName})`);

        try {
            // Ensure we have a list of databases (required for listTablesAndViews to populate descriptions)
            let targetDatabases = databases;
            if (!targetDatabases || targetDatabases.length === 0) {
                targetDatabases = await this.prefetchDatabases(connectionName, runQueryFn);
            }


            if (!targetDatabases || targetDatabases.length === 0) {
                Logger.getInstance().warn(`[CachePrefetcher] prefetchAllObjects aborted - no databases found for ${connectionName}`);
                return;
            }

            const liveDatabases = targetDatabases.filter(
                (db) => !this.cache.isDatabaseDead(connectionName, db),
            );

            if (liveDatabases.length === 0) {
                Logger.getInstance().warn(
                    `[CachePrefetcher] prefetchAllObjects aborted - all databases marked dead for ${connectionName}`,
                );
                return;
            }

            if (liveDatabases.length < targetDatabases.length) {
                Logger.getInstance().debug(
                    `[CachePrefetcher] Skipping ${targetDatabases.length - liveDatabases.length} dead database(s) in objects prefetch`,
                );
            }

            // Use centralized query for listing tables and views (global or per-database when provided)
            const tablesQuery = NZ_QUERIES.listTablesAndViews(liveDatabases);
            const queryStart = Date.now();

            const result = await runQueryFn(tablesQuery);
            const queryDuration = Date.now() - queryStart;
            if (!result) return;

            const results = queryResultToRows<RawObjectRow>(result);
            const tablesByKey = new Map<string, { tables: TableMetadata[]; idMap: Map<string, number> }>();

            for (const row of results) {
                const key = buildDbSchemaCacheKey(row.DBNAME, row.SCHEMA ?? undefined);
                if (!tablesByKey.has(key)) {
                    tablesByKey.set(key, { tables: [], idMap: new Map() });
                }
                const entry = tablesByKey.get(key)!;
                entry.tables.push(mapPrefetchObjectRow(row));

                const fullKey = buildColumnCacheKey(
                    row.DBNAME,
                    row.SCHEMA ?? undefined,
                    row.OBJNAME,
                );
                entry.idMap.set(fullKey, row.OBJID);
            }

            // Count objects per database for logging
            const countByDb = new Map<string, number>();
            for (const row of results) {
                const db = row.DBNAME || 'UNKNOWN';
                countByDb.set(db, (countByDb.get(db) || 0) + 1);
            }
            const dbBreakdown = Array.from(countByDb.entries())
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([db, cnt]) => `${db}:${cnt}`)
                .join(', ');

            for (const [key, entry] of tablesByKey) {
                // Only skip if explicitly requested AND data already exists
                if (skipIfCached && this.cache.getTables(connectionName, key)) {
                    continue;
                }
                this.cache.setTables(connectionName, key, entry.tables, entry.idMap);
                this.cache.markPrefetchObjectTypesCatalogLoaded(connectionName, key);
            }

            Logger.getInstance().debug(`[CachePrefetcher] [TIMING]   Objects query: ${queryDuration}ms — ${results.length} objects (${dbBreakdown})`);
            Logger.getInstance().info(`[CachePrefetcher] Prefetched tables for ${tablesByKey.size} schema(s) on ${connectionName}`);
        } catch (e: unknown) {
            logPrefetchError(`[CachePrefetcher] Error in prefetchAllObjects:`, e);
        }
    }

    hasAllObjectsPrefetchTriggered(connectionName: string): boolean {
        return this.allObjectsPrefetchTriggeredSet.has(`ALL_OBJECTS|${connectionName}`);
    }

    markAllObjectsPrefetchTriggered(connectionName: string): void {
        this.allObjectsPrefetchTriggeredSet.add(`ALL_OBJECTS|${connectionName}`);
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
        const inflightKey = `${connectionName}|${dbName.toUpperCase()}`;
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
        if (this.cache.isDatabaseDead(connectionName, dbName)) {
            return;
        }

        const query = NZ_QUERIES.listColumnsWithKeys(dbName);

        try {
            const result = await runWithMetadataQueryConcurrencyLimit(connectionName, () => runQueryFn(query));
            if (!result) {
                return;
            }

            const results = queryResultToRows<RawColumnRowWithKeys>(result);
            const columnsByKey = groupColumnRowsByTableKey(results);

            for (const [key, columns] of columnsByKey) {
                if (!this.cache.getColumns(connectionName, key)) {
                    this.cache.setColumns(connectionName, key, columns);
                }
            }

            await mirrorSynonymColumnsForConnection(this.cache, connectionName);
        } catch (e: unknown) {
            logPrefetchError(`[CachePrefetcher] prefetchColumnsForDatabase error for ${dbName}:`, e);
            if (isDatabaseLevelCatalogError(e)) {
                this.cache.markDatabaseDead(connectionName, dbName);
            }
        }
    }

    triggerConnectionPrefetch(connectionName: string, runQueryFn: QueryRunnerRawFn): void {
        void this.cache.whenDiskReady().then(async () => {
            if (this.cache.isConnectionMetadataHydrating(connectionName)) {
                await this.cache.whenConnectionMetadataHydrated(connectionName);
            }
            void this.runConnectionPrefetch(connectionName, runQueryFn);
        });
    }

    /** Threshold in ms for considering a prefetch 'slow' — used to suggest disk persistence. */
    private static readonly SLOW_PREFETCH_MS = 30_000;

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

        const prefetchLease = await this.cache.tryAcquirePrefetchLock(connectionName);
        if (!prefetchLease) {
            return;
        }

        try {
            if (isPrefetchStale) {
                Logger.getInstance().info(`[CachePrefetcher] Prefetch stale for ${connectionName}, re-triggering`);
            }

            this.connectionPrefetchInProgress.add(connectionName);
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
            await this.executeConnectionPrefetch(connectionName, runQueryFn, isPrefetchStale, prefetchLease);
            prefetchSucceeded = true;
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
                && this.cache.verifyStagesComplete(connectionName)
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
    ): Promise<void> {
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
            return;
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
        await this.runPerDatabaseBatched(
            connectionName,
            databases,
            async (dbName) => {
                await this.prefetchSchemasForDb(connectionName, dbName, runQueryFn, forceRefresh);
                await this.prefetchTypeGroupsForDb(connectionName, dbName, runQueryFn, forceRefresh);
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
        await this.prefetchAllObjects(connectionName, runQueryFn, !forceRefresh, databases, forceRefresh);
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
        await this.runPerDatabaseBatched(
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
        await this.prefetchAllColumnsForConnection(connectionName, runQueryFn, forceRefresh, progress => {
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
    }

    private async runPerDatabaseBatched(
        connectionName: string,
        databases: string[],
        operation: (database: string) => Promise<void>,
        onItemComplete?: (completed: number, total: number) => void,
    ): Promise<void> {
        const concurrencyLimit = getMetadataQueryConcurrencyLimit();
        let completed = 0;

        for (let i = 0; i < databases.length; i += concurrencyLimit) {
            const batch = databases.slice(i, i + concurrencyLimit);
            await Promise.all(
                batch.map(async (database) => {
                    if (this.cache.isDatabaseDead(connectionName, database)) {
                        completed += 1;
                        onItemComplete?.(completed, databases.length);
                        return;
                    }
                    await runWithMetadataQueryConcurrencyLimit(connectionName, () =>
                        operation(database),
                    );
                    completed += 1;
                    onItemComplete?.(completed, databases.length);
                }),
            );
        }
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
            const result = await runQueryFn(query);
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
    ): Promise<void> {
        if (!forceRefresh && this.cache.hasCachedTypeGroups(connectionName, dbName)) {
            Logger.getInstance().debug(`[CachePrefetcher] [TIMING]   TypeGroups ${dbName}: skipped (cached)`);
            return;
        }

        try {
            const queryStart = Date.now();
            const query = NZ_QUERIES.listTypeGroups(dbName);
            const result = await runQueryFn(query);
            const queryDuration = Date.now() - queryStart;
            if (!result) {
                return;
            }

            const results = queryResultToRows<RawTypeGroupRow>(result);
            const typeList = results
                .map((row) => row.OBJTYPE?.trim())
                .filter((type): type is string => Boolean(type));
            this.cache.setTypeGroups(connectionName, dbName, typeList);
            Logger.getInstance().debug(
                `[CachePrefetcher] [TIMING]   TypeGroups ${dbName}: ${typeList.length} types in ${queryDuration}ms`,
            );
        } catch (e: unknown) {
            logPrefetchError(`[CachePrefetcher] prefetchTypeGroupsForDb error for ${dbName}:`, e);
            if (isDatabaseLevelCatalogError(e)) {
                this.cache.markDatabaseDead(connectionName, dbName);
            }
        }
    }

    private async prefetchSchemasForDb(
        connectionName: string,
        dbName: string,
        runQueryFn: QueryRunnerRawFn,
        forceRefresh = false,
    ): Promise<void> {
        if (!forceRefresh && this.cache.getSchemas(connectionName, dbName)) {
            Logger.getInstance().debug(`[CachePrefetcher] [TIMING]   Schemas ${dbName}: skipped (cached)`);
            return;
        }

        try {
            const queryStart = Date.now();
            const query = NZ_QUERIES.listSchemas(dbName);
            const result = await runQueryFn(query);
            const queryDuration = Date.now() - queryStart;
            if (!result) return;

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

            this.cache.setSchemas(connectionName, dbName, items);
            Logger.getInstance().debug(`[CachePrefetcher] [TIMING]   Schemas ${dbName}: ${items.length} schemas in ${queryDuration}ms`);
        } catch (e: unknown) {
            logPrefetchError(`[CachePrefetcher] prefetchSchemasForDb error for ${dbName}:`, e);
            if (isDatabaseLevelCatalogError(e)) {
                this.cache.markDatabaseDead(connectionName, dbName);
            }
        }
    }

    private async prefetchProceduresForDb(
        connectionName: string,
        dbName: string,
        runQueryFn: QueryRunnerRawFn,
        forceRefresh = false,
    ): Promise<void> {
        const dbCacheKey = `${dbName}..`;
        if (
            !forceRefresh &&
            (
                this.cache.getProcedures(connectionName, dbCacheKey) !== undefined
                || this.cache.isProcedureCatalogLoaded(connectionName, dbName)
            )
        ) {
            Logger.getInstance().debug(`[CachePrefetcher] [TIMING]   Procedures ${dbName}: skipped (cached)`);
            return;
        }

        try {
            const query = NZ_QUERIES.listProcedures(dbName);
            if (!query) {
                return;
            }

            const queryStart = Date.now();
            const result = await runQueryFn(query);
            const queryDuration = Date.now() - queryStart;
            if (!result) {
                return;
            }

            const results = queryResultToRows<RawProcedureRow>(result);
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
                const key = normalizedSchema ? `${dbName}.${normalizedSchema}` : dbCacheKey;

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
            this.cache.markProcedureCatalogLoaded(connectionName, dbName);

            Logger.getInstance().debug(`[CachePrefetcher] [TIMING]   Procedures ${dbName}: ${allProcedures.length} procedures in ${queryDuration}ms`);
        } catch (e: unknown) {
            logPrefetchError(`[CachePrefetcher] prefetchProceduresForDb error for ${dbName}:`, e);
            if (isDatabaseLevelCatalogError(e)) {
                this.cache.markDatabaseDead(connectionName, dbName);
            }
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
    ): Promise<void> {
        try {
            const connPrefix = `${connectionName}|`;
            const allTables: { schema: string; name: string; db: string }[] = [];

            for (const [key, entry] of this.cache.tableCache) {
                if (!key.startsWith(connPrefix)) continue;

                const parts = key.split('|');
                if (parts.length < 2) continue;

                const dbKey = parts[1];
                const dbParts = dbKey.split('.');
                const dbName = dbParts[0];
                const schemaName = dbParts.length > 1 ? dbParts[1] : '';

                for (const table of entry.data) {
                    const tableName = extractLabel(table);
                    if (tableName) {
                        allTables.push({ schema: schemaName, name: tableName, db: dbName });
                    }
                }
            }

            if (allTables.length === 0) {
                return;
            }

            let fetchedCount = 0;
            const prefetchStartTime = Date.now();

            const tablesByDb = new Map<string, typeof allTables>();
            for (const item of allTables) {
                if (!tablesByDb.has(item.db)) {
                    tablesByDb.set(item.db, []);
                }
                tablesByDb.get(item.db)!.push(item);
            }

            const dbEntries = Array.from(tablesByDb.entries());
            const totalDatabases = dbEntries.length;
            const totalTables = allTables.length;
            let completedDatabases = 0;
            const concurrencyLimit = getMetadataQueryConcurrencyLimit();

            for (let i = 0; i < dbEntries.length; i += concurrencyLimit) {
                const batch = dbEntries.slice(i, i + concurrencyLimit);
                await Promise.all(
                    batch.map(async ([dbName, dbBatch]) => {
                        if (this.cache.isDatabaseDead(connectionName, dbName)) {
                            completedDatabases += 1;
                            onProgress?.({
                                completedDatabases,
                                totalDatabases,
                                completedTables: fetchedCount,
                                totalTables,
                            });
                            return;
                        }

                        const query = NZ_QUERIES.listColumnsWithKeys(dbName);

                        try {
                            const queryStartTime = Date.now();
                            const result = await runWithMetadataQueryConcurrencyLimit(connectionName, () =>
                                runQueryFn(query),
                            );
                            const queryDuration = Date.now() - queryStartTime;

                            if (result) {
                                const parseStartTime = Date.now();
                                const results = queryResultToRows<RawColumnRowWithKeys>(result);
                                const parseDuration = Date.now() - parseStartTime;

                                const columnsByKey = groupColumnRowsByTableKey(results);

                                for (const [key, columns] of columnsByKey) {
                                    if (forceRefresh || !this.cache.getColumns(connectionName, key)) {
                                        this.cache.setColumns(connectionName, key, columns);
                                        fetchedCount++;
                                    }
                                }

                                Logger.getInstance().debug(
                                `[CachePrefetcher] [TIMING]     Columns ${dbName}: ${results.length} columns across ${dbBatch.length} tables | query=${queryDuration}ms, parse=${parseDuration}ms`,
                            );
                            }
                        } catch (e: unknown) {
                            logPrefetchError(`[CachePrefetcher] Error fetching columns for DB ${dbName}:`, e);
                            if (isDatabaseLevelCatalogError(e)) {
                                this.cache.markDatabaseDead(connectionName, dbName);
                            }
                        } finally {
                            completedDatabases += 1;
                            onProgress?.({
                                completedDatabases,
                                totalDatabases,
                                completedTables: fetchedCount,
                                totalTables,
                            });
                        }
                    }),
                );
            }

            const totalDuration = Date.now() - prefetchStartTime;
            Logger.getInstance().debug(`[CachePrefetcher] [TIMING]   Columns total: ${fetchedCount} tables cached in ${totalDuration}ms`);
            Logger.getInstance().debug(`[CachePrefetcher] [TIMING]   Columns processed: ${dbEntries.length} databases, ${allTables.length} tables total`);
        } catch (e: unknown) {
            logPrefetchError(`[CachePrefetcher] prefetchAllColumnsForConnection error:`, e);
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
        this.connectionPrefetchTriggered.clear();
        this.connectionPrefetchInProgress.clear();
        this.lastCheckpointTime.clear();
        Logger.getInstance().info('[CachePrefetcher] Prefetch tracking state reset');
    }
}
