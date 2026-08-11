/**
 * Pull-based source row reader.
 *
 * Reads rows one at a time from a live source connection (`executeReader()`),
 * never materializing the full result set. Cell values are formatted to plain
 * string cells suitable for the target writers.
 */

import type { DatabaseConnection } from '../contracts/database';
import { getEffectiveResultColumnType } from '../core/streaming/resultColumnMetadata';
import type { MigrationProgressCallback, MigrationSourceContext } from './types';
import { createMigrationProgress } from './progress';

export interface SourceColumnDescriptor {
    /** Positional index in the result set. */
    index: number;
    name: string;
    /** Declared driver type (uppercased), may be generic for expressions. */
    driverType: string;
    /** True when result metadata is not sufficient and values may refine the type. */
    requiresValueSampling?: boolean;
    /** Source nullability when table metadata exposes it. */
    notNull?: boolean;
    /** Simple literal default value from source table metadata (table mode). */
    defaultValue?: string;
}

export interface SourceRowSet {
    columns: SourceColumnDescriptor[];
    /** Opens the reader; call `readRow` until null. */
    rows(): AsyncGenerator<string[], void, unknown>;
    close(): Promise<void>;
    connection: DatabaseConnection;
}

export function formatSourceCellValue(value: unknown, driverType?: string): string {
    if (value === null || value === undefined) {
        return '';
    }
    if (value instanceof Date) {
        if (isNaN(value.getTime())) {
            return '';
        }
        const pad = (part: number) => String(part).padStart(2, '0');
        const datePart = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
        const baseType = driverType ? getBaseTypeName(driverType) : '';
        if (baseType === 'DATE') {
            // DATE columns may carry a timezone artifact (e.g. midnight+2h);
            // the time part is meaningless for a date transfer.
            return datePart;
        }
        const hasTime = value.getHours() !== 0 || value.getMinutes() !== 0 || value.getSeconds() !== 0;
        if (!hasTime) {
            return datePart;
        }
        return `${datePart} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
    }
    if (typeof value === 'boolean') {
        return value ? '1' : '0';
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value) : '';
    }
    if (ArrayBuffer.isView(value)) {
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        return `hex:${Buffer.from(bytes).toString('hex')}`;
    }
    if (typeof value === 'string') {
        return value;
    }
    return String(value);
}

function getBaseTypeName(typeName: string): string {
    const normalized = typeName.trim().toUpperCase();
    const parenIndex = normalized.indexOf('(');
    return (parenIndex >= 0 ? normalized.slice(0, parenIndex) : normalized).trim();
}

export interface SourceRowReaderOptions {
    progressCallback?: MigrationProgressCallback;
    startedAt?: number;
    totalRows?: number;
    /** Report progress at most once per this many rows read. */
    reportEveryRows?: number;
}

/**
 * Executes `sql` on the source connection and returns a pull-based row set
 * with formatted string cells.
 */
export async function openSourceRowSet(
    connection: DatabaseConnection,
    sql: string,
    options?: SourceRowReaderOptions,
): Promise<SourceRowSet> {
    const command = connection.createCommand(sql);
    command.commandTimeout = 7200;
    const reader = await command.executeReader();
    const hasFirstRow = await reader.read();
    const fieldCount = reader.fieldCount;

    const columnNames = Array.from({ length: fieldCount }, (_value, index) => {
        try {
            return reader.getName(index) || `COL_${index}`;
        } catch {
            return `COL_${index}`;
        }
    });

    const driverTypes = columnNames.map((_name, index) => {
        try {
            return getEffectiveResultColumnType(reader as unknown as Parameters<typeof getEffectiveResultColumnType>[0], index) ?? '';
        } catch {
            return '';
        }
    });

    const columns: SourceColumnDescriptor[] = columnNames.map((name, index) => ({
        index,
        name,
        driverType: driverTypes[index],
    }));

    const startedAt = options?.startedAt ?? Date.now();
    const totalRows = options?.totalRows;
    const reportEveryRows = options?.reportEveryRows ?? 5000;
    const progressCallback = options?.progressCallback;

    let closed = false;
    let rowsRead = 0;
    let lastReport = 0;
    let firstRowPending = hasFirstRow;

    async function* rows(): AsyncGenerator<string[], void, unknown> {
        try {
            while (firstRowPending || await reader.read()) {
                firstRowPending = false;
                const cells = Array.from({ length: fieldCount }, (_value, index) =>
                    formatSourceCellValue(reader.getValue(index), driverTypes[index]),
                );
                rowsRead++;
                if (progressCallback && rowsRead - lastReport >= reportEveryRows) {
                    lastReport = rowsRead;
                    progressCallback(
                        createMigrationProgress('stream', rowsRead, totalRows, `Reading rows from source...`, startedAt),
                    );
                }
                yield cells;
            }
        } finally {
            if (!closed) {
                await reader.close().catch(() => undefined);
                closed = true;
            }
        }
    }

    return {
        columns,
        rows,
        connection,
        async close() {
            if (!closed) {
                closed = true;
                await reader.close().catch(() => undefined);
            }
        },
    };
}

export interface MigrationSourceConnection {
    context: MigrationSourceContext;
    connection: DatabaseConnection;
}

export async function closeSourceConnection(
    source: MigrationSourceConnection | undefined,
): Promise<void> {
    if (source) {
        try {
            await source.connection.close();
        } catch {
            // Best-effort close during cleanup.
        }
    }
}
