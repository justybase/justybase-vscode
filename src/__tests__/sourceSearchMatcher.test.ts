import { searchSourceText } from '../providers/sourceSearchMatcher';

const VIEW_SOURCE = [
    'CREATE OR REPLACE VIEW ADMIN.V_SALES AS',
    'SELECT S.SALE_ID, S.AMOUNT',
    'FROM ADMIN.SALES S',
    'WHERE S.STATUS = \'OPEN\';',
].join('\n');

describe('searchSourceText', () => {
    it('finds a case-insensitive match and returns a snippet with the match position', () => {
        const result = searchSourceText(VIEW_SOURCE, 'admin.sales', { mode: 'raw' });

        expect(result.matched).toBe(true);
        expect(result.offset).toBe(VIEW_SOURCE.indexOf('ADMIN.SALES'));
        expect(result.snippet).toContain('ADMIN.SALES');
        expect(result.snippetMatchOffset).toBeGreaterThanOrEqual(0);
        expect(result.snippetMatchLength).toBe('ADMIN.SALES'.length);
    });

    it('honours case-sensitive matching', () => {
        expect(searchSourceText(VIEW_SOURCE, 'admin.sales', { mode: 'raw', caseSensitive: true }).matched).toBe(false);
        expect(searchSourceText(VIEW_SOURCE, 'ADMIN.SALES', { mode: 'raw', caseSensitive: true }).matched).toBe(true);
    });

    it('honours whole-word matching', () => {
        expect(searchSourceText(VIEW_SOURCE, 'SALE', { mode: 'raw', wholeWord: true }).matched).toBe(false);
        expect(searchSourceText(VIEW_SOURCE, 'SALES', { mode: 'raw', wholeWord: true }).matched).toBe(true);
    });

    it('supports regular expressions and reports invalid patterns', () => {
        const regex = searchSourceText(VIEW_SOURCE, 'S\\.[A-Z_]+', { mode: 'raw', regex: true });
        expect(regex.matched).toBe(true);
        expect(regex.offset).toBe(VIEW_SOURCE.indexOf('S.SALE_ID'));

        const invalid = searchSourceText(VIEW_SOURCE, '([', { mode: 'raw', regex: true });
        expect(invalid.matched).toBe(false);
        expect(invalid.invalidPattern).toBe(true);
    });

    it('ignores comments in noComments mode', () => {
        const source = 'SELECT 1 -- SECRET_TOKEN\nFROM DUAL';
        expect(searchSourceText(source, 'SECRET_TOKEN', { mode: 'raw' }).matched).toBe(true);
        expect(searchSourceText(source, 'SECRET_TOKEN', { mode: 'noComments' }).matched).toBe(false);
    });

    it('ignores string literals in noCommentsNoLiterals mode', () => {
        const source = "SELECT 'SECRET_TOKEN' AS VALUE FROM DUAL";
        expect(searchSourceText(source, 'SECRET_TOKEN', { mode: 'noComments' }).matched).toBe(true);
        expect(searchSourceText(source, 'SECRET_TOKEN', { mode: 'noCommentsNoLiterals' }).matched).toBe(false);
    });

    it('collapses whitespace in the snippet without losing the match text', () => {
        const source = 'SELECT\n\n    COLUMN_A,\n    COLUMN_B\nFROM T';
        const result = searchSourceText(source, 'COLUMN_B', { mode: 'raw', snippetLead: 10, snippetLength: 40 });

        expect(result.matched).toBe(true);
        expect(result.snippet).not.toContain('\n');
        expect(result.snippet).toContain('COLUMN_B');
        expect(result.snippet?.slice(result.snippetMatchOffset, (result.snippetMatchOffset ?? 0) + (result.snippetMatchLength ?? 0)))
            .toBe('COLUMN_B');
    });

    it('accepts a UTF-16 offset that matches the source slice', () => {
        const source = '-- äöü\nSELECT 1 AS VALUE FROM T';
        const result = searchSourceText(source, 'VALUE', { mode: 'raw' });

        expect(result.matched).toBe(true);
        expect(source.slice(result.offset, result.offset + 'VALUE'.length)).toBe('VALUE');
    });
});
