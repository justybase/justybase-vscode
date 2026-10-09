jest.unmock("chevrotain");
import { describe, expect, it } from '@jest/globals';

import { buildSqlColumnRenameEdits, formatSqlRenameReplacement } from '../../sqlParser/renameFormatting';

describe('sqlParser/renameFormatting', () => {
    it('keeps plain identifiers unquoted', () => {
        expect(formatSqlRenameReplacement('ALIAS1', 'NEXT_ALIAS')).toBe('NEXT_ALIAS');
    });

    it('preserves quoted identifiers and escapes embedded quotes', () => {
        expect(formatSqlRenameReplacement('"Sales Alias"', 'Quarter "A"')).toBe('"Quarter ""A"""');
    });

    it('accepts a quoted new name and normalizes it once', () => {
        expect(formatSqlRenameReplacement('"Sales Alias"', '"Quarter Alias"')).toBe('"Quarter Alias"');
    });

    it('quotes reserved words the lexer only knows as part of combined keywords', () => {
        expect(formatSqlRenameReplacement('CID', 'ORDER')).toBe('"ORDER"');
        expect(formatSqlRenameReplacement('CID', 'group')).toBe('"group"');
        expect(formatSqlRenameReplacement('CID', 'PARTITION')).toBe('"PARTITION"');
        expect(formatSqlRenameReplacement('CID', 'ORDERS')).toBe('ORDERS');
    });

    it('renames a local column with the shared name policy and rejects malformed names', () => {
        const sql = 'WITH X AS (SELECT 1 AS CID) SELECT X.CID FROM X';
        const cursor = sql.lastIndexOf('CID');
        expect(buildSqlColumnRenameEdits(sql, cursor, 'Customer Key')?.map(edit => edit.newText))
            .toEqual(['"Customer Key"', '"Customer Key"']);
        expect(buildSqlColumnRenameEdits(sql, cursor, '"unterminated')).toBeUndefined();
        expect(buildSqlColumnRenameEdits(sql, cursor, '   ')).toBeUndefined();
    });
});
