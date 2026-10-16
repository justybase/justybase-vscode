// Pure state transitions for the Analytical view. Persisted values come back from webview host
// state and are untrusted, so every field is validated against the current result schema.

import type { ExploreColumnRole } from '../explore/types.js';
import {
    ANALYTICAL_MAX_GROUP_COLUMNS,
    ANOMALY_RULE_IDS,
    type AnalyticalGroup,
    type AnalyticalGroupColumnRef,
    type AnalyticalPersistedState,
    type AnalyticalSensitivity,
    type AnalyticalSortKey,
    type AnomalyRuleId,
    type DetectionChoice,
    createDefaultAnalyticalState,
} from './types.js';
import { DETECTION_CHOICES } from './detectionConfig.js';
import { normalizeKeyPart } from './groupKey.js';

const SORT_KEYS: readonly AnalyticalSortKey[] = ['size', 'score', 'name'];
const SENSITIVITIES: readonly AnalyticalSensitivity[] = ['low', 'normal', 'high'];
const MIN_GROUP_ROWS_LIMIT = 1000;

export interface SchemaColumn {
    index: number;
    name: string;
    type?: string;
}

export function buildSchemaKey(columns: readonly SchemaColumn[]): string {
    return JSON.stringify(columns.map(column => [column.name, column.type ?? '']));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeGroupColumns(raw: unknown, columns: readonly SchemaColumn[]): AnalyticalGroupColumnRef[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const byIndex = new Map(columns.map(column => [column.index, column.name] as const));
    const seen = new Set<number>();
    const result: AnalyticalGroupColumnRef[] = [];
    for (const item of raw) {
        if (!isRecord(item) || typeof item.index !== 'number' || typeof item.name !== 'string') {
            continue;
        }
        // A column is kept only when the same index still carries the same name.
        if (byIndex.get(item.index) !== item.name || seen.has(item.index)) {
            continue;
        }
        seen.add(item.index);
        result.push({ index: item.index, name: item.name });
        if (result.length >= ANALYTICAL_MAX_GROUP_COLUMNS) {
            break;
        }
    }
    return result;
}

/** Validates persisted state against the current result. Anything unexpected falls back to defaults. */
export function sanitizeState(
    raw: unknown,
    schemaKey: string,
    columns: readonly SchemaColumn[],
): AnalyticalPersistedState {
    const base = createDefaultAnalyticalState();
    // Version 1 predates detection modes, rule toggles and excluded columns; it migrates to the defaults for them.
    if (!isRecord(raw) || (raw.version !== 1 && raw.version !== 2)) {
        return { ...base, schemaKey };
    }
    const sort = isRecord(raw.sort) ? raw.sort : {};
    const sortKey = SORT_KEYS.includes(sort.key as AnalyticalSortKey) ? (sort.key as AnalyticalSortKey) : base.sort.key;
    const sensitivity = SENSITIVITIES.includes(raw.sensitivity as AnalyticalSensitivity)
        ? (raw.sensitivity as AnalyticalSensitivity)
        : base.sensitivity;
    const minGroupRows = typeof raw.minGroupRows === 'number' && Number.isInteger(raw.minGroupRows)
        && raw.minGroupRows >= 1 && raw.minGroupRows <= MIN_GROUP_ROWS_LIMIT
        ? raw.minGroupRows
        : base.minGroupRows;

    return {
        version: 2,
        schemaKey,
        groupColumns: sanitizeGroupColumns(raw.groupColumns, columns),
        selectedGroupKey: typeof raw.selectedGroupKey === 'string' ? raw.selectedGroupKey : undefined,
        sort: { key: sortKey, desc: typeof sort.desc === 'boolean' ? sort.desc : base.sort.desc },
        sensitivity,
        minGroupRows,
        anomaliesOnly: raw.anomaliesOnly === true,
        detection: sanitizeDetection(raw.detection),
        disabledRules: sanitizeDisabledRules(raw.disabledRules),
        excludedColumns: sanitizeExcludedColumns(raw.excludedColumns, columns, sanitizeGroupColumns(raw.groupColumns, columns)),
    };
}

/** Unknown modes fall back to the default; the reference key is kept only as a bounded string. */
function sanitizeDetection(raw: unknown): AnalyticalPersistedState['detection'] {
    const mode = isRecord(raw) ? raw.mode : undefined;
    const referenceGroupKey = isRecord(raw) && typeof raw.referenceGroupKey === 'string' && raw.referenceGroupKey.length <= MAX_REFERENCE_KEY_LENGTH
        ? raw.referenceGroupKey
        : undefined;
    const choice = DETECTION_CHOICES.includes(mode as DetectionChoice) ? (mode as DetectionChoice) : 'default';
    return referenceGroupKey === undefined ? { mode: choice } : { mode: choice, referenceGroupKey };
}

const MAX_REFERENCE_KEY_LENGTH = 4096;

/** Unknown rule ids are dropped, so a state saved by a newer build never disables anything silently. */
function sanitizeDisabledRules(raw: unknown): AnomalyRuleId[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const unique = new Set<AnomalyRuleId>();
    for (const item of raw) {
        if (ANOMALY_RULE_IDS.includes(item as AnomalyRuleId)) {
            unique.add(item as AnomalyRuleId);
        }
    }
    return [...unique];
}

/** Excluded columns must still exist with the same name, and cannot also be grouping columns. */
function sanitizeExcludedColumns(
    raw: unknown,
    columns: readonly SchemaColumn[],
    groupColumns: readonly AnalyticalGroupColumnRef[],
): AnalyticalGroupColumnRef[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const byIndex = new Map(columns.map(column => [column.index, column.name] as const));
    const grouped = new Set(groupColumns.map(ref => ref.index));
    const seen = new Set<number>();
    const result: AnalyticalGroupColumnRef[] = [];
    for (const item of raw) {
        if (!isRecord(item) || typeof item.index !== 'number' || typeof item.name !== 'string') {
            continue;
        }
        if (byIndex.get(item.index) !== item.name || grouped.has(item.index) || seen.has(item.index)) {
            continue;
        }
        seen.add(item.index);
        result.push({ index: item.index, name: item.name });
    }
    return result;
}

const SUGGESTION_MIN_SAMPLE = 20;
const SUGGESTION_MIN_DISTINCT = 2;
const SUGGESTION_MAX_DISTINCT = 50;
const SUGGESTION_MAX_DISTINCT_RATIO = 0.9;

/**
 * One-click suggestions for grouping: low-cardinality dimension columns, ordered by cardinality.
 * With no sample (disk-backed results) only role-based candidates are returned, without a cardinality check.
 */
export function suggestGroupColumns(
    columns: ReadonlyArray<SchemaColumn & { role: ExploreColumnRole }>,
    sample: ReadonlyArray<readonly unknown[]>,
    limit: number = ANALYTICAL_MAX_GROUP_COLUMNS + 1,
): SchemaColumn[] {
    const candidates = columns.filter(column => column.role === 'dimension' || column.role === 'unknown');
    if (sample.length < SUGGESTION_MIN_SAMPLE) {
        return candidates.slice(0, limit).map(column => ({ index: column.index, name: column.name, type: column.type }));
    }
    const scored = candidates.map(column => {
        // Same normalisation as the group key, so null and '' are counted as different values.
        const distinct = new Set(sample.map(row => normalizeKeyPart(row[column.index]))).size;
        return { column, distinct, ratio: distinct / sample.length };
    });
    return scored
        .filter(item => item.distinct >= SUGGESTION_MIN_DISTINCT
            && item.distinct <= SUGGESTION_MAX_DISTINCT
            && item.ratio < SUGGESTION_MAX_DISTINCT_RATIO)
        .sort((a, b) => a.distinct - b.distinct || a.column.index - b.column.index)
        .slice(0, limit)
        .map(item => ({ index: item.column.index, name: item.column.name, type: item.column.type }));
}

export function addGroupColumn(state: AnalyticalPersistedState, column: SchemaColumn): AnalyticalPersistedState {
    if (state.groupColumns.some(ref => ref.index === column.index)) {
        return state;
    }
    if (state.groupColumns.length >= ANALYTICAL_MAX_GROUP_COLUMNS) {
        return state;
    }
    return {
        ...state,
        groupColumns: [...state.groupColumns, { index: column.index, name: column.name }],
        selectedGroupKey: undefined,
        detection: { ...state.detection, referenceGroupKey: undefined },
    };
}

export function removeGroupColumn(state: AnalyticalPersistedState, index: number): AnalyticalPersistedState {
    return {
        ...state,
        groupColumns: state.groupColumns.filter(ref => ref.index !== index),
        selectedGroupKey: undefined,
        detection: { ...state.detection, referenceGroupKey: undefined },
    };
}

/**
 * Keeps the selected group only when it still exists after a recompute. Otherwise the selection
 * falls back to the first group in the current sort order so the detail pane is never empty.
 */
export function reconcileSelection(selectedGroupKey: string | undefined, groups: readonly AnalyticalGroup[]): string | undefined {
    if (groups.length === 0) {
        return undefined;
    }
    if (selectedGroupKey && groups.some(group => group.key === selectedGroupKey)) {
        return selectedGroupKey;
    }
    return groups[0].key;
}

function compareByKey(a: AnalyticalGroup, b: AnalyticalGroup, key: AnalyticalSortKey): number {
    if (key === 'score') {
        return a.score - b.score;
    }
    if (key === 'name') {
        return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
    }
    return a.rowCount - b.rowCount;
}

/** Sorts groups for the master list. Ties break on size (desc) and then key (asc), so order is stable. */
export function sortGroups(
    groups: readonly AnalyticalGroup[],
    sort: AnalyticalPersistedState['sort'],
): AnalyticalGroup[] {
    const direction = sort.desc ? -1 : 1;
    return [...groups].sort((a, b) => {
        const primary = compareByKey(a, b, sort.key) * direction;
        if (primary !== 0) return primary;
        if (b.rowCount !== a.rowCount) return b.rowCount - a.rowCount;
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
}
