import type { SelectionStatsProcessor } from './statsWorker.js';
import {
    formatGridCellId,
    getGridSelectionBounds,
    getSelectedGridRowIndices,
    parseGridCellId,
} from '@justybase/ui-core';

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

export interface SelectionBounds {
    minRow: number;
    maxRow: number;
    minCol: number;
    maxCol: number;
}

// Legacy names stay stable for the DOM grid and its tests; the implementation
// now lives in the renderer-neutral @justybase/ui-core module.
export function parseCellId(cellId: string): ParsedCellId | null {
    const parsed = parseGridCellId(cellId);
    return parsed ? { row: parsed.row, col: parsed.column } : null;
}

export const formatCellId = formatGridCellId;

export function getSelectionBounds(cells: ReadonlySet<string>): SelectionBounds | null {
    const bounds = getGridSelectionBounds(cells);
    return bounds
        ? { minRow: bounds.minRow, maxRow: bounds.maxRow, minCol: bounds.minColumn, maxCol: bounds.maxColumn }
        : null;
}

export const getSelectedRowIndices = getSelectedGridRowIndices;

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
