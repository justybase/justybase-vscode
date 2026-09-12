import type { DataGridColumn, DataGridCopyPayload } from './dataGrid';
import {
  formatDataGridCellValue,
  isDataGridNumericColumn,
  isDataGridTemporalColumn,
} from './resultGridFormatting';

export type DataGridClipboardFormat = 'text' | 'tsv' | 'html' | 'markdown' | 'csv' | 'csv-semicolon' | 'json' | 'sql';

export interface DataGridClipboardPayload {
  readonly text: string;
  readonly html: string;
  readonly markdown: string;
  readonly csv: string;
  readonly csvSemicolon: string;
  readonly json: string;
  readonly sql: string;
}

export interface DataGridClipboardOptions {
  readonly includeHeaders?: boolean;
  readonly tableName?: string;
}

interface ClipboardCell {
  readonly text: string;
  readonly htmlValue: string;
  readonly kind: 'text' | 'number' | 'date';
  readonly numericValue?: string;
}

function normalizeExcelNumericValue(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u.test(trimmed) ? trimmed : undefined;
}

function getLocaleDecimalSeparator(): string {
  try {
    return new Intl.NumberFormat().formatToParts(1.1).find(part => part.type === 'decimal')?.value ?? '.';
  } catch {
    return '.';
  }
}

function localizeNumericDisplayText(text: string): string {
  const separator = getLocaleDecimalSeparator();
  if (separator === '.' || text.includes(',')) return text;
  const compact = text.trim().replace(/[\s\u00a0\u202f]/gu, '');
  if (!/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u.test(compact)) return text;
  return text.replace('.', separator);
}

function cellPayload(value: unknown, column: DataGridColumn): ClipboardCell {
  const text = formatDataGridCellValue(value, column.type, column);
  if (value === null || value === undefined) return { text, htmlValue: text, kind: 'text' };
  const numericValue = isDataGridNumericColumn(column) ? normalizeExcelNumericValue(value) : undefined;
  if (numericValue !== undefined) return { text, htmlValue: localizeNumericDisplayText(text), kind: 'number', numericValue };
  if (isDataGridTemporalColumn(column)) return { text, htmlValue: text, kind: 'date' };
  return { text, htmlValue: text, kind: 'text' };
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function escapeCsvValue(value: string, separator: string): string {
  return /["\r\n]/u.test(value) || value.includes(separator) ? `"${value.replace(/"/gu, '""')}"` : value;
}

function uniqueJsonNames(columns: readonly DataGridColumn[]): string[] {
  const used = new Set<string>();
  return columns.map((column, index) => {
    const base = column.name || `column_${index + 1}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    return candidate;
  });
}

function serialiseJsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Array.from(value);
  if (value && typeof value === 'object') {
    try {
      JSON.stringify(value);
      return value;
    } catch {
      return String(value);
    }
  }
  return value;
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return `'${value.toISOString().replace(/'/gu, "''")}'`;
  if (value instanceof Uint8Array) return `X'${Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')}'`;
  if (typeof value === 'object') {
    try {
      return `'${(JSON.stringify(value) ?? String(value)).replace(/'/gu, "''")}'`;
    } catch {
      return `'${String(value).replace(/'/gu, "''")}'`;
    }
  }
  return `'${String(value).replace(/'/gu, "''")}'`;
}

function columnAlignment(column: DataGridColumn): 'left' | 'right' {
  return isDataGridNumericColumn(column) || isDataGridTemporalColumn(column) ? 'left' : 'right';
}

function markdownEscape(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/\r?\n/gu, '<br>');
}

function createPlainTextTable(headers: readonly string[], matrix: readonly (readonly ClipboardCell[])[]): string {
  const lines: string[] = [];
  if (headers.length > 0) lines.push(headers.join('\t'));
  for (const row of matrix) lines.push(row.map(cell => cell.text).join('\t'));
  return lines.join('\n');
}

function createCsvTable(headers: readonly string[], matrix: readonly (readonly ClipboardCell[])[], separator: string): string {
  const lines: string[] = [];
  if (headers.length > 0) lines.push(headers.map(header => escapeCsvValue(header, separator)).join(separator));
  for (const row of matrix) {
    lines.push(row.map(cell => {
      const value = separator === ';' && cell.kind === 'number' ? cell.text.replace('.', ',') : cell.text;
      return escapeCsvValue(value, separator);
    }).join(separator));
  }
  return lines.join('\n');
}

function createMarkdownTable(headers: readonly string[], matrix: readonly (readonly ClipboardCell[])[]): string {
  if (matrix.length === 0) return '';
  const effectiveHeaders = headers.length > 0 ? headers : matrix[0]!.map(() => '');
  const alignments = matrix[0]!.map((_cell, index) => index);
  const lines = [
    `| ${effectiveHeaders.map(markdownEscape).join(' | ')} |`,
    `| ${alignments.map(() => '---').join(' | ')} |`,
  ];
  for (const row of matrix) lines.push(`| ${row.map(cell => markdownEscape(cell.text)).join(' | ')} |`);
  return lines.join('\n');
}

function createHtmlTable(headers: readonly string[], matrix: readonly (readonly ClipboardCell[])[], columns: readonly DataGridColumn[]): string {
  const tableStyle = 'border-collapse:collapse;border-spacing:0;font-family:Calibri, Arial, sans-serif;font-size:11pt;line-height:1.4;color:#1f1f1f';
  const headerStyle = 'background-color:#f3f2f1;border:1px solid #d1d1d1;padding:6px 8px;font-weight:600;text-align:left;vertical-align:top;white-space:nowrap';
  const head = headers.length > 0
    ? `<thead><tr>${headers.map(header => `<th align="left" style="${headerStyle}">${escapeHtml(header)}</th>`).join('')}</tr></thead>`
    : '';
  const body = matrix.map((row, rowIndex) => {
    const background = rowIndex % 2 === 0 ? '#ffffff' : '#faf9f8';
    const cells = row.map((cell, columnIndex) => {
      const alignment = columnAlignment(columns[columnIndex] ?? {} as DataGridColumn);
      const style = `border:1px solid #d1d1d1;padding:6px 8px;text-align:${alignment};vertical-align:top;background-color:${background};white-space:nowrap${cell.kind === 'text' ? ";mso-number-format:'\\@'" : ''}`;
      const numeric = cell.kind === 'number' && cell.numericValue !== undefined ? ` x:num="${escapeHtml(cell.numericValue)}"` : '';
      return `<td align="${alignment}" style="${style}"${numeric}>${escapeHtml(cell.htmlValue)}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"></head><body><table style="${tableStyle}">${head}<tbody>${body}</tbody></table></body></html>`;
}

function createJsonTable(columns: readonly DataGridColumn[], rows: readonly (readonly unknown[])[]): string {
  const names = uniqueJsonNames(columns);
  const records = rows.map(row => Object.fromEntries(names.map((name, index) => [name, serialiseJsonValue(row[index])])), );
  return JSON.stringify(records, null, 2);
}

function createSqlTable(columns: readonly DataGridColumn[], rows: readonly (readonly unknown[])[], tableName: string): string {
  if (rows.length === 0) return '';
  const names = columns.map((column, index) => `"${(column.name || `column_${index + 1}`).replace(/"/gu, '""')}"`).join(', ');
  return rows.map(row => `INSERT INTO ${tableName} (${names}) VALUES (${row.map(sqlLiteral).join(', ')});`).join('\n');
}

/**
 * Produces the same typed clipboard representations for every product host.
 * It intentionally has no DOM, navigator, or VS Code dependency so adapters
 * can decide how to write the formats to their platform clipboard.
 */
export function createDataGridClipboardPayload(
  payload: DataGridCopyPayload,
  options: DataGridClipboardOptions = {},
): DataGridClipboardPayload {
  const includeHeaders = options.includeHeaders ?? true;
  const headers = includeHeaders ? payload.columns.map(column => column.name) : [];
  const matrix = payload.rows.map(row => payload.columns.map((column, index) => cellPayload(row[index], column)));
  const tableName = options.tableName ?? '<table>';
  return {
    text: createPlainTextTable(headers, matrix),
    html: createHtmlTable(headers, matrix, payload.columns),
    markdown: createMarkdownTable(headers, matrix),
    csv: createCsvTable(headers, matrix, ','),
    csvSemicolon: createCsvTable(headers, matrix, ';'),
    json: createJsonTable(payload.columns, payload.rows),
    sql: createSqlTable(payload.columns, payload.rows, tableName),
  };
}

export function formatDataGridClipboard(payload: DataGridCopyPayload, format: DataGridClipboardFormat = 'text', options?: DataGridClipboardOptions): string {
  const formatted = createDataGridClipboardPayload(payload, options);
  if (format === 'html') return formatted.html;
  if (format === 'markdown') return formatted.markdown;
  if (format === 'csv') return formatted.csv;
  if (format === 'csv-semicolon') return formatted.csvSemicolon;
  if (format === 'json') return formatted.json;
  if (format === 'sql') return formatted.sql;
  return formatted.text;
}
