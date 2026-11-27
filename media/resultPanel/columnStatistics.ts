// Whole-column statistics for the grid context menu. Loaded results are
// aggregated in the webview; disk-backed results ask SQLite through the host.
// Pure module: no DOM or host calls.

import { parseNumericValue } from './explore/columnClassification.js';

export interface SharedColumnStatistics {
    readonly columnIndex: number;
    readonly columnName: string;
    readonly columnType?: string;
    /** Whether the numbers came from the loaded page or from every spilled row. */
    readonly scope: 'loaded' | 'database';
    /** Rows considered after the current grid filters. */
    readonly rowCount: number;
    /** Rows in the result before filters, when the host knows it. */
    readonly totalRowCount?: number;
    /** Non-null values. */
    readonly count: number;
    readonly nullCount: number;
    readonly distinctCount: number;
    /** Values that parsed as numbers; numeric aggregates cover only these. */
    readonly numericCount: number;
    readonly sum?: number;
    readonly avg?: number;
    readonly min?: number;
    readonly max?: number;
    readonly stdev?: number;
}

function distinctKey(value: unknown): string {
    if (typeof value === 'object' && value !== null) {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return `${typeof value}:${String(value)}`;
}

function finiteNumber(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'bigint') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    const parsed = parseNumericValue(value);
    return parsed === null ? undefined : parsed;
}

function populationStandardDeviation(values: readonly number[], average: number): number {
    const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
    return Math.sqrt(Math.max(0, variance));
}

/**
 * Aggregates one column over the supplied rows (already filtered by the caller).
 * Distinct counts stringify values the same way for every supported scalar.
 */
export function computeLoadedColumnStatistics(
    rows: readonly (readonly unknown[])[],
    columnIndex: number,
    columnName: string,
    columnType?: string,
): SharedColumnStatistics {
    const numeric: number[] = [];
    const distinct = new Set<string>();
    let nullCount = 0;

    for (const row of rows) {
        const value = row[columnIndex];
        if (value === null || value === undefined || value === '') {
            nullCount += 1;
            continue;
        }
        distinct.add(distinctKey(value));
        const parsed = parseNumericValue(value);
        if (parsed !== null) numeric.push(parsed);
    }

    const count = rows.length - nullCount;
    const stats: SharedColumnStatistics = {
        columnIndex,
        columnName,
        columnType,
        scope: 'loaded',
        rowCount: rows.length,
        count,
        nullCount,
        distinctCount: distinct.size,
        numericCount: numeric.length,
    };
    if (numeric.length === 0) {
        return stats;
    }

    const sum = numeric.reduce((total, value) => total + value, 0);
    const avg = sum / numeric.length;
    return {
        ...stats,
        sum,
        avg,
        min: Math.min(...numeric),
        max: Math.max(...numeric),
        stdev: populationStandardDeviation(numeric, avg),
    };
}

export interface DatabaseColumnStatisticInput {
    readonly columnIndex: number;
    readonly columnName: string;
    readonly columnType?: string;
    /** Total rows (or filtered rows) covered by the aggregate query. */
    readonly rowCount: number;
    readonly totalRowCount?: number;
    /** Aggregation results keyed by their function name. */
    readonly values: Readonly<Record<string, unknown>>;
}

/** Maps SQLite aggregate results onto the same shape as the loaded-row path. */
export function buildDatabaseColumnStatistics(input: DatabaseColumnStatisticInput): SharedColumnStatistics {
    const count = finiteNumber(input.values.count) ?? 0;
    const sum = finiteNumber(input.values.sum);
    const avg = finiteNumber(input.values.avg);
    const numericCount = finiteNumber(input.values.numericCount) ?? (avg === undefined ? 0 : count);
    const stats: SharedColumnStatistics = {
        columnIndex: input.columnIndex,
        columnName: input.columnName,
        columnType: input.columnType,
        scope: 'database',
        rowCount: input.rowCount,
        totalRowCount: input.totalRowCount,
        count,
        nullCount: Math.max(0, input.rowCount - count),
        distinctCount: finiteNumber(input.values.countDistinct) ?? 0,
        numericCount,
    };

    const min = finiteNumber(input.values.min);
    const max = finiteNumber(input.values.max);
    const stdev = finiteNumber(input.values.stdev);
    return {
        ...stats,
        ...(sum === undefined ? {} : { sum }),
        ...(avg === undefined ? {} : { avg }),
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
        ...(stdev === undefined ? {} : { stdev }),
    };
}
