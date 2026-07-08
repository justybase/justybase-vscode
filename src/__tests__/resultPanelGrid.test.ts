// Unit tests for grid.js exported table mode functions.
// Tests pure, testable functions used by the Table grid rendering.
// DOM-dependent functions (renderGrids, createResultSetGrid, etc.) are excluded
// as they require a full browser environment.
// Pattern follows resultPanelStateScroll.test.ts — require() inside it() blocks.

import { describe, expect, it, jest, beforeEach } from '@jest/globals';

// Helper: mock row objects for sort/filter functions
type RowLike = { getValue: (id: string) => unknown; original?: Record<string, unknown> };
function mockRow(value: unknown): RowLike {
    return {
        getValue: () => value,
        original: { col: value },
    };
}

// Mock all modules grid.js depends on — avoid DOM / global side-effects at import time.
jest.mock('../../media/resultPanel/protocol.js', () => ({
    postHostMessage: jest.fn(),
    asHostMessage: jest.fn(),
    getHostState: jest.fn(),
    setHostState: jest.fn(),
}));

jest.mock('../../media/resultPanel/state.js', () => ({
    getActiveGridIndex: jest.fn(() => 0),
    resetGrids: jest.fn(),
    addGrid: jest.fn(),
    getGrid: jest.fn(),
    getAllGrids: jest.fn(() => []),
    setColumnFilterState: jest.fn(),
    getAggregationState: jest.fn(() => ({})),
    setAggregationState: jest.fn(),
    setGlobalDragState: jest.fn(),
    getGlobalDragState: jest.fn(() => ({})),
    getSearchMatches: jest.fn(() => new Set()),
    getSearchWorker: jest.fn(() => null),
    saveScrollStateToCache: jest.fn(),
    getPinnedColumnsState: jest.fn(() => []),
    setPinnedColumnsState: jest.fn(),
    getGlobalFilterState: jest.fn(() => ''),
    setGlobalFilterState: jest.fn(),
    setResultFormattingState: jest.fn(),
}));

jest.mock('../../media/resultPanel/utils.js', () => {
    const temporalTypes = new Set([
        'date', 'datetime', 'datetime2', 'datetimeoffset', 'smalldatetime',
        'timestamp', 'timestamptz', 'timestamp_ntz', 'timestamp_ltz', 'timestamp_tz',
        'time', 'timetz', 'abstime', 'reltime', 'interval',
    ]);
    const normalizeType = (type: string | undefined) => String(type || '').trim().toLowerCase();
    const baseType = (type: string | undefined) => normalizeType(type).split('(')[0]?.trim() ?? '';
    const isTemporalType = (type: string | undefined) => {
        const normalized = normalizeType(type);
        return temporalTypes.has(normalized)
            || temporalTypes.has(baseType(type))
            || normalized.includes('timestamp')
            || normalized.includes('datetime');
    };
    const parseTemporalSortKey = (value: unknown, type?: string, options?: { inferredDateInteger?: boolean }) => {
        if (value === null || value === undefined) return Number.NaN;
        if (value instanceof Date) return value.getTime();
        if (options?.inferredDateInteger) {
            const raw = String(value).trim();
            if (/^\d{8}$/.test(raw)) {
                return Number(raw);
            }
        }
        if (typeof value === 'number') {
            if (isTemporalType(type) && value >= 1_000_000_000 && value < 10_000_000_000) {
                return value * 1000;
            }
            return value;
        }
        if (typeof value === 'object' && value !== null && ('hours' in value || 'minutes' in value)) {
            const timeValue = value as { hours?: unknown; minutes?: unknown; seconds?: unknown };
            return ((Number(timeValue.hours ?? 0) * 3600)
                + (Number(timeValue.minutes ?? 0) * 60)
                + Number(timeValue.seconds ?? 0)) * 1000;
        }
        const parsed = Date.parse(String(value));
        return Number.isNaN(parsed) ? Number.NaN : parsed;
    };
    return {
        validateRequiredLibraries: jest.fn(() => null),
        formatCellValue: jest.fn((value: unknown) => (value === null || value === undefined ? null : String(value))),
        debounce: jest.fn((fn: (...args: unknown[]) => unknown) => fn),
        getNumericTypeInfo: jest.fn((type: string) => {
            const t = (type || '').toLowerCase();
            const isInt = !!(t.match(/^(tiny|small|medium|big|byte|huge|u)?int/) || t === 'serial' || t === 'serial2' || t === 'serial4' || t === 'serial8');
            const isDec = !!(t.match(/^(decimal|numeric|dec|number|float|real|double|money)/));
            if (isInt) return { isNumeric: true, hasDecimal: false, isInteger: true, numericKind: 'integer' };
            if (isDec) return { isNumeric: true, hasDecimal: true, isInteger: false, numericKind: 'decimal' };
            return { isNumeric: false, hasDecimal: false, isInteger: false, numericKind: 'none' };
        }),
        shouldRightAlignCell: jest.fn(() => false),
        inferNumericTypeFromRows: jest.fn(() => ({ numericKind: 'none', scale: null, dataType: 'text' })),
        inferYyyymmddIntegerDateFromValues: jest.fn(() => false),
        isDeclaredIntegerType: jest.fn(() => false),
        isTemporalType,
        parseTemporalSortKey,
    };
});

jest.mock('../../media/resultPanel/filter.js', () => ({
    createHeaderCellWithFilter: jest.fn(),
    reorderColumnsForPinning: jest.fn(),
}));

jest.mock('../../media/resultPanel/selection.js', () => ({
    setupCellSelectionEvents: jest.fn(() => ({
        destroy: jest.fn(),
        onTableRowsRendered: jest.fn(),
    })),
}));

jest.mock('../../media/resultPanel/messages.js', () => ({
    getSavedStateFor: jest.fn(() => null),
    saveAllGridStates: jest.fn(),
}));

describe('grid.js exported constants (Table mode)', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    it('exports RESULT_GRID_MAX_AUTO_COLUMN_WIDTH = 600', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.RESULT_GRID_MAX_AUTO_COLUMN_WIDTH).toBe(600);
    });

    it('exports RESULT_GRID_MAX_AUTO_SIZE_ROWS = 10000', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.RESULT_GRID_MAX_AUTO_SIZE_ROWS).toBe(10000);
    });

    it('exports RESULT_GRID_ROW_NUMBER_MIN_DIGITS = 7', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.RESULT_GRID_ROW_NUMBER_MIN_DIGITS).toBe(7);
    });

    it('exports RESULT_GRID_INIT_AUTO_SIZE_ROWS = 1000', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.RESULT_GRID_INIT_AUTO_SIZE_ROWS).toBe(1000);
    });

    it('exports RESULT_GRID_VIRTUAL_OVERSCAN = 12', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.RESULT_GRID_VIRTUAL_OVERSCAN).toBe(12);
    });
});

describe('renderGrids cleanup', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    it('disposes existing grid handles before rerendering', () => {
        const state = require('../../media/resultPanel/state.js');
        const dispose = jest.fn();
        const destroyVirtualizer = jest.fn();
        const clearPool = jest.fn();
        state.getAllGrids.mockReturnValue([{ dispose, destroyVirtualizer, clearPool }]);

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                resultSets: [{ columns: [{ name: 'id' }], data: [[1]], executionTimestamp: 1 }],
                activeSource: 'file:///test.sql'
            }
        });

        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                getElementById: jest.fn(() => ({ innerHTML: '' }))
            }
        });

        const g = require('../../media/resultPanel/grid.js');
        g.renderGrids();

        expect(dispose).toHaveBeenCalledTimes(1);
        expect(destroyVirtualizer).not.toHaveBeenCalled();
        expect(clearPool).not.toHaveBeenCalled();
    });
});

describe('prepareColumns', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    it('does not precompute uniqueValues for each column', () => {
        const utils = require('../../media/resultPanel/utils.js');
        const formatCellValue = utils.formatCellValue as jest.Mock;
        formatCellValue.mockClear();

        const g = require('../../media/resultPanel/grid.js');
        const rows = Array.from({ length: 50 }, (_, index) => [`value-${index}`]);
        const columns = g.prepareColumns({
            columns: [{ name: 'A', type: 'varchar' }, { name: 'B', type: 'varchar' }],
            data: rows,
            executionTimestamp: 'ts-1',
        }, 0);

        expect(columns).toHaveLength(2);
        expect(columns[0]).not.toHaveProperty('uniqueValues');
        expect(columns[1]).not.toHaveProperty('uniqueValues');
        expect(formatCellValue).not.toHaveBeenCalled();
    });
});

describe('calculateRowNumberColumnWidth', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    it('returns minimum width for small row counts', () => {
        const g = require('../../media/resultPanel/grid.js');
        const measureText = jest.fn<(text: string) => number>().mockReturnValue(30);
        const width = g.calculateRowNumberColumnWidth(5, measureText);
        expect(width).toBeGreaterThanOrEqual(50);
    });

    it('scales width for larger row counts', () => {
        const g = require('../../media/resultPanel/grid.js');
        const measureText = jest.fn<(text: string) => number>((text: string) => text.length * 7);
        const width10 = g.calculateRowNumberColumnWidth(10, measureText);
        const width10000 = g.calculateRowNumberColumnWidth(10000, measureText);
        expect(width10000).toBeGreaterThanOrEqual(width10);
    });

    it('handles zero row count — uses minimum 7 digits', () => {
        const g = require('../../media/resultPanel/grid.js');
        const measureText = jest.fn<(text: string) => number>().mockReturnValue(30);
        g.calculateRowNumberColumnWidth(0, measureText);
        expect(measureText).toHaveBeenCalledWith('9999999');
    });

    it('measures correct digit text for given row count', () => {
        const g = require('../../media/resultPanel/grid.js');
        const measureText = jest.fn<(text: string) => number>().mockReturnValue(40);
        g.calculateRowNumberColumnWidth(500, measureText);
        // 500 rows → 3 digits, but min digits = 7 → should measure '9999999'
        expect(measureText).toHaveBeenCalledWith('9999999');
    });

    it('handles very large row count (1M) — still limits to 7-8 digits', () => {
        const g = require('../../media/resultPanel/grid.js');
        const measureText = jest.fn<(text: string) => number>().mockReturnValue(40);
        g.calculateRowNumberColumnWidth(1_000_000, measureText);
        // 1M rows → 7 digits → should measure '9999999' (min digits = 7)
        expect(measureText).toHaveBeenCalledWith('9999999');
    });
});

describe('calculateAutoHeaderWidth', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    it('computes width based on header text length', () => {
        const g = require('../../media/resultPanel/grid.js');
        const measureText = jest.fn<(text: string) => number>((text: string) => text.length * 7);
        const column = { header: 'short' };
        const width = g.calculateAutoHeaderWidth(column, measureText);
        expect(width).toBeGreaterThan(35);
        expect(measureText).toHaveBeenCalledWith('short');
    });

    it('handles empty header', () => {
        const g = require('../../media/resultPanel/grid.js');
        const measureText = jest.fn<(text: string) => number>().mockReturnValue(0);
        const column = { header: '' };
        const width = g.calculateAutoHeaderWidth(column, measureText);
        expect(width).toBeGreaterThanOrEqual(0);
    });

    it('handles long header text', () => {
        const g = require('../../media/resultPanel/grid.js');
        const longHeader = 'A'.repeat(100);
        const measureText = jest.fn<(text: string) => number>((text: string) => text.length * 7);
        const column = { header: longHeader };
        const width = g.calculateAutoHeaderWidth(column, measureText);
        expect(width).toBeGreaterThan(700);
    });
});

describe('calculateAutoColumnWidth', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    function createColumn(): Record<string, unknown> {
        return {
            id: '0',
            header: 'Col',
            accessorFn: (row: unknown[]) => (Array.isArray(row) ? row[0] : null),
        };
    }

    it('computes width based on cell values', () => {
        const g = require('../../media/resultPanel/grid.js');
        const measureText = jest.fn<(text: string) => number>((text: string) => text.length * 7);
        const column = createColumn();
        const rows = [['hello'], ['world'], ['foo']];
        const width = g.calculateAutoColumnWidth(column, rows, measureText);
        expect(width).toBeGreaterThanOrEqual(35);
        expect(measureText).toHaveBeenCalledWith('hello');
    });

    it('uses headerWidth as minimum when provided', () => {
        const g = require('../../media/resultPanel/grid.js');
        const measureText = jest.fn<(text: string) => number>((text: string) => text.length * 7);
        const column = createColumn();
        const rows = [['a'], ['b']];
        const width = g.calculateAutoColumnWidth(column, rows, measureText, {
            headerWidth: 180,
        });
        expect(width).toBeGreaterThanOrEqual(180);
    });

    it('respects maxRows option', () => {
        const g = require('../../media/resultPanel/grid.js');
        const measureText = jest.fn<(text: string) => number>((text: string) => text.length * 7);
        const column = createColumn();
        const rows = Array.from({ length: 100 }, (_, i) => [`value-${i}`]);
        g.calculateAutoColumnWidth(column, rows, measureText, { maxRows: 5 });
        // measureText should only have been called for up to 5 values
        const calls = (measureText as jest.Mock).mock.calls
            .map((args: unknown[]) => String(args[0]))
            .filter((a: string) => a.startsWith('value-'));
        expect(calls.length).toBeLessThanOrEqual(5);
    });

    it('samples rows when the dataset exceeds the init threshold', () => {
        const g = require('../../media/resultPanel/grid.js');
        const measureText = jest.fn<(text: string) => number>((text: string) => text.length * 7);
        const column = createColumn();
        const rows = Array.from({ length: 200 }, (_, i) => [`value-${i}`]);
        g.calculateAutoColumnWidth(column, rows, measureText, {
            maxRows: 200,
            sampleStep: 10,
        });
        const valueCalls = (measureText as jest.Mock).mock.calls
            .map((args: unknown[]) => String(args[0]))
            .filter((a: string) => a.startsWith('value-'));
        expect(valueCalls.length).toBeLessThanOrEqual(21);
        expect(valueCalls).toContain('value-0');
        expect(valueCalls).toContain('value-10');
    });

    it('skips null / undefined values', () => {
        const g = require('../../media/resultPanel/grid.js');
        const measureText = jest.fn<(text: string) => number>((text: string) => text.length * 7);
        const column = createColumn();
        const rows = [[null], ['abc'], [undefined]];
        g.calculateAutoColumnWidth(column, rows, measureText);
        expect(measureText).toHaveBeenCalledWith('abc');
    });

    it('caps width at RESULT_GRID_MAX_AUTO_COLUMN_WIDTH', () => {
        const g = require('../../media/resultPanel/grid.js');
        const measureText = jest.fn<(text: string) => number>().mockReturnValue(5000);
        const column = createColumn();
        const rows = [['x'.repeat(2000)]];
        const width = g.calculateAutoColumnWidth(column, rows, measureText);
        expect(width).toBeLessThanOrEqual(g.RESULT_GRID_MAX_AUTO_COLUMN_WIDTH);
    });

    it('works with empty rows array', () => {
        const g = require('../../media/resultPanel/grid.js');
        const measureText = jest.fn<(text: string) => number>((text: string) => text.length * 7);
        const column = createColumn();
        const width = g.calculateAutoColumnWidth(column, [], measureText);
        // Should still return a value (header-based minimum)
        expect(width).toBeGreaterThanOrEqual(0);
    });

    it('uses the column accessorFn to extract values', () => {
        const g = require('../../media/resultPanel/grid.js');
        const measureText = jest.fn<(text: string) => number>((text: string) => text.length * 7);
        const accessorFn = jest.fn().mockReturnValue('extracted-value');
        const column = { id: 'name', header: 'Name', accessorFn };
        const rows = [{ name: 'Alice' }];
        g.calculateAutoColumnWidth(column, rows, measureText);
        expect(accessorFn).toHaveBeenCalledWith({ name: 'Alice' });
        expect(measureText).toHaveBeenCalledWith('extracted-value');
    });
});

describe('createSortingFn', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    it('returns "alphanumeric" for text columns (no numeric/date inference)', () => {
        const g = require('../../media/resultPanel/grid.js');
        const fn = g.createSortingFn('varchar', 'none', false);
        expect(fn).toBe('alphanumeric');
    });

    it('returns "alphanumeric" for unknown types', () => {
        const g = require('../../media/resultPanel/grid.js');
        const fn = g.createSortingFn('', 'none', false);
        expect(fn).toBe('alphanumeric');
    });

    it('sorts numeric values in ascending order', () => {
        const g = require('../../media/resultPanel/grid.js');
        const fn = g.createSortingFn('integer', 'none', false);
        const result = fn(mockRow(10), mockRow(5), '0');
        expect(result).toBeGreaterThan(0); // 10 > 5
    });

    it('puts nulls before values in ascending sort', () => {
        const g = require('../../media/resultPanel/grid.js');
        const fn = g.createSortingFn('integer', 'none', false);
        // null vs value → null should come first → return -1
        expect(fn(mockRow(null), mockRow(5), '0')).toBe(-1);
        // value vs null → value should come after → return 1
        expect(fn(mockRow(5), mockRow(null), '0')).toBe(1);
    });

    it('sorts by inferred numeric kind (integer)', () => {
        const g = require('../../media/resultPanel/grid.js');
        const fn = g.createSortingFn('text', 'integer', false);
        const result = fn(mockRow('100'), mockRow('20'), '0');
        expect(result).toBeGreaterThan(0); // 100 > 20
    });

    it('handles comma as decimal separator', () => {
        const g = require('../../media/resultPanel/grid.js');
        const fn = g.createSortingFn('decimal', 'none', false);
        const result = fn(mockRow('10,5'), mockRow('5,2'), '0');
        expect(result).toBeGreaterThan(0); // 10.5 > 5.2
    });

    it('falls back to localeCompare when both values are NaN', () => {
        const g = require('../../media/resultPanel/grid.js');
        const fn = g.createSortingFn('integer', 'none', false);
        const result = fn(mockRow('abc'), mockRow('xyz'), '0');
        // 'abc' < 'xyz' → should be negative
        expect(result).toBeLessThan(0);
    });

    it('sorts by inferred decimal kind', () => {
        const g = require('../../media/resultPanel/grid.js');
        const fn = g.createSortingFn('text', 'decimal', false);
        expect(fn(mockRow(3.14), mockRow(2.71), '0')).toBeGreaterThan(0);
        expect(fn(mockRow(1.5), mockRow(1.5), '0')).toBe(0);
        expect(fn(mockRow(1), mockRow(2), '0')).toBeLessThan(0);
    });

    it('sorts date columns by timestamp', () => {
        const g = require('../../media/resultPanel/grid.js');
        const fn = g.createSortingFn('date', 'none', false);
        const earlier = new Date('2023-01-01');
        const later = new Date('2024-06-15');
        expect(fn(mockRow(earlier), mockRow(later), '0')).toBeLessThan(0);
        expect(fn(mockRow(later), mockRow(earlier), '0')).toBeGreaterThan(0);
        expect(fn(mockRow(earlier), mockRow(earlier), '0')).toBe(0);
    });

    it('sorts timestamp columns by timestamp', () => {
        const g = require('../../media/resultPanel/grid.js');
        const fn = g.createSortingFn('timestamp', 'none', false);
        expect(fn(mockRow('2023-01-01'), mockRow('2024-01-01'), '0')).toBeLessThan(0);
    });

    it('sorts ABSTIME columns by Date values', () => {
        const g = require('../../media/resultPanel/grid.js');
        const fn = g.createSortingFn('ABSTIME', 'none', false);
        const earlier = new Date('2023-01-01T10:00:00.000Z');
        const later = new Date('2024-06-15T10:00:00.000Z');
        expect(fn(mockRow(earlier), mockRow(later), '0')).toBeLessThan(0);
        expect(fn(mockRow(later), mockRow(earlier), '0')).toBeGreaterThan(0);
    });

    it('sorts ABSTIME columns by epoch seconds', () => {
        const g = require('../../media/resultPanel/grid.js');
        const fn = g.createSortingFn('abstime', 'none', false);
        expect(fn(mockRow(1704067200), mockRow(1609459200), '0')).toBeGreaterThan(0);
    });

    it('sorts TIME columns by time-of-day objects', () => {
        const g = require('../../media/resultPanel/grid.js');
        const fn = g.createSortingFn('TIME', 'none', false);
        const earlier = { hours: 8, minutes: 15, seconds: 0 };
        const later = { hours: 14, minutes: 30, seconds: 0 };
        expect(fn(mockRow(earlier), mockRow(later), '0')).toBeLessThan(0);
    });

    it('handles inferred date integer columns', () => {
        const g = require('../../media/resultPanel/grid.js');
        const fn = g.createSortingFn('integer', 'none', true);
        expect(fn(mockRow('2023-01-01'), mockRow('2024-01-01'), '0')).toBeLessThan(0);
        expect(fn(mockRow('20230101'), mockRow('20241231'), '0')).toBeLessThan(0);
        expect(fn(mockRow(20230101), mockRow('20241231'), '0')).toBeLessThan(0);
    });
});

describe('createFilterFn', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function createFilterTest(g: any): {
        filterFn: (row: RowLike, _colId: string, filterValue: unknown) => boolean;
    } {
        const accessorFn = (row: { col?: unknown }) => row.col;
        const filterFn = g.createFilterFn(accessorFn, 'varchar', undefined, 'none', false);
        return { filterFn };
    }

    function rowWith(val: unknown): RowLike {
        return { getValue: () => val, original: { col: val } };
    }

    it('returns true for empty/undefined filter', () => {
        const g = require('../../media/resultPanel/grid.js');
        const { filterFn } = createFilterTest(g);
        expect(filterFn(rowWith('hello'), '0', undefined)).toBe(true);
        expect(filterFn(rowWith('hello'), '0', null)).toBe(true);
        expect(filterFn(rowWith('hello'), '0', '')).toBe(true);
    });

    it('filters by array of allowed values', () => {
        const g = require('../../media/resultPanel/grid.js');
        const { filterFn } = createFilterTest(g);
        expect(filterFn(rowWith('apple'), '0', ['apple', 'banana'])).toBe(true);
        expect(filterFn(rowWith('cherry'), '0', ['apple', 'banana'])).toBe(false);
    });

    it('returns true for empty array filter', () => {
        const g = require('../../media/resultPanel/grid.js');
        const { filterFn } = createFilterTest(g);
        expect(filterFn(rowWith('anything'), '0', [])).toBe(true);
    });

    it('filters by condition: contains', () => {
        const g = require('../../media/resultPanel/grid.js');
        const { filterFn } = createFilterTest(g);
        const cond = { _isConditionFilter: true, conditions: [{ type: 'contains', value: 'apple' }], logic: 'and' };
        expect(filterFn(rowWith('pineapple'), '0', cond)).toBe(true);
        expect(filterFn(rowWith('banana'), '0', cond)).toBe(false);
    });

    it('filters by condition: equals', () => {
        const g = require('../../media/resultPanel/grid.js');
        const { filterFn } = createFilterTest(g);
        const cond = { _isConditionFilter: true, conditions: [{ type: 'equals', value: 'hello' }], logic: 'and' };
        expect(filterFn(rowWith('hello'), '0', cond)).toBe(true);
        expect(filterFn(rowWith('world'), '0', cond)).toBe(false);
    });

    it('filters by condition: startsWith', () => {
        const g = require('../../media/resultPanel/grid.js');
        const { filterFn } = createFilterTest(g);
        const cond = { _isConditionFilter: true, conditions: [{ type: 'startsWith', value: 'he' }], logic: 'and' };
        expect(filterFn(rowWith('hello'), '0', cond)).toBe(true);
        expect(filterFn(rowWith('world'), '0', cond)).toBe(false);
    });

    it('filters by condition: greaterThan (numeric)', () => {
        const g = require('../../media/resultPanel/grid.js');
        const accessorFn = (row: { col?: unknown }) => row.col;
        // Use integer type so numericValue is parsed
        const filterFn = g.createFilterFn(accessorFn, 'integer', undefined, 'none', false);
        const cond = { _isConditionFilter: true, conditions: [{ type: 'greaterThan', value: '100' }], logic: 'and' };
        expect(filterFn(rowWith(150), '0', cond)).toBe(true);
        expect(filterFn(rowWith(50), '0', cond)).toBe(false);
    });

    it('filters by condition: isEmpty / isNotEmpty', () => {
        const g = require('../../media/resultPanel/grid.js');
        const { filterFn } = createFilterTest(g);
        const emptyCond = { _isConditionFilter: true, conditions: [{ type: 'isEmpty' }], logic: 'and' };
        const notEmptyCond = { _isConditionFilter: true, conditions: [{ type: 'isNotEmpty' }], logic: 'and' };
        // null/undefined → formatted as 'NULL' → isNull = true
        expect(filterFn(rowWith(null), '0', emptyCond)).toBe(true);
        expect(filterFn(rowWith('abc'), '0', notEmptyCond)).toBe(true);
        expect(filterFn(rowWith(null), '0', notEmptyCond)).toBe(false);
    });

    it('filters by condition: notContains', () => {
        const g = require('../../media/resultPanel/grid.js');
        const { filterFn } = createFilterTest(g);
        const cond = { _isConditionFilter: true, conditions: [{ type: 'notContains', value: 'bad' }], logic: 'and' };
        expect(filterFn(rowWith('good'), '0', cond)).toBe(true);
        expect(filterFn(rowWith('badword'), '0', cond)).toBe(false);
    });

    it('handles null values in condition filter', () => {
        const g = require('../../media/resultPanel/grid.js');
        const { filterFn } = createFilterTest(g);
        const cond = { _isConditionFilter: true, conditions: [{ type: 'contains', value: 'abc' }], logic: 'and' };
        // null → formatted as 'NULL' → should not contain 'abc'
        expect(filterFn(rowWith(null), '0', cond)).toBe(false);
    });
});

describe('evaluateConditions', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    // Helper: build evaluateConditions call with default helpers
    function callEval(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        g: any,
        conditions: Array<Record<string, string>>,
        logic: string,
        stringValue: string,
        numericValue?: number,
        isDateColumn?: boolean
    ): boolean {
        const parseDateValue = (v: unknown) => {
            if (v === null || v === undefined) return null;
            if (v instanceof Date) return v.getTime();
            const parsed = Date.parse(String(v));
            return isNaN(parsed) ? null : parsed;
        };
        const parseFilterDate = (v: unknown) => {
            if (!v || v === '') return null;
            const parsed = Date.parse(String(v));
            return isNaN(parsed) ? null : parsed;
        };
        return g.evaluateConditions(
            conditions,
            logic,
            stringValue,
            numericValue ?? NaN,
            isDateColumn ?? false,
            parseDateValue,
            parseFilterDate
        );
    }

    describe('AND logic', () => {
        it('returns true when all conditions match', () => {
            const g = require('../../media/resultPanel/grid.js');
            const result = callEval(g, [
                { type: 'contains', value: 'hello' },
                { type: 'endsWith', value: 'world' },
            ], 'and', 'hello world');
            expect(result).toBe(true);
        });

        it('returns false when any condition fails', () => {
            const g = require('../../media/resultPanel/grid.js');
            const result = callEval(g, [
                { type: 'contains', value: 'hello' },
                { type: 'endsWith', value: 'xyz' },
            ], 'and', 'hello world');
            expect(result).toBe(false);
        });
    });

    describe('OR logic', () => {
        it('returns true when any condition matches', () => {
            const g = require('../../media/resultPanel/grid.js');
            const result = callEval(g, [
                { type: 'contains', value: 'xyz' },
                { type: 'endsWith', value: 'world' },
            ], 'or', 'hello world');
            expect(result).toBe(true);
        });

        it('returns false when no condition matches', () => {
            const g = require('../../media/resultPanel/grid.js');
            const result = callEval(g, [
                { type: 'contains', value: 'xyz' },
                { type: 'endsWith', value: 'abc' },
            ], 'or', 'hello world');
            expect(result).toBe(false);
        });
    });

    describe('text condition types', () => {
        it('contains', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'contains', value: 'test' }], 'and', 'this is a test')).toBe(true);
            expect(callEval(g, [{ type: 'contains', value: 'xyz' }], 'and', 'hello')).toBe(false);
        });

        it('equals (string)', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'equals', value: 'hello' }], 'and', 'hello')).toBe(true);
            expect(callEval(g, [{ type: 'equals', value: 'Hello' }], 'and', 'hello')).toBe(true); // case-insensitive
        });

        it('equals (numeric)', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'equals', value: '100' }], 'and', '100', 100)).toBe(true);
        });

        it('startsWith', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'startsWith', value: 'he' }], 'and', 'hello')).toBe(true);
            expect(callEval(g, [{ type: 'startsWith', value: 'lo' }], 'and', 'hello')).toBe(false);
        });

        it('endsWith', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'endsWith', value: 'lo' }], 'and', 'hello')).toBe(true);
            expect(callEval(g, [{ type: 'endsWith', value: 'el' }], 'and', 'hello')).toBe(false);
        });

        it('notContains', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'notContains', value: 'xyz' }], 'and', 'hello')).toBe(true);
            expect(callEval(g, [{ type: 'notContains', value: 'll' }], 'and', 'hello')).toBe(false);
        });

        it('notEquals (string)', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'notEquals', value: 'world' }], 'and', 'hello')).toBe(true);
            expect(callEval(g, [{ type: 'notEquals', value: 'hello' }], 'and', 'hello')).toBe(false);
        });

        it('notEquals (numeric)', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'notEquals', value: '100' }], 'and', '200', 200)).toBe(true);
            expect(callEval(g, [{ type: 'notEquals', value: '100' }], 'and', '100', 100)).toBe(false);
        });

        it('isEmpty / isNotEmpty', () => {
            const g = require('../../media/resultPanel/grid.js');
            // 'NULL' string → isNull = true
            expect(callEval(g, [{ type: 'isEmpty' }], 'and', 'NULL')).toBe(true);
            expect(callEval(g, [{ type: 'isNotEmpty' }], 'and', 'not null')).toBe(true);
            expect(callEval(g, [{ type: 'isNotEmpty' }], 'and', 'NULL')).toBe(false);
        });

        it('like with % wildcard', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'like', value: 'hel%' }], 'and', 'hello world')).toBe(true);
            expect(callEval(g, [{ type: 'like', value: '%wor%' }], 'and', 'hello world')).toBe(true);
            expect(callEval(g, [{ type: 'like', value: 'xyz%' }], 'and', 'hello')).toBe(false);
        });

        it('like with _ single char wildcard', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'like', value: 'h_llo' }], 'and', 'hello')).toBe(true);
            expect(callEval(g, [{ type: 'like', value: 'h_llo' }], 'and', 'hxllo')).toBe(true);
            expect(callEval(g, [{ type: 'like', value: 'h_llo' }], 'and', 'hllo')).toBe(false);
        });
    });

    describe('numeric condition types', () => {
        it('greaterThan', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'greaterThan', value: '50' }], 'and', '100', 100)).toBe(true);
            expect(callEval(g, [{ type: 'greaterThan', value: '50' }], 'and', '30', 30)).toBe(false);
        });

        it('greaterThanOrEqual', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'greaterThanOrEqual', value: '50' }], 'and', '50', 50)).toBe(true);
            expect(callEval(g, [{ type: 'greaterThanOrEqual', value: '50' }], 'and', '49', 49)).toBe(false);
        });

        it('lessThan', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'lessThan', value: '50' }], 'and', '30', 30)).toBe(true);
            expect(callEval(g, [{ type: 'lessThan', value: '50' }], 'and', '70', 70)).toBe(false);
        });

        it('lessThanOrEqual', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'lessThanOrEqual', value: '50' }], 'and', '50', 50)).toBe(true);
            expect(callEval(g, [{ type: 'lessThanOrEqual', value: '50' }], 'and', '51', 51)).toBe(false);
        });

        it('between', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'between', value: '10', value2: '20' }], 'and', '15', 15)).toBe(true);
            expect(callEval(g, [{ type: 'between', value: '10', value2: '20' }], 'and', '5', 5)).toBe(false);
            expect(callEval(g, [{ type: 'between', value: '10', value2: '20' }], 'and', '25', 25)).toBe(false);
        });
    });

    describe('date column conditions', () => {
        it('equals date', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'equals', value: '2024-01-15' }], 'and', '2024-01-15', NaN, true)).toBe(true);
            expect(callEval(g, [{ type: 'equals', value: '2024-01-15' }], 'and', '2024-06-01', NaN, true)).toBe(false);
        });

        it('greaterThan date', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'greaterThan', value: '2024-01-01' }], 'and', '2024-06-15', NaN, true)).toBe(true);
            expect(callEval(g, [{ type: 'greaterThan', value: '2024-01-01' }], 'and', '2023-01-01', NaN, true)).toBe(false);
        });

        it('between dates', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [
                { type: 'between', value: '2024-01-01', value2: '2024-12-31' },
            ], 'and', '2024-06-15', NaN, true)).toBe(true);
            expect(callEval(g, [
                { type: 'between', value: '2024-01-01', value2: '2024-06-01' },
            ], 'and', '2024-12-01', NaN, true)).toBe(false);
        });

        it('contains text within date column', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'contains', value: '2024' }], 'and', '2024-06-15', NaN, true)).toBe(true);
            expect(callEval(g, [{ type: 'contains', value: 'xyz' }], 'and', '2024-06-15', NaN, true)).toBe(false);
        });

        it('handles null dates with isEmpty', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'isEmpty' }], 'and', 'NULL', NaN, true)).toBe(true);
        });
    });

    describe('text comparison for non-numeric values', () => {
        it('greaterThan falls back to string comparison', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'greaterThan', value: 'apple' }], 'and', 'banana')).toBe(true);
            expect(callEval(g, [{ type: 'greaterThan', value: 'banana' }], 'and', 'apple')).toBe(false);
        });

        it('between falls back to string comparison', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [
                { type: 'between', value: 'apple', value2: 'cherry' },
            ], 'and', 'banana')).toBe(true);
            expect(callEval(g, [
                { type: 'between', value: 'apple', value2: 'cherry' },
            ], 'and', 'zebra')).toBe(false);
        });
    });

    describe('null handling', () => {
        it('contains returns false for NULL values', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'contains', value: 'abc' }], 'and', 'NULL')).toBe(false);
        });

        it('startsWith returns false for NULL values', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'startsWith', value: 'abc' }], 'and', 'NULL')).toBe(false);
        });

        it('notContains returns true for NULL values', () => {
            const g = require('../../media/resultPanel/grid.js');
            expect(callEval(g, [{ type: 'notContains', value: 'abc' }], 'and', 'NULL')).toBe(true);
        });
    });
});

describe('formatAggregationNumber', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    it('returns empty string for null / undefined / empty', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.formatAggregationNumber(null)).toBe('');
        expect(g.formatAggregationNumber(undefined)).toBe('');
        expect(g.formatAggregationNumber('')).toBe('');
    });

    it('formats integer values with space thousand separators', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.formatAggregationNumber(1000, false)).toBe('1 000');
        expect(g.formatAggregationNumber(1_000_000, false)).toBe('1 000 000');
        expect(g.formatAggregationNumber(42, false)).toBe('42');
    });

    it('formats decimal values with 4 decimal places by default', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.formatAggregationNumber(3.14159, true)).toBe('3.1416'); // rounds
        expect(g.formatAggregationNumber(2.71, true)).toBe('2.7100');   // pads
    });

    it('formats integer values without decimal when hasDecimal=false', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.formatAggregationNumber(42.7, false)).toBe('43'); // rounds
        expect(g.formatAggregationNumber(99.1, false)).toBe('99');
    });

    it('respects custom precision', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.formatAggregationNumber(1.234567, true, 6)).toBe('1.234567');
        expect(g.formatAggregationNumber(5.5, true, 2)).toBe('5.50');
        expect(g.formatAggregationNumber(100.123, true, 1)).toBe('100.1');
    });

    it('rounds using half-up rounding (default)', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.formatAggregationNumber(2.345, true, 2)).toBe('2.35'); // 2.345 → 2.35
        expect(g.formatAggregationNumber(2.344, true, 2)).toBe('2.34');
        expect(g.formatAggregationNumber(1.005, true, 2)).toBe('1.01');
    });

    it('handles negative numbers', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.formatAggregationNumber(-1000, false)).toBe('-1 000');
        expect(g.formatAggregationNumber(-3.1415, true, 4)).toBe('-3.1415');
    });

    it('handles large numbers with thousand separators', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.formatAggregationNumber(123456789, false)).toBe('123 456 789');
    });

    it('returns string value for non-numeric input', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.formatAggregationNumber('N/A')).toBe('N/A');
    });

    it('precision of 0 produces integer-like output (no decimal part)', () => {
        const g = require('../../media/resultPanel/grid.js');
        const result = g.formatAggregationNumber(99.9, true, 0);
        expect(result).toBe('100');
        expect(result).not.toContain('.');
    });
});

describe('getAggregationSymbol', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    it('returns Σ for sum', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.getAggregationSymbol('sum')).toBe('Σ');
    });

    it('returns # for count', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.getAggregationSymbol('count')).toBe('#');
    });

    it('returns ◊ for countDistinct', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.getAggregationSymbol('countDistinct')).toBe('◊');
    });

    it('returns μ for avg', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.getAggregationSymbol('avg')).toBe('μ');
    });

    it('returns ↓ for min', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.getAggregationSymbol('min')).toBe('↓');
    });

    it('returns ↑ for max', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.getAggregationSymbol('max')).toBe('↑');
    });

    it('returns σ for stdev', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.getAggregationSymbol('stdev')).toBe('σ');
    });

    it('returns the function name as-is for unknown symbols', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.getAggregationSymbol('customFunc')).toBe('customFunc');
    });

    it('handles object format with .fn property', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.getAggregationSymbol({ fn: 'sum', precision: null })).toBe('Σ');
        expect(g.getAggregationSymbol({ fn: 'avg', precision: 2 })).toBe('μ');
    });

    it('returns fn value for unknown object format', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.getAggregationSymbol({ fn: 'unknownAgg' })).toBe('unknownAgg');
    });
});

describe('getAggFn', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    it('returns string agg as-is', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.getAggFn('sum')).toBe('sum');
    });

    it('extracts .fn from object format', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.getAggFn({ fn: 'avg', precision: 2 })).toBe('avg');
    });

    it('returns empty string for null/undefined fn', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.getAggFn({})).toBe('');
    });
});

describe('getAggPrecision', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    it('returns null for string agg', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.getAggPrecision('sum')).toBeNull();
    });

    it('extracts precision from object format', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.getAggPrecision({ fn: 'avg', precision: 4 })).toBe(4);
    });

    it('returns null when precision is not set in object', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.getAggPrecision({ fn: 'sum' })).toBeNull();
    });

    it('returns null when precision is explicitly null', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.getAggPrecision({ fn: 'sum', precision: null })).toBeNull();
    });

    it('returns null for non-object input', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.getAggPrecision(null)).toBeNull();
    });
});

describe('getAggregationColumnTypeInfo', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    it('returns isNumeric true for integer column', () => {
        const g = require('../../media/resultPanel/grid.js');
        const info = g.getAggregationColumnTypeInfo({ columnDef: { dataType: 'integer' } });
        expect(info.isNumeric).toBe(true);
        expect(info.isInteger).toBe(true);
    });

    it('returns isNumeric true for decimal column', () => {
        const g = require('../../media/resultPanel/grid.js');
        const info = g.getAggregationColumnTypeInfo({ columnDef: { dataType: 'decimal' } });
        expect(info.isNumeric).toBe(true);
        expect(info.hasDecimal).toBe(true);
    });

    it('returns isNumeric false for text column', () => {
        const g = require('../../media/resultPanel/grid.js');
        const info = g.getAggregationColumnTypeInfo({ columnDef: { dataType: 'varchar' } });
        expect(info.isNumeric).toBe(false);
    });

    it('handles empty columnDef gracefully', () => {
        const g = require('../../media/resultPanel/grid.js');
        const info = g.getAggregationColumnTypeInfo({});
        expect(info.isNumeric).toBe(false);
    });
});

describe('calculateAggregation', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    type MockRow = { getValue: (id: string) => unknown };
    function row(value: unknown): MockRow {
        return { getValue: () => value };
    }
    function col(def: { dataType?: string; scale?: number } = {}): {
        id: string;
        columnDef: { dataType?: string; scale?: number; inferredNumericKind?: string; inferredDateInteger?: boolean };
    } {
        return { id: 'amount', columnDef: { ...def } };
    }

    it('calculates sum', () => {
        const g = require('../../media/resultPanel/grid.js');
        const rows = [row(10), row(20), row(30)];
        const result = g.calculateAggregation('sum', rows, col(), { isNumeric: true, hasDecimal: false, isInteger: true });
        expect(result).toBe('60');
    });

    it('calculates count', () => {
        const g = require('../../media/resultPanel/grid.js');
        const rows = [row(10), row(null), row(30)];
        const result = g.calculateAggregation('count', rows, col());
        expect(result).toBe('2'); // only non-null values
    });

    it('calculates countDistinct', () => {
        const g = require('../../media/resultPanel/grid.js');
        const rows = [row(10), row(20), row(10), row(30)];
        const result = g.calculateAggregation('countDistinct', rows, col({ dataType: 'integer' }));
        expect(result).toBe('3'); // 10, 20, 30
    });

    it('calculates avg', () => {
        const g = require('../../media/resultPanel/grid.js');
        const rows = [row(10), row(20), row(30)];
        const result = g.calculateAggregation('avg', rows, col(), { isNumeric: true, hasDecimal: false, isInteger: true });
        expect(result).toBe('20');
    });

    it('calculates min', () => {
        const g = require('../../media/resultPanel/grid.js');
        const rows = [row(50), row(10), row(30)];
        const result = g.calculateAggregation('min', rows, col(), { isNumeric: true, hasDecimal: false, isInteger: true });
        expect(result).toBe('10');
    });

    it('calculates max', () => {
        const g = require('../../media/resultPanel/grid.js');
        const rows = [row(10), row(50), row(30)];
        const result = g.calculateAggregation('max', rows, col(), { isNumeric: true, hasDecimal: false, isInteger: true });
        expect(result).toBe('50');
    });

    it('handles empty rows gracefully', () => {
        const g = require('../../media/resultPanel/grid.js');
        const result = g.calculateAggregation('sum', [], col());
        expect(result).toBe('');
    });

    it('handles all-null rows gracefully', () => {
        const g = require('../../media/resultPanel/grid.js');
        const rows = [row(null), row(null)];
        expect(g.calculateAggregation('sum', rows, col())).toBe('');
        expect(g.calculateAggregation('count', rows, col())).toBe('0');
    });

    it('uses object format for agg with custom precision', () => {
        const g = require('../../media/resultPanel/grid.js');
        const rows = [row(1.234), row(5.678)];
        const result = g.calculateAggregation(
            { fn: 'avg', precision: 2 },
            rows,
            col({ dataType: 'decimal' })
        );
        // (1.234 + 5.678) / 2 = 3.456 → rounded to 2dp → 3.46
        expect(result).toBe('3.46');
    });

    it('calculates stdev', () => {
        const g = require('../../media/resultPanel/grid.js');
        const rows = [row(2), row(4), row(4), row(4), row(5), row(5), row(7), row(9)];
        const result = g.calculateAggregation('stdev', rows, col({ dataType: 'decimal' }));
        // mean = 5, variance = 4, stdev = 2
        expect(parseFloat(result)).toBeCloseTo(2, 0);
    });

    it('returns empty string for unknown aggregation type', () => {
        const g = require('../../media/resultPanel/grid.js');
        const rows = [row(10)];
        expect(g.calculateAggregation('unknownFn', rows, col())).toBe('');
    });
});

describe('calculateAggregationForRows', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    type MockRow = { getValue: (id: string) => unknown };
    function row(value: unknown): MockRow {
        return { getValue: () => value };
    }
    function col(): { id: string; columnDef: { dataType?: string } } {
        return { id: 'amount', columnDef: {} };
    }

    it('calculates sum for grouped rows', () => {
        const g = require('../../media/resultPanel/grid.js');
        const rows = [row(10), row(20), row(30)];
        const result = g.calculateAggregationForRows('sum', rows, col());
        expect(result).toBe('60');
    });

    it('calculates count for grouped rows (non-null values)', () => {
        const g = require('../../media/resultPanel/grid.js');
        const rows = [row(10), row(null), row(30)];
        const result = g.calculateAggregationForRows('count', rows, col());
        expect(result).toBe('2');
    });

    it('returns empty string for unknown agg in grouped rows', () => {
        const g = require('../../media/resultPanel/grid.js');
        const rows = [row(10)];
        expect(g.calculateAggregationForRows('unknownFn', rows, col())).toBe('');
    });
});

describe('countLeafRows', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    // Helper: create a mock TanStack row with the shape countLeafRows expects
    type GroupableRow = {
        getIsGrouped?: () => boolean;
        subRows?: GroupableRow[];
    };

    function leafRow(): GroupableRow {
        return {}; // getIsGrouped is undefined → ?.() returns undefined → falsy → leaf
    }

    function groupRow(children: GroupableRow[]): GroupableRow {
        return {
            getIsGrouped: () => true,
            subRows: children,
        };
    }

    it('returns 1 for a leaf row (not grouped)', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.countLeafRows(leafRow())).toBe(1);
    });

    it('returns 0 for an empty group', () => {
        const g = require('../../media/resultPanel/grid.js');
        expect(g.countLeafRows(groupRow([]))).toBe(0);
    });

    it('counts all leaf rows in a single-level group', () => {
        const g = require('../../media/resultPanel/grid.js');
        const row = groupRow([leafRow(), leafRow(), leafRow()]);
        expect(g.countLeafRows(row)).toBe(3);
    });

    it('counts leaf rows in nested groups', () => {
        const g = require('../../media/resultPanel/grid.js');
        // Group A has:
        //   - Group B (2 leaves)
        //   - Leaf 1
        // Total = 2 + 1 = 3
        const groupB = groupRow([leafRow(), leafRow()]);
        const row = groupRow([groupB, leafRow()]);
        expect(g.countLeafRows(row)).toBe(3);
    });

    it('handles deeply nested groups', () => {
        const g = require('../../media/resultPanel/grid.js');
        // Level 3: Group C (2 leaves)
        // Level 2: Group B (Group C + 1 leaf = 3)
        // Level 1: Group A (Group B + 1 leaf = 4)
        const groupC = groupRow([leafRow(), leafRow()]);
        const groupB = groupRow([groupC, leafRow()]);
        const groupA = groupRow([groupB, leafRow()]);
        expect(g.countLeafRows(groupA)).toBe(4);
    });

    it('handles a group with a mix of leaves and sub-groups', () => {
        const g = require('../../media/resultPanel/grid.js');
        // Group has: Leaf, Group(2 leaves), Leaf, Group(1 leaf), Leaf
        // Total = 1 + 2 + 1 + 1 + 1 = 6
        const innerGroupA = groupRow([leafRow(), leafRow()]);
        const innerGroupB = groupRow([leafRow()]);
        const row = groupRow([leafRow(), innerGroupA, leafRow(), innerGroupB, leafRow()]);
        expect(g.countLeafRows(row)).toBe(6);
    });

});
