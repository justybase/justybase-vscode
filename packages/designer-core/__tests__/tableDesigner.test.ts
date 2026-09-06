import { describe, expect, it } from '@jest/globals';
import {
  buildTableDesignerCreateSql,
  getTableDesignerProfile,
  getTableDesignerUnsupportedReason,
  isTableDesignerSupported,
} from '../src';

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    databaseKind: 'sqlite',
    dbName: 'main',
    schemaName: 'main',
    tableName: 'orders',
    tableType: 'PERMANENT',
    ifNotExists: true,
    columns: [
      { name: 'id', type: 'INTEGER', length: '', notNull: true, pk: true, defaultValue: '' },
      { name: 'status', type: 'TEXT', length: '', notNull: false, pk: false, defaultValue: 'ready' },
    ],
    distributeColumns: [],
    organizeNone: false,
    organizeColumns: [],
    tableConstraints: [],
    ...overrides,
  };
}

describe('table designer boundary', () => {
  it('keeps dialect profile capabilities and generated SQL together', () => {
    expect(getTableDesignerProfile('sqlite')).toMatchObject({
      supported: true,
      supportsIfNotExists: true,
      supportsDistribution: false,
      supportsOrganize: false,
    });
    expect(buildTableDesignerCreateSql(createInput())).toBe(
      "CREATE TABLE IF NOT EXISTS main.orders (\n"
      + '    id INTEGER NOT NULL,\n'
      + "    status TEXT DEFAULT 'ready',\n"
      + '    PRIMARY KEY (id)\n'
      + ');',
    );
  });

  it('preserves the Netezza-specific distribution and organization clauses', () => {
    expect(buildTableDesignerCreateSql(createInput({
      databaseKind: 'netezza',
      dbName: 'SYSTEM',
      schemaName: 'ADMIN',
      distributeColumns: ['id'],
      organizeColumns: ['id'],
    }))).toContain('DISTRIBUTE ON ("id") ORGANIZE ON ("id");');
  });

  it('reports unsupported and runtime-blocked states without emitting SQL', () => {
    expect(isTableDesignerSupported('clickhouse')).toBe(false);
    expect(getTableDesignerUnsupportedReason('clickhouse')).toMatch(/MergeTree/u);
    expect(isTableDesignerSupported('sqlite', { readOnly: true, runtimeAvailable: true })).toBe(false);
    expect(getTableDesignerUnsupportedReason('sqlite', { readOnly: true, runtimeAvailable: true })).toMatch(/read-only/u);
    expect(() => buildTableDesignerCreateSql(createInput({ readOnly: true, runtimeAvailable: true }))).toThrow(/read-only/u);
    expect(() => buildTableDesignerCreateSql(createInput({ runtimeAvailable: false }))).toThrow(/runtime/u);
  });
});
