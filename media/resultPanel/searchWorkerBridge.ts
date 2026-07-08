/**
 * Deferred search-worker data loading — avoids a second full structured-clone copy
 * until the user runs global filter search (Ctrl+F / filter box).
 */
import { clearAllSearchMatches, getSearchWorker } from './state.js';
import { getActiveSourceUri, getResultSetAt } from './types.js';

/** Row count at which global filter uses the background worker instead of TanStack inline scan. */
export const GLOBAL_FILTER_WORKER_ROW_THRESHOLD = 20000;

/** Rows per postMessage chunk when loading worker data (keeps UI responsive). */
const WORKER_LOAD_CHUNK_ROWS = 15000;

const loadedResultSetIds = new Set<number>();
const loadingPromises = new Map<number, Promise<boolean>>();
let workerDataGeneration = 0;

function yieldToUi(): Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, 0);
    });
}

export function isSearchWorkerDataLoaded(rsIndex: number): boolean {
    return loadedResultSetIds.has(rsIndex);
}

export function clearSearchWorkerData(rsIndex: number): void {
    const worker = getSearchWorker();
    if (worker) {
        worker.postMessage({ command: 'clearData', id: rsIndex });
    }
    loadedResultSetIds.delete(rsIndex);
    loadingPromises.delete(rsIndex);
}

export function clearAllSearchWorkerData(): void {
    workerDataGeneration += 1;
    const idsToClear = new Set([...loadedResultSetIds, ...loadingPromises.keys()]);
    for (const rsIndex of idsToClear) {
        clearSearchWorkerData(rsIndex);
    }
    loadedResultSetIds.clear();
    loadingPromises.clear();
    clearAllSearchMatches();
}

async function loadSearchWorkerDataChunked(rsIndex: number): Promise<boolean> {
    const worker = getSearchWorker();
    if (!worker) {
        return false;
    }

    const rs = getResultSetAt(rsIndex);
    if (!rs || rs.isLog || rs.isError || rs.isTextContent) {
        return false;
    }

    if (rs.storageMode === 'sqlite') {
        // Disk-backed results use SQL global filter; worker data is not loaded.
        return false;
    }

    if (!Array.isArray(rs.data)) {
        return false;
    }

    if (loadedResultSetIds.has(rsIndex)) {
        return true;
    }

    clearAllSearchWorkerData();
    const loadGeneration = workerDataGeneration;

    worker.postMessage({
        command: 'initData',
        id: rsIndex,
        columns: rs.columns,
    });
    await yieldToUi();

    const rows = rs.data;
    for (let offset = 0; offset < rows.length; offset += WORKER_LOAD_CHUNK_ROWS) {
        if (loadGeneration !== workerDataGeneration || getResultSetAt(rsIndex) !== rs) {
            return false;
        }
        worker.postMessage({
            command: 'appendData',
            id: rsIndex,
            rows: rows.slice(offset, offset + WORKER_LOAD_CHUNK_ROWS),
        });
        await yieldToUi();
    }

    if (loadGeneration !== workerDataGeneration || getResultSetAt(rsIndex) !== rs) {
        return false;
    }
    loadedResultSetIds.add(rsIndex);
    return true;
}

/**
 * Load one result set into the worker asynchronously (single-slot, chunked).
 */
export function ensureSearchWorkerDataAsync(rsIndex: number): Promise<boolean> {
    if (loadedResultSetIds.has(rsIndex)) {
        return Promise.resolve(true);
    }

    const inFlight = loadingPromises.get(rsIndex);
    if (inFlight) {
        return inFlight;
    }

    const promise = loadSearchWorkerDataChunked(rsIndex).finally(() => {
        loadingPromises.delete(rsIndex);
    });
    loadingPromises.set(rsIndex, promise);
    return promise;
}
