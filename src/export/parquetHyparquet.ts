import * as fs from 'fs/promises';
import type { BasicType } from 'hyparquet-writer';
import type { AsyncBuffer, SchemaElement } from 'hyparquet';
import { parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet';
import { ByteWriter, parquetWriteRows } from 'hyparquet-writer';
import { compressors } from 'hyparquet-compressors';

export interface ParquetColumnSpec {
    name: string;
    type?: string;
}

export interface ParquetReadResult {
    columns: ParquetColumnSpec[];
    rows: unknown[][];
    totalRows: number;
}

export function sanitizeParquetColumnName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

export function columnTypeToHyparquet(dbType?: string): BasicType {
    if (!dbType) return 'STRING';
    const t = dbType.toUpperCase();
    if (t === 'BOOLEAN' || t === 'BIT') return 'BOOLEAN';
    if (t.includes('BIGINT') || t === 'INT64') return 'INT64';
    if (t.includes('INT') || t === 'SMALLINT') return 'INT32';
    if (t === 'FLOAT4' || t === 'REAL' || t === 'FLOAT') return 'FLOAT';
    if (t === 'FLOAT8' || t === 'DOUBLE' || t === 'DOUBLE PRECISION') return 'DOUBLE';
    if (t.includes('NUMERIC') || t.includes('DECIMAL') || t === 'MONEY') return 'STRING';
    if (t.includes('TIMESTAMP') || t.includes('DATE') || t.includes('TIME')) return 'STRING';
    if (t === 'BYTEA' || t === 'BINARY' || t === 'VARBINARY') return 'BYTE_ARRAY';
    return 'STRING';
}

export function formatParquetValue(val: unknown): unknown {
    if (val === null || val === undefined) return null;
    if (typeof val === 'bigint') {
        if (val >= Number.MIN_SAFE_INTEGER && val <= Number.MAX_SAFE_INTEGER) {
            return val;
        }
        return val.toString();
    }
    if (val instanceof Date) return val.toISOString();
    if (typeof val === 'object' && Buffer.isBuffer(val)) return val;
    if (typeof val === 'object') {
        const str = String(val);
        if (str !== '[object Object]') return str;
        const v = val as { hours?: number; minutes?: number; seconds?: number };
        if ('hours' in v || 'minutes' in v || 'seconds' in v) {
            const hh = String(v.hours || 0).padStart(2, '0');
            const mm = String(v.minutes || 0).padStart(2, '0');
            const ss = String(v.seconds || 0).padStart(2, '0');
            return `${hh}:${mm}:${ss}`;
        }
        return JSON.stringify(val);
    }
    return val;
}

function coerceValueForHyparquetType(val: unknown, basicType: BasicType): unknown {
    const formatted = formatParquetValue(val);
    if (formatted === null || formatted === undefined) return null;
    if (basicType === 'INT64') {
        if (typeof formatted === 'bigint') return formatted;
        if (typeof formatted === 'number' && Number.isFinite(formatted)) {
            return BigInt(Math.trunc(formatted));
        }
        if (typeof formatted === 'string' && formatted.trim() !== '') {
            return BigInt(formatted);
        }
    }
    if (basicType === 'INT32' && typeof formatted === 'number') {
        return Math.trunc(formatted);
    }
    if (basicType === 'BYTE_ARRAY' && typeof formatted === 'string') {
        return Buffer.from(formatted, 'utf8');
    }
    return formatted;
}

export function formatParquetRow(
    columns: ParquetColumnSpec[],
    row: unknown[],
    columnIndices: number[]
): Record<string, unknown> {
    const record: Record<string, unknown> = {};
    for (let j = 0; j < columnIndices.length; j++) {
        const colIdx = columnIndices[j];
        const column = columns[j];
        const colName = sanitizeParquetColumnName(column.name);
        const basicType = columnTypeToHyparquet(column.type);
        const val = row[colIdx];
        if (val === null || val === undefined) continue;
        record[colName] = coerceValueForHyparquetType(val, basicType);
    }
    return record;
}

function schemaElementToDisplayType(element: SchemaElement): string {
    if (element.converted_type === 'UTF8') return 'UTF8';
    if (element.type === 'BYTE_ARRAY' && !element.converted_type) return 'BYTE_ARRAY';
    return element.type ?? 'STRING';
}

export function normalizeParquetReadValue(val: unknown): unknown {
    if (val === null || val === undefined) return null;
    if (typeof val === 'bigint') {
        if (val >= Number.MIN_SAFE_INTEGER && val <= Number.MAX_SAFE_INTEGER) {
            return Number(val);
        }
        return val.toString();
    }
    if (val instanceof Uint8Array) return Buffer.from(val);
    return val;
}

async function readParquetBuffer(filePath: string): Promise<AsyncBuffer> {
    const bytes = await fs.readFile(filePath);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function readParquetFile(filePath: string, maxRows?: number): Promise<ParquetReadResult> {
    const file = await readParquetBuffer(filePath);
    const metadata = await parquetMetadataAsync(file);
    const schema = parquetSchema(metadata);
    const totalRows = Number(metadata.num_rows);

    const columns: ParquetColumnSpec[] = schema.children.map(child => ({
        name: child.element.name,
        type: schemaElementToDisplayType(child.element),
    }));

    const objects = await parquetReadObjects({
        file,
        compressors,
        rowEnd: maxRows,
    });

    const rows = objects.map((record: Record<string, unknown>) =>
        columns.map(col => normalizeParquetReadValue(record[col.name]))
    );

    return { columns, rows, totalRows };
}

export async function writeParquetRows(
    outputPath: string,
    columns: ParquetColumnSpec[],
    rows: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>,
    options?: { rowGroupSize?: number }
): Promise<void> {
    const columnSpec = columns.map(col => ({
        name: sanitizeParquetColumnName(col.name),
        type: columnTypeToHyparquet(col.type),
        nullable: true,
    }));

    const writer = new ByteWriter();
    const result = parquetWriteRows({
        writer,
        rows,
        columns: columnSpec,
        rowGroupSize: options?.rowGroupSize ?? 65536,
    });

    if (result instanceof Promise) {
        await result;
    }

    await fs.writeFile(outputPath, Buffer.from(writer.getBytes()));
}
