import { describe, expect, it, jest } from '@jest/globals';
import {
  buildSchemaCacheKey,
  getColumnsForTableObject,
  getTablesForScope,
  hasTreeReadyColumnCache,
  normalizeColumnCacheEntry,
  refreshTableLikeTypeForSchema,
} from '../metadata/cache/schemaTreeDataSource';
import { MetadataCache } from '../metadata/cache/MetadataCache';
import type { TableMetadata } from '../metadata/types';
import * as vscode from 'vscode';

jest.mock('vscode');

describe('schemaTreeDataSource', () => {
  it('buildSchemaCacheKey uses DB.. for missing schema', () => {
    expect(buildSchemaCacheKey('db1')).toBe('DB1..');
    expect(buildSchemaCacheKey('db1', 'admin')).toBe('DB1.ADMIN');
  });

  it('getTablesForScope falls back to all-schemas aggregate', () => {
    const cache = {
      getTables: jest.fn((_conn: string, key: string) =>
        key.endsWith('..') ? undefined : [{ OBJNAME: 'T1' }],
      ),
      getTablesAllSchemas: jest.fn(() => [{ OBJNAME: 'T2' }]),
    } as {
      getTables: (connectionName: string, key: string) => unknown;
      getTablesAllSchemas: (connectionName: string, dbName: string) => unknown;
    };

    const scoped = getTablesForScope(
      cache as never,
      'conn',
      'DB1',
      'ADMIN',
    );
    expect(scoped).toEqual([{ OBJNAME: 'T1' }]);

    const allSchemas = getTablesForScope(cache as never, 'conn', 'DB1');
    expect(cache.getTablesAllSchemas).toHaveBeenCalledWith('conn', 'DB1');
    expect(allSchemas).toEqual([{ OBJNAME: 'T2' }]);
  });

  it('getTablesForScope aggregates per-schema cache when DB.. entry is empty', () => {
    const cache = {
      getTables: jest.fn((_conn: string, key: string) =>
        key.endsWith('..') ? [] : undefined,
      ),
      getTablesAllSchemas: jest.fn(() => [{ OBJNAME: 'T1', SCHEMA: 'ADMIN' }]),
    } as {
      getTables: (connectionName: string, key: string) => unknown;
      getTablesAllSchemas: (connectionName: string, dbName: string) => unknown;
    };

    expect(getTablesForScope(cache as never, 'conn', 'db1')).toEqual([
      { OBJNAME: 'T1', SCHEMA: 'ADMIN' },
    ]);
    expect(cache.getTablesAllSchemas).toHaveBeenCalledWith('conn', 'db1');
  });

  it('reads lowercase DB.. scope after prefetch stored per-schema uppercase keys', () => {
    const cache = new MetadataCache(
      { globalStorageUri: vscode.Uri.file('/tmp/schema-tree-ds-test') } as vscode.ExtensionContext,
    );
    cache.setTables(
      'conn',
      'MYDB.ADMIN',
      [{ OBJNAME: 'DIMACCOUNT', label: 'DIMACCOUNT', objType: 'TABLE', kind: 6 }],
      new Map([['MYDB.ADMIN.DIMACCOUNT', 1]]),
    );

    expect(getTablesForScope(cache, 'conn', 'mydb')).toEqual([
      expect.objectContaining({ OBJNAME: 'DIMACCOUNT' }),
    ]);
    expect(getTablesForScope(cache, 'conn', 'mydb', 'admin')).toEqual([
      expect.objectContaining({ OBJNAME: 'DIMACCOUNT' }),
    ]);
  });

  it('hasTreeReadyColumnCache accepts columns when isPk is set', () => {
    expect(
      hasTreeReadyColumnCache([
        {
          ATTNAME: 'ID',
          FORMAT_TYPE: 'INTEGER',
          isPk: false,
          isFk: false,
          isDistributionKey: false,
        },
      ]),
    ).toBe(true);
    expect(
      hasTreeReadyColumnCache([
        { ATTNAME: 'ID', FORMAT_TYPE: 'INTEGER' },
      ]),
    ).toBe(false);
  });

  it('normalizeColumnCacheEntry defaults missing PK flags', () => {
    expect(
      normalizeColumnCacheEntry({
        ATTNAME: 'ID',
        FORMAT_TYPE: 'INTEGER',
        label: 'ID',
        kind: 5,
        detail: 'INTEGER',
        documentation: '',
        isPk: true,
        isFk: undefined as unknown as boolean,
        isDistributionKey: undefined,
      }),
    ).toEqual(
      expect.objectContaining({
        isPk: true,
        isFk: false,
        isDistributionKey: false,
      }),
    );
  });

  it('isLargeTableCatalog returns true when table count exceeds threshold', () => {
    const cache = new MetadataCache(
      { globalStorageUri: vscode.Uri.file('/tmp/schema-tree-large-db') } as vscode.ExtensionContext,
    );
    const tables = Array.from({ length: 501 }, (_, index) => ({
      OBJNAME: `T${index}`,
      label: `T${index}`,
      objType: 'TABLE',
      kind: 6,
    }));
    cache.setTables('conn', 'BIGDB.ADMIN', tables, new Map());

    expect(cache.isLargeTableCatalog('conn', 'BIGDB')).toBe(true);
    expect(cache.isLargeTableCatalog('conn', 'SMALLDB')).toBe(false);
  });

  it('areViewsCatalogLoadedForDatabase requires every per-schema layer to be marked', () => {
    const cache = new MetadataCache(
      { globalStorageUri: vscode.Uri.file('/tmp/schema-tree-views-test') } as vscode.ExtensionContext,
    );
    const table: TableMetadata = {
      OBJNAME: 'DIMACCOUNT',
      label: 'DIMACCOUNT',
      objType: 'TABLE',
      kind: vscode.CompletionItemKind.Class,
    };
    cache.setTables(
      'conn',
      'JUST_DATA_3.ADMIN',
      [table],
      new Map([['JUST_DATA_3.ADMIN.DIMACCOUNT', 1]]),
    );
    cache.setTables(
      'conn',
      'JUST_DATA_3.PUBLIC',
      [table],
      new Map([['JUST_DATA_3.PUBLIC.DIMACCOUNT', 2]]),
    );

    expect(cache.areViewsCatalogLoadedForDatabase('conn', 'JUST_DATA_3')).toBe(
      false,
    );

    cache.markViewsCatalogLoaded('conn', 'JUST_DATA_3.ADMIN');
    expect(cache.areViewsCatalogLoadedForDatabase('conn', 'JUST_DATA_3')).toBe(
      false,
    );

    cache.markViewsCatalogLoaded('conn', 'JUST_DATA_3.PUBLIC');
    expect(cache.areViewsCatalogLoadedForDatabase('conn', 'JUST_DATA_3')).toBe(
      true,
    );
  });

  it('refreshTableLikeTypeForSchema delegates to merge path', () => {
    const written: TableMetadata[] = [];
    const cache = {
      getTables: () => [{ OBJNAME: 'T1', objType: 'TABLE' } as TableMetadata],
      setTables: (
        _c: string,
        _k: string,
        data: TableMetadata[],
        _id: Map<string, number>,
      ) => {
        written.push(...data);
      },
    };

    refreshTableLikeTypeForSchema(
      cache as never,
      'conn',
      'DB1',
      'ADMIN',
      'VIEW',
      [{ OBJNAME: 'V1', objType: 'VIEW' } as TableMetadata],
      () => new Map(),
    );

    expect(written.some((item) => item.OBJNAME === 'T1')).toBe(true);
    expect(written.some((item) => item.OBJNAME === 'V1')).toBe(true);
  });

  it('getColumnsForTableObject loads then reads column cache', async () => {
    const ensureColumnsLoadedForTableKey = jest.fn(async () => undefined);
    const getColumns = jest.fn(() => [{ ATTNAME: 'C1', label: 'C1' }]);
    const cache = {
      ensureColumnsLoadedForTableKey,
      getColumns,
    };

    const columns = await getColumnsForTableObject(
      cache as never,
      'conn',
      'DB1',
      'ADMIN',
      'T1',
    );

    expect(ensureColumnsLoadedForTableKey).toHaveBeenCalledTimes(1);
    expect(columns).toHaveLength(1);
  });
});
