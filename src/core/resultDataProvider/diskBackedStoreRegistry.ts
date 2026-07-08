import { SqliteResultStore } from './sqliteResultStore';
import type {
    DiskAggregationRequest,
    DiskAggregationResult,
    DiskDistinctValue,
    DiskGroupLevel,
    DiskGroupPathItem,
    DiskGroupQueryResult,
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
