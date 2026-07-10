import {
    buildLowerLikePattern,
    combineFilterClauses,
    escapeSqlLikeLiteral,
    formatFilterNumericLiteral,
    normalizeFilterNumericInput,
    parseFilterNumericParam,
} from '../../../core/resultDataProvider/columnFilterShared';

describe('columnFilterShared', () => {
    describe('normalizeFilterNumericInput', () => {
        it('strips spaces, NBSP, thin space, and commas', () => {
            expect(normalizeFilterNumericInput('2011 02 09')).toBe('20110209');
            expect(normalizeFilterNumericInput('123\u00A0456')).toBe('123456');
            expect(normalizeFilterNumericInput('1,234.56')).toBe('1234.56');
        });
    });

    describe('escapeSqlLikeLiteral', () => {
        it('escapes LIKE metacharacters', () => {
            expect(escapeSqlLikeLiteral('100%_\\')).toBe('100\\%\\_\\\\');
        });
    });

    describe('buildLowerLikePattern', () => {
        it('builds contains and startsWith patterns', () => {
            expect(buildLowerLikePattern('contains', 'AbC')).toBe('%abc%');
            expect(buildLowerLikePattern('startsWith', 'x%')).toBe('x\\%%');
        });
    });

    describe('parseFilterNumericParam', () => {
        it('parses grouped integer input for integer-only columns', () => {
            expect(parseFilterNumericParam('123 456', { integerOnly: true })).toBe(123456);
            expect(parseFilterNumericParam('2011 02 09', { integerOnly: true })).toBe(20110209);
        });

        it('parses grouped decimal input', () => {
            expect(parseFilterNumericParam('1 234.5')).toBe(1234.5);
        });
    });

    describe('formatFilterNumericLiteral', () => {
        it('formats grouped numeric strings for SQL literals', () => {
            expect(formatFilterNumericLiteral('123 456')).toBe('123456');
            expect(formatFilterNumericLiteral('2011 02 09')).toBe('20110209');
        });

        it('returns undefined for non-numeric strings', () => {
            expect(formatFilterNumericLiteral('abc')).toBeUndefined();
        });
    });

    describe('combineFilterClauses', () => {
        it('joins multiple clauses with AND or OR', () => {
            expect(combineFilterClauses(['a = 1', 'b = 2'], 'and')).toBe('(a = 1 AND b = 2)');
            expect(combineFilterClauses(['a = 1', 'b = 2'], 'or')).toBe('(a = 1 OR b = 2)');
            expect(combineFilterClauses(['only'], undefined)).toBe('only');
        });
    });
});
