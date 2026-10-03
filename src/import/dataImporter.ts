/**
 * Data Importer for Netezza
 * Handles importing data from various file formats to Netezza tables
 * Ported from Python data_importer.py
 */

import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { ConnectionDetails, NzConnection } from "../types";
import { createConnectedDatabaseConnectionFromDetails } from "../core/connectionFactory";
import {
  ColumnTypeChooser,
  type ColumnTypeChooserOptions,
} from "../dialects/netezza/import/typeMapping";
import { headerForcesTextImportType } from "./importTypeInferenceUtils";
import { throwIfImportCancelled, type ImportCancellationCheck } from "./importCancellation";
import { quoteIdentifier } from "../utils/identifierUtils";
import {
  buildNetezzaVirtualImportName,
  destroyNetezzaImportStream,
  registerNetezzaImportStream,
} from "./netezzaVirtualImport";
import type {
  ImportColumnDescriptor,
  ImportColumnOptions,
  ImportResult,
  ProgressCallback,
} from '@justybase/contracts';

// Helper to unblock event loop
const delay = () => new Promise((resolve) => setTimeout(resolve, 0));

class DelimitedRecordParser {
  private field = "";
  private row: string[] = [];
  private recordHasMeaningfulInput = false;
  private inQuotes = false;
  private pendingQuote = false;
  private skipLfAfterCr = false;
  private recordNumber = 0;

  constructor(private readonly delimiter: string) {
    if (delimiter.length !== 1) {
      throw new Error("Delimited import requires a single-character delimiter");
    }
  }

  *push(chunk: string, final = false): Generator<string[], void, unknown> {
    const emitRecord = (): string[] | undefined => {
      this.row.push(this.field);
      const record = this.recordHasMeaningfulInput ? this.row : undefined;
      this.field = "";
      this.row = [];
      this.recordHasMeaningfulInput = false;
      this.recordNumber++;
      return record;
    };

    for (let index = 0; index < chunk.length; index++) {
      const char = chunk[index];

      if (this.skipLfAfterCr) {
        this.skipLfAfterCr = false;
        if (char === "\n") {
          continue;
        }
      }

      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (char === '"') {
          this.field += '"';
          continue;
        }
        this.inQuotes = false;
      }

      if (this.inQuotes) {
        if (char === '"') {
          this.pendingQuote = true;
        } else {
          this.field += char;
        }
        continue;
      }

      if (char === '"') {
        this.recordHasMeaningfulInput = true;
        if (this.field.length === 0) {
          this.inQuotes = true;
        } else {
          this.field += char;
        }
      } else if (char === this.delimiter) {
        if (!/\s/.test(char)) {
          this.recordHasMeaningfulInput = true;
        }
        this.row.push(this.field);
        this.field = "";
      } else if (char === "\r" || char === "\n") {
        const record = emitRecord();
        if (record) {
          yield record;
        }
        this.skipLfAfterCr = char === "\r";
      } else {
        if (!/\s/.test(char)) {
          this.recordHasMeaningfulInput = true;
        }
        this.field += char;
      }
    }

    if (final) {
      if (this.pendingQuote) {
        this.pendingQuote = false;
        this.inQuotes = false;
      }
      if (this.inQuotes) {
        throw new Error(`Unterminated quoted field in record ${this.recordNumber + 1}`);
      }
      if (this.recordHasMeaningfulInput) {
        const record = emitRecord();
        if (record) {
          yield record;
        }
      }
    }
  }
}

export function parseDelimitedRecords(text: string, delimiter: string): string[][] {
  const parser = new DelimitedRecordParser(delimiter);
  return Array.from(parser.push(text.startsWith("\ufeff") ? text.slice(1) : text, true));
}

export function* iterateDelimitedRecords(
  text: string,
  delimiter: string,
  chunkSize = 64 * 1024,
): Generator<string[], void, unknown> {
  if (chunkSize < 1) {
    throw new Error("Delimited import chunk size must be positive");
  }

  const parser = new DelimitedRecordParser(delimiter);
  const source = text.startsWith("\ufeff") ? text.slice(1) : text;
  for (let offset = 0; offset < source.length; offset += chunkSize) {
    yield* parser.push(source.slice(offset, offset + chunkSize));
  }
  yield* parser.push("", true);
}

export function readDelimitedTextPrefix(
  filePath: string,
  maxBytes = 64 * 1024,
): string {
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(maxBytes);
  try {
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.toString("utf-8", 0, bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function* readDelimitedRecords(
  filePath: string,
  delimiter: string,
  onReadProgress?: (bytesRead: number, totalBytes: number) => void,
): AsyncGenerator<string[]> {
  const parser = new DelimitedRecordParser(delimiter);
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const totalBytes = fs.statSync(filePath).size;
  let firstChunk = true;

  try {
    for await (const rawChunk of stream) {
      onReadProgress?.(stream.bytesRead, totalBytes);
      let chunk = String(rawChunk);
      if (firstChunk) {
        firstChunk = false;
        if (chunk.startsWith("\ufeff")) {
          chunk = chunk.slice(1);
        }
      }
      for (const record of parser.push(chunk)) {
        yield record;
      }
    }

    for (const record of parser.push("", true)) {
      yield record;
    }
  } finally {
    stream.destroy();
  }
}

export function detectDelimitedTextDelimiter(
  text: string,
  delimiters: readonly string[],
  fallback: string,
): string {
  const countsByRecord = new Map(delimiters.map((delimiter) => [delimiter, [] as number[]]));
  const delimiterSet = new Set(delimiters);
  let inQuotes = false;
  let atFieldStart = true;
  let recordHasContent = false;
  let recordCounts = new Map(delimiters.map((delimiter) => [delimiter, 0]));
  let sampledRecords = 0;
  const source = text.startsWith("\ufeff") ? text.slice(1) : text;
  const sampleRecordLimit = 10;

  const finishRecord = () => {
    if (recordHasContent) {
      for (const delimiter of delimiters) {
        countsByRecord.get(delimiter)?.push(recordCounts.get(delimiter) ?? 0);
      }
      sampledRecords++;
    }
    recordHasContent = false;
    atFieldStart = true;
    recordCounts = new Map(delimiters.map((delimiter) => [delimiter, 0]));
  };

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inQuotes) {
      if (char === '"' && source[index + 1] === '"') {
        index++;
      } else if (char === '"') {
        inQuotes = !inQuotes;
      }
    } else if (char === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
    } else {
      if (char === "\r" || char === "\n") {
        finishRecord();
        if (sampledRecords >= sampleRecordLimit) {
          break;
        }
      } else if (delimiterSet.has(char)) {
        recordCounts.set(char, (recordCounts.get(char) ?? 0) + 1);
        recordHasContent = true;
        atFieldStart = true;
      } else {
        if (!/\s/.test(char)) {
          recordHasContent = true;
        }
        atFieldStart = false;
      }
    }
  }

  if (sampledRecords < sampleRecordLimit) {
    finishRecord();
  }

  let detected = fallback;
  let maxConsistentCount = 0;
  let hasConsistentDelimiter = false;
  const fallbackCounts = countsByRecord.get(fallback) ?? [];
  const fallbackCount = fallbackCounts[0] ?? 0;
  const hasConsistentFallback = fallbackCount > 0
    && fallbackCounts.every((recordCount) => recordCount === fallbackCount);

  if (hasConsistentFallback) {
    return fallback;
  }

  for (const delimiter of delimiters) {
    if (delimiter === fallback) {
      continue;
    }
    const counts = countsByRecord.get(delimiter) ?? [];
    const count = counts[0] ?? 0;
    const isConsistent = count > 0 && counts.every((recordCount) => recordCount === count);
    if (
      isConsistent
      && (
        !hasConsistentDelimiter
        || count > maxConsistentCount
        || (count === maxConsistentCount && delimiter === fallback)
      )
    ) {
      detected = delimiter;
      maxConsistentCount = count;
      hasConsistentDelimiter = true;
    }
  }
  return detected;
}

// XLSX import for Excel file support
// Custom Excel Reader from ExcelHelpersTs
interface IExcelReader {
  open(path: string): Promise<void>;
  read(): Promise<boolean> | boolean;
  close(): Promise<void>;
  _currentRow: unknown[];
  getSheetNames?(): string[];
  _currentSheetIndex?: number;
  _initSheet?: (index: number) => Promise<void> | boolean | void;
}

interface IReaderFactory {
  create(path: string): IExcelReader;
}

let ReaderFactory: IReaderFactory | undefined;
try {
  const { ReaderFactory: RF } = require("@justybase/spreadsheet-tasks");
  ReaderFactory = RF;
} catch (e: unknown) {
  console.error("libs/ExcelHelpersTs/ReaderFactory module not available", e);
}

// ConnectionDetails is imported from '../types' - no need for parseConnectionString

export {
  ColumnTypeChooser,
  NetezzaDataType,
} from "../dialects/netezza/import/typeMapping";

/**
 * Import options
 */
export interface ImportOptions {
  delimiter?: string;
  encoding?: string;
  skipRows?: number;
  maxErrors?: number;
}

export interface NetezzaImporterOptions extends ColumnTypeChooserOptions {
  hasHeaders?: boolean;
  /** Cooperative cancellation checked while streaming source rows. */
  isCancelled?: ImportCancellationCheck;
}

export type {
  ImportColumnDescriptor,
  ImportColumnOptions,
  ImportResult,
  ProgressCallback,
} from '@justybase/contracts';

export interface NetezzaImportProgressData {
  bytesSent?: number;
  totalSize?: number;
  percentComplete?: number;
}

export interface NetezzaImportProgress {
  percentComplete: number;
  estimatedRows: number;
}

function finitePositiveNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * Resolve import progress for both regular files and virtual streams.
 *
 * The Netezza driver can calculate byte progress for a filesystem stream, but
 * a virtual Readable has no stat-able length and therefore reports a zero
 * total. In that case the importer-owned row counter is the authoritative
 * progress source. If neither source can provide progress, report zero rather
 * than comparing transformed stream bytes with the source file size.
 */
export function resolveNetezzaImportProgress(
  progress: NetezzaImportProgressData,
  totalRows: number,
  streamedRows: number,
): NetezzaImportProgress {
  const safeTotalRows = finitePositiveNumber(totalRows);
  const safeStreamedRows = finitePositiveNumber(streamedRows);
  const driverTotalSize = finitePositiveNumber(progress.totalSize);

  let percentComplete: number;
  if (driverTotalSize > 0) {
    percentComplete = finitePositiveNumber(progress.percentComplete);
  } else if (safeTotalRows > 0 && safeStreamedRows > 0) {
    percentComplete = (safeStreamedRows / safeTotalRows) * 100;
  } else {
    percentComplete = 0;
  }

  const roundedPercent = Math.max(0, Math.min(100, Math.round(percentComplete)));
  const estimatedRows =
    safeTotalRows > 0
      ? Math.min(safeTotalRows, Math.round((roundedPercent / 100) * safeTotalRows))
      : 0;

  return {
    percentComplete: roundedPercent,
    estimatedRows,
  };
}

const FORCED_TYPE_PATTERN =
  /^[A-Za-z][A-Za-z0-9_ ]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?$/;

export function normalizeDataType(typeName: string): string {
  return typeName.trim().replace(/\s+/g, " ").toUpperCase();
}

export function normalizeAndValidateForcedType(typeName: string): string {
  const normalized = normalizeDataType(typeName);
  if (!FORCED_TYPE_PATTERN.test(normalized)) {
    throw new Error(`Invalid forced data type: ${typeName}`);
  }
  return normalized;
}

export function getBaseDataType(typeName: string): string {
  const normalized = normalizeDataType(typeName);
  const parenIndex = normalized.indexOf("(");
  return (
    parenIndex >= 0 ? normalized.slice(0, parenIndex) : normalized
  ).trim();
}

export function getNumericScale(typeName: string): number | null {
  const normalized = normalizeDataType(typeName);
  const match = normalized.match(
    /^(NUMERIC|DECIMAL|NUMBER)\(\s*\d+\s*,\s*(\d+)\s*\)$/,
  );
  if (!match) {
    return null;
  }
  return Number(match[2]);
}

/**
 * Netezza Data Importer class
 *
 * Historical note: its tabular-file parsing and type-inference methods are also reused by other
 * dialects through `createTabularDataImporter(...)` in `src/import/tabularDataImporter.ts`.
 */
export class NetezzaImporter {
  private filePath: string;
  private targetTable: string;
  private logDir: string;

  // Pipe settings
  private virtualFileName: string;
  private delimiter: string = "\t";
  private recordDelim: string = "\n";
  private recordDelimPlain: string = "\\n";
  private escapechar: string = "\\";

  // CSV settings
  private csvDelimiter: string = ",";
  // Actual delimiter to use in external table (can be different from csvDelimiter for parsing)
  private externalDelimiter: string = "\t";

  // Decimal delimiter detection
  private decimalDelimiter: string = ".";

  private isExcelFile: boolean = false;
  private excelHasHeaderRow: boolean = true;
  private hasHeadersOverride?: boolean;
  private readonly isCancelled?: ImportCancellationCheck;
  private availableSheetNames: string[] = [];
  private selectedSheetName?: string;

  // Data analysis
  private sourceHeaders: string[] = [];
  private sqlHeaders: string[] = [];
  private dataTypes: ColumnTypeChooser[] = [];
  private rowsCount: number = 0;
  private streamedRowsCount: number = 0;
  private analysisProgressOffset = 0;
  private valuesToEscape: string[] = [];
  private selectedColumnIndexes: number[] = [];
  private forcedColumnTypes: Map<number, string> = new Map();
  private columnNameOverrides: Map<number, string> = new Map();
  private readonly typeChooserOptions: ColumnTypeChooserOptions;

  constructor(
    filePath: string,
    targetTable: string,
    logDir?: string,
    typeChooserOptions?: NetezzaImporterOptions,
  ) {
    this.filePath = filePath;
    this.targetTable = targetTable;
    this.logDir = logDir || path.join(path.dirname(filePath), "netezza_logs");
    this.typeChooserOptions = typeChooserOptions ?? {};
    this.hasHeadersOverride = typeChooserOptions?.hasHeaders;
    this.isCancelled = typeChooserOptions?.isCancelled;

    // Check if this is an Excel file
    const fileExt = path.extname(filePath).toLowerCase();
    this.isExcelFile = [".xlsx", ".xlsb"].includes(fileExt);

    // Initialize virtual filename
    this.virtualFileName = `virtual_import_${Date.now()}_${Math.floor(Math.random() * 1000)}.txt`;

    // For non-Excel files, detect and set the external delimiter
    if (!this.isExcelFile) {
      this.detectCsvDelimiter();
      this.externalDelimiter = this.csvDelimiter;
    }

    // Values to escape - use the detected delimiter
    this.valuesToEscape = [
      this.escapechar,
      this.recordDelim,
      "\r",
      this.externalDelimiter,
    ];

    // Log dir is still useful for log files from Netezza if any (though mapped through stream now?)
    // Actually, Netezza logs come back as data streams too in the new driver version
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  public updateTargetTable(targetTable: string): void {
    this.targetTable = targetTable;
  }

  public setHasHeaders(hasHeaders: boolean): void {
    this.hasHeadersOverride = hasHeaders;
    this.resetAnalyzedState();
  }

  public getHasHeaders(): boolean {
    return this.isExcelFile
      ? this.excelHasHeaderRow
      : (this.hasHeadersOverride ?? true);
  }

  getDelimiter(): string {
    return this.delimiter;
  }
  /**
   * Get the external delimiter for Netezza import (detected from file)
   */
  getExternalDelimiter(): string {
    return this.externalDelimiter;
  }
  getRecordDelim(): string {
    return this.recordDelim;
  }
  /**
   * Get the escape character for external table
   */
  getEscapeChar(): string {
    return this.escapechar;
  }

  private resetAnalyzedState(): void {
    this.sourceHeaders = [];
    this.sqlHeaders = [];
    this.dataTypes = [];
    this.rowsCount = 0;
    this.streamedRowsCount = 0;
    this.analysisProgressOffset = 0;
    this.excelHasHeaderRow = this.hasHeadersOverride ?? true;
    this.selectedColumnIndexes = [];
    this.forcedColumnTypes.clear();
    this.columnNameOverrides.clear();
  }

  private async selectExcelReaderSheet(reader: IExcelReader): Promise<void> {
    if (!this.selectedSheetName || this.availableSheetNames.length === 0) {
      return;
    }

    const targetIndex = this.availableSheetNames.findIndex(
      (name) => name === this.selectedSheetName,
    );
    if (targetIndex < 0) {
      return;
    }

    reader._currentSheetIndex = targetIndex;
    if (typeof reader._initSheet === "function") {
      await reader._initSheet(targetIndex);
    }
  }

  private normalizeSqlHeaders(headers: readonly string[]): string[] {
    const used = new Set<string>();

    return headers.map((header, index) => {
      const base = this.cleanColumnName(header || `COLUMN_${index + 1}`);
      let candidate = base;
      let suffix = 1;

      while (used.has(candidate.toUpperCase())) {
        candidate = `${base}_${suffix}`;
        suffix += 1;
      }

      used.add(candidate.toUpperCase());
      return candidate;
    });
  }

  private setHeaders(headers: readonly string[]): void {
    this.sourceHeaders = headers.map(
      (header, index) =>
        header.replace(/^[\t ]+|[\t ]+$/g, "") ||
        `COLUMN_${index + 1}`,
    );
    this.sqlHeaders = this.normalizeSqlHeaders(this.sourceHeaders);
  }

  private setGeneratedHeaders(width: number): void {
    this.setHeaders(
      Array.from({ length: width }, (_unused, index) => `COL_${index + 1}`),
    );
  }

  private isLikelyExcelDataValue(value: unknown): boolean {
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
      return true;
    }
    if (value instanceof Date) {
      return true;
    }

    const text = this.excelValueToString(value).trim();
    return /^[-+]?\d+(?:[.,]\d+)?$/.test(text);
  }

  private detectExcelHeaderRow(row: readonly unknown[]): boolean {
    const hasValue = row.some(
      (value) => this.excelValueToString(value).trim().length > 0,
    );
    return hasValue && !row.some((value) => this.isLikelyExcelDataValue(value));
  }

  public setVirtualFileName(fileName: string): void {
    this.virtualFileName = fileName;
  }

  private getAllColumnIndexes(): number[] {
    return this.sqlHeaders.map((_header, index) => index);
  }

  private getEffectiveColumnIndexes(): number[] {
    if (this.selectedColumnIndexes.length > 0) {
      return this.selectedColumnIndexes;
    }
    return this.getAllColumnIndexes();
  }

  private getInferredDataType(columnIndex: number): string {
    return (
      this.dataTypes[columnIndex]?.currentType.toString() || "NVARCHAR(255)"
    );
  }

  private getEffectiveDataType(columnIndex: number): string {
    return (
      this.forcedColumnTypes.get(columnIndex) ||
      this.getInferredDataType(columnIndex)
    );
  }

  private getEffectiveColumnName(columnIndex: number): string {
    return (
      this.columnNameOverrides.get(columnIndex) ||
      this.sqlHeaders[columnIndex] ||
      `COLUMN_${columnIndex + 1}`
    );
  }

  private getImportColumnDescriptors(): Array<{
    sourceIndex: number;
    columnName: string;
    sourceType: string;
    forcedType?: string;
  }> {
    const descriptors: Array<{
      sourceIndex: number;
      columnName: string;
      sourceType: string;
      forcedType?: string;
    }> = [];

    for (const sourceIndex of this.getEffectiveColumnIndexes()) {
      descriptors.push({
        sourceIndex,
        columnName: this.getEffectiveColumnName(sourceIndex),
        sourceType: this.getInferredDataType(sourceIndex),
        forcedType: this.forcedColumnTypes.get(sourceIndex),
      });
    }

    return descriptors;
  }

  private createColumnTypeChoosers(
    headers: readonly string[],
    decimalDelimiter: string,
  ): ColumnTypeChooser[] {
    return headers.map(
      (header) =>
        new ColumnTypeChooser(decimalDelimiter, {
          forceText: headerForcesTextImportType(header),
          ...this.typeChooserOptions,
        }),
    );
  }

  applyColumnOptions(options?: ImportColumnOptions): void {
    this.selectedColumnIndexes = [];
    this.forcedColumnTypes.clear();
    this.columnNameOverrides.clear();

    if (!options) {
      return;
    }

    const allIndexes = this.getAllColumnIndexes();
    let normalizedSelectedIndexes = allIndexes;

    if (
      options.selectedColumnIndexes &&
      options.selectedColumnIndexes.length > 0
    ) {
      normalizedSelectedIndexes = Array.from(
        new Set(options.selectedColumnIndexes),
      ).filter(
        (index) =>
          Number.isInteger(index) &&
          index >= 0 &&
          index < this.sqlHeaders.length,
      );
    }

    if (normalizedSelectedIndexes.length === 0) {
      throw new Error("No valid columns selected for import.");
    }

    this.selectedColumnIndexes = normalizedSelectedIndexes;

    if (options.forcedColumnTypes) {
      for (const [rawIndex, rawType] of Object.entries(
        options.forcedColumnTypes,
      )) {
        const index = Number(rawIndex);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= this.sqlHeaders.length
        ) {
          continue;
        }
        if (!this.selectedColumnIndexes.includes(index)) {
          continue;
        }
        if (!rawType || !rawType.trim()) {
          continue;
        }
        const normalizedType = normalizeAndValidateForcedType(rawType);
        this.forcedColumnTypes.set(index, normalizedType);
      }
    }

    if (!options.columnNameOverrides) {
      return;
    }

    for (const [rawIndex, rawColumnName] of Object.entries(
      options.columnNameOverrides,
    )) {
      const index = Number(rawIndex);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= this.sqlHeaders.length
      ) {
        continue;
      }
      if (!this.selectedColumnIndexes.includes(index)) {
        continue;
      }
      const normalizedColumnName = this.cleanColumnName(rawColumnName || "");
      if (!normalizedColumnName) {
        continue;
      }
      this.columnNameOverrides.set(index, normalizedColumnName);
    }
  }

  getImportColumnCount(): number {
    return this.getEffectiveColumnIndexes().length;
  }

  getEffectiveColumnDescriptors(): ImportColumnDescriptor[] {
    return this.getImportColumnDescriptors().map((column) => ({
      sourceIndex: column.sourceIndex,
      columnName: column.columnName,
      dataType: this.getEffectiveDataType(column.sourceIndex),
    }));
  }

  formatImportRow(row: string[]): string[] {
    return this.getEffectiveColumnIndexes().map((sourceIndex) =>
      this.formatValue(row[sourceIndex] || "", sourceIndex),
    );
  }

  /**
   * Auto-detect CSV delimiter
   */
  private detectCsvDelimiter(): void {
    const content = readDelimitedTextPrefix(this.filePath);
    const fallback = path.extname(this.filePath).toLowerCase() === ".tsv"
      ? "\t"
      : ",";
    this.csvDelimiter = detectDelimitedTextDelimiter(
      content,
      [";", "\t", "|", ","],
      fallback,
    );
  }

  /**
   * Clean column name for SQL compatibility
   */
  private cleanColumnName(colName: string): string {
    const hasTrailingLineBreak = /(?:\r\n|\r|\n)+\s*$/.test(colName);
    let cleanName = String(colName).replace(/\r\n|\r|\n/g, "_").trim();
    cleanName = cleanName
      .replace(/[^0-9a-zA-Z]+/g, "_")
      .toUpperCase();
    if (!hasTrailingLineBreak) {
      cleanName = cleanName.replace(/_+$/g, "");
    }
    if (!cleanName || /^\d/.test(cleanName) || cleanName.startsWith("_")) {
      cleanName = "COL" + (cleanName.startsWith("_") ? "" : "_") + cleanName;
    }
    return cleanName;
  }

  /**
   * Format Excel cell value to string with proper date handling
   */
  private excelValueToString(val: unknown): string {
    if (val === null || val === undefined) return "";
    if (val instanceof Date) {
      const pad = (n: number) => (n < 10 ? "0" + n : n);
      return `${val.getUTCFullYear()}-${pad(val.getUTCMonth() + 1)}-${pad(val.getUTCDate())} ${pad(val.getUTCHours())}:${pad(val.getUTCMinutes())}:${pad(val.getUTCSeconds())}`;
    }
    return String(val);
  }

  /**
   * In Netezza, double quotes are used for case-sensitive or reserved name identifiers
   */
  private quoteIdentifier(name: string): string {
    if (!name) return '""';
    return quoteIdentifier(name);
  }

  /**
   * Read Excel sample rows (streaming, limited to N data rows).
   * Opens the Excel reader, skips a detected header, and collects rows.
   */
  private async readExcelSampleRows(limit: number): Promise<string[][]> {
    if (!ReaderFactory) {
      throw new Error("ReaderFactory module not available");
    }

    const reader = ReaderFactory.create(this.filePath);
    try {
      await reader.open(this.filePath);
      this.availableSheetNames =
        typeof reader.getSheetNames === "function"
          ? [...reader.getSheetNames()]
          : [];
      await this.selectExcelReaderSheet(reader);

      const rows: string[][] = [];
      let headerSkipped = !this.excelHasHeaderRow;

      while ((await reader.read()) && rows.length < limit) {
        if (!headerSkipped) {
          headerSkipped = true;
          continue;
        }

        const currentRow = reader._currentRow;
        const row: string[] = [];
        if (currentRow && Array.isArray(currentRow)) {
          for (let i = 0; i < currentRow.length; i++) {
            row.push(this.excelValueToString(currentRow[i]));
          }
        }
        rows.push(row);
      }

      return rows;
    } finally {
      if (reader && typeof reader.close === "function") {
        try {
          await reader.close();
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }

  /**
   * Read Excel file (xlsx/xlsb) and convert to 2D array
   * Used by getAllRows() for cross-DB importers that need full data;
   * callers should NOT cache the result — rows are materialized per-call.
   */
  private async readExcelFile(
    progressCallback?: ProgressCallback,
  ): Promise<string[][]> {
    if (!ReaderFactory) {
      throw new Error("ReaderFactory module not available");
    }

    progressCallback?.("Reading Excel file...");

    const reader = ReaderFactory.create(this.filePath);
    try {
      await reader.open(this.filePath);
      this.availableSheetNames =
        typeof reader.getSheetNames === "function"
          ? [...reader.getSheetNames()]
          : [];
      await this.selectExcelReaderSheet(reader);

      const rows: string[][] = [];

      let rowCount = 0;
      while (await reader.read()) {
        const row: string[] = [];
        const currentRow = reader._currentRow;
        if (currentRow && Array.isArray(currentRow)) {
          for (let i = 0; i < currentRow.length; i++) {
            row.push(this.excelValueToString(currentRow[i]));
          }
        }

        rows.push(row);
        rowCount++;

        if (rowCount % 10000 === 0) {
          progressCallback?.(
            `Processed ${rowCount.toLocaleString()} rows...`,
            undefined,
            false,
          );
          await delay();
        }
      }

      progressCallback?.(`Excel file loaded: ${rows.length} rows`);
      return rows;
    } finally {
      // Reader cleanup (close zip if needed)
      if (reader && typeof reader.close === "function") {
        try {
          await reader.close();
        } catch (err) {
          console.error("Error closing Excel reader:", err);
        }
      }
    }
  }

  /**
   * Detect decimal delimiter from sample of rows
   */
  private detectDecimalDelimiter(rows: string[][]): string {
    let dotCount = 0;
    let commaCount = 0;
    const sampleLimit = Math.min(100, rows.length - 1);

    for (let i = 1; i <= sampleLimit; i++) {
      const row = rows[i];
      if (!row) continue;

      for (const cell of row) {
        if (!cell?.trim()) continue;
        const val = cell.trim();
        if (/^\d+\.\d+$/.test(val)) dotCount++;
        if (/^\d+,\d+$/.test(val)) commaCount++;
      }
    }

    return commaCount > dotCount && commaCount > 0 ? "," : ".";
  }

  /**
   * Analyze file to determine column types (supports CSV, TXT, XLSX, XLSB)
   * Uses streaming approach for large files
   */
  async analyzeDataTypes(
    progressCallback?: ProgressCallback,
  ): Promise<ColumnTypeChooser[]> {
    progressCallback?.("Analyzing data types...");
    this.analysisProgressOffset = 0;

    if (this.isExcelFile) {
      return this.analyzeExcelTypes(progressCallback);
    }

    // CSV/TXT files: use streaming approach for large files
    const fileSize = fs.statSync(this.filePath).size;
    const isLargeFile = fileSize > 10 * 1024 * 1024; // > 10MB threshold

    if (isLargeFile) {
      progressCallback?.("Using streaming analysis for large file...");
      this.analysisProgressOffset = 40;
      return this.analyzeDataTypesStreaming(progressCallback);
    } else {
      // Small files: use existing approach for simplicity
      progressCallback?.("Using memory-based analysis...");
      return this.analyzeDataTypesInMemory(progressCallback);
    }
  }

  /**
   * Streaming analysis for large CSV/TXT files
   */
  private async analyzeDataTypesStreaming(
    progressCallback?: ProgressCallback,
  ): Promise<ColumnTypeChooser[]> {
    const pendingRows: string[][] = [];
    const decimalSamples = { dot: 0, comma: 0 };
    const maxDecimalSamples = 1000;
    let headers: string[] = [];
    let dataTypes: ColumnTypeChooser[] = [];
    let decimalDelimiter = ".";
    let headerProcessed = false;
    let sampleCount = 0;
    let rowCount = 0;
    let lastReportedAnalysisPercent = 0;

    const applyRow = (row: string[]) => {
      for (let index = 0; index < Math.min(row.length, headers.length); index++) {
        const value = row[index]?.trim();
        if (value) {
          dataTypes[index].refreshCurrentType(value);
        }
      }
    };

    const initializeTypes = () => {
      if (dataTypes.length > 0 || headers.length === 0) {
        return;
      }
      decimalDelimiter =
        decimalSamples.comma > decimalSamples.dot && decimalSamples.comma > 0
          ? ","
          : ".";
      this.decimalDelimiter = decimalDelimiter;
      this.sqlHeaders = headers;
      dataTypes = this.createColumnTypeChoosers(
        this.sourceHeaders,
        decimalDelimiter,
      );
      progressCallback?.(`Detected decimal separator: '${decimalDelimiter}'`);
      for (const row of pendingRows) {
        applyRow(row);
      }
      pendingRows.length = 0;
    };

    for await (const row of readDelimitedRecords(
      this.filePath,
      this.csvDelimiter,
      (bytesRead, totalBytes) => {
        const readPercent = totalBytes > 0
          ? Math.min(100, Math.floor((bytesRead / totalBytes) * 100))
          : 100;
        const overallPercent = Math.floor(readPercent * 0.4);
        if (overallPercent <= lastReportedAnalysisPercent) {
          return;
        }
        const increment = Math.max(0, overallPercent - lastReportedAnalysisPercent);
        lastReportedAnalysisPercent = Math.max(lastReportedAnalysisPercent, overallPercent);
        progressCallback?.(
          `Analyzing source: ${readPercent}% (${rowCount.toLocaleString()} rows)`,
          increment,
          false,
        );
      },
    )) {
      if (!headerProcessed) {
        if (this.hasHeadersOverride ?? true) {
          this.setHeaders(row);
        } else {
          this.setGeneratedHeaders(row.length);
        }
        headers = [...this.sqlHeaders];
        headerProcessed = true;
        progressCallback?.(`Headers: ${headers.length} columns`);
        if (this.hasHeadersOverride ?? true) {
          continue;
        }
      }

      rowCount++;
      pendingRows.push(row);
      if (sampleCount < maxDecimalSamples) {
        sampleCount++;
        for (const cell of row) {
          const value = cell?.trim() ?? "";
          if (/^\d+\.\d+$/.test(value)) decimalSamples.dot++;
          if (/^\d+,\d+$/.test(value)) decimalSamples.comma++;
        }
      }

      if (dataTypes.length > 0) {
        applyRow(row);
        pendingRows.length = 0;
      } else if (sampleCount === maxDecimalSamples || rowCount >= 100) {
        initializeTypes();
      }

      if (rowCount % 10000 === 0) {
        progressCallback?.(`Analyzed ${rowCount.toLocaleString()} rows...`, undefined, false);
        await delay();
      }
    }

    if (!headerProcessed) {
      throw new Error("No data found in file");
    }
    initializeTypes();
    this.rowsCount = rowCount;
    this.dataTypes = dataTypes;
    progressCallback?.(`Analysis complete: ${rowCount.toLocaleString()} rows`);
    return dataTypes;
  }

  /**
   * In-memory analysis for small CSV/TXT files (original implementation)
   */
  private async analyzeDataTypesInMemory(
    progressCallback?: ProgressCallback,
  ): Promise<ColumnTypeChooser[]> {
    this.detectCsvDelimiter();

    const content = fs.readFileSync(this.filePath, "utf-8");
    const rows = parseDelimitedRecords(content, this.csvDelimiter);

    if (!rows || rows.length === 0) {
      throw new Error("No data found in file");
    }

    // Detect decimal delimiter before analyzing types
    this.decimalDelimiter = this.detectDecimalDelimiter(rows);
    progressCallback?.(
      `Detected decimal separator: '${this.decimalDelimiter}'`,
    );

    const dataTypes: ColumnTypeChooser[] = [];

    const hasHeaders = this.hasHeadersOverride ?? true;
    if (hasHeaders) {
      this.setHeaders(rows[0]);
    } else {
      this.setGeneratedHeaders(rows[0].length);
    }
    dataTypes.push(
      ...this.createColumnTypeChoosers(
        this.sourceHeaders,
        this.decimalDelimiter,
      ),
    );

    // Process data rows, including the first row when no header is selected.
    for (let i = hasHeaders ? 1 : 0; i < rows.length; i++) {
      const row = rows[i];
      for (let j = 0; j < row.length; j++) {
        if (j < dataTypes.length && row[j] && row[j].trim()) {
          dataTypes[j].refreshCurrentType(row[j].trim());
        }
      }

      if (i % 10000 === 0) {
        progressCallback?.(
          `Analyzed ${i.toLocaleString()} rows...`,
          undefined,
          false,
        );
        await delay();
      }
    }

    this.rowsCount = Math.max(0, rows.length - (hasHeaders ? 1 : 0));
    progressCallback?.(
      `Analysis complete: ${this.rowsCount.toLocaleString()} rows`,
    );

    this.dataTypes = dataTypes;
    return dataTypes;
  }

  /**
   * Streaming type analysis for Excel files — reads rows through the reader
   * for decimal detection and column type inference without caching all rows.
   */
  private async analyzeExcelTypes(
    progressCallback?: ProgressCallback,
  ): Promise<ColumnTypeChooser[]> {
    if (!ReaderFactory) {
      throw new Error("ReaderFactory module not available");
    }

    progressCallback?.("Analyzing Excel file types...");

    const reader = ReaderFactory.create(this.filePath);
    try {
      await reader.open(this.filePath);
      this.availableSheetNames =
        typeof reader.getSheetNames === "function"
          ? [...reader.getSheetNames()]
          : [];
      await this.selectExcelReaderSheet(reader);

      let rowsCount = 0;
      let dataTypes: ColumnTypeChooser[] = [];
      let decimalFinalized = false;
      let firstRawRow: unknown[] | undefined;
      let firstRow: string[] | undefined;
      let firstRowHandled = false;
      const decimalSamples: { dot: number; comma: number } = {
        dot: 0,
        comma: 0,
      };
      const maxDecimalSamples = 100;

      const initializeDataTypes = () => {
        if (decimalFinalized || this.sqlHeaders.length === 0) {
          return;
        }

        this.decimalDelimiter =
          decimalSamples.comma > decimalSamples.dot && decimalSamples.comma > 0
            ? ","
            : ".";
        progressCallback?.(
          `Detected decimal separator: '${this.decimalDelimiter}'`,
        );

        dataTypes = this.createColumnTypeChoosers(
          this.sourceHeaders,
          this.decimalDelimiter,
        );
        decimalFinalized = true;
      };

      const processDataRow = (row: string[]) => {
        rowsCount++;

        if (rowsCount <= maxDecimalSamples) {
          for (const cell of row) {
            const val = cell?.trim() || "";
            if (/^\d+\.\d+$/.test(val)) decimalSamples.dot++;
            if (/^\d+,\d+$/.test(val)) decimalSamples.comma++;
          }
        }

        initializeDataTypes();

        for (let j = 0; j < Math.min(row.length, dataTypes.length); j++) {
          if (row[j] && row[j].trim()) {
            dataTypes[j].refreshCurrentType(row[j].trim());
          }
        }
      };

      while (await reader.read()) {
        const currentRow = reader._currentRow;
        const row: string[] = [];
        if (currentRow && Array.isArray(currentRow)) {
          for (let i = 0; i < currentRow.length; i++) {
            row.push(this.excelValueToString(currentRow[i]));
          }
        }

        if (!firstRawRow) {
          firstRawRow = Array.isArray(currentRow) ? [...currentRow] : [];
          firstRow = row;
          continue;
        }

        if (!firstRowHandled) {
          this.excelHasHeaderRow = this.hasHeadersOverride ?? this.detectExcelHeaderRow(firstRawRow);
          if (this.excelHasHeaderRow) {
            this.setHeaders(firstRow ?? []);
          } else {
            this.setGeneratedHeaders(Math.max(firstRow?.length ?? 0, row.length));
            processDataRow(firstRow ?? []);
          }
          firstRowHandled = true;
        }

        processDataRow(row);
      }

      if (firstRow && !firstRowHandled) {
        this.excelHasHeaderRow = this.hasHeadersOverride ?? this.detectExcelHeaderRow(firstRawRow ?? []);
        if (this.excelHasHeaderRow) {
          this.setHeaders(firstRow);
        } else {
          this.setGeneratedHeaders(firstRow.length);
          processDataRow(firstRow);
        }
      }

      if (rowsCount > 0 && rowsCount % 10000 === 0) {
        progressCallback?.(
          `Analyzed ${rowsCount.toLocaleString()} rows...`,
          undefined,
          false,
        );
        await delay();
      }

      this.rowsCount = rowsCount;
      this.dataTypes = dataTypes;

      progressCallback?.(
        `Analysis complete: ${rowsCount.toLocaleString()} rows`,
      );

      return dataTypes;
    } finally {
      if (reader && typeof reader.close === "function") {
        try {
          await reader.close();
        } catch (err) {
          console.error("Error closing Excel reader:", err);
        }
      }
    }
  }

  /**
   * Escape special characters for Netezza import
   */
  private escapeValue(val: string): string {
    let result = String(val).replace(/\r/g, "");
    for (const char of this.valuesToEscape) {
      result = result.split(char).join(`${this.escapechar}${char}`);
    }
    return result;
  }

  /**
   * Truncate numeric value to specified scale (decimal places)
   */
  private truncateNumeric(value: string, scale: number): string {
    if (!value || scale < 0) return value;

    const parts = value.split(this.decimalDelimiter);
    if (parts.length !== 2) return value;

    const integerPart = parts[0];
    const decimalPart = parts[1];

    // Truncate decimal part to scale
    if (decimalPart.length > scale) {
      return (
        integerPart + this.decimalDelimiter + decimalPart.substring(0, scale)
      );
    }

    return value;
  }

  /**
   * Format value according to column type
   */
  formatValue(val: string, colIndex: number): string {
    if (colIndex < 0 || colIndex >= this.sqlHeaders.length) {
      return this.escapeValue(val);
    }

    const effectiveType = this.getEffectiveDataType(colIndex);
    const baseType = getBaseDataType(effectiveType);
    const isTextType = /^(N?CHAR|N?VARCHAR|TEXT|CLOB)/.test(baseType);
    let result = this.escapeValue(isTextType ? val : val.trim());

    if (baseType === "BOOLEAN") {
      if (/^true$/i.test(result)) result = "1";
      else if (/^false$/i.test(result)) result = "0";
    }

    // Handle DATETIME
    if (baseType === "DATETIME" || baseType === "TIMESTAMP") {
      result = result.replace("T", " ");

      // Reformat dd.mm.yyyy to yyyy-mm-dd
      const dateTimeMatch = result.match(
        /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/,
      );
      if (dateTimeMatch) {
        const [, day, month, year, hour = "00", min = "00", sec = "00"] =
          dateTimeMatch;
        result = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")} ${hour.padStart(2, "0")}:${min.padStart(2, "0")}:${sec.padStart(2, "0")}`;
      }
    }

    // Handle NUMERIC - truncate to scale and convert delimiter
    if (baseType === "NUMERIC" || baseType === "DECIMAL") {
      // Truncate to declared scale
      const scale = getNumericScale(effectiveType) || 0;
      if (scale > 0) {
        result = this.truncateNumeric(result, scale);
      }

      // Replace comma with dot for DB if needed
      if (this.decimalDelimiter === ",") {
        result = result.replace(",", ".");
      }
    }

    return result;
  }

  /**
   * Get the plain/escaped representation of a delimiter for SQL
   */
  private getDelimiterPlain(): string {
    const d = this.externalDelimiter;
    if (d === "\t") return "\\t";
    if (d === ",") return ",";
    if (d === ";") return ";";
    if (d === "|") return "|";
    return d; // Fallback
  }

  private getQuotedTargetTable(): string {
    return this.targetTable.includes(".")
      ? this.targetTable
          .split(".")
          .map((p) => this.quoteIdentifier(p))
          .join(".")
      : this.quoteIdentifier(this.targetTable);
  }

  private getExternalUsingClause(): string {
    const logDirUnix = this.logDir.replace(/\\/g, "/");
    const delimiterPlain = this.getDelimiterPlain();

    return `    USING
    (
        REMOTESOURCE 'jdbc'
        DELIMITER '${delimiterPlain}'
        RecordDelim '${this.recordDelimPlain}'
        ESCAPECHAR '${this.escapechar}'
        NULLVALUE ''
        ENCODING 'Utf-8'
        TIMESTYLE '24hour'
        BOOLSTYLE '1_0'
        SKIPROWS 0
        MAXERRORS 1
        COMPRESS FALSE
        LOGDIR '${logDirUnix}'
    )`;
  }

  private buildImportSelectColumns(
    importColumns: Array<{
      sourceIndex: number;
      columnName: string;
      sourceType: string;
      forcedType?: string;
    }>,
  ): string[] {
    return importColumns.map((column) => {
      const quotedColumn = this.quoteIdentifier(column.columnName);
      const forcedType = column.forcedType
        ? normalizeDataType(column.forcedType)
        : undefined;
      const inferredType = normalizeDataType(column.sourceType);

      if (forcedType && forcedType !== inferredType) {
        return `        CAST(${quotedColumn} AS ${forcedType}) AS ${quotedColumn}`;
      }
      return `        ${quotedColumn}`;
    });
  }

  generateStandaloneCreateTableSql(): string {
    const importColumns = this.getImportColumnDescriptors();
    if (importColumns.length === 0) {
      throw new Error("No columns selected for import.");
    }

    const columnDefinitions = importColumns.map((column) => {
      const quotedColumn = this.quoteIdentifier(column.columnName);
      const targetType = normalizeDataType(
        column.forcedType ?? column.sourceType,
      );
      return `    ${quotedColumn} ${targetType}`;
    });

    return `CREATE TABLE ${this.getQuotedTargetTable()} (\n${columnDefinitions.join(",\n")}\n) DISTRIBUTE ON RANDOM;`;
  }

  generateLoadIntoExistingTableSql(): string {
    const importColumns = this.getImportColumnDescriptors();
    if (importColumns.length === 0) {
      throw new Error("No columns selected for import.");
    }

    const externalColumns = importColumns.map(
      (column) =>
        `        ${this.quoteIdentifier(column.columnName)} ${column.sourceType}`,
    );
    const selectColumns = this.buildImportSelectColumns(importColumns);
    const targetColumns = importColumns
      .map((column) => this.quoteIdentifier(column.columnName))
      .join(", ");

    return `INSERT INTO ${this.getQuotedTargetTable()} (${targetColumns})
SELECT
${selectColumns.join(",\n")}
FROM EXTERNAL '${this.virtualFileName}'
(
${externalColumns.join(",\n")}
)
${this.getExternalUsingClause()};`;
  }

  /**
   * Generate CREATE TABLE SQL with detected column types
   */
  generateCreateTableSql(): string {
    const importColumns = this.getImportColumnDescriptors();
    if (importColumns.length === 0) {
      throw new Error("No columns selected for import.");
    }

    const externalColumns = importColumns.map(
      (column) =>
        `        ${this.quoteIdentifier(column.columnName)} ${column.sourceType}`,
    );

    const selectColumns = this.buildImportSelectColumns(importColumns);

    if (selectColumns.length === 0) {
      throw new Error("No columns selected for import.");
    }

    return `CREATE TABLE ${this.getQuotedTargetTable()} AS 
(
    SELECT
${selectColumns.join(",\n")}
    FROM EXTERNAL '${this.virtualFileName}'
    (
${externalColumns.join(",\n")}
    )
${this.getExternalUsingClause()}
) DISTRIBUTE ON RANDOM;`;
  }

  /**
   * Create data stream from file content (CSV/Excel)
   * - CSV/TXT: streaming approach — data is never materialized in RAM
   * - XLSX/XLSB: memory-based approach (Excel files are typically smaller)
   */
  async createDataStream(
    progressCallback?: ProgressCallback,
  ): Promise<Readable> {
    progressCallback?.("Preparing data stream...");

    try {
      if (this.isExcelFile) {
        // Excel files: streaming approach via Excel reader async generator
        return this.createExcelDataStream(progressCallback);
      }

      // CSV/TXT: streaming approach — rows are parsed and formatted lazily
      return this.createCsvDataStream(progressCallback);
    } catch (e: unknown) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      progressCallback?.(`Error preparing stream: ${errorMsg}`);
      throw e;
    }
  }

  /**
   * Streaming CSV data source — reads and processes rows lazily
  * via an incremental quote-aware record parser. Row data is never
  * materialized in a full array; each row is formatted and pushed directly
  * into the Readable stream as a delimited record.
   */
  private async createCsvDataStream(
    progressCallback?: ProgressCallback,
  ): Promise<Readable> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    async function* generateRows(): AsyncGenerator<string> {
      let headerSkipped = false;
      let totalRowsPushed = 0;
      let lastReportTime = 0;
      const progressOffset = self.analysisProgressOffset;
      const streamProgressWeight = 100 - progressOffset;
      let lastReportedPercent = progressOffset;
      self.streamedRowsCount = 0;

      try {
        for await (const row of readDelimitedRecords(self.filePath, self.csvDelimiter)) {
          throwIfImportCancelled(self.isCancelled);
          if (self.hasHeadersOverride !== false && !headerSkipped) {
            headerSkipped = true;
            continue;
          }
          headerSkipped = true;

          const formattedRow = self.formatImportRow(row);
          const lineStr =
            formattedRow.join(self.getExternalDelimiter()) +
            self.getRecordDelim();

          totalRowsPushed++;
          self.streamedRowsCount = totalRowsPushed;

          const now = Date.now();
          if (progressCallback && now - lastReportTime >= 1000) {
            const percent =
              self.rowsCount > 0
                ? progressOffset + Math.floor((totalRowsPushed / self.rowsCount) * streamProgressWeight)
                : 100;
            const increment = Math.max(0, percent - lastReportedPercent);
            lastReportedPercent = Math.max(lastReportedPercent, percent);
            progressCallback(
              `Importing: ${percent}% complete (${totalRowsPushed.toLocaleString()} rows)`,
              increment,
              false,
            );
            lastReportTime = now;
          }

          yield lineStr;
        }
      } finally {
        self.rowsCount = totalRowsPushed;
      }
    }

    return Readable.from(generateRows(), { highWaterMark: 65536 });
  }

  /**
   * Streaming Excel data source — reads rows through the Excel reader lazily
   * via an async generator wrapped in Readable.from(). Row data is formatted
   * and pushed directly into the stream without materializing the full file.
   */
  private async createExcelDataStream(
    progressCallback?: ProgressCallback,
  ): Promise<Readable> {
    if (!ReaderFactory) {
      throw new Error("ReaderFactory module not available");
    }
    const factory: IReaderFactory = ReaderFactory;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const totalRows = this.rowsCount;

    async function* generateRows(): AsyncGenerator<string> {
      const reader = factory.create(self.filePath);
      let readerOpened = false;
      let rowsPushed = 0;
      self.streamedRowsCount = 0;

      try {
        await reader.open(self.filePath);
        readerOpened = true;

        // Apply sheet selection if set
        if (
          self.availableSheetNames.length > 0 &&
          self.selectedSheetName &&
          typeof reader._initSheet === "function"
        ) {
          const targetIndex = self.availableSheetNames.findIndex(
            (name) => name === self.selectedSheetName,
          );
          if (targetIndex >= 0) {
            reader._currentSheetIndex = targetIndex;
            await reader._initSheet(targetIndex);
          }
        }

        let headerSkipped = !self.excelHasHeaderRow;
        let lastReportTime = 0;
        let lastReportedPercent = 0;

        while (readerOpened && (await reader.read())) {
          throwIfImportCancelled(self.isCancelled);
          if (!headerSkipped) {
            headerSkipped = true;
            continue;
          }

          const currentRow = reader._currentRow;
          const row: string[] = [];
          if (currentRow && Array.isArray(currentRow)) {
            for (let i = 0; i < currentRow.length; i++) {
              row.push(self.excelValueToString(currentRow[i]));
            }
          }

          const formattedRow = self.formatImportRow(row);
          const lineStr =
            formattedRow.join(self.getExternalDelimiter()) +
            self.getRecordDelim();

          rowsPushed++;
          self.streamedRowsCount = rowsPushed;

          // Progress reporting
          const now = Date.now();
          if (progressCallback && now - lastReportTime >= 1000) {
            const percent =
              totalRows > 0
                ? Math.floor((rowsPushed / totalRows) * 100)
                : 0;
            const increment = Math.max(0, percent - lastReportedPercent);
            lastReportedPercent = Math.max(lastReportedPercent, percent);
            progressCallback(
              `Importing: ${percent}% complete (${rowsPushed.toLocaleString()} / ${totalRows.toLocaleString()} rows)`,
              increment,
              false,
            );
            lastReportTime = now;
          }

          yield lineStr;
        }
      } finally {
        self.rowsCount = rowsPushed;
        if (reader && readerOpened && typeof reader.close === "function") {
          try {
            await reader.close();
          } catch {
            // Best-effort cleanup
          }
        }
      }
    }

    return Readable.from(generateRows(), { highWaterMark: 65536 });
  }

  // Public getter for pipeName to register it
  getVirtualFileName(): string {
    return this.virtualFileName;
  }

  /**
   * Get rows count
   */
  getRowsCount(): number {
    return this.rowsCount;
  }

  /**
   * Get the number of rows already pulled from the source into the virtual
   * import stream.
   */
  getStreamedRowsCount(): number {
    return this.streamedRowsCount;
  }

  /**
   * Get SQL headers
   */
  getSqlHeaders(): string[] {
    return this.sqlHeaders;
  }

  /**
   * Get original source headers before SQL normalization
   */
  getSourceHeaders(): string[] {
    return this.sourceHeaders;
  }

  async getAvailableSheetNames(): Promise<string[]> {
    if (!this.isExcelFile) {
      return [];
    }

    if (this.availableSheetNames.length > 0) {
      return [...this.availableSheetNames];
    }

    if (!ReaderFactory) {
      return [];
    }

    const reader = ReaderFactory.create(this.filePath);
    try {
      await reader.open(this.filePath);
      this.availableSheetNames =
        typeof reader.getSheetNames === "function"
          ? [...reader.getSheetNames()]
          : [];
      return [...this.availableSheetNames];
    } finally {
      await reader.close().catch(() => undefined);
    }
  }

  setSelectedSheet(sheetName?: string): void {
    if (!this.isExcelFile) {
      return;
    }

    this.selectedSheetName = sheetName?.trim() || undefined;
    this.resetAnalyzedState();
  }

  getSelectedSheet(): string | undefined {
    return this.selectedSheetName;
  }

  /**
   * Get detected decimal delimiter from analysis
   */
  getDecimalDelimiter(): string {
    return this.decimalDelimiter;
  }

  /**
   * Returns inferred import mapping between source columns and target columns.
   */
  getColumnMappings(): Array<{
    sourceColumn: string;
    targetColumn: string;
    dataType: string;
  }> {
    const mappings: Array<{
      sourceColumn: string;
      targetColumn: string;
      dataType: string;
    }> = [];
    const maxColumns = Math.max(this.sqlHeaders.length, this.dataTypes.length);
    for (let i = 0; i < maxColumns; i++) {
      mappings.push({
        sourceColumn:
          this.sourceHeaders[i] || this.sqlHeaders[i] || `COLUMN_${i + 1}`,
        targetColumn: this.sqlHeaders[i] || `COLUMN_${i + 1}`,
        dataType: this.dataTypes[i]?.currentType.toString() || "NVARCHAR(255)",
      });
    }
    return mappings;
  }

  /**
   * Returns a preview sample of data rows (without header).
   */
  async getSampleRows(limit: number = 5): Promise<string[][]> {
    const sampleLimit = Math.max(1, Math.min(limit, 50000));

    if (this.isExcelFile) {
      return this.readExcelSampleRows(sampleLimit);
    }

    const rows: string[][] = [];
    let headerSkipped = false;
    for await (const row of readDelimitedRecords(this.filePath, this.csvDelimiter)) {
      if (this.hasHeadersOverride !== false && !headerSkipped) {
        headerSkipped = true;
        continue;
      }
      headerSkipped = true;
      rows.push(row);
      if (rows.length >= sampleLimit) {
        break;
      }
    }
    return rows;
  }

  async getAllRows(): Promise<string[][]> {
    if (this.isExcelFile) {
      const allRows = await this.readExcelFile();
      const rows = allRows.slice(this.excelHasHeaderRow ? 1 : 0);
      this.rowsCount = rows.length;
      return rows;
    }

    const rows: string[][] = [];
    let skipHeader = this.hasHeadersOverride !== false;
    for await (const row of readDelimitedRecords(this.filePath, this.csvDelimiter)) {
      if (skipHeader) {
        skipHeader = false;
        continue;
      }
      rows.push(row);
    }

    this.rowsCount = rows.length;
    return rows;
  }

  /**
   * Get CSV delimiter (uses external delimiter for consistency)
   */
  getCsvDelimiter(): string {
    return this.externalDelimiter;
  }
}

/**
 * Import data from a file to Netezza table
 */
export async function importDataToNetezza(
  filePath: string,
  targetTable: string,
  connectionDetails: ConnectionDetails,
  progressCallback?: ProgressCallback,
  timeout?: number,
  columnOptions?: ImportColumnOptions,
  isCancelled?: ImportCancellationCheck,
): Promise<ImportResult> {
  const startTime = Date.now();
  let connection: NzConnection | null = null;
  let importStream: Readable | undefined;
  let unregisterImportStream: (() => void) | undefined;

  try {
    // Validate parameters
    if (!filePath || !fs.existsSync(filePath)) {
      return {
        success: false,
        message: `Source file not found: ${filePath}`,
      };
    }

    if (!targetTable) {
      return {
        success: false,
        message: "Target table name is required",
      };
    }

    if (!connectionDetails || !connectionDetails.host) {
      return {
        success: false,
        message: "Connection details are required",
      };
    }

    // Get file info
    const fileStats = fs.statSync(filePath);
    const fileSize = fileStats.size;
    const fileExt = path.extname(filePath).toLowerCase();

    // Check supported formats
    const supportedFormats = [".csv", ".txt", ".tsv", ".xlsx", ".xlsb"];
    if (!supportedFormats.includes(fileExt)) {
      return {
        success: false,
        message: `Unsupported file format: ${fileExt}. Supported: ${supportedFormats.join(", ")}`,
      };
    }

    progressCallback?.("Starting import process...");
    progressCallback?.(`  Source file: ${filePath}`);
    progressCallback?.(`  Target table: ${targetTable}`);
    progressCallback?.(`  File size: ${fileSize.toLocaleString()} bytes`);
    progressCallback?.(`  File format: ${fileExt}`);

    // Create importer instance (logDir defaults to netezza_logs alongside source file)
    const importer = new NetezzaImporter(filePath, targetTable, undefined, {
      hasHeaders: columnOptions?.hasHeaders,
      isCancelled,
    });

    // Analyze data types
    await importer.analyzeDataTypes(progressCallback);
    importer.applyColumnOptions(columnOptions);

    progressCallback?.("Preparing data stream...");
    importStream = await importer.createDataStream(progressCallback);
    const virtualFileName = buildNetezzaVirtualImportName("virtual_file_import");
    importer.setVirtualFileName(virtualFileName);
    unregisterImportStream = registerNetezzaImportStream(virtualFileName, importStream);
    progressCallback?.(`Registered virtual import stream: ${virtualFileName}`);

    // Generate SQL
    const createSql = importer.generateCreateTableSql();
    progressCallback?.("Generated SQL:");
    progressCallback?.(createSql);

    // Execute import
    progressCallback?.("Connecting to database...");

    connection =
      await createConnectedDatabaseConnectionFromDetails(connectionDetails);

    try {
      progressCallback?.("Executing CREATE TABLE with EXTERNAL data...");
      // Create command for the CREATE TABLE AS SELECT ... FROM EXTERNAL
      // NzConnection should handle the external table protocol automatically
      const cmd = connection!.createCommand(createSql);

      // Set timeout (default to 60 minutes for large file imports if not specified)
      cmd.commandTimeout = timeout || 3600;

      // Listen for import progress events
      const totalRows = importer.getRowsCount();
      connection!.on("importProgress", (progressData: unknown) => {
        const progress = resolveNetezzaImportProgress(
          progressData as NetezzaImportProgressData,
          totalRows,
          importer.getStreamedRowsCount(),
        );
        progressCallback?.(
          `Importing: ${progress.percentComplete}% complete (${progress.estimatedRows.toLocaleString()} / ${totalRows.toLocaleString()} rows)`,
        );
      });

      throwIfImportCancelled(isCancelled);
      await cmd.execute();

      progressCallback?.("Import completed successfully");
    } finally {
      await connection.close();
    }

    const processingTime = (Date.now() - startTime) / 1000;

    return {
      success: true,
      message: "Import completed successfully",
      details: {
        sourceFile: filePath,
        targetTable: targetTable,
        fileSize: fileSize,
        format: fileExt,
        rowsProcessed: importer.getRowsCount(),
        rowsInserted: importer.getRowsCount(),
        processingTime: `${processingTime.toFixed(1)}s`,

        columns: importer.getImportColumnCount(),
        detectedDelimiter: importer.getCsvDelimiter(),
      },
    };
  } catch (e: unknown) {
    const processingTime = (Date.now() - startTime) / 1000;
    const errorMsg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      message: `Import failed: ${errorMsg}`,
      details: {
        processingTime: `${processingTime.toFixed(1)}s`,
      },
    };
  } finally {
    if (connection && connection._connected) {
      try {
        await connection.close();
      } catch {
        // Ignore connection close errors during cleanup
      }
    }
    unregisterImportStream?.();
    destroyNetezzaImportStream(importStream);
  }
}

export async function importDataToNetezzaAdvanced(
  filePath: string,
  targetTable: string,
  connectionDetails: ConnectionDetails,
  progressCallback?: ProgressCallback,
  timeout?: number,
  columnOptions?: ImportColumnOptions,
  isCancelled?: ImportCancellationCheck,
): Promise<ImportResult> {
  const startTime = Date.now();
  let connection: NzConnection | null = null;
  let importStream: Readable | undefined;
  let unregisterImportStream: (() => void) | undefined;

  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return {
        success: false,
        message: `Source file not found: ${filePath}`,
      };
    }

    if (!targetTable) {
      return {
        success: false,
        message: "Target table name is required",
      };
    }

    if (!connectionDetails || !connectionDetails.host) {
      return {
        success: false,
        message: "Connection details are required",
      };
    }

    const fileStats = fs.statSync(filePath);
    const fileSize = fileStats.size;
    const fileExt = path.extname(filePath).toLowerCase();
    const supportedFormats = [".csv", ".txt", ".tsv", ".xlsx", ".xlsb"];
    if (!supportedFormats.includes(fileExt)) {
      return {
        success: false,
        message: `Unsupported file format: ${fileExt}. Supported: ${supportedFormats.join(", ")}`,
      };
    }

    progressCallback?.("Starting advanced import process...");
    progressCallback?.(`  Source file: ${filePath}`);
    progressCallback?.(`  Target table: ${targetTable}`);
    progressCallback?.(`  File size: ${fileSize.toLocaleString()} bytes`);
    progressCallback?.(`  File format: ${fileExt}`);

    const importer = new NetezzaImporter(filePath, targetTable, undefined, {
      hasHeaders: columnOptions?.hasHeaders,
      isCancelled,
    });
    await importer.analyzeDataTypes(progressCallback);
    importer.applyColumnOptions(columnOptions);

    progressCallback?.("Preparing data stream...");
    importStream = await importer.createDataStream(progressCallback);
    const virtualFileName = buildNetezzaVirtualImportName("virtual_file_import");
    importer.setVirtualFileName(virtualFileName);
    unregisterImportStream = registerNetezzaImportStream(virtualFileName, importStream);
    progressCallback?.(`Registered virtual import stream: ${virtualFileName}`);

    const createSql = importer.generateStandaloneCreateTableSql();
    const loadSql = importer.generateLoadIntoExistingTableSql();
    progressCallback?.("Generated CREATE TABLE SQL:");
    progressCallback?.(createSql);
    progressCallback?.("Generated load SQL:");
    progressCallback?.(loadSql);

    progressCallback?.("Connecting to database...");
    connection =
      await createConnectedDatabaseConnectionFromDetails(connectionDetails);

    try {
      const totalRows = importer.getRowsCount();
      connection.on("importProgress", (progressData: unknown) => {
        const progress = resolveNetezzaImportProgress(
          progressData as NetezzaImportProgressData,
          totalRows,
          importer.getStreamedRowsCount(),
        );
        progressCallback?.(
          `Importing: ${progress.percentComplete}% complete (${progress.estimatedRows.toLocaleString()} / ${totalRows.toLocaleString()} rows)`,
        );
      });

      if (!columnOptions?.appendToExistingTable) {
        progressCallback?.("Creating target table...");
        const createCommand = connection.createCommand(createSql);
        createCommand.commandTimeout = timeout || 3600;
        await createCommand.execute();
      }

      progressCallback?.("Loading rows from external stream...");
      const loadCommand = connection.createCommand(loadSql);
      loadCommand.commandTimeout = timeout || 3600;
      throwIfImportCancelled(isCancelled);
      await loadCommand.execute();

      progressCallback?.("Import completed successfully");
    } finally {
      await connection.close();
    }

    const processingTime = (Date.now() - startTime) / 1000;
    return {
      success: true,
      message: "Import completed successfully",
      details: {
        sourceFile: filePath,
        targetTable,
        fileSize,
        format: fileExt,
        rowsProcessed: importer.getRowsCount(),
        rowsInserted: importer.getRowsCount(),
        processingTime: `${processingTime.toFixed(1)}s`,
        columns: importer.getImportColumnCount(),
        detectedDelimiter: importer.getCsvDelimiter(),
      },
    };
  } catch (error) {
    if (connection) {
      await connection.close().catch(() => undefined);
    }

    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    unregisterImportStream?.();
    destroyNetezzaImportStream(importStream);
  }
}
