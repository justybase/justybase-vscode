import type { ExploreFilterModel, ExploreValue } from '@justybase/contracts';

/** Compare decimal strings without rounding through IEEE-754. */
export function compareExploreNumbers(a: unknown, b: unknown): number | undefined {
    const parse = (value: unknown): { coefficient: bigint; scale: number } | undefined => {
        const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value).trim());
        if (!match || !(match[2] || match[3])) return undefined;
        const exponent = Number(match[4] ?? 0);
        if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return undefined;
        const digits = (match[2] || '0') + (match[3] || '');
        if (digits.length > 2000) return undefined;
        return { coefficient: BigInt((match[1] === '-' ? '-' : '') + digits), scale: (match[3]?.length ?? 0) - exponent };
    };
    const x = parse(a), y = parse(b);
    if (!x || !y) return undefined;
    const scale = Math.max(x.scale, y.scale);
    const left = x.coefficient * 10n ** BigInt(scale - x.scale);
    const right = y.coefficient * 10n ** BigInt(scale - y.scale);
    return left < right ? -1 : left > right ? 1 : 0;
}

export function exploreValueEqual(a: unknown, b: ExploreValue): boolean {
    if (typeof b === 'number' || typeof a === 'number' || typeof a === 'bigint') {
        return compareExploreNumbers(a, b) === 0;
    }
    return a === b;
}

/**
 * Canonical `YYYY-MM-DDTHH:MM:SS.ffffff` form so cells and bounds of different
 * precision compare like SQL timestamps (`'2024-01-01 01:00'` equals
 * `2024-01-01 01:00:00.000`). Date cells carry the database wall-clock value in
 * their UTC components, matching the result grid formatter.
 */
function normalizeExploreTimestamp(raw: unknown): string {
    const text = raw instanceof Date ? raw.toISOString().replace(/Z$/, '') : String(raw).trim();
    const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?)?$/.exec(text);
    if (!match) return text.replace(' ', 'T');
    const [, date, hours = '00', minutes = '00', seconds = '00', fraction = ''] = match;
    return `${date}T${hours}:${minutes}:${seconds}.${fraction.padEnd(6, '0').slice(0, 6)}`;
}

export function matchesExploreFilters(row: readonly unknown[], filters: ExploreFilterModel): boolean {
    for (const filter of filters.dimensions) {
        if (!filter.values.length && !filter.includeNull && !filter.includeEmpty) continue;
        const value = row[filter.columnIndex];
        const match = value == null ? !!filter.includeNull
            : value === '' ? !!filter.includeEmpty || filter.values.includes('')
            : filter.values.some(item => exploreValueEqual(value, item));
        if (filter.mode === 'exclude' ? match : !match) return false;
    }
    for (const filter of filters.measures) {
        if (filter.min === undefined && filter.max === undefined) continue;
        const value = row[filter.columnIndex];
        if (value == null || value === '') return false;
        const lower = filter.min === undefined ? 0 : compareExploreNumbers(value, filter.min);
        const upper = filter.max === undefined ? 0 : compareExploreNumbers(value, filter.max);
        if (lower === undefined || upper === undefined || lower < 0 || upper > 0 || (filter.maxExclusive && upper === 0)) return false;
    }
    for (const filter of filters.dates) {
        if (!filter.from && !filter.to) continue;
        const raw = row[filter.columnIndex];
        if (raw == null || raw === '') return false;
        const value = normalizeExploreTimestamp(raw);
        const from = filter.from ? normalizeExploreTimestamp(filter.from) : undefined;
        const to = filter.to ? normalizeExploreTimestamp(filter.to) : undefined;
        if (from && value < from) return false;
        if (to && (filter.toExclusive ? value >= to : value > to)) return false;
    }
    return true;
}
