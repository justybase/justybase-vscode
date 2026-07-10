import { findTrailingLimitClause, removeTrailingLimitClause, replaceTrailingLimitValue } from '../results/refreshSqlLimit';

describe('refreshSqlLimit', () => {
    it('finds a trailing LIMIT integer with optional semicolon', () => {
        expect(findTrailingLimitClause('WITH c AS (SELECT 1) SELECT * FROM c LIMIT 25;')?.value).toBe('25');
    });

    it('replaces only the trailing LIMIT value', () => {
        expect(replaceTrailingLimitValue('SELECT * FROM T LIMIT 25;', '100')).toBe('SELECT * FROM T LIMIT 100;');
    });

    it('ignores non-trailing LIMIT values', () => {
        const sql = 'SELECT * FROM (SELECT * FROM T LIMIT 5) X';
        expect(findTrailingLimitClause(sql)).toBeUndefined();
        expect(replaceTrailingLimitValue(sql, '100')).toBe(sql);
    });

    it('removes only the trailing LIMIT clause for aggregate refresh SQL', () => {
        expect(removeTrailingLimitClause('WITH c AS (SELECT 1) SELECT * FROM c LIMIT 25;'))
            .toBe('WITH c AS (SELECT 1) SELECT * FROM c;');
    });

    it('keeps SQL without a trailing LIMIT unchanged', () => {
        const sql = 'SELECT * FROM (SELECT * FROM T LIMIT 5) X';
        expect(removeTrailingLimitClause(sql)).toBe(sql);
    });

    it('finds trailing LIMIT with inline block comment between keyword and value', () => {
        const result = findTrailingLimitClause('SELECT * FROM t LIMIT /* my comment */ 100');
        expect(result?.value).toBe('100');
        expect(result?.keywordStart).toBe(16);
    });

    it('replaces trailing LIMIT value with inline comment', () => {
        expect(replaceTrailingLimitValue('SELECT * FROM t LIMIT /* x */ 50;', '200'))
            .toBe('SELECT * FROM t LIMIT /* x */ 200;');
    });

    it('removes trailing LIMIT clause with inline comment', () => {
        expect(removeTrailingLimitClause('SELECT * FROM t LIMIT /* x */ 50;'))
            .toBe('SELECT * FROM t;');
    });

    it('finds trailing LIMIT with comment but no whitespace before comment', () => {
        const result = findTrailingLimitClause('SELECT * FROM t LIMIT/* inline */100');
        expect(result?.value).toBe('100');
        expect(result?.keywordStart).toBe(16);
    });

    it('returns keywordStart in TrailingLimitClause', () => {
        const result = findTrailingLimitClause('SELECT * FROM t LIMIT 25');
        expect(result?.keywordStart).toBe(16);
    });
});
