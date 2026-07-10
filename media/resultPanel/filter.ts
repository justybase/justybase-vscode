// Filter module - Column filtering and aggregation for result panel
import {
    getActiveGridIndex,
    getGrid,
    getAggregationState,
    setAggregationState,
    setGlobalDragState,
    getPinnedColumnsState,
    togglePinnedColumn,
    getIsSearching,
    getGlobalFilterState,
    getSortedSearchMatchIndices,
} from './state.js';
import { formatCellValue, formatSqlIdentifierForInsertion } from './utils.js';
import { matchesFilterValueSearch, parseFilterNumericValue, sortFilterValues } from './filterValueSort.js';
import { savePinnedState } from './grid/persistence.js';
import { openResultFormattingPanel } from './formatting.js';
import { postHostMessage } from './protocol.js';
import type {
    AggregationSelection,
    ColumnFilterValue,
    ConditionColumnFilter,
    DiskColumnFilterSpec,
    DiskQuerySpec,
    FilterCondition,
    ResultSet,
    TanStackColumn,
    TanStackHeader,
    TanStackRow,
    TanStackTable
} from './types';
import { getResultPanelWindow, getActiveSourceUri, isActiveSourceExecuting } from './types.js';
import { diskQuerySpecHasFilters } from './diskQueryUtils.js';
import { queryDiskDistinctValues } from './diskBackedGrid.js';
import { applyDatabaseFilter, queryDatabaseFilterValues } from './databaseFilters.js';
import { showInlineErrorWithRetry } from './inlineErrorRetry.js';
import {
    buildDiskQuerySpecForResultSet,
    getDiskFilteredCount,
    setDiskColumnFilterConditions,
    setDiskColumnFilterValues,
} from './diskQuerySpec.js';

const vscode = { postMessage: postHostMessage };

function findTrailingLimitValue(sql: string | undefined): string | null {
    if (!sql) return null;
    const match = /(?:\blimit\s+)(\d+)(\s*;?\s*)$/i.exec(sql);
    return match ? match[1] : null;
}

export const FILTER_MAX_UNIQUE_VALUES = 10000;

function isConditionColumnFilter(value: ColumnFilterValue): value is ConditionColumnFilter {
    return Boolean(value && typeof value === 'object' && '_isConditionFilter' in value);
}

function hasActiveColumnFilter(
    columnIndex: number,
    currentFilter: ColumnFilterValue | undefined,
    resultSet: ResultSet,
): boolean {
    const specFilters = [
        resultSet.databaseFilterSpec?.columnFilters,
        resultSet.diskQuerySpec?.columnFilters,
    ];
    for (const filters of specFilters) {
        const match = filters?.find((filter) => filter.columnIndex === columnIndex);
        if (match && (
            (match.conditions?.length ?? 0) > 0
            || (match.values?.length ?? 0) > 0
        )) {
            return true;
        }
    }
    return Boolean(currentFilter && (
        (Array.isArray(currentFilter) && currentFilter.length > 0)
        || (isConditionColumnFilter(currentFilter) && Array.isArray(currentFilter.conditions) && currentFilter.conditions.length > 0)
    ));
}

export function isResultSetRowLimitReached(rs: ResultSet | null | undefined): boolean {
    if (!rs || rs.isLog || rs.isError) {
        return false;
    }
    if (rs.limitReached === true) {
        return true;
    }
    const configuredLimit = Number(getResultPanelWindow().queryRowLimit);
    if (!Number.isFinite(configuredLimit) || configuredLimit <= 0) {
        return false;
    }
    return Array.isArray(rs.data) && rs.data.length >= configuredLimit;
}

export function applyRowLimitReachedFlag(rs: ResultSet | null | undefined, limitReached: boolean): void {
    if (!rs || rs.isLog || rs.isError) {
        return;
    }
    if (limitReached === true) {
        rs.limitReached = true;
        return;
    }
    if (rs.limitReached !== true && isResultSetRowLimitReached(rs)) {
        rs.limitReached = true;
    }
}

function appendRowLimitWarning(container: HTMLElement, _rs: ResultSet): void {
    const limit = Number(getResultPanelWindow().queryRowLimit) || 200000;
    const warning = document.createElement('span');
    warning.className = 'row-limit-warning';
    warning.title =
        `Query row limit of ${limit.toLocaleString()} rows was reached. ` +
        'Increase "justybase.query.rowLimit" in settings to fetch more.';
    warning.textContent = ' — limit reached';
    container.appendChild(warning);
}

export function renderRowCountInfo(resultSetIndex: number = getActiveGridIndex()): void {
    const rowCountInfo = document.getElementById('rowCountInfo');
    if (!rowCountInfo || resultSetIndex !== getActiveGridIndex()) {
        return;
    }

    const panelWindow = getResultPanelWindow();
    const rs = panelWindow.resultSets ? panelWindow.resultSets[resultSetIndex] : null;
    if (!rs || rs.isLog || rs.isError || rs.isTextContent) {
        rowCountInfo.textContent = '';
        rowCountInfo.style.opacity = '';
        return;
    }

    applyRowLimitReachedFlag(rs, rs.limitReached === true);

    if (getIsSearching()) {
        rowCountInfo.textContent = '';
        rowCountInfo.style.opacity = '';
        const label = document.createElement('span');
        label.className = 'global-filter-searching-label';
        label.textContent = 'Searching…';
        rowCountInfo.appendChild(label);
        return;
    }

    const isDiskBacked = rs.storageMode === 'sqlite';
    const loadedRows = Array.isArray(rs.data) ? rs.data.length : 0;
    const totalRows = isDiskBacked
        ? (rs.totalRowCount ?? 0)
        : (typeof rs.totalRowCount === 'number' ? rs.totalRowCount : loadedRows);
    const isStreamingPreview = !isDiskBacked
        && typeof rs.totalRowCount === 'number'
        && rs.totalRowCount > loadedRows
        && (isActiveSourceExecuting() || loadedRows < totalRows);

    const globalFilter = getGlobalFilterState(
        resultSetIndex,
        rs.executionTimestamp,
        getActiveSourceUri(),
    );
    const hasActiveGlobalFilter = Boolean(globalFilter && globalFilter.trim() !== '');

    if (isDiskBacked) {
        rowCountInfo.textContent = '';
        rowCountInfo.style.opacity = '';
        const filteredCount = getDiskFilteredCount(rs);
        const hasFilters = diskQuerySpecHasFilters(rs.diskQuerySpec) || hasActiveGlobalFilter;
        let text: string;
        if (hasFilters && filteredCount !== totalRows) {
            text = `${filteredCount.toLocaleString()} row${filteredCount !== 1 ? 's' : ''} of ${totalRows.toLocaleString()}`;
        } else {
            text = `${filteredCount.toLocaleString()} row${filteredCount !== 1 ? 's' : ''}`;
        }
        if (isActiveSourceExecuting()) {
            text += ' (streaming…)';
        }
        rowCountInfo.appendChild(document.createTextNode(text));
        if (isResultSetRowLimitReached(rs)) {
            appendRowLimitWarning(rowCountInfo, rs);
        }
        return;
    }

    const sortedMatches = getSortedSearchMatchIndices(resultSetIndex);

    if (hasActiveGlobalFilter && sortedMatches !== undefined) {
        rowCountInfo.textContent = '';
        rowCountInfo.style.opacity = '';
        const matchCount = sortedMatches.length;
        let text = `${matchCount.toLocaleString()} row${matchCount !== 1 ? 's' : ''} of ${totalRows.toLocaleString()}`;
        rowCountInfo.appendChild(document.createTextNode(text));
        if (isResultSetRowLimitReached(rs)) {
            appendRowLimitWarning(rowCountInfo, rs);
        }
        return;
    }

    const grid = getGrid(resultSetIndex);
    const filteredRows = !isStreamingPreview
        ? grid?.tanTable?.getFilteredRowModel?.().rows
        : undefined;
    const hasFilteredCount = Array.isArray(filteredRows);
    const visibleCount = isStreamingPreview
        ? loadedRows
        : (hasFilteredCount ? filteredRows.length : totalRows);

    rowCountInfo.textContent = '';
    rowCountInfo.style.opacity = '';

    let text = `${visibleCount.toLocaleString()} row${visibleCount !== 1 ? 's' : ''}`;
    if ((isStreamingPreview || (hasFilteredCount && visibleCount !== totalRows)) && totalRows > visibleCount) {
        text += ` of ${totalRows.toLocaleString()}`;
    }
    rowCountInfo.appendChild(document.createTextNode(text));

    if (isResultSetRowLimitReached(rs)) {
        appendRowLimitWarning(rowCountInfo, rs);
    }
}

export function updateRowCountInfo(resultSetIndex: number, _totalRows: number, limitReached: boolean): void {
    const panelWindow = getResultPanelWindow();
    const rs = panelWindow.resultSets ? panelWindow.resultSets[resultSetIndex] : null;
    if (rs) {
        applyRowLimitReachedFlag(rs, limitReached === true);
    }
    renderRowCountInfo(resultSetIndex);
}

type HeaderScheduleRenderFn = (options?: { chrome?: boolean }) => void;

export function createHeaderCellWithFilter(
    header: TanStackHeader,
    resultSet: ResultSet,
    table: TanStackTable,
    rsIndex: number,
    scheduleRender?: HeaderScheduleRenderFn
): HTMLTableCellElement {
    const th = document.createElement('th');
    th.draggable = true;
    th.dataset.colId = header.column.id;
    th.style.position = 'relative';
    th.style.padding = '4px 7px';
    th.style.borderBottom = '2px solid var(--ac)';
    th.style.borderRight = '1px solid var(--vscode-panel-border)';

    const headerContent = document.createElement('div');
    headerContent.style.display = 'flex';
    headerContent.style.justifyContent = 'space-between';
    headerContent.style.alignItems = 'center';
    headerContent.style.minHeight = '20px';

    const dataType = (header.column.columnDef.dataType || '').toLowerCase();
    const typeClassMap: Record<string, string> = { text: 'tt', number: 'tn', boolean: 'tb2', date: 'td' };
    const typeClass = typeClassMap[dataType === 'timestamp' || dataType.includes('datetime') || dataType.includes('time') ? 'date' : dataType] || 'tt';
    const typeLabel = (dataType || '').slice(0, 4);

    const dragHandle = document.createElement('span');
    dragHandle.className = 'col-drag-handle';
    dragHandle.textContent = '⠿';
    dragHandle.title = 'Drag to reorder';

    const typeBadge = document.createElement('span');
    typeBadge.className = 'tb ' + typeClass;
    typeBadge.textContent = typeLabel;

    const headerText = document.createElement('span');
    headerText.innerHTML = header.column.columnDef.header;
    headerText.style.cursor = 'pointer';
    headerText.style.flex = '1';
    headerText.style.minWidth = '0';
    headerText.style.overflow = 'hidden';
    headerText.style.textOverflow = 'ellipsis';
    headerText.style.whiteSpace = 'nowrap';

    // Get column index for selection (use header.index which is the correct TanStack Table API)
    const columnIndex = header.index;

    headerText.onclick = (e) => {
        e.stopPropagation();
        // Select all cells in this column using the grid's selectColumn method
        const grid = getGrid(rsIndex);
        if (grid && grid.selectColumn) {
            grid.selectColumn(columnIndex);
        }
    };
    headerText.ondblclick = (e) => {
        e.preventDefault();
        e.stopPropagation();

        const headerName = String(header.column.columnDef.header || '').trim();
        const sqlText = formatSqlIdentifierForInsertion(headerName);
        if (!sqlText) {
            return;
        }

        vscode.postMessage({
            command: 'insertCellContent',
            text: headerName,
            sqlText
        });
    };
    headerContent.append(dragHandle, typeBadge, headerText);

    // Sort icon/button
    const sortBtn = document.createElement('span');
    const isSorted = header.column.getIsSorted();
    const activeSortCount = table.getState().sorting?.length ?? 0;
    const sortIndex = header.column.getSortIndex?.() ?? -1;
    sortBtn.className = 'header-btn header-btn-sort' + (isSorted ? ' active' : '');
    sortBtn.style.position = 'relative';
    sortBtn.innerHTML = isSorted
        ? (isSorted === 'asc'
            ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2l4 5H4l4-5zm0 12l-4-5h8l-4 5z"/></svg>'
            : '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 14l-4-5h8l-4 5zm0-12l4 5H4l4-5z"/></svg>')
        : '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1L5 5h6L8 1zM8 15l3-4H5l3 4z"/></svg>';

    if (isSorted && activeSortCount > 1 && sortIndex >= 0) {
        const sortOrderBadge = document.createElement('span');
        sortOrderBadge.textContent = String(sortIndex + 1);
        sortOrderBadge.style.position = 'absolute';
        sortOrderBadge.style.top = '-6px';
        sortOrderBadge.style.right = '-8px';
        sortOrderBadge.style.backgroundColor = 'var(--vscode-charts-blue)';
        sortOrderBadge.style.color = 'var(--vscode-button-foreground)';
        sortOrderBadge.style.fontSize = '9px';
        sortOrderBadge.style.padding = '1px 3px';
        sortOrderBadge.style.borderRadius = '3px';
        sortOrderBadge.style.lineHeight = '1';
        sortOrderBadge.style.pointerEvents = 'none';
        sortBtn.appendChild(sortOrderBadge);
    }

    if (!isSorted) {
        sortBtn.title = 'Click to sort. Shift+Click to add another sort column.';
    } else if (isSorted === 'asc') {
        sortBtn.title = activeSortCount > 1
            ? `Sorted ascending (priority ${sortIndex + 1}). Shift+Click another column to add sort.`
            : 'Sorted ascending. Shift+Click another column to add sort.';
    } else {
        sortBtn.title = activeSortCount > 1
            ? `Sorted descending (priority ${sortIndex + 1}). Shift+Click another column to add sort.`
            : 'Sorted descending. Shift+Click another column to add sort.';
    }

    sortBtn.onclick = (e) => {
        e.stopPropagation();
        header.column.getToggleSortingHandler()(e);
        if (scheduleRender) {
            scheduleRender({ chrome: true });
        }
    };

    headerContent.appendChild(sortBtn);

    // Filter dropdown button
    const filterBtn = document.createElement('span');
    filterBtn.className = 'header-btn header-btn-filter';
    filterBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2h14l-5.5 6.5V14l-3 2v-7.5L1 2z"/></svg>';
    filterBtn.title = 'Filter';

    const currentFilter = table.getColumn(header.column.id).getFilterValue();
    const parsedColumnIndex = Number.parseInt(header.column.id, 10);
    const hasActiveFilter = hasActiveColumnFilter(parsedColumnIndex, currentFilter, resultSet);

    if (hasActiveFilter) {
        filterBtn.classList.add('active');
        filterBtn.style.color = 'var(--vscode-charts-blue)';
        filterBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2h14l-5.5 6.5V14l-3 2v-7.5L1 2z"/></svg>';
        th.style.backgroundColor = 'var(--vscode-list-activeSelectionBackground)';
        th.style.borderBottom = '2px solid var(--vscode-charts-blue)';
    }

    filterBtn.onclick = (e) => {
        e.stopPropagation();
        showColumnFilterDropdown(header.column, table, filterBtn, rsIndex);
    };

    // Aggregation button
    const aggBtn = document.createElement('span');
    aggBtn.className = 'header-btn header-btn-agg';
    aggBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h3v12H2V2zm4.5 4h3v8h-3V6zM11 1h3v15h-3V1z"/></svg>';
    aggBtn.title = 'Aggregation';
    aggBtn.style.position = 'relative';

    const currentAggs = (getAggregationState(rsIndex, resultSet.executionTimestamp, getResultPanelWindow().activeSource) || {})[header.column.id];
    let aggCount = 0;
    if (currentAggs) {
        if (Array.isArray(currentAggs)) {
            aggCount = currentAggs.length;
        } else {
            aggCount = 1; // Old format - single value
        }
    }

    if (aggCount > 0) {
        aggBtn.classList.add('active');
        aggBtn.style.color = 'var(--vscode-charts-green)';

        if (aggCount > 1) {
            const badge = document.createElement('span');
            badge.textContent = String(aggCount);
            badge.style.position = 'absolute';
            badge.style.top = '-6px';
            badge.style.right = '-8px';
            badge.style.backgroundColor = 'var(--vscode-charts-green)';
            badge.style.color = 'var(--vscode-button-foreground)';
            badge.style.fontSize = '9px';
            badge.style.padding = '1px 3px';
            badge.style.borderRadius = '8px';
            badge.style.minWidth = '12px';
            badge.style.textAlign = 'center';
            badge.style.lineHeight = '1';
            aggBtn.appendChild(badge);
        }
    }

    aggBtn.onclick = (e) => {
        e.stopPropagation();
        showAggregationDropdown(header.column, table, aggBtn, rsIndex, resultSet.executionTimestamp);
    };

    const groupBtn = document.createElement('span');
    const currentGrouping = table.getState().grouping ?? [];
    const isGrouped = currentGrouping.includes(header.column.id);
    groupBtn.className = 'header-btn header-btn-group' + (isGrouped ? ' active' : '');
    groupBtn.textContent = '#';
    groupBtn.title = isGrouped ? 'Remove this column from grouping' : 'Group by this column';
    if (isGrouped) {
        groupBtn.style.color = 'var(--vscode-charts-purple)';
    }
    groupBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const grouping = table.getState().grouping ?? [];
        if (grouping.includes(header.column.id)) {
            table.setGrouping(grouping.filter((columnId) => columnId !== header.column.id));
        } else {
            table.setGrouping([...grouping, header.column.id]);
        }
        if (scheduleRender) {
            scheduleRender();
        }
    };

    // Pin column button
    const pinBtn = document.createElement('span');
    pinBtn.className = 'header-btn header-btn-pin';
    pinBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.708l-.8-.8-3.535 3.535c.268.59.408 1.236.408 1.9 0 .94-.28 1.87-.828 2.672l-.172.243a.5.5 0 0 1-.756.05L8.06 10.5l-2.12 2.122a.5.5 0 0 1-.708 0L4.1 11.657a.5.5 0 0 1 0-.708l2.122-2.12-2.122-2.122a.5.5 0 0 1 .05-.756l.243-.172A4.5 4.5 0 0 1 6.9 5.88c.664 0 1.31.14 1.9.408L12.343 2.75l-.8-.8a.5.5 0 0 1 .146-.354l.132.132zM6.076 7.39l-4.243 4.243a.5.5 0 0 0 .354.854h1.5v3.5a.5.5 0 0 0 .854.354l4.243-4.243a4.5 4.5 0 0 1-2.664-2.664z"/></svg>';
    pinBtn.title = 'Pin column';

    const currentPinned = getPinnedColumnsState(rsIndex, resultSet.executionTimestamp, getResultPanelWindow().activeSource);
    const isPinned = currentPinned.includes(header.column.id);
    if (isPinned) {
        pinBtn.classList.add('active');
        pinBtn.style.color = 'var(--vscode-charts-yellow)';
        pinBtn.title = 'Unpin column';
        th.classList.add('pinned-column');
    }

    pinBtn.onclick = (e) => {
        e.stopPropagation();
        const newPinnedState = togglePinnedColumn(rsIndex, header.column.id, resultSet.executionTimestamp, getResultPanelWindow().activeSource);
        const isNowPinned = newPinnedState.includes(header.column.id);

        if (isNowPinned) {
            pinBtn.classList.add('active');
            pinBtn.style.color = 'var(--vscode-charts-yellow)';
            pinBtn.title = 'Unpin column';
            th.classList.add('pinned-column');
        } else {
            pinBtn.classList.remove('active');
            pinBtn.style.color = '';
            pinBtn.title = 'Pin column';
            th.classList.remove('pinned-column');
        }

        reorderColumnsForPinning(table, rsIndex, resultSet.executionTimestamp);

        if (scheduleRender) {
            scheduleRender();
        }
    };

    const formatBtn = document.createElement('span');
    formatBtn.className = 'header-btn header-btn-format';
    formatBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 1a.5.5 0 0 1 .5.5V3h3v-.5a.5.5 0 0 1 1 0V3h1.5a.5.5 0 0 1 .5.5v3A3.5 3.5 0 0 1 9.5 13H8v1.5a.5.5 0 0 1-1 0V13H5.5A3.5 3.5 0 0 1 2 6.5v-3a.5.5 0 0 1 .5-.5H4V3.5a.5.5 0 0 1 1 0V3h1.5a.5.5 0 0 1 .5-.5zM3 6.5a2.5 2.5 0 0 1 2.5-2.5h5A2.5 2.5 0 0 1 13 6.5v3a2.5 2.5 0 0 1-2.5 2.5h-5A2.5 2.5 0 0 1 3 9.5v-3z"/></svg>';
    formatBtn.title = 'Format column';
    formatBtn.onclick = (e) => {
        e.stopPropagation();
        openResultFormattingPanel({
            scope: 'column',
            columnId: header.column.id,
            columnName: header.column.columnDef.header
        });
    };

    headerContent.appendChild(aggBtn);
    headerContent.appendChild(groupBtn);
    headerContent.appendChild(filterBtn);
    headerContent.appendChild(pinBtn);
    headerContent.appendChild(formatBtn);

    // Drag and drop handlers
    th.ondragstart = (e) => {
        const dataTransfer = e.dataTransfer;
        if (!dataTransfer) {
            return;
        }
        dataTransfer.setData('text/plain', header.column.columnDef.header);
        dataTransfer.setData('type', 'column');
        dataTransfer.setData('columnId', header.column.id);
        dataTransfer.setData('columnName', header.column.columnDef.header);
        dataTransfer.effectAllowed = 'copyMove';
        th.classList.add('dragging');
        setGlobalDragState({ isDragging: true, dragType: 'column', draggedItem: header.column.id });
    };

    th.ondragover = (e) => {
        e.preventDefault();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'move';
        }
        th.classList.add('drag-over');
    };

    th.ondragleave = () => {
        th.classList.remove('drag-over');
    };

    th.ondrop = (e) => {
        e.preventDefault();
        th.classList.remove('drag-over');
        handleHeaderDrop(e, header.column.id, table);
    };

    th.ondragend = () => {
        th.classList.remove('dragging');
        setGlobalDragState({ isDragging: false, dragType: null, draggedItem: null });
        if (typeof getResultPanelWindow().clearGroupDropTargets === 'function') {
            getResultPanelWindow().clearGroupDropTargets?.();
        }
    };

    th.appendChild(headerContent);

    // Resizer handle
    const resizer = createResizer(th, header, rsIndex);
    th.appendChild(resizer);

    return th;
}

function createResizer(th: HTMLTableCellElement, header: TanStackHeader, rsIndex: number): HTMLDivElement {
    const resizer = document.createElement('div');
    resizer.className = 'col-resizer';
    resizer.style.position = 'absolute';
    resizer.style.right = '0';
    resizer.style.top = '0';
    resizer.style.width = '5px';
    resizer.style.height = '100%';
    resizer.style.cursor = 'col-resize';
    resizer.style.userSelect = 'none';
    resizer.style.touchAction = 'none';
    resizer.style.zIndex = '5';

    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const grid = getGrid(rsIndex);
        const colId = header.column.id;
        const startX = e.clientX;
        const startWidth = (grid && grid.columnWidths && grid.columnWidths.get(colId)) || th.getBoundingClientRect().width;

        const onMouseMove = (moveEvent: MouseEvent) => {
            const currentX = moveEvent.clientX;
            const delta = currentX - startX;
            const newWidth = Math.max(50, startWidth + delta);

            if (grid && grid.columnWidths) {
                if (grid.manualColumnWidths) {
                    grid.manualColumnWidths.add(colId);
                }
                const oldWidth = grid.columnWidths.get(colId) || startWidth;
                grid.columnWidths.set(colId, newWidth);

                if (grid.tanTable) {
                    const visibleCols = grid.tanTable.getVisibleLeafColumns();
                    const colIndex = visibleCols.findIndex((c: { id: string }) => c.id === colId);
                    if (colIndex !== -1) {
                        const wrapper = document.querySelectorAll('.grid-wrapper')[rsIndex];
                        const colGroup = wrapper?.querySelector('colgroup');
                        const tableEl = wrapper?.querySelector('table');

                        if (colGroup && colGroup.children[colIndex + 1]) {
                            const colElement = colGroup.children[colIndex + 1] as HTMLElement;
                            colElement.style.width = newWidth + 'px';
                        }
                        th.style.width = newWidth + 'px';

                        if (tableEl) {
                            const currentTableWidth = parseFloat(tableEl.style.width) || 0;
                            const widthDelta = newWidth - oldWidth;
                            tableEl.style.width = (currentTableWidth + widthDelta) + 'px';
                        }
                    }
                }
            }
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            savePinnedState();
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    resizer.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const grid = getGrid(rsIndex);
        if (!grid || !grid.autoFitColumn) {
            return;
        }

        const didChange = grid.autoFitColumn(header.column.id);
        if (didChange && grid.render) {
            grid.render();
        }
        savePinnedState();
    });

    resizer.draggable = true;
    resizer.ondragstart = (e) => {
        e.preventDefault();
        e.stopPropagation();
    };

    return resizer;
}

function handleHeaderDrop(e: DragEvent, targetColId: string, table: TanStackTable): void {
    const type = e.dataTransfer?.getData('type');
    if (type === 'column') {
        const draggedColId = e.dataTransfer?.getData('columnId');

        if (draggedColId && draggedColId !== targetColId) {
            const th = e.currentTarget as HTMLTableCellElement;
            const rect = th.getBoundingClientRect();
            const midX = rect.left + rect.width / 2;
            const insertBefore = e.clientX < midX;
            reorderColumnByDrag(table, draggedColId, targetColId, insertBefore);
        }
    }
}

export function reorderColumnByDrag(
    table: TanStackTable,
    draggedColId: string,
    targetColId: string,
    insertBefore: boolean,
): boolean {
    if (!draggedColId || draggedColId === targetColId) {
        return false;
    }

    const currentOrder = table.getState().columnOrder || table.getAllColumns().map(col => col.id);
    const newOrder = [...currentOrder];
    const fromIndex = newOrder.indexOf(draggedColId);
    const targetIndex = newOrder.indexOf(targetColId);

    if (fromIndex === -1 || targetIndex === -1) {
        return false;
    }

    newOrder.splice(fromIndex, 1);

    let toIndex: number;
    if (insertBefore) {
        toIndex = targetIndex < fromIndex ? targetIndex : targetIndex - 1;
    } else {
        toIndex = targetIndex < fromIndex ? targetIndex + 1 : targetIndex;
    }

    newOrder.splice(toIndex, 0, draggedColId);
    table.setColumnOrder(newOrder);
    return true;
}

const diskDistinctRawByDisplay = new Map<string, unknown>();

function buildDiskDistinctSpecWithoutColumn(rsIndex: number, columnIndex: number) {
    const spec = buildDiskQuerySpecForResultSet(rsIndex);
    if (spec.columnFilters) {
        spec.columnFilters = spec.columnFilters.filter((filter) => filter.columnIndex !== columnIndex);
        if (spec.columnFilters.length === 0) {
            delete spec.columnFilters;
        }
    }
    return spec;
}

async function showDiskColumnFilterDropdown(
    column: TanStackColumn,
    anchorElement: HTMLElement,
    rsIndex: number,
    resultSet: ResultSet,
): Promise<void> {
    const columnIndex = Number.parseInt(column.id, 10);
    const dropdown = createDropdownContainer(anchorElement, column.columnDef.header);
    dropdown.innerHTML = '<div style="padding:12px;opacity:0.8;">Loading values…</div>';
    document.body.appendChild(dropdown);
    setupDropdownCloseHandlers(dropdown, anchorElement);

    const spec = buildDiskDistinctSpecWithoutColumn(rsIndex, columnIndex);
    const distinct = await queryDiskDistinctValues(rsIndex, columnIndex, spec);
    diskDistinctRawByDisplay.clear();

    const uniqueValues: string[] = [];
    const valueCounts = new Map<string, number>();
    for (const entry of distinct.values) {
        const display = entry.raw === null || entry.raw === undefined
            ? 'NULL'
            : (formatCellValue(entry.raw, column.columnDef.dataType, column.columnDef?.scale, {
                columnId: column.id,
                inferredNumericKind: column.columnDef?.inferredNumericKind,
                inferredDateInteger: column.columnDef?.inferredDateInteger,
            }) ?? String(entry.raw));
        uniqueValues.push(display);
        valueCounts.set(display, entry.count);
        diskDistinctRawByDisplay.set(display, entry.raw ?? null);
    }

    dropdown.innerHTML = '';
    const { valuesTab, conditionsTab, valuesContent, conditionsContent } = createTabs(dropdown);

    const diskScopeRow = document.createElement('div');
    diskScopeRow.className = 'filter-dropdown-selection-info';
    diskScopeRow.style.color = 'var(--vscode-descriptionForeground)';
    diskScopeRow.textContent = 'Filter scope: Full spilled dataset (disk-backed, local SQLite)';
    dropdown.insertBefore(diskScopeRow, dropdown.firstChild);

    const existingColumnFilter = resultSet.diskQuerySpec?.columnFilters
        ?.find((filter) => filter.columnIndex === columnIndex);

    const currentFilter = existingColumnFilter?.values
        ?.map((raw) => {
            if (raw === null || raw === undefined) {
                return 'NULL';
            }
            return formatCellValue(raw, column.columnDef.dataType, column.columnDef?.scale, {
                columnId: column.id,
                inferredNumericKind: column.columnDef?.inferredNumericKind,
                inferredDateInteger: column.columnDef?.inferredDateInteger,
            }) ?? String(raw);
        }) ?? undefined;

    const sortedUniqueValues = sortFilterValues(uniqueValues, column.columnDef.dataType);
    const isNumericColumn = detectNumericColumn(sortedUniqueValues);
    const { checkboxes, checkedValues, getFilteredValues, getSelectedCount } = createValuesTabContent(
        valuesContent,
        sortedUniqueValues,
        currentFilter,
        valueCounts,
        isNumericColumn,
        () => undefined,
        distinct.truncated,
    );

    const initialConditions: FilterCondition[] = (existingColumnFilter?.conditions ?? []).map((entry) => ({
        type: entry.type,
        value: entry.value ?? '',
        value2: entry.value2 ?? '',
    }));
    const conditionSeed: ColumnFilterValue = initialConditions.length > 0
        ? {
            _isConditionFilter: true,
            conditions: initialConditions,
            logic: existingColumnFilter?.conditionLogic ?? 'and',
        }
        : undefined;
    const { conditions, logicOperator } = createConditionsTabContent(
        conditionsContent,
        isNumericColumn,
        conditionSeed,
    );

    const switchTab = (tabName: 'values' | 'conditions') => {
        [valuesTab, conditionsTab].forEach((tab) => tab.classList.remove('active'));
        [valuesContent, conditionsContent].forEach((content) => content.classList.remove('active'));

        if (tabName === 'values') {
            valuesTab.classList.add('active');
            valuesContent.classList.add('active');
        } else {
            conditionsTab.classList.add('active');
            conditionsContent.classList.add('active');
        }
    };
    valuesTab.onclick = () => switchTab('values');
    conditionsTab.onclick = () => switchTab('conditions');

    const selectionInfo = document.createElement('div');
    selectionInfo.className = 'filter-dropdown-selection-info';
    const updateSelectionInfo = () => {
        const selected = getSelectedCount();
        const total = uniqueValues.length;
        selectionInfo.classList.remove('filter-selection-warning', 'filter-selection-muted');
        if (selected === 0) {
            selectionInfo.textContent = 'No values selected — Apply will remove the filter';
            selectionInfo.classList.add('filter-selection-warning');
        } else if (selected === total) {
            selectionInfo.textContent = `All ${total.toLocaleString()} values selected — no filtering`;
            selectionInfo.classList.add('filter-selection-muted');
        } else {
            selectionInfo.textContent = `${selected.toLocaleString()} of ${total.toLocaleString()} selected — click Apply`;
        }
    };
    checkboxes.forEach((cb) => cb.addEventListener('change', updateSelectionInfo));

    const hasActiveDiskFilter = hasActiveColumnFilter(columnIndex, undefined, resultSet);

    const removeDiskColumnFilter = () => {
        setDiskColumnFilterValues(rsIndex, columnIndex, []);
        setDiskColumnFilterConditions(rsIndex, columnIndex, [], 'and');
        dropdown.remove();
    };

    const { container: actionsContainer } = createFilterActionButtons(() => {
        const activeTab = valuesTab.classList.contains('active') ? 'values' : 'conditions';
        if (activeTab === 'values') {
            const filteredValues = getFilteredValues();
            const selectedValues = filteredValues.filter((val) => {
                const checkbox = checkboxes.get(val);
                return Boolean(checkbox?.checked);
            });
            const rawValues = selectedValues.map((display) => diskDistinctRawByDisplay.get(display) ?? display);
            if (selectedValues.length === uniqueValues.length || selectedValues.length === 0) {
                setDiskColumnFilterValues(rsIndex, columnIndex, []);
            } else {
                setDiskColumnFilterValues(rsIndex, columnIndex, rawValues);
            }
        } else {
            const validConditions = conditions.filter((entry) => {
                if (['isEmpty', 'isNotEmpty'].includes(entry.type)) {
                    return true;
                }
                if (entry.type === 'between') {
                    return entry.value !== '' && entry.value2 !== '';
                }
                return entry.value !== '';
            });
            if (validConditions.length === 0) {
                setDiskColumnFilterConditions(rsIndex, columnIndex, [], logicOperator);
            } else {
                setDiskColumnFilterConditions(
                    rsIndex,
                    columnIndex,
                    validConditions.map((entry) => ({
                        type: entry.type,
                        value: entry.value,
                        value2: entry.value2,
                    })),
                    logicOperator,
                );
            }
        }
        dropdown.remove();
    }, () => {
        dropdown.remove();
    }, {
        showRemoveFilter: hasActiveDiskFilter,
        onRemoveFilter: removeDiskColumnFilter,
    });

    if (hasActiveDiskFilter) {
        const banner = createFilterActiveBanner(removeDiskColumnFilter);
        dropdown.insertBefore(banner, dropdown.firstChild);
    }

    dropdown.appendChild(selectionInfo);
    dropdown.appendChild(actionsContainer);
    updateSelectionInfo();
    switchTab('values');
}

export function showColumnFilterDropdown(
    column: TanStackColumn,
    table: TanStackTable,
    anchorElement: HTMLElement,
    rsIndex: number
): void {
    const existingDropdown = document.querySelector('.column-filter-dropdown');
    if (existingDropdown) existingDropdown.remove();
    const existingAgg = document.querySelector('.column-aggregation-dropdown');
    if (existingAgg) existingAgg.remove();

    const panelWindow = getResultPanelWindow();
    const resultSet = panelWindow.resultSets ? panelWindow.resultSets[rsIndex] : null;
    if (resultSet?.storageMode === 'sqlite') {
        void showDiskColumnFilterDropdown(column, anchorElement, rsIndex, resultSet);
        return;
    }
    const directSql = resultSet?.refreshSql || resultSet?.sql || '';

    let { uniqueValues, valueCounts, uniqueValuesTruncated } = calculateFilterValuesAndCounts(column, table);
    let currentFilter = column.getFilterValue();
    const columnIndex = Number.parseInt(column.id, 10);
    const sourceUri = getActiveSourceUri();
    const canDatabaseFilter = Boolean(
        sourceUri
        && directSql
        && findTrailingLimitValue(directSql)
    );
    let filterMode: 'fetched' | 'database' = resultSet?.databaseFilterSpec ? 'database' : 'fetched';
    if (!canDatabaseFilter) {
        filterMode = 'fetched';
    }
    const dbRawByDisplay = new Map<string, unknown>();

    const existingDatabaseColumnFilter = resultSet?.databaseFilterSpec?.columnFilters
        ?.find((filter) => filter.columnIndex === columnIndex);
    if (filterMode === 'database' && existingDatabaseColumnFilter) {
        if (existingDatabaseColumnFilter.conditions) {
            currentFilter = {
                _isConditionFilter: true,
                conditions: existingDatabaseColumnFilter.conditions,
                logic: existingDatabaseColumnFilter.conditionLogic ?? 'and',
            };
        } else if (existingDatabaseColumnFilter.values) {
            currentFilter = existingDatabaseColumnFilter.values.map((raw) => raw === null || raw === undefined
                ? 'NULL'
                : (formatCellValue(raw, column.columnDef.dataType, column.columnDef?.scale, {
                    columnId: column.id,
                    inferredNumericKind: column.columnDef?.inferredNumericKind,
                    inferredDateInteger: column.columnDef?.inferredDateInteger,
                }) ?? String(raw)));
        }
    }

    let isNumericColumn = detectNumericColumn(uniqueValues);

    const dropdown = createDropdownContainer(anchorElement, column.columnDef.header);
    const { valuesTab, conditionsTab, valuesContent, conditionsContent } = createTabs(dropdown);
    const modeRow = document.createElement('div');
    modeRow.className = 'filter-dropdown-selection-info';
    modeRow.style.display = canDatabaseFilter ? 'flex' : 'none';
    modeRow.style.gap = '6px';
    modeRow.style.alignItems = 'center';

    const modeLabel = document.createElement('span');
    modeLabel.textContent = 'Filter scope:';
    modeLabel.style.color = 'var(--vscode-descriptionForeground)';
    const fetchedBtn = document.createElement('button');
    fetchedBtn.type = 'button';
    fetchedBtn.className = 'filter-btn';
    fetchedBtn.textContent = 'Loaded rows';
    fetchedBtn.title = 'Filter rows already loaded in the grid (no database round-trip).';
    const databaseBtn = document.createElement('button');
    databaseBtn.type = 'button';
    databaseBtn.className = 'filter-btn';
    databaseBtn.textContent = 'All rows + LIMIT';
    databaseBtn.title = 'Run this filter on the database by wrapping the original SQL without LIMIT, then applying the original LIMIT again.';
    modeRow.appendChild(modeLabel);
    modeRow.appendChild(fetchedBtn);
    modeRow.appendChild(databaseBtn);

    const originalFilter = currentFilter ? JSON.parse(JSON.stringify(currentFilter)) as ColumnFilterValue : undefined;
    let searchFilterApplied = false;

    function applySearchFilter(searchTerm: string): void {
        if (!searchTerm || searchTerm.trim() === '') {
            if (searchFilterApplied) {
                column.setFilterValue(originalFilter);
                searchFilterApplied = false;
            }
        } else {
            let type = 'contains';
            let value = searchTerm;
            let value2: string | undefined = undefined;
            
            const termStr = searchTerm.trim();
            const upperTerm = termStr.toUpperCase();
            
            if (termStr.startsWith('>=')) {
                type = 'greaterThanOrEqual';
                value = termStr.substring(2).trim();
            } else if (termStr.startsWith('>')) {
                type = 'greaterThan';
                value = termStr.substring(1).trim();
            } else if (termStr.startsWith('<=')) {
                type = 'lessThanOrEqual';
                value = termStr.substring(2).trim();
            } else if (termStr.startsWith('<')) {
                type = 'lessThan';
                value = termStr.substring(1).trim();
            } else if (termStr.startsWith('=')) {
                type = 'equals';
                value = termStr.substring(1).trim();
            } else if (termStr.startsWith('!=') || termStr.startsWith('<>')) {
                type = 'notEquals';
                value = termStr.startsWith('!=') ? termStr.substring(2).trim() : termStr.substring(2).trim();
            } else if (upperTerm.startsWith('BETWEEN ')) {
                const parts = termStr.substring(8).split(/\s+AND\s+/i);
                if (parts.length === 2) {
                    type = 'between';
                    value = parts[0].trim();
                    value2 = parts[1].trim();
                }
            } else if (upperTerm.startsWith('LIKE ')) {
                type = 'like';
                value = termStr.substring(5).trim();
                if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
                    value = value.substring(1, value.length - 1);
                }
            }

            if (type !== 'contains' && (value === '' || (type === 'between' && value2 === ''))) {
                type = 'contains';
                value = searchTerm;
                value2 = undefined;
            }

            const conditionFilter: ConditionColumnFilter = {
                _isConditionFilter: true,
                conditions: [{
                    type: type,
                    value: value,
                    value2: value2
                }],
                logic: 'and'
            };
            column.setFilterValue(conditionFilter);
            searchFilterApplied = true;
        }
    }

    function clearSearchFilter() {
        if (searchFilterApplied) {
            column.setFilterValue(originalFilter);
            searchFilterApplied = false;
        }
    }

    function getValuesTabSearchHandler(): ((searchTerm: string) => void) | undefined {
        return filterMode === 'database' ? undefined : applySearchFilter;
    }

    const selectionInfo = document.createElement('div');
    selectionInfo.className = 'filter-dropdown-selection-info';

    function updateSelectionInfo(): void {
        const selected = valuesUi.getSelectedCount();
        const total = valuesUi.getTotalCount();
        selectionInfo.classList.remove('filter-selection-warning', 'filter-selection-muted');
        if (selected === 0) {
            selectionInfo.textContent = 'No values selected — Apply will remove the filter';
            selectionInfo.classList.add('filter-selection-warning');
        } else if (selected === total) {
            selectionInfo.textContent = `All ${total.toLocaleString()} values selected — no filtering`;
            selectionInfo.classList.add('filter-selection-muted');
        } else {
            selectionInfo.textContent = `${selected.toLocaleString()} of ${total.toLocaleString()} selected — click Apply`;
        }
    }

    let valuesUi = createValuesTabContent(
        valuesContent,
        uniqueValues,
        currentFilter,
        valueCounts,
        isNumericColumn,
        getValuesTabSearchHandler(),
        uniqueValuesTruncated,
        filterMode !== 'database' || Boolean(existingDatabaseColumnFilter),
        updateSelectionInfo,
    );

    // Conditions tab content
    const { conditions, logicOperator } = createConditionsTabContent(
        conditionsContent, isNumericColumn, currentFilter
    );

    function updateModeButtons(): void {
        fetchedBtn.classList.toggle('primary', filterMode === 'fetched');
        databaseBtn.classList.toggle('primary', filterMode === 'database');
    }

    function renderValuesContent(nextCurrentFilter: ColumnFilterValue = currentFilter): void {
        valuesContent.innerHTML = '';
        valuesUi = createValuesTabContent(
            valuesContent,
            uniqueValues,
            nextCurrentFilter,
            valueCounts,
            isNumericColumn,
            getValuesTabSearchHandler(),
            uniqueValuesTruncated,
            filterMode !== 'database' || Boolean(existingDatabaseColumnFilter),
            updateSelectionInfo,
        );
        updateSelectionInfo();
    }

    function buildFilterFromUi(): DiskColumnFilterSpec | undefined {
        const activeTab = valuesTab.classList.contains('active') ? 'values' : 'conditions';
        if (activeTab === 'values') {
            const filteredValues = valuesUi.getFilteredValues ? valuesUi.getFilteredValues() : [...uniqueValues];
            const selectedValues = filteredValues.filter(val => {
                const checkbox = valuesUi.checkboxes.get(val);
                return Boolean(checkbox?.checked);
            });
            if (selectedValues.length === uniqueValues.length || selectedValues.length === 0) {
                return undefined;
            }
            const rawValues = selectedValues.map((display) => {
                if (filterMode === 'database' && dbRawByDisplay.has(display)) {
                    return dbRawByDisplay.get(display) ?? null;
                }
                return display === 'NULL' ? null : display;
            });
            return { columnIndex, values: rawValues };
        }

        const validConditions = conditions.filter(c => {
            if (['isEmpty', 'isNotEmpty'].includes(c.type)) return true;
            if (c.type === 'between') return c.value !== '' && c.value2 !== '';
            return c.value !== '';
        });
        return validConditions.length > 0
            ? {
                columnIndex,
                conditions: validConditions.map((entry) => ({
                    type: entry.type,
                    value: entry.value,
                    value2: entry.value2,
                })),
                conditionLogic: logicOperator,
            }
            : undefined;
    }

    function buildDatabaseFilterSpecFromUi(): DiskQuerySpec | undefined {
        const existing = resultSet?.databaseFilterSpec ?? {};
        const filters = [...(existing.columnFilters ?? [])].filter((filter) => filter.columnIndex !== columnIndex);
        const filter = buildFilterFromUi();
        if (filter) {
            filters.push(filter);
        }
        const spec: DiskQuerySpec = {
            globalSearch: existing.globalSearch,
            columnFilters: filters.length > 0 ? filters : undefined,
            sorting: existing.sorting,
        };
        return (spec.columnFilters?.length ?? 0) > 0 || Boolean(spec.globalSearch?.trim())
            ? spec
            : undefined;
    }

    let databaseValuesLoading = false;
    let applyBtn: HTMLButtonElement | undefined;
    let closeBtn: HTMLButtonElement | undefined;
    let removeFilterBtn: HTMLButtonElement | undefined;

    function setDatabaseValuesLoading(loading: boolean): void {
        databaseValuesLoading = loading;
        if (applyBtn) {
            applyBtn.disabled = loading;
        }
        if (closeBtn) {
            closeBtn.disabled = loading;
        }
        if (removeFilterBtn) {
            removeFilterBtn.disabled = loading;
        }
    }

    async function loadDatabaseValues(isRetry = false): Promise<void> {
        if (!sourceUri || !canDatabaseFilter) {
            return;
        }
        setDatabaseValuesLoading(true);
        valuesContent.innerHTML = '<div style="padding:12px;opacity:0.8;">Loading database values...</div>';
        try {
            const result = await queryDatabaseFilterValues(
                sourceUri,
                rsIndex,
                columnIndex,
                resultSet?.databaseFilterSpec,
                isRetry ? { isRetry: true } : undefined,
            );
            dbRawByDisplay.clear();
            uniqueValues = [];
            valueCounts = new Map<string, number>();
            for (const entry of result.values) {
                const display = entry.raw === null || entry.raw === undefined
                    ? 'NULL'
                    : (formatCellValue(entry.raw, column.columnDef.dataType, column.columnDef?.scale, {
                        columnId: column.id,
                        inferredNumericKind: column.columnDef?.inferredNumericKind,
                        inferredDateInteger: column.columnDef?.inferredDateInteger,
                    }) ?? String(entry.raw));
                uniqueValues.push(display);
                valueCounts.set(display, entry.count);
                dbRawByDisplay.set(display, entry.raw ?? null);
            }
            uniqueValues = sortFilterValues(uniqueValues, column.columnDef.dataType);
            uniqueValuesTruncated = result.truncated;
            isNumericColumn = detectNumericColumn(uniqueValues);
            renderValuesContent(currentFilter);
        } catch (error) {
            showInlineErrorWithRetry(valuesContent, error, () => {
                void loadDatabaseValues(true);
            });
        } finally {
            setDatabaseValuesLoading(false);
        }
    }

    fetchedBtn.onclick = () => {
        filterMode = 'fetched';
        dbRawByDisplay.clear();
        const recalculated = calculateFilterValuesAndCounts(column, table);
        uniqueValues = recalculated.uniqueValues;
        valueCounts = recalculated.valueCounts;
        uniqueValuesTruncated = recalculated.uniqueValuesTruncated;
        currentFilter = column.getFilterValue();
        isNumericColumn = detectNumericColumn(uniqueValues);
        updateModeButtons();
        renderValuesContent(currentFilter);
    };

    databaseBtn.onclick = () => {
        filterMode = 'database';
        updateModeButtons();
        if (existingDatabaseColumnFilter?.values) {
            currentFilter = existingDatabaseColumnFilter.values.map((raw) => raw === null || raw === undefined
                ? 'NULL'
                : (formatCellValue(raw, column.columnDef.dataType, column.columnDef?.scale, {
                    columnId: column.id,
                    inferredNumericKind: column.columnDef?.inferredNumericKind,
                    inferredDateInteger: column.columnDef?.inferredDateInteger,
                }) ?? String(raw)));
        } else if (existingDatabaseColumnFilter?.conditions) {
            currentFilter = {
                _isConditionFilter: true,
                conditions: existingDatabaseColumnFilter.conditions,
                logic: existingDatabaseColumnFilter.conditionLogic ?? 'and',
            };
        } else {
            currentFilter = undefined;
        }
        void loadDatabaseValues();
    };

    // Tab switching
    const switchTab = (tabName: 'values' | 'conditions') => {
        [valuesTab, conditionsTab].forEach(t => t.classList.remove('active'));
        [valuesContent, conditionsContent].forEach(c => c.classList.remove('active'));

        if (tabName === 'values') {
            valuesTab.classList.add('active');
            valuesContent.classList.add('active');
        } else {
            conditionsTab.classList.add('active');
            conditionsContent.classList.add('active');
        }
    };

    valuesTab.onclick = () => switchTab('values');
    conditionsTab.onclick = () => switchTab('conditions');

    // Action buttons
    const applyErrorBanner = document.createElement('div');
    applyErrorBanner.style.display = 'none';

    async function runDatabaseApply(
        spec: DiskQuerySpec | undefined,
        isRetry = false,
    ): Promise<void> {
        if (!sourceUri || !canDatabaseFilter || databaseValuesLoading) {
            return;
        }
        applyErrorBanner.style.display = 'none';
        applyErrorBanner.replaceChildren();
        if (applyBtn) {
            applyBtn.disabled = true;
        }
        if (closeBtn) {
            closeBtn.disabled = true;
        }
        if (removeFilterBtn) {
            removeFilterBtn.disabled = true;
        }
        const previousApplyText = applyBtn?.textContent;
        if (applyBtn) {
            applyBtn.textContent = 'Applying...';
        }
        try {
            await applyDatabaseFilter(
                sourceUri,
                rsIndex,
                spec,
                isRetry ? { isRetry: true } : undefined,
            );
            dropdown.remove();
        } catch (error) {
            showInlineErrorWithRetry(applyErrorBanner, error, () => {
                void runDatabaseApply(spec, true);
            });
            applyErrorBanner.style.display = 'block';
        } finally {
            if (applyBtn) {
                applyBtn.disabled = false;
                applyBtn.textContent = previousApplyText ?? 'Apply';
            }
            if (closeBtn) {
                closeBtn.disabled = false;
            }
            if (removeFilterBtn) {
                removeFilterBtn.disabled = false;
            }
        }
    }

    const hasActiveFilter = resultSet
        ? hasActiveColumnFilter(columnIndex, currentFilter, resultSet)
        : false;

    const removeColumnFilter = () => {
        clearSearchFilter();
        if (filterMode === 'database' && canDatabaseFilter && sourceUri) {
            const existing = resultSet?.databaseFilterSpec ?? {};
            const filters = [...(existing.columnFilters ?? [])].filter((filter) => filter.columnIndex !== columnIndex);
            const spec = filters.length > 0 ? { ...existing, columnFilters: filters } : undefined;
            void runDatabaseApply(spec);
            return;
        }
        column.setFilterValue(undefined);
        const grid = getGrid(rsIndex);
        if (grid?.render) {
            grid.render();
        }
        dropdown.remove();
    };

    const actionButtons = createFilterActionButtons(() => {
        if (filterMode === 'database' && canDatabaseFilter && sourceUri) {
            if (databaseValuesLoading) {
                return;
            }
            void runDatabaseApply(buildDatabaseFilterSpecFromUi());
            return;
        }
        applyFilter(column, valuesUi.checkboxes, uniqueValues, conditions, logicOperator, valuesTab, valuesUi.getFilteredValues);
        dropdown.remove();
    }, () => {
        clearSearchFilter();
        dropdown.remove();
    }, {
        showRemoveFilter: hasActiveFilter,
        onRemoveFilter: removeColumnFilter,
    });
    const actionsContainer = actionButtons.container;
    applyBtn = actionButtons.applyBtn;
    closeBtn = actionButtons.closeBtn;
    removeFilterBtn = actionButtons.removeFilterBtn;

    // valuesContent i conditionsContent są już w contentWrapper (dodane w createTabs)
    // Dodajemy tylko selectionInfo i actionsContainer na dole
    if (hasActiveFilter) {
        const banner = createFilterActiveBanner(removeColumnFilter);
        dropdown.insertBefore(banner, dropdown.firstChild);
    }
    dropdown.appendChild(modeRow);
    dropdown.appendChild(selectionInfo);
    dropdown.appendChild(applyErrorBanner);
    dropdown.appendChild(actionsContainer);

    document.body.appendChild(dropdown);

    // Initialize selection info
    updateSelectionInfo();
    updateModeButtons();
    if (filterMode === 'database') {
        void loadDatabaseValues();
    }

    // Auto-switch to Conditions tab if there's an existing condition filter
    if (currentFilter && isConditionColumnFilter(currentFilter)) {
        switchTab('conditions');
    }

    // Focus search box
    setTimeout(() => {
        if (valuesTab.classList.contains('active')) {
            const searchBox = dropdown.querySelector('.filter-search-input') as HTMLInputElement | null;
            if (searchBox) searchBox.focus();
        }
    }, 50);

    setupDropdownCloseHandlers(dropdown, anchorElement);
}

function getRowsForFilterDropdown(column: TanStackColumn, table: TanStackTable): TanStackRow[] {
    const allRows = table.getCoreRowModel().rows;
    const tableState = table.getState ? table.getState() : {};
    const columnFilters = tableState.columnFilters || [];
    const otherColumnFilters = columnFilters.filter(filter => filter.id !== column.id);
    const globalFilter = tableState.globalFilter;
    const globalFilterFn = table.options && typeof table.options.globalFilterFn === 'function'
        ? table.options.globalFilterFn
        : null;

    return allRows.filter(row => {
        if (globalFilterFn && globalFilter !== undefined && globalFilter !== null && globalFilter !== '') {
            if (!globalFilterFn(row, column.id, globalFilter)) {
                return false;
            }
        }

        return otherColumnFilters.every(filter => {
            const filterColumn = table.getColumn(filter.id);
            const filterFn = filterColumn && filterColumn.columnDef ? filterColumn.columnDef.filterFn : null;
            if (typeof filterFn !== 'function') {
                return true;
            }
            return filterFn(row, filter.id, filter.value);
        });
    });
}

function calculateFilterValuesAndCounts(column: TanStackColumn, table: TanStackTable): {
    uniqueValues: string[];
    valueCounts: Map<string, number>;
    uniqueValuesTruncated: boolean;
} {
    const valueCounts = new Map();
    const filteredRows = getRowsForFilterDropdown(column, table);
    const dataType = column.columnDef.dataType;
    let uniqueValuesTruncated = false;

    const formatFilterValue = (cellValue: unknown): string => {
        if (cellValue === null || cellValue === undefined) {
            return 'NULL';
        }
        return formatCellValue(cellValue, dataType, column.columnDef?.scale, {
            columnId: column.id,
            inferredNumericKind: column.columnDef?.inferredNumericKind,
            inferredDateInteger: column.columnDef?.inferredDateInteger
        }) ?? 'NULL';
    };

    for (let rowIndex = 0; rowIndex < filteredRows.length; rowIndex++) {
        const row = filteredRows[rowIndex];
        const stringValue = formatFilterValue(column.columnDef.accessorFn?.(row.original));

        if (!valueCounts.has(stringValue) && valueCounts.size >= FILTER_MAX_UNIQUE_VALUES) {
            uniqueValuesTruncated = true;
            break;
        }

        valueCounts.set(stringValue, (valueCounts.get(stringValue) || 0) + 1);
    }

    if (uniqueValuesTruncated) {
        const listedValues = new Set(valueCounts.keys());
        for (const listedValue of listedValues) {
            valueCounts.set(listedValue, 0);
        }

        for (let rowIndex = 0; rowIndex < filteredRows.length; rowIndex++) {
            const row = filteredRows[rowIndex];
            const stringValue = formatFilterValue(column.columnDef.accessorFn?.(row.original));
            if (listedValues.has(stringValue)) {
                valueCounts.set(stringValue, (valueCounts.get(stringValue) || 0) + 1);
            }
        }
    }

    const uniqueValues = sortFilterValues(Array.from(valueCounts.keys()), dataType);
    return { uniqueValues, valueCounts, uniqueValuesTruncated };
}

function detectNumericColumn(uniqueValues: string[]): boolean {
    return uniqueValues.some(v => parseFilterNumericValue(v) !== null);
}

function createDropdownContainer(anchorElement: HTMLElement, _columnHeader: string): HTMLDivElement {
    const dropdown = document.createElement('div');
    dropdown.className = 'column-filter-dropdown';
    dropdown.style.position = 'fixed';
    dropdown.style.zIndex = '10000';
    dropdown.style.width = '320px';
    dropdown.style.display = 'flex';
    dropdown.style.flexDirection = 'column';
    dropdown.style.overflow = 'hidden';

    const rect = anchorElement.getBoundingClientRect();
    const viewportMargin = 10;
    const anchorGap = 5;
    const desiredHeight = 400;
    const absoluteMinHeight = 280; // Absolute minimum to keep filter usable

    let left = rect.left;
    if (left + 320 > window.innerWidth - viewportMargin) {
        left = window.innerWidth - 320 - viewportMargin;
    }
    left = Math.max(viewportMargin, left);

    const availableHeightBelow = Math.max(0, window.innerHeight - rect.bottom - viewportMargin - anchorGap);
    const availableHeightAbove = Math.max(0, rect.top - viewportMargin - anchorGap);

    // Use whichever side has more space
    let isPositionedAbove = availableHeightAbove > availableHeightBelow;
    let availableHeight = isPositionedAbove ? availableHeightAbove : availableHeightBelow;

    // If neither side has enough space, use maximum available viewport height
    const maxViewportHeight = window.innerHeight - viewportMargin * 2;
    if (availableHeight < absoluteMinHeight) {
        // Not enough space - use full viewport height
        availableHeight = maxViewportHeight;
    }

    // Final height: prefer desiredHeight, but at least absoluteMinHeight, capped at available
    const dropdownHeight = Math.max(absoluteMinHeight, Math.min(desiredHeight, availableHeight));

    // Position: try preferred side, but clamp to viewport
    let top;
    if (isPositionedAbove && availableHeightAbove >= absoluteMinHeight) {
        top = rect.top - dropdownHeight - anchorGap;
    } else if (!isPositionedAbove && availableHeightBelow >= absoluteMinHeight) {
        top = rect.bottom + anchorGap;
    } else {
        // Neither side has enough - center in viewport
        top = Math.max(viewportMargin, (window.innerHeight - dropdownHeight) / 2);
    }
    // Ensure within viewport bounds
    top = Math.max(viewportMargin, Math.min(top, window.innerHeight - dropdownHeight - viewportMargin));

    dropdown.style.top = top + 'px';
    dropdown.style.left = left + 'px';
    dropdown.style.height = dropdownHeight + 'px';
    dropdown.style.minHeight = absoluteMinHeight + 'px';
    dropdown.style.maxHeight = dropdownHeight + 'px';

    return dropdown;
}

function createTabs(dropdown: HTMLDivElement): {
    valuesTab: HTMLButtonElement;
    conditionsTab: HTMLButtonElement;
    valuesContent: HTMLDivElement;
    conditionsContent: HTMLDivElement;
    contentWrapper: HTMLDivElement;
} {
    const tabsContainer = document.createElement('div');
    tabsContainer.className = 'filter-tabs';

    const valuesTab = document.createElement('button');
    valuesTab.className = 'filter-tab active';
    valuesTab.textContent = '📋 Values';
    valuesTab.dataset.tab = 'values';

    const conditionsTab = document.createElement('button');
    conditionsTab.className = 'filter-tab';
    conditionsTab.textContent = '🔧 Conditions';
    conditionsTab.dataset.tab = 'conditions';

    tabsContainer.appendChild(valuesTab);
    tabsContainer.appendChild(conditionsTab);
    dropdown.appendChild(tabsContainer);

    // Wrapper for scrollable content
    const contentWrapper = document.createElement('div');
    contentWrapper.style.flex = '1';
    contentWrapper.style.overflowY = 'auto';
    contentWrapper.style.minHeight = '0';
    contentWrapper.style.position = 'relative';
    dropdown.appendChild(contentWrapper);

    const valuesContent = document.createElement('div');
    valuesContent.className = 'filter-tab-content active';
    valuesContent.dataset.tabContent = 'values';

    const conditionsContent = document.createElement('div');
    conditionsContent.className = 'filter-tab-content';
    conditionsContent.dataset.tabContent = 'conditions';

    contentWrapper.appendChild(valuesContent);
    contentWrapper.appendChild(conditionsContent);

    return { valuesTab, conditionsTab, valuesContent, conditionsContent, contentWrapper };
}

function createValuesTabContent(
    valuesContent: HTMLDivElement,
    uniqueValues: string[],
    currentFilter: ColumnFilterValue,
    valueCounts: Map<string, number>,
    isNumericColumn: boolean,
    onSearchChange: ((searchTerm: string) => void) | undefined,
    uniqueValuesTruncated = false,
    defaultSelectAll = true,
    onSelectionChange?: () => void,
): {
    checkboxes: Map<string, HTMLInputElement>;
    checkedValues: Set<string>;
    renderValuesList: () => void;
    getFilteredValues: () => string[];
    getSelectedCount: () => number;
    getTotalCount: () => number;
} {
    // Quick filter buttons
    const quickFilters = document.createElement('div');
    quickFilters.className = 'quick-filters';

    const blanksBtn = document.createElement('button');
    blanksBtn.className = 'quick-filter-btn';
    blanksBtn.textContent = 'Blanks';
    quickFilters.appendChild(blanksBtn);

    const nonBlanksBtn = document.createElement('button');
    nonBlanksBtn.className = 'quick-filter-btn';
    nonBlanksBtn.textContent = 'Non-blanks';
    quickFilters.appendChild(nonBlanksBtn);

    if (isNumericColumn) {
        const top10Btn = document.createElement('button');
        top10Btn.className = 'quick-filter-btn';
        top10Btn.textContent = 'Top 10';
        quickFilters.appendChild(top10Btn);

        const bottom10Btn = document.createElement('button');
        bottom10Btn.className = 'quick-filter-btn';
        bottom10Btn.textContent = 'Bottom 10';
        quickFilters.appendChild(bottom10Btn);
    }

    valuesContent.appendChild(quickFilters);

    if (uniqueValuesTruncated) {
        const truncationNotice = document.createElement('div');
        truncationNotice.className = 'filter-truncation-notice';
        truncationNotice.style.padding = '6px 8px';
        truncationNotice.style.fontSize = '12px';
        truncationNotice.style.opacity = '0.85';
        truncationNotice.textContent =
            `Showing the first ${FILTER_MAX_UNIQUE_VALUES.toLocaleString()} distinct values. ` +
            'Use search or condition filters for high-cardinality columns.';
        valuesContent.appendChild(truncationNotice);
    }

    // Search box
    const searchWrapper = document.createElement('div');
    searchWrapper.className = 'filter-search-wrapper';

    const searchIcon = document.createElement('span');
    searchIcon.className = 'filter-search-icon';
    searchIcon.textContent = '🔍';

    const searchBox = document.createElement('input');
    searchBox.type = 'text';
    searchBox.placeholder = 'Search values...';
    searchBox.className = 'filter-search-input';

    searchWrapper.appendChild(searchIcon);
    searchWrapper.appendChild(searchBox);
    valuesContent.appendChild(searchWrapper);

    // Selection buttons
    const selectionButtons = document.createElement('div');
    selectionButtons.className = 'filter-selection-buttons';

    const selectAllBtn = document.createElement('button');
    selectAllBtn.className = 'filter-selection-btn';
    selectAllBtn.textContent = 'Select all';
    selectAllBtn.title = 'Check all visible values';

    const clearAllBtn = document.createElement('button');
    clearAllBtn.className = 'filter-selection-btn';
    clearAllBtn.textContent = 'Deselect all';
    clearAllBtn.title = 'Uncheck all visible values. Click Apply to update the filter.';

    const invertBtn = document.createElement('button');
    invertBtn.className = 'filter-selection-btn';
    invertBtn.textContent = 'Invert';
    invertBtn.title = 'Invert the checked state of visible values';

    selectionButtons.appendChild(selectAllBtn);
    selectionButtons.appendChild(clearAllBtn);
    selectionButtons.appendChild(invertBtn);
    valuesContent.appendChild(selectionButtons);

    // Values list
    const valuesContainer = document.createElement('div');
    valuesContainer.className = 'filter-values-container';

    let checkedValues = new Set<string>();
    if (currentFilter && Array.isArray(currentFilter) && currentFilter.length > 0) {
        currentFilter.forEach(v => checkedValues.add(v));
    } else if (defaultSelectAll) {
        uniqueValues.forEach(v => checkedValues.add(v));
    }

    let filteredValues = [...uniqueValues];
    const checkboxes = new Map<string, HTMLInputElement>();

    const notifySelectionChange = (): void => {
        onSelectionChange?.();
    };

    const setValueChecked = (value: string, checked: boolean): void => {
        if (checked) {
            checkedValues.add(value);
        } else {
            checkedValues.delete(value);
        }
    };

    function renderValuesList() {
        valuesContainer.innerHTML = '';
        filteredValues.forEach(value => {
            const item = document.createElement('div');
            item.className = 'filter-value-item';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = checkedValues.has(value);
            checkbox.onchange = () => {
                setValueChecked(value, checkbox.checked);
                notifySelectionChange();
            };

            const label = document.createElement('span');
            label.className = 'filter-value-label';
            label.textContent = value;
            label.title = value;

            const count = document.createElement('span');
            count.className = 'filter-value-count';
            count.textContent = String(valueCounts.get(value) || 0);

            item.onclick = (e) => {
                if (e.target !== checkbox) {
                    checkbox.checked = !checkbox.checked;
                    checkbox.dispatchEvent(new Event('change'));
                }
            };

            item.appendChild(checkbox);
            item.appendChild(label);
            item.appendChild(count);
            valuesContainer.appendChild(item);

            checkboxes.set(value, checkbox);
        });
    }

    renderValuesList();
    valuesContent.appendChild(valuesContainer);

    // Event handlers
    searchBox.oninput = () => {
        const needle = searchBox.value;
        filteredValues = uniqueValues.filter(value => matchesFilterValueSearch(String(value), needle));
        renderValuesList();
        if (onSearchChange) {
            onSearchChange(searchBox.value);
        }
    };

    selectAllBtn.onclick = () => {
        filteredValues.forEach(v => checkedValues.add(v));
        renderValuesList();
        notifySelectionChange();
    };

    clearAllBtn.onclick = () => {
        filteredValues.forEach(v => checkedValues.delete(v));
        renderValuesList();
        notifySelectionChange();
    };

    invertBtn.onclick = () => {
        filteredValues.forEach(v => {
            if (checkedValues.has(v)) {
                checkedValues.delete(v);
            } else {
                checkedValues.add(v);
            }
        });
        renderValuesList();
        notifySelectionChange();
    };

    blanksBtn.onclick = () => {
        checkboxes.forEach((cb, val) => {
            const checked = val === 'NULL';
            cb.checked = checked;
            setValueChecked(val, checked);
        });
        notifySelectionChange();
    };

    nonBlanksBtn.onclick = () => {
        checkboxes.forEach((cb, val) => {
            const checked = val !== 'NULL';
            cb.checked = checked;
            setValueChecked(val, checked);
        });
        notifySelectionChange();
    };

    if (isNumericColumn) {
        const top10Btn = quickFilters.querySelectorAll('button')[2] as HTMLButtonElement | undefined;
        const bottom10Btn = quickFilters.querySelectorAll('button')[3] as HTMLButtonElement | undefined;

        top10Btn?.addEventListener('click', () => {
            const numericValues = uniqueValues
                .map(v => ({ val: v, num: parseFilterNumericValue(v) }))
                .filter((x): x is { val: string; num: number } => x.num !== null)
                .sort((a, b) => b.num - a.num)
                .slice(0, 10)
                .map(x => x.val);
            checkboxes.forEach((cb, val) => {
                const checked = numericValues.includes(val);
                cb.checked = checked;
                setValueChecked(val, checked);
            });
            notifySelectionChange();
        });

        bottom10Btn?.addEventListener('click', () => {
            const numericValues = uniqueValues
                .map(v => ({ val: v, num: parseFilterNumericValue(v) }))
                .filter((x): x is { val: string; num: number } => x.num !== null)
                .sort((a, b) => a.num - b.num)
                .slice(0, 10)
                .map(x => x.val);
            checkboxes.forEach((cb, val) => {
                const checked = numericValues.includes(val);
                cb.checked = checked;
                setValueChecked(val, checked);
            });
            notifySelectionChange();
        });
    }

    return {
        checkboxes,
        checkedValues,
        renderValuesList,
        getFilteredValues: () => filteredValues,
        getSelectedCount: () => {
            let count = 0;
            checkboxes.forEach((checkbox) => {
                if (checkbox.checked) {
                    count += 1;
                }
            });
            return count;
        },
        getTotalCount: () => uniqueValues.length
    };
}

function createConditionsTabContent(
    conditionsContent: HTMLDivElement,
    isNumericColumn: boolean,
    currentFilter: ColumnFilterValue
): {
    conditions: FilterCondition[];
    logicOperator: 'and' | 'or';
    renderConditions: () => void;
} {
    const textFilterTypes = [
        { value: 'contains', label: 'Contains' },
        { value: 'notContains', label: 'Does not contain' },
        { value: 'equals', label: 'Equals' },
        { value: 'notEquals', label: 'Does not equal' },
        { value: 'startsWith', label: 'Starts with' },
        { value: 'endsWith', label: 'Ends with' },
        { value: 'like', label: 'Like (SQL % _)' },
        { value: 'isEmpty', label: 'Is empty' },
        { value: 'isNotEmpty', label: 'Is not empty' }
    ];

    const numericFilterTypes = [
        { value: 'equals', label: 'Equals' },
        { value: 'notEquals', label: 'Does not equal' },
        { value: 'greaterThan', label: 'Greater than' },
        { value: 'greaterThanOrEqual', label: 'Greater than or equal' },
        { value: 'lessThan', label: 'Less than' },
        { value: 'lessThanOrEqual', label: 'Less than or equal' },
        { value: 'between', label: 'Between' },
        { value: 'like', label: 'Like (SQL % _)' },
        { value: 'isEmpty', label: 'Is empty' },
        { value: 'isNotEmpty', label: 'Is not empty' }
    ];

    const filterTypes = isNumericColumn ? numericFilterTypes : textFilterTypes;

    let conditions: FilterCondition[];
    let logicOperator: 'and' | 'or';

    if (currentFilter && isConditionColumnFilter(currentFilter) && Array.isArray(currentFilter.conditions)) {
        conditions = currentFilter.conditions.map(c => ({
            type: c.type,
            value: c.value || '',
            value2: c.value2 || ''
        }));
        logicOperator = currentFilter.logic || 'and';
    } else {
        conditions = [{ type: filterTypes[0].value, value: '', value2: '' }];
        logicOperator = 'and';
    }

    function createConditionRow(condition: FilterCondition, index: number): HTMLDivElement {
        const row = document.createElement('div');
        row.className = 'filter-condition';

        const conditionRow = document.createElement('div');
        conditionRow.className = 'filter-condition-row';

        const typeSelect = document.createElement('select');
        typeSelect.className = 'filter-type-dropdown';
        filterTypes.forEach(ft => {
            const opt = document.createElement('option');
            opt.value = ft.value;
            opt.textContent = ft.label;
            if (ft.value === condition.type) opt.selected = true;
            typeSelect.appendChild(opt);
        });

        typeSelect.onchange = () => {
            condition.type = typeSelect.value;
            renderConditions();
        };

        conditionRow.appendChild(typeSelect);

        const needsNoInput = ['isEmpty', 'isNotEmpty'].includes(condition.type);
        const needsTwoInputs = condition.type === 'between';

        if (!needsNoInput) {
            if (needsTwoInputs) {
                const betweenContainer = document.createElement('div');
                betweenContainer.className = 'filter-between-inputs';

                const input1 = document.createElement('input');
                input1.type = isNumericColumn ? 'number' : 'text';
                input1.className = 'filter-value-input';
                input1.placeholder = 'From';
                input1.value = condition.value || '';
                input1.oninput = () => { condition.value = input1.value; };

                const sep = document.createElement('span');
                sep.className = 'filter-between-separator';
                sep.textContent = 'and';

                const input2 = document.createElement('input');
                input2.type = isNumericColumn ? 'number' : 'text';
                input2.className = 'filter-value-input';
                input2.placeholder = 'To';
                input2.value = condition.value2 || '';
                input2.oninput = () => { condition.value2 = input2.value; };

                betweenContainer.appendChild(input1);
                betweenContainer.appendChild(sep);
                betweenContainer.appendChild(input2);
                conditionRow.appendChild(betweenContainer);
            } else {
                const input = document.createElement('input');
                input.type = isNumericColumn && !['contains', 'notContains', 'startsWith', 'endsWith'].includes(condition.type) ? 'number' : 'text';
                input.className = 'filter-value-input';
                input.placeholder = 'Enter value...';
                input.value = condition.value || '';
                input.oninput = () => { condition.value = input.value; };
                conditionRow.appendChild(input);
            }
        }

        if (conditions.length > 1) {
            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-condition-btn';
            removeBtn.textContent = '×';
            removeBtn.title = 'Remove condition';
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                conditions.splice(index, 1);
                renderConditions();
            };
            conditionRow.appendChild(removeBtn);
        }

        row.appendChild(conditionRow);
        return row;
    }

    function renderConditions() {
        conditionsContent.innerHTML = '';

        conditions.forEach((cond, idx) => {
            if (idx > 0) {
                const logicToggle = document.createElement('div');
                logicToggle.className = 'filter-logic-toggle';
                logicToggle.style.margin = '8px 0';
                logicToggle.style.padding = '6px';
                logicToggle.style.backgroundColor = 'var(--vscode-editor-background)';
                logicToggle.style.borderRadius = '4px';
                logicToggle.style.display = 'flex';
                logicToggle.style.justifyContent = 'center';
                logicToggle.style.gap = '8px';

                const andBtn = document.createElement('button');
                andBtn.className = 'filter-logic-btn' + (logicOperator === 'and' ? ' active' : '');
                andBtn.textContent = '⋀ AND';
                andBtn.onclick = (e) => {
                    e.stopPropagation();
                    logicOperator = 'and';
                    renderConditions();
                };

                const orBtn = document.createElement('button');
                orBtn.className = 'filter-logic-btn' + (logicOperator === 'or' ? ' active' : '');
                orBtn.textContent = '⋁ OR';
                orBtn.onclick = (e) => {
                    e.stopPropagation();
                    logicOperator = 'or';
                    renderConditions();
                };

                logicToggle.appendChild(andBtn);
                logicToggle.appendChild(orBtn);
                conditionsContent.appendChild(logicToggle);
            }

            const condRow = createConditionRow(cond, idx);
            conditionsContent.appendChild(condRow);
        });

        if (conditions.length < 3) {
            const addBtn = document.createElement('button');
            addBtn.className = 'add-condition-btn';
            addBtn.textContent = conditions.length === 1 ? '+ Add another condition (for AND/OR)' : '+ Add condition';
            addBtn.onclick = (e) => {
                e.stopPropagation();
                e.preventDefault();
                conditions.push({ type: filterTypes[0].value, value: '', value2: '' });
                renderConditions();
            };
            conditionsContent.appendChild(addBtn);
        }
    }

    renderConditions();

    return { conditions, logicOperator, renderConditions };
}

function createFilterActiveBanner(onRemoveFilter: () => void | Promise<void>): HTMLDivElement {
    const banner = document.createElement('div');
    banner.className = 'filter-active-banner';

    const status = document.createElement('div');
    status.className = 'filter-active-banner-text';
    status.innerHTML = '<span class="filter-active-dot" aria-hidden="true"></span> Filter active on this column';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'filter-btn filter-remove-btn';
    removeBtn.textContent = 'Remove filter';
    removeBtn.title = 'Clear the filter on this column and show all rows';
    removeBtn.onclick = (event) => {
        event.stopPropagation();
        void Promise.resolve(onRemoveFilter());
    };

    banner.appendChild(status);
    banner.appendChild(removeBtn);
    return banner;
}

function createFilterActionButtons(
    onApply: () => void | Promise<void>,
    onClose: () => void,
    options: { showRemoveFilter?: boolean; onRemoveFilter?: () => void | Promise<void> } = {},
): {
    container: HTMLDivElement;
    applyBtn: HTMLButtonElement;
    closeBtn: HTMLButtonElement;
    removeFilterBtn?: HTMLButtonElement;
} {
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'filter-actions';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'filter-btn secondary';
    closeBtn.textContent = 'Close';
    closeBtn.title = 'Close without applying changes';
    closeBtn.onclick = () => {
        onClose();
    };

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'filter-btn primary';
    applyBtn.textContent = 'Apply';
    applyBtn.title = 'Apply the current filter selection';
    applyBtn.onclick = () => {
        void Promise.resolve(onApply());
    };

    actionsContainer.appendChild(closeBtn);

    let removeFilterBtn: HTMLButtonElement | undefined;
    if (options.showRemoveFilter && options.onRemoveFilter) {
        const spacer = document.createElement('div');
        spacer.className = 'filter-actions-spacer';
        actionsContainer.appendChild(spacer);

        removeFilterBtn = document.createElement('button');
        removeFilterBtn.type = 'button';
        removeFilterBtn.className = 'filter-btn filter-remove-btn';
        removeFilterBtn.textContent = 'Remove filter';
        removeFilterBtn.title = 'Clear the filter on this column and show all rows';
        removeFilterBtn.onclick = () => {
            void Promise.resolve(options.onRemoveFilter!());
        };
        actionsContainer.appendChild(removeFilterBtn);
    }

    actionsContainer.appendChild(applyBtn);

    return { container: actionsContainer, applyBtn, closeBtn, removeFilterBtn };
}

function applyFilter(
    column: TanStackColumn,
    checkboxes: Map<string, HTMLInputElement>,
    uniqueValues: string[],
    conditions: FilterCondition[],
    logicOperator: 'and' | 'or',
    valuesTab: HTMLButtonElement,
    getFilteredValues?: () => string[]
): void {
    const activeTab = valuesTab.classList.contains('active') ? 'values' : 'conditions';

    if (activeTab === 'values') {
        const filteredValues = getFilteredValues ? getFilteredValues() : [...uniqueValues];
        const selectedValues = filteredValues.filter(val => {
            const checkbox = checkboxes.get(val);
            return Boolean(checkbox?.checked);
        });

        if (selectedValues.length === uniqueValues.length || selectedValues.length === 0) {
            column.setFilterValue(undefined);
        } else {
            column.setFilterValue(selectedValues);
        }
    } else {
        const validConditions = conditions.filter(c => {
            if (['isEmpty', 'isNotEmpty'].includes(c.type)) return true;
            if (c.type === 'between') return c.value !== '' && c.value2 !== '';
            return c.value !== '';
        });

        if (validConditions.length === 0) {
            column.setFilterValue(undefined);
        } else {
            column.setFilterValue({
                _isConditionFilter: true,
                conditions: validConditions,
                logic: logicOperator
            } satisfies ConditionColumnFilter);
        }
    }
    savePinnedState();
    document.querySelector('.column-filter-dropdown')?.remove();
}

function isEventInsideDropdownTarget(
    event: MouseEvent,
    dropdown: HTMLDivElement,
    anchorElement: HTMLElement,
): boolean {
    const path = event.composedPath();
    return path.includes(dropdown) || path.includes(anchorElement);
}

function setupDropdownCloseHandlers(dropdown: HTMLDivElement, anchorElement: HTMLElement): void {
    setTimeout(() => {
        const closeHandler = (e: MouseEvent) => {
            if (!isEventInsideDropdownTarget(e, dropdown, anchorElement)) {
                dropdown.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        document.addEventListener('click', closeHandler);
    }, 100);

    const keyHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            dropdown.remove();
            document.removeEventListener('keydown', keyHandler);
        }
    };
    document.addEventListener('keydown', keyHandler);
}

export function showAggregationDropdown(
    column: TanStackColumn,
    _table: TanStackTable,
    anchorElement: HTMLElement,
    rsIndex: number,
    executionTimestamp: number | undefined
): void {
    const existing = document.querySelector('.column-aggregation-dropdown');
    if (existing) existing.remove();
    const existingFilter = document.querySelector('.column-filter-dropdown');
    if (existingFilter) existingFilter.remove();

    // Aggregation options with icons and descriptions
    const aggOptions = [
        { value: 'sum', label: 'Sum', symbol: 'Σ', desc: 'Sum of all values' },
        { value: 'count', label: 'Count', symbol: '#', desc: 'Count of non-null values' },
        { value: 'countDistinct', label: 'Count Distinct', symbol: '◊', desc: 'Count of unique values' },
        { value: 'avg', label: 'Average', symbol: 'μ', desc: 'Arithmetic mean' },
        { value: 'min', label: 'Minimum', symbol: '↓', desc: 'Smallest value' },
        { value: 'max', label: 'Maximum', symbol: '↑', desc: 'Largest value' },
        { value: 'stdev', label: 'Std Deviation', symbol: 'σ', desc: 'Standard deviation' },
        { value: 'median', label: 'Median', symbol: 'M', desc: 'Middle value' }
    ];

    // Get current aggregations (objects with fn/precision/position)
    const currentAggs = getAggregationState(rsIndex, executionTimestamp, getResultPanelWindow().activeSource) || {};
    let selectedAggs: AggregationSelection[];
    const columnAggs = currentAggs[column.id];
    if (Array.isArray(columnAggs)) {
        selectedAggs = columnAggs.map(entry => typeof entry === 'string'
                ? { fn: entry, precision: null, position: 'bottom' as const, scope: 'visible' as const }
                : entry);
    } else if (typeof columnAggs === 'string') {
        selectedAggs = [{ fn: columnAggs, precision: null, position: 'bottom', scope: 'visible' }];
    } else if (columnAggs) {
        selectedAggs = [columnAggs];
    } else {
        selectedAggs = [];
    }

    // Helper: find a selected agg by fn
    function findSelected(fn: string): AggregationSelection | undefined {
        return selectedAggs.find(a => a.fn === fn);
    }

    function findSelectedIndex(fn: string): number {
        return selectedAggs.findIndex(a => a.fn === fn);
    }

    // Helper: normalize to object
    function toAggObj(a: AggregationSelection): AggregationSelection {
        return a;
    }

    const dropdown = document.createElement('div');
    dropdown.className = 'column-aggregation-dropdown';
    dropdown.style.position = 'fixed';
    dropdown.style.zIndex = '10000';
    dropdown.style.width = '320px';
    dropdown.style.display = 'flex';
    dropdown.style.flexDirection = 'column';
    dropdown.style.overflow = 'hidden';

    // Position dropdown
    const rect = anchorElement.getBoundingClientRect();
    const viewportMargin = 10;
    const anchorGap = 5;
    const desiredHeight = 400;
    const absoluteMinHeight = 280;

    let left = rect.left;
    if (left + 320 > window.innerWidth - viewportMargin) {
        left = window.innerWidth - 320 - viewportMargin;
    }
    left = Math.max(viewportMargin, left);

    const availableHeightBelow = Math.max(0, window.innerHeight - rect.bottom - viewportMargin - anchorGap);
    const availableHeightAbove = Math.max(0, rect.top - viewportMargin - anchorGap);

    let isPositionedAbove = availableHeightAbove > availableHeightBelow;
    let availableHeight = isPositionedAbove ? availableHeightAbove : availableHeightBelow;

    const maxViewportHeight = window.innerHeight - viewportMargin * 2;
    if (availableHeight < absoluteMinHeight) {
        availableHeight = maxViewportHeight;
    }

    const dropdownHeight = Math.max(absoluteMinHeight, Math.min(desiredHeight, availableHeight));

    let top;
    if (isPositionedAbove && availableHeightAbove >= absoluteMinHeight) {
        top = rect.top - dropdownHeight - anchorGap;
    } else if (!isPositionedAbove && availableHeightBelow >= absoluteMinHeight) {
        top = rect.bottom + anchorGap;
    } else {
        top = Math.max(viewportMargin, (window.innerHeight - dropdownHeight) / 2);
    }
    top = Math.max(viewportMargin, Math.min(top, window.innerHeight - dropdownHeight - viewportMargin));

    dropdown.style.top = top + 'px';
    dropdown.style.left = left + 'px';
    dropdown.style.height = dropdownHeight + 'px';
    dropdown.style.minHeight = absoluteMinHeight + 'px';
    dropdown.style.maxHeight = dropdownHeight + 'px';

    // Header
    const header = document.createElement('div');
    header.className = 'filter-tabs';
    header.style.flexShrink = '0';

    const headerTitle = document.createElement('span');
    headerTitle.className = 'filter-tab active';
    headerTitle.style.cursor = 'default';
    headerTitle.style.flex = '1';
    headerTitle.textContent = `Aggregation: ${column.columnDef.header}`;

    header.appendChild(headerTitle);
    dropdown.appendChild(header);

    // Selection info
    const infoRow = document.createElement('div');
    infoRow.className = 'filter-dropdown-selection-info';
    infoRow.textContent = 'Select aggregations — configure precision & position per function';
    dropdown.appendChild(infoRow);

    // Aggregations list container
    const listContainer = document.createElement('div');
    listContainer.style.flex = '1';
    listContainer.style.overflowY = 'auto';
    listContainer.style.padding = '2px 0';

    const itemStates = new Map(); // fn -> { checkbox, precisionInput, topBtn, bottomBtn, optionsRow }

    // Create aggregation items
    aggOptions.forEach(opt => {
        const item = document.createElement('div');

        // ─── Main row (checkbox + symbol + label + desc) ───
        const mainRow = document.createElement('div');
        mainRow.style.display = 'flex';
        mainRow.style.alignItems = 'center';
        mainRow.style.padding = '5px 12px';
        mainRow.style.cursor = 'pointer';
        mainRow.style.gap = '8px';
        mainRow.style.transition = 'background-color 0.1s';

        mainRow.onmouseenter = () => {
            mainRow.style.backgroundColor = 'var(--vscode-list-hoverBackground)';
        };
        mainRow.onmouseleave = () => {
            mainRow.style.backgroundColor = '';
        };

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = findSelected(opt.value) !== undefined;
        checkbox.style.margin = '0';
        checkbox.style.cursor = 'pointer';
        checkbox.style.accentColor = 'var(--vscode-focusBorder)';
        checkbox.style.flexShrink = '0';

        const symbolSpan = document.createElement('span');
        symbolSpan.textContent = opt.symbol;
        symbolSpan.style.fontSize = '13px';
        symbolSpan.style.minWidth = '18px';
        symbolSpan.style.textAlign = 'center';
        symbolSpan.style.opacity = '0.8';
        symbolSpan.style.flexShrink = '0';

        const textContainer = document.createElement('div');
        textContainer.style.display = 'flex';
        textContainer.style.flexDirection = 'column';
        textContainer.style.flex = '1';
        textContainer.style.minWidth = '0';

        const labelSpan = document.createElement('span');
        labelSpan.textContent = opt.label;
        labelSpan.style.fontWeight = '500';
        labelSpan.style.fontSize = '12px';

        const descSpan = document.createElement('span');
        descSpan.textContent = opt.desc;
        descSpan.style.fontSize = '10px';
        descSpan.style.opacity = '0.7';

        textContainer.appendChild(labelSpan);
        textContainer.appendChild(descSpan);

        mainRow.appendChild(checkbox);
        mainRow.appendChild(symbolSpan);
        mainRow.appendChild(textContainer);

        // ─── Options (precision, position, scope — shown when checked) ───
        const optionsRow = document.createElement('div');
        optionsRow.style.display = checkbox.checked ? 'flex' : 'none';
        optionsRow.style.flexDirection = 'column';
        optionsRow.style.gap = '6px';
        optionsRow.style.padding = '2px 12px 8px 44px'; // indent to align with text
        optionsRow.style.fontSize = '11px';

        function createOptionLine(): HTMLDivElement {
            const line = document.createElement('div');
            line.style.display = 'flex';
            line.style.alignItems = 'center';
            line.style.gap = '8px';
            line.style.flexWrap = 'nowrap';
            return line;
        }

        const optionLabelStyle = 'color: var(--vscode-descriptionForeground); flex-shrink: 0; min-width: 58px;';

        // Precision label + input
        const precLabel = document.createElement('span');
        precLabel.textContent = 'Precision:';
        precLabel.style.cssText = optionLabelStyle;

        const precisionInput = document.createElement('input');
        precisionInput.type = 'number';
        precisionInput.min = '0';
        precisionInput.max = '15';
        precisionInput.placeholder = 'auto';
        precisionInput.style.width = '52px';
        precisionInput.style.padding = '2px 4px';
        precisionInput.style.fontSize = '11px';
        precisionInput.style.backgroundColor = 'var(--vscode-input-background)';
        precisionInput.style.color = 'var(--vscode-input-foreground)';
        precisionInput.style.border = '1px solid var(--vscode-input-border)';
        precisionInput.style.borderRadius = '2px';
        precisionInput.style.outline = 'none';

        // Set precision from existing selection
        const existing = findSelected(opt.value);
        if (existing) {
            const obj = toAggObj(existing);
            if (obj.precision !== null && obj.precision !== undefined) {
                precisionInput.value = String(obj.precision);
            }
        }

        precisionInput.onfocus = () => {
            precisionInput.style.borderColor = 'var(--vscode-focusBorder)';
        };
        precisionInput.onblur = () => {
            precisionInput.style.borderColor = 'var(--vscode-input-border)';
        };

        // Position toggle
        const posLabel = document.createElement('span');
        posLabel.textContent = 'Position:';
        posLabel.style.cssText = optionLabelStyle;

        const topBtn = document.createElement('button');
        topBtn.textContent = 'Top';
        topBtn.style.padding = '2px 8px';
        topBtn.style.fontSize = '11px';
        topBtn.style.cursor = 'pointer';
        topBtn.style.borderRadius = '2px';
        topBtn.style.border = '1px solid var(--vscode-button-border, var(--vscode-panel-border))';
        topBtn.style.fontFamily = 'var(--vscode-font-family)';

        const bottomBtn = document.createElement('button');
        bottomBtn.textContent = 'Bottom';
        bottomBtn.style.padding = '2px 8px';
        bottomBtn.style.fontSize = '11px';
        bottomBtn.style.cursor = 'pointer';
        bottomBtn.style.borderRadius = '2px';
        bottomBtn.style.border = '1px solid var(--vscode-button-border, var(--vscode-panel-border))';
        bottomBtn.style.fontFamily = 'var(--vscode-font-family)';

        const scopeLabel = document.createElement('span');
        scopeLabel.textContent = 'Rows:';
        scopeLabel.style.cssText = optionLabelStyle;

        const visibleBtn = document.createElement('button');
        visibleBtn.textContent = 'Loaded';
        visibleBtn.title = 'Calculate over rows loaded locally in this grid';
        visibleBtn.style.padding = '2px 8px';
        visibleBtn.style.fontSize = '11px';
        visibleBtn.style.cursor = 'pointer';
        visibleBtn.style.borderRadius = '2px';
        visibleBtn.style.border = '1px solid var(--vscode-button-border, var(--vscode-panel-border))';
        visibleBtn.style.fontFamily = 'var(--vscode-font-family)';

        const databaseBtn = document.createElement('button');
        databaseBtn.textContent = 'All';
        databaseBtn.title = 'Run a database aggregate using this grid SQL without a trailing LIMIT';
        databaseBtn.style.padding = '2px 8px';
        databaseBtn.style.fontSize = '11px';
        databaseBtn.style.cursor = 'pointer';
        databaseBtn.style.borderRadius = '2px';
        databaseBtn.style.border = '1px solid var(--vscode-button-border, var(--vscode-panel-border))';
        databaseBtn.style.fontFamily = 'var(--vscode-font-family)';

        // Set initial position style
        function updatePositionButtons(pos: 'top' | 'bottom'): void {
            const activeBg = 'var(--vscode-button-background)';
            const activeFg = 'var(--vscode-button-foreground)';
            const inactiveBg = 'transparent';
            const inactiveFg = 'var(--vscode-foreground)';
            topBtn.style.backgroundColor = pos === 'top' ? activeBg : inactiveBg;
            topBtn.style.color = pos === 'top' ? activeFg : inactiveFg;
            bottomBtn.style.backgroundColor = pos !== 'top' ? activeBg : inactiveBg;
            bottomBtn.style.color = pos !== 'top' ? activeFg : inactiveFg;
        }

        function updateScopeButtons(scope: 'visible' | 'database'): void {
            const activeBg = 'var(--vscode-button-background)';
            const activeFg = 'var(--vscode-button-foreground)';
            const inactiveBg = 'transparent';
            const inactiveFg = 'var(--vscode-foreground)';
            visibleBtn.style.backgroundColor = scope !== 'database' ? activeBg : inactiveBg;
            visibleBtn.style.color = scope !== 'database' ? activeFg : inactiveFg;
            databaseBtn.style.backgroundColor = scope === 'database' ? activeBg : inactiveBg;
            databaseBtn.style.color = scope === 'database' ? activeFg : inactiveFg;
        }

        if (existing) {
            const obj = toAggObj(existing);
            updatePositionButtons(obj.position || 'bottom');
            updateScopeButtons(obj.scope === 'database' ? 'database' : 'visible');
        } else {
            updatePositionButtons('bottom');
            updateScopeButtons('visible');
        }

        topBtn.onclick = (e) => {
            e.stopPropagation();
            checkbox.checked = true;
            if (!findSelected(opt.value)) {
                selectedAggs.push({ fn: opt.value, precision: null, position: 'top', scope: 'visible' });
                checkbox.dispatchEvent(new Event('change'));
            } else {
                const idx = findSelectedIndex(opt.value);
                if (idx >= 0) {
                    const obj = toAggObj(selectedAggs[idx]);
                    obj.position = 'top';
                    selectedAggs[idx] = obj;
                }
            }
            updatePositionButtons('top');
            updateSelectionInfo();
            showHideOptions();
        };

        bottomBtn.onclick = (e) => {
            e.stopPropagation();
            checkbox.checked = true;
            if (!findSelected(opt.value)) {
                selectedAggs.push({ fn: opt.value, precision: null, position: 'bottom', scope: 'visible' });
                checkbox.dispatchEvent(new Event('change'));
            } else {
                const idx = findSelectedIndex(opt.value);
                if (idx >= 0) {
                    const obj = toAggObj(selectedAggs[idx]);
                    obj.position = 'bottom';
                    selectedAggs[idx] = obj;
                }
            }
            updatePositionButtons('bottom');
            updateSelectionInfo();
            showHideOptions();
        };

        visibleBtn.onclick = (e) => {
            e.stopPropagation();
            checkbox.checked = true;
            if (!findSelected(opt.value)) {
                selectedAggs.push({ fn: opt.value, precision: null, position: 'bottom', scope: 'visible' });
                checkbox.dispatchEvent(new Event('change'));
            } else {
                const idx = findSelectedIndex(opt.value);
                if (idx >= 0) {
                    const obj = toAggObj(selectedAggs[idx]);
                    obj.scope = 'visible';
                    selectedAggs[idx] = obj;
                }
            }
            updateScopeButtons('visible');
            updateSelectionInfo();
            showHideOptions();
        };

        databaseBtn.onclick = (e) => {
            e.stopPropagation();
            checkbox.checked = true;
            if (!findSelected(opt.value)) {
                selectedAggs.push({ fn: opt.value, precision: null, position: 'bottom', scope: 'database' });
                checkbox.dispatchEvent(new Event('change'));
            } else {
                const idx = findSelectedIndex(opt.value);
                if (idx >= 0) {
                    const obj = toAggObj(selectedAggs[idx]);
                    obj.scope = 'database';
                    selectedAggs[idx] = obj;
                }
            }
            updateScopeButtons('database');
            updateSelectionInfo();
            showHideOptions();
        };

        const precisionLine = createOptionLine();
        precisionLine.appendChild(precLabel);
        precisionLine.appendChild(precisionInput);

        const positionLine = createOptionLine();
        positionLine.appendChild(posLabel);
        positionLine.appendChild(topBtn);
        positionLine.appendChild(bottomBtn);

        const scopeLine = createOptionLine();
        scopeLine.appendChild(scopeLabel);
        scopeLine.appendChild(visibleBtn);
        scopeLine.appendChild(databaseBtn);

        optionsRow.appendChild(precisionLine);
        optionsRow.appendChild(positionLine);
        optionsRow.appendChild(scopeLine);

        item.appendChild(mainRow);
        item.appendChild(optionsRow);

        // ─── Events ───
        mainRow.onclick = (e) => {
            if (e.target !== checkbox) {
                checkbox.checked = !checkbox.checked;
                checkbox.dispatchEvent(new Event('change'));
            }
        };

        const stateEntry = { checkbox, precisionInput, topBtn, bottomBtn, optionsRow };

        checkbox.onchange = () => {
            if (checkbox.checked) {
                if (!findSelected(opt.value)) {
                    selectedAggs.push({ fn: opt.value, precision: null, position: 'bottom', scope: 'visible' });
                }
            } else {
                const idx = findSelectedIndex(opt.value);
                if (idx >= 0) {
                    selectedAggs.splice(idx, 1);
                }
            }
            showHideOptions();
            updateSelectionInfo();
        };

        function showHideOptions() {
            optionsRow.style.display = checkbox.checked ? 'flex' : 'none';
        }

        // Update precision in selectedAggs when input changes
        precisionInput.onchange = () => {
            const idx = findSelectedIndex(opt.value);
            if (idx >= 0) {
                const obj = toAggObj(selectedAggs[idx]);
                const val = precisionInput.value.trim();
                obj.precision = val !== '' ? parseInt(val, 10) : null;
                selectedAggs[idx] = obj;
            }
        };
        precisionInput.oninput = () => {
            const idx = findSelectedIndex(opt.value);
            if (idx >= 0) {
                const obj = toAggObj(selectedAggs[idx]);
                const val = precisionInput.value.trim();
                obj.precision = val !== '' ? parseInt(val, 10) : null;
                selectedAggs[idx] = obj;
            }
        };

        itemStates.set(opt.value, stateEntry);
        listContainer.appendChild(item);
    });

    dropdown.appendChild(listContainer);

    // Selection count info
    const selectionInfo = document.createElement('div');
    selectionInfo.className = 'filter-dropdown-selection-info';
    dropdown.appendChild(selectionInfo);

    function updateSelectionInfo() {
        const count = selectedAggs.length;
        selectionInfo.textContent = count === 0 ? 'No aggregations selected' :
                                   count === 1 ? '1 aggregation selected' :
                                   `${count} aggregations selected`;
    }
    updateSelectionInfo();

    // Action buttons
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'filter-actions';

    const clearBtn = document.createElement('button');
    clearBtn.className = 'filter-btn';
    clearBtn.textContent = 'Clear';
    clearBtn.onclick = () => {
        selectedAggs = [];
        itemStates.forEach(st => {
            st.checkbox.checked = false;
            st.optionsRow.style.display = 'none';
        });
        updateSelectionInfo();
    };

    const applyBtn = document.createElement('button');
    applyBtn.className = 'filter-btn primary';
    applyBtn.textContent = 'Apply';
    applyBtn.onclick = () => {
        // Read latest precision values from inputs before saving
        selectedAggs.forEach((a: AggregationSelection, i: number) => {
            const st = itemStates.get(a.fn);
            if (st) {
                const obj = toAggObj(selectedAggs[i]);
                const val = st.precisionInput.value.trim();
                obj.precision = val !== '' ? parseInt(val, 10) : null;
                selectedAggs[i] = obj;
            }
        });
        const currentAggs = getAggregationState(rsIndex, executionTimestamp, getResultPanelWindow().activeSource) || {};
        if (selectedAggs.length === 0) {
            delete currentAggs[column.id];
        } else {
            currentAggs[column.id] = [...selectedAggs];
        }
        setAggregationState(rsIndex, currentAggs, executionTimestamp, getResultPanelWindow().activeSource);
        savePinnedState();
        dropdown.remove();
        const grid = getGrid(rsIndex);
        if (grid && grid.render) {
            grid.render();
        }
    };

    actionsContainer.appendChild(clearBtn);
    actionsContainer.appendChild(applyBtn);
    dropdown.appendChild(actionsContainer);

    document.body.appendChild(dropdown);

    // Close handlers
    setTimeout(() => {
        const closeHandler = (e: MouseEvent) => {
            if (!isEventInsideDropdownTarget(e, dropdown, anchorElement)) {
                dropdown.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        document.addEventListener('click', closeHandler);
    }, 100);

    const keyHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            dropdown.remove();
            document.removeEventListener('keydown', keyHandler);
        }
    };
    document.addEventListener('keydown', keyHandler);
}

export function reorderColumnsForPinning(
    table: TanStackTable,
    rsIndex: number,
    executionTimestamp: number | undefined
): void {
    const pinnedColumns = getPinnedColumnsState(rsIndex, executionTimestamp, getResultPanelWindow().activeSource);
    if (pinnedColumns.length === 0) return;

    const currentOrder = table.getState().columnOrder || table.getAllColumns().map(col => col.id);

    // Separate pinned and unpinned columns
    const pinned = pinnedColumns.filter((id: string) => currentOrder.includes(id));
    const unpinned = currentOrder.filter(id => !pinned.includes(id));

    // Create new order: pinned columns first, then unpinned
    const newOrder = [...pinned, ...unpinned];

    table.setColumnOrder(newOrder);
}
