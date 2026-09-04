import { asHtml } from '../dom.js';
import { postHostMessage } from '../protocol.js';
import { getGrid } from '../state.js';
import { formatCellValueForSql } from '../utils.js';
import { isInputLikeElement, panelGetIsEditMode, parseDatasetIndex, requestResultsViewFocus } from './interaction.js';
import {
    clearSelection,
    internalClearSelection,
    performSelectAll,
    selectEntireRow,
    selectRange,
    selectRowRange,
    selectSingleCell,
    setSelectionContexts,
    type SelectionOperationsScope,
} from './operations.js';
import { getCellId, getVisibleColumns, isCurrentActiveWrapper, notifySelectionChanged, queryCell } from './render.js';

export interface SelectionEventsScope extends SelectionOperationsScope {
    showMenu: (x: number, y: number, clickedCell: HTMLElement | null, isRowMenu?: boolean) => void;
}

export interface AttachedSelectionEvents {
    dispose: () => void;
}

const vscode = { postMessage: postHostMessage };

export function attachSelectionEvents(scope: SelectionEventsScope): AttachedSelectionEvents {
    const { wrapper, table, selRect, model } = scope;

    function notifyLocal(): void {
        notifySelectionChanged(wrapper, selRect, model);
    }

    // Make wrapper focusable
    wrapper.tabIndex = 0;
    wrapper.style.outline = 'none';

    let autoScrollFrame: number | null = null;
    let currentMouseX = 0;
    let currentMouseY = 0;
    const SCROLL_THRESHOLD = 40;
    const MAX_SCROLL_SPEED = 25;

    function stopAutoScroll(): void {
        if (autoScrollFrame) {
            cancelAnimationFrame(autoScrollFrame);
            autoScrollFrame = null;
        }
    }

    function handleAutoScroll(): void {
        if (!model.isSelecting && !model.isSelectingRows) {
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
                    if (model.isSelecting && model.startCell) {
                        const currentCell = getCellId(td);
                        if (currentCell && currentCell !== model.endCell) {
                            model.endCell = currentCell;
                            selectRange(scope, model.startCell, model.endCell);
                        }
                    } else if (model.isSelectingRows && model.startRow !== null && td.classList.contains('row-number-cell')) {
                        const tr = td.closest('tr');
                        if (tr) {
                            const rowIndex = parseDatasetIndex(tr);
                            if (rowIndex !== null && rowIndex !== model.endRow) {
                                model.endRow = rowIndex;
                                selectRowRange(scope, model.startRow, model.endRow);
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

    function handleMousedown(e: MouseEvent): void {
        const td = asHtml(e.target)?.closest('td');
        if (!td) {
            return;
        }

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

            const rowTr = td.closest('tr');
            if (!rowTr) {
                return;
            }

            const rowIndex = (rowTr as HTMLElement).dataset.index;
            if (rowIndex === undefined) {
                return;
            }

            // If Ctrl/Cmd is held, toggle selection; otherwise clear and select
            if (!e.ctrlKey && !e.metaKey) {
                internalClearSelection(scope);
                // Remove row-selected class from all rows
                wrapper.querySelectorAll('tr.row-selected').forEach(r => r.classList.remove('row-selected'));
            }

            // Toggle row selection
            if (rowTr.classList.contains('row-selected')) {
                rowTr.classList.remove('row-selected');
                // Remove cells from this row from selectedCells
                const cells = rowTr.querySelectorAll('td[data-cell-id]');
                cells.forEach(cell => {
                    const cellId = (cell as HTMLElement).dataset.cellId;
                    if (cellId) {
                        model.selectedCells.delete(cellId);
                        cell.classList.remove('selected-cell');
                    }
                });
            } else {
                rowTr.classList.add('row-selected');
                selectEntireRow(scope, parseInt(rowIndex), rowTr);
            }

            // Enable row drag selection
            model.isSelectingRows = true;
            model.startRow = parseInt(rowIndex);
            model.endRow = model.startRow;

            setSelectionContexts(model.selectedCells.size > 0);
            scope.sendSelectionStats();
            notifyLocal();
            return;
        }

        // Regular cell selection
        model.isSelecting = true;
        model.startCell = getCellId(e.target) ?? null;
        model.endCell = model.startCell;
        e.preventDefault();

        requestResultsViewFocus();
        wrapper.focus();

        // Remove row-selected class when starting cell selection
        wrapper.querySelectorAll('tr.row-selected').forEach(r => r.classList.remove('row-selected'));

        if (!e.ctrlKey && !e.metaKey) {
            internalClearSelection(scope);
        }

        if (model.startCell) {
            model.selectedCells.add(model.startCell);
            const cell = queryCell(wrapper, model.startCell);
            if (cell) {
                cell.classList.add('selected-cell');
            }

            setSelectionContexts(true);
            scope.sendSelectionStats();
            notifyLocal();
        }
    }

    function handleDblclick(e: MouseEvent): void {
        const td = asHtml(e.target)?.closest('td');
        if (!td) {
            return;
        }

        // Only handle double-click on data cells (not row number cells)
        if (td.classList.contains('row-number-cell') || td.colSpan > 1) {
            return;
        }

        const tr = td.closest('tr');
        if (!tr || tr.classList.contains('group-header')) {
            return;
        }

        const rowIndex = parseDatasetIndex(tr);
        if (rowIndex === null) {
            return;
        }

        const cellIndex = Array.from(tr.children).indexOf(td);
        if (cellIndex <= 0) {
            return;
        } // Skip row number cell

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
    }

    // Capture mouse outside wrapper if selecting
    const handleDocumentMouseMove = (e: MouseEvent): void => {
        if (!model.isSelecting && !model.isSelectingRows) {
            return;
        }
        currentMouseX = e.clientX;
        currentMouseY = e.clientY;

        // Ensure auto-scroll loop runs even if mouse is outside the wrapper
        if (!autoScrollFrame) {
            autoScrollFrame = requestAnimationFrame(handleAutoScroll);
        }
    };

    const handleDocumentMouseUp = (): void => {
        if (model.isSelecting || model.isSelectingRows) {
            model.isSelecting = false;
            model.isSelectingRows = false;
            model.startRow = null;
            model.endRow = null;
            stopAutoScroll();
        }
    };

    function handleWrapperMousemove(e: MouseEvent): void {
        currentMouseX = e.clientX;
        currentMouseY = e.clientY;

        if (model.isSelecting && model.startCell) {
            const currentCell = getCellId(e.target);
            if (currentCell && currentCell !== model.endCell) {
                model.endCell = currentCell;
                selectRange(scope, model.startCell, model.endCell);
            }
        }

        if (model.isSelectingRows && model.startRow !== null) {
            const td = asHtml(e.target)?.closest('td');
            if (td && td.classList.contains('row-number-cell')) {
                const tr = td.closest('tr');
                if (tr) {
                    const rowIndex = parseDatasetIndex(tr);
                    if (rowIndex !== null && rowIndex !== model.endRow) {
                        model.endRow = rowIndex;
                        selectRowRange(scope, model.startRow, model.endRow);
                    }
                }
            }
        }

        if ((model.isSelecting || model.isSelectingRows) && !autoScrollFrame) {
            autoScrollFrame = requestAnimationFrame(handleAutoScroll);
        }
    }

    function handleWrapperMouseup(): void {
        model.isSelecting = false;
        model.isSelectingRows = false;
        model.startRow = null;
        model.endRow = null;
    }

    function handleDocumentKeydown(e: KeyboardEvent): void {
        const target = e.target;
        if (isInputLikeElement(target)) {
            return;
        }

        // Only handle keydown for the currently active grid wrapper
        if (!isCurrentActiveWrapper(wrapper, model.isDestroyed)) {
            return;
        }

        // F2 — enter cell edit mode (if edit mode is active)
        if (e.key === 'F2') {
            let isEditMode = false;
            try { isEditMode = panelGetIsEditMode(); } catch { /* panel may be unavailable during teardown */ }
            if (!isEditMode) {
                return;
            }
            e.preventDefault();
            e.stopImmediatePropagation();
            // Find first selected cell and trigger edit
            if (model.selectedCells.size > 0) {
                let firstCellId: string | null = null;
                for (const cellId of model.selectedCells) { firstCellId = cellId; break; }
                if (firstCellId) {
                    const cellEl = queryCell(wrapper, firstCellId);
                    if (cellEl) {
                        // Trigger dblclick event to start editing
                        const dblEvent = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
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
            performSelectAll(scope);

            // Clear browser text selection that may have started
            const selection = window.getSelection();
            if (selection) {
                selection.removeAllRanges();
            }
            return;
        }

        // Shift + Arrow Keys
        if (e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            if (model.selectedCells.size === 0 && !model.startCell) {
                return; // Nothing selected to expand from
            }

            e.preventDefault();
            e.stopImmediatePropagation();
            requestResultsViewFocus();
            wrapper.focus();

            // If there's a selection but startCell/endCell are missing
            // (e.g., selection was made via Ctrl+A or clicking row headers)
            if (!model.startCell || !model.endCell) {
                if (model.selectedCells.size > 0) {
                    const first = Array.from(model.selectedCells)[0];
                    model.startCell = first;
                    model.endCell = first;
                } else {
                    return;
                }
            }

            const endParts = (model.endCell as string).split('-').map(Number);
            let shiftEndRow = endParts[0];
            let shiftEndCol = endParts[1];
            const rows = table.getRowModel().rows;
            const rowCount = rows.length;
            const visibleColsCount = getVisibleColumns(table).length;
            const isJump = e.ctrlKey || e.metaKey;

            if (e.key === 'ArrowUp') {
                shiftEndRow = isJump ? 0 : Math.max(0, shiftEndRow - 1);
            } else if (e.key === 'ArrowDown') {
                shiftEndRow = isJump ? rowCount - 1 : Math.min(rowCount - 1, shiftEndRow + 1);
            } else if (e.key === 'ArrowLeft') {
                shiftEndCol = isJump ? 0 : Math.max(0, shiftEndCol - 1);
            } else if (e.key === 'ArrowRight') {
                shiftEndCol = isJump ? visibleColsCount - 1 : Math.min(visibleColsCount - 1, shiftEndCol + 1);
            }

            model.endCell = `${shiftEndRow}-${shiftEndCol}`;
            selectRange(scope, model.startCell, model.endCell);

            // Clear browser text selection
            const selection = window.getSelection();
            if (selection) {
                selection.removeAllRanges();
            }

            const scrollTargetCell = model.endCell;
            if (!scrollTargetCell) {
                return;
            }

            // Let the DOM update, then auto-scroll the new end cell into view
            requestAnimationFrame(() => {
                const td = queryCell(wrapper, scrollTargetCell);
                if (!td) {
                    // The cell is not in the DOM because virtualization removed it.
                    // Scroll to the row using the virtualizer.
                    const activeGridIndex = asHtml(document.querySelector('.grid-wrapper.active'))?.dataset?.index;
                    if (activeGridIndex !== undefined) {
                        const grid = getGrid(parseInt(activeGridIndex, 10));
                        if (grid && grid.scrollToIndex) {
                            grid.scrollToIndex(shiftEndRow, 'auto');
                            // Retry fetching the TD after a short delay, and scroll horizontally too if this was a horizontal jump
                            setTimeout(() => {
                                const newTd = queryCell(wrapper, scrollTargetCell);
                                if (newTd) {
                                    (newTd as HTMLElement).scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
                                }
                            }, 50);
                            return;
                        }
                    }
                }

                if (td) {
                    (td as HTMLElement).scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
                }
            });
            return;
        }

        // Plain Arrow Keys (no Shift/Ctrl/Meta) — cancel selection and move cursor one step
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            let anchor: string | null | undefined;
            if (model.selectedCells.size > 0) {
                anchor = model.startCell || model.endCell || Array.from(model.selectedCells)[0];
                clearSelection(scope);
            } else {
                anchor = model.endCell || model.startCell;
            }

            if (!anchor) {
                return;
            }

            e.preventDefault();
            e.stopImmediatePropagation();

            let [curRow, curCol] = anchor.split('-').map(Number);
            const rowCount = table.getRowModel().rows.length;
            const colCount = getVisibleColumns(table).length;

            if (e.key === 'ArrowUp') {
                curRow = Math.max(0, curRow - 1);
            } else if (e.key === 'ArrowDown') {
                curRow = Math.min(rowCount - 1, curRow + 1);
            } else if (e.key === 'ArrowLeft') {
                curCol = Math.max(0, curCol - 1);
            } else if (e.key === 'ArrowRight') {
                curCol = Math.min(colCount - 1, curCol + 1);
            }

            selectSingleCell(scope, curRow, curCol);
            return;
        }

        // Ctrl + Arrow Keys (no Shift) — jump to edge of data grid
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            let anchor: string | null | undefined;
            if (model.selectedCells.size > 0) {
                anchor = model.startCell || model.endCell || Array.from(model.selectedCells)[0];
                clearSelection(scope);
            } else {
                anchor = model.endCell || model.startCell;
            }

            if (!anchor) {
                return;
            }

            e.preventDefault();
            e.stopImmediatePropagation();

            let [curRow, curCol] = anchor.split('-').map(Number);
            const rowCount = table.getRowModel().rows.length;
            const colCount = getVisibleColumns(table).length;

            if (e.key === 'ArrowUp') {
                curRow = 0;
            } else if (e.key === 'ArrowDown') {
                curRow = rowCount - 1;
            } else if (e.key === 'ArrowLeft') {
                curCol = 0;
            } else if (e.key === 'ArrowRight') {
                curCol = colCount - 1;
            }

            selectSingleCell(scope, curRow, curCol);
            return;
        }
    }

    function handleContextmenu(e: MouseEvent): void {
        const cell = asHtml(e.target)?.closest('td');
        if (!cell) {
            return;
        }

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
            if (!tr) {
                return;
            }

            const rowIndex = (tr as HTMLElement).dataset.index;
            if (rowIndex === undefined) {
                return;
            }

            // If there's already a selection, keep it and just show the menu
            if (model.selectedCells.size === 0) {
                tr.classList.add('row-selected');
                selectEntireRow(scope, parseInt(rowIndex), tr);
                setSelectionContexts(true);
                scope.sendSelectionStats();
            }

            scope.showMenu(e.clientX, e.clientY, null, true);
            return;
        }

        // If there's already a selection, keep it and just show the menu
        // Don't modify the selection on right-click (like Excel)
        if (model.selectedCells.size === 0) {
            // No selection yet, select the cell
            const cellId = getCellId(e.target);
            if (cellId) {
                model.selectedCells.add(cellId);
                cell.classList.add('selected-cell');
                setSelectionContexts(true);
                scope.sendSelectionStats();
                notifyLocal();
            }
        }

        // Show context menu
        scope.showMenu(e.clientX, e.clientY, cell as unknown as HTMLElement);
    }

    wrapper.addEventListener('mousedown', handleMousedown as EventListener);
    wrapper.addEventListener('dblclick', handleDblclick as EventListener);
    wrapper.addEventListener('mousemove', handleWrapperMousemove as EventListener);
    wrapper.addEventListener('mouseup', handleWrapperMouseup as EventListener);
    wrapper.addEventListener('contextmenu', handleContextmenu as EventListener);
    document.addEventListener('mousemove', handleDocumentMouseMove);
    document.addEventListener('mouseup', handleDocumentMouseUp);
    document.addEventListener('keydown', handleDocumentKeydown, true);

    return {
        dispose: () => {
            stopAutoScroll();
            wrapper.removeEventListener('mousedown', handleMousedown as EventListener);
            wrapper.removeEventListener('dblclick', handleDblclick as EventListener);
            wrapper.removeEventListener('mousemove', handleWrapperMousemove as EventListener);
            wrapper.removeEventListener('mouseup', handleWrapperMouseup as EventListener);
            wrapper.removeEventListener('contextmenu', handleContextmenu as EventListener);
            document.removeEventListener('mousemove', handleDocumentMouseMove);
            document.removeEventListener('mouseup', handleDocumentMouseUp);
            document.removeEventListener('keydown', handleDocumentKeydown, true);
        },
    };
}
