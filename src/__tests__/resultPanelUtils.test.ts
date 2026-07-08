// Unit tests for pure utility functions in utils.js
// Complements resultPanelNumericFormatting.test.ts — focuses on coverage gaps:
//   - formatCellValue: Date objects, YYYYMMDD integer dates, generic objects, booleans, null/undefined
//   - getNumericTypeInfo: all type aliases, full return shape, case insensitivity, null/empty
//   - inferNumericTypeFromRows: empty/mixed/non-numeric rows, sampling limit
//
// Pattern follows resultPanelStateScroll.test.ts — require() inside it() blocks.

import { describe, expect, it, beforeEach } from '@jest/globals';

// utils.js imports from state.js and protocol.js, but those modules are side-effect-free
// in test environment (no DOM, no window globals needed for the tested code paths).

describe('formatCellValue — edge cases and non-numeric paths', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    describe('null / undefined', () => {
        it('returns null when value is null', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            expect(formatCellValue(null, 'varchar')).toBeNull();
        });

        it('returns null when value is undefined', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            expect(formatCellValue(undefined, 'varchar')).toBeNull();
        });
    });

    describe('inferredDateInteger', () => {
        it('formats valid YYYYMMDD integer with spaces', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            expect(formatCellValue(20260315, 'int', undefined, { inferredDateInteger: true })).toBe('2026 03 15');
        });

        it('formats valid YYYYMMDD as string', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            expect(formatCellValue('20240101', 'int', undefined, { inferredDateInteger: true })).toBe('2024 01 01');
        });

        it('falls through when value is not a valid YYYYMMDD date', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            // 99991231 is valid YYYYMMDD → should format
            expect(formatCellValue(99991231, 'int', undefined, { inferredDateInteger: true })).toBe('9999 12 31');
            // 10000100 is invalid (month 00) → falls through to numeric formatting
            const result = formatCellValue(10000100, 'int', undefined, { inferredDateInteger: true });
            expect(result).not.toContain('1000 01 00');
        });
    });

    describe('Date objects', () => {
        it('formats Date with type "date" as YYYY-MM-DD (UTC)', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            const date = new Date(Date.UTC(2024, 0, 15));
            expect(formatCellValue(date, 'date')).toBe('2024-01-15');
        });

        it('formats Date with type "timestamp" including time part', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            const date = new Date(Date.UTC(2024, 5, 15, 14, 30, 45));
            expect(formatCellValue(date, 'timestamp')).toBe('2024-06-15 14:30:45');
        });

        it('formats Date with type "datetime" including time part', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            const date = new Date(Date.UTC(2024, 11, 25, 8, 5, 0));
            expect(formatCellValue(date, 'datetime')).toBe('2024-12-25 08:05:00');
        });

        it('formats Date with type "time" includes time part', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            const date = new Date(Date.UTC(2024, 0, 1, 23, 59, 59));
            expect(formatCellValue(date, 'time')).toBe('2024-01-01 23:59:59');
        });
    });

    describe('Netezza DATE as YYYYMMDD integer', () => {
        it('formats 8-digit integer as YYYY-MM-DD when type is "date"', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            expect(formatCellValue(20260402, 'date')).toBe('2026-04-02');
        });

        it('does not format non-8-digit integers', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            // 123456789 is 9 digits → should use String() fallback
            expect(formatCellValue(123456789, 'date')).toBe('123456789');
        });

        it('does not format numbers outside the 19000000-21000000 range', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            expect(formatCellValue(18000101, 'date')).toBe('18000101');
            expect(formatCellValue(22000101, 'date')).toBe('22000101');
        });
    });

    describe('generic objects', () => {
        it('formats object with custom toString', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            const obj = { toString: () => 'custom-value' };
            expect(formatCellValue(obj, 'varchar')).toBe('custom-value');
        });

        it('formats Time-like object {hours, minutes, seconds}', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            const time = { hours: 14, minutes: 30, seconds: 45 };
            expect(formatCellValue(time, 'time')).toBe('14:30:45');
        });

        it('pads single-digit time components', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            const time = { hours: 1, minutes: 2, seconds: 3 };
            expect(formatCellValue(time, 'time')).toBe('01:02:03');
        });

        it('handles partial time object (missing seconds)', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            const time = { hours: 9, minutes: 5 };
            expect(formatCellValue(time, 'time')).toBe('09:05:00');
        });

        it('returns [object Object] for plain object', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            const obj = { foo: 'bar' };
            expect(formatCellValue(obj, 'varchar')).toBe('[object Object]');
        });
    });

    describe('string and primitive values', () => {
        it('formats plain strings as-is', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            expect(formatCellValue('hello', 'varchar')).toBe('hello');
        });

        it('formats empty string as empty string', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            expect(formatCellValue('', 'varchar')).toBe('');
        });

        it('formats boolean true', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            expect(formatCellValue(true, 'boolean')).toBe('true');
        });

        it('formats boolean false', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            expect(formatCellValue(false, 'boolean')).toBe('false');
        });

        it('formats number 0', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            expect(formatCellValue(0, 'int')).toBe('0');
        });

        it('formats negative integer', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            expect(formatCellValue(-42, 'int')).toBe('-42');
        });

        it('formats non-numeric type varchar with number value', () => {
            const { formatCellValue } = require('../../media/resultPanel/utils.js');
            // varchar type, number value → should just String(value)
            expect(formatCellValue(42, 'varchar')).toBe('42');
        });
    });
});

describe('getNumericTypeInfo — comprehensive type alias coverage', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    describe('integer types', () => {
        const integerTypes = [
            'tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint',
            'byteint', 'hugeint', 'uhugeint',
            'serial', 'smallserial', 'bigserial', 'serial2', 'serial4', 'serial8',
            'int1', 'int2', 'int4', 'int8', 'int16', 'int32', 'int64',
            'utinyint', 'usmallint', 'uinteger', 'ubigint',
            'uint8', 'uint16', 'uint32', 'uint64',
        ];

        integerTypes.forEach(type => {
            it(`identifies "${type}" as integer`, () => {
                const { getNumericTypeInfo } = require('../../media/resultPanel/utils.js');
                const info = getNumericTypeInfo(type);
                expect(info.isNumeric).toBe(true);
                expect(info.numericKind).toBe('integer');
                expect(info.isInteger).toBe(true);
                expect(info.hasDecimal).toBe(false);
            });
        });
    });

    describe('decimal types', () => {
        const decimalTypes = [
            'numeric', 'decimal', 'dec', 'number', 'fixed',
            'float', 'float4', 'float8', 'real', 'double',
            'double precision', 'binary_float', 'binary_double',
            'single', 'single precision', 'decfloat',
            'money', 'smallmoney',
        ];

        decimalTypes.forEach(type => {
            it(`identifies "${type}" as decimal`, () => {
                const { getNumericTypeInfo } = require('../../media/resultPanel/utils.js');
                const info = getNumericTypeInfo(type);
                expect(info.isNumeric).toBe(true);
                expect(info.numericKind).toBe('decimal');
                expect(info.isInteger).toBe(false);
                expect(info.hasDecimal).toBe(true);
            });
        });
    });

    describe('non-numeric types', () => {
        const nonNumericTypes = [
            'varchar', 'char', 'text', 'nchar', 'nvarchar', 'clob', 'blob',
            'boolean', 'bool', 'interval', 'json', 'xml', 'uuid',
            'geometry', 'geography', 'inet', 'cidr', 'macaddr',
        ];

        nonNumericTypes.forEach(type => {
            it(`identifies "${type}" as non-numeric`, () => {
                const { getNumericTypeInfo } = require('../../media/resultPanel/utils.js');
                const info = getNumericTypeInfo(type);
                expect(info.isNumeric).toBe(false);
                expect(info.numericKind).toBe('none');
                expect(info.isInteger).toBe(false);
                expect(info.hasDecimal).toBe(false);
            });
        });
    });

    describe('edge cases', () => {
        it('handles null type', () => {
            const { getNumericTypeInfo } = require('../../media/resultPanel/utils.js');
            const info = getNumericTypeInfo(null);
            expect(info.isNumeric).toBe(false);
        });

        it('handles undefined type', () => {
            const { getNumericTypeInfo } = require('../../media/resultPanel/utils.js');
            const info = getNumericTypeInfo(undefined);
            expect(info.isNumeric).toBe(false);
        });

        it('handles empty string type', () => {
            const { getNumericTypeInfo } = require('../../media/resultPanel/utils.js');
            const info = getNumericTypeInfo('');
            expect(info.isNumeric).toBe(false);
        });

        it('is case insensitive', () => {
            const { getNumericTypeInfo } = require('../../media/resultPanel/utils.js');
            expect(getNumericTypeInfo('INT').isNumeric).toBe(true);
            expect(getNumericTypeInfo('Int').isNumeric).toBe(true);
            expect(getNumericTypeInfo('int').isNumeric).toBe(true);
            expect(getNumericTypeInfo('FLOAT').isNumeric).toBe(true);
            expect(getNumericTypeInfo('Float').isNumeric).toBe(true);
            expect(getNumericTypeInfo('VARCHAR').isNumeric).toBe(false);
            expect(getNumericTypeInfo('Varchar').isNumeric).toBe(false);
        });

        it('handles types with extra whitespace', () => {
            const { getNumericTypeInfo } = require('../../media/resultPanel/utils.js');
            expect(getNumericTypeInfo('  int  ').isNumeric).toBe(true);
            expect(getNumericTypeInfo('  decimal  ').isNumeric).toBe(true);
            expect(getNumericTypeInfo('  varchar  ').isNumeric).toBe(false);
        });

        it('handles scale-sensitive types with zero scale as integer', () => {
            const { getNumericTypeInfo } = require('../../media/resultPanel/utils.js');
            // numeric(18,0) → scale 0 → integer
            const info = getNumericTypeInfo('numeric(18,0)');
            expect(info.isNumeric).toBe(true);
            expect(info.numericKind).toBe('integer');
            expect(info.isInteger).toBe(true);
        });

        it('handles scale-sensitive types with positive scale as decimal', () => {
            const { getNumericTypeInfo } = require('../../media/resultPanel/utils.js');
            // decimal(10,2) → scale 2 → decimal
            const info = getNumericTypeInfo('decimal(10,2)');
            expect(info.isNumeric).toBe(true);
            expect(info.numericKind).toBe('decimal');
        });
    });
});

describe('inferNumericTypeFromRows — sampling and edge cases', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    it('detects integer from integer values', () => {
        const { inferNumericTypeFromRows } = require('../../media/resultPanel/utils.js');
        const result = inferNumericTypeFromRows([[1], [2], [3]], 0);
        expect(result).toEqual({
            dataType: '__inferred_integer__',
            scale: undefined,
            numericKind: 'integer',
        });
    });

    it('detects decimal from decimal values', () => {
        const { inferNumericTypeFromRows } = require('../../media/resultPanel/utils.js');
        const result = inferNumericTypeFromRows([['1.5'], ['2.75']], 0);
        expect(result).toEqual({
            dataType: '__inferred_decimal__',
            scale: 4,
            numericKind: 'decimal',
        });
    });

    it('returns none for empty rows array', () => {
        const { inferNumericTypeFromRows } = require('../../media/resultPanel/utils.js');
        const result = inferNumericTypeFromRows([], 0);
        expect(result).toEqual({
            dataType: undefined,
            scale: undefined,
            numericKind: 'none',
        });
    });

    it('returns none when all values are null', () => {
        const { inferNumericTypeFromRows } = require('../../media/resultPanel/utils.js');
        const result = inferNumericTypeFromRows([[null], [null], [null]], 0);
        expect(result.numericKind).toBe('none');
    });

    it('returns none when all values are undefined', () => {
        const { inferNumericTypeFromRows } = require('../../media/resultPanel/utils.js');
        const result = inferNumericTypeFromRows([[undefined], [undefined]], 0);
        expect(result.numericKind).toBe('none');
    });

    it('skips null values when other values are present', () => {
        const { inferNumericTypeFromRows } = require('../../media/resultPanel/utils.js');
        const result = inferNumericTypeFromRows([[null], [42], [null]], 0);
        expect(result.numericKind).toBe('integer');
    });

    it('returns decimal when mixed integer and decimal values exist', () => {
        const { inferNumericTypeFromRows } = require('../../media/resultPanel/utils.js');
        const result = inferNumericTypeFromRows([[1], [2.5], [3]], 0);
        expect(result.numericKind).toBe('decimal');
    });

    it('returns none when all values are non-numeric strings', () => {
        const { inferNumericTypeFromRows } = require('../../media/resultPanel/utils.js');
        const result = inferNumericTypeFromRows([['abc'], ['xyz']], 0);
        expect(result.numericKind).toBe('none');
    });

    it('handles single row', () => {
        const { inferNumericTypeFromRows } = require('../../media/resultPanel/utils.js');
        expect(inferNumericTypeFromRows([[99]], 0).numericKind).toBe('integer');
        expect(inferNumericTypeFromRows([['3.14']], 0).numericKind).toBe('decimal');
        expect(inferNumericTypeFromRows([['text']], 0).numericKind).toBe('none');
    });

    it('samples only first 100 rows', () => {
        const { inferNumericTypeFromRows } = require('../../media/resultPanel/utils.js');
        // 150 rows: first 100 are integers, next 50 are decimal
        // Should only sample first 100 → integer
        const rows = [];
        for (let i = 0; i < 100; i++) {
            rows.push([i]);
        }
        rows.push([1.5]); // this should NOT be sampled
        const result = inferNumericTypeFromRows(rows, 0);
        expect(result.numericKind).toBe('integer');
    });

    it('detects decimal within first 100 rows of large dataset', () => {
        const { inferNumericTypeFromRows } = require('../../media/resultPanel/utils.js');
        // 200 rows: first 50 are integers, next 50 are decimal
        const rows = [];
        for (let i = 0; i < 50; i++) {
            rows.push([i]);
        }
        for (let i = 0; i < 50; i++) {
            rows.push([i + 0.5]);
        }
        for (let i = 0; i < 100; i++) {
            rows.push([i + 100]);
        }
        const result = inferNumericTypeFromRows(rows, 0);
        expect(result.numericKind).toBe('decimal');
    });

    it('handles large numeric values', () => {
        const { inferNumericTypeFromRows } = require('../../media/resultPanel/utils.js');
        const result = inferNumericTypeFromRows([[9999999999], [12345678901]], 0);
        expect(result.numericKind).toBe('integer');
    });

    it('treats string numbers as parseable values', () => {
        const { inferNumericTypeFromRows } = require('../../media/resultPanel/utils.js');
        const result = inferNumericTypeFromRows([['42'], ['100']], 0);
        expect(result.numericKind).toBe('integer');
    });
});

describe('parseTemporalSortKey', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    it('parses YYYYMMDD strings when inferredDateInteger is set', () => {
        const { parseTemporalSortKey } = require('../../media/resultPanel/utils.js');
        expect(parseTemporalSortKey('20230101', 'integer', { inferredDateInteger: true })).toBe(20230101);
        expect(parseTemporalSortKey('20241231', 'integer', { inferredDateInteger: true })).toBe(20241231);
        expect(
            parseTemporalSortKey('20230101', 'integer', { inferredDateInteger: true })
            < parseTemporalSortKey('20241231', 'integer', { inferredDateInteger: true }),
        ).toBe(true);
    });

    it('aligns numeric and string YYYYMMDD keys for mixed rows', () => {
        const { parseTemporalSortKey } = require('../../media/resultPanel/utils.js');
        const options = { inferredDateInteger: true as const };
        expect(parseTemporalSortKey(20230101, 'integer', options)).toBe(
            parseTemporalSortKey('20230101', 'integer', options),
        );
    });

    it('does not treat bare YYYYMMDD strings as dates without inferredDateInteger', () => {
        const { parseTemporalSortKey } = require('../../media/resultPanel/utils.js');
        expect(Number.isNaN(parseTemporalSortKey('20230101', 'integer'))).toBe(true);
    });
});
