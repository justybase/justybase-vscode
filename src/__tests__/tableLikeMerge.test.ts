import { describe, expect, it } from '@jest/globals';
import { mergeAndSetTables } from '../metadata/cache/tableLikeMerge';
import type { TableMetadata } from '../metadata/types';

function table(name: string, objType: string, schema = 'S1'): TableMetadata {
  return {
    OBJNAME: name,
    label: name,
    SCHEMA: schema,
    objType,
    kind: objType === 'VIEW' ? 18 : 6,
    OBJID: name.length,
  };
}

describe('mergeAndSetTables', () => {
  it('refresh VIEW does not remove TABLE in the same schema key', () => {
    const store = new Map<string, TableMetadata[]>();
    const cache = {
      getTables: (_conn: string, key: string) => store.get(key),
      setTables: (
        _conn: string,
        key: string,
        data: TableMetadata[],
        _idMap: Map<string, number>,
      ) => {
        store.set(key, data);
      },
    };

    store.set('DB1.S1', [table('T1', 'TABLE'), table('V0', 'VIEW')]);

    mergeAndSetTables(
      cache,
      'conn',
      'DB1.S1',
      [table('V1', 'VIEW'), table('V2', 'VIEW')],
      'VIEW',
      () => new Map(),
    );

    const result = store.get('DB1.S1') ?? [];
    expect(result.map((item) => `${item.objType}:${item.OBJNAME}`).sort()).toEqual([
      'TABLE:T1',
      'VIEW:V1',
      'VIEW:V2',
    ]);
  });

  it('prefetch-style full replace is not handled here — caller uses setTables directly', () => {
    const store = new Map<string, TableMetadata[]>();
    const cache = {
      getTables: (_conn: string, key: string) => store.get(key),
      setTables: (
        _conn: string,
        key: string,
        data: TableMetadata[],
        _idMap: Map<string, number>,
      ) => {
        store.set(key, [...data]);
      },
    };

    store.set('DB1.S1', [table('T1', 'TABLE'), table('V1', 'VIEW')]);

    cache.setTables('conn', 'DB1.S1', [table('T2', 'TABLE')], new Map());

    const result = store.get('DB1.S1') ?? [];
    expect(result).toHaveLength(1);
    expect(result[0].OBJNAME).toBe('T2');
  });

  it('DB.. merge falls back to getTablesAllSchemas when aggregate key is missing', () => {
    const perSchema = new Map<string, TableMetadata[]>([
      ['DB1.S1', [table('T1', 'TABLE', 'S1')]],
      ['DB1.S2', [table('T2', 'TABLE', 'S2')]],
    ]);
    let writtenKey = '';
    let written: TableMetadata[] = [];
    const cache = {
      getTables: (_conn: string, key: string) => perSchema.get(key),
      getTablesAllSchemas: () => [
        table('T1', 'TABLE', 'S1'),
        table('T2', 'TABLE', 'S2'),
      ],
      setTables: (
        _conn: string,
        key: string,
        data: TableMetadata[],
        _idMap: Map<string, number>,
      ) => {
        writtenKey = key;
        written = data;
      },
    };

    mergeAndSetTables(
      cache,
      'conn',
      'DB1..',
      [table('V1', 'VIEW', 'S1')],
      'VIEW',
      () => new Map(),
    );

    expect(writtenKey).toBe('DB1..');
    expect(written.map((item) => `${item.objType}:${item.OBJNAME}`).sort()).toEqual([
      'TABLE:T1',
      'TABLE:T2',
      'VIEW:V1',
    ]);
  });
});
