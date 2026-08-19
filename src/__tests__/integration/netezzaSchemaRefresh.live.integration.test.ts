/**
 * Read-only live integration tests for the complete Netezza metadata refresh.
 *
 * The suite intentionally uses an existing database. It never creates,
 * changes, or drops a database object; the only state it mutates is the local
 * in-memory metadata cache used by the test.
 *
 * Required:
 *   NZ_DEV_PASSWORD
 *
 * Optional:
 *   NZ_DEV_HOST, NZ_DEV_PORT, NZ_DEV_DATABASE, NZ_DEV_USER
 *   NZ_DEV_PREFETCH_DB              - regular database used by the focused tests
 *   NZ_DEV_PREFETCH_EXTERNAL_DB     - database which must contain an external table
 *   NZ_DEV_PREFETCH_FULL_REFRESH=1  - opt-in refresh of every database returned by _V_DATABASE
 *   NZ_DEV_PREFETCH_SESSION_WAIT_MS - _V_SESSION cleanup wait, default 5000
 *
 * Run:
 *   NZ_DEV_PASSWORD=... NZ_DEV_PREFETCH_DB=... \
 *     npm run test:netezza:metadata:integration
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { NzConnection } from '@justybase/netezza-driver';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../../core/connectionManager';
import {
    runQueryRaw,
    type MetadataQuerySession,
    type QueryResult,
    type RunQueryRawOptions,
} from '../../core/queryRunner';
import { ensureBuiltInDialectsRegistered } from '../../dialects';
import { NZ_QUERIES } from '../../dialects/netezza/metadata/systemQueries';
import { MetadataCache } from '../../metadata/cache/MetadataCache';
import { createConnectionScopedMetadataQueryRunner } from '../../metadata/connectionScopedMetadataQueryRunner';
import {
    buildColumnCacheKey,
    groupColumnRowsByTableKey,
    type RawColumnRowWithKeys,
} from '../../metadata/columnRowMapping';
import type {
    MetadataQueryKind,
} from '../../metadata/metadataQueryDiagnostics';
import type {
    DisposableQueryRunnerRawFn,
    MetadataPrefetchRefreshDetails,
} from '../../metadata/prefetch';
import type { ColumnMetadata } from '../../metadata/types';
import { Logger } from '../../utils/logger';
import type { ConnectionDetails } from '../../types';

const skipLive = !process.env.NZ_DEV_PASSWORD;
const describeIfLive = skipLive ? describe.skip : describe;
const itIfLive = skipLive ? it.skip : it;
const itIfExternal = skipLive || !process.env.NZ_DEV_PREFETCH_EXTERNAL_DB
    ? it.skip
    : it;
const itIfFullRefresh = skipLive || process.env.NZ_DEV_PREFETCH_FULL_REFRESH !== '1'
    ? it.skip
    : it;

const DB_CONFIG = {
    host: process.env.NZ_DEV_HOST || 'localhost',
    port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
    database: process.env.NZ_DEV_DATABASE || 'JUST_DATA',
    user: process.env.NZ_DEV_USER || 'admin',
    password: process.env.NZ_DEV_PASSWORD || '',
};

const CONNECTION_NAME = 'LIVE_NZ_SCHEMA_REFRESH';
const QUERY_TIMEOUT_SECONDS = 180;
const TEST_TIMEOUT_MS = Number(process.env.NZ_DEV_PREFETCH_TEST_TIMEOUT_MS || '600000');
const SESSION_WAIT_MS = Number(process.env.NZ_DEV_PREFETCH_SESSION_WAIT_MS || '5000');

type Row = Record<string, unknown>;

interface CatalogSnapshot {
    schemas: Row[];
    typeGroups: Row[];
    objects: Row[];
    externalObjects: Row[];
    procedures: Row[];
    columns: RawColumnRowWithKeys[];
    externalColumns: RawColumnRowWithKeys[];
}

interface CatalogCall {
    kind: MetadataQueryKind | undefined;
    database: string | undefined;
    sql: string;
}

interface RefreshTrace {
    catalogCalls: CatalogCall[];
    activeQueries: number;
    maxActiveQueries: number;
    connectionRefs: Set<object>;
    metadataSessions: Set<MetadataQuerySession>;
    sessionIds: Set<string>;
    injectedFailureKind?: MetadataQueryKind;
    failureCount: number;
}

let monitorConnection: NzConnection | undefined;
let monitorSessionId: string | undefined;
let connectionManager: ConnectionManager;
let targetDatabase: string;
let externalDatabase: string | undefined;

function text(value: unknown): string {
    return value === undefined || value === null ? '' : String(value);
}

function openLiveConnection(database: string): NzConnection {
    return new NzConnection({
        host: DB_CONFIG.host,
        port: DB_CONFIG.port,
        database,
        user: DB_CONFIG.user,
        password: DB_CONFIG.password,
    });
}

async function queryRows<T extends Row>(
    connection: NzConnection,
    sql: string,
): Promise<T[]> {
    const command = connection.createCommand(sql);
    command.commandTimeout = QUERY_TIMEOUT_SECONDS;
    const reader = await command.executeReader();
    const rows: Row[] = [];
    try {
        const fieldCount = reader.fieldCount;
        while (await reader.read()) {
            const row: Row = {};
            for (let index = 0; index < fieldCount; index += 1) {
                row[reader.getName(index) ?? `COL_${index}`] = reader.getValue(index);
            }
            rows.push(row);
        }
    } finally {
        await reader.close();
    }
    return rows as T[];
}

async function currentSessionId(connection: NzConnection): Promise<string> {
    const rows = await queryRows(connection, 'SELECT CURRENT_SID');
    const value = rows[0] ? Object.values(rows[0])[0] : undefined;
    const id = text(value);
    if (!id) {
        throw new Error('Netezza returned no CURRENT_SID');
    }
    return id;
}

function createLiveConnectionManager(): ConnectionManager {
    const details: ConnectionDetails = {
        name: CONNECTION_NAME,
        host: DB_CONFIG.host,
        port: DB_CONFIG.port,
        database: DB_CONFIG.database,
        user: DB_CONFIG.user,
        password: DB_CONFIG.password,
        dbType: 'netezza',
    };

    return {
        getConnection: async (name: string) => name === CONNECTION_NAME ? details : undefined,
        getConnectionMetadata: (name: string) => name === CONNECTION_NAME ? details : undefined,
        getConnectionDatabaseKind: (name: string) => name === CONNECTION_NAME ? 'netezza' : undefined,
        getConnectionNames: () => [CONNECTION_NAME],
        ensureFullyLoaded: async () => undefined,
    } as unknown as ConnectionManager;
}

async function readCatalogSnapshot(
    connection: NzConnection,
    database: string,
): Promise<CatalogSnapshot> {
    return {
        schemas: await queryRows(connection, NZ_QUERIES.listSchemas(database)),
        typeGroups: await queryRows(connection, NZ_QUERIES.listTypeGroups(database)),
        objects: await queryRows(connection, NZ_QUERIES.listTablesAndViews([database])),
        externalObjects: await queryRows(connection, NZ_QUERIES.listExternalTables([database])),
        procedures: await queryRows(connection, NZ_QUERIES.listProcedures(database)),
        columns: await queryRows<RawColumnRowWithKeys>(
            connection,
            NZ_QUERIES.listColumnsWithKeys(database),
        ),
        externalColumns: await queryRows<RawColumnRowWithKeys>(
            connection,
            NZ_QUERIES.listExternalColumnsWithKeys(database),
        ),
    };
}

async function chooseRegularDatabase(connection: NzConnection): Promise<string> {
    const availableRows = await queryRows(connection, NZ_QUERIES.LIST_DATABASES);
    const available = availableRows
        .map(row => text(row.DATABASE))
        .filter(database => database.length > 0)
        .filter(database => !['SYSTEM', 'MASTER_DB'].includes(database.toUpperCase()));

    const requested = process.env.NZ_DEV_PREFETCH_DB?.trim();
    if (requested) {
        const resolved = available.find(database => database === requested)
            ?? available.find(database => database.toUpperCase() === requested.toUpperCase())
            ?? requested;
        const rows = await queryRows(connection, NZ_QUERIES.listTablesAndViews([resolved]));
        if (rows.length === 0) {
            throw new Error(
                `NZ_DEV_PREFETCH_DB='${requested}' has no regular TABLE/VIEW rows; `
                + 'choose a database with at least one table or view',
            );
        }
        return resolved;
    }

    for (const database of available) {
        const rows = await queryRows(connection, NZ_QUERIES.listTablesAndViews([database]));
        if (rows.length > 0) {
            return database;
        }
    }

    throw new Error(
        'No non-system Netezza database with a regular TABLE/VIEW was found; '
        + 'set NZ_DEV_PREFETCH_DB explicitly',
    );
}

async function resolveExternalDatabase(connection: NzConnection): Promise<string | undefined> {
    const requested = process.env.NZ_DEV_PREFETCH_EXTERNAL_DB?.trim();
    if (!requested) {
        return undefined;
    }

    const rows = await queryRows(connection, NZ_QUERIES.listExternalTables([requested]));
    if (rows.length === 0) {
        throw new Error(
            `NZ_DEV_PREFETCH_EXTERNAL_DB='${requested}' has no EXTERNAL TABLE rows; `
            + 'the external-branch test requires a real external table',
        );
    }
    return requested;
}

function createRefreshTrace(injectedFailureKind?: MetadataQueryKind): RefreshTrace {
    return {
        catalogCalls: [],
        activeQueries: 0,
        maxActiveQueries: 0,
        connectionRefs: new Set<object>(),
        metadataSessions: new Set<MetadataQuerySession>(),
        sessionIds: new Set<string>(),
        injectedFailureKind,
        failureCount: 0,
    };
}

function createRefreshRunner(trace: RefreshTrace): DisposableQueryRunnerRawFn {
    return createConnectionScopedMetadataQueryRunner({
        context: {} as vscode.ExtensionContext,
        connectionManager,
        connectionName: CONNECTION_NAME,
        maxRows: 1_000_000,
        timeoutSeconds: QUERY_TIMEOUT_SECONDS,
        queryExecutor: async (options: RunQueryRawOptions): Promise<QueryResult> => {
            if (options.connectionOverride) {
                trace.connectionRefs.add(options.connectionOverride);
            }
            if (options.metadataSession) {
                trace.metadataSessions.add(options.metadataSession);
                if (options.metadataSession.sessionId) {
                    trace.sessionIds.add(options.metadataSession.sessionId);
                }
            }

            const context = options.metadataContext;
            if (context?.source === 'connection-prefetch') {
                trace.catalogCalls.push({
                    kind: context.kind,
                    database: context.database,
                    sql: options.query,
                });
            }

            trace.activeQueries += 1;
            trace.maxActiveQueries = Math.max(trace.maxActiveQueries, trace.activeQueries);
            try {
                if (
                    trace.injectedFailureKind !== undefined
                    && context?.kind === trace.injectedFailureKind
                    && trace.failureCount === 0
                ) {
                    trace.failureCount += 1;
                    throw new Error(`Injected live refresh failure for ${trace.injectedFailureKind}`);
                }

                const result = await runQueryRaw(options);
                if (options.metadataSession?.sessionId) {
                    trace.sessionIds.add(options.metadataSession.sessionId);
                }
                return result;
            } finally {
                trace.activeQueries -= 1;
            }
        },
    });
}

async function waitForTerminalRefresh(
    cache: MetadataCache,
    runner: DisposableQueryRunnerRawFn,
): Promise<MetadataPrefetchRefreshDetails> {
    return new Promise<MetadataPrefetchRefreshDetails>((resolve, reject) => {
        let settled = false;
        const subscription = cache.onDidPrefetchRefreshDetails(details => {
            if (
                details.completedAt === undefined
                || (details.stage !== 'complete' && details.stage !== 'error')
            ) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            subscription.dispose();
            resolve(details);
        });
        const timeout = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            subscription.dispose();
            reject(new Error(`Timed out waiting for Netezza metadata refresh after ${TEST_TIMEOUT_MS}ms`));
        }, TEST_TIMEOUT_MS);

        try {
            cache.triggerConnectionPrefetch(CONNECTION_NAME, runner);
        } catch (error: unknown) {
            clearTimeout(timeout);
            subscription.dispose();
            reject(error);
        }
    });
}

async function runPublicRefresh(
    cache: MetadataCache,
    runner: DisposableQueryRunnerRawFn,
): Promise<MetadataPrefetchRefreshDetails> {
    try {
        return await waitForTerminalRefresh(cache, runner);
    } finally {
        await runner.dispose?.();
    }
}

async function runPrivateRefresh(
    cache: MetadataCache,
    runner: DisposableQueryRunnerRawFn,
): Promise<void> {
    const prefetcher = (cache as unknown as {
        prefetcher: {
            runConnectionPrefetch(
                connectionName: string,
                runQueryFn: DisposableQueryRunnerRawFn,
            ): Promise<void>;
        };
    }).prefetcher;

    try {
        await prefetcher.runConnectionPrefetch(CONNECTION_NAME, runner);
    } finally {
        await runner.dispose?.();
    }
}

function createCache(database?: string): MetadataCache {
    const cache = new MetadataCache({} as vscode.ExtensionContext, connectionManager);
    if (database) {
        cache.setDatabases(CONNECTION_NAME, [
            {
                DATABASE: database,
                label: database,
                kind: 9,
                detail: 'Live Netezza database',
            },
        ]);
    }
    return cache;
}

function canonicalObject(row: Row, schemaFallback?: string): string {
    return [
        text(row.DBNAME),
        text(row.SCHEMA) || schemaFallback || '',
        text(row.OBJNAME),
        text(row.OBJID),
        text(row.OBJTYPE ?? row.objType ?? row.TYPE).trim().toUpperCase(),
    ].join('\u001f');
}

function canonicalProcedure(row: Row): string {
    return [
        text(row.SCHEMA).trim(),
        text(row.PROCEDURE).trim(),
        text(row.PROCEDURESIGNATURE).trim(),
    ].join('\u001f');
}

function canonicalColumn(column: ColumnMetadata): string {
    return [
        text(column.ATTNAME),
        text(column.FORMAT_TYPE),
        String(column.isPk === true),
        String(column.isFk === true),
        String(column.isDistributionKey === true),
    ].join('\u001f');
}

function sorted(values: readonly string[]): string[] {
    return [...values].sort();
}

function assertCatalogRowsCached(
    cache: MetadataCache,
    database: string,
    snapshot: CatalogSnapshot,
): void {
    const cachedSchemas = cache.getSchemas(CONNECTION_NAME, database) ?? [];
    expect(sorted(cachedSchemas.map(row => text(row.SCHEMA)))).toEqual(
        sorted(snapshot.schemas.map(row => text(row.SCHEMA))),
    );

    const cachedTypeGroups = cache.getTypeGroups(CONNECTION_NAME, database) ?? [];
    expect(new Set(cachedTypeGroups).size).toBe(cachedTypeGroups.length);
    expect(cachedTypeGroups).toEqual(expect.arrayContaining(
        snapshot.typeGroups.map(row => text(row.OBJTYPE).trim()).filter(Boolean),
    ));

    const expectedObjects = [...snapshot.objects, ...snapshot.externalObjects]
        .map(row => canonicalObject(row));
    const cachedObjects = cache.getObjectsWithSchema(CONNECTION_NAME, database)
        .map(({ item, schema }) => canonicalObject(item, schema));
    expect(cachedObjects.length).toBe(new Set(cachedObjects).size);
    expect(sorted(cachedObjects)).toEqual(sorted(expectedObjects));

    const expectedProcedures = snapshot.procedures
        .filter(row => text(row.PROCEDURE).trim().length > 0)
        .map(canonicalProcedure);
    const cachedProcedures = cache.getProceduresForDatabase(CONNECTION_NAME, database) ?? [];
    expect(sorted(cachedProcedures.map(canonicalProcedure))).toEqual(sorted(expectedProcedures));

    const expectedColumnGroups = groupColumnRowsByTableKey(
        [...snapshot.columns, ...snapshot.externalColumns],
        undefined,
        { preserveCase: true, exactNetezza: true },
    );
    for (const [key, expectedColumns] of expectedColumnGroups) {
        const cachedColumns = cache.getColumns(CONNECTION_NAME, key);
        expect(cachedColumns).toBeDefined();
        expect(sorted(cachedColumns!.map(canonicalColumn))).toEqual(
            sorted(expectedColumns.map(canonicalColumn)),
        );
    }

    for (const row of [...snapshot.objects, ...snapshot.externalObjects]) {
        const objectType = text(row.OBJTYPE).trim().toUpperCase();
        if (!['TABLE', 'VIEW', 'EXTERNAL TABLE'].includes(objectType)) {
            continue;
        }
        const schema = text(row.SCHEMA);
        const key = buildColumnCacheKey(
            text(row.DBNAME) || database,
            schema || undefined,
            text(row.OBJNAME),
            { preserveCase: true, exactNetezza: true },
        );
        expect(cache.getColumns(CONNECTION_NAME, key)).toBeDefined();
    }
}

function assertTargetRefreshDetails(
    details: MetadataPrefetchRefreshDetails,
    database: string,
    hasExternalObjects: boolean,
): void {
    expect(details.stage).toBe('complete');
    expect(details.completedAt).toBeDefined();
    expect(details.snapshot).toEqual(expect.objectContaining({
        complete: true,
        missingStages: [],
        missingColumnCount: 0,
    }));

    const queries = details.queries.filter(query => query.context.database === database);
    const requiredKinds: MetadataQueryKind[] = [
        'schemas',
        'type-groups',
        'objects',
        'external-objects',
        'procedures',
        'columns',
    ];
    for (const kind of requiredKinds) {
        expect(queries.filter(query => query.context.kind === kind && query.state === 'completed')).toHaveLength(1);
    }

    const externalObjects = queries.filter(query => query.context.kind === 'external-objects');
    expect(externalObjects).toHaveLength(1);
    expect(externalObjects[0]?.state).toBe('completed');

    const externalColumns = queries.filter(query => query.context.kind === 'external-columns');
    expect(externalColumns).toHaveLength(1);
    if (hasExternalObjects) {
        expect(externalColumns[0]?.state).toBe('completed');
    } else {
        expect(externalColumns[0]?.state).toBe('skipped');
    }
}

async function currentSessionRows(connection: NzConnection): Promise<Set<string>> {
    const rows = await queryRows(connection, 'SELECT * FROM _V_SESSION');
    const ids = new Set<string>();
    for (const row of rows) {
        const id = text(row.ID ?? row.SESSIONID);
        if (id) {
            ids.add(id);
        }
    }
    return ids;
}

async function waitForSessionIdsToDisappear(ids: ReadonlySet<string>): Promise<Set<string>> {
    if (ids.size === 0 || !monitorConnection) {
        return new Set();
    }

    const deadline = Date.now() + SESSION_WAIT_MS;
    while (true) {
        const liveIds = await currentSessionRows(monitorConnection);
        const remaining = new Set([...ids].filter(id => liveIds.has(id)));
        if (remaining.size === 0 || Date.now() >= deadline) {
            return remaining;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

function seedDatabase(cache: MetadataCache, database: string): void {
    cache.setDatabases(CONNECTION_NAME, [
        { DATABASE: database, label: database, kind: 9, detail: 'Live Netezza database' },
    ]);
}

describeIfLive('Netezza schema refresh - live read-only integration', () => {
    beforeAll(async () => {
        ensureBuiltInDialectsRegistered();
        Logger.initialize({
            appendLine: () => undefined,
            show: () => undefined,
            dispose: () => undefined,
        } as unknown as vscode.OutputChannel);

        connectionManager = createLiveConnectionManager();
        monitorConnection = openLiveConnection(DB_CONFIG.database);
        await monitorConnection.connect();
        monitorSessionId = await currentSessionId(monitorConnection);
        targetDatabase = await chooseRegularDatabase(monitorConnection);
        externalDatabase = await resolveExternalDatabase(monitorConnection);
    }, TEST_TIMEOUT_MS);

    afterAll(async () => {
        await monitorConnection?.close();
        monitorConnection = undefined;
        Logger.tryGetInstance()?.dispose();
    });

    itIfLive(
        'refreshes a real database into a complete cache without duplicate catalog work',
        async () => {
            const cache = createCache(targetDatabase);
            const trace = createRefreshTrace();
            const snapshot = await readCatalogSnapshot(monitorConnection!, targetDatabase);
            const runner = createRefreshRunner(trace);
            try {
                const details = await runPublicRefresh(cache, runner);

                assertTargetRefreshDetails(details, targetDatabase, snapshot.externalObjects.length > 0);
                assertCatalogRowsCached(cache, targetDatabase, snapshot);
                expect(cache.isConnectionPrefetchFresh(CONNECTION_NAME)).toBe(true);
                expect(trace.catalogCalls).toHaveLength(6 + (snapshot.externalObjects.length > 0 ? 1 : 0));
                expect(trace.maxActiveQueries).toBe(1);
                expect(trace.connectionRefs.size).toBe(1);
                expect(trace.metadataSessions.size).toBe(1);
                expect(trace.sessionIds.size).toBe(1);
                expect(monitorSessionId).toBeDefined();

                const remaining = await waitForSessionIdsToDisappear(trace.sessionIds);
                expect(remaining).toEqual(new Set());
            } finally {
                await cache.dispose();
            }
        },
        TEST_TIMEOUT_MS,
    );

    itIfLive(
        'does not repeat fresh work, but repeats it after local cache invalidation',
        async () => {
            const cache = createCache(targetDatabase);
            try {
                const firstTrace = createRefreshTrace();
                await runPublicRefresh(cache, createRefreshRunner(firstTrace));
                expect(cache.isConnectionPrefetchFresh(CONNECTION_NAME)).toBe(true);

                const skippedTrace = createRefreshTrace();
                await runPrivateRefresh(cache, createRefreshRunner(skippedTrace));
                expect(skippedTrace.catalogCalls).toEqual([]);

                cache.clearConnectionMetadata(CONNECTION_NAME);
                seedDatabase(cache, targetDatabase);
                const repeatedTrace = createRefreshTrace();
                const repeatedDetails = await runPublicRefresh(cache, createRefreshRunner(repeatedTrace));
                expect(repeatedDetails.stage).toBe('complete');
                expect(repeatedTrace.catalogCalls.length).toBeGreaterThanOrEqual(6);
                expect(cache.isConnectionPrefetchFresh(CONNECTION_NAME)).toBe(true);
            } finally {
                await cache.dispose();
            }
        },
        TEST_TIMEOUT_MS,
    );

    itIfLive(
        'retries a failed object catalog query and advances freshness only after recovery',
        async () => {
            const cache = createCache(targetDatabase);
            try {
                const failedTrace = createRefreshTrace('objects');
                const failedDetails = await runPublicRefresh(cache, createRefreshRunner(failedTrace));
                expect(failedTrace.failureCount).toBe(1);
                expect(failedDetails.stage).toBe('error');
                expect(failedDetails.snapshot?.complete).toBe(false);
                expect(cache.isConnectionPrefetchFresh(CONNECTION_NAME)).toBe(false);

                const retryTrace = createRefreshTrace();
                const retryDetails = await runPublicRefresh(cache, createRefreshRunner(retryTrace));
                expect(retryDetails.stage).toBe('complete');
                expect(cache.isConnectionPrefetchFresh(CONNECTION_NAME)).toBe(true);
                expect(retryTrace.catalogCalls.some(call => call.kind === 'objects')).toBe(true);
            } finally {
                await cache.dispose();
            }
        },
        TEST_TIMEOUT_MS,
    );

    itIfLive(
        'does not skip a fresh-timestamp cache when a column layer is missing',
        async () => {
            const cache = createCache(targetDatabase);
            try {
                const firstTrace = createRefreshTrace();
                await runPublicRefresh(cache, createRefreshRunner(firstTrace));

                const snapshot = await readCatalogSnapshot(monitorConnection!, targetDatabase);
                const columnGroups = groupColumnRowsByTableKey(
                    [...snapshot.columns, ...snapshot.externalColumns],
                    undefined,
                    { preserveCase: true, exactNetezza: true },
                );
                const missingKey = columnGroups.keys().next().value as string | undefined;
                if (!missingKey) {
                    throw new Error(`Database '${targetDatabase}' has no column layer to invalidate`);
                }

                cache.columnCache.delete(`${CONNECTION_NAME}|${missingKey}`);
                expect(cache.isConnectionPrefetchFresh(CONNECTION_NAME)).toBe(false);

                const repairTrace = createRefreshTrace();
                await runPrivateRefresh(cache, createRefreshRunner(repairTrace));
                expect(repairTrace.catalogCalls.some(call => call.kind === 'columns')).toBe(true);
                expect(cache.isConnectionPrefetchFresh(CONNECTION_NAME)).toBe(true);
            } finally {
                await cache.dispose();
            }
        },
        TEST_TIMEOUT_MS,
    );

    itIfExternal(
        'keeps regular columns when the external-column branch fails once and then retries it',
        async () => {
            if (!externalDatabase) {
                throw new Error('External database was not resolved despite NZ_DEV_PREFETCH_EXTERNAL_DB');
            }

            const cache = createCache(externalDatabase);
            try {
                const failedTrace = createRefreshTrace('external-columns');
                const failedDetails = await runPublicRefresh(cache, createRefreshRunner(failedTrace));
                expect(failedTrace.failureCount).toBe(1);
                expect(failedDetails.stage).toBe('error');
                expect(failedDetails.snapshot?.complete).toBe(false);

                const retryTrace = createRefreshTrace();
                const retryDetails = await runPublicRefresh(cache, createRefreshRunner(retryTrace));
                expect(retryDetails.stage).toBe('complete');
                expect(retryTrace.catalogCalls.some(call => call.kind === 'external-columns')).toBe(true);
                expect(cache.isConnectionPrefetchFresh(CONNECTION_NAME)).toBe(true);
            } finally {
                await cache.dispose();
            }
        },
        TEST_TIMEOUT_MS,
    );

    itIfFullRefresh(
        'uses the expected query budget for an opt-in full-connection refresh',
        async () => {
            const cache = createCache();
            const trace = createRefreshTrace();
            try {
                const details = await runPublicRefresh(cache, createRefreshRunner(trace));
                const databases = cache.getDatabases(CONNECTION_NAME) ?? [];
                const databaseCount = databases.length;
                const externalDatabaseCount = details.queries.filter(query =>
                    query.context.kind === 'external-objects'
                    && query.state === 'completed'
                    && (query.rowsRead ?? 0) > 0,
                ).length;

                expect(databaseCount).toBeGreaterThan(0);
                expect(details.stage).toBe('complete');
                expect(details.snapshot?.complete).toBe(true);
                expect(details.queries.filter(query =>
                    query.context.kind === 'databases' && query.state === 'completed',
                )).toHaveLength(1);
                expect(trace.catalogCalls).toHaveLength(1 + (6 * databaseCount) + externalDatabaseCount);
                expect(trace.maxActiveQueries).toBe(1);
                expect(trace.connectionRefs.size).toBe(1);
                expect(trace.metadataSessions.size).toBe(1);
            } finally {
                await cache.dispose();
            }
        },
        TEST_TIMEOUT_MS,
    );
});
