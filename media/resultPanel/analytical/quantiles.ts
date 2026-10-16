// Quartiles and robust scale for the Analytical view. Pure: no DOM, no host calls.
// Type 7 interpolation (the default of R, NumPy and Excel QUARTILE.INC). The in-memory engine and the
// disk-backed engine both call quartilesFromRanks, so the two paths produce the same numbers.

export interface Quartiles {
    q1: number;
    median: number;
    q3: number;
}

/** Quartile position as a numerator over four: 1 = Q1, 2 = median, 3 = Q3. */
type QuarterNumerator = 1 | 2 | 3;
const QUARTER_NUMERATORS: readonly QuarterNumerator[] = [1, 2, 3];

/** Scale factor turning an interquartile range into a sigma for normal data. */
export const IQR_TO_SIGMA = 1.349;

/**
 * Zero-based ranks of the sorted sample that a quartile reads: the lower rank and the one above it.
 * The disk path selects exactly these ranks with a window function; the memory path indexes directly.
 */
export function quartileRanks(n: number): number[] {
    const ranks = new Set<number>();
    if (n <= 0) {
        return [];
    }
    for (const quarter of QUARTER_NUMERATORS) {
        const lo = Math.floor(((n - 1) * quarter) / 4);
        ranks.add(lo);
        if (((n - 1) * quarter) % 4 !== 0) {
            ranks.add(lo + 1);
        }
    }
    return [...ranks].sort((a, b) => a - b);
}

/**
 * Quartiles of n sorted values. valueAt(i) returns the i-th smallest value (zero-based) and must answer
 * every rank listed by quartileRanks(n). Returns null for an empty sample.
 */
export function quartilesFromRanks(n: number, valueAt: (index: number) => number): Quartiles | null {
    if (n <= 0) {
        return null;
    }
    const at = (quarter: QuarterNumerator): number => {
        const numerator = (n - 1) * quarter;
        const lo = Math.floor(numerator / 4);
        const fraction = (numerator - 4 * lo) / 4;
        const below = valueAt(lo);
        if (fraction === 0) {
            return below;
        }
        const above = valueAt(lo + 1);
        return below + fraction * (above - below);
    };
    return { q1: at(1), median: at(2), q3: at(3) };
}

/** Quartiles of an ascending array of finite numbers. */
export function quartilesSorted(sorted: ArrayLike<number>): Quartiles | null {
    return quartilesFromRanks(sorted.length, index => sorted[index]);
}

/** Median with the usual average of the two middle values for even counts. */
export function median(values: readonly number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** Interquartile range; zero or negative when the sample has no spread in its middle half. */
export function interquartileRange(quartiles: Quartiles): number {
    return quartiles.q3 - quartiles.q1;
}

/** Robust sigma estimate: IQR / 1.349. Equal to the standard deviation for normal data. */
export function robustSigma(quartiles: Quartiles): number {
    return interquartileRange(quartiles) / IQR_TO_SIGMA;
}
