import { describe, expect, it } from '@jest/globals';
import {
  formatCellsAsInList,
  formatCellsAsInsert,
  formatCellsAsJson,
  formatGridCellId,
  getGridSelectionBounds,
  getSelectedGridRowIndices,
  gridSelectionColumnRange,
  gridSelectionContains,
  normalizeGridSelection,
  parseGridCellId,
} from '../src';

describe('renderer-neutral result-grid selection', () => {
  it('normalizes anchor/focus selection in either direction', () => {
    expect(normalizeGridSelection({ anchorRow: 5, anchorColumn: 3, focusRow: 2, focusColumn: 1 })).toEqual({
      minRow: 2, maxRow: 5, minColumn: 1, maxColumn: 3,
    });
    expect(gridSelectionContains({ minRow: 2, maxRow: 5, minColumn: 1, maxColumn: 3 }, 3, 2)).toBe(true);
    expect(gridSelectionContains({ minRow: 2, maxRow: 5, minColumn: 1, maxColumn: 3 }, 6, 2)).toBe(false);
    expect(normalizeGridSelection(undefined)).toBeUndefined();
  });

  it('projects raw column indexes onto display positions', () => {
    expect(gridSelectionColumnRange(
      { anchorRow: 0, anchorColumn: 7, focusRow: 0, focusColumn: 2 },
      [7, 3, 2, 9],
    )).toEqual({ minColumn: 0, maxColumn: 2 });
    expect(gridSelectionColumnRange(undefined, [1, 2])).toBeUndefined();
    // An unmounted column keeps its raw index, matching the renderer fallback.
    expect(gridSelectionColumnRange(
      { anchorRow: 0, anchorColumn: 42, focusRow: 0, focusColumn: 1 },
      [1, 2],
    )).toEqual({ minColumn: 0, maxColumn: 42 });
  });

  it('parses legacy cell ids and derives copy bounds', () => {
    expect(parseGridCellId('3-7')).toEqual({ row: 3, column: 7 });
    expect(parseGridCellId('3')).toBeNull();
    expect(parseGridCellId('1.5-2')).toBeNull();
    expect(formatGridCellId(3, 7)).toBe('3-7');
    expect(getGridSelectionBounds(new Set(['2-3', '0-1', '5-0']))).toEqual({
      minRow: 0, maxRow: 5, minColumn: 0, maxColumn: 3,
    });
    expect(getGridSelectionBounds(new Set())).toBeNull();
    expect(getSelectedGridRowIndices(new Set(['0-0', '0-2', '4-1']))).toEqual(new Set([0, 4]));
  });
});

describe('shared typed clipboard formats', () => {
  it('keeps duplicate headers and exact numeric digits in JSON', () => {
    const json = formatCellsAsJson(['ID', 'ID'], [
      [
        { text: '9 007 199 254 740 993', kind: 'number', numericValue: '9007199254740993', rawValue: '9007199254740993' },
        { text: 'x', kind: 'text', rawValue: 'x' },
      ],
    ]);
    expect(JSON.parse(json)).toEqual([{ ID: '9007199254740993', ID_2: 'x' }]);
  });

  it('formats SQL INSERT and IN lists from raw values', () => {
    expect(formatCellsAsInsert(['ID', 'NAME'], [[
      { text: '1', kind: 'number', numericValue: '1', rawValue: 1 },
      { text: "O'Brien", kind: 'text', rawValue: "O'Brien" },
    ]])).toBe("INSERT INTO TARGET_TABLE (ID, NAME) VALUES (1, 'O''Brien');");
    expect(formatCellsAsInList([[
      { text: "O'Brien", kind: 'text', rawValue: "O'Brien" },
      { text: 'NULL', kind: 'text', rawValue: null },
    ], [
      { text: 'A', kind: 'text', rawValue: 'A' },
      { text: '1', kind: 'number', numericValue: '1', rawValue: 1 },
    ]])).toBe("IN ('O''Brien', 'A', 1)");
  });
});
