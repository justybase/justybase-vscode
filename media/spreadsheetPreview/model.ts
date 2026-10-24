/** Pure state and serialization for the Excel-like file preview. No DOM access here. */

export interface SpreadsheetSheet {
    name: string;
    /** Column labels (A, B, … AA) in display order. */
    columns: string[];
    /** Rows in display order; row 0 is the file's first row. */
    rows: unknown[][];
    /** Data rows included in the payload; the file's first row is not counted. */
    shownRows?: number;
    /** True while the host is still streaming the remaining rows of this sheet. */
    loading?: boolean;
    /** True when the file has more columns than `justybase.filePreview.maxColumns`. */
    columnsTruncated?: boolean;
}

export interface SpreadsheetPreviewData {
    fileName: string;
    fileInfo: string;
    /** Short format label shown as a badge next to the file name, for example CSV. */
    fileKind?: string;
    canAddToWorkspace: boolean;
    /** True for formats the import wizard can read (CSV, TSV, XLSX, XLSB). */
    canImportToDatabase?: boolean;
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
export const ROW_NUMBER_WIDTH = 44;
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

/** Excel-style column label for a zero-based index: 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
    let n = index + 1;
    let label = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        label = String.fromCharCode(65 + rem) + label;
        n = Math.floor((n - 1) / 26);
    }
    return label;
}

/**
 * Excel-style reference for the current selection, as the name box shows it. A whole row or column
 * selection (made from a header) uses `B:B` / `3:5`; a rectangular cell selection always uses
 * `A1:B2`, even when it happens to cover every used row or column.
 */
export function rangeAddress(range: CellRange, kind?: 'rows' | 'columns'): string {
    const startCol = columnName(range.startCol);
    const endCol = columnName(range.endCol);
    if (kind === 'columns') {
        return `${startCol}:${endCol}`;
    }
    if (kind === 'rows') {
        return `${range.startRow + 1}:${range.endRow + 1}`;
    }
    if (range.startRow === range.endRow && range.startCol === range.endCol) {
        return `${startCol}${range.startRow + 1}`;
    }
    return `${startCol}${range.startRow + 1}:${endCol}${range.endRow + 1}`;
}

function columnIndexFromName(name: string): number {
    let value = 0;
    for (const character of name) {
        value = value * 26 + (character.charCodeAt(0) - 64);
    }
    return value - 1;
}

const SINGLE_CELL_ADDRESS = /^([A-Z]{1,3})([1-9][0-9]*)$/;
const CELL_RANGE_ADDRESS = /^([A-Z]{1,3})([1-9][0-9]*):([A-Z]{1,3})([1-9][0-9]*)$/;
const COLUMN_RANGE_ADDRESS = /^([A-Z]{1,3}):([A-Z]{1,3})$/;
const ROW_RANGE_ADDRESS = /^([1-9][0-9]*):([1-9][0-9]*)$/;

/** Whole-row (`3:5`) or whole-column (`B:D`) notation of a typed or header-based selection. */
export function classifyRangeAddress(text: string): 'rows' | 'columns' | null {
    const address = text.trim().replace(/\$/g, '').toUpperCase();
    if (COLUMN_RANGE_ADDRESS.test(address)) {
        return 'columns';
    }
    if (ROW_RANGE_ADDRESS.test(address)) {
        return 'rows';
    }
    return null;
}

/**
 * Parses a name-box entry (`B7`, `$A$1:$B$2`, `A:C`, `1:5`) into a selection, clamped to the
 * sheet. Returns null for anything that is not a cell or range reference.
 */
export function parseRangeAddress(sheet: SpreadsheetSheet, text: string): CellRange | null {
    const address = text.trim().replace(/\$/g, '').toUpperCase();
    if (!address) {
        return null;
    }
    const maxRow = Math.max(0, sheet.rows.length - 1);
    const maxCol = Math.max(0, sheet.columns.length - 1);
    const row = (value: string): number => clamp(Number(value) - 1, 0, maxRow);
    const col = (value: string): number => clamp(columnIndexFromName(value), 0, maxCol);

    const cell = address.match(SINGLE_CELL_ADDRESS);
    if (cell) {
        const ref = { row: row(cell[2]), col: col(cell[1]) };
        return { startRow: ref.row, endRow: ref.row, startCol: ref.col, endCol: ref.col };
    }

    const cells = address.match(CELL_RANGE_ADDRESS);
    if (cells) {
        return normalizeRange(
            { row: row(cells[2]), col: col(cells[1]) },
            { row: row(cells[4]), col: col(cells[3]) },
        );
    }

    const columns = address.match(COLUMN_RANGE_ADDRESS);
    if (columns) {
        const first = col(columns[1]);
        const last = col(columns[2]);
        return { startRow: 0, endRow: maxRow, startCol: Math.min(first, last), endCol: Math.max(first, last) };
    }

    const rows = address.match(ROW_RANGE_ADDRESS);
    if (rows) {
        const first = row(rows[1]);
        const last = row(rows[2]);
        return { startRow: Math.min(first, last), endRow: Math.max(first, last), startCol: 0, endCol: maxCol };
    }

    return null;
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

/** Numeric value of a cell, or null when the cell is text, blank or not a finite number. */
function numericValue(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && isNumericValue(value)) {
        const parsed = Number(value.trim());
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/** Non-empty cells of a selection plus the aggregates Excel shows in its status bar. */
export interface SelectionStats {
    /** Non-empty cells of any type. */
    count: number;
    numericCount: number;
    sum: number;
    /** Null when the selection contains no numbers. */
    average: number | null;
    /** True when the scan stopped at `MAX_STATS_CELLS`. */
    truncated: boolean;
}

/** Caps the work done for Ctrl+A-sized selections; the status bar still reports a count. */
export const MAX_STATS_CELLS = 200_000;

/**
 * Summarizes a selection the way Excel's status bar does: Count covers every non-empty cell,
 * while Sum and Average only use numbers (including numeric text from a CSV).
 */
export function selectionStats(
    sheet: SpreadsheetSheet,
    range: CellRange,
    limit = MAX_STATS_CELLS,
): SelectionStats {
    return selectionStatsForRanges(sheet, [range], limit);
}

/** Same as {@link selectionStats}, for a multi-area selection created with Ctrl+click. */
export function selectionStatsForRanges(
    sheet: SpreadsheetSheet,
    ranges: CellRange[],
    limit = MAX_STATS_CELLS,
): SelectionStats {
    const stats: SelectionStats = { count: 0, numericCount: 0, sum: 0, average: null, truncated: false };
    let visited = 0;
    scan: for (const range of ranges) {
        for (let row = range.startRow; row <= range.endRow; row++) {
            const source = sheet.rows[row] ?? [];
            for (let col = range.startCol; col <= range.endCol; col++) {
                if (visited >= limit) {
                    stats.truncated = true;
                    break scan;
                }
                visited++;
                const value = source[col];
                if (cellText(value) === '') {
                    continue;
                }
                stats.count++;
                const number = numericValue(value);
                if (number !== null) {
                    stats.numericCount++;
                    stats.sum += number;
                }
            }
        }
    }
    if (stats.numericCount > 0) {
        stats.average = stats.sum / stats.numericCount;
    }
    return stats;
}

/** Locale-aware number for the status bar, with Excel-like grouping and bounded decimals. */
export function formatStat(value: number, locale?: string): string {
    return value.toLocaleString(locale, { maximumFractionDigits: 4 });
}

/** How far a text cell may paint over its empty right neighbours, as in Excel. */
export const MAX_OVERFLOW_COLUMNS = 8;

/**
 * Number of cells to the right that a text cell may overflow into. Numbers never overflow,
 * and the run stops at the first non-empty cell or at the last column of the sheet.
 */
export function overflowColumns(
    sheet: SpreadsheetSheet,
    row: number,
    col: number,
    limit = MAX_OVERFLOW_COLUMNS,
): number {
    const value = sheet.rows[row]?.[col];
    if (cellText(value) === '' || isNumericValue(value)) {
        return 0;
    }
    let span = 0;
    while (
        span < limit
        && col + span + 1 < sheet.columns.length
        && cellText(sheet.rows[row]?.[col + span + 1]) === ''
    ) {
        span++;
    }
    return span;
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
