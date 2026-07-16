import type { SqlCompletionItem, SqlCompletionRequest, SqlCompletionResponse, SqlDiagnostic, SqlDiagnosticsRequest, SqlDiagnosticsResponse } from '@justybase/contracts';
import { isReadOnlySql, listColumns, listObjects } from './netezza';
import type { ApiConfig } from './config';
import type { AppStore, StoredConnection } from './store';

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'ON', 'GROUP BY', 'ORDER BY', 'HAVING',
  'LIMIT', 'OFFSET', 'UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT', 'WITH', 'AS', 'DISTINCT', 'CASE', 'WHEN', 'THEN', 'ELSE',
  'END', 'AND', 'OR', 'NOT', 'NULL', 'IS NULL', 'IS NOT NULL', 'IN', 'EXISTS', 'LIKE', 'BETWEEN', 'ASC', 'DESC',
  'INSERT INTO', 'UPDATE', 'DELETE FROM', 'MERGE INTO', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'CALL', 'EXPLAIN',
];

const FUNCTIONS = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'CAST', 'SUBSTR', 'TRIM', 'UPPER', 'LOWER', 'CURRENT_DATE', 'CURRENT_TIMESTAMP'];
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> { value: T; expiresAt: number; }
interface TableReference { table: string; alias?: string; }

const objectCache = new Map<string, CacheEntry<Awaited<ReturnType<typeof listObjects>>>>();
const columnCache = new Map<string, CacheEntry<Awaited<ReturnType<typeof listColumns>>>>();

export function invalidateSqlMetadataCache(connectionId: string): void {
  const prefix = `${connectionId}|`;
  for (const key of objectCache.keys()) if (key.startsWith(prefix)) objectCache.delete(key);
  for (const key of columnCache.keys()) if (key.startsWith(prefix)) columnCache.delete(key);
}

function getProfile(store: AppStore, userId: string, connectionId: string | undefined): StoredConnection | undefined {
  return connectionId ? store.getConnection(userId, connectionId) : undefined;
}

function currentToken(sql: string, offset: number): string {
  const prefix = sql.slice(0, Math.max(0, Math.min(offset, sql.length)));
  return /[A-Za-z_][A-Za-z0-9_$]*$/.exec(prefix)?.[0] ?? '';
}

function referencedTables(sql: string): TableReference[] {
  const references: TableReference[] = [];
  const pattern = /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:[A-Za-z_][A-Za-z0-9_$]*\.\.)?(?:[A-Za-z_][A-Za-z0-9_$]*\.)?([A-Za-z_][A-Za-z0-9_$]*)(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_$]*))?/gi;
  for (const match of sql.matchAll(pattern)) {
    const table = match[1];
    const alias = match[2];
    if (table && !['WHERE', 'JOIN', 'ON', 'GROUP', 'ORDER', 'LIMIT', 'UNION'].includes(table.toUpperCase())) references.push({ table, alias });
  }
  return references;
}

function uniqueItems(items: SqlCompletionItem[], token: string): SqlCompletionItem[] {
  const seen = new Set<string>();
  const normalizedToken = token.toUpperCase();
  return items.filter(item => {
    const key = `${item.kind}:${item.label.toUpperCase()}`;
    if (seen.has(key) || !item.label.toUpperCase().startsWith(normalizedToken)) return false;
    seen.add(key);
    return true;
  }).slice(0, 200);
}

async function cachedObjects(profile: StoredConnection, database: string, schema: string | undefined, masterKey: string) {
  const key = `${profile.id}|${database.toUpperCase()}|${(schema ?? '').toUpperCase()}`;
  const cached = objectCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await listObjects(profile, database, schema, masterKey);
  objectCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

async function cachedColumns(profile: StoredConnection, database: string, schema: string, table: string, masterKey: string) {
  const key = `${profile.id}|${database.toUpperCase()}|${schema.toUpperCase()}|${table.toUpperCase()}`;
  const cached = columnCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await listColumns(profile, database, schema, table, masterKey);
  columnCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export async function provideSqlCompletion(store: AppStore, config: ApiConfig, userId: string, request: SqlCompletionRequest): Promise<SqlCompletionResponse> {
  const token = currentToken(request.sql, request.offset);
  const prefix = request.sql.slice(0, request.offset);
  const items: SqlCompletionItem[] = [
    ...KEYWORDS.map(label => ({ label, kind: 'keyword' as const })),
    ...FUNCTIONS.map(label => ({ label, kind: 'function' as const, detail: 'Netezza function' })),
  ];
  const profile = getProfile(store, userId, request.connectionId);
  if (profile && request.database && request.schema) {
    const objects = await cachedObjects(profile, request.database, request.schema, config.masterKey);
    items.push(...objects.map(object => ({ label: object.name, kind: object.objectType?.toUpperCase() === 'VIEW' ? 'view' as const : 'table' as const, detail: object.objectType ?? 'TABLE' })));
    const refs = referencedTables(prefix);
    const qualifier = /(?:^|[^A-Za-z0-9_$])([A-Za-z_][A-Za-z0-9_$]*)\.[A-Za-z_0-9$]*$/.exec(prefix)?.[1];
    const targetRefs = qualifier ? refs.filter(reference => reference.alias?.toUpperCase() === qualifier.toUpperCase() || reference.table.toUpperCase() === qualifier.toUpperCase()) : refs;
    for (const reference of targetRefs.slice(0, 5)) {
      const columns = await cachedColumns(profile, request.database, request.schema, reference.table, config.masterKey);
      items.push(...columns.map(column => ({ label: column.name, kind: 'column' as const, detail: column.type })));
    }
  }
  return { items: uniqueItems(items, token) };
}

function positionAt(sql: string, offset: number): { line: number; character: number } {
  const safeOffset = Math.max(0, Math.min(offset, sql.length));
  const before = sql.slice(0, safeOffset);
  const lines = before.split('\n');
  return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 };
}

function diagnostic(sql: string, message: string, severity: SqlDiagnostic['severity'], offset: number, code: string): SqlDiagnostic {
  return { message, severity, code, start: positionAt(sql, offset), end: positionAt(sql, Math.min(sql.length, offset + 1)) };
}

export async function provideSqlDiagnostics(store: AppStore, _config: ApiConfig, userId: string, request: SqlDiagnosticsRequest): Promise<SqlDiagnosticsResponse> {
  const diagnostics: SqlDiagnostic[] = [];
  const sql = request.sql;
  let quoteOpen = false;
  let parentheses = 0;
  for (let index = 0; index < sql.length; index += 1) {
    if (sql[index] === "'" && sql[index + 1] === "'") { index += 1; continue; }
    if (sql[index] === "'") { quoteOpen = !quoteOpen; continue; }
    if (quoteOpen) continue;
    if (sql[index] === '(') parentheses += 1;
    if (sql[index] === ')') {
      parentheses -= 1;
      if (parentheses < 0) { diagnostics.push(diagnostic(sql, 'Unexpected closing parenthesis.', 'error', index, 'WEB001')); parentheses = 0; }
    }
  }
  if (quoteOpen) diagnostics.push(diagnostic(sql, 'Unterminated string literal.', 'error', Math.max(0, sql.lastIndexOf("'")), 'WEB002'));
  if (parentheses > 0) diagnostics.push(diagnostic(sql, 'Unclosed parenthesis.', 'error', sql.length, 'WEB003'));
  const profile = getProfile(store, userId, request.connectionId);
  if (profile?.readOnly && sql.trim() && !isReadOnlySql(sql)) diagnostics.push(diagnostic(sql, 'This connection is read-only; the statement may be rejected.', 'warning', 0, 'WEB004'));
  return { diagnostics };
}
