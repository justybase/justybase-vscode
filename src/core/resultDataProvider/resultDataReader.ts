import type { ResultSet } from '../../types';
import { diskBackedStoreRegistry, countDiskBackedRows, queryDiskBackedRows } from './diskBackedStoreRegistry';
import { diskQuerySpecIsActive } from './types';
import type { RowRange } from './types';

export interface ResultDataReader {
    getTotalRows(): number;
    getRows(range: RowRange): unknown[][];
    iterateRows(batchSize: number): Generator<unknown[][], void, unknown>;
}

class MemoryResultDataReader implements ResultDataReader {
    public constructor(private readonly _data: unknown[][]) {}

    public getTotalRows(): number {
        return this._data.length;
    }

    public getRows(range: RowRange): unknown[][] {
        const offset = Math.max(0, range.offset);
        const limit = Math.max(0, range.limit);
        return this._data.slice(offset, offset + limit);
    }

    public *iterateRows(batchSize: number): Generator<unknown[][], void, unknown> {
        const size = Math.max(1, batchSize);
        for (let offset = 0; offset < this._data.length; offset += size) {
            yield this._data.slice(offset, Math.min(offset + size, this._data.length));
        }
    }
}

class SqliteResultDataReader implements ResultDataReader {
    public constructor(
        private readonly _storeId: string,
        private readonly _querySpec: ResultSet['diskQuerySpec'],
    ) {}

    public getTotalRows(): number {
        const store = diskBackedStoreRegistry.get(this._storeId);
        if (!store) {
            return 0;
        }
        if (diskQuerySpecIsActive(this._querySpec)) {
            return countDiskBackedRows(this._storeId, this._querySpec) ?? 0;
        }
        return store.getTotalRows();
    }

    public getRows(range: RowRange): unknown[][] {
        if (diskQuerySpecIsActive(this._querySpec)) {
            return queryDiskBackedRows(this._storeId, this._querySpec, range) ?? [];
        }
        return diskBackedStoreRegistry.get(this._storeId)?.getRows(range) ?? [];
    }

    public *iterateRows(batchSize: number): Generator<unknown[][], void, unknown> {
        const total = this.getTotalRows();
        const size = Math.max(1, batchSize);
        for (let offset = 0; offset < total; offset += size) {
            yield this.getRows({ offset, limit: size });
        }
    }
}

export function createResultDataReader(resultSet: ResultSet): ResultDataReader {
    if (resultSet.storageMode === 'sqlite' && resultSet.diskStoreId) {
        return new SqliteResultDataReader(resultSet.diskStoreId, resultSet.diskQuerySpec);
    }
    return new MemoryResultDataReader(resultSet.data);
}

export function getEffectiveRowCount(resultSet: ResultSet): number {
    if (resultSet.storageMode === 'sqlite') {
        if (diskQuerySpecIsActive(resultSet.diskQuerySpec) && resultSet.diskStoreId) {
            return countDiskBackedRows(resultSet.diskStoreId, resultSet.diskQuerySpec) ?? 0;
        }
        return resultSet.totalRowCount ?? diskBackedStoreRegistry.get(resultSet.diskStoreId ?? '')?.getTotalRows() ?? 0;
    }
    return resultSet.data.length;
}

export function resolveExportRows(
    resultSet: ResultSet,
    rowIndices: number[] | undefined,
    columnIndices: number[],
): unknown[][] {
    const pickColumns = (row: unknown[]): unknown[] =>
        columnIndices.map((columnIndex) => row[columnIndex]);

    if (resultSet.storageMode !== 'sqlite' || !resultSet.diskStoreId) {
        const source = resultSet.data;
        const indices = rowIndices && rowIndices.length > 0
            ? rowIndices
            : source.map((_, index) => index);
        return indices
            .map((idx) => source[idx])
            .filter((row): row is unknown[] => Array.isArray(row))
            .map(pickColumns);
    }

    const reader = createResultDataReader(resultSet);
    if (rowIndices && rowIndices.length > 0) {
        return rowIndices
            .map((idx) => reader.getRows({ offset: idx, limit: 1 })[0])
            .filter((row): row is unknown[] => Array.isArray(row))
            .map(pickColumns);
    }

    const rows: unknown[][] = [];
    for (const batch of reader.iterateRows(50_000)) {
        for (const row of batch) {
            rows.push(pickColumns(row));
        }
    }
    return rows;
}

/**
 * Lazily projects result rows for export. In particular, SQLite-backed
 * results are fetched one row/batch at a time and never copied into a second
 * full `unknown[][]` array.
 */
export function* iterateResultRows(
    resultSet: ResultSet,
    rowIndices: number[] | undefined,
    columnIndices: number[],
): Generator<unknown[], void, unknown> {
    const pickColumns = (row: unknown[]): unknown[] =>
        columnIndices.map(columnIndex => row[columnIndex]);
    if (resultSet.storageMode !== 'sqlite' || !resultSet.diskStoreId) {
        if (rowIndices && rowIndices.length > 0) {
            for (const index of rowIndices) {
                const row = resultSet.data[index];
                if (Array.isArray(row)) {
                    yield pickColumns(row);
                }
            }
            return;
        }
        for (const row of resultSet.data) {
            if (Array.isArray(row)) {
                yield pickColumns(row);
            }
        }
        return;
    }

    const reader = createResultDataReader(resultSet);
    if (rowIndices && rowIndices.length > 0) {
        for (const index of rowIndices) {
            const row = reader.getRows({ offset: index, limit: 1 })[0];
            if (Array.isArray(row)) {
                yield pickColumns(row);
            }
        }
        return;
    }

    for (const batch of reader.iterateRows(50_000)) {
        for (const row of batch) {
            if (Array.isArray(row)) {
                yield pickColumns(row);
            }
        }
    }
}
