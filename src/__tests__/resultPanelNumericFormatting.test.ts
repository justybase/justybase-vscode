import { beforeEach, describe, expect, it, jest } from '@jest/globals';

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

describe('result panel numeric formatting', () => {
    beforeEach(() => {
        jest.resetModules();
        (global as typeof globalThis & {
            acquireVsCodeApi?: () => { postMessage: jest.Mock; setState: jest.Mock; getState: jest.Mock };
        }).acquireVsCodeApi = jest.fn(() => ({
            postMessage: jest.fn(),
            setState: jest.fn(),
            getState: jest.fn()
        }));
    });

    it('pads scale-4 numeric values to exactly four decimals', () => {
        const { formatCellValue } = require('../../media/resultPanel/utils.js');

        expect(formatCellValue(1234.5678, 'numeric', 4)).toBe('1 234.5678');
        expect(formatCellValue(1234.25, 'numeric', 4)).toBe('1 234.2500');
        expect(formatCellValue(1234.1, 'numeric', 4)).toBe('1 234.1000');
        expect(formatCellValue(1234, 'numeric', 4)).toBe('1 234.0000');
    });

    it('keeps non scale-4 numeric values unchanged in precision behavior', () => {
        const { formatCellValue } = require('../../media/resultPanel/utils.js');

        expect(formatCellValue(1234.25, 'numeric', 2)).toBe('1 234.25');
        expect(formatCellValue(1234.1, 'numeric', 1)).toBe('1 234.1');
        expect(formatCellValue(1234, 'int')).toBe('1 234');
    });

    it('uses four decimal places by default for numeric columns, including whole values', () => {
        const { formatCellValue } = require('../../media/resultPanel/utils.js');

        expect(formatCellValue(123456.789, 'numeric')).toBe('123 456.7890');
        expect(formatCellValue(123456, 'numeric')).toBe('123 456.0000');
        expect(formatCellValue('123456.0000', 'decimal')).toBe('123 456.0000');
    });

    it('infers typeless decimal and integer columns from result rows', () => {
        const { inferNumericTypeFromRows, formatCellValue } = require('../../media/resultPanel/utils.js');

        expect(inferNumericTypeFromRows([[1], [2], [3]], 0)).toEqual({
            dataType: '__inferred_integer__',
            scale: undefined,
            numericKind: 'integer'
        });

        expect(inferNumericTypeFromRows([['1.0'], ['2.5']], 0)).toEqual({
            dataType: '__inferred_decimal__',
            scale: 4,
            numericKind: 'decimal'
        });

        expect(formatCellValue('42.1', undefined, undefined, { inferredNumericKind: 'decimal' })).toBe('42.1000');
        expect(formatCellValue('42', undefined, undefined, { inferredNumericKind: 'integer' })).toBe('42');
    });

    it('treats real and floating-point values as decimal even when reported scale is zero', () => {
        const { formatCellValue } = require('../../media/resultPanel/utils.js');

        expect(formatCellValue(0.123456, 'real', 0)).toBe('0.1235');
        expect(formatCellValue(0.987654, 'double precision', 0)).toBe('0.9877');
        expect(formatCellValue(0.456789, 'single', 0)).toBe('0.4568');
        expect(formatCellValue(0.50001, 'float8', 0)).toBe('0.5000');
    });

    it('recognizes cross-dialect numeric aliases without misclassifying interval types', () => {
        const { getNumericTypeInfo, formatCellValue } = require('../../media/resultPanel/utils.js');

        expect(getNumericTypeInfo('INT4')).toMatchObject({ isNumeric: true, numericKind: 'integer' });
        expect(getNumericTypeInfo('BIGSERIAL')).toMatchObject({ isNumeric: true, numericKind: 'integer' });
        expect(getNumericTypeInfo('BYTEINT')).toMatchObject({ isNumeric: true, numericKind: 'integer' });
        expect(getNumericTypeInfo('MEDIUMINT')).toMatchObject({ isNumeric: true, numericKind: 'integer' });
        expect(getNumericTypeInfo('HUGEINT')).toMatchObject({ isNumeric: true, numericKind: 'integer' });
        expect(getNumericTypeInfo('NUMBER(18,0)')).toMatchObject({ isNumeric: true, numericKind: 'integer' });
        expect(getNumericTypeInfo('BINARY_DOUBLE')).toMatchObject({ isNumeric: true, numericKind: 'decimal' });
        expect(getNumericTypeInfo('DECFLOAT(16)')).toMatchObject({ isNumeric: true, numericKind: 'decimal' });
        expect(getNumericTypeInfo('INTERVAL DAY TO SECOND')).toMatchObject({ isNumeric: false, numericKind: 'none' });

        expect(formatCellValue(12.34567, 'binary_double', 0)).toBe('12.3457');
        expect(formatCellValue('1234.5', 'decfloat(16)', 0)).toBe('1 234.5000');
    });

    it('right-aligns only numeric, date, and timestamp-like result cells', () => {
        const { shouldRightAlignCell } = require('../../media/resultPanel/utils.js');

        expect(shouldRightAlignCell('INT4')).toBe(true);
        expect(shouldRightAlignCell('NUMBER(18,0)')).toBe(true);
        expect(shouldRightAlignCell('DATE')).toBe(true);
        expect(shouldRightAlignCell('TIMESTAMP WITH TIME ZONE')).toBe(true);
        expect(shouldRightAlignCell('DATETIMEOFFSET')).toBe(true);
        expect(shouldRightAlignCell('TIMESTAMP_NTZ')).toBe(true);
        expect(shouldRightAlignCell('TIMESTAMP_NTZ WITHOUT TIME ZONE')).toBe(true);
        expect(shouldRightAlignCell('TIMESTAMP_LTZ WITH TIME ZONE')).toBe(true);
        expect(shouldRightAlignCell('TIMESTAMP_TZ WITH TIME ZONE')).toBe(true);
        expect(shouldRightAlignCell(undefined, { inferredNumericKind: 'integer' })).toBe(true);
        expect(shouldRightAlignCell(undefined, { inferredNumericKind: 'decimal' })).toBe(true);
        expect(shouldRightAlignCell('NUMERIC(18,0)', { value: '123' })).toBe(true);
        expect(shouldRightAlignCell('DATE', { value: 20260402 })).toBe(true);
        expect(shouldRightAlignCell('TIMESTAMP WITH TIME ZONE', { value: '2026-04-02 12:34:56' })).toBe(true);
        expect(shouldRightAlignCell('DATETIMEOFFSET', { value: '2026-04-02 12:34:56 +01:00' })).toBe(true);

        expect(shouldRightAlignCell('VARCHAR')).toBe(false);
        expect(shouldRightAlignCell('NVARCHAR(25)', { value: 'RIGHT' })).toBe(false);
        expect(shouldRightAlignCell('NVARCHAR(25)', { value: '2026-04-02 12:34:56 +01:00' })).toBe(false);
        expect(shouldRightAlignCell('CHARACTER VARYING')).toBe(false);
        expect(shouldRightAlignCell('VARCHAR', { value: '123' })).toBe(false);
        expect(shouldRightAlignCell('NUMERIC(18,0)', { value: 'RIGHT' })).toBe(false);
        expect(shouldRightAlignCell('TIMESTAMP WITH TIME ZONE', { value: 'RIGHT' })).toBe(false);
        expect(shouldRightAlignCell('DATETIMEOFFSET', { value: 'RIGHT' })).toBe(false);
        expect(shouldRightAlignCell('INTERVAL DAY TO SECOND')).toBe(false);
        expect(shouldRightAlignCell('TIME')).toBe(true);
    });

    it('infers YYYYMMDD integer date columns for display only', () => {
        const {
            inferYyyymmddIntegerDateFromValues,
            formatCellValue,
            formatCellValueForSql
        } = require('../../media/resultPanel/utils.js');

        expect(inferYyyymmddIntegerDateFromValues([20260315, 20260316, null, 20260317])).toBe(true);
        expect(inferYyyymmddIntegerDateFromValues([20260315, 12345678, 20260317])).toBe(false);

        expect(formatCellValue(20260315, 'int', undefined, { inferredDateInteger: true })).toBe('2026 03 15');
        expect(formatCellValueForSql(20260315, 'int', undefined, { inferredDateInteger: true })).toBe('20260315');
    });

    it('formats SQL insertion text without leaking display grouping or single quotes for identifiers', () => {
        const {
            formatCellValueForSql,
            formatSqlIdentifierForInsertion
        } = require('../../media/resultPanel/utils.js');

        expect(formatCellValueForSql(123456.789, 'numeric', 4)).toBe('123456.789');
        expect(formatCellValueForSql('123456.0000', 'decimal', 4)).toBe('123456.0000');
        expect(formatCellValueForSql("O'Reilly", 'varchar')).toBe("'O''Reilly'");
        expect(formatSqlIdentifierForInsertion('CUSTOMER_ID')).toBe('CUSTOMER_ID');
        expect(formatSqlIdentifierForInsertion('Order Date')).toBe('"Order Date"');
    });
});
