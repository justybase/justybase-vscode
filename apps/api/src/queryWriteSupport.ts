import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  QueryEditPreviewRequest,
  QueryFileImportPreviewRequest,
  QueryImportPreviewRequest,
} from '@justybase/contracts';
import { MAX_QUERY_FILE_IMPORT_BYTES } from '@justybase/contracts';
import type { StoredConnection } from './store';

function quoteWriteIdentifier(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\u0000')) throw new Error(`${field} is required.`);
  return `"${trimmed.replace(/"/g, '""')}"`;
}

function quoteWriteTarget(database: string | undefined, schema: string, table: string, dbType: StoredConnection['dbType'] = 'netezza'): string {
  if (dbType === 'sqlite') {
    const catalog = database?.trim() || schema.trim();
    return `${quoteWriteIdentifier(catalog, 'database')}.${quoteWriteIdentifier(table, 'table')}`;
  }
  return [database, schema, table].filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part, index) => quoteWriteIdentifier(part, index === 0 && database ? 'database' : index === 1 || !database ? 'schema' : 'table'))
    .join('.');
}

function sqlWriteLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `'${text.replace(/\u0000/g, '').replace(/'/g, "''")}'`;
}

function sqlWritePredicate(column: string, value: unknown, field: string): string {
  const identifier = quoteWriteIdentifier(column, field);
  return value === null || value === undefined ? `${identifier} IS NULL` : `${identifier} = ${sqlWriteLiteral(value)}`;
}

function sortedWriteEntries(values: Record<string, unknown>, field: string): Array<[string, unknown]> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`${field} is required.`);
  const entries = Object.entries(values).filter(([key]) => key.trim().length > 0).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) throw new Error(`${field} must contain at least one column.`);
  return entries;
}

export function buildUpdateSql(input: QueryEditPreviewRequest, dbType: StoredConnection['dbType'] = 'netezza'): string {
  const target = quoteWriteTarget(input.database, input.schema, input.table, dbType);
  const changes = sortedWriteEntries(input.changes, 'changes');
  const keys = sortedWriteEntries(input.key, 'key');
  const setClause = changes.map(([column, value]) => `${quoteWriteIdentifier(column, 'column')} = ${sqlWriteLiteral(value)}`).join(', ');
  const whereClause = keys.map(([column, value]) => sqlWritePredicate(column, value, 'key column')).join(' AND ');
  return `UPDATE ${target} SET ${setClause} WHERE ${whereClause};`;
}

export function buildInsertSql(input: QueryImportPreviewRequest, dbType: StoredConnection['dbType'] = 'netezza'): string {
  if (!Array.isArray(input.columns) || input.columns.length === 0) throw new Error('At least one import column is required.');
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw new Error('At least one import row is required.');
  if (input.rows.length > 10_000) throw new Error('Imports are limited to 10,000 rows per operation.');
  const columns = input.columns.map(column => quoteWriteIdentifier(column, 'column'));
  const rows = input.rows.map(row => {
    if (!Array.isArray(row) || row.length !== input.columns.length) throw new Error('Every import row must match the column count.');
    return `(${row.map(sqlWriteLiteral).join(', ')})`;
  });
  if (rows.length === 0) throw new Error('At least one import row is required.');
  const target = quoteWriteTarget(input.database, input.schema, input.table, dbType);
  return `INSERT INTO ${target} (${columns.join(', ')}) VALUES\n  ${rows.join(',\n  ')};`;
}

interface SpreadsheetReader {
  open(filePath: string): Promise<void>;
  read(): Promise<boolean> | boolean;
  close(): Promise<void>;
  _currentRow?: unknown[];
  /** Internal selection cursor exposed by the package's reader contract. */
  _currentSheetIndex?: number;
  getSheetNames?: () => string[];
  _initSheet?: (index: number) => Promise<void> | void;
}

interface SpreadsheetTasksModule {
  ReaderFactory?: { create(filePath: string): SpreadsheetReader };
}

function parseCsvImport(text: string, delimiter: string): unknown[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quoted) {
      if (character === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && next === '\n') index += 1;
      row.push(field);
      if (row.some(value => value.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some(value => value.length > 0)) rows.push(row);
  }
  return rows;
}

function importColumnNames(header: unknown[] | undefined, width: number, targetColumns?: string[]): string[] {
  const used = new Set<string>();
  return Array.from({ length: width }, (_, index) => {
    const original = header?.[index] ?? targetColumns?.[index];
    const base = String(original ?? '').trim() || `column_${index + 1}`;
    let name = base;
    let suffix = 2;
    while (used.has(name.toLowerCase())) {
      name = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

async function readSpreadsheetImport(filePath: string, sheetName?: string): Promise<unknown[][]> {
  let spreadsheet: SpreadsheetTasksModule;
  try {
    spreadsheet = require('@justybase/spreadsheet-tasks') as SpreadsheetTasksModule;
  } catch (error: unknown) {
    throw new Error(`Spreadsheet import is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const factory = spreadsheet.ReaderFactory;
  if (!factory) throw new Error('Spreadsheet import is unavailable in this installation.');
  const reader = factory.create(filePath);
  try {
    await reader.open(filePath);
    if (sheetName) {
      const sheets = reader.getSheetNames?.() ?? [];
      const sheetIndex = sheets.indexOf(sheetName);
      if (sheetIndex < 0) throw new Error(`Worksheet "${sheetName}" was not found.`);
      if (!reader._initSheet) throw new Error('This spreadsheet reader cannot select a worksheet.');
      await reader._initSheet(sheetIndex);
      reader._currentSheetIndex = sheetIndex;
    }
    const rows: unknown[][] = [];
    while (await reader.read()) {
      const values = reader._currentRow;
      if (Array.isArray(values)) rows.push([...values]);
      if (rows.length > 10_000) throw new Error('Imports are limited to 10,000 rows per operation.');
    }
    return rows;
  } finally {
    await reader.close().catch(() => undefined);
  }
}

export async function materializeFileImport(input: QueryFileImportPreviewRequest, targetColumns?: string[]): Promise<QueryImportPreviewRequest> {
  if (typeof input.fileName !== 'string' || input.fileName.trim().length === 0) throw new Error('fileName is required.');
  if (input.format !== 'csv' && input.format !== 'xlsx' && input.format !== 'xlsb') throw new Error('format must be csv, xlsx, or xlsb.');
  const expectedExtension = ({ csv: 'csv', xlsx: 'xlsx', xlsb: 'xlsb' } as const)[input.format];
  const actualExtension = path.extname(path.basename(input.fileName)).slice(1).toLowerCase();
  if (actualExtension !== expectedExtension) throw new Error(`fileName must use the .${expectedExtension} extension for ${input.format} imports.`);
  if (input.hasHeader !== undefined && typeof input.hasHeader !== 'boolean') throw new Error('hasHeader must be a boolean.');
  if (typeof input.contentBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64)) throw new Error('contentBase64 is invalid.');
  const content = Buffer.from(input.contentBase64, 'base64');
  if (content.length === 0) throw new Error('The import file is empty.');
  if (content.length > MAX_QUERY_FILE_IMPORT_BYTES) throw new Error('Import files are limited to 25 MB.');
  const extension = expectedExtension;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'justybase-web-import-'));
  const tempPath = path.join(tempDir, `upload.${extension}`);
  try {
    await writeFile(tempPath, content, { mode: 0o600 });
    const rawRows = input.format === 'csv'
      ? parseCsvImport(content.toString('utf8'), typeof input.delimiter === 'string' && input.delimiter.length === 1 ? input.delimiter : ',')
      : await readSpreadsheetImport(tempPath, input.sheetName);
    if (rawRows.length === 0) throw new Error('The import file does not contain any rows.');
    const width = rawRows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
    if (width === 0) throw new Error('The import file does not contain any columns.');
    const hasHeader = input.hasHeader !== false;
    const header = hasHeader ? rawRows[0] : undefined;
    const dataRows = (hasHeader ? rawRows.slice(1) : rawRows).map(row => Array.from({ length: width }, (_, index) => row[index] ?? null));
    if (dataRows.length === 0) throw new Error('The import file contains a header but no data rows.');
    if (!hasHeader && (!targetColumns || targetColumns.length < width)) throw new Error('A headerless import must fit the target table columns.');
    return {
      connectionId: input.connectionId,
      database: input.database,
      schema: input.schema,
      table: input.table,
      columns: importColumnNames(header, width, hasHeader ? undefined : targetColumns),
      rows: dataRows,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
