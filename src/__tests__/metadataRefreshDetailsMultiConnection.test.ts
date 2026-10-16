/**
 * Experiments for the Schema Refresh Details panel with two distinct Netezza
 * connections in the schema tree (different `connectionName` values).
 *
 * The reported bug: with two Netezza connections, the details panel always
 * shows only the first one. These tests pin down the three layers that have to
 * agree for a second connection to appear:
 *
 *   1. CachePrefetcher keeps one refresh record per connection.
 *   2. The coordinator accumulates records across connections and publishes a
 *      record even for a connection whose full prefetch never ran (fresh
 *      cache), otherwise that connection has no card at all.
 *   3. The webview merges and renders one card per connection, and lets the
 *      user narrow the view to a single connection.
 */
import * as vscode from 'vscode';
import { createContext, Script } from 'node:vm';
import { CachePrefetcher } from '../metadata/prefetch';
import type { MetadataPrefetchRefreshDetails } from '../metadata/prefetch';
import type { MetadataPrefetchTarget } from '../metadata/cache/MetadataPrefetchTarget';
import type { PrefetchLease } from '../metadata/diskStorage/metadataDiskStorage';
import type { QueryRunnerRawFn } from '../metadata/prefetch';
import { MetadataRefreshDetailsPanel, getMetadataRefreshDetailsHtml } from '../services/metadataRefreshDetailsPanel';
import { MetadataPrefetchCoordinator } from '../activation/MetadataPrefetchCoordinator';
import type { ExtensionServices } from '../activation/extensionServices';
import type { Logger } from '../utils/logger';

jest.mock('vscode');
jest.mock('../metadata/connectionScopedMetadataQueryRunner', () => ({
    createConnectionScopedMetadataQueryRunner: jest.fn(() => jest.fn(async () => undefined)),
}));

jest.mock('../utils/logger', () => ({
    Logger: {
        getInstance: jest.fn().mockReturnValue({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        }),
    },
}));

const CONN_A = 'NZ_PROD';
const CONN_B = 'NZ_DEV';

function createRefresh(
    connectionName: string,
    overrides: Partial<MetadataPrefetchRefreshDetails> = {},
): MetadataPrefetchRefreshDetails {
    return {
        connectionName,
        refreshId: `${connectionName}:1:1`,
        stage: 'columns',
        percent: 80,
        message: 'Fetching columns',
        startedAt: 1_000,
        updatedAt: 2_000,
        revision: 1,
        longestSqlDurationMs: 0,
        queries: [],
        ...overrides,
    };
}

/** Minimal vm harness that runs the real panel script with a fake DOM. */
function runPanelScript() {
    const elements = new Map<string, { value: string; innerHTML: string; addEventListener: jest.Mock }>();
    const makeElement = (value = '') => ({ value, innerHTML: '', addEventListener: jest.fn() });
    elements.set('content', makeElement());
    elements.set('status-filter', makeElement('all'));
    elements.set('sort-order', makeElement('duration-desc'));

    let messageListener: ((event: { data?: unknown }) => void) | undefined;
    const postMessage = jest.fn();

    const scriptSource = getMetadataRefreshDetailsHtml().match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
    const context = createContext({
        Date,
        Element: class {},
        acquireVsCodeApi: () => ({ postMessage }),
        document: {
            getElementById: (id: string) => elements.get(id) ?? (() => {
                const created = makeElement();
                elements.set(id, created);
                return created;
            })(),
            addEventListener: jest.fn(),
            body: {},
        },
        navigator: {},
        setInterval: jest.fn(),
        setTimeout: jest.fn(),
        window: {
            addEventListener: (_type: string, listener: (event: { data?: unknown }) => void) => {
                messageListener = listener;
            },
        },
    });
    new Script(scriptSource!).runInContext(context);

    return {
        elements,
        postMessage,
        send: (details: MetadataPrefetchRefreshDetails[]) => {
            messageListener?.({ data: { type: 'refresh-state', details } });
        },
        rendered: () => elements.get('content')!.innerHTML,
        select: (id: string, value: string) => {
            const element = elements.get(id);
            if (element) {
                element.value = value;
                const listeners = element.addEventListener as jest.Mock;
                for (const call of listeners.mock.calls) {
                    if (call[0] === 'change') call[1]();
                }
            }
        },
        options: (id: string): string[] => {
            const element = elements.get(id) as unknown as { innerHTML: string } | undefined;
            if (!element) return [];
            return [...element.innerHTML.matchAll(/<option value="([^"]*)"/g)].map(match => match[1]);
        },
    };
}

function createMockCache(): jest.Mocked<MetadataPrefetchTarget> {
    return {
        tableCache: new Map(),
        schemaCache: new Map(),
        columnCache: new Map(),
        getCacheTTL: jest.fn().mockReturnValue(12 * 60 * 60 * 1000),
        discardExpiredConnectionMetadata: jest.fn().mockResolvedValue(undefined),
        getTables: jest.fn(),
        setTables: jest.fn(),
        getColumns: jest.fn(),
        setColumns: jest.fn(),
        setForeignKeyRelationshipsForDatabase: jest.fn(),
        getColumnsAnySchema: jest.fn(),
        ensureColumnsLoaded: jest.fn().mockResolvedValue(undefined),
        getDatabases: jest.fn(),
        setDatabases: jest.fn(),
        getSchemas: jest.fn(),
        setSchemas: jest.fn(),
        getProcedures: jest.fn(),
        setProcedures: jest.fn(),
        getProceduresAllSchemas: jest.fn(),
        markViewsCatalogLoaded: jest.fn(),
        markPrefetchObjectTypesCatalogLoaded: jest.fn(),
        markProcedureCatalogLoaded: jest.fn(),
        getTypeGroups: jest.fn(),
        hasCachedTypeGroups: jest.fn().mockReturnValue(false),
        setTypeGroups: jest.fn(),
        tryAcquirePrefetchLock: jest.fn().mockResolvedValue({ connectionName: CONN_A, generation: 0, fence: 0 } satisfies PrefetchLease),
        releasePrefetchLock: jest.fn().mockResolvedValue(undefined),
        saveConnectionToDiskAfterPrefetch: jest.fn().mockResolvedValue(undefined),
        checkpointSave: jest.fn().mockResolvedValue(undefined),
        verifyStagesComplete: jest.fn().mockReturnValue(true),
        whenDiskReady: jest.fn().mockResolvedValue(undefined),
        hasTableCacheForConnection: jest.fn().mockReturnValue(false),
        isConnectionMetadataHydrating: jest.fn().mockReturnValue(false),
        isProcedureCatalogLoaded: jest.fn().mockReturnValue(false),
        isDatabaseDead: jest.fn().mockReturnValue(false),
        markDatabaseDead: jest.fn(),
        isDiskPersistenceEnabled: jest.fn().mockReturnValue(false),
    } as unknown as jest.Mocked<MetadataPrefetchTarget>;
}

describe('Schema Refresh Details with two Netezza connections', () => {
    describe('CachePrefetcher (one record per connection)', () => {
        let published: MetadataPrefetchRefreshDetails[];

        beforeEach(() => {
            published = [];
        });

        it('keeps and publishes an independent record for each connection', () => {
            const prefetcher = new CachePrefetcher(createMockCache(), undefined, event => published.push(event));

            prefetcher['beginRefreshDetails'](CONN_A);
            prefetcher['beginRefreshDetails'](CONN_B);

            expect([...prefetcher['refreshDetailsByConnection'].keys()]).toEqual([CONN_A, CONN_B]);
            expect(new Set(published.map(entry => entry.connectionName))).toEqual(new Set([CONN_A, CONN_B]));
        });

        it('still publishes a record when the full prefetch is skipped as fresh', async () => {
            const prefetcher = new CachePrefetcher(createMockCache(), undefined, event => published.push(event));
            const cache = prefetcher['cache'] as jest.Mocked<MetadataPrefetchTarget>;

            // Fresh timestamp + complete snapshot => createMetadataPrefetchPlan skips.
            prefetcher['connectionPrefetchTriggered'].set(CONN_B, Date.now());
            cache.hasTableCacheForConnection.mockReturnValue(true);

            await prefetcher['runConnectionPrefetch'](
                CONN_B,
                jest.fn() as unknown as QueryRunnerRawFn,
                undefined,
            );

            const record = prefetcher['refreshDetailsByConnection'].get(CONN_B);
            expect(published.map(entry => entry.connectionName)).toContain(CONN_B);
            expect(record?.skipReason).toBe('fresh');
            // No refresh ran, so nothing downstream may treat this as a
            // completed refresh (database analysis invalidates on completedAt).
            expect(record?.completedAt).toBeUndefined();
            expect(record?.queries.size).toBe(0);
        });

        it('does not replace a real refresh record with a skip record', async () => {
            const prefetcher = new CachePrefetcher(createMockCache(), undefined, event => published.push(event));
            const cache = prefetcher['cache'] as jest.Mocked<MetadataPrefetchTarget>;

            const real = prefetcher['beginRefreshDetails'](CONN_B);
            real.queries.set('q1', {
                id: 'q1',
                state: 'completed',
                sql: 'SELECT * FROM JUST_DATA.._V_OBJECT_DATA',
                context: { connectionName: CONN_B, source: 'connection-prefetch', kind: 'objects' },
                queuedAt: 1,
            });
            prefetcher['finalizeRefreshDetails'](CONN_B);
            published.length = 0;

            prefetcher['connectionPrefetchTriggered'].set(CONN_B, Date.now());
            cache.hasTableCacheForConnection.mockReturnValue(true);
            await prefetcher['runConnectionPrefetch'](CONN_B, jest.fn() as unknown as QueryRunnerRawFn, undefined);

            const retained = prefetcher['refreshDetailsByConnection'].get(CONN_B)!;
            expect(retained.queries.size).toBe(1);
            expect(retained.skipReason).toBeUndefined();
        });
    });

    describe('MetadataPrefetchCoordinator (accumulates across connections)', () => {
        function createCoordinator(isFresh: boolean) {
            const listeners: Array<(details: MetadataPrefetchRefreshDetails) => void> = [];
            const metadataCache = {
                whenDiskReady: jest.fn(async () => undefined),
                isConnectionPrefetchFresh: jest.fn(() => isFresh),
                refreshIncompleteForeignKeyRelationships: jest.fn(async () => undefined),
                triggerConnectionPrefetch: jest.fn(),
                // Mirrors the real MetadataCache: the prefetcher publishes the
                // skip record through the very same details event.
                recordConnectionPrefetchSkipped: jest.fn((connectionName: string, reason: string) => {
                    for (const listener of listeners) {
                        listener(createRefresh(connectionName, {
                            stage: 'complete',
                            percent: 100,
                            message: 'Metadata is up to date.',
                            startedAt: 5_000,
                            updatedAt: 5_000,
                            skipReason: reason as MetadataPrefetchRefreshDetails['skipReason'],
                        }));
                    }
                }),
                getCurrentSchema: jest.fn(() => 'PUBLIC'),
                invalidateCurrentSchema: jest.fn(),
                setCurrentSchema: jest.fn(),
                isConnectionMetadataHydrating: jest.fn(() => false),
                whenConnectionMetadataHydrated: jest.fn(async () => undefined),
                preloadColumnsForConnection: jest.fn(async () => undefined),
                onDidPrefetchProgress: jest.fn(() => ({ dispose: jest.fn() })),
                onDidNeedColumnRecovery: jest.fn(() => ({ dispose: jest.fn() })),
                onDidPrefetchRefreshDetails: jest.fn((listener: (details: MetadataPrefetchRefreshDetails) => void) => {
                    listeners.push(listener);
                    return { dispose: jest.fn() };
                }),
            };
            const connectionManager = {
                getConnectionDatabaseKind: jest.fn(() => 'netezza'),
                getConnectionMetadata: jest.fn(() => ({ database: 'JUST_DATA' })),
                getActiveConnectionName: jest.fn(() => null),
                getConnectionForExecution: jest.fn(() => undefined),
            };
            const logger = {
                debug: jest.fn(),
                warn: jest.fn(),
                info: jest.fn(),
            } as unknown as Logger;
            const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
            const services = {
                metadataCache,
                connectionManager,
                queryExecutor: jest.fn(),
            } as unknown as ExtensionServices;
            const coordinator = new MetadataPrefetchCoordinator(context, services, logger);
            // register() is what subscribes to the details event.
            coordinator.register(context, Promise.resolve());
            return { coordinator, metadataCache, emitRefreshDetails: listeners };
        }

        const flush = () => new Promise<void>(resolve => setImmediate(resolve));
        const lastUpdate = (calls: unknown[][]): unknown =>
            calls.length ? calls[calls.length - 1][0] : undefined;

        it('publishes both connections to the panel', () => {
            const { emitRefreshDetails } = createCoordinator(false);
            const update = jest.spyOn(MetadataRefreshDetailsPanel.prototype, 'update');

            for (const listener of emitRefreshDetails) {
                listener(createRefresh(CONN_A));
                listener(createRefresh(CONN_B));
            }

            const last = lastUpdate(update.mock.calls as unknown[][]) as MetadataPrefetchRefreshDetails[];
            expect(last.map(entry => entry.connectionName)).toEqual([CONN_A, CONN_B]);
            update.mockRestore();
        });

        it('represents a connection whose metadata is already fresh', async () => {
            const { coordinator, metadataCache } = createCoordinator(true);
            const update = jest.spyOn(MetadataRefreshDetailsPanel.prototype, 'update');

            coordinator.triggerForConnection(CONN_B);
            await flush();

            expect(metadataCache.recordConnectionPrefetchSkipped).toHaveBeenCalledWith(CONN_B, 'fresh');
            const last = lastUpdate(update.mock.calls as unknown[][]) as MetadataPrefetchRefreshDetails[] | undefined;
            expect(last?.map(entry => entry.connectionName)).toContain(CONN_B);
            update.mockRestore();
        });

        it('still runs a full prefetch for a stale connection', async () => {
            const { coordinator, metadataCache } = createCoordinator(false);

            coordinator.triggerForConnection(CONN_B);
            await flush();

            expect(metadataCache.triggerConnectionPrefetch).toHaveBeenCalledWith(CONN_B, expect.any(Function));
            expect(metadataCache.recordConnectionPrefetchSkipped).not.toHaveBeenCalled();
        });
    });

    describe('webview (renders and filters per connection)', () => {
        it('renders one card per connection', () => {
            const panel = runPanelScript();
            panel.send([createRefresh(CONN_A), createRefresh(CONN_B)]);

            const rendered = panel.rendered();
            expect(rendered).toContain(CONN_A);
            expect(rendered).toContain(CONN_B);
        });

        it('keeps the second connection when a later update only carries the first', () => {
            const panel = runPanelScript();
            panel.send([createRefresh(CONN_A), createRefresh(CONN_B)]);
            panel.send([createRefresh(CONN_A, { revision: 2 })]);

            const rendered = panel.rendered();
            expect(rendered).toContain(CONN_A);
            expect(rendered).toContain(CONN_B);
        });

        it('offers a connection filter listing every connection with details', () => {
            const panel = runPanelScript();
            panel.send([createRefresh(CONN_A), createRefresh(CONN_B)]);

            const options = panel.options('connection-filter');
            expect(options).toContain('all');
            expect(options).toContain(CONN_A);
            expect(options).toContain(CONN_B);
        });

        it('narrows the view to the selected connection', () => {
            const panel = runPanelScript();
            panel.send([createRefresh(CONN_A), createRefresh(CONN_B)]);

            panel.select('connection-filter', CONN_B);

            const rendered = panel.rendered();
            expect(rendered).toContain(CONN_B);
            expect(rendered).not.toContain(CONN_A);
        });

        it('labels a connection that never ran a full refresh', () => {
            const panel = runPanelScript();
            panel.send([createRefresh(CONN_B, {
                stage: 'complete',
                percent: 100,
                message: 'Metadata is up to date.',
                updatedAt: 3_000,
                skipReason: 'fresh',
            })]);

            const rendered = panel.rendered();
            expect(rendered).toContain('skip-note');
            expect(rendered).toContain('cached metadata is still fresh');
        });
    });
});
