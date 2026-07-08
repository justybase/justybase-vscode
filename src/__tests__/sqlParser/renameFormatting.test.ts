import { describe, expect, it } from '@jest/globals';

import { formatSqlRenameReplacement } from '../../sqlParser/renameFormatting';

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
});