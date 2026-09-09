import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { DatabaseKind } from '@justybase/contracts';
import { normalizeDatabaseKind } from '@justybase/contracts';
import { headerForcesTextImportType, ColumnTypeChooser } from '@justybase/database-utils';

export interface ImportColumnOptions {
  selectedColumnIndexes?: number[];
  forcedColumnTypes?: Record<number, string>;
  columnNameOverrides?: Record<number, string>;
  appendToExistingTable?: boolean;
}

export interface ImportColumnDescriptor {
  sourceIndex: number;
  columnName: string;
  dataType: string;
}

export type ProgressCallback = (
  message: string,
  increment?: number,
  logToOutput?: boolean,
) => void;

export interface SnowflakeWorkflowDetails {
  workflowMarkdown: string;
  createTableSql?: string;
  copyIntoSql?: string;
  warnings?: string[];
  nextSteps?: string[];
  stageName?: string;
  stagePath?: string;
  sourceFormat?: string;
}

export interface ImportResultDetails {
  sourceFile?: string;
  targetTable?: string;
  fileSize?: number;
  format?: string;
  rowsProcessed?: number;
  rowsInserted?: number;
  processingTime?: string;
  columns?: number;
  detectedDelimiter?: string;
  warnings?: string[];
  snowflakeWorkflow?: SnowflakeWorkflowDetails;
}

export interface ImportResult<TDetails extends ImportResultDetails = ImportResultDetails> {
  success: boolean;
  message: string;
  details?: TDetails;
}

export interface TabularDataImporterOptions {
  kind?: string | DatabaseKind;
  inferBoolean?: boolean;
}

interface ExcelReader {
  open(filePath: string): Promise<void>;
  read(): Promise<boolean> | boolean;
  close(): Promise<void>;
  _currentRow: unknown[];
  getSheetNames?(): string[];
  _currentSheetIndex?: number;
  _initSheet?: (index: number) => Promise<void> | boolean | void;
}

interface ExcelReaderFactory {
  create(filePath: string): ExcelReader;
}

let readerFactory: ExcelReaderFactory | undefined;
try {
  const loaded = createRequire(__filename)('@justybase/spreadsheet-tasks') as { ReaderFactory?: ExcelReaderFactory };
  readerFactory = loaded.ReaderFactory;
} catch {
  readerFactory = undefined;
}

const FORCED_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_ ]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?$/;

function normalizeKind(kind?: string | DatabaseKind): DatabaseKind | undefined {
  return kind ? normalizeDatabaseKind(kind) : undefined;
}

function sanitizeHeaderToken(value: string): string {
  return value.trim().replace(/[^0-9A-Za-z_$]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizeHeader(header: string, kind?: DatabaseKind): string {
  let value = sanitizeHeaderToken(header);
  if (!value) value = 'COL_EMPTY';
  if (/^\d/.test(value)) value = `COL_${value}`;
  else if (value.startsWith('_')) value = `COL${value}`;
  if (kind === 'mysql' || kind === 'sqlite') return value;
  if (kind === 'postgresql' || kind === 'duckdb') return value.toLowerCase();
  return value.toUpperCase();
}

function normalizeAndDeduplicateHeaders(headers: readonly string[], kind?: DatabaseKind): string[] {
  const seen = new Map<string, number>();
  return headers.map(header => {
    const value = normalizeHeader(header, kind);
    const key = value.toUpperCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0 ? value : `${value}_${count}`;
  });
}

function normalizeDataType(typeName: string): string {
  return typeName.trim().replace(/\s+/g, ' ').toUpperCase();
}

function validateForcedType(typeName: string): string {
  const normalized = normalizeDataType(typeName);
  if (!FORCED_TYPE_PATTERN.test(normalized)) {
    throw new Error(`Invalid forced data type: ${typeName}`);
  }
  return normalized;
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (character === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  result.push(current);
  return result;
}

function detectDelimiter(firstLine: string): string {
  const delimiters = [';', '\t', '|', ','];
  const counts = delimiters.map(delimiter => ({
    delimiter,
    count: firstLine.split(delimiter).length - 1,
  }));
  const best = counts.reduce((current, candidate) => candidate.count > current.count ? candidate : current);
  return best.count > 0 ? best.delimiter : ',';
}

function valueToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const pad = (number: number) => number < 10 ? `0${number}` : String(number);
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
  }
  return String(value);
}

function inferExcelHeader(row: readonly unknown[]): boolean {
  const values = row.map(valueToString);
  return values.some(value => value.trim().length > 0)
    && !values.some(value => /^[-+]?\d+(?:[.,]\d+)?$/.test(value.trim()));
}

function decimalDelimiter(rows: readonly string[][]): string {
  let dots = 0;
  let commas = 0;
  for (const row of rows.slice(0, 100)) {
    for (const value of row) {
      const normalized = value.trim();
      if (/^\d+\.\d+$/.test(normalized)) dots += 1;
      if (/^\d+,\d+$/.test(normalized)) commas += 1;
    }
  }
  return commas > dots && commas > 0 ? ',' : '.';
}

export class TabularDataImporter {
  private readonly filePath: string;
  private readonly kind?: DatabaseKind;
  private readonly inferBoolean: boolean;
  private readonly isExcelFile: boolean;
  private csvDelimiter: string;
  private decimalSeparator = '.';
  private sourceHeaders: string[] = [];
  private normalizedHeaders: string[] = [];
  private dataTypes: ColumnTypeChooser[] = [];
  private rowsCount = 0;
  private availableSheetNames: string[] = [];
  private selectedSheetName?: string;
  private excelHasHeaderRow = true;
  private selectedColumnIndexes: number[] = [];
  private forcedColumnTypes = new Map<number, string>();
  private columnNameOverrides = new Map<number, string>();

  public constructor(filePath: string, targetTable: string, options?: TabularDataImporterOptions) {
    this.filePath = filePath;
    void targetTable;
    this.kind = normalizeKind(options?.kind);
    this.inferBoolean = options?.inferBoolean === true;
    this.isExcelFile = ['.xlsx', '.xlsb'].includes(path.extname(filePath).toLowerCase());
    const firstLine = fs.readFileSync(filePath, 'utf8').split(/\r?\n/, 1)[0]?.replace(/^\ufeff/, '') ?? '';
    this.csvDelimiter = detectDelimiter(firstLine);
  }

  private setHeaders(headers: readonly string[]): void {
    this.sourceHeaders = headers.map((header, index) => header.trim() || `COLUMN_${index + 1}`);
    this.normalizedHeaders = normalizeAndDeduplicateHeaders(this.sourceHeaders, this.kind);
  }

  private async openExcelRows(): Promise<string[][]> {
    if (!readerFactory) throw new Error('ReaderFactory module not available');
    const reader = readerFactory.create(this.filePath);
    const rows: string[][] = [];
    try {
      await reader.open(this.filePath);
      this.availableSheetNames = reader.getSheetNames ? [...reader.getSheetNames()] : [];
      if (this.selectedSheetName && this.availableSheetNames.length > 0 && reader._initSheet) {
        const index = this.availableSheetNames.indexOf(this.selectedSheetName);
        if (index >= 0) {
          reader._currentSheetIndex = index;
          await reader._initSheet(index);
        }
      }
      while (await reader.read()) {
        const current = Array.isArray(reader._currentRow) ? reader._currentRow : [];
        rows.push(current.map(valueToString));
      }
      return rows;
    } finally {
      await reader.close().catch(() => undefined);
    }
  }

  private readCsvRows(): string[][] {
    const content = fs.readFileSync(this.filePath, 'utf8').replace(/^\ufeff/, '');
    return content.split(/\r?\n/).filter(line => line.trim().length > 0).map(line => parseCsvLine(line, this.csvDelimiter));
  }

  public async analyzeDataTypes(progressCallback?: ProgressCallback): Promise<ColumnTypeChooser[]> {
    progressCallback?.('Analyzing data types...');
    const rows = this.isExcelFile ? await this.openExcelRows() : this.readCsvRows();
    if (rows.length === 0) throw new Error('No data found in file');

    let dataRows: string[][];
    if (this.isExcelFile) {
      this.excelHasHeaderRow = inferExcelHeader(rows[0]);
      if (this.excelHasHeaderRow) {
        this.setHeaders(rows[0]);
        dataRows = rows.slice(1);
      } else {
        this.excelHasHeaderRow = false;
        const width = Math.max(...rows.map(row => row.length));
        this.setHeaders(Array.from({ length: width }, (_unused, index) => `COL_${index + 1}`));
        dataRows = rows;
      }
    } else {
      this.setHeaders(rows[0]);
      dataRows = rows.slice(1);
    }

    this.decimalSeparator = decimalDelimiter(dataRows);
    this.dataTypes = this.sourceHeaders.map(header => new ColumnTypeChooser(this.decimalSeparator, {
      forceText: headerForcesTextImportType(header),
      inferBoolean: this.inferBoolean,
    }));
    for (const row of dataRows) {
      for (let index = 0; index < Math.min(row.length, this.dataTypes.length); index += 1) {
        const value = row[index]?.trim();
        if (value) this.dataTypes[index].refreshCurrentType(value);
      }
    }
    this.rowsCount = dataRows.length;
    progressCallback?.(`Analysis complete: ${this.rowsCount.toLocaleString()} rows`);
    return this.dataTypes;
  }

  public applyColumnOptions(options?: ImportColumnOptions): void {
    this.selectedColumnIndexes = [];
    this.forcedColumnTypes.clear();
    this.columnNameOverrides.clear();
    if (!options) return;

    const allIndexes = this.normalizedHeaders.map((_header, index) => index);
    const selected = options.selectedColumnIndexes && options.selectedColumnIndexes.length > 0
      ? Array.from(new Set(options.selectedColumnIndexes)).filter(index => Number.isInteger(index) && index >= 0 && index < allIndexes.length)
      : allIndexes;
    if (selected.length === 0) throw new Error('No valid columns selected for import.');
    this.selectedColumnIndexes = selected;

    for (const [rawIndex, rawType] of Object.entries(options.forcedColumnTypes ?? {})) {
      const index = Number(rawIndex);
      if (this.selectedColumnIndexes.includes(index) && rawType.trim()) {
        this.forcedColumnTypes.set(index, validateForcedType(rawType));
      }
    }
    for (const [rawIndex, rawName] of Object.entries(options.columnNameOverrides ?? {})) {
      const index = Number(rawIndex);
      if (this.selectedColumnIndexes.includes(index) && rawName.trim()) {
        const normalized = normalizeHeader(rawName, this.kind);
        if (normalized) this.columnNameOverrides.set(index, normalized);
      }
    }
  }

  public getEffectiveColumnDescriptors(): ImportColumnDescriptor[] {
    const indexes = this.selectedColumnIndexes.length > 0
      ? this.selectedColumnIndexes
      : this.normalizedHeaders.map((_header, index) => index);
    return indexes.map(index => ({
      sourceIndex: index,
      columnName: this.columnNameOverrides.get(index) ?? this.normalizedHeaders[index] ?? `COLUMN_${index + 1}`,
      dataType: this.forcedColumnTypes.get(index) ?? this.dataTypes[index]?.currentType.toString() ?? 'NVARCHAR(255)',
    }));
  }

  public getColumnMappings(): Array<{ sourceColumn: string; targetColumn: string; dataType: string }> {
    return this.normalizedHeaders.map((targetColumn, index) => ({
      sourceColumn: this.sourceHeaders[index] || targetColumn,
      targetColumn,
      dataType: this.dataTypes[index]?.currentType.toString() ?? 'NVARCHAR(255)',
    }));
  }

  public getSourceHeaders(): string[] { return [...this.sourceHeaders]; }
  public getRowsCount(): number { return this.rowsCount; }
  public getDecimalDelimiter(): string { return this.decimalSeparator; }
  public getCsvDelimiter(): string { return this.csvDelimiter; }
  public getSelectedSheet(): string | undefined { return this.selectedSheetName; }

  public async getAvailableSheetNames(): Promise<string[]> {
    if (!this.isExcelFile || !readerFactory) return [];
    if (this.availableSheetNames.length > 0) return [...this.availableSheetNames];
    await this.openExcelRows();
    return [...this.availableSheetNames];
  }

  public setSelectedSheet(sheetName?: string): void {
    if (this.isExcelFile) {
      this.selectedSheetName = sheetName?.trim() || undefined;
      this.sourceHeaders = [];
      this.normalizedHeaders = [];
      this.dataTypes = [];
      this.rowsCount = 0;
    }
  }

  public async getSampleRows(limit = 5): Promise<string[][]> {
    const rows = this.isExcelFile ? await this.openExcelRows() : this.readCsvRows();
    const start = this.isExcelFile ? (this.excelHasHeaderRow ? 1 : 0) : 1;
    return rows.slice(start, start + Math.max(1, Math.min(limit, 50000)));
  }

  public async getAllRows(): Promise<string[][]> {
    const rows = this.isExcelFile ? await this.openExcelRows() : this.readCsvRows();
    const start = this.isExcelFile ? (this.excelHasHeaderRow ? 1 : 0) : 1;
    const dataRows = rows.slice(start);
    this.rowsCount = dataRows.length;
    return dataRows;
  }
}

export function createTabularDataImporter(
  filePath: string,
  targetTable: string,
  options?: TabularDataImporterOptions,
): TabularDataImporter {
  return new TabularDataImporter(filePath, targetTable, options);
}
