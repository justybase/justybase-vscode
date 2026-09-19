const NUMERIC_TYPES = new Set([
    'INT8',
    'INT2',
    'INT4',
    'INT',
    'INTEGER',
    'BIGINT',
    'SMALLINT',
    'BYTEINT',
    'NUMERIC',
    'DECIMAL',
    'NUMBER',
    'FIXED',
    'FLOAT',
    'FLOAT4',
    'FLOAT8',
    'REAL',
    'DOUBLE',
    'DOUBLE PRECISION',
    'DECFLOAT',
    'MONEY',
    'SMALLMONEY'
]);

const NUMERIC_STRING_PATTERN = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;
const EXCEL_SIGNIFICANT_DIGITS = 15;

function normalizeTypeName(type?: string): string | undefined {
    return type
        ?.trim()
        .replace(/\s+/g, ' ')
        .toUpperCase();
}

export function shouldConvertToExcelNumber(type?: string): boolean {
    const normalized = normalizeTypeName(type);
    if (!normalized) {
        return false;
    }

    return Array.from(NUMERIC_TYPES).some(baseType => normalized === baseType || normalized.startsWith(baseType + '('));
}

function isZeroNumericString(value: string): boolean {
    return /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:[eE][+-]?\d+)?$/.test(value);
}

function roundDecimalStringToSignificantDigits(value: string): string {
    const sign = value.startsWith('-') ? '-' : '';
    const unsignedValue = value[0] === '+' || value[0] === '-'
        ? value.slice(1)
        : value;
    const exponentSeparator = unsignedValue.search(/[eE]/);
    const mantissa = exponentSeparator >= 0
        ? unsignedValue.slice(0, exponentSeparator)
        : unsignedValue;
    const exponentText = exponentSeparator >= 0
        ? unsignedValue.slice(exponentSeparator + 1)
        : '';
    const exponent = exponentText.length > 0 ? Number(exponentText) : 0;
    if (!Number.isFinite(exponent)) {
        return value;
    }

    const decimalPointIndex = mantissa.indexOf('.');
    const digitsBeforeDecimal = decimalPointIndex >= 0 ? decimalPointIndex : mantissa.length;
    const digits = mantissa.replace('.', '');
    const firstSignificantDigitIndex = digits.search(/[1-9]/);
    if (firstSignificantDigitIndex < 0) {
        return value;
    }

    const significantDigits = digits.slice(firstSignificantDigitIndex);
    if (significantDigits.length <= EXCEL_SIGNIFICANT_DIGITS) {
        return value;
    }

    let scientificExponent = exponent + digitsBeforeDecimal - firstSignificantDigitIndex - 1;
    if (!Number.isFinite(scientificExponent)) {
        return value;
    }

    let roundedDigits = BigInt(significantDigits.slice(0, EXCEL_SIGNIFICANT_DIGITS));
    if (significantDigits[EXCEL_SIGNIFICANT_DIGITS] >= '5') {
        roundedDigits += 1n;
    }

    let roundedDigitsText = roundedDigits.toString();
    if (roundedDigitsText.length > EXCEL_SIGNIFICANT_DIGITS) {
        roundedDigitsText = `1${'0'.repeat(EXCEL_SIGNIFICANT_DIGITS)}`;
        scientificExponent += 1;
    } else {
        roundedDigitsText = roundedDigitsText.padStart(EXCEL_SIGNIFICANT_DIGITS, '0');
    }

    if (!Number.isFinite(scientificExponent)) {
        return value;
    }

    return `${sign}${roundedDigitsText[0]}.${roundedDigitsText.slice(1)}e${scientificExponent}`;
}

/**
 * Excel stores cell numbers as IEEE-754 doubles and supports about 15
 * significant decimal digits. Round the decimal text first, then convert
 * the rounded value to a numeric cell to avoid binary floating-point
 * double-rounding at decimal boundaries.
 */
function roundNumericValueForExcel(value: string): number | string {
    const roundedDecimal = roundDecimalStringToSignificantDigits(value);
    const numericValue = Number(roundedDecimal);
    if (!Number.isFinite(numericValue)) {
        return value;
    }

    // Do not turn a non-zero value that underflowed to zero into a different
    // numeric value. Excel cannot represent it faithfully as a cell number.
    if (numericValue === 0 && !isZeroNumericString(value)) {
        return value;
    }

    return numericValue;
}

export function convertToExcelNumberIfNumericString(val: unknown, type?: string): unknown {
    if (typeof val === 'bigint') {
        if (type && shouldConvertToExcelNumber(type)) {
            return roundNumericValueForExcel(val.toString());
        }
        return val;
    }
    if (typeof val !== 'string') {
        return val;
    }

    if (type !== undefined && !shouldConvertToExcelNumber(type)) {
        return val;
    }

    const trimmed = val.trim();
    if (trimmed.length === 0 || !NUMERIC_STRING_PATTERN.test(trimmed)) {
        return val;
    }

    // CSV exports do not carry column metadata. Keep their old conservative
    // inference for long values, while typed database columns use the Excel
    // precision policy below.
    if (type === undefined && trimmed.length > EXCEL_SIGNIFICANT_DIGITS && !/^-?0\d+/.test(trimmed)) {
        return val;
    }

    return roundNumericValueForExcel(trimmed);
}

export function convertRowExcelNumericStrings(row: unknown[]): unknown[] {
    return row.map(value => convertToExcelNumberIfNumericString(value));
}
