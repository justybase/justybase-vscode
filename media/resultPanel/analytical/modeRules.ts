// Rule families for the detection modes beyond whole/rest: robust (medians and IQR), peer (the other
// groups as a distribution, judged by robust z-scores) and category shift (MIX_SHIFT, every mode).
// Thresholds are named constants. Every flag carries the same evidence as the whole-result rules, so
// the 'Why?' panel and the CSV export work unchanged. Pure module: no DOM or host dependencies.

import { median, IQR_TO_SIGMA } from './quantiles.js';
import { clamp01, flag, formatNumber, nonNull, percent, type RuleContext } from './ruleHelpers.js';
import type { AnalyticalColumnStats, AnalyticalGroup, AnomalyFlag } from './types.js';

// Robust (median and IQR)
/** Median shift in robust sigma (scaled by sensitivity), and its z-score against the baseline. */
export const ROBUST_MEAN_EFFECT = 1.0;
export const ROBUST_MEAN_Z = 3;
/** Tukey fences: quartile minus or plus this many IQRs. */
export const ROBUST_FENCE_IQR = 3;
/** Robust coefficient of variation ratio (scaled), and the sigma ratio used when medians are zero. */
export const ROBUST_CV_RATIO = 3;
export const ROBUST_SIGMA_RATIO = 2.5;
export const ROBUST_MIN_CV = 0.5;

// Peer groups
/** Peer comparison needs this many qualifying groups; below it the view falls back to whole result. */
export const PEER_MIN_GROUPS = 8;
/** A group contributes to a column's peer distribution with at least this many non-null values. */
export const PEER_MIN_NON_NULL = 5;
/** Robust z-score threshold (scaled by sensitivity) and the stricter one for extremes. */
export const PEER_Z = 3.5;
export const PEER_OUTLIER_Z = 5;
/** Null rate: absolute change needed on top of the z-score (scaled). */
export const PEER_NULL_DELTA = 0.1;
export const PEER_DOMINANCE_SHARE = 0.6;
export const PEER_MIN_CV = 0.5;
/** Scale floors: relative to the peer median, and absolute for shares (proportions). */
export const PEER_RELATIVE_FLOOR = 0.05;
export const PEER_SHARE_FLOOR = 0.02;
/** Normal-consistency factors: MAD to sigma, and mean absolute deviation to sigma. */
const MAD_TO_SIGMA = 1.4826;
const MEAN_ABS_DEV_TO_SIGMA = 1.2533;

// Category shift (MIX_SHIFT)
/** Both distributions need at least this many non-null values. */
export const MIX_MIN_NON_NULL = 30;
/** Shift above the noise floor (total variation distance, scaled by sensitivity). */
export const MIX_EFFECT = 0.25;
export const MIX_STRENGTH_SCALE = 0.6;

export type ShareMap = ReadonlyMap<string, number>;

interface CategoryDistribution {
    shares: ShareMap;
    total: number;
}

/** Shares of the complete category distribution, or null when no complete distribution is known. */
export function categoryDistribution(stats: AnalyticalColumnStats): CategoryDistribution | null {
    if (!stats.categories || stats.categories.length === 0) {
        return null;
    }
    const total = stats.categories.reduce((sum, entry) => sum + entry.count, 0);
    if (total === 0) {
        return null;
    }
    const shares = new Map<string, number>();
    for (const entry of stats.categories) {
        shares.set(entry.value, entry.count / total);
    }
    return { shares, total };
}

export interface CategoryShift {
    /** Total variation distance: half the sum of absolute share differences. */
    tvd: number;
    /** Expected distance between two samples drawn from the same distribution (noise floor). */
    floor: number;
    largest: { value: string; groupShare: number; baseShare: number } | null;
}

/** Distance between a group's shares and a baseline's shares, with the noise floor for the group size. */
export function categoryShift(groupShares: ShareMap, groupTotal: number, baseShares: ShareMap): CategoryShift {
    const values = new Set<string>([...groupShares.keys(), ...baseShares.keys()]);
    let tvd = 0;
    let floor = 0;
    let largest: CategoryShift['largest'] = null;
    let largestGap = -1;
    for (const value of values) {
        const pg = groupShares.get(value) ?? 0;
        const pb = baseShares.get(value) ?? 0;
        const gap = Math.abs(pg - pb);
        tvd += gap;
        floor += Math.sqrt((2 * pb * (1 - pb)) / (Math.PI * groupTotal));
        if (gap > largestGap) {
            largestGap = gap;
            largest = { value, groupShare: pg, baseShare: pb };
        }
    }
    return { tvd: tvd / 2, floor: floor / 2, largest };
}

function categoryFlag(shift: CategoryShift, groupTotal: number, baseTotal: number, ctx: RuleContext, baselineLabel: string, columnIndex: number): AnomalyFlag | null {
    const effect = shift.tvd - shift.floor;
    const threshold = MIX_EFFECT * ctx.k;
    if (effect < threshold) {
        return null;
    }
    const notes = shift.largest
        ? [`largest shift: ${shift.largest.value} ${percent(shift.largest.groupShare)} vs ${percent(shift.largest.baseShare)}`]
        : [];
    return flag(
        'MIX_SHIFT',
        effect / MIX_STRENGTH_SCALE,
        `Category mix differs from the ${baselineLabel} by ${percent(shift.tvd)} of rows (noise about ${percent(shift.floor)})`,
        {
            method: `category distribution vs ${baselineLabel} (total variation, minus noise floor)`,
            observed: shift.tvd,
            observedLabel: 'category distance (TVD)',
            expected: shift.floor,
            expectedLabel: 'noise floor for this group size',
            threshold,
            thresholdLabel: 'TVD minus noise floor',
            effect,
            effectUnit: 'TVD',
            sampleSize: groupTotal,
            baselineSize: baseTotal,
            notes,
        },
        ctx,
        columnIndex,
    );
}

/** MIX_SHIFT against a baseline column (population, rest, or reference group). */
export function mixFlag(group: AnalyticalColumnStats, baseline: AnalyticalColumnStats, ctx: RuleContext): AnomalyFlag | null {
    const g = categoryDistribution(group);
    const b = categoryDistribution(baseline);
    if (!g || !b || g.total < MIX_MIN_NON_NULL || b.total < MIX_MIN_NON_NULL) {
        return null;
    }
    const shift = categoryShift(g.shares, g.total, b.shares);
    return categoryFlag(shift, g.total, b.total, ctx, baselineLabelOf(ctx), group.columnIndex);
}

function baselineLabelOf(ctx: RuleContext): string {
    switch (ctx.mode) {
        case 'rest': return 'rest of result';
        case 'reference': return 'reference group';
        case 'peer': return 'median peer group';
        default: return 'whole result';
    }
}

// Robust (median and IQR)

/**
 * Median shift, extremes beyond Tukey fences and robust variability, using quartiles of the group and the
 * whole result. Needs quartiles on both sides; with zero IQR there is no robust scale, so nothing is flagged.
 */
export function robustNumericFlags(group: AnalyticalColumnStats, baseline: AnalyticalColumnStats, ctx: RuleContext): AnomalyFlag[] {
    const g = group.numeric;
    const p = baseline.numeric;
    const gq = g?.quartiles;
    const pq = p?.quartiles;
    if (!g || !p || !gq || !pq) {
        return [];
    }
    const iqr = pq.q3 - pq.q1;
    if (!(iqr > 0)) {
        return [];
    }
    const sigma = iqr / IQR_TO_SIGMA;
    const flags: AnomalyFlag[] = [];

    const shift = Math.abs(gq.median - pq.median);
    const effect = shift / sigma;
    const z = shift / (MEAN_ABS_DEV_TO_SIGMA * sigma / Math.sqrt(g.count));
    const effectThreshold = ROBUST_MEAN_EFFECT * ctx.k;
    if (effect >= effectThreshold && z >= ROBUST_MEAN_Z) {
        flags.push(flag(
            'MEAN_SHIFT',
            effect / 3,
            `Median ${formatNumber(gq.median)} vs ${formatNumber(pq.median)} overall (${effect.toFixed(1)} robust sigma)`,
            {
                method: 'median shift vs whole result (robust sigma = IQR / 1.349)',
                observed: gq.median,
                observedLabel: 'median in group',
                expected: pq.median,
                expectedLabel: 'median in baseline',
                threshold: effectThreshold,
                thresholdLabel: `effect size >= ${effectThreshold.toFixed(2)} robust sigma and z >= ${ROBUST_MEAN_Z}`,
                effect,
                effectUnit: 'robust sigma',
                sampleSize: g.count,
                baselineSize: p.count,
                notes: [`z = ${z.toFixed(1)}`],
            },
            ctx,
            group.columnIndex,
        ));
    }

    const lowerFence = pq.q1 - ROBUST_FENCE_IQR * iqr;
    const upperFence = pq.q3 + ROBUST_FENCE_IQR * iqr;
    const beyondLow = lowerFence - g.min;
    const beyondHigh = g.max - upperFence;
    const beyond = Math.max(beyondLow, beyondHigh);
    if (beyond > 0) {
        const extreme = beyondHigh >= beyondLow ? g.max : g.min;
        flags.push(flag(
            'RANGE_OUTLIER',
            0.3 + beyond / iqr / 3,
            `Values reach ${formatNumber(extreme)}, beyond the Tukey fence (${formatNumber(beyondHigh >= beyondLow ? upperFence : lowerFence)})`,
            {
                method: 'extreme value vs Tukey fences of the whole result (3 IQR beyond the quartiles)',
                observed: extreme,
                observedLabel: 'most extreme value in group',
                expected: beyondHigh >= beyondLow ? upperFence : lowerFence,
                expectedLabel: 'fence in baseline',
                threshold: ROBUST_FENCE_IQR,
                thresholdLabel: 'IQR beyond the quartiles',
                effect: beyond / iqr,
                effectUnit: 'IQR',
                sampleSize: g.count,
                baselineSize: p.count,
            },
            ctx,
            group.columnIndex,
        ));
    }

    const groupIqr = gq.q3 - gq.q1;
    if (gq.median !== 0 && pq.median !== 0) {
        const groupRobustCv = groupIqr / (IQR_TO_SIGMA * Math.abs(gq.median));
        const baseRobustCv = iqr / (IQR_TO_SIGMA * Math.abs(pq.median));
        const ratio = groupRobustCv / baseRobustCv;
        const threshold = ROBUST_CV_RATIO * ctx.k;
        if (ratio >= threshold && groupRobustCv >= ROBUST_MIN_CV) {
            flags.push(flag(
                'HIGH_VARIABILITY',
                ratio / 6,
                `Robust variability ${ratio.toFixed(1)}x the overall value`,
                {
                    method: 'robust coefficient of variation (IQR / median) vs whole result',
                    observed: groupRobustCv,
                    observedLabel: 'robust CV in group',
                    expected: baseRobustCv,
                    expectedLabel: 'robust CV in baseline',
                    threshold,
                    thresholdLabel: `ratio >= ${threshold.toFixed(2)} and robust CV >= ${ROBUST_MIN_CV}`,
                    effect: ratio,
                    effectUnit: 'ratio',
                    sampleSize: g.count,
                    baselineSize: p.count,
                },
                ctx,
                group.columnIndex,
            ));
        }
    } else {
        const ratio = groupIqr / iqr;
        const threshold = ROBUST_SIGMA_RATIO * ctx.k;
        if (ratio >= threshold) {
            flags.push(flag(
                'HIGH_VARIABILITY',
                ratio / 6,
                `Spread ${ratio.toFixed(1)}x the overall IQR`,
                {
                    method: 'IQR ratio vs whole result (medians at zero)',
                    observed: groupIqr,
                    observedLabel: 'IQR in group',
                    expected: iqr,
                    expectedLabel: 'IQR in baseline',
                    threshold,
                    thresholdLabel: `ratio >= ${threshold.toFixed(2)}`,
                    effect: ratio,
                    effectUnit: 'ratio',
                    sampleSize: g.count,
                    baselineSize: p.count,
                },
                ctx,
                group.columnIndex,
            ));
        }
    }
    return flags;
}

// Peer groups

export interface PeerMetric {
    median: number;
    /** Robust scale: 1.4826 x MAD, floored so that small spreads do not explode the z-score. */
    scale: number;
}

/**
 * Median and robust scale of a metric across peer groups. Returns null with fewer than PEER_MIN_GROUPS
 * values, or when the scale is zero even after the floors.
 */
export function peerMetric(values: readonly number[], absoluteFloor: number): PeerMetric | null {
    if (values.length < PEER_MIN_GROUPS) {
        return null;
    }
    const med = median(values);
    const absDev = values.map(value => Math.abs(value - med));
    let scale = MAD_TO_SIGMA * median(absDev);
    if (scale === 0) {
        scale = MEAN_ABS_DEV_TO_SIGMA * (absDev.reduce((sum, value) => sum + value, 0) / absDev.length);
    }
    scale = Math.max(scale, PEER_RELATIVE_FLOOR * Math.abs(med), absoluteFloor);
    return scale > 0 ? { median: med, scale } : null;
}

export function peerZ(value: number, metric: PeerMetric): number {
    return (value - metric.median) / metric.scale;
}

type PeerMetricName = 'mean' | 'max' | 'min' | 'cv' | 'nullRate' | 'topShare';

export interface PeerColumnContext {
    /** Peer group column statistics, keyed by group key, for groups with enough non-null values. */
    peers: ReadonlyMap<string, AnalyticalColumnStats>;
    metrics: Partial<Record<PeerMetricName, PeerMetric>>;
    /** Median start and end of the peers' date ranges, in milliseconds. */
    dateMedian?: { start: number; end: number };
    /** Per group: category distance from the median peer distribution, minus its noise floor. */
    mixByKey?: ReadonlyMap<string, { tvd: number; floor: number; excess: number; largest: CategoryShift['largest'] }>;
    mixMetric?: PeerMetric;
    peerCount: number;
}

function topShareOf(stats: AnalyticalColumnStats): number | null {
    const top = stats.topValues[0];
    const nn = nonNull(stats);
    if (!top || stats.distinctApprox || nn === 0) {
        return null;
    }
    return top.count / nn;
}

/** Builds the peer context for one column from the qualifying groups (the groups the view lists). */
export function buildPeerContext(
    groups: readonly AnalyticalGroup[],
    population: AnalyticalColumnStats,
    minGroupRows: number,
): PeerColumnContext {
    const peers = new Map<string, AnalyticalColumnStats>();
    for (const group of groups) {
        if (group.rowCount < minGroupRows) continue;
        const stats = group.columns.find(column => column.columnIndex === population.columnIndex);
        if (stats && nonNull(stats) >= PEER_MIN_NON_NULL) {
            peers.set(group.key, stats);
        }
    }
    const all = [...peers.values()];
    const collect = (pick: (stats: AnalyticalColumnStats) => number | null | undefined): number[] => {
        const out: number[] = [];
        for (const stats of all) {
            const value = pick(stats);
            if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
        }
        return out;
    };
    const metrics: PeerColumnContext['metrics'] = {};
    const put = (name: PeerMetricName, values: number[], floor: number): void => {
        const metric = peerMetric(values, floor);
        if (metric) metrics[name] = metric;
    };
    put('mean', collect(stats => stats.numeric?.mean), 0);
    put('max', collect(stats => stats.numeric?.max), 0);
    put('min', collect(stats => stats.numeric?.min), 0);
    put('cv', collect(stats => stats.numeric?.cv), 0);
    put('nullRate', collect(stats => stats.nullRate), PEER_SHARE_FLOOR);
    if (population.role === 'dimension' || population.role === 'unknown') {
        put('topShare', collect(topShareOf), PEER_SHARE_FLOOR);
    }

    let dateMedian: PeerColumnContext['dateMedian'];
    if (population.date) {
        const starts = collect(stats => (stats.date ? Date.parse(stats.date.min) : undefined));
        const ends = collect(stats => (stats.date ? Date.parse(stats.date.max) : undefined));
        if (starts.length >= PEER_MIN_GROUPS && ends.length >= PEER_MIN_GROUPS) {
            dateMedian = { start: median(starts), end: median(ends) };
        }
    }

    const context: PeerColumnContext = { peers, metrics, dateMedian, peerCount: all.length };
    if (population.categories && (population.role === 'dimension' || population.role === 'unknown')) {
        attachPeerMix(context, all);
    }
    return context;
}

/**
 * Category shift per peer against the median distribution of the peers. The median is taken per value
 * across peers (absent values count as zero), then each peer's excess over its noise floor is judged by
 * a robust z-score across peers.
 */
function attachPeerMix(context: PeerColumnContext, all: readonly AnalyticalColumnStats[]): void {
    const distributions = all.map(stats => categoryDistribution(stats)).filter((item): item is CategoryDistribution => item !== null);
    if (distributions.length < PEER_MIN_GROUPS) {
        return;
    }
    const values = new Set<string>();
    for (const distribution of distributions) {
        for (const value of distribution.shares.keys()) values.add(value);
    }
    const medianShares = new Map<string, number>();
    for (const value of values) {
        medianShares.set(value, median(distributions.map(distribution => distribution.shares.get(value) ?? 0)));
    }
    const perPeer = new Map<string, { tvd: number; floor: number; excess: number; largest: CategoryShift['largest'] }>();
    const excesses: number[] = [];
    for (const [key, stats] of context.peers) {
        const distribution = categoryDistribution(stats);
        if (!distribution) continue;
        const shift = categoryShift(distribution.shares, distribution.total, medianShares);
        const excess = shift.tvd - shift.floor;
        perPeer.set(key, { tvd: shift.tvd, floor: shift.floor, excess, largest: shift.largest });
        excesses.push(excess);
    }
    const metric = peerMetric(excesses, 0);
    if (!metric) {
        return;
    }
    context.mixByKey = perPeer;
    context.mixMetric = metric;
}

function peerFlagStrength(z: number, threshold: number): number {
    return clamp01(Math.abs(z) / (2 * threshold));
}

/** Mean, extremes and variability of a group column against its peers (robust z-scores). */
export function peerNumericFlags(group: AnalyticalColumnStats, context: PeerColumnContext, population: AnalyticalColumnStats, ctx: RuleContext): AnomalyFlag[] {
    const g = group.numeric;
    if (!g) {
        return [];
    }
    const flags: AnomalyFlag[] = [];
    const peerNote = `${context.peerCount} peer groups`;
    const meanMetric = context.metrics.mean;
    const sigma = population.numeric?.stddev ?? 0;
    if (meanMetric) {
        const threshold = PEER_Z * ctx.k;
        const z = peerZ(g.mean, meanMetric);
        const se = sigma > 0 ? sigma / Math.sqrt(g.count) : 0;
        const shift = Math.abs(g.mean - meanMetric.median);
        if (Math.abs(z) >= threshold && se > 0 && shift / se >= 3) {
            flags.push(flag(
                'MEAN_SHIFT',
                peerFlagStrength(z, threshold),
                `Average ${formatNumber(g.mean)} vs ${formatNumber(meanMetric.median)} for the typical group (robust z ${z.toFixed(1)})`,
                {
                    method: 'mean vs median of peer groups (robust z), standard-error gate',
                    observed: g.mean,
                    observedLabel: 'average in group',
                    expected: meanMetric.median,
                    expectedLabel: 'median of peer averages',
                    threshold,
                    thresholdLabel: `|z| >= ${threshold.toFixed(2)} and standard error gate >= 3`,
                    effect: Math.abs(z),
                    effectUnit: 'robust z',
                    sampleSize: g.count,
                    baselineSize: context.peerCount,
                    notes: [peerNote],
                },
                ctx,
                group.columnIndex,
            ));
        }
    }

    const maxMetric = context.metrics.max;
    const minMetric = context.metrics.min;
    const zMax = maxMetric ? peerZ(g.max, maxMetric) : 0;
    const zMin = minMetric ? peerZ(g.min, minMetric) : 0;
    const outlierThreshold = PEER_OUTLIER_Z * ctx.k;
    if (Math.max(Math.abs(zMax), Math.abs(zMin)) >= outlierThreshold) {
        const useMax = Math.abs(zMax) >= Math.abs(zMin);
        const z = useMax ? zMax : zMin;
        const extreme = useMax ? g.max : g.min;
        const reference = useMax ? maxMetric?.median ?? extreme : minMetric?.median ?? extreme;
        flags.push(flag(
            'RANGE_OUTLIER',
            peerFlagStrength(z, outlierThreshold),
            `${useMax ? 'Maximum' : 'Minimum'} ${formatNumber(extreme)} vs ${formatNumber(reference)} for the typical group (robust z ${z.toFixed(1)})`,
            {
                method: 'group extreme vs median of peer extremes (robust z)',
                observed: extreme,
                observedLabel: useMax ? 'maximum in group' : 'minimum in group',
                expected: reference,
                expectedLabel: useMax ? 'median of peer maxima' : 'median of peer minima',
                threshold: outlierThreshold,
                thresholdLabel: `|z| >= ${outlierThreshold.toFixed(2)}`,
                effect: Math.abs(z),
                effectUnit: 'robust z',
                sampleSize: g.count,
                baselineSize: context.peerCount,
                notes: [peerNote],
            },
            ctx,
            group.columnIndex,
        ));
    }

    const cvMetric = context.metrics.cv;
    if (cvMetric && g.cv !== null) {
        const threshold = PEER_Z * ctx.k;
        const z = peerZ(g.cv, cvMetric);
        if (z >= threshold && g.cv >= PEER_MIN_CV && g.cv >= 2 * cvMetric.median) {
            flags.push(flag(
                'HIGH_VARIABILITY',
                peerFlagStrength(z, threshold),
                `Variability ${g.cv.toFixed(2)} vs ${cvMetric.median.toFixed(2)} for the typical group`,
                {
                    method: 'coefficient of variation vs median of peer groups (robust z, upper side only)',
                    observed: g.cv,
                    observedLabel: 'CV in group',
                    expected: cvMetric.median,
                    expectedLabel: 'median of peer CVs',
                    threshold,
                    thresholdLabel: `robust z >= ${threshold.toFixed(2)}, CV >= ${PEER_MIN_CV} and at least 2x the peer median`,
                    effect: z,
                    effectUnit: 'robust z',
                    sampleSize: g.count,
                    baselineSize: context.peerCount,
                    notes: [peerNote],
                },
                ctx,
                group.columnIndex,
            ));
        }
    }
    return flags;
}

/** Null rate against the peer groups. */
export function peerNullFlag(group: AnalyticalColumnStats, context: PeerColumnContext, ctx: RuleContext): AnomalyFlag | null {
    const metric = context.metrics.nullRate;
    if (!metric) return null;
    const threshold = PEER_Z * ctx.k;
    const z = peerZ(group.nullRate, metric);
    const delta = Math.abs(group.nullRate - metric.median);
    if (z < threshold || delta < PEER_NULL_DELTA * ctx.k) {
        return null;
    }
    return flag(
        'NULL_RATE_DELTA',
        peerFlagStrength(z, threshold),
        `${percent(group.nullRate)} null here vs ${percent(metric.median)} for the typical group`,
        {
            method: 'null rate vs median of peer groups (robust z and absolute change)',
            observed: group.nullRate,
            observedLabel: 'null rate in group',
            expected: metric.median,
            expectedLabel: 'median of peer null rates',
            threshold: PEER_NULL_DELTA * ctx.k,
            thresholdLabel: 'absolute change (scaled), with robust z',
            effect: delta,
            effectUnit: 'pp',
            sampleSize: group.rowCount,
            baselineSize: context.peerCount,
        },
        ctx,
        group.columnIndex,
    );
}

/** Dominant value: its share in the group against the peers, and a minimum share. */
export function peerDominanceFlag(group: AnalyticalColumnStats, context: PeerColumnContext, ctx: RuleContext): AnomalyFlag | null {
    const metric = context.metrics.topShare;
    const share = topShareOf(group);
    const top = group.topValues[0];
    if (!metric || share === null || !top || share < PEER_DOMINANCE_SHARE) return null;
    const threshold = PEER_Z * ctx.k;
    const z = peerZ(share, metric);
    if (z < threshold) return null;
    return flag(
        'TOP_VALUE_DOMINANCE',
        peerFlagStrength(z, threshold),
        `${top.value} is ${percent(share)} of this group vs ${percent(metric.median)} for the typical group`,
        {
            method: 'share of the most frequent value vs median of peer groups (robust z)',
            observed: share,
            observedLabel: 'share in group',
            expected: metric.median,
            expectedLabel: 'median of peer shares',
            threshold,
            thresholdLabel: `robust z >= ${threshold.toFixed(2)} and share >= ${PEER_DOMINANCE_SHARE}`,
            effect: z,
            effectUnit: 'robust z',
            sampleSize: nonNull(group),
            baselineSize: context.peerCount,
        },
        ctx,
        group.columnIndex,
    );
}

/** Date window against the median start and end of the peer groups, as a share of the population span. */
export function peerDateFlags(group: AnalyticalColumnStats, context: PeerColumnContext, population: AnalyticalColumnStats, ctx: RuleContext, fraction: number): AnomalyFlag[] {
    const peerMedian = context.dateMedian;
    const gd = group.date;
    const pd = population.date;
    if (!peerMedian || !gd || !pd) return [];
    const popMin = Date.parse(pd.min);
    const popMax = Date.parse(pd.max);
    const groupMin = Date.parse(gd.min);
    const groupMax = Date.parse(gd.max);
    const span = popMax - popMin;
    if (![popMin, popMax, groupMin, groupMax].every(Number.isFinite) || span <= 0) return [];
    const endsEarly = (peerMedian.end - groupMax) / span;
    const startsLate = (groupMin - peerMedian.start) / span;
    if (endsEarly < fraction && startsLate < fraction) return [];
    const messages: string[] = [];
    if (endsEarly >= fraction) messages.push('range ends early');
    if (startsLate >= fraction) messages.push('range starts late');
    return [flag(
        'DATE_WINDOW_SHIFT',
        0.3,
        `Date ${messages.join(' and ')} compared with the typical group`,
        {
            method: 'date range vs median start and end of peer groups, as a share of the overall span',
            observed: `${gd.min} to ${gd.max}`,
            observedLabel: 'date range in group',
            expected: `${new Date(peerMedian.start).toISOString().slice(0, 10)} to ${new Date(peerMedian.end).toISOString().slice(0, 10)}`,
            expectedLabel: 'median peer date range',
            threshold: fraction,
            thresholdLabel: 'share of span (ends early or starts late)',
            effect: Math.max(endsEarly, startsLate),
            effectUnit: 'span',
            sampleSize: group.rowCount,
            baselineSize: context.peerCount,
        },
        ctx,
        group.columnIndex,
    )];
}

/** Category shift against the median peer distribution (see attachPeerMix). */
export function peerMixFlag(groupKey: string, group: AnalyticalColumnStats, context: PeerColumnContext, ctx: RuleContext): AnomalyFlag | null {
    const entry = context.mixByKey?.get(groupKey);
    const metric = context.mixMetric;
    if (!entry || !metric) return null;
    const threshold = PEER_Z * ctx.k;
    const z = peerZ(entry.excess, metric);
    if (z < threshold || entry.excess < MIX_EFFECT * ctx.k) return null;
    const notes = entry.largest
        ? [`largest shift: ${entry.largest.value} ${percent(entry.largest.groupShare)} vs ${percent(entry.largest.baseShare)}`]
        : [];
    return flag(
        'MIX_SHIFT',
        peerFlagStrength(z, threshold),
        `Category mix differs from the typical group by ${percent(entry.tvd)} of rows (noise about ${percent(entry.floor)})`,
        {
            method: 'category distance from the median peer distribution, minus noise floor (robust z across peers)',
            observed: entry.tvd,
            observedLabel: 'category distance (TVD)',
            expected: entry.floor,
            expectedLabel: 'noise floor for this group size',
            threshold,
            thresholdLabel: `robust z >= ${threshold.toFixed(2)} and excess >= ${(MIX_EFFECT * ctx.k).toFixed(2)}`,
            effect: entry.excess,
            effectUnit: 'TVD',
            sampleSize: categoryDistribution(group)?.total ?? nonNull(group),
            baselineSize: context.peerCount,
            notes,
        },
        ctx,
        group.columnIndex,
    );
}

