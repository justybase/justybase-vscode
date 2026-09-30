import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as vscode from 'vscode';
import { MetadataCache } from '../metadataCache';
import type {
    MetadataPrefetchRefreshDetails,
    DisposableQueryRunnerRawFn,
} from '../metadata/prefetch';
import type { MetadataQueryContext } from '../metadata/metadataQueryDiagnostics';
import {
    CACHE_V3_DIR_NAME,
    getV3ColumnFilePath,
    getV3ConnectionManifestPath,
    getV3ConnectionMetadataPath,
    getV3IndexPath,
} from '../metadata/diskStorage/metadataDiskPaths';
import { encodeColumnLayers } from '../metadata/diskStorage/metadataColumnCodec';
import type { QueryResult } from '../types';
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
        getConnectionNames: () => ['NZ', 'OTHER'],
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

    function populateSnapshot(
        connectionName: string,
        tableName: string,
        columnName: string,
    ): void {
        cache.setDatabases(connectionName, [{ DATABASE: 'DB1', label: 'DB1', kind: 9 }]);
        cache.setSchemas(connectionName, 'DB1', [{ SCHEMA: 'S1', label: 'S1', kind: 19 }]);
        const idMap = new Map<string, number>();
        idMap.set(`DB1.S1.${tableName}`, 9);
        cache.setTables(connectionName, 'DB1.S1', [{
            OBJNAME: tableName, OBJID: 9, SCHEMA: 'S1', label: tableName, objType: 'TABLE', kind: 6,
        }], idMap);
        cache.setProcedures(connectionName, 'DB1..', [{ PROCEDURE: 'P1', SCHEMA: 'S1', label: 'P1' }]);
        cache.setColumns(connectionName, `DB1.S1.${tableName}`, [{ ATTNAME: columnName, FORMAT_TYPE: 'INT', label: columnName }]);
        cache.setTypeGroups(connectionName, 'DB1', ['TABLE']);
        cache.setForeignKeyRelationshipsForDatabase(connectionName, 'DB1', [], true);
    }

    function populateFull(connectionName: string): void {
        populateSnapshot(connectionName, 'T1', 'C1');
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

    function removeRelationshipIndexMetadata(filePath: string): void {
        const value = JSON.parse(gunzipSync(fs.readFileSync(filePath)).toString('utf8')) as {
            connections?: Record<string, Record<string, unknown>>;
        };
        const entry = value.connections?.NZ;
        if (entry) {
            delete entry.relationshipDatabases;
            delete entry.relationshipIndexVersion;
        }
        fs.writeFileSync(filePath, gzipSync(JSON.stringify(value)));
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
        expect(cache2.hasColumnLayerOnDisk('NZ', 'DB1.S1.T1')).toBe(true);

        await cache2.ensureColumnsLoaded('NZ', 'DB1');
        expect(cache2.getColumns('NZ', 'DB1.S1.T1')).toEqual([
            expect.objectContaining({ ATTNAME: 'C1', FORMAT_TYPE: 'INT', label: 'C1' }),
        ]);
    });

    it('does not hydrate a snapshot after the connection fingerprint changes', async () => {
        populateFull('NZ');
        cache['prefetcher'].restorePrefetchTimestamps(new Map([['NZ', Date.now()]]));
        await persistFull('NZ');
        await cache.dispose();

        const changedConnectionManager = {
            ...mockConnectionManager,
            getConnectionMetadata: () => ({
                host: 'replacement.host',
                port: 5480,
                database: 'SYSTEM',
                user: 'admin',
                dbType: 'netezza' as const,
            }),
        };
        const cache2 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            changedConnectionManager as never,
        );
        await cache2.initialize();
        await cache2.whenConnectionMetadataHydrated('NZ');

        expect(cache2.getDatabases('NZ')).toBeUndefined();
        expect(cache2.getTables('NZ', 'DB1.S1')).toBeUndefined();
        expect(cache2.isConnectionPrefetchFresh('NZ')).toBe(false);
        expect((await cache2['_diskStorage']!.readV3Index())?.connections.NZ).toBeDefined();
        await cache2.dispose();
    });

    it('persists and hydrates FK relationship slices without hydrating column layers', async () => {
        populateFull('NZ');
        const reference = {
            fromDatabase: 'DB1',
            fromSchema: 'S1',
            fromTable: 'T1',
            fromColumn: 'C1',
            toDatabase: 'DB1',
            toSchema: 'S1',
            toTable: 'PARENT',
            toColumn: 'ID',
            constraintName: 'FK_T1_PARENT',
            ordinalPosition: 1,
        };
        cache.setForeignKeyRelationshipsForDatabase('NZ', 'DB1', [reference], true);
        cache['prefetcher'].restorePrefetchTimestamps(new Map([['NZ', Date.now()]]));
        await persistFull('NZ');
        const index = await cache['_diskStorage']!.readV3Index();
        expect(index?.connections.NZ).toEqual(expect.objectContaining({
            relationshipDatabases: ['DB1'],
            relationshipIndexVersion: 1,
        }));
        await cache.dispose();

        const cache2 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
        await cache2.initialize();
        await cache2.whenConnectionMetadataHydrated('NZ');

        expect(cache2.getForeignKeyRelationshipsForDatabase('NZ', 'DB1')).toEqual({
            database: 'DB1',
            references: [reference],
            complete: true,
            status: 'complete',
        });
        expect(cache2.getColumns('NZ', 'DB1.S1.T1')).toBeUndefined();
        expect(cache2.isConnectionPrefetchFresh('NZ')).toBe(true);
        await cache2.dispose();
    });

    it.each(['unavailable', 'failed'] as const)('persists optional FK status %s without expiring core metadata', async (status) => {
        populateFull('NZ');
        cache.setForeignKeyRelationshipsForDatabase('NZ', 'DB1', [], false, status);
        const timestamp = Date.now() - 60_000;
        cache['prefetcher'].restorePrefetchTimestamps(new Map([['NZ', timestamp]]));
        expect(cache.isConnectionPrefetchFresh('NZ')).toBe(true);
        await persistFull('NZ');
        await cache.dispose();
        const restored = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
        await restored.initialize();
        await restored.whenConnectionMetadataHydrated('NZ');
        expect(restored.isConnectionPrefetchFresh('NZ')).toBe(true);
        expect(restored.getForeignKeyRelationshipsForDatabase('NZ', 'DB1')?.status).toBe(status);
        expect(restored['prefetcher'].getConnectionPrefetchTimestamp('NZ')).toBe(timestamp);
        await restored.dispose();
    });

    it('recovers only FK metadata and keeps core TTL and other profiles unchanged', async () => {
        populateFull('NZ');
        populateFull('OTHER');
        cache.setForeignKeyRelationshipsForDatabase('NZ', 'DB1', [], false, 'failed');
        const timestamp = Date.now() - 60_000;
        cache['prefetcher'].restorePrefetchTimestamps(new Map([['NZ', timestamp], ['OTHER', timestamp]]));
        const runner = Object.assign(jest.fn(async (_sql: string) => ({ columns: [], data: [] }) as unknown as QueryResult),
            { dispose: jest.fn(async () => undefined) });
        await cache.refreshIncompleteForeignKeyRelationships('NZ', runner);
        expect(runner).toHaveBeenCalledTimes(1);
        expect(runner.mock.calls[0]?.[0]).toContain('_V_RELATION_KEYDATA');
        expect(runner.dispose).toHaveBeenCalledTimes(1);
        expect(cache.getForeignKeyRelationshipsForDatabase('NZ', 'DB1')?.complete).toBe(true);
        expect(cache.isConnectionPrefetchFresh('OTHER')).toBe(true);
        expect(cache['prefetcher'].getConnectionPrefetchTimestamp('NZ')).toBe(timestamp);
        await cache.dispose();
    });

    it('bounds FK-only retries and skips unavailable catalogues', async () => {
        populateFull('NZ');
        cache['prefetcher'].restorePrefetchTimestamps(new Map([['NZ', Date.now()]]));
        cache.setForeignKeyRelationshipsForDatabase('NZ', 'DB1', [], false, 'failed');
        const runner = Object.assign(jest.fn(async () => { throw new Error('query timed out'); }),
            { dispose: jest.fn(async () => undefined) });
        await cache.refreshIncompleteForeignKeyRelationships('NZ', runner);
        await cache.refreshIncompleteForeignKeyRelationships('NZ', runner);
        expect(runner).toHaveBeenCalledTimes(1);
        expect(cache.getForeignKeyRelationshipsForDatabase('NZ', 'DB1')?.status).toBe('failed');
        const now = Date.now();
        const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000 + 1);
        try {
            await cache.refreshIncompleteForeignKeyRelationships('NZ', runner);
            expect(runner).toHaveBeenCalledTimes(2);
            clock.mockReturnValue(now + 10 * 60_000 + 2);
            await cache.refreshIncompleteForeignKeyRelationships('NZ', runner);
            expect(runner).toHaveBeenCalledTimes(2);
        } finally {
            clock.mockRestore();
        }
        cache.setForeignKeyRelationshipsForDatabase('NZ', 'DB1', [], false, 'unavailable');
        await cache.refreshIncompleteForeignKeyRelationships('NZ', runner);
        expect(runner).toHaveBeenCalledTimes(2);
        expect(runner.dispose).toHaveBeenCalledTimes(5);
        expect(cache.isConnectionPrefetchFresh('NZ')).toBe(true);
        await cache.dispose();
    });

    it('rejects a late FK response after cache invalidation and still disposes the runner', async () => {
        populateFull('NZ');
        cache['prefetcher'].restorePrefetchTimestamps(new Map([['NZ', Date.now()]]));
        cache.setForeignKeyRelationshipsForDatabase('NZ', 'DB1', [], false, 'failed');
        let release!: (result: QueryResult) => void;
        let started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        const runner = Object.assign(jest.fn(async (_sql: string) => {
            started();
            return new Promise<QueryResult>(resolve => { release = resolve; });
        }), { dispose: jest.fn(async () => undefined) });
        const recovery = cache.refreshIncompleteForeignKeyRelationships('NZ', runner);
        await ready;
        await cache.clearCache();
        release({ columns: [], data: [] } as unknown as QueryResult);
        await recovery;
        expect(cache.getForeignKeyRelationshipsForDatabase('NZ', 'DB1')).toBeUndefined();
        expect(runner.dispose).toHaveBeenCalledTimes(1);
        await cache.dispose();
    });

    it('restores independent fresh core snapshots for two profiles with different FK states', async () => {
        populateSnapshot('NZ', 'FIRST', 'A');
        populateSnapshot('OTHER', 'SECOND', 'B');
        cache.setForeignKeyRelationshipsForDatabase('NZ', 'DB1', [], false, 'unavailable');
        const timestamp = Date.now() - 60_000;
        cache['prefetcher'].restorePrefetchTimestamps(new Map([['NZ', timestamp], ['OTHER', timestamp]]));
        await persistFull('NZ');
        await persistFull('OTHER');
        await cache.dispose();
        const restored = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
        await restored.initialize();
        for (const profile of ['NZ', 'OTHER', 'NZ']) {
            await restored.whenConnectionMetadataHydrated(profile);
            expect(restored.isConnectionPrefetchFresh(profile)).toBe(true);
            const expected = profile === 'NZ' ? 'FIRST' : 'SECOND';
            expect(restored.getTables(profile, 'DB1.S1')?.[0]?.OBJNAME).toBe(expected);
        }
        await restored.dispose();
    });

    it('keeps core metadata fresh when an older snapshot has no FK index', async () => {
        populateFull('NZ');
        cache['prefetcher'].restorePrefetchTimestamps(new Map([['NZ', Date.now()]]));
        await persistFull('NZ');
        await cache.dispose();

        removeRelationshipIndexMetadata(getV3IndexPath(tempDir));
        removeRelationshipIndexMetadata(getV3ConnectionManifestPath(tempDir, 'NZ'));

        const cache2 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
        await cache2.initialize();
        await cache2.whenConnectionMetadataHydrated('NZ');

        expect(cache2.getForeignKeyRelationshipsForDatabase('NZ', 'DB1')).toBeUndefined();
        expect(cache2.isConnectionPrefetchFresh('NZ')).toBe(true);
        await cache2.dispose();
    });

    it('keeps only the manifest database list when the metadata blob is corrupt', async () => {
        populateFull('NZ');
        cache['prefetcher'].restorePrefetchTimestamps(new Map([['NZ', Date.now()]]));
        await persistFull('NZ');
        await cache.dispose();

        fs.writeFileSync(getV3ConnectionMetadataPath(tempDir, 'NZ'), Buffer.from('corrupt-gzip'));
        const cache2 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
        await cache2.initialize();
        await cache2.whenConnectionMetadataHydrated('NZ');

        expect(cache2.getDatabases('NZ')).toEqual([
            expect.objectContaining({ DATABASE: 'DB1' }),
        ]);
        expect(cache2.getTables('NZ', 'DB1.S1')).toBeUndefined();
        expect(cache2.isConnectionPrefetchFresh('NZ')).toBe(false);
        await cache2.dispose();
    });

    it('discards an expired connection snapshot from memory and disk before refresh', async () => {
        populateFull('NZ');
        await persistFull('NZ');

        expect(cache.getTables('NZ', 'DB1.S1')).toBeDefined();
        expect(fs.existsSync(getV3ConnectionMetadataPath(tempDir, 'NZ'))).toBe(true);

        await cache.discardExpiredConnectionMetadata('NZ');

        expect(cache.getDatabases('NZ')).toBeUndefined();
        expect(cache.getTables('NZ', 'DB1.S1')).toBeUndefined();
        expect(cache.getColumns('NZ', 'DB1.S1.T1')).toBeUndefined();
        expect((await cache['_diskStorage']!.readV3Index())?.connections.NZ).toBeUndefined();
        expect(fs.existsSync(getV3ConnectionMetadataPath(tempDir, 'NZ'))).toBe(false);
        expect(fs.existsSync(getV3ColumnFilePath(tempDir, 'NZ', 'DB1'))).toBe(false);
    });

    it('does not hydrate an expired disk snapshot after restart', async () => {
        populateFull('NZ');
        const expiredAt = Date.now() - cache.getCacheTTL() - 1;
        await cache['_diskStorage']!.saveConnection(cache, 'NZ', expiredAt);

        const cache2 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
        await cache2.initialize();
        await cache2.whenConnectionMetadataHydrated('NZ');

        expect(cache2.getDatabases('NZ')).toBeUndefined();
        expect(cache2.getTables('NZ', 'DB1.S1')).toBeUndefined();
        expect((await cache2['_diskStorage']!.readV3Index())?.connections.NZ).toBeUndefined();
        expect(fs.existsSync(getV3ConnectionMetadataPath(tempDir, 'NZ'))).toBe(false);
        expect(fs.existsSync(getV3ColumnFilePath(tempDir, 'NZ', 'DB1'))).toBe(false);

        await cache2.dispose();
    });

    it('removes an expired Netezza snapshot before a clean refresh and persists only current metadata', async () => {
        populateSnapshot('NZ', 'OLD_TABLE', 'OLD_COL');
        const expiredAt = Date.now() - cache.getCacheTTL() - 1;
        await cache['_diskStorage']!.saveConnection(cache, 'NZ', expiredAt);

        const cache2 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
        const diskStorage = cache2['_diskStorage']!;
        const lifecycle: string[] = [];
        const originalRemoveConnection = diskStorage.removeConnection.bind(diskStorage);
        const removeConnectionSpy = jest.spyOn(diskStorage, 'removeConnection')
            .mockImplementation(async (...args) => {
                await originalRemoveConnection(...args);
                lifecycle.push('remove-complete');
            });

        await cache2.initialize();
        await cache2.whenConnectionMetadataHydrated('NZ');

        expect(removeConnectionSpy).toHaveBeenCalledWith('NZ', {
            expectedPrefetchCompletedAt: expiredAt,
        });
        expect(cache2.getDatabases('NZ')).toBeUndefined();
        expect(cache2.getTables('NZ', 'DB1.S1')).toBeUndefined();
        expect(cache2.getColumns('NZ', 'DB1.S1.OLD_TABLE')).toBeUndefined();
        expect((await diskStorage.readV3Index())?.connections.NZ).toBeUndefined();
        expect(fs.existsSync(getV3ConnectionMetadataPath(tempDir, 'NZ'))).toBe(false);
        expect(fs.existsSync(getV3ColumnFilePath(tempDir, 'NZ', 'DB1'))).toBe(false);

        const result = (columns: string[], data: unknown[][]): QueryResult => ({
            columns: columns.map(name => ({ name })),
            data,
        });
        let resolveRunnerDisposed!: () => void;
        const runnerDisposed = new Promise<void>(resolve => {
            resolveRunnerDisposed = resolve;
        });
        const runner = Object.assign(
            jest.fn(async (_query: string, context?: MetadataQueryContext): Promise<QueryResult> => {
                if (!lifecycle.includes('first-query')) {
                    lifecycle.push('first-query');
                }

                switch (context?.kind) {
                    case 'databases':
                        return result(['DATABASE'], [['DB1']]);
                    case 'schemas':
                        return result(['SCHEMA'], [['S1']]);
                    case 'type-groups':
                        return result(['OBJTYPE'], [['TABLE'], ['PROCEDURE']]);
                    case 'objects':
                        return result(
                            ['OBJNAME', 'OBJID', 'SCHEMA', 'DBNAME', 'OBJTYPE'],
                            [['NEW_TABLE', 10, 'S1', 'DB1', 'TABLE']],
                        );
                    case 'external-objects':
                        return result(
                            ['OBJNAME', 'OBJID', 'SCHEMA', 'DBNAME', 'OBJTYPE'],
                            [],
                        );
                    case 'procedures':
                        return result(
                            ['PROCEDURE', 'SCHEMA', 'PROCEDURESIGNATURE'],
                            [['P_NEW', 'S1', 'P_NEW()']],
                        );
                    case 'columns':
                        return result(
                            ['OBJID', 'TABLENAME', 'DBNAME', 'SCHEMA', 'ATTNAME', 'FORMAT_TYPE', 'ATTNUM', 'DESCRIPTION'],
                            [[10, 'NEW_TABLE', 'DB1', 'S1', 'NEW_COL', 'INTEGER', 1, 'new column']],
                        );
                    case 'column-keys':
                        return result(['OBJID', 'ATTNAME', 'CONTYPE'], []);
                    case 'column-distribution':
                        return result(['OBJID', 'ATTNAME'], []);
                    case 'column-relations':
                        return result([], []);
                    default:
                        throw new Error(`Unexpected metadata query kind: ${String(context?.kind)}`);
                }
            }),
            {
                dispose: jest.fn(async () => {
                    resolveRunnerDisposed();
                }),
            },
        ) as unknown as DisposableQueryRunnerRawFn;

        const terminalRefresh = new Promise<MetadataPrefetchRefreshDetails>((resolve, reject) => {
            const subscription = cache2.onDidPrefetchRefreshDetails(details => {
                if (
                    details.completedAt === undefined
                    || (details.stage !== 'complete' && details.stage !== 'error')
                ) {
                    return;
                }
                subscription.dispose();
                resolve(details);
            });

            try {
                cache2.triggerConnectionPrefetch('NZ', runner);
            } catch (error: unknown) {
                subscription.dispose();
                reject(error);
            }
        });

        const details = await terminalRefresh;
        await runnerDisposed;

        expect(lifecycle.indexOf('remove-complete')).toBeGreaterThanOrEqual(0);
        expect(lifecycle.indexOf('first-query')).toBeGreaterThan(lifecycle.indexOf('remove-complete'));
        expect(details.stage).toBe('complete');
        expect(details.snapshot).toEqual(expect.objectContaining({
            complete: true,
            missingStages: [],
            missingColumnCount: 0,
        }));
        const refreshedTables = cache2.getTables('NZ', 'DB1.S1');
        expect(refreshedTables).toEqual([
            expect.objectContaining({ OBJNAME: 'NEW_TABLE', OBJID: 10 }),
        ]);
        expect(refreshedTables?.some(table => table.OBJNAME === 'OLD_TABLE')).toBe(false);
        expect(cache2.getColumns('NZ', 'DB1.S1.NEW_TABLE')).toEqual([
            expect.objectContaining({ ATTNAME: 'NEW_COL', FORMAT_TYPE: 'INTEGER' }),
        ]);
        expect(cache2.getColumns('NZ', 'DB1.S1.OLD_TABLE')).toBeUndefined();
        expect(cache2.isConnectionPrefetchFresh('NZ')).toBe(true);

        const refreshedIndex = await diskStorage.readV3Index();
        expect(refreshedIndex?.connections.NZ?.prefetchCompletedAt).toBeGreaterThan(expiredAt);
        expect(fs.existsSync(getV3ConnectionMetadataPath(tempDir, 'NZ'))).toBe(true);
        expect(fs.existsSync(getV3ColumnFilePath(tempDir, 'NZ', 'DB1'))).toBe(true);

        await cache2.dispose();

        const cache3 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
        await cache3.initialize();
        await cache3.whenConnectionMetadataHydrated('NZ');
        await cache3.ensureColumnsLoaded('NZ', 'DB1');

        const restartedTables = cache3.getTables('NZ', 'DB1.S1');
        expect(restartedTables).toEqual([
            expect.objectContaining({ OBJNAME: 'NEW_TABLE', OBJID: 10 }),
        ]);
        expect(restartedTables?.some(table => table.OBJNAME === 'OLD_TABLE')).toBe(false);
        expect(cache3.getColumns('NZ', 'DB1.S1.NEW_TABLE')).toEqual([
            expect.objectContaining({ ATTNAME: 'NEW_COL', FORMAT_TYPE: 'INTEGER' }),
        ]);
        expect(cache3.getColumns('NZ', 'DB1.S1.OLD_TABLE')).toBeUndefined();

        await cache3.dispose();
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

    it('removes FK slices omitted by an external snapshot for an existing database', async () => {
        populateFull('NZ');
        cache.invalidateForeignKeyRelationships('NZ');
        await cache.checkpointSave('NZ');

        const cache2 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
        cache2.setDatabases('NZ', [{ DATABASE: 'DB1', label: 'DB1', kind: 9 }]);
        cache2.setForeignKeyRelationshipsForDatabase('NZ', 'DB1', [{
            fromDatabase: 'DB1', fromSchema: 'S1', fromTable: 'T1', fromColumn: 'C1',
            toDatabase: 'DB1', toSchema: 'S1', toTable: 'PARENT', toColumn: 'ID',
        }], true);

        await (
            cache2 as unknown as {
                onExternalCacheUpdate: (names: string[]) => Promise<void>;
            }
        ).onExternalCacheUpdate(['NZ']);

        expect(cache2.getDatabases('NZ')).toEqual([
            expect.objectContaining({ DATABASE: 'DB1' }),
        ]);
        expect(cache2.getForeignKeyRelationshipsForDatabase('NZ', 'DB1')).toBeUndefined();
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

    it('reports recovery and withholds columns when the persisted column blob is corrupt', async () => {
        populateFull('NZ');
        cache['prefetcher'].restorePrefetchTimestamps(new Map([['NZ', Date.now()]]));
        await persistFull('NZ');
        await cache.dispose();

        fs.writeFileSync(getV3ColumnFilePath(tempDir, 'NZ', 'DB1'), Buffer.from('corrupt-gzip'));
        const cache2 = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
        const recovery = jest.fn();
        cache2.onDidNeedColumnRecovery(recovery);
        await cache2.initialize();
        await cache2.whenConnectionMetadataHydrated('NZ');
        await cache2.ensureColumnsLoaded('NZ', 'DB1');

        expect(recovery).toHaveBeenCalledWith('NZ');
        expect(cache2.isConnectionPrefetchFresh('NZ')).toBe(false);
        expect(cache2.hasColumnsOnDisk('NZ', 'DB1')).toBe(false);
        expect(cache2.getColumns('NZ', 'DB1.S1.T1')).toBeUndefined();
        await cache2.dispose();
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
        cache.setForeignKeyRelationshipsForDatabase('NZ', 'DB1', [], true);
        expect(cache.verifyCompleteSnapshot('NZ')).toBe(true);
    });

    it('does not treat another table in the same database file as column coverage', () => {
        cache.setDatabases('NZ', [{ DATABASE: 'DB1', label: 'DB1', kind: 9 }]);
        cache.setSchemas('NZ', 'DB1', [{ SCHEMA: 'S1', label: 'S1', kind: 19 }]);
        cache.setTables('NZ', 'DB1.S1', [
            { OBJNAME: 'T1', OBJID: 1, SCHEMA: 'S1', label: 'T1', objType: 'TABLE', kind: 6 },
            { OBJNAME: 'T2', OBJID: 2, SCHEMA: 'S1', label: 'T2', objType: 'TABLE', kind: 6 },
        ], new Map([['DB1.S1.T1', 1], ['DB1.S1.T2', 2]]));
        cache.setProcedures('NZ', 'DB1..', [{ PROCEDURE: 'P1', SCHEMA: 'S1', label: 'P1' }]);
        cache.setColumns('NZ', 'DB1.S1.T1', [{ ATTNAME: 'C1', FORMAT_TYPE: 'INT', label: 'C1' }]);

        cache['_columnLoaderState'].columnsOnDisk.set('NZ', ['DB1']);
        cache['_columnLoaderState'].columnLayerKeysOnDisk.set(
            'NZ',
            new Set(['DB1.S1.T1']),
        );

        expect(cache.verifyCompleteSnapshot('NZ')).toBe(false);
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
