import { describe, expect, it } from '@jest/globals';
import { isBinarySqlColumnType } from '../results/sqlColumnTypeUtils';
import { formatResultValueForDisplay } from '../results/resultValueFormatter';

function makeColumn(type: string): { type: string } {
    return { type };
}

describe('isBinarySqlColumnType', () => {
    it('recognizes binary column types across dialects', () => {
        for (const type of ['BLOB', 'VARBINARY', 'LONGVARBINARY', 'BINARY', 'OLE', 'IMAGE', 'BYTEA', 'RAW']) {
            expect(isBinarySqlColumnType(type)).toBe(true);
        }
        expect(isBinarySqlColumnType('VARCHAR(50)')).toBe(false);
        expect(isBinarySqlColumnType('INTEGER')).toBe(false);
        expect(isBinarySqlColumnType('OLE Object')).toBe(true);
    });
});

describe('formatResultValueForDisplay binary placeholder', () => {
    it('renders a size placeholder instead of raw base64 for BLOB columns', () => {
        // 6 bytes -> base64 'AQIDBAUG' -> 8 chars
        const value = 'AQIDBAUG';
        const formatted = formatResultValueForDisplay(value, makeColumn('BLOB') as never);
        expect(formatted).toBe('[BLOB · 6 B]');
    });

    it('renders an OLE placeholder with size', () => {
        const value = 'AQIDBAUG';
        const formatted = formatResultValueForDisplay(value, makeColumn('OLE') as never);
        expect(formatted).toBe('[OLE Object · 6 B]');
    });

    it('returns empty string for null binary values', () => {
        expect(formatResultValueForDisplay(null, makeColumn('BLOB') as never)).toBe('');
        expect(formatResultValueForDisplay(undefined, makeColumn('BLOB') as never)).toBe('');
    });

    it('does not affect text columns', () => {
        expect(formatResultValueForDisplay('AQIDBAUG', makeColumn('VARCHAR') as never)).toBe('AQIDBAUG');
    });
});
