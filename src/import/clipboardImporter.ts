/**
 * Clipboard Data Importer for Netezza
 * Handles importing data from clipboard in text (tab-separated) format
 * Optimized for memory efficiency with streaming approach
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Readable } from 'stream';
import { ColumnTypeChooser, ProgressCallback, ImportResult } from './dataImporter';
import { NzConnection, ConnectionDetails } from '../types';
import {
    createConnectedDatabaseConnectionFromDetails,
    getDatabaseConnectionConstructor
} from '../core/connectionFactory';
import { headerForcesTextImportType } from './importTypeInferenceUtils';

// Helper to unblock event loop
const delay = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Streaming text data analyzer
 * Analyzes data types without storing all rows in memory
 */
class TextDataAnalyzer {
    private lines: string[];
    private delimiter: string;
    private headers: string[] = [];
    private dataTypes: ColumnTypeChooser[] = [];
    private decimalDelimiter: string = '.';
    private rowCount: number = 0;
    private readonly inferBoolean: boolean;

    constructor(textData: string, options?: { inferBoolean?: boolean }) {
        this.inferBoolean = options?.inferBoolean === true;
        this.lines = textData.split('\n');

        // Strip UTF-8 BOM from first line (can appear when copied from Notepad, Excel, etc.)
        if (this.lines.length > 0 && this.lines[0].startsWith('\ufeff')) {
            this.lines[0] = this.lines[0].slice(1);
        }

        // Remove empty lines at the end
        while (this.lines.length && !this.lines[this.lines.length - 1].trim()) {
            this.lines.pop();
        }

        this.delimiter = this.detectDelimiter();
    }

    /**
     * Auto-detect delimiter
     */
    private detectDelimiter(): string {
        const delimiters = ['\t', ',', ';', '|'];
        const delimiterScores: { [key: string]: { avg: number, variance: number } } = {};

        const sampleLines = this.lines.slice(0, Math.min(10, this.lines.length)).filter(l => l.trim());
        if (sampleLines.length === 0) return '\t';

        for (const delimiter of delimiters) {
            const scores = sampleLines.map(line => line.split(delimiter).length);
            const avgCols = scores.reduce((a, b) => a + b, 0) / scores.length;
            const variance = scores.reduce((sum, s) => sum + Math.pow(s - avgCols, 2), 0) / scores.length;
            delimiterScores[delimiter] = { avg: avgCols, variance };
        }

        // Default to tab, especially if tab has consistent columns > 1
        if (delimiterScores['\t'].avg > 1 && delimiterScores['\t'].variance === 0) {
            return '\t';
        }

        let bestDelimiter = '\t';
        let maxConsistentCols = 1;

        // Order of preference for fallbacks
        for (const delimiter of ['\t', ';', '|', ',']) {
            const stats = delimiterScores[delimiter];
            // Only consider delimiters that are perfectly consistent across all sample rows
            if (stats.variance === 0 && stats.avg > maxConsistentCols) {
                maxConsistentCols = stats.avg;
                bestDelimiter = delimiter;
            }
        }

        // If no perfectly consistent delimiter is found, stick to tab
        // (which implicitly means 1 column if variance was 0, or we just fallback)
        return bestDelimiter;
    }

    /**
     * Detect decimal delimiter from sample of first 100 rows
     * Must be called BEFORE analyze()
     */
    private detectDecimalDelimiter(): string {
        let dotCount = 0;
        let commaCount = 0;
        const sampleLimit = Math.min(100, this.lines.length - 1); // Skip header

        for (let i = 1; i <= sampleLimit; i++) {
            const line = this.lines[i];
            if (!line?.trim()) continue;

            const cells = line.split(this.delimiter);
            for (const cell of cells) {
                if (!cell?.trim()) continue;
                // Ignore spaces (like thousand separators) when guessing if it's a number
                const val = cell.trim().replace(/\s/g, '');
                if (/^\d+\.\d+$/.test(val)) dotCount++;
                if (/^\d+,\d+$/.test(val)) commaCount++;
            }
        }

        return (commaCount > dotCount && commaCount > 0) ? ',' : '.';
    }

    /**
     * Analyze data types - two-pass approach:
     * 1. Detect decimal delimiter from sample
     * 2. Initialize type choosers with correct delimiter
     * 3. Analyze all rows
     */
    private createColumnTypeChoosers(): ColumnTypeChooser[] {
        return this.headers.map(header =>
            new ColumnTypeChooser(this.decimalDelimiter, {
                forceText: headerForcesTextImportType(header),
                inferBoolean: this.inferBoolean,
            })
        );
    }

    async analyze(progressCallback?: ProgressCallback): Promise<void> {
        if (this.lines.length === 0) {
            throw new Error('No data to analyze');
        }

        progressCallback?.(`Auto-detected delimiter: '${this.delimiter === '\t' ? '\\t' : this.delimiter}'`);

        // First line is headers
        const headerLine = this.lines[0];
        if (!headerLine.trim()) {
            throw new Error('First line (headers) is empty');
        }

        this.headers = headerLine.split(this.delimiter).map(cell => cell.trim());
        const columnCount = this.headers.length;

        progressCallback?.(`Headers: ${columnCount} columns`);

        // PASS 1: Detect decimal delimiter from sample
        this.decimalDelimiter = this.detectDecimalDelimiter();
        progressCallback?.(`Detected decimal separator: '${this.decimalDelimiter}'`);

        // PASS 2: Initialize type choosers with correct delimiter and analyze all rows
        this.dataTypes = this.createColumnTypeChoosers();
        progressCallback?.(`Analyzing data types for ${(this.lines.length - 1).toLocaleString()} rows...`);

        for (let i = 1; i < this.lines.length; i++) {
            const line = this.lines[i];
            if (!line.trim()) continue;

            const cells = line.split(this.delimiter);

            for (let j = 0; j < Math.min(cells.length, columnCount); j++) {
                const value = cells[j]?.trim();
                if (value) {
                    this.dataTypes[j].refreshCurrentType(value);
                }
            }

            this.rowCount++;

            if (this.rowCount % 10000 === 0) {
                progressCallback?.(`Analyzed ${this.rowCount.toLocaleString()} rows...`, undefined, false);
                await delay();
            }
        }

        progressCallback?.(`Analysis complete: ${this.rowCount.toLocaleString()} data rows`);
    }

    getHeaders(): string[] {
        return this.headers;
    }

    getDataTypes(): ColumnTypeChooser[] {
        return this.dataTypes;
    }

    getDecimalDelimiter(): string {
        return this.decimalDelimiter;
    }

    getDelimiter(): string {
        return this.delimiter;
    }

    getRowCount(): number {
        return this.rowCount;
    }

    /**
     * Create iterator for data rows (excluding header)
     */
    *dataRowIterator(): Generator<string[], void, unknown> {
        const columnCount = this.headers.length;

        for (let i = 1; i < this.lines.length; i++) {
            const line = this.lines[i];
            if (!line.trim()) continue;

            const cells = line.split(this.delimiter).map(cell => cell.trim());

            // Normalize to column count
            while (cells.length < columnCount) {
                cells.push('');
            }

            yield cells.slice(0, columnCount);
        }
    }
}

/**
 * Clipboard data processor
 */
export class ClipboardDataProcessor {
    public constructor(private readonly options?: { inferBoolean?: boolean }) {}

    /**
     * Get clipboard text content using VS Code API
     */
    async getClipboardText(): Promise<string> {
        return await vscode.env.clipboard.readText();
    }

    /**
     * Analyze clipboard text data
     */
    async analyzeClipboardData(
        progressCallback?: ProgressCallback
    ): Promise<TextDataAnalyzer> {
        progressCallback?.('Getting clipboard data...');

        const rawData = await this.getClipboardText();

        if (!rawData) {
            throw new Error('No data found in clipboard');
        }

        progressCallback?.(`Data size: ${rawData.length.toLocaleString()} characters`);

        const analyzer = new TextDataAnalyzer(rawData, this.options);
        await analyzer.analyze(progressCallback);

        return analyzer;
    }
}

/**
 * Clean column name for SQL compatibility
 */
function cleanColumnName(colName: string): string {
    let cleanName = String(colName).trim();

    if (!cleanName) {
        return 'COL_EMPTY';
    }

    cleanName = cleanName.replace(/[^0-9a-zA-Z]+/g, '_').toUpperCase();

    if (!cleanName || /^\d/.test(cleanName) || cleanName.startsWith('_')) {
        cleanName = 'COL' + (cleanName.startsWith('_') ? '' : '_') + cleanName;
    }

    return cleanName;
}

/**
 * De-duplicate column names
 */
function deduplicateColumnNames(names: string[]): string[] {
    const seen = new Map<string, number>();
    const result: string[] = [];

    for (const name of names) {
        let uniqueName = name;
        const count = seen.get(name) || 0;

        if (count > 0) {
            uniqueName = `${name}_${count}`;
        }

        seen.set(name, count + 1);
        result.push(uniqueName);
    }

    return result;
}

/**
 * Escape special characters for Netezza import
 */
function escapeValue(val: string, escapechar: string, valuesToEscape: string[]): string {
    let result = String(val).trim();
    for (const char of valuesToEscape) {
        result = result.split(char).join(`${escapechar}${char}`);
    }
    return result;
}

/**
 * Truncate numeric value to specified scale (decimal places)
 * Example: truncateNumeric("0,661868517", 8, ",") -> "0,66186852"
 */
function truncateNumeric(value: string, scale: number, decimalDelimiter: string): string {
    if (!value || scale < 0) return value;

    const parts = value.split(decimalDelimiter);
    if (parts.length !== 2) return value;

    const integerPart = parts[0];
    const decimalPart = parts[1];

    // Truncate decimal part to scale
    if (decimalPart.length > scale) {
        return integerPart + decimalDelimiter + decimalPart.substring(0, scale);
    }

    return value;
}

/**
 * Format value according to column type
 */
function formatValue(
    val: string,
    colIndex: number,
    dataTypes: ColumnTypeChooser[],
    escapechar: string,
    valuesToEscape: string[],
    decimalDelimiter: string
): string {
    let result = escapeValue(val, escapechar, valuesToEscape);

    if (colIndex >= dataTypes.length) {
        return result;
    }

    const typeChooser = dataTypes[colIndex];
    const dbType = typeChooser.currentType.dbType;

    // Handle DATETIME
    if (dbType === 'DATETIME') {
        result = result.replace('T', ' ');

        // Reformat dd.mm.yyyy to yyyy-mm-dd
        const dateTimeMatch = result.match(
            /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/
        );
        if (dateTimeMatch) {
            const [, day, month, year, hour = '00', min = '00', sec = '00'] = dateTimeMatch;
            result = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${hour.padStart(2, '0')}:${min.padStart(2, '0')}:${sec.padStart(2, '0')}`;
        }
    }

    // Handle BIGINT and NUMERIC - remove spaces used as thousand separators
    if (dbType === 'BIGINT' || dbType === 'NUMERIC') {
        result = result.replace(/\s/g, '');
    }

    // Handle NUMERIC - replace comma with dot and truncate to declared scale
    if (dbType === 'NUMERIC') {
        // Truncate to declared scale before converting delimiter
        const scale = typeChooser.currentType.scale || typeChooser.getMaxScale();
        if (scale > 0) {
            result = truncateNumeric(result, scale, decimalDelimiter);
        }

        // Replace comma with dot for DB
        if (decimalDelimiter === ',') {
            result = result.replace(',', '.');
        }
    }

    return result;
}

/**
 * Streaming clipboard data generator
 * Generates formatted rows on-demand from text analyzer
 */
class StreamingClipboardDataStream extends Readable {
    private analyzer: TextDataAnalyzer;
    private dataTypes: ColumnTypeChooser[];
    private delimiter: string;
    private recordDelim: string;
    private escapechar: string;
    private valuesToEscape: string[];
    private decimalDelimiter: string;
    private progressCallback?: ProgressCallback;
    private rowIterator: Generator<string[], void, unknown> | null = null;
    private currentIndex: number = 0;
    private totalRows: number;
    private lastReportTime: number = 0;
    public byteLength: number = 0;

    constructor(
        analyzer: TextDataAnalyzer,
        dataTypes: ColumnTypeChooser[],
        delimiter: string,
        recordDelim: string,
        escapechar: string,
        valuesToEscape: string[],
        decimalDelimiter: string,
        progressCallback?: ProgressCallback
    ) {
        super();
        this.analyzer = analyzer;
        this.dataTypes = dataTypes;
        this.delimiter = delimiter;
        this.recordDelim = recordDelim;
        this.escapechar = escapechar;
        this.valuesToEscape = valuesToEscape;
        this.decimalDelimiter = decimalDelimiter;
        this.progressCallback = progressCallback;
        this.totalRows = analyzer.getRowCount();

        // Byte length unknown - streaming from generator
        this.byteLength = 0;

        this.rowIterator = this.analyzer.dataRowIterator();
    }

    private isReading = false;

    _read(_size: number): void {
        if (this.isReading) { return; }
        this.isReading = true;

        this._doRead();
    }

    private _doRead(): void {
        try {
            if (!this.rowIterator) {
                this.isReading = false;
                this.push(null);
                return;
            }

            let more = true;
            let batchCount = 0;
            const batchSize = 100; // Process 100 rows per batch

            while (more && batchCount < batchSize) {
                const result = this.rowIterator.next();

                if (result.done) {
                    this.isReading = false;
                    this.push(null);
                    return;
                }

                const row = result.value;
                const formattedRow = row.map((value, j) =>
                    formatValue(value, j, this.dataTypes, this.escapechar, this.valuesToEscape, this.decimalDelimiter)
                );

                const line = formattedRow.join(this.delimiter) + this.recordDelim;
                more = this.push(Buffer.from(line, 'utf8'));

                this.currentIndex++;
                batchCount++;

                // Yield control every 500 rows to prevent event loop blocking
                if (this.currentIndex % 500 === 0) {
                    this.isReading = false;
                    setImmediate(() => this._doRead());
                    return;
                }
            }

            // Report progress
            const now = Date.now();
            if (now - this.lastReportTime >= 1000) {
                const percent = Math.floor((this.currentIndex / this.totalRows) * 100);
                const message = `Streaming data: ${percent}% (${this.currentIndex.toLocaleString()}/${this.totalRows.toLocaleString()})`;
                this.progressCallback?.(message, undefined, false);
                this.lastReportTime = now;
            }

            this.isReading = false;
        } catch (e) {
            this.isReading = false;
            this.emit('error', e);
        }
    }
}

/**
 * Import clipboard data to Netezza table
 */
export async function importClipboardDataToNetezza(
    targetTable: string,
    connectionDetails: ConnectionDetails,
    _formatPreference?: string | null,
    _options?: unknown,
    progressCallback?: ProgressCallback
): Promise<ImportResult> {
    const startTime = Date.now();
    let virtualFileName: string | null = null;
    let connection: NzConnection | null = null;

    try {
        // Validate parameters
        if (!targetTable) {
            return {
                success: false,
                message: 'Target table name is required'
            };
        }

        if (!connectionDetails || !connectionDetails.host) {
            return {
                success: false,
                message: 'Connection details are required'
            };
        }

        progressCallback?.('Starting clipboard import process...');
        progressCallback?.(`  Target table: ${targetTable}`);

        // Analyze clipboard data
        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData(progressCallback);

        // Clean and deduplicate column names
        const rawHeaders = analyzer.getHeaders().map(col => cleanColumnName(col));
        const sqlHeaders = deduplicateColumnNames(rawHeaders);
        const dataTypes = analyzer.getDataTypes();
        const decimalDelimiter = analyzer.getDecimalDelimiter();
        const rowCount = analyzer.getRowCount();

        progressCallback?.(`Headers: ${sqlHeaders.length} columns`);
        progressCallback?.(`First few headers: ${sqlHeaders.slice(0, 5).join(', ')}...`);
        progressCallback?.(`Data rows: ${rowCount.toLocaleString()}`);

        // Validate
        if (sqlHeaders.length === 0) {
            throw new Error('No columns found in clipboard data');
        }

        if (rowCount === 0) {
            throw new Error('No data rows found in clipboard');
        }

        // Create streaming data source
        progressCallback?.('Creating data stream...');

        const delimiter = '\t';
        const recordDelim = '\n';
        const escapechar = '\\';
        const valuesToEscape = [escapechar, recordDelim, '\r', delimiter];

        const dataStream = new StreamingClipboardDataStream(
            analyzer,
            dataTypes,
            delimiter,
            recordDelim,
            escapechar,
            valuesToEscape,
            decimalDelimiter,
            progressCallback
        );

        // Create temp directory for logs
        const tempDir = path.join(require('os').tmpdir(), 'netezza_clipboard_logs');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        virtualFileName = `virtual_clipboard_import_${Date.now()}_${Math.floor(Math.random() * 1000)}.txt`;
        progressCallback?.(`Registered virtual stream: ${virtualFileName}`);

        // Register stream with driver
        const connectionConstructor = getDatabaseConnectionConstructor(connectionDetails.dbType);
        if (connectionConstructor.registerImportStream) {
            connectionConstructor.registerImportStream(virtualFileName, dataStream);
        } else {
            throw new Error('Active database driver does not support stream registry');
        }

        // Generate CREATE TABLE SQL
        const columns = sqlHeaders.map((header, i) =>
            `        ${header} ${dataTypes[i].currentType.toString()}`
        );

        //const logDirUnix = tempDir.replace(/\\/g, '/');
        const delimiterPlain = '\\t';
        const recordDelimPlain = '\\n';

        const createSql = `CREATE TABLE ${targetTable} AS 
(
    SELECT * FROM EXTERNAL '${virtualFileName}'
    (
${columns.join(',\n')}
    )
    USING
    (
        REMOTESOURCE 'jdbc'
        DELIMITER '${delimiterPlain}'
        RecordDelim '${recordDelimPlain}'
        ESCAPECHAR '${escapechar}'
        NULLVALUE ''
        ENCODING 'Utf-8'
        TIMESTYLE '24hour'
        BOOLSTYLE '1_0'
        SKIPROWS 0
        MAXERRORS 1
        COMPRESS FALSE
        LOGDIR '${tempDir}'
    )
) DISTRIBUTE ON RANDOM;`;

        progressCallback?.('Generated SQL (first 500 chars):');
        progressCallback?.(createSql.substring(0, 500) + '...');

        // Execute import
        progressCallback?.('Connecting to database...');

        connection = await createConnectedDatabaseConnectionFromDetails(connectionDetails);

        try {
            progressCallback?.('Executing CREATE TABLE with EXTERNAL clipboard data...');
            const cmd = connection!.createCommand(createSql);
            cmd.commandTimeout = 3600;
            await cmd.execute();
            progressCallback?.('Clipboard import completed successfully');
        } finally {
            await connection!.close();
        }

        const processingTime = (Date.now() - startTime) / 1000;

        return {
            success: true,
            message: 'Clipboard import completed successfully',
            details: {
                targetTable: targetTable,
                format: 'TEXT',
                rowsProcessed: rowCount,
                rowsInserted: rowCount,
                processingTime: `${processingTime.toFixed(1)}s`,
                columns: sqlHeaders.length,
                detectedDelimiter: analyzer.getDelimiter()
            }
        };
    } catch (e: unknown) {
        const processingTime = (Date.now() - startTime) / 1000;
        const errorMsg = e instanceof Error ? e.message : String(e);
        return {
            success: false,
            message: `Clipboard import failed: ${errorMsg}`,
            details: {
                processingTime: `${processingTime.toFixed(1)}s`
            }
        };
    } finally {
        if (connection?._connected) {
            try {
                await connection.close();
            } catch {
                // Ignore
            }
        }

        if (virtualFileName) {
            const connectionConstructor = getDatabaseConnectionConstructor(connectionDetails.dbType);
            if (connectionConstructor.unregisterImportStream) {
                connectionConstructor.unregisterImportStream(virtualFileName);
            }
        }
    }
}
