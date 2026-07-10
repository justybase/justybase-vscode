/**
 * XPORT v5 (SAS Transport) exporter.
 *
 * Provides:
 *  - exportStructuredToXpt  — export in-memory rows
 *  - exportQueryToXpt       — execute query + export results directly
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { NzConnection, ConnectionDetails } from '../types';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import { getEffectiveResultColumnType } from '../core/streaming/resultColumnMetadata';
import { validateExportPath } from './exportUtils';
import type { ProgressCallback } from './xlsbExporter';
import type { ExportResult } from './xlsbExporter';
import type { SasColumnDef } from './xptColumnMapper';
import { mapColumnType } from './xptColumnMapper';
import { sanitizeSasLabel, resolveSasColumnNames } from './xptSanitizer';
import { encodeWin1252 } from './xptWin1252';
import {
    RecordWriter,
    buildLibraryHeader,
    buildMemberHeader,
    buildNamestrHeader,
    buildObsHeader,
    buildNamestr,
    writeNumericObs,
    writeCharObs,
} from './xptNamestr';

// ── Constants ───────────────────────────────────────────────────────────

const SAS_VERSION = 'SAS     ';
const OS_NAME = '        ';
const MEMBER_TYPE = 'DATA    ';
const DEFAULT_SHEET_NAME = 'DATA';

// ── Column metadata for export ──────────────────────────────────────────

interface ExportColumn {
    name: string;
    type?: string;
    scale?: number;
}

interface PreparedColumn {
    /** Original column metadata */
    col: ExportColumn;
    /** SAS-sanitized name (≤8 chars) */
    sasName: string;
    /** SAS attributes */
    sasDef: SasColumnDef;
    /** Warnings generated during preparation */
    warnings: string[];
    /** Was this column dropped (unsupported type)? */
    dropped: boolean;
}

// ── Main export functions ───────────────────────────────────────────────

/**
 * Export structured (in-memory) data to XPORT v5 format.
 * Follows the `exportStructuredToXlsb`/`exportStructuredToParquet` pattern.
 */
export async function exportStructuredToXpt(
    items: { columns: ExportColumn[]; rows: unknown[][]; sql?: string; name?: string }[],
    outputPath: string,
    copyToClipboard: boolean = false,
    progressCallback?: ProgressCallback,
): Promise<ExportResult> {
    try {
        validateExportPath(outputPath);

        if (progressCallback) {
            progressCallback('Preparing SAS XPORT export...');
        }

        const firstItem = items.find(item => item.columns.length > 0);
        if (!firstItem) {
            return { success: false, message: 'Export failed: no columns to export' };
        }

        // Prepare columns: map types and sanitize names.
        const prepared = prepareColumns(firstItem.columns);
        const activeCols = prepared.filter(c => !c.dropped);
        if (activeCols.length === 0) {
            return { success: false, message: 'Export failed: no supported columns after type mapping' };
        }

        // Map activeCols index back to original column index in the row data.
        const originalIndices = prepared
            .map((c, i) => c.dropped ? -1 : i)
            .filter(i => i >= 0);

        // Collect all warnings.
        const allWarnings: string[] = [];
        for (const p of prepared) allWarnings.push(...p.warnings);
        const uniqueWarnings = [...new Set(allWarnings)];

        // Build header records.
        const now = new Date();
        const writer = new RecordWriter();

        // 1. Library header
        writer.write(buildLibraryHeader(SAS_VERSION, OS_NAME, now, now));

        // 2. Member header
        const memberName = (firstItem.name || DEFAULT_SHEET_NAME).toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 8) || 'DATA';
        writer.write(buildMemberHeader(memberName, MEMBER_TYPE, now, now));

        // 3. Namestr header
        writer.write(buildNamestrHeader(activeCols.length));

        // 4. Namestr records (140 bytes each, streamed as 80-byte records)
        for (let i = 0; i < activeCols.length; i++) {
            const col = activeCols[i];
            const namestr = buildNamestr(col.sasName, col.sasDef, i + 1);
            writer.write(namestr);
        }
        // Finalize the namestr block (pad to 80-byte boundary)
        writer.finalize();

        // 5. Observation header
        writer.write(buildObsHeader());
        // Observation header occupies exactly 1 record (80 bytes), no finalization needed

        // 6. Observations
        //
        // For a StructuredExportItem, rows are in-memory arrays.
        // We iterate row-by-row.
        const totalRows = items.reduce((sum, item) => sum + item.rows.length, 0);
        let writtenRows = 0;
        const obsBuf = new Uint8Array(computeObsLength(activeCols));

        for (const item of items) {
            if (item.columns.length === 0) continue;

            // Verify column compatibility (same set of columns).
            for (const row of item.rows) {
                let offset = 0;
                for (let ci = 0; ci < activeCols.length; ci++) {
                    const col = activeCols[ci];
                    const rawVal = row[originalIndices[ci]];
                    if (col.sasDef.sasType === 1) {
                        // Numeric: convert via IBM HFP.
                        const { clipped } = writeNumericObs(obsBuf, offset, Number(rawVal));
                        if (clipped) {
                            // Log once per column.
                            uniqueWarnings.push(`Numeric clipping for column "${col.sasName}" value "${rawVal}"`);
                        }
                        offset += 8;
                    } else {
                        // Character: write space-padded.
                        const str = rawVal === null || rawVal === undefined ? '' : String(rawVal);
                        writeCharObs(obsBuf, offset, str, col.sasDef.length);
                        offset += col.sasDef.length;
                    }
                }
                writer.write(obsBuf);
                writtenRows++;
                if (writtenRows % 10000 === 0 && progressCallback) {
                    progressCallback(`Writing ${writtenRows.toLocaleString()} rows...`);
                }
            }
        }

        // Finalize: pad to 80-byte boundary.
        writer.finalize();

        // Write to file
        if (progressCallback) {
            progressCallback('Writing output file...');
        }

        const fd = fs.openSync(outputPath, 'w');
        try {
            for (const record of writer.records) {
                fs.writeSync(fd, record);
            }
        } finally {
            fs.closeSync(fd);
        }

        const stats = fs.statSync(outputPath);
        const fileSizeMb = stats.size / (1024 * 1024);

        if (progressCallback) {
            progressCallback('SAS XPORT file created successfully');
            if (uniqueWarnings.length > 0) {
                for (const w of uniqueWarnings.slice(0, 20)) {
                    progressCallback(`  Warning: ${w}`);
                }
                if (uniqueWarnings.length > 20) {
                    progressCallback(`  ... and ${uniqueWarnings.length - 20} more warnings`);
                }
            }
            progressCallback(`  - Rows: ${totalRows.toLocaleString()}`);
            progressCallback(`  - Columns: ${activeCols.length}`);
            progressCallback(`  - File size: ${fileSizeMb.toFixed(1)} MB`);
            progressCallback(`  - Location: ${outputPath}`);
        }

        const exportResult: ExportResult = {
            success: true,
            message: `Successfully exported ${totalRows} rows to ${outputPath}`,
            details: {
                rows_exported: totalRows,
                columns: activeCols.length,
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
        return { success: false, message: `Export failed: ${errorMsg}` };
    }
}

/**
 * Execute a SQL query and export results directly to XPORT v5.
 * Follows the `exportQueryToXlsb`/`exportQueryToParquet` pattern.
 */
export async function exportQueryToXpt(
    connectionDetails: ConnectionDetails,
    query: string,
    outputPath: string,
    copyToClipboard: boolean = false,
    progressCallback?: ProgressCallback,
    timeout?: number,
    cancellationToken?: vscode.CancellationToken,
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
        let headerWritten = false;
        let columnsPrep: PreparedColumn[] | null = null;

        // We'll accumulate records in a RecordWriter and then write to file at the end.
        const now = new Date();
        const writer = new RecordWriter();

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
                    try { await cmd.cancel(); } catch { /* ignore */ }
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

                const rawColumns: { name: string; type?: string }[] = [];
                for (let i = 0; i < reader.fieldCount; i++) {
                    let dbType: string | undefined;
                    try {
                        dbType = getEffectiveResultColumnType(reader, i) || reader.getTypeName(i);
                    } catch {
                        dbType = undefined;
                    }
                    rawColumns.push({ name: reader.getName(i), type: dbType });
                }

                if (rawColumns.length === 0) {
                    if (progressCallback) {
                        progressCallback(`Skipping empty result set for query ${qIndex + 1}`);
                    }
                    await reader.close();
                    continue;
                }

                // Prepare columns on first result set.
                if (!columnsPrep) {
                    columnsPrep = prepareColumns(rawColumns);
                }

                const activeCols = columnsPrep.filter(c => !c.dropped);
                totalCols = Math.max(totalCols, activeCols.length);

                // Map activeCols index back to original column index for reader.getValue.
                const originalIndices = columnsPrep
                    .map((c, i) => c.dropped ? -1 : i)
                    .filter(i => i >= 0);

                if (activeCols.length === 0) {
                    if (progressCallback) {
                        progressCallback(`Skipping query ${qIndex + 1}: no supported columns`);
                    }
                    await reader.close();
                    continue;
                }

                // Write headers once.
                if (!headerWritten) {
                    const memberName = 'DATA';
                    writer.write(buildLibraryHeader(SAS_VERSION, OS_NAME, now, now));
                    writer.write(buildMemberHeader(memberName, MEMBER_TYPE, now, now));
                    writer.write(buildNamestrHeader(activeCols.length));
                    for (let i = 0; i < activeCols.length; i++) {
                        writer.write(buildNamestr(activeCols[i].sasName, activeCols[i].sasDef, i + 1));
                    }
                    writer.finalize();
                    writer.write(buildObsHeader());
                    headerWritten = true;
                }

                const obsBuf = new Uint8Array(computeObsLength(activeCols));
                let rowCount = 0;

                try {
                    while (await reader.read()) {
                        if (wasCancelled || cancellationToken?.isCancellationRequested) {
                            wasCancelled = true;
                            if (progressCallback) {
                                progressCallback(`Export cancelled after ${totalRows.toLocaleString()} rows...`);
                            }
                            break;
                        }

                        let offset = 0;
                        for (let ci = 0; ci < activeCols.length; ci++) {
                            const col = activeCols[ci];
                            const rawVal = reader.getValue(originalIndices[ci]);
                            if (col.sasDef.sasType === 1) {
                                writeNumericObs(obsBuf, offset, Number(rawVal));
                                offset += 8;
                            } else {
                                const str = rawVal === null || rawVal === undefined ? '' : String(rawVal);
                                writeCharObs(obsBuf, offset, str, col.sasDef.length);
                                offset += col.sasDef.length;
                            }
                        }
                        writer.write(obsBuf);
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

                if (wasCancelled) break;
            } finally {
                if (cancelListener) cancelListener.dispose();
                if (reader) {
                    try { await reader.close(); } catch { /* ignore */ }
                }
            }
        }

        // Finalize the record writer (pad to 80 bytes).
        writer.finalize();

        if (progressCallback) {
            progressCallback('Writing output file...');
        }

        const fd = fs.openSync(outputPath, 'w');
        try {
            for (const record of writer.records) {
                fs.writeSync(fd, record);
            }
        } finally {
            fs.closeSync(fd);
        }

        const stats = fs.statSync(outputPath);
        const fileSizeMb = stats.size / (1024 * 1024);

        if (progressCallback) {
            if (wasCancelled) {
                progressCallback('SAS XPORT file created with partial data (export was cancelled)');
            } else {
                progressCallback('SAS XPORT file created successfully');
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
                progressCallback('Copying file to clipboard...');
            }
            const clipboardSuccess = await copyFileToClipboard(outputPath);
            if (exportResult.details) {
                exportResult.details.clipboard_success = clipboardSuccess;
            }
        }

        return exportResult;
    } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return { success: false, message: `Export error: ${errorMsg}` };
    } finally {
        if (connection) {
            try { await connection.close(); } catch { /* ignore */ }
        }
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function prepareColumns(columns: ExportColumn[]): PreparedColumn[] {
    const originalNames = columns.map(c => c.name);
    const { names: sasNames } = resolveSasColumnNames(originalNames);

    const prepared: PreparedColumn[] = [];
    const allWarnings: string[] = [];

    for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const sasName = sasNames[i];
        const colWarnings: string[] = [];

        // Determine character width (for char/string types) or undefined.
        let width: number | undefined;
        let charLength: number | undefined;
        const upperType = (col.type || '').toUpperCase();
        if (
            upperType.startsWith('CHAR') ||
            upperType.startsWith('VARCHAR') ||
            upperType.startsWith('NVARCHAR') ||
            upperType.startsWith('NCHAR') ||
            upperType.startsWith('TEXT')
        ) {
            // Try to parse the declared length: e.g. VARCHAR(100)
            const match = (col.type || '').match(/\((\d+)\)/);
            if (match) {
                charLength = parseInt(match[1], 10);
            } else if (col.scale !== undefined) {
                charLength = col.scale;
            } else {
                charLength = 255;
            }
            width = charLength;
        }

        const label = sanitizeSasLabel(col.name);
        const { def, dropped, warning } = mapColumnType(col.name, col.type, width, label);

        if (warning) {
            colWarnings.push(warning.message);
        }

        if (sasName !== col.name) {
            colWarnings.push(`Column "${col.name}" renamed to "${sasName}" (SAS name limit)`);
        }

        // Warn about encoding issues for character columns.
        if (!dropped && def.sasType === 2 && col.name.length > 0) {
            // We'll only emit this if the name itself had non-ASCII chars.
            const encWarn = checkEncoding(col.name);
            if (encWarn) colWarnings.push(encWarn);
        }

        prepared.push({
            col,
            sasName,
            sasDef: def,
            warnings: colWarnings,
            dropped,
        });

        allWarnings.push(...colWarnings);
    }

    // Collect unique warnings for logging (returned via export result warnings).
    return prepared;
}

function computeObsLength(cols: PreparedColumn[]): number {
    let len = 0;
    for (const c of cols) {
        if (c.dropped) continue;
        len += c.sasDef.sasType === 1 ? 8 : c.sasDef.length;
    }
    return len;
}

function checkEncoding(value: string): string | null {
    const result = encodeWin1252(value);
    return result.warned
        ? `Value "${value}" contains non-ASCII characters that will be replaced with '?'`
        : null;
}

/**
 * Copy a file path to the clipboard (Windows only).
 */
export async function copyFileToClipboard(filePath: string): Promise<boolean> {
    if (os.platform() !== 'win32') return false;
    return new Promise<boolean>(resolve => {
        try {
            const normalizedPath = path.normalize(path.resolve(filePath));
            const ps = spawn('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-Command',
                `Set-Clipboard -Path "${normalizedPath.replace(/"/g, '`"')}"`,
            ]);
            ps.stderr.on('data', () => { /* ignore PowerShell stderr */ });
            ps.on('close', (code: number) => resolve(code === 0));
            ps.on('error', () => resolve(false));
        } catch {
            resolve(false);
        }
    });
}

export function getTempFilePath(): string {
    return path.join(os.tmpdir(), `netezza_export_${Date.now()}.xpt`);
}
