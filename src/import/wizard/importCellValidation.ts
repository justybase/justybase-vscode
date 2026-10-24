import {
    detectImportDecimalDelimiter,
    parseFormattedImportNumber,
} from '@justybase/database-utils/importNumberParsing';
import { getBaseImportTypeName } from './adapters/DatabaseImportWizardAdapter';

function normalizeDateCandidate(value: string): string | null {
    const isoMatch = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (isoMatch) {
        const [, year, month, day] = isoMatch;
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    const localMatch = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (!localMatch) {
        return null;
    }

    const [, day, month, year] = localMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function normalizeTimestampCandidate(value: string): string | null {
    const normalized = value.replace('T', ' ').trim();
    const isoMatch = normalized.match(
        /^(\d{4}-\d{1,2}-\d{1,2})(?:\s+(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?$/,
    );
    if (isoMatch) {
        const [, datePart, hour = '00', minute = '00', second = '00'] = isoMatch;
        const normalizedDate = normalizeDateCandidate(datePart);
        return normalizedDate
            ? `${normalizedDate} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`
            : null;
    }

    const localMatch = normalized.match(
        /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?$/,
    );
    if (!localMatch) {
        return null;
    }

    const [, day, month, year, hour = '00', minute = '00', second = '00'] = localMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`;
}

function isRealDate(value: string): boolean {
    const normalized = normalizeDateCandidate(value);
    if (!normalized) {
        return false;
    }

    const [yearText, monthText, dayText] = normalized.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const parsed = new Date(`${normalized}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}

function isRealTimestamp(value: string): boolean {
    const normalized = normalizeTimestampCandidate(value);
    if (!normalized) {
        return false;
    }

    const parsed = new Date(normalized.replace(' ', 'T') + 'Z');
    return !Number.isNaN(parsed.getTime());
}

const INTEGER_BASE_TYPES = new Set(['INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT']);
const NUMERIC_BASE_TYPES = new Set([
    'NUMERIC',
    'DECIMAL',
    'REAL',
    'DOUBLE',
    'FLOAT',
    'DOUBLE PRECISION',
    'NUMBER',
    'MONEY',
    'SMALLMONEY',
    'DECFLOAT',
]);
const BOOLEAN_BASE_TYPES = new Set(['BOOLEAN', 'BOOL', 'BIT']);
const TIMESTAMP_BASE_TYPES = new Set(['TIMESTAMP', 'DATETIME', 'DATETIME2', 'TIMESTAMP_NTZ']);
const BOOLEAN_PATTERN = /^(true|false|1|0|yes|no|y|n|t|f)$/i;

export type ImportCellValidator = (value: string) => string | null;

function isPlainInteger(value: string): boolean {
    return /^[+-]?\d+$/.test(value);
}

function isPlainNumber(value: string, decimalDelimiter: string): boolean {
    return decimalDelimiter === ','
        ? /^[+-]?\d+(?:,\d+)?$/.test(value)
        : /^[+-]?\d+(?:\.\d+)?$/.test(value);
}

function validateTrimmedValue(
    trimmed: string,
    baseType: string,
    decimalDelimiter: string | undefined,
): string | null {
    if (INTEGER_BASE_TYPES.has(baseType)) {
        if (isPlainInteger(trimmed)) {
            return null;
        }
        const effectiveDecimalDelimiter = decimalDelimiter ?? detectImportDecimalDelimiter([trimmed]);
        const parsed = parseFormattedImportNumber(trimmed, effectiveDecimalDelimiter);
        return parsed && !parsed.fractionDigits ? null : 'Expected an integer value.';
    }

    if (NUMERIC_BASE_TYPES.has(baseType)) {
        const effectiveDecimalDelimiter = decimalDelimiter ?? detectImportDecimalDelimiter([trimmed]);
        if (isPlainNumber(trimmed, effectiveDecimalDelimiter)) {
            return null;
        }
        return parseFormattedImportNumber(trimmed, effectiveDecimalDelimiter)
            ? null
            : 'Expected a numeric value.';
    }

    if (BOOLEAN_BASE_TYPES.has(baseType)) {
        return BOOLEAN_PATTERN.test(trimmed) ? null : 'Expected a boolean value.';
    }

    if (baseType === 'DATE') {
        return isRealDate(trimmed) ? null : 'Expected a valid date value.';
    }

    if (TIMESTAMP_BASE_TYPES.has(baseType)) {
        return isRealTimestamp(trimmed) ? null : 'Expected a valid timestamp value.';
    }

    return null;
}

/**
 * Create a reusable per-column validator. Large background samples validate
 * tens of thousands of cells, so resolving the base type and decimal style once
 * per column avoids repeating that work for every cell.
 */
export function createImportCellValidator(
    typeName: string,
    decimalDelimiter?: string,
): ImportCellValidator {
    const baseType = getBaseImportTypeName(typeName);
    const isSupported =
        INTEGER_BASE_TYPES.has(baseType)
        || NUMERIC_BASE_TYPES.has(baseType)
        || BOOLEAN_BASE_TYPES.has(baseType)
        || baseType === 'DATE'
        || TIMESTAMP_BASE_TYPES.has(baseType);
    if (!isSupported) {
        return () => null;
    }

    return (value: string) => {
        const trimmed = String(value || '').trim();
        if (!trimmed) {
            return null;
        }
        return validateTrimmedValue(trimmed, baseType, decimalDelimiter);
    };
}

/**
 * Validate a single wizard cell against the selected target type.
 *
 * Shared by the synchronous preview validation and the background sample
 * validation so both surfaces report identical messages.
 */
export function validateImportCellValue(
    value: string,
    typeName: string,
    decimalDelimiter?: string,
): string | null {
    return createImportCellValidator(typeName, decimalDelimiter)(value);
}
