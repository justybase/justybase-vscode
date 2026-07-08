/**
 * Metadata Cache - Observability / Stats Module
 *
 * Tracks cache hit/miss rates, refresh costs, and memory pressure
 * to support evidence-based decisions during Phase 3 metadata hardening.
 *
 * All counters are per-connection and reset when the cache is cleared.
 */

import { Logger } from '../utils/logger';

/** Snapshot of cache stats for a single connection */
export interface CacheStatsSnapshot {
    connectionName: string;
    /** Hit/miss counters by cache layer */
    hits: Readonly<Record<CacheLayer, number>>;
    misses: Readonly<Record<CacheLayer, number>>;
    /** Total number of entries currently stored (summed across layers) */
    totalEntries: number;
    /** Estimated memory usage in bytes (sum of estimated entry sizes) */
    estimatedMemoryBytes: number;
    /** Entry count by cache layer for size analysis */
    entriesByLayer: Readonly<Record<CacheLayer, number>>;
    /** Number of TTL-expired evictions that have been observed */
    ttlEvictions: number;
    /** Refresh operations recorded */
    refreshOps: readonly RefreshRecord[];
}

export interface RefreshRecord {
    layer: CacheLayer;
    key: string;
    durationMs: number;
    timestamp: number;
    entryCount: number;
}

export type CacheLayer =
    | 'database'
    | 'schema'
    | 'table'
    | 'column'
    | 'procedure'
    | 'typeGroup'
    | 'objectsByType'
    | 'objectLookup';

const ALL_LAYERS: readonly CacheLayer[] = [
    'database',
    'schema',
    'table',
    'column',
    'procedure',
    'typeGroup',
    'objectsByType',
    'objectLookup',
];

function createZeroCounters(): Record<CacheLayer, number> {
    const counters: Partial<Record<CacheLayer, number>> = {};
    for (const layer of ALL_LAYERS) {
        counters[layer] = 0;
    }
    return counters as Record<CacheLayer, number>;
}

/** Maximum number of refresh records to keep per connection (ring buffer) */
const MAX_REFRESH_RECORDS = 100;

interface PerConnectionStats {
    hits: Record<CacheLayer, number>;
    misses: Record<CacheLayer, number>;
    entriesByLayer: Record<CacheLayer, number>;
    ttlEvictions: number;
    refreshOps: RefreshRecord[];
}

/**
 * Tracks cache observability metrics.
 *
 * Thread-safe for single-threaded Node.js:
 * all operations are synchronous and non-reentrant.
 */
export class CacheStatsTracker {
    private readonly _stats = new Map<string, PerConnectionStats>();

    private getOrCreate(connectionName: string): PerConnectionStats {
        let entry = this._stats.get(connectionName);
        if (!entry) {
            entry = {
                hits: createZeroCounters(),
                misses: createZeroCounters(),
                entriesByLayer: createZeroCounters(),
                ttlEvictions: 0,
                refreshOps: [],
            };
            this._stats.set(connectionName, entry);
        }
        return entry;
    }

    // ========== Recording ==========

    recordHit(connectionName: string, layer: CacheLayer): void {
        this.getOrCreate(connectionName).hits[layer]++;
    }

    recordMiss(connectionName: string, layer: CacheLayer): void {
        this.getOrCreate(connectionName).misses[layer]++;
    }

    recordTtlEviction(connectionName: string, _layer: CacheLayer): void {
        this.getOrCreate(connectionName).ttlEvictions++;
    }

    recordEntriesByLayer(connectionName: string, layer: CacheLayer, count: number): void {
        const entry = this._stats.get(connectionName);
        if (entry) {
            entry.entriesByLayer[layer] = count;
        }
    }

    recordRefresh(
        connectionName: string,
        layer: CacheLayer,
        key: string,
        durationMs: number,
        entryCount: number,
    ): void {
        const stats = this.getOrCreate(connectionName);
        const record: RefreshRecord = {
            layer,
            key,
            durationMs,
            timestamp: Date.now(),
            entryCount,
        };
        stats.refreshOps.push(record);
        // Ring-buffer trim
        if (stats.refreshOps.length > MAX_REFRESH_RECORDS) {
            stats.refreshOps = stats.refreshOps.slice(-MAX_REFRESH_RECORDS);
        }
    }

    // ========== Querying ==========

    /**
     * Get a snapshot of stats for a single connection.
     * Returns undefined if no stats have been recorded yet.
     */
    getSnapshot(connectionName: string, totalEntries: number): CacheStatsSnapshot | undefined {
        const entry = this._stats.get(connectionName);
        if (!entry) {
            return undefined;
        }
        const entriesByLayer = { ...entry.entriesByLayer };
        const estimatedMemoryBytes = this.estimateMemoryBytes(entriesByLayer);
        return {
            connectionName,
            hits: { ...entry.hits },
            misses: { ...entry.misses },
            totalEntries,
            estimatedMemoryBytes,
            entriesByLayer,
            ttlEvictions: entry.ttlEvictions,
            refreshOps: [...entry.refreshOps],
        };
    }

    /**
     * Get hit rate for a specific layer (0.0 – 1.0).
     * Returns undefined if no accesses have been recorded.
     */
    getHitRate(connectionName: string, layer: CacheLayer): number | undefined {
        const entry = this._stats.get(connectionName);
        if (!entry) {
            return undefined;
        }
        const total = entry.hits[layer] + entry.misses[layer];
        if (total === 0) {
            return undefined;
        }
        return entry.hits[layer] / total;
    }

    /**
     * Estimate memory usage in bytes based on entry counts per layer.
     *
     * This uses a heuristic approach:
     * - database/schema entries: ~512 bytes each (relatively simple objects)
     * - table entries: ~1024 bytes each (larger objects with metadata)
     * - column entries: ~256 bytes each (simpler objects)
     * - procedure entries: ~1024 bytes each (similar to tables)
     * - typeGroup/objectsByType/objectLookup entries: ~2048 bytes each (computed/cached)
     *
     * This provides a rough estimate for memory pressure monitoring.
     */
    private estimateMemoryBytes(entriesByLayer: Record<CacheLayer, number>): number {
        const ESTIMATED_BYTES_PER_ENTRY: Record<CacheLayer, number> = {
            database: 512,
            schema: 512,
            table: 1024,
            column: 256,
            procedure: 1024,
            typeGroup: 2048,
            objectsByType: 2048,
            objectLookup: 512,
        };

        let totalBytes = 0;
        for (const layer of ALL_LAYERS) {
            totalBytes += entriesByLayer[layer] * (ESTIMATED_BYTES_PER_ENTRY[layer] || 1024);
        }
        return totalBytes;
    }

    private formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    // ========== Lifecycle ==========

    /** Clear stats for a specific connection */
    clearConnection(connectionName: string): void {
        this._stats.delete(connectionName);
    }

    /** Clear all stats */
    clearAll(): void {
        this._stats.clear();
    }

    // ========== Logging ==========

    /**
     * Log a summary of cache stats for a connection.
     * Useful for periodic health checks or on-demand diagnostics.
     */
    logSummary(connectionName: string, totalEntries: number): void {
        const snapshot = this.getSnapshot(connectionName, totalEntries);
        if (!snapshot) {
            return;
        }

        const logger = Logger.getInstance();
        const lines: string[] = [
            `[CacheStats] Connection: ${connectionName}`,
            `  Total entries:  ${snapshot.totalEntries}`,
            `  Est. memory:    ${this.formatBytes(snapshot.estimatedMemoryBytes)}`,
            `  TTL evictions:  ${snapshot.ttlEvictions}`,
        ];

        for (const layer of ALL_LAYERS) {
            const h = snapshot.hits[layer];
            const m = snapshot.misses[layer];
            const total = h + m;
            if (total === 0) {
                continue;
            }
            const rate = ((h / total) * 100).toFixed(1);
            const entries = snapshot.entriesByLayer[layer];
            lines.push(`  ${layer}: ${entries} entries, ${h} hits / ${m} misses (${rate}%)`);
        }

        const recentRefreshes = snapshot.refreshOps.slice(-5);
        if (recentRefreshes.length > 0) {
            lines.push('  Recent refreshes:');
            for (const r of recentRefreshes) {
                lines.push(`    ${r.layer}/${r.key}: ${r.durationMs}ms (${r.entryCount} entries)`);
            }
        }

        logger.info(lines.join('\n'));
    }
}

/** P95 refresh duration in milliseconds; undefined when no refresh ops recorded. */
export function computeRefreshDurationP95(
    refreshOps: readonly RefreshRecord[],
): number | undefined {
    if (refreshOps.length === 0) {
        return undefined;
    }
    const durations = refreshOps
        .map((record) => record.durationMs)
        .sort((left, right) => left - right);
    const index = Math.min(
        durations.length - 1,
        Math.ceil(durations.length * 0.95) - 1,
    );
    return durations[index];
}
