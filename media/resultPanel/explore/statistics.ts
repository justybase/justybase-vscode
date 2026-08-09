// Pure descriptive statistics for the Explore view (client-side, sample-based).

import { parseNumericValue } from './columnClassification.js';

export interface ColumnStatistics {
    count: number;
    distinct: number;
    nullCount: number;
    sum?: number;
    avg?: number;
    median?: number;
    stddev?: number;
    variance?: number;
    min?: number;
    max?: number;
    p25?: number;
    p75?: number;
}

function percentile(sorted: number[], p: number): number | undefined {
    if (sorted.length === 0) {
        return undefined;
    }
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[index];
}

function standardDeviation(values: number[], avg: number): number | undefined {
    if (values.length < 2) {
        return undefined;
    }
    const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
}

export function computeColumnStatistics(
    rows: readonly unknown[][],
    columnIndex: number,
    maxRows = 2000,
): ColumnStatistics {
    const numeric: number[] = [];
    const distinctValues = new Set<number>();
    let nullCount = 0;
    const examined = Math.min(rows.length, maxRows);

    for (let i = 0; i < examined; i++) {
        const value = rows[i]?.[columnIndex];
        if (value === null || value === undefined || value === '') {
            nullCount += 1;
            continue;
        }
        const parsed = parseNumericValue(value);
        if (parsed !== null) {
            numeric.push(parsed);
            distinctValues.add(parsed);
        }
    }

    const sorted = [...numeric].sort((a, b) => a - b);
    const stats: ColumnStatistics = {
        count: numeric.length,
        distinct: distinctValues.size,
        nullCount,
    };
    if (numeric.length === 0) {
        return stats;
    }

    stats.min = sorted[0];
    stats.max = sorted[sorted.length - 1];
    stats.sum = numeric.reduce((sum, value) => sum + value, 0);
    stats.avg = stats.sum / numeric.length;
    stats.median = percentile(sorted, 50);
    stats.p25 = percentile(sorted, 25);
    stats.p75 = percentile(sorted, 75);
    stats.stddev = standardDeviation(numeric, stats.avg);
    if (stats.stddev !== undefined) {
        stats.variance = stats.stddev ** 2;
    }
    return stats;
}
