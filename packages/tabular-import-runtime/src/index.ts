import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type {
  DatabaseKind,
  ImportColumnDescriptor,
  ImportColumnOptions,
  ProgressCallback,
} from '@justybase/contracts';
import { tryNormalizeDatabaseKind } from '@justybase/contracts';
import { applyGeneratedIdentifierCase } from '@justybase/dialect-utils';
import {
  detectImportDecimalDelimiter,
  headerForcesTextImportType,
  ColumnTypeChooser,
} from '@justybase/database-utils';
import {
  DelimitedRecordParser,
  detectDelimitedTextDelimiter,
} from '@justybase/database-utils/delimitedRecordParser';

export type {
  ImportColumnDescriptor,
  ImportColumnOptions,
  ImportResult,
  ImportResultDetails,
  ProgressCallback,
  SnowflakeWorkflowDetails,
} from '@justybase/contracts';

export interface TabularDataImporterOptions {
  kind?: string | DatabaseKind;
  inferBoolean?: boolean;
  /**
   * Whether the first delimited record is a header row. Defaults to true,
   * matching the desktop importer's historical behavior.
   */
  hasHeaders?: boolean;
}

interface ExcelReader {
  open(filePath: string): Promise<void>;
  read(): Promise<boolean> | boolean;
  close(): Promise<void>;
  _currentRow?: unknown[];
  fieldCount?: number;
  getValue?: (columnIndex: number) => unknown;
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
} catch (error) {
  readerFactory = undefined;
  console.warn(
    'Excel support is unavailable because @justybase/spreadsheet-tasks could not be loaded.',
    error instanceof Error ? error.message : error,
  );
}

const FORCED_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_ ]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?$/;
const DECIMAL_SAMPLE_ROW_LIMIT = 100;
const FIRST_LINE_READ_CHUNK_SIZE = 64 * 1024;

function readDetectionPrefix(filePath: string, maxBytes = 2 * 1024 * 1024): string {
  const descriptor = fs.openSync(filePath, 'r');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    // Read whole chunks until a record boundary appears so a first record
    // wider than one chunk is still available to delimiter detection.
    while (total < maxBytes) {
      const buffer = Buffer.allocUnsafe(FIRST_LINE_READ_CHUNK_SIZE);
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      total += bytesRead;
      const text = Buffer.concat(chunks, total).toString('utf8');
      if (/[\r\n]/.test(text)) break;
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

async function* readCsvFileRecords(filePath: string, delimiter: string): AsyncGenerator<string[]> {
  const parser = new DelimitedRecordParser(delimiter);
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  let firstChunk = true;
  try {
    for await (const rawChunk of stream) {
      let chunk = String(rawChunk);
      if (firstChunk) {
        firstChunk = false;
        chunk = chunk.replace(/^\ufeff/, '');
      }
      for (const record of parser.push(chunk)) {
        yield record;
      }
    }
    for (const record of parser.push('', true)) {
      yield record;
    }
  } finally {
    stream.destroy();
  }
}

function normalizeKind(kind?: string | DatabaseKind): DatabaseKind | undefined {
  if (kind === undefined || kind.trim().length === 0) return undefined;
  const normalizedKind = tryNormalizeDatabaseKind(kind);
  if (!normalizedKind) {
    throw new Error(`Unsupported database kind '${kind}'.`);
  }
  return normalizedKind;
}

function sanitizeHeaderToken(value: string): string {
  return value.trim().replace(/[^0-9A-Za-z_$]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizeHeader(header: string, kind?: DatabaseKind): string {
  let value = sanitizeHeaderToken(header);
  if (!value) value = 'COL_EMPTY';
  if (/^\d/.test(value)) value = `COL_${value}`;
  else if (value.startsWith('_')) value = `COL${value}`;
  return applyGeneratedIdentifierCase(value, kind);
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

function detectDelimiter(prefix: string): string {
  return detectDelimitedTextDelimiter(prefix, [';', '\t', '|', ','], ',');
}

function valueToString(value: unknown): string {
  if (value && typeof value === 'object' && 'value' in value && 'format' in value) {
    value = (value as { value: unknown }).value;
  }
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const pad = (number: number) => number < 10 ? `0${number}` : String(number);
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
  }
  return String(value);
}

function inferExcelHeader(row: readonly unknown[]): boolean {
  const hasContent = row.some(value => valueToString(value).trim().length > 0);
  if (!hasContent) return false;

  return !row.some(value => {
    const rawValue = value && typeof value === 'object' && 'value' in value && 'format' in value
      ? (value as { value: unknown }).value
      : value;
    if (typeof rawValue === 'number' || typeof rawValue === 'bigint' || typeof rawValue === 'boolean' || rawValue instanceof Date) {
      return true;
    }
    return /^[-+]?\d+(?:[.,]\d+)?$/.test(valueToString(rawValue).trim());
  });
}

export class TabularDataImporter {
  private readonly filePath: string;
  private readonly kind?: DatabaseKind;
  private readonly inferBoolean: boolean;
  private readonly hasHeaders?: boolean;
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

  public constructor(filePath: string, options?: TabularDataImporterOptions);
  /** @deprecated Pass options as the second argument. The target table is no longer used by this runtime. */
  public constructor(filePath: string, targetTable: string, options?: TabularDataImporterOptions);
  public constructor(
    filePath: string,
    optionsOrTargetTable?: TabularDataImporterOptions | string,
    legacyOptions?: TabularDataImporterOptions,
  ) {
    const options = typeof optionsOrTargetTable === 'string' ? legacyOptions : optionsOrTargetTable;
    this.filePath = filePath;
    this.kind = normalizeKind(options?.kind);
    this.inferBoolean = options?.inferBoolean === true;
    this.hasHeaders = options?.hasHeaders;
    this.isExcelFile = ['.xlsx', '.xlsb'].includes(path.extname(filePath).toLowerCase());
    this.csvDelimiter = this.isExcelFile
      ? ','
      : detectDelimiter(readDetectionPrefix(filePath));
  }

  private setHeaders(headers: readonly string[]): void {
    this.sourceHeaders = headers.map((header, index) => header.trim() || `COLUMN_${index + 1}`);
    this.normalizedHeaders = normalizeAndDeduplicateHeaders(this.sourceHeaders, this.kind);
  }

  private getCurrentExcelRow(reader: ExcelReader): unknown[] {
    const fieldCount = reader.fieldCount;
    if (Array.isArray(reader._currentRow) && reader._currentRow.length > 0) return [...reader._currentRow];
    if (reader.getValue && typeof fieldCount === 'number' && Number.isInteger(fieldCount) && fieldCount > 0) {
      return Array.from({ length: fieldCount }, (_unused, index) => reader.getValue!(index));
    }
    if (Array.isArray(reader._currentRow)) return [...reader._currentRow];
    return [];
  }

  private async prepareExcelReader(reader: ExcelReader): Promise<void> {
    this.availableSheetNames = reader.getSheetNames ? [...reader.getSheetNames()] : [];
    if (!this.selectedSheetName || this.availableSheetNames.length === 0) {
      return;
    }

    const index = this.availableSheetNames.indexOf(this.selectedSheetName);
    if (index < 0) {
      throw new Error(
        `Worksheet "${this.selectedSheetName}" was not found in "${path.basename(this.filePath)}". ` +
          `Available worksheets: ${this.availableSheetNames.join(', ')}.`,
      );
    }

    reader._currentSheetIndex = index;
    if (reader._initSheet) {
      await reader._initSheet(index);
    }
  }

  private async openExcelRows(): Promise<string[][]> {
    if (!readerFactory) throw new Error('ReaderFactory module not available');
    const reader = readerFactory.create(this.filePath);
    const rows: string[][] = [];
    try {
      await reader.open(this.filePath);
      await this.prepareExcelReader(reader);
      while (await reader.read()) {
        const current = this.getCurrentExcelRow(reader);
        rows.push(current.map(valueToString));
      }
      return rows;
    } finally {
      await reader.close().catch(() => undefined);
    }
  }

  private async readExcelSampleRows(limit: number): Promise<string[][]> {
    if (!readerFactory) throw new Error('ReaderFactory module not available');
    const reader = readerFactory.create(this.filePath);
    const rows: string[][] = [];
    try {
      await reader.open(this.filePath);
      await this.prepareExcelReader(reader);
      let rowIndex = 0;
      while (rows.length < limit && await reader.read()) {
        const rawRow = this.getCurrentExcelRow(reader);
        const current = rawRow.map(valueToString);
        if (rowIndex === 0) {
          this.excelHasHeaderRow = inferExcelHeader(rawRow);
          if (this.excelHasHeaderRow) {
            this.setHeaders(current);
          } else {
            this.setHeaders(Array.from({ length: current.length }, (_unused, index) => `COL_${index + 1}`));
          }
          rowIndex += 1;
          if (this.excelHasHeaderRow) continue;
        }
        rowIndex += 1;
        if (!this.excelHasHeaderRow && current.length > this.sourceHeaders.length) {
          const previousWidth = this.sourceHeaders.length;
          this.setHeaders([
            ...this.sourceHeaders,
            ...Array.from({ length: current.length - previousWidth }, (_unused, index) => `COL_${previousWidth + index + 1}`),
          ]);
        }
        rows.push(current);
      }
      return rows;
    } finally {
      await reader.close().catch(() => undefined);
    }
  }

  private async readCsvRows(): Promise<string[][]> {
    const rows: string[][] = [];
    for await (const record of readCsvFileRecords(this.filePath, this.csvDelimiter)) {
      rows.push(record);
    }
    return rows;
  }

  private async readCsvSampleRows(limit: number): Promise<string[][]> {
    const rows: string[][] = [];
    let headerSkipped = false;
    for await (const record of readCsvFileRecords(this.filePath, this.csvDelimiter)) {
      if (!headerSkipped) {
        headerSkipped = true;
        if (this.hasHeaders !== false) {
          continue;
        }
      }
      rows.push(record);
      if (rows.length >= limit) break;
    }
    return rows;
  }

  private async analyzeCsvDataTypes(progressCallback?: ProgressCallback): Promise<ColumnTypeChooser[]> {
    let headerProcessed = false;
    let dataRowsCount = 0;
    let dataTypes: ColumnTypeChooser[] | undefined;
    const pendingRows: string[][] = [];
    const decimalSampleCells: string[] = [];

    const initializeDataTypes = (): void => {
      if (dataTypes || !headerProcessed) return;
      this.decimalSeparator = detectImportDecimalDelimiter(decimalSampleCells);
      dataTypes = this.sourceHeaders.map(header => new ColumnTypeChooser(this.decimalSeparator, {
        forceText: headerForcesTextImportType(header),
        inferBoolean: this.inferBoolean,
      }));
      for (const pendingRow of pendingRows) {
        this.applyRowToTypeInference(pendingRow, dataTypes);
      }
      pendingRows.length = 0;
    };

    const processDataRow = (row: string[]): void => {
      dataRowsCount += 1;
      if (dataRowsCount <= DECIMAL_SAMPLE_ROW_LIMIT) {
        for (const value of row) {
          if (value.trim()) decimalSampleCells.push(value);
        }
      }

      if (!dataTypes) {
        pendingRows.push(row);
        if (pendingRows.length >= DECIMAL_SAMPLE_ROW_LIMIT) initializeDataTypes();
        return;
      }
      this.applyRowToTypeInference(row, dataTypes);
    };

    for await (const record of readCsvFileRecords(this.filePath, this.csvDelimiter)) {
      if (!headerProcessed) {
        if (this.hasHeaders === false) {
          this.setHeaders(Array.from({ length: record.length }, (_unused, index) => `COL_${index + 1}`));
          headerProcessed = true;
          processDataRow(record);
          continue;
        }
        this.setHeaders(record);
        headerProcessed = true;
        continue;
      }

      processDataRow(record);
      if (dataRowsCount % 10000 === 0) {
        progressCallback?.(`Analyzed ${dataRowsCount.toLocaleString()} rows...`, undefined, false);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }

    if (!headerProcessed) throw new Error('No data found in file');
    initializeDataTypes();
    this.dataTypes = dataTypes ?? [];
    this.rowsCount = dataRowsCount;
    progressCallback?.(`Analysis complete: ${this.rowsCount.toLocaleString()} rows`);
    return this.dataTypes;
  }

  private applyRowToTypeInference(row: readonly string[], dataTypes: readonly ColumnTypeChooser[]): void {
    for (let index = 0; index < Math.min(row.length, dataTypes.length); index += 1) {
      const value = row[index]?.trim();
      if (value) dataTypes[index].refreshCurrentType(value);
    }
  }

  private async analyzeExcelDataTypes(progressCallback?: ProgressCallback): Promise<ColumnTypeChooser[]> {
    if (!readerFactory) throw new Error('ReaderFactory module not available');
    const reader = readerFactory.create(this.filePath);
    let firstRawRow: unknown[] | undefined;
    let firstTextRow: string[] | undefined;
    let firstRowHandled = false;
    let dataRowsCount = 0;
    let dataTypes: ColumnTypeChooser[] | undefined;
    const pendingRows: string[][] = [];
    const decimalSampleCells: string[] = [];

    const initializeDataTypes = (): void => {
      if (dataTypes || !firstRowHandled) return;
      this.decimalSeparator = detectImportDecimalDelimiter(decimalSampleCells);
      dataTypes = this.sourceHeaders.map(header => new ColumnTypeChooser(this.decimalSeparator, {
        forceText: headerForcesTextImportType(header),
        inferBoolean: this.inferBoolean,
      }));
      for (const pendingRow of pendingRows) {
        this.applyRowToTypeInference(pendingRow, dataTypes);
      }
      pendingRows.length = 0;
    };

    const processDataRow = (row: string[]): void => {
      dataRowsCount += 1;
      if (dataRowsCount <= DECIMAL_SAMPLE_ROW_LIMIT) {
        for (const value of row) {
          if (value.trim()) decimalSampleCells.push(value);
        }
      }

      if (!dataTypes) {
        pendingRows.push(row);
        if (pendingRows.length >= DECIMAL_SAMPLE_ROW_LIMIT) initializeDataTypes();
        return;
      }
      this.applyRowToTypeInference(row, dataTypes);
    };

    const ensureHeaderWidth = (width: number): void => {
      if (this.excelHasHeaderRow || width <= this.sourceHeaders.length) return;
      const previousWidth = this.sourceHeaders.length;
      this.setHeaders([
        ...this.sourceHeaders,
        ...Array.from({ length: width - previousWidth }, (_unused, index) => `COL_${previousWidth + index + 1}`),
      ]);
      if (dataTypes) {
        for (let index = previousWidth; index < width; index += 1) {
          dataTypes.push(new ColumnTypeChooser(this.decimalSeparator, {
            forceText: headerForcesTextImportType(this.sourceHeaders[index]!),
            inferBoolean: this.inferBoolean,
          }));
        }
      }
    };

    const handleFirstRows = (rawRow: unknown[], textRow: string[], nextTextRow?: string[]): void => {
      this.excelHasHeaderRow = inferExcelHeader(rawRow);
      if (this.excelHasHeaderRow) {
        this.setHeaders(textRow);
      } else {
        const width = Math.max(rawRow.length, nextTextRow?.length ?? 0);
        this.setHeaders(Array.from({ length: width }, (_unused, index) => `COL_${index + 1}`));
        processDataRow(textRow);
      }
      firstRowHandled = true;
    };

    try {
      await reader.open(this.filePath);
      await this.prepareExcelReader(reader);

      while (await reader.read()) {
        const rawRow = this.getCurrentExcelRow(reader);
        const textRow = rawRow.map(valueToString);
        if (!firstRawRow) {
          firstRawRow = rawRow;
          firstTextRow = textRow;
          continue;
        }

        if (!firstRowHandled) handleFirstRows(firstRawRow, firstTextRow ?? [], textRow);
        ensureHeaderWidth(textRow.length);
        processDataRow(textRow);
        if (dataRowsCount > 0 && dataRowsCount % 10000 === 0) {
          progressCallback?.(`Analyzed ${dataRowsCount.toLocaleString()} rows...`, undefined, false);
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }

      if (firstRawRow && !firstRowHandled) handleFirstRows(firstRawRow, firstTextRow ?? []);
      if (!firstRawRow) throw new Error('No data found in file');

      initializeDataTypes();
      this.dataTypes = dataTypes ?? [];
      this.rowsCount = dataRowsCount;
      progressCallback?.(`Analysis complete: ${this.rowsCount.toLocaleString()} rows`);
      return this.dataTypes;
    } finally {
      await reader.close().catch(() => undefined);
    }
  }

  public async analyzeDataTypes(progressCallback?: ProgressCallback): Promise<ColumnTypeChooser[]> {
    progressCallback?.('Analyzing data types...');
    return this.isExcelFile
      ? this.analyzeExcelDataTypes(progressCallback)
      : this.analyzeCsvDataTypes(progressCallback);
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
    return this.getEffectiveColumnDescriptors().map(descriptor => ({
      sourceColumn: this.sourceHeaders[descriptor.sourceIndex]
        || this.normalizedHeaders[descriptor.sourceIndex]
        || `COLUMN_${descriptor.sourceIndex + 1}`,
      targetColumn: descriptor.columnName,
      dataType: descriptor.dataType,
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
    const reader = readerFactory.create(this.filePath);
    try {
      await reader.open(this.filePath);
      this.availableSheetNames = reader.getSheetNames ? [...reader.getSheetNames()] : [];
      return [...this.availableSheetNames];
    } finally {
      await reader.close().catch(() => undefined);
    }
  }

  public setSelectedSheet(sheetName?: string): void {
    if (this.isExcelFile) {
      this.selectedSheetName = sheetName?.trim() || undefined;
      this.sourceHeaders = [];
      this.normalizedHeaders = [];
      this.dataTypes = [];
      this.rowsCount = 0;
      this.decimalSeparator = '.';
      this.excelHasHeaderRow = true;
      this.selectedColumnIndexes = [];
      this.forcedColumnTypes.clear();
      this.columnNameOverrides.clear();
    }
  }

  public async getSampleRows(limit = 5): Promise<string[][]> {
    const sampleLimit = Math.max(1, Math.min(limit, 50000));
    return this.isExcelFile
      ? this.readExcelSampleRows(sampleLimit)
      : this.readCsvSampleRows(sampleLimit);
  }

  public async getAllRows(): Promise<string[][]> {
    const rows = this.isExcelFile ? await this.openExcelRows() : await this.readCsvRows();
    const start = this.isExcelFile
      ? (this.excelHasHeaderRow ? 1 : 0)
      : (this.hasHeaders === false ? 0 : 1);
    const dataRows = rows.slice(start);
    this.rowsCount = dataRows.length;
    return dataRows;
  }
}

export function createTabularDataImporter(
  filePath: string,
  options?: TabularDataImporterOptions,
): TabularDataImporter;
/** @deprecated Pass options as the second argument. The target table is no longer used by this runtime. */
export function createTabularDataImporter(
  filePath: string,
  targetTable: string,
  options?: TabularDataImporterOptions,
): TabularDataImporter;
export function createTabularDataImporter(
  filePath: string,
  optionsOrTargetTable?: TabularDataImporterOptions | string,
  legacyOptions?: TabularDataImporterOptions,
): TabularDataImporter {
  return typeof optionsOrTargetTable === 'string'
    ? new TabularDataImporter(filePath, optionsOrTargetTable, legacyOptions)
    : new TabularDataImporter(filePath, optionsOrTargetTable);
}
