import { describe, expect, it } from '@jest/globals';
import {
  buildReconstructedTableDdl,
  buildReconstructedViewDdl,
} from '../src';

describe('shared reconstructed metadata DDL', () => {
  it.each([
    ['netezza', 'DB.PUBLIC.USERS'],
    ['postgresql', 'PUBLIC."USERS"'],
    ['db2', 'DB.PUBLIC.USERS'],
    ['oracle', 'PUBLIC.USERS'],
    ['mssql', 'DB.PUBLIC.USERS'],
    ['clickhouse', 'DB.USERS'],
  ] as const)('qualifies a %s table using its dialect profile', (databaseKind, expectedName) => {
    const result = buildReconstructedTableDdl({
      databaseKind,
      database: 'DB',
      schema: 'PUBLIC',
      tableName: 'USERS',
      columns: [
        { name: 'ID', type: 'INTEGER', isPk: true },
        { name: 'Display Name', type: 'VARCHAR(80)' },
      ],
    });

    expect(result.ddl).toContain(`CREATE TABLE ${expectedName}`);
    expect(result.ddl).toContain(databaseKind === 'postgresql' ? 'PRIMARY KEY ("ID")' : 'PRIMARY KEY (ID)');
    expect(result.ddl).toContain(databaseKind === 'clickhouse' ? '`Display Name` VARCHAR(80)' : '"Display Name" VARCHAR(80)');
    expect(result.ddl).not.toContain('VARCHAR(1)');
  });

  it('uses MySQL/ClickHouse backticks for identifiers that need quoting', () => {
    const result = buildReconstructedTableDdl({
      databaseKind: 'clickhouse',
      database: 'analytics',
      tableName: 'sales data',
      columns: [{ name: 'order id', type: 'UInt64' }],
    });

    expect(result.ddl).toContain('CREATE TABLE analytics.`sales data`');
    expect(result.ddl).toContain('`order id` UInt64');
  });

  it('preserves SQLite typeless columns and makes the loss explicit', () => {
    const result = buildReconstructedTableDdl({
      databaseKind: 'sqlite',
      database: 'main',
      schema: 'main',
      tableName: 'events',
      columns: [{ name: 'payload' }],
    });

    expect(result.ddl).toContain('CREATE TABLE main.events\n(\n    payload\n);');
    expect(result.warnings.some(warning => warning.includes('typeless columns'))).toBe(true);
  });

  it('rejects missing types for dialects where a generic table reconstruction is unsafe', () => {
    expect(() => buildReconstructedTableDdl({
      databaseKind: 'postgresql',
      schema: 'public',
      tableName: 'events',
      columns: [{ name: 'payload' }],
    })).toThrow('payload has no declared type');
  });

  it('keeps a catalog CREATE VIEW source intact', () => {
    const result = buildReconstructedViewDdl({
      databaseKind: 'sqlite',
      database: 'main',
      schema: 'main',
      viewName: 'recent_events',
      sourceSql: 'CREATE VIEW recent_events AS SELECT * FROM events;',
    });

    expect(result.ddl).toBe('CREATE VIEW recent_events AS SELECT * FROM events;');
  });

  it('wraps query-only view metadata with the dialect-qualified name', () => {
    const result = buildReconstructedViewDdl({
      databaseKind: 'postgresql',
      database: 'db',
      schema: 'public',
      viewName: 'recent_events',
      sourceSql: 'SELECT * FROM events;\n',
    });

    expect(result.ddl).toBe('CREATE VIEW public.recent_events AS\nSELECT * FROM events;');
    expect(result.warnings).toHaveLength(2);
  });

  it('does not create a placeholder for missing view source', () => {
    expect(() => buildReconstructedViewDdl({
      databaseKind: 'duckdb',
      schema: 'main',
      viewName: 'empty_view',
      sourceSql: '  ',
    })).toThrow('No source SQL');
  });
});
