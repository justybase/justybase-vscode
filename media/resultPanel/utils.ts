// Utils module - Utility functions for result panel
import {
    getResultFormattingPayload,
    getResultFormattingState
} from './state.js';
import { postHostMessage } from './protocol.js';
import {
    getActiveSourceUri,
    type ColumnFormattingOverride,
    type FormatCellValueContext,
    type FormatNumericContext,
    type FormattingDecimalSettings,
    type FormattingIntegerSettings,
    type FormattingSettings,
    type ParsedDecimalParts,
    type ParsedYyyymmddDate,
    type RoundedDecimalParts,
} from './types.js';

const vscode = { postMessage: postHostMessage };

export type {
    FormatCellValueContext,
    FormatNumericContext,
    FormattingDecimalSettings,
    FormattingIntegerSettings,
    FormattingSettings,
} from './types.js';

export interface DebouncedFunction<T extends (...args: unknown[]) => unknown> {
    (...args: Parameters<T>): void;
    cancel(): void;
}

/**
 * Debounce utility function
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
    func: T,
    wait: number,
): DebouncedFunction<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const debounced = function executedFunction(...args: Parameters<T>) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    } as DebouncedFunction<T>;
    debounced.cancel = function cancel() {
        clearTimeout(timeout);
    };
    return debounced;
}

const DEFAULT_FORMATTING_SETTINGS: FormattingSettings = {
    integer: { useGrouping: true, groupSeparator: ' ' },
    decimal: {
        useGrouping: true,
        groupSeparator: ' ',
        decimalSeparator: '.',
        scale: 4,
        preserveTrailingZeros: true,
        roundingMode: 'half-up'
    },
    useFormattedValuesForExport: false
};

const INTEGER_TYPE_ALIASES = new Set([
    'tinyint',
    'smallint',
    'mediumint',
    'int',
    'integer',
    'bigint',
    'byteint',
    'serial',
    'smallserial',
    'bigserial',
    'serial2',
    'serial4',
    'serial8',
    'int1',
    'int2',
    'int4',
    'int8',
    'int16',
    'int32',
    'int64',
    'utinyint',
    'usmallint',
    'uinteger',
    'ubigint',
    'hugeint',
    'uhugeint',
    'uint8',
    'uint16',
    'uint32',
    'uint64'
]);

const SCALE_SENSITIVE_DECIMAL_TYPE_ALIASES = new Set([
    'numeric',
    'decimal',
    'dec',
    'number',
    'fixed'
]);

const DEFAULT_SCALE_DECIMAL_TYPE_ALIASES = new Set([
    'float',
    'float4',
    'float8',
    'real',
    'double',
    'double precision',
    'binary_float',
    'binary_double',
    'single',
    'single precision',
    'decfloat'
]);

const ALWAYS_DECIMAL_TYPE_ALIASES = new Set([
    'money',
    'smallmoney'
]);

const RIGHT_ALIGNED_TEMPORAL_TYPE_ALIASES = new Set([
    'date',
    'datetime',
    'datetime2',
    'datetimeoffset',
    'smalldatetime',
    'timestamp',
    'timestamp without time zone',
    'timestamp with time zone',
    'timestamptz',
    'timestamp_ntz',
    'timestamp_ltz',
    'timestamp_tz',
    'time',
    'timetz',
    'abstime',
    'reltime',
    'interval',
]);

const DECIMAL_TYPE_ALIASES = new Set([
    ...SCALE_SENSITIVE_DECIMAL_TYPE_ALIASES,
    ...DEFAULT_SCALE_DECIMAL_TYPE_ALIASES,
    ...ALWAYS_DECIMAL_TYPE_ALIASES
]);

const SIMPLE_SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*$/;
const YYYYMMDD_INTEGER_DATE_MIN = 10000101;
const YYYYMMDD_INTEGER_DATE_MAX = 99991231;
const YYYYMMDD_INTEGER_DATE_SAMPLE_LIMIT = 100;
const YYYYMMDD_INTEGER_DATE_MIN_MATCHES = 3;

function normalizeTypeName(type: string | undefined | null): string {
    return String(type || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function extractBaseTypeName(type: string | undefined | null): string {
    const normalizedType = normalizeTypeName(type)
        .replace(/\[\]$/, '')
        .replace(/\s+(?:unsigned|signed|zerofill)\b/g, '')
        .replace(/\s+(?:with|without)\s+time\s+zone\b/g, '')
        .trim();
    const parenIndex = normalizedType.indexOf('(');
    return (parenIndex >= 0 ? normalizedType.slice(0, parenIndex) : normalizedType).trim();
}

function normalizeDeclaredScale(scale: number | undefined | null): number | null {
    if (scale === undefined || scale === null || !Number.isFinite(scale)) {
        return null;
    }

    return Math.max(0, Math.floor(scale));
}

function usesDefaultDecimalScale(type: string | undefined | null): boolean {
    return DEFAULT_SCALE_DECIMAL_TYPE_ALIASES.has(extractBaseTypeName(type));
}

function escapeSqlStringLiteral(value: unknown): string {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function parseYyyymmddIntegerDate(value: unknown): ParsedYyyymmddDate | null {
    const raw = sanitizeNumericString(value);
    if (!raw || raw.startsWith('-') || raw.startsWith('+') || raw.includes('.')) {
        return null;
    }

    if (!/^\d{8}$/.test(raw)) {
        return null;
    }

    const numericValue = Number(raw);
    if (!Number.isFinite(numericValue) || numericValue < YYYYMMDD_INTEGER_DATE_MIN || numericValue > YYYYMMDD_INTEGER_DATE_MAX) {
        return null;
    }

    const year = Number(raw.slice(0, 4));
    const month = Number(raw.slice(4, 6));
    const day = Number(raw.slice(6, 8));
    const parsedDate = new Date(Date.UTC(year, month - 1, day));

    if (
        parsedDate.getUTCFullYear() !== year
        || parsedDate.getUTCMonth() !== month - 1
        || parsedDate.getUTCDate() !== day
    ) {
        return null;
    }

    return {
        raw,
        year,
        month: String(month).padStart(2, '0'),
        day: String(day).padStart(2, '0')
    };
}

function formatParsedYyyymmddIntegerDate(
    parsed: ParsedYyyymmddDate | null,
    separator = ' ',
): string | null {
    if (!parsed) {
        return null;
    }

    return `${parsed.year}${separator}${parsed.month}${separator}${parsed.day}`;
}

function resolveDeclaredNumericKind(type: string | undefined, scale?: number | null): 'integer' | 'decimal' | 'none' {
    const baseType = extractBaseTypeName(type);
    if (INTEGER_TYPE_ALIASES.has(baseType)) {
        return 'integer';
    }

    if (SCALE_SENSITIVE_DECIMAL_TYPE_ALIASES.has(baseType)) {
        const resolvedScale = normalizeDeclaredScale(scale) ?? getNumericScale(type);
        return resolvedScale === 0 ? 'integer' : 'decimal';
    }

    if (DECIMAL_TYPE_ALIASES.has(baseType)) {
        return 'decimal';
    }

    return 'none';
}

function cloneFormattingSettings(settings: FormattingSettings): FormattingSettings {
    return {
        integer: { ...settings.integer },
        decimal: { ...settings.decimal },
        useFormattedValuesForExport: settings.useFormattedValuesForExport
    };
}

function mergeFormattingSettings(
    base: FormattingSettings,
    override?: Partial<FormattingSettings> | null,
): FormattingSettings {
    if (!override) {
        return cloneFormattingSettings(base);
    }

    return {
        integer: {
            ...base.integer,
            ...(override.integer || {})
        },
        decimal: {
            ...base.decimal,
            ...(override.decimal || {})
        },
        useFormattedValuesForExport: override.useFormattedValuesForExport ?? base.useFormattedValuesForExport
    };
}

function sanitizeNumericString(value: unknown): string | null {
    if (typeof value === 'bigint') {
        return value.toString();
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return null;
        }
        return String(value);
    }

    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }

    return /^[-+]?\d+(?:\.\d+)?$/.test(trimmed) ? trimmed : null;
}

function parseNumericString(value: unknown): ParsedDecimalParts | null {
    const raw = sanitizeNumericString(value);
    if (!raw) {
        return null;
    }

    const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
    if (!match) {
        return null;
    }

    return {
        sign: match[1] === '-' ? '-' : '',
        integerPart: match[2].replace(/^0+(?=\d)/, '') || '0',
        fractionalPart: match[3] || ''
    };
}

function addGroupSeparators(integerPart: string, separator: string): string {
    return integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

function hasNonZeroDigits(value: string): boolean {
    return /[1-9]/.test(value || '');
}

function incrementDigitString(value: string): string {
    let carry = 1;
    const digits = value.split('');

    for (let index = digits.length - 1; index >= 0; index -= 1) {
        const digit = Number(digits[index]) + carry;
        if (digit >= 10) {
            digits[index] = '0';
            carry = 1;
        } else {
            digits[index] = String(digit);
            carry = 0;
            break;
        }
    }

    if (carry > 0) {
        digits.unshift('1');
    }

    return digits.join('');
}

function shouldRoundHalfEven(
    nextDigit: string,
    remainder: string,
    lastKeptDigit: string,
): boolean {
    if (nextDigit > '5') {
        return true;
    }

    if (nextDigit < '5') {
        return false;
    }

    if (hasNonZeroDigits(remainder)) {
        return true;
    }

    return Number(lastKeptDigit || '0') % 2 === 1;
}

function roundDecimalParts(
    parsed: ParsedDecimalParts,
    scale: number,
    roundingMode: string,
): RoundedDecimalParts {
    const fractional = parsed.fractionalPart || '';
    const discarded = fractional.slice(scale);
    let integerPart = parsed.integerPart;
    let fractionalPart = fractional.slice(0, scale);

    if (discarded.length === 0) {
        return { integerPart, fractionalPart };
    }

    const nextDigit = discarded[0];
    const remainder = discarded.slice(1);
    const discardedHasValue = hasNonZeroDigits(discarded);
    let shouldRoundUp = false;

    switch (roundingMode) {
        case 'ceil':
            shouldRoundUp = parsed.sign !== '-' && discardedHasValue;
            break;
        case 'floor':
            shouldRoundUp = parsed.sign === '-' && discardedHasValue;
            break;
        case 'truncate':
            shouldRoundUp = false;
            break;
        case 'half-even':
            shouldRoundUp = shouldRoundHalfEven(nextDigit, remainder, (fractionalPart || integerPart).slice(-1));
            break;
        case 'half-up':
        default:
            shouldRoundUp = nextDigit >= '5';
            break;
    }

    if (shouldRoundUp) {
        const combined = incrementDigitString(`${integerPart}${fractionalPart}` || '0');
        const splitIndex = Math.max(0, combined.length - scale);
        integerPart = (scale > 0 ? combined.slice(0, splitIndex) : combined) || '0';
        fractionalPart = scale > 0 ? combined.slice(splitIndex).padStart(scale, '0') : '';
    }

    return { integerPart, fractionalPart };
}

function formatIntegerString(
    parsed: ParsedDecimalParts,
    options: FormattingIntegerSettings,
): string {
    const grouped = options.useGrouping
        ? addGroupSeparators(parsed.integerPart, options.groupSeparator || ' ')
        : parsed.integerPart;
    return `${parsed.sign}${grouped}`;
}

function formatDecimalString(
    parsed: ParsedDecimalParts,
    options: FormattingDecimalSettings,
    explicitScale: number | undefined,
    allowOptionsScaleFallback: boolean,
): string {
    const resolvedScale = Number.isFinite(explicitScale)
        ? explicitScale
        : (allowOptionsScaleFallback && Number.isFinite(options.scale) ? options.scale : undefined);

    if (resolvedScale === undefined) {
        const integerPart = options.useGrouping
            ? addGroupSeparators(parsed.integerPart, options.groupSeparator || ' ')
            : parsed.integerPart;
        let fractionalPart = parsed.fractionalPart || '';
        if (fractionalPart.length > 0 && !options.preserveTrailingZeros) {
            fractionalPart = fractionalPart.replace(/0+$/, '');
        }
        const decimalSeparator = options.decimalSeparator || '.';
        const suffix = fractionalPart.length > 0 ? `${decimalSeparator}${fractionalPart}` : '';
        return `${parsed.sign}${integerPart}${suffix}`;
    }

    const rounded = roundDecimalParts(parsed, resolvedScale, options.roundingMode || 'half-up');
    const integerPart = options.useGrouping
        ? addGroupSeparators(rounded.integerPart, options.groupSeparator || ' ')
        : rounded.integerPart;

    let fractionalPart = rounded.fractionalPart;
    if (resolvedScale > 0 && options.preserveTrailingZeros) {
        fractionalPart = fractionalPart.padEnd(resolvedScale, '0');
    } else if (!options.preserveTrailingZeros) {
        fractionalPart = fractionalPart.replace(/0+$/, '');
    }

    const decimalSeparator = options.decimalSeparator || '.';
    const suffix = fractionalPart.length > 0 ? `${decimalSeparator}${fractionalPart}` : '';
    return `${parsed.sign}${integerPart}${suffix}`;
}

/**
 * Check if type is a numeric type that needs formatting
 * @param {string} type - Raw database type
 * @returns {{ isNumeric: boolean; hasDecimal: boolean }}
 */
export function getNumericTypeInfo(type: string | undefined): {
    isNumeric: boolean;
    hasDecimal: boolean;
    isInteger?: boolean;
    numericKind: string;
} {
    const numericKind = resolveDeclaredNumericKind(type);

    return {
        isNumeric: numericKind !== 'none',
        hasDecimal: numericKind === 'decimal',
        isInteger: numericKind === 'integer',
        numericKind
    };
}

export function inferNumericTypeFromRows(
    rows: unknown[][],
    columnIndex: number,
): { dataType?: string; scale?: number; numericKind: string } {
    let sawDecimal = false;
    let sawInteger = false;

    for (let index = 0; index < Math.min(rows.length, 100); index += 1) {
        const row = rows[index];
        const value = Array.isArray(row) ? row[columnIndex] : null;
        const parsed = parseNumericString(value);
        if (!parsed) {
            continue;
        }

        if (parsed.fractionalPart.length > 0) {
            sawDecimal = true;
        } else {
            sawInteger = true;
        }
    }

    if (sawDecimal) {
        return { dataType: '__inferred_decimal__', scale: 4, numericKind: 'decimal' };
    }

    if (sawInteger) {
        return { dataType: '__inferred_integer__', scale: undefined, numericKind: 'integer' };
    }

    return { dataType: undefined, scale: undefined, numericKind: 'none' };
}

export function isDeclaredIntegerType(type: string | undefined): boolean {
    return INTEGER_TYPE_ALIASES.has(extractBaseTypeName(type));
}

export function inferYyyymmddIntegerDateFromValues(
    values: unknown[],
    options: { sampleLimit?: number; minMatches?: number } = {},
): boolean {
    const sampleLimit = Math.max(1, options.sampleLimit ?? YYYYMMDD_INTEGER_DATE_SAMPLE_LIMIT);
    const minMatches = Math.max(1, options.minMatches ?? YYYYMMDD_INTEGER_DATE_MIN_MATCHES);
    let inspected = 0;

    for (let index = 0; index < values.length && inspected < sampleLimit; index += 1) {
        const value = values[index];
        if (value === null || typeof value === 'undefined' || value === '') {
            continue;
        }

        inspected += 1;
        if (!parseYyyymmddIntegerDate(value)) {
            return false;
        }
    }

    return inspected >= minMatches;
}

export function formatSqlIdentifierForInsertion(identifier: string): string {
    const normalizedIdentifier = String(identifier || '').trim();
    if (!normalizedIdentifier) {
        return '';
    }

    if (SIMPLE_SQL_IDENTIFIER_PATTERN.test(normalizedIdentifier)) {
        return normalizedIdentifier;
    }

    return `"${normalizedIdentifier.replace(/"/g, '""')}"`;
}

function getNumericScale(lowerType: string | undefined | null): number | null {
    const normalizedType = normalizeTypeName(lowerType);
    if (!normalizedType) {
        return null;
    }

    const baseType = extractBaseTypeName(normalizedType);
    if (!SCALE_SENSITIVE_DECIMAL_TYPE_ALIASES.has(baseType)) {
        return null;
    }

    const scaleMatch = normalizedType.match(/\(\s*(?:\*|\d+)\s*(?:,\s*(-?\d+)\s*)?\)/);
    if (!scaleMatch) {
        return null;
    }

    if (typeof scaleMatch[1] === 'undefined') {
        return 0;
    }

    const scale = normalizeDeclaredScale(Number(scaleMatch[1]));
    return Number.isFinite(scale) ? scale : null;
}

/**
 * Check if type is temporal and should be aligned right in result cells.
 * @param {string} type - Raw database type
 * @returns {boolean}
 */
export function isTemporalType(type: string | undefined): boolean {
    const normalizedType = normalizeTypeName(type);
    if (!normalizedType) {
        return false;
    }

    if (RIGHT_ALIGNED_TEMPORAL_TYPE_ALIASES.has(normalizedType)
        || RIGHT_ALIGNED_TEMPORAL_TYPE_ALIASES.has(extractBaseTypeName(normalizedType))) {
        return true;
    }

    return normalizedType.includes('timestamp') || normalizedType.includes('datetime');
}

function isEpochSecondTimestamp(value: number): boolean {
    return Number.isFinite(value) && value >= 1_000_000_000 && value < 10_000_000_000;
}

function parseTimeObjectSortKey(value: object): number | null {
    if (!('hours' in value || 'minutes' in value || 'seconds' in value)) {
        return null;
    }

    const timeValue = value as { hours?: unknown; minutes?: unknown; seconds?: unknown };
    const hours = Number(timeValue.hours ?? 0);
    const minutes = Number(timeValue.minutes ?? 0);
    const seconds = Number(timeValue.seconds ?? 0);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
        return null;
    }

    return ((hours * 3600) + (minutes * 60) + seconds) * 1000;
}

/**
 * Normalize temporal cell values to a comparable epoch-millisecond key.
 */
export function parseTemporalSortKey(
    value: unknown,
    type?: string,
    options?: { inferredDateInteger?: boolean },
): number {
    if (value === null || value === undefined) {
        return Number.NaN;
    }

    if (value instanceof Date) {
        return value.getTime();
    }

    if (options?.inferredDateInteger) {
        const yyyymmdd = parseYyyymmddIntegerDate(value);
        if (yyyymmdd) {
            return Number(yyyymmdd.raw);
        }
    }

    if (typeof value === 'number') {
        if (isTemporalType(type) && isEpochSecondTimestamp(value)) {
            return value * 1000;
        }
        return value;
    }

    if (typeof value === 'object') {
        const timeObjectKey = parseTimeObjectSortKey(value);
        if (timeObjectKey !== null) {
            return timeObjectKey;
        }
    }

    const parsed = Date.parse(String(value));
    return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function looksLikeRightAlignedTemporalValue(value: unknown, type: string | undefined): boolean {
    if (value instanceof Date) {
        return true;
    }

    const lowerType = normalizeTypeName(type);
    if (typeof value === 'number' && lowerType === 'date' && value > 19000000 && value < 21000000) {
        return true;
    }

    if (typeof value !== 'string') {
        return false;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return false;
    }

    return /^\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?(?:Z|[+-]\d{2}:?\d{2})?)?)?$/.test(trimmed);
}

/**
 * Check if a result cell should be right aligned based on its data type.
 * @param {string} type - Raw database type
 * @returns {boolean}
 */
export function shouldRightAlignCell(
    type: string | undefined,
    context: { value?: unknown; inferredNumericKind?: string } = {},
): boolean {
    const { value } = context;
    const { isNumeric } = getNumericTypeInfo(type);

    if (context.inferredNumericKind === 'decimal' || context.inferredNumericKind === 'integer') {
        return true;
    }

    if (isNumeric) {
        return typeof value === 'string' ? sanitizeNumericString(value) !== null : true;
    }

    if (isTemporalType(type)) {
        if (value === null || typeof value === 'undefined') {
            return true;
        }
        return looksLikeRightAlignedTemporalValue(value, type);
    }

    return false;
}

interface FormattingPayload {
    global?: Partial<FormattingSettings>;
    connection?: Partial<FormattingSettings>;
    columnOverrides?: Record<string, ColumnFormattingOverride>;
}

function resolveEffectiveFormatting(context: FormatCellValueContext = {}): {
    effective: FormattingSettings;
    columnOverride: ColumnFormattingOverride | undefined;
} {
    const payload = (getResultFormattingPayload() || {
        global: DEFAULT_FORMATTING_SETTINGS,
        columnOverrides: {},
    }) as FormattingPayload;
    let effective = mergeFormattingSettings(DEFAULT_FORMATTING_SETTINGS, payload.global);
    effective = mergeFormattingSettings(effective, payload.connection);

    if (typeof context.rsIndex === 'number') {
        const resultOverride = getResultFormattingState(
            context.rsIndex,
            context.executionTimestamp as number | undefined,
            getActiveSourceUri(),
        );
        effective = mergeFormattingSettings(effective, resultOverride);
    }

    const columnOverride = context.columnId && payload.columnOverrides
        ? payload.columnOverrides[context.columnId]
        : undefined;

    return { effective, columnOverride };
}

function resolveNumericKind(
    type: string | undefined,
    scale: number | undefined | null,
    value: unknown,
    context: FormatCellValueContext = {},
): string {
    const declaredKind = resolveDeclaredNumericKind(type, scale);
    if (declaredKind !== 'none') {
        return declaredKind;
    }

    if (context.inferredNumericKind === 'decimal' || context.inferredNumericKind === 'integer') {
        return context.inferredNumericKind;
    }

    if (typeof value === 'number' || typeof value === 'bigint') {
        return 'integer';
    }

    return 'none';
}

function resolveDisplayDecimalScale(
    type: string | undefined,
    scale: number | null | undefined,
    defaultScale: number | undefined,
): number | undefined {
    const fromMetadata = normalizeDeclaredScale(scale) ?? getNumericScale(type);

    if (usesDefaultDecimalScale(type)) {
        // Float/real columns often report scale 0; that is not an integer declaration.
        if (fromMetadata === 0) {
            return defaultScale;
        }
        if (fromMetadata === null || fromMetadata === undefined) {
            return undefined;
        }
        return fromMetadata;
    }

    if (fromMetadata !== null && fromMetadata !== undefined) {
        return fromMetadata;
    }

    return defaultScale;
}

function formatNumericValue(
    value: unknown,
    type: string | undefined,
    scale: number | null,
    context: FormatNumericContext = {},
): string {
    const parsed = parseNumericString(value);
    if (!parsed) {
        return String(value);
    }

    const { effective, columnOverride } = resolveEffectiveFormatting(context);
    let numericKind = resolveNumericKind(type, scale, value, context);
    if (columnOverride?.kind === 'integer' || columnOverride?.kind === 'decimal') {
        numericKind = columnOverride.kind;
    }

    if (numericKind === 'integer') {
        const integerOptions = {
            ...effective.integer,
            ...(columnOverride?.integer || {})
        };
        return formatIntegerString(parsed, integerOptions);
    }

    if (numericKind === 'decimal') {
        const decimalOptions = {
            ...effective.decimal,
            ...(columnOverride?.decimal || {})
        };
        const decimalScale = resolveDisplayDecimalScale(type, scale, decimalOptions.scale);
        const allowOptionsScaleFallback = decimalScale !== undefined
            || !usesDefaultDecimalScale(type);
        return formatDecimalString(parsed, decimalOptions, decimalScale, allowOptionsScaleFallback);
    }

    return String(value);
}

/**
 * Format cell value for display based on data type
 */
export function formatCellValue(
    value: unknown,
    type: string | undefined,
    scale: number | undefined,
    context: FormatCellValueContext = {},
): string | null {
    if (value === null || value === undefined) return null;

    const lowerType = normalizeTypeName(type);
    const numericScale = normalizeDeclaredScale(scale) ?? getNumericScale(type);

    if (context.inferredDateInteger) {
        const inferredDateDisplay = formatParsedYyyymmddIntegerDate(parseYyyymmddIntegerDate(value));
        if (inferredDateDisplay) {
            return inferredDateDisplay;
        }
    }

    // Check if this is a numeric type that needs formatting
    const { isNumeric } = getNumericTypeInfo(type);

    if (isNumeric || context.inferredNumericKind === 'decimal' || context.inferredNumericKind === 'integer') {
        return formatNumericValue(value, type, numericScale, context);
    }

    if (value instanceof Date) {
        // Use UTC methods to avoid timezone conversion issues
        const y = value.getUTCFullYear();
        const m = String(value.getUTCMonth() + 1).padStart(2, '0');
        const d = String(value.getUTCDate()).padStart(2, '0');

        if (lowerType === 'date') {
            return `${y}-${m}-${d}`;
        } else if (lowerType.includes('timestamp') || lowerType.includes('datetime') || lowerType.includes('time')) {
            const hh = String(value.getUTCHours()).padStart(2, '0');
            const mm = String(value.getUTCMinutes()).padStart(2, '0');
            const ss = String(value.getUTCSeconds()).padStart(2, '0');
            return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
        }
        // Fallback for other Date objects - use ISO string (timezone-agnostic)
        try {
            return value.toISOString().replace('T', ' ').substring(0, 19);
        } catch (e) {
            return String(value);
        }
    }

    // Handle Netezza DATE represented as YYYYMMDD integer
    if (typeof value === 'number' && lowerType === 'date' && value > 19000000 && value < 21000000) {
        const s = String(value);
        return `${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}`;
    }

    // Handle generic objects that might be Time/Interval or just need string representation
    if (typeof value === 'object' && value !== null) {
        // If it has a custom toString (different from [object Object]), use it
        const str = String(value);
        if (str !== '[object Object]') {
            return str;
        }

        // Handle common Time object structures: {hours, minutes, seconds}
        if ('hours' in value || 'minutes' in value || 'seconds' in value) {
            const timeValue = value as { hours?: unknown; minutes?: unknown; seconds?: unknown };
            const hh = String(timeValue.hours ?? 0).padStart(2, '0');
            const mm = String(timeValue.minutes ?? 0).padStart(2, '0');
            const ss = String(timeValue.seconds ?? 0).padStart(2, '0');
            return `${hh}:${mm}:${ss}`;
        }
    }

    return String(value);
}

export function formatCellValueForSql(
    value: unknown,
    type?: string,
    scale?: number,
    context: FormatCellValueContext = {},
): string {
    if (value === null || value === undefined) {
        return 'NULL';
    }

    if (typeof value === 'boolean') {
        return value ? 'TRUE' : 'FALSE';
    }

    const numericKind = resolveNumericKind(type, scale, value, context);
    if (numericKind === 'integer' || numericKind === 'decimal') {
        return sanitizeNumericString(value) ?? String(value);
    }

    const lowerType = normalizeTypeName(type);
    const isBooleanType = lowerType === 'bool' || lowerType === 'boolean';

    if (isBooleanType && typeof value === 'string') {
        const trimmed = value.trim().toLowerCase();
        if (trimmed === 'true' || trimmed === 'false') {
            return trimmed.toUpperCase();
        }
    }

    const formattedValue = formatCellValue(value, type, scale, {
        ...context,
        inferredDateInteger: false
    });

    if (formattedValue === null || formattedValue === undefined) {
        return 'NULL';
    }

    return escapeSqlStringLiteral(formattedValue);
}

export function getEffectiveFormattingPayload(): Record<string, unknown> {
    return getResultFormattingPayload();
}

/**
 * Escape CSV value for export
 */
export function escapeCsvValue(value: unknown, separator = ','): string {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(separator) || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

/**
 * Validate required libraries are loaded
 */
export function validateRequiredLibraries(): { TableCore: typeof TableCore } | null {
    if (typeof TableCore === 'undefined') {
        showError('TableCore is not defined. The TanStack Table library might not have loaded.');
        return null;
    }

    if (typeof VirtualCore === 'undefined') {
        showError('VirtualCore is not defined. The TanStack Virtual library might not have loaded.');
        return null;
    }

    return { TableCore };
}

/**
 * Show error message
 */
export function showError(msg: string): void {
    const container = document.getElementById('gridContainer');
    if (container) {
        container.innerHTML += `<div style="color: red; padding: 20px;">Error: ${msg}</div>`;
    }
    vscode.postMessage({ command: 'error', text: msg });
}
