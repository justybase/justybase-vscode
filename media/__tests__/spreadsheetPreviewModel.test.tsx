import {
    addressOf,
    buildSearchIndex,
    clampColumnWidth,
    classifyRangeAddress,
    columnAt,
    columnStart,
    edgeScrollStep,
    findCells,
    formatStat,
    isCellInRange,
    isNumericValue,
    jumpToEdge,
    MAX_COLUMN_WIDTH,
    MIN_COLUMN_WIDTH,
    moveCell,
    normalizeRange,
    overflowColumns,
    parseRangeAddress,
    rangeAddress,
    rangeToTsv,
    ROW_NUMBER_WIDTH,
    selectionStats,
    selectionStatsForRanges,
    stepMatch,
    tableWidth,
    visibleRowRange,
    type SpreadsheetSheet,
} from '../spreadsheetPreview/model.js';

const sheet: SpreadsheetSheet = {
    name: 'Sheet1',
    columns: ['A', 'B', 'C'],
    rows: [
        ['id', 'name', 'note'],
        [1, 'Ada', null],
        [2, 'Grace, Hopper', 'line one\nline two'],
        [3, 'He said "hi"', 'x'],
    ],
};

describe('spreadsheet preview model', () => {
    it('labels the active cell with its column letter and file row', () => {
        expect(addressOf(sheet, { row: 0, col: 0 })).toBe('A1');
        expect(addressOf(sheet, { row: 2, col: 1 })).toBe('B3');
    });

    it('normalizes a range drawn in any direction', () => {
        expect(normalizeRange({ row: 3, col: 2 }, { row: 1, col: 0 })).toEqual({
            startRow: 1, endRow: 3, startCol: 0, endCol: 2,
        });
        const range = normalizeRange({ row: 1, col: 1 }, { row: 2, col: 2 });
        expect(isCellInRange(range, 2, 2)).toBe(true);
        expect(isCellInRange(range, 0, 1)).toBe(false);
        expect(isCellInRange(null, 0, 0)).toBe(false);
    });

    it('labels the selection in the name box the way Excel does', () => {
        expect(rangeAddress(normalizeRange({ row: 0, col: 0 }, { row: 0, col: 0 }))).toBe('A1');
        expect(rangeAddress(normalizeRange({ row: 0, col: 0 }, { row: 1, col: 1 }))).toBe('A1:B2');
        expect(rangeAddress(normalizeRange({ row: 1, col: 1 }, { row: 0, col: 0 }))).toBe('A1:B2');
        expect(rangeAddress(normalizeRange({ row: 0, col: 0 }, { row: 3, col: 2 }))).toBe('A1:C4');
        // Header selections use whole-column/row notation; a rectangle covering the same cells does not.
        expect(rangeAddress(normalizeRange({ row: 0, col: 1 }, { row: 3, col: 1 }), 'columns')).toBe('B:B');
        expect(rangeAddress(normalizeRange({ row: 2, col: 0 }, { row: 2, col: 2 }), 'rows')).toBe('3:3');
        expect(rangeAddress(normalizeRange({ row: 0, col: 1 }, { row: 3, col: 1 }))).toBe('B1:B4');
    });

    it('recognizes whole-column and whole-row notation typed in the name box', () => {
        expect(classifyRangeAddress('B:D')).toBe('columns');
        expect(classifyRangeAddress('$B:$D')).toBe('columns');
        expect(classifyRangeAddress('2:5')).toBe('rows');
        expect(classifyRangeAddress('A1:B2')).toBeNull();
        expect(classifyRangeAddress('B2')).toBeNull();
    });

    it('parses typed cell and range references from the name box', () => {
        expect(parseRangeAddress(sheet, 'B2')).toEqual({ startRow: 1, endRow: 1, startCol: 1, endCol: 1 });
        expect(parseRangeAddress(sheet, 'a1:c3')).toEqual({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 });
        expect(parseRangeAddress(sheet, '$B$2:$C$3')).toEqual({ startRow: 1, endRow: 2, startCol: 1, endCol: 2 });
        expect(parseRangeAddress(sheet, 'C3:A1')).toEqual({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 });
        expect(parseRangeAddress(sheet, 'B:B')).toEqual({ startRow: 0, endRow: 3, startCol: 1, endCol: 1 });
        expect(parseRangeAddress(sheet, '2:3')).toEqual({ startRow: 1, endRow: 2, startCol: 0, endCol: 2 });
    });

    it('clamps typed references to the sheet and rejects non-references', () => {
        expect(parseRangeAddress(sheet, 'Z99')).toEqual({ startRow: 3, endRow: 3, startCol: 2, endCol: 2 });
        expect(parseRangeAddress(sheet, 'A0')).toBeNull();
        expect(parseRangeAddress(sheet, 'not a cell')).toBeNull();
        expect(parseRangeAddress(sheet, '')).toBeNull();
    });

    it('copies a range as tab-separated text with blank cells kept', () => {
        const range = normalizeRange({ row: 0, col: 0 }, { row: 1, col: 2 });
        expect(rangeToTsv(sheet, range)).toBe('id\tname\tnote\n1\tAda\t');
    });

    it('quotes fields that would break a spreadsheet paste, as Excel does', () => {
        const range = normalizeRange({ row: 2, col: 1 }, { row: 3, col: 2 });
        // A comma is harmless in tab-separated text, so only tabs, line breaks and quotes force quoting.
        expect(rangeToTsv(sheet, range)).toBe(
            'Grace, Hopper\t"line one\nline two"\n"He said ""hi"""\tx',
        );
    });

    it('right-aligns numbers, including numbers that came from CSV text', () => {
        expect(isNumericValue(42)).toBe(true);
        expect(isNumericValue('1234.50')).toBe(true);
        expect(isNumericValue('-3e4')).toBe(true);
        expect(isNumericValue('Ada')).toBe(false);
        expect(isNumericValue('1 234')).toBe(false);
        expect(isNumericValue('')).toBe(false);
        expect(isNumericValue(null)).toBe(false);
    });

    it('summarizes a selection like the Excel status bar', () => {
        const stats = selectionStats(sheet, normalizeRange({ row: 0, col: 0 }, { row: 3, col: 2 }));
        expect(stats).toEqual({
            count: 11,
            numericCount: 3,
            sum: 6,
            average: 2,
            truncated: false,
        });
    });

    it('reports only a count for a selection without numbers', () => {
        const stats = selectionStats(sheet, normalizeRange({ row: 0, col: 0 }, { row: 0, col: 2 }));
        expect(stats.count).toBe(3);
        expect(stats.numericCount).toBe(0);
        expect(stats.average).toBeNull();
    });

    it('combines statistics across Ctrl-selected areas', () => {
        const stats = selectionStatsForRanges(sheet, [
            normalizeRange({ row: 0, col: 0 }, { row: 0, col: 1 }),
            normalizeRange({ row: 1, col: 0 }, { row: 2, col: 0 }),
        ]);
        expect(stats).toEqual({
            count: 4,
            numericCount: 2,
            sum: 3,
            average: 1.5,
            truncated: false,
        });
    });

    it('stops scanning huge selections at the cell budget and says so', () => {
        const stats = selectionStats(sheet, normalizeRange({ row: 0, col: 0 }, { row: 3, col: 2 }), 4);
        expect(stats).toEqual({
            count: 4,
            numericCount: 1,
            sum: 1,
            average: 1,
            truncated: true,
        });
    });

    it('formats status-bar numbers with grouping and bounded decimals', () => {
        expect(formatStat(4231.5, 'en-US')).toBe('4,231.5');
        expect(formatStat(1 / 3, 'en-US')).toBe('0.3333');
        expect(formatStat(-1234.56789, 'en-US')).toBe('-1,234.5679');
        expect(formatStat(0, 'en-US')).toBe('0');
    });

    it('overflows text into empty right neighbours but never numbers', () => {
        const overflowSheet: SpreadsheetSheet = {
            name: 'Overflow',
            columns: ['A', 'B', 'C', 'D'],
            rows: [
                ['wide text', null, '', 5],
                ['x', '', '', ''],
            ],
        };
        expect(overflowColumns(overflowSheet, 0, 0)).toBe(2);
        expect(overflowColumns(overflowSheet, 0, 1)).toBe(0);
        expect(overflowColumns(overflowSheet, 0, 3)).toBe(0);
        expect(overflowColumns(overflowSheet, 0, 0, 1)).toBe(1);
        expect(overflowColumns(overflowSheet, 1, 0)).toBe(3);
        expect(overflowColumns(overflowSheet, 2, 0)).toBe(0);
    });

    it('limits DOM rows to the visible window plus overscan', () => {
        // 20 px rows, 200 px viewport starting at row 100 -> rows 100..110 plus 12 overscan each side.
        expect(visibleRowRange(2000, 200, 1000, 12)).toEqual({ start: 88, end: 122 });
        expect(visibleRowRange(0, 100, 5, 12)).toEqual({ start: 0, end: 5 });
        expect(visibleRowRange(0, 100, 0)).toEqual({ start: 0, end: 0 });
    });

    it('moves the active cell with arrows and stops at the sheet edges', () => {
        expect(moveCell(sheet, { row: 0, col: 0 }, 'ArrowUp')).toEqual({ row: 0, col: 0 });
        expect(moveCell(sheet, { row: 0, col: 0 }, 'ArrowRight')).toEqual({ row: 0, col: 1 });
        expect(moveCell(sheet, { row: 3, col: 2 }, 'ArrowDown')).toEqual({ row: 3, col: 2 });
        expect(moveCell(sheet, { row: 1, col: 1 }, 'Enter')).toEqual({ row: 1, col: 1 });
    });

    it('finds matches in every row of the sheet, case-insensitively, in reading order', () => {
        const index = buildSearchIndex(sheet);
        const result = findCells(sheet, index, 'ADA');
        expect(result).toEqual({ cells: [{ row: 1, col: 1 }], truncated: false });
        expect(findCells(sheet, index, 'hi').cells).toEqual([{ row: 3, col: 1 }]);
        expect(findCells(sheet, index, 'said ada').cells).toEqual([]);
    });

    it('returns no matches for an empty query and matches numbers as their displayed text', () => {
        const index = buildSearchIndex(sheet);
        expect(findCells(sheet, index, '').cells).toEqual([]);
        expect(findCells(sheet, index, '  ').cells).toEqual([]);
        expect(findCells(sheet, index, '2').cells).toEqual([{ row: 2, col: 0 }]);
    });

    it('does not match across the cell boundary inside the index', () => {
        const tricky: SpreadsheetSheet = {
            name: 'T',
            columns: ['A', 'B'],
            rows: [['ab', 'cd']],
        };
        const index = buildSearchIndex(tricky);
        expect(findCells(tricky, index, 'bc').cells).toEqual([]);
        expect(findCells(tricky, index, 'cd').cells).toEqual([{ row: 0, col: 1 }]);
    });

    it('stops at the match limit and reports that the result is truncated', () => {
        const big: SpreadsheetSheet = {
            name: 'Big',
            columns: ['A'],
            rows: Array.from({ length: 50 }, (_, i) => [`x${i}`]),
        };
        const result = findCells(big, buildSearchIndex(big), 'x', 10);
        expect(result.cells).toHaveLength(10);
        expect(result.truncated).toBe(true);
    });

    it('keeps resized columns within the minimum and maximum width', () => {
        expect(clampColumnWidth(10)).toBe(MIN_COLUMN_WIDTH);
        expect(clampColumnWidth(5000)).toBe(MAX_COLUMN_WIDTH);
        expect(clampColumnWidth(150.4)).toBe(150);
    });

    it('places columns using their individual widths', () => {
        const widths = [96, 200, 40];
        expect(columnStart(widths, 0)).toBe(ROW_NUMBER_WIDTH);
        expect(columnStart(widths, 1)).toBe(ROW_NUMBER_WIDTH + 96);
        expect(columnStart(widths, 2)).toBe(ROW_NUMBER_WIDTH + 96 + 200);
        expect(tableWidth(widths)).toBe(ROW_NUMBER_WIDTH + 96 + 200 + 40);
    });

    it('jumps to the edge of a block of data with Ctrl+arrow, as Excel does', () => {
        // a b c
        // d _ f
        // _ _ i
        // j k _
        const grid: SpreadsheetSheet = {
            name: 'Grid',
            columns: ['A', 'B', 'C'],
            rows: [
                ['a', 'b', 'c'],
                ['d', '', 'f'],
                ['', '', 'i'],
                ['j', 'k', ''],
            ],
        };
        // From data to data: stop at the last cell of the current run.
        expect(jumpToEdge(grid, { row: 0, col: 0 }, 'ArrowRight')).toEqual({ row: 0, col: 2 });
        expect(jumpToEdge(grid, { row: 0, col: 0 }, 'ArrowDown')).toEqual({ row: 1, col: 0 });
        expect(jumpToEdge(grid, { row: 2, col: 2 }, 'ArrowUp')).toEqual({ row: 0, col: 2 });
        // Next cell blank: skip the gap to the next data cell.
        expect(jumpToEdge(grid, { row: 1, col: 0 }, 'ArrowRight')).toEqual({ row: 1, col: 2 });
        // Starting from a blank cell: go to the next data cell.
        expect(jumpToEdge(grid, { row: 1, col: 1 }, 'ArrowDown')).toEqual({ row: 3, col: 1 });
        expect(jumpToEdge(grid, { row: 2, col: 0 }, 'ArrowDown')).toEqual({ row: 3, col: 0 });
        // No data further on: stop at the sheet edge.
        expect(jumpToEdge(grid, { row: 3, col: 1 }, 'ArrowRight')).toEqual({ row: 3, col: 2 });
        // Already at the edge, or a non-arrow key: nothing moves.
        expect(jumpToEdge(grid, { row: 0, col: 0 }, 'ArrowUp')).toEqual({ row: 0, col: 0 });
        expect(jumpToEdge(grid, { row: 1, col: 1 }, 'Enter')).toEqual({ row: 1, col: 1 });
    });

    it('finds the column under a pointer, clamped to the sheet', () => {
        const widths = [96, 200, 40];
        expect(columnAt(widths, -5)).toBe(0);
        expect(columnAt(widths, 95)).toBe(0);
        expect(columnAt(widths, 96)).toBe(1);
        expect(columnAt(widths, 295)).toBe(1);
        expect(columnAt(widths, 296)).toBe(2);
        expect(columnAt(widths, 400)).toBe(2);
    });

    it('scrolls faster the closer a drag gets to the visible edge, and not at all in the middle', () => {
        // Visible area 100..400: the top zone is 100..124, the bottom zone 376..400.
        expect(edgeScrollStep(250, 100, 400)).toBe(0);
        expect(edgeScrollStep(100, 100, 400)).toBe(-12);
        expect(edgeScrollStep(60, 100, 400)).toBeLessThan(-12);
        expect(edgeScrollStep(400, 100, 400)).toBe(12);
        expect(edgeScrollStep(1000, 100, 400)).toBe(40);
        expect(edgeScrollStep(-1000, 100, 400)).toBe(-40);
    });

    it('steps through matches and wraps at both ends', () => {
        expect(stepMatch(-1, 3, 1)).toBe(0);
        expect(stepMatch(-1, 3, -1)).toBe(2);
        expect(stepMatch(0, 3, -1)).toBe(2);
        expect(stepMatch(2, 3, 1)).toBe(0);
        expect(stepMatch(1, 3, 1)).toBe(2);
        expect(stepMatch(0, 0, 1)).toBe(-1);
    });
});
