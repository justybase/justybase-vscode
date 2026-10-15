// Client-side application of explore filters to loaded/sampled rows.

import type { ExploreColumnMeta, ExploreFilterModel } from './types.js';

import { matchesExploreFilters } from '@justybase/result-core';
export const rowMatchesExploreFilters = matchesExploreFilters;

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
