/**
 * Unit tests for media/resultPanel/utils.js and media/resultPanel/export.js
 *
 * Covers:
 *  - escapeCsvValue
 *  - escapeSqlStringLiteral (indirectly via formatCellValueForSql)
 *  - formatCellValueForSql
 *  - getValueForExport
 *  - getSelectedIndices
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// Mock dependencies needed by the modules under test
jest.mock('../../media/resultPanel/messages.js', () => ({
    getSavedStateFor: jest.fn(),
    saveAllGridStates: jest.fn()
}));

jest.mock('../../media/resultPanel/filter.js', () => ({
    createHeaderCellWithFilter: jest.fn(),
    reorderColumnsForPinning: jest.fn()
}));

jest.mock('../../media/resultPanel/selection.js', () => ({
    setupCellSelectionEvents: jest.fn(() => ({}))
}));

jest.mock('../../media/resultPanel/formatting.js', () => ({
    getCurrentExportFormattingMetadata: jest.fn(() => ({}))
}));

jest.mock('../../media/resultPanel/protocol.js', () => ({
    postHostMessage: jest.fn()
}));

jest.mock('../../media/resultPanel/state.js', () => ({
    getActiveGridIndex: jest.fn(() => 0),
    getAllGrids: jest.fn(() => []),
    getGrid: jest.fn(() => null),
    getGlobalDragState: jest.fn(() => ({ isDragging: false, dragType: null, draggedItem: null })),
    getResultFormattingPayload: jest.fn(() => null),
    getResultFormattingState: jest.fn(() => null)
}));

// ────────────────────────────────────────────────────────────────────────────
// utils.js helpers
// ────────────────────────────────────────────────────────────────────────────

describe('escapeCsvValue', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    function escape(value: unknown) {
        const { escapeCsvValue } = require('../../media/resultPanel/utils.js');
        return escapeCsvValue(value);
    }

    it('returns empty string for null and undefined', () => {
        expect(escape(null)).toBe('');
        expect(escape(undefined)).toBe('');
    });

    it('returns the string unchanged when no special characters', () => {
        expect(escape('hello')).toBe('hello');
        expect(escape('123')).toBe('123');
        expect(escape('')).toBe('');
    });

    it('quotes values containing commas', () => {
        expect(escape('a,b')).toBe('"a,b"');
    });

    it('doubles embedded double quotes', () => {
        expect(escape('say "hi"')).toBe('"say ""hi"""');
        expect(escape('')).toBe('');
    });

    it('quotes values containing newlines', () => {
        expect(escape('line1\nline2')).toBe('"line1\nline2"');
    });

    it('quotes values containing carriage returns', () => {
        expect(escape('a\rb')).toBe('"a\rb"');
    });

    it('quotes values containing both comma and quote', () => {
        expect(escape('a,"b"')).toBe('"a,""b"""');
    });

    it('converts non-string values via String()', () => {
        expect(escape(42)).toBe('42');
        expect(escape(0)).toBe('0');
        expect(escape(true)).toBe('true');
        expect(escape(false)).toBe('false');
    });

    it('does not quote values with only whitespace', () => {
        expect(escape('   ')).toBe('   ');
        expect(escape('\t')).toBe('\t');
    });
});

describe('formatCellValueForSql', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    function fmt(value: unknown, type?: string, scale?: number, context?: Record<string, unknown>) {
        const { formatCellValueForSql } = require('../../media/resultPanel/utils.js');
        return formatCellValueForSql(value, type, scale, context);
    }

    it('returns NULL for null and undefined', () => {
        expect(fmt(null)).toBe('NULL');
        expect(fmt(undefined)).toBe('NULL');
    });

    it('returns TRUE and FALSE for booleans', () => {
        expect(fmt(true)).toBe('TRUE');
        expect(fmt(false)).toBe('FALSE');
    });

    it('returns numeric values without quotes', () => {
        expect(fmt(42)).toBe('42');
        expect(fmt(0)).toBe('0');
        expect(fmt(-7)).toBe('-7');
        expect(fmt(3.14)).toBe('3.14');
    });

    it('returns numeric strings without quotes for numeric types', () => {
        expect(fmt('123456', 'numeric', 4)).toBe('123456');
        expect(fmt('99.99', 'decimal', 2)).toBe('99.99');
    });

    it('returns bigints as plain numbers', () => {
        expect(fmt(BigInt('99999999999999'))).toBe('99999999999999');
    });

    it('quotes string values with single-quote escaping', () => {
        expect(fmt('hello', 'varchar')).toBe("'hello'");
        expect(fmt("O'Reilly", 'varchar')).toBe("'O''Reilly'");
        expect(fmt("it's", 'char')).toBe("'it''s'");
    });

    it('handles empty string', () => {
        expect(fmt('', 'varchar')).toBe("''");
    });

    it('quotes string values for non-numeric types', () => {
        expect(fmt('abc', 'text')).toBe("'abc'");
        expect(fmt('abc', 'clob')).toBe("'abc'");
    });

    it('returns TRUE/FALSE for boolean type strings', () => {
        expect(fmt('true', 'bool')).toBe('TRUE');
        expect(fmt('TRUE', 'boolean')).toBe('TRUE');
        expect(fmt('false', 'bool')).toBe('FALSE');
        expect(fmt('FALSE', 'boolean')).toBe('FALSE');
    });

    it('passes through date-like integer values for inferred date context', () => {
        expect(fmt(20260315, 'int', undefined, { inferredDateInteger: true })).toBe('20260315');
    });

    it('formats Date objects as string literals', () => {
        const date = new Date('2024-06-15T10:30:00.000Z');
        const result = fmt(date, 'date');
        expect(result).toContain('2024-06-15');
        expect(result).toMatch(/^'.*'$/);
    });
});

describe('getValueForExport', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    function getValue(row: Record<string, unknown>, columnId: string, resultSetColumns: Array<{ accessorKey?: string }>) {
        const { getValueForExport } = require('../../media/resultPanel/export.js');
        return getValueForExport(row, columnId, resultSetColumns);
    }

    it('returns value from array row by index', () => {
        const row = { original: [10, 'Alice', 3.14] };
        expect(getValue(row, '0', [])).toBe(10);
        expect(getValue(row, '1', [])).toBe('Alice');
        expect(getValue(row, '2', [])).toBe(3.14);
    });

    it('returns value from object row via accessorKey', () => {
        const row = { original: { id: 10, name: 'Alice' } };
        const columns = [
            { accessorKey: 'id' },
            { accessorKey: 'name' }
        ];
        expect(getValue(row, '0', columns)).toBe(10);
        expect(getValue(row, '1', columns)).toBe('Alice');
    });

    it('falls back to columnId for object rows without accessorKey', () => {
        const row = { original: { customCol: 'val' } };
        const columns = [{}];
        expect(getValue(row, 'customCol', columns)).toBe('val');
    });

    it('returns null for out-of-bounds index on array rows', () => {
        const row = { original: [1, 2] };
        expect(getValue(row, '5', [])).toBeNull();
    });

    it('returns null when row.original is missing', () => {
        const row = {};
        expect(getValue(row, '0', [])).toBeNull();
    });

    it('handles null values inside row data', () => {
        const row = { original: [1, null, 'x'] };
        expect(getValue(row, '1', [])).toBeNull();
    });

    it('returns value for single-element row', () => {
        const row = { original: [42] };
        expect(getValue(row, '0', [])).toBe(42);
    });
});

// Note: getSelectedIndices tests are omitted because they require jsdom
// (document.querySelectorAll). The project uses testEnvironment: 'node', and
// jest-environment-jsdom is not available. These tests would need either a
// jsdom environment or a different mocking strategy.
