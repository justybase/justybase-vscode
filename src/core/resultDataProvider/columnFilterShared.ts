/**
 * Shared column-filter helpers used by disk-backed SQLite SQL and database-side filter SQL.
 * Keeps LIKE escaping and numeric normalization consistent across execution layers.
 */

export const COLUMN_FILTER_COMPARISON_OPERATORS = {
    greaterThan: '>',
    greaterThanOrEqual: '>=',
    lessThan: '<',
    lessThanOrEqual: '<=',
} as const;

export type ColumnFilterComparisonOperator = keyof typeof COLUMN_FILTER_COMPARISON_OPERATORS;

const SQLITE_MIN_INT64 = BigInt('-9223372036854775808');
const SQLITE_MAX_INT64 = BigInt('9223372036854775807');
const JS_MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const JS_MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const FILTER_NUMERIC_GROUPING_PATTERN = /[\s\u00A0\u202F,]/g;

/** Escape `%`, `_`, and `\` for SQL `LIKE ... ESCAPE '\\'`. */
export function escapeSqlLikeLiteral(value: string): string {
    return value.replace(/[%_\\]/g, '\\$&');
}

/** Strip grouping separators so compact input matches displayed values (e.g. 20110209 vs 2011 02 09). */
export function normalizeFilterNumericInput(value: string): string {
    return value.replace(FILTER_NUMERIC_GROUPING_PATTERN, '').trim();
}

export function parseFilterNumericParam(
    value: string,
    options?: { integerOnly?: boolean },
): number | bigint | null {
    const normalized = normalizeFilterNumericInput(value);
    if (normalized === '') {
        return null;
    }

    if (options?.integerOnly && /^[+-]?\d+$/.test(normalized)) {
        try {
            const parsedBigInt = BigInt(normalized);
            if (parsedBigInt < SQLITE_MIN_INT64 || parsedBigInt > SQLITE_MAX_INT64) {
                return null;
            }
            if (parsedBigInt >= JS_MIN_SAFE_BIGINT && parsedBigInt <= JS_MAX_SAFE_BIGINT) {
                return Number(parsedBigInt);
            }
            return parsedBigInt;
        } catch {
            return null;
        }
    }

    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

/** Format a filter operand as a SQL numeric literal string, or undefined when not numeric. */
export function formatFilterNumericLiteral(value: unknown): string | undefined {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }
    if (typeof value !== 'string') {
        return undefined;
    }
    const normalized = normalizeFilterNumericInput(value);
    return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)
        ? normalized
        : undefined;
}

export function buildLowerLikePattern(
    conditionType: 'contains' | 'notContains' | 'startsWith' | 'endsWith',
    value: string,
): string {
    const escaped = escapeSqlLikeLiteral(value).toLowerCase();
    switch (conditionType) {
        case 'contains':
        case 'notContains':
            return `%${escaped}%`;
        case 'startsWith':
            return `${escaped}%`;
        case 'endsWith':
            return `%${escaped}`;
        default:
            return escaped;
    }
}

export function combineFilterClauses(parts: string[], logic: 'and' | 'or' | undefined): string {
    if (parts.length === 0) {
        return '';
    }
    if (parts.length === 1) {
        return parts[0];
    }
    const joiner = logic === 'or' ? ' OR ' : ' AND ';
    return `(${parts.join(joiner)})`;
}
