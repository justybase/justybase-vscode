// Maps exact disk-backed group statistics (one host response per column batch) onto the same
// AnalyticalDataset the in-memory engine produces, so anomaly rules and the panels are shared.
// Pure module: no DOM, no host calls.

import type { ExploreColumnRole } from '../explore/types.js';
import { isIdentifierStats } from './computeGroupStats.js';
import { decodeGroupKey, encodeGroupKey, formatGroupLabel } from './groupKey.js';
import {
    ANALYTICAL_MAX_ANALYZED_COLUMNS,
    type AnalyticalColumnStats,
    type AnalyticalCoverage,
    type AnalyticalDataset,
    type AnalyticalGroup,
    type AnalyticalGroupColumnRef,
    type AnomalyRuleId,
    type SkippedEvaluation,
    type SkippedEvaluationReason,
} from './types.js';
import type { DiskColumnGroupStats, DiskGroupStatsOmission, DiskGroupStatsResult } from '../types.js';

/** Column batch size per host request; keeps each SQL pass bounded on the extension host. */
export const DISK_STAT_BATCH_COLUMNS = 8;

export interface AnalysisColumn {
    index: number;
    name: string;
    role: ExploreColumnRole;
}

/** Same selection rule as the in-memory engine: group columns excluded, first N analysed. */
export function analyzedColumnsFor(
    columns: readonly AnalysisColumn[],
    groupColumns: readonly AnalyticalGroupColumnRef[],
): { analyzed: AnalysisColumn[]; truncated: boolean } {
    const groupSet = new Set(groupColumns.map(ref => ref.index));
    const candidates = columns.filter(column => !groupSet.has(column.index));
    return {
        analyzed: candidates.slice(0, ANALYTICAL_MAX_ANALYZED_COLUMNS),
        truncated: candidates.length > ANALYTICAL_MAX_ANALYZED_COLUMNS,
    };
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toColumnStats(
    stats: DiskColumnGroupStats,
    column: AnalysisColumn,
    rowCount: number,
    topValues: DiskColumnGroupStats['topValues'],
): AnalyticalColumnStats {
    const nonNull = stats.nonNullCount;
    const nullCount = Math.max(0, rowCount - nonNull);
    const result: AnalyticalColumnStats = {
        columnIndex: column.index,
        name: column.name,
        role: column.role,
        rowCount,
        nullCount,
        nullRate: rowCount > 0 ? nullCount / rowCount : 0,
        distinctCount: stats.distinctCount,
        distinctApprox: false,
        topValues: (topValues ?? []).map(entry => ({ value: String(entry.value ?? ''), count: entry.count })),
    };

    const mean = stats.numeric?.mean ?? null;
    const stddev = stats.numeric?.stddev ?? null;
    const min = finiteNumber(stats.min);
    const max = finiteNumber(stats.max);
    if (column.role === 'measure' && nonNull > 0 && mean !== null && stddev !== null && min !== undefined && max !== undefined) {
        result.numeric = {
            count: nonNull,
            min,
            max,
            mean,
            stddev,
            cv: mean !== 0 ? stddev / Math.abs(mean) : null,
        };
    }
    if (column.role === 'date' && stats.min !== null && stats.min !== undefined && stats.max !== null && stats.max !== undefined) {
        result.date = { min: String(stats.min), max: String(stats.max) };
    }
    if (result.numeric && stats.numeric?.quartiles) {
        result.numeric.quartiles = { ...stats.numeric.quartiles };
    }
    if (stats.categories && (column.role === 'dimension' || column.role === 'unknown')) {
        result.categories = stats.categories.map(entry => ({ value: String(entry.value ?? ''), count: entry.count }));
    }
    if (stats.rare) {
        result.rare = { total: stats.rare.total, examples: [...stats.rare.examples] };
    }
    return result;
}

export interface DiskDatasetInput {
    columns: readonly AnalysisColumn[];
    groupColumns: readonly AnalyticalGroupColumnRef[];
    /** One response per column batch, in batch order. The first response defines the group list. */
    batches: readonly DiskGroupStatsResult[];
    /** True when the batches were asked for quartiles (robust mode). */
    quantiles?: boolean;
}

/** Rules each omitted statistic would have fed, so the view can report the reduced coverage. */
const RULES_BY_FIELD: Record<DiskGroupStatsOmission['field'], readonly AnomalyRuleId[]> = {
    topValues: ['TOP_VALUE_DOMINANCE'],
    categories: ['MIX_SHIFT'],
    quartiles: ['MEAN_SHIFT', 'RANGE_OUTLIER', 'HIGH_VARIABILITY'],
    rare: ['RARE_VALUE'],
};

function skippedFromOmissions(
    omissions: readonly DiskGroupStatsOmission[],
    quantiles: boolean,
): SkippedEvaluation[] {
    const merged = new Map<string, { columnIndex: number; reason: SkippedEvaluationReason; rules: Set<AnomalyRuleId> }>();
    for (const omission of omissions) {
        // Without a quartile request the numeric rules were never in play, so a missing quartile is not a gap.
        if (omission.field === 'quartiles' && !quantiles) continue;
        const key = `${omission.columnIndex}|${omission.reason}`;
        const entry = merged.get(key) ?? { columnIndex: omission.columnIndex, reason: omission.reason, rules: new Set<AnomalyRuleId>() };
        for (const rule of RULES_BY_FIELD[omission.field]) {
            entry.rules.add(rule);
        }
        merged.set(key, entry);
    }
    return [...merged.values()]
        .sort((a, b) => a.columnIndex - b.columnIndex || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0))
        .map(entry => ({ columnIndex: entry.columnIndex, rules: [...entry.rules], reason: entry.reason }));
}

export function buildDiskGroupDataset(input: DiskDatasetInput): AnalyticalDataset {
    const { analyzed, truncated } = analyzedColumnsFor(input.columns, input.groupColumns);
    const roleByIndex = new Map(analyzed.map(column => [column.index, column] as const));
    const first = input.batches[0];
    const totalRows = first?.totalRows ?? 0;

    const populationByIndex = new Map<number, DiskColumnGroupStats>();
    for (const batch of input.batches) {
        for (const stats of batch.population) {
            populationByIndex.set(stats.columnIndex, stats);
        }
    }

    const identifiers = new Set<number>();
    const population: AnalyticalColumnStats[] = [];
    for (const column of analyzed) {
        const stats = populationByIndex.get(column.index);
        if (!stats) continue;
        const converted = toColumnStats(stats, column, totalRows, stats.topValues);
        if (isIdentifierStats(converted, column.role)) {
            identifiers.add(column.index);
        } else {
            population.push(converted);
        }
    }

    const groupsByKey = new Map<string, AnalyticalGroup>();
    const groups: AnalyticalGroup[] = [];
    for (const row of first?.groups ?? []) {
        const key = encodeGroupKey(row.values);
        const values = decodeGroupKey(key);
        const group: AnalyticalGroup = {
            key,
            values,
            label: formatGroupLabel(values),
            rowCount: row.count,
            share: totalRows > 0 ? row.count / totalRows : 0,
            columns: [],
            flags: [],
            score: 0,
            anomalous: false,
        };
        groupsByKey.set(key, group);
        groups.push(group);
    }

    for (const batch of input.batches) {
        for (const row of batch.groups) {
            const group = groupsByKey.get(encodeGroupKey(row.values));
            if (!group) continue;
            for (const stats of row.columns) {
                const column = roleByIndex.get(stats.columnIndex);
                if (!column || identifiers.has(stats.columnIndex)) continue;
                // Quartile responses repeat a column the batch already delivered; the complete entry replaces it.
                const converted = toColumnStats(stats, column, row.count, stats.topValues);
                const existing = group.columns.findIndex(entry => entry.columnIndex === stats.columnIndex);
                if (existing >= 0) {
                    group.columns[existing] = converted;
                } else {
                    group.columns.push(converted);
                }
            }
        }
    }

    // Keep column order identical to the in-memory engine for every group.
    const order = new Map(population.map((stats, position) => [stats.columnIndex, position] as const));
    for (const group of groups) {
        group.columns.sort((a, b) => (order.get(a.columnIndex) ?? 0) - (order.get(b.columnIndex) ?? 0));
    }

    const unlistedRows = first ? Math.max(0, first.unlistedRows) : 0;

    const omissions: DiskGroupStatsOmission[] = [];
    for (const batch of input.batches) {
        if (batch.omitted) omissions.push(...batch.omitted);
    }
    const skipped = skippedFromOmissions(omissions, input.quantiles === true);
    const coverage: AnalyticalCoverage = skipped.length > 0
        ? { quantiles: input.quantiles === true, skipped }
        : { quantiles: input.quantiles === true };

    return {
        mode: 'disk',
        groupColumns: input.groupColumns.map(ref => ({ ...ref })),
        totalRows,
        examinedRows: totalRows,
        population,
        groups,
        totalGroups: first?.totalGroups ?? 0,
        unlistedRows,
        groupsTruncated: (first?.totalGroups ?? 0) > groups.length || unlistedRows > 0,
        analyzedColumnsTruncated: truncated,
        excludedColumns: [
            ...input.groupColumns.map(ref => ref.index),
            ...Array.from(identifiers),
        ],
        coverage,
    };
}
