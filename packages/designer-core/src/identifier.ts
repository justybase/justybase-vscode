import type { DatabaseKind } from '@justybase/contracts';

const RESERVED_KEYWORDS = new Set([
  'ABORT', 'ACTION', 'ADD', 'AFTER', 'ALL', 'ALTER', 'ALWAYS', 'ANALYZE', 'AND', 'AS', 'ASC', 'ATTACH',
  'AUTOINCREMENT', 'BEFORE', 'BEGIN', 'BETWEEN', 'BY', 'CASCADE', 'CASE', 'CAST', 'CHECK', 'COLLATE',
  'COLUMN', 'COMMIT', 'CONFLICT', 'CONSTRAINT', 'CREATE', 'CROSS', 'CURRENT', 'CURRENT_DATE',
  'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'DATABASE', 'DEFAULT', 'DEFERRABLE', 'DEFERRED', 'DELETE', 'DESC',
  'DETACH', 'DISTINCT', 'DO', 'DROP', 'EACH', 'ELSE', 'END', 'ESCAPE', 'EXCEPT', 'EXCLUDE', 'EXCLUSIVE',
  'EXISTS', 'EXPLAIN', 'FAIL', 'FILTER', 'FIRST', 'FOLLOWING', 'FOR', 'FOREIGN', 'FROM', 'FULL', 'GENERATED',
  'GLOB', 'GROUP', 'GROUPS', 'HAVING', 'IF', 'IGNORE', 'IMMEDIATE', 'IN', 'INDEX', 'INDEXED', 'INITIALLY',
  'INNER', 'INSERT', 'INSTEAD', 'INTERSECT', 'INTO', 'IS', 'ISNULL', 'JOIN', 'KEY', 'LAST', 'LEFT', 'LIKE',
  'LIMIT', 'MATCH', 'MATERIALIZED', 'NATURAL', 'NO', 'NOT', 'NOTHING', 'NOTNULL', 'NULL', 'NULLS', 'OF',
  'OFFSET', 'ON', 'OR', 'ORDER', 'OTHERS', 'OUTER', 'OVER', 'PARTITION', 'PLAN', 'PRAGMA', 'PRECEDING',
  'PRIMARY', 'QUERY', 'RAISE', 'RANGE', 'RECURSIVE', 'REFERENCES', 'REGEXP', 'REINDEX', 'RELEASE', 'RENAME',
  'REPLACE', 'RESTRICT', 'RETURNING', 'RIGHT', 'ROLLBACK', 'ROW', 'ROWS', 'SAVEPOINT', 'SELECT', 'SET',
  'TABLE', 'TEMP', 'TEMPORARY', 'THEN', 'TIES', 'TO', 'TRANSACTION', 'TRIGGER', 'UNBOUNDED', 'UNION',
  'UNIQUE', 'UPDATE', 'USING', 'VACUUM', 'VALUES', 'VIEW', 'VIRTUAL', 'WHEN', 'WHERE', 'WINDOW', 'WITH',
  'WITHOUT',
]);

function stripIdentifierQuoting(value: string, kind: string): string {
  const trimmed = value.trim();
  if (kind === 'mysql' || kind === 'clickhouse') {
    if (trimmed.startsWith('`') && trimmed.endsWith('`')) return trimmed.slice(1, -1).replace(/``/g, '`');
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replace(/""/g, '"');
  return trimmed;
}

function identifierPattern(kind: string): RegExp {
  if (kind === 'mssql') return /^[A-Za-z_][A-Za-z0-9_$#@]*$/u;
  if (kind === 'netezza') return /^[A-Z_][A-Z0-9_]*$/u;
  if (kind === 'oracle' || kind === 'db2' || kind === 'snowflake') {
    return /^[A-Z_][A-Z0-9_$]*$/u;
  }
  if (kind === 'postgresql' || kind === 'vertica' || kind === 'duckdb' || kind === 'file') {
    return /^[a-z_][a-z0-9_$]*$/u;
  }
  return /^[A-Za-z_][A-Za-z0-9_$]*$/u;
}

function quoteIdentifier(value: string, kind: string): string {
  if (kind === 'mysql' || kind === 'clickhouse') return `\`${value.replace(/`/g, '``')}\``;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Formats the simple identifiers used by CREATE TABLE without importing the
 * desktop dialect implementation. This intentionally preserves the previous
 * behavior: ordinary identifiers stay unquoted and reserved/unsafe names are
 * quoted according to the selected dialect.
 */
export function formatTableDesignerIdentifier(identifier: string, databaseKind: string | DatabaseKind): string {
  const kind = String(databaseKind).trim().toLowerCase();
  const value = stripIdentifierQuoting(identifier, kind);
  if (!value) return value;
  const needsKeywordQuoting = kind === 'sqlite'
    || kind === 'duckdb'
    || kind === 'postgresql'
    || kind === 'mysql';
  return identifierPattern(kind).test(value) && !(needsKeywordQuoting && RESERVED_KEYWORDS.has(value.toUpperCase()))
    ? value
    : quoteIdentifier(value, kind);
}
