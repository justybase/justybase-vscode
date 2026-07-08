import { formatCellValue } from '../utils.js';
import type { SavedGridState } from './persistence.js';
import type {
    AutoColumnWidthOptions,
    MeasureTextFn,
    ResultColumnDef,
    ResultSet,
} from '../types.js';
import type { GridColumnDef, GridTableState } from './types.js';

export const RESULT_GRID_MAX_AUTO_COLUMN_WIDTH = 600;
export const RESULT_GRID_MAX_AUTO_SIZE_ROWS = 10000;
export const RESULT_GRID_INIT_AUTO_SIZE_ROWS = 1000;
export const RESULT_GRID_AUTO_WIDTH_SAMPLE_STEP = 10;
export const RESULT_GRID_VIRTUAL_OVERSCAN = 12;
/** Initial virtualizer estimate; actual row height is measured at runtime via measureElement. */
export const RESULT_GRID_ESTIMATED_ROW_HEIGHT = 30;
export const RESULT_GRID_ROW_NUMBER_MIN_DIGITS = 7;

/** Aborted when renderGrids() runs again or the user switches result sets. */
let activeGridInitController: AbortController | null = null;

export function beginGridInit(): AbortSignal {
    if (activeGridInitController) {
        activeGridInitController.abort();
    }
    activeGridInitController = new AbortController();
    return activeGridInitController.signal;
}

export function getGridInitSignal(): AbortSignal | undefined {
    return activeGridInitController?.signal;
}

function yieldToMain(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            if (signal?.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
            } else {
                resolve(undefined);
            }
        }, 0);
    });
}

const RESULT_GRID_ROW_NUMBER_MIN_WIDTH = 50;
const RESULT_GRID_ROW_NUMBER_PADDING = 24;
const RESULT_GRID_CELL_HORIZONTAL_PADDING = 16;
const RESULT_GRID_CELL_HORIZONTAL_BORDERS = 2;
// Header controls: 6 buttons (22px each = 132px) + drag handle (15px) + type badge (45px) = ~192px
const RESULT_GRID_HEADER_CONTROL_WIDTH = 192;
const RESULT_GRID_CELL_EXTRA_WIDTH = RESULT_GRID_CELL_HORIZONTAL_PADDING + RESULT_GRID_CELL_HORIZONTAL_BORDERS;
const RESULT_GRID_HEADER_EXTRA_WIDTH = RESULT_GRID_CELL_EXTRA_WIDTH + RESULT_GRID_HEADER_CONTROL_WIDTH;

function normalizeMeasuredCellText(value: unknown): string {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function createGridTextMeasurer(): MeasureTextFn {
    try {
        const measureCanvas = document.createElement('canvas');
        const measureCtx = measureCanvas.getContext('2d');
        const bodyStyle = window.getComputedStyle(document.body);
        const rootStyle = window.getComputedStyle(document.documentElement);
        const fontSize = bodyStyle.fontSize || '13px';
        const fontFamily = rootStyle.getPropertyValue('--justybase-results-grid-font-family').trim()
            || rootStyle.getPropertyValue('--vscode-editor-font-family').trim()
            || 'Consolas, monospace';

        if (measureCtx) {
            measureCtx.font = `${fontSize} ${fontFamily}`;
            return (text: string) => measureCtx.measureText(normalizeMeasuredCellText(text)).width;
        }
    } catch (e) {
        console.error('Error creating text measurer:', e);
    }

    return (text: string) => normalizeMeasuredCellText(text).length * 8;
}

export function calculateRowNumberColumnWidth(rowCount: number, measureText: MeasureTextFn): number {
    const digits = Math.max(
        RESULT_GRID_ROW_NUMBER_MIN_DIGITS,
        String(Math.max(1, rowCount || 0)).length
    );
    const contentWidth = measureText('9'.repeat(digits));
    return Math.max(
        RESULT_GRID_ROW_NUMBER_MIN_WIDTH,
        Math.ceil(contentWidth + RESULT_GRID_ROW_NUMBER_PADDING)
    );
}

export function calculateAutoHeaderWidth(column: ResultColumnDef, measureText: MeasureTextFn): number {
    return Math.ceil(measureText(column.header) + RESULT_GRID_HEADER_EXTRA_WIDTH);
}

export function calculateAutoColumnWidth(
    column: ResultColumnDef & { id?: string; scale?: number; accessorFn?: (row: unknown) => unknown },
    rows: unknown[][],
    measureText: MeasureTextFn,
    options: AutoColumnWidthOptions = {},
): number {
    const maxRows = Math.min(rows.length, options.maxRows ?? RESULT_GRID_MAX_AUTO_SIZE_ROWS);
    const sampleStep = Math.max(1, options.sampleStep ?? (
        maxRows > RESULT_GRID_INIT_AUTO_SIZE_ROWS ? RESULT_GRID_AUTO_WIDTH_SAMPLE_STEP : 1
    ));
    const headerWidth = options.headerWidth ?? calculateAutoHeaderWidth(column, measureText);
    let maxWidth = Math.max(headerWidth, options.initialWidth ?? 0);

    for (let i = 0; i < maxRows; i += sampleStep) {
        const accessorFn = column.accessorFn;
        if (!accessorFn) {
            continue;
        }
        const value = accessorFn(rows[i]);
        if (value === null || value === undefined) {
            continue;
        }

        const displayValue = formatCellValue(value, column.dataType, column.scale, {
            columnId: column.id,
            inferredNumericKind: column.inferredNumericKind,
            inferredDateInteger: column.inferredDateInteger
        });
        const measuredWidth = measureText(displayValue ?? '') + RESULT_GRID_CELL_EXTRA_WIDTH;
        if (measuredWidth > maxWidth) {
            maxWidth = measuredWidth;
        }
    }

    return Math.min(Math.ceil(maxWidth), RESULT_GRID_MAX_AUTO_COLUMN_WIDTH);
}

export function initializeColumnWidths(
    columns: GridColumnDef[],
    rs: ResultSet,
    savedState: SavedGridState | null | undefined,
    measureText: MeasureTextFn,
): Map<string, number> {
    let columnWidths = new Map<string, number>();
    if (savedState && savedState.columnWidths) {
        try {
            columnWidths = new Map(savedState.columnWidths);
        } catch (e) {
            console.error('Error restoring column widths', e);
        }
    }

    const initRowSample = rs.data.slice(0, Math.min(rs.data.length, RESULT_GRID_INIT_AUTO_SIZE_ROWS));

    try {
        columns.forEach((col: GridColumnDef) => {
            if (!columnWidths.has(col.id)) {
                columnWidths.set(col.id, calculateAutoColumnWidth(col, initRowSample, measureText, {
                    maxRows: initRowSample.length
                }));
            }
        });
    } catch (e) {
        console.error('Error calculating column widths:', e);
    }

    return columnWidths;
}

export async function scheduleDeferredColumnWidthInit(
    columns: GridColumnDef[],
    rs: ResultSet,
    columnWidths: Map<string, number>,
    manualColumnWidths: Set<string>,
    measureText: MeasureTextFn,
    onLayoutChanged: () => void,
): Promise<void> {
    const signal = getGridInitSignal();
    if (!signal || rs.data.length <= RESULT_GRID_INIT_AUTO_SIZE_ROWS) {
        return;
    }

    try {
        const remainingRows = rs.data.slice(RESULT_GRID_INIT_AUTO_SIZE_ROWS);
        for (const col of columns) {
            if (signal.aborted) {
                return;
            }
            if (manualColumnWidths.has(col.id)) {
                continue;
            }

            const currentWidth = columnWidths.get(col.id) || calculateAutoColumnWidth(col, [], measureText);
            const nextWidth = calculateAutoColumnWidth(col, remainingRows, measureText, {
                initialWidth: currentWidth,
                maxRows: remainingRows.length
            });

            if (nextWidth !== currentWidth) {
                columnWidths.set(col.id, nextWidth);
                onLayoutChanged();
            }

            await yieldToMain(signal);
        }
    } catch (error: unknown) {
        const errorName = error instanceof Error ? error.name : undefined;
        if (errorName !== 'AbortError') {
            console.error('Deferred column width init failed:', error);
        }
    }
}

export function initializeTableState(savedState: SavedGridState | null | undefined): GridTableState {
    return {
        sorting: Array.isArray(savedState?.sorting) ? savedState.sorting as GridTableState['sorting'] : [],
        globalFilter: typeof savedState?.globalFilter === 'string' ? savedState.globalFilter : '',
        grouping: Array.isArray(savedState?.grouping) ? savedState.grouping as string[] : [],
        expanded: savedState?.expanded && typeof savedState.expanded === 'object'
            ? savedState.expanded as Record<string, boolean>
            : {},
        columnOrder: Array.isArray(savedState?.columnOrder) ? savedState.columnOrder as string[] : null,
        columnFilters: Array.isArray(savedState?.columnFilters)
            ? savedState.columnFilters as GridTableState['columnFilters']
            : [],
        columnPinning: savedState?.columnPinning && typeof savedState.columnPinning === 'object'
            ? savedState.columnPinning as GridTableState['columnPinning']
            : { left: [], right: [] },
        columnVisibility: savedState?.columnVisibility && typeof savedState.columnVisibility === 'object'
            ? savedState.columnVisibility as Record<string, boolean>
            : {},
        pinnedColumns: Array.isArray(savedState?.pinnedColumns) ? savedState.pinnedColumns : []
    };
}

export function calculatePinnedColumnLeft(
    colId: string,
    pinnedColumns: string[],
    columnWidths: Map<string, number>,
): number {
    const colIndex = pinnedColumns.indexOf(colId);
    if (colIndex <= 0) return 0;

    let leftOffset = 0;
    for (let i = 0; i < colIndex; i++) {
        const prevColId = pinnedColumns[i];
        leftOffset += columnWidths.get(prevColId) || 100;
    }
    return leftOffset;
}
