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

/**
 * Validate a single wizard cell against the selected target type.
 *
 * Shared by the synchronous preview validation and the background sample
 * validation so both surfaces report identical messages.
 */
export function validateImportCellValue(value: string, typeName: string): string | null {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return null;
    }

    const baseType = getBaseImportTypeName(typeName);

    if (['INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'NUMBER'].includes(baseType)) {
        return /^[-+]?\d+$/.test(trimmed) ? null : 'Expected an integer value.';
    }

    if (
        [
            'NUMERIC',
            'DECIMAL',
            'REAL',
            'DOUBLE',
            'FLOAT',
            'DOUBLE PRECISION',
            'MONEY',
            'SMALLMONEY',
            'DECFLOAT',
        ].includes(baseType)
    ) {
        return /^[-+]?\d+(?:[.,]\d+)?$/.test(trimmed) ? null : 'Expected a numeric value.';
    }

    if (['BOOLEAN', 'BOOL', 'BIT'].includes(baseType)) {
        return /^(true|false|1|0|yes|no|y|n|t|f)$/i.test(trimmed) ? null : 'Expected a boolean value.';
    }

    if (baseType === 'DATE') {
        return isRealDate(trimmed) ? null : 'Expected a valid date value.';
    }

    if (['TIMESTAMP', 'DATETIME', 'DATETIME2', 'TIMESTAMP_NTZ'].includes(baseType)) {
        return isRealTimestamp(trimmed) ? null : 'Expected a valid timestamp value.';
    }

    return null;
}
