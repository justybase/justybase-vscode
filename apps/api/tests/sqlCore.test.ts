import { NetezzaWebLspCore } from '@justybase/sql-core';

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
});
