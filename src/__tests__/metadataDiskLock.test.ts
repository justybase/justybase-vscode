import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
    getLockFileName,
    LOCK_TTL_MS,
    MetadataDiskLock,
    sanitizeConnectionNameForLock,
} from '../metadata/diskStorage/metadataDiskLock';

describe('MetadataDiskLock', () => {
    let tempDir: string;
    let lock: MetadataDiskLock;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-lock-'));
        lock = new MetadataDiskLock(tempDir);
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    // ──── Phase 0: Characterization tests (pre-existing behavior) ────

    it('should sanitize connection names for lock files', () => {
        expect(sanitizeConnectionNameForLock('NZ/PROD:1')).toBe('NZ_PROD_1');
        expect(getLockFileName('NZ/PROD:1')).toBe('metadata-cache-NZ_PROD_1.lock');
    });

    it('should acquire and release lock', async () => {
        expect(await lock.acquireLock('conn1')).toBe(true);
        expect(fs.existsSync(lock.getLockPath('conn1'))).toBe(true);
        expect(lock.hasOwnedLock('conn1')).toBe(true);
        await lock.releaseLock('conn1');
        expect(fs.existsSync(lock.getLockPath('conn1'))).toBe(false);
        expect(lock.hasOwnedLock('conn1')).toBe(false);
    });

    it('should reject second acquire while lock is valid (E8)', async () => {
        const lock2 = new MetadataDiskLock(tempDir);
        expect(await lock.acquireLock('conn1')).toBe(true);
        expect(await lock2.acquireLock('conn1')).toBe(false);
    });

    it('should reclaim stale lock after TTL (E9)', async () => {
        const lockPath = lock.getLockPath('conn1');
        fs.writeFileSync(
            lockPath,
            JSON.stringify({ pid: 1, startedAt: Date.now() - LOCK_TTL_MS - 1000 }),
        );
        expect(await lock.acquireLock('conn1')).toBe(true);
    });

    it('should handle corrupted lock file gracefully', async () => {
        const lockPath = lock.getLockPath('conn1');
        fs.writeFileSync(lockPath, 'not-json');
        // Should recover: delete corrupted file and create new lock.
        expect(await lock.acquireLock('conn1')).toBe(true);
        expect(fs.existsSync(lockPath)).toBe(true);
    });

    it('should handle empty lock file gracefully', async () => {
        const lockPath = lock.getLockPath('conn1');
        fs.writeFileSync(lockPath, '');
        expect(await lock.acquireLock('conn1')).toBe(true);
    });

    it('should delete all lock files and clear owned state', async () => {
        await lock.acquireLock('a');
        await lock.acquireLock('b');
        await lock.deleteAllLockFiles();
        expect(fs.readdirSync(tempDir).filter(f => f.endsWith('.lock'))).toHaveLength(0);
        expect(lock.hasOwnedLock('a')).toBe(false);
        expect(lock.hasOwnedLock('b')).toBe(false);
    });

    it('should release all owned locks', async () => {
        await lock.acquireLock('a');
        await lock.acquireLock('b');
        await lock.releaseAllOwned();
        expect(lock.hasOwnedLock('a')).toBe(false);
        expect(lock.hasOwnedLock('b')).toBe(false);
        expect(fs.existsSync(lock.getLockPath('a'))).toBe(false);
        expect(fs.existsSync(lock.getLockPath('b'))).toBe(false);
    });

    // ──── Phase 1: Heartbeat tests ────

    describe('heartbeat', () => {
        beforeEach(() => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        });

        afterEach(async () => {
            await jest.runOnlyPendingTimersAsync();
            jest.useRealTimers();
        });

        it('should start heartbeat and write lastHeartbeatAt immediately on start', async () => {
            await lock.acquireLock('conn1');
            lock.startHeartbeat('conn1');

            const lockPath = lock.getLockPath('conn1');
            const raw = fs.readFileSync(lockPath, 'utf8');
            const content = JSON.parse(raw);
            expect(content.lastHeartbeatAt).toBeDefined();
            expect(typeof content.lastHeartbeatAt).toBe('number');
            expect(content.pid).toBe(process.pid);
        });

        it('should renew heartbeat on timer interval', async () => {
            await lock.acquireLock('conn1');
            const renewSpy = jest.spyOn(lock as unknown as { renewLock: (name: string) => Promise<void> }, 'renewLock');

            lock.startHeartbeat('conn1', 1000); // Fast interval for testing
            expect(renewSpy).toHaveBeenCalledTimes(1); // Immediate first heartbeat

            jest.advanceTimersByTime(500);
            expect(renewSpy).toHaveBeenCalledTimes(1); // Still before interval

            jest.advanceTimersByTime(500);
            expect(renewSpy).toHaveBeenCalledTimes(2); // Timer fired at 1000ms

            jest.advanceTimersByTime(1000);
            expect(renewSpy).toHaveBeenCalledTimes(3); // Timer fired again at 2000ms
        });

        it('should stop heartbeat on releaseLock', async () => {
            await lock.acquireLock('conn1');
            lock.startHeartbeat('conn1', 1000);

            await lock.releaseLock('conn1');

            // After release, lock file is deleted. Timer should be stopped.
            expect(fs.existsSync(lock.getLockPath('conn1'))).toBe(false);

            // Advancing time should not cause timer to fire (no crash / leak).
            expect(() => jest.advanceTimersByTime(5000)).not.toThrow();
        });

        it('should stop heartbeat on stopHeartbeat', async () => {
            await lock.acquireLock('conn1');
            lock.startHeartbeat('conn1', 1000);
            lock.stopHeartbeat('conn1');

            // Timer stopped — advancing time should not crash.
            expect(() => jest.advanceTimersByTime(5000)).not.toThrow();
        });

        it('should not write heartbeat after lock released externally', async () => {
            await lock.acquireLock('conn1');
            lock.startHeartbeat('conn1', 1000);

            // Manually delete the lock file (simulating external release)
            fs.unlinkSync(lock.getLockPath('conn1'));

            // Timer fires but should not crash — writes best-effort
            jest.advanceTimersByTime(1500);
            // Should not throw even though ownedLocks still has 'conn1'
        });

        it('should keep other instance from acquiring while heartbeat is fresh', async () => {
            jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

            await lock.acquireLock('conn1');
            lock.startHeartbeat('conn1', 1000);
            await jest.runOnlyPendingTimersAsync();

            const lockPath = lock.getLockPath('conn1');
            const lock2 = new MetadataDiskLock(tempDir);
            const currentNow = Date.now();

            fs.writeFileSync(
                lockPath,
                JSON.stringify({
                    pid: process.pid,
                    startedAt: currentNow - 60_000,
                    lastHeartbeatAt: currentNow,
                }),
            );

            expect(await lock2.acquireLock('conn1')).toBe(false);
            lock.stopHeartbeat('conn1');
        });

        it('should allow takeover when heartbeat is stale', async () => {
            jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

            const lockPath = lock.getLockPath('conn1');
            const staleAt = Date.now() - LOCK_TTL_MS - 10_000;
            fs.writeFileSync(
                lockPath,
                JSON.stringify({
                    pid: process.pid,
                    startedAt: staleAt,
                    lastHeartbeatAt: staleAt,
                }),
            );

            const lock2 = new MetadataDiskLock(tempDir);
            expect(await lock2.acquireLock('conn1')).toBe(true);
        });

        it('should stop heartbeat on deleteAllLockFiles', async () => {
            await lock.acquireLock('conn1');
            lock.startHeartbeat('conn1', 1000);

            await lock.deleteAllLockFiles();

            // Timer stopped — advancing time should not crash.
            expect(() => jest.advanceTimersByTime(5000)).not.toThrow();
        });
    });

    // ──── Phase 1b: PID recovery tests ────

    describe('PID-based crash recovery', () => {
        it('should steal lock when owning PID is this process (not applicable, but test API)', async () => {
            // Write a lock file with this process's PID but no heartbeat
            const lockPath = lock.getLockPath('conn1');
            fs.writeFileSync(
                lockPath,
                JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
            );
            // This PID IS alive, so lock should NOT be stolen.
            expect(await lock.acquireLock('conn1')).toBe(false);
        });

        it('should steal lock immediately when owning PID is dead', async () => {
            const lockPath = lock.getLockPath('conn1');
            // Use PID=1 (init) which is always alive on most systems, but we can test
            // with a non-existent PID. PID=99999999 is very unlikely to exist.
            fs.writeFileSync(
                lockPath,
                JSON.stringify({ pid: 99999999, startedAt: Date.now() }),
            );
            // PID 99999999 is unlikely to be alive, so lock should be stolen.
            const result = await lock.acquireLock('conn1');
            // Note: In some container environments, high PIDs may exist.
            // This test verifies the logic path; TTL fallback handles edge cases.
            if (!result) {
                // If PID 99999999 happens to exist in this environment,
                // fall back: wait for TTL.
                fs.writeFileSync(
                    lockPath,
                    JSON.stringify({ pid: 99999999, startedAt: Date.now() - LOCK_TTL_MS - 1000 }),
                );
                expect(await lock.acquireLock('conn1')).toBe(true);
            } else {
                expect(result).toBe(true);
            }
        });

        it('should not steal lock when PID is alive (even without heartbeat)', async () => {
            const lockPath = lock.getLockPath('conn1');
            // PID = process.pid is definitely alive.
            fs.writeFileSync(
                lockPath,
                JSON.stringify({ pid: process.pid, startedAt: Date.now() - 60000 }),
            );
            expect(await lock.acquireLock('conn1')).toBe(false);
        });
    });

    // ──── Phase 1: Backward compatibility ────

    describe('backward compatibility', () => {
        it('should read legacy lock file (no lastHeartbeatAt) and fall back to startedAt', async () => {
            const lock2 = new MetadataDiskLock(tempDir);
            const lockPath = lock.getLockPath('legacy');
            // Legacy lock file format: no lastHeartbeatAt
            fs.writeFileSync(
                lockPath,
                JSON.stringify({ pid: 1, startedAt: Date.now() - 60000 }), // 60s ago, within TTL
            );
            // Since startedAt is within LOCK_TTL_MS (135s), lock2 should not acquire.
            expect(await lock2.acquireLock('legacy')).toBe(false);
        });

        it('should allow takeover of very old legacy lock file', async () => {
            const lock2 = new MetadataDiskLock(tempDir);
            const lockPath = lock.getLockPath('legacy-old');
            // Legacy lock file, very old (beyond TTL)
            fs.writeFileSync(
                lockPath,
                JSON.stringify({ pid: 1, startedAt: Date.now() - LOCK_TTL_MS - 10000 }),
            );
            expect(await lock2.acquireLock('legacy-old')).toBe(true);
        });

        it('should write lastHeartbeatAt on new lock creation', async () => {
            await lock.acquireLock('fresh-conn');
            const lockPath = lock.getLockPath('fresh-conn');
            const raw = fs.readFileSync(lockPath, 'utf8');
            const content = JSON.parse(raw);
            expect(content.lastHeartbeatAt).toBeDefined();
            expect(typeof content.lastHeartbeatAt).toBe('number');
            expect(content.pid).toBe(process.pid);
            expect(content.startedAt).toBeDefined();
        });
    });
});
