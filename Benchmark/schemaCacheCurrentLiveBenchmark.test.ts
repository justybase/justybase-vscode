/**
 * Current file-backed schema cache benchmark on live Netezza.
 *
 * Read-only: uses existing databases/schemas and does not provision objects.
 *
 * Usage:
 *   NZ_DEV_PASSWORD=... NZ_SCHEMA_CACHE_DATABASES=DB1,DB2 \
 *   NODE_OPTIONS="--max-old-space-size=4096 --expose-gc" \
 *   npx jest --config Benchmark/jest.config.js --runInBand Benchmark/schemaCacheCurrentLiveBenchmark.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { NzConnection } from '@justybase/netezza-driver';
import { ResultFormatter } from '../src/core/streaming/ResultFormatter';
import { MetadataCache } from '../src/metadataCache';
import { NZ_QUERIES } from '../src/metadata/systemQueries';
import { Logger } from '../src/utils/logger';
import type { QueryResult } from '../src/types';
import type { ConnectionManager } from '../src/core/connectionManager';

const skipLive = !process.env.NZ_DEV_PASSWORD;
const describeIfLive = skipLive ? describe.skip : describe;

const DB_CONFIG = {
    host: process.env.NZ_DEV_HOST || 'localhost',
    port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
    user: process.env.NZ_DEV_USER || 'admin',
    password: process.env.NZ_DEV_PASSWORD || '',
    database: process.env.NZ_DEV_DATABASE || 'SYSTEM',
};

const CONN_NAME = 'SCHEMA_CACHE_LIVE';
const RESULTS_PATH = path.join(__dirname, 'schemaCacheCurrentLive.results.md');

interface QueryTiming {
    sql: string;
    durationMs: number;
    rows: number;
}

interface BenchmarkReport {
    date: string;
    node: string;
    databases: string[];
    prefetchMs: number;
    diskSaveMs: number;
    manifestInitMs: number;
    fullHydrateMs: number;
    tableLayers: number;
    columnLayers: number;
    procedureLayers: number;
    cacheBytes: number;
    rssBefore: number;
    rssAfterPrefetch: number;
    rssAfterHydrate: number;
    queryTimings: QueryTiming[];
}

async function executeRaw(connection: NzConnection, sql: string): Promise<QueryResult> {
    const command = connection.createCommand(sql);
    const reader = await command.executeReader();
    const columns = ResultFormatter.extractColumns(reader);
    const data: unknown[][] = [];
    while (await reader.read()) {
        const row: unknown[] = [];
        for (let index = 0; index < reader.fieldCount; index++) {
            row.push(reader.getValue(index));
        }
        data.push(row);
    }
    await reader.close();
    return { columns, data };
}

async function withConnection<T>(
    database: string,
    operation: (connection: NzConnection) => Promise<T>,
): Promise<T> {
    const connection = new NzConnection({
        host: DB_CONFIG.host,
        port: DB_CONFIG.port,
        database,
        user: DB_CONFIG.user,
        password: DB_CONFIG.password,
    });
    await connection.connect();
    try {
        return await operation(connection);
    } finally {
        connection.close();
    }
}

function createMockConnectionManager(databases: string[]): ConnectionManager {
    return {
        getConnectionMetadata: () => ({
            host: DB_CONFIG.host,
            port: DB_CONFIG.port,
            database: DB_CONFIG.database,
            user: DB_CONFIG.user,
            dbType: 'netezza' as const,
        }),
        getConnectionNames: () => [CONN_NAME],
        getConnectionDatabaseKind: () => 'netezza' as const,
        ensureFullyLoaded: async () => undefined,
        getActiveConnectionName: () => CONN_NAME,
        getConnectionForExecution: () => CONN_NAME,
        getCurrentDatabase: async () => databases[0] || DB_CONFIG.database,
    } as unknown as ConnectionManager;
}

function directoryBytes(root: string): number {
    let total = 0;
    if (!fs.existsSync(root)) {
        return 0;
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            total += directoryBytes(fullPath);
        } else if (entry.isFile()) {
            total += fs.statSync(fullPath).size;
        }
    }
    return total;
}

function getSelectedDatabases(allDatabases: string[]): string[] {
    const explicit = process.env.NZ_SCHEMA_CACHE_DATABASES
        ?.split(',')
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean);
    if (explicit && explicit.length > 0) {
        return explicit;
    }
    const max = Number(process.env.NZ_SCHEMA_CACHE_MAX_DATABASES || '0');
    return max > 0 ? allDatabases.slice(0, max) : allDatabases;
}

function countCacheLayers(cache: MetadataCache): Pick<
    BenchmarkReport,
    'tableLayers' | 'columnLayers' | 'procedureLayers'
> {
    const store = cache as unknown as {
        _store: {
            tableCache: Map<string, unknown>;
            columnCache: Map<string, unknown>;
            procedureCache: Map<string, unknown>;
        };
    };
    return {
        tableLayers: store._store.tableCache.size,
        columnLayers: store._store.columnCache.size,
        procedureLayers: store._store.procedureCache.size,
    };
}

function renderReport(report: BenchmarkReport): string {
    return [
        '# Current Schema Cache Live Benchmark',
        '',
        `Date: ${report.date}`,
        `Node: ${report.node}`,
        `Databases: ${report.databases.join(', ')}`,
        '',
        '| Metric | Value |',
        '| --- | ---: |',
        `| Prefetch | ${report.prefetchMs} ms |`,
        `| Disk save | ${report.diskSaveMs} ms |`,
        `| Manifest init after restart | ${report.manifestInitMs} ms |`,
        `| Full metadata hydrate after restart | ${report.fullHydrateMs} ms |`,
        `| Cache bytes on disk | ${report.cacheBytes} |`,
        `| Table layers | ${report.tableLayers} |`,
        `| Column layers | ${report.columnLayers} |`,
        `| Procedure layers | ${report.procedureLayers} |`,
        `| RSS before | ${report.rssBefore} |`,
        `| RSS after prefetch | ${report.rssAfterPrefetch} |`,
        `| RSS after hydrate | ${report.rssAfterHydrate} |`,
        '',
        '## Catalog Query Timings',
        '',
        '| Rows | Duration | SQL |',
        '| ---: | ---: | --- |',
        ...report.queryTimings.map((timing) =>
            `| ${timing.rows} | ${timing.durationMs} ms | \`${timing.sql.replace(/\s+/g, ' ').slice(0, 180)}\` |`,
        ),
        '',
    ].join('\n');
}

describeIfLive('current schema cache live benchmark', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-cache-current-live-'));
    const queryTimings: QueryTiming[] = [];

    beforeAll(() => {
        Logger.initialize({
            appendLine: () => undefined,
            show: () => undefined,
            dispose: () => undefined,
        } as unknown as vscode.OutputChannel);
    });

    afterAll(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('measures current file-backed cache against existing live Netezza schemas', async () => {
        const allDatabases = await withConnection(DB_CONFIG.database, async (connection) => {
            const result = await executeRaw(connection, NZ_QUERIES.LIST_DATABASES);
            return ResultFormatter.queryResultToRows<{ DATABASE: string }>(result)
                .map((row) => row.DATABASE)
                .filter(Boolean);
        });
        const databases = getSelectedDatabases(allDatabases);
        expect(databases.length).toBeGreaterThan(0);

        const connectionManager = createMockConnectionManager(databases);
        const cache = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            connectionManager,
        );
        cache.setDatabases(
            CONN_NAME,
            databases.map((database) => ({
                DATABASE: database,
                label: database,
                kind: 9,
                detail: 'Database',
            })),
        );

        const runQuery = async (sql: string): Promise<QueryResult | undefined> => {
            const start = performance.now();
            const result = await withConnection(DB_CONFIG.database, (connection) =>
                executeRaw(connection, sql),
            );
            queryTimings.push({
                sql,
                durationMs: Math.round(performance.now() - start),
                rows: result.data?.length ?? 0,
            });
            return result;
        };

        const rssBefore = process.memoryUsage().rss;
        const prefetchStart = performance.now();
        await cache.prefetchAllObjects(CONN_NAME, runQuery, databases);
        const prefetcher = (cache as unknown as {
            prefetcher: {
                prefetchSchemasForDb: (
                    connectionName: string,
                    dbName: string,
                    fn: (sql: string) => Promise<QueryResult | undefined>,
                    forceRefresh?: boolean,
                ) => Promise<void>;
                prefetchTypeGroupsForDb: (
                    connectionName: string,
                    dbName: string,
                    fn: (sql: string) => Promise<QueryResult | undefined>,
                    forceRefresh?: boolean,
                ) => Promise<void>;
                prefetchProceduresForDb: (
                    connectionName: string,
                    dbName: string,
                    fn: (sql: string) => Promise<QueryResult | undefined>,
                    forceRefresh?: boolean,
                ) => Promise<void>;
            };
        }).prefetcher;

        for (const database of databases) {
            await prefetcher.prefetchSchemasForDb(CONN_NAME, database, runQuery, true);
            await prefetcher.prefetchTypeGroupsForDb(CONN_NAME, database, runQuery, true);
            await prefetcher.prefetchProceduresForDb(CONN_NAME, database, runQuery, true);
            await cache.prefetchColumnsForDatabase(CONN_NAME, database, runQuery);
        }
        const prefetchMs = Math.round(performance.now() - prefetchStart);
        const rssAfterPrefetch = process.memoryUsage().rss;

        const diskStorage = (cache as unknown as {
            _diskStorage: {
                saveConnection: (
                    metadataCache: MetadataCache,
                    connectionName: string,
                    prefetchCompletedAt: number,
                    options?: { isComplete?: boolean },
                ) => Promise<void>;
            };
        })._diskStorage;
        const diskSaveStart = performance.now();
        await diskStorage.saveConnection(cache, CONN_NAME, Date.now(), { isComplete: true });
        const diskSaveMs = Math.round(performance.now() - diskSaveStart);

        const restarted = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            connectionManager,
        );
        const initStart = performance.now();
        await restarted.initialize();
        const manifestInitMs = Math.round(performance.now() - initStart);
        const hydrateStart = performance.now();
        await restarted.whenConnectionMetadataHydrated(CONN_NAME);
        const fullHydrateMs = Math.round(performance.now() - hydrateStart);
        await restarted.whenEagerPreloadComplete();

        const report: BenchmarkReport = {
            date: new Date().toISOString(),
            node: process.version,
            databases,
            prefetchMs,
            diskSaveMs,
            manifestInitMs,
            fullHydrateMs,
            cacheBytes: directoryBytes(tempDir),
            ...countCacheLayers(cache),
            rssBefore,
            rssAfterPrefetch,
            rssAfterHydrate: process.memoryUsage().rss,
            queryTimings,
        };

        fs.writeFileSync(RESULTS_PATH, renderReport(report), 'utf8');
        expect(report.tableLayers).toBeGreaterThan(0);
        expect(report.columnLayers).toBeGreaterThan(0);
        await restarted.dispose();
        await cache.dispose();
    }, 900_000);
});
