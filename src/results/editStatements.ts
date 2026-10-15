import type { EditSource } from '../types/index';

/** One change the inline editor will execute, with the SQL it would run. */
export interface EditStatement {
  kind: 'update' | 'delete';
  rowIndex: number;
  sql: string;
}

export interface EditChangeInput {
  rowIndex: number;
  columnIndex: number;
  newValue: unknown;
}

interface EditableResultShape {
  columns: Array<{ name: string; type?: string }>;
  data: unknown[][];
}

export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function buildFullTableName(editSource: EditSource): string {
  const parts: string[] = [];
  if (editSource.db) parts.push(editSource.db);
  if (editSource.schema) parts.push(editSource.schema);
  parts.push(editSource.table);
  return parts.map(quoteIdentifier).join('.');
}

/** Formats a cell value as a SQL literal for the given column type. */
export function formatEditValue(value: unknown, dataType?: string): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';

  // Handle Date objects for timestamp/date columns.
  // Netezza driver returns Date objects in UTC; use UTC methods so the
  // formatted literal matches the database's stored value exactly.
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    const hh = String(value.getUTCHours()).padStart(2, '0');
    const mm = String(value.getUTCMinutes()).padStart(2, '0');
    const ss = String(value.getUTCSeconds()).padStart(2, '0');
    const dt = dataType?.toLowerCase() ?? '';
    if (dt.includes('date') && !dt.includes('timestamp') && !dt.includes('time')) {
      return `'${y}-${m}-${d}'`;
    }
    return `'${y}-${m}-${d} ${hh}:${mm}:${ss}'`;
  }

  const str = String(value);
  // Check if it's a numeric string
  if (dataType && /\b(?:tinyint|smallint|mediumint|bigint|hugeint|integer|int(?:2|4|8|16|32|64)?|u(?:tinyint|smallint|integer|bigint|hugeint|int(?:8|16|32|64)?)|byteint|serial|smallserial|bigserial|numeric|decimal|number|float|double|real|money|smallmoney|decfloat|single)\b/i.test(dataType)) {
    const cleanNum = str.replace(/[\s,]/g, '');
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(cleanNum)) return cleanNum;
  }
  // Escape single quotes for string values
  return `'${str.replace(/'/g, "''")}'`;
}

/**
 * Builds the DELETE and UPDATE statements that inline editing would run, in execution
 * order (deletes first, then updates). Pure: no database access, so the confirmation
 * dialog and the executor always show and run the same SQL.
 */
export function buildEditStatements(
  rs: EditableResultShape,
  editSource: EditSource,
  edits: EditChangeInput[],
  deleteRowIndices: number[] = [],
): EditStatement[] {
  const fullTableName = buildFullTableName(editSource);
  const statements: EditStatement[] = [];

  for (const delRowIdx of deleteRowIndices) {
    const origRow = rs.data[delRowIdx];
    if (!origRow) continue;
    // Row identification relies on non-null columns only (see update WHERE below).
    const whereClauses: string[] = [];
    rs.columns.forEach((colDef, ci) => {
      const origVal = origRow[ci];
      if (origVal === null || origVal === undefined) return;
      whereClauses.push(`${quoteIdentifier(colDef.name)} = ${formatEditValue(origVal, colDef.type)}`);
    });
    if (whereClauses.length === 0) continue;
    statements.push({
      kind: 'delete',
      rowIndex: delRowIdx,
      sql: `DELETE FROM ${fullTableName} WHERE ${whereClauses.join(' AND ')}`,
    });
  }

  const editsByRow = new Map<number, { columnIndex: number; newValue: unknown }[]>();
  for (const edit of edits) {
    const existing = editsByRow.get(edit.rowIndex) || [];
    existing.push({ columnIndex: edit.columnIndex, newValue: edit.newValue });
    editsByRow.set(edit.rowIndex, existing);
  }

  for (const [rowIndex, rowEdits] of editsByRow) {
    const originalRow = rs.data[rowIndex];
    if (!originalRow) continue;

    const setClauses: string[] = [];
    for (const edit of rowEdits) {
      const colDef = rs.columns[edit.columnIndex];
      if (!colDef) continue;
      setClauses.push(`${quoteIdentifier(colDef.name)} = ${formatEditValue(edit.newValue, colDef.type)}`);
    }
    if (setClauses.length === 0) continue;

    // NULL values are skipped (col IS NULL is too broad and risky).
    const whereClauses: string[] = [];
    rs.columns.forEach((colDef, ci) => {
      const origVal = originalRow[ci];
      if (origVal === null || origVal === undefined) return;
      whereClauses.push(`${quoteIdentifier(colDef.name)} = ${formatEditValue(origVal, colDef.type)}`);
    });
    if (whereClauses.length === 0) continue;

    statements.push({
      kind: 'update',
      rowIndex,
      sql: `UPDATE ${fullTableName} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`,
    });
  }

  return statements;
}
