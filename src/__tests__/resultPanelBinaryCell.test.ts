import { describe, expect, it, jest } from '@jest/globals';

jest.mock('../../media/resultPanel/state.js', () => ({
    getResultFormattingPayload: jest.fn(() => ({})),
    getResultFormattingState: jest.fn(() => ({})),
}));

describe('media formatCellValue binary placeholder', () => {
    it('renders a size placeholder for BLOB cells instead of raw base64', () => {
        const { formatCellValue } = require('../../media/resultPanel/utils.js');
        expect(formatCellValue('AQIDBAUG', 'BLOB', undefined)).toBe('[BLOB · 6 B]');
    });

    it('renders an OLE Object placeholder', () => {
        const { formatCellValue } = require('../../media/resultPanel/utils.js');
        expect(formatCellValue('AQIDBAUG', 'OLE', undefined)).toBe('[OLE Object · 6 B]');
    });

    it('displays a numeric scalar when its column was incorrectly reported as BLOB', () => {
        const { formatCellValue, shouldRightAlignCell } = require('../../media/resultPanel/utils.js');
        expect(formatCellValue(1234, 'BLOB', undefined)).toBe('1 234');
        expect(shouldRightAlignCell('BLOB', { value: 1234 })).toBe(true);
    });

    it('returns null for null binary cells', () => {
        const { formatCellValue } = require('../../media/resultPanel/utils.js');
        expect(formatCellValue(null, 'BLOB', undefined)).toBeNull();
    });

    it('keeps text cells unchanged', () => {
        const { formatCellValue } = require('../../media/resultPanel/utils.js');
        expect(formatCellValue('AQIDBAUG', 'VARCHAR', undefined)).toBe('AQIDBAUG');
    });

    it('keeps numeric formatting intact', () => {
        const { formatCellValue } = require('../../media/resultPanel/utils.js');
        expect(formatCellValue(1234.5, 'numeric', 1)).toBe('1 234.5');
    });
});
