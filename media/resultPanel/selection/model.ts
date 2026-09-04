import type { SelectionStatsProcessor } from './statsWorker.js';

/** Mutable per-grid selection state. Owned by `setupCellSelectionEvents`, shared by selection submodules. */
export interface SelectionModel {
    isSelecting: boolean;
    isSelectingRows: boolean;
    startCell: string | null;
    endCell: string | null;
    startRow: number | null;
    endRow: number | null;
    selectedCells: Set<string>;
    selectedColumnIndex: number | null;
    isAllSelected: boolean;
    isDestroyed: boolean;
    selectionStatsRequestVersion: number;
    selectedColumnFilterKey: string | null;
    selectionStatsProcessor: SelectionStatsProcessor | null;
}

export function createSelectionModel(): SelectionModel {
    return {
        isSelecting: false,
        isSelectingRows: false,
        startCell: null,
        endCell: null,
        startRow: null,
        endRow: null,
        selectedCells: new Set<string>(),
        selectedColumnIndex: null,
        isAllSelected: false,
        isDestroyed: false,
        selectionStatsRequestVersion: 0,
        selectedColumnFilterKey: null,
        selectionStatsProcessor: null,
    };
}

export interface ParsedCellId {
    row: number;
    col: number;
}

export function parseCellId(cellId: string): ParsedCellId | null {
    const parts = cellId.split('-');
    if (parts.length !== 2) {
        return null;
    }
    const row = Number(parts[0]);
    const col = Number(parts[1]);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) {
        return null;
    }
    return { row, col };
}

export function formatCellId(row: number, col: number): string {
    return `${row}-${col}`;
}

export interface SelectionBounds {
    minRow: number;
    maxRow: number;
    minCol: number;
    maxCol: number;
}

/** Bounding rectangle over a set of `row-col` cell ids. Returns null when empty or unparseable. */
export function getSelectionBounds(cells: ReadonlySet<string>): SelectionBounds | null {
    let minRow = Infinity;
    let maxRow = -Infinity;
    let minCol = Infinity;
    let maxCol = -Infinity;
    let found = false;
    cells.forEach(cellId => {
        const parsed = parseCellId(cellId);
        if (!parsed) {
            return;
        }
        found = true;
        if (parsed.row < minRow) {
            minRow = parsed.row;
        }
        if (parsed.row > maxRow) {
            maxRow = parsed.row;
        }
        if (parsed.col < minCol) {
            minCol = parsed.col;
        }
        if (parsed.col > maxCol) {
            maxCol = parsed.col;
        }
    });
    if (!found) {
        return null;
    }
    return { minRow, maxRow, minCol, maxCol };
}

/** Unique row indices referenced by a set of `row-col` cell ids. */
export function getSelectedRowIndices(cells: ReadonlySet<string>): Set<number> {
    const rows = new Set<number>();
    cells.forEach(cellId => {
        const parsed = parseCellId(cellId);
        if (parsed) {
            rows.add(parsed.row);
        }
    });
    return rows;
}

/** Reset identity/selection fields without touching the DOM. DOM cleanup stays in render/operations. */
export function resetSelectionModelState(model: SelectionModel): void {
    model.selectionStatsRequestVersion++;
    model.selectionStatsProcessor?.dispose();
    model.selectionStatsProcessor = null;
    model.selectedColumnFilterKey = null;
    model.isAllSelected = false;
    model.selectedColumnIndex = null;
    model.selectedCells.clear();
}
