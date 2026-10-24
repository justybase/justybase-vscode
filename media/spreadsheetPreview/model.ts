/** Pure state and serialization for the Excel-like file preview. No DOM access here. */

export interface SpreadsheetSheet {
    name: string;
    /** Column labels (A, B, … AA) in display order. */
    columns: string[];
    /** Rows in display order; row 0 is the file's first row. */
    rows: unknown[][];
}

export interface SpreadsheetPreviewData {
    fileName: string;
    fileInfo: string;
    limitReached: boolean;
    maxRows: number;
    canAddToWorkspace: boolean;
    sheets: SpreadsheetSheet[];
}

export interface CellRef {
    row: number;
    col: number;
}

export interface CellRange {
    startRow: number;
    endRow: number;
    startCol: number;
    endCol: number;
}

export const ROW_HEIGHT = 20;
export const HEADER_HEIGHT = 20;
export const COLUMN_WIDTH = 96;
export const ROW_NUMBER_WIDTH = 52;
export const MIN_COLUMN_WIDTH = 40;
export const MAX_COLUMN_WIDTH = 800;

/** Whole-pixel width kept inside the resize limits. */
export function clampColumnWidth(width: number): number {
    return clamp(Math.round(width), MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
}

/** Left edge of a data column (in px, from the left of the table), given every column's width. */
export function columnStart(widths: number[], col: number): number {
    let start = ROW_NUMBER_WIDTH;
    for (let i = 0; i < col; i++) {
        start += widths[i];
    }
    return start;
}

/** Total table width: the row-number column plus every data column. */
export function tableWidth(widths: number[]): number {
    return columnStart(widths, widths.length);
}

export function normalizeRange(anchor: CellRef, focus: CellRef): CellRange {
    return {
        startRow: Math.min(anchor.row, focus.row),
        endRow: Math.max(anchor.row, focus.row),
        startCol: Math.min(anchor.col, focus.col),
        endCol: Math.max(anchor.col, focus.col),
    };
}

export function isCellInRange(range: CellRange | null, row: number, col: number): boolean {
    return range !== null
        && row >= range.startRow && row <= range.endRow
        && col >= range.startCol && col <= range.endCol;
}

export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** Excel-style address of a cell, for example B7. */
export function addressOf(sheet: SpreadsheetSheet, ref: CellRef): string {
    const column = sheet.columns[ref.col] ?? '';
    return `${column}${ref.row + 1}`;
}

/** Full display text of a cell; empty cells are blank, as in Excel. */
export function cellText(value: unknown): string {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value);
}

const NUMERIC_TEXT = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

/** CSV values arrive as text; numbers in them are right-aligned, as Excel does after opening a CSV. */
export function isNumericValue(value: unknown): boolean {
    return typeof value === 'number' || (typeof value === 'string' && NUMERIC_TEXT.test(value.trim()));
}

/**
 * Tab-separated text for a range, quoting fields that contain tabs, line breaks or quotes
 * the same way Excel does, so pasting into a spreadsheet keeps the grid shape.
 */
export function rangeToTsv(sheet: SpreadsheetSheet, range: CellRange): string {
    const lines: string[] = [];
    for (let row = range.startRow; row <= range.endRow; row++) {
        const source = sheet.rows[row] ?? [];
        const fields: string[] = [];
        for (let col = range.startCol; col <= range.endCol; col++) {
            fields.push(tsvField(cellText(source[col])));
        }
        lines.push(fields.join('\t'));
    }
    return lines.join('\n');
}

function tsvField(text: string): string {
    if (/[\t\r\n"]/.test(text)) {
        return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
}

/** Rows that must be in the DOM for the given scroll position (overscan keeps fast scrolling smooth). */
export function visibleRowRange(
    scrollTop: number,
    viewportHeight: number,
    rowCount: number,
    overscan = 12,
): { start: number; end: number } {
    if (rowCount <= 0) {
        return { start: 0, end: 0 };
    }
    const first = Math.floor(Math.max(0, scrollTop) / ROW_HEIGHT);
    const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportHeight)) / ROW_HEIGHT);
    return {
        start: clamp(first - overscan, 0, rowCount),
        end: clamp(last + overscan, 0, rowCount),
    };
}

/** Moves the active cell by a key direction, staying inside the sheet. */
export function moveCell(sheet: SpreadsheetSheet, ref: CellRef, key: string): CellRef {
    const maxRow = Math.max(0, sheet.rows.length - 1);
    const maxCol = Math.max(0, sheet.columns.length - 1);
    switch (key) {
        case 'ArrowUp': return { row: clamp(ref.row - 1, 0, maxRow), col: ref.col };
        case 'ArrowDown': return { row: clamp(ref.row + 1, 0, maxRow), col: ref.col };
        case 'ArrowLeft': return { row: ref.row, col: clamp(ref.col - 1, 0, maxCol) };
        case 'ArrowRight': return { row: ref.row, col: clamp(ref.col + 1, 0, maxCol) };
        default: return ref;
    }
}

const ARROW_STEPS: Record<string, { dRow: number; dCol: number }> = {
    ArrowUp: { dRow: -1, dCol: 0 },
    ArrowDown: { dRow: 1, dCol: 0 },
    ArrowLeft: { dRow: 0, dCol: -1 },
    ArrowRight: { dRow: 0, dCol: 1 },
};

/**
 * Ctrl+arrow, as in Excel: from a data cell, stop at the last cell of the current block of data;
 * from a blank cell, or when the next cell is blank, go to the next data cell, or to the sheet edge.
 */
export function jumpToEdge(sheet: SpreadsheetSheet, ref: CellRef, key: string): CellRef {
    const step = ARROW_STEPS[key];
    if (!step) {
        return ref;
    }
    const maxRow = sheet.rows.length - 1;
    const maxCol = sheet.columns.length - 1;
    const inside = (row: number, col: number): boolean => row >= 0 && row <= maxRow && col >= 0 && col <= maxCol;
    const isBlank = (row: number, col: number): boolean => cellText(sheet.rows[row]?.[col]) === '';

    let row = ref.row + step.dRow;
    let col = ref.col + step.dCol;
    if (!inside(row, col)) {
        return ref;
    }
    if (!isBlank(ref.row, ref.col) && !isBlank(row, col)) {
        while (inside(row + step.dRow, col + step.dCol) && !isBlank(row + step.dRow, col + step.dCol)) {
            row += step.dRow;
            col += step.dCol;
        }
        return { row, col };
    }
    let last: CellRef = { row, col };
    while (inside(row, col)) {
        if (!isBlank(row, col)) {
            return { row, col };
        }
        last = { row, col };
        row += step.dRow;
        col += step.dCol;
    }
    return last;
}

/** Index of the data column under an x offset measured from the left edge of the first data column. */
export function columnAt(widths: number[], offset: number): number {
    let start = 0;
    for (let i = 0; i < widths.length; i++) {
        if (offset < start + widths[i]) {
            return i;
        }
        start += widths[i];
    }
    return Math.max(0, widths.length - 1);
}

/**
 * Scroll step per frame while drag-selecting near a visible edge: 0 away from the edges,
 * faster the closer the pointer gets to (or past) the edge. `min`/`max` are the visible bounds.
 */
export function edgeScrollStep(pointer: number, min: number, max: number, zone = 24): number {
    const before = min + zone - pointer;
    if (before > 0) {
        return -Math.min(40, Math.ceil(before / 2));
    }
    const after = pointer - (max - zone);
    if (after > 0) {
        return Math.min(40, Math.ceil(after / 2));
    }
    return 0;
}

/** Stops a search from materialising an unbounded match list on huge sheets. */
export const MAX_SEARCH_MATCHES = 10000;

/** Separates cells inside one indexed row; a query can never contain it, so matches cannot span cells. */
const SEARCH_CELL_SEPARATOR = '\u0001';

/**
 * One lowercase string per row, so a whole-sheet search is a cheap substring test per row and only
 * matching rows are examined cell by cell. Built once per sheet and reused for every query.
 */
export function buildSearchIndex(sheet: SpreadsheetSheet): string[] {
    return sheet.rows.map(row => row.map(value => cellText(value).toLowerCase()).join(SEARCH_CELL_SEPARATOR));
}

export interface SearchResult {
    cells: CellRef[];
    truncated: boolean;
}

/** Case-insensitive search across every row of the sheet, in reading order; a blank query matches nothing. */
export function findCells(
    sheet: SpreadsheetSheet,
    index: string[],
    query: string,
    limit = MAX_SEARCH_MATCHES,
): SearchResult {
    const needle = query.toLowerCase();
    const cells: CellRef[] = [];
    if (needle.trim() === '') {
        return { cells, truncated: false };
    }
    const width = sheet.columns.length;
    for (let row = 0; row < index.length; row++) {
        if (index[row].indexOf(needle) === -1) {
            continue;
        }
        const source = sheet.rows[row];
        for (let col = 0; col < width; col++) {
            if (!cellText(source[col]).toLowerCase().includes(needle)) {
                continue;
            }
            if (cells.length >= limit) {
                return { cells, truncated: true };
            }
            cells.push({ row, col });
        }
    }
    return { cells, truncated: false };
}

/** Next or previous match index, wrapping at both ends. A current index of -1 means no match is active yet. */
export function stepMatch(current: number, count: number, step: 1 | -1): number {
    if (count === 0) {
        return -1;
    }
    if (current < 0) {
        return step === 1 ? 0 : count - 1;
    }
    return (current + step + count) % count;
}
