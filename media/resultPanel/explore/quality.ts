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
    maxRows = 2000,
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
