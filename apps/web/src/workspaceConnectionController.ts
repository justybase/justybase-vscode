import type { ConnectionProfileSummary } from '@justybase/contracts';
import type { ResultState } from './queryState';
import type { EditorTab } from './workspaceDocumentController';

export function workspaceDatabase(connection: ConnectionProfileSummary): string {
  if (connection.dbType === 'sqlite') return 'main';
  if (connection.dbType === 'duckdb') {
    if (connection.database === ':memory:') return 'memory';
    const base = connection.database.replaceAll('\\', '/').split('/').pop() ?? connection.database;
    return base.replace(/\.(?:duckdb|ddb)$/i, '') || base;
  }
  return connection.database;
}

export function normalizeSql(value: string): string {
  return value.trim().replace(/;\s*$/u, '').replace(/\s+/gu, ' ');
}

export function canEditActiveResult(tab: EditorTab | undefined, result: ResultState, connection: ConnectionProfileSummary | null): boolean {
  return Boolean(tab?.source && tab.source.kind === 'object' && tab.source.objectType?.toUpperCase() === 'TABLE'
    && tab.sourceSql && normalizeSql(tab.sourceSql) === normalizeSql(tab.sql)
    && tab.sourceConnectionId === connection?.id && tab.sourceDatabase === tab.database
    && result.status.startsWith('complete') && result.sessionId && result.statementSql
    && normalizeSql(result.statementSql) === normalizeSql(tab.sourceSql));
}
