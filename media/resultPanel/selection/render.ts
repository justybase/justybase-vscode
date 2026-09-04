import { asHtml } from '../dom.js';
import { getGrid } from '../state.js';
import type { CellDescriptor, TanStackColumn, TanStackTable } from '../types.js';
import type { SelectionModel } from './model.js';

export function queryCell(wrapper: HTMLElement, cellId: string): Element | null {
    return wrapper.querySelector(`[data-cell-id="${cellId}"]`);
}

export function isCurrentActiveWrapper(wrapper: HTMLElement, isDestroyed: boolean): boolean {
    return !isDestroyed
        && wrapper.isConnected
        && wrapper === document.querySelector('.grid-wrapper.active')
        && wrapper.style.display !== 'none';
}

export function scrollCellIntoView(wrapper: HTMLElement, td: Element): void {
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

export function updateSelectionBorder(wrapper: HTMLElement, selRect: HTMLElement, model: SelectionModel): void {
    wrapper.querySelectorAll('.anchor-cell').forEach(el => el.classList.remove('anchor-cell'));
    selRect.style.display = 'none';

    if (model.selectedCells.size === 0) {
        return;
    }

    // Position outer selection rectangle
    let minRow = Infinity, maxRow = -Infinity, minCol = Infinity, maxCol = -Infinity;
    model.selectedCells.forEach(cellId => {
        const [r, c] = cellId.split('-').map(Number);
        if (r < minRow) {
            minRow = r;
        }
        if (r > maxRow) {
            maxRow = r;
        }
        if (c < minCol) {
            minCol = c;
        }
        if (c > maxCol) {
            maxCol = c;
        }
    });

    const firstCell = queryCell(wrapper, `${minRow}-${minCol}`);
    const lastCell = queryCell(wrapper, `${maxRow}-${maxCol}`);

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
    if (model.startCell) {
        const anchorEl = queryCell(wrapper, model.startCell);
        if (anchorEl) {
            anchorEl.classList.add('anchor-cell');
        }
    }
}

export function notifySelectionChanged(wrapper: HTMLElement, selRect: HTMLElement, model: SelectionModel): void {
    updateSelectionBorder(wrapper, selRect, model);
    window.dispatchEvent(new CustomEvent('result-panel-selection-changed'));
}

export function reapplySelectionBorders(wrapper: HTMLElement, selRect: HTMLElement, model: SelectionModel): void {
    if (model.selectedColumnIndex !== null) {
        return;
    }
    if (model.selectedCells.size === 0) {
        return;
    }

    model.selectedCells.forEach(cellId => {
        const cell = queryCell(wrapper, cellId);
        if (cell && !cell.classList.contains('selected-cell')) {
            cell.classList.add('selected-cell');
        }
    });

    updateSelectionBorder(wrapper, selRect, model);
}

export function addCellIds(wrapper: HTMLElement, model: SelectionModel): void {
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
                    if (model.isAllSelected || model.selectedColumnIndex === dataCellIndex || model.selectedCells.has(cellId)) {
                        td.classList.add('selected-cell');
                    } else {
                        td.classList.remove('selected-cell');
                    }
                }
            });
        }
    });
}

export function triggerRender(wrapper: HTMLElement): void {
    const rsIdx = parseInt(wrapper.dataset.index ?? '0', 10);
    if (!isNaN(rsIdx)) {
        const grid = getGrid(rsIdx);
        if (grid && grid.render) {
            grid.render();
        }
    }
}

export function getVisibleColumns(table: TanStackTable): TanStackColumn[] {
    return table.getVisibleLeafColumns().filter(col => !col.columnDef?.isRowNumber);
}

export function getCellId(element: EventTarget | null): string | null {
    const td = asHtml(element)?.closest('td');
    if (!td) {
        return null;
    }

    const tr = td.closest('tr');
    if (!tr) {
        return null;
    }

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

export function getCellDescriptorFromTd(table: TanStackTable, td: Element): CellDescriptor | null {
    const tr = td.closest('tr');
    if (!tr) {
        return null;
    }

    const rowIndexStr = (tr as HTMLElement).dataset.index;
    if (!rowIndexStr) {
        return null;
    }

    const rowIndex = parseInt(rowIndexStr, 10);
    if (Number.isNaN(rowIndex)) {
        return null;
    }

    const cellIndex = Array.from(tr.children).indexOf(td);
    if (cellIndex <= 0) {
        return null;
    }

    const visibleColumns = getVisibleColumns(table);
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
