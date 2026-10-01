/**
 * Clipboard Data Importer for Netezza
 * Handles importing data from clipboard in text (tab-separated) format
 * Optimized for memory efficiency with streaming approach
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Readable } from 'stream';
import {
    ColumnTypeChooser,
    detectDelimitedTextDelimiter,
    iterateDelimitedRecords,
    ProgressCallback,
    ImportResult,
} from './dataImporter';
import { NzConnection, ConnectionDetails } from '../types';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import { headerForcesTextImportType } from './importTypeInferenceUtils';
import {
    buildNetezzaVirtualImportName,
    destroyNetezzaImportStream,
    registerNetezzaImportStream,
} from './netezzaVirtualImport';

// Helper to unblock event loop
const delay = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Streaming text data analyzer
 * Analyzes data types without storing all rows in memory
 */
class TextDataAnalyzer {
    private readonly textData: string;
    private delimiter: string;
    private headers: string[] = [];
    private dataTypes: ColumnTypeChooser[] = [];
    private decimalDelimiter: string = '.';
    private rowCount: number = 0;
    private readonly inferBoolean: boolean;

    constructor(textData: string, options?: { inferBoolean?: boolean }) {
        this.inferBoolean = options?.inferBoolean === true;
        this.textData = textData;
        this.delimiter = this.detectDelimiter(textData);
    }

    /**
     * Auto-detect delimiter
     */
    private detectDelimiter(textData: string): string {
        return detectDelimitedTextDelimiter(textData, ['\t', ';', '|', ','], '\t');
    }

    /**
     * Detect decimal delimiter from sample of first 100 rows
     * Must be called BEFORE analyze()
     */
    private detectDecimalDelimiter(): string {
        let dotCount = 0;
        let commaCount = 0;
        let dataRowsSampled = 0;
        let isHeader = true;

        for (const row of iterateDelimitedRecords(this.textData, this.delimiter)) {
            if (isHeader) {
                isHeader = false;
                continue;
            }
            if (dataRowsSampled >= 100) {
                break;
            }
            dataRowsSampled++;
            for (const cell of row) {
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
        const records = iterateDelimitedRecords(this.textData, this.delimiter);
        const headerRecord = records.next();
        if (headerRecord.done) {
            throw new Error('No data to analyze');
        }

        progressCallback?.(`Auto-detected delimiter: '${this.delimiter === '\t' ? '\\t' : this.delimiter}'`);

        // First line is headers
        const headerRow = headerRecord.value;
        if (headerRow.every(cell => !cell.trim())) {
            throw new Error('First line (headers) is empty');
        }

        this.headers = headerRow.map(cell => cell.replace(/^[\t ]+|[\t ]+$/g, ''));
        const columnCount = this.headers.length;

        progressCallback?.(`Headers: ${columnCount} columns`);

        // PASS 1: Detect decimal delimiter from sample
        this.decimalDelimiter = this.detectDecimalDelimiter();
        progressCallback?.(`Detected decimal separator: '${this.decimalDelimiter}'`);

        // PASS 2: Initialize type choosers with correct delimiter and analyze all rows
        this.dataTypes = this.createColumnTypeChoosers();
        progressCallback?.('Analyzing data types...');

        let isHeader = true;
        for (const cells of iterateDelimitedRecords(this.textData, this.delimiter)) {
            if (isHeader) {
                isHeader = false;
                continue;
            }

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

        let isHeader = true;
        for (const parsedCells of iterateDelimitedRecords(this.textData, this.delimiter)) {
            if (isHeader) {
                isHeader = false;
                continue;
            }
            const cells = parsedCells.slice(0, columnCount);

            // Normalize to column count
            while (cells.length < columnCount) {
                cells.push('');
            }

            yield cells;
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
    const hasTrailingLineBreak = /(?:\r\n|\r|\n)+\s*$/.test(colName);
    let cleanName = String(colName).replace(/\r\n|\r|\n/g, '_').trim();

    if (!cleanName) {
        return 'COL_EMPTY';
    }

    cleanName = cleanName.replace(/[^0-9a-zA-Z]+/g, '_').toUpperCase();
    if (!hasTrailingLineBreak) {
        cleanName = cleanName.replace(/_+$/g, '');
    }

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
    let result = String(val).replace(/\r/g, '');
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
    if (colIndex >= dataTypes.length) {
        return escapeValue(val, escapechar, valuesToEscape);
    }

    const typeChooser = dataTypes[colIndex];
    const dbType = typeChooser.currentType.dbType;
    const isTextType = /^(N?CHAR|N?VARCHAR|TEXT|CLOB)/.test(dbType);
    let result = escapeValue(isTextType ? val : val.trim(), escapechar, valuesToEscape);

    if (dbType === 'BOOLEAN') {
        if (/^true$/i.test(result)) result = '1';
        else if (/^false$/i.test(result)) result = '0';
    }

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
    private lastReportedPercent: number = 0;
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
                const increment = Math.max(0, percent - this.lastReportedPercent);
                this.lastReportedPercent = Math.max(this.lastReportedPercent, percent);
                const message = `Streaming data: ${percent}% (${this.currentIndex.toLocaleString()}/${this.totalRows.toLocaleString()})`;
                this.progressCallback?.(message, increment, false);
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
    let virtualFileName: string;
    let importStream: Readable | undefined;
    let unregisterImportStream: (() => void) | undefined;
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
        const tempDir = path.join(os.tmpdir(), 'netezza_clipboard_logs');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        importStream = dataStream;
        virtualFileName = buildNetezzaVirtualImportName('virtual_clipboard_import');
        unregisterImportStream = registerNetezzaImportStream(virtualFileName, importStream);
        progressCallback?.(`Registered virtual clipboard stream: ${virtualFileName}`);

        // Generate CREATE TABLE SQL
        const columns = sqlHeaders.map((header, i) =>
            `        ${header} ${dataTypes[i].currentType.toString()}`
        );

        const delimiterPlain = '\\t';
        const recordDelimPlain = '\\n';
        const logDirUnix = tempDir.replace(/\\/g, '/');

        const createSql = `CREATE TABLE ${targetTable} AS
(
    SELECT
${sqlHeaders.map(header => `        ${header}`).join(',\n')}
    FROM EXTERNAL '${virtualFileName}'
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
        LOGDIR '${logDirUnix}'
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

        unregisterImportStream?.();
        destroyNetezzaImportStream(importStream);
    }
}
