import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    accessLockOwnerPath,
    accessLockPath,
    acquireAccessFileLock,
    clearStaleAccessLock,
    isProcessAlive,
    readAccessLockOwner,
} from '../../extensions/access/src/accessFileLock';

async function spawnedDeadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    if (child.pid === undefined) {
        throw new Error('The helper process did not expose a PID.');
    }
    await once(child, 'exit');
    return child.pid;
}

async function writeOwner(
    databasePath: string,
    overrides: Partial<{ pid: number; host: string; startedAt: string }> = {},
): Promise<void> {
    await fs.writeFile(accessLockOwnerPath(databasePath), JSON.stringify({
        app: 'justybase',
        pid: overrides.pid ?? process.pid,
        host: overrides.host ?? os.hostname(),
        startedAt: overrides.startedAt ?? new Date().toISOString(),
        database: databasePath,
        lockPath: accessLockPath(databasePath, 'accdb2016'),
    }), 'utf8');
}

describe('Access file lock ownership', () => {
    let directory: string;
    let databasePath: string;
    const releases: Array<() => Promise<void>> = [];

    beforeEach(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'justybase-access-lock-'));
        databasePath = path.join(directory, 'sample.accdb');
        await fs.writeFile(databasePath, 'fixture');
    });

    afterEach(async () => {
        for (const release of releases.splice(0)) {
            await release().catch(() => undefined);
        }
        await fs.rm(directory, { recursive: true, force: true });
    });

    async function acquire(format: 'accdb2016' | 'jet4' = 'accdb2016'): Promise<() => Promise<void>> {
        const release = await acquireAccessFileLock(databasePath, format);
        releases.push(release);
        return release;
    }

    it('creates the ACCDB lock plus an owner sidecar and removes both on release', async () => {
        const lockPath = accessLockPath(databasePath, 'accdb2016');
        expect(lockPath).toBe(path.join(directory, 'sample.laccdb'));

        const release = await acquire();
        try {
            await expect(fs.stat(lockPath)).resolves.toBeDefined();
            await expect(readAccessLockOwner(databasePath)).resolves.toMatchObject({
                app: 'justybase',
                pid: process.pid,
                host: os.hostname(),
                database: path.resolve(databasePath),
            });
        } finally {
            await release();
        }
        await expect(fs.access(lockPath)).rejects.toThrow();
        await expect(fs.access(accessLockOwnerPath(databasePath))).rejects.toThrow();
    });

    it('uses the Jet 4 .ldb lock name for MDB files', async () => {
        const legacyPath = path.join(directory, 'legacy.mdb');
        await fs.writeFile(legacyPath, 'fixture');
        expect(accessLockPath(legacyPath, 'jet4')).toBe(path.join(directory, 'legacy.ldb'));
    });

    it('shares one lock between in-process acquisitions and releases it last', async () => {
        const lockPath = accessLockPath(databasePath, 'accdb2016');
        const first = await acquire();
        const second = await acquire();

        await second();
        await expect(fs.stat(lockPath)).resolves.toBeDefined();
        await first();
        await expect(fs.access(lockPath)).rejects.toThrow();
    });

    it('refuses a foreign lock without owner metadata and points at the recovery command', async () => {
        const lockPath = accessLockPath(databasePath, 'accdb2016');
        await fs.writeFile(lockPath, '');

        await expect(acquireAccessFileLock(databasePath, 'accdb2016')).rejects.toThrow(
            /already open by another process[\s\S]*Clear Stale Lock File/,
        );
        await expect(fs.stat(lockPath)).resolves.toBeDefined();
    });

    it('does not take over a live JustyBase owner', async () => {
        const lockPath = accessLockPath(databasePath, 'accdb2016');
        await fs.writeFile(lockPath, '');
        await writeOwner(databasePath);

        await expect(acquireAccessFileLock(databasePath, 'accdb2016')).rejects.toThrow(
            new RegExp(`Process ${process.pid} on this machine`),
        );
        await expect(fs.stat(lockPath)).resolves.toBeDefined();
    });

    it('reclaims an orphaned lock left by a crashed process on this host', async () => {
        const deadPid = await spawnedDeadPid();
        expect(isProcessAlive(deadPid)).toBe(false);
        const lockPath = accessLockPath(databasePath, 'accdb2016');
        await fs.writeFile(lockPath, 'stale');
        await writeOwner(databasePath, { pid: deadPid, startedAt: new Date(0).toISOString() });

        const release = await acquire();
        try {
            await expect(readAccessLockOwner(databasePath)).resolves.toMatchObject({ pid: process.pid });
        } finally {
            await release();
        }
    });

    it('does not reclaim a lock owned by another host automatically', async () => {
        const deadPid = await spawnedDeadPid();
        const lockPath = accessLockPath(databasePath, 'accdb2016');
        await fs.writeFile(lockPath, 'remote');
        await writeOwner(databasePath, { pid: deadPid, host: 'another-machine' });

        await expect(acquireAccessFileLock(databasePath, 'accdb2016')).rejects.toThrow(
            /another-machine/,
        );
        await expect(fs.stat(lockPath)).resolves.toBeDefined();

        const cleared = await clearStaleAccessLock(databasePath);
        expect(cleared).toMatchObject({ cleared: true, reason: 'cleared' });
        await expect(fs.access(lockPath)).rejects.toThrow();
    });

    it('treats malformed owner metadata as an unknown holder', async () => {
        const lockPath = accessLockPath(databasePath, 'accdb2016');
        await fs.writeFile(lockPath, '');
        await fs.writeFile(accessLockOwnerPath(databasePath), '{not json', 'utf8');

        await expect(readAccessLockOwner(databasePath)).resolves.toBeUndefined();
        await expect(acquireAccessFileLock(databasePath, 'accdb2016')).rejects.toThrow(
            /already open by another process/,
        );
    });

    it('clears a stale lock through the recovery API and reports missing locks', async () => {
        await expect(clearStaleAccessLock(databasePath)).resolves.toMatchObject({
            cleared: false,
            reason: 'missing',
        });

        const lockPath = accessLockPath(databasePath, 'accdb2016');
        await fs.writeFile(lockPath, '');
        await expect(clearStaleAccessLock(databasePath)).resolves.toMatchObject({
            cleared: true,
            reason: 'cleared',
            lockPath,
        });
        await expect(fs.access(lockPath)).rejects.toThrow();

        await expect(clearStaleAccessLock(path.join(directory, 'notes.txt'))).resolves.toMatchObject({
            cleared: false,
            reason: 'not-a-database',
        });
    });

    it('refuses to clear a lock held by a live owner', async () => {
        const lockPath = accessLockPath(databasePath, 'accdb2016');
        await fs.writeFile(lockPath, '');
        await writeOwner(databasePath);

        await expect(clearStaleAccessLock(databasePath)).resolves.toMatchObject({
            cleared: false,
            reason: 'live-owner',
            owner: { pid: process.pid },
        });
        await expect(fs.stat(lockPath)).resolves.toBeDefined();
    });

    it('removes an orphaned owner sidecar when no lock remains', async () => {
        await fs.writeFile(accessLockOwnerPath(databasePath), '{}', 'utf8');
        await expect(clearStaleAccessLock(databasePath)).resolves.toMatchObject({
            cleared: false,
            reason: 'missing',
        });
        await expect(fs.access(accessLockOwnerPath(databasePath))).rejects.toThrow();
    });
});
