import { createHash } from 'crypto';
import * as path from 'path';
import { JavaBridgeClient } from './javaBridgeClient';

export interface AccessBridgePoolOptions {
    databasePath: string;
    javaExecutable: string;
    bridgeJarPath: string;
    user?: string;
    password?: string;
    readOnly?: boolean;
}

export interface AccessBridgeLease {
    readonly bridge: JavaBridgeClient;
    release(): Promise<void>;
}

interface PoolEntry {
    readonly key: string;
    readonly bridge: JavaBridgeClient;
    readonly ready: Promise<void>;
    leases: number;
    released: boolean;
}

export type AccessBridgeFactory = (options: {
    javaExecutable: string;
    bridgeJarPath: string;
}) => JavaBridgeClient;

function normalizeDatabasePath(databasePath: string): string {
    const normalized = path.normalize(path.resolve(databasePath));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function passwordFingerprint(password: string | undefined): string {
    return createHash('sha256').update(password ?? '', 'utf8').digest('hex');
}

function makePoolKey(options: AccessBridgePoolOptions): string {
    // The password is represented only by a one-way fingerprint. Do not put it
    // in diagnostics or retain it in the pool entry after connect() returns.
    return JSON.stringify([
        normalizeDatabasePath(options.databasePath),
        options.user ?? '',
        passwordFingerprint(options.password),
        options.readOnly,
        options.javaExecutable,
        options.bridgeJarPath,
    ]);
}

export class AccessBridgePool {
    private readonly _entries = new Map<string, PoolEntry>();

    public constructor(
        private readonly _factory: AccessBridgeFactory = options => new JavaBridgeClient(options),
    ) {}

    public async acquire(options: AccessBridgePoolOptions): Promise<AccessBridgeLease> {
        const readOnly = options.readOnly !== false;
        const resolvedOptions = { ...options, readOnly };
        const key = makePoolKey(resolvedOptions);
        let entry = this._entries.get(key);
        if (!entry) {
            const bridge = this._factory({
                javaExecutable: options.javaExecutable,
                bridgeJarPath: options.bridgeJarPath,
            });
            entry = {
                key,
                bridge,
                leases: 1,
                released: false,
                ready: Promise.resolve()
                    .then(() => bridge.start())
                    .then(() => bridge.connect(options.databasePath, {
                        password: resolvedOptions.password,
                        readOnly,
                    }))
                    .catch(async error => {
                        if (this._entries.get(key) === entry) {
                            this._entries.delete(key);
                        }
                        await bridge.close().catch(() => undefined);
                        throw error;
                    }),
            };
            this._entries.set(key, entry);
        } else {
            entry.leases++;
        }

        try {
            await entry.ready;
        } catch (error) {
            // The failed initialization owns one reservation for every caller
            // waiting on the same promise; no lease is returned to callers.
            entry.leases = Math.max(0, entry.leases - 1);
            throw error;
        }

        let released = false;
        return {
            bridge: entry.bridge,
            release: async () => {
                if (released) {
                    return;
                }
                released = true;
                await this._release(entry as PoolEntry);
            },
        };
    }

    private async _release(entry: PoolEntry): Promise<void> {
        if (entry.released) {
            return;
        }
        entry.leases--;
        if (entry.leases > 0) {
            return;
        }
        entry.released = true;
        if (this._entries.get(entry.key) === entry) {
            this._entries.delete(entry.key);
        }
        await entry.bridge.close().catch(() => undefined);
    }

    /** Test/support cleanup for extension shutdown. */
    public async close(): Promise<void> {
        const entries = [...this._entries.values()];
        this._entries.clear();
        await Promise.all(entries.map(async entry => {
            entry.released = true;
            await entry.bridge.close().catch(() => undefined);
        }));
    }
}

export const accessBridgePool = new AccessBridgePool();
