import { queryDiskGroups, DISK_WINDOW_ROWS } from './diskBackedGrid.js';
import { getGrid } from './state.js';
import type {
    DiskAggregationResult,
    DiskGroupLevel,
    DiskGroupPathItem,
    DiskGroupQueryResult,
    DiskGroupRow,
} from './types.js';

export type DiskGroupingDisplayRow =
    | { kind: 'group'; group: DiskGroupRow }
    | { kind: 'leaf'; row: unknown[]; depth: number; path: DiskGroupPathItem[] }
    | { kind: 'footer'; group: DiskGroupRow; aggregations: DiskAggregationResult[] }
    | { kind: 'loading'; depth: number };

interface PathLoadMeta {
    loaded: number;
    total: number;
}

interface DiskGroupingState {
    grouping: string[];
    aggregationKey: string;
    aggregations: Array<{ columnIndex: number; fn: string }>;
    version: number;
    rootRows: DiskGroupingDisplayRow[];
    rootTotalCount: number;
    expandedKeys: Set<string>;
    loadingKeys: Set<string>;
    childrenByKey: Map<string, DiskGroupingDisplayRow[]>;
    pathMeta: Map<string, PathLoadMeta>;
}

const diskGroupingStates = new Map<number, DiskGroupingState>();
const GROUP_LOAD_MARGIN = 50;

function groupingKey(grouping: string[]): string {
    return grouping.join('|');
}

function aggregationKey(aggregations: Array<{ columnIndex: number; fn: string }>): string {
    return JSON.stringify(aggregations);
}

function pathKey(path: DiskGroupPathItem[]): string {
    return JSON.stringify(path.map((item) => [item.columnIndex, item.value ?? null]));
}

function parsePathKey(key: string): DiskGroupPathItem[] | null {
    try {
        const parsed = JSON.parse(key) as Array<[number, unknown]>;
        if (!Array.isArray(parsed)) {
            return null;
        }
        return parsed.map(([columnIndex, value]) => ({
            columnIndex,
            value: value as string | number | boolean | null,
        }));
    } catch {
        return null;
    }
}

function pathIsDescendantOrSelf(path: DiskGroupPathItem[], ancestor: DiskGroupPathItem[]): boolean {
    if (path.length < ancestor.length) {
        return false;
    }
    for (let i = 0; i < ancestor.length; i++) {
        if (path[i].columnIndex !== ancestor[i].columnIndex) {
            return false;
        }
        if (path[i].value !== ancestor[i].value) {
            return false;
        }
    }
    return true;
}

function loadExpandedPaths(rsIndex: number, state: DiskGroupingState, keys: Iterable<string>): void {
    for (const key of keys) {
        const pathItems = parsePathKey(key);
        if (!pathItems) {
            continue;
        }
        const childKey = pathKey(pathItems);
        if (!state.childrenByKey.has(childKey) && !state.loadingKeys.has(childKey)) {
            void loadPath(rsIndex, state, pathItems);
        }
    }
}

function toGroupLevels(grouping: string[]): DiskGroupLevel[] {
    return grouping
        .map((columnId) => Number.parseInt(columnId, 10))
        .filter((columnIndex) => Number.isInteger(columnIndex) && columnIndex >= 0)
        .map((columnIndex) => ({ columnIndex }));
}

function getOrCreateState(
    rsIndex: number,
    grouping: string[],
    aggregations: Array<{ columnIndex: number; fn: string }> = [],
): DiskGroupingState {
    const existing = diskGroupingStates.get(rsIndex);
    const nextAggregationKey = aggregationKey(aggregations);
    if (
        existing
        && groupingKey(existing.grouping) === groupingKey(grouping)
        && existing.aggregationKey === nextAggregationKey
    ) {
        return existing;
    }
    const next: DiskGroupingState = {
        grouping: [...grouping],
        aggregationKey: nextAggregationKey,
        aggregations: [...aggregations],
        version: (existing?.version ?? 0) + 1,
        rootRows: [],
        rootTotalCount: 0,
        expandedKeys: new Set(),
        loadingKeys: new Set(),
        childrenByKey: new Map(),
        pathMeta: new Map(),
    };
    diskGroupingStates.set(rsIndex, next);
    return next;
}

function mapGroupResult(result: DiskGroupQueryResult): DiskGroupingDisplayRow[] {
    if (result.kind === 'leafRows') {
        return (result.rows ?? []).map((row) => ({
            kind: 'leaf',
            row,
            depth: result.depth,
            path: result.path,
        }));
    }
    return (result.groups ?? []).map((group) => ({ kind: 'group', group }));
}

function countDisplayRows(rows: DiskGroupingDisplayRow[]): number {
    return rows.filter((row) => row.kind === 'group' || row.kind === 'leaf').length;
}

function notifyGrid(rsIndex: number): void {
    const grid = getGrid(rsIndex);
    grid?.createVirtualizer?.();
    grid?.render?.();
}

function mergeLoadedRows(
    state: DiskGroupingState,
    path: DiskGroupPathItem[],
    offset: number,
    rows: DiskGroupingDisplayRow[],
    totalCount: number,
): void {
    const key = pathKey(path);
    if (path.length === 0) {
        if (offset === 0) {
            state.rootRows = rows;
        } else {
            state.rootRows.push(...rows);
        }
        state.rootTotalCount = totalCount;
    } else {
        const existing = state.childrenByKey.get(key) ?? [];
        state.childrenByKey.set(key, offset === 0 ? rows : [...existing, ...rows]);
    }
    state.pathMeta.set(key, {
        loaded: path.length === 0
            ? countDisplayRows(state.rootRows)
            : countDisplayRows(state.childrenByKey.get(key) ?? []),
        total: totalCount,
    });
}

async function loadPath(
    rsIndex: number,
    state: DiskGroupingState,
    path: DiskGroupPathItem[],
    offset = 0,
    limit = DISK_WINDOW_ROWS,
): Promise<void> {
    const key = pathKey(path);
    const version = state.version;
    state.loadingKeys.add(key);
    try {
        const result = await queryDiskGroups(
            rsIndex,
            toGroupLevels(state.grouping),
            path,
            offset,
            limit,
            state.aggregations,
        );
        const current = diskGroupingStates.get(rsIndex);
        if (!current || current.version !== version) {
            return;
        }
        const rows = mapGroupResult(result);
        mergeLoadedRows(current, path, offset, rows, result.totalCount);
    } catch {
        const current = diskGroupingStates.get(rsIndex);
        if (current?.version === version) {
            if (offset === 0) {
                if (path.length === 0) {
                    current.rootRows = [];
                    current.rootTotalCount = 0;
                } else {
                    current.childrenByKey.set(key, []);
                }
                current.pathMeta.delete(key);
            }
        }
    } finally {
        const current = diskGroupingStates.get(rsIndex);
        if (current?.version === version) {
            current.loadingKeys.delete(key);
            notifyGrid(rsIndex);
        }
    }
}

function pathNeedsMoreData(state: DiskGroupingState, path: DiskGroupPathItem[]): boolean {
    const key = pathKey(path);
    if (state.loadingKeys.has(key)) {
        return false;
    }
    const meta = state.pathMeta.get(key);
    if (!meta) {
        if (path.length === 0) {
            return state.rootTotalCount > countDisplayRows(state.rootRows);
        }
        return state.expandedKeys.has(key) && !state.childrenByKey.has(key);
    }
    return meta.loaded < meta.total;
}

export function refreshDiskGrouping(
    rsIndex: number,
    grouping: string[],
    aggregations: Array<{ columnIndex: number; fn: string }> = [],
): void {
    if (grouping.length === 0) {
        diskGroupingStates.delete(rsIndex);
        notifyGrid(rsIndex);
        return;
    }
    const previous = diskGroupingStates.get(rsIndex);
    const preservedExpanded = previous && groupingKey(previous.grouping) === groupingKey(grouping)
        ? [...previous.expandedKeys]
        : [];
    const state = getOrCreateState(rsIndex, grouping, aggregations);
    state.version += 1;
    state.aggregations = [...aggregations];
    state.aggregationKey = aggregationKey(aggregations);
    state.rootRows = [];
    state.rootTotalCount = 0;
    state.expandedKeys = new Set(preservedExpanded);
    state.loadingKeys.clear();
    state.childrenByKey.clear();
    state.pathMeta.clear();
    void loadPath(rsIndex, state, []);
    loadExpandedPaths(rsIndex, state, preservedExpanded);
}

export function ensureDiskGrouping(
    rsIndex: number,
    grouping: string[],
    aggregations: Array<{ columnIndex: number; fn: string }> = [],
): void {
    if (grouping.length === 0) {
        diskGroupingStates.delete(rsIndex);
        return;
    }
    const state = getOrCreateState(rsIndex, grouping, aggregations);
    if (state.rootRows.length === 0 && !state.loadingKeys.has(pathKey([]))) {
        void loadPath(rsIndex, state, []);
    }
}

export function clearDiskGrouping(rsIndex: number): void {
    diskGroupingStates.delete(rsIndex);
}

export function clearAllDiskGrouping(): void {
    diskGroupingStates.clear();
}

function flattenStateRows(state: DiskGroupingState): DiskGroupingDisplayRow[] {
    const rows: DiskGroupingDisplayRow[] = [];
    if (state.rootRows.length === 0 && state.loadingKeys.has(pathKey([]))) {
        return [{ kind: 'loading', depth: 0 }];
    }

    const appendRows = (items: DiskGroupingDisplayRow[]) => {
        for (const item of items) {
            rows.push(item);
            if (item.kind !== 'group') {
                continue;
            }
            const key = pathKey(item.group.path);
            if (!state.expandedKeys.has(key)) {
                continue;
            }
            const children = state.childrenByKey.get(key);
            if (children) {
                appendRows(children);
                if ((item.group.aggregations?.length ?? 0) > 0) {
                    rows.push({
                        kind: 'footer',
                        group: item.group,
                        aggregations: item.group.aggregations ?? [],
                    });
                }
            } else if (state.loadingKeys.has(key)) {
                rows.push({ kind: 'loading', depth: item.group.depth + 1 });
            }
        }
    };

    appendRows(state.rootRows);
    return rows;
}

export function getDiskGroupingRows(rsIndex: number): DiskGroupingDisplayRow[] {
    const state = diskGroupingStates.get(rsIndex);
    return state ? flattenStateRows(state) : [];
}

export function getDiskGroupingRowCount(rsIndex: number): number {
    return getDiskGroupingRows(rsIndex).length;
}

export function getDiskGroupingLeafRowAt(rsIndex: number, flatIndex: number): unknown[] | undefined {
    const row = getDiskGroupingRows(rsIndex)[flatIndex];
    return row?.kind === 'leaf' ? row.row : undefined;
}

export function getDiskGroupingExpandedKeys(rsIndex: number): string[] {
    const state = diskGroupingStates.get(rsIndex);
    return state ? [...state.expandedKeys] : [];
}

export function restoreDiskGroupingExpandedKeys(rsIndex: number, keys: string[]): void {
    const state = diskGroupingStates.get(rsIndex);
    if (!state || keys.length === 0) {
        return;
    }
    for (const key of keys) {
        state.expandedKeys.add(key);
    }
    loadExpandedPaths(rsIndex, state, keys);
}

export function getDiskGroupingTruncationMessage(rsIndex: number): string | null {
    const state = diskGroupingStates.get(rsIndex);
    if (!state) {
        return null;
    }
    const messages: string[] = [];
    const rootMeta = state.pathMeta.get(pathKey([]));
    if (rootMeta && rootMeta.loaded < rootMeta.total) {
        messages.push(
            `Showing ${rootMeta.loaded.toLocaleString()} of ${rootMeta.total.toLocaleString()} top-level groups. Scroll to load more.`,
        );
    }
    for (const [key, meta] of state.pathMeta.entries()) {
        if (key === pathKey([]) || meta.loaded >= meta.total) {
            continue;
        }
        messages.push(
            `A grouped section is showing ${meta.loaded.toLocaleString()} of ${meta.total.toLocaleString()} rows. Scroll to load more.`,
        );
        break;
    }
    return messages.length > 0 ? messages.join(' ') : null;
}

function findLastRootGroupFlatIndex(flatRows: DiskGroupingDisplayRow[]): number {
    let lastIndex = -1;
    for (let i = 0; i < flatRows.length; i++) {
        const row = flatRows[i];
        if (row.kind === 'group' && row.group.depth === 0) {
            lastIndex = i;
        }
    }
    return lastIndex;
}

function findExpandedPathLoadTriggerIndex(
    flatRows: DiskGroupingDisplayRow[],
    expandedKey: string,
): number {
    const expandedPath = parsePathKey(expandedKey);
    if (!expandedPath) {
        return -1;
    }

    let endIndex = -1;
    let inExpanded = false;
    for (let i = 0; i < flatRows.length; i++) {
        const row = flatRows[i];
        if (row.kind === 'group' && pathKey(row.group.path) === expandedKey) {
            inExpanded = true;
            continue;
        }
        if (!inExpanded) {
            continue;
        }
        if (row.kind === 'group') {
            if (!pathIsDescendantOrSelf(row.group.path, expandedPath)) {
                break;
            }
            endIndex = i;
            continue;
        }
        if (row.kind === 'leaf') {
            if (!pathIsDescendantOrSelf(row.path, expandedPath)) {
                break;
            }
            endIndex = i;
            continue;
        }
        if (row.kind === 'loading') {
            endIndex = i;
            continue;
        }
        if (row.kind === 'footer' && pathKey(row.group.path) === expandedKey) {
            endIndex = i;
            break;
        }
    }
    return endIndex;
}

export function ensureDiskGroupingPagesLoaded(
    rsIndex: number,
    visibleStart: number,
    visibleEnd: number,
): void {
    void visibleStart;
    const state = diskGroupingStates.get(rsIndex);
    if (!state) {
        return;
    }

    const flatRows = flattenStateRows(state);
    const expandedCandidates: Array<{ path: DiskGroupPathItem[]; triggerIndex: number }> = [];

    for (const key of state.expandedKeys) {
        const pathItems = parsePathKey(key);
        if (!pathItems || !pathNeedsMoreData(state, pathItems)) {
            continue;
        }
        const triggerIndex = findExpandedPathLoadTriggerIndex(flatRows, key);
        if (triggerIndex >= 0 && visibleEnd >= triggerIndex - GROUP_LOAD_MARGIN) {
            expandedCandidates.push({ path: pathItems, triggerIndex });
        }
    }

    if (expandedCandidates.length > 0) {
        expandedCandidates.sort((a, b) => a.triggerIndex - b.triggerIndex);
        const { path } = expandedCandidates[0];
        const key = pathKey(path);
        const meta = state.pathMeta.get(key);
        const offset = meta?.loaded ?? countDisplayRows(state.childrenByKey.get(key) ?? []);
        void loadPath(rsIndex, state, path, offset, DISK_WINDOW_ROWS);
        return;
    }

    if (pathNeedsMoreData(state, [])) {
        const triggerIndex = findLastRootGroupFlatIndex(flatRows);
        if (triggerIndex >= 0 && visibleEnd >= triggerIndex - GROUP_LOAD_MARGIN) {
            const meta = state.pathMeta.get(pathKey([]));
            const offset = meta?.loaded ?? countDisplayRows(state.rootRows);
            void loadPath(rsIndex, state, [], offset, DISK_WINDOW_ROWS);
        }
    }
}

export function toggleDiskGroupRow(rsIndex: number, group: DiskGroupRow): void {
    const state = diskGroupingStates.get(rsIndex);
    if (!state) {
        return;
    }
    const key = pathKey(group.path);
    if (state.expandedKeys.has(key)) {
        state.expandedKeys.delete(key);
        notifyGrid(rsIndex);
        return;
    }
    state.expandedKeys.add(key);
    if (!state.childrenByKey.has(key) && !state.loadingKeys.has(key)) {
        void loadPath(rsIndex, state, group.path);
    }
    notifyGrid(rsIndex);
}

export function isDiskGroupRowExpanded(rsIndex: number, group: DiskGroupRow): boolean {
    return diskGroupingStates.get(rsIndex)?.expandedKeys.has(pathKey(group.path)) === true;
}
