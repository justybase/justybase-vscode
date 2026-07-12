import * as fs from 'fs';
import * as vscode from 'vscode';
import type { Writable } from 'stream';
import type { NzConnection } from '../types';
import { createCsvFileWriter, type CsvCompression } from './csvStream';
import { escapeCsvField } from './csvExporter';
import { validateExportPath } from './exportUtils';

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
    timeoutSeconds?: number;
    cancellationToken?: vscode.CancellationToken;
    progress?: (message: string) => void;
}

interface QueryReader {
    fieldCount: number;
    getName(index: number): string;
    getValue(index: number): unknown;
    read(): Promise<boolean>;
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

function sqlValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (value instanceof Date) return `'${value.toISOString().replace(/'/g, "''")}'`;
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

    try {
        cancelDisposable = options.cancellationToken?.onCancellationRequested(() => {
            void command.cancel();
        });
        options.progress?.('Executing SQL without LIMIT...');
        reader = await command.executeReader() as QueryReader;

        const indices = options.columnIndices?.length
            ? options.columnIndices.filter(index => index >= 0 && index < reader!.fieldCount)
            : Array.from({ length: reader.fieldCount }, (_, index) => index);
        const columns = indices.map(index => reader!.getName(index));
        let rowCount = 0;

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
            if (options.format === 'markdown') {
                await write(output, `| ${columns.map(name => name.replace(/\|/g, '\\|')).join(' | ')} |\n`);
                await write(output, `| ${columns.map(() => '---').join(' | ')} |\n`);
            }
        }

        while (await reader.read()) {
            if (options.cancellationToken?.isCancellationRequested) {
                throw new Error('Export cancelled by user');
            }
            const values = indices.map(index => reader!.getValue(index));
            if (csvWriter) {
                await write(csvWriter.stream, values.map(escapeCsvField).join(',') + '\n');
            } else if (spreadsheetWriter) {
                spreadsheetWriter.writeRow(values);
            } else if (output && options.format === 'json') {
                const record: Record<string, unknown> = {};
                columns.forEach((name, index) => { record[name] = values[index]; });
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
                await write(output, `INSERT INTO EXPORT_TABLE (${names}) VALUES (${values.map(sqlValue).join(', ')});\n`);
            } else if (output && options.format === 'markdown') {
                await write(output, `| ${values.map(value => String(value ?? 'NULL').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')).join(' | ')} |\n`);
            }
            rowCount += 1;
            if (rowCount % 10_000 === 0) options.progress?.(`Streaming ${rowCount.toLocaleString()} rows...`);
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
        options.progress?.(`Exported ${rowCount.toLocaleString()} rows.`);
        return rowCount;
    } finally {
        cancelDisposable?.dispose();
        if (reader) {
            try { await reader.close(); } catch { /* best effort */ }
        }
    }
}
