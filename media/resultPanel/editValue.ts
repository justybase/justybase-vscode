export type TypedEditResult =
    | { valid: true; value: unknown }
    | { valid: false; message: string };

function isIntegerType(dataType: string): boolean {
    return /\b(?:tinyint|smallint|mediumint|bigint|hugeint|integer|int(?:2|4|8|16|32|64)?|u(?:tinyint|smallint|integer|bigint|hugeint|int(?:8|16|32|64)?)|byteint|serial|smallserial|bigserial)\b/i.test(dataType);
}

export function isNumericEditType(dataType: string): boolean {
    return isIntegerType(dataType) || /\b(?:numeric|decimal|number|float|double|real|money|smallmoney|decfloat|single)\b/i.test(dataType);
}

export function isBooleanEditType(dataType: string | undefined): boolean {
    const type = dataType ?? '';
    return /\b(?:bool|boolean)\b/i.test(type) || /^\s*bit\s*(?:\(\s*1\s*\))?\s*$/i.test(type);
}

function isDateOnlyType(dataType: string): boolean {
    return /\bdate\b/i.test(dataType) && !/time|timestamp/i.test(dataType);
}

export function parseTypedEditValue(
    text: string,
    dataType: string | undefined,
    setNull: boolean,
): TypedEditResult {
    if (setNull) return { valid: true, value: null };
    const type = dataType ?? '';

    if (isBooleanEditType(type)) {
        const value = text.trim().toLowerCase();
        if (value === 'true') return { valid: true, value: true };
        if (value === 'false') return { valid: true, value: false };
        return { valid: false, message: 'Choose TRUE, FALSE, or NULL.' };
    }

    if (isNumericEditType(type)) {
        const value = text.trim();
        if (isIntegerType(type) && !/^[+-]?\d+$/.test(value)) {
            return { valid: false, message: 'Enter a whole number, or choose NULL.' };
        }
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
            return { valid: false, message: 'Enter a valid numeric value, or choose NULL.' };
        }
        // Keep decimals as text so editing never rounds large or high-precision values.
        return { valid: true, value };
    }

    if (isDateOnlyType(type)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
            return { valid: false, message: 'Enter a date in YYYY-MM-DD format, or choose NULL.' };
        }
        const date = new Date(`${text}T00:00:00.000Z`);
        if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
            return { valid: false, message: 'Enter a valid calendar date.' };
        }
    }

    if (/\bjson\b/i.test(type)) {
        try {
            JSON.parse(text);
        } catch {
            return { valid: false, message: 'Enter valid JSON.' };
        }
    }

    return { valid: true, value: text };
}

export function editValuesEqual(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if ((typeof left === 'number' || typeof left === 'string')
        && (typeof right === 'number' || typeof right === 'string')) {
        return String(left) === String(right);
    }
    if (left instanceof Date && right instanceof Date) {
        return left.getTime() === right.getTime();
    }
    if (left instanceof Date && typeof right === 'string') {
        const isoValue = left.toISOString();
        return right === isoValue || right === isoValue.slice(0, 10);
    }
    if (right instanceof Date && typeof left === 'string') {
        const isoValue = right.toISOString();
        return left === isoValue || left === isoValue.slice(0, 10);
    }
    return false;
}

export function toEditableCellText(value: unknown, dataType: string | undefined): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) {
        const pad = (part: number, size = 2) => String(part).padStart(size, '0');
        const date = `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
        if (/\bdate\b/i.test(dataType ?? '') && !/time|timestamp/i.test(dataType ?? '')) return date;
        return `${date}T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}.${pad(value.getUTCMilliseconds(), 3)}Z`;
    }
    return String(value);
}
