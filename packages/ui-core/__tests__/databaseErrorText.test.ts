import {
  buildSqlErrorLineExcerpt,
  formatDatabaseErrorForPrompt,
} from '../src';

describe('PostgreSQL error text helpers', () => {
  it('builds a one-based LINE excerpt around the reported position', () => {
    const sql = 'SELECT *\nFROM items\nWHERE idd = 1';
    const excerpt = buildSqlErrorLineExcerpt(sql, 27);
    expect(excerpt).toEqual({ line: 3, text: 'WHERE idd = 1', caret: 6 });
  });

  it('keeps the caret at the end of the line for an end-of-line position', () => {
    const sql = 'SELECT 1\nFROM items';
    expect(buildSqlErrorLineExcerpt(sql, 9)).toEqual({ line: 1, text: 'SELECT 1', caret: 8 });
  });

  it('returns undefined for a missing or nonsensical position', () => {
    expect(buildSqlErrorLineExcerpt('SELECT 1', 0)).toBeUndefined();
    expect(buildSqlErrorLineExcerpt('SELECT 1', Number.NaN)).toBeUndefined();
  });

  it('bounds a long line around the caret', () => {
    const sql = `SELECT ${'x'.repeat(400)} FROM items`;
    const excerpt = buildSqlErrorLineExcerpt(sql, 200);
    expect(excerpt?.text.length).toBeLessThanOrEqual(162);
    expect(excerpt?.text.startsWith('…')).toBe(true);
    expect(excerpt?.text.endsWith('…')).toBe(true);
  });

  it('appends every backend diagnostic to the assistant prompt', () => {
    const prompt = formatDatabaseErrorForPrompt('column "idd" does not exist', {
      code: '42703',
      severity: 'ERROR',
      position: 27,
      detail: 'The column is missing.',
      hint: 'Check the column name.',
      context: 'PL/pgSQL function f() line 4 at RETURN',
      diagnostics: { constraint: 'items_pkey', table: 'items', custom: 'value' },
    });
    expect(prompt).toContain('column "idd" does not exist');
    expect(prompt).toContain('SQLSTATE: 42703');
    expect(prompt).toContain('POSITION: 27');
    expect(prompt).toContain('DETAIL: The column is missing.');
    expect(prompt).toContain('HINT: Check the column name.');
    expect(prompt).toContain('CONTEXT: PL/pgSQL function f() line 4 at RETURN');
    expect(prompt).toContain('Constraint: items_pkey');
    expect(prompt).toContain('Table: items');
    expect(prompt).toContain('custom: value');
  });

  it('returns the plain message when no diagnostics are available', () => {
    expect(formatDatabaseErrorForPrompt('boom')).toBe('boom');
    expect(formatDatabaseErrorForPrompt('boom', {})).toBe('boom');
    expect(formatDatabaseErrorForPrompt(undefined)).toBe('Query execution failed.');
    expect(formatDatabaseErrorForPrompt('   ')).toBe('Query execution failed.');
  });
});
