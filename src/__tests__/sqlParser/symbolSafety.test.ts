jest.unmock('chevrotain');
import { resolveSqlRenameSymbol } from '../../sqlParser/symbols';
import { buildSqlRenameEdits } from '../../sqlParser/renameFormatting';

describe('production symbol safety', () => {
    it.each(['', '"unfinished', '"bad"quote"', 'next\nname'])('rejects malformed replacement %p', newName => {
        const sql = 'SELECT a.ID FROM T a';
        const symbol = resolveSqlRenameSymbol(sql, sql.indexOf('a.ID'))!;
        expect(buildSqlRenameEdits(sql, symbol, newName)).toBeUndefined();
    });
    it.each([
        ['SELECT a.ID FROM T a JOIN ORDERS ON ORDERS.ID = a.ID', 'a.ID', 'ORDERS'],
        ['SELECT a.ID FROM T a JOIN SALES.ORDERS ON ORDERS.ID = a.ID', 'a.ID', 'orders'],
        ['WITH A AS (SELECT 1 AS ID) SELECT * FROM A JOIN ORDERS ON ORDERS.ID = A.ID', 'A AS', 'ORDERS'],
    ])('rejects capturing the unaliased physical relation in %p', (sql, anchorText, newName) => {
        const symbol = resolveSqlRenameSymbol(sql, sql.indexOf(anchorText))!;
        expect(symbol).toBeDefined();
        expect(buildSqlRenameEdits(sql, symbol, newName)).toBeUndefined();
    });
    it('still renames to a name no visible relation exposes', () => {
        const sql = 'SELECT a.ID FROM T a JOIN ORDERS ON ORDERS.ID = a.ID';
        const symbol = resolveSqlRenameSymbol(sql, sql.indexOf('a.ID'))!;
        expect(buildSqlRenameEdits(sql, symbol, 'ACCT')).toHaveLength(3);
    });
    it('rejects a capture of another declaration', () => {
        const sql = 'SELECT a.ID FROM T a JOIN U b ON a.ID=b.ID';
        expect(buildSqlRenameEdits(sql, resolveSqlRenameSymbol(sql, 7)!, 'b')).toBeUndefined();
    });
    it.each([
        'SELECT a. FROM T a',
        'WITH q AS (SELECT * FROM T a) SELECT q.',
        'SELECT * FROM (SELECT ID FROM T) d WHERE d.',
    ])('handles incomplete SQL safely: %s', sql => {
        const offset = sql.lastIndexOf('.');
        const symbol = resolveSqlRenameSymbol(sql, offset);
        if (!symbol) return;
        const edits = buildSqlRenameEdits(sql, symbol, 'next_alias')!;
        expect(edits.length).toBeGreaterThan(0);
        expect(edits.every(edit => ['a', 'q', 'd'].includes(sql.slice(edit.startOffset, edit.endOffset)))).toBe(true);
    });
});
