// Shared types and tuning constants for the Analytical (master/detail) result view.
// Pure module: no DOM or host dependencies.

import type { ExploreColumnRole } from '../explore/types.js';
import type { Quartiles } from './quantiles.js';

export type { ExploreColumnRole };

/** Maximum number of grouping columns a user can pick. */
export const ANALYTICAL_MAX_GROUP_COLUMNS = 3;
/** Groups shown in the master list; smaller groups are counted but not listed. */
export const ANALYTICAL_MAX_GROUPS = 500;
/** Distinct composite keys tracked before further new keys are counted as overflow. */
export const ANALYTICAL_MAX_KEYS = 50_000;
/** Distinct values tracked per group and column (top values are approximate past this). */
export const ANALYTICAL_GROUP_DISTINCT_CAP = 64;
/** Distinct values tracked for the whole population and column. */
export const ANALYTICAL_POPULATION_DISTINCT_CAP = 10_000;
/** Columns analysed per result; extra columns are dropped with a notice. */
export const ANALYTICAL_MAX_ANALYZED_COLUMNS = 60;
/** Above this row count the in-browser engine refuses and suggests disk-backed analysis. */
export const ANALYTICAL_MAX_IN_MEMORY_ROWS = 500_000;
/** Top values listed for dimension columns in the detail pane. */
export const ANALYTICAL_TOP_VALUES = 8;
/** Default minimum group size before anomaly rules are evaluated. */
export const ANALYTICAL_DEFAULT_MIN_GROUP_ROWS = 5;
/** Groups whose anomaly score reaches this value count as anomalous. */
export const ANALYTICAL_SCORE_ANOMALOUS = 25;
/** Rows processed per slice when the engine yields to the UI thread. */
export const ANALYTICAL_CHUNK_ROWS = 5_000;
/** A rare value occurs at most this many times and in exactly one group (RARE_VALUE). */
export const ANALYTICAL_RARE_MAX_OCCURRENCES = 3;
/** Example rare values kept per group and column. */
export const ANALYTICAL_RARE_MAX_EXAMPLES = 5;
/**
 * Quartiles (robust mode) on disk need window passes over every spilled row. Above this row count robust
 * mode falls back to the whole result instead of blocking the extension host. Set from the benchmark.
 */
export const ANALYTICAL_QUANTILE_MAX_DISK_ROWS = 500_000;
/** Full category distributions are kept only up to this many distinct values (MIX_SHIFT). */
export const ANALYTICAL_CATEGORY_MAX_DISTINCT = 50;

export type AnalyticalSensitivity = 'low' | 'normal' | 'high';
/**
 * How a group is compared. whole: the whole result, group included. rest: every row outside the group.
 * robust: medians and IQR instead of means and sigma. peer: the other groups. reference: one chosen group.
 */
export type DetectionMode = 'whole' | 'rest' | 'robust' | 'peer' | 'reference';
/**
 * Persisted per result. 'default' stays whole-result until the VS Code setting is wired; 'auto' picks peer
 * comparison when there are enough groups and whole-result otherwise.
 */
export type DetectionChoice = 'default' | 'auto' | DetectionMode;
export type AnalyticalSortKey = 'size' | 'score' | 'name';
export type AnomalyRuleId =
    | 'MEAN_SHIFT'
    | 'RANGE_OUTLIER'
    | 'HIGH_VARIABILITY'
    | 'NULL_RATE_DELTA'
    | 'CONSTANT_IN_GROUP'
    | 'TOP_VALUE_DOMINANCE'
    | 'RARE_VALUE'
    | 'SMALL_GROUP'
    | 'LARGE_GROUP'
    | 'DATE_WINDOW_SHIFT'
    | 'MIX_SHIFT';

export const ANOMALY_RULE_IDS: readonly AnomalyRuleId[] = [
    'MEAN_SHIFT',
    'RANGE_OUTLIER',
    'HIGH_VARIABILITY',
    'NULL_RATE_DELTA',
    'CONSTANT_IN_GROUP',
    'TOP_VALUE_DOMINANCE',
    'RARE_VALUE',
    'SMALL_GROUP',
    'LARGE_GROUP',
    'DATE_WINDOW_SHIFT',
    'MIX_SHIFT',
];
export type AnomalySeverity = 'info' | 'warn' | 'high';

export interface AnalyticalGroupColumnRef {
    index: number;
    name: string;
}

export interface AnalyticalPersistedState {
    version: 2;
    /** Column names+types of the result when the state was saved; mismatches drop stale columns. */
    schemaKey?: string;
    groupColumns: AnalyticalGroupColumnRef[];
    selectedGroupKey?: string;
    sort: { key: AnalyticalSortKey; desc: boolean };
    sensitivity: AnalyticalSensitivity;
    minGroupRows: number;
    anomaliesOnly: boolean;
    detection: { mode: DetectionChoice; referenceGroupKey?: string };
    /** Rules switched off by the user. Stored as the disabled set, so newly added rules default to on. */
    disabledRules: AnomalyRuleId[];
    /** Columns left out of the analysis; matched by index and name against the current schema. */
    excludedColumns: AnalyticalGroupColumnRef[];
}

/** Why a flag fired, in numbers. Shared by the 'Why?' panel, the CSV export and the documentation. */
export interface FlagEvidence {
    baseline: DetectionMode;
    method: string;
    observed: number | string | null;
    observedLabel: string;
    expected: number | string | null;
    expectedLabel: string;
    threshold: number | null;
    thresholdLabel: string;
    effect: number | null;
    effectUnit: string;
    sampleSize: number;
    baselineSize?: number;
    notes?: string[];
}

export interface AnomalyFlag {
    rule: AnomalyRuleId;
    severity: AnomalySeverity;
    /** Analysed column index, undefined for group-level rules. */
    columnIndex?: number;
    /** Effect strength in 0..1. */
    strength: number;
    message: string;
    evidence: FlagEvidence;
}

export interface AnalyticalTopValue {
    value: string;
    count: number;
}

export interface AnalyticalColumnStats {
    columnIndex: number;
    name: string;
    role: ExploreColumnRole;
    rowCount: number;
    nullCount: number;
    nullRate: number;
    distinctCount: number;
    /** True when distinct tracking hit its cap, so counts and top values are approximate. */
    distinctApprox: boolean;
    numeric?: {
        count: number;
        min: number;
        max: number;
        mean: number;
        /** Population standard deviation. */
        stddev: number;
        /** Coefficient of variation, null when the mean is zero. */
        cv: number | null;
        /** Type-7 quartiles; present only when the analysis requested them (robust mode). */
        quartiles?: Quartiles;
    };
    date?: { min: string; max: string };
    topValues: AnalyticalTopValue[];
    /** Full distribution, only for dimension columns with at most ANALYTICAL_CATEGORY_MAX_DISTINCT values. */
    categories?: AnalyticalTopValue[];
    /** Group statistics only: values of this column that occur in no other group, at most a few times. */
    rare?: { total: number; examples: string[] };
}

export interface AnalyticalGroup {
    key: string;
    values: Array<string | null>;
    label: string;
    rowCount: number;
    share: number;
    columns: AnalyticalColumnStats[];
    flags: AnomalyFlag[];
    score: number;
    anomalous: boolean;
    /** The reference group of reference mode: it is the yardstick, so it is never scored. */
    isReference?: boolean;
}

/** Why a rule could not be evaluated for a column, in the engine's own words. */
export type SkippedEvaluationReason =
    | 'too-many-distinct'
    | 'too-many-groups'
    | 'not-numeric'
    | 'approximate';

/** One rule (or rule family) that did not run for a column, so the view can report the reduced coverage. */
export interface SkippedEvaluation {
    columnIndex: number;
    rules: AnomalyRuleId[];
    reason: SkippedEvaluationReason;
}

/** What the computation produced beyond the basic statistics. Absent fields mean not requested. */
export interface AnalyticalCoverage {
    quantiles: boolean;
    /** Rule evaluations the engine skipped (bounded work or approximate counts). Empty/absent means none. */
    skipped?: SkippedEvaluation[];
}

export interface AnalyticalDataset {
    mode: 'memory' | 'sample' | 'disk';
    groupColumns: AnalyticalGroupColumnRef[];
    totalRows: number;
    examinedRows: number;
    population: AnalyticalColumnStats[];
    groups: AnalyticalGroup[];
    /** Distinct group keys found, including groups not listed. */
    totalGroups: number;
    /** Rows that belong to groups not listed (outside the top N or past the key cap). */
    unlistedRows: number;
    groupsTruncated: boolean;
    analyzedColumnsTruncated: boolean;
    /** Column indexes that were excluded as identifiers or group keys. */
    excludedColumns: number[];
    coverage?: AnalyticalCoverage;
    /**
     * Set when the analysis ran over a filtered scope: rows in scope, and rows in the whole result.
     * The Analytical view reports the scope explicitly so numbers are never read as full-result ones.
     */
    scopedRows?: number;
    sourceRows?: number;
}

export function createDefaultAnalyticalState(): AnalyticalPersistedState {
    return {
        version: 2,
        groupColumns: [],
        sort: { key: 'size', desc: true },
        sensitivity: 'normal',
        minGroupRows: ANALYTICAL_DEFAULT_MIN_GROUP_ROWS,
        anomaliesOnly: false,
        detection: { mode: 'default' },
        disabledRules: [],
        excludedColumns: [],
    };
}
