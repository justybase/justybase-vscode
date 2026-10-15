jest.unmock('chevrotain');
import { MetadataBridge } from '../../server/metadataBridge';
import { extractTableReferences, parseQualifiedReference } from '../../server/diagnosticsUtils';
import type { MetadataContextResponse } from '../../lsp/protocol';

describe('PostgreSQL metadata identity and search_path', () => {
  const uri = 'file:///postgresql.sql';
  it('folds unquoted identifiers and keeps quoted dots, spaces and escaped quotes', () => {
    expect(parseQualifiedReference('PUBLIC.Items', 'postgresql')).toEqual({ schema: 'public', table: 'items' });
    expect(parseQualifiedReference('"a.b"."A"" B"', 'postgresql')).toEqual({ schema: 'a.b', table: 'A" B' });
    expect(extractTableReferences('SELECT * FROM PUBLIC.Items JOIN public."Items" i ON true', 'postgresql')).toEqual([
      { schema: 'public', table: 'items' }, { schema: 'public', table: 'Items' },
    ]);
  });
  it('never warms objects mentioned only in comments, strings, bodies or function names', () => {
    const sql = "SELECT $$ FROM secret $$, E' JOIN hidden', 'FROM private' FROM generate_series(1,2) g; -- FROM nope\nSELECT * FROM żółć";
    expect(extractTableReferences(sql, 'postgresql')).toEqual([{ table: 'żółć' }]);
  });
  it('resolves the first matching schema, preserves case and invalidates on context changes', async () => {
    let context: MetadataContextResponse = { connectionName: 'pg', databaseKind: 'postgresql', effectiveDatabase: 'db',
      serverVersionNum: 160013, searchPath: ['second', 'first'] };
    const request = jest.fn(async (params: { kind: string; schema?: string; table?: string }) => {
      if (params.kind === 'context') return context;
      return { exists: params.table === 'items', table: params.table ?? '', database: 'db', schema: params.schema,
        columnsComplete: true, columns: params.table === 'items' ? [{ name: params.schema + '_id', type: 'integer' }] : [] };
    });
    const bridge = new MetadataBridge(request);
    await bridge.getContext(uri);
    expect((await bridge.getTableInfo(uri, 'db', 'items'))?.schema).toBe('second');
    await bridge.getTableInfo(uri, 'db', 'items', 'first');
    expect(bridge.findCachedTableInfo(uri, 'items', 'db')?.schema).toBe('second');
    expect((await bridge.getTableInfo(uri, 'db', 'Items', 'second'))?.exists).toBe(false);
    const epoch = bridge.getValidationMetadataEpoch(uri);
    context = { ...context, serverVersionNum: 180000, searchPath: ['first', 'second'] };
    await bridge.getContext(uri);
    expect(bridge.getValidationMetadataEpoch(uri)).toBeGreaterThan(epoch);
    expect(bridge.findCachedTableInfo(uri, 'items', 'db')?.schema).toBe('first');
    context = { ...context, searchPath: undefined };
    await bridge.getContext(uri);
    expect(bridge.findCachedTableInfo(uri, 'items', 'db')).toBeUndefined();
    await expect(bridge.getTableInfo(uri, 'db', 'items')).resolves.toBeUndefined();
    bridge.clearDocument(uri);
    await bridge.getContext(uri);
    expect(bridge.getValidationMetadataEpoch(uri)).toBe(0);
    bridge.clearAll();
  });
  it('does not skip an unresolved earlier search_path entry', async () => {
    const bridge = new MetadataBridge(async params => params.kind === 'context'
      ? { connectionName: 'pg', databaseKind: 'postgresql', searchPath: ['unknown', 'public'] }
      : params.schema === 'unknown' ? null
      : { exists: true, table: 'items', schema: 'public', columns: [{ name: 'id', type: 'int' }] });
    await bridge.getContext(uri);
    await bridge.getTableInfo(uri, 'db', 'items', 'public');
    expect(bridge.findCachedTableInfo(uri, 'items', 'db')).toBeUndefined();
  });
});
