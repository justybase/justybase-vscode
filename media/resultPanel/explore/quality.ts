import { EXPLORE_SAMPLE_ROWS } from './types.js';
// Data-quality alerts and measure correlations for the Explore view.

import { parseNumericValue } from './columnClassification.js';
import type { ExploreColumnMeta, ExploreColumnOverview } from './types.js';

export type QualitySeverity = 'warn' | 'info';

export interface QualityAlert {
    severity: QualitySeverity;
    columnIndex: number;
    columnName: string;
    message: string;
}

export interface MeasureCorrelation {
    firstIndex: number;
    firstName: string;
    secondIndex: number;
    secondName: string;
    /** Pearson correlation coefficient (-1..1). */
    r: number;
}

export const HIGH_NULL_RATE = 0.3;

/** A single value covering at least this share of non-null rows is dominant. */
export const DOMINANT_VALUE_SHARE = 0.6;

/** Two values covering at least this share of non-null rows are concentrated. */
export const TOP_TWO_SHARE = 0.5;

/** Concentration above this share is severe enough to warn instead of inform. */
export const TOP_TWO_WARN_SHARE = 0.75;

/** Ignore two-value concentration on low-cardinality columns (e.g. a 2-value flag). */
export const CONCENTRATION_MIN_DISTINCT = 10;

export function formatSharePercent(share: number): string {
    const percent = Math.round(share * 1000) / 10;
    return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

function displayValue(value: string): string {
    return value.length > 32 ? `${value.slice(0, 31)}…` : value;
}

export function computeQualityAlerts(
    columns: readonly ExploreColumnMeta[],
    overviews: readonly ExploreColumnOverview[],
): QualityAlert[] {
    const alerts: QualityAlert[] = [];
    for (const overview of overviews) {
        const meta = columns[overview.index];
        if (!meta) {
            continue;
        }
        const nullRate = overview.examinedRows > 0 ? overview.nullCount / overview.examinedRows : 0;
        if (nullRate > HIGH_NULL_RATE) {
            alerts.push({
                severity: 'warn',
                columnIndex: overview.index,
                columnName: meta.name,
                message: `${Math.round(nullRate * 100)}% null values`,
            });
        }
        if (meta.role === 'dimension') {
            if (overview.distinctCount === 0) {
                alerts.push({
                    severity: 'info',
                    columnIndex: overview.index,
                    columnName: meta.name,
                    message: 'All values are null in the sample',
                });
            } else if (overview.examinedRows > 0 && overview.distinctCount === 1 && overview.nullCount === 0) {
                alerts.push({
                    severity: 'info',
                    columnIndex: overview.index,
                    columnName: meta.name,
                    message: 'Constant value — no analytical value',
                });
            } else if (overview.examinedRows > 0 && overview.distinctCount === overview.examinedRows - overview.nullCount) {
                alerts.push({
                    severity: 'info',
                    columnIndex: overview.index,
                    columnName: meta.name,
                    message: 'All values unique (high cardinality)',
                });
            } else {
                const nonNull = overview.examinedRows - overview.nullCount;
                const topValues = overview.topValues ?? [];
                if (nonNull > 0 && topValues.length > 0) {
                    const shareOf = (value: { count: number; share?: number }): number =>
                        typeof value.share === 'number' ? value.share : value.count / nonNull;
                    const first = topValues[0];
                    const firstShare = shareOf(first);
                    if (overview.distinctCount >= 2 && firstShare >= DOMINANT_VALUE_SHARE) {
                        alerts.push({
                            severity: 'warn',
                            columnIndex: overview.index,
                            columnName: meta.name,
                            message: `Top value "${displayValue(first.value)}" covers ${formatSharePercent(firstShare)} of rows`,
                        });
                    } else if (overview.distinctCount >= CONCENTRATION_MIN_DISTINCT && topValues.length >= 2) {
                        const topTwoShare = firstShare + shareOf(topValues[1]);
                        if (topTwoShare >= TOP_TWO_SHARE) {
                            alerts.push({
                                severity: topTwoShare >= TOP_TWO_WARN_SHARE ? 'warn' : 'info',
                                columnIndex: overview.index,
                                columnName: meta.name,
                                message: `Top 2 values cover ${formatSharePercent(topTwoShare)} of rows`,
                            });
                        }
                    }
                }
            }
        }
    }
    return alerts;
}

function pearson(pairs: Array<[number, number]>): number {
    const n = pairs.length;
    if (n < 3) {
        return Number.NaN;
    }
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;
    let sumY2 = 0;
    for (const [x, y] of pairs) {
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumX2 += x * x;
        sumY2 += y * y;
    }
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    if (denominator === 0 || !Number.isFinite(denominator)) {
        return Number.NaN;
    }
    return (n * sumXY - sumX * sumY) / denominator;
}

/** Maximum number of correlation pairs computed. */
const MAX_CORRELATION_PAIRS = 12;

export function computeMeasureCorrelations(
    columns: readonly ExploreColumnMeta[],
    rows: readonly unknown[][],
    maxRows = EXPLORE_SAMPLE_ROWS,
): MeasureCorrelation[] {
    const measureIndexes = columns
        .filter(column => column.role === 'measure')
        .map(column => column.index);
    if (measureIndexes.length < 2) {
        return [];
    }

    const pairs: Array<[number, number]> = [];
    const examined = Math.min(rows.length, maxRows);
    for (const first of measureIndexes) {
        for (let i = measureIndexes.indexOf(first) + 1; i < measureIndexes.length; i++) {
            pairs.push([first, measureIndexes[i]]);
        }
        if (pairs.length >= MAX_CORRELATION_PAIRS) {
            break;
        }
    }

    const results: MeasureCorrelation[] = [];
    for (const [first, second] of pairs.slice(0, MAX_CORRELATION_PAIRS)) {
        const pairRows: Array<[number, number]> = [];
        for (let r = 0; r < examined; r++) {
            const a = parseNumericValue(rows[r]?.[first]);
            const b = parseNumericValue(rows[r]?.[second]);
            if (a !== null && b !== null) {
                pairRows.push([a, b]);
            }
        }
        const r = pearson(pairRows);
        if (!Number.isNaN(r) && Math.abs(r) >= 0.5) {
            results.push({
                firstIndex: first,
                firstName: columns[first].name,
                secondIndex: second,
                secondName: columns[second].name,
                r: Math.round(r * 100) / 100,
            });
        }
    }
    return results.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
}
