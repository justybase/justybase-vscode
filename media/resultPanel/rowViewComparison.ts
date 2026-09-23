import { formatCellValue } from './utils.js';
import type { TanStackColumn } from './types.js';

function binaryBytes(value: unknown): Uint8Array | undefined {
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return undefined;
}

function stableValue(value: unknown, seen: WeakSet<object>): string {
    if (value === null) return 'null';
    if (value === undefined) return 'null';
    if (value instanceof Date) {
        return JSON.stringify(['date', Number.isNaN(value.getTime()) ? 'invalid' : value.getTime()]);
    }
    if (typeof value === 'number') {
        if (Number.isNaN(value)) return JSON.stringify(['number', 'NaN']);
        if (value === Number.POSITIVE_INFINITY) return JSON.stringify(['number', 'Infinity']);
        if (value === Number.NEGATIVE_INFINITY) return JSON.stringify(['number', '-Infinity']);
        if (Object.is(value, -0)) return JSON.stringify(['number', 0]);
        return JSON.stringify(['number', value]);
    }
    if (typeof value === 'bigint') return JSON.stringify(['bigint', value.toString()]);
    if (typeof value === 'string') return JSON.stringify(['string', value]);
    if (typeof value === 'boolean') return JSON.stringify(['boolean', value]);
    if (typeof value === 'symbol') return JSON.stringify(['symbol', String(value.description ?? '')]);
    if (typeof value === 'function') return JSON.stringify(['function', String(value)]);

    const bytes = binaryBytes(value);
    if (bytes) return JSON.stringify(['binary', Array.from(bytes)]);

    if (typeof value !== 'object') return `${typeof value}:${String(value)}`;
    if (seen.has(value)) return JSON.stringify(['object', '[circular]']);
    seen.add(value);

    let serialized: unknown;
    if (Array.isArray(value)) {
        serialized = ['array', value.map(item => stableValue(item, seen))];
    } else {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        serialized = ['object', keys.map(key => [key, stableValue(record[key], seen)])];
    }
    seen.delete(value);
    return JSON.stringify(serialized);
}

/** Compare raw result values while keeping SQL NULL, empty text, and typed values distinct. */
export function areRowViewValuesEqual(values: readonly unknown[]): boolean {
    if (values.length < 2) return true;
    const first = stableValue(values[0], new WeakSet<object>());
    return values.slice(1).every(value => stableValue(value, new WeakSet<object>()) === first);
}

function displayValue(value: unknown, column: TanStackColumn): { text: string; className: string } {
    if (value === null || value === undefined) {
        return { text: 'NULL', className: 'null' };
    }

    const type = (column.columnDef.dataType ?? '').toLowerCase();
    if (type.includes('bool')) {
        const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value;
        const isTrue = normalized === true || normalized === 1 || normalized === 'true';
        return isTrue
            ? { text: '✓ true', className: 'boolean-t' }
            : { text: '✕ false', className: 'boolean-f' };
    }

    let className = '';
    if (/int|dec|float|num|real|double|numeric|decimal/u.test(type)) {
        className = 'number';
    } else if (/date|time/u.test(type) || value instanceof Date) {
        className = 'date';
    }

    const formatted = formatCellValue(value, column.columnDef.dataType, column.columnDef.scale, {
        columnId: column.id,
        inferredNumericKind: column.columnDef.inferredNumericKind,
        inferredDateInteger: column.columnDef.inferredDateInteger,
    });
    return { text: formatted ?? String(value), className };
}

function getTypeLabel(dataType: string | undefined): string {
    const type = (dataType ?? '').toLowerCase();
    if (/int|dec|float|num|real|double|numeric|decimal/u.test(type)) return 'num';
    if (/char|text|varchar|clob|string/u.test(type)) return 'txt';
    if (/date|time/u.test(type)) return 'dt';
    if (/bool/u.test(type)) return 'bool';
    return 'oth';
}

/** Build the Row View with DOM text nodes so database values and column names are never parsed as HTML. */
export function renderRowViewComparison(
    content: HTMLElement,
    columns: readonly TanStackColumn[],
    rows: readonly (readonly unknown[])[],
): void {
    content.replaceChildren();
    if (rows.length === 0) return;

    const table = document.createElement('div');
    table.className = 'row-view-table';

    columns.forEach((column, columnIndex) => {
        const values = rows.map(row => row[columnIndex]);
        const isDiff = !areRowViewValuesEqual(values);
        const section = document.createElement('div');
        section.className = `row-view-section${isDiff ? ' diff' : ''}`;

        const key = document.createElement('div');
        key.className = 'row-view-key';
        const name = document.createElement('span');
        name.className = 'row-view-key-name';
        name.textContent = String(column.columnDef.header ?? column.id);
        const type = document.createElement('span');
        type.className = 'row-view-key-type';
        type.textContent = getTypeLabel(column.columnDef.dataType);
        key.append(name, type);

        const valueContainer = document.createElement('div');
        valueContainer.className = 'row-view-vals';
        values.forEach((value, rowIndex) => {
            if (rows.length > 1) {
                const label = document.createElement('span');
                label.className = `row-view-val label${isDiff ? ' diff' : ''}`;
                label.textContent = `Row ${rowIndex + 1}`;
                valueContainer.appendChild(label);
            }
            const formatted = displayValue(value, column);
            const valueElement = document.createElement('span');
            valueElement.className = `row-view-val${formatted.className ? ` ${formatted.className}` : ''}`;
            valueElement.textContent = formatted.text;
            valueContainer.appendChild(valueElement);
        });

        section.append(key, valueContainer);
        table.appendChild(section);
    });

    content.appendChild(table);
}
