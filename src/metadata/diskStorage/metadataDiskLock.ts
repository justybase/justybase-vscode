/**
 * Cooperative per-connection prefetch lock files (async fs.promises, O_EXCL).
 *
 * Phase 1: Heartbeat-based lock renewal to prevent redundant prefetches
 * during long-running metadata fetch operations across VS Code windows.
 * Phase 6: Converted from sync fs to fs.promises for consistency.
 *
 * Design:
 * - Lock owner writes a heartbeat timestamp every 45s, proving liveness.
 * - Staleness check uses lastHeartbeatAt (or startedAt for legacy locks).
 * - PID check via process.kill(pid, 0) allows instant crash recovery.
 * - LOCK_TTL_MS (135s) = 3 × HEARTBEAT_INTERVAL_MS acts as the backstop.
 */

import * as fs from 'fs';
import * as path from 'path';

/** How often the lock owner refreshes its heartbeat timestamp (45 seconds). */
export const HEARTBEAT_INTERVAL_MS = 45_000;

/**
 * How long since the last heartbeat before a lock is considered stale.
 * 135s = 3 × HEARTBEAT_INTERVAL_MS, giving ~2 missed heartbeats before takeover.
 * This is shorter than the old fixed 5 min TTL, so crash recovery is faster.
 */
export const LOCK_TTL_MS = 3 * HEARTBEAT_INTERVAL_MS;

const LOCK_PREFIX = 'metadata-cache-';
const LOCK_SUFFIX = '.lock';

export function sanitizeConnectionNameForLock(connectionName: string): string {
    return connectionName.replace(/[/\\:*?"<>|]/g, '_');
}

export function getLockFileName(connectionName: string): string {
    return `${LOCK_PREFIX}${sanitizeConnectionNameForLock(connectionName)}${LOCK_SUFFIX}`;
}

interface LockFileContent {
    pid: number;
    startedAt: number;
    /** Timestamp of the last heartbeat write. Optional for backward compatibility. */
    lastHeartbeatAt?: number;
}

/**
 * Check whether a process is alive by sending signal 0.
 * Returns true if the PID exists and we have permission to signal it.
 * Returns false only for ESRCH (no such process).
 * EPERM/EACCES means the process exists but we can't signal it — treat as alive.
 */
function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException)?.code;
        return code !== 'ESRCH';
    }
}

export class MetadataDiskLock {
    private readonly ownedLocks = new Set<string>();
    private readonly heartbeatTimers = new Map<string, NodeJS.Timeout>();

    constructor(private readonly storageDir: string) {}

    getLockPath(connectionName: string): string {
        return path.join(this.storageDir, getLockFileName(connectionName));
    }

    /**
     * Periodically rewrite the lock file with an updated `lastHeartbeatAt`.
     * Silently no-ops if the connection lock is no longer owned, or stops the
     * heartbeat on I/O error (lock file deleted externally).
     */
    private async renewLock(connectionName: string): Promise<void> {
        if (!this.ownedLocks.has(connectionName)) {
            return;
        }
        const lockPath = this.getLockPath(connectionName);
        try {
            const startedAt = (await this.readStartedAt(lockPath)) ?? Date.now();
            const content: LockFileContent = {
                pid: process.pid,
                startedAt,
                lastHeartbeatAt: Date.now(),
            };
            await fs.promises.writeFile(lockPath, JSON.stringify(content), 'utf8');
        } catch {
            // File may have been deleted (releaseLock) between check and write.
            // Stop the timer to avoid repeated failures.
            this.stopHeartbeat(connectionName);
        }
    }

    /**
     * Read the `startedAt` from an existing lock file on disk.
     */
    private async readStartedAt(lockPath: string): Promise<number | undefined> {
        try {
            const raw = await fs.promises.readFile(lockPath, 'utf8');
            const parsed = JSON.parse(raw) as LockFileContent;
            return typeof parsed.startedAt === 'number' ? parsed.startedAt : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Start a periodic heartbeat timer for the given connection lock.
     * Stops any previously running heartbeat for the same connection first.
     * The initial heartbeat is written immediately (fire-and-forget).
     */
    startHeartbeat(connectionName: string, intervalMs: number = HEARTBEAT_INTERVAL_MS): void {
        this.stopHeartbeat(connectionName);
        const timer = setInterval(() => {
            this.renewLock(connectionName).catch(() => this.stopHeartbeat(connectionName));
        }, intervalMs);
        this.heartbeatTimers.set(connectionName, timer);
        // Write the first heartbeat immediately (no need to wait 45s).
        this.renewLock(connectionName).catch(() => { /* best-effort */ });
    }

    /**
     * Stop the heartbeat timer for the given connection, if running.
     */
    stopHeartbeat(connectionName: string): void {
        const timer = this.heartbeatTimers.get(connectionName);
        if (timer) {
            clearInterval(timer);
            this.heartbeatTimers.delete(connectionName);
        }
    }

    /**
     * Check whether this instance currently owns the lock for the given connection.
     */
    hasOwnedLock(connectionName: string): boolean {
        return this.ownedLocks.has(connectionName);
    }

    /**
     * Attempt to acquire the prefetch lock for a connection.
     *
     * Returns true if:
     *  - The lock file was created successfully (no existing lock), OR
     *  - The previous owner's PID is dead (instant crash recovery), OR
     *  - The lock is stale (no heartbeat for > LOCK_TTL_MS).
     *
     * Returns false if another process holds a valid lock.
     */
    async acquireLock(connectionName: string, lockTtlMs: number = LOCK_TTL_MS): Promise<boolean> {
        const lockPath = this.getLockPath(connectionName);
        const lockContent: LockFileContent = {
            pid: process.pid,
            startedAt: Date.now(),
            lastHeartbeatAt: Date.now(),
        };

        const tryCreate = async (): Promise<boolean> => {
            try {
                await fs.promises.writeFile(lockPath, JSON.stringify(lockContent), { flag: 'wx' });
                this.ownedLocks.add(connectionName);
                return true;
            } catch (error: unknown) {
                const code = (error as NodeJS.ErrnoException)?.code;
                if (code !== 'EEXIST') {
                    return false;
                }
                return false;
            }
        };

        // Fast path: no existing lock file.
        if (await tryCreate()) {
            return true;
        }

        // Read existing lock file to decide whether to steal.
        try {
            const existingRaw = await fs.promises.readFile(lockPath, 'utf8');
            const existing = JSON.parse(existingRaw) as LockFileContent;

            if (typeof existing.pid !== 'number' || typeof existing.startedAt !== 'number') {
                // Corrupted or unknown format — remove and retry.
                try { await fs.promises.unlink(lockPath); } catch { /* ignore */ }
                return tryCreate();
            }

            // Phase 1b: PID check — if the owning process is dead, steal immediately.
            if (!isProcessAlive(existing.pid)) {
                try { await fs.promises.unlink(lockPath); } catch { /* ignore */ }
                return tryCreate();
            }

            // Backward-compatible staleness check:
            // - New lock files have `lastHeartbeatAt` written periodically.
            // - Legacy lock files (from before heartbeat) have only `startedAt`.
            const lastSeen = existing.lastHeartbeatAt ?? existing.startedAt;
            if (lastSeen > Date.now() - lockTtlMs) {
                return false; // Lock is still valid.
            }

            // Lock is stale — fall through to remove and retry.
        } catch {
            // Lock file missing or unreadable — try again fresh.
        }

        try {
            await fs.promises.unlink(lockPath);
        } catch {
            return false;
        }

        return tryCreate();
    }

    /**
     * Release the lock for the given connection.
     * Stops the heartbeat timer synchronously, then deletes the lock file asynchronously.
     */
    async releaseLock(connectionName: string): Promise<void> {
        // Stop heartbeat synchronously before any I/O — this is the critical
        // ordering guarantee: once releaseLock starts, no more heartbeats.
        this.stopHeartbeat(connectionName);

        if (!this.ownedLocks.has(connectionName)) {
            return;
        }
        try {
            await fs.promises.unlink(this.getLockPath(connectionName));
        } catch {
            // Best-effort
        }
        this.ownedLocks.delete(connectionName);
    }

    /**
     * Release all owned locks and stop all heartbeat timers.
     */
    async releaseAllOwned(): Promise<void> {
        const names = [...this.ownedLocks];
        await Promise.all(names.map((name) => this.releaseLock(name)));
    }

    /**
     * Delete all lock files on disk (including unowned ones) and clear all state.
     * This is called during full cache teardown (clearCache / dispose).
     */
    async deleteAllLockFiles(): Promise<void> {
        // Stop all heartbeat timers first.
        for (const name of [...this.heartbeatTimers.keys()]) {
            this.stopHeartbeat(name);
        }
        try {
            const entries = await fs.promises.readdir(this.storageDir);
            const lockFiles = entries.filter(
                (e) => e.startsWith(LOCK_PREFIX) && e.endsWith(LOCK_SUFFIX),
            );
            await Promise.all(
                lockFiles.map((e) =>
                    fs.promises.unlink(path.join(this.storageDir, e)).catch(() => {
                        /* best-effort */
                    }),
                ),
            );
        } catch {
            // Directory may not exist or other errors — best-effort
        }
        this.ownedLocks.clear();
    }
}
