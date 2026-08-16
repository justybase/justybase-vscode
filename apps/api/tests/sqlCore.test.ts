import { getSqlStatementAtPosition, NetezzaWebLspCore, splitSqlStatements } from '@justybase/sql-core';

describe('shared Netezza web SQL core', () => {
  it('provides parser-backed completion and diagnostics without a database connection', async () => {
    const core = new NetezzaWebLspCore({ requestMetadata: async params => params.kind === 'context' ? { databaseKind: 'netezza' } : [] });
    core.setContext('file:///query.sql', { databaseKind: 'netezza' });
    const completions = await core.completion('file:///query.sql', 1, 'SELECT COU', { line: 0, character: 10 });
    expect(completions.some(item => item.label === 'COUNT')).toBe(true);
    const diagnostics = await core.diagnostics('file:///query.sql', 1, 'SELECT (');
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it('preserves metadata caches when an unchanged context is resent', async () => {
    let tableRequests = 0;
    const core = new NetezzaWebLspCore({ requestMetadata: async params => {
      if (params.kind === 'context') return { connectionName: 'connection-1', effectiveDatabase: 'DB', effectiveSchema: 'ADMIN', databaseKind: 'netezza', netezzaSchemasEnabled: true };
      if (params.kind === 'tables') { tableRequests += 1; return [{ name: 'CUSTOMERS', database: 'DB', schema: 'ADMIN', objectType: 'table' }]; }
      return [];
    } });
    const context = { connectionName: 'connection-1', effectiveDatabase: 'DB', effectiveSchema: 'ADMIN', databaseKind: 'netezza' as const, netezzaSchemasEnabled: true };
    core.setContext('file:///cached.sql', context);
    await core.completion('file:///cached.sql', 1, 'SELECT * FROM C', { line: 0, character: 15 });
    core.setContext('file:///cached.sql', { ...context });
    await core.completion('file:///cached.sql', 2, 'SELECT * FROM CU', { line: 0, character: 16 });
    expect(tableRequests).toBe(1);
  });

  it('splits scripts with offsets without breaking strings, comments, or NZPLSQL bodies', () => {
    const sql = `-- header;\nSELECT 'value; still one literal';\nCREATE PROCEDURE P() RETURNS INT LANGUAGE NZPLSQL AS BEGIN_PROC\n  SELECT 1;\n  RETURN 1;\nEND_PROC;\nSELECT 3;`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[0].sql).toContain("'value; still one literal'");
    expect(statements[1].sql).toContain('RETURN 1;');
    expect(statements[2].sql).toBe('SELECT 3');
    expect(sql.slice(statements[1].startOffset, statements[1].endOffset).trim()).toBe(statements[1].sql);
  });

  it('resolves the statement under the cursor using parser boundaries', () => {
    const sql = 'SELECT 1; /* ; */ SELECT 2; SELECT \'3;\';';
    expect(getSqlStatementAtPosition(sql, sql.indexOf('SELECT 2'))?.sql).toBe('/* ; */ SELECT 2');
    expect(getSqlStatementAtPosition(sql, sql.indexOf('3;'))?.sql).toBe("SELECT '3;'");
  });

  it('keeps semicolons inside quoted identifiers out of statement boundaries', () => {
    const statements = splitSqlStatements('SELECT "semi;column" FROM "quoted;table"; SELECT 4;');
    expect(statements.map(statement => statement.sql)).toEqual(['SELECT "semi;column" FROM "quoted;table"', 'SELECT 4']);
  });
});
