// Client-side application of explore filters to loaded/sampled rows.

import { parseNumericValue } from './columnClassification.js';
import type { ExploreColumnMeta, ExploreFilterModel } from './types.js';

function dimensionMatches(value: unknown, values: string[]): boolean {
    if (value === null || value === undefined || value === '') {
        return false;
    }
    return values.includes(String(value));
}

function dateMatches(value: unknown, from: string | undefined, to: string | undefined): boolean {
    if (value === null || value === undefined || value === '') {
        return false;
    }
    const text = String(value);
    if (from && text < from) {
        return false;
    }
    if (to && text > to) {
        return false;
    }
    return true;
}

function measureMatches(value: unknown, min: number | undefined, max: number | undefined): boolean {
    const parsed = parseNumericValue(value);
    if (parsed === null) {
        return false;
    }
    if (min !== undefined && parsed < min) {
        return false;
    }
    if (max !== undefined && parsed > max) {
        return false;
    }
    return true;
}

export function rowMatchesExploreFilters(row: unknown[], filters: ExploreFilterModel): boolean {
    for (const dimension of filters.dimensions) {
        if (dimension.values.length > 0 && !dimensionMatches(row[dimension.columnIndex], dimension.values)) {
            return false;
        }
    }
    for (const date of filters.dates) {
        if ((date.from || date.to) && !dateMatches(row[date.columnIndex], date.from, date.to)) {
            return false;
        }
    }
    for (const measure of filters.measures) {
        if ((measure.min !== undefined || measure.max !== undefined) && !measureMatches(row[measure.columnIndex], measure.min, measure.max)) {
            return false;
        }
    }
    return true;
}

export function filterExploreRows(rows: readonly unknown[][], filters: ExploreFilterModel): unknown[][] {
    if (filters.dimensions.length === 0 && filters.dates.length === 0 && filters.measures.length === 0) {
        return rows.slice();
    }
    return rows.filter(row => rowMatchesExploreFilters(row, filters));
}

/**
 * Build column metadata with roles for a row sample (used after filtering
 * so dimension/measure classification reacts to changed cardinality).
 */
export function columnsMetaForRows(
    columns: ReadonlyArray<{ name: string; type?: string }>,
    rows: readonly unknown[][],
    classify: (name: string, type: string | undefined, values: readonly unknown[]) => 'dimension' | 'measure' | 'date' | 'unknown',
): ExploreColumnMeta[] {
    return columns.map((column, index) => {
        const sample: unknown[] = [];
        const sampleSize = Math.min(rows.length, 200);
        for (let i = 0; i < sampleSize; i++) {
            sample.push(rows[i]?.[index]);
        }
        return {
            index,
            name: column.name || `Col ${index + 1}`,
            type: column.type,
            role: classify(column.name || '', column.type, sample),
        };
    });
}
