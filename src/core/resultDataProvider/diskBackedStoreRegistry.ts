import { SqliteResultStore } from './sqliteResultStore';
import type {
    DiskAggregationRequest,
    DiskAggregationResult,
    DiskDistinctValue,
    DiskGroupLevel,
    DiskGroupPathItem,
    DiskGroupQueryResult,
    DiskGroupStatsRequest,
    DiskGroupStatsResult,
    DiskQuerySpec,
    RowRange,
} from './types';

class DiskBackedStoreRegistry {
    private readonly _stores = new Map<string, SqliteResultStore>();

    public register(store: SqliteResultStore): void {
        this._stores.set(store.id, store);
    }

    public get(storeId: string): SqliteResultStore | undefined {
        return this._stores.get(storeId);
    }

    public has(storeId: string): boolean {
        return this._stores.has(storeId);
    }

    /** Sum of the on-disk size of every registered store (database + WAL/SHM). */
    public totalDiskBytes(): number {
        let total = 0;
        for (const store of this._stores.values()) {
            total += store.getDiskBytes();
        }
        return total;
    }

    public count(): number {
        return this._stores.size;
    }

    public dispose(storeId: string): void {
        const store = this._stores.get(storeId);
        if (!store) {
            return;
        }
        store.dispose();
        this._stores.delete(storeId);
    }

    public disposeAll(): void {
        for (const store of this._stores.values()) {
            store.dispose();
        }
        this._stores.clear();
    }
}

export const diskBackedStoreRegistry = new DiskBackedStoreRegistry();

/** Total bytes every registered store currently occupies on disk. */
export function getDiskBackedTotalBytes(): number {
    return diskBackedStoreRegistry.totalDiskBytes();
}

function formatStorageBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
    }
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    const rounded = value >= 100 || unitIndex === 0 ? Math.round(value) : Math.round(value * 10) / 10;
    return `${rounded} ${units[unitIndex]}`;
}

/** Markdown section for the result-panel performance report. */
export function renderDiskBackedStorageReport(budgetBytes: number): string {
    const used = diskBackedStoreRegistry.totalDiskBytes();
    const stores = diskBackedStoreRegistry.count();
    const percent = budgetBytes > 0 ? Math.round((used / budgetBytes) * 100) : 0;
    return [
        '## Disk-backed results',
        '',
        `- Stores: ${stores}`,
        `- On disk: ${formatStorageBytes(used)}`,
        `- Budget: ${formatStorageBytes(budgetBytes)} (${percent}% used)`,
    ].join('\n');
}

export function getDiskBackedRows(storeId: string, range: RowRange): unknown[][] | undefined {
    return diskBackedStoreRegistry.get(storeId)?.getRows(range);
}

export function getDiskBackedTotalRows(storeId: string): number | undefined {
    return diskBackedStoreRegistry.get(storeId)?.getTotalRows();
}

export function queryDiskBackedRows(
    storeId: string,
    spec: DiskQuerySpec | undefined,
    range: RowRange,
): unknown[][] | undefined {
    return diskBackedStoreRegistry.get(storeId)?.queryRows(spec, range);
}

export function countDiskBackedRows(
    storeId: string,
    spec: DiskQuerySpec | undefined,
): number | undefined {
    return diskBackedStoreRegistry.get(storeId)?.countRows(spec);
}

export function distinctDiskBackedValues(
    storeId: string,
    spec: DiskQuerySpec | undefined,
    columnIndex: number,
    limit: number,
): { values: DiskDistinctValue[]; truncated: boolean } | undefined {
    return diskBackedStoreRegistry.get(storeId)?.distinctValues(spec, columnIndex, limit);
}

export function aggregateDiskBackedRows(
    storeId: string,
    spec: DiskQuerySpec | undefined,
    requests: DiskAggregationRequest[],
): DiskAggregationResult[] | undefined {
    return diskBackedStoreRegistry.get(storeId)?.aggregateRows(spec, requests);
}

export function queryDiskBackedGroupStats(
    storeId: string,
    request: DiskGroupStatsRequest,
): DiskGroupStatsResult | undefined {
    return diskBackedStoreRegistry.get(storeId)?.queryGroupStats(request);
}

export function queryDiskBackedGroups(
    storeId: string,
    spec: DiskQuerySpec | undefined,
    grouping: DiskGroupLevel[],
    path: DiskGroupPathItem[],
    range: RowRange,
    aggregations: DiskAggregationRequest[] = [],
): DiskGroupQueryResult | undefined {
    return diskBackedStoreRegistry.get(storeId)?.queryGroups(spec, grouping, path, range, aggregations);
}
