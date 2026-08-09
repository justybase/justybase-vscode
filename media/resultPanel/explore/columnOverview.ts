// Pure per-column overview computation for the Explore view.
// Operates on loaded/sampled rows; no DOM or host dependencies.

import {
    EXPLORE_HISTOGRAM_BINS,
    EXPLORE_TOP_VALUES,
    type ExploreColumnMeta,
    type ExploreColumnOverview,
    type ExploreHistogramBin,
    type ExploreTopValue,
} from './types.js';
import { parseNumericValue } from './columnClassification.js';

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) {
        return Number.NaN;
    }
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[index];
}

function buildHistogram(values: number[], binCount: number): ExploreHistogramBin[] {
    if (values.length === 0) {
        return [];
    }
    let min = Infinity;
    let max = -Infinity;
    for (const value of values) {
        if (value < min) min = value;
        if (value > max) max = value;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return [];
    }
    if (min === max) {
        return [{ min, max, count: values.length }];
    }
    const width = (max - min) / binCount;
    const bins: ExploreHistogramBin[] = [];
    for (let i = 0; i < binCount; i++) {
        bins.push({ min: min + i * width, max: min + (i + 1) * width, count: 0 });
    }
    for (const value of values) {
        const binIndex = Math.min(binCount - 1, Math.floor((value - min) / width));
        bins[binIndex].count += 1;
    }
    return bins;
}

function collectTopValues(values: readonly unknown[], limit: number): { values: ExploreTopValue[]; distinctCount: number; topTruncated: boolean } {
    const counts = new Map<string, number>();
    let distinct = 0;
    for (const value of values) {
        if (value === null || value === undefined || value === '') {
            continue;
        }
        const key = String(value);
        if (!counts.has(key)) {
            distinct += 1;
        }
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    return {
        values: sorted.slice(0, limit).map(([value, count]) => ({ value, count })),
        distinctCount: distinct,
        topTruncated: distinct > limit,
    };
}

function measureOverview(
    index: number,
    name: string,
    type: string | undefined,
    rows: readonly unknown[][],
    examinedRows: number,
): ExploreColumnOverview {
    const numeric: number[] = [];
    let nullCount = 0;
    for (let i = 0; i < examinedRows; i++) {
        const value = rows[i]?.[index];
        if (value === null || value === undefined || value === '') {
            nullCount += 1;
            continue;
        }
        const parsed = parseNumericValue(value);
        if (parsed !== null) {
            numeric.push(parsed);
        }
    }
    const sorted = [...numeric].sort((a, b) => a - b);
    const overview: ExploreColumnOverview = {
        index,
        name,
        type,
        role: 'measure',
        examinedRows,
        nullCount,
        distinctCount: new Set(numeric).size,
        distinctTruncated: false,
        min: sorted.length > 0 ? sorted[0] : undefined,
        max: sorted.length > 0 ? sorted[sorted.length - 1] : undefined,
        avg: numeric.length > 0 ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : undefined,
        p25: percentile(sorted, 25),
        p75: percentile(sorted, 75),
        histogram: buildHistogram(numeric, EXPLORE_HISTOGRAM_BINS),
    };
    return overview;
}

function dimensionOverview(
    index: number,
    name: string,
    type: string | undefined,
    rows: readonly unknown[][],
    examinedRows: number,
): ExploreColumnOverview {
    const values: unknown[] = [];
    let nullCount = 0;
    for (let i = 0; i < examinedRows; i++) {
        const value = rows[i]?.[index];
        if (value === null || value === undefined || value === '') {
            nullCount += 1;
        } else {
            values.push(value);
        }
    }
    const top = collectTopValues(values, EXPLORE_TOP_VALUES);
    const overview: ExploreColumnOverview = {
        index,
        name,
        type,
        role: 'dimension',
        examinedRows,
        nullCount,
        distinctCount: top.distinctCount,
        distinctTruncated: top.topTruncated,
        topValues: top.values,
    };
    return overview;
}

function dateOverview(
    index: number,
    name: string,
    type: string | undefined,
    rows: readonly unknown[][],
    examinedRows: number,
): ExploreColumnOverview {
    const values = new Set<string>();
    let nullCount = 0;
    let minDate: string | undefined;
    let maxDate: string | undefined;
    for (let i = 0; i < examinedRows; i++) {
        const value = rows[i]?.[index];
        if (value === null || value === undefined || value === '') {
            nullCount += 1;
            continue;
        }
        const text = String(value);
        values.add(text);
        if (minDate === undefined || text < minDate) minDate = text;
        if (maxDate === undefined || text > maxDate) maxDate = text;
    }
    return {
        index,
        name,
        type,
        role: 'date',
        examinedRows,
        nullCount,
        distinctCount: values.size,
        distinctTruncated: false,
        minDate,
        maxDate,
    };
}

/**
 * Compute per-column overviews for a result set sample.
 * The supplied `columns` already carry their classified `role`.
 */
export function computeColumnOverviews(
    columns: readonly ExploreColumnMeta[],
    rows: readonly unknown[][],
    examinedRows: number,
): ExploreColumnOverview[] {
    return columns.map(column => {
        switch (column.role) {
            case 'measure':
                return measureOverview(column.index, column.name, column.type, rows, examinedRows);
            case 'date':
                return dateOverview(column.index, column.name, column.type, rows, examinedRows);
            case 'dimension':
            default:
                return dimensionOverview(column.index, column.name, column.type, rows, examinedRows);
        }
    });
}
