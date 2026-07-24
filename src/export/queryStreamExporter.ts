import * as fs from 'fs';
import * as vscode from 'vscode';
import type { Writable } from 'stream';
import type { NzConnection } from '../types';
import { createCsvFileWriter, type CsvCompression } from './csvStream';
import { escapeCsvField } from './csvExporter';
import { validateExportPath } from './exportUtils';
import { formatBinaryValue } from './binaryValue';
import {
    cancelCommandAndCloseReader,
    ExportCancelledError,
    isCancellationError,
} from '../core/cancellation';

export type QueryStreamExportFormat =
    | 'csv'
    | 'csv.gz'
    | 'csv.zst'
    | 'json'
    | 'xml'
    | 'sql'
    | 'markdown'
    | 'xlsx'
    | 'xlsb';

export interface QueryStreamExportOptions {
    connection: NzConnection;
    query: string;
    filePath: string;
    format: QueryStreamExportFormat;
    columnIndices?: number[];
    sql?: string;
    sqlTargetTable?: string;
    /** SQL dialect used for dialect-specific literals; defaults to portable SQL. */
    sqlDialect?: string;
    timeoutSeconds?: number;
    cancellationToken?: vscode.CancellationToken;
    progress?: (message: string) => void;
}

interface QueryReader {
    fieldCount: number;
    getName(index: number): string;
    getTypeName(index: number): string;
    getValue(index: number): unknown;
    read(): Promise<boolean>;
    nextResult(): Promise<boolean>;
    close(): Promise<void>;
}

interface SpreadsheetWriter {
    startSheet(name: string, columnCount: number, headers?: string[], options?: { doAutofilter?: boolean }): void;
    writeRow(row: unknown[]): void;
    endSheet(): void;
    finalize(): Promise<void>;
}

function csvCompression(format: QueryStreamExportFormat): CsvCompression {
    return format === 'csv.gz' ? 'gzip' : format === 'csv.zst' ? 'zstd' : 'none';
}

function escapeXml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function jsonValue(value: unknown): string {
    return JSON.stringify(value, (_key, item: unknown) =>
        typeof item === 'bigint' ? item.toString() : item,
    );
}

function sqlValue(value: unknown, type?: string, sqlDialect?: string): string {
    if (value === null || value === undefined) return 'NULL';
    const binaryValue = formatBinaryValue(value);
    const upperType = type?.toUpperCase();
    if (binaryValue) {
        const hex = binaryValue.slice('hex:'.length);
        if (sqlDialect?.toLowerCase() === 'oracle') {
            if (upperType?.includes('BLOB')) return `TO_BLOB(HEXTORAW('${hex}'))`;
            if (upperType?.includes('RAW') || upperType?.includes('BINARY')) return `HEXTORAW('${hex}')`;
        }
        return `'${binaryValue}'`;
    }
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (value instanceof Date) {
        const iso = value.toISOString();
        if (upperType === 'DATE' || (upperType?.includes('DATE') && !upperType.includes('TIMESTAMP'))) {
            const datePart = iso.slice(0, 10);
            const hours = iso.slice(11, 13);
            const minutes = iso.slice(14, 16);
            const seconds = iso.slice(17, 19);
            if (hours !== '00' || minutes !== '00' || seconds !== '00') {
                if (sqlDialect?.toLowerCase() === 'oracle') {
                    return `TO_DATE('${datePart} ${hours}:${minutes}:${seconds}', 'YYYY-MM-DD HH24:MI:SS')`;
                }
                return `TIMESTAMP '${datePart} ${hours}:${minutes}:${seconds}'`;
            }
            return `DATE '${datePart}'`;
        }
        if (upperType?.includes('WITH TIME ZONE')) {
            if (sqlDialect?.toLowerCase() === 'oracle') {
                return `TO_TIMESTAMP_TZ('${iso.slice(0, 19).replace('T', ' ')} +00:00', 'YYYY-MM-DD HH24:MI:SS TZH:TZM')`;
            }
            return `'${iso.slice(0, 19).replace('T', ' ')} +00:00'`;
        }
        return `TIMESTAMP '${iso.slice(0, 19).replace('T', ' ')}'`;
    }
    if (upperType?.includes('WITH TIME ZONE') && typeof value === 'string') {
        if (sqlDialect?.toLowerCase() === 'oracle') {
            return `TO_TIMESTAMP_TZ('${value.replace(/'/g, "''")}', 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM')`;
        }
        return `'${value.replace(/'/g, "''")}'`;
    }
    return `'${String(value).replace(/'/g, "''")}'`;
}

async function write(stream: Writable, content: string): Promise<void> {
    if (!stream.write(content)) {
        await new Promise<void>(resolve => stream.once('drain', resolve));
    }
}

async function finalize(stream: fs.WriteStream): Promise<void> {
    stream.end();
    await new Promise<void>((resolve, reject) => {
        stream.once('finish', resolve);
        stream.once('error', reject);
    });
}

/** Streams a database reader straight to a file; rows are never accumulated in memory. */
export async function exportQueryToStreamFile(options: QueryStreamExportOptions): Promise<number> {
    validateExportPath(options.filePath);
    const command = options.connection.createCommand(options.query);
    if (options.timeoutSeconds && options.timeoutSeconds > 0) {
        command.commandTimeout = options.timeoutSeconds;
    }

    let reader: QueryReader | undefined;
    let cancelDisposable: vscode.Disposable | undefined;
    let output: fs.WriteStream | undefined;
    let csvWriter: ReturnType<typeof createCsvFileWriter> | undefined;
    let spreadsheetWriter: SpreadsheetWriter | undefined;
    let rowCount = 0;
    let cancellationRequested = false;
    const cleanupContext = { timeoutMs: 5_000 };

    const requestCancellation = () => {
        cancellationRequested = true;
        void cancelCommandAndCloseReader(command, reader, cleanupContext);
    };

    try {
        cancelDisposable = options.cancellationToken?.onCancellationRequested(requestCancellation);
        options.progress?.('Executing SQL without LIMIT...');
        reader = await command.executeReader() as QueryReader;

        if (options.cancellationToken?.isCancellationRequested) {
            requestCancellation();
            throw new ExportCancelledError(options.filePath, 0);
        }

        const indices = options.columnIndices?.length
            ? options.columnIndices.filter(index => index >= 0 && index < reader!.fieldCount)
            : Array.from({ length: reader.fieldCount }, (_, index) => index);
        const columns = indices.map(index => reader!.getName(index));
        if (options.format === 'csv' || options.format === 'csv.gz' || options.format === 'csv.zst') {
            csvWriter = createCsvFileWriter(options.filePath, csvCompression(options.format));
            await write(csvWriter.stream, columns.map(escapeCsvField).join(',') + '\n');
        } else if (options.format === 'xlsx' || options.format === 'xlsb') {
            const spreadsheetTasks = require('@justybase/spreadsheet-tasks') as {
                XlsxWriter: new (filePath: string) => SpreadsheetWriter;
                XlsbWriter: new (filePath: string) => SpreadsheetWriter;
            };
            const Writer = options.format === 'xlsx' ? spreadsheetTasks.XlsxWriter : spreadsheetTasks.XlsbWriter;
            const writer = new Writer(options.filePath);
            spreadsheetWriter = writer;
            writer.startSheet('Query Results', columns.length, columns, { doAutofilter: true });
        } else {
            output = fs.createWriteStream(options.filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
            if (options.format === 'json') await write(output, '[\n');
            if (options.format === 'xml') await write(output, '<?xml version="1.0" encoding="UTF-8"?>\n<results>\n');
            if (options.format === 'sql') await write(output, '-- Data-only export: INSERT statements only; schema/DDL is not included.\n');
            if (options.format === 'markdown') {
                await write(output, `| ${columns.map(name => name.replace(/\|/g, '\\|')).join(' | ')} |\n`);
                await write(output, `| ${columns.map(() => '---').join(' | ')} |\n`);
            }
        }

        try {
            while (await reader.read()) {
                if (options.cancellationToken?.isCancellationRequested || cancellationRequested) {
                    requestCancellation();
                    break;
                }
                const values = indices.map(index => reader!.getValue(index));
            if (csvWriter) {
                await write(csvWriter.stream, values.map(escapeCsvField).join(',') + '\n');
            } else if (spreadsheetWriter) {
                spreadsheetWriter.writeRow(values);
            } else if (output && options.format === 'json') {
                const record: Record<string, unknown> = {};
                columns.forEach((name, index) => { record[name] = formatBinaryValue(values[index]) ?? values[index]; });
                await write(output, `${rowCount === 0 ? '' : ',\n'}  ${jsonValue(record)}`);
            } else if (output && options.format === 'xml') {
                await write(output, '  <row>\n');
                for (let index = 0; index < columns.length; index += 1) {
                    const tag = columns[index].replace(/[^A-Za-z0-9_-]/g, '_') || 'column';
                    await write(output, `    <${tag}>${escapeXml(values[index])}</${tag}>\n`);
                }
                await write(output, '  </row>\n');
            } else if (output && options.format === 'sql') {
                const names = columns.map(name => `"${name.replace(/"/g, '""')}"`).join(', ');
                const tableName = options.sqlTargetTable?.trim() || 'EXPORT_TABLE';
                if (!/^(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$#]*)(?:\.(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$#]*))*$/.test(tableName)) {
                    throw new Error(`Invalid SQL export target table: ${tableName}`);
                }
                await write(output, `INSERT INTO ${tableName} (${names}) VALUES (${values.map((value, index) => sqlValue(value, reader!.getTypeName(indices[index]), options.sqlDialect)).join(', ')});\n`);
            } else if (output && options.format === 'markdown') {
                await write(output, `| ${values.map(value => String(value ?? 'NULL').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')).join(' | ')} |\n`);
            }
                rowCount += 1;
                if (rowCount % 10_000 === 0) options.progress?.(`Streaming ${rowCount.toLocaleString()} rows...`);
            }
        } catch (error) {
            if (cancellationRequested || options.cancellationToken?.isCancellationRequested || isCancellationError(error)) {
                cancellationRequested = true;
                requestCancellation();
            } else {
                throw error;
            }
        }

        if (options.cancellationToken?.isCancellationRequested || cancellationRequested) {
            requestCancellation();
        }

        if (output && options.format === 'json') await write(output, '\n]\n');
        if (output && options.format === 'xml') await write(output, '</results>\n');
        if (csvWriter) await csvWriter.finalize();
        if (spreadsheetWriter) {
            spreadsheetWriter.endSheet();
            if (options.sql) {
                const sqlLines = options.sql.split('\n');
                spreadsheetWriter.startSheet('SQL Code', 1, undefined, { doAutofilter: false });
                spreadsheetWriter.writeRow(['SQL Query:']);
                for (const line of sqlLines) {
                    spreadsheetWriter.writeRow([line.trim()]);
                }
                spreadsheetWriter.endSheet();
            }
            await spreadsheetWriter.finalize();
        }
        if (output) await finalize(output);
        if (cancellationRequested) {
            options.progress?.(`Export cancelled — retained ${rowCount.toLocaleString()} rows.`);
            throw new ExportCancelledError(options.filePath, rowCount);
        }
        options.progress?.(`Exported ${rowCount.toLocaleString()} rows.`);
        return rowCount;
    } finally {
        cancelDisposable?.dispose();
        if (reader) {
            if (cancellationRequested) {
                await cancelCommandAndCloseReader(command, reader, cleanupContext);
            } else {
                try { await reader.close(); } catch { /* best effort */ }
            }
        }
    }
}
