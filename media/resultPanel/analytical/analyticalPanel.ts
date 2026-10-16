// Analytical view orchestrator: group picker, master list of groups and detail pane with per-column
// statistics compared with the whole loaded result. Computation is cached per result revision and
// grouping, cancelled when superseded, and state persists per result in host state (_analyticalStates).

import { getElementById } from '../dom.js';
import { fetchRowsFromHost } from '../diskBackedGrid.js';
import { classifyColumns } from '../explore/columnClassification.js';
import { getActiveSourceUri, getResultSetAt, type ResultSet } from '../types.js';
import { applyAnomalies } from './anomalyRules.js';
import {
    addGroupColumn,
    buildSchemaKey,
    reconcileSelection,
    removeGroupColumn,
    sanitizeState,
    sortGroups,
    suggestGroupColumns,
    type SchemaColumn,
} from './analyticalState.js';
import { computeGroupStats, GroupStatsRowLimitError } from './computeGroupStats.js';
import { describeCoverageSkips } from './coverage.js';
import { analyzedColumnsFor, buildDiskGroupDataset, type AnalysisColumn } from './diskAdapter.js';
import { collectDiskGroupStats } from './diskLoader.js';
import { renderDetailPane } from './detailPane.js';
import { el } from './elements.js';
import { renderGroupPicker } from './groupPicker.js';
import { renderMasterPane } from './masterPane.js';
import { DETECTION_MODE_NAME, resolveDetection, type ResolvedDetection } from './detectionConfig.js';
import { renderOptionsPanel } from './optionsPanel.js';
import { loadAnalyticalStateRaw, saveAnalyticalState } from './persistence.js';
import {
    ANALYTICAL_MAX_ANALYZED_COLUMNS,
    ANALYTICAL_QUANTILE_MAX_DISK_ROWS,
    type AnalyticalDataset,
    type AnalyticalGroupColumnRef,
    type AnalyticalPersistedState,
    type AnalyticalSensitivity,
    type AnalyticalSortKey,
} from './types.js';

/** Streaming results recompute at most once per this window, so growth does not thrash the engine. */
const PARTIAL_DEBOUNCE_MS = 750;
const SUGGESTION_SAMPLE_ROWS = 500;
/** Rows used to classify column roles and to offer suggestions for disk-backed results (no analysis on this sample). */
const ROLE_SAMPLE_ROWS = 200;
const MAX_VIEW_STATES = 50;

const SORT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
    { value: 'size:desc', label: 'Largest first' },
    { value: 'score:desc', label: 'Highest score first' },
    { value: 'name:asc', label: 'Name A–Z' },
];
const SENSITIVITY_OPTIONS: ReadonlyArray<{ value: AnalyticalSensitivity; label: string }> = [
    { value: 'low', label: 'Fewer alerts' },
    { value: 'normal', label: 'Normal' },
    { value: 'high', label: 'More alerts' },
];

interface ComputeToken {
    cancelled: boolean;
}

interface AnalyticalViewState {
    persisted: AnalyticalPersistedState;
    revision?: string;
    /** Group column indexes the cached dataset was computed for. */
    rawKey?: string;
    raw?: AnalyticalDataset;
    status: 'idle' | 'loading' | 'ready' | 'error' | 'too-large';
    message?: string;
    token?: ComputeToken;
    inflightKey?: string;
    debounce?: ReturnType<typeof setTimeout>;
    /** Set by Cancel: no automatic recompute for this grouping until the user asks again. */
    autoStartSuppressed?: string;
    totalRows: number;
    partial: boolean;
    /** Leading rows of a disk-backed result, used only for role classification and suggestions. */
    sample?: unknown[][];
    samplePromise?: Promise<unknown[][]>;
}

const viewStates = new Map<string, AnalyticalViewState>();
/** Which views have the options panel open; UI state only, not persisted. */
const optionsOpen = new Set<string>();
let activeViewKey: string | null = null;
let pendingFocusKey: string | undefined;

/**
 * Identity of a computation: the grouping, plus quartiles when robust mode needs them. Other modes and
 * options re-score the cached dataset and never start a new computation.
 */
function groupKeyOf(state: AnalyticalPersistedState): string {
    const grouping = JSON.stringify(state.groupColumns.map(ref => ref.index));
    return state.detection.mode === 'robust' ? `${grouping}|quartiles` : grouping;
}

/** The cached dataset when it belongs to the current grouping, otherwise undefined. */
function currentRaw(view: AnalyticalViewState): AnalyticalDataset | undefined {
    return view.rawKey === groupKeyOf(view.persisted) ? view.raw : undefined;
}

/** What the rules will run with for the cached dataset (fallbacks included). */
function detectionFor(state: AnalyticalPersistedState, raw: AnalyticalDataset | undefined): ResolvedDetection {
    const listed = raw?.groups ?? [];
    const referenceKey = state.detection.referenceGroupKey;
    return resolveDetection(state.detection.mode, {
        listedGroups: listed.length,
        qualifyingGroups: listed.filter(group => group.rowCount >= state.minGroupRows).length,
        quantilesAvailable: raw?.coverage?.quantiles === true,
        referenceKey: referenceKey !== undefined && listed.some(group => group.key === referenceKey) ? referenceKey : undefined,
    });
}

function rowCountOf(owner: ResultSet): number {
    if (owner.storageMode === 'sqlite') {
        return owner.totalRowCount ?? 0;
    }
    return Array.isArray(owner.data) ? owner.data.length : 0;
}

function revisionOf(owner: ResultSet): string {
    return [
        owner.executionTimestamp,
        owner.sql,
        owner.storageSessionId,
        owner.storageMode,
        rowCountOf(owner),
        owner.isStreamingComplete === false ? 'partial' : 'final',
    ].join('\u001f');
}

function yieldToUi(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function cancelInflight(view: AnalyticalViewState): void {
    if (view.token) {
        view.token.cancelled = true;
    }
    view.token = undefined;
    view.inflightKey = undefined;
}

function clearDebounce(view: AnalyticalViewState): void {
    if (view.debounce !== undefined) {
        clearTimeout(view.debounce);
        view.debounce = undefined;
    }
}

function releaseView(view: AnalyticalViewState): void {
    cancelInflight(view);
    clearDebounce(view);
    view.raw = undefined;
    view.rawKey = undefined;
}

function trimViewStates(keep: string): void {
    while (viewStates.size > MAX_VIEW_STATES) {
        const oldest = viewStates.keys().next().value;
        if (!oldest || oldest === keep) break;
        const view = viewStates.get(oldest);
        if (view) releaseView(view);
        viewStates.delete(oldest);
    }
}

function memoryRows(owner: ResultSet): unknown[][] {
    return Array.isArray(owner.data) ? (owner.data as unknown[][]) : [];
}

/** Leading rows for role classification of a disk-backed result; fetched once per revision and cached. */
function roleSampleFor(view: AnalyticalViewState, rsIndex: number): Promise<unknown[][]> {
    if (view.sample) {
        return Promise.resolve(view.sample);
    }
    if (!view.samplePromise) {
        const sourceUri = getActiveSourceUri();
        const revision = view.revision;
        view.samplePromise = (sourceUri
            ? fetchRowsFromHost(sourceUri, rsIndex, 0, ROLE_SAMPLE_ROWS, true)
            : Promise.resolve([] as unknown[][]))
            .then(
                rows => {
                    if (view.revision === revision) view.sample = rows;
                    return rows;
                },
                () => {
                    if (view.revision === revision) view.sample = [];
                    return [] as unknown[][];
                },
            )
            .finally(() => {
                view.samplePromise = undefined;
            });
    }
    return view.samplePromise;
}

async function computeMemoryDataset(
    owner: ResultSet,
    groupColumns: AnalyticalGroupColumnRef[],
    token: ComputeToken,
    quantiles: boolean,
): Promise<AnalyticalDataset | null> {
    const rows = memoryRows(owner);
    const roles = classifyColumns(owner.columns, rows);
    const columns = owner.columns.map((column, index) => ({ index, name: column.name, role: roles[index] }));
    return computeGroupStats({ columns, rows, groupColumns, quantiles }, { isCancelled: () => token.cancelled, yieldToUi });
}

/** Exact disk-backed analysis over every spilled row, in column batches. No sampling. */
async function computeDiskDataset(
    view: AnalyticalViewState,
    owner: ResultSet,
    rsIndex: number,
    groupColumns: AnalyticalGroupColumnRef[],
    token: ComputeToken,
    quantilesWanted: boolean,
): Promise<AnalyticalDataset | null> {
    const sample = await roleSampleFor(view, rsIndex);
    if (token.cancelled) return null;
    const roles = classifyColumns(owner.columns, sample);
    const columns: AnalysisColumn[] = owner.columns.map((column, index) => ({ index, name: column.name, role: roles[index] }));
    const { analyzed } = analyzedColumnsFor(columns, groupColumns);
    // Quartiles add window passes over every row, so they are skipped on very large results (robust falls back).
    const quantiles = quantilesWanted && (owner.totalRowCount ?? 0) <= ANALYTICAL_QUANTILE_MAX_DISK_ROWS;
    const batches = await collectDiskGroupStats({
        rsIndex,
        groupColumns: groupColumns.map(ref => ref.index),
        statColumns: analyzed,
        isCancelled: () => token.cancelled,
        quantiles,
    });
    if (!batches || token.cancelled) return null;
    return buildDiskGroupDataset({ columns, groupColumns, batches, quantiles });
}

function scheduleCompute(view: AnalyticalViewState, viewKey: string, rsIndex: number): void {
    clearDebounce(view);
    view.debounce = setTimeout(() => {
        view.debounce = undefined;
        if (activeViewKey !== viewKey) return;
        const current = getResultSetAt(rsIndex);
        if (current) startCompute(view, viewKey, rsIndex, current);
    }, PARTIAL_DEBOUNCE_MS);
}

function startCompute(view: AnalyticalViewState, viewKey: string, rsIndex: number, owner: ResultSet): void {
    cancelInflight(view);
    const token: ComputeToken = { cancelled: false };
    const groupColumns = [...view.persisted.groupColumns];
    const wantedKey = groupKeyOf(view.persisted);
    view.token = token;
    view.inflightKey = wantedKey;
    view.status = 'loading';
    view.message = undefined;

    void (async () => {
        try {
            const quantilesWanted = view.persisted.detection.mode === 'robust';
            const dataset = owner.storageMode === 'sqlite'
                ? await computeDiskDataset(view, owner, rsIndex, groupColumns, token, quantilesWanted)
                : await computeMemoryDataset(owner, groupColumns, token, quantilesWanted);
            if (!dataset || token.cancelled) return;
            view.raw = dataset;
            view.rawKey = wantedKey;
            view.totalRows = dataset.totalRows;
            view.status = 'ready';
        } catch (error) {
            if (token.cancelled) return;
            view.raw = undefined;
            view.rawKey = undefined;
            view.status = error instanceof GroupStatsRowLimitError ? 'too-large' : 'error';
            view.message = error instanceof Error ? error.message : String(error);
            // Failures wait for an explicit Retry; otherwise the re-render would start the same work again.
            view.autoStartSuppressed = wantedKey;
        } finally {
            if (view.token === token) {
                view.token = undefined;
                view.inflightKey = undefined;
            }
        }
        if (!token.cancelled && activeViewKey === viewKey) {
            renderAnalyticalView(rsIndex);
        }
    })();
}

function sampleForSuggestions(owner: ResultSet, view: AnalyticalViewState): unknown[][] {
    if (owner.storageMode === 'sqlite') {
        return (view.sample ?? []).slice(0, SUGGESTION_SAMPLE_ROWS);
    }
    return memoryRows(owner).slice(0, SUGGESTION_SAMPLE_ROWS);
}

function buildNotices(view: AnalyticalViewState, owner: ResultSet): HTMLElement[] {
    const notices: string[] = [];
    if (view.partial) {
        notices.push('Results are still loading; statistics update as rows arrive.');
    }
    const raw = view.raw;
    if (raw?.groupsTruncated) {
        notices.push(`Showing the ${raw.groups.length} largest of ${raw.totalGroups} groups; ${raw.unlistedRows.toLocaleString('en-US')} rows in smaller groups are not listed.`);
    }
    if (raw?.analyzedColumnsTruncated) {
        notices.push(`Only the first ${ANALYTICAL_MAX_ANALYZED_COLUMNS} columns are analysed.`);
    }
    if (raw?.coverage?.skipped?.length) {
        const nameByIndex = new Map<number, string>();
        for (const stats of raw.population) {
            nameByIndex.set(stats.columnIndex, stats.name);
        }
        const nameOf = (columnIndex: number) =>
            nameByIndex.get(columnIndex) ?? owner.columns[columnIndex]?.name ?? `column ${columnIndex}`;
        notices.push(...describeCoverageSkips(raw, nameOf));
    }
    return notices.map(text => el('div', 'analytical-notice', text));
}

function buildStatusRow(view: AnalyticalViewState, rsIndex: number, viewKey: string, owner: ResultSet): HTMLElement {
    const state = view.persisted;
    const wantedKey = groupKeyOf(state);
    const pending = view.status === 'loading' || view.debounce !== undefined;
    const status = el('div', 'analytical-status');
    status.setAttribute('role', 'status');

    if (pending) {
        status.append(el('span', '', view.partial ? 'Waiting for rows to settle…' : 'Computing group statistics…'));
        const cancel = el('button', 'analytical-button', 'Cancel');
        cancel.type = 'button';
        cancel.addEventListener('click', () => {
            cancelInflight(view);
            clearDebounce(view);
            view.status = 'idle';
            view.autoStartSuppressed = wantedKey;
            renderAnalyticalView(rsIndex);
        });
        status.append(cancel);
        return status;
    }
    if (view.status === 'error' || view.status === 'too-large') {
        status.classList.add('is-error');
        status.setAttribute('role', 'alert');
        status.append(el('span', '', view.message ?? 'Analysis failed.'));
        const retry = el('button', 'analytical-button', 'Retry');
        retry.type = 'button';
        retry.disabled = view.status === 'too-large';
        retry.addEventListener('click', () => {
            view.autoStartSuppressed = undefined;
            startCompute(view, viewKey, rsIndex, owner);
        });
        status.append(retry);
        return status;
    }
    // Not running and no result for this grouping: the user cancelled, or nothing was requested yet.
    status.append(el('span', '', 'Analysis not started for this grouping.'));
    const compute = el('button', 'analytical-button', 'Compute');
    compute.type = 'button';
    compute.addEventListener('click', () => {
        view.autoStartSuppressed = undefined;
        startCompute(view, viewKey, rsIndex, owner);
    });
    status.append(compute);
    return status;
}

function buildBody(view: AnalyticalViewState, rsIndex: number, viewKey: string, owner: ResultSet): HTMLElement {
    const body = el('div', 'analytical-body');
    const state = view.persisted;
    const raw = currentRaw(view);

    if (state.groupColumns.length === 0) {
        body.append(el('div', 'analytical-empty', 'Choose one to three columns to group the rows. Each group is then compared with the whole result.'));
        return body;
    }
    if (!raw) {
        body.append(buildStatusRow(view, rsIndex, viewKey, owner));
        return body;
    }

    const resolved = detectionFor(state, raw);
    const dataset = applyAnomalies(raw, {
        sensitivity: state.sensitivity,
        minGroupRows: state.minGroupRows,
        mode: resolved.effective,
        referenceGroupKey: state.detection.referenceGroupKey,
        disabledRules: state.disabledRules,
        excludedColumns: state.excludedColumns.map(ref => ref.index),
    });
    const displayed = sortGroups(
        dataset.groups.filter(group => !state.anomaliesOnly || group.anomalous),
        state.sort,
    );
    const selectedKey = reconcileSelection(state.selectedGroupKey, displayed);
    if (selectedKey !== state.selectedGroupKey) {
        state.selectedGroupKey = selectedKey;
        saveAnalyticalState(viewKey, state);
    }
    const selectedGroup = dataset.groups.find(group => group.key === selectedKey);

    const suffix = resolved.viaAuto ? ' · auto' : state.detection.mode === 'default' ? ' (default)' : '';
    const modeLine = el('div', 'analytical-mode', `Mode: ${DETECTION_MODE_NAME[resolved.effective]}${suffix}`);
    body.append(modeLine);
    if (resolved.notice) {
        body.append(el('div', 'analytical-notice', resolved.notice));
    }

    const toolbar = el('div', 'analytical-toolbar');
    const sort = el('select', 'analytical-select');
    sort.setAttribute('aria-label', 'Sort groups');
    const sortValue = `${state.sort.key}:${state.sort.desc ? 'desc' : 'asc'}`;
    for (const option of SORT_OPTIONS) {
        sort.append(new Option(option.label, option.value, false, option.value === sortValue));
    }
    sort.addEventListener('change', () => {
        const [key, direction] = sort.value.split(':');
        state.sort = { key: key as AnalyticalSortKey, desc: direction === 'desc' };
        saveAnalyticalState(viewKey, state);
        renderAnalyticalView(rsIndex);
    });

    const sensitivity = el('select', 'analytical-select');
    sensitivity.setAttribute('aria-label', 'Alert sensitivity');
    for (const option of SENSITIVITY_OPTIONS) {
        sensitivity.append(new Option(option.label, option.value, false, option.value === state.sensitivity));
    }
    sensitivity.addEventListener('change', () => {
        state.sensitivity = sensitivity.value as AnalyticalSensitivity;
        saveAnalyticalState(viewKey, state);
        renderAnalyticalView(rsIndex);
    });

    const anomalies = el('label', 'analytical-toggle');
    const anomaliesInput = el('input');
    anomaliesInput.type = 'checkbox';
    anomaliesInput.checked = state.anomaliesOnly;
    anomaliesInput.addEventListener('change', () => {
        state.anomaliesOnly = anomaliesInput.checked;
        saveAnalyticalState(viewKey, state);
        renderAnalyticalView(rsIndex);
    });
    anomalies.append(anomaliesInput, el('span', '', 'Anomalies only'));
    toolbar.append(sort, sensitivity, anomalies);
    body.append(toolbar);

    const layout = el('div', 'analytical-layout');
    layout.append(
        renderMasterPane({
            groups: displayed,
            selectedKey,
            onSelect: (key) => {
                state.selectedGroupKey = key;
                saveAnalyticalState(viewKey, state);
                pendingFocusKey = key;
                renderAnalyticalView(rsIndex);
            },
        }),
        renderDetailPane({ group: selectedGroup, population: dataset.population }),
    );
    body.append(layout);
    return body;
}

function paint(view: AnalyticalViewState, owner: ResultSet, rsIndex: number, viewKey: string, container: HTMLElement): void {
    const state = view.persisted;
    const schema: SchemaColumn[] = owner.columns.map((column, index) => ({ index, name: column.name, type: column.type }));
    const sample = sampleForSuggestions(owner, view);
    const roles = classifyColumns(owner.columns, sample);
    const suggestions = suggestGroupColumns(
        schema.map((column, index) => ({ ...column, role: roles[index] })),
        sample,
    );
    const totalRows = view.raw ? view.totalRows : rowCountOf(owner);
    const names = state.groupColumns.map(ref => ref.name).join(', ');

    const root = el('div', 'analytical-view');
    const header = el('div', 'analytical-header');
    header.append(el('div', 'analytical-title', 'Analytical'));
    header.append(el('div', 'analytical-subtitle', state.groupColumns.length > 0
        ? `${totalRows.toLocaleString('en-US')} rows · grouped by ${names} · grid filters not applied`
        : 'Grouped analysis of result rows'));
    root.append(header);

    root.append(renderGroupPicker({
        columns: schema,
        chosen: state.groupColumns,
        suggestions,
        onAdd: (column) => {
            view.autoStartSuppressed = undefined;
            view.persisted = addGroupColumn(state, column);
            saveAnalyticalState(viewKey, view.persisted);
            renderAnalyticalView(rsIndex);
        },
        onRemove: (index) => {
            view.autoStartSuppressed = undefined;
            view.persisted = removeGroupColumn(state, index);
            saveAnalyticalState(viewKey, view.persisted);
            renderAnalyticalView(rsIndex);
        },
    }));
    const panelRaw = currentRaw(view);
    const resolvedForPanel = detectionFor(state, panelRaw);
    const groupedIndexes = new Set(state.groupColumns.map(ref => ref.index));
    root.append(renderOptionsPanel({
        open: optionsOpen.has(viewKey),
        state,
        effectiveMode: resolvedForPanel.effective,
        groups: (panelRaw?.groups ?? []).map(group => ({ key: group.key, label: group.label })),
        columns: schema
            .filter(column => !groupedIndexes.has(column.index))
            .map(column => ({ index: column.index, name: column.name })),
        panelId: 'analytical-options',
        onToggle: () => {
            if (optionsOpen.has(viewKey)) optionsOpen.delete(viewKey);
            else optionsOpen.add(viewKey);
            renderAnalyticalView(rsIndex);
        },
        onUpdate: update => {
            view.persisted = update(view.persisted);
            saveAnalyticalState(viewKey, view.persisted);
            renderAnalyticalView(rsIndex);
        },
    }));
    for (const notice of buildNotices(view, owner)) {
        root.append(notice);
    }
    root.append(buildBody(view, rsIndex, viewKey, owner));

    container.replaceChildren(root);

    if (pendingFocusKey) {
        const focusKey = pendingFocusKey;
        pendingFocusKey = undefined;
        const target = Array.from(root.querySelectorAll<HTMLElement>('.analytical-group'))
            .find(node => node.dataset.key === focusKey);
        target?.focus();
    }
}

/**
 * Entry point, also used as the re-render path after every state change. Idempotent: the same
 * result, revision and grouping reuse the cached dataset without starting new work.
 */
export function renderAnalyticalView(rsIndex: number): void {
    const container = getElementById('analysisContainer');
    if (!container) {
        return;
    }
    const owner = getResultSetAt(rsIndex);
    if (!owner || owner.isLog || owner.isError) {
        container.replaceChildren(el('div', 'analytical-empty', 'Analytical view needs a tabular result.'));
        return;
    }

    const sourceUri = getActiveSourceUri() || '';
    const viewKey = `${sourceUri}\u001f${owner.resultSetId ?? `ts:${owner.executionTimestamp ?? 0}:${rsIndex}`}`;
    const schema: SchemaColumn[] = owner.columns.map((column, index) => ({ index, name: column.name, type: column.type }));
    const schemaKey = buildSchemaKey(schema);

    if (activeViewKey && activeViewKey !== viewKey) {
        const previous = viewStates.get(activeViewKey);
        if (previous) releaseView(previous);
    }
    activeViewKey = viewKey;

    let view = viewStates.get(viewKey);
    if (!view) {
        view = {
            persisted: sanitizeState(loadAnalyticalStateRaw(viewKey), schemaKey, schema),
            status: 'idle',
            totalRows: 0,
            partial: false,
        };
        viewStates.set(viewKey, view);
        trimViewStates(viewKey);
    }
    view.persisted = sanitizeState(view.persisted, schemaKey, schema);

    const revision = revisionOf(owner);
    if (view.revision !== revision) {
        cancelInflight(view);
        clearDebounce(view);
        view.revision = revision;
        view.raw = undefined;
        view.rawKey = undefined;
        view.autoStartSuppressed = undefined;
        view.sample = undefined;
    }
    view.partial = owner.isStreamingComplete === false;

    if (owner.storageMode === 'sqlite' && view.sample === undefined && !view.samplePromise) {
        void roleSampleFor(view, rsIndex).then(() => {
            if (activeViewKey === viewKey) renderAnalyticalView(rsIndex);
        });
    }

    const wantedKey = groupKeyOf(view.persisted);
    if (view.persisted.groupColumns.length === 0) {
        cancelInflight(view);
        clearDebounce(view);
        view.status = 'idle';
    } else if (view.rawKey !== wantedKey && view.inflightKey !== wantedKey && view.autoStartSuppressed !== wantedKey) {
        if (view.partial) {
            if (view.debounce === undefined) {
                scheduleCompute(view, viewKey, rsIndex);
            }
        } else {
            startCompute(view, viewKey, rsIndex, owner);
        }
    }

    paint(view, owner, rsIndex, viewKey, container);
}

/** Leaves the view: cancels in-flight work and timers, frees cached rows, keeps persisted state. */
export function disposeAnalyticalView(): void {
    if (activeViewKey) {
        const view = viewStates.get(activeViewKey);
        if (view) releaseView(view);
    }
    activeViewKey = null;
    pendingFocusKey = undefined;
}
