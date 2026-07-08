import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { NzConnection, ConnectionDetails } from '../types';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import { getEffectiveResultColumnType } from '../core/streaming/resultColumnMetadata';
import { validateExportPath } from './exportUtils';
import {
    formatParquetRow,
    writeParquetRows,
    type ParquetColumnSpec,
} from './parquetHyparquet';

export type ProgressCallback = (message: string) => void;

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

export interface StructuredExportItem {
    columns: { name: string; type?: string; scale?: number }[];
    rows: unknown[][];
    sql?: string;
    name: string;
}

function buildRowIterable(
    items: StructuredExportItem[]
): { columns: ParquetColumnSpec[]; rows: Iterable<Record<string, unknown>>; totalRows: number } {
    const firstItem = items.find(item => item.columns.length > 0);
    if (!firstItem) {
        return { columns: [], rows: [], totalRows: 0 };
    }

    const columns = firstItem.columns;
    const columnIndices = columns.map((_, i) => i);

    function* generateRows(): Iterable<Record<string, unknown>> {
        for (const item of items) {
            if (!item.columns.length) continue;
            for (const row of item.rows) {
                yield formatParquetRow(columns, row, columnIndices);
            }
        }
    }

    const totalRows = items.reduce((sum, item) => sum + item.rows.length, 0);
    return { columns, rows: generateRows(), totalRows };
}

export async function exportStructuredToParquet(
    items: StructuredExportItem[],
    outputPath: string,
    copyToClipboard: boolean = false,
    progressCallback?: ProgressCallback
): Promise<ExportResult> {
    try {
        validateExportPath(outputPath);

        if (progressCallback) {
            progressCallback('Initializing Parquet writer...');
        }

        const { columns, rows, totalRows } = buildRowIterable(items);
        if (columns.length === 0) {
            return {
                success: false,
                message: 'Export failed: no columns to export',
            };
        }

        if (items.length > 1 && progressCallback) {
            progressCallback('Note: Parquet export combines all result sets into one file.');
        }

        let writtenRows = 0;
        async function* trackedRows(): AsyncIterable<Record<string, unknown>> {
            for (const row of rows) {
                writtenRows++;
                if (writtenRows % 10000 === 0 && progressCallback) {
                    progressCallback(`Streaming ${writtenRows.toLocaleString()} rows...`);
                }
                yield row;
            }
        }

        if (progressCallback) {
            progressCallback(`Processing ${totalRows.toLocaleString()} rows...`);
        }

        await writeParquetRows(outputPath, columns, trackedRows());

        const stats = fs.statSync(outputPath);
        const fileSizeMb = stats.size / (1024 * 1024);

        if (progressCallback) {
            progressCallback('Parquet file created successfully');
            progressCallback(`  - Rows: ${totalRows.toLocaleString()}`);
            progressCallback(`  - File size: ${fileSizeMb.toFixed(1)} MB`);
        }

        const exportResult: ExportResult = {
            success: true,
            message: `Successfully exported ${totalRows} rows to ${outputPath}`,
            details: {
                rows_exported: totalRows,
                columns: columns.length,
                file_size_mb: parseFloat(fileSizeMb.toFixed(1)),
                file_path: outputPath,
            },
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
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            message: `Export failed: ${errorMsg}`,
        };
    }
}

export async function exportQueryToParquet(
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
        validateExportPath(outputPath);

        if (cancellationToken?.isCancellationRequested) {
            throw new Error('Export cancelled by user');
        }

        if (progressCallback) {
            progressCallback('Connecting to database...');
        }

        connection = await createConnectedDatabaseConnectionFromDetails(connectionDetails);

        const { SqlParser } = await import('../sql/sqlParser');
        const queries = SqlParser.splitStatements(query);

        let totalRows = 0;
        let totalCols = 0;
        let wasCancelled = false;
        let exportColumns: ParquetColumnSpec[] | null = null;

        async function* generateQueryRows(): AsyncGenerator<Record<string, unknown>> {
            for (let qIndex = 0; qIndex < queries.length; qIndex++) {
                const currentQuery = queries[qIndex];
                if (!currentQuery.trim()) continue;

                if (progressCallback) {
                    progressCallback(`Executing query ${qIndex + 1}/${queries.length}...`);
                }

                const cmd = connection!.createCommand(currentQuery);
                if (timeout) {
                    cmd.commandTimeout = timeout;
                }

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

                let reader: {
                    close(): Promise<void>;
                    fieldCount: number;
                    getName(i: number): string;
                    getTypeName(i: number): string;
                    getValue(i: number): unknown;
                    read(): Promise<boolean>;
                } | null = null;

                try {
                    reader = await cmd.executeReader();
                    const activeReader = reader;

                    const columns: ParquetColumnSpec[] = [];
                    for (let i = 0; i < activeReader.fieldCount; i++) {
                        let dbType: string | undefined;
                        try {
                            dbType = getEffectiveResultColumnType(activeReader, i) || activeReader.getTypeName(i);
                        } catch {
                            dbType = undefined;
                        }
                        columns.push({ name: activeReader.getName(i), type: dbType });
                    }

                    totalCols = Math.max(totalCols, columns.length);

                    if (columns.length === 0) {
                        if (progressCallback) {
                            progressCallback(`Skipping empty result set for query ${qIndex + 1}`);
                        }
                        await reader.close();
                        continue;
                    }

                    if (!exportColumns) {
                        exportColumns = columns;
                    }

                    let rowCount = 0;

                    try {
                        while (await activeReader.read()) {
                            if (wasCancelled || cancellationToken?.isCancellationRequested) {
                                wasCancelled = true;
                                if (progressCallback) {
                                    progressCallback(`Export cancelled - finalizing ${totalRows.toLocaleString()} rows...`);
                                }
                                return;
                            }

                            const rowValues = Array.from({ length: activeReader.fieldCount }, (_, i) => activeReader.getValue(i));
                            yield formatParquetRow(
                                columns,
                                rowValues,
                                columns.map((_, i) => i)
                            );
                            rowCount++;
                            totalRows++;

                            if (rowCount % 500 === 0) {
                                await new Promise(resolve => setImmediate(resolve));
                            }

                            if (rowCount % 10000 === 0 && progressCallback) {
                                progressCallback(`Streaming ${totalRows.toLocaleString()} rows...`);
                            }
                        }
                    } catch (readErr: unknown) {
                        const readErrMsg = readErr instanceof Error ? readErr.message : String(readErr);
                        if (!wasCancelled && progressCallback) {
                            progressCallback(`Read error after ${rowCount} rows: ${readErrMsg}`);
                        }
                    }

                    if (progressCallback) {
                        const status = wasCancelled ? '(cancelled)' : '';
                        progressCallback(`Written ${rowCount.toLocaleString()} rows ${status}`);
                    }

                    if (wasCancelled) {
                        return;
                    }
                } catch (err: unknown) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    if (progressCallback) {
                        progressCallback(`Error executing query ${qIndex + 1}: ${errorMsg}`);
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
            }
        }

        const rowStream = generateQueryRows();
        const firstRow = await rowStream.next();
        const columnsForWrite = exportColumns ?? [];

        if (columnsForWrite.length === 0 && firstRow.done) {
            return {
                success: false,
                message: 'Export failed: query returned no columns',
            };
        }

        async function* allRows(): AsyncGenerator<Record<string, unknown>> {
            if (!firstRow.done) {
                yield firstRow.value;
            }
            for await (const row of rowStream) {
                yield row;
            }
        }

        if (progressCallback) {
            progressCallback('Finalizing Parquet file...');
        }

        await writeParquetRows(outputPath, columnsForWrite, allRows(), { rowGroupSize: 65536 });

        const stats = fs.statSync(outputPath);
        const fileSizeMb = stats.size / (1024 * 1024);

        if (progressCallback) {
            if (wasCancelled) {
                progressCallback('Parquet file created with partial data (export was cancelled)');
            } else {
                progressCallback('Parquet file created successfully');
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
                file_path: outputPath,
            },
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
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            message: `Export error: ${errorMsg}`,
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

export function getTempFilePath(): string {
    const tempDir = os.tmpdir();
    const timestamp = Date.now();
    const tempFilename = `netezza_export_${timestamp}.parquet`;
    return path.join(tempDir, tempFilename);
}
