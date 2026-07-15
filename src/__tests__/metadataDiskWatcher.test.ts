/**
 * Tests for MetadataDiskIndexWatcher — cross-window cache sync.
 *
 * These tests use a temporary directory and write real v3 index files
 * to verify change detection, initial sync, and lifecycle.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MetadataDiskIndexWatcher } from '../metadata/diskStorage/metadataDiskWatcher';
import {
    createEmptyV3Index,
    type V3DiskIndex,
} from '../metadata/diskStorage/metadataDiskTypes';
import { getV3IndexPath, getCacheV3Dir } from '../metadata/diskStorage/metadataDiskPaths';

// Helper to write a compressed index file (simplified — just write JSON, not gzip)
function writeIndex(storageDir: string, index: V3DiskIndex): void {
    const v3Dir = getCacheV3Dir(storageDir);
    if (!fs.existsSync(v3Dir)) {
        fs.mkdirSync(v3Dir, { recursive: true });
    }
    fs.writeFileSync(getV3IndexPath(storageDir), JSON.stringify(index), 'utf8');
}

function createIndex(connections: Record<string, number>): V3DiskIndex {
    const index = createEmptyV3Index();
    for (const [name, prefetchCompletedAt] of Object.entries(connections)) {
        index.connections[name] = {
            prefetchCompletedAt,
            connectionFingerprint: 'test-fp',
            columnDatabases: ['DB1'],
        };
    }
    return index;
}

describe('MetadataDiskIndexWatcher', () => {
    let tmpDir: string;
    let watcher: MetadataDiskIndexWatcher;
    const updatedConnections: string[] = [];
    const errors: Error[] = [];

    function onUpdated(names: string[]): void {
        updatedConnections.push(...names);
    }

    function onError(err: Error): void {
        errors.push(err);
    }

    beforeEach(() => {
        const tmpBase = process.env.TEMP || '/tmp';
        tmpDir = fs.mkdtempSync(path.join(tmpBase, 'mdw-test-'));
        updatedConnections.length = 0;
        errors.length = 0;
    });

    afterEach(() => {
        watcher?.stop();
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup
        }
    });

    describe('initialization', () => {
        it('should start inactive and become active after start()', async () => {
            watcher = new MetadataDiskIndexWatcher(tmpDir, onUpdated, onError);
            expect(watcher.active).toBe(false);
            await watcher.start();
            expect(watcher.active).toBe(true);
        });

        it('should stop and become inactive after dispose', async () => {
            watcher = new MetadataDiskIndexWatcher(tmpDir, onUpdated, onError);
            await watcher.start();
            watcher.stop();
            expect(watcher.active).toBe(false);
        });

        it('should be safe to call start()/stop() multiple times', async () => {
            watcher = new MetadataDiskIndexWatcher(tmpDir, onUpdated, onError);
            await watcher.start();
            await watcher.start(); // no-op
            expect(watcher.active).toBe(true);
            watcher.stop();
            watcher.stop(); // no-op
            expect(watcher.active).toBe(false);
        });
    });

    describe('change detection', () => {
        it('should detect a new connection appearing in the index', async () => {
            const now = Date.now();
            writeIndex(tmpDir, createIndex({}));
            watcher = new MetadataDiskIndexWatcher(tmpDir, onUpdated, onError);
            await watcher.start();

            // No changes initially (empty index → no connections to report)
            expect(updatedConnections).toEqual([]);

            // Simulate another window writing a connection
            const laterIndex = createEmptyV3Index();
            laterIndex.connections.conn1 = {
                prefetchCompletedAt: now,
                connectionFingerprint: 'fp',
                columnDatabases: [],
            };
            laterIndex.writtenAt = now;
            writeIndex(tmpDir, laterIndex);

            const changed = await watcher.checkForChanges();
            expect(changed).toEqual(['conn1']);
        });

        it('should detect an updated prefetchCompletedAt', async () => {
            const now = Date.now();
            writeIndex(tmpDir, createIndex({ conn1: now - 10_000 }));
            watcher = new MetadataDiskIndexWatcher(tmpDir, onUpdated, onError);
            await watcher.start();

            // Update the timestamp
            const updatedIndex = createIndex({ conn1: now });
            updatedIndex.writtenAt = now;
            writeIndex(tmpDir, updatedIndex);

            const changed = await watcher.checkForChanges();
            expect(changed).toEqual(['conn1']);
        });

        it('should NOT report unchanged connections', async () => {
            const now = Date.now();
            writeIndex(tmpDir, createIndex({ conn1: now }));
            watcher = new MetadataDiskIndexWatcher(tmpDir, onUpdated, onError);
            await watcher.start();

            // Rewrite with the same timestamp — should NOT trigger
            writeIndex(tmpDir, createIndex({ conn1: now }));
            const changed = await watcher.checkForChanges();
            expect(changed).toEqual([]);
        });

        it('should report multiple changed connections', async () => {
            const now = Date.now();
            writeIndex(tmpDir, createIndex({ conn1: now - 10_000, conn2: now - 10_000 }));
            watcher = new MetadataDiskIndexWatcher(tmpDir, onUpdated, onError);
            await watcher.start();

            const updatedIndex = createIndex({ conn1: now, conn2: now });
            updatedIndex.writtenAt = now;
            writeIndex(tmpDir, updatedIndex);

            const changed = await watcher.checkForChanges();
            expect(changed).toContain('conn1');
            expect(changed).toContain('conn2');
            expect(changed.length).toBe(2);
        });
    });

    describe('initial sync', () => {
        it('should NOT report connections that existed at start with same timestamp', async () => {
            const now = Date.now();
            writeIndex(tmpDir, createIndex({ conn1: now }));
            watcher = new MetadataDiskIndexWatcher(tmpDir, onUpdated, onError);
            await watcher.start();

            // Rewrite with the exact same timestamp — should not trigger
            writeIndex(tmpDir, createIndex({ conn1: now }));
            const changed = await watcher.checkForChanges();
            expect(changed).toEqual([]);
        });
    });

    describe('markConnection', () => {
        it('should update known timestamps to prevent redundant detection', async () => {
            const now = Date.now();
            writeIndex(tmpDir, createIndex({ conn1: now }));
            watcher = new MetadataDiskIndexWatcher(tmpDir, onUpdated, onError);
            await watcher.start();

            // Advance the watcher's known timestamp to be the same as what we'll write
            watcher.markConnection('conn1', now);

            // Write the same timestamp — should not trigger
            writeIndex(tmpDir, createIndex({ conn1: now }));
            const changed = await watcher.checkForChanges();
            expect(changed).toEqual([]);
        });
    });

    describe('error handling', () => {
        it('should not throw when index file does not exist', async () => {
            watcher = new MetadataDiskIndexWatcher(tmpDir, onUpdated, onError);
            await watcher.start();

            const changed = await watcher.checkForChanges();
            expect(changed).toEqual([]);
            expect(errors).toEqual([]);
        });

        it('should handle corrupted index file gracefully', async () => {
            const v3Dir = getCacheV3Dir(tmpDir);
            if (!fs.existsSync(v3Dir)) {
                fs.mkdirSync(v3Dir, { recursive: true });
            }
            fs.writeFileSync(getV3IndexPath(tmpDir), 'not-valid-json', 'utf8');

            watcher = new MetadataDiskIndexWatcher(tmpDir, onUpdated, onError);
            await watcher.start();

            const changed = await watcher.checkForChanges();
            expect(changed).toEqual([]);
            expect(errors).toEqual([]);
        });

        it('should handle index with wrong schema version', async () => {
            const badIndex = createEmptyV3Index();
            badIndex.schemaVersion = 999;
            badIndex.connections.conn1 = {
                prefetchCompletedAt: Date.now(),
                connectionFingerprint: 'fp',
                columnDatabases: [],
            };
            writeIndex(tmpDir, badIndex);

            watcher = new MetadataDiskIndexWatcher(tmpDir, onUpdated, onError);
            await watcher.start();

            const changed = await watcher.checkForChanges();
            expect(changed).toEqual([]);
        });
    });
});
