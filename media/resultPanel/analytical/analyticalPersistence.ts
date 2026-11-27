// Persisted Analytical view state, validated against the current schema.
// Stores stay in the webview host state under `_analyticalStates`, keyed by the
// stable result identity. Pure module: no DOM.

import { DETECTION_CHOICES } from './detectionConfig.js';
import {
    ANALYTICAL_DEFAULT_MIN_GROUP_ROWS,
    ANOMALY_RULE_IDS,
    createDefaultAnalyticalState,
    type AnalyticalGroupColumnRef,
    type AnalyticalPersistedState,
    type AnalyticalSensitivity,
    type AnalyticalSortKey,
    type AnomalyRuleId,
    type DetectionChoice,
} from './types.js';

const SORT_KEYS: readonly AnalyticalSortKey[] = ['size', 'score', 'name'];
const SENSITIVITIES: readonly AnalyticalSensitivity[] = ['low', 'normal', 'high'];
const MAX_PERSISTED_STATES = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDetectionChoice(value: unknown): value is DetectionChoice {
    return typeof value === 'string' && (DETECTION_CHOICES as readonly string[]).includes(value);
}

function isAnomalyRuleId(value: unknown): value is AnomalyRuleId {
    return typeof value === 'string' && (ANOMALY_RULE_IDS as readonly string[]).includes(value);
}

function sanitizeRef(value: unknown, columns: readonly { readonly name: string }[]): AnalyticalGroupColumnRef | undefined {
    if (!isRecord(value)) return undefined;
    const name = typeof value.name === 'string' ? value.name : '';
    const index = typeof value.index === 'number' ? Math.trunc(value.index) : -1;
    if (index >= 0 && index < columns.length && columns[index]?.name === name) return { index, name };
    const byName = columns.findIndex(column => column.name === name);
    return byName >= 0 ? { index: byName, name } : undefined;
}

/** Schema identity: a changed column name/type drops stale saved options. */
export function analyticalSchemaKey(columns: readonly { readonly name: string; readonly type?: string }[]): string {
    return JSON.stringify(columns.map(column => [column.name, column.type]));
}

export function sanitizeAnalyticalState(
    value: unknown,
    columns: readonly { readonly name: string }[],
    schemaKey: string,
): AnalyticalPersistedState {
    const fallback = { ...createDefaultAnalyticalState(), schemaKey };
    if (!isRecord(value) || value.version !== 2) return fallback;
    if (typeof value.schemaKey === 'string' && value.schemaKey !== schemaKey) return fallback;

    const groupColumns: AnalyticalGroupColumnRef[] = [];
    const seenGroups = new Set<number>();
    if (Array.isArray(value.groupColumns)) {
        for (const candidate of value.groupColumns.slice(0, 3)) {
            const ref = sanitizeRef(candidate, columns);
            if (ref && !seenGroups.has(ref.index)) {
                seenGroups.add(ref.index);
                groupColumns.push(ref);
            }
        }
    }

    const excludedColumns: AnalyticalGroupColumnRef[] = [];
    const seenExcluded = new Set<number>();
    if (Array.isArray(value.excludedColumns)) {
        for (const candidate of value.excludedColumns) {
            const ref = sanitizeRef(candidate, columns);
            if (ref && !seenExcluded.has(ref.index) && !seenGroups.has(ref.index)) {
                seenExcluded.add(ref.index);
                excludedColumns.push(ref);
            }
        }
    }

    const disabledRules = Array.isArray(value.disabledRules)
        ? [...new Set(value.disabledRules.filter(isAnomalyRuleId))]
        : [];
    const sort = isRecord(value.sort) ? value.sort : {};
    const detection = isRecord(value.detection) ? value.detection : {};
    const minGroupRows = typeof value.minGroupRows === 'number' && Number.isFinite(value.minGroupRows)
        ? Math.max(1, Math.min(100_000, Math.trunc(value.minGroupRows)))
        : ANALYTICAL_DEFAULT_MIN_GROUP_ROWS;

    return {
        version: 2,
        schemaKey,
        groupColumns,
        ...(typeof value.selectedGroupKey === 'string' ? { selectedGroupKey: value.selectedGroupKey } : {}),
        sort: {
            key: typeof sort.key === 'string' && SORT_KEYS.includes(sort.key as AnalyticalSortKey) ? sort.key as AnalyticalSortKey : 'size',
            desc: typeof sort.desc === 'boolean' ? sort.desc : true,
        },
        sensitivity: typeof value.sensitivity === 'string' && SENSITIVITIES.includes(value.sensitivity as AnalyticalSensitivity)
            ? value.sensitivity as AnalyticalSensitivity
            : 'normal',
        minGroupRows,
        anomaliesOnly: value.anomaliesOnly === true,
        detection: {
            mode: isDetectionChoice(detection.mode) ? detection.mode : 'default',
            ...(typeof detection.referenceGroupKey === 'string' ? { referenceGroupKey: detection.referenceGroupKey } : {}),
        },
        disabledRules,
        excludedColumns,
    };
}

/** Loads one result's state; missing/mismatched entries fall back to defaults. */
export function loadAnalyticalState(
    states: unknown,
    stateKey: string | undefined,
    columns: readonly { readonly name: string }[],
    schemaKey: string,
): AnalyticalPersistedState {
    if (!stateKey || !isRecord(states)) return { ...createDefaultAnalyticalState(), schemaKey };
    return sanitizeAnalyticalState(states[stateKey], columns, schemaKey);
}

/** Saves one result's state and keeps the store bounded without dropping the active entry. */
export function saveAnalyticalState(
    states: unknown,
    stateKey: string,
    state: AnalyticalPersistedState,
    maxStates = MAX_PERSISTED_STATES,
): Record<string, AnalyticalPersistedState> {
    const next: Record<string, AnalyticalPersistedState> = {};
    if (isRecord(states)) {
        for (const [key, value] of Object.entries(states)) {
            if (key !== stateKey && isRecord(value)) next[key] = value as unknown as AnalyticalPersistedState;
        }
    }
    next[stateKey] = { ...state, version: 2 };
    for (const key of Object.keys(next)) {
        if (Object.keys(next).length <= maxStates) break;
        if (key !== stateKey) delete next[key];
    }
    return next;
}
