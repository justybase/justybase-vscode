import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
    getLockFileName,
    LOCK_TTL_MS,
    MetadataDiskLock,
    sanitizeConnectionNameForLock,
} from '../metadata/diskStorage/metadataDiskLock';

function requireLease(value: Awaited<ReturnType<MetadataDiskLock['acquireLock']>>) {
    if (!value) throw new Error('Expected lock lease');
    return value;
}

describe('MetadataDiskLock leases', () => {
    let tempDir: string;
    let first: MetadataDiskLock;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-lock-'));
        first = new MetadataDiskLock(tempDir);
    });
    afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it('sanitizes lock names', () => {
        expect(sanitizeConnectionNameForLock('NZ/PROD:1')).toBe('NZ_PROD_1');
        expect(getLockFileName('NZ/PROD:1')).toBe('metadata-cache-NZ_PROD_1.lock');
    });

    it('acquires a lease and releases only that lease', async () => {
        const lease = requireLease(await first.acquireLock('conn1'));
        expect(await first.hasLease(lease)).toBe(true);
        await first.releaseLock(lease);
        expect(fs.existsSync(first.getLockPath('conn1'))).toBe(false);
    });

    it('does not give a second instance a valid lease', async () => {
        const second = new MetadataDiskLock(tempDir);
        expect(await first.acquireLock('conn1')).toBeTruthy();
        expect(await second.acquireLock('conn1')).toBeFalsy();
    });

    it('uses a lease-specific heartbeat without rewriting the lock record', async () => {
        const lease = requireLease(await first.acquireLock('conn1'));
        const original = fs.readFileSync(first.getLockPath('conn1'), 'utf8');
        first.startHeartbeat(lease, 5);
        await new Promise(resolve => setTimeout(resolve, 15));
        expect(fs.readFileSync(first.getLockPath('conn1'), 'utf8')).toBe(original);
        const files = fs.readdirSync(tempDir);
        expect(files.some(file => file.includes(`heartbeat-${lease.leaseId}`))).toBe(true);
    });

    it('does not let an expired owner release or renew a successor lease', async () => {
        const oldLease = requireLease(await first.acquireLock('conn1'));
        const lockPath = first.getLockPath('conn1');
        const stale = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
        stale.startedAt = Date.now() - LOCK_TTL_MS - 1;
        fs.writeFileSync(lockPath, JSON.stringify(stale));

        const second = new MetadataDiskLock(tempDir);
        const newLease = requireLease(await second.acquireLock('conn1'));
        expect(newLease.leaseId).not.toBe(oldLease.leaseId);
        await first.releaseLock(oldLease);
        expect(await second.hasLease(newLease)).toBe(true);
        expect(await first.hasLease(oldLease)).toBe(false);
    });

    it('recovers a corrupted lock record', async () => {
        fs.writeFileSync(first.getLockPath('conn1'), 'broken');
        expect(await first.acquireLock('conn1')).toBeTruthy();
    });
});
