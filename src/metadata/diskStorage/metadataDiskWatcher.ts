/**
 * Cross-window metadata cache sync via file-system watch + polling.
 *
 * Polls the v3 index file periodically (backstop) and uses fs.watch (accelerator)
 * to detect when another VS Code window has finished a metadata prefetch.
 * Reports only connections whose `prefetchCompletedAt` has advanced.
 *
 * Architecture decisions:
 * - Polling (30s) is the reliable backstop — fs.watch is best-effort.
 * - We read only the lightweight index file (~KB), never full metadata blobs.
 * - Initial sync populates `knownTimestamps` so that only *new* changes fire.
 */

import * as fs from 'fs';
import { gunzip } from 'zlib';
import { promisify } from 'util';
import { getCacheV3Dir, getV3IndexPath, V2_INDEX_FILE_NAME } from './metadataDiskPaths';
import {
    CACHE_V3_SCHEMA_VERSION,
    isV3DiskIndex,
    type V3DiskIndex,
} from './metadataDiskTypes';

const gunzipAsync = promisify(gunzip);

/** Default polling interval: 30 seconds. */
const POLL_INTERVAL_MS = 30_000;

export class MetadataDiskIndexWatcher {
    /** Known `prefetchCompletedAt` per connection — used to detect changes. */
    private knownTimestamps = new Map<string, number>();
    private pollTimer: ReturnType<typeof setInterval> | undefined;
    private fsWatcher: fs.FSWatcher | undefined;
    private _active = false;
    /** Set to true after the first initial sync completes so new connections are reported. */
    private _initialSyncDone = false;
    private knownGeneration: number | undefined;

    constructor(
        private readonly storageDir: string,
        private readonly onConnectionsUpdated: (connectionNames: string[]) => void,
        private readonly onError?: (error: Error) => void,
        private readonly onGenerationChanged?: () => void,
    ) {}

    get active(): boolean {
        return this._active;
    }

    /** Start watching for index changes. Safe to call multiple times. */
    async start(): Promise<void> {
        if (this._active) {
            return;
        }
        this._active = true;

        // Seed known timestamps from the current disk state so initial
        // callers don't get a false "updated" event for already-known data.
        await this.syncKnownTimestamps();
        this._initialSyncDone = true;

        this.startPolling();
        this.startNativeWatch();
    }

    /** Stop watching. Safe to call multiple times. */
    stop(): void {
        this._active = false;
        this.stopPolling();
        this.stopNativeWatch();
    }

    /**
     * Mark a connection as already known with its `prefetchCompletedAt`.
     * Call this after *this* window finishes a prefetch to prevent the watcher
     * from re-detecting the same save as an external update.
     */
    markConnection(connectionName: string, prefetchCompletedAt: number): void {
        this.knownTimestamps.set(connectionName, prefetchCompletedAt);
    }

    // ─── Polling (reliable backstop) ─────────────────────────────

    private startPolling(): void {
        this.stopPolling();
        this.pollTimer = setInterval(() => {
            if (!this._active) return;
            void this.checkForChanges().catch((err: unknown) => {
                this.onError?.(err instanceof Error ? err : new Error(String(err)));
            });
        }, POLL_INTERVAL_MS);
    }

    private stopPolling(): void {
        if (this.pollTimer !== undefined) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
    }

    // ─── Native fs.watch (best-effort accelerator) ──────────────

    private startNativeWatch(): void {
        const v3Dir = getCacheV3Dir(this.storageDir);
        try {
            // Ensure the directory exists so fs.watch doesn't fail immediately.
            if (!fs.existsSync(v3Dir)) {
                fs.mkdirSync(v3Dir, { recursive: true });
            }
            this.fsWatcher = fs.watch(v3Dir, (_eventType, filename) => {
                // filename may be null on some platforms (e.g., Linux w/ non-recursive watch).
                if (!this._active) return;
                if (!filename || filename === V2_INDEX_FILE_NAME) {
                    void this.checkForChanges().catch((err: unknown) => {
                        this.onError?.(err instanceof Error ? err : new Error(String(err)));
                    });
                }
            });
        } catch {
            // fs.watch can fail on network/Samba filesystems — polling is the backup.
        }
    }

    private stopNativeWatch(): void {
        if (this.fsWatcher !== undefined) {
            this.fsWatcher.close();
            this.fsWatcher = undefined;
        }
    }

    // ─── Change detection ──────────────────────────────────────

    /**
     * Read the v3 index from disk and compare against known timestamps.
     * Returns the list of connection names whose `prefetchCompletedAt` has advanced.
     */
    async checkForChanges(): Promise<string[]> {
        if (!this._active) {
            return [];
        }

        const index = await this.readV3Index();
        if (!index) {
            if (this.knownGeneration !== undefined) {
                this.knownGeneration = undefined;
                this.knownTimestamps.clear();
                this.onGenerationChanged?.();
            }
            return [];
        }
        if (this.knownGeneration !== undefined && index.generation !== this.knownGeneration) {
            this.knownTimestamps.clear();
            this.onGenerationChanged?.();
        }
        this.knownGeneration = index.generation;

        const changed: string[] = [];

        for (const [name, entry] of Object.entries(index.connections)) {
            const known = this.knownTimestamps.get(name);
            if (entry.prefetchCompletedAt > (known ?? 0)) {
                this.knownTimestamps.set(name, entry.prefetchCompletedAt);
                // Report if:
                // - We had a previous known value (timestamp advanced)
                // - Initial sync is done AND this is a brand new connection
                if (known !== undefined || this._initialSyncDone) {
                    changed.push(name);
                }
            }
        }

        // Clean up connections that were deleted from the index.
        for (const [name] of this.knownTimestamps) {
            if (!index.connections[name]) {
                this.knownTimestamps.delete(name);
            }
        }

        if (changed.length > 0) {
            this.onConnectionsUpdated(changed);
        }

        return changed;
    }

    // ─── Index I/O ─────────────────────────────────────────────

    private async syncKnownTimestamps(): Promise<void> {
        const index = await this.readV3Index();
        if (!index) return;

        this.knownGeneration = index.generation;

        for (const [name, entry] of Object.entries(index.connections)) {
            this.knownTimestamps.set(name, entry.prefetchCompletedAt);
        }
    }

    private async readV3Index(): Promise<V3DiskIndex | null> {
        const indexPath = getV3IndexPath(this.storageDir);
        let raw: Buffer;
        try {
            raw = await fs.promises.readFile(indexPath);
        } catch {
            return null;
        }

        if (raw.length === 0) {
            return null;
        }

        try {
            const isGzipped = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
            const jsonText = isGzipped
                ? (await gunzipAsync(raw)).toString('utf8')
                : raw.toString('utf8');
            const parsed: unknown = JSON.parse(jsonText);
            if (!isV3DiskIndex(parsed)) {
                return null;
            }
            if (parsed.schemaVersion !== CACHE_V3_SCHEMA_VERSION) {
                return null;
            }
            return parsed;
        } catch {
            return null;
        }
    }
}
