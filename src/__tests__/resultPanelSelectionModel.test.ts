import { describe, expect, it, jest } from '@jest/globals';

const {
    createSelectionModel,
    formatCellId,
    getSelectedRowIndices,
    getSelectionBounds,
    parseCellId,
    resetSelectionModelState,
} = require('../../media/resultPanel/selection/model.js');
const {
    calculateSelectionStats,
    getDiskColumnStats,
    getSelectedColumnFilterKey,
} = require('../../media/resultPanel/selection/stats.js');

describe('selection model', () => {
    it('creates an empty selection state', () => {
        const model = createSelectionModel();
        expect(model.selectedCells.size).toBe(0);
        expect(model.startCell).toBeNull();
        expect(model.endCell).toBeNull();
        expect(model.selectedColumnIndex).toBeNull();
        expect(model.isAllSelected).toBe(false);
        expect(model.isDestroyed).toBe(false);
        expect(model.selectionStatsRequestVersion).toBe(0);
    });

    it('parses and formats cell ids round-trip', () => {
        expect(parseCellId('3-7')).toEqual({ row: 3, col: 7 });
        expect(formatCellId(3, 7)).toBe('3-7');
    });

    it('rejects malformed cell ids', () => {
        expect(parseCellId('')).toBeNull();
        expect(parseCellId('3')).toBeNull();
        expect(parseCellId('a-b')).toBeNull();
        expect(parseCellId('-1-2')).toBeNull();
        expect(parseCellId('1.5-2')).toBeNull();
    });

    it('computes selection bounds over a cell set', () => {
        expect(getSelectionBounds(new Set(['2-3', '0-1', '5-0']))).toEqual({
            minRow: 0, maxRow: 5, minCol: 0, maxCol: 3,
        });
    });

    it('returns null bounds for empty or unparseable sets', () => {
        expect(getSelectionBounds(new Set())).toBeNull();
        expect(getSelectionBounds(new Set(['nope']))).toBeNull();
    });

    it('collects unique row indices', () => {
        expect(getSelectedRowIndices(new Set(['0-0', '0-2', '4-1']))).toEqual(new Set([0, 4]));
    });

    it('resets selection state, bumps the stats version, and disposes the processor', () => {
        const model = createSelectionModel();
        model.selectedCells.add('0-0');
        model.startCell = '0-0';
        model.selectedColumnIndex = 2;
        model.isAllSelected = true;
        model.selectedColumnFilterKey = '{"x":1}';
        const dispose = jest.fn();
        model.selectionStatsProcessor = { add: jest.fn(), complete: jest.fn(), dispose };

        resetSelectionModelState(model);

        expect(model.selectedCells.size).toBe(0);
        expect(model.selectedColumnIndex).toBeNull();
        expect(model.isAllSelected).toBe(false);
        expect(model.selectedColumnFilterKey).toBeNull();
        expect(model.selectionStatsProcessor).toBeNull();
        expect(model.selectionStatsRequestVersion).toBe(1);
        expect(dispose).toHaveBeenCalledTimes(1);
    });
});

describe('selection stats classification', () => {
    it('classifies numeric selections', () => {
        expect(calculateSelectionStats([1, 2, 3, 4])).toEqual({
            cellCount: 4, type: 'numeric', count: 4, distinctCount: 4, sum: 10, min: 1, max: 4,
        });
    });

    it('classifies date selections', () => {
        const stats = calculateSelectionStats(['2024-01-02', '2024-01-01']);
        expect(stats.type).toBe('date');
        expect(stats.min).toBe('2024-01-01');
        expect(stats.max).toBe('2024-01-02');
    });

    it('classifies text and mixed selections', () => {
        expect(calculateSelectionStats(['a', 'b', 'a']).type).toBe('text');
        expect(calculateSelectionStats([1, 'a']).type).toBe('mixed');
    });

    it('skips nulls, blanks, and NULL markers', () => {
        const stats = calculateSelectionStats([null, undefined, '', '   ', 'NULL', 'null', 5]);
        expect(stats).toEqual({
            cellCount: 1, type: 'numeric', count: 1, distinctCount: 1, sum: 5, min: 5, max: 5,
        });
    });

    it('maps disk-backed numeric aggregations', () => {
        const column = { id: '0', columnDef: { header: 'n', dataType: 'integer' } };
        expect(getDiskColumnStats(column, [
            { fn: 'count', value: 10 },
            { fn: 'countDistinct', value: 7 },
            { fn: 'sum', value: 42 },
            { fn: 'min', value: 1 },
            { fn: 'max', value: 9 },
        ])).toEqual({
            cellCount: 10, type: 'numeric', count: 10, distinctCount: 7, sum: 42, min: 1, max: 9,
        });
    });

    it('maps inferred date columns to date stats', () => {
        const column = {
            id: '0',
            columnDef: { header: 'd', dataType: '__inferred_integer__', inferredDateInteger: true },
        };
        const stats = getDiskColumnStats(column, [
            { fn: 'count', value: 2 },
            { fn: 'countDistinct', value: 2 },
            { fn: 'sum', value: 0 },
            { fn: 'min', value: 20240101 },
            { fn: 'max', value: 20240102 },
        ]);
        expect(stats.type).toBe('date');
        expect(stats.min).toBe('20240101');
    });

    it('fingerprints the table filter state', () => {
        const table = {
            getState: () => ({ columnFilters: [{ id: '0', value: 'x' }], globalFilter: 'foo' }),
        };
        expect(getSelectedColumnFilterKey(table)).toBe(
            JSON.stringify({ columnFilters: [{ id: '0', value: 'x' }], globalFilter: 'foo' }),
        );
    });
});
