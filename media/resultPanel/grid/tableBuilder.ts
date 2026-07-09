import {
    getActiveGridIndex,
    addGrid,
    setColumnFilterState,
    getAggregationState,
    setAggregationState,
    setGlobalDragState,
    getGlobalDragState,
    getSearchMatches,
    getPinnedColumnsState,
    setPinnedColumnsState,
    getGlobalFilterState,
    setGlobalFilterState,
    setResultFormattingState,
    saveScrollStateToCache,
} from '../state.js';
import { GLOBAL_FILTER_WORKER_ROW_THRESHOLD } from '../searchWorkerBridge.js';
import {
    formatCellValue,
    debounce,
    getNumericTypeInfo,
} from '../utils.js';
import { getSavedStateFor, saveAllGridStates, resolveScrollStateForResultSet } from './persistence.js';
import { createHeaderCellWithFilter, reorderColumnsForPinning, renderRowCountInfo } from '../filter.js';
import { setupCellSelectionEvents } from '../selection.js';
import { postHostMessage } from '../protocol.js';
import {
    GridHandle,
    ResultSet,
    CellSelectionHandlers,
    TanStackRow,
    TanStackColumn,
    TanStackTable,
    TanStackHeader,
    ColumnFilterValue,
    ColumnAggregationState,
    ColumnAggregationValue,
    AggregationSelection,
    getActiveSourceUri,
    requireActiveSourceUri,
    getResultPanelWindow,
    getResultSetAt,
    asScrollState,
    callPanelMethod,
} from '../types.js';
import { asHtml, getElementById, queryHtml, eventTargetAsHtml } from '../dom.js';
import {
    RESULT_GRID_MAX_AUTO_SIZE_ROWS,
    RESULT_GRID_ESTIMATED_ROW_HEIGHT,
    RESULT_GRID_VIRTUAL_OVERSCAN,
    createGridTextMeasurer,
    initializeColumnWidths,
    initializeTableState,
    calculatePinnedColumnLeft,
    calculateRowNumberColumnWidth,
    scheduleDeferredColumnWidthInit,
    calculateAutoColumnWidth,
    getGridInitSignal,
} from './sizing.js';
import { prepareColumns, populateColumnSearchList } from './columns.js';
import { renderStateCard, applyRightAlignmentClass } from './alternateViews.js';
import {
    createGroupChip,
    createGroupFooterRow,
    calculateAggregation,
    calculateAggregationForRows,
    formatDiskAggregationResult,
    getAggregationColumnTypeInfo,
    countLeafRows,
    getAggregationSymbol,
    getAggFn,
} from './aggregation.js';
import type {
    GridColumnDef,
    GridTanStackTable,
    GroupableTanStackRow,
    GridVisibleCell,
    ResultSetWithExtras,
    FormatContext,
    ScheduleRenderFn,
    CreateTableFn,
    RowModelFactoryFn,
} from './types.js';
import { ensureDiskWindow, fetchRowsFromHost, isDiskBackedResultSet, queryDiskAggregations, refreshDiskQueryWindow, resolveDiskGridViewState, scheduleEnsureDiskWindow } from '../diskBackedGrid.js';
import { getDiskFilteredCount, syncDiskQuerySpecFromGrid } from '../diskQuerySpec.js';
import {
    clearDiskGrouping,
    ensureDiskGrouping,
    ensureDiskGroupingPagesLoaded,
    getDiskGroupingLeafRowAt,
    getDiskGroupingRowCount,
    getDiskGroupingRows,
    isDiskGroupRowExpanded,
    restoreDiskGroupingExpandedKeys,
    refreshDiskGrouping,
    toggleDiskGroupRow,
} from '../diskGrouping.js';
import type { DiskGroupingDisplayRow } from '../diskGrouping.js';
import type { ClipboardRowResolver } from '../selection/clipboard.js';

const vscode = { postMessage: postHostMessage };

type GridRowVirtualizer = InstanceType<typeof VirtualCore.Virtualizer>;

export function createResultSetGrid(
    rs: ResultSetWithExtras,
    rsIndex: number,
    container: HTMLElement,
    createTable: CreateTableFn,
    getCoreRowModel: RowModelFactoryFn,
    getSortedRowModel: RowModelFactoryFn,
    getFilteredRowModel: RowModelFactoryFn,
    getGroupedRowModel: RowModelFactoryFn,
    getExpandedRowModel: RowModelFactoryFn,
): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'grid-wrapper' + (rsIndex === getActiveGridIndex() ? ' active' : '');
    wrapper.style.height = '100%';
    wrapper.style.overflow = 'auto';
    wrapper.style.position = 'relative';
    wrapper.style.display = rsIndex === getActiveGridIndex() ? 'block' : 'none';
    wrapper.dataset.index = String(rsIndex);
    container.appendChild(wrapper);

    if (!rs.data || !Array.isArray(rs.data)) {
        renderStateCard(wrapper, {
            title: 'Invalid Result Data',
            description: 'The panel received a result set that could not be rendered safely.',
            hint: 'Retry the query. If the problem persists, review the execution logs.',
            tone: 'error'
        });
        addGrid(null);
        return;
    }

    const hasRows = rs.data.length > 0;

    if (!hasRows && (!rs.columns || rs.columns.length === 0)) {
        if (rs.rowsAffected !== undefined || rs.message) {
            const rowsAffectedText = rs.rowsAffected !== undefined ? `${rs.rowsAffected} rows affected` : '';
            const messageText = rs.message || '';
            const displayText = [messageText, rowsAffectedText].filter(Boolean).join(' - ');
            renderStateCard(wrapper, {
                title: 'Statement Completed',
                description: displayText || 'The statement completed without a tabular result set.',
                hint: 'Use the Logs tab for execution details, or rerun a SELECT-style query if you expected rows.',
                tone: 'success'
            });
        } else {
            renderStateCard(wrapper, {
                title: 'Empty Result Set',
                description: 'The query completed successfully, but it returned no rows.',
                hint: 'Adjust filters, verify the active database/schema, or rerun the query if you expected data.'
            });
        }
        addGrid(null);
        return;
    }

    if (!rs.columns || !Array.isArray(rs.columns)) {
        renderStateCard(wrapper, {
            title: 'Invalid Column Metadata',
            description: 'The panel could not determine the column layout for this result set.',
            hint: 'Retry the query. If this repeats, inspect the execution logs and metadata diagnostics.',
            tone: 'error'
        });
        addGrid(null);
        return;
    }

    // Initialize states
    setColumnFilterState(rsIndex, {});
    // Don't reset aggregation state - it should persist across renders

    // Create table elements
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    tbody.dataset.tbody = 'data';
    const tfoot = document.createElement('tfoot');



    table.appendChild(thead);
    table.appendChild(tbody);
    table.appendChild(tfoot);
    wrapper.appendChild(table);

    // Prepare columns
    const columns = prepareColumns(rs, rsIndex);

    // Get saved state
    const savedState = getSavedStateFor(rsIndex, rs.executionTimestamp);
    const measureText = createGridTextMeasurer();
    const manualColumnWidths = new Set(savedState?.manualColumnWidths || []);

    // Initialize column widths
    let columnWidths = initializeColumnWidths(columns, rs, savedState, measureText);
    let autoWidthMeasuredRowCount = savedState?.columnWidths ? RESULT_GRID_MAX_AUTO_SIZE_ROWS : Math.min(
        rs.data.length,
        RESULT_GRID_MAX_AUTO_SIZE_ROWS
    );
    let rowNumberColumnWidth = calculateRowNumberColumnWidth(rs.data.length, measureText);

    let dataRowCounter = 0;

    // Initialize table state
    const tableState = initializeTableState(savedState);
    setGlobalFilterState(rsIndex, tableState.globalFilter, rs.executionTimestamp, getActiveSourceUri());

    // Load pinned columns state (only if timestamp matches - otherwise treat as new result)
    if (savedState && savedState.pinnedColumns && savedState.pinnedColumns.length > 0) {
        setPinnedColumnsState(rsIndex, tableState.pinnedColumns, rs.executionTimestamp, getActiveSourceUri());
    }

    // Load aggregation state from saved state (only if timestamp matches - otherwise treat as new result)
    if (savedState && savedState.aggregations) {
        setAggregationState(rsIndex, savedState.aggregations, rs.executionTimestamp, getActiveSourceUri());
    }

    if (savedState && savedState.resultFormatting) {
        setResultFormattingState(rsIndex, savedState.resultFormatting, rs.executionTimestamp, getActiveSourceUri());
    }

    // Setup virtualization
    let rowVirtualizer: GridRowVirtualizer | null = null;
    let virtualizerCleanup: (() => void) | null = null;
    let lastVirtualizerKey = '';
    /** Measured once from first rendered data row; keeps natural row height without per-row measureElement drift. */
    let resolvedRowHeight: number | null = null;
    let renderScheduled = false;
    let renderRowsScheduled = false;  // Throttling dla renderTableRows

    // Pooling elementów DOM - Faza 6 (eksperymentalna optymalizacja)
    const rowPool: HTMLTableRowElement[] = [];
    const cellPool: HTMLTableCellElement[] = [];
    const MAX_POOL_SIZE = 100; // Maksymalna liczba elementów w puli

    let chromeDirty = true;
    let rowNumberCacheVersion = 0;
    let rowNumberCacheKey = '';
    let rowNumberCacheOffset = 0;
    let aggregationCacheKey = '';
    let aggregationCacheBottom: Record<string, string[]> | null = null;
    let aggregationCacheTop: Record<string, string[]> | null = null;
    let selectionHandlers: CellSelectionHandlers | null = null;
    let editModeDblClickBound = false;
    let disposed = false;
    let debouncedSaveOnScroll: ReturnType<typeof debounce> | null = null;
    let immediateScrollSaveHandler: EventListener | null = null;

    let tanTable: GridTanStackTable;

    // Declare function variables first (hoisting pattern)
    let scheduleRender: ScheduleRenderFn;
    let render: () => void;
    let renderChrome: () => void;
    let renderBody: () => void;
    let createVirtualizer: () => void;
    let renderTableRows: () => void;
    let renderColGroup: () => void;
    let renderTableHeaders: () => void;
    let createDataRow: (
        tr: HTMLTableRowElement,
        row: GroupableTanStackRow,
        pinnedColumns: string[],
        formatContext: FormatContext,
    ) => void;
    let createGroupHeaderRow: (
        tr: HTMLTableRowElement,
        row: GroupableTanStackRow,
        resultSet: ResultSet,
        _pinnedColumns: string[],
    ) => void;
    let renderGrouping: () => void;
    let updateRowCount: () => void;
    let renderAggregations: () => void;
    let getRowFromPool: () => HTMLTableRowElement;
    let getCellFromPool: () => HTMLTableCellElement;
    let returnRowToPool: (row: HTMLTableRowElement) => void;
    let returnCellToPool: (cell: HTMLTableCellElement) => void;
    let recycleTbodyRowsBeforeClear: () => void;
    let clearPool: () => void;
    let invalidateRowNumberCache: () => void;
    let invalidateAggregationCache: () => void;
    let computeRowNumberOffset: (firstVyIdx: number, rows: GroupableTanStackRow[]) => number;

    // Define the functions
    const safeVirtualizerScrollToTop = (): void => {
        if (!rowVirtualizer || (rowVirtualizer.options.count ?? 0) <= 0) {
            wrapper.scrollTop = 0;
            return;
        }
        try {
            rowVirtualizer.scrollToIndex(0, { align: 'start' });
        } catch {
            wrapper.scrollTop = 0;
        }
    };

    const getGridChromeHeights = (): { headerHeight: number; footerHeight: number } => ({
        headerHeight: thead.offsetHeight || 0,
        footerHeight: tfoot.offsetHeight || 0,
    });

    const appendPlaceholderRow = (fragment: DocumentFragment, rowIndex: number): void => {
        const tr = document.createElement('tr');
        tr.className = 'virtual-row-placeholder';
        tr.dataset.index = String(rowIndex);
        const td = document.createElement('td');
        td.colSpan = columns.length + 1;
        const spacer = document.createElement('div');
        spacer.className = 'virtual-pad-spacer';
        spacer.style.height = `${resolvedRowHeight ?? RESULT_GRID_ESTIMATED_ROW_HEIGHT}px`;
        td.appendChild(spacer);
        tr.appendChild(td);
        fragment.appendChild(tr);
    };

    const syncVirtualScrollExtent = (
        scrollTotalSize: number,
        paddingTop: number,
        paddingBottom: number,
    ): void => {
        const { headerHeight, footerHeight } = getGridChromeHeights();
        const targetBodyHeight = scrollTotalSize;
        // Force layout so tbody padding is included in table metrics.
        const tableHeight = table.offsetHeight;
        const actualBodyHeight = Math.max(0, tableHeight - headerHeight - footerHeight);
        const usesVirtualPadding = paddingTop > 0 || paddingBottom > 0;
        // Padding rows already extend the table to the full virtual height.
        // Adding scroll-track on top doubles scrollHeight (thumb reaches bottom at ~50% of data).
        const scrollExtentDeficit = usesVirtualPadding
            ? 0
            : Math.max(0, targetBodyHeight - actualBodyHeight);

        let scrollTrack = wrapper.querySelector('.virtual-scroll-track') as HTMLElement | null;
        if (!scrollTrack) {
            scrollTrack = document.createElement('div');
            scrollTrack.className = 'virtual-scroll-track';
            scrollTrack.setAttribute('aria-hidden', 'true');
            wrapper.appendChild(scrollTrack);
        }
        scrollTrack.style.height = `${scrollExtentDeficit}px`;

        const rowSlack = resolvedRowHeight ?? RESULT_GRID_ESTIMATED_ROW_HEIGHT;
        const targetScrollHeight = scrollTotalSize + headerHeight + footerHeight;
        if (wrapper.scrollHeight > targetScrollHeight + rowSlack && scrollExtentDeficit > 0) {
            scrollTrack.style.height = '0px';
        }
    };

    createVirtualizer = function () {
        if (disposed) return;
        const rsAt = getResultSetAt(rsIndex) ?? rs;
        const diskView = resolveDiskGridViewState(rsIndex);
        const { isDiskBacked, isDiskQueryActive } = diskView;
        const isDiskGrouped = isDiskBacked && tableState.grouping.length > 0;
        if (isDiskGrouped) {
            ensureDiskGrouping(rsIndex, tableState.grouping, getDiskGroupAggregationRequests());
        }
        const count = isDiskBacked
            ? (isDiskGrouped ? getDiskGroupingRowCount(rsIndex) : diskView.virtualizerCount)
            : tanTable.getRowModel().rows.length;

        const virtualizerKey = `${isDiskGrouped ? `group:${tableState.grouping.join('|')}` : (isDiskQueryActive ? 'query' : 'full')}`;

        if (rowVirtualizer && virtualizerKey !== lastVirtualizerKey) {
            if (virtualizerCleanup) {
                virtualizerCleanup();
                virtualizerCleanup = null;
            }
            rowVirtualizer = null;
            resolvedRowHeight = null;
        }

        if (!rowVirtualizer) {
            rowVirtualizer = new VirtualCore.Virtualizer({
                count,
                getScrollElement: () => wrapper,
                estimateSize: () => resolvedRowHeight ?? RESULT_GRID_ESTIMATED_ROW_HEIGHT,
                overscan: RESULT_GRID_VIRTUAL_OVERSCAN,
                scrollToFn: VirtualCore.elementScroll,
                observeElementRect: VirtualCore.observeElementRect,
                observeElementOffset: VirtualCore.observeElementOffset,
                onChange: () => {
                    if (disposed) return;
                    const rsLive = getResultSetAt(rsIndex) ?? rsAt;
                    if (isDiskBackedResultSet(rsLive) && tableState.grouping.length === 0) {
                        const items = rowVirtualizer?.getVirtualItems() ?? [];
                        if (items.length > 0) {
                            scheduleEnsureDiskWindow(
                                rsLive,
                                rsIndex,
                                items[0].index,
                                items[items.length - 1].index,
                            );
                        }
                    } else if (isDiskBackedResultSet(rsLive) && tableState.grouping.length > 0) {
                        const items = rowVirtualizer?.getVirtualItems() ?? [];
                        if (items.length > 0) {
                            ensureDiskGroupingPagesLoaded(
                                rsIndex,
                                items[0].index,
                                items[items.length - 1].index,
                            );
                        }
                    }
                    if (renderRowsScheduled) return;
                    renderRowsScheduled = true;
                    requestAnimationFrame(() => {
                        if (disposed) return;
                        renderRowsScheduled = false;
                        renderTableRows();
                    });
                }
            });
            virtualizerCleanup = rowVirtualizer!._didMount();
            lastVirtualizerKey = virtualizerKey;
            if (isDiskQueryActive) {
                wrapper.scrollTop = 0;
            }
        } else if (rowVirtualizer.options.count !== count) {
            rowVirtualizer.options.count = count;
            lastVirtualizerKey = virtualizerKey;
            if (isDiskQueryActive) {
                safeVirtualizerScrollToTop();
            }
        }

        rowVirtualizer!._willUpdate();

        if (isDiskQueryActive && rowVirtualizer && count > 0) {
            const maxScroll = typeof rowVirtualizer.getMaxScrollOffset === 'function'
                ? rowVirtualizer.getMaxScrollOffset()
                : Math.max(0, rowVirtualizer.getTotalSize() - wrapper.clientHeight);
            if (wrapper.scrollTop > maxScroll) {
                safeVirtualizerScrollToTop();
            }
        }
    };

    scheduleRender = function (options: { chrome?: boolean } = {}) {
        if (disposed) return;
        if (options.chrome) {
            chromeDirty = true;
        }
        if (renderScheduled) return;
        renderScheduled = true;
        requestAnimationFrame(() => {
            if (disposed) return;
            renderScheduled = false;
            render();
        });
    };

    invalidateRowNumberCache = function () {
        rowNumberCacheVersion += 1;
        rowNumberCacheKey = '';
    };

    invalidateAggregationCache = function () {
        aggregationCacheKey = '';
        aggregationCacheBottom = null;
        aggregationCacheTop = null;
    };

    const getDiskGroupAggregationRequests = (): Array<{ columnIndex: number; fn: string }> => {
        const currentAggs = getAggregationState(rsIndex, rs.executionTimestamp, getActiveSourceUri()) || {};
        const requests: Array<{ columnIndex: number; fn: string }> = [];
        for (const [columnId, values] of Object.entries(currentAggs)) {
            if (!Array.isArray(values)) {
                continue;
            }
            for (const aggItem of values) {
                const isBottom = typeof aggItem === 'string' || aggItem.position !== 'top';
                const fn = getAggFn(aggItem);
                if (!isBottom) {
                    continue;
                }
                requests.push({
                    columnIndex: Number.parseInt(columnId, 10),
                    fn,
                });
            }
        }
        return requests;
    };

    if (rs.storageMode === 'sqlite' && tableState.grouping.length > 0) {
        ensureDiskGrouping(rsIndex, tableState.grouping, getDiskGroupAggregationRequests());
        if (savedState?.diskGroupingExpandedKeys?.length) {
            restoreDiskGroupingExpandedKeys(
                rsIndex,
                savedState.diskGroupingExpandedKeys as string[],
            );
        }
    }

    renderChrome = function () {
        renderColGroup();
        renderTableHeaders();
        chromeDirty = false;
    };

    renderBody = function () {
        renderTableRows();
        updateRowCount();
        renderAggregations();
    };

    render = function () {
        if (disposed) return;
        try {
            const rsAtIndex = getResultSetAt(rsIndex);
            const scrollState = getActiveSourceUri() && rsAtIndex
                ? resolveScrollStateForResultSet(rsIndex, getActiveSourceUri())
                : null;
            const shouldRestoreSavedScroll = wrapper.scrollTop < 1 && (scrollState?.scrollTop ?? 0) > 0;
            if (scrollState?.scrollTop && scrollState.scrollTop > 0 && wrapper.scrollTop < 1) {
                wrapper.scrollTop = scrollState.scrollTop;
                wrapper.scrollLeft = scrollState.scrollLeft ?? 0;
            }
            const anchorScrollTop = wrapper.scrollTop;
            const anchorScrollLeft = wrapper.scrollLeft;
            createVirtualizer();
            if (chromeDirty) {
                renderChrome();
            }
            renderBody();
            if (
                shouldRestoreSavedScroll
                && scrollState?.scrollAnchorIndex != null
                && rsIndex === getActiveGridIndex()
                && rowVirtualizer
            ) {
                try {
                    rowVirtualizer.scrollToIndex(scrollState.scrollAnchorIndex, { align: 'start' });
                } catch {
                    // fall back to pixel scroll below
                }
            } else if (anchorScrollTop > 0 && wrapper.scrollTop < 1) {
                wrapper.scrollTop = anchorScrollTop;
                wrapper.scrollLeft = anchorScrollLeft;
            }
        } catch (e: unknown) {
            console.error('Render error:', e);
            const message = e instanceof Error ? e.message : String(e);
            wrapper.innerHTML = `<div style="color: red; padding: 20px;">Render error: ${message}</div>`;
        }
    };

    renderColGroup = function () {
        const existing = table.querySelector('colgroup');
        if (existing) existing.remove();

        const colGroup = document.createElement('colgroup');
        const visibleCols = tanTable.getVisibleLeafColumns();

        let totalWidth = 0;

        // Add col for row number column (always first)
        const rowNumCol = document.createElement('col');
        rowNumCol.style.width = rowNumberColumnWidth + 'px';
        colGroup.appendChild(rowNumCol);
        totalWidth += rowNumberColumnWidth;

        visibleCols.forEach((col: TanStackColumn) => {
            const colEl = document.createElement('col');
            const w = columnWidths.get(col.id) || 100;
            colEl.style.width = w + 'px';
            colGroup.appendChild(colEl);
            totalWidth += w;
        });

        table.style.width = totalWidth + 'px';
        table.insertBefore(colGroup, table.querySelector('thead'));
    };

    renderTableHeaders = function () {
        thead.innerHTML = '';
        const pinnedColumns = getPinnedColumnsState(rsIndex, rs.executionTimestamp, getActiveSourceUri());

        tanTable.getHeaderGroups().forEach((headerGroup: { headers: TanStackHeader[] }) => {
            const tr = document.createElement('tr');

            // Add row number header as first column (always sticky)
            const rowNumTh = document.createElement('th');
            rowNumTh.textContent = '#';
            rowNumTh.className = 'row-number-header';
            rowNumTh.style.position = 'sticky';
            rowNumTh.style.top = '0';
            rowNumTh.style.left = '0';
            rowNumTh.style.zIndex = '1001'; // Above other headers
            rowNumTh.style.width = rowNumberColumnWidth + 'px';
            rowNumTh.style.minWidth = rowNumberColumnWidth + 'px';
            rowNumTh.style.maxWidth = rowNumberColumnWidth + 'px';
            rowNumTh.style.textAlign = 'center';
            rowNumTh.style.cursor = 'pointer';
            rowNumTh.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                wrapper.focus();
                if (typeof getResultPanelWindow().selectAll === 'function') {
                    getResultPanelWindow().selectAll!();
                }
            });
            tr.appendChild(rowNumTh);

            headerGroup.headers.forEach((header: TanStackHeader) => {
                const th = createHeaderCellWithFilter(header, rs, tanTable, rsIndex, scheduleRender);

                // Vertical sticky is handled by thead (position: sticky; top: 0)

                // For pinned columns, set left position (horizontal pinning during horizontal scroll)
                // Offset by the sticky row-number column width
                if (pinnedColumns.includes(header.column.id)) {
                    th.classList.add('pinned-column');
                    const leftOffset = calculatePinnedColumnLeft(header.column.id, pinnedColumns, columnWidths) + rowNumberColumnWidth;
                    th.style.left = leftOffset + 'px';
                    th.style.position = 'sticky';
                    th.style.zIndex = '1000';
                } else {
                    th.style.zIndex = '100';
                }

                tr.appendChild(th);
            });
            thead.appendChild(tr);
        });
    };

    computeRowNumberOffset = function (firstVyIdx: number, rows: GroupableTanStackRow[]): number {
        if (tableState.grouping.length === 0) {
            return firstVyIdx;
        }

        const cacheKey = `${rowNumberCacheVersion}:${firstVyIdx}`;
        if (cacheKey === rowNumberCacheKey) {
            return rowNumberCacheOffset;
        }

        let offset = 0;
        for (let ri = 0; ri < firstVyIdx; ri++) {
            const r = rows[ri];
            if (r?.getIsGrouped?.() && !r.getIsExpanded?.()) {
                offset += countLeafRows(r);
            } else if (!r?.getIsGrouped?.()) {
                offset += 1;
            }
        }

        rowNumberCacheKey = cacheKey;
        rowNumberCacheOffset = offset;
        return offset;
    };

    const createDiskLeafTanRow = (
        displayRow: Extract<DiskGroupingDisplayRow, { kind: 'leaf' }>,
        rowIndex: number,
    ): GroupableTanStackRow => ({
        index: rowIndex,
        original: displayRow.row,
        depth: displayRow.depth,
        getValue: (columnId: string) => displayRow.row[Number.parseInt(columnId, 10)],
        getVisibleCells: () => tanTable.getVisibleLeafColumns().map((column: TanStackColumn) => ({
            column,
            getValue: () => displayRow.row[Number.parseInt(column.id, 10)],
        })),
    });

    const createDiskGroupHeaderRow = (
        tr: HTMLTableRowElement,
        displayRow: Extract<DiskGroupingDisplayRow, { kind: 'group' }>,
    ): void => {
        const group = displayRow.group;
        tr.className = 'group-header';

        const rowNumTd = getCellFromPool();
        rowNumTd.className = 'row-number-cell';
        applyRowNumberColumnStyles(rowNumTd, {
            backgroundColor: 'var(--vscode-breadcrumb-background)',
        });
        tr.appendChild(rowNumTd);

        const firstCell = getCellFromPool();
        firstCell.colSpan = tanTable.getVisibleLeafColumns().length;

        const indent = document.createElement('span');
        indent.className = 'group-indent';
        indent.style.width = (group.depth * 20) + 'px';
        firstCell.appendChild(indent);

        const indicator = document.createElement('span');
        indicator.textContent = isDiskGroupRowExpanded(rsIndex, group) ? '▼' : '▶';
        indicator.style.cursor = 'pointer';
        indicator.onclick = (event) => {
            event.stopPropagation();
            toggleDiskGroupRow(rsIndex, group);
        };
        firstCell.appendChild(indicator);

        const groupedColumn = rs.columns[group.columnIndex];
        const groupedColumnDef = columns.find((col: GridColumnDef) => col.id === String(group.columnIndex));
        const formattedGroupValue = formatCellValue(group.value, groupedColumn?.type, groupedColumnDef?.scale, {
            rsIndex,
            executionTimestamp: rs.executionTimestamp,
            columnId: String(group.columnIndex),
            inferredNumericKind: groupedColumnDef?.inferredNumericKind,
            inferredDateInteger: groupedColumnDef?.inferredDateInteger,
        });
        const groupText = document.createElement('span');
        groupText.textContent = ` ${groupedColumn?.name ?? `Column ${group.columnIndex + 1}`}: ${formattedGroupValue ?? 'NULL'} (${group.count} row${group.count !== 1 ? 's' : ''})`;
        firstCell.appendChild(groupText);

        tr.onclick = () => toggleDiskGroupRow(rsIndex, group);
        tr.appendChild(firstCell);
    };

    const createDiskLoadingRow = (
        tr: HTMLTableRowElement,
        displayRow: Extract<DiskGroupingDisplayRow, { kind: 'loading' }>,
    ): void => {
        tr.className = 'group-loading';
        const rowNumTd = getCellFromPool();
        rowNumTd.className = 'row-number-cell';
        applyRowNumberColumnStyles(rowNumTd, {
            backgroundColor: 'var(--vscode-editor-background)',
        });
        tr.appendChild(rowNumTd);

        const td = getCellFromPool();
        td.colSpan = tanTable.getVisibleLeafColumns().length;
        const indent = document.createElement('span');
        indent.className = 'group-indent';
        indent.style.width = (displayRow.depth * 20) + 'px';
        td.appendChild(indent);
        const label = document.createElement('span');
        label.textContent = 'Loading...';
        td.appendChild(label);
        tr.appendChild(td);
    };

    const createDiskGroupFooterRow = (
        tr: HTMLTableRowElement,
        displayRow: Extract<DiskGroupingDisplayRow, { kind: 'footer' }>,
    ): void => {
        tr.className = 'group-footer';
        tr.dataset.groupFooter = 'true';

        const rowNumTd = getCellFromPool();
        rowNumTd.className = 'row-number-cell';
        applyRowNumberColumnStyles(rowNumTd, {
            backgroundColor: 'rgba(128, 128, 128, 0.1)',
        });
        tr.appendChild(rowNumTd);

        const currentAggs = getAggregationState(rsIndex, rs.executionTimestamp, getActiveSourceUri()) || {};
        const visibleColumns = tanTable.getVisibleLeafColumns();

        visibleColumns.forEach((col: TanStackColumn, colIndex: number) => {
            const td = getCellFromPool();
            if (colIndex === 0 && displayRow.group.depth > 0) {
                const indent = document.createElement('span');
                indent.className = 'group-indent';
                indent.style.width = (displayRow.group.depth * 20) + 'px';
                td.appendChild(indent);
            }

            const configuredAggs = currentAggs[col.id];
            if (!Array.isArray(configuredAggs) || configuredAggs.length === 0) {
                tr.appendChild(td);
                return;
            }

            const bottomAggs = configuredAggs.filter((aggItem) =>
                typeof aggItem === 'string' || aggItem.position !== 'top'
            );
            if (bottomAggs.length === 0) {
                tr.appendChild(td);
                return;
            }

            const shouldAlignRight = applyRightAlignmentClass(td, col.columnDef?.dataType, col.columnDef?.inferredNumericKind);
            const container = document.createElement('div');
            container.style.display = 'flex';
            container.style.flexDirection = 'column';
            container.style.gap = '2px';

            bottomAggs.forEach((aggItem) => {
                const fn = getAggFn(aggItem);
                const columnIndex = Number.parseInt(col.id, 10);
                const result = displayRow.aggregations.find((entry) =>
                    entry.columnIndex === columnIndex && entry.fn === fn
                );
                if (!result) {
                    return;
                }
                const formatted = formatDiskAggregationResult(aggItem, result.value, col);

                const rowDiv = document.createElement('div');
                rowDiv.className = 'group-footer-agg-row';
                rowDiv.style.display = 'flex';
                rowDiv.style.alignItems = 'center';
                rowDiv.style.gap = '4px';
                if (shouldAlignRight) {
                    rowDiv.classList.add('cell-align-right');
                }

                const labelSpan = document.createElement('span');
                labelSpan.className = 'agg-label';
                labelSpan.textContent = getAggregationSymbol(aggItem);
                labelSpan.style.fontSize = '10px';
                labelSpan.style.opacity = '0.7';

                const valueSpan = document.createElement('span');
                valueSpan.className = 'agg-value';
                valueSpan.textContent = formatted;
                if (shouldAlignRight) {
                    valueSpan.classList.add('cell-align-right');
                }

                rowDiv.appendChild(labelSpan);
                rowDiv.appendChild(valueSpan);
                container.appendChild(rowDiv);
            });

            td.appendChild(container);
            tr.appendChild(td);
        });
    };

    renderTableRows = function () {
        if (disposed || !rowVirtualizer) return;

        const pinnedColumns = getPinnedColumnsState(rsIndex, rs.executionTimestamp, getActiveSourceUri());
        const formatContext = {
            rsIndex,
            executionTimestamp: rs.executionTimestamp
        };

        rowVirtualizer._willUpdate();

        const coreRows = tanTable.getCoreRowModel().rows as GroupableTanStackRow[];
        const filteredRows = tanTable.getFilteredRowModel().rows as GroupableTanStackRow[];
        const virtualItems = rowVirtualizer.getVirtualItems();
        const totalSize = rowVirtualizer.getTotalSize();
        const rsAt = getResultSetAt(rsIndex) ?? rs;
        const diskView = resolveDiskGridViewState(rsIndex);
        const { isDiskBacked } = diskView;
        const isDiskGrouped = isDiskBacked && tableState.grouping.length > 0;
        if (isDiskGrouped) {
            ensureDiskGrouping(rsIndex, tableState.grouping, getDiskGroupAggregationRequests());
        }
        const diskWindowStart = rsAt.diskWindowStart ?? 0;

        if (isDiskBacked && !isDiskGrouped && virtualItems.length > 0) {
            const windowStart = diskWindowStart;
            const windowEnd = windowStart + rsAt.data.length;
            const visibleStart = virtualItems[0].index;
            const visibleEnd = virtualItems[virtualItems.length - 1].index;
            if (visibleStart < windowStart || visibleEnd >= windowEnd) {
                scheduleEnsureDiskWindow(rsAt, rsIndex, visibleStart, visibleEnd);
            }
        }

        const diskGroupRows = isDiskGrouped ? getDiskGroupingRows(rsIndex) : [];
        const rows = isDiskBacked ? coreRows : (tanTable.getRowModel().rows as GroupableTanStackRow[]);

        const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
        const paddingBottom = virtualItems.length > 0 ? totalSize - virtualItems[virtualItems.length - 1].end : 0;

        const fragment = document.createDocumentFragment();

        const appendVirtualPaddingRow = (heightPx: number, className: string): void => {
            if (heightPx <= 0) return;
            const tr = document.createElement('tr');
            tr.className = className;
            tr.setAttribute('aria-hidden', 'true');
            const td = document.createElement('td');
            td.colSpan = columns.length + 1;
            const spacer = document.createElement('div');
            spacer.className = 'virtual-pad-spacer';
            spacer.style.height = `${heightPx}px`;
            td.appendChild(spacer);
            tr.appendChild(td);
            fragment.appendChild(tr);
        };

        appendVirtualPaddingRow(paddingTop, 'virtual-pad-top');

        const firstVyIdx = virtualItems.length > 0 ? virtualItems[0].index : 0;
        if (isDiskGrouped) {
            let leafOffset = 0;
            for (let i = 0; i < firstVyIdx; i++) {
                if (diskGroupRows[i]?.kind === 'leaf') {
                    leafOffset++;
                }
            }
            dataRowCounter = leafOffset;
        } else {
            dataRowCounter = computeRowNumberOffset(firstVyIdx, rows);
        }

        const renderedGroupFooters = new Set();

        virtualItems.forEach((virtualRow: { index: number }) => {
            if (isDiskGrouped) {
                const displayRow = diskGroupRows[virtualRow.index];
                if (!displayRow) {
                    appendPlaceholderRow(fragment, virtualRow.index);
                    return;
                }
                const tr = getRowFromPool();
                tr.dataset.index = String(virtualRow.index);
                tr.className = virtualRow.index % 2 === 0 ? 'even' : 'odd';
                if (displayRow.kind === 'group') {
                    createDiskGroupHeaderRow(tr, displayRow);
                } else if (displayRow.kind === 'leaf') {
                    createDataRow(tr, createDiskLeafTanRow(displayRow, virtualRow.index), pinnedColumns, formatContext);
                } else if (displayRow.kind === 'footer') {
                    createDiskGroupFooterRow(tr, displayRow);
                } else {
                    createDiskLoadingRow(tr, displayRow);
                }
                fragment.appendChild(tr);
                return;
            }

            let tableRowIndex: number;
            if (isDiskBacked) {
                tableRowIndex = virtualRow.index - diskWindowStart;
            } else {
                tableRowIndex = virtualRow.index;
            }

            const row = tableRowIndex >= 0 && tableRowIndex < rows.length
                ? rows[tableRowIndex]
                : undefined;
            if (!row) {
                if (isDiskBacked) {
                    appendPlaceholderRow(fragment, virtualRow.index);
                }
                return;
            }

            const tr = getRowFromPool();
            tr.dataset.index = String(virtualRow.index);
            tr.className = virtualRow.index % 2 === 0 ? 'even' : 'odd';

            if (row.getIsGrouped?.()) {
                createGroupHeaderRow(tr, row, rs, pinnedColumns);
                if (!row.getIsExpanded?.()) {
                    dataRowCounter += countLeafRows(row);
                }
            } else {
                createDataRow(tr, row, pinnedColumns, formatContext);
            }

            fragment.appendChild(tr);

            if (!row.getIsGrouped?.() && (row.depth ?? 0) > 0) {
                const nextRow = rows[virtualRow.index + 1];
                const isLastInGroup = !nextRow || (nextRow.depth ?? 0) < (row.depth ?? 0) || nextRow.getIsGrouped?.();

                if (isLastInGroup) {
                    const parentRow = row.getParentRow?.() || rows.find((r: GroupableTanStackRow) =>
                        r.getIsGrouped?.() && r.subRows?.some((sr: GroupableTanStackRow) => sr.id === row.id)
                    );

                    if (parentRow && parentRow.getIsExpanded?.() && !renderedGroupFooters.has(parentRow.id)) {
                        const footerTr = createGroupFooterRow(parentRow, rs, rsIndex, tanTable, rowNumberColumnWidth);
                        if (footerTr) {
                            fragment.appendChild(footerTr);
                            renderedGroupFooters.add(parentRow.id);
                        }
                    }
                }
            }
        });

        appendVirtualPaddingRow(paddingBottom, 'virtual-pad-bottom');

        recycleTbodyRowsBeforeClear();
        tbody.innerHTML = '';
        tbody.appendChild(fragment);

        if (resolvedRowHeight === null && rowVirtualizer) {
            const sample = tbody.querySelector('tr[data-index]') as HTMLElement | null;
            const measured = sample?.getBoundingClientRect().height ?? 0;
            if (measured > 0) {
                const anchorIndex = rowVirtualizer.getVirtualItems()[0]?.index ?? 0;
                resolvedRowHeight = measured;
                rowVirtualizer.options.estimateSize = () => measured;
                if (typeof rowVirtualizer.measure === 'function') {
                    rowVirtualizer.measure();
                }
                if (anchorIndex > 0) {
                    try {
                        rowVirtualizer.scrollToIndex(anchorIndex, { align: 'start' });
                    } catch {
                        // Virtualizer may not have settled yet; scroll position is close enough.
                    }
                }
            }
        }

        const scrollTotalSize = rowVirtualizer?.getTotalSize() ?? totalSize;
        syncVirtualScrollExtent(scrollTotalSize, paddingTop, paddingBottom);

        if (selectionHandlers && typeof selectionHandlers.onTableRowsRendered === 'function') {
            selectionHandlers.onTableRowsRendered();
        }
    };

    // Funkcje poolingowe - Faza 6
    getRowFromPool = function () {
        const row = rowPool.pop();
        if (row) {
            // Czyścimy wiersz z poprzedniej zawartości
            row.innerHTML = '';
            row.removeAttribute('class');
            row.removeAttribute('data-index');
            row.removeAttribute('style');
            return row;
        }
        return document.createElement('tr');
    };

    getCellFromPool = function () {
        const cell = cellPool.pop();
        if (cell) {
            // Czyścimy komórkę
            cell.innerHTML = '';
            cell.removeAttribute('class');
            cell.removeAttribute('style');
            cell.removeAttribute('colspan');
            delete cell.dataset.cellId;
            delete cell.dataset.rowNumber;
            return cell;
        }
        return document.createElement('td');
    };

    returnRowToPool = function (row: HTMLTableRowElement): void {
        if (rowPool.length < MAX_POOL_SIZE) {
            rowPool.push(row);
        }
    };

    returnCellToPool = function (cell: HTMLTableCellElement): void {
        if (cellPool.length < MAX_POOL_SIZE * 20) {
            cellPool.push(cell);
        }
    };

    recycleTbodyRowsBeforeClear = function () {
        const existingRows = tbody.children;
        for (let i = existingRows.length - 1; i >= 0; i--) {
            const row = existingRows[i];
            const cells = row.children;
            for (let j = cells.length - 1; j >= 0; j--) {
                returnCellToPool(cells[j] as HTMLTableCellElement);
            }
            returnRowToPool(row as HTMLTableRowElement);
        }
    };

    clearPool = function () {
        rowPool.length = 0;
        cellPool.length = 0;
    };

    const applyRowNumberColumnStyles = (
        cell: HTMLElement,
        overrides: {
            textAlign?: string;
            zIndex?: number;
            backgroundColor?: string;
            cursor?: string;
        } = {},
    ) => {
        cell.style.position = 'sticky';
        cell.style.left = '0';
        cell.style.width = rowNumberColumnWidth + 'px';
        cell.style.minWidth = rowNumberColumnWidth + 'px';
        cell.style.maxWidth = rowNumberColumnWidth + 'px';
        cell.style.textAlign = overrides.textAlign || 'center';
        cell.style.zIndex = String(overrides.zIndex || 10);
        if (overrides.backgroundColor) {
            cell.style.backgroundColor = overrides.backgroundColor;
        }
        if (overrides.cursor) {
            cell.style.cursor = overrides.cursor;
        }
    };

    const refreshAutoSizedLayout = () => {
        let hasChanged = false;

        const nextRowNumberWidth = calculateRowNumberColumnWidth(rs.data.length, measureText);
        if (nextRowNumberWidth !== rowNumberColumnWidth) {
            rowNumberColumnWidth = nextRowNumberWidth;
            hasChanged = true;
        }

        const nextScanLimit = Math.min(rs.data.length, RESULT_GRID_MAX_AUTO_SIZE_ROWS);
        if (nextScanLimit <= autoWidthMeasuredRowCount) {
            return hasChanged;
        }

        const rowsToMeasure = rs.data.slice(autoWidthMeasuredRowCount, nextScanLimit);
        columns.forEach((col: GridColumnDef) => {
            if (manualColumnWidths.has(col.id)) {
                return;
            }

            const currentWidth = columnWidths.get(col.id) || calculateAutoColumnWidth(col, [], measureText);
            const nextWidth = calculateAutoColumnWidth(col, rowsToMeasure, measureText, {
                initialWidth: currentWidth
            });

            if (nextWidth !== currentWidth) {
                columnWidths.set(col.id, nextWidth);
                hasChanged = true;
            }
        });

        autoWidthMeasuredRowCount = nextScanLimit;
        if (hasChanged) {
            chromeDirty = true;
        }
        return hasChanged;
    };

    const autoFitColumn = (columnId: string): boolean => {
        const targetColumn = columns.find((col: GridColumnDef) => col.id === columnId);
        if (!targetColumn) {
            return false;
        }

        const nextWidth = calculateAutoColumnWidth(targetColumn, rs.data, measureText);
        const currentWidth = columnWidths.get(columnId);
        manualColumnWidths.add(columnId);
        columnWidths.set(columnId, nextWidth);

        if (currentWidth !== nextWidth) {
            chromeDirty = true;
        }

        return currentWidth !== nextWidth;
    };

    const setupEditModeDelegation = () => {
        if (editModeDblClickBound) {
            return;
        }
        editModeDblClickBound = true;

        tbody.addEventListener('dblclick', (e) => {
            let isEdit = false;
            try { isEdit = typeof getResultPanelWindow().getIsEditMode === 'function' ? getResultPanelWindow().getIsEditMode!() : false; } catch (_) {}
            if (!isEdit) return;

            const cellTd = asHtml(e.target)?.closest('td');
            if (!cellTd || cellTd.classList.contains('row-number-cell')) return;
            const editCellTd = cellTd;

            const cellTr = cellTd.closest('tr');
            if (!cellTr || !cellTr.dataset.index) return;

            e.stopPropagation();
            const rowIdx = parseInt(cellTr.dataset.index, 10);
            if (isNaN(rowIdx)) return;
            const cellIdx2 = Array.from(cellTr.children).indexOf(cellTd) - 1;
            if (cellIdx2 < 0) return;

            const currentText = editCellTd.textContent;
            const isNull = currentText === 'NULL';

            const input = document.createElement('input');
            input.type = 'text';
            input.value = isNull ? '' : currentText;
            input.className = 'edit-cell-input';
            input.style.width = '100%';
            input.style.boxSizing = 'border-box';
            input.style.backgroundColor = 'var(--vscode-input-background)';
            input.style.color = 'var(--vscode-input-foreground)';
            input.style.border = '1px solid var(--vscode-focusBorder)';
            input.style.padding = '2px 4px';
            input.style.fontSize = 'inherit';
            input.style.fontFamily = 'inherit';

            editCellTd.innerHTML = '';
            editCellTd.appendChild(input);
            input.focus();
            input.select();

            function commitEdit() {
                const newVal = input.value;
                const oldVal = isNull ? null : currentText;
                if (newVal !== (isNull ? '' : currentText)) {
                    try {
                        callPanelMethod('addPendingEdit', rowIdx, cellIdx2, oldVal, newVal);
                    } catch (_) {}
                    editCellTd.classList.add('cell-modified');
                } else {
                    editCellTd.classList.remove('cell-modified');
                }
                editCellTd.innerHTML = '';
                const displaySpan = document.createElement('span');
                displaySpan.textContent = newVal || 'NULL';
                editCellTd.appendChild(displaySpan);
                editCellTd.title = newVal || 'NULL';
            }

            input.onblur = function () { commitEdit(); };
            input.onkeydown = function (ke) {
                if (ke.key === 'Enter') { commitEdit(); }
                if (ke.key === 'Escape') {
                    editCellTd.innerHTML = '';
                    const displaySpan2 = document.createElement('span');
                    displaySpan2.textContent = currentText;
                    editCellTd.appendChild(displaySpan2);
                    editCellTd.title = currentText;
                }
            };
        });
    };

    createDataRow = function (
        tr: HTMLTableRowElement,
        row: GroupableTanStackRow,
        pinnedColumns: string[],
        formatContext: FormatContext,
    ): void {
        const rowNumTd = getCellFromPool();
        rowNumTd.className = 'row-number-cell';
        applyRowNumberColumnStyles(rowNumTd, {
            backgroundColor: 'var(--vscode-editor-background)',
            cursor: 'pointer'
        });
        rowNumTd.dataset.rowNumber = (++dataRowCounter).toString();
        rowNumTd.textContent = dataRowCounter.toString();
        tr.dataset.dataRowNumber = dataRowCounter.toString();
        tr.appendChild(rowNumTd);

        row.getVisibleCells().forEach((cell: GridVisibleCell) => {
            const td = getCellFromPool();
            const value = cell.getValue();
            applyRightAlignmentClass(td, cell.column.columnDef.dataType, cell.column.columnDef.inferredNumericKind, value);

            if (pinnedColumns.includes(cell.column.id)) {
                td.classList.add('pinned-cell');
                td.style.position = 'sticky';
                const leftOffset = calculatePinnedColumnLeft(cell.column.id, pinnedColumns, columnWidths) + rowNumberColumnWidth;
                td.style.left = leftOffset + 'px';
                td.style.zIndex = '10';
                td.style.backgroundColor = 'var(--vscode-editor-background)';
            }

            if (row.depth && row.depth > 0) {
                const indent = document.createElement('span');
                indent.className = 'group-indent';
                indent.style.width = ((row.depth ?? 0) * 20) + 'px';
                td.appendChild(indent);
            }

            if (value === null || value === undefined) {
                const nullSpan = document.createElement('span');
                nullSpan.className = 'null-value';
                nullSpan.textContent = 'NULL';
                td.appendChild(nullSpan);
                td.title = 'NULL';
            } else {
                const formattedValue = formatCellValue(value, cell.column.columnDef.dataType, cell.column.columnDef.scale, {
                    ...formatContext,
                    columnId: cell.column.id,
                    inferredNumericKind: cell.column.columnDef.inferredNumericKind,
                    inferredDateInteger: cell.column.columnDef.inferredDateInteger
                });
                const valueSpan = document.createElement('span');
                const dataType = (cell.column.columnDef.dataType || '').toLowerCase();
                if (dataType === 'bool' || dataType === 'boolean') {
                    const isTrue = value === true || value === 1 || String(value).toLowerCase() === 'true';
                    valueSpan.textContent = isTrue ? '✓ true' : '✗ false';
                    valueSpan.className = isTrue ? 'val-bool-t' : 'val-bool-f';
                } else if (td.classList.contains('cell-align-right')) {
                    if (dataType.includes('date') || dataType.includes('timestamp') || dataType.includes('time')) {
                        valueSpan.textContent = formattedValue;
                        valueSpan.className = 'val-date';
                    } else {
                        valueSpan.textContent = formattedValue;
                        valueSpan.className = 'val-num';
                    }
                } else {
                    valueSpan.textContent = formattedValue;
                }
                td.appendChild(valueSpan);
                td.title = formattedValue ?? '';
            }

            tr.appendChild(td);
        });

        try {
            const isRowMarkedForDelete = getResultPanelWindow().isRowMarkedForDelete;
            if (typeof isRowMarkedForDelete === 'function' && row.index !== undefined && isRowMarkedForDelete(row.index)) {
                tr.classList.add('row-deleted');
            }
        } catch (_) {}
    };

    createGroupHeaderRow = function (
        tr: HTMLTableRowElement,
        row: GroupableTanStackRow,
        resultSet: ResultSet,
        _pinnedColumns: string[],
    ): void {
        tr.className = 'group-header';

        const rowNumTd = getCellFromPool();
        rowNumTd.className = 'row-number-cell';
        applyRowNumberColumnStyles(rowNumTd, {
            backgroundColor: 'var(--vscode-breadcrumb-background)'
        });
        tr.appendChild(rowNumTd);

        const firstCell = getCellFromPool();
        firstCell.colSpan = row.getVisibleCells().length;

        const indent = document.createElement('span');
        indent.className = 'group-indent';
        indent.style.width = ((row.depth ?? 0) * 20) + 'px';
        firstCell.appendChild(indent);

        const indicator = document.createElement('span');
        indicator.textContent = row.getIsExpanded?.() ? '▼' : '▶';
        indicator.style.cursor = 'pointer';
        indicator.onclick = () => row.toggleExpanded?.();
        firstCell.appendChild(indicator);

        const groupingColumnId = row.groupingColumnId ?? '';
        const groupValue = row.getGroupingValue?.(groupingColumnId);
        const groupedColumn = resultSet.columns[parseInt(groupingColumnId, 10)];
        const groupedColumnDef = columns.find((col: GridColumnDef) => col.id === groupingColumnId);
        const formattedGroupValue = formatCellValue(groupValue, groupedColumn.type, groupedColumnDef?.scale, {
            rsIndex,
            executionTimestamp: rs.executionTimestamp,
            columnId: groupingColumnId,
            inferredNumericKind: groupedColumnDef?.inferredNumericKind,
            inferredDateInteger: groupedColumnDef?.inferredDateInteger
        });
        const groupText = document.createElement('span');
        const subRowCount = row.subRows?.length ?? 0;
        groupText.textContent = ` ${resultSet.columns[parseInt(groupingColumnId, 10)].name}: ${formattedGroupValue} (${subRowCount} row${subRowCount !== 1 ? 's' : ''})`;
        firstCell.appendChild(groupText);

        tr.appendChild(firstCell);
    };

    renderGrouping = function () {
        const panel = document.getElementById('groupingPanel');
        if (!panel) return;
        panel.innerHTML = '';

        const grouping = tanTable.getState().grouping ?? [];

        // Also render into sidebar drop zone if present
        const sidebarZone = document.getElementById('sidebarGroupDropZone');
        if (sidebarZone) {
            sidebarZone.innerHTML = '';
            if (grouping.length === 0) {
                sidebarZone.classList.remove('has-chips');
                sidebarZone.innerHTML = '<span class="sidebar-group-hint">Drag columns here from headers or SCHEMA</span>';
            } else {
                sidebarZone.classList.add('has-chips');
                grouping.forEach((colId: string, index: number) => {
                    const chip = createGroupChip(colId, index, rs, tanTable);
                    sidebarZone.appendChild(chip);
                });
            }
        }

        if (grouping.length === 0) {
            panel.innerHTML = '<span style="opacity: 0.5;">Drag headers here to group</span>';
            return;
        }

        grouping.forEach((colId: string, index: number) => {
            const chip = createGroupChip(colId, index, rs, tanTable);
            panel.appendChild(chip);
        });
    };

    updateRowCount = function () {
        renderRowCountInfo(rsIndex);
    };

    renderAggregations = function () {
        try {
            var existingTopAggs = thead && thead.querySelectorAll('.top-agg-row');
            if (existingTopAggs) {
                for (var e = existingTopAggs.length - 1; e >= 0; e--) {
                    existingTopAggs[e].parentNode?.removeChild(existingTopAggs[e]);
                }
            }

            if (!tfoot) return;
            tfoot.innerHTML = '';

            var rows = (tanTable.getFilteredRowModel().rows || []) as GroupableTanStackRow[];
            var visibleColumns = tanTable.getVisibleLeafColumns();
            var currentAggs = getAggregationState(rsIndex, rs.executionTimestamp, getActiveSourceUri()) || {};
            var pinnedColumns = getPinnedColumnsState(rsIndex, rs.executionTimestamp, getActiveSourceUri());

            var bottomAggs: Record<string, ColumnAggregationValue[]> = {};
            var topAggs: Record<string, ColumnAggregationValue[]> = {};
            var hasAnyAggregations = false;
            for (var ci = 0; ci < visibleColumns.length; ci++) {
                var col = visibleColumns[ci];
                var aggs = currentAggs[col.id];
                if (aggs && Array.isArray(aggs) && aggs.length > 0) {
                    bottomAggs[col.id] = aggs.filter(function (a) {
                        return typeof a === 'string' ? true : (a.position !== 'top');
                    });
                    topAggs[col.id] = aggs.filter(function (a) {
                        return typeof a !== 'string' && a.position === 'top';
                    });
                    if (bottomAggs[col.id].length > 0 || topAggs[col.id].length > 0) {
                        hasAnyAggregations = true;
                    }
                }
            }

            if (!hasAnyAggregations) {
                return;
            }

            if (rs.storageMode === 'sqlite') {
                void (async () => {
                    try {
                        const requests: Array<{ columnIndex: number; fn: string }> = [];

                        function collectRequests(
                            aggMap: Record<string, ColumnAggregationValue[]>,
                            position: 'top' | 'bottom',
                        ): void {
                            for (let ci = 0; ci < visibleColumns.length; ci++) {
                                const col = visibleColumns[ci];
                                const colAggs = aggMap[col.id];
                                if (!Array.isArray(colAggs) || colAggs.length === 0) {
                                    continue;
                                }
                                colAggs.forEach((aggItem, aggIndex) => {
                                    const fn = getAggFn(aggItem);
                                    requests.push({
                                        columnIndex: Number.parseInt(col.id, 10),
                                        fn,
                                    });
                                });
                            }
                        }

                        collectRequests(bottomAggs, 'bottom');
                        collectRequests(topAggs, 'top');

                        if (requests.length === 0) {
                            return;
                        }

                        syncDiskQuerySpecFromGrid(rsIndex);
                        const sqlResults = await queryDiskAggregations(rsIndex, requests);
                        const resultByKey = new Map<string, unknown>();
                        sqlResults.forEach((entry) => {
                            resultByKey.set(`${entry.columnIndex}:${entry.fn}`, entry.value);
                        });

                        const cachedBottomResults: Record<string, string[]> = {};
                        const cachedTopResults: Record<string, string[]> = {};

                        function buildDiskResultCache(
                            aggMap: Record<string, ColumnAggregationValue[]>,
                            target: Record<string, string[]>,
                        ): void {
                            for (let ci = 0; ci < visibleColumns.length; ci++) {
                                const col = visibleColumns[ci];
                                const colAggs = aggMap[col.id];
                                if (!Array.isArray(colAggs) || colAggs.length === 0) {
                                    continue;
                                }
                                target[col.id] = colAggs.map((aggItem) => {
                                    const fn = getAggFn(aggItem);
                                    const columnIndex = Number.parseInt(col.id, 10);
                                    const rawValue = resultByKey.get(`${columnIndex}:${fn}`);
                                    return formatDiskAggregationResult(aggItem, rawValue, col);
                                });
                            }
                        }

                        buildDiskResultCache(bottomAggs, cachedBottomResults);
                        buildDiskResultCache(topAggs, cachedTopResults);

                        renderAggRows(tfoot, bottomAggs, false, cachedBottomResults);
                        if (thead) {
                            renderAggRows(thead, topAggs, true, cachedTopResults);
                        }
                    } catch (diskAggError) {
                        console.error('Disk aggregation render error:', diskAggError);
                    }
                })();
                return;
            }

            var nextCacheKey = [
                rows.length,
                rs.data.length,
                JSON.stringify(tableState.sorting),
                JSON.stringify(tableState.columnFilters),
                tableState.globalFilter,
                JSON.stringify(currentAggs)
            ].join('|');

            var cachedBottomResults: Record<string, string[]> | null = null;
            var cachedTopResults: Record<string, string[]> | null = null;
            if (nextCacheKey === aggregationCacheKey && aggregationCacheBottom) {
                cachedBottomResults = aggregationCacheBottom;
                cachedTopResults = aggregationCacheTop;
            } else {
                function buildAggResultCache(aggMap: Record<string, unknown>): Record<string, string[]> {
                    var resultMap: Record<string, string[]> = {};
                    for (var cacheColIdx = 0; cacheColIdx < visibleColumns.length; cacheColIdx++) {
                        var cacheCol = visibleColumns[cacheColIdx];
                        var cacheColAggs = aggMap[cacheCol.id];
                        if (!Array.isArray(cacheColAggs) || cacheColAggs.length === 0) {
                            continue;
                        }
                        var typeInfo = getAggregationColumnTypeInfo(cacheCol);
                        resultMap[cacheCol.id] = cacheColAggs.map(function (aggItem) {
                            return calculateAggregation(aggItem, rows, cacheCol, typeInfo);
                        });
                    }
                    return resultMap;
                }

                cachedBottomResults = buildAggResultCache(bottomAggs);
                cachedTopResults = buildAggResultCache(topAggs);
                aggregationCacheKey = nextCacheKey;
                aggregationCacheBottom = cachedBottomResults;
                aggregationCacheTop = cachedTopResults;
            }

            function renderAggRows(
                parentContainer: HTMLElement,
                aggMap: Record<string, ColumnAggregationValue[]>,
                isTop: boolean,
                cachedResults: Record<string, string[]>,
            ): void {
                var maxAggCount = 0;
                for (var cj = 0; cj < visibleColumns.length; cj++) {
                    var colJ = visibleColumns[cj];
                    var aggsJ = aggMap[colJ.id];
                    if (aggsJ && Array.isArray(aggsJ) && aggsJ.length > maxAggCount) {
                        maxAggCount = aggsJ.length;
                    }
                }
                if (maxAggCount === 0) return;

                for (var ri = 0; ri < maxAggCount; ri++) {
                    var aggRow = document.createElement('tr');
                    aggRow.className = 'aggregation-row' + (isTop ? ' top-agg-row' : '');

                    var rowNumTd = document.createElement('td');
                    rowNumTd.className = 'row-number-cell';
                    applyRowNumberColumnStyles(rowNumTd, {
                        zIndex: 1600,
                        backgroundColor: 'var(--vscode-editor-background)'
                    });
                    aggRow.appendChild(rowNumTd);

                    for (var ck = 0; ck < visibleColumns.length; ck++) {
                        var colK = visibleColumns[ck];
                        var td = document.createElement('td');
                        td.style.padding = '4px 8px';
                        td.style.borderTop = 'none';
                        td.style.fontWeight = '500';
                        td.style.fontSize = '12px';
                        td.style.verticalAlign = 'middle';

                        if (ri === 0) {
                            if (isTop) {
                                td.style.boxShadow = 'inset 0 -2px 0 0 var(--vscode-panel-border)';
                            } else {
                                td.style.boxShadow = 'inset 0 2px 0 0 var(--vscode-panel-border)';
                            }
                        }

                        if (pinnedColumns.indexOf(colK.id) !== -1) {
                            td.classList.add('pinned-cell');
                            var leftOff = calculatePinnedColumnLeft(colK.id, pinnedColumns, columnWidths) + rowNumberColumnWidth;
                            td.style.left = leftOff + 'px';
                        }

                        var colAggs = aggMap[colK.id];
                        if (!colAggs || !Array.isArray(colAggs) || ri >= colAggs.length) {
                            td.textContent = '';
                            aggRow.appendChild(td);
                            continue;
                        }

                        var aggItem = colAggs[ri];
                        var typeInfo = getAggregationColumnTypeInfo(colK);
                        var colCache = cachedResults[colK.id];
                        var result = colCache && colCache[ri] !== undefined
                            ? colCache[ri]
                            : calculateAggregation(aggItem, rows, colK, typeInfo);
                        var alignRight = applyRightAlignmentClass(td, colK.columnDef && colK.columnDef.dataType, colK.columnDef && colK.columnDef.inferredNumericKind);

                        var cellContent = document.createElement('div');
                        cellContent.className = 'agg-cell-content';
                        cellContent.style.display = 'flex';
                        cellContent.style.alignItems = 'center';
                        cellContent.style.gap = '6px';

                        var labelSpan = document.createElement('span');
                        labelSpan.className = 'agg-label';
                        labelSpan.textContent = getAggregationSymbol(aggItem);
                        labelSpan.style.opacity = '0.6';
                        labelSpan.style.fontSize = '11px';
                        labelSpan.style.minWidth = '16px';

                        var valueSpan = document.createElement('span');
                        valueSpan.className = 'agg-value';
                        valueSpan.textContent = result;
                        valueSpan.style.flex = '1';
                        if (alignRight) {
                            cellContent.classList.add('cell-align-right');
                            valueSpan.classList.add('cell-align-right');
                        }

                        cellContent.appendChild(labelSpan);
                        cellContent.appendChild(valueSpan);
                        td.appendChild(cellContent);
                        aggRow.appendChild(td);
                    }

                    parentContainer.appendChild(aggRow);
                }
            }

            // Bottom → tfoot
            renderAggRows(tfoot, bottomAggs, false, cachedBottomResults);

            // Top → thead (after header rows)
            if (thead) {
                renderAggRows(thead, topAggs, true, cachedTopResults ?? {});
            }

        } catch (e) {
            console.error('Aggregation render error:', e);
        }
    };



    tanTable = createTable({
        data: rs.data,
        columns,
        state: {
            get sorting() { return tableState.sorting; },
            get globalFilter() { return tableState.globalFilter; },
            get grouping() { return tableState.grouping; },
            get expanded() { return tableState.expanded; },
            get columnOrder() { return tableState.columnOrder; },
            get columnFilters() { return tableState.columnFilters; },
            get columnPinning() { return tableState.columnPinning; },
            get columnVisibility() { return tableState.columnVisibility; }
        },
        onSortingChange: (updater) => {
            tableState.sorting = typeof updater === 'function' ? updater(tableState.sorting) : updater;
            if (getResultSetAt(rsIndex)?.storageMode === 'sqlite') {
                syncDiskQuerySpecFromGrid(rsIndex);
                if (tableState.grouping.length > 0) {
                    refreshDiskGrouping(rsIndex, tableState.grouping, getDiskGroupAggregationRequests());
                } else {
                    refreshDiskQueryWindow(rsIndex, true);
                }
            }
            invalidateRowNumberCache();
            invalidateAggregationCache();
            scheduleRender({ chrome: true });
            saveAllGridStates();
        },
        onGlobalFilterChange: (updater) => {
            tableState.globalFilter = typeof updater === 'function' ? updater(tableState.globalFilter) : updater;
            setGlobalFilterState(rsIndex, tableState.globalFilter, rs.executionTimestamp, getActiveSourceUri());
            if (getResultSetAt(rsIndex)?.storageMode === 'sqlite') {
                syncDiskQuerySpecFromGrid(rsIndex);
                if (tableState.grouping.length > 0) {
                    refreshDiskGrouping(rsIndex, tableState.grouping, getDiskGroupAggregationRequests());
                } else {
                    refreshDiskQueryWindow(rsIndex, true);
                }
            }
            invalidateRowNumberCache();
            invalidateAggregationCache();
            scheduleRender();
            saveAllGridStates();
        },
        onColumnFiltersChange: (updater) => {
            tableState.columnFilters = typeof updater === 'function' ? updater(tableState.columnFilters) : updater;
            if (getResultSetAt(rsIndex)?.storageMode === 'sqlite') {
                syncDiskQuerySpecFromGrid(rsIndex);
                if (tableState.grouping.length > 0) {
                    refreshDiskGrouping(rsIndex, tableState.grouping, getDiskGroupAggregationRequests());
                } else {
                    refreshDiskQueryWindow(rsIndex, true);
                }
            }
            invalidateRowNumberCache();
            invalidateAggregationCache();
            scheduleRender();
            saveAllGridStates();
        },
        onGroupingChange: (updater) => {
            tableState.grouping = typeof updater === 'function' ? updater(tableState.grouping) : updater;
            if (getResultSetAt(rsIndex)?.storageMode === 'sqlite') {
                syncDiskQuerySpecFromGrid(rsIndex);
                if (tableState.grouping.length > 0) {
                    refreshDiskGrouping(rsIndex, tableState.grouping, getDiskGroupAggregationRequests());
                } else {
                    clearDiskGrouping(rsIndex);
                    refreshDiskQueryWindow(rsIndex, true);
                }
            }
            invalidateRowNumberCache();
            invalidateAggregationCache();
            render();
            renderGrouping();
            saveAllGridStates();
        },
        onExpandedChange: (updater) => {
            tableState.expanded = typeof updater === 'function' ? updater(tableState.expanded) : updater;
            invalidateRowNumberCache();
            scheduleRender();
            saveAllGridStates();
        },
        onColumnOrderChange: (updater) => {
            tableState.columnOrder = typeof updater === 'function' ? updater(tableState.columnOrder) : updater;
            scheduleRender({ chrome: true });
            saveAllGridStates();
            if (document.body.classList.contains('sidebar-layout') && rsIndex === getActiveGridIndex()) {
                getResultPanelWindow().renderSidebarSchema?.();
            }
        },
        onColumnPinningChange: (updater) => {
            tableState.columnPinning = typeof updater === 'function' ? updater(tableState.columnPinning) : updater;
            scheduleRender({ chrome: true });
            saveAllGridStates();
        },
        onColumnVisibilityChange: (updater) => {
            tableState.columnVisibility = typeof updater === 'function' ? updater(tableState.columnVisibility) : updater;
            scheduleRender({ chrome: true });
            saveAllGridStates();
            if (document.body.classList.contains('sidebar-layout') && rsIndex === getActiveGridIndex()) {
                getResultPanelWindow().renderSidebarSchema?.();
            }
        },
        globalFilterFn: (row: unknown, _columnId: string, filterValue: string) => {
            const groupableRow = row as GroupableTanStackRow;
            if (!filterValue || filterValue === '') {
                return true;
            }

            const rsForFilter = getResultSetAt(rsIndex);
            if (rsForFilter?.storageMode === 'sqlite') {
                // Disk-backed filtering is applied via SQL window fetch.
                return true;
            }

            const matches = getSearchMatches(rsIndex);
            if (matches !== undefined && matches !== null) {
                const rsForMatch = getResultSetAt(rsIndex);
                const rowIndex = groupableRow.index ?? 0;
                const absoluteIndex = rsForMatch?.storageMode === 'sqlite'
                    ? (rsForMatch.diskWindowStart ?? 0) + rowIndex
                    : rowIndex;
                return matches.has(absoluteIndex);
            }

            const rsForCount = getResultSetAt(rsIndex);
            const totalRows = rsForCount?.storageMode === 'sqlite'
                ? (rsForCount.totalRowCount ?? 0)
                : (Array.isArray(rsForCount?.data) ? rsForCount.data.length : 0);
            if (filterValue && totalRows >= GLOBAL_FILTER_WORKER_ROW_THRESHOLD) {
                // Worker-backed filter: never scan all rows on the main thread while waiting.
                return true;
            }

            const query = String(filterValue).toLowerCase();
            const original = groupableRow.original;
            if (!original || !Array.isArray(original)) {
                return false;
            }

            for (let c = 0; c < original.length; c++) {
                let val = original[c];
                if (val === null || val === undefined) {
                    val = 'NULL';
                } else {
                    val = String(val);
                }
                if (val.toLowerCase().includes(query)) {
                    return true;
                }
            }

            return false;
        },
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        getGroupedRowModel: getGroupedRowModel(),
        getExpandedRowModel: getExpandedRowModel()
    }) as GridTanStackTable;

    // Reorder columns to ensure pinned columns are on the left
    reorderColumnsForPinning(tanTable, rsIndex, rs.executionTimestamp);

    // Create grid object
    const gridObj: GridHandle = {
        tanTable,
        rsIndex,
        executionTimestamp: rs.executionTimestamp,
        renderGrouping: () => renderGrouping(),
        updateRowCount: () => updateRowCount(),
        render: () => render(),
        createVirtualizer: () => createVirtualizer(),
        renderTableRows: () => renderTableRows(),
        renderColGroup: () => renderColGroup(),
        columnWidths: columnWidths,
        manualColumnWidths: manualColumnWidths,
        autoFitColumn: (columnId: string) => autoFitColumn(columnId),
        refreshAutoSizedLayout: () => refreshAutoSizedLayout(),
        scrollToIndex: (index: number, align: string = 'auto') => {
            if (!rowVirtualizer || (rowVirtualizer.options.count ?? 0) <= 0) {
                if (index <= 0) {
                    wrapper.scrollTop = 0;
                }
                return;
            }
            const safeIndex = Math.max(0, Math.min(index, rowVirtualizer.options.count - 1));
            try {
                rowVirtualizer.scrollToIndex(safeIndex, { align });
            } catch {
                if (safeIndex <= 0) {
                    wrapper.scrollTop = 0;
                }
            }
        },
        getScrollAnchorIndex: (): number | undefined => {
            const items = rowVirtualizer?.getVirtualItems() ?? [];
            return items.length > 0 ? items[0].index : undefined;
        },
        clearPool: () => clearPool(),
        destroyVirtualizer: () => {
            if (virtualizerCleanup) {
                virtualizerCleanup();
                virtualizerCleanup = null;
            }
            rowVirtualizer = null;
            lastVirtualizerKey = '';
            resolvedRowHeight = null;
        },
        dispose: () => {
            disposed = true;
            if (typeof debouncedSaveOnScroll?.cancel === 'function') {
                debouncedSaveOnScroll.cancel();
            }
            if (debouncedSaveOnScroll) {
                wrapper.removeEventListener('scroll', debouncedSaveOnScroll as EventListener);
            }
            if (immediateScrollSaveHandler) {
                wrapper.removeEventListener('scroll', immediateScrollSaveHandler);
                immediateScrollSaveHandler = null;
            }
            if (wrapper._scrollSaveTimeout) {
                clearTimeout(wrapper._scrollSaveTimeout);
                wrapper._scrollSaveTimeout = undefined;
            }
            selectionHandlers?.destroy();
            selectionHandlers = null;
            if (virtualizerCleanup) {
                virtualizerCleanup();
                virtualizerCleanup = null;
            }
            rowVirtualizer = null;
            lastVirtualizerKey = '';
            resolvedRowHeight = null;
            if (tanTable.options) {
                tanTable.options.data = [];
            }
            rowPool.length = 0;
            cellPool.length = 0;
        },
    };
    addGrid(gridObj);

    setupEditModeDelegation();

    const clipboardResolver: ClipboardRowResolver = {
        resolveRowValues: (virtualIndex: number) => {
            const liveRs = getResultSetAt(rsIndex);
            if (liveRs?.storageMode === 'sqlite' && tableState.grouping.length > 0) {
                return getDiskGroupingLeafRowAt(rsIndex, virtualIndex);
            }
            if (liveRs?.storageMode === 'sqlite') {
                const windowStart = liveRs.diskWindowStart ?? 0;
                const localIndex = virtualIndex - windowStart;
                const row = tanTable.getRowModel().rows[localIndex];
                return row ? (row.original as unknown[]) : undefined;
            }
            const row = tanTable.getRowModel().rows[virtualIndex];
            return row ? (row.original as unknown[]) : undefined;
        },
        fetchRowValues: async (virtualIndex: number) => {
            const liveRs = getResultSetAt(rsIndex);
            const sourceUri = getActiveSourceUri();
            if (!liveRs || liveRs.storageMode !== 'sqlite' || !sourceUri || tableState.grouping.length > 0) {
                return undefined;
            }
            const rows = await fetchRowsFromHost(sourceUri, rsIndex, virtualIndex, 1);
            return rows[0];
        },
        fetchAllRowValues: async () => {
            const liveRs = getResultSetAt(rsIndex);
            const sourceUri = getActiveSourceUri();
            if (!liveRs || liveRs.storageMode !== 'sqlite' || !sourceUri) {
                return tanTable.getFilteredRowModel().rows.map((row) => row.original as unknown[]);
            }
            const total = getDiskFilteredCount(liveRs);
            const batchSize = 50_000;
            const allRows: unknown[][] = [];
            for (let offset = 0; offset < total; offset += batchSize) {
                const chunk = await fetchRowsFromHost(
                    sourceUri,
                    rsIndex,
                    offset,
                    Math.min(batchSize, total - offset),
                );
                allRows.push(...chunk);
            }
            return allRows;
        },
    };

    selectionHandlers = setupCellSelectionEvents(wrapper, tanTable, columns.length, clipboardResolver);
    const originalClearPool = gridObj.clearPool;
    gridObj.clearPool = () => {
        selectionHandlers?.destroy();
        originalClearPool?.();
    };

    // Initial render
    render();

    void scheduleDeferredColumnWidthInit(columns, rs, columnWidths, manualColumnWidths, measureText, () => {
        if (getGridInitSignal()?.aborted) {
            return;
        }
        chromeDirty = true;
        render();
    });

    // Note: Scroll position restoration is handled by switchToResultSet in tabs.js
    // which runs after all grids are created and uses proper requestAnimationFrame timing

    /**
     * Save scroll position during scrolling for view switching preservation.
     * Global cache is updated immediately to have the most recent position available
     * when user switches back from Terminal or other views.
     * Debounced (200ms) to avoid excessive saves during fast scrolling.
     * 
     * Test coverage: scrollPreservation.test.ts
     */
    debouncedSaveOnScroll = debounce(() => {
        saveAllGridStates();
        // Save scroll to global cache for persistence across document switches
        if (getActiveSourceUri() && getResultSetAt(rsIndex)) {
            const rsAtIndex = getResultSetAt(rsIndex)!;
            saveScrollStateToCache(requireActiveSourceUri(), rsIndex, {
                scrollTop: wrapper.scrollTop,
                scrollLeft: wrapper.scrollLeft,
                scrollAnchorIndex: gridObj.getScrollAnchorIndex?.(),
                timestamp: rsAtIndex.executionTimestamp,
            });
        }
    }, 200);
    wrapper.addEventListener('scroll', debouncedSaveOnScroll);

    /**
     * Immediate (throttled) scroll save for fast scroll scenarios.
     * Captures position every 50ms to ensure we don't lose scroll position
     * during rapid scrolling before user switches views.
     */
    immediateScrollSaveHandler = () => {
        if (getActiveSourceUri() && getResultSetAt(rsIndex)) {
            if (!wrapper._scrollSaveTimeout) {
                wrapper._scrollSaveTimeout = setTimeout(() => {
                    const rsAtIndex = getResultSetAt(rsIndex);
                    if (!rsAtIndex) return;
                    saveScrollStateToCache(requireActiveSourceUri(), rsIndex, {
                        scrollTop: wrapper.scrollTop,
                        scrollLeft: wrapper.scrollLeft,
                        scrollAnchorIndex: gridObj.getScrollAnchorIndex?.(),
                        timestamp: rsAtIndex.executionTimestamp,
                    });
                    wrapper._scrollSaveTimeout = undefined;
                }, 50);
            }
        }
    };
    wrapper.addEventListener('scroll', immediateScrollSaveHandler, { passive: true });

    Object.assign(gridObj, selectionHandlers);

    populateColumnSearchList(rsIndex, rs, columns);
}
