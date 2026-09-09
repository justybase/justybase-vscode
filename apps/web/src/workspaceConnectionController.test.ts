import type { ConnectionProfileSummary } from '@justybase/contracts';
import { emptyResult } from './queryState';
import { canEditActiveResult, normalizeSql, workspaceDatabase } from './workspaceConnectionController';
import { newEditorTab } from './workspaceDocumentController';

function connection(overrides: Partial<ConnectionProfileSummary> = {}): ConnectionProfileSummary {
  return {
    id: 'connection-1',
    name: 'Local',
    host: 'local',
    port: 0,
    database: 'main',
    user: 'local',
    dbType: 'sqlite',
    readOnly: true,
    ...overrides,
  };
}

describe('workspace connection controller', () => {
  it('normalizes product-specific workspace database names', () => {
    expect(workspaceDatabase(connection())).toBe('main');
    expect(workspaceDatabase(connection({ dbType: 'duckdb', database: '/tmp/sample.duckdb' }))).toBe('sample');
    expect(workspaceDatabase(connection({ dbType: 'duckdb', database: ':memory:' }))).toBe('memory');
    expect(workspaceDatabase(connection({ dbType: 'netezza', database: 'SYSTEM' }))).toBe('SYSTEM');
    expect(normalizeSql(' SELECT 1;\n')).toBe('SELECT 1');
  });

  it('allows row editing only when the source and current result still match', () => {
    const selected = connection();
    const tab = { ...newEditorTab(1, 'tab-1'), sql: 'SELECT * FROM main.orders', database: 'main', source: { id: 'orders', kind: 'object' as const, label: 'orders', objectName: 'orders', objectType: 'TABLE', schema: 'main', database: 'main', hasChildren: false }, sourceSql: 'SELECT * FROM main.orders', sourceConnectionId: selected.id, sourceDatabase: 'main' };
    const result = { ...emptyResult, status: 'complete' as const, sessionId: 'session-1', statementSql: 'SELECT * FROM main.orders' };
    expect(canEditActiveResult(tab, result, selected)).toBe(true);
    expect(canEditActiveResult(tab, result, connection({ id: 'other' }))).toBe(false);
    expect(canEditActiveResult(tab, { ...result, statementSql: 'SELECT * FROM main.other' }, selected)).toBe(false);
  });
});
