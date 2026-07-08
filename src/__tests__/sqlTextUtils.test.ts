/**
 * Unit tests for sql/sqlTextUtils.ts
 */

import { stripCommentsAndLiterals, searchInCode, stripComments, searchInCodeWithMode } from '../sql/sqlTextUtils';

describe('sql/sqlTextUtils', () => {
    describe('stripCommentsAndLiterals', () => {
        describe('single-line comments', () => {
            it('should remove single-line comment at end of line', () => {
                const sql = 'SELECT * FROM table1 -- this is a comment';
                const result = stripCommentsAndLiterals(sql);
                expect(result).toContain('SELECT * FROM table1');
                expect(result).not.toContain('comment');
            });

            it('should remove single-line comment and preserve code before it', () => {
                const sql = 'SELECT id -- get id\nFROM users';
                const result = stripCommentsAndLiterals(sql);
                expect(result).toContain('SELECT id');
                expect(result).toContain('FROM users');
                expect(result).not.toContain('get id');
            });

            it('should handle multiple single-line comments', () => {
                const sql = 'SELECT * -- comment1\nFROM table -- comment2';
                const result = stripCommentsAndLiterals(sql);
                expect(result.includes('comment1')).toBe(false);
                expect(result.includes('comment2')).toBe(false);
            });
        });

        describe('multi-line comments', () => {
            it('should remove multi-line comment', () => {
                const sql = 'SELECT /* column names */ * FROM table1';
                const result = stripCommentsAndLiterals(sql);
                // Comment is removed, whitespace may vary by implementation
                expect(result).not.toContain('column names');
                expect(result).toContain('SELECT');
                expect(result).toContain('* FROM table1');
            });

            it('should remove multi-line comment spanning multiple lines', () => {
                const sql = `SELECT *
/* this is a
multi-line
comment */
FROM table1`;
                const result = stripCommentsAndLiterals(sql);
                expect(result.includes('multi-line')).toBe(false);
            });

            it('should handle nested-style text in comments', () => {
                const sql = 'SELECT /* comment with -- inside */ * FROM t';
                const result = stripCommentsAndLiterals(sql);
                expect(result.includes('--')).toBe(false);
            });
        });

        describe('string literals', () => {
            it('should remove single-quoted string literal', () => {
                const sql = "SELECT 'hello world' FROM t";
                const result = stripCommentsAndLiterals(sql);
                expect(result.includes('hello')).toBe(false);
            });

            it('should handle escaped single quotes inside string', () => {
                const sql = "SELECT 'it''s a test' FROM t";
                const result = stripCommentsAndLiterals(sql);
                expect(result.includes("it's")).toBe(false);
            });

            it('should handle multiple string literals', () => {
                const sql = "SELECT 'first', 'second' FROM t";
                const result = stripCommentsAndLiterals(sql);
                expect(result.includes('first')).toBe(false);
                expect(result.includes('second')).toBe(false);
            });
        });

        describe('combined cases', () => {
            it('should handle comments and strings together', () => {
                const sql = "SELECT 'value' -- comment\nFROM /* block */ table1";
                const result = stripCommentsAndLiterals(sql);
                expect(result.includes('value')).toBe(false);
                expect(result.includes('comment')).toBe(false);
                expect(result.includes('block')).toBe(false);
                expect(result).toContain('SELECT');
                expect(result).toContain('FROM');
                expect(result).toContain('table1');
            });

            it('should preserve SQL keywords and identifiers', () => {
                const sql = 'SELECT id, name FROM users WHERE active = 1';
                const result = stripCommentsAndLiterals(sql);
                expect(result).toBe(sql);
            });

            it('should handle empty input', () => {
                expect(stripCommentsAndLiterals('')).toBe('');
            });
        });
    });

    describe('searchInCode', () => {
        it('should find term in SQL code', () => {
            const sql = 'SELECT * FROM users WHERE id = 1';
            expect(searchInCode(sql, 'users')).toBe(true);
        });

        it('should be case-insensitive', () => {
            const sql = 'SELECT * FROM USERS';
            expect(searchInCode(sql, 'users')).toBe(true);
            expect(searchInCode(sql, 'USERS')).toBe(true);
            expect(searchInCode(sql, 'Users')).toBe(true);
        });

        it('should not find term only in comment', () => {
            const sql = 'SELECT * FROM table1 -- look for users here';
            expect(searchInCode(sql, 'users')).toBe(false);
        });

        it('should not find term only in block comment', () => {
            const sql = 'SELECT * FROM table1 /* users table */';
            expect(searchInCode(sql, 'users')).toBe(false);
        });

        it('should not find term only in string literal', () => {
            const sql = "SELECT 'users' FROM table1";
            expect(searchInCode(sql, 'users')).toBe(false);
        });

        it('should find term when it appears in code and comment', () => {
            const sql = 'SELECT * FROM users -- users table comment';
            expect(searchInCode(sql, 'users')).toBe(true);
        });

        it('should return false for empty SQL', () => {
            expect(searchInCode('', 'test')).toBe(false);
        });

        it('should return false when term not found', () => {
            const sql = 'SELECT * FROM orders';
            expect(searchInCode(sql, 'users')).toBe(false);
        });
    });
});

describe('sql/sqlTextUtils - new functions', () => {
    describe('stripComments', () => {
        it('should remove single-line comments but keep string literals', () => {
            const sql = "SELECT 'hello' FROM t -- comment";
            const result = stripComments(sql);
            expect(result).toContain("'hello'");
            expect(result).not.toContain('comment');
        });

        it('should remove multi-line comments but keep string literals', () => {
            const sql = "SELECT /* comment */ 'value' FROM t";
            const result = stripComments(sql);
            expect(result).toContain("'value'");
            expect(result).not.toContain('comment');
        });

        it('should preserve string with escaped quotes', () => {
            const sql = "SELECT 'it''s a test' FROM t";
            const result = stripComments(sql);
            expect(result).toContain("'it''s a test'");
        });
    });

    describe('searchInCodeWithMode', () => {
        const sql = "SELECT 'users' FROM orders -- users table";

        it('should find in raw mode (comments and strings included)', () => {
            expect(searchInCodeWithMode(sql, 'users', 'raw')).toBe(true);
        });

        it('should find in noComments mode when term is in string', () => {
            expect(searchInCodeWithMode(sql, 'users', 'noComments')).toBe(true);
        });

        it('should NOT find in noCommentsNoLiterals mode when term is only in string/comment', () => {
            expect(searchInCodeWithMode(sql, 'users', 'noCommentsNoLiterals')).toBe(false);
        });

        it('should find term in actual code in all modes', () => {
            expect(searchInCodeWithMode(sql, 'orders', 'raw')).toBe(true);
            expect(searchInCodeWithMode(sql, 'orders', 'noComments')).toBe(true);
            expect(searchInCodeWithMode(sql, 'orders', 'noCommentsNoLiterals')).toBe(true);
        });

        it('should find term only in comment in raw mode', () => {
            const sqlWithComment = "SELECT * FROM t -- secret_table";
            expect(searchInCodeWithMode(sqlWithComment, 'secret_table', 'raw')).toBe(true);
            expect(searchInCodeWithMode(sqlWithComment, 'secret_table', 'noComments')).toBe(false);
            expect(searchInCodeWithMode(sqlWithComment, 'secret_table', 'noCommentsNoLiterals')).toBe(false);
        });
    });
});
