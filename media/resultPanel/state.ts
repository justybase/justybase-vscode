// State module - Global state management for result panel
import type {
    AggregationSelection,
    ColumnAggregationState,
    ColumnAggregationValue,
    ColumnFilterValue,
    GridHandle,
    GridScrollState,
    ResultSet,
} from './types.js';
import { getResultPanelWindow } from './types.js';

interface SourceCacheEntry {
    resultSets?: ResultSet[];
    activeGridIndex?: number;
    scrollStates?: Record<number, unknown>;
    lastAccess?: number;
}

/** Max SQL sources whose full resultSets references are kept in webview memory. */
const MAX_SOURCE_RESULTS_CACHE = 2;

interface GlobalDragState {
    isDragging: boolean;
    dragType: string | null;
    draggedItem: string | null;
}

interface PendingEdit {
    rowIndex: number;
    columnIndex: number;
    oldValue: unknown;
    newValue: unknown;
}

type ColumnFilterStateMap = Record<string, ColumnFilterValue>;

// Grid state
export let grids: Array<GridHandle | null> = [];
export let activeGridIndex = 0;

// Source results cache
export const sourceResultsCache: Record<string, SourceCacheEntry> = {};

// Separate scroll state cache - persists across document switches and hydrations
export const scrollStatesCache: Record<string, Record<number, unknown>> = {};

// Column filter states per grid
export let columnFilterStates: Record<number, Record<string, ColumnFilterValue>> = {};

// Global filter input state per result set
export let globalFilterStates: Record<string, string> = {};

// Aggregation selection per grid
export let aggregationStates: Record<string, Record<string, ColumnAggregationState>> = {};

// Search worker and search state
export let searchWorker: Worker | null = null;
export let searchMatches: Record<number, Set<number>> = {};
const searchMatchSortedIndices: Record<number, number[]> = {};
export let isSearching = false;

// Global drag state management
export let globalDragState: GlobalDragState = {
    isDragging: false,
    dragType: null,
    draggedItem: null
};

// Layout mode state ('top' | 'sidebar')
export let layoutMode = 'top';
export function getLayoutMode() { return layoutMode; }
export function setLayoutMode(mode: string): void { layoutMode = mode; }

// Row view state
export let isRowViewOpen = false;

// Edit mode state
export let isEditMode = false;
export let pendingEdits: PendingEdit[] = []; // { rowIndex, columnIndex, oldValue, newValue }
export let pendingDeletes = new Set<number>(); // Set<rowIndex>
export function getIsEditMode(): boolean {
    return isEditMode;
}
export function setIsEditMode(val: boolean): void {
    isEditMode = val;
}
export function getPendingEdits(): PendingEdit[] {
    return pendingEdits;
}
export function setPendingEdits(edits: PendingEdit[]): void {
    pendingEdits = edits;
}
export function clearPendingEdits(): void {
    pendingEdits = [];
}
export function getPendingDeletes(): Set<number> {
    return pendingDeletes;
}
export function clearPendingDeletes(): void {
    pendingDeletes.clear();
}

/** Exit edit mode and discard pending cell/row changes (tab/source switch). */
export function resetEditSession(): void {
    clearPendingEdits();
    clearPendingDeletes();
    setIsEditMode(false);
}

/** Disk-backed result sets are not inline-editable; keep webview cache aligned. */
export function normalizeResultSetsEditability(resultSets: ResultSet[]): void {
    for (const rs of resultSets) {
        if (!rs) {
            continue;
        }
        if (rs.storageMode === 'sqlite') {
            rs.isEditable = false;
        }
    }
}
export function markRowForDelete(rowIndex: number): void {
    pendingDeletes.add(rowIndex);
}
export function unmarkRowForDelete(rowIndex: number): void {
    pendingDeletes.delete(rowIndex);
}
export function isRowMarkedForDelete(rowIndex: number): boolean {
    return pendingDeletes.has(rowIndex);
}

export function addPendingEdit(
    rowIndex: number,
    columnIndex: number,
    oldValue: unknown,
    newValue: unknown,
): void {
    // Replace existing edit for same cell, or add new
    var existingIndex = -1;
    for (var i = 0; i < pendingEdits.length; i++) {
        var e = pendingEdits[i];
        if (e.rowIndex === rowIndex && e.columnIndex === columnIndex) {
            existingIndex = i;
            break;
        }
    }
    var edit = { rowIndex: rowIndex, columnIndex: columnIndex, oldValue: oldValue, newValue: newValue };
    if (existingIndex >= 0) {
        pendingEdits[existingIndex] = edit;
    } else {
        pendingEdits.push(edit);
    }
}

// Pinned columns state per grid
export let pinnedColumnsState: Record<string, string[]> = {};

// Result formatting state
export let resultFormattingPayload = {
    global: {
        integer: { useGrouping: true, groupSeparator: ' ' },
        decimal: {
            useGrouping: true,
            groupSeparator: ' ',
            decimalSeparator: '.',
            scale: 4,
            preserveTrailingZeros: true,
            roundingMode: 'half-up'
        },
        useFormattedValuesForExport: false
    },
    columnOverrides: {}
};
export let resultFormattingStates: Record<string, Record<string, unknown>> = {};

// Window state variables
export function initializeWindowState(): void {
    const panel = getResultPanelWindow();
    panel.sourceResultsCache = sourceResultsCache;
    panel.grids = grids as GridHandle[];
    panel.resultFormattingPayload = resultFormattingPayload;
    panel.layoutMode = layoutMode;
}

// Grid state functions
export function setActiveGridIndex(index: number): void {
    activeGridIndex = index;
}

export function getActiveGridIndex(): number {
    return activeGridIndex;
}

export function resetGrids(): void {
    grids = [];
}

export function addGrid(grid: GridHandle | null): void {
    grids.push(grid);
}

export function getGrid(index: number): GridHandle | null | undefined {
    return grids[index];
}

export function getAllGrids(): Array<GridHandle | null> {
    return grids;
}

// State management functions
export function saveCurrentSourceToCache(
    activeSource: string | undefined,
    resultSets: ResultSet[],
    gridIndex: number,
): void {
    if (!activeSource) return;
    
    normalizeResultSetsEditability(resultSets);
    sourceResultsCache[activeSource] = {
        resultSets: resultSets,
        activeGridIndex: gridIndex,
        lastAccess: Date.now(),
    };
    pruneSourceResultsCache(activeSource);
}

export function releaseResultSetRows(resultSet: ResultSet | undefined): void {
    if (!resultSet || !Array.isArray(resultSet.data)) {
        return;
    }
    resultSet.data.length = 0;
}

export function releaseResultSetsRows(resultSets: ResultSet[] | undefined): void {
    if (!Array.isArray(resultSets)) {
        return;
    }
    for (const resultSet of resultSets) {
        releaseResultSetRows(resultSet);
    }
}

function releaseSourceCacheEntry(entry: SourceCacheEntry | undefined): void {
    releaseResultSetsRows(entry?.resultSets);
}

export function pruneSourceResultsCache(keepSource: string): void {
    const keys = Object.keys(sourceResultsCache);
    if (keys.length <= MAX_SOURCE_RESULTS_CACHE) {
        return;
    }

    const victims = keys
        .filter(key => key !== keepSource)
        .sort((a, b) => (sourceResultsCache[a]?.lastAccess ?? 0) - (sourceResultsCache[b]?.lastAccess ?? 0));

    while (Object.keys(sourceResultsCache).length > MAX_SOURCE_RESULTS_CACHE) {
        const victim = victims.shift();
        if (!victim) {
            break;
        }
        releaseSourceCacheEntry(sourceResultsCache[victim]);
        delete sourceResultsCache[victim];
    }
}

export function evictSourceCacheNotInList(activeSources: string[]): void {
    const allowed = new Set(activeSources);
    for (const key of Object.keys(sourceResultsCache)) {
        if (!allowed.has(key)) {
            releaseSourceCacheEntry(sourceResultsCache[key]);
            delete sourceResultsCache[key];
        }
    }
}

export function getCachedSource(sourceUri: string): SourceCacheEntry | undefined {
    const entry = sourceResultsCache[sourceUri];
    if (entry) {
        entry.lastAccess = Date.now();
    }
    return entry;
}

export function saveScrollStateForSource(
    activeSource: string | undefined,
    rsIndex: number,
    scrollState: GridScrollState,
): void {
    if (!activeSource || !sourceResultsCache[activeSource]) return;
    if (!sourceResultsCache[activeSource].scrollStates) {
        sourceResultsCache[activeSource].scrollStates = {};
    }
    sourceResultsCache[activeSource].scrollStates![rsIndex] = scrollState;
}

export function getScrollStateForSource(
    activeSource: string | undefined,
    rsIndex: number,
): unknown {
    if (!activeSource || !sourceResultsCache[activeSource]) return null;
    return sourceResultsCache[activeSource].scrollStates?.[rsIndex] || null;
}

export function getScrollStateFromCache(sourceUri: string, rsIndex: number): unknown {
    const cached = sourceResultsCache[sourceUri];
    if (!cached || !cached.scrollStates) return null;
    return cached.scrollStates[rsIndex] || null;
}

// Scroll state cache functions - persists across hydrations
export function saveScrollStateToCache(
    sourceUri: string | undefined,
    rsIndex: number,
    scrollState: GridScrollState,
): void {
    if (!sourceUri) return;
    if (!scrollStatesCache[sourceUri]) {
        scrollStatesCache[sourceUri] = {};
    }
    scrollStatesCache[sourceUri][rsIndex] = scrollState;
}

export function getScrollStateFromGlobalCache(sourceUri: string | undefined, rsIndex: number): unknown {
    if (!sourceUri || !scrollStatesCache[sourceUri]) return null;
    return scrollStatesCache[sourceUri][rsIndex] || null;
}

export function clearScrollStatesForSource(sourceUri: string): void {
    if (scrollStatesCache[sourceUri]) {
        delete scrollStatesCache[sourceUri];
    }
}

export function clearSourceCache(sourceUri: string): void {
    releaseSourceCacheEntry(sourceResultsCache[sourceUri]);
    delete sourceResultsCache[sourceUri];
}

// State getters/setters for column filters
export function getColumnFilterState(rsIndex: number): ColumnFilterStateMap {
    return columnFilterStates[rsIndex] || {};
}

export function setColumnFilterState(rsIndex: number, state: ColumnFilterStateMap): void {
    columnFilterStates[rsIndex] = state;
}

// Helper function to build state key
function buildStateKey(
    rsIndex: number,
    executionTimestamp: number | undefined,
    sourceUri: string | undefined,
): string {
    const timestamp = executionTimestamp || '';
    const source = sourceUri || getResultPanelWindow().activeSource || '';
    return `${source}:${rsIndex}:${timestamp}`;
}

// Global filter state functions
export function getGlobalFilterState(
    rsIndex: number,
    executionTimestamp: number | undefined,
    sourceUri: string | undefined,
): string {
    const key = buildStateKey(rsIndex, executionTimestamp, sourceUri);
    return globalFilterStates[key] || '';
}

export function setGlobalFilterState(
    rsIndex: number,
    filterValue: string,
    executionTimestamp: number | undefined,
    sourceUri: string | undefined,
): void {
    const key = buildStateKey(rsIndex, executionTimestamp, sourceUri);
    globalFilterStates[key] = filterValue || '';
}

// Normalize a single aggregation item (old string format → new object format)
function normalizeAggItem(agg: ColumnAggregationValue | unknown): AggregationSelection | unknown {
    if (typeof agg === 'string') {
        return { fn: agg, precision: null, position: 'bottom' };
    }
    if (agg && typeof agg === 'object') {
        const item = agg as Partial<AggregationSelection> & { fn?: string };
        return {
            fn: item.fn || 'sum',
            precision: item.precision ?? null,
            position: item.position || 'bottom',
            scope: item.scope === 'database' ? 'database' : 'visible',
        };
    }
    return agg;
}

// Normalize entire aggregation state for backward compatibility
function normalizeAggregationState(
    state: Record<string, ColumnAggregationState> | undefined | null,
): Record<string, ColumnAggregationState> {
    if (!state || typeof state !== 'object') return {};
    const normalized: Record<string, ColumnAggregationState> = {};
    for (const [colId, aggs] of Object.entries(state)) {
        if (Array.isArray(aggs)) {
            normalized[colId] = aggs.map((a) => normalizeAggItem(a) as ColumnAggregationValue);
        } else {
            normalized[colId] = aggs;
        }
    }
    return normalized;
}

// State getters/setters for aggregations
export function getAggregationState(
    rsIndex: number,
    executionTimestamp: number | undefined,
    sourceUri: string | undefined,
): Record<string, ColumnAggregationState> {
    const key = buildStateKey(rsIndex, executionTimestamp, sourceUri);
    return normalizeAggregationState(aggregationStates[key]);
}

export function setAggregationState(
    rsIndex: number,
    state: Record<string, ColumnAggregationState>,
    executionTimestamp: number | undefined,
    sourceUri: string | undefined,
): void {
    const key = buildStateKey(rsIndex, executionTimestamp, sourceUri);
    aggregationStates[key] = state;
}

// Clear aggregation state for a specific key (used when result is replaced)
export function clearAggregationState(
    rsIndex: number,
    executionTimestamp: number | undefined,
    sourceUri: string | undefined,
): void {
    const key = buildStateKey(rsIndex, executionTimestamp, sourceUri);
    delete aggregationStates[key];
}

// Clear all aggregation states for a source (used when new execution starts)
export function clearAllAggregationStatesForSource(sourceUri: string): void {
    const prefix = `${sourceUri}:`;
    for (const key of Object.keys(aggregationStates)) {
        if (key.startsWith(prefix)) {
            delete aggregationStates[key];
        }
    }
}

// Search worker functions
export function setSearchWorker(worker: Worker | null): void {
    searchWorker = worker;
}

export function getSearchWorker(): Worker | null {
    return searchWorker;
}

/** Pass `null` to clear matches for a result set (stored key is removed). */
export function setSearchMatches(rsIndex: number, matches: Set<number> | null): void {
    if (matches === null) {
        delete searchMatches[rsIndex];
        delete searchMatchSortedIndices[rsIndex];
    } else {
        searchMatches[rsIndex] = matches;
        searchMatchSortedIndices[rsIndex] = [...matches].sort((a, b) => a - b);
    }
}

export function clearAllSearchMatches(): void {
    for (const key of Object.keys(searchMatches)) {
        delete searchMatches[Number(key)];
    }
    for (const key of Object.keys(searchMatchSortedIndices)) {
        delete searchMatchSortedIndices[Number(key)];
    }
}

export function getSearchMatches(rsIndex: number): Set<number> | undefined {
    return searchMatches[rsIndex];
}

export function getSortedSearchMatchIndices(rsIndex: number): number[] | undefined {
    return searchMatchSortedIndices[rsIndex];
}

export function setIsSearching(searching: boolean): void {
    isSearching = searching;
}

export function getIsSearching(): boolean {
    return isSearching;
}

// Drag state functions
export function setGlobalDragState(state: Partial<GlobalDragState>): void {
    globalDragState = { ...globalDragState, ...state };
}

export function getGlobalDragState(): GlobalDragState {
    return globalDragState;
}

// Row view functions
export function setRowViewOpen(open: boolean): void {
    isRowViewOpen = open;
}

export function getRowViewOpen(): boolean {
    return isRowViewOpen;
}

// Database Grouping Panel state
export let isGroupingPanelOpen = false;

export function setGroupingPanelOpen(open: boolean): void {
    isGroupingPanelOpen = open;
}

export function getGroupingPanelOpen(): boolean {
    return isGroupingPanelOpen;
}

// Pinned columns state functions
export function getPinnedColumnsState(
    rsIndex: number,
    executionTimestamp: number | undefined,
    sourceUri: string | undefined,
): string[] {
    const key = buildStateKey(rsIndex, executionTimestamp, sourceUri);
    return pinnedColumnsState[key] || [];
}

export function setPinnedColumnsState(
    rsIndex: number,
    pinnedColumns: string[],
    executionTimestamp: number | undefined,
    sourceUri: string | undefined,
): void {
    const key = buildStateKey(rsIndex, executionTimestamp, sourceUri);
    pinnedColumnsState[key] = pinnedColumns;
}

export function togglePinnedColumn(
    rsIndex: number,
    colId: string,
    executionTimestamp: number | undefined,
    sourceUri: string | undefined,
): string[] {
    const key = buildStateKey(rsIndex, executionTimestamp, sourceUri);
    const currentPinned = getPinnedColumnsState(rsIndex, executionTimestamp, sourceUri);
    if (currentPinned.includes(colId)) {
        pinnedColumnsState[key] = currentPinned.filter(id => id !== colId);
    } else {
        pinnedColumnsState[key] = [...currentPinned, colId];
    }
    return pinnedColumnsState[key];
}

// Clear pinned columns state for a specific key (used when result is replaced)
export function clearPinnedColumnsState(
    rsIndex: number,
    executionTimestamp: number | undefined,
    sourceUri: string | undefined,
): void {
    const key = buildStateKey(rsIndex, executionTimestamp, sourceUri);
    delete pinnedColumnsState[key];
}

// Clear all pinned columns states for a source (used when new execution starts)
export function clearAllPinnedColumnsStatesForSource(sourceUri: string): void {
    const prefix = `${sourceUri}:`;
    for (const key of Object.keys(pinnedColumnsState)) {
        if (key.startsWith(prefix)) {
            delete pinnedColumnsState[key];
        }
    }
}

export function getResultFormattingPayload() {
    return resultFormattingPayload;
}

export function setResultFormattingPayload(payload: typeof resultFormattingPayload): void {
    resultFormattingPayload = payload || resultFormattingPayload;
    getResultPanelWindow().resultFormattingPayload = resultFormattingPayload;
}

export function getResultFormattingState(
    rsIndex: number,
    executionTimestamp: number | undefined,
    sourceUri: string | undefined,
): Record<string, unknown> | undefined {
    const key = buildStateKey(rsIndex, executionTimestamp, sourceUri);
    return resultFormattingStates[key];
}

export function setResultFormattingState(
    rsIndex: number,
    state: Record<string, unknown> | null | undefined,
    executionTimestamp: number | undefined,
    sourceUri: string | undefined,
): void {
    const key = buildStateKey(rsIndex, executionTimestamp, sourceUri);
    if (!state) {
        delete resultFormattingStates[key];
        return;
    }
    resultFormattingStates[key] = state;
}

export function clearResultFormattingState(
    rsIndex: number,
    executionTimestamp: number | undefined,
    sourceUri: string | undefined,
): void {
    const key = buildStateKey(rsIndex, executionTimestamp, sourceUri);
    delete resultFormattingStates[key];
}
