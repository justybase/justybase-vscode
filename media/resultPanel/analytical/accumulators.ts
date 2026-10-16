// Single-pass column accumulators. Numeric moments use Welford's update so the variance stays
// stable for large means (ids, epoch values) instead of the unstable E[x^2] - E[x]^2 form.

import { parseNumericValue } from '../explore/columnClassification.js';
import type { ExploreColumnRole } from '../explore/types.js';
import {
    ANALYTICAL_CATEGORY_MAX_DISTINCT,
    ANALYTICAL_TOP_VALUES,
    type AnalyticalColumnStats,
    type AnalyticalTopValue,
} from './types.js';

function isNullLike(value: unknown): boolean {
    return value === null || value === undefined || value === '';
}

export class ColumnAccumulator {
    rows = 0;
    nulls = 0;
    numericCount = 0;
    private mean = 0;
    private m2 = 0;
    private min = Number.POSITIVE_INFINITY;
    private max = Number.NEGATIVE_INFINITY;
    private dateMin: string | undefined;
    private dateMax: string | undefined;
    private readonly counts = new Map<string, number>();
    overflow = false;

    constructor(
        readonly role: ExploreColumnRole,
        private readonly distinctCap: number,
    ) {}

    add(value: unknown): void {
        this.rows += 1;
        if (isNullLike(value)) {
            this.nulls += 1;
            return;
        }

        if (this.role === 'measure') {
            const numeric = parseNumericValue(value);
            if (numeric !== null) {
                this.numericCount += 1;
                const delta = numeric - this.mean;
                this.mean += delta / this.numericCount;
                this.m2 += delta * (numeric - this.mean);
                if (numeric < this.min) this.min = numeric;
                if (numeric > this.max) this.max = numeric;
            }
        }

        if (this.role === 'date') {
            const text = String(value);
            if (this.dateMin === undefined || text < this.dateMin) this.dateMin = text;
            if (this.dateMax === undefined || text > this.dateMax) this.dateMax = text;
        }

        const key = String(value);
        const seen = this.counts.get(key);
        if (seen !== undefined) {
            this.counts.set(key, seen + 1);
        } else if (this.counts.size < this.distinctCap) {
            this.counts.set(key, 1);
        } else {
            this.overflow = true;
        }
    }

    distinctCount(): number {
        return this.counts.size;
    }

    /** Count of a value this accumulator has seen, or undefined when it was not tracked. */
    countOf(value: string): number | undefined {
        return this.counts.get(value);
    }

    topValues(limit: number = ANALYTICAL_TOP_VALUES): AnalyticalTopValue[] {
        return Array.from(this.counts.entries())
            .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
            .slice(0, limit)
            .map(([value, count]) => ({ value, count }));
    }

    numericSummary(): AnalyticalColumnStats['numeric'] {
        if (this.numericCount === 0) {
            return undefined;
        }
        const stddev = Math.sqrt(this.m2 / this.numericCount);
        return {
            count: this.numericCount,
            min: this.min,
            max: this.max,
            mean: this.mean,
            stddev,
            cv: this.mean !== 0 ? stddev / Math.abs(this.mean) : null,
        };
    }

    dateSummary(): AnalyticalColumnStats['date'] {
        if (this.dateMin === undefined || this.dateMax === undefined) {
            return undefined;
        }
        return { min: this.dateMin, max: this.dateMax };
    }

    toStats(columnIndex: number, name: string): AnalyticalColumnStats {
        const rowCount = this.rows;
        const stats: AnalyticalColumnStats = {
            columnIndex,
            name,
            role: this.role,
            rowCount,
            nullCount: this.nulls,
            nullRate: rowCount > 0 ? this.nulls / rowCount : 0,
            distinctCount: this.distinctCount(),
            distinctApprox: this.overflow,
            topValues: this.topValues(),
        };
        const numeric = this.numericSummary();
        if (numeric) stats.numeric = numeric;
        const date = this.dateSummary();
        if (date) stats.date = date;
        // The full distribution is exact only while no value was dropped by the cap.
        if ((this.role === 'dimension' || this.role === 'unknown') && !this.overflow && this.counts.size <= ANALYTICAL_CATEGORY_MAX_DISTINCT) {
            stats.categories = this.topValues(Number.POSITIVE_INFINITY);
        }
        return stats;
    }
}
