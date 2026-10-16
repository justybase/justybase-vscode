// Explainable anomaly rules for the Analytical view. A group is compared with a baseline: the whole
// loaded result (default, the group included) or the rest of the result (leave-one-out, exact for
// mean, sigma, CV and null rate). Every threshold is a named constant so the rules can be documented
// and tuned in one place. Sensitivity scales the effect-size thresholds only. Every flag carries the
// evidence behind it, so the UI can explain it and the CSV export can reproduce it.

import { median } from './quantiles.js';
import {
    DETECTION_MODE_LABEL,
    flag,
    formatNumber,
    nonNull,
    percent,
    type RuleContext,
} from './ruleHelpers.js';
import {
    buildPeerContext,
    mixFlag,
    peerDateFlags,
    peerDominanceFlag,
    peerMixFlag,
    peerNullFlag,
    peerNumericFlags,
    PEER_MIN_GROUPS,
    robustNumericFlags,
    type PeerColumnContext,
} from './modeRules.js';
import {
    ANALYTICAL_RARE_MAX_OCCURRENCES,
    ANALYTICAL_SCORE_ANOMALOUS,
    ANOMALY_RULE_IDS,
    type AnalyticalColumnStats,
    type AnalyticalDataset,
    type AnalyticalGroup,
    type AnalyticalSensitivity,
    type AnomalyFlag,
    type AnomalyRuleId,
    type AnomalySeverity,
    type DetectionMode,
} from './types.js';

export { DETECTION_MODE_LABEL, severityForStrength } from './ruleHelpers.js';

/** Reference mode: the yardstick group needs at least this many rows (or non-null values per column). */
export const REFERENCE_MIN_ROWS = 10;

export const SENSITIVITY_FACTOR: Record<AnalyticalSensitivity, number> = { low: 1.5, normal: 1, high: 0.67 };

export const SEVERITY_WEIGHT: Record<AnomalySeverity, number> = { info: 1, warn: 2, high: 3 };
/** Diminishing-returns divisor: many weak flags saturate instead of summing to a huge score. */
export const SCORE_DIVISOR = 6;

/** Group mean shift: effect size |mean_g - mean_base| / sigma_base (scaled by sensitivity). */
export const MEAN_SHIFT_EFFECT = 1.0;
/** Group mean shift: z-score of the group mean against the baseline (not scaled). */
export const MEAN_SHIFT_Z = 3;
/** Range outlier: group extreme further than this many baseline sigmas from the mean. */
export const OUTLIER_SIGMA = 4;
/** High variability: coefficient-of-variation ratio (scaled by sensitivity). */
export const HIGH_VARIABILITY_CV_RATIO = 3;
export const HIGH_VARIABILITY_MIN_CV = 0.5;
/** High variability fallback when means are zero: standard-deviation ratio (scaled). */
export const HIGH_VARIABILITY_SIGMA_RATIO = 2.5;
/** Null-rate change in absolute percentage points (scaled). */
export const NULL_RATE_DELTA = 0.2;
export const NULL_RATE_STRENGTH_SCALE = 0.6;
/** Constant in group: minimum non-null rows in the group and distinct values in the baseline. */
export const CONSTANT_MIN_NON_NULL = 10;
export const CONSTANT_POPULATION_MIN_DISTINCT = 3;
/** Dominance: top value share inside the group and its lift over the baseline (lift scaled). */
export const DOMINANCE_SHARE = 0.6;
export const DOMINANCE_LIFT = 0.4;
/** Date window: fraction of the baseline span a group starts late or ends early. */
export const DATE_SHIFT_FRACTION = 0.25;
export const DATE_SHIFT_STRENGTH = 0.3;
/** Group size: small and large relative to the median listed group. */
export const SMALL_GROUP_FACTOR = 0.1;
export const LARGE_GROUP_FACTOR = 10;
export const SIZE_MEDIAN_MIN_ROWS = 10;
export const SIZE_MIN_GROUPS = 5;
/** Rest-of-result baseline: minimum rows left outside the group, and the cancellation guard on M2. */
export const REST_MIN_ROWS = 10;
export const REST_CANCELLATION_GUARD = 1e-9;
/** Rare value: strength per occurrence and its cap, so it never makes a group anomalous on its own. */
export const RARE_STRENGTH_BASE = 0.15;
export const RARE_STRENGTH_STEP = 0.05;
export const RARE_STRENGTH_CAP = 0.34;

export interface AnomalyRuleDoc {
    id: AnomalyRuleId;
    title: string;
    appliesTo: string;
    /** How the rule behaves in each detection mode. 'adapted' means it runs with a documented simplification. */
    support: Record<DetectionMode, 'full' | 'adapted' | 'n/a'>;
    description: string;
}

/** Single source of truth for the rule catalogue; the user guide and contract are checked against it. */
export const ANOMALY_RULES: readonly AnomalyRuleDoc[] = [
    {
        id: 'MEAN_SHIFT',
        title: 'Mean shift',
        appliesTo: 'measure',
        support: { whole: 'full', rest: 'full', robust: 'adapted', peer: 'adapted', reference: 'full' },
        description: 'Whole and rest: group mean is at least 1 baseline sigma away (scaled) and its z-score is at least 3. Robust: the same on medians with IQR / 1.349. Peer: robust z-score of the mean against the peer groups. Reference: Welch z-score against the reference group.',
    },
    {
        id: 'RANGE_OUTLIER',
        title: 'Range outlier',
        appliesTo: 'measure',
        support: { whole: 'full', rest: 'full', robust: 'adapted', peer: 'adapted', reference: 'full' },
        description: 'Whole and rest: group min or max lies beyond 4 baseline sigmas from the baseline mean. Robust: beyond the Tukey fences (3 IQR). Peer: robust z-score of the extreme against the peers (at least 5, scaled). Reference: beyond 4 sigmas of the reference group.',
    },
    {
        id: 'HIGH_VARIABILITY',
        title: 'High variability',
        appliesTo: 'measure',
        support: { whole: 'full', rest: 'full', robust: 'adapted', peer: 'adapted', reference: 'full' },
        description: 'Group coefficient of variation is at least 3x the baseline CV (scaled) and at least 0.5; with zero means, sigma ratio at least 2.5x. Robust and peer modes use IQR-based and peer-relative variants of the same test.',
    },
    {
        id: 'NULL_RATE_DELTA',
        title: 'Null rate change',
        appliesTo: 'any',
        support: { whole: 'full', rest: 'full', robust: 'full', peer: 'adapted', reference: 'full' },
        description: 'Null rate differs from the baseline by at least 20 percentage points (scaled). Peer mode also requires a robust z-score of at least 3.5 against the peer groups and a change of at least 10 points.',
    },
    {
        id: 'CONSTANT_IN_GROUP',
        title: 'Constant in group',
        appliesTo: 'dimension, measure, unknown',
        support: { whole: 'full', rest: 'adapted', robust: 'full', peer: 'full', reference: 'full' },
        description: 'The group has at least 10 non-null values, all identical, while the baseline has at least 3 distinct values.',
    },
    {
        id: 'TOP_VALUE_DOMINANCE',
        title: 'Dominant value',
        appliesTo: 'dimension, unknown',
        support: { whole: 'full', rest: 'n/a', robust: 'full', peer: 'adapted', reference: 'full' },
        description: 'One value makes up at least 60% of the group and is at least 40 points (scaled) more frequent than in the baseline. Peer mode compares the share with the peer groups instead (robust z-score of at least 3.5).',
    },
    {
        id: 'RARE_VALUE',
        title: 'Rare value',
        appliesTo: 'dimension, unknown',
        support: { whole: 'full', rest: 'full', robust: 'full', peer: 'full', reference: 'full' },
        description: 'A value occurs in exactly one group and at most 3 times in the whole result. Only for columns with at least 3 distinct values, at least 100 non-null rows and at most 50% distinct values; never makes a group anomalous on its own.',
    },
    {
        id: 'DATE_WINDOW_SHIFT',
        title: 'Date window shift',
        appliesTo: 'date',
        support: { whole: 'full', rest: 'adapted', robust: 'full', peer: 'adapted', reference: 'full' },
        description: 'Group date range starts at least 25% of the baseline span late or ends 25% early. Peer mode uses the median start and end of the peer groups.',
    },
    {
        id: 'SMALL_GROUP',
        title: 'Small group',
        appliesTo: 'group',
        support: { whole: 'full', rest: 'full', robust: 'full', peer: 'full', reference: 'adapted' },
        description: 'Group is smaller than 10% of the median listed group size (at least 5 groups, median at least 10 rows). Reference mode compares with the reference group size instead.',
    },
    {
        id: 'LARGE_GROUP',
        title: 'Large group',
        appliesTo: 'group',
        support: { whole: 'full', rest: 'full', robust: 'full', peer: 'full', reference: 'adapted' },
        description: 'Group is larger than 10 times the median listed group size. Reference mode compares with the reference group size instead.',
    },
    {
        id: 'MIX_SHIFT',
        title: 'Category mix shift',
        appliesTo: 'dimension, unknown',
        support: { whole: 'full', rest: 'full', robust: 'full', peer: 'adapted', reference: 'full' },
        description: 'Share of rows per category differs from the baseline by more than the noise expected for the group size (total variation distance minus noise floor, at least 0.25, scaled). Only for columns with at most 50 distinct values. Peer mode compares with the median peer distribution.',
    },
];

/**
 * Baseline statistics for "rest of result": the whole result minus the group, computed exactly from
 * the population moments (inverse of the parallel Welford combine). Returns null when too few rows
 * are left outside the group, so no rule runs against an unstable baseline.
 */
export function restBaseline(population: AnalyticalColumnStats, group: AnalyticalColumnStats): AnalyticalColumnStats | null {
    const rowsRest = population.rowCount - group.rowCount;
    if (rowsRest < REST_MIN_ROWS) {
        return null;
    }
    const nullsRest = population.nullCount - group.nullCount;
    const baseline: AnalyticalColumnStats = {
        ...population,
        rowCount: rowsRest,
        nullCount: nullsRest,
        nullRate: nullsRest / rowsRest,
        // Top values cannot be subtracted from a truncated list, so value-level rules see no baseline.
        topValues: [],
        numeric: undefined,
        categories: undefined,
    };
    const pn = population.numeric;
    const gn = group.numeric;
    if (pn && gn) {
        const nP = pn.count;
        const nG = gn.count;
        const nR = nP - nG;
        if (nR >= REST_MIN_ROWS) {
            const delta = gn.mean - pn.mean;
            const meanR = pn.mean - (nG / nR) * delta;
            const m2P = nP * pn.stddev * pn.stddev;
            const m2G = nG * gn.stddev * gn.stddev;
            const m2R = m2P - m2G - (delta * delta * nP * nG) / nR;
            if (m2R > 0 && m2R > REST_CANCELLATION_GUARD * m2P) {
                const stddev = Math.sqrt(m2R / nR);
                baseline.numeric = {
                    count: nR,
                    min: pn.min,
                    max: pn.max,
                    mean: meanR,
                    stddev,
                    cv: meanR !== 0 ? stddev / Math.abs(meanR) : null,
                };
            }
        }
    }
    if (population.categories && group.categories) {
        // The rest of the result holds the population count minus the group count for every category.
        const inGroup = new Map(group.categories.map(entry => [entry.value, entry.count] as const));
        baseline.categories = population.categories
            .map(entry => ({ value: entry.value, count: entry.count - (inGroup.get(entry.value) ?? 0) }))
            .filter(entry => entry.count > 0);
    }
    return baseline;
}

function nullRateFlag(group: AnalyticalColumnStats, baseline: AnalyticalColumnStats, ctx: RuleContext): AnomalyFlag | null {
    const delta = Math.abs(group.nullRate - baseline.nullRate);
    const threshold = NULL_RATE_DELTA * ctx.k;
    if (delta < threshold) {
        return null;
    }
    const strength = group.nullRate >= 0.95 && baseline.nullRate < 0.5 ? 1 : delta / NULL_RATE_STRENGTH_SCALE;
    return flag(
        'NULL_RATE_DELTA',
        strength,
        `${percent(group.nullRate)} null here vs ${percent(baseline.nullRate)} overall`,
        {
            method: `null rate vs ${DETECTION_MODE_LABEL[ctx.mode]}`,
            observed: group.nullRate,
            observedLabel: 'null rate in group',
            expected: baseline.nullRate,
            expectedLabel: 'null rate in baseline',
            threshold,
            thresholdLabel: 'difference (scaled)',
            effect: delta,
            effectUnit: 'pp',
            sampleSize: group.rowCount,
            baselineSize: baseline.rowCount,
        },
        ctx,
        group.columnIndex,
    );
}

function numericFlags(group: AnalyticalColumnStats, baseline: AnalyticalColumnStats, ctx: RuleContext, welch = false): AnomalyFlag[] {
    const flags: AnomalyFlag[] = [];
    const g = group.numeric;
    const p = baseline.numeric;
    if (!g || !p || p.stddev <= 0) {
        return flags;
    }
    const label = DETECTION_MODE_LABEL[ctx.mode];

    const shift = Math.abs(g.mean - p.mean);
    // Welch (reference mode): both spreads enter the standard error and the pooled effect size.
    const effect = welch ? shift / Math.sqrt((g.stddev * g.stddev + p.stddev * p.stddev) / 2) : shift / p.stddev;
    const standardError = welch ? Math.sqrt((g.stddev * g.stddev) / g.count + (p.stddev * p.stddev) / p.count) : p.stddev / Math.sqrt(g.count);
    const z = standardError > 0 ? shift / standardError : 0;
    if (effect >= MEAN_SHIFT_EFFECT * ctx.k && z >= MEAN_SHIFT_Z) {
        flags.push(flag(
            'MEAN_SHIFT',
            effect / 3,
            `Average ${formatNumber(g.mean)} vs ${formatNumber(p.mean)} overall (${effect.toFixed(1)} sigma)`,
            {
                method: welch ? 'mean shift vs reference group (Welch z, pooled effect size)' : `mean shift vs ${label} (effect size and z-score)`,
                observed: g.mean,
                observedLabel: 'average in group',
                expected: p.mean,
                expectedLabel: 'average in baseline',
                threshold: MEAN_SHIFT_EFFECT * ctx.k,
                thresholdLabel: `effect size >= ${(MEAN_SHIFT_EFFECT * ctx.k).toFixed(2)} sigma and z >= ${MEAN_SHIFT_Z}`,
                effect,
                effectUnit: 'sigma',
                sampleSize: g.count,
                baselineSize: p.count,
                notes: [`z = ${z.toFixed(1)}`],
            },
            ctx,
            group.columnIndex,
        ));
    }

    const deviation = Math.max((p.mean - g.min) / p.stddev, (g.max - p.mean) / p.stddev);
    if (deviation > OUTLIER_SIGMA) {
        const extreme = g.max - p.mean > p.mean - g.min ? g.max : g.min;
        flags.push(flag(
            'RANGE_OUTLIER',
            (deviation - OUTLIER_SIGMA) / OUTLIER_SIGMA + 0.3,
            `Values reach ${formatNumber(deviation)} sigma from the overall mean (range ${formatNumber(g.min)} to ${formatNumber(g.max)})`,
            {
                method: `extreme value vs ${label} mean and sigma`,
                observed: extreme,
                observedLabel: 'most extreme value in group',
                expected: p.mean,
                expectedLabel: 'average in baseline',
                threshold: OUTLIER_SIGMA,
                thresholdLabel: `beyond ${OUTLIER_SIGMA} sigma`,
                effect: deviation,
                effectUnit: 'sigma',
                sampleSize: g.count,
                baselineSize: p.count,
            },
            ctx,
            group.columnIndex,
        ));
    }

    if (g.cv !== null && p.cv !== null && p.cv > 0 && g.mean !== 0 && p.mean !== 0) {
        const ratio = g.cv / p.cv;
        const threshold = HIGH_VARIABILITY_CV_RATIO * ctx.k;
        if (ratio >= threshold && g.cv >= HIGH_VARIABILITY_MIN_CV) {
            flags.push(flag(
                'HIGH_VARIABILITY',
                ratio / 6,
                `Variability ${ratio.toFixed(1)}x the overall coefficient of variation`,
                {
                    method: `coefficient of variation vs ${label}`,
                    observed: g.cv,
                    observedLabel: 'CV in group',
                    expected: p.cv,
                    expectedLabel: 'CV in baseline',
                    threshold,
                    thresholdLabel: `ratio >= ${threshold.toFixed(2)} and CV >= ${HIGH_VARIABILITY_MIN_CV}`,
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
        const ratio = g.stddev / p.stddev;
        const threshold = HIGH_VARIABILITY_SIGMA_RATIO * ctx.k;
        if (ratio >= threshold) {
            flags.push(flag(
                'HIGH_VARIABILITY',
                ratio / 6,
                `Spread ${ratio.toFixed(1)}x the overall standard deviation`,
                {
                    method: `standard deviation vs ${label} (means at zero)`,
                    observed: g.stddev,
                    observedLabel: 'sigma in group',
                    expected: p.stddev,
                    expectedLabel: 'sigma in baseline',
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

function dateFlags(group: AnalyticalColumnStats, baseline: AnalyticalColumnStats, ctx: RuleContext): AnomalyFlag[] {
    const gd = group.date;
    const pd = baseline.date;
    if (!gd || !pd) {
        return [];
    }
    const popMin = Date.parse(pd.min);
    const popMax = Date.parse(pd.max);
    const groupMin = Date.parse(gd.min);
    const groupMax = Date.parse(gd.max);
    const span = popMax - popMin;
    if (![popMin, popMax, groupMin, groupMax].every(Number.isFinite) || span <= 0) {
        return [];
    }
    const messages: string[] = [];
    const endsEarly = (popMax - groupMax) / span;
    const startsLate = (groupMin - popMin) / span;
    if (endsEarly >= DATE_SHIFT_FRACTION) messages.push('range ends early');
    if (startsLate >= DATE_SHIFT_FRACTION) messages.push('range starts late');
    if (messages.length === 0) {
        return [];
    }
    return [flag(
        'DATE_WINDOW_SHIFT',
        DATE_SHIFT_STRENGTH,
        `Date ${messages.join(' and ')} compared with the overall range`,
        {
            method: `date range vs ${DETECTION_MODE_LABEL[ctx.mode]} span`,
            observed: `${gd.min} to ${gd.max}`,
            observedLabel: 'date range in group',
            expected: `${pd.min} to ${pd.max}`,
            expectedLabel: 'date range in baseline',
            threshold: DATE_SHIFT_FRACTION,
            thresholdLabel: 'share of span (ends early or starts late)',
            effect: Math.max(endsEarly, startsLate),
            effectUnit: 'span',
            sampleSize: group.rowCount,
            baselineSize: baseline.rowCount,
        },
        ctx,
        group.columnIndex,
    )];
}

function constantFlag(group: AnalyticalColumnStats, baseline: AnalyticalColumnStats, ctx: RuleContext): AnomalyFlag | null {
    if (nonNull(group) < CONSTANT_MIN_NON_NULL || group.distinctApprox || group.distinctCount !== 1) {
        return null;
    }
    if (baseline.distinctCount < CONSTANT_POPULATION_MIN_DISTINCT) {
        return null;
    }
    const value = group.topValues[0]?.value ?? '';
    return flag(
        'CONSTANT_IN_GROUP',
        0.25,
        `Every value here is ${value}; overall there are ${baseline.distinctCount} distinct values`,
        {
            method: `distinct values in group vs ${DETECTION_MODE_LABEL[ctx.mode]}`,
            observed: 1,
            observedLabel: 'distinct values in group',
            expected: baseline.distinctCount,
            expectedLabel: 'distinct values in baseline',
            threshold: CONSTANT_POPULATION_MIN_DISTINCT,
            thresholdLabel: 'minimum baseline distinct values',
            effect: null,
            effectUnit: 'values',
            sampleSize: nonNull(group),
            baselineSize: nonNull(baseline),
        },
        ctx,
        group.columnIndex,
    );
}

function dominanceFlag(group: AnalyticalColumnStats, baseline: AnalyticalColumnStats, ctx: RuleContext): AnomalyFlag | null {
    const top = group.topValues[0];
    const groupBase = nonNull(group);
    if (!top || group.distinctApprox || baseline.distinctApprox || groupBase === 0) {
        return null;
    }
    const share = top.count / groupBase;
    if (share < DOMINANCE_SHARE) {
        return null;
    }
    const baselineTop = baseline.topValues.find(entry => entry.value === top.value);
    const baselineBase = nonNull(baseline);
    if (!baselineTop || baselineBase === 0) {
        // The value is not among the baseline's top values, so its share there is unknown.
        return null;
    }
    const baselineShare = baselineTop.count / baselineBase;
    const lift = share - baselineShare;
    const threshold = DOMINANCE_LIFT * ctx.k;
    if (lift < threshold) {
        return null;
    }
    return flag(
        'TOP_VALUE_DOMINANCE',
        lift,
        `${top.value} is ${percent(share)} of this group vs ${percent(baselineShare)} overall`,
        {
            method: `share of the most frequent value vs ${DETECTION_MODE_LABEL[ctx.mode]}`,
            observed: share,
            observedLabel: 'share in group',
            expected: baselineShare,
            expectedLabel: 'share in baseline',
            threshold,
            thresholdLabel: `lift >= ${threshold.toFixed(2)} and share >= ${DOMINANCE_SHARE}`,
            effect: lift,
            effectUnit: 'pp',
            sampleSize: groupBase,
            baselineSize: baselineBase,
        },
        ctx,
        group.columnIndex,
    );
}

function rareFlag(group: AnalyticalColumnStats, ctx: RuleContext): AnomalyFlag | null {
    const rare = group.rare;
    if (!rare || rare.total === 0) {
        return null;
    }
    const strength = Math.min(RARE_STRENGTH_CAP, RARE_STRENGTH_BASE + RARE_STRENGTH_STEP * Math.min(rare.total, 4));
    const examples = rare.examples.join(', ');
    return flag(
        'RARE_VALUE',
        strength,
        `${rare.total} rare value${rare.total === 1 ? '' : 's'} seen only in this group: ${examples}`,
        {
            method: 'value owned by this group alone, at most a few occurrences',
            observed: rare.total,
            observedLabel: 'rare values in group',
            expected: 0,
            expectedLabel: 'rare values expected',
            threshold: ANALYTICAL_RARE_MAX_OCCURRENCES,
            thresholdLabel: `occurrences <= ${ANALYTICAL_RARE_MAX_OCCURRENCES} and one group`,
            effect: null,
            effectUnit: 'values',
            sampleSize: group.rowCount,
            notes: [`examples: ${examples}`],
        },
        ctx,
        group.columnIndex,
    );
}

/** How a mode compares a group column with its baseline. Constant, rare and size rules are shared. */
interface ColumnStrategy {
    baselineOf(column: AnalyticalColumnStats): AnalyticalColumnStats | null;
    numeric(group: AnalyticalGroup, column: AnalyticalColumnStats, baseline: AnalyticalColumnStats): AnomalyFlag[];
    nullRate(group: AnalyticalGroup, column: AnalyticalColumnStats, baseline: AnalyticalColumnStats): AnomalyFlag | null;
    dominance(group: AnalyticalGroup, column: AnalyticalColumnStats, baseline: AnalyticalColumnStats): AnomalyFlag | null;
    date(group: AnalyticalGroup, column: AnalyticalColumnStats, baseline: AnalyticalColumnStats): AnomalyFlag[];
    mix(group: AnalyticalGroup, column: AnalyticalColumnStats, baseline: AnalyticalColumnStats): AnomalyFlag | null;
}

/** Whole result, rest of result, or robust statistics against the whole result. */
function populationStrategy(
    populationByIndex: ReadonlyMap<number, AnalyticalColumnStats>,
    ctx: RuleContext,
    rest: boolean,
    robust: boolean,
): ColumnStrategy {
    return {
        baselineOf: column => {
            const population = populationByIndex.get(column.columnIndex);
            if (!population) return null;
            return rest ? restBaseline(population, column) : population;
        },
        numeric: (_group, column, baseline) => (robust ? robustNumericFlags(column, baseline, ctx) : numericFlags(column, baseline, ctx)),
        nullRate: (_group, column, baseline) => nullRateFlag(column, baseline, ctx),
        dominance: (_group, column, baseline) => dominanceFlag(column, baseline, ctx),
        date: (_group, column, baseline) => dateFlags(column, baseline, ctx),
        mix: (_group, column, baseline) => mixFlag(column, baseline, ctx),
    };
}

/** Each group against the reference group: Welch for means, the rest as in the whole-result family. */
function referenceStrategy(reference: AnalyticalGroup, ctx: RuleContext): ColumnStrategy {
    const base = populationStrategy(new Map(), ctx, false, false);
    return {
        baselineOf: column => {
            const yardstick = reference.columns.find(entry => entry.columnIndex === column.columnIndex);
            return yardstick && nonNull(yardstick) >= REFERENCE_MIN_ROWS ? yardstick : null;
        },
        numeric: (_group, column, baseline) => numericFlags(column, baseline, ctx, true),
        nullRate: base.nullRate,
        dominance: base.dominance,
        date: base.date,
        mix: base.mix,
    };
}

/** Each group against its peer groups (robust z-scores). Population is the baseline for shared rules. */
function peerStrategy(
    populationByIndex: ReadonlyMap<number, AnalyticalColumnStats>,
    contexts: ReadonlyMap<number, PeerColumnContext>,
    ctx: RuleContext,
): ColumnStrategy {
    const contextOf = (column: AnalyticalColumnStats): PeerColumnContext | undefined => contexts.get(column.columnIndex);
    return {
        baselineOf: column => populationByIndex.get(column.columnIndex) ?? null,
        numeric: (_group, column, baseline) => {
            const context = contextOf(column);
            return context ? peerNumericFlags(column, context, baseline, ctx) : [];
        },
        nullRate: (_group, column) => {
            const context = contextOf(column);
            return context ? peerNullFlag(column, context, ctx) : null;
        },
        dominance: (_group, column) => {
            const context = contextOf(column);
            return context ? peerDominanceFlag(column, context, ctx) : null;
        },
        date: (_group, column, baseline) => {
            const context = contextOf(column);
            return context ? peerDateFlags(column, context, baseline, ctx, DATE_SHIFT_FRACTION) : [];
        },
        mix: (group, column) => {
            const context = contextOf(column);
            return context ? peerMixFlag(group.key, column, context, ctx) : null;
        },
    };
}

function columnFlags(
    group: AnalyticalGroup,
    strategy: ColumnStrategy,
    ctx: RuleContext,
    enabled: (rule: AnomalyRuleId) => boolean,
): AnomalyFlag[] {
    const flags: AnomalyFlag[] = [];
    for (const column of group.columns) {
        const role = column.role;
        const baseline = strategy.baselineOf(column);
        if (baseline) {
            const nullFlag = enabled('NULL_RATE_DELTA') ? strategy.nullRate(group, column, baseline) : null;
            if (nullFlag) flags.push(nullFlag);

            if (role === 'measure') {
                flags.push(...strategy.numeric(group, column, baseline).filter(item => enabled(item.rule)));
            }
            if (role === 'date' && enabled('DATE_WINDOW_SHIFT')) {
                flags.push(...strategy.date(group, column, baseline));
            }
            if (role !== 'date' && enabled('CONSTANT_IN_GROUP')) {
                const constant = constantFlag(column, baseline, ctx);
                if (constant) flags.push(constant);
            }
            if (role === 'dimension' || role === 'unknown') {
                if (enabled('TOP_VALUE_DOMINANCE')) {
                    const dominance = strategy.dominance(group, column, baseline);
                    if (dominance) flags.push(dominance);
                }
                if (enabled('MIX_SHIFT')) {
                    const mix = strategy.mix(group, column, baseline);
                    if (mix) flags.push(mix);
                }
            }
        }
        // RARE_VALUE is defined by ownership across groups, so it is independent of the baseline.
        if ((role === 'dimension' || role === 'unknown') && enabled('RARE_VALUE')) {
            const rare = rareFlag(column, ctx);
            if (rare) flags.push(rare);
        }
    }
    return flags;
}

/** Group size compared with the median listed group, or with the reference group in reference mode. */
interface SizeBaseline {
    size: number;
    kind: 'median' | 'reference';
    listedCount: number;
}

function groupSizeFlags(group: AnalyticalGroup, baseline: SizeBaseline, ctx: RuleContext): AnomalyFlag[] {
    const { size, kind, listedCount } = baseline;
    const comparison = kind === 'median' ? `a median group of ${size}` : `the reference group of ${size}`;
    const isMedian = kind === 'median';
    const sizeEvidence = {
        method: isMedian ? 'group size vs median listed group' : 'group size vs reference group',
        observedLabel: 'rows in group',
        expectedLabel: isMedian ? 'median listed group size' : 'reference group size',
        expected: size,
        sampleSize: group.rowCount,
        ...(isMedian ? { baselineSize: listedCount } : {}),
    };
    if (group.rowCount < SMALL_GROUP_FACTOR * size) {
        return [flag('SMALL_GROUP', 0.4, `${group.rowCount} rows vs ${comparison}`, {
            ...sizeEvidence,
            observed: group.rowCount,
            threshold: SMALL_GROUP_FACTOR,
            thresholdLabel: 'share of median size',
            effect: group.rowCount / size,
            effectUnit: 'x',
        }, ctx)];
    }
    if (group.rowCount > LARGE_GROUP_FACTOR * size) {
        return [flag('LARGE_GROUP', 0.2, `${group.rowCount} rows vs ${comparison}`, {
            ...sizeEvidence,
            observed: group.rowCount,
            threshold: LARGE_GROUP_FACTOR,
            thresholdLabel: 'multiple of median size',
            effect: group.rowCount / size,
            effectUnit: 'x',
        }, ctx)];
    }
    return [];
}

export interface ApplyAnomalyOptions {
    sensitivity: AnalyticalSensitivity;
    minGroupRows: number;
    /** Comparison used for the flags. Defaults to the whole result, as before. */
    mode?: DetectionMode;
    /** Reference mode: the listed group that every other group is compared with. Never scored itself. */
    referenceGroupKey?: string;
    /** Rules the user switched off. */
    disabledRules?: readonly AnomalyRuleId[];
    /** Columns the user left out; they are removed from the scored result without recomputing it. */
    excludedColumns?: readonly number[];
}

/** Returns a copy of the dataset with flags, evidence, score and anomalous status filled in per group. */
export function applyAnomalies(dataset: AnalyticalDataset, options: ApplyAnomalyOptions): AnalyticalDataset {
    const mode: DetectionMode = options.mode ?? 'whole';
    const ctx: RuleContext = { k: SENSITIVITY_FACTOR[options.sensitivity], mode };
    const disabled = new Set<AnomalyRuleId>(options.disabledRules ?? []);
    const enabled = (rule: AnomalyRuleId): boolean => !disabled.has(rule) && ANOMALY_RULE_IDS.includes(rule);
    const excluded = new Set<number>(options.excludedColumns ?? []);
    const keepColumn = (columnIndex: number): boolean => !excluded.has(columnIndex);
    const scoredGroup = (group: AnalyticalGroup): AnalyticalGroup => ({
        ...group,
        columns: group.columns.filter(column => keepColumn(column.columnIndex)),
    });

    const population = dataset.population.filter(stats => keepColumn(stats.columnIndex));
    const populationByIndex = new Map(population.map(stats => [stats.columnIndex, stats] as const));
    const listedCount = dataset.groups.length;
    const medianSize = median(dataset.groups.map(group => group.rowCount));
    const qualifying = dataset.groups.filter(group => group.rowCount >= options.minGroupRows);
    const reference = mode === 'reference' && options.referenceGroupKey !== undefined
        ? dataset.groups.find(group => group.key === options.referenceGroupKey)
        : undefined;
    const referenceScored = reference ? scoredGroup(reference) : undefined;

    const peerContexts = new Map<number, PeerColumnContext>();
    if (mode === 'peer' && qualifying.length >= PEER_MIN_GROUPS) {
        for (const stats of population) {
            peerContexts.set(stats.columnIndex, buildPeerContext(qualifying, stats, options.minGroupRows));
        }
    }

    let strategy: ColumnStrategy | null;
    switch (mode) {
        case 'rest': strategy = populationStrategy(populationByIndex, ctx, true, false); break;
        case 'robust': strategy = populationStrategy(populationByIndex, ctx, false, true); break;
        case 'peer': strategy = peerStrategy(populationByIndex, peerContexts, ctx); break;
        case 'reference': strategy = referenceScored ? referenceStrategy(referenceScored, ctx) : null; break;
        default: strategy = populationStrategy(populationByIndex, ctx, false, false);
    }

    let sizeBaseline: SizeBaseline | null = null;
    if (mode === 'reference') {
        if (referenceScored && referenceScored.rowCount >= REFERENCE_MIN_ROWS) {
            sizeBaseline = { size: referenceScored.rowCount, kind: 'reference', listedCount };
        }
    } else if (listedCount >= SIZE_MIN_GROUPS && medianSize >= SIZE_MEDIAN_MIN_ROWS) {
        sizeBaseline = { size: medianSize, kind: 'median', listedCount };
    }

    const groups = dataset.groups.map((group): AnalyticalGroup => {
        const scored = scoredGroup(group);
        if (mode === 'reference' && (!reference || group.key === reference.key)) {
            // Without a reference nothing is scored; the reference group is the yardstick and is never scored.
            return { ...scored, flags: [], score: 0, anomalous: false, isReference: reference?.key === group.key };
        }
        const flags: AnomalyFlag[] = [];
        if (group.rowCount >= options.minGroupRows && strategy) {
            flags.push(...columnFlags(scored, strategy, ctx, enabled));
            if (sizeBaseline && (enabled('SMALL_GROUP') || enabled('LARGE_GROUP'))) {
                flags.push(...groupSizeFlags(group, sizeBaseline, ctx).filter(item => enabled(item.rule)));
            }
        }
        flags.sort((a, b) => b.strength - a.strength);
        const raw = flags.reduce((sum, item) => sum + SEVERITY_WEIGHT[item.severity] * item.strength, 0);
        const score = Math.round(100 * (1 - Math.exp(-raw / SCORE_DIVISOR)));
        return {
            ...scored,
            flags,
            score,
            anomalous: score >= ANALYTICAL_SCORE_ANOMALOUS,
            ...(mode === 'reference' ? { isReference: false } : {}),
        };
    });

    return { ...dataset, population, groups };
}

const SUPPORT_LABEL: Record<'full' | 'adapted' | 'n/a', string> = {
    full: 'Yes',
    adapted: 'Adapted',
    'n/a': 'No',
};

/**
 * Markdown table of the rule catalogue. The user guide embeds this output between markers and a test
 * fails when they differ, so the documentation cannot drift from the rules.
 */
export function renderRuleCatalogueMarkdown(): string {
    const header = '| Rule | Applies to | Whole result | Rest of result | Robust | Peer groups | Reference group | What it flags |';
    const separator = '|---|---|---|---|---|---|---|---|';
    const rows = ANOMALY_RULES.map(rule => (
        `| ${rule.title} (\`${rule.id}\`) | ${rule.appliesTo} | ${SUPPORT_LABEL[rule.support.whole]} | ${SUPPORT_LABEL[rule.support.rest]} | ${SUPPORT_LABEL[rule.support.robust]} | ${SUPPORT_LABEL[rule.support.peer]} | ${SUPPORT_LABEL[rule.support.reference]} | ${rule.description} |`
    ));
    return [header, separator, ...rows].join('\n');
}
