import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AccessFileFormat } from '@justybase/access-file';

interface HeldFileLock {
    readonly lockKey: string;
    refCount: number;
    readonly releasePromise: Promise<() => Promise<void>>;
}

/**
 * In-process lock holders keyed by lock file path. Multiple connections in
 * the same extension process (the user's persistent connection plus the
 * short-lived connection used by metadata refresh / schema search) share one
 * lock file; the file is closed and removed only when the last holder
 * releases it. Cross-process conflicts still fail with EEXIST.
 */
const heldFileLocks = new Map<string, HeldFileLock>();

const OWNER_APP = 'justybase';
const OWNER_SUFFIX = '.justybase-lock.json';
const STALE_SUFFIX = '.stale-';

/** Metadata written next to the Access lock file while JustyBase owns it. */
export interface AccessLockOwner {
    readonly app: string;
    readonly pid: number;
    readonly host: string;
    readonly startedAt: string;
    readonly database: string;
    readonly lockPath: string;
}

export type AccessLockClearReason =
    | 'cleared'
    | 'missing'
    | 'live-owner'
    | 'held'
    | 'not-a-database';

export interface AccessLockClearResult {
    readonly cleared: boolean;
    readonly reason: AccessLockClearReason;
    readonly lockPath?: string;
    readonly owner?: AccessLockOwner;
}

function accessFileLockKey(lockPath: string): string {
    const resolved = path.resolve(lockPath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isAccdbFormat(format: AccessFileFormat): boolean {
    return format === 'accdb2007'
        || format === 'accdb2010'
        || format === 'accdb2013'
        || format === 'accdb2016'
        || format === 'accdb2019';
}

/** The Access-compatible lock path (`.ldb` for MDB, `.laccdb` for ACCDB). */
export function accessLockPath(databasePath: string, format: AccessFileFormat): string {
    return databasePath.replace(/\.(?:mdb|accdb)$/i, '') + (isAccdbFormat(format) ? '.laccdb' : '.ldb');
}

/** Sidecar with the owning process; never written into the Access lock file. */
export function accessLockOwnerPath(databasePath: string): string {
    return `${path.resolve(databasePath)}${OWNER_SUFFIX}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readAccessLockOwner(databasePath: string): Promise<AccessLockOwner | undefined> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(await fs.readFile(accessLockOwnerPath(databasePath), 'utf8'));
    } catch {
        return undefined;
    }
    if (!isRecord(parsed) || parsed.app !== OWNER_APP) return undefined;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return undefined;
    if (typeof parsed.host !== 'string' || parsed.host.length === 0) return undefined;
    if (typeof parsed.startedAt !== 'string' || parsed.startedAt.length === 0) return undefined;
    return {
        app: OWNER_APP,
        pid: parsed.pid,
        host: parsed.host,
        startedAt: parsed.startedAt,
        database: typeof parsed.database === 'string' ? parsed.database : '',
        lockPath: typeof parsed.lockPath === 'string' ? parsed.lockPath : '',
    };
}

/**
 * Best-effort liveness probe. EPERM means the process exists but belongs to
 * another user; only ESRCH proves that the PID is gone.
 */
export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

function isFileExistsError(error: unknown): boolean {
    return isRecord(error) && error.code === 'EEXIST';
}

function lockedError(
    databasePath: string,
    lockPath: string,
    cause: unknown,
    owner: AccessLockOwner | undefined,
): Error {
    const holder = owner
        ? owner.host === os.hostname()
            ? ` Process ${owner.pid} on this machine (started ${owner.startedAt}) holds it.`
            : ` Process ${owner.pid} on '${owner.host}' holds it.`
        : ' Microsoft Access or another process may hold it.';
    const staleHint = ' If Microsoft Access and every JustyBase window are closed, the lock may be stale: run "JustyBase Access: Clear Stale Lock File".';
    return new Error(
        `The database '${databasePath}' is already open by another process (lock file '${lockPath}' exists).`
        + `${holder}${staleHint} Close the other process or open this connection as read-only.`,
        { cause },
    );
}

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Moves a lock file out of the way. Windows refuses the rename while Access
 * (or another process) keeps the file open without delete sharing, which is
 * exactly the gate that makes this safe to attempt before a takeover.
 */
async function takeOverLock(lockPath: string, ownerPath: string): Promise<boolean> {
    const tombstone = `${lockPath}${STALE_SUFFIX}${randomBytes(6).toString('hex')}`;
    try {
        await fs.rename(lockPath, tombstone);
    } catch {
        return false;
    }
    await fs.rm(tombstone, { force: true }).catch(() => undefined);
    await fs.rm(ownerPath, { force: true }).catch(() => undefined);
    return true;
}

function lockCandidates(databasePath: string): string[] {
    const base = databasePath.replace(/\.(?:mdb|accdb)$/i, '');
    return [`${base}.laccdb`, `${base}.ldb`];
}

/**
 * Creates the Access lock file and records the owning process next to it.
 * A stale lock left by a crashed JustyBase process on this host is reclaimed
 * automatically; locks from Access or from another host are never removed
 * here and require the explicit `clearStaleAccessLock` command.
 */
export async function acquireAccessFileLock(
    databasePath: string,
    format: AccessFileFormat,
): Promise<() => Promise<void>> {
    const lockPath = accessLockPath(databasePath, format);
    const lockKey = accessFileLockKey(lockPath);

    const existing = heldFileLocks.get(lockKey);
    if (existing) {
        existing.refCount += 1;
        const release = await existing.releasePromise;
        return makeRefCountedRelease(existing, release);
    }

    const holder: HeldFileLock = {
        lockKey,
        refCount: 1,
        releasePromise: createLockFileHandle(lockPath, databasePath),
    };
    heldFileLocks.set(lockKey, holder);
    try {
        const release = await holder.releasePromise;
        return makeRefCountedRelease(holder, release);
    } catch (error) {
        heldFileLocks.delete(lockKey);
        throw error;
    }
}

function makeRefCountedRelease(
    holder: HeldFileLock,
    release: () => Promise<void>,
): () => Promise<void> {
    let released = false;
    return async () => {
        if (released) {
            return;
        }
        released = true;
        holder.refCount -= 1;
        if (holder.refCount <= 0) {
            heldFileLocks.delete(holder.lockKey);
            await release();
        }
    };
}

async function openLockFile(
    lockPath: string,
    databasePath: string,
): Promise<Awaited<ReturnType<typeof fs.open>>> {
    try {
        return await fs.open(lockPath, 'wx');
    } catch (error) {
        if (!isFileExistsError(error)) {
            throw new Error(
                `Cannot create the Access database lock file '${lockPath}'. Writable access is refused.`,
                { cause: error },
            );
        }
        const owner = await readAccessLockOwner(databasePath);
        if (owner && owner.host === os.hostname() && !isProcessAlive(owner.pid)) {
            const ownerPath = accessLockOwnerPath(databasePath);
            if (await takeOverLock(lockPath, ownerPath)) {
                try {
                    return await fs.open(lockPath, 'wx');
                } catch (retryError) {
                    throw lockedError(databasePath, lockPath, retryError, owner);
                }
            }
        }
        throw lockedError(databasePath, lockPath, error, owner);
    }
}

async function createLockFileHandle(
    lockPath: string,
    databasePath: string,
): Promise<() => Promise<void>> {
    const handle = await openLockFile(lockPath, databasePath);
    const ownerPath = accessLockOwnerPath(databasePath);
    const owner: AccessLockOwner = {
        app: OWNER_APP,
        pid: process.pid,
        host: os.hostname(),
        startedAt: new Date().toISOString(),
        database: path.resolve(databasePath),
        lockPath,
    };
    try {
        // The lock file is exclusively ours at this point, so an orphaned
        // owner sidecar from an interrupted acquisition is safe to replace.
        await fs.writeFile(ownerPath, JSON.stringify(owner, null, 2), { encoding: 'utf8' });
    } catch (error) {
        await handle.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        throw new Error(
            `Cannot record the Access lock owner in '${ownerPath}'. Writable access is refused.`,
            { cause: error },
        );
    }
    let released = false;
    return async () => {
        if (released) {
            return;
        }
        released = true;
        try {
            await handle.close();
        } catch {
            // best effort
        }
        await fs.rm(ownerPath, { force: true }).catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
    };
}

/**
 * Explicit recovery for a lock that no live JustyBase owner claims (usually
 * an Access crash or a leftover from another machine). The rename gate keeps
 * an actively held lock untouched.
 */
export async function clearStaleAccessLock(databasePath: string): Promise<AccessLockClearResult> {
    if (!/\.(?:mdb|accdb)$/i.test(databasePath)) {
        return { cleared: false, reason: 'not-a-database' };
    }
    const owner = await readAccessLockOwner(databasePath);
    const ownerPath = accessLockOwnerPath(databasePath);
    for (const lockPath of lockCandidates(databasePath)) {
        if (!(await pathExists(lockPath))) continue;
        if (owner && owner.host === os.hostname() && isProcessAlive(owner.pid)) {
            return { cleared: false, reason: 'live-owner', lockPath, owner };
        }
        if (await takeOverLock(lockPath, ownerPath)) {
            return { cleared: true, reason: 'cleared', lockPath, ...(owner ? { owner } : {}) };
        }
        return { cleared: false, reason: 'held', lockPath, ...(owner ? { owner } : {}) };
    }
    // No lock file; remove a sidecar left by an interrupted acquisition.
    await fs.rm(ownerPath, { force: true }).catch(() => undefined);
    return { cleared: false, reason: 'missing' };
}
