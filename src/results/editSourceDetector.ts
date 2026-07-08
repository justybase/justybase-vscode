import type { EditSource } from '../types/index';

/**
 * Detect if a SQL query is a simple SELECT from a single table/view
 * that can be edited inline. Returns null for complex queries (CTE, JOIN, subquery, UNION).
 *
 * Handles:
 *   SELECT ... FROM table
 *   SELECT ... FROM schema.table
 *   SELECT ... FROM db.schema.table
 *   Options: WHERE, ORDER BY, GROUP BY, LIMIT, OFFSET, HAVING, alias
 */
export function detectEditSource(sql: string): EditSource | null {
  if (!sql) return null;

  const trimmed = sql.trim();

  // Must start with SELECT (case-insensitive)
  if (!/^\s*SELECT\b/i.test(trimmed)) return null;

  // Reject CTEs
  if (/^\s*WITH\b/i.test(trimmed)) return null;

  // Reject JOINs (including INNER, LEFT, RIGHT, FULL, CROSS, NATURAL)
  if (/\bJOIN\b/i.test(trimmed)) return null;

  // Reject UNION, INTERSECT, EXCEPT, MINUS
  if(/\bUNION\b/i.test(trimmed)) return null;
  if (/\bINTERSECT\b/i.test(trimmed)) return null;
  if (/\bEXCEPT\b/i.test(trimmed)) return null;
  if (/\bMINUS\b/i.test(trimmed)) return null;

  // Extract FROM clause content — everything between FROM and next keyword
  // (WHERE, GROUP, ORDER, HAVING, LIMIT, OFFSET, FOR, INTO)
  const fromMatch = trimmed.match(/\bFROM\s+([^\s;()]+(?:\s*\.\s*[^\s;.()]+)*)/i);
  if (!fromMatch) return null;

  let tableRef = fromMatch[1];

  // Strip alias (e.g. "table t" → "table", "table AS t" → "table")
  tableRef = tableRef.replace(/\s+(AS\s+)?\w+$/i, '').trim();

  if (!tableRef) return null;

  // Split into parts: db.schema.table
  const parts = tableRef.split('.').map(p => p.replace(/["`[\]']/g, '').trim()).filter(Boolean);

  if (parts.length === 1) {
    return { table: parts[0] };
  }
  if (parts.length === 2) {
    return { schema: parts[0], table: parts[1] };
  }
  if (parts.length >= 3) {
    return { db: parts[0], schema: parts[1], table: parts.slice(2).join('.') };
  }

  return null;
}
