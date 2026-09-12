import { SQL_SHORTCUTS, sqlShortcutEdit } from '../src';

describe('shared SQL shortcuts', () => {
  it('keeps the VS Code shortcut map and expands SX at a boundary', () => {
    expect(SQL_SHORTCUTS.get('SX')).toBe('SELECT');
    expect(sqlShortcutEdit('SX ', 2)).toEqual({
      startColumn: 1,
      endColumn: 4,
      text: 'SELECT ',
      triggerSuggest: true,
    });
    expect(sqlShortcutEdit('FROM SX ', 7)).toEqual({
      startColumn: 6,
      endColumn: 9,
      text: 'SELECT ',
      triggerSuggest: true,
    });
  });

  it('supports all compact clause shortcuts without rewriting identifiers', () => {
    for (const [trigger, replacement] of SQL_SHORTCUTS) {
      expect(sqlShortcutEdit(`${trigger} `, trigger.length)).toEqual(expect.objectContaining({
        text: `${replacement} `,
      }));
    }
    expect(sqlShortcutEdit('SXDIM ', 5)).toBeUndefined();
    expect(sqlShortcutEdit('orders_sx ', 9)).toBeUndefined();
  });

  it('creates the LIKE wildcard and places the cursor between percent signs', () => {
    expect(sqlShortcutEdit('WHERE name LIKE ', 15)).toEqual({
      startColumn: 12,
      endColumn: 17,
      text: "LIKE '%%'",
      cursorColumn: 19,
      triggerSuggest: false,
    });
    expect(sqlShortcutEdit('dislike ', 8)).toBeUndefined();
  });
});
