import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as vscode from 'vscode';
import { MetadataCache } from '../metadataCache';
import { CACHE_V3_DIR_NAME, getV3ColumnFilePath, getV3IndexPath } from '../metadata/diskStorage/metadataDiskPaths';
import { encodeColumnLayers } from '../metadata/diskStorage/metadataColumnCodec';
import { Logger } from '../utils/logger';

jest.mock('vscode');

describe('MetadataCache disk persistence integration', () => {
    let tempDir: string;
    let cache: MetadataCache;
    const mockConnectionManager = {
        getConnectionMetadata: () => ({
            host: 'nz.host',
            port: 5480,
            database: 'SYSTEM',
            user: 'admin',
            dbType: 'netezza' as const,
        }),
        getConnectionNames: () => ['NZ'],
        getConnectionDatabaseKind: () => 'netezza' as const,
        ensureFullyLoaded: jest.fn(async () => undefined),
    };

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-cache-int-'));
        const mockOutputChannel = {
            appendLine: jest.fn(),
            show: jest.fn(),
            dispose: jest.fn(),
        } as unknown as vscode.OutputChannel;
        Logger.initialize(mockOutputChannel);

        jest.spyOn(
            require('../compatibility/configuration'),
            'getExtensionConfiguration',
        ).mockReturnValue({
            get: (key: string, defaultValue?: unknown) => {
                if (key === 'metadataCache.diskPersistence') {
                    return true;
                }
                if (key === 'metadataCache.crossWindowSync') {
                    return false;
                }
                return defaultValue;
            },
        });

        cache = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function populateFull(connectionName: string): void {
        cache.setDatabases(connectionName, [{ DATABASE: 'DB1', label: 'DB1', kind: 9 }]);
        cache.setSchemas(connectionName, 'DB1', [{ SCHEMA: 'S1', label: 'S1', kind: 19 }]);
        const idMap = new Map<string, number>();
        idMap.set('DB1.S1.T1', 9);
        cache.setTables(connectionName, 'DB1.S1', [{
            OBJNAME: 'T1', OBJID: 9, SCHEMA: 'S1', label: 'T1', objType: 'TABLE', kind: 6,
        }], idMap);
        cache.setProcedures(connectionName, 'DB1..', [{ PROCEDURE: 'P1', SCHEMA: 'S1', label: 'P1' }]);
        cache.setColumns(connectionName, 'DB1.S1.T1', [{ ATTNAME: 'C1', FORMAT_TYPE: 'INT', label: 'C1' }]);
        cache.setTypeGroups(connectionName, 'DB1', ['TABLE']);
    }

    async function persistFull(connectionName: string): Promise<void> {
        const lease = await cache.tryAcquirePrefetchLock(connectionName);
        expect(lease).toBeDefined();
        try {
            await cache.saveConnectionToDiskAfterPrefetch(connectionName, false, lease!);
        } finally {
            await cache.releasePrefetchLock(lease);
        }
    }

    it('releases locks and local resources when the final disk save fails', async () => {
        const diskStorage = cache['_diskStorage']!;
        const saveError = new Error('disk unavailable');
        jest.spyOn(diskStorage, 'saveAll').mockRejectedValue(saveError);
        const releaseSpy = jest.spyOn(diskStorage.lock, 'releaseAllOwned')
            .mockResolvedValue(undefined);
        const progressDisposeSpy = jest.spyOn(
            cache['_onDidPrefetchProgress'],
            'dispose',
        );
        const warnSpy = jest.spyOn(Logger.getInstance(), 'warn')
            .mockImplementation(() => undefined);

        await expect(cache.dispose()).resolves.toBeUndefined();

        expect(releaseSpy).toHaveBeenCalledTimes(1);
        expect(progressDisposeSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
            '[MetadataCache] Failed to save cache on dispose',
            saveError,
        );
    });

    it('should load from disk on initialize and restore fresh prefetch state', async () => {
        populateFull('NZ');
        cache['prefetcher'].restorePrefetchTimestamps(new Map([['NZ', Date.now()]]));
        await persistFull('NZ');
        await cache.dispose();

        const cache2 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
        await cache2.initialize();
        await cache2.whenConnectionMetadataHydrated('NZ');

        expect(cache2.getDatabases('NZ')).toBeDefined();
        expect(cache2.isConnectionPrefetchFresh('NZ')).toBe(true);
        expect(cache2.hasAllObjectsPrefetchTriggered('NZ')).toBe(true);
        expect(cache2.getColumns('NZ', 'DB1.S1.T1')).toBeUndefined();

        await cache2.ensureColumnsLoaded('NZ', 'DB1');
        expect(cache2.getColumns('NZ', 'DB1.S1.T1')).toEqual([
            expect.objectContaining({ ATTNAME: 'C1', FORMAT_TYPE: 'INT', label: 'C1' }),
        ]);
    });

    it('should resolve initialize after manifest load while full metadata hydrates in background', async () => {
        populateFull('NZ');
        cache['prefetcher'].restorePrefetchTimestamps(new Map([['NZ', Date.now()]]));
        await persistFull('NZ');
        await cache.dispose();

        const cache2 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
        const diskStorage = cache2['_diskStorage']!;
        const originalLoad = diskStorage.loadConnectionMetadataOnly.bind(diskStorage);
        let releaseMetadataLoad: (() => void) | undefined;
        const metadataLoadGate = new Promise<void>((resolve) => {
            releaseMetadataLoad = resolve;
        });
        jest.spyOn(diskStorage, 'loadConnectionMetadataOnly').mockImplementation(
            async (connectionName, indexEntry) => {
                await metadataLoadGate;
                return originalLoad(connectionName, indexEntry);
            },
        );

        await cache2.initialize();

        expect(cache2.getDatabases('NZ')).toEqual([
            { DATABASE: 'DB1', label: 'DB1', kind: 9 },
        ]);
        expect(cache2.getTables('NZ', 'DB1.S1')).toBeUndefined();
        expect(cache2.isConnectionMetadataHydrating('NZ')).toBe(true);
        expect(cache2.isConnectionPrefetchFresh('NZ')).toBe(true);

        releaseMetadataLoad!();
        await cache2.whenConnectionMetadataHydrated('NZ');

        expect(cache2.getTables('NZ', 'DB1.S1')).toEqual([
            expect.objectContaining({ OBJNAME: 'T1' }),
        ]);
        expect(cache2.isConnectionMetadataHydrating('NZ')).toBe(false);
    });

    it('should hydrate partial checkpoints without marking prefetch fresh', async () => {
        populateFull('NZ');
        await cache.checkpointSave('NZ');

        const cache2 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
        await cache2.initialize();
        await cache2.whenConnectionMetadataHydrated('NZ');

        expect(cache2.getDatabases('NZ')).toEqual([
            { DATABASE: 'DB1', label: 'DB1', kind: 9 },
        ]);
        expect(cache2.getTables('NZ', 'DB1.S1')).toEqual([
            expect.objectContaining({ OBJNAME: 'T1' }),
        ]);
        expect(cache2.isConnectionPrefetchFresh('NZ')).toBe(false);
    });

    it('should eagerly preload columns from disk on initialize when diskPersistence is enabled', async () => {
        populateFull('NZ');
        cache['prefetcher'].restorePrefetchTimestamps(new Map([['NZ', Date.now()]]));
        await persistFull('NZ');
        await cache.dispose();

        const cache2 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
        await cache2.initialize();
        await cache2.whenConnectionMetadataHydrated('NZ');

        // Wait for the eager column preload to finish
        await cache2.whenEagerPreloadComplete();

        expect(cache2.getColumns('NZ', 'DB1.S1.T1')).toEqual([
            expect.objectContaining({ ATTNAME: 'C1', FORMAT_TYPE: 'INT', label: 'C1' }),
        ]);
    });

    it('should resolve findObjectWithType after disk hydrate without prefetch', async () => {
        populateFull('NZ');
        cache['prefetcher'].restorePrefetchTimestamps(new Map([['NZ', Date.now()]]));
        await persistFull('NZ');
        await cache.dispose();

        const cache2 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
        await cache2.initialize();
        await cache2.whenConnectionMetadataHydrated('NZ');

        expect(
            cache2.findObjectWithType('NZ', 'DB1', 'S1', 'T1'),
        ).toEqual(expect.objectContaining({
            objId: 9,
            objType: 'TABLE',
            schema: 'S1',
            name: 'T1',
        }));
        expect(
            cache2.findObjectWithType('NZ', 'DB1', undefined, 'T1'),
        ).toEqual(expect.objectContaining({
            objId: 9,
            objType: 'TABLE',
            schema: 'S1',
            name: 'T1',
        }));
    });

    it('should rebuild lookup indexes after onExternalCacheUpdate', async () => {
        populateFull('NZ');
        cache['prefetcher'].restorePrefetchTimestamps(new Map([['NZ', Date.now()]]));
        await persistFull('NZ');
        await cache.dispose();

        const cache2 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );

        await (
            cache2 as unknown as {
                onExternalCacheUpdate: (names: string[]) => Promise<void>;
            }
        ).onExternalCacheUpdate(['NZ']);

        expect(cache2['_diskLifecycleState'].deferredIndexConnections.has('NZ')).toBe(true);
        expect(
            cache2.findObjectWithType('NZ', 'DB1', undefined, 'T1'),
        ).toEqual(expect.objectContaining({
            objId: 9,
            objType: 'TABLE',
            schema: 'S1',
            name: 'T1',
        }));
        expect(cache2['_diskLifecycleState'].deferredIndexConnections.has('NZ')).toBe(false);
    });

    it('should not restore freshness from partial external cache updates', async () => {
        populateFull('NZ');
        await cache.checkpointSave('NZ');

        const cache2 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );

        await (
            cache2 as unknown as {
                onExternalCacheUpdate: (names: string[]) => Promise<void>;
            }
        ).onExternalCacheUpdate(['NZ']);

        expect(cache2.getTables('NZ', 'DB1.S1')).toEqual([
            expect.objectContaining({ OBJNAME: 'T1' }),
        ]);
        expect(cache2.isConnectionPrefetchFresh('NZ')).toBe(false);
    });

    it('should resolve on-disk column files case-insensitively', async () => {
        populateFull('NZ');
        cache['prefetcher'].restorePrefetchTimestamps(new Map([['NZ', Date.now()]]));
        await persistFull('NZ');
        await cache.dispose();

        const cache2 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
        await cache2.initialize();
        await cache2.whenConnectionMetadataHydrated('NZ');

        await cache2.ensureColumnsLoaded('NZ', 'db1');
        expect(cache2.getColumns('NZ', 'DB1.S1.T1')).toEqual([
            expect.objectContaining({ ATTNAME: 'C1', FORMAT_TYPE: 'INT', label: 'C1' }),
        ]);
    });

    it('should clear prefetch freshness when a column file is missing on disk', async () => {
        populateFull('NZ');
        cache['prefetcher'].restorePrefetchTimestamps(new Map([['NZ', Date.now()]]));
        await persistFull('NZ');
        await cache.dispose();

        const columnPath = getV3ColumnFilePath(tempDir, 'NZ', 'DB1');
        fs.unlinkSync(columnPath);

        const cache2 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
        await cache2.initialize();
        await cache2.whenConnectionMetadataHydrated('NZ');

        expect(cache2.isConnectionPrefetchFresh('NZ')).toBe(true);
        expect(cache2.hasColumnsOnDisk('NZ', 'DB1')).toBe(true);

        await cache2.ensureColumnsLoaded('NZ', 'DB1');

        expect(cache2.isConnectionPrefetchFresh('NZ')).toBe(false);
        expect(cache2.hasColumnsOnDisk('NZ', 'DB1')).toBe(false);
        expect(cache2.getColumns('NZ', 'DB1.S1.T1')).toBeUndefined();
    });

    it('should discard in-flight column disk load after clearCache', async () => {
        populateFull('NZ');
        cache['prefetcher'].restorePrefetchTimestamps(new Map([['NZ', Date.now()]]));
        await persistFull('NZ');
        await cache.dispose();

        const cache2 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
        await cache2.initialize();
        await cache2.whenConnectionMetadataHydrated('NZ');

        const diskStorage = cache2['_diskStorage'] as {
            loadColumnFileForDatabase: (
                connectionName: string,
                databaseName: string,
            ) => Promise<unknown>;
        };
        const originalLoad = diskStorage.loadColumnFileForDatabase.bind(diskStorage);
        let releaseLoad: (() => void) | undefined;
        const loadGate = new Promise<void>((resolve) => {
            releaseLoad = resolve;
        });

        jest.spyOn(diskStorage, 'loadColumnFileForDatabase').mockImplementation(
            async (connectionName: string, databaseName: string) => {
                await loadGate;
                return originalLoad(connectionName, databaseName);
            },
        );

        const loadPromise = cache2.ensureColumnsLoaded('NZ', 'DB1');
        await new Promise((resolve) => setTimeout(resolve, 10));
        await cache2.clearCache();
        releaseLoad!();
        await loadPromise;

        expect(cache2.getColumns('NZ', 'DB1.S1.T1')).toBeUndefined();
        expect(cache2.getDatabases('NZ')).toBeUndefined();
    });

    it('should not load when diskPersistence disabled (E11)', async () => {
        jest.spyOn(
            require('../compatibility/configuration'),
            'getExtensionConfiguration',
        ).mockReturnValue({
            get: (key: string, defaultValue?: unknown) => {
                if (key === 'metadataCache.diskPersistence') {
                    return false;
                }
                return defaultValue;
            },
        });

        populateFull('NZ');
        await persistFull('NZ');
        await cache.dispose();

        const cache2 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
        await cache2.initialize();
        expect(cache2.getDatabases('NZ')).toBeUndefined();
    });

    it('should clear memory and disk on clearCache (E12)', async () => {
        populateFull('NZ');
        await persistFull('NZ');
        await cache.dispose();
        expect(fs.existsSync(path.join(tempDir, CACHE_V3_DIR_NAME))).toBe(true);
        expect(fs.existsSync(getV3IndexPath(tempDir))).toBe(true);

        await cache.clearCache();
        expect(cache.getDatabases('NZ')).toBeUndefined();
        const index = await cache['_diskStorage']!.readV3Index();
        expect(fs.existsSync(getV3IndexPath(tempDir))).toBe(true);
        expect(index?.generation).toBeGreaterThan(1);
        expect(index?.connections).toEqual({});
    });

    it('should verify stages complete only when all layers present', () => {
        expect(cache.verifyStagesComplete('NZ')).toBe(false);
        populateFull('NZ');
        expect(cache.verifyStagesComplete('NZ')).toBe(true);
        cache.setDatabases('NZ', []);
        expect(cache.verifyStagesComplete('NZ')).toBe(false);
    });

    it('should verify complete snapshot only when table columns are present', () => {
        cache.setDatabases('NZ', [{ DATABASE: 'DB1', label: 'DB1', kind: 9 }]);
        cache.setSchemas('NZ', 'DB1', [{ SCHEMA: 'S1', label: 'S1', kind: 19 }]);
        cache.setTables('NZ', 'DB1.S1', [{
            OBJNAME: 'T1', OBJID: 9, SCHEMA: 'S1', label: 'T1', objType: 'TABLE', kind: 6,
        }], new Map([['DB1.S1.T1', 9]]));
        cache.setProcedures('NZ', 'DB1..', [{ PROCEDURE: 'P1', SCHEMA: 'S1', label: 'P1' }]);

        expect(cache.verifyStagesComplete('NZ')).toBe(true);
        expect(cache.verifyCompleteSnapshot('NZ')).toBe(false);

        cache.setColumns('NZ', 'DB1.S1.T1', [{ ATTNAME: 'C1', FORMAT_TYPE: 'INT', label: 'C1' }]);
        expect(cache.verifyCompleteSnapshot('NZ')).toBe(true);
    });

    it('should report stale prefetch after TTL even if triggered (E18)', () => {
        cache['prefetcher'].restorePrefetchTimestamps(new Map([['NZ', Date.now() - 20 * 60 * 60 * 1000]]));
        expect(cache.isConnectionPrefetchFresh('NZ')).toBe(false);
        expect(cache.hasConnectionPrefetchTriggered('NZ')).toBe(true);
    });

    it('loads one table column layer from disk for large catalogs without full DB hydrate', async () => {
        const tables = Array.from({ length: 501 }, (_, index) => ({
            OBJNAME: `T${index}`,
            OBJID: index,
            SCHEMA: 'S1',
            label: `T${index}`,
            objType: 'TABLE',
            kind: 6,
        }));
        cache.setTables('NZ', 'BIGDB.S1', tables, new Map());

        const columnFile = encodeColumnLayers('BIGDB', {
            'BIGDB.S1.TARGET': {
                timestamp: Date.now(),
                data: [{
                    ATTNAME: 'C1',
                    FORMAT_TYPE: 'INT',
                    label: 'C1',
                    isPk: false,
                    isFk: false,
                    isDistributionKey: false,
                }],
            },
        });
        cache['_columnLoaderState'].columnsOnDisk.set('NZ', ['BIGDB']);

        const diskStorage = cache['_diskStorage'];
        expect(diskStorage).toBeDefined();
        const loadSpy = jest
            .spyOn(diskStorage!, 'loadColumnFileForDatabase')
            .mockResolvedValue(columnFile);

        expect(cache.isLargeTableCatalog('NZ', 'BIGDB')).toBe(true);
        expect(cache.getColumns('NZ', 'BIGDB.S1.TARGET')).toBeUndefined();

        await cache.ensureColumnsLoadedForTableKey('NZ', 'BIGDB.S1.TARGET');

        expect(loadSpy).toHaveBeenCalledTimes(1);
        expect(cache.getColumns('NZ', 'BIGDB.S1.TARGET')).toEqual([
            expect.objectContaining({ ATTNAME: 'C1', FORMAT_TYPE: 'INT' }),
        ]);
        expect(cache.getColumns('NZ', 'BIGDB.S1.T0')).toBeUndefined();

        await cache.ensureColumnsLoadedForTableKey('NZ', 'BIGDB.S1.TARGET');
        expect(loadSpy).toHaveBeenCalledTimes(1);
    });
});
