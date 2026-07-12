// Unit tests for extractKeyNetezzaErrorInfo in grid/alternateViews.ts
// Validated against 26 real Netezza error messages collected from live DB (192.168.0.144:5480/JUST_DATA).
//
// Pattern follows resultPanelUtils.test.ts — require() inside it() blocks.

import { describe, expect, it, beforeEach } from '@jest/globals';

// Helper to strip leading whitespace from multi-line template literals for cleaner test data.
function stripMargin(s: TemplateStringsArray, ...values: unknown[]): string {
    // Build string from the template literal segments (NOT String.raw, so escape sequences
    // like \t become real tab characters, matching actual error messages from the driver).
    let result = '';
    for (let i = 0; i < s.length; i++) {
        result += s[i];
        if (i < values.length) {
            result += String(values[i]);
        }
    }
    return result.replace(/^[ \t]+/gm, '').trim();
}

describe('extractKeyNetezzaErrorInfo', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    describe('Pattern A — syntax errors with SQL in quotes and error ^ marker (11 cases)', () => {
        it('double comma (,,)', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = stripMargin`
                Error: Netezza Error: ERROR:  'SELECT 1,,2 AS COL1 FROM JUST_DATA..DIMACCOUNT'
                error             ^ found "," (at char 10) expecting an identifier found a keyword
            `;
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'found "," (at char 10) expecting an identifier found a keyword'
            );
        });

        it('missing closing parenthesis', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = stripMargin`
                Error: Netezza Error: ERROR:  'SELECT * FROM JUST_DATA..DIMACCOUNT WHERE (ACCOUNTKEY > 0'
                error                                                            ^ found "" (at char 57) expecting ','
            `;
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'found "" (at char 57) expecting \',\''
            );
        });

        it('extra closing parenthesis', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = stripMargin`
                Error: Netezza Error: ERROR:  'SELECT * FROM JUST_DATA..DIMACCOUNT WHERE (ACCOUNTKEY > 0))'
                error                                                              ^ found ")" (at char 59) expecting a keyword
            `;
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'found ")" (at char 59) expecting a keyword'
            );
        });

        it('bad keyword — SELECTX', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = stripMargin`
                Error: Netezza Error: ERROR:  'SELECTX * FROM JUST_DATA..DIMACCOUNT'
                error    ^ found "SELECTX" (at char 1) expecting a keyword
            `;
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'found "SELECTX" (at char 1) expecting a keyword'
            );
        });

        it('bad keyword — WHEREx', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = stripMargin`
                Error: Netezza Error: ERROR:  'SELECT * FROM JUST_DATA..DIMACCOUNT WHEREX ACCOUNTKEY > 0'
                error                                               ^ found "ACCOUNTKEY" (at char 44) expecting a keyword
            `;
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'found "ACCOUNTKEY" (at char 44) expecting a keyword'
            );
        });

        it('bad keyword — FROMM', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = stripMargin`
                Error: Netezza Error: ERROR:  'SELECT * FROMM JUST_DATA..DIMACCOUNT'
                error             ^ found "FROMM" (at char 10) expecting a keyword
            `;
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'found "FROMM" (at char 10) expecting a keyword'
            );
        });

        it('IN without parentheses', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = stripMargin`
                Error: Netezza Error: ERROR:  'SELECT * FROM JUST_DATA..DIMACCOUNT WHERE ACCOUNTKEY IN 1,2,3'
                error                                                            ^ found "1" (at char 57) expecting '('
            `;
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'found "1" (at char 57) expecting \'(\''
            );
        });

        it('bad CTE — "==" instead of "AS"', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = stripMargin`
                Error: Netezza Error: ERROR:  'WITH CTE1 == (SELECT 1 AS COL1) SELECT * FROM CTE1'
                error              ^ found "==" (at char 11) expecting AS
            `;
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'found "==" (at char 11) expecting AS'
            );
        });

        it('FROM without table', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = stripMargin`
                Error: Netezza Error: ERROR:  'SELECT 1 FROM'
                error                ^ found "" (at char 13) expecting an identifier found a keyword
            `;
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'found "" (at char 13) expecting an identifier found a keyword'
            );
        });

        it('reserved word as alias (TABLE)', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = stripMargin`
                Error: Netezza Error: ERROR:  'SELECT ACCOUNTKEY AS TABLE FROM JUST_DATA..DIMACCOUNT'
                error                         ^ found "TABLE" (at char 22) expecting an identifier found a keyword
            `;
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'found "TABLE" (at char 22) expecting an identifier found a keyword'
            );
        });

        it('SELECT as operand after >', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = stripMargin`
                Error: Netezza Error: ERROR:  'SELECT * FROM JUST_DATA..DIMACCOUNT WHERE ACCOUNTKEY > SELECT MAX(ACCOUNTKEY) FROM JUST_DATA..DIMACCOUNT'
                error                                                           ^ found "SELECT" (at char 56) expecting ALL or ANY or SOME
            `;
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'found "SELECT" (at char 56) expecting ALL or ANY or SOME'
            );
        });
    });

    describe('Pattern B — runtime/parse errors without SQL quotes (13 cases)', () => {
        it('non-aggregate in GROUP BY', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = 'Error: Netezza Error: ERROR:  Attribute DIMACCOUNT.ACCOUNTCODEALTERNATEKEY must be GROUPed or used in an aggregate function';
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'Attribute DIMACCOUNT.ACCOUNTCODEALTERNATEKEY must be GROUPed or used in an aggregate function'
            );
        });

        it('unclosed string literal', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = 'Error: Netezza Error: ERROR:  Unterminated quoted string';
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'Unterminated quoted string'
            );
        });

        it('wrong table name — relation does not exist', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = 'Error: Netezza Error: ERROR:  relation does not exist JUST_DATA.ADMIN.NO_SUCH_TABLE';
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'relation does not exist JUST_DATA.ADMIN.NO_SUCH_TABLE'
            );
        });

        it('wrong column name', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = "Error: Netezza Error: ERROR:  Attribute 'NONEXISTENT_COLUMN' not found";
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                "Attribute 'NONEXISTENT_COLUMN' not found"
            );
        });

        it('wrong schema', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = "Error: Netezza Error: ERROR:  Schema 'WRONG_SCHEMA' does not exist";
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                "Schema 'WRONG_SCHEMA' does not exist"
            );
        });

        it('division by zero', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = 'Error: Netezza Error: ERROR:  Divide by 0';
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'Divide by 0'
            );
        });

        it('invalid function name — multi-line hint', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            // Use explicit \n\t escapes (not stripMargin) to preserve the real tab characters.
            const input = 'Error: Netezza Error: ERROR:  Function \'NONEXISTENT_FUNC(INT4)\' does not exist\n\tUnable to identify a function that satisfies the given argument types\n\tYou may need to add explicit typecasts';
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'Function \'NONEXISTENT_FUNC(INT4)\' does not exist\n\tUnable to identify a function that satisfies the given argument types\n\tYou may need to add explicit typecasts'
            );
        });

        it('ORDER BY position out of range', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = 'Error: Netezza Error: ERROR:  ORDER BY position 999 is not in target list';
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'ORDER BY position 999 is not in target list'
            );
        });

        it('LIMIT must not be negative', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = 'Error: Netezza Error: ERROR:  LIMIT must not be negative';
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'LIMIT must not be negative'
            );
        });

        it('wrong database via double-dot', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = "Error: Netezza Error: ERROR:  ResolveCatalog: error retrieving database 'BADDB'";
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                "ResolveCatalog: error retrieving database 'BADDB'"
            );
        });

        it('aggregate in WHERE clause', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = 'Error: Netezza Error: ERROR:  Aggregates not allowed in WHERE clause';
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'Aggregates not allowed in WHERE clause'
            );
        });

        it('non-aggregate column without GROUP BY', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = 'Error: Netezza Error: ERROR:  Attribute DIMACCOUNT.ACCOUNTKEY must be GROUPed or used in an aggregate function';
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'Attribute DIMACCOUNT.ACCOUNTKEY must be GROUPed or used in an aggregate function'
            );
        });

        it('COUNT with too many arguments', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = "Error: Netezza Error: ERROR:  Function 'COUNT', number of parameters greater than the maximum (1)";
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                "Function 'COUNT', number of parameters greater than the maximum (1)"
            );
        });
    });

    describe('Edge cases — raw driver format, unknown format, empty, null', () => {
        it('raw driver format (no "Error:" prefix)', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = 'Netezza Error: ERROR:  relation does not exist JUST_DATA.ADMIN.NO_SUCH_TABLE';
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'relation does not exist JUST_DATA.ADMIN.NO_SUCH_TABLE'
            );
        });

        it('unknown error format — returns as-is', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = 'Some completely different error format from another database';
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'Some completely different error format from another database'
            );
        });

        it('empty string — returns empty', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            expect(extractKeyNetezzaErrorInfo('')).toBe('');
        });

        it('non-Netezza error with "ERROR:" prefix but no quotes', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = 'Error: Netezza Error: ERROR:  Some generic error message';
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'Some generic error message'
            );
        });

        it('query with single quotes in data (not SQL wrapper)', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = "Error: Netezza Error: ERROR:  Attribute 'COLUMN_WITH_QUOTES' not found in table";
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                "Attribute 'COLUMN_WITH_QUOTES' not found in table"
            );
        });

        it('syntax error with only "Error:" prefix (no Netezza Error prefix)', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = stripMargin`
                Error: ERROR:  'SELECT 1 FROM'
                error                ^ found "" (at char 13) expecting an identifier found a keyword
            `;
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'found "" (at char 13) expecting an identifier found a keyword'
            );
        });

        it('empty message with unknown prefix', () => {
            const { extractKeyNetezzaErrorInfo } = require('../../media/resultPanel/grid/alternateViews.js');
            const input = 'UnknownError: something went wrong';
            expect(extractKeyNetezzaErrorInfo(input)).toBe(
                'UnknownError: something went wrong'
            );
        });
    });
});
