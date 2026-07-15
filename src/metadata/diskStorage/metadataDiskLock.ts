/** Cooperative, lease-identified locks for metadata cache writers. */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const HEARTBEAT_INTERVAL_MS = 45_000;
export const LOCK_TTL_MS = 3 * HEARTBEAT_INTERVAL_MS;
const LOCK_PREFIX = 'metadata-cache-';
const LOCK_SUFFIX = '.lock';

export function sanitizeConnectionNameForLock(connectionName: string): string {
    return connectionName.replace(/[/\\:*?"<>|]/g, '_');
}
export function getLockFileName(connectionName: string): string {
    return `${LOCK_PREFIX}${sanitizeConnectionNameForLock(connectionName)}${LOCK_SUFFIX}`;
}

export interface DiskLease {
    connectionName: string;
    ownerId: string;
    leaseId: string;
}

interface LockFileContent {
    pid: number;
    startedAt: number;
    ownerId?: string;
    leaseId?: string;
    lastHeartbeatAt?: number;
}

function isProcessAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (error: unknown) {
        return (error as NodeJS.ErrnoException)?.code !== 'ESRCH';
    }
}

/**
 * The lock record is immutable. Liveness is written to a lease-specific
 * heartbeat file, so a former owner can never rename a heartbeat over a new
 * owner's lock after its lease has been stolen.
 */
export class MetadataDiskLock {
    private readonly ownerId = crypto.randomUUID();
    private readonly ownedLeases = new Map<string, DiskLease>();
    private readonly heartbeatTimers = new Map<string, NodeJS.Timeout>();

    constructor(private readonly storageDir: string) {}
    getLockPath(connectionName: string): string { return path.join(this.storageDir, getLockFileName(connectionName)); }
    private heartbeatPath(lease: DiskLease): string { return `${this.getLockPath(lease.connectionName)}.heartbeat-${lease.leaseId}`; }

    private async readLock(connectionName: string): Promise<LockFileContent | undefined> {
        try { return JSON.parse(await fs.promises.readFile(this.getLockPath(connectionName), 'utf8')) as LockFileContent; } catch { return undefined; }
    }
    private matches(lease: DiskLease, lock: LockFileContent | undefined): boolean {
        return lock?.ownerId === lease.ownerId && lock.leaseId === lease.leaseId;
    }
    private async heartbeat(lease: DiskLease): Promise<void> {
        if (this.ownedLeases.get(lease.connectionName)?.leaseId !== lease.leaseId || !this.matches(lease, await this.readLock(lease.connectionName))) {
            this.stopHeartbeat(lease.connectionName); this.ownedLeases.delete(lease.connectionName); return;
        }
        const target = this.heartbeatPath(lease);
        const temp = `${target}.${crypto.randomUUID()}.tmp`;
        try { await fs.promises.writeFile(temp, String(Date.now()), 'utf8'); await fs.promises.rename(temp, target); }
        catch { await fs.promises.unlink(temp).catch(() => undefined); }
    }
    startHeartbeat(leaseOrConnection: DiskLease | string, intervalMs = HEARTBEAT_INTERVAL_MS): void {
        const lease = typeof leaseOrConnection === 'string' ? this.ownedLeases.get(leaseOrConnection) : leaseOrConnection;
        if (!lease) return;
        this.stopHeartbeat(lease.connectionName);
        this.heartbeatTimers.set(lease.connectionName, setInterval(() => void this.heartbeat(lease), intervalMs));
        void this.heartbeat(lease);
    }
    stopHeartbeat(connectionName: string): void { const t = this.heartbeatTimers.get(connectionName); if (t) clearInterval(t); this.heartbeatTimers.delete(connectionName); }
    hasOwnedLock(connectionName: string): boolean { return this.ownedLeases.has(connectionName); }
    getOwnedLease(connectionName: string): DiskLease | undefined { return this.ownedLeases.get(connectionName); }
    async hasLease(lease: DiskLease): Promise<boolean> {
        return this.ownedLeases.get(lease.connectionName)?.leaseId === lease.leaseId
            && this.matches(lease, await this.readLock(lease.connectionName));
    }

    async acquireLock(connectionName: string, lockTtlMs = LOCK_TTL_MS): Promise<DiskLease | false | undefined> {
        const existingOwned = this.ownedLeases.get(connectionName);
        if (existingOwned && this.matches(existingOwned, await this.readLock(connectionName))) return existingOwned;
        const lease: DiskLease = { connectionName, ownerId: this.ownerId, leaseId: crypto.randomUUID() };
        const content: LockFileContent = { pid: process.pid, startedAt: Date.now(), ownerId: lease.ownerId, leaseId: lease.leaseId };
        const tryCreate = async (): Promise<boolean> => {
            try { await fs.promises.writeFile(this.getLockPath(connectionName), JSON.stringify(content), { flag: 'wx' }); return true; } catch { return false; }
        };
        if (!await tryCreate()) {
            const old = await this.readLock(connectionName);
            if (!old) {
                // Corrupt/empty records have no lease identity and cannot be a
                // valid owner; remove only that unreadable record then retry.
                await fs.promises.unlink(this.getLockPath(connectionName)).catch(() => undefined);
                if (!await tryCreate()) return undefined;
            }
            else {
                let lastSeen = old.lastHeartbeatAt ?? old.startedAt;
                if (old.leaseId) {
                    try { lastSeen = Number(await fs.promises.readFile(`${this.getLockPath(connectionName)}.heartbeat-${old.leaseId}`, 'utf8')) || lastSeen; } catch { /* absent heartbeat */ }
                }
                if ((typeof old.pid === 'number' && isProcessAlive(old.pid)) && lastSeen > Date.now() - lockTtlMs) return undefined;
                // Compare identity immediately before removal; never remove a successor.
                const current = await this.readLock(connectionName);
                if (current && JSON.stringify(current) === JSON.stringify(old)) await fs.promises.unlink(this.getLockPath(connectionName)).catch(() => undefined);
                if (!await tryCreate()) return undefined;
            }
        }
        this.ownedLeases.set(connectionName, lease);
        return lease;
    }
    async releaseLock(leaseOrConnection: DiskLease | string): Promise<void> {
        const lease = typeof leaseOrConnection === 'string' ? this.ownedLeases.get(leaseOrConnection) : leaseOrConnection;
        if (!lease) return;
        this.stopHeartbeat(lease.connectionName);
        if (this.matches(lease, await this.readLock(lease.connectionName))) await fs.promises.unlink(this.getLockPath(lease.connectionName)).catch(() => undefined);
        await fs.promises.unlink(this.heartbeatPath(lease)).catch(() => undefined);
        if (this.ownedLeases.get(lease.connectionName)?.leaseId === lease.leaseId) this.ownedLeases.delete(lease.connectionName);
    }
    async releaseAllOwned(): Promise<void> { await Promise.all([...this.ownedLeases.values()].map(lease => this.releaseLock(lease))); }
    /** @deprecated Unsafe global removal is intentionally no longer performed. */
    async deleteAllLockFiles(): Promise<void> { await this.releaseAllOwned(); }
}
