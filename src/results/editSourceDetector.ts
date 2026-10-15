import type { EditSource } from '../types/index';

export type EditSourceAnalysis =
  | { source: EditSource; reason?: undefined }
  | { source: null; reason: string };

/**
 * Analyze whether a SQL query is a simple SELECT from a single table/view
 * that can be edited inline. When it cannot, `reason` explains why in a
 * user-facing sentence so the UI can tell the user instead of failing silently.
 *
 * Handles:
 *   SELECT ... FROM table
 *   SELECT ... FROM schema.table
 *   SELECT ... FROM db.schema.table
 *   Options: WHERE, ORDER BY, GROUP BY, LIMIT, OFFSET, HAVING, alias
 */
export function analyzeEditSource(sql: string): EditSourceAnalysis {
  if (!sql) return { source: null, reason: 'No SQL text is associated with this result.' };

  const trimmed = sql.trim();

  // Reject CTEs (checked before SELECT: a WITH query never starts with SELECT)
  if (/^\s*WITH\b/i.test(trimmed)) {
    return { source: null, reason: 'Editing is not available for WITH (CTE) queries.' };
  }

  // Must start with SELECT (case-insensitive)
  if (!/^\s*SELECT\b/i.test(trimmed)) {
    return { source: null, reason: 'Only SELECT results from a single table can be edited.' };
  }

  // Reject JOINs (including INNER, LEFT, RIGHT, FULL, CROSS, NATURAL)
  if (/\bJOIN\b/i.test(trimmed)) {
    return { source: null, reason: 'Editing is not available for queries with JOIN.' };
  }

  // Reject UNION, INTERSECT, EXCEPT, MINUS
  if (/\bUNION\b/i.test(trimmed) || /\bINTERSECT\b/i.test(trimmed)
    || /\bEXCEPT\b/i.test(trimmed) || /\bMINUS\b/i.test(trimmed)) {
    return { source: null, reason: 'Editing is not available for UNION / INTERSECT / EXCEPT queries.' };
  }

  // Extract FROM clause content — everything between FROM and next keyword
  // (WHERE, GROUP, ORDER, HAVING, LIMIT, OFFSET, FOR, INTO)
  const fromMatch = trimmed.match(/\bFROM\s+([^\s;()]+(?:\s*\.\s*[^\s;.()]+)*)/i);
  if (!fromMatch) {
    return { source: null, reason: 'Editing needs a single table in the FROM clause.' };
  }

  let tableRef = fromMatch[1];

  // Strip alias (e.g. "table t" → "table", "table AS t" → "table")
  tableRef = tableRef.replace(/\s+(AS\s+)?\w+$/i, '').trim();

  if (!tableRef) {
    return { source: null, reason: 'Editing needs a single table in the FROM clause.' };
  }

  // Split into parts: db.schema.table
  const parts = tableRef.split('.').map(p => p.replace(/["`[\]']/g, '').trim()).filter(Boolean);

  if (parts.length === 1) {
    return { source: { table: parts[0] } };
  }
  if (parts.length === 2) {
    return { source: { schema: parts[0], table: parts[1] } };
  }
  if (parts.length >= 3) {
    return { source: { db: parts[0], schema: parts[1], table: parts.slice(2).join('.') } };
  }

  return { source: null, reason: 'Editing needs a single table in the FROM clause.' };
}

/**
 * Detect if a SQL query is a simple SELECT from a single table/view that can be
 * edited inline. Returns null for complex queries (CTE, JOIN, subquery, UNION).
 */
export function detectEditSource(sql: string): EditSource | null {
  return analyzeEditSource(sql).source;
}
