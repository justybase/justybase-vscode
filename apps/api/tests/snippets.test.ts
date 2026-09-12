import { loadNetezzaSnippets, loadSqlSnippets } from '../src/snippets';

describe('dialect SQL snippets', () => {
  it('keeps the complete Netezza macro/snippet catalog', () => {
    const snippets = loadNetezzaSnippets();
    expect(snippets.some(snippet => snippet.prefix.includes('nzmacrolet'))).toBe(true);
    expect(snippets.some(snippet => snippet.prefix.includes('nzmacrodeclare'))).toBe(true);
  });

  it.each([
    ['postgresql', 'pgselect'],
    ['db2', 'db2-dgtt'],
    ['clickhouse', 'clickhouse-table'],
    ['oracle', 'oraplsql'],
    ['mssql', 'mssql-top'],
  ] as const)('loads %s-specific snippets alongside portable templates', (databaseKind, prefix) => {
    const snippets = loadSqlSnippets(databaseKind);
    expect(snippets.some(snippet => snippet.prefix.includes(prefix))).toBe(true);
    expect(snippets.some(snippet => snippet.prefix.includes('sqlselect'))).toBe(true);
  });

  it('uses a safe portable fallback for dialects without a file catalog', () => {
    const snippets = loadSqlSnippets('access');
    expect(snippets.some(snippet => snippet.prefix.includes('sqltable'))).toBe(true);
    expect(snippets.some(snippet => snippet.prefix.includes('nzmacrolet'))).toBe(false);
  });
});
