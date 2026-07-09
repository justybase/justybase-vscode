// Selection module - Cell selection and copy functionality for result panel
import {
    escapeCsvValue,
    formatCellValue,
    formatCellValueForSql,
    getNumericTypeInfo,
    isTemporalType
} from './utils.js';
import { postHostMessage } from './protocol.js';
import { getGrid } from './state.js';
import { getResultPanelWindow, getActiveSourceUri, requireActiveSourceUri, callPanelMethod } from './types.js';
import type {
    CellDescriptor,
    CellSelectionHandlers,
    ResultColumnDef,
    SelectionStats,
    TanStackColumn,
    TanStackRow,
    TanStackTable,
} from './types.js';
import { asHtml, getElementById } from './dom.js';
import {
    buildSelectedClipboardPayload,
    buildSelectedClipboardPayloadAsync,
    writeMultiFormatToClipboard,
    copyAllRows,
    copyAllRowsAsync,
    copyAllRowsAsHtml,
    copyAllRowsAsHtmlAsync,
    copyAllRowsAsMd,
    copyAllRowsAsMdAsync,
    resolvePlainText,
    type ClipboardRowResolver,
} from './selection/clipboard.js';

export { __testHooks } from './selection/clipboard.js';
import {
    RANGE_CHART_MENU,
    canCreateRangeChart,
    openRangeChartModal,
} from './rangeChart.js';
import {
    panelGetIsEditMode,
    requestResultsViewFocus,
    isInputLikeElement,
    parseDatasetIndex,
} from './selection/interaction.js';
import {
    removeOpenSubmenus,
    createContextMenuItem,
    createChartRangeSubmenuItem,
} from './selection/contextMenu.js';

const vscode = { postMessage: postHostMessage };

export function setupCellSelectionEvents(
    wrapper: HTMLElement,
    table: TanStackTable,
    columnCount: number,
    clipboardResolver?: ClipboardRowResolver,
): CellSelectionHandlers {
    let isSelecting = false;
    let isSelectingRows = false;
    let startCell: string | null = null;
    let endCell: string | null = null;
    let startRow: number | null = null;
    let endRow: number | null = null;
    let selectedCells = new Set<string>();
    let isAllSelected = false;
    let isDestroyed = false;

    // Selection rectangle overlay matching TableV2 style
    const selRect = document.createElement('div');
    selRect.className = 'sel-rect';
    wrapper.appendChild(selRect);

    function isCurrentActiveWrapper() {
        return !isDestroyed
            && wrapper.isConnected
            && wrapper === document.querySelector('.grid-wrapper.active')
            && wrapper.style.display !== 'none';
    }

    function queryCell(cellId: string): Element | null {
        return wrapper.querySelector(`[data-cell-id="${cellId}"]`);
    }

    function selectSingleCell(row: number, col: number): void {
        const cellId = `${row}-${col}`;
        const td = queryCell(cellId);

        if (td) {
            startCell = cellId;
            endCell = cellId;
            selectedCells.add(cellId);
            td.classList.add('selected-cell');
            setSelectionContexts(true);
            sendSelectionStats();
            notifySelectionChanged();
            scrollCellIntoView(td);
        } else {
            const activeGridIndex = asHtml(document.querySelector('.grid-wrapper.active'))?.dataset?.index;
            if (activeGridIndex !== undefined) {
                const grid = getGrid(parseInt(activeGridIndex, 10));
                if (grid && grid.scrollToIndex) {
                    grid.scrollToIndex(row, 'auto');
                    setTimeout(() => {
                        const newTd = queryCell(cellId);
                        if (newTd) {
                            startCell = cellId;
                            endCell = cellId;
                            selectedCells.add(cellId);
                            newTd.classList.add('selected-cell');
                            setSelectionContexts(true);
                            sendSelectionStats();
                            notifySelectionChanged();
                            scrollCellIntoView(newTd);
                        }
                    }, 50);
                }
            }
        }
    }

    function scrollCellIntoView(td: Element) {
        const cell = td as HTMLElement;
        const rowHeader = asHtml(wrapper.querySelector('td.row-number-cell'));
        const rhWidth = rowHeader?.offsetWidth ?? 0;

        const tdOffsetLeft = cell.offsetLeft;
        const tdWidth = cell.offsetWidth;
        const sl = wrapper.scrollLeft;
        const visibleWidth = wrapper.clientWidth;

        if (tdOffsetLeft - rhWidth < sl) {
            wrapper.scrollLeft = tdOffsetLeft - rhWidth;
        } else if (tdOffsetLeft + tdWidth > sl + visibleWidth) {
            wrapper.scrollLeft = tdOffsetLeft + tdWidth - visibleWidth;
        }

        const thead = asHtml(wrapper.querySelector('thead'));
        const headerHeight = thead?.offsetHeight ?? 0;
        const tdOffsetTop = cell.offsetTop;
        const tdHeight = cell.offsetHeight;
        const st = wrapper.scrollTop;
        const visibleHeight = wrapper.clientHeight;

        if (tdOffsetTop - headerHeight < st) {
            wrapper.scrollTop = tdOffsetTop - headerHeight;
        } else if (tdOffsetTop + tdHeight > st + visibleHeight) {
            wrapper.scrollTop = tdOffsetTop + tdHeight - visibleHeight;
        }
    }

    function notifySelectionChanged() {
        updateSelectionBorder();
        window.dispatchEvent(new CustomEvent('result-panel-selection-changed'));
    }

    function reapplySelectionBorders() {
        if (selectedCells.size === 0) return;

        selectedCells.forEach(cellId => {
            const cell = queryCell(cellId);
            if (cell && !cell.classList.contains('selected-cell')) {
                cell.classList.add('selected-cell');
            }
        });

        updateSelectionBorder();
    }

    function updateSelectionBorder() {
        wrapper.querySelectorAll('.anchor-cell').forEach(el => el.classList.remove('anchor-cell'));
        selRect.style.display = 'none';

        if (selectedCells.size === 0) return;

        // Position outer selection rectangle
        let minRow = Infinity, maxRow = -Infinity, minCol = Infinity, maxCol = -Infinity;
        selectedCells.forEach(cellId => {
            const [r, c] = cellId.split('-').map(Number);
            if (r < minRow) minRow = r;
            if (r > maxRow) maxRow = r;
            if (c < minCol) minCol = c;
            if (c > maxCol) maxCol = c;
        });

        const firstCell = queryCell(`${minRow}-${minCol}`);
        const lastCell = queryCell(`${maxRow}-${maxCol}`);

        if (firstCell && lastCell) {
            const wrapperRect = wrapper.getBoundingClientRect();
            const firstRect = firstCell.getBoundingClientRect();
            const lastRect = lastCell.getBoundingClientRect();

            const scrollTop = wrapper.scrollTop;
            const scrollLeft = wrapper.scrollLeft;

            selRect.style.display = 'block';
            selRect.style.top = (firstRect.top - wrapperRect.top + scrollTop) + 'px';
            selRect.style.left = (firstRect.left - wrapperRect.left + scrollLeft) + 'px';
            selRect.style.width = (lastRect.right - firstRect.left) + 'px';
            selRect.style.height = (lastRect.bottom - firstRect.top) + 'px';
        }

        // Mark anchor cell
        if (startCell) {
            const anchorEl = queryCell(startCell);
            if (anchorEl) anchorEl.classList.add('anchor-cell');
        }
    }

    function setSelectionContexts(hasSelection: boolean, primeCopy = hasSelection): void {
        vscode.postMessage({
            command: 'setContext',
            key: 'netezza.resultsHasSelection',
            value: hasSelection
        });
        vscode.postMessage({
            command: 'setContext',
            key: 'netezza.resultsCopyPrimed',
            value: hasSelection && primeCopy
        });
    }

    function _internalClearSelection() {
        isAllSelected = false;
        selRect.style.display = 'none';
        wrapper.querySelectorAll('.anchor-cell').forEach(el => el.classList.remove('anchor-cell'));
        // Clear every visible selected cell — not only selectedCells entries. After Ctrl+A,
        // virtualization re-renders rows with isAllSelected styling without updating the Set.
        wrapper.querySelectorAll('.selected-cell').forEach(el => el.classList.remove('selected-cell'));
        selectedCells.clear();
        wrapper.querySelectorAll('tr.row-selected').forEach(r => r.classList.remove('row-selected'));
    }

    function clearSelection() {
        _internalClearSelection();
        setSelectionContexts(false, false);
        sendSelectionStats();
        notifySelectionChanged();
    }

    function getCellId(element: EventTarget | null): string | null {
        const td = asHtml(element)?.closest('td');
        if (!td) return null;

        const tr = td.closest('tr');
        if (!tr) return null;

        const rowIndex = (tr as HTMLElement).dataset.index;
        if (rowIndex === undefined) {
            return null;
        }
        let cellIndex = Array.from(tr.children).indexOf(td);

        // Subtract 1 to account for row number column (first column)
        if (cellIndex > 0) {
            cellIndex = cellIndex - 1;
        } else {
            // Clicked on row number cell - return null or special handling
            return null;
        }

        return `${rowIndex}-${cellIndex}`;
    }

    function selectRange(start: string | null, end: string | null): void {
        if (!start || !end) return;

        const [startRow, startCol] = start.split('-').map(Number);
        const [endRow, endCol] = end.split('-').map(Number);

        const minRow = Math.min(startRow, endRow);
        const maxRow = Math.max(startRow, endRow);
        const minCol = Math.min(startCol, endCol);
        const maxCol = Math.max(startCol, endCol);

        _internalClearSelection();

        for (let row = minRow; row <= maxRow; row++) {
            for (let col = minCol; col <= maxCol; col++) {
                const cellId = `${row}-${col}`;
                selectedCells.add(cellId);

                const cell = queryCell(cellId);
                if (cell) {
                    cell.classList.add('selected-cell');
                }
            }
        }

        setSelectionContexts(true);

        sendSelectionStats();
        notifySelectionChanged();
    }

    function selectRowRange(startRowIndex: number | null, endRowIndex: number | null): void {
        if (startRowIndex === null || endRowIndex === null) return;

        const minRow = Math.min(startRowIndex, endRowIndex);
        const maxRow = Math.max(startRowIndex, endRowIndex);

        _internalClearSelection();

        for (let row = minRow; row <= maxRow; row++) {
            const tr = wrapper.querySelector(`tr[data-index="${row}"]`);
            if (tr) {
                tr.classList.add('row-selected');
                selectEntireRow(row, tr);
            }
        }

        setSelectionContexts(true);

        sendSelectionStats();
        notifySelectionChanged();
    }

    function getVisibleColumns(): TanStackColumn[] {
        return table.getVisibleLeafColumns().filter(col => !col.columnDef?.isRowNumber);
    }



    function getCellDescriptorFromTd(td: Element): CellDescriptor | null {
        const tr = td.closest('tr');
        if (!tr) return null;

        const rowIndexStr = (tr as HTMLElement).dataset.index;
        if (!rowIndexStr) return null;

        const rowIndex = parseInt(rowIndexStr, 10);
        if (Number.isNaN(rowIndex)) return null;

        const cellIndex = Array.from(tr.children).indexOf(td);
        if (cellIndex <= 0) return null;

        const visibleColumns = getVisibleColumns();
        const column = visibleColumns[cellIndex - 1];
        const row = table.getRowModel().rows[rowIndex];
        if (!column || !row) {
            return null;
        }

        const rawValue = row.getValue(column.id);
        const dataRowNumStr = (tr as HTMLElement).dataset.dataRowNumber;
        const dataRowNum = dataRowNumStr ? parseInt(dataRowNumStr, 10) : NaN;
        return {
            rowIndex,
            rowNumber: Number.isNaN(dataRowNum) ? rowIndex + 1 : dataRowNum,
            columnId: column.id,
            columnName: String(column.columnDef.header || column.id),
            dataType: column.columnDef?.dataType || 'text',
            value: rawValue,
            isNull: rawValue === null || rawValue === undefined
        };
    }

    function sendSelectionStats() {
        if (selectedCells.size === 0) {
            vscode.postMessage({
                command: 'selectionStatsChanged',
                stats: null
            });
            return;
        }

        if (selectedCells.size > 100) {
            vscode.postMessage({
                command: 'selectionStatsChanged',
                stats: null
            });
            return;
        }

        const cellArray = Array.from(selectedCells).map(cellId => {
            const [row, col] = cellId.split('-').map(Number);
            return { row, col, cellId };
        }).sort((a, b) => a.row - b.row || a.col - b.col);

        if (cellArray.length === 0) {
            vscode.postMessage({
                command: 'selectionStatsChanged',
                stats: null
            });
            return;
        }

        const numericValues: number[] = [];
        const dateValues: string[] = [];
        const textValues: string[] = [];

        cellArray.forEach(cell => {
            const cellElement = queryCell(cell.cellId);
            if (cellElement) {
                const text = cellElement.textContent.trim();
                
                if (text === '' || text === 'NULL' || text === 'null') {
                    return;
                }

                const cleanText = text.replace(/[\s\u00A0]/g, '');
                
                // Allow comma as decimal separator for locale formats by replacing it with dot for parsing
                const standardText = cleanText.replace(',', '.');
                
                const num = parseFloat(standardText);
                if (!isNaN(num) && /^-?\d*\.?\d+$/.test(standardText)) {
                    numericValues.push(num);
                }

                if (text.match(/^\d{4}-\d{2}-\d{2}/) || text.match(/^\d{2}\/\d{2}\/\d{4}/)) {
                    dateValues.push(text);
                } else if (!/^-?\d*\.?\d+$/.test(standardText)) {
                    textValues.push(text);
                }
            }
        });

        const allValues = [...numericValues, ...dateValues, ...textValues];
        const distinctValues = new Set(allValues);
        
        let stats: SelectionStats = {
            cellCount: allValues.length,
            type: 'mixed',
            count: allValues.length,
            distinctCount: distinctValues.size
        };

        if (numericValues.length > 0 && dateValues.length === 0 && textValues.length === 0) {
            const sum = numericValues.reduce((a, b) => a + b, 0);
            const min = Math.min(...numericValues);
            const max = Math.max(...numericValues);
            stats = {
                cellCount: allValues.length,
                type: 'numeric',
                count: numericValues.length,
                distinctCount: distinctValues.size,
                sum: sum,
                min: min,
                max: max
            };
        } else if (dateValues.length > 0 && numericValues.length === 0 && textValues.length === 0) {
            const sortedDates = [...dateValues].sort();
            stats = {
                cellCount: allValues.length,
                type: 'date',
                count: dateValues.length,
                distinctCount: distinctValues.size,
                min: sortedDates[0],
                max: sortedDates[sortedDates.length - 1]
            };
        } else if (textValues.length > 0 && numericValues.length === 0 && dateValues.length === 0) {
            stats = {
                cellCount: allValues.length,
                type: 'text',
                count: textValues.length,
                distinctCount: distinctValues.size
            };
        }

        vscode.postMessage({
            command: 'selectionStatsChanged',
            stats: stats
        });
    }

    function addCellIds() {
        const rows = wrapper.querySelectorAll('tbody tr');
        rows.forEach(tr => {
            const rowIndex = (tr as HTMLElement).dataset.index;
            if (rowIndex !== undefined) {
                const cells = tr.querySelectorAll('td');
                cells.forEach((td, cellIndex) => {
                    // Skip row number cell (first column), it doesn't get a cellId
                    if (td.classList.contains('row-number-cell')) {
                        delete (td as HTMLElement).dataset.cellId;
                        td.classList.remove('selected-cell');
                        return;
                    }
                    // Subtract 1 from cellIndex because first column is row number
                    const dataCellIndex = cellIndex - 1;
                    if (dataCellIndex >= 0) {
                        const cellId = `${rowIndex}-${dataCellIndex}`;
                        (td as HTMLElement).dataset.cellId = cellId;
                        if (isAllSelected || selectedCells.has(cellId)) {
                            td.classList.add('selected-cell');
                        } else {
                            td.classList.remove('selected-cell');
                        }
                    }
                });
            }
        });
    }

function performSelectAll() {
  _internalClearSelection();
  isAllSelected = true;
    const rows = wrapper.querySelectorAll('tbody tr[data-index]');

  rows.forEach(tr => {
    // Note: We don't add 'row-selected' class here because 'select all' should
    // select data cells only, not the row number column. The visual selection
    // is handled by .selected-cell class on individual cells.
    // Select all data cells (skip row number cell)
    const cells = tr.querySelectorAll('td[data-cell-id]:not(.row-number-cell)');
    cells.forEach((td) => {
      const cellId = (td as HTMLElement).dataset.cellId;
      if (cellId) {
        selectedCells.add(cellId);
        td.classList.add('selected-cell');
      }
    });
  });

  setSelectionContexts(true);
  sendSelectionStats();
  notifySelectionChanged();
}

    // Make wrapper focusable
    wrapper.tabIndex = 0;
    wrapper.style.outline = 'none';

    wrapper.addEventListener('mousedown', (e) => {
        const td = asHtml(e.target)?.closest('td');
        if (!td) return;

        // Ignore right-click (context menu) - let contextmenu handler handle it
        if (e.button === 2) {
            return;
        }

        // Skip selection on group header rows (expand/collapse handled by indicator.onclick)
        const tr = td.closest('tr');
        if (tr && tr.classList.contains('group-header')) {
            return;
        }

        // Check if clicking on row number cell
        if (td.classList.contains('row-number-cell')) {
            e.preventDefault();
            e.stopPropagation();
            requestResultsViewFocus();
            wrapper.focus();

            const tr = td.closest('tr');
            if (!tr) return;

            const rowIndex = (tr as HTMLElement).dataset.index;
            if (rowIndex === undefined) return;

            // If Ctrl/Cmd is held, toggle selection; otherwise clear and select
            if (!e.ctrlKey && !e.metaKey) {
                _internalClearSelection();
                // Remove row-selected class from all rows
                wrapper.querySelectorAll('tr.row-selected').forEach(r => r.classList.remove('row-selected'));
            }

            // Toggle row selection
            if (tr.classList.contains('row-selected')) {
                tr.classList.remove('row-selected');
                // Remove cells from this row from selectedCells
                const cells = tr.querySelectorAll('td[data-cell-id]');
                cells.forEach(cell => {
                    const cellId = (cell as HTMLElement).dataset.cellId;
                    if (cellId) {
                        selectedCells.delete(cellId);
                        cell.classList.remove('selected-cell');
                    }
                });
            } else {
                tr.classList.add('row-selected');
                selectEntireRow(parseInt(rowIndex), tr);
            }

            // Enable row drag selection
            isSelectingRows = true;
            startRow = parseInt(rowIndex);
            endRow = startRow;

            setSelectionContexts(selectedCells.size > 0);
            sendSelectionStats();
            notifySelectionChanged();
            return;
        }

        // Regular cell selection
        isSelecting = true;
        startCell = getCellId(e.target) ?? null;
        endCell = startCell;
        e.preventDefault();

        requestResultsViewFocus();
        wrapper.focus();

        // Remove row-selected class when starting cell selection
        wrapper.querySelectorAll('tr.row-selected').forEach(r => r.classList.remove('row-selected'));

        if (!e.ctrlKey && !e.metaKey) {
            _internalClearSelection();
        }

        if (startCell) {
            selectedCells.add(startCell);
            const cell = queryCell(startCell);
            if (cell) {
                cell.classList.add('selected-cell');
            }

            setSelectionContexts(true);
            sendSelectionStats();
            notifySelectionChanged();
        }
    });

    // Double-click handler to insert cell content into SQL editor
    wrapper.addEventListener('dblclick', (e) => {
        const td = asHtml(e.target)?.closest('td');
        if (!td) return;

        // Only handle double-click on data cells (not row number cells)
        if (td.classList.contains('row-number-cell') || td.colSpan > 1) {
            return;
        }

        const tr = td.closest('tr');
        if (!tr || tr.classList.contains('group-header')) return;

        const rowIndex = parseDatasetIndex(tr);
        if (rowIndex === null) return;

        const cellIndex = Array.from(tr.children).indexOf(td);
        if (cellIndex <= 0) return; // Skip row number cell

        const row = table.getRowModel().rows[rowIndex];
        const cell = row?.getVisibleCells?.()[cellIndex - 1];
        const columnDef = cell?.column?.columnDef;
        if (!cell || !columnDef) {
            return;
        }

        const rawValue = cell.getValue();
        const sqlText = formatCellValueForSql(rawValue, columnDef.dataType, columnDef.scale, {
            columnId: cell.column.id,
            inferredNumericKind: columnDef.inferredNumericKind,
            inferredDateInteger: columnDef.inferredDateInteger
        });

        if (sqlText) {
            vscode.postMessage({
                command: 'insertCellContent',
                text: rawValue === null || rawValue === undefined ? 'NULL' : String(rawValue),
                dataType: columnDef.dataType,
                sqlText
            });
        }
    });

    function selectEntireRow(rowIndex: number, tr: Element): void {
        const cells = tr.querySelectorAll('td[data-cell-id]:not(.row-number-cell)');
        cells.forEach((cell, colIndex) => {
            const cellId = `${rowIndex}-${colIndex}`;
            (cell as HTMLElement).dataset.cellId = cellId;
            selectedCells.add(cellId);
            cell.classList.add('selected-cell');
        });
    }

    let autoScrollFrame: number | null = null;
    let currentMouseX = 0;
    let currentMouseY = 0;
    const SCROLL_THRESHOLD = 40;
    const MAX_SCROLL_SPEED = 25;

    function stopAutoScroll() {
        if (autoScrollFrame) {
            cancelAnimationFrame(autoScrollFrame);
            autoScrollFrame = null;
        }
    }

    function handleAutoScroll() {
        if (!isSelecting && !isSelectingRows) {
            stopAutoScroll();
            return;
        }

        const rect = wrapper.getBoundingClientRect();
        const thead = wrapper.querySelector('thead');
        const headerHeight = thead ? thead.offsetHeight : 0;
        let scrollX = 0;
        let scrollY = 0;

        if (currentMouseY < rect.top + headerHeight + SCROLL_THRESHOLD) {
            const distance = rect.top + headerHeight + SCROLL_THRESHOLD - currentMouseY;
            scrollY = -Math.min(MAX_SCROLL_SPEED, distance * 0.5);
        } else if (currentMouseY > rect.bottom - SCROLL_THRESHOLD) {
            const distance = currentMouseY - (rect.bottom - SCROLL_THRESHOLD);
            scrollY = Math.min(MAX_SCROLL_SPEED, distance * 0.5);
        }

        if (currentMouseX < rect.left + SCROLL_THRESHOLD) {
            const distance = rect.left + SCROLL_THRESHOLD - currentMouseX;
            scrollX = -Math.min(MAX_SCROLL_SPEED, distance * 0.5);
        } else if (currentMouseX > rect.right - SCROLL_THRESHOLD) {
            const distance = currentMouseX - (rect.right - SCROLL_THRESHOLD);
            scrollX = Math.min(MAX_SCROLL_SPEED, distance * 0.5);
        }

        if (scrollX !== 0 || scrollY !== 0) {
            wrapper.scrollBy(scrollX, scrollY);
            
            const target = document.elementFromPoint(currentMouseX, currentMouseY);
            if (target) {
                const td = target.closest('td');
                if (td) {
                    if (isSelecting && startCell) {
                        const currentCell = getCellId(td);
                        if (currentCell && currentCell !== endCell) {
                            endCell = currentCell;
                            selectRange(startCell, endCell);
                        }
                    } else if (isSelectingRows && startRow !== null && td.classList.contains('row-number-cell')) {
                        const tr = td.closest('tr');
                        if (tr) {
                            const rowIndex = parseDatasetIndex(tr);
                            if (rowIndex !== null && rowIndex !== endRow) {
                                endRow = rowIndex;
                                selectRowRange(startRow, endRow);
                            }
                        }
                    }
                }
            }
            autoScrollFrame = requestAnimationFrame(handleAutoScroll);
        } else {
            autoScrollFrame = null;
        }
    }

    // Capture mouse outside wrapper if selecting
    const handleDocumentMouseMove = (e: MouseEvent): void => {
        if (!isSelecting && !isSelectingRows) return;
        currentMouseX = e.clientX;
        currentMouseY = e.clientY;
        
        // Still need to calculate target if mouse is outside wrapper
        const target = document.elementFromPoint(currentMouseX, currentMouseY);
        
        // Ensure auto-scroll loop runs even if mouse is outside the wrapper
        if (!autoScrollFrame) {
            autoScrollFrame = requestAnimationFrame(handleAutoScroll);
        }
    };
    
    document.addEventListener('mousemove', handleDocumentMouseMove);

    const handleDocumentMouseUp = () => {
        if (isSelecting || isSelectingRows) {
            isSelecting = false;
            isSelectingRows = false;
            startRow = null;
            endRow = null;
            stopAutoScroll();
        }
    };
    
    document.addEventListener('mouseup', handleDocumentMouseUp);

    wrapper.addEventListener('mousemove', (e) => {
        currentMouseX = e.clientX;
        currentMouseY = e.clientY;

        if (isSelecting && startCell) {
            const currentCell = getCellId(e.target);
            if (currentCell && currentCell !== endCell) {
                endCell = currentCell;
                selectRange(startCell, endCell);
            }
        }

        if (isSelectingRows && startRow !== null) {
            const td = asHtml(e.target)?.closest('td');
            if (td && td.classList.contains('row-number-cell')) {
                const tr = td.closest('tr');
                if (tr) {
                    const rowIndex = parseDatasetIndex(tr);
                    if (rowIndex !== null && rowIndex !== endRow) {
                        endRow = rowIndex;
                        selectRowRange(startRow, endRow);
                    }
                }
            }
        }

        if ((isSelecting || isSelectingRows) && !autoScrollFrame) {
            autoScrollFrame = requestAnimationFrame(handleAutoScroll);
        }
    });

    function handleDocumentKeydown(e: KeyboardEvent): void {
        const target = e.target;
        if (isInputLikeElement(target)) {
            return;
        }

        // Only handle keydown for the currently active grid wrapper
        if (!isCurrentActiveWrapper()) {
            return;
        }

        // F2 — enter cell edit mode (if edit mode is active)
        if (e.key === 'F2') {
            var isEditMode = false;
            try { isEditMode = panelGetIsEditMode(); } catch (_) {}
            if (!isEditMode) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            // Find first selected cell and trigger edit
            if (selectedCells.size > 0) {
                var firstCellId: string | null = null;
                for (var cellId of selectedCells) { firstCellId = cellId; break; }
                if (firstCellId) {
                    var cellEl = queryCell(firstCellId);
                    if (cellEl) {
                        // Trigger dblclick event to start editing
                        var dblEvent = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
                        cellEl.dispatchEvent(dblEvent);
                    }
                }
            }
            return;
        }

        // Ctrl + A (Select All)
        if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            
            requestResultsViewFocus();
            wrapper.focus();
            performSelectAll();

            // Clear browser text selection that may have started
            const selection = window.getSelection();
            if (selection) {
                selection.removeAllRanges();
            }
            return;
        }

        // Shift + Arrow Keys
        if (e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            if (selectedCells.size === 0 && !startCell) {
                return; // Nothing selected to expand from
            }

            e.preventDefault();
            e.stopImmediatePropagation();
            requestResultsViewFocus();
            wrapper.focus();

            // If there's a selection but startCell/endCell are missing 
            // (e.g., selection was made via Ctrl+A or clicking row headers)
            if (!startCell || !endCell) {
                if (selectedCells.size > 0) {
                    const first = Array.from(selectedCells)[0];
                    startCell = first;
                    endCell = first;
                } else {
                    return;
                }
            }

            let [endRow, endCol] = endCell.split('-').map(Number);
            const rows = table.getRowModel().rows;
            const rowCount = rows.length;
            const visibleColsCount = getVisibleColumns().length;
            const isJump = e.ctrlKey || e.metaKey;

            if (e.key === 'ArrowUp') {
                endRow = isJump ? 0 : Math.max(0, endRow - 1);
            } else if (e.key === 'ArrowDown') {
                endRow = isJump ? rowCount - 1 : Math.min(rowCount - 1, endRow + 1);
            } else if (e.key === 'ArrowLeft') {
                endCol = isJump ? 0 : Math.max(0, endCol - 1);
            } else if (e.key === 'ArrowRight') {
                endCol = isJump ? visibleColsCount - 1 : Math.min(visibleColsCount - 1, endCol + 1);
            }

            endCell = `${endRow}-${endCol}`;
            selectRange(startCell, endCell);

            // Clear browser text selection
            const selection = window.getSelection();
            if (selection) {
                selection.removeAllRanges();
            }

            const scrollTargetCell = endCell;
            if (!scrollTargetCell) {
                return;
            }

            // Let the DOM update, then auto-scroll the new end cell into view
            requestAnimationFrame(() => {
                let td = queryCell(scrollTargetCell);
                if (!td) {
                    // Wirtualizacja spowodowała, że komórki nie ma w DOM.
                    // Przewijamy do wiersza używając wirtualizatora.
                    const activeGridIndex = asHtml(document.querySelector('.grid-wrapper.active'))?.dataset?.index;
                    if (activeGridIndex !== undefined) {
                        const grid = getGrid(parseInt(activeGridIndex, 10));
                        if (grid && grid.scrollToIndex) {
                            grid.scrollToIndex(endRow, 'auto');
                            // Spróbuj po chwili pobrać TD i doscrollować też w poziomie, jeśli to był skok poziomy
                            setTimeout(() => {
                                const newTd = queryCell(scrollTargetCell);
                                if (newTd) {
                                    newTd.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
                                }
                            }, 50);
                            return;
                        }
                    }
                }
                
                if (td) {
                    td.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
                }
            });
            return;
        }

        // Plain Arrow Keys (no Shift/Ctrl/Meta) — cancel selection and move cursor one step
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            let anchor;
            if (selectedCells.size > 0) {
                anchor = startCell || endCell || Array.from(selectedCells)[0];
                clearSelection();
            } else {
                anchor = endCell || startCell;
            }

            if (!anchor) return;

            e.preventDefault();
            e.stopImmediatePropagation();

            let [curRow, curCol] = anchor.split('-').map(Number);
            const rowCount = table.getRowModel().rows.length;
            const colCount = getVisibleColumns().length;

            if (e.key === 'ArrowUp') curRow = Math.max(0, curRow - 1);
            else if (e.key === 'ArrowDown') curRow = Math.min(rowCount - 1, curRow + 1);
            else if (e.key === 'ArrowLeft') curCol = Math.max(0, curCol - 1);
            else if (e.key === 'ArrowRight') curCol = Math.min(colCount - 1, curCol + 1);

            selectSingleCell(curRow, curCol);
            return;
        }

        // Ctrl + Arrow Keys (no Shift) — jump to edge of data grid
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            let anchor;
            if (selectedCells.size > 0) {
                anchor = startCell || endCell || Array.from(selectedCells)[0];
                clearSelection();
            } else {
                anchor = endCell || startCell;
            }

            if (!anchor) return;

            e.preventDefault();
            e.stopImmediatePropagation();

            let [curRow, curCol] = anchor.split('-').map(Number);
            const rowCount = table.getRowModel().rows.length;
            const colCount = getVisibleColumns().length;

            if (e.key === 'ArrowUp') curRow = 0;
            else if (e.key === 'ArrowDown') curRow = rowCount - 1;
            else if (e.key === 'ArrowLeft') curCol = 0;
            else if (e.key === 'ArrowRight') curCol = colCount - 1;

            selectSingleCell(curRow, curCol);
            return;
        }
    }

    document.addEventListener('keydown', handleDocumentKeydown, true);

    wrapper.addEventListener('mouseup', () => {
        isSelecting = false;
        isSelectingRows = false;
        startRow = null;
        endRow = null;
    });

    // Context menu handler for cell selection
    wrapper.addEventListener('contextmenu', (e) => {
        const cell = asHtml(e.target)?.closest('td');
        if (!cell) return;

        // Skip context menu on group header rows
        const cellTr = cell.closest('tr');
        if (cellTr && cellTr.classList.contains('group-header')) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        requestResultsViewFocus();
        wrapper.focus();

        // Check if clicking on row number cell
        if (cell.classList.contains('row-number-cell')) {
            const tr = cell.closest('tr');
            if (!tr) return;

            const rowIndex = (tr as HTMLElement).dataset.index;
            if (rowIndex === undefined) return;

            // If there's already a selection, keep it and just show the menu
            if (selectedCells.size === 0) {
                tr.classList.add('row-selected');
                selectEntireRow(parseInt(rowIndex), tr);
                setSelectionContexts(true);
                sendSelectionStats();
            }

            showContextMenu(e.clientX, e.clientY, null, true);
            return;
        }

        // If there's already a selection, keep it and just show the menu
        // Don't modify the selection on right-click (like Excel)
        if (selectedCells.size === 0) {
            // No selection yet, select the cell
            const cellId = getCellId(e.target);
            if (cellId) {
                selectedCells.add(cellId);
                cell.classList.add('selected-cell');
                setSelectionContexts(true);
                sendSelectionStats();
                notifySelectionChanged();
            }
        }

        // Show context menu
        showContextMenu(e.clientX, e.clientY, cell);
    });

    function triggerRender() {
        var rsIdx = parseInt(wrapper.dataset.index ?? '0', 10);
        if (!isNaN(rsIdx)) {
            var grid = getGrid(rsIdx);
            if (grid && grid.render) {
                grid.render();
            }
        }
    }

    function showContextMenu(x: number, y: number, clickedCell: HTMLElement | null, isRowMenu = false) {
        // Close any existing context menu
        const existingMenu = document.querySelector('.grid-context-menu');
        if (existingMenu) {
            existingMenu.remove();
        }

        const menu = document.createElement('div');
        menu.className = 'grid-context-menu';
        menu.style.position = 'fixed';
        menu.style.top = y + 'px';
        menu.style.left = x + 'px';
        menu.style.backgroundColor = 'var(--vscode-menu-background)';
        menu.style.border = '1px solid var(--vscode-menu-border)';
        menu.style.borderRadius = '4px';
        menu.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.3)';
        menu.style.zIndex = '10000';
        menu.style.minWidth = '200px';
        menu.style.padding = '4px 0';

        // ─── Column Actions (from clicked cell) ───
        var colId: string | null = null;
        var column: TanStackColumn | null = null;
        var cellValue: string | null = null;
        var cellRawValue: unknown = null;
        if (clickedCell) {
            var td = clickedCell;
            var tr = td.closest('tr');
            if (tr) {
                var cellIdx = Array.from(tr.children).indexOf(td) - 1; // minus row-number col
                var visibleCols = table.getVisibleLeafColumns();
                if (cellIdx >= 0 && visibleCols[cellIdx]) {
                    column = visibleCols[cellIdx];
                    colId = column.id;
                    // Get raw value from row data (bypass formatted DOM text)
                    var rowIndex = parseDatasetIndex(tr);
                    var allRows = table.getRowModel().rows;
                    if (rowIndex !== null && allRows[rowIndex]) {
                        cellRawValue = allRows[rowIndex].getValue(colId);
                        // Format for display in the menu label
                        var colDef = column.columnDef;
                        cellValue = formatCellValue(cellRawValue, colDef.dataType, colDef.scale, {
                            columnId: colId,
                            inferredNumericKind: colDef.inferredNumericKind,
                            inferredDateInteger: colDef.inferredDateInteger
                        });
                    } else {
                        cellValue = td.textContent;
                    }
                }
            }
        }

        if (colId && column) {
            const menuColId = colId;
            const menuColumn = column;
            // Sort Ascending
            var sortAscItem = createContextMenuItem('Sort Ascending', function () {
                table.setSorting([{ id: menuColId, desc: false }]);
                menu.remove();
                triggerRender();
            });
            menu.appendChild(sortAscItem);

            // Sort Descending
            var sortDescItem = createContextMenuItem('Sort Descending', function () {
                table.setSorting([{ id: menuColId, desc: true }]);
                menu.remove();
                triggerRender();
            });
            menu.appendChild(sortDescItem);

            // Separator
            var colSep1 = document.createElement('div');
            colSep1.style.height = '1px';
            colSep1.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
            colSep1.style.margin = '4px 0';
            menu.appendChild(colSep1);

            // Filter by this value (uses raw value, condition filter format)
            if (cellValue && cellValue !== '' && cellValue !== 'NULL') {
                var filterLabel = 'Filter by "' + cellValue.substring(0, 40) + '"';
                var filterValueItem = createContextMenuItem(filterLabel, function () {
                    var currentFilters = table.getState().columnFilters || [];
                    var withoutCurrent = currentFilters.filter(function (f) { return f.id !== menuColId; });
                    // Use raw value for the condition (avoids formatting issues like thousand separators)
                    var filterCondValue = (cellRawValue !== null && cellRawValue !== undefined) ? cellRawValue : cellValue;
                    table.setColumnFilters(withoutCurrent.concat([{
                        id: menuColId,
                        value: { _isConditionFilter: true, conditions: [{ type: 'equals', value: String(filterCondValue) }], logic: 'and' }
                    }]));
                    menu.remove();
                    triggerRender();
                });
                menu.appendChild(filterValueItem);
            }

            // Clear filter on this column
            var clearFilterItem = createContextMenuItem('Clear Filter', function () {
                var currentFilters = table.getState().columnFilters || [];
                table.setColumnFilters(currentFilters.filter(function (f) { return f.id !== menuColId; }));
                menu.remove();
                triggerRender();
            });
            menu.appendChild(clearFilterItem);

            // Separator
            var colSep2 = document.createElement('div');
            colSep2.style.height = '1px';
            colSep2.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
            colSep2.style.margin = '4px 0';
            menu.appendChild(colSep2);

            // Group by This Column
            var groupItem = createContextMenuItem('Group by This Column', function () {
                var currentGrouping = table.getState().grouping || [];
                if (currentGrouping.indexOf(menuColId) !== -1) {
                    table.setGrouping(currentGrouping.filter(function (g) { return g !== menuColId; }));
                } else {
                    table.setGrouping(currentGrouping.concat([menuColId]));
                }
                menu.remove();
                triggerRender();
            });
            menu.appendChild(groupItem);

            // Hide Column
            var hideItem = createContextMenuItem('Hide Column', function () {
                menuColumn.toggleVisibility(false);
                menu.remove();
                triggerRender();
            });
            menu.appendChild(hideItem);

            // Separator before copy/export
            var colSep3 = document.createElement('div');
            colSep3.style.height = '1px';
            colSep3.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
            colSep3.style.margin = '4px 0';
            menu.appendChild(colSep3);
        }

        // ─── Row Actions (when right-click on row number) ───
        if (isRowMenu && selectedCells.size > 0) {
            var copyRowItem = createContextMenuItem('Copy Row', function () {
                if (typeof getResultPanelWindow().copySelection === 'function') {
                    getResultPanelWindow().copySelection!(false, 'tabbed');
                }
                menu.remove();
            });
            menu.appendChild(copyRowItem);

            var copyRowMdItem = createContextMenuItem('Copy Row as MD', function () {
                if (typeof getResultPanelWindow().copySelectionAsMd === 'function') {
                    getResultPanelWindow().copySelectionAsMd!(true);
                }
                menu.remove();
            });
            menu.appendChild(copyRowMdItem);

            // Delete Row(s) — only in edit mode
            var inEditMode = false;
            try { inEditMode = panelGetIsEditMode(); } catch (_) {}
            if (inEditMode) {
                var sepRow = document.createElement('div');
                sepRow.style.height = '1px';
                sepRow.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
                sepRow.style.margin = '4px 0';
                menu.appendChild(sepRow);

                var rowCount = selectedCells.size > 0 ? new Set(Array.from(selectedCells).map(function (c) { return c.split('-')[0]; })).size : 0;
                var delLabel = rowCount > 1 ? 'Delete ' + rowCount + ' Rows' : 'Delete Row';
                var deleteRowItem = createContextMenuItem(delLabel, function () {
                    // Collect unique row indices from selected cells
                    var rowIndices = new Set<number>();
                    selectedCells.forEach(function (cid) { rowIndices.add(parseInt(cid.split('-')[0])); });
                    rowIndices.forEach(function (ri) {
                        callPanelMethod('markRowForDelete', ri);
                    });
                    menu.remove();
                });
                deleteRowItem.style.color = 'var(--vscode-errorForeground)';
                menu.appendChild(deleteRowItem);
            }

            var rowSep = document.createElement('div');
            rowSep.style.height = '1px';
            rowSep.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
            rowSep.style.margin = '4px 0';
            menu.appendChild(rowSep);
        }

        // Copy as MD option (default format)
        var copyAsMdItem = createContextMenuItem('Copy as MD', function () {
            callPanelMethod('copySelectionAsMd', true);
            menu.remove();
        });
        menu.appendChild(copyAsMdItem);

        // Copy as tabbed with headers option
        var copyTabbedItem = createContextMenuItem('Copy as tabbed with headers', function () {
            callPanelMethod('copySelection', true, 'tabbed');
            menu.remove();
        });
        menu.appendChild(copyTabbedItem);

        // Copy option (tabbed without headers)
        var copyItem = createContextMenuItem('Copy', function () {
            callPanelMethod('copySelection', false, 'tabbed');
            menu.remove();
        });
        menu.appendChild(copyItem);

        var cellDescriptor = clickedCell ? getCellDescriptorFromTd(clickedCell) : null;
        if (cellDescriptor) {
            const descriptor = cellDescriptor;
            var viewValueItem = createContextMenuItem('View Cell Value', function () {
                callPanelMethod('openValueViewer', descriptor);
                menu.remove();
            });
            menu.appendChild(viewValueItem);
        }

        var formattingItem = createContextMenuItem('Result Formatting...', function () {
            callPanelMethod('openResultFormattingPanel', { scope: 'result' });
            menu.remove();
        });
        menu.appendChild(formattingItem);

        var hasSelection = selectedCells.size > 0;

        if (hasSelection && canCreateRangeChart(table, selectedCells)) {
            var chartRangeItem = createChartRangeSubmenuItem(table, selectedCells, menu);
            menu.appendChild(chartRangeItem);

            var chartSeparator = document.createElement('div');
            chartSeparator.style.height = '1px';
            chartSeparator.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
            chartSeparator.style.margin = '4px 0';
            menu.appendChild(chartSeparator);
        }

        // Separator
        var separator1 = document.createElement('div');
        separator1.style.height = '1px';
        separator1.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
        separator1.style.margin = '4px 0';
        menu.appendChild(separator1);

        // Export Selection submenu
        if (hasSelection) {
            var exportSelectionItem = createContextMenuItem('Export Selection to CSV', function () {
                callPanelMethod('exportSelectionToCsv');
                menu.remove();
            });
            menu.appendChild(exportSelectionItem);

            var exportSelectionJsonItem = createContextMenuItem('Export Selection to JSON', function () {
                callPanelMethod('exportSelectionToJson');
                menu.remove();
            });
            menu.appendChild(exportSelectionJsonItem);

            var exportSelectionExcelItem = createContextMenuItem('Export Selection to Excel', function () {
                callPanelMethod('exportSelectionToExcel');
                menu.remove();
            });
            menu.appendChild(exportSelectionExcelItem);

            // Separator
            var separator2 = document.createElement('div');
            separator2.style.height = '1px';
            separator2.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
            separator2.style.margin = '4px 0';
            menu.appendChild(separator2);
        }

        // Export All Visible options
        var exportAllCsvItem = createContextMenuItem('Export All Visible to CSV', function () {
            callPanelMethod('exportAllVisibleToCsv');
            menu.remove();
        });
        menu.appendChild(exportAllCsvItem);

        var exportAllJsonItem = createContextMenuItem('Export All Visible to JSON', function () {
            callPanelMethod('exportAllVisibleToJson');
            menu.remove();
        });
        menu.appendChild(exportAllJsonItem);

        var exportAllExcelItem = createContextMenuItem('Export All Visible to Excel', function () {
            callPanelMethod('exportAllVisibleToExcel');
            menu.remove();
        });
        menu.appendChild(exportAllExcelItem);

        document.body.appendChild(menu);

        // Position menu to stay within viewport
        var menuRect = menu.getBoundingClientRect();
        if (menuRect.right > window.innerWidth) {
            menu.style.left = (window.innerWidth - menuRect.width - 10) + 'px';
        }
        if (menuRect.bottom > window.innerHeight) {
            menu.style.top = (window.innerHeight - menuRect.height - 10) + 'px';
        }

        // Close menu on click outside
        var closeMenu = function (e: MouseEvent) {
            const target = e.target instanceof Node ? e.target : null;
            if (!menu.contains(target) && !asHtml(target)?.closest('.grid-context-submenu')) {
                menu.remove();
                removeOpenSubmenus();
                document.removeEventListener('click', closeMenu);
                document.removeEventListener('contextmenu', closeMenu);
            }
        };

        setTimeout(function () {
            document.addEventListener('click', closeMenu);
            document.addEventListener('contextmenu', closeMenu);
        }, 0);
    }


    function onTableRowsRendered() {
        addCellIds();
        reapplySelectionBorders();
    }

    // Initial setup
    addCellIds();

    function selectColumn(columnIndex: number): void {
        // Clear previous selection first
        _internalClearSelection();

        // Select all cells in the column
        const rows = wrapper.querySelectorAll('tbody tr[data-index]');
        rows.forEach(tr => {
            const rowIndex = (tr as HTMLElement).dataset.index;
            const cellId = `${rowIndex}-${columnIndex}`;
            const cell = tr.querySelector(`td[data-cell-id="${cellId}"]`);
            if (cell) {
                cell.classList.add('selected-cell');
                selectedCells.add(cellId);
            }
        });

        setSelectionContexts(selectedCells.size > 0);

        sendSelectionStats();
        notifySelectionChanged();
    }

    return {
        copySelection: function (withHeaders = false, plainTextFormat) {
            requestResultsViewFocus();

            // Auto-select all if nothing is selected
            if (!isAllSelected && selectedCells.size === 0) {
                performSelectAll();
            }

            void (async () => {
                if (isAllSelected) {
                    await copyAllRowsAsync(table, withHeaders, plainTextFormat, clipboardResolver);
                    return;
                }

                if (selectedCells.size === 0) {
                    return;
                }

                const payload = clipboardResolver
                    ? await buildSelectedClipboardPayloadAsync(table, selectedCells, withHeaders, clipboardResolver)
                    : buildSelectedClipboardPayload(table, selectedCells, withHeaders);
                if (!payload) {
                    return;
                }

                const plainText = resolvePlainText(payload, plainTextFormat);
                writeMultiFormatToClipboard(payload.html, plainText, payload.md, `${selectedCells.size} cells`);
            })();
        },

        copySelectionAsHtml: function () {
            requestResultsViewFocus();

            if (!isAllSelected && selectedCells.size === 0) {
                performSelectAll();
            }

            void (async () => {
                if (isAllSelected) {
                    await copyAllRowsAsHtmlAsync(table, clipboardResolver);
                    return;
                }

                if (selectedCells.size === 0) {
                    return;
                }

                const payload = clipboardResolver
                    ? await buildSelectedClipboardPayloadAsync(table, selectedCells, true, clipboardResolver)
                    : buildSelectedClipboardPayload(table, selectedCells, true);
                if (!payload) {
                    return;
                }

                writeMultiFormatToClipboard(payload.html, payload.text, payload.md, `${selectedCells.size} cells`);
            })();
        },

        copySelectionAsMd: function (withHeaders = true) {
            requestResultsViewFocus();

            if (!isAllSelected && selectedCells.size === 0) {
                performSelectAll();
            }

            void (async () => {
                if (isAllSelected) {
                    await copyAllRowsAsMdAsync(table, withHeaders, clipboardResolver);
                    return;
                }

                if (selectedCells.size === 0) {
                    return;
                }

                const payload = clipboardResolver
                    ? await buildSelectedClipboardPayloadAsync(table, selectedCells, withHeaders, clipboardResolver)
                    : buildSelectedClipboardPayload(table, selectedCells, withHeaders);
                if (!payload) {
                    return;
                }

                vscode.postMessage({
                    command: 'setContext',
                    key: 'netezza.resultsCopyPrimed',
                    value: false,
                });

                writeMultiFormatToClipboard(payload.html, payload.md, payload.md, `${selectedCells.size} cells`);
            })();
        },

        selectAll: function () {
            requestResultsViewFocus();
            performSelectAll();
        },

        clearSelection: clearSelection,

        hasSelection: function () {
            return selectedCells.size > 0;
        },

        selectColumn: selectColumn,

        onTableRowsRendered: onTableRowsRendered,

        destroy: function () {
            if (isDestroyed) {
                return;
            }

            isDestroyed = true;
            document.removeEventListener('keydown', handleDocumentKeydown, true);
        }
    };
}

