// Grid module - Grid rendering and management for result panel (facade)
import { getGrid, getPinnedColumnsState } from './state.js';
import { getActiveSourceUri } from './types.js';
import { asHtml } from './dom.js';

export * from './grid/sizing.js';
export {
    prepareColumns,
    createSortingFn,
    createFilterFn,
    evaluateConditions,
    populateColumnSearchList,
} from './grid/columns.js';
export { renderGrids } from './grid/orchestration.js';
export {
    createLogConsole,
    createTextContentView,
    createLogLineElement,
    appendLogRows,
    createErrorView,
    hasPreviewableResultData,
    dismissLoadingOverlay,
    resetLoadingOverlayDismissed,
    isLoadingOverlayDismissed,
    updateLoadingState,
    updateControlsVisibility,
    syncGlobalFilterInput,
    renderStateCard,
    applyRightAlignmentClass,
} from './grid/alternateViews.js';
export {
    createGroupChip,
    createGroupFooterRow,
    formatAggregationNumber,
    roundHalfUp,
    reduceNumericMin,
    reduceNumericMax,
    getAggregationSymbol,
    getAggFn,
    getAggPrecision,
    getAggregationColumnTypeInfo,
    calculateAggregation,
    calculateAggregationForRows,
    countLeafRows,
} from './grid/aggregation.js';
export { createResultSetGrid } from './grid/tableBuilder.js';

export function scrollToColumn(rsIndex: number, colId: string): void {
    const grid = getGrid(rsIndex);
    if (!grid || !grid.tanTable) return;

    const wrapper = document.querySelector(`.grid-wrapper[data-index="${rsIndex}"]`);
    if (!wrapper) return;

    const th = wrapper.querySelector(`th[data-col-id="${colId}"]`) as HTMLElement | null;
    if (!th) return;

    const pinnedCols = getPinnedColumnsState(rsIndex, grid.executionTimestamp, getActiveSourceUri());

    if (pinnedCols.includes(colId)) return;

    const rowNumWidth = asHtml(wrapper.querySelector('.row-number-header'))?.offsetWidth || 50;
    let scrollTarget = th.offsetLeft - rowNumWidth;

    if (pinnedCols.length > 0) {
        const visibleCols = grid.tanTable.getVisibleLeafColumns();
        const colWidths = grid.columnWidths;
        if (!colWidths) return;
        for (const col of visibleCols) {
            if (col.id === colId) break;
            if (pinnedCols.includes(col.id)) {
                scrollTarget -= colWidths.get(col.id) || 100;
            }
        }
    }

    wrapper.scrollLeft = Math.max(0, scrollTarget);
}
