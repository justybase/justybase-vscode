import { createGzip, createZstdCompress } from 'node:zlib';
import { createReadStream, mkdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import type { QueryColumn, QueryExportFormat, QueryExportRequest } from '@justybase/contracts';
import { QuerySessionManager } from './querySessions';

export interface QueryExportStream {
  stream: Readable;
  contentType: string;
  extension: string;
}

interface SpreadsheetWriter {
  startSheet(name: string, columnCount: number, headers?: string[], options?: { doAutofilter?: boolean }): void;
  writeRow(row: unknown[]): void;
  endSheet(): void;
  finalize(): Promise<void>;
}

function jsonValue(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function csvValue(value: unknown): string {
  const valueText = textValue(value);
  return /[",\r\n]/.test(valueText) ? `"${valueText.replace(/"/g, '""')}"` : valueText;
}

function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${textValue(value).replace(/'/g, "''")}'`;
}

function xmlValue(value: unknown): string {
  return textValue(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function markdownValue(value: unknown): string {
  return textValue(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function columnNames(columns: QueryColumn[]): string[] {
  return columns.map(column => column.name);
}

function uniqueJsonNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name, index) => {
    const base = name || `column_${index + 1}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) { candidate = `${base}_${suffix}`; suffix += 1; }
    used.add(candidate);
    return candidate;
  });
}

function safeTag(name: string, index: number): string {
  const tag = name.replace(/[^A-Za-z0-9_-]/g, '_');
  return /^[A-Za-z_]/.test(tag) ? tag : `column_${index + 1}`;
}

function safeFormat(format: QueryExportFormat): QueryExportFormat {
  const formats: QueryExportFormat[] = ['csv', 'csv.gz', 'csv.zst', 'json', 'xml', 'sql', 'markdown', 'xlsx', 'xlsb'];
  if (!formats.includes(format)) throw new Error('Unsupported query export format.');
  return format;
}

function extensionFor(format: QueryExportFormat): string {
  return format === 'csv.gz' ? 'csv.gz' : format === 'csv.zst' ? 'csv.zst' : format;
}

/** Creates a response stream over a disk-backed query result. */
export function createQueryExportStream(manager: QuerySessionManager, userId: string, sessionId: string, input: QueryExportRequest): QueryExportStream {
  const format = safeFormat(input.format);
  const columns = manager.columns(userId, sessionId);
  const names = columnNames(columns);
  const jsonNames = uniqueJsonNames(names);
  if (format === 'xlsx') return createXlsxLikeStream(manager, userId, sessionId, input, names, 'xlsx');
  if (format === 'xlsb') return createXlsxLikeStream(manager, userId, sessionId, input, names, 'xlsb');

  async function* generate(): AsyncGenerator<string> {
    if (format === 'csv' || format === 'csv.gz' || format === 'csv.zst') yield `${names.map(csvValue).join(',')}\n`;
    if (format === 'json') yield '[\n';
    if (format === 'xml') yield '<?xml version="1.0" encoding="UTF-8"?>\n<results>\n';
    if (format === 'markdown') {
      yield `| ${names.map(markdownValue).join(' | ')} |\n`;
      yield `| ${names.map(() => '---').join(' | ')} |\n`;
    }
    let rowNumber = 0;
    for await (const rows of manager.streamRows(userId, sessionId, input)) {
      for (const values of rows) {
        if (format === 'csv' || format === 'csv.gz' || format === 'csv.zst') {
          yield `${values.map(csvValue).join(',')}\n`;
        } else if (format === 'json') {
          const record: Record<string, unknown> = {};
          jsonNames.forEach((name, index) => { record[name] = values[index]; });
          yield `${rowNumber === 0 ? '' : ',\n'}  ${jsonValue(record)}`;
        } else if (format === 'xml') {
          yield '  <row>\n';
          for (let index = 0; index < names.length; index += 1) {
            const tag = safeTag(names[index] ?? '', index);
            yield `    <${tag}>${xmlValue(values[index])}</${tag}>\n`;
          }
          yield '  </row>\n';
        } else if (format === 'sql') {
          const quotedNames = names.map(name => `"${name.replace(/"/g, '""')}"`).join(', ');
          yield `INSERT INTO EXPORT_TABLE (${quotedNames}) VALUES (${values.map(sqlValue).join(', ')});\n`;
        } else if (format === 'markdown') {
          yield `| ${values.map(markdownValue).join(' | ')} |\n`;
        }
        rowNumber += 1;
      }
    }
    if (format === 'json') yield '\n]\n';
    if (format === 'xml') yield '</results>\n';
  }

  const source = Readable.from(generate());
  if (format === 'csv.gz') return { stream: source.pipe(createGzip()), contentType: 'application/gzip', extension: extensionFor(format) };
  if (format === 'csv.zst') {
    if (typeof createZstdCompress !== 'function') throw new Error('Zstandard compression is not supported by this Node.js runtime.');
    return { stream: source.pipe(createZstdCompress()), contentType: 'application/zstd', extension: extensionFor(format) };
  }
  return { stream: source, contentType: format === 'csv' ? 'text/csv; charset=utf-8' : format === 'json' ? 'application/json; charset=utf-8' : format === 'xml' ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8', extension: extensionFor(format) };
}

/** Create a streamed XLSX or XLSB export using @justybase/spreadsheet-tasks. XLSB is ~3x faster. */
function createXlsxLikeStream(manager: QuerySessionManager, userId: string, sessionId: string, input: QueryExportRequest, names: string[], kind: 'xlsx' | 'xlsb'): QueryExportStream {
  const ext = kind === 'xlsb' ? 'xlsb' : 'xlsx';
  async function* create(): AsyncGenerator<Buffer> {
    const exportDirectory = process.env.JUSTYBASE_WEB_EXPORT_DIR ?? '/tmp';
    mkdirSync(exportDirectory, { recursive: true });
    const filePath = path.join(exportDirectory, `justybase-export-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
    const spreadsheetTasks = require('@justybase/spreadsheet-tasks') as {
      XlsxWriter: new (path: string) => SpreadsheetWriter;
      XlsbWriter: new (path: string) => SpreadsheetWriter;
    };
    const WriterClass = kind === 'xlsb' ? spreadsheetTasks.XlsbWriter : spreadsheetTasks.XlsxWriter;
    const writer = new WriterClass(filePath);
    try {
      writer.startSheet('Query Results', names.length, names, { doAutofilter: true });
      for await (const rows of manager.streamRows(userId, sessionId, input)) for (const row of rows) writer.writeRow(row);
      writer.endSheet();
      await writer.finalize();
      for await (const chunk of createReadStream(filePath)) yield chunk as Buffer;
    } finally {
      await import('node:fs/promises').then(fs => fs.rm(filePath, { force: true }));
    }
  }
  const contentType = kind === 'xlsb'
    ? 'application/vnd.ms-excel.binarysheet'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return { stream: Readable.from(create()), contentType, extension: ext };
}
