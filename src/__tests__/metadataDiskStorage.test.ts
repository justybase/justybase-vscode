import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as vscode from 'vscode';
import { MetadataCache } from '../metadataCache';
import { computeConnectionFingerprint } from '../metadata/diskStorage/connectionFingerprint';
import {
    getCacheV3Dir,
    getV3ColumnFilePath,
    getV3ConnectionManifestPath,
    getLegacySanitizedColumnFilePath,
    getV3ConnectionMetadataPath,
    getV3IndexPath,
    LEGACY_CACHE_FILE_NAME,
} from '../metadata/diskStorage/metadataDiskPaths';
import { MetadataDiskStorage } from '../metadata/diskStorage/metadataDiskStorage';
import {
    CACHE_SCHEMA_VERSION,
    COLUMN_FILE_SCHEMA_VERSION,
    createEmptySerializedCache,
    LEGACY_CACHE_SCHEMA_VERSION,
    METADATA_MANIFEST_SCHEMA_VERSION,
    ORPHAN_MAX_AGE_MS,
    SAVE_DEBOUNCE_MS,
} from '../metadata/diskStorage/metadataDiskTypes';
import { Logger } from '../utils/logger';

jest.mock('vscode');

describe('MetadataDiskStorage', () => {
    let tempDir: string;
    let storage: MetadataDiskStorage;
    let cache: MetadataCache;
    const fingerprint = computeConnectionFingerprint({
        host: 'h',
        port: 5480,
        database: 'd',
        dbType: 'netezza',
    });

    const mockConnectionManager = {
        getConnectionMetadata: (name: string) => {
            if (name === 'conn1') {
                return { host: 'h', port: 5480, database: 'd', user: 'u', dbType: 'netezza' as const };
            }
            return undefined;
        },
        getConnectionNames: () => ['conn1'],
        getConnectionDatabaseKind: () => 'netezza' as const,
    };

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-disk-'));
        storage = new MetadataDiskStorage(tempDir, mockConnectionManager as never);

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
            get: (_key: string, defaultValue?: unknown) => defaultValue,
        });

        cache = new MetadataCache(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            mockConnectionManager as never,
        );
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function populateCache(connectionName: string): void {
        cache.setDatabases(connectionName, [{ DATABASE: 'DB1', label: 'DB1', kind: 9 }]);
        cache.setSchemas(connectionName, 'DB1', [{ SCHEMA: 'S1', label: 'S1', kind: 19 }]);
        const idMap = new Map<string, number>();
        idMap.set('DB1.S1.T1', 1);
        cache.setTables(connectionName, 'DB1.S1', [{
            OBJNAME: 'T1', OBJID: 1, SCHEMA: 'S1', label: 'T1', objType: 'TABLE', kind: 6,
        }], idMap);
        cache.setProcedures(connectionName, 'DB1..', [{ PROCEDURE: 'P1', SCHEMA: 'S1', label: 'P1' }]);
        cache.setColumns(connectionName, 'DB1.S1.T1', [{ ATTNAME: 'C1', FORMAT_TYPE: 'INT', label: 'C1' }]);
        cache.setTypeGroups(connectionName, 'DB1', ['TABLE']);
    }

    function populateTwoDatabases(connectionName: string): void {
        populateCache(connectionName);
        cache.setSchemas(connectionName, 'DB2', [{ SCHEMA: 'S2', label: 'S2', kind: 19 }]);
        const idMap = new Map<string, number>();
        idMap.set('DB2.S2.T2', 2);
        cache.setTables(connectionName, 'DB2.S2', [{
            OBJNAME: 'T2', OBJID: 2, SCHEMA: 'S2', label: 'T2', objType: 'TABLE', kind: 6,
        }], idMap);
        cache.setColumns(connectionName, 'DB2.S2.T2', [{ ATTNAME: 'C2', FORMAT_TYPE: 'INT', label: 'C2' }]);
    }

    it('should save and load v2 split cache files', async () => {
        populateCache('conn1');
        await storage.saveConnection(cache, 'conn1', Date.now());

        expect(fs.existsSync(getV3IndexPath(tempDir))).toBe(true);
        expect(fs.existsSync(getV3ConnectionManifestPath(tempDir, 'conn1'))).toBe(true);
        expect(fs.existsSync(getV3ConnectionMetadataPath(tempDir, 'conn1'))).toBe(true);
        expect(fs.existsSync(getV3ColumnFilePath(tempDir, 'conn1', 'DB1'))).toBe(true);

        const manifestLoaded = await storage.loadAllConnectionManifests();
        expect(manifestLoaded.get('conn1')?.database.data).toEqual([
            { DATABASE: 'DB1', label: 'DB1', kind: 9 },
        ]);
        expect(manifestLoaded.get('conn1')?.hasManifestFile).toBe(true);

        const metadataBytes = fs.readFileSync(getV3ConnectionMetadataPath(tempDir, 'conn1'));
        expect(metadataBytes[0]).toBe(0x1f);
        expect(metadataBytes[1]).toBe(0x8b);

        const loaded = await storage.loadAllConnections();
        expect(loaded.get('conn1')).toBeDefined();
        expect(loaded.get('conn1')?.column['DB1.S1.T1']).toBeDefined();
    });

    it('should load partial checkpoints without marking prefetch fresh', async () => {
        const savedAt = Date.now();
        populateCache('conn1');
        await storage.saveConnection(cache, 'conn1', savedAt, { isComplete: false });

        const manifests = await storage.loadAllConnectionManifests();
        const manifest = manifests.get('conn1');
        expect(manifest?.isComplete).toBe(false);
        expect(manifest?.database.data).toEqual([
            { DATABASE: 'DB1', label: 'DB1', kind: 9 },
        ]);

        const { loadable, freshTimestamps } = storage.filterLoadableManifestConnections(
            manifests,
            12 * 60 * 60 * 1000,
        );
        expect(loadable.has('conn1')).toBe(true);
        expect(freshTimestamps.has('conn1')).toBe(false);
    });

    it('should persist column files as dictionary-encoded v3', async () => {
        populateCache('conn1');
        await storage.saveConnection(cache, 'conn1', Date.now());

        const { gunzipSync } = require('zlib');
        const raw = gunzipSync(fs.readFileSync(getV3ColumnFilePath(tempDir, 'conn1', 'DB1')));
        const parsed = JSON.parse(raw.toString('utf8'));
        expect(parsed.schemaVersion).toBe(COLUMN_FILE_SCHEMA_VERSION);
        expect(parsed.layers['DB1.S1.T1']).toBeDefined();
        expect(parsed.schemas).toContain('S1');
    });

    it('should ignore manifest that is newer than the committed index entry', async () => {
        const committedAt = Date.now() - 10_000;
        populateCache('conn1');
        await storage.saveConnection(cache, 'conn1', committedAt);

        const { gzipSync } = require('zlib');
        const uncommittedManifest = {
            schemaVersion: METADATA_MANIFEST_SCHEMA_VERSION,
            prefetchCompletedAt: committedAt + 5_000,
            connectionFingerprint: fingerprint,
            database: {
                timestamp: committedAt + 5_000,
                data: [{ DATABASE: 'UNCOMMITTED_DB', label: 'UNCOMMITTED_DB', kind: 9 }],
            },
            columnDatabases: ['UNCOMMITTED_DB'],
        };
        fs.writeFileSync(
            getV3ConnectionManifestPath(tempDir, 'conn1'),
            gzipSync(Buffer.from(JSON.stringify(uncommittedManifest))),
        );

        const manifests = await storage.loadAllConnectionManifests();
        const manifest = manifests.get('conn1');

        expect(manifest?.hasManifestFile).toBe(false);
        expect(manifest?.prefetchCompletedAt).toBe(committedAt);
        expect(manifest?.database.data).toEqual([]);
        expect(manifest?.columnDatabases).toEqual(['DB1']);
    });

    it('should ignore v2 payloads', async () => {
        populateCache('conn1');
        const v2ColumnFile = {
            schemaVersion: CACHE_SCHEMA_VERSION,
            database: 'DB1',
            column: {
                'DB1.S1.T1': {
                    timestamp: 1,
                    data: [{ ATTNAME: 'C1', FORMAT_TYPE: 'INT', label: 'C1' }],
                },
            },
        };
        const { gzipSync } = require('zlib');
        const columnPath = getLegacySanitizedColumnFilePath(tempDir, 'conn1', 'DB1');
        fs.mkdirSync(path.dirname(columnPath), { recursive: true });
        fs.writeFileSync(columnPath, gzipSync(Buffer.from(JSON.stringify(v2ColumnFile))));

        const metadata = {
            prefetchCompletedAt: Date.now(),
            connectionFingerprint: fingerprint,
            database: { timestamp: 1, data: [{ DATABASE: 'DB1', label: 'DB1' }] },
            schema: { DB1: { timestamp: 1, data: [{ SCHEMA: 'S1', label: 'S1' }] } },
            table: { 'DB1.S1': { timestamp: 1, data: [{ OBJNAME: 'T1', OBJID: 1, SCHEMA: 'S1', label: 'T1' }] } },
            procedure: { 'DB1..': { timestamp: 1, data: [{ PROCEDURE: 'P1', SCHEMA: 'S1', label: 'P1' }] } },
            typeGroup: { DB1: { timestamp: 1, data: ['TABLE'] } },
        };
        const { gzipSync: gzip } = require('zlib');
        // Deliberately place a complete v2-style payload in the legacy root.
        const legacyMetadataPath = path.join(tempDir, 'metadata-cache-v2', 'conn1', 'metadata.json.gz');
        await storage['writeGzipJson'](legacyMetadataPath, metadata);
        const index = {
            schemaVersion: CACHE_SCHEMA_VERSION,
            writtenAt: Date.now(),
            connections: {
                conn1: {
                    prefetchCompletedAt: Date.now(),
                    connectionFingerprint: fingerprint,
                    columnDatabases: ['DB1'],
                },
            },
        };
        fs.writeFileSync(path.join(tempDir, 'metadata-cache-v2', 'index.json.gz'), gzip(Buffer.from(JSON.stringify(index))));

        const loaded = await storage.loadAllConnections();
        expect(loaded.get('conn1')).toBeUndefined();
    });

    it('should write separate column files per database', async () => {
        populateTwoDatabases('conn1');
        await storage.saveConnection(cache, 'conn1', Date.now());

        expect(fs.existsSync(getV3ColumnFilePath(tempDir, 'conn1', 'DB1'))).toBe(true);
        expect(fs.existsSync(getV3ColumnFilePath(tempDir, 'conn1', 'DB2'))).toBe(true);

        const loaded = await storage.loadAllConnections();
        const conn = loaded.get('conn1');
        expect(conn?.column['DB1.S1.T1']).toBeDefined();
        expect(conn?.column['DB2.S2.T2']).toBeDefined();
    });

    it('should not collide column files for database names that sanitize identically', async () => {
        cache.setDatabases('conn1', [
            { DATABASE: 'PROD:1', label: 'PROD:1', kind: 9 },
            { DATABASE: 'PROD_1', label: 'PROD_1', kind: 9 },
        ]);
        cache.setSchemas('conn1', 'PROD:1', [{ SCHEMA: 'S1', label: 'S1', kind: 19 }]);
        cache.setSchemas('conn1', 'PROD_1', [{ SCHEMA: 'S1', label: 'S1', kind: 19 }]);
        const idMap1 = new Map<string, number>();
        idMap1.set('PROD:1.S1.T1', 1);
        cache.setTables('conn1', 'PROD:1.S1', [{
            OBJNAME: 'T1', OBJID: 1, SCHEMA: 'S1', label: 'T1', objType: 'TABLE', kind: 6,
        }], idMap1);
        const idMap2 = new Map<string, number>();
        idMap2.set('PROD_1.S1.T2', 2);
        cache.setTables('conn1', 'PROD_1.S1', [{
            OBJNAME: 'T2', OBJID: 2, SCHEMA: 'S1', label: 'T2', objType: 'TABLE', kind: 6,
        }], idMap2);
        cache.setProcedures('conn1', 'PROD:1..', [{ PROCEDURE: 'P1', SCHEMA: 'S1', label: 'P1' }]);
        cache.setProcedures('conn1', 'PROD_1..', [{ PROCEDURE: 'P2', SCHEMA: 'S1', label: 'P2' }]);
        cache.setColumns('conn1', 'PROD:1.S1.T1', [{ ATTNAME: 'C1', FORMAT_TYPE: 'INT', label: 'C1' }]);
        cache.setColumns('conn1', 'PROD_1.S1.T2', [{ ATTNAME: 'C2', FORMAT_TYPE: 'INT', label: 'C2' }]);
        cache.setTypeGroups('conn1', 'PROD:1', ['TABLE']);
        cache.setTypeGroups('conn1', 'PROD_1', ['TABLE']);

        await storage.saveConnection(cache, 'conn1', Date.now());

        const pathA = getV3ColumnFilePath(tempDir, 'conn1', 'PROD:1');
        const pathB = getV3ColumnFilePath(tempDir, 'conn1', 'PROD_1');
        expect(pathA).not.toBe(pathB);
        expect(fs.existsSync(pathA)).toBe(true);
        expect(fs.existsSync(pathB)).toBe(true);

        const loaded = await storage.loadAllConnections();
        expect(loaded.get('conn1')?.column['PROD:1.S1.T1']?.data[0].ATTNAME).toBe('C1');
        expect(loaded.get('conn1')?.column['PROD_1.S1.T2']?.data[0].ATTNAME).toBe('C2');
    });

    it('does not persist a debounced snapshot without a prefetch lease', async () => {
        jest.useFakeTimers();
        populateCache('conn1');

        storage.scheduleSave(cache, 'conn1', Date.now());
        expect(fs.existsSync(getV3IndexPath(tempDir))).toBe(false);

        await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
        await storage.whenWriteQueueIdle();

        expect(fs.existsSync(getV3IndexPath(tempDir))).toBe(false);
    });

    it('re-queues a dirty connection when another flush temporarily holds its lease', async () => {
        jest.useFakeTimers();
        populateCache('conn1');
        const acquireLease = jest.spyOn(storage, 'acquirePrefetchLease').mockResolvedValue(undefined);

        storage.scheduleSave(cache, 'conn1', Date.now());
        await storage.flushPendingWrites();

        expect(acquireLease).toHaveBeenCalledWith('conn1');
        expect(storage['dirtyConnections'].has('conn1')).toBe(true);
        jest.clearAllTimers();
    });

    it('leaves legacy v1 data untouched', async () => {
        const legacy = createEmptySerializedCache();
        legacy.connections.conn1 = {
            prefetchCompletedAt: Date.now(),
            connectionFingerprint: fingerprint,
            database: { timestamp: 1, data: [{ DATABASE: 'DB1' }] },
            schema: { DB1: { timestamp: 1, data: [{ SCHEMA: 'S1' }] } },
            table: { 'DB1.S1': { timestamp: 1, data: [{ OBJNAME: 'T1', SCHEMA: 'S1', OBJID: 1 }] } },
            procedure: { 'DB1..': { timestamp: 1, data: [{ PROCEDURE: 'P1' }] } },
            column: { 'DB1.S1.T1': { timestamp: 1, data: [{ ATTNAME: 'C1', FORMAT_TYPE: 'INT' }] } },
            typeGroup: { DB1: { timestamp: 1, data: ['TABLE'] } },
        };
        const { gzipSync } = require('zlib');
        fs.writeFileSync(
            path.join(tempDir, LEGACY_CACHE_FILE_NAME),
            gzipSync(Buffer.from(JSON.stringify(legacy))),
        );

        await storage.migrateLegacyIfNeeded();
        expect(fs.existsSync(path.join(tempDir, LEGACY_CACHE_FILE_NAME))).toBe(true);
        expect(fs.existsSync(getV3IndexPath(tempDir))).toBe(false);

        const loaded = await storage.loadAllConnections();
        expect(loaded.get('conn1')).toBeUndefined();
    });

    it('should reject corrupted gzip (E1)', async () => {
        fs.writeFileSync(getV3IndexPath(tempDir), Buffer.from('not-gzip-json'));
        const loaded = await storage.loadAllConnections();
        expect(loaded.size).toBe(0);
    });

    it('should reject legacy schema version mismatch (E2)', async () => {
        const bad = createEmptySerializedCache();
        bad.schemaVersion = 999;
        bad.connections.conn1 = {
            prefetchCompletedAt: Date.now(),
            connectionFingerprint: fingerprint,
            database: { timestamp: 1, data: [{ DATABASE: 'DB1' }] },
            schema: { DB1: { timestamp: 1, data: [{ SCHEMA: 'S1' }] } },
            table: { 'DB1.S1': { timestamp: 1, data: [{ OBJNAME: 'T1', SCHEMA: 'S1' }] } },
            procedure: { 'DB1..': { timestamp: 1, data: [{ PROCEDURE: 'P1' }] } },
            column: { 'DB1.S1.T1': { timestamp: 1, data: [{ ATTNAME: 'C1', FORMAT_TYPE: 'INT' }] } },
            typeGroup: { DB1: { timestamp: 1, data: ['TABLE'] } },
        };
        const { gzipSync } = require('zlib');
        fs.writeFileSync(
            path.join(tempDir, LEGACY_CACHE_FILE_NAME),
            gzipSync(Buffer.from(JSON.stringify(bad))),
        );
        await storage.migrateLegacyIfNeeded();
        expect(fs.existsSync(getV3IndexPath(tempDir))).toBe(false);
    });

    it('should cleanup tmp file on init (E3)', async () => {
        fs.writeFileSync(`${getV3IndexPath(tempDir)}.tmp`, 'partial');
        await storage.cleanupTempFile();
        expect(fs.existsSync(`${getV3IndexPath(tempDir)}.tmp`)).toBe(false);
    });

    it('should skip fingerprint mismatch on load (E5)', async () => {
        populateCache('conn1');
        await storage.saveConnection(cache, 'conn1', Date.now());

        const loaded = await storage.loadAllConnections();
        const conn = loaded.get('conn1')!;
        conn.connectionFingerprint = 'wrong-fingerprint';
        const connections = new Map([['conn1', conn]]);
        const { loadable } = storage.filterLoadableConnections(connections, 12 * 60 * 60 * 1000);
        expect(loadable.size).toBe(0);
    });

    it('should skip load when connection fingerprint cannot be resolved', async () => {
        populateCache('conn1');
        await storage.saveConnection(cache, 'conn1', Date.now());

        const loaded = await storage.loadAllConnections();
        const connections = new Map([['unknown', loaded.get('conn1')!]]);
        const { loadable } = storage.filterLoadableConnections(connections, 12 * 60 * 60 * 1000);
        expect(loadable.size).toBe(0);
    });

    it('should merge saves for two connections', async () => {
        populateCache('conn1');
        await storage.saveConnection(cache, 'conn1', Date.now());

        const mockConn2Manager = {
            getConnectionMetadata: (name: string) => {
                if (name === 'conn2') {
                    return { host: 'h2', port: 1, database: 'd2', user: 'u', dbType: 'netezza' as const };
                }
                if (name === 'conn1') {
                    return { host: 'h', port: 5480, database: 'd', user: 'u', dbType: 'netezza' as const };
                }
                return undefined;
            },
            getConnectionNames: () => ['conn1', 'conn2'],
            getConnectionDatabaseKind: () => 'netezza' as const,
        };
        const storage2 = new MetadataDiskStorage(tempDir, mockConn2Manager as never);
        populateCache('conn2');
        await storage2.saveConnection(cache, 'conn2', Date.now());

        const loaded = await storage.loadAllConnections();
        expect(loaded.get('conn1')).toBeDefined();
        expect(loaded.get('conn2')).toBeDefined();
    });

    it('should serialize concurrent saves behind a disk save lock', async () => {
        populateCache('conn1');
        const lockSpy = jest.spyOn(storage.lock, 'acquireLock');

        await Promise.all([
            storage.saveConnection(cache, 'conn1', Date.now()),
            storage.saveConnection(cache, 'conn1', Date.now()),
        ]);

        expect(lockSpy).toHaveBeenCalledWith('__metadata-cache-save__');
        lockSpy.mockRestore();
    });

    it('should reject when save lock cannot be acquired after retries', async () => {
        const lockSpy = jest.spyOn(storage.lock, 'acquireLock').mockResolvedValue(false);
        const warnSpy = jest.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => {});
        const sleepSpy = jest.spyOn(
            storage as unknown as { sleep: (ms: number) => Promise<void> },
            'sleep',
        ).mockResolvedValue(undefined);

        // Each retry attempt needs 2 Date.now() calls:
        //   call 1: deadline = Date.now() + SAVE_LOCK_WAIT_MS
        //   call 2: if (Date.now() >= deadline) — returns a value past deadline to break inner loop
        // With MAX_RETRY_ATTEMPTS=3 → 4 total iterations (retry=0,1,2,3) → 8 Date.now() calls
        let callCount = 0;
        const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
            callCount++;
            return callCount <= 1 ? 0
                : callCount <= 2 ? 30001
                : callCount <= 3 ? 30001
                : callCount <= 4 ? 60001
                : callCount <= 5 ? 60001
                : callCount <= 6 ? 90001
                : callCount <= 7 ? 90001
                : 120001;
        });

        await expect((storage as never as { withSaveLock: (operation: () => Promise<void>) => Promise<void> })
            .withSaveLock(async () => undefined))
            .rejects
            .toThrow('Could not acquire metadata cache save lock');

        // Should have logged 3 retry warnings (attempt 1/4, 2/4, 3/4)
        expect(warnSpy).toHaveBeenCalledTimes(3);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Save lock timeout (attempt 1/4)'));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Save lock timeout (attempt 2/4)'));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Save lock timeout (attempt 3/4)'));

        lockSpy.mockRestore();
        sleepSpy.mockRestore();
        nowSpy.mockRestore();
        warnSpy.mockRestore();
    });

    it('advances generation when clear runs after a pending save', async () => {
        populateCache('conn1');

        await Promise.all([
            storage.saveConnection(cache, 'conn1', Date.now()),
            storage.deleteCacheFile(),
        ]);

        expect(fs.existsSync(getCacheV3Dir(tempDir))).toBe(true);
        expect(fs.existsSync(getV3IndexPath(tempDir))).toBe(true);
        expect((await storage.readV3Index())?.generation).toBeGreaterThan(1);
    });

    it('should evict oldest when more than 10 connections (E13)', async () => {
        const storageNoConn = new MetadataDiskStorage(tempDir);
        const index = {
            schemaVersion: CACHE_SCHEMA_VERSION,
            writtenAt: Date.now(),
            connections: {} as Record<string, { prefetchCompletedAt: number; connectionFingerprint: string; columnDatabases: string[] }>,
        };
        for (let i = 0; i < 11; i++) {
            index.connections[`conn${i}`] = {
                prefetchCompletedAt: i * 1000,
                connectionFingerprint: 'fp',
                columnDatabases: ['DB1'],
            };
        }
        storageNoConn.applyEvictionToIndex(index);
        expect(Object.keys(index.connections)).toHaveLength(10);
        expect(index.connections.conn0).toBeUndefined();
    });

    it('should evict orphan connections older than 30 days (E14)', () => {
        const storageWithConn = new MetadataDiskStorage(tempDir, {
            getConnectionNames: () => ['conn1'],
            getConnectionMetadata: () => undefined,
        } as never);
        const index = {
            schemaVersion: CACHE_SCHEMA_VERSION,
            writtenAt: Date.now(),
            connections: {} as Record<string, { prefetchCompletedAt: number; connectionFingerprint: string; columnDatabases: string[] }>,
        };
        const oldTs = Date.now() - ORPHAN_MAX_AGE_MS - 1000;
        index.connections.orphan = {
            prefetchCompletedAt: oldTs,
            connectionFingerprint: 'fp',
            columnDatabases: ['DB1'],
        };
        index.connections.conn1 = {
            prefetchCompletedAt: Date.now(),
            connectionFingerprint: 'fp',
            columnDatabases: ['DB1'],
        };
        storageWithConn.applyEvictionToIndex(index);
        expect(index.connections.orphan).toBeUndefined();
        expect(index.connections.conn1).toBeDefined();
    });

    it('resets generation and removes payload files', async () => {
        populateCache('conn1');
        await storage.saveConnection(cache, 'conn1', Date.now());
        await storage.deleteCacheFile();
        expect(fs.existsSync(getV3IndexPath(tempDir))).toBe(true);
        expect(fs.existsSync(getV3ConnectionMetadataPath(tempDir, 'conn1'))).toBe(false);
    });

    it('legacy loadSerialized still reads v1 file', async () => {
        const legacy = createEmptySerializedCache();
        legacy.schemaVersion = LEGACY_CACHE_SCHEMA_VERSION;
        legacy.connections.conn1 = {
            prefetchCompletedAt: Date.now(),
            connectionFingerprint: fingerprint,
            database: { timestamp: 1, data: [{ DATABASE: 'DB1' }] },
            schema: { DB1: { timestamp: 1, data: [{ SCHEMA: 'S1' }] } },
            table: { 'DB1.S1': { timestamp: 1, data: [{ OBJNAME: 'T1', SCHEMA: 'S1', OBJID: 1 }] } },
            procedure: { 'DB1..': { timestamp: 1, data: [{ PROCEDURE: 'P1' }] } },
            column: { 'DB1.S1.T1': { timestamp: 1, data: [{ ATTNAME: 'C1', FORMAT_TYPE: 'INT' }] } },
            typeGroup: { DB1: { timestamp: 1, data: ['TABLE'] } },
        };
        const { gzipSync } = require('zlib');
        fs.writeFileSync(
            path.join(tempDir, LEGACY_CACHE_FILE_NAME),
            gzipSync(Buffer.from(JSON.stringify(legacy))),
        );

        const loaded = await storage.loadSerialized();
        expect(loaded?.connections.conn1).toBeDefined();
    });

    it('should disable session on ENOSPC (E4)', async () => {
        // Only mock data file writes (paths ending in .tmp from writeGzipJson)
        // to reject with ENOSPC. Lock file writes must succeed so the save lock
        // can be acquired, otherwise withSaveLock spins in its retry loop (~120s).
        // IMPORTANT: capture original BEFORE jest.spyOn to avoid infinite recursion.
        const realWriteFile = fs.promises.writeFile;
        const writeFile = jest.spyOn(fs.promises, 'writeFile').mockImplementation(
            ((path: string | URL | Buffer, ...args: unknown[]) => {
                const pathStr = typeof path === 'string' ? path : String(path);
                if (pathStr.endsWith('.lock')) {
                    return (realWriteFile as unknown as (...a: unknown[]) => Promise<void>)(path, ...args);
                }
                return Promise.reject(Object.assign(new Error('no space'), { code: 'ENOSPC' }));
            }) as typeof fs.promises.writeFile,
        );
        try {
            populateCache('conn1');
            await expect(storage.saveConnection(cache, 'conn1', Date.now())).rejects.toThrow('no space');
            expect(storage.isSessionDisabled()).toBe(true);
            expect(storage.lock.hasOwnedLock('conn1')).toBe(false);
        } finally {
            writeFile.mockRestore();
        }
    });
});
