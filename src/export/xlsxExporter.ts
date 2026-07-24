import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { validateExportPath } from './exportUtils';
export { validateExportPath } from './exportUtils';
import { NzConnection, ConnectionDetails } from '../types';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import { getEffectiveResultColumnType } from '../core/streaming/resultColumnMetadata';
import { formatBinaryValue } from './binaryValue';
import { ExportCancelledError } from '../core/cancellation';
import {
    convertRowExcelNumericStrings,
    convertToExcelNumberIfNumericString,
    shouldConvertToExcelNumber
} from './excelNumericUtils';
const XlsxWriter = require('@justybase/spreadsheet-tasks').XlsxWriter as new (filePath: string) => {
    addSheet(sheetName: string, hidden?: boolean): void;
    writeSheet(rows: unknown[][], headers: string[] | null, doAutofilter?: boolean): void;
    // Streaming API methods
    startSheet(sheetName: string, columnCount: number, headers?: string[], options?: { hidden?: boolean; doAutofilter?: boolean }): void;
    writeRow(row: unknown[]): void;
    endSheet(): void;
    finalize(): Promise<void>;
};

/**
 * Progress callback function type
 */
export type ProgressCallback = (message: string) => void;

/**
 * Export result interface
 */
export interface ExportResult {
    success: boolean;
    message: string;
    details?: {
        rows_exported: number;
        columns: number;
        file_size_mb: number;
        file_path: string;
        clipboard_success?: boolean;
    };
}

/**
 * CSV export item interface
 */
export interface CsvExportItem {
    csv: string;
    sql?: string;
    name: string;
}

/**
 * Structured export item with column types (used by Grid export)
 */
export interface StructuredExportItem {
    columns: { name: string; type?: string }[];
    rows: Iterable<unknown[]>;
    sql?: string;
    name: string;
    isActive?: boolean;
}

/**
 * Remove CR, LF and TAB from the beginning and end of a string,
 * while preserving regular spaces so SQL indentation is kept.
 */
function trimCRLFTab(s: string): string {
    return s.replace(/^[\r\n\t]+|[\r\n\t]+$/g, '');
}

/**
 * Export CSV content to XLSX file
 * @param csvContent CSV content as string or array of CsvExportItems
 * @param outputPath Path where to save the XLSX file
 * @param copyToClipboard If true, also copy file to clipboard (Windows only)
 * @param metadata Optional metadata (source info, etc.)
 * @param progressCallback Optional callback for progress updates
 * @returns Export result with success status and details
 */
export async function exportCsvToXlsx(
    csvContent: string | CsvExportItem[],
    outputPath: string,
    copyToClipboard: boolean = false,
    metadata: { source: string; sql?: string } = { source: 'Unknown' },
    progressCallback?: ProgressCallback
): Promise<ExportResult> {
    try {
        // Pre-validate export path
        validateExportPath(outputPath);

        if (progressCallback) {
            progressCallback('Initializing XLSX writer...');
        }

        const writer = new XlsxWriter(outputPath);

        let totalRows = 0;
        let totalColumns = 0;
        const sqlItems: { name: string; sql: string }[] = [];

        // Helper to process a single CSV string using streaming API
        const processCsv = (csv: string, sheetName: string) => {
            const lines = csv.split(/\r?\n/);

            // Simple regex parser for CSV lines
            const parseCsvLine = (line: string): string[] => {
                const result = [];
                let start = 0;
                let inQuotes = false;
                for (let i = 0; i < line.length; i++) {
                    if (line[i] === '"') {
                        inQuotes = !inQuotes;
                    } else if (line[i] === ',' && !inQuotes) {
                        let field = line.substring(start, i);
                        if (field.startsWith('"') && field.endsWith('"')) {
                            field = field.substring(1, field.length - 1).replace(/""/g, '"');
                        }
                        result.push(field);
                        start = i + 1;
                    }
                }
                let field = line.substring(start);
                if (field.startsWith('"') && field.endsWith('"')) {
                    field = field.substring(1, field.length - 1).replace(/""/g, '"');
                }
                result.push(field);
                return result;
            };

            // Find first non-empty line for headers
            let headerIndex = 0;
            while (headerIndex < lines.length && !lines[headerIndex].trim()) {
                headerIndex++;
            }

            if (headerIndex >= lines.length) return;

            const headers = parseCsvLine(lines[headerIndex]);
            if (headers.length === 0) return;

            totalColumns = Math.max(totalColumns, headers.length);

            // Start streaming sheet with headers
            writer.startSheet(sheetName, headers.length, headers, { doAutofilter: true });

            let currentRowCount = 0;

            // Stream data rows
            for (let i = headerIndex + 1; i < lines.length; i++) {
                const line = lines[i];
                if (!line.trim()) continue;

                const fields = parseCsvLine(line);
                // Convert numeric strings to numbers and write immediately
                writer.writeRow(convertRowExcelNumericStrings(fields));
                currentRowCount++;

                if (currentRowCount % 10000 === 0 && progressCallback) {
                    progressCallback(`Streaming ${currentRowCount.toLocaleString()} rows to "${sheetName}"...`);
                }
            }

            writer.endSheet();
            totalRows += currentRowCount;
        };

        if (Array.isArray(csvContent)) {
            // Multiple results
            if (progressCallback) {
                progressCallback(`Processing ${csvContent.length} result sets...`);
            }

            csvContent.forEach((item, index) => {
                const sheetName = item.name || `Result ${index + 1}`;
                if (progressCallback) {
                    progressCallback(`Processing sheet "${sheetName}"...`);
                }
                processCsv(item.csv, sheetName);
                if (item.sql) {
                    sqlItems.push({ name: sheetName, sql: item.sql });
                }
            });
        } else {
            // Single result (legacy)
            if (progressCallback) {
                progressCallback('Reading CSV content...');
            }
            processCsv(csvContent, 'Query Results');
            if (metadata.sql) {
                sqlItems.push({ name: 'Query Results', sql: metadata.sql });
            }
        }

        // Add SQL Code sheet if we have any SQL (using streaming API)
        if (sqlItems.length > 0) {
            writer.startSheet('SQL Code', 1, undefined, { doAutofilter: false });

            sqlItems.forEach(item => {
                writer.writeRow([`--- SQL for ${item.name} ---`]);
                item.sql.split('\n').forEach(line => {
                    writer.writeRow([trimCRLFTab(line)]);
                });
                writer.writeRow(['']); // Spacer
            });

            writer.endSheet();
        }

        if (progressCallback) {
            progressCallback('Finalizing XLSX file...');
        }
        await writer.finalize();

        // Check file size
        const stats = fs.statSync(outputPath);
        const fileSizeMb = stats.size / (1024 * 1024);

        if (progressCallback) {
            progressCallback(`XLSX file created successfully`);
            progressCallback(`  - Rows: ${totalRows.toLocaleString()}`);
            progressCallback(`  - File size: ${fileSizeMb.toFixed(1)} MB`);
        }

        const exportResult: ExportResult = {
            success: true,
            message: `Successfully exported ${totalRows} rows to ${outputPath}`,
            details: {
                rows_exported: totalRows,
                columns: totalColumns,
                file_size_mb: parseFloat(fileSizeMb.toFixed(1)),
                file_path: outputPath
            }
        };

        // Copy to clipboard logic if needed
        if (copyToClipboard) {
            if (progressCallback) {
                progressCallback('Copying file to clipboard...');
            }
            const clipboardSuccess = await copyFileToClipboard(outputPath);
            if (exportResult.details) {
                exportResult.details.clipboard_success = clipboardSuccess;
            }
        }

        return exportResult;
    } catch (err: unknown) {
        if (err instanceof ExportCancelledError) {
            throw err;
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            message: `Export failed: ${errorMsg}`
        };
    }
}

/**
 * Export structured data (with column types) to XLSX file.
 * This is used by Grid exports where we have type metadata from the database.
 * Uses streaming API to avoid loading all rows into memory.
 * @param items Structured export items with columns, rows, and type metadata
 * @param outputPath Path where to save the XLSX file
 * @param copyToClipboard If true, also copy file to clipboard (Windows only)
 * @param progressCallback Optional callback for progress updates
 * @returns Export result with success status and details
 */
export async function exportStructuredToXlsx(
    items: StructuredExportItem[],
    outputPath: string,
    copyToClipboard: boolean = false,
    progressCallback?: ProgressCallback,
    cancellationToken?: vscode.CancellationToken,
): Promise<ExportResult> {
    try {
        // Pre-validate export path
        validateExportPath(outputPath);

        if (cancellationToken?.isCancellationRequested) {
            throw new ExportCancelledError(outputPath, 0);
        }

        if (progressCallback) {
            progressCallback('Initializing XLSX writer...');
        }

        const writer = new XlsxWriter(outputPath);
        let totalRows = 0;
        let totalColumns = 0;
        let wasCancelled = false;
        const sqlItems: { name: string; sql: string }[] = [];

        for (const item of items) {
            const sheetName = item.name || 'Sheet';
            if (progressCallback) {
                progressCallback(`Processing sheet "${sheetName}"...`);
            }

            const headers = item.columns.map(c => c.name);
            const colIsNumeric = item.columns.map(c => shouldConvertToExcelNumber(c.type));

            totalColumns = Math.max(totalColumns, headers.length);

            // Skip empty items (no columns means no data to export)
            if (headers.length === 0) {
                if (progressCallback) {
                    progressCallback(`Skipping empty sheet "${sheetName}"...`);
                }
                continue;
            }

            // Start streaming sheet with headers
            writer.startSheet(sheetName, headers.length, headers, { doAutofilter: true });

            let sheetRows = 0;
            // Write rows with type-aware conversion (streaming - one row at a time)
            for (const row of item.rows) {
                if (cancellationToken?.isCancellationRequested) {
                    wasCancelled = true;
                    break;
                }
                const processedRow = row.map((val, i) => {
                    const binaryValue = formatBinaryValue(val);
                    if (binaryValue) return binaryValue;
                    if (colIsNumeric[i]) {
                        return convertToExcelNumberIfNumericString(val, item.columns[i]?.type);
                    }
                    return val;
                });
                writer.writeRow(processedRow);
                totalRows++;
                sheetRows++;

                if (sheetRows % 10000 === 0 && progressCallback) {
                    progressCallback(`Streaming ${sheetRows.toLocaleString()} rows to "${sheetName}"...`);
                }
            }

            writer.endSheet();

            if (wasCancelled) break;

            if (item.sql) {
                sqlItems.push({ name: sheetName, sql: item.sql });
            }
        }

        // Add SQL Code sheet if we have any SQL (using streaming API)
        if (sqlItems.length > 0) {
            writer.startSheet('SQL Code', 1, undefined, { doAutofilter: false });
            sqlItems.forEach(item => {
                writer.writeRow([`--- SQL for ${item.name} ---`]);
                item.sql.split('\n').forEach(line => {
                    writer.writeRow([trimCRLFTab(line)]);
                });
                writer.writeRow(['']); // Spacer
            });
            writer.endSheet();
        }

        if (progressCallback) {
            progressCallback('Finalizing XLSX file...');
        }
        await writer.finalize();

        if (wasCancelled) {
            throw new ExportCancelledError(outputPath, totalRows);
        }

        const stats = fs.statSync(outputPath);
        const fileSizeMb = stats.size / (1024 * 1024);

        if (progressCallback) {
            progressCallback(`XLSX file created successfully`);
            progressCallback(`  - Rows: ${totalRows.toLocaleString()}`);
            progressCallback(`  - File size: ${fileSizeMb.toFixed(1)} MB`);
        }

        const exportResult: ExportResult = {
            success: true,
            message: `Successfully exported ${totalRows} rows to ${outputPath}`,
            details: {
                rows_exported: totalRows,
                columns: totalColumns,
                file_size_mb: parseFloat(fileSizeMb.toFixed(1)),
                file_path: outputPath
            }
        };

        if (copyToClipboard) {
            if (progressCallback) {
                progressCallback('Copying file to clipboard...');
            }
            const clipboardSuccess = await copyFileToClipboard(outputPath);
            if (exportResult.details) {
                exportResult.details.clipboard_success = clipboardSuccess;
            }
        }

        return exportResult;
    } catch (err: unknown) {
        if (err instanceof ExportCancelledError) {
            throw err;
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            message: `Export failed: ${errorMsg}`
        };
    }
}

/**
 * Export SQL query results directly to XLSX file (streaming from database).
 * Mirrors exportQueryToXlsb but produces XLSX output.
 * @param connectionDetails Database connection details
 * @param query SQL query to execute
 * @param outputPath Path where to save the XLSX file
 * @param copyToClipboard If true, also copy file to clipboard (Windows only)
 * @param progressCallback Optional callback for progress updates
 * @param timeout Optional query timeout in seconds
 * @param cancellationToken Optional cancellation token to abort export
 * @returns Export result with success status and details
 */
export async function exportQueryToXlsx(
    connectionDetails: ConnectionDetails,
    query: string,
    outputPath: string,
    copyToClipboard: boolean = false,
    progressCallback?: ProgressCallback,
    timeout?: number,
    cancellationToken?: vscode.CancellationToken
): Promise<ExportResult> {
    let connection: NzConnection | null = null;

    try {
        // Pre-validate export path
        validateExportPath(outputPath);

        // Check cancellation before starting
        if (cancellationToken?.isCancellationRequested) {
            throw new ExportCancelledError(outputPath, 0);
        }

        // Connect to database
        if (progressCallback) {
            progressCallback('Connecting to database...');
        }

        connection = await createConnectedDatabaseConnectionFromDetails(connectionDetails);

        // Use XlsxWriter
        const writer = new XlsxWriter(outputPath);

        // Split queries
        const { SqlParser } = await import('../sql/sqlParser');
        const queries = SqlParser.splitStatements(query);

        let totalRows = 0;
        let totalCols = 0;
        let wasCancelled = false;

        for (let qIndex = 0; qIndex < queries.length; qIndex++) {
            const currentQuery = queries[qIndex];
            if (!currentQuery.trim()) continue;

            const sheetName = queries.length > 1 ? `Result ${qIndex + 1}` : 'Query Results';

            if (progressCallback) {
                progressCallback(`Executing query ${qIndex + 1}/${queries.length}...`);
            }

            try {
                const cmd = connection!.createCommand(currentQuery);
                if (timeout) {
                    cmd.commandTimeout = timeout;
                }

                // Set up cancellation listener
                let cancelListener: vscode.Disposable | undefined;
                if (cancellationToken) {
                    cancelListener = cancellationToken.onCancellationRequested(async () => {
                        wasCancelled = true;
                        if (progressCallback) {
                            progressCallback('Cancelling query...');
                        }
                        try {
                            await cmd.cancel();
                        } catch (cancelErr) {
                            console.error('Error cancelling command:', cancelErr);
                        }
                    });
                }

                let reader: { close(): Promise<void>; fieldCount: number; getName(i: number): string; getTypeName(i: number): string; getValue(i: number): unknown; read(): Promise<boolean> } | null = null;
                try {
                    reader = await cmd.executeReader();

                    // Prepare headers
                    const headers: string[] = [];
                    const columnTypes: Array<string | undefined> = [];
                    const colIsNumeric: boolean[] = [];

                    for (let i = 0; i < reader.fieldCount; i++) {
                        headers.push(reader.getName(i));
                        try {
                            const typeName = getEffectiveResultColumnType(reader, i) || reader.getTypeName(i);
                            columnTypes.push(typeName);
                            colIsNumeric.push(shouldConvertToExcelNumber(typeName));
                        } catch {
                            columnTypes.push(undefined);
                            colIsNumeric.push(false);
                        }
                    }

                    const columnCount = headers.length;
                    totalCols = Math.max(totalCols, columnCount);

                    // Skip empty result sets
                    if (columnCount === 0) {
                        if (progressCallback) {
                            progressCallback(`Skipping empty result set for query ${qIndex + 1}`);
                        }
                        await reader.close();
                        continue;
                    }

                    // Start streaming sheet with headers
                    writer.startSheet(sheetName, columnCount, headers, { doAutofilter: true });

                    let rowCount = 0;

                    try {
                        while (await reader.read()) {
                            if (wasCancelled || cancellationToken?.isCancellationRequested) {
                                wasCancelled = true;
                                if (progressCallback) {
                                    progressCallback(`Export cancelled - finalizing ${rowCount.toLocaleString()} rows...`);
                                }
                                break;
                            }

                            const row: unknown[] = [];
                            for (let i = 0; i < reader.fieldCount; i++) {
                                let val = reader.getValue(i);
                                const binaryValue = formatBinaryValue(val);
                                if (binaryValue) {
                                    val = binaryValue;
                                } else if (colIsNumeric[i]) {
                                    val = convertToExcelNumberIfNumericString(val, columnTypes[i]);
                                }
                                row.push(val);
                            }
                            writer.writeRow(row);
                            rowCount++;

                            // Yield every 500 rows for cancellation to work
                            if (rowCount % 500 === 0) {
                                await new Promise(resolve => setImmediate(resolve));
                                if (wasCancelled) {
                                    if (progressCallback) {
                                        progressCallback(`Export cancelled - finalizing ${rowCount.toLocaleString()} rows...`);
                                    }
                                    break;
                                }
                            }

                            // Progress update every 10000 rows
                            if (rowCount % 10000 === 0 && progressCallback) {
                                progressCallback(`Streaming ${rowCount.toLocaleString()} rows to "${sheetName}"...`);
                            }
                        }
                    } catch (readErr: unknown) {
                        const readErrMsg = readErr instanceof Error ? readErr.message : String(readErr);
                        if (!wasCancelled && progressCallback) {
                            progressCallback(`Read error after ${rowCount} rows: ${readErrMsg}`);
                        }
                    }

                    writer.endSheet();
                    totalRows += rowCount;

                    if (progressCallback) {
                        const status = wasCancelled ? '(cancelled)' : '';
                        progressCallback(`Written ${rowCount.toLocaleString()} rows to sheet "${sheetName}" ${status}`);
                    }

                    if (wasCancelled) {
                        if (reader) {
                            await reader.close();
                        }
                        break;
                    }
                } finally {
                    if (cancelListener) {
                        cancelListener.dispose();
                    }
                    if (reader) {
                        try {
                            await reader.close();
                        } catch {
                            // Ignore close errors
                        }
                    }
                }
            } catch (err: unknown) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                writer.startSheet(`Error ${qIndex + 1}`, 1, ['Error'], { doAutofilter: false });
                writer.writeRow([`Error executing query: ${errorMsg}`]);
                writer.endSheet();
            }
        }

        // Final sheet: SQL Code
        const sqlLines = query.split('\n');
        writer.startSheet('SQL Code', 1, undefined, { doAutofilter: false });
        writer.writeRow(['SQL Query:']);
        for (const line of sqlLines) {
            writer.writeRow([trimCRLFTab(line)]);
        }
        writer.endSheet();

        if (progressCallback) {
            progressCallback('Finalizing XLSX file...');
        }
        await writer.finalize();

        if (wasCancelled) {
            throw new ExportCancelledError(outputPath, totalRows);
        }

        const stats = fs.statSync(outputPath);
        const fileSizeMb = stats.size / (1024 * 1024);

        if (progressCallback) {
            if (wasCancelled) {
                progressCallback(`XLSX file created with partial data (export was cancelled)`);
            } else {
                progressCallback(`XLSX file created successfully`);
            }
            progressCallback(`  - Total Rows: ${totalRows.toLocaleString()}`);
            progressCallback(`  - File size: ${fileSizeMb.toFixed(1)} MB`);
            progressCallback(`  - Location: ${outputPath}`);
        }

        const exportResult: ExportResult = {
            success: true,
            message: wasCancelled
                ? `Export cancelled - saved ${totalRows} rows to ${outputPath}`
                : `Successfully exported ${totalRows} rows to ${outputPath}`,
            details: {
                rows_exported: totalRows,
                columns: totalCols,
                file_size_mb: parseFloat(fileSizeMb.toFixed(1)),
                file_path: outputPath
            }
        };

        if (copyToClipboard) {
            if (progressCallback) {
                progressCallback('Copying to clipboard...');
            }
            const clipboardSuccess = await copyFileToClipboard(outputPath);
            if (exportResult.details) {
                exportResult.details.clipboard_success = clipboardSuccess;
            }
        }

        return exportResult;
    } catch (error: unknown) {
        if (error instanceof ExportCancelledError) {
            throw error;
        }
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            message: `Export error: ${errorMsg}`
        };
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch {
                // Ignore close errors
            }
        }
    }
}

/**
 * Copy file to Windows clipboard using PowerShell
 */
export async function copyFileToClipboard(filePath: string): Promise<boolean> {
    if (os.platform() !== 'win32') {
        console.error('Clipboard file copy is only supported on Windows');
        return false;
    }

    return new Promise<boolean>(resolve => {
        try {
            const normalizedPath = path.normalize(path.resolve(filePath));
            const powershellCommand = `Set-Clipboard -Path "${normalizedPath.replace(/"/g, '`"')}"`;

            const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershellCommand]);

            let errorOutput = '';

            ps.stderr.on('data', (data: Buffer) => {
                errorOutput += data.toString();
            });

            ps.on('close', (code: number) => {
                if (code !== 0) {
                    console.error(`PowerShell clipboard copy failed: ${errorOutput}`);
                    resolve(false);
                } else {
                    console.log(`File copied to clipboard: ${normalizedPath}`);
                    resolve(true);
                }
            });

            ps.on('error', (err: Error) => {
                console.error(`Error spawning PowerShell: ${err.message}`);
                resolve(false);
            });
        } catch (error: unknown) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error(`Error copying file to clipboard: ${errorMsg}`);
            resolve(false);
        }
    });
}

/**
 * Generate temporary file path for XLSX file
 */
export function getTempFilePath(): string {
    const tempDir = os.tmpdir();
    const timestamp = Date.now();
    const tempFilename = `netezza_export_${timestamp}.xlsx`;
    return path.join(tempDir, tempFilename);
}
