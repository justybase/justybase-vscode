import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../media/resultPanel/protocol.js', () => ({
    postHostMessage: jest.fn(),
}));

jest.mock('../../../media/resultPanel/state.js', () => ({
    getResultFormattingPayload: jest.fn(() => null),
    getResultFormattingState: jest.fn(() => null),
}));

describe('resultPanel utils numeric formatting', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    function formatCellValue(
        value: unknown,
        type?: string,
        scale?: number,
        context?: Record<string, unknown>,
    ): string | null {
        const { formatCellValue: format } = require('../../../media/resultPanel/utils.js');
        return format(value, type, scale, context);
    }

    function inferYyyymmddIntegerDateFromValues(values: unknown[]): boolean {
        const { inferYyyymmddIntegerDateFromValues: infer } = require('../../../media/resultPanel/utils.js');
        return infer(values);
    }

    it('formats inferred YYYYMMDD integer dates with separators', () => {
        expect(formatCellValue(20240615, '__inferred_integer__', undefined, {
            inferredDateInteger: true,
        })).toBe('2024 06 15');
    });

    it('rejects invalid YYYYMMDD integer date samples during inference', () => {
        expect(inferYyyymmddIntegerDateFromValues([
            20240615,
            20240616,
            20240230,
        ])).toBe(false);
    });

    it('formats decimal values with grouping and scale', () => {
        expect(formatCellValue('1234.5678', 'numeric(12,4)')).toBe('1 234.5678');
    });

    it('preserves full fractional precision for float types without declared scale', () => {
        expect(formatCellValue('1.123456789', 'real')).toBe('1.123456789');
    });

    it('uses declared scale for numeric types', () => {
        expect(formatCellValue('99.99999', 'numeric(10,2)')).toBe('100.00');
    });
});
