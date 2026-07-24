import * as fs from 'fs';
import type { Writable } from 'stream';
import * as vscode from 'vscode';
import { ResultSet } from '../types';
import { validateExportPath } from './exportUtils';
import type { ExportFormattingMetadata } from './exportManager';
import { formatResultValueForDisplay } from '../results/resultValueFormatter';
import { createCsvFileWriter, type CsvCompression } from './csvStream';
import { iterateResultRows } from '../core/resultDataProvider/resultDataReader';
import { formatBinaryValue } from './binaryValue';
import { ExportCancelledError } from '../core/cancellation';

export interface ExportOptions {
    format: 'csv' | 'csv.gz' | 'csv.zst' | 'json' | 'xml' | 'sql' | 'markdown' | 'parquet';
    rowIndices?: number[];
    columnIds?: string[]; // IDs of visible columns
    formatting?: ExportFormattingMetadata;
    sqlTargetTable?: string;
    /** SQL dialect used for dialect-specific literals; defaults to portable SQL. */
    sqlDialect?: string;
    cancellationToken?: vscode.CancellationToken;
}

export async function exportResultSetToFile(
    resultSet: ResultSet,
    filePath: string,
    options: ExportOptions
): Promise<void> {
    // Pre-validate export path
    validateExportPath(filePath);

    if (options.cancellationToken?.isCancellationRequested) {
        throw new ExportCancelledError(filePath, 0);
    }

    const { format, rowIndices, columnIds } = options;
    // Determine which columns to export
    const columns = resultSet.columns;
    const visibleColumnIndices = columnIds
        ? columnIds.map(id => parseInt(id)).filter(idx => !isNaN(idx) && idx >= 0 && idx < columns.length)
        : columns.map((_, i) => i);

    const exportedColumns = visibleColumnIndices.map(idx => ({
        ...columns[idx],
        id: String(idx)
    }));

    const rowsToExport = iterateResultRows(resultSet, rowIndices, visibleColumnIndices);
    const assertNotCancelled = () => {
        if (options.cancellationToken?.isCancellationRequested) {
            throw new ExportCancelledError(filePath, rowsWritten);
        }
    };
    let rowsWritten = 0;

    if (format === 'csv' || format === 'csv.gz' || format === 'csv.zst') {
        const compression: CsvCompression =
            format === 'csv.gz' ? 'gzip' : format === 'csv.zst' ? 'zstd' : 'none';
        const csvWriter = createCsvFileWriter(filePath, compression);
        try {
            await writeContent(csvWriter.stream, exportedColumns.map(c => escapeCsv(c.name)).join(',') + '\n');
            for (const row of rowsToExport) {
                assertNotCancelled();
                await streamCsvRow(csvWriter.stream, exportedColumns, row, visibleColumnIndices, options.formatting);
                rowsWritten++;
            }
        } finally {
            await csvWriter.finalize();
        }
        if (options.cancellationToken?.isCancellationRequested) {
            throw new ExportCancelledError(filePath, rowsWritten);
        }
        return;
    }

    const writeStream = fs.createWriteStream(filePath, { encoding: 'utf8' });

    try {
        switch (format) {
            case 'json':
                await streamJson(writeStream, exportedColumns, rowsToExport, visibleColumnIndices, options.formatting, assertNotCancelled, () => { rowsWritten++; });
                break;
            case 'xml':
                await streamXml(writeStream, exportedColumns, rowsToExport, visibleColumnIndices, options.formatting, assertNotCancelled, () => { rowsWritten++; });
                break;
            case 'sql':
                await streamSql(writeStream, exportedColumns, rowsToExport, visibleColumnIndices, options.sqlTargetTable, options.sqlDialect, assertNotCancelled, () => { rowsWritten++; });
                break;
            case 'markdown':
                await streamMarkdown(writeStream, exportedColumns, rowsToExport, visibleColumnIndices, options.formatting, assertNotCancelled, () => { rowsWritten++; });
                break;
            case 'parquet':
                throw new Error('Parquet export from resultExporter is not supported directly. Use parquetExporter.');
        }
        if (options.cancellationToken?.isCancellationRequested) {
            throw new ExportCancelledError(filePath, rowsWritten);
        }
    } finally {
        writeStream.end();
        await new Promise<void>((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });
    }
}

type ExportRowIterable = Iterable<unknown[]>;

async function writeContent(stream: Writable, content: string): Promise<void> {
    if (!stream.write(content)) {
        await new Promise<void>((resolve, reject) => {
            const onDrain = () => { cleanup(); resolve(); };
            const onError = (error: Error) => { cleanup(); reject(error); };
            const cleanup = () => {
                stream.removeListener('drain', onDrain);
                stream.removeListener('error', onError);
            };
            stream.once('drain', onDrain);
            stream.once('error', onError);
        });
    }
}

async function streamCsvRow(
    stream: Writable,
    columns: { id?: string; name: string; type?: string; scale?: number }[],
    row: unknown[],
    columnIndices: number[],
    formatting?: ExportFormattingMetadata,
): Promise<void> {
    const line = columnIndices
        .map((_idx, j) => escapeCsv(formatValue(row[j], columns[j], formatting)))
        .join(',') + '\n';
    await writeContent(stream, line);
}

async function streamJson(
    stream: fs.WriteStream,
    columns: { id?: string; name: string; type?: string; scale?: number }[],
    rows: ExportRowIterable,
    columnIndices: number[],
    formatting: ExportFormattingMetadata | undefined,
    assertNotCancelled: () => void,
    countRow: () => void,
) {
    await writeContent(stream, '[\n');
    let first = true;
    try {
      for (const row of rows) {
        assertNotCancelled();
        const obj: Record<string, unknown> = {};
        columnIndices.forEach((_colIdx, j) => {
            const val = row[j];
            const binaryValue = formatBinaryValue(val);
            obj[columns[j].name] = binaryValue ?? (formatting?.useFormattedValues
                ? formatValue(val, columns[j], formatting)
                : ((val instanceof Date) ? formatValue(val, columns[j], formatting) : val));
        });

        await writeContent(stream, '  ' + (first ? '' : ',\n  ') + JSON.stringify(obj, bigIntReplacer) + '\n');
        first = false;
        countRow();
      }
    } finally {
      await writeContent(stream, '\n]\n');
    }
}

async function streamXml(
    stream: fs.WriteStream,
    columns: { id?: string; name: string; type?: string; scale?: number }[],
    rows: ExportRowIterable,
    columnIndices: number[],
    formatting: ExportFormattingMetadata | undefined,
    assertNotCancelled: () => void,
    countRow: () => void,
) {
    await writeContent(stream, '<?xml version="1.0" encoding="UTF-8"?>\n<results>\n');
    try {
    for (const row of rows) {
        assertNotCancelled();
        await writeContent(stream, '  <row>\n');
        await writeContent(stream, columnIndices.map((_colIdx, j) => {
            const tagName = columns[j].name.replace(/[^a-zA-Z0-9_-]/g, '_');
            const content = escapeXml(formatValue(row[j], columns[j], formatting));
            return `    <${tagName}>${content}</${tagName}>\n`;
        }).join(''));
        await writeContent(stream, '  </row>\n');
        countRow();

        // Yield if needed? For 50k rows this is fine but let's be safe
        await new Promise(resolve => setImmediate(resolve));
    }
    } finally {
        await writeContent(stream, '</results>\n');
    }
}

async function streamSql(
    stream: fs.WriteStream,
    columns: { id?: string; name: string; type?: string; scale?: number }[],
    rows: ExportRowIterable,
    columnIndices: number[],
    sqlTargetTable: string | undefined,
    sqlDialect: string | undefined,
    assertNotCancelled: () => void,
    countRow: () => void,
) {
    const tableName = sqlTargetTable?.trim() || 'EXPORT_TABLE';
    if (!/^(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$#]*)(?:\.(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$#]*))*$/.test(tableName)) {
        throw new Error(`Invalid SQL export target table: ${tableName}`);
    }
    const colNames = columns.map(c => c.name.replace(/[^a-zA-Z0-9_]/g, '') || 'COL').join(', ');
    await writeContent(stream, '-- Data-only export: INSERT statements only; schema/DDL is not included.\n');

    for (const row of rows) {
        assertNotCancelled();
        const values = columnIndices.map((_colIdx, j) => {
            const val = row[j];
            const type = columns[j].type;
            return formatSqlValue(val, type, sqlDialect);
        });

        const line = `INSERT INTO ${tableName} (${colNames}) VALUES (${values.join(', ')});\n`;
        await writeContent(stream, line);
        countRow();
    }
}

async function streamMarkdown(
    stream: fs.WriteStream,
    columns: { id?: string; name: string; type?: string; scale?: number }[],
    rows: ExportRowIterable,
    columnIndices: number[],
    formatting: ExportFormattingMetadata | undefined,
    assertNotCancelled: () => void,
    countRow: () => void,
) {
    // Header
    await writeContent(stream, '| ' + columns.map(c => c.name.replace(/\|/g, '\\|')).join(' | ') + ' |\n');
    // Separator
    await writeContent(stream, '| ' + columns.map(() => '---').join(' | ') + ' |\n');

    for (const row of rows) {
        assertNotCancelled();
        const rowData = columnIndices.map((_colIdx, j) => {
            const val = row[j];
            if (val === null || val === undefined) return '';
            const formatted = formatValue(val, columns[j], formatting);
            return String(formatted).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
        });
        const line = '| ' + rowData.join(' | ') + ' |\n';
        await writeContent(stream, line);
        countRow();
    }
}

function escapeCsv(val: unknown): string {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function escapeXml(val: unknown): string {
    if (val === null || val === undefined) return '';
    return String(val)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function formatSqlValue(val: unknown, type?: string, sqlDialect?: string): string {
    if (val === null || val === undefined) return 'NULL';

    // Check type if possible
    const upperType = type?.toUpperCase();
    const binaryValue = formatBinaryValue(val);
    if (binaryValue) {
        const hex = binaryValue.slice('hex:'.length);
        if (sqlDialect?.toLowerCase() === 'oracle') {
            if (upperType?.includes('BLOB')) return `TO_BLOB(HEXTORAW('${hex}'))`;
            if (upperType?.includes('RAW') || upperType?.includes('BINARY')) return `HEXTORAW('${hex}')`;
        }
        return `'${binaryValue}'`;
    }
    if (val instanceof Date) {
        const year = val.getUTCFullYear();
        const month = String(val.getUTCMonth() + 1).padStart(2, '0');
        const day = String(val.getUTCDate()).padStart(2, '0');
        const datePart = `${year}-${month}-${day}`;
        if (upperType === 'DATE' || (upperType?.includes('DATE') && !upperType.includes('TIMESTAMP'))) {
            const hours = String(val.getUTCHours()).padStart(2, '0');
            const minutes = String(val.getUTCMinutes()).padStart(2, '0');
            const seconds = String(val.getUTCSeconds()).padStart(2, '0');
            if (hours !== '00' || minutes !== '00' || seconds !== '00') {
                if (sqlDialect?.toLowerCase() === 'oracle') {
                    return `TO_DATE('${datePart} ${hours}:${minutes}:${seconds}', 'YYYY-MM-DD HH24:MI:SS')`;
                }
                return `TIMESTAMP '${datePart} ${hours}:${minutes}:${seconds}'`;
            }
            return `DATE '${datePart}'`;
        }

        const hours = String(val.getUTCHours()).padStart(2, '0');
        const minutes = String(val.getUTCMinutes()).padStart(2, '0');
        const seconds = String(val.getUTCSeconds()).padStart(2, '0');
        if (upperType?.includes('WITH TIME ZONE')) {
            if (sqlDialect?.toLowerCase() === 'oracle') {
                return `TO_TIMESTAMP_TZ('${datePart} ${hours}:${minutes}:${seconds} +00:00', 'YYYY-MM-DD HH24:MI:SS TZH:TZM')`;
            }
            return `'${datePart} ${hours}:${minutes}:${seconds} +00:00'`;
        }
        return `TIMESTAMP '${datePart} ${hours}:${minutes}:${seconds}'`;
    }
    if (upperType === 'BOOLEAN') return val ? 'TRUE' : 'FALSE';
    if (['INTEGER', 'BIGINT', 'SMALLINT', 'DECIMAL', 'NUMERIC', 'REAL', 'DOUBLE PRECISION', 'FLOAT4', 'FLOAT8', 'INT2', 'INT4', 'INT8'].includes(upperType || '')) {
        return String(val);
    }

    if (typeof val === 'number') return String(val);
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';

    if (upperType?.includes('WITH TIME ZONE') && typeof val === 'string') {
        if (sqlDialect?.toLowerCase() === 'oracle') {
            return `TO_TIMESTAMP_TZ('${val.replace(/'/g, "''")}', 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM')`;
        }
        return `'${val.replace(/'/g, "''")}'`;
    }

    return `'${String(val).replace(/'/g, "''")}'`;
}

function formatValue(
    val: unknown,
    column: { id?: string; name: string; type?: string; scale?: number },
    formatting?: ExportFormattingMetadata
): string {
    if (val === null || val === undefined) return '';
    const binaryValue = formatBinaryValue(val);
    if (binaryValue) return binaryValue;
    if (formatting?.useFormattedValues) {
        return formatResultValueForDisplay(val, column, {
            columnId: column.id || String(column.name),
            payload: formatting.payload,
            resultOverride: formatting.resultOverride
        });
    }
    if (val instanceof Date) {
        // Use UTC methods to avoid timezone conversion issues
        const y = val.getUTCFullYear();
        const m = String(val.getUTCMonth() + 1).padStart(2, '0');
        const d = String(val.getUTCDate()).padStart(2, '0');

        const lowerType = (column.type || '').toLowerCase();
        if (lowerType === 'date') {
            return `${y}-${m}-${d}`;
        } else if (lowerType.includes('timestamp') || lowerType.includes('datetime') || lowerType.includes('time')) {
            const hh = String(val.getUTCHours()).padStart(2, '0');
            const mm = String(val.getUTCMinutes()).padStart(2, '0');
            const ss = String(val.getUTCSeconds()).padStart(2, '0');
            return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
        }
        try {
            return val.toISOString().replace('T', ' ').substring(0, 19);
        } catch {
            return String(val);
        }
    }

    // Handle generic objects that might be Time/Interval or just need string representation
    if (typeof val === 'object' && val !== null) {
        // If it has a custom toString (different from [object Object]), use it
        const str = String(val);
        if (str !== '[object Object]') {
            return str;
        }

        // Handle common Time object structures: {hours, minutes, seconds}
        const v = val as { hours?: number; minutes?: number; seconds?: number };
        if ('hours' in v || 'minutes' in v || 'seconds' in v) {
            const hh = String(v.hours || 0).padStart(2, '0');
            const mm = String(v.minutes || 0).padStart(2, '0');
            const ss = String(v.seconds || 0).padStart(2, '0');
            return `${hh}:${mm}:${ss}`;
        }
    }

    return String(val);
}

const bigIntReplacer = (_key: string, value: unknown) => {
    if (typeof value === 'bigint') {
        if (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
            return Number(value);
        }
        return value.toString();
    }
    return value;
};
