import { getHostState, setHostState } from '../protocol.js';
import {
    getAllGrids,
    getColumnFilterState,
    getAggregationState,
    getPinnedColumnsState,
    getResultFormattingState,
    getLayoutMode,
    saveScrollStateToCache,
    getScrollStateFromGlobalCache,
    getGrid,
} from '../state.js';
import type { ColumnAggregationState } from '../types.js';
import { asScrollState, getActiveSourceUri, getResultSets, getResultSetAt, type GridScrollState } from '../types.js';
import { asHtml } from '../dom.js';
import { getDiskGroupingExpandedKeys } from '../diskGrouping.js';

export interface SavedGridState {
    sorting?: unknown;
    grouping?: unknown;
    expanded?: unknown;
    columnOrder?: unknown;
    columnFilters?: unknown;
    columnPinning?: unknown;
    columnVisibility?: unknown;
    globalFilter?: string;
    customColumnFilters?: Record<string, unknown>;
    aggregations?: Record<string, ColumnAggregationState>;
    columnWidths?: Array<[string, number]>;
    manualColumnWidths?: string[];
    scrollTop?: number;
    scrollLeft?: number;
    scrollAnchorIndex?: number;
    pinnedColumns?: string[];
    resultFormatting?: Record<string, unknown>;
    diskGroupingExpandedKeys?: string[];
    [key: string]: unknown;
}

// True during handleHydrate (after Terminal switch) so saveAllGridStates preserves
// existing scroll from host state even though new grid elements have scrollTop = 0.
let preserveScrollDuringHydrate = false;

export function setPreserveScrollDuringHydrate(value: boolean): void {
    preserveScrollDuringHydrate = value;
}

export function getScrollTarget(wrapper: Element | null | undefined): HTMLElement | null {
    if (!wrapper) return null;
    const htmlWrapper = asHtml(wrapper);
    if (!htmlWrapper) return null;
    return htmlWrapper.classList.contains('console-wrapper')
        ? asHtml(htmlWrapper.querySelector('.console-view'))
        : htmlWrapper;
}

export function isConsoleWrapper(wrapper: Element | null | undefined): boolean {
    return asHtml(wrapper)?.classList.contains('console-wrapper') === true;
}

export function getGridWrapperForResultSet(rsIndex: number): HTMLElement | null {
    return asHtml(document.querySelector(`.grid-wrapper[data-index="${rsIndex}"]`))
        ?? asHtml(document.querySelectorAll('.grid-wrapper')[rsIndex]);
}

function hasNonZeroScroll(scrollState: GridScrollState | null | undefined): boolean {
    return (scrollState?.scrollTop ?? 0) > 0 || (scrollState?.scrollLeft ?? 0) > 0;
}

function scrollStateMatchesResult(
    scrollState: GridScrollState | null | undefined,
    executionTimestamp: number | undefined,
): boolean {
    if (!scrollState || scrollState.timestamp === undefined || executionTimestamp === undefined) {
        return true;
    }
    return scrollState.timestamp === executionTimestamp;
}

export function resolveScrollStateForResultSet(
    rsIndex: number,
    sourceUri?: string | null,
): GridScrollState | null {
    const source = sourceUri ?? getActiveSourceUri() ?? '';
    const rs = getResultSetAt(rsIndex);
    const exactState = rs
        ? asScrollState(getSavedStateFor(rsIndex, rs.executionTimestamp, source))
        : undefined;

    const globalState = asScrollState(getScrollStateFromGlobalCache(source, rsIndex));
    if (
        globalState
        && scrollStateMatchesResult(globalState, rs?.executionTimestamp)
        && (hasNonZeroScroll(globalState) || !hasNonZeroScroll(exactState))
    ) {
        return globalState;
    }

    if (exactState) {
        return exactState;
    }

    // A result with an execution timestamp is a fresh, identifiable result set.
    // Do not reuse a scroll position found under the same source/index but a
    // different timestamp: that can place a newly executed query at the end
    // of the previous result set.
    if (source && rs?.executionTimestamp === undefined) {
        const found = findScrollStateBySource(source, rsIndex);
        if (found) {
            return asScrollState(found) ?? null;
        }
    }

    return null;
}

export function applyScrollStateToTarget(target: HTMLElement, scrollState: GridScrollState): void {
    target.scrollTop = scrollState.scrollTop ?? 0;
    target.scrollLeft = scrollState.scrollLeft ?? 0;
}

function applyScrollAnchorForGrid(
    rsIndex: number,
    scrollState: GridScrollState,
): boolean {
    const anchorIndex = scrollState.scrollAnchorIndex;
    if (anchorIndex === undefined || anchorIndex < 0) {
        return false;
    }
    const grid = getGrid(rsIndex);
    if (!grid?.scrollToIndex) {
        return false;
    }
    grid.scrollToIndex(anchorIndex, 'start');
    return true;
}

export function applyScrollForResultSet(
    rsIndex: number,
    options: {
        sourceUri?: string | null;
        autoBottomLogs?: boolean;
        forceBottomLogs?: boolean;
        verifyAfterFrame?: boolean;
        preferScrollAnchor?: boolean;
    } = {},
): void {
    const wrapper = getGridWrapperForResultSet(rsIndex);
    const scrollTarget = getScrollTarget(wrapper);
    if (!scrollTarget) return;

    const isConsole = isConsoleWrapper(wrapper);
    const scrollState = resolveScrollStateForResultSet(rsIndex, options.sourceUri);
    const hasRestorableScroll = scrollState
        && ((scrollState.scrollTop ?? 0) > 0 || (scrollState.scrollLeft ?? 0) > 0);

    const usedAnchor = options.preferScrollAnchor
        && !isConsole
        && scrollState
        && applyScrollAnchorForGrid(rsIndex, scrollState);

    if (options.forceBottomLogs && isConsole) {
        scrollTarget.scrollTop = scrollTarget.scrollHeight;
    } else if (!usedAnchor && hasRestorableScroll) {
        applyScrollStateToTarget(scrollTarget, scrollState);
    } else if (!usedAnchor && options.autoBottomLogs && isConsole) {
        scrollTarget.scrollTop = scrollTarget.scrollHeight;
    }

    if (options.verifyAfterFrame) {
        requestAnimationFrame(() => {
            const frameWrapper = getGridWrapperForResultSet(rsIndex);
            const frameTarget = getScrollTarget(frameWrapper);
            if (!frameTarget) return;

            const isFrameConsole = isConsoleWrapper(frameWrapper);
            const frameState = resolveScrollStateForResultSet(rsIndex, options.sourceUri);
            const hasFrameRestorableScroll = frameState
                && ((frameState.scrollTop ?? 0) > 0 || (frameState.scrollLeft ?? 0) > 0);

            const usedFrameAnchor = options.preferScrollAnchor
                && !isFrameConsole
                && frameState
                && applyScrollAnchorForGrid(rsIndex, frameState);

            if (options.forceBottomLogs && isFrameConsole) {
                frameTarget.scrollTop = frameTarget.scrollHeight;
            } else if (!usedFrameAnchor && hasFrameRestorableScroll) {
                applyScrollStateToTarget(frameTarget, frameState);
            } else if (!usedFrameAnchor && options.autoBottomLogs && isFrameConsole) {
                frameTarget.scrollTop = frameTarget.scrollHeight;
            }
        });
    }
}

export function saveAllGridStates(): void {
    const stateToSave: Record<string, SavedGridState | string> = (
        getHostState() as Record<string, SavedGridState | string> | null
    ) || {};
    const activeSource = getActiveSourceUri();

    getAllGrids().forEach((grid, rsIndex) => {
        if (!grid) return;

        const rs = getResultSetAt(rsIndex);
        const timestamp = grid.executionTimestamp || rs?.executionTimestamp || '';
        const key = `${activeSource ?? ''}:${rsIndex}:${timestamp}`;
        const tableState = grid.tanTable?.getState();
        const wrapper = getGridWrapperForResultSet(rsIndex);
        const htmlWrapper = asHtml(wrapper);
        const isVisible = htmlWrapper && htmlWrapper.style.display !== 'none';

        const existingState = stateToSave[key] as SavedGridState | undefined;

        let scrollTop = 0;
        let scrollLeft = 0;
        let scrollAnchorIndex: number | undefined;

        if (isVisible && htmlWrapper) {
            const scrollTarget = getScrollTarget(htmlWrapper);
            if (scrollTarget) {
                scrollTop = scrollTarget.scrollTop || 0;
                scrollLeft = scrollTarget.scrollLeft || 0;
            }
            if (typeof grid.getScrollAnchorIndex === 'function') {
                scrollAnchorIndex = grid.getScrollAnchorIndex() as number | undefined;
            }
        } else if (activeSource) {
            const cachedScroll = asScrollState(getScrollStateFromGlobalCache(activeSource, rsIndex));
            if (cachedScroll) {
                scrollTop = cachedScroll.scrollTop || 0;
                scrollLeft = cachedScroll.scrollLeft || 0;
                scrollAnchorIndex = cachedScroll.scrollAnchorIndex;
            }
        }

        if ((preserveScrollDuringHydrate || (htmlWrapper && htmlWrapper.offsetParent === null))
            && existingState && (existingState.scrollTop ?? 0) > 0 && scrollTop === 0) {
            scrollTop = existingState.scrollTop ?? 0;
            scrollLeft = existingState.scrollLeft ?? 0;
            scrollAnchorIndex = existingState.scrollAnchorIndex as number | undefined ?? scrollAnchorIndex;
        }

        const state: SavedGridState = {
            sorting: tableState?.sorting,
            grouping: tableState?.grouping,
            expanded: tableState?.expanded,
            columnOrder: tableState?.columnOrder,
            columnFilters: tableState?.columnFilters,
            columnPinning: tableState?.columnPinning,
            columnVisibility: tableState?.columnVisibility,
            globalFilter: tableState?.globalFilter,
            customColumnFilters: getColumnFilterState(rsIndex),
            aggregations: getAggregationState(rsIndex, grid.executionTimestamp, activeSource),
            columnWidths: Array.from(grid.columnWidths || []),
            manualColumnWidths: Array.from(grid.manualColumnWidths || []),
            scrollTop: scrollTop,
            scrollLeft: scrollLeft,
            scrollAnchorIndex,
            pinnedColumns: getPinnedColumnsState(rsIndex, grid.executionTimestamp, activeSource),
            resultFormatting: getResultFormattingState(rsIndex, grid.executionTimestamp, activeSource),
            diskGroupingExpandedKeys: getDiskGroupingExpandedKeys(rsIndex),
        };

        stateToSave[key] = state;

        if (activeSource && rs) {
            saveScrollStateToCache(activeSource, rsIndex, {
                scrollTop: scrollTop,
                scrollLeft: scrollLeft,
                scrollAnchorIndex,
                timestamp: rs.executionTimestamp
            });
        }
    });

    stateToSave._layoutMode = getLayoutMode();

    setHostState(stateToSave);
}

export function getSavedStateFor(
    rsIndex: number,
    executionTimestamp: number | undefined,
    sourceUri?: string | null,
): SavedGridState | null {
    const savedState = getHostState() as Record<string, SavedGridState> | null;
    if (!savedState) return null;

    const timestamp = executionTimestamp || '';
    const source = sourceUri || getActiveSourceUri() || '';
    const key = `${source}:${rsIndex}:${timestamp}`;
    return savedState[key] ?? null;
}

export function findScrollStateBySource(
    sourceUri: string,
    rsIndex: number,
): SavedGridState | null {
    const savedState = getHostState() as Record<string, SavedGridState> | null;
    if (!savedState) return null;

    const prefix = `${sourceUri}:${rsIndex}:`;
    for (const key of Object.keys(savedState)) {
        if (key.startsWith(prefix)) {
            const state = savedState[key];
            if (state && (state.scrollTop ?? 0) > 0) {
                return state;
            }
        }
    }

    return null;
}

export function savePinnedState(): void {
    saveAllGridStates();
}

export function saveScrollStatesToResultSets(): void {
    const resultSets = getResultSets();
    if (resultSets.length === 0) return;
    resultSets.forEach((rs, rsIndex) => {
        if (rs && rs.executionTimestamp) {
            const wrapper = getGridWrapperForResultSet(rsIndex);
            const htmlWrapper = asHtml(wrapper);
            const isVisible = htmlWrapper && htmlWrapper.style.display !== 'none';
            if (!rs._savedState) rs._savedState = {};
            const scrollTarget = isVisible ? getScrollTarget(htmlWrapper) : null;
            rs._savedState.scrollTop = scrollTarget?.scrollTop || 0;
            rs._savedState.scrollLeft = scrollTarget?.scrollLeft || 0;
        }
    });
}

export function restoreScrollFromResultSet(rsIndex: number): Record<string, unknown> | null {
    const rs = getResultSetAt(rsIndex);
    if (!rs) return null;
    return rs._savedState ?? null;
}
