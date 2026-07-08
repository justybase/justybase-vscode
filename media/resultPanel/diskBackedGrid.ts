import { decode } from '@msgpack/msgpack';
import { postHostMessage } from './protocol.js';
import { clearAllSearchWorkerData } from './searchWorkerBridge.js';
import { renderGrids } from './grid.js';
import { updateRowCountInfo } from './filter.js';
import { getGrid, getSortedSearchMatchIndices, resetEditSession } from './state.js';
import { getGridWrapperForResultSet, getScrollTarget } from './grid/persistence.js';
import {
    diskQueryChangesRowCount,
    getDiskFilteredCount,
    getDiskQuerySpec,
    syncDiskQuerySpecFromGrid,
    syncDiskStreamingRowCount,
} from './diskQuerySpec.js';
import { diskQuerySpecIsActive } from './diskQueryUtils.js';
import type {
    DiskAggregationResult,
    DiskDistinctValue,
    DiskGroupLevel,
    DiskGroupPathItem,
    DiskGroupQueryResult,
    DiskQuerySpec,
    ResultSet,
} from './types.js';
import { getActiveSourceUri, callPanelMethod, getResultSetAt, getResultSets, setResultSets } from './types.js';

export const DISK_WINDOW_ROWS = 2_000;
export const DISK_PAGE_SIZE = 800;
/** Keep in sync with src/core/resultDataProvider/types.ts DISK_BACKED_WEBVIEW_STREAM_CAP */
export const DISK_BACKED_WEBVIEW_STREAM_CAP = 250_000;
/** Keep in sync with src/core/resultDataProvider/types.ts DISK_BACKED_STREAMING_PREVIEW_ROWS */
export const DISK_BACKED_STREAMING_PREVIEW_ROWS = 2_000;
export const DISK_QUERY_DISTINCT_LIMIT = 10_001;

type PendingRowRequest =
    | { type: 'window'; rsIndex: number; offset: number }
    | { type: 'fetch'; resolve: (rows: unknown[][]) => void; reject: (error: Error) => void };

type PendingDiskQueryRequest =
    | { type: 'window'; rsIndex: number; offset: number }
    | { type: 'count'; rsIndex: number; resolve: (count: number) => void; reject: (error: Error) => void }
    | { type: 'distinct'; resolve: (result: { values: DiskDistinctValue[]; truncated: boolean }) => void; reject: (error: Error) => void }
    | { type: 'aggregate'; resolve: (results: DiskAggregationResult[]) => void; reject: (error: Error) => void }
    | { type: 'group'; rsIndex: number; resolve: (result: DiskGroupQueryResult) => void; reject: (error: Error) => void }
    | { type: 'fetch'; resolve: (rows: unknown[][]) => void; reject: (error: Error) => void };

let requestIdCounter = 0;
const pendingRequests = new Map<number, PendingRowRequest>();
const pendingDiskQueries = new Map<number, PendingDiskQueryRequest>();

interface DiskWindowRequestState {
    visibleStart: number;
    visibleEnd: number;
    targetStart: number;
}

const diskWindowRequestState = new Map<number, DiskWindowRequestState>();
const ensureDiskWindowScheduled = new Map<number, number>();

function cancelPendingWindowRequestsForResultSet(rsIndex: number): void {
    for (const [requestId, pending] of pendingRequests.entries()) {
        if (pending.type === 'window' && pending.rsIndex === rsIndex) {
            pendingRequests.delete(requestId);
        }
    }
    for (const [requestId, pending] of pendingDiskQueries.entries()) {
        if (pending.type === 'window' && pending.rsIndex === rsIndex) {
            pendingDiskQueries.delete(requestId);
        }
    }
}

function cancelPendingDiskQueriesForResultSet(rsIndex: number): void {
    for (const [requestId, pending] of pendingDiskQueries.entries()) {
        if (
            (pending.type === 'window' && pending.rsIndex === rsIndex)
            || (pending.type === 'count' && pending.rsIndex === rsIndex)
            || (pending.type === 'group' && pending.rsIndex === rsIndex)
        ) {
            pendingDiskQueries.delete(requestId);
        }
    }
}

function isWindowResponseRelevant(rsIndex: number, offset: number, rowCount: number): boolean {
    const state = diskWindowRequestState.get(rsIndex);
    if (!state) {
        return true;
    }
    const windowEnd = offset + rowCount;
    const margin = DISK_PAGE_SIZE;
    return state.visibleEnd >= offset - margin && state.visibleStart < windowEnd + margin;
}

function tryApplyWindowResult(
    resultSetIndex: number,
    offset: number,
    rows: unknown[][],
    filteredCount?: number,
    totalRows?: number,
): void {
    if (!isWindowResponseRelevant(resultSetIndex, offset, rows.length)) {
        return;
    }
    applyWindowResult(resultSetIndex, offset, rows, filteredCount, totalRows);
}

function resetGridScrollPosition(rsIndex: number): void {
    const wrappers = document.querySelectorAll('.grid-wrapper');
    const wrapper = wrappers[rsIndex] as HTMLElement | undefined;
    if (wrapper) {
        wrapper.scrollTop = 0;
    }
    const rs = getResultSetAt(rsIndex);
    const count = rs ? getDiskFilteredCount(rs) : 0;
    if (count <= 0) {
        return;
    }
    const grid = getGrid(rsIndex);
    try {
        grid?.scrollToIndex?.(0, 'auto');
    } catch {
        if (wrapper) {
            wrapper.scrollTop = 0;
        }
    }
}

function invalidateDiskWindowBuffer(rs: ResultSet, rsIndex: number): void {
    rs.data = [];
    rs.diskWindowStart = 0;
    if (diskQueryChangesRowCount(rs.diskQuerySpec)) {
        rs.diskFilteredCount = undefined;
    }
    const grid = getGrid(rsIndex);
    if (grid?.tanTable?.options) {
        grid.tanTable.options.data = [];
        grid.render?.();
    }
}

function decodeRows(rows: unknown): unknown[][] {
    if (rows instanceof Uint8Array || (rows && typeof rows === 'object' && (rows as { data?: number[] }).data instanceof Array)) {
        const rowData = rows as Uint8Array | { data?: number[] };
        const buffer = rowData instanceof Uint8Array ? rowData : new Uint8Array(rowData.data ?? []);
        return decode(buffer) as unknown[][];
    }
    if (Array.isArray(rows)) {
        return rows as unknown[][];
    }
    return [];
}

function postDiskQuery(
    rsIndex: number,
    action: 'window' | 'count' | 'distinct' | 'aggregate' | 'group',
    payload: Record<string, unknown>,
    pending: PendingDiskQueryRequest,
): number {
    const sourceUri = getActiveSourceUri();
    if (!sourceUri) {
        throw new Error('No active source URI');
    }
    const requestId = ++requestIdCounter;
    pendingDiskQueries.set(requestId, pending);
    const spec = getDiskQuerySpec(rsIndex) ?? syncDiskQuerySpecFromGrid(rsIndex);
    postHostMessage({
        command: 'diskQuery',
        sourceUri,
        resultSetIndex: rsIndex,
        requestId,
        action,
        querySpec: spec,
        ...payload,
    });
    return requestId;
}

export function requestRowsFromHost(
    sourceUri: string,
    resultSetIndex: number,
    offset: number,
    limit: number,
    requestType: 'window' | 'fetch',
    rsIndex?: number,
): number {
    const spec = getDiskQuerySpec(rsIndex ?? resultSetIndex);
    if (diskQuerySpecIsActive(spec)) {
        if (requestType === 'fetch') {
            return queryDiskRowsFetch(resultSetIndex, offset, limit);
        }
        return queryDiskWindow(resultSetIndex, offset, limit);
    }

    const requestId = ++requestIdCounter;
    if (requestType === 'window') {
        pendingRequests.set(requestId, { type: 'window', rsIndex: rsIndex ?? resultSetIndex, offset });
    } else {
        pendingRequests.set(requestId, {
            type: 'fetch',
            resolve: () => undefined,
            reject: () => undefined,
        });
    }

    postHostMessage({
        command: 'requestRows',
        sourceUri,
        resultSetIndex,
        offset,
        limit,
        requestId,
        querySpec: spec,
    });

    return requestId;
}

function queryDiskWindow(rsIndex: number, offset: number, limit: number): number {
    return postDiskQuery(rsIndex, 'window', { offset, limit }, {
        type: 'window',
        rsIndex,
        offset,
    });
}

function queryDiskRowsFetch(rsIndex: number, offset: number, limit: number): number {
    return postDiskQuery(rsIndex, 'window', { offset, limit }, {
        type: 'fetch',
        resolve: () => undefined,
        reject: () => undefined,
    });
}

export function fetchRowsFromHost(
    sourceUri: string,
    resultSetIndex: number,
    offset: number,
    limit: number,
): Promise<unknown[][]> {
    const spec = getDiskQuerySpec(resultSetIndex);
    if (diskQuerySpecIsActive(spec)) {
        return new Promise((resolve, reject) => {
            const requestId = postDiskQuery(resultSetIndex, 'window', { offset, limit }, {
                type: 'fetch',
                resolve,
                reject,
            });
            void requestId;
        });
    }

    return new Promise((resolve, reject) => {
        const requestId = ++requestIdCounter;
        pendingRequests.set(requestId, { type: 'fetch', resolve, reject });
        postHostMessage({
            command: 'requestRows',
            sourceUri,
            resultSetIndex,
            offset,
            limit,
            requestId,
        });
    });
}

export function queryDiskCount(rsIndex: number): Promise<number> {
    return new Promise((resolve, reject) => {
        postDiskQuery(rsIndex, 'count', {}, {
            type: 'count',
            rsIndex,
            resolve,
            reject,
        });
    });
}

export function queryDiskDistinctValues(
    rsIndex: number,
    columnIndex: number,
    specOverride?: DiskQuerySpec,
): Promise<{ values: DiskDistinctValue[]; truncated: boolean }> {
    return new Promise((resolve, reject) => {
        if (specOverride) {
            const rs = getResultSetAt(rsIndex);
            if (rs) {
                rs.diskQuerySpec = specOverride;
            }
        }
        postDiskQuery(rsIndex, 'distinct', {
            columnIndex,
            distinctLimit: DISK_QUERY_DISTINCT_LIMIT,
        }, {
            type: 'distinct',
            resolve,
            reject,
        });
    });
}

export function queryDiskAggregations(
    rsIndex: number,
    aggregations: Array<{ columnIndex: number; fn: string }>,
): Promise<DiskAggregationResult[]> {
    return new Promise((resolve, reject) => {
        postDiskQuery(rsIndex, 'aggregate', { aggregations }, {
            type: 'aggregate',
            resolve,
            reject,
        });
    });
}

export function queryDiskGroups(
    rsIndex: number,
    grouping: DiskGroupLevel[],
    groupPath: DiskGroupPathItem[],
    offset: number,
    limit: number,
    aggregations: Array<{ columnIndex: number; fn: string }> = [],
): Promise<DiskGroupQueryResult> {
    return new Promise((resolve, reject) => {
        postDiskQuery(rsIndex, 'group', {
            grouping,
            groupPath,
            offset,
            limit,
            aggregations,
        }, {
            type: 'group',
            rsIndex,
            resolve,
            reject,
        });
    });
}

export function refreshDiskQueryWindow(rsIndex: number, scrollToTop = true): void {
    const rs = getResultSetAt(rsIndex);
    if (!rs || rs.storageMode !== 'sqlite') {
        return;
    }
    const scheduled = ensureDiskWindowScheduled.get(rsIndex);
    if (scheduled !== undefined) {
        cancelAnimationFrame(scheduled);
        ensureDiskWindowScheduled.delete(rsIndex);
    }
    diskWindowRequestState.delete(rsIndex);
    cancelPendingWindowRequestsForResultSet(rsIndex);
    cancelPendingDiskQueriesForResultSet(rsIndex);
    syncDiskQuerySpecFromGrid(rsIndex);
    invalidateDiskWindowBuffer(rs, rsIndex);
    queryDiskWindow(rsIndex, 0, DISK_WINDOW_ROWS);
    if (scrollToTop) {
        resetGridScrollPosition(rsIndex);
    }
}

export function scheduleEnsureDiskWindow(
    rs: ResultSet,
    rsIndex: number,
    visibleStart: number,
    visibleEnd: number,
): void {
    const existing = ensureDiskWindowScheduled.get(rsIndex);
    if (existing !== undefined) {
        cancelAnimationFrame(existing);
    }
    const pending = diskWindowRequestState.get(rsIndex) ?? {
        visibleStart,
        visibleEnd,
        targetStart: 0,
    };
    pending.visibleStart = visibleStart;
    pending.visibleEnd = visibleEnd;
    diskWindowRequestState.set(rsIndex, pending);

    const frameId = requestAnimationFrame(() => {
        ensureDiskWindowScheduled.delete(rsIndex);
        const state = diskWindowRequestState.get(rsIndex);
        if (!state) {
            return;
        }
        const rsNow = getResultSetAt(rsIndex) ?? rs;
        ensureDiskWindow(rsNow, rsIndex, state.visibleStart, state.visibleEnd);
    });
    ensureDiskWindowScheduled.set(rsIndex, frameId);
}

export function ensureDiskWindow(
    rs: ResultSet,
    rsIndex: number,
    visibleStart: number,
    visibleEnd: number,
): void {
    if (rs.storageMode !== 'sqlite') {
        return;
    }

    const sourceUri = getActiveSourceUri();
    if (!sourceUri) {
        return;
    }

    const spec = getDiskQuerySpec(rsIndex);
    const totalRows = diskQuerySpecIsActive(spec)
        ? (rs.diskFilteredCount ?? rs.totalRowCount ?? 0)
        : (rs.totalRowCount ?? 0);
    const windowStart = rs.diskWindowStart ?? 0;
    const windowEnd = windowStart + rs.data.length;
    const targetStart = Math.max(0, visibleStart - DISK_PAGE_SIZE);
    const targetEnd = Math.min(totalRows, visibleEnd + DISK_PAGE_SIZE + 1);
    const neededSize = Math.min(DISK_WINDOW_ROWS, Math.max(0, targetEnd - targetStart));

    if (neededSize === 0) {
        return;
    }

    if (targetStart >= windowStart && targetEnd <= windowEnd) {
        return;
    }

    diskWindowRequestState.set(rsIndex, {
        visibleStart,
        visibleEnd,
        targetStart,
    });
    cancelPendingWindowRequestsForResultSet(rsIndex);

    requestRowsFromHost(sourceUri, rsIndex, targetStart, neededSize, 'window', rsIndex);
}

function applyWindowResult(
    resultSetIndex: number,
    offset: number,
    rows: unknown[][],
    filteredCount?: number,
    totalRows?: number,
): void {
    const resultSet = getResultSetAt(resultSetIndex);
    if (!resultSet || resultSet.storageMode !== 'sqlite') {
        return;
    }

    resultSet.data = rows;
    resultSet.diskWindowStart = offset;
    if (typeof filteredCount === 'number') {
        resultSet.diskFilteredCount = filteredCount;
    }
    if (typeof totalRows === 'number') {
        resultSet.totalRowCount = totalRows;
    }

    const grid = getGrid(resultSetIndex);
    const wrapper = getGridWrapperForResultSet(resultSetIndex);
    const scrollTarget = getScrollTarget(wrapper);
    const preservedScrollTop = scrollTarget?.scrollTop ?? 0;
    const preservedScrollLeft = scrollTarget?.scrollLeft ?? 0;
    if (grid?.tanTable?.options) {
        grid.tanTable.options.data = resultSet.data;
        grid.render?.();
        if (scrollTarget && preservedScrollTop > 0) {
            scrollTarget.scrollTop = preservedScrollTop;
            scrollTarget.scrollLeft = preservedScrollLeft;
        }
    }
    updateRowCountInfo(resultSetIndex, resultSet.totalRowCount ?? 0, resultSet.limitReached === true);
}

export function handleRowWindow(message: Record<string, unknown>): void {
    const requestId = message.requestId as number | undefined;
    const offset = message.offset as number;
    const resultSetIndex = message.resultSetIndex as number;
    const rows = decodeRows(message.rows);
    const totalRows = message.totalRows as number | undefined;
    const filteredCount = message.filteredCount as number | undefined;

    if (requestId !== undefined) {
        const pending = pendingRequests.get(requestId);
        if (pending?.type === 'fetch') {
            pending.resolve(rows);
            pendingRequests.delete(requestId);
            return;
        }
        if (pending?.type === 'window') {
            pendingRequests.delete(requestId);
        }
    }

    tryApplyWindowResult(resultSetIndex, offset, rows, filteredCount ?? totalRows, totalRows);
}

export function handleDiskQueryResult(message: Record<string, unknown>): void {
    const requestId = message.requestId as number | undefined;
    const action = message.action as string;
    const resultSetIndex = message.resultSetIndex as number;

    if (requestId === undefined) {
        return;
    }

    const pending = pendingDiskQueries.get(requestId);
    if (!pending) {
        if (action === 'count') {
            const rs = getResultSetAt(resultSetIndex);
            if (rs && rs.storageMode === 'sqlite') {
                rs.diskFilteredCount = message.filteredCount as number;
                const grid = getGrid(resultSetIndex);
                grid?.render?.();
                updateRowCountInfo(resultSetIndex, rs.totalRowCount ?? 0, rs.limitReached === true);
            }
        } else if (action === 'window') {
            const rows = decodeRows(message.rows);
            const offset = message.offset as number;
            const filteredCount = message.filteredCount as number | undefined;
            const totalRows = message.totalRows as number | undefined;
            tryApplyWindowResult(resultSetIndex, offset, rows, filteredCount, totalRows);
        }
        return;
    }
    pendingDiskQueries.delete(requestId);

    if (action === 'window') {
        const rows = decodeRows(message.rows);
        const offset = message.offset as number;
        const filteredCount = message.filteredCount as number | undefined;
        const totalRows = message.totalRows as number | undefined;

        if (pending.type === 'fetch') {
            pending.resolve(rows);
            return;
        }

        tryApplyWindowResult(resultSetIndex, offset, rows, filteredCount, totalRows);
        return;
    }

    if (action === 'count' && pending.type === 'count') {
        pending.resolve(message.filteredCount as number);
        return;
    }

    if (action === 'distinct' && pending.type === 'distinct') {
        pending.resolve({
            values: (message.distinctValues as DiskDistinctValue[]) ?? [],
            truncated: message.distinctTruncated === true,
        });
        return;
    }

    if (action === 'aggregate' && pending.type === 'aggregate') {
        pending.resolve((message.aggregations as DiskAggregationResult[]) ?? []);
        return;
    }

    if (action === 'group' && pending.type === 'group') {
        pending.resolve((message.groupResult as DiskGroupQueryResult) ?? {
            kind: 'groups',
            path: [],
            depth: 0,
            totalCount: 0,
            groups: [],
        });
    }
}

export function handleDiskBackedActivate(message: Record<string, unknown>): void {
    const resultSetIndex = message.resultSetIndex as number;
    const totalRows = message.totalRows as number;
    const columns = message.columns as ResultSet['columns'];
    const limitReached = message.limitReached as boolean | undefined;
    const rows = decodeRows(message.rows);

    let rs = getResultSetAt(resultSetIndex);
    if (!rs) {
        rs = {
            columns: columns ?? [],
            data: rows,
            storageMode: 'sqlite',
            totalRowCount: totalRows,
            diskWindowStart: 0,
            diskFilteredCount: totalRows,
            limitReached: limitReached === true,
            isEditable: false,
        };
        const next = [...getResultSets()];
        next[resultSetIndex] = rs;
        setResultSets(next);
    } else {
        rs.storageMode = 'sqlite';
        rs.totalRowCount = totalRows;
        rs.diskFilteredCount = totalRows;
        rs.diskWindowStart = 0;
        rs.data = rows;
        rs.diskQuerySpec = undefined;
        rs.isEditable = false;
        if (columns && columns.length > 0) {
            rs.columns = columns;
        }
        if (limitReached === true) {
            rs.limitReached = true;
        }
    }

    clearAllSearchWorkerData();
    clearDiskBackedPendingRequests();
    resetEditSession();
    renderGrids();
    updateRowCountInfo(resultSetIndex, totalRows, limitReached === true);
    callPanelMethod('updateEditButtons');
}

export function handleRowCountUpdate(message: Record<string, unknown>): void {
    const resultSetIndex = message.resultSetIndex as number;
    const totalRows = message.totalRows as number;
    const limitReached = message.limitReached as boolean | undefined;

    const rs = getResultSetAt(resultSetIndex);
    if (!rs) {
        return;
    }

    syncDiskStreamingRowCount(rs, totalRows);
    if (limitReached === true) {
        rs.limitReached = true;
    }

    const grid = getGrid(resultSetIndex);
    if (grid?.tanTable?.options && rs.data.length > 0) {
        grid.tanTable.options.data = rs.data;
        grid.createVirtualizer?.();
        grid.renderTableRows?.();
    }

    updateRowCountInfo(resultSetIndex, totalRows, limitReached === true);
}

export function prepareDiskFilterWindow(rsIndex: number): void {
    refreshDiskQueryWindow(rsIndex, true);
}

export function isDiskBackedResultSet(rs: ResultSet | undefined): boolean {
    return rs?.storageMode === 'sqlite';
}

export interface DiskGridViewState {
    isDiskBacked: boolean;
    isDiskQueryActive: boolean;
    virtualizerCount: number;
}

export function resolveDiskGridViewState(rsIndex: number): DiskGridViewState {
    const rs = getResultSetAt(rsIndex);
    const isDiskBacked = isDiskBackedResultSet(rs);
    const spec = getDiskQuerySpec(rsIndex);
    const isDiskQueryActive = isDiskBacked && diskQuerySpecIsActive(spec);

    const virtualizerCount = isDiskBacked
        ? getDiskFilteredCount(rs)
        : 0;

    return {
        isDiskBacked,
        isDiskQueryActive,
        virtualizerCount,
    };
}

export function clearDiskBackedPendingRequests(): void {
    for (const pending of pendingRequests.values()) {
        if (pending.type === 'fetch') {
            pending.reject(new Error('Disk-backed row request cancelled'));
        }
    }
    for (const pending of pendingDiskQueries.values()) {
        if (pending.type === 'fetch') {
            pending.reject(new Error('Disk-backed query request cancelled'));
        } else if (pending.type === 'count') {
            pending.reject(new Error('Disk-backed count request cancelled'));
        } else if (pending.type === 'distinct') {
            pending.reject(new Error('Disk-backed distinct request cancelled'));
        } else if (pending.type === 'aggregate') {
            pending.reject(new Error('Disk-backed aggregate request cancelled'));
        } else if (pending.type === 'group') {
            pending.reject(new Error('Disk-backed group request cancelled'));
        }
    }
    pendingRequests.clear();
    pendingDiskQueries.clear();
}
