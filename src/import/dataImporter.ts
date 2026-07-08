/**
 * Data Importer for Netezza
 * Handles importing data from various file formats to Netezza tables
 * Ported from Python data_importer.py
 */

import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { ConnectionDetails, NzConnection } from "../types";
import {
  createConnectedDatabaseConnectionFromDetails,
  getDatabaseConnectionConstructor,
} from "../core/connectionFactory";
import { ColumnTypeChooser } from "../dialects/netezza/import/typeMapping";
import { headerForcesTextImportType } from "./importTypeInferenceUtils";

// Helper to unblock event loop
const delay = () => new Promise((resolve) => setTimeout(resolve, 0));

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

export interface ImportColumnOptions {
  selectedColumnIndexes?: number[];
  forcedColumnTypes?: Record<number, string>;
  columnNameOverrides?: Record<number, string>;
}

export interface ImportColumnDescriptor {
  sourceIndex: number;
  columnName: string;
  dataType: string;
}

/**
 * Import result
 */
export interface ImportResult {
  success: boolean;
  message: string;
  details?: {
    sourceFile?: string;
    targetTable?: string;
    fileSize?: number;
    format?: string;
    rowsProcessed?: number;
    rowsInserted?: number;
    processingTime?: string;
    columns?: number;
    detectedDelimiter?: string;
    snowflakeWorkflow?: {
      workflowMarkdown: string;
      createTableSql?: string;
      copyIntoSql?: string;
      warnings?: string[];
      nextSteps?: string[];
      stageName?: string;
      stagePath?: string;
      sourceFormat?: string;
    };
  };
}

/**
 * Progress callback function type
 */
export type ProgressCallback = (
  message: string,
  increment?: number,
  logToOutput?: boolean,
) => void;

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
    /^(NUMERIC|DECIMAL)\(\s*\d+\s*,\s*(\d+)\s*\)$/,
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
  private availableSheetNames: string[] = [];
  private selectedSheetName?: string;

  // Data analysis
  private sourceHeaders: string[] = [];
  private sqlHeaders: string[] = [];
  private dataTypes: ColumnTypeChooser[] = [];
  private rowsCount: number = 0;
  private valuesToEscape: string[] = [];
  private selectedColumnIndexes: number[] = [];
  private forcedColumnTypes: Map<number, string> = new Map();
  private columnNameOverrides: Map<number, string> = new Map();

  constructor(filePath: string, targetTable: string, logDir?: string) {
    this.filePath = filePath;
    this.targetTable = targetTable;
    this.logDir = logDir || path.join(path.dirname(filePath), "netezza_logs");

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
    const content = fs.readFileSync(this.filePath, "utf-8");
    let firstLine = content.split("\n")[0] || "";

    // Handle UTF-8 BOM
    if (firstLine.startsWith("\ufeff")) {
      firstLine = firstLine.slice(1);
    }

    // Count delimiters and choose the most frequent
    const delimiters = [";", "\t", "|", ","];
    const counts: { [key: string]: number } = {};

    for (const delim of delimiters) {
      counts[delim] = (
        firstLine.match(new RegExp(delim === "|" ? "\\|" : delim, "g")) || []
      ).length;
    }

    const maxCount = Math.max(...Object.values(counts));
    if (maxCount > 0) {
      this.csvDelimiter =
        Object.keys(counts).find((k) => counts[k] === maxCount) || ",";
    }
  }

  /**
   * Clean column name for SQL compatibility
   */
  private cleanColumnName(colName: string): string {
    let cleanName = String(colName).trim();
    cleanName = cleanName.replace(/[^0-9a-zA-Z]+/g, "_").toUpperCase();
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
    return `"${name.replace(/"/g, '""')}"`;
  }

  /**
   * Parse a CSV line handling quoted fields
   */
  private parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === this.csvDelimiter && !inQuotes) {
        result.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current);

    return result;
  }

  /**
   * Read Excel sample rows (streaming, limited to N data rows).
   * Opens the Excel reader, skips header, collects up to `limit` rows.
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
      let headerSkipped = false;

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

    if (this.isExcelFile) {
      return this.analyzeExcelTypes(progressCallback);
    }

    // CSV/TXT files: use streaming approach for large files
    const fileSize = fs.statSync(this.filePath).size;
    const isLargeFile = fileSize > 10 * 1024 * 1024; // > 10MB threshold

    if (isLargeFile) {
      progressCallback?.("Using streaming analysis for large file...");
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
    return new Promise((resolve, reject) => {
      const readline = require("readline");
      const stream = fs.createReadStream(this.filePath, { encoding: "utf-8" });
      const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity,
      });

      let lineNumber = 0;
      let headers: string[] = [];
      let dataTypes: ColumnTypeChooser[] = [];
      let decimalDelimiter = "."; // Default
      let columnCount = 0;
      let headerProcessed = false;
      let decimalSampleCount = 0;
      const maxDecimalSamples = 1000;
      const pendingRows: string[][] = [];

      // Temporary storage for decimal detection
      const decimalSamples: { dot: number; comma: number } = {
        dot: 0,
        comma: 0,
      };

      const applyRowToTypeInference = (row: string[]) => {
        for (let j = 0; j < Math.min(row.length, columnCount); j++) {
          const value = row[j]?.trim();
          if (value) {
            dataTypes[j].refreshCurrentType(value);
          }
        }
      };

      const initializeTypeChoosers = () => {
        if (dataTypes.length > 0 || headers.length === 0) {
          return;
        }

        decimalDelimiter =
          decimalSamples.comma > decimalSamples.dot &&
          decimalSamples.comma > 0
            ? ","
            : ".";
        progressCallback?.(
          `Detected decimal separator: '${decimalDelimiter}'`,
        );

        dataTypes = this.createColumnTypeChoosers(
          this.sourceHeaders,
          decimalDelimiter,
        );
        this.sqlHeaders = headers;
        this.decimalDelimiter = decimalDelimiter;

        for (const pendingRow of pendingRows) {
          applyRowToTypeInference(pendingRow);
        }
        pendingRows.length = 0;
      };

      const processLine = async (line: string) => {
        try {
          lineNumber++;

          // Skip empty lines
          if (!line || !line.trim()) {
            return;
          }

          // Handle UTF-8 BOM on first line
          if (lineNumber === 1 && line.startsWith("\ufeff")) {
            line = line.slice(1);
          }

          const row = this.parseCsvLine(line);

          if (!headerProcessed) {
            // First non-empty line is header
            this.sourceHeaders = row.map((col) => col || "COLUMN");
            headers = this.sourceHeaders.map((col) =>
              this.cleanColumnName(col),
            );
            columnCount = headers.length;

            // We'll detect decimal delimiter from first data row
            headerProcessed = true;
            progressCallback?.(`Headers: ${columnCount} columns`);
            return;
          }

          pendingRows.push(row);

          // First data rows: detect decimal delimiter
          if (decimalSampleCount < maxDecimalSamples) {
            decimalSampleCount++;
            for (const cell of row) {
              const val = cell?.trim() || "";
              if (/^\d+\.\d+$/.test(val)) decimalSamples.dot++;
              if (/^\d+,\d+$/.test(val)) decimalSamples.comma++;
            }
          }

          if (decimalSampleCount === maxDecimalSamples || lineNumber > 100) {
            initializeTypeChoosers();
          }

          if (dataTypes.length === 0) {
            return;
          }

          applyRowToTypeInference(row);
          pendingRows.length = 0;

          // Progress reporting
          const rowsAnalyzed = lineNumber - 2; // Exclude header and current row
          if (rowsAnalyzed % 10000 === 0) {
            progressCallback?.(
              `Analyzed ${rowsAnalyzed.toLocaleString()} rows...`,
              undefined,
              false,
            );
            await delay(); // Unblock event loop
          }
        } catch (e) {
          console.error("Error processing line:", e);
        }
      };

      rl.on("line", (line: string) => {
        // Queue processing
        processLine(line).catch(reject);
      });

      rl.on("close", async () => {
        try {
          // Ensure type choosers are initialized (for small files where we didn't hit threshold)
          if (dataTypes.length === 0 && headers.length > 0) {
            initializeTypeChoosers();
          }

          this.rowsCount = Math.max(0, lineNumber - 2);
          this.dataTypes = dataTypes;

          progressCallback?.(
            `Analysis complete: ${this.rowsCount.toLocaleString()} rows`,
          );
          resolve(dataTypes);
        } catch (e) {
          reject(e);
        }
      });

      rl.on("error", reject);
    });
  }

  /**
   * In-memory analysis for small CSV/TXT files (original implementation)
   */
  private async analyzeDataTypesInMemory(
    progressCallback?: ProgressCallback,
  ): Promise<ColumnTypeChooser[]> {
    this.detectCsvDelimiter();

    let content = fs.readFileSync(this.filePath, "utf-8");

    // Handle UTF-8 BOM
    if (content.startsWith("\ufeff")) {
      content = content.slice(1);
    }

    const lines = content.split(/\r?\n/);
    const rows: string[][] = [];

    for (const line of lines) {
      if (line.trim()) {
        rows.push(this.parseCsvLine(line));
      }
    }

    if (!rows || rows.length === 0) {
      throw new Error("No data found in file");
    }

    // Detect decimal delimiter before analyzing types
    this.decimalDelimiter = this.detectDecimalDelimiter(rows);
    progressCallback?.(
      `Detected decimal separator: '${this.decimalDelimiter}'`,
    );

    const dataTypes: ColumnTypeChooser[] = [];

    // Process headers (first row)
    this.sourceHeaders = rows[0].map((col) => col || "COLUMN");
    this.sqlHeaders = this.sourceHeaders.map((col) =>
      this.cleanColumnName(col),
    );
    dataTypes.push(
      ...this.createColumnTypeChoosers(
        this.sourceHeaders,
        this.decimalDelimiter,
      ),
    );

    // Process data rows
    for (let i = 1; i < rows.length; i++) {
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

    this.rowsCount = rows.length - 1; // Exclude header
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

      let rowIndex = 0;
      let rowsCount = 0;
      let dataTypes: ColumnTypeChooser[] = [];
      let decimalFinalized = false;
      const decimalSamples: { dot: number; comma: number } = {
        dot: 0,
        comma: 0,
      };
      const maxDecimalSamples = 100;

      while (await reader.read()) {
        const currentRow = reader._currentRow;
        const row: string[] = [];
        if (currentRow && Array.isArray(currentRow)) {
          for (let i = 0; i < currentRow.length; i++) {
            row.push(this.excelValueToString(currentRow[i]));
          }
        }

        if (rowIndex === 0) {
          // First row is header
          this.sourceHeaders = row.map((col) => col || "COLUMN");
          this.sqlHeaders = this.sourceHeaders.map((col) =>
            this.cleanColumnName(col),
          );
          rowIndex++;
          continue;
        }

        // Data row processing
        rowsCount++;

        // Collect decimal delimiter samples from first N data rows
        if (!decimalFinalized && rowsCount <= maxDecimalSamples) {
          for (const cell of row) {
            const val = cell?.trim() || "";
            if (/^\d+\.\d+$/.test(val)) decimalSamples.dot++;
            if (/^\d+,\d+$/.test(val)) decimalSamples.comma++;
          }
        }

        // Initialize type choosers once decimal delimiter is determined
        if (!decimalFinalized && this.sqlHeaders.length > 0) {
          this.decimalDelimiter =
            decimalSamples.comma > decimalSamples.dot &&
            decimalSamples.comma > 0
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
        }

        // Type inference on all data rows
        if (dataTypes.length > 0) {
          for (
            let j = 0;
            j < Math.min(row.length, dataTypes.length);
            j++
          ) {
            if (row[j] && row[j].trim()) {
              dataTypes[j].refreshCurrentType(row[j].trim());
            }
          }
        }

        if (rowsCount % 10000 === 0) {
          progressCallback?.(
            `Analyzed ${rowsCount.toLocaleString()} rows...`,
            undefined,
            false,
          );
          await delay();
        }

        rowIndex++;
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
    let result = String(val).trim();
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
    let result = this.escapeValue(val);

    if (colIndex < 0 || colIndex >= this.sqlHeaders.length) {
      return result;
    }

    const effectiveType = this.getEffectiveDataType(colIndex);
    const baseType = getBaseDataType(effectiveType);

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
   * via fs.createReadStream + readline. Row data is never materialized
   * in a full array; each row is parsed, formatted, and pushed directly
   * into the Readable stream as a formatted delimited line.
   */
  private async createCsvDataStream(
    progressCallback?: ProgressCallback,
  ): Promise<Readable> {
    const fileStats = fs.statSync(this.filePath);
    const totalBytes = fileStats.size;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const readline = require("readline");

    async function* generateRows(): AsyncGenerator<string> {
      const fileStream = fs.createReadStream(self.filePath, {
        encoding: "utf-8",
      });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      let headerSkipped = false;
      let totalRowsPushed = 0;
      let lastReportTime = 0;

      try {
        for await (const line of rl) {
          // Skip header row (first non-empty line)
          // (BOM was already stripped during analyzeDataTypes())
          if (!headerSkipped) {
            headerSkipped = true;
            continue;
          }

          if (!line || !line.trim()) {
            continue;
          }

          const row = self.parseCsvLine(line);
          const formattedRow = self.formatImportRow(row);
          const lineStr =
            formattedRow.join(self.getExternalDelimiter()) +
            self.getRecordDelim();

          totalRowsPushed++;

          // Progress reporting based on bytes read from file
          const now = Date.now();
          if (progressCallback && now - lastReportTime >= 1000) {
            const bytesRead = fileStream.bytesRead || 0;
            const percent =
              totalBytes > 0
                ? Math.floor((bytesRead / totalBytes) * 100)
                : 0;
            progressCallback(
              `Importing: ${percent}% complete (${totalRowsPushed.toLocaleString()} rows)`,
              undefined,
              false,
            );
            lastReportTime = now;
          }

          yield lineStr;
        }
      } finally {
        self.rowsCount = totalRowsPushed;
        rl.close();
        fileStream.destroy();
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

        let headerSkipped = false;
        let lastReportTime = 0;

        while (readerOpened && (await reader.read())) {
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

          // Progress reporting
          const now = Date.now();
          if (progressCallback && now - lastReportTime >= 1000) {
            const percent =
              totalRows > 0
                ? Math.floor((rowsPushed / totalRows) * 100)
                : 0;
            progressCallback(
              `Importing: ${percent}% complete (${rowsPushed.toLocaleString()} / ${totalRows.toLocaleString()} rows)`,
              undefined,
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

    return new Promise((resolve, reject) => {
      const readline = require("readline");
      const stream = fs.createReadStream(this.filePath, { encoding: "utf-8" });
      const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity,
      });
      const rows: string[][] = [];
      let headerSkipped = false;

      rl.on("line", (line: string) => {
        if (!headerSkipped) {
          headerSkipped = true;
          return;
        }

        if (!line.trim()) {
          return;
        }

        rows.push(this.parseCsvLine(line));
        if (rows.length >= sampleLimit) {
          rl.close();
        }
      });

      rl.on("close", () => resolve(rows));
      rl.on("error", (err: Error) => reject(err));
    });
  }

  async getAllRows(): Promise<string[][]> {
    if (this.isExcelFile) {
      const allRows = await this.readExcelFile();
      const rows = allRows.slice(1);
      this.rowsCount = rows.length;
      return rows;
    }

    let content = fs.readFileSync(this.filePath, "utf-8");
    if (content.startsWith("\ufeff")) {
      content = content.slice(1);
    }

    const lines = content.split(/\r?\n/);
    const rows: string[][] = [];
    let skipHeader = true;

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      if (skipHeader) {
        skipHeader = false;
        continue;
      }
      rows.push(this.parseCsvLine(line));
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
): Promise<ImportResult> {
  const startTime = Date.now();
  let connection: NzConnection | null = null;

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
    const supportedFormats = [".csv", ".txt", ".xlsx", ".xlsb"];
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
    const importer = new NetezzaImporter(filePath, targetTable);

    // Analyze data types
    await importer.analyzeDataTypes(progressCallback);
    importer.applyColumnOptions(columnOptions);

    // Create data stream (in-memory)
    progressCallback?.("Preparing data stream...");
    const dataStream = await importer.createDataStream(progressCallback);
    const virtualFileName = importer.getVirtualFileName();
    progressCallback?.(`Registered virtual stream: ${virtualFileName}`);

    // Register stream with driver static registry
    // We need to access the class statically, so we require it
    const connectionConstructor = getDatabaseConnectionConstructor(
      connectionDetails.dbType,
    );
    if (connectionConstructor.registerImportStream) {
      connectionConstructor.registerImportStream(virtualFileName, dataStream);
    } else {
      progressCallback?.(
        "Warning: active database driver does not support stream registry. Import might fail.",
      );
    }

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
        const progress = progressData as {
          bytesSent: number;
          totalSize: number;
          percentComplete: number;
        };
        const estimatedRows =
          totalRows > 0
            ? Math.round((progress.percentComplete / 100) * totalRows)
            : 0;
        progressCallback?.(
          `Importing: ${progress.percentComplete}% complete (${estimatedRows.toLocaleString()} / ${totalRows.toLocaleString()} rows)`,
        );
      });

      await cmd.execute();

      progressCallback?.("Import completed successfully");
    } finally {
      await connection.close();

      // Clean up registry
      if (connectionConstructor.unregisterImportStream) {
        connectionConstructor.unregisterImportStream(virtualFileName);
      }
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
  }
}

export async function importDataToNetezzaAdvanced(
  filePath: string,
  targetTable: string,
  connectionDetails: ConnectionDetails,
  progressCallback?: ProgressCallback,
  timeout?: number,
  columnOptions?: ImportColumnOptions,
): Promise<ImportResult> {
  const startTime = Date.now();
  let connection: NzConnection | null = null;

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
    const supportedFormats = [".csv", ".txt", ".xlsx", ".xlsb"];
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

    const importer = new NetezzaImporter(filePath, targetTable);
    await importer.analyzeDataTypes(progressCallback);
    importer.applyColumnOptions(columnOptions);

    progressCallback?.("Preparing data stream...");
    const dataStream = await importer.createDataStream(progressCallback);
    const virtualFileName = importer.getVirtualFileName();
    progressCallback?.(`Registered virtual stream: ${virtualFileName}`);

    const connectionConstructor = getDatabaseConnectionConstructor(
      connectionDetails.dbType,
    );
    if (connectionConstructor.registerImportStream) {
      connectionConstructor.registerImportStream(virtualFileName, dataStream);
    } else {
      progressCallback?.(
        "Warning: active database driver does not support stream registry. Import might fail.",
      );
    }

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
        const progress = progressData as {
          bytesSent: number;
          totalSize: number;
          percentComplete: number;
        };
        const estimatedRows =
          totalRows > 0
            ? Math.round((progress.percentComplete / 100) * totalRows)
            : 0;
        progressCallback?.(
          `Importing: ${progress.percentComplete}% complete (${estimatedRows.toLocaleString()} / ${totalRows.toLocaleString()} rows)`,
        );
      });

      progressCallback?.("Creating target table...");
      const createCommand = connection.createCommand(createSql);
      createCommand.commandTimeout = timeout || 3600;
      await createCommand.execute();

      progressCallback?.("Loading rows from external stream...");
      const loadCommand = connection.createCommand(loadSql);
      loadCommand.commandTimeout = timeout || 3600;
      await loadCommand.execute();

      progressCallback?.("Import completed successfully");
    } finally {
      await connection.close();

      if (connectionConstructor.unregisterImportStream) {
        connectionConstructor.unregisterImportStream(virtualFileName);
      }
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
  }
}
