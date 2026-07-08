import * as fs from 'fs';
import type { Writable } from 'stream';
import { ResultSet } from '../types';
import { validateExportPath } from './exportUtils';
import type { ExportFormattingMetadata } from './exportManager';
import { formatResultValueForDisplay } from '../results/resultValueFormatter';
import { createCsvFileWriter, type CsvCompression } from './csvStream';
import { createResultDataReader, resolveExportRows } from '../core/resultDataProvider/resultDataReader';

export interface ExportOptions {
    format: 'csv' | 'csv.gz' | 'csv.zst' | 'json' | 'xml' | 'sql' | 'markdown' | 'parquet';
    rowIndices?: number[];
    columnIds?: string[]; // IDs of visible columns
    formatting?: ExportFormattingMetadata;
}

export async function exportResultSetToFile(
    resultSet: ResultSet,
    filePath: string,
    options: ExportOptions
): Promise<void> {
    // Pre-validate export path
    validateExportPath(filePath);

    const { format, rowIndices, columnIds } = options;
    const reader = createResultDataReader(resultSet);

    // Determine which columns to export
    const columns = resultSet.columns;
    const visibleColumnIndices = columnIds
        ? columnIds.map(id => parseInt(id)).filter(idx => !isNaN(idx) && idx >= 0 && idx < columns.length)
        : columns.map((_, i) => i);

    const exportedColumns = visibleColumnIndices.map(idx => ({
        ...columns[idx],
        id: String(idx)
    }));

    const rowsToExport = rowIndices && rowIndices.length > 0
        ? resolveExportRows(resultSet, rowIndices, visibleColumnIndices)
        : resultSet.storageMode === 'sqlite'
            ? undefined
            : resultSet.data.map((row) => visibleColumnIndices.map((columnIndex) => row[columnIndex]));

    if (format === 'csv' || format === 'csv.gz' || format === 'csv.zst') {
        const compression: CsvCompression =
            format === 'csv.gz' ? 'gzip' : format === 'csv.zst' ? 'zstd' : 'none';
        const csvWriter = createCsvFileWriter(filePath, compression);
        try {
            if (rowsToExport) {
                await streamCsv(csvWriter.stream, exportedColumns, rowsToExport, visibleColumnIndices, options.formatting);
            } else {
                csvWriter.stream.write(exportedColumns.map(c => escapeCsv(c.name)).join(',') + '\n');
                for (const batch of reader.iterateRows(50_000)) {
                    await streamCsvRows(csvWriter.stream, exportedColumns, batch, visibleColumnIndices, options.formatting);
                }
            }
        } finally {
            await csvWriter.finalize();
        }
        return;
    }

    const allRows = rowsToExport ?? collectAllRows(reader);

    const writeStream = fs.createWriteStream(filePath, { encoding: 'utf8' });

    try {
        switch (format) {
            case 'json':
                await streamJson(writeStream, exportedColumns, allRows, visibleColumnIndices, options.formatting);
                break;
            case 'xml':
                await streamXml(writeStream, exportedColumns, allRows, visibleColumnIndices, options.formatting);
                break;
            case 'sql':
                await streamSql(writeStream, exportedColumns, allRows, visibleColumnIndices);
                break;
            case 'markdown':
                await streamMarkdown(writeStream, exportedColumns, allRows, visibleColumnIndices, options.formatting);
                break;
            case 'parquet':
                throw new Error('Parquet export from resultExporter is not supported directly. Use parquetExporter.');
        }
    } finally {
        writeStream.end();
        await new Promise<void>((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });
    }
}

function collectAllRows(reader: ReturnType<typeof createResultDataReader>): unknown[][] {
    const rows: unknown[][] = [];
    for (const batch of reader.iterateRows(50_000)) {
        rows.push(...batch);
    }
    return rows;
}

async function streamCsvRows(
    stream: Writable,
    columns: { id?: string; name: string; type?: string; scale?: number }[],
    rows: unknown[][],
    columnIndices: number[],
    formatting?: ExportFormattingMetadata,
): Promise<void> {
    for (const row of rows) {
        const line = columnIndices
            .map((idx, j) => escapeCsv(formatValue(row[idx], columns[j], formatting)))
            .join(',') + '\n';
        if (!stream.write(line)) {
            await new Promise(resolve => stream.once('drain', resolve));
        }
    }
}

async function streamCsv(
    stream: Writable,
    columns: { id?: string; name: string; type?: string; scale?: number }[],
    rows: unknown[][],
    columnIndices: number[],
    formatting?: ExportFormattingMetadata
) {
    // Header
    stream.write(columns.map(c => escapeCsv(c.name)).join(',') + '\n');

    for (const row of rows) {
        const line = columnIndices.map(idx => escapeCsv(formatValue(row[idx], columns[columnIndices.indexOf(idx)], formatting))).join(',') + '\n';
        if (!stream.write(line)) {
            await new Promise(resolve => stream.once('drain', resolve));
        }
    }
}

async function streamJson(
    stream: fs.WriteStream,
    columns: { id?: string; name: string; type?: string; scale?: number }[],
    rows: unknown[][],
    columnIndices: number[],
    formatting?: ExportFormattingMetadata
) {
    stream.write('[\n');
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const obj: Record<string, unknown> = {};
        columnIndices.forEach((colIdx, j) => {
            const val = row[colIdx];
            obj[columns[j].name] = formatting?.useFormattedValues
                ? formatValue(val, columns[j], formatting)
                : ((val instanceof Date) ? formatValue(val, columns[j], formatting) : val);
        });

        const line = '  ' + JSON.stringify(obj, bigIntReplacer) + (i < rows.length - 1 ? ',' : '') + '\n';
        if (!stream.write(line)) {
            await new Promise(resolve => stream.once('drain', resolve));
        }
    }
    stream.write(']');
}

async function streamXml(
    stream: fs.WriteStream,
    columns: { id?: string; name: string; type?: string; scale?: number }[],
    rows: unknown[][],
    columnIndices: number[],
    formatting?: ExportFormattingMetadata
) {
    stream.write('<?xml version="1.0" encoding="UTF-8"?>\n<results>\n');
    for (const row of rows) {
        stream.write('  <row>\n');
        columnIndices.forEach((colIdx, j) => {
            const val = row[colIdx];
            const tagName = columns[j].name.replace(/[^a-zA-Z0-9_-]/g, '_');
            const content = escapeXml(formatValue(val, columns[j], formatting));
            stream.write(`    <${tagName}>${content}</${tagName}>\n`);
        });
        stream.write('  </row>\n');

        // Yield if needed? For 50k rows this is fine but let's be safe
        await new Promise(resolve => setImmediate(resolve));
    }
    stream.write('</results>');
}

async function streamSql(
    stream: fs.WriteStream,
    columns: { id?: string; name: string; type?: string; scale?: number }[],
    rows: unknown[][],
    columnIndices: number[]
) {
    const tableName = 'EXPORT_TABLE';
    const colNames = columns.map(c => c.name.replace(/[^a-zA-Z0-9_]/g, '') || 'COL').join(', ');

    for (const row of rows) {
        const values = columnIndices.map((colIdx, j) => {
            const val = row[colIdx];
            const type = columns[j].type;
            return formatSqlValue(val, type);
        });

        const line = `INSERT INTO ${tableName} (${colNames}) VALUES (${values.join(', ')});\n`;
        if (!stream.write(line)) {
            await new Promise(resolve => stream.once('drain', resolve));
        }
    }
}

async function streamMarkdown(
    stream: fs.WriteStream,
    columns: { id?: string; name: string; type?: string; scale?: number }[],
    rows: unknown[][],
    columnIndices: number[],
    formatting?: ExportFormattingMetadata
) {
    // Header
    stream.write('| ' + columns.map(c => c.name.replace(/\|/g, '\\|')).join(' | ') + ' |\n');
    // Separator
    stream.write('| ' + columns.map(() => '---').join(' | ') + ' |\n');

    for (const row of rows) {
        const rowData = columnIndices.map((colIdx, j) => {
            const val = row[colIdx];
            if (val === null || val === undefined) return '';
            const formatted = formatValue(val, columns[j], formatting);
            return String(formatted).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
        });
        const line = '| ' + rowData.join(' | ') + ' |\n';
        if (!stream.write(line)) {
            await new Promise(resolve => stream.once('drain', resolve));
        }
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

function formatSqlValue(val: unknown, type?: string): string {
    if (val === null || val === undefined) return 'NULL';

    // Check type if possible
    const upperType = type?.toUpperCase();
    if (upperType === 'BOOLEAN') return val ? 'TRUE' : 'FALSE';
    if (['INTEGER', 'BIGINT', 'SMALLINT', 'DECIMAL', 'NUMERIC', 'REAL', 'DOUBLE PRECISION', 'FLOAT4', 'FLOAT8', 'INT2', 'INT4', 'INT8'].includes(upperType || '')) {
        return String(val);
    }

    if (typeof val === 'number') return String(val);
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';

    return `'${String(val).replace(/'/g, "''")}'`;
}

function formatValue(
    val: unknown,
    column: { id?: string; name: string; type?: string; scale?: number },
    formatting?: ExportFormattingMetadata
): string {
    if (val === null || val === undefined) return '';
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
