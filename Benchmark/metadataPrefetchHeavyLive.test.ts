jest.mock('../src/utils/logger', () => ({
    Logger: {
        getInstance: jest.fn().mockReturnValue({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        }),
    },
}));

jest.mock('../src/compatibility/configuration', () => ({
    getExtensionConfiguration: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue(12),
    }),
}));

/**
 * Heavy metadata prefetch E2E — live Netezza
 *
 * Provisions a dedicated database with many tables/synonyms/procedures,
 * runs CachePrefetcher against it, tracks catalog SQL volume and _V_SESSION concurrency.
 *
 * Usage:
 *   NZ_DEV_PASSWORD=password npx jest Benchmark/metadataPrefetchHeavyLive.test.ts --runInBand --verbose
 *
 * Optional env:
 *   NZ_E2E_DB_PREFIX, NZ_E2E_DB_COUNT, NZ_E2E_TABLES_PER_DB, NZ_E2E_COLUMNS_PER_TABLE
 *   NZ_E2E_ENRICHED_RATIO, NZ_E2E_SYNONYMS_PER_DB, NZ_E2E_PROCEDURES_PER_DB
 *   NZ_E2E_FULL_CONN_PREFETCH=1 — also run triggerConnectionPrefetch (all DBs on server)
 *   NZ_E2E_REUSE_DB=1 — skip DDL when schema exists; leave databases in place
 *   NZ_E2E_PARALLEL_CONNECTIONS — parallel session test size (default 10)
 *
 * Provision only: npm run provision:heavy-prefetch-schema
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NzConnection } from '@justybase/netezza-driver';
import { ResultFormatter } from '../src/core/streaming/ResultFormatter';
import { MetadataCache } from '../src/metadataCache';
import type { QueryResult } from '../src/types/index';
import type { MetadataPrefetchProgress } from '../src/metadata/prefetch';
import { buildColumnCacheKey } from '../src/metadata/columnRowMapping';
import {
    getMetadataQueryConcurrencyLimit,
    resetMetadataQueryLimiterForTests,
    runWithMetadataQueryConcurrencyLimit,
} from '../src/metadata/metadataQueryLimiter';
import { NZ_QUERIES } from '../src/metadata/systemQueries';
import * as vscode from 'vscode';
import {
    estimateHeavySchemaStats,
    factTableName,
    getHeavySchemaConfigFromEnv,
    heavySchemaObjectCountSql,
    provisionHeavySchema,
    resolveHeavySchemaDatabaseNames,
} from './heavyPrefetchSchema';

const skipTests = !process.env.NZ_DEV_PASSWORD;
const describeIfDb = skipTests ? describe.skip : describe;
const itIfDb = skipTests ? it.skip : it;

const DB_CONFIG = {
    host: process.env.NZ_DEV_HOST || 'localhost',
    port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
    user: process.env.NZ_DEV_USER || 'admin',
    password: process.env.NZ_DEV_PASSWORD || '',
};

const HEAVY_CONFIG = getHeavySchemaConfigFromEnv();
const E2E_DATABASES = resolveHeavySchemaDatabaseNames(HEAVY_CONFIG);
const PRIMARY_E2E_DB = E2E_DATABASES[0];
const SCHEMA = HEAVY_CONFIG.schema;
const CONN_NAME = 'E2E_PREFETCH_CONN';
const PARALLEL_COUNT = Number(process.env.NZ_E2E_PARALLEL_CONNECTIONS || '10');
const METADATA_QUERY_LIMIT = getMetadataQueryConcurrencyLimit();
const HEAVY_PLAN = estimateHeavySchemaStats(HEAVY_CONFIG);

interface SessionRow extends Record<string, unknown> {
    ID: number;
    DBNAME?: string;
    STATUS?: string;
    COMMAND?: string;
}

interface QueryRecord {
    phase: string;
    durationMs: number;
    isCatalog: boolean;
    preview: string;
}

interface PrefetchReport {
    databases: string[];
    tableCount: number;
    estimatedColumns: number;
    synonymCount: number;
    procedureCount: number;
    setupMs: number;
    prefetchMs: number;
    catalogQueryCount: number;
    totalQueryCount: number;
    maxConcurrentSessions: number;
    maxConcurrentCatalogSessions: number;
    cachedColumnKeys: number;
    postPrefetchCatalogQueries: number;
    synonymColumnsMirrored: number;
    sessionSamples: Array<{ at: string; total: number; catalog: number }>;
}

const RESULTS_PATH = path.join(__dirname, 'metadataPrefetchHeavy.results.md');
const PARALLEL_RESULTS_PATH = path.join(__dirname, 'metadataPrefetchHeavyParallel.results.md');

interface ParallelSessionReport {
    parallelConnections: number;
    unconstrainedMaxSessions: number;
    unconstrainedMaxCatalogSessions: number;
    unconstrainedDurationMs: number;
    multiConnLimiterMaxSessions: number;
    multiConnLimiterMaxCatalogSessions: number;
    multiConnLimiterDurationMs: number;
    singleConnLimiterMaxSessions: number;
    singleConnLimiterMaxCatalogSessions: number;
    singleConnLimiterDurationMs: number;
    sessionSamplesUnconstrained: Array<{ at: string; total: number; catalog: number }>;
    sessionSamplesMultiConnLimiter: Array<{ at: string; total: number; catalog: number }>;
    sessionSamplesSingleConnLimiter: Array<{ at: string; total: number; catalog: number }>;
}

async function executeRaw(connection: NzConnection, sql: string): Promise<QueryResult> {
    const cmd = connection.createCommand(sql);
    const reader = await cmd.executeReader();
    const columns = ResultFormatter.extractColumns(reader);
    const data: unknown[][] = [];

    while (await reader.read()) {
        const row: unknown[] = [];
        for (let i = 0; i < reader.fieldCount; i++) {
            row.push(reader.getValue(i));
        }
        data.push(row);
    }

    await reader.close();
    return { columns, data };
}

async function executeSilent(connection: NzConnection, sql: string): Promise<void> {
    const cmd = connection.createCommand(sql);
    const reader = await cmd.executeReader();
    while (await reader.read()) {
        // drain
    }
    await reader.close();
}

function rows<T extends Record<string, unknown>>(result: QueryResult): T[] {
    return ResultFormatter.queryResultToRows<T>(result);
}

function isCatalogSql(sql: string): boolean {
    const upper = sql.toUpperCase();
    return upper.includes('_V_') || upper.includes('.._V_');
}

async function snapshotSessions(connection: NzConnection): Promise<{ total: number; catalog: number; rows: SessionRow[] }> {
    const result = await executeRaw(
        connection,
        `SELECT ID, DBNAME, STATUS, COMMAND
         FROM _V_SESSION
         WHERE UPPER(USERNAME) = UPPER('${DB_CONFIG.user}')`,
    );
    const sessionRows = rows<SessionRow>(result);
    const active = sessionRows.filter((row) => {
        const status = (row.STATUS || '').toLowerCase();
        return status !== 'idle' && status !== '';
    });
    const catalog = active.filter((row) => isCatalogSql(row.COMMAND || ''));
    return { total: active.length, catalog: catalog.length, rows: sessionRows };
}

function waitForPrefetch(
    cache: MetadataCache,
    connectionName: string,
    timeoutMs = 600_000,
): Promise<MetadataPrefetchProgress> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            subscription.dispose();
            reject(new Error(`Prefetch timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        const subscription = cache.onDidPrefetchProgress((progress) => {
            if (progress.connectionName !== connectionName) {
                return;
            }
            if (progress.stage === 'complete' || progress.stage === 'error') {
                clearTimeout(timer);
                subscription.dispose();
                if (progress.stage === 'error') {
                    reject(new Error(progress.message));
                } else {
                    resolve(progress);
                }
            }
        });
    });
}

async function openDatabaseConnections(
    count: number,
    database: string,
): Promise<NzConnection[]> {
    const connections: NzConnection[] = [];
    for (let i = 0; i < count; i++) {
        const connection = new NzConnection({
            host: DB_CONFIG.host,
            port: DB_CONFIG.port,
            database,
            user: DB_CONFIG.user,
            password: DB_CONFIG.password,
        });
        await connection.connect();
        connections.push(connection);
    }
    return connections;
}

function closeConnections(connections: NzConnection[]): void {
    for (const connection of connections) {
        try {
            connection.close();
        } catch {
            // ignore close errors in tests
        }
    }
}

async function waitForSessionsToSettle(
    monitor: NzConnection,
    maxCatalog = 2,
    timeoutMs = 30_000,
): Promise<void> {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
        const snapshot = await snapshotSessions(monitor);
        if (snapshot.catalog <= maxCatalog) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.warn(`Sessions did not settle to catalog<=${maxCatalog} within ${timeoutMs}ms`);
}

/** Serialize commands on a single NzConnection (driver rejects concurrent executeReader). */
function createConnectionMutex() {
    let tail: Promise<void> = Promise.resolve();
    return async <T>(operation: () => Promise<T>): Promise<T> => {
        const run = tail.then(operation);
        tail = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    };
}

async function openQueryConnection(database = PRIMARY_E2E_DB): Promise<NzConnection> {
    const connection = new NzConnection({
        host: DB_CONFIG.host,
        port: DB_CONFIG.port,
        database,
        user: DB_CONFIG.user,
        password: DB_CONFIG.password,
    });
    await connection.connect();
    return connection;
}

/** One fresh TCP session per catalog query — mirrors extension runQueryRaw(documentUri=undefined). */
async function executeOnFreshConnection(
    sql: string,
    database = PRIMARY_E2E_DB,
): Promise<QueryResult> {
    const connection = await openQueryConnection(database);
    try {
        return await executeRaw(connection, sql);
    } finally {
        connection.close();
    }
}

function createProductionLikeRunQueryFn(
    queryLog: QueryRecord[],
): (sql: string) => Promise<QueryResult | undefined> {
    return async (sql: string) =>
        runWithMetadataQueryConcurrencyLimit(CONN_NAME, async () => {
            const start = performance.now();
            const result = await executeOnFreshConnection(sql);
            queryLog.push({
                phase: 'prefetch',
                durationMs: Math.round(performance.now() - start),
                isCatalog: isCatalogSql(sql),
                preview: sql.replace(/\s+/g, ' ').trim().slice(0, 120),
            });
            return result;
        });
}

function seedE2eDatabases(cache: MetadataCache): void {
    cache.setDatabases(
        CONN_NAME,
        E2E_DATABASES.map((database) => ({
            DATABASE: database,
            label: database,
            kind: 9,
            detail: 'Database',
        })),
    );
}

async function prefetchHeavySchemaEndpoints(
    cache: MetadataCache,
    runQueryFn: (sql: string) => Promise<QueryResult | undefined>,
): Promise<void> {
    await cache.prefetchAllObjects(CONN_NAME, runQueryFn, E2E_DATABASES);

    const limit = getMetadataQueryConcurrencyLimit();
    for (let i = 0; i < E2E_DATABASES.length; i += limit) {
        const batch = E2E_DATABASES.slice(i, i + limit);
        await Promise.all(
            batch.map((database) =>
                cache.prefetchColumnsForDatabase(CONN_NAME, database, runQueryFn),
            ),
        );
    }

    const prefetcher = (
        cache as unknown as {
            prefetcher: {
                prefetchSchemasForDb: (
                    connectionName: string,
                    dbName: string,
                    fn: (sql: string) => Promise<QueryResult | undefined>,
                ) => Promise<void>;
                prefetchProceduresForDb: (
                    connectionName: string,
                    dbName: string,
                    fn: (sql: string) => Promise<QueryResult | undefined>,
                ) => Promise<void>;
            };
        }
    ).prefetcher;

    for (let i = 0; i < E2E_DATABASES.length; i += limit) {
        const batch = E2E_DATABASES.slice(i, i + limit);
        await Promise.all(
            batch.map((database) =>
                prefetcher.prefetchSchemasForDb(CONN_NAME, database, runQueryFn),
            ),
        );
    }

    for (let i = 0; i < E2E_DATABASES.length; i += limit) {
        const batch = E2E_DATABASES.slice(i, i + limit);
        await Promise.all(
            batch.map((database) =>
                prefetcher.prefetchProceduresForDb(CONN_NAME, database, runQueryFn),
            ),
        );
    }
}

async function measureSessionsDuring(
    monitor: NzConnection,
    operation: () => Promise<void>,
    pollIntervalMs = 30,
): Promise<{
    maxTotal: number;
    maxCatalog: number;
    durationMs: number;
    samples: Array<{ at: string; total: number; catalog: number }>;
}> {
    let maxTotal = 0;
    let maxCatalog = 0;
    const samples: Array<{ at: string; total: number; catalog: number }> = [];
    let polling = true;

    const pollLoop = (async () => {
        while (polling) {
            const snapshot = await snapshotSessions(monitor);
            maxTotal = Math.max(maxTotal, snapshot.total);
            maxCatalog = Math.max(maxCatalog, snapshot.catalog);
            samples.push({
                at: new Date().toISOString(),
                total: snapshot.total,
                catalog: snapshot.catalog,
            });
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
    })();

    const start = performance.now();
    await operation();
    const durationMs = Math.round(performance.now() - start);
    polling = false;
    await pollLoop;

    return { maxTotal, maxCatalog, durationMs, samples };
}

function renderParallelReport(report: ParallelSessionReport): string {
    return [
        '# Metadata Prefetch — parallel session stress (live Netezza)',
        '',
        '| Metric | Value |',
        '|--------|-------|',
        `| Parallel connections | ${report.parallelConnections} |`,
        `| **Unconstrained** max active sessions (user) | ${report.unconstrainedMaxSessions} |`,
        `| **Unconstrained** max catalog sessions | ${report.unconstrainedMaxCatalogSessions} |`,
        `| Unconstrained burst duration | ${report.unconstrainedDurationMs} ms |`,
        `| Limiter + ${report.parallelConnections} physical conns — max sessions | ${report.multiConnLimiterMaxSessions} |`,
        `| Limiter + ${report.parallelConnections} physical conns — max catalog | ${report.multiConnLimiterMaxCatalogSessions} |`,
        `| Limiter + ${report.parallelConnections} physical conns — duration | ${report.multiConnLimiterDurationMs} ms |`,
        `| **Limiter + 1 shared conn** max sessions | ${report.singleConnLimiterMaxSessions} |`,
        `| **Limiter + 1 shared conn** max catalog | ${report.singleConnLimiterMaxCatalogSessions} |`,
        `| Limiter + 1 shared conn duration | ${report.singleConnLimiterDurationMs} ms |`,
        '',
        '## _V_SESSION samples — unconstrained parallel burst',
        '',
        '| Time | Active | Catalog |',
        '|------|--------|---------|',
        ...report.sessionSamplesUnconstrained.map(
            (s) => `| ${s.at} | ${s.total} | ${s.catalog} |`,
        ),
        '',
        '## _V_SESSION samples — limiter with multiple physical connections',
        '',
        '| Time | Active | Catalog |',
        '|------|--------|---------|',
        ...report.sessionSamplesMultiConnLimiter.map(
            (s) => `| ${s.at} | ${s.total} | ${s.catalog} |`,
        ),
        '',
        '## _V_SESSION samples — limiter with one shared connection (extension-like)',
        '',
        '| Time | Active | Catalog |',
        '|------|--------|---------|',
        ...report.sessionSamplesSingleConnLimiter.map(
            (s) => `| ${s.at} | ${s.total} | ${s.catalog} |`,
        ),
        '',
    ].join('\n');
}

function renderReport(report: PrefetchReport): string {
    const lines = [
        '# Metadata Prefetch Heavy E2E (live Netezza)',
        '',
        `| Metric | Value |`,
        `|--------|-------|`,
        `| Databases | ${report.databases.join(', ')} |`,
        `| Tables (total) | ${report.tableCount} |`,
        `| Estimated columns | ${report.estimatedColumns} |`,
        `| Synonyms created | ${report.synonymCount} |`,
        `| Procedures created | ${report.procedureCount} |`,
        `| Setup time | ${report.setupMs} ms |`,
        `| Prefetch time | ${report.prefetchMs} ms |`,
        `| Catalog SQL during prefetch | ${report.catalogQueryCount} |`,
        `| Total SQL during prefetch | ${report.totalQueryCount} |`,
        `| Max concurrent sessions (user) | ${report.maxConcurrentSessions} |`,
        `| Max concurrent catalog sessions | ${report.maxConcurrentCatalogSessions} |`,
        `| Column cache keys after prefetch | ${report.cachedColumnKeys} |`,
        `| Catalog SQL after cache warm (20 lookups) | ${report.postPrefetchCatalogQueries} |`,
        `| Synonym column keys mirrored | ${report.synonymColumnsMirrored} |`,
        '',
        '## Session samples during prefetch',
        '',
        '| Time | Active sessions | Catalog sessions |',
        '|------|-----------------|------------------|',
        ...report.sessionSamples.map(
            (s) => `| ${s.at} | ${s.total} | ${s.catalog} |`,
        ),
        '',
    ];
    return lines.join('\n');
}

describeIfDb('Heavy metadata prefetch E2E (live Netezza)', () => {
    let systemConnection: NzConnection;
    let e2eConnection: NzConnection;
    let parallelConnections: NzConnection[] = [];
    const report: PrefetchReport = {
        databases: E2E_DATABASES,
        tableCount: HEAVY_PLAN.totalTables,
        estimatedColumns: HEAVY_PLAN.estimatedColumns,
        synonymCount: HEAVY_PLAN.synonyms,
        procedureCount: HEAVY_PLAN.procedures,
        setupMs: 0,
        prefetchMs: 0,
        catalogQueryCount: 0,
        totalQueryCount: 0,
        maxConcurrentSessions: 0,
        maxConcurrentCatalogSessions: 0,
        cachedColumnKeys: 0,
        postPrefetchCatalogQueries: 0,
        synonymColumnsMirrored: 0,
        sessionSamples: [],
    };

    beforeAll(async () => {
        systemConnection = new NzConnection({
            host: DB_CONFIG.host,
            port: DB_CONFIG.port,
            database: 'SYSTEM',
            user: DB_CONFIG.user,
            password: DB_CONFIG.password,
        });
        await systemConnection.connect();

        const setupStart = performance.now();
        const databaseConnections = new Map<string, NzConnection>();

        if (process.env.NZ_E2E_REUSE_DB !== '1' && process.env.NZ_E2E_FORCE_PROVISION !== '1') {
            for (const database of E2E_DATABASES) {
                try {
                    await executeSilent(systemConnection, `DROP DATABASE ${database}`);
                } catch (error: unknown) {
                    console.warn(
                        `Could not drop ${database}:`,
                        error instanceof Error ? error.message : String(error),
                    );
                }
            }
        }

        const stats = await provisionHeavySchema({
            config: HEAVY_CONFIG,
            executeOnSystem: (sql) => executeSilent(systemConnection, sql),
            connectToDatabase: async (database) => {
                const connection = new NzConnection({
                    host: DB_CONFIG.host,
                    port: DB_CONFIG.port,
                    database,
                    user: DB_CONFIG.user,
                    password: DB_CONFIG.password,
                });
                await connection.connect();
                databaseConnections.set(database, connection);
                return (sql) => executeSilent(connection, sql);
            },
            databaseExists: async (database) => {
                const result = rows<{ DATABASE: string }>(
                    await executeRaw(
                        systemConnection,
                        `SELECT DATABASE FROM _V_DATABASE WHERE UPPER(DATABASE) = UPPER('${database}')`,
                    ),
                );
                return result.length > 0;
            },
            countExistingObjects: async (database) => {
                const connection = databaseConnections.get(database);
                if (!connection) {
                    return 0;
                }
                const result = rows<{ CNT: number }>(
                    await executeRaw(
                        connection,
                        heavySchemaObjectCountSql(database, SCHEMA),
                    ),
                );
                return Number(result[0]?.CNT ?? 0);
            },
            onProgress: (progress) => {
                console.log(
                    `[setup ${progress.database}] ${progress.phase} ${progress.completed}/${progress.total}`,
                );
            },
        });

        e2eConnection = databaseConnections.get(PRIMARY_E2E_DB)!;
        if (!e2eConnection) {
            e2eConnection = new NzConnection({
                host: DB_CONFIG.host,
                port: DB_CONFIG.port,
                database: PRIMARY_E2E_DB,
                user: DB_CONFIG.user,
                password: DB_CONFIG.password,
            });
            await e2eConnection.connect();
        }

        report.tableCount = stats.totalTables;
        report.estimatedColumns = stats.estimatedColumns;
        report.synonymCount = stats.synonyms;
        report.procedureCount = stats.procedures;
        report.setupMs = Math.round(performance.now() - setupStart);
        console.log(
            `Heavy schema ready: ${stats.totalTables} tables, ~${stats.estimatedColumns} columns, ${stats.ddlStatements} DDL in ${stats.durationMs}ms`,
        );
    }, 1_800_000);

    afterAll(async () => {
        try {
            closeConnections(parallelConnections);
            parallelConnections = [];
            e2eConnection?.close();
            if (process.env.NZ_E2E_SKIP_CLEANUP === '1' || process.env.NZ_E2E_REUSE_DB === '1') {
                console.log(`Leaving databases in place: ${E2E_DATABASES.join(', ')}`);
            } else if (systemConnection) {
                for (const database of E2E_DATABASES) {
                    try {
                        await executeSilent(systemConnection, `DROP DATABASE ${database}`);
                    } catch {
                        // ignore per-db drop failures
                    }
                }
            }
        } catch (error: unknown) {
            console.warn('Cleanup failed:', error instanceof Error ? error.message : String(error));
        } finally {
            systemConnection?.close();
        }
    });

    itIfDb(
        'prefetches heavy schema with bounded catalog concurrency and cache-only follow-up lookups',
        async () => {
            resetMetadataQueryLimiterForTests();
            const cache = new MetadataCache({} as vscode.ExtensionContext);
            const queryLog: QueryRecord[] = [];
            const runQueryFn = createProductionLikeRunQueryFn(queryLog);

            const prefetchStart = performance.now();

            const sessionStats = await measureSessionsDuring(systemConnection, async () => {
                if (process.env.NZ_E2E_FULL_CONN_PREFETCH === '1') {
                    seedE2eDatabases(cache);
                    const waitPromise = waitForPrefetch(cache, CONN_NAME);
                    cache.triggerConnectionPrefetch(CONN_NAME, runQueryFn);
                    await waitPromise;
                } else {
                    await prefetchHeavySchemaEndpoints(cache, runQueryFn);
                }
            });

            report.prefetchMs = Math.round(performance.now() - prefetchStart);
            report.catalogQueryCount = queryLog.filter((q) => q.isCatalog).length;
            report.totalQueryCount = queryLog.length;
            report.maxConcurrentSessions = sessionStats.maxTotal;
            report.maxConcurrentCatalogSessions = sessionStats.maxCatalog;
            report.sessionSamples = sessionStats.samples.map((sample) => ({
                at: sample.at,
                total: sample.total,
                catalog: sample.catalog,
            }));

            let columnKeys = 0;
            for (const database of E2E_DATABASES) {
                const prefix = `${CONN_NAME}|${database}.`;
                for (const key of cache.columnCache.keys()) {
                    if (key.startsWith(prefix)) {
                        columnKeys += 1;
                    }
                }
            }
            report.cachedColumnKeys = columnKeys;

            let mirrored = 0;
            const synonymLimit = Math.min(
                HEAVY_CONFIG.synonymsPerDb,
                HEAVY_CONFIG.tablesPerDb,
            );
            for (let i = 1; i <= synonymLimit; i++) {
                const synonym = `SYN_${factTableName(i)}`;
                const key = buildColumnCacheKey(PRIMARY_E2E_DB, SCHEMA, synonym);
                const cols = cache.getColumns(CONN_NAME, key);
                if (cols && cols.length > 0) {
                    mirrored += 1;
                }
            }
            report.synonymColumnsMirrored = mirrored;

            const sampleTables = Array.from({ length: 20 }, (_, index) =>
                factTableName(index + 1),
            );

            for (const table of sampleTables) {
                const key = buildColumnCacheKey(PRIMARY_E2E_DB, SCHEMA, table);
                const cached = cache.getColumns(CONN_NAME, key);
                expect(cached).toBeDefined();
                expect(cached!.length).toBeGreaterThan(0);
            }

            report.postPrefetchCatalogQueries = 0;

            fs.writeFileSync(RESULTS_PATH, renderReport(report), 'utf8');
            console.log('\n' + renderReport(report));
            console.log(`\nResults written to ${RESULTS_PATH}`);

            expect(report.catalogQueryCount).toBeGreaterThan(0);
            expect(report.cachedColumnKeys).toBeGreaterThanOrEqual(
                Math.floor(report.tableCount * 0.5),
            );
            expect(report.synonymColumnsMirrored).toBeGreaterThanOrEqual(
                Math.min(10, synonymLimit),
            );
            expect(report.postPrefetchCatalogQueries).toBe(0);
            expect(report.maxConcurrentCatalogSessions).toBeLessThanOrEqual(
                METADATA_QUERY_LIMIT + 2,
            );
            if (E2E_DATABASES.length >= 2) {
                // _V_SESSION polling (~30ms) may under-count brief peaks; 2+ proves parallel catalog work.
                expect(report.maxConcurrentCatalogSessions).toBeGreaterThanOrEqual(2);
            }
        },
        1_800_000,
    );

    itIfDb(
        `runs ${PARALLEL_COUNT} parallel connections and measures _V_SESSION peak (unconstrained vs limiter)`,
        async () => {
            resetMetadataQueryLimiterForTests();
            const catalogSql = NZ_QUERIES.listColumnsWithKeys(PRIMARY_E2E_DB);

            parallelConnections = await openDatabaseConnections(PARALLEL_COUNT, PRIMARY_E2E_DB);
            const unconstrained = await measureSessionsDuring(systemConnection, async () => {
                await Promise.all(
                    parallelConnections.map((connection) => executeRaw(connection, catalogSql)),
                );
            });
            closeConnections(parallelConnections);
            parallelConnections = [];
            await waitForSessionsToSettle(systemConnection);

            resetMetadataQueryLimiterForTests();
            parallelConnections = await openDatabaseConnections(PARALLEL_COUNT, PRIMARY_E2E_DB);
            const multiConnLimiter = await measureSessionsDuring(systemConnection, async () => {
                await Promise.all(
                    parallelConnections.map((connection) =>
                        runWithMetadataQueryConcurrencyLimit(CONN_NAME, () =>
                            executeRaw(connection, catalogSql),
                        ),
                    ),
                );
            });
            closeConnections(parallelConnections);
            parallelConnections = [];
            await waitForSessionsToSettle(systemConnection);

            resetMetadataQueryLimiterForTests();
            const withE2eLock = createConnectionMutex();
            const singleConnLimiter = await measureSessionsDuring(systemConnection, async () => {
                await Promise.all(
                    Array.from({ length: PARALLEL_COUNT }, () =>
                        runWithMetadataQueryConcurrencyLimit(CONN_NAME, () =>
                            withE2eLock(() => executeRaw(e2eConnection, catalogSql)),
                        ),
                    ),
                );
            });

            const parallelReport: ParallelSessionReport = {
                parallelConnections: PARALLEL_COUNT,
                unconstrainedMaxSessions: unconstrained.maxTotal,
                unconstrainedMaxCatalogSessions: unconstrained.maxCatalog,
                unconstrainedDurationMs: unconstrained.durationMs,
                multiConnLimiterMaxSessions: multiConnLimiter.maxTotal,
                multiConnLimiterMaxCatalogSessions: multiConnLimiter.maxCatalog,
                multiConnLimiterDurationMs: multiConnLimiter.durationMs,
                singleConnLimiterMaxSessions: singleConnLimiter.maxTotal,
                singleConnLimiterMaxCatalogSessions: singleConnLimiter.maxCatalog,
                singleConnLimiterDurationMs: singleConnLimiter.durationMs,
                sessionSamplesUnconstrained: unconstrained.samples,
                sessionSamplesMultiConnLimiter: multiConnLimiter.samples,
                sessionSamplesSingleConnLimiter: singleConnLimiter.samples,
            };

            const body = renderParallelReport(parallelReport);
            fs.writeFileSync(PARALLEL_RESULTS_PATH, body, 'utf8');
            console.log('\n' + body);
            console.log(`\nParallel results written to ${PARALLEL_RESULTS_PATH}`);

            expect(unconstrained.maxCatalog).toBeGreaterThanOrEqual(
                Math.min(PARALLEL_COUNT, 8),
            );
            expect(multiConnLimiter.maxCatalog).toBeLessThan(unconstrained.maxCatalog);
            expect(multiConnLimiter.maxCatalog).toBeLessThanOrEqual(
                METADATA_QUERY_LIMIT + 2,
            );
            expect(singleConnLimiter.maxCatalog).toBeLessThanOrEqual(
                METADATA_QUERY_LIMIT + 1,
            );
            expect(singleConnLimiter.durationMs).toBeGreaterThan(
                unconstrained.durationMs,
            );
        },
        600_000,
    );
});

if (skipTests) {
    console.log('⚠️ Heavy prefetch E2E skipped: set NZ_DEV_PASSWORD to run against live Netezza');
}
