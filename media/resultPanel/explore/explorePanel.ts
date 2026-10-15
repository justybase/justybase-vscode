import { renderFullStatsCard, type FullStatsSnapshot } from './fullStatsCard.js';
// Explore view orchestrator: column cards, quality banner, filter bar with
// undo/redo, pivot tab and time composer tab. State persists per result set
// in the webview host state (_exploreStates).

import { getElementById, asHtml } from '../dom.js';
import { getActiveSourceUri, getResultSetAt } from '../types.js';
import { getHostState, setHostState } from '../protocol.js';
import { fetchRowsFromHost } from '../diskBackedGrid.js';
import { classifyColumnRole } from './columnClassification.js';
import { computeColumnOverviews } from './columnOverview.js';
import { filterExploreRows, columnsMetaForRows } from './filtering.js';
import { computeQualityAlerts, computeMeasureCorrelations } from './quality.js';
import { renderFilterEditor } from './filterEditor.js';
import { showSelectionActions, type ExploreSelection } from './selectionActions.js';
import { renderRankingTab, disposeRankingView, type RankingViewState } from './rankingTab.js';
import { select, field, applyDatabaseAvailability } from './ui.js';
import { ExploreFilterState } from './filterState.js';
import { renderFilterBar } from './filterBar.js';
import { renderPivotTab, type PivotTabState, type PivotTabCache } from './pivotTab.js';
import { renderComposerTab, disposeComposerChart, type ComposerTabCache } from './composerTab.js';
import { cancelExploreRequests } from './hostBridge.js';
import { wireExplorePreviewGlobal } from './previewModal.js';
import {
    EXPLORE_SAMPLE_ROWS,
    EXPLORE_TOP_VALUES,
    type ExploreColumnMeta,
    type ExploreColumnOverview,
    type ExploreFilterModel,
    type ExploreOverviewResult,
    type ExplorePersistedState,
} from './types.js';

const ROLE_LABELS: Record<string, string> = {
    dimension: 'DIM',
    measure: 'MEA',
    date: 'DATE',
    unknown: '?',
};

type ExploreTab = 'cards' | 'pivot' | 'composer';

interface ExploreData {
    key: string;
    columns: ReadonlyArray<{ name: string; type?: string }>;
    columnsMeta: ExploreColumnMeta[];
    sampleRows: unknown[][];
    overviews: ExploreColumnOverview[];
    totalRows: number;
    sampledRows: number;
    truncated: boolean;
    sampleMode: 'memory' | 'disk';
    databaseReason?: string;
}

interface ExploreViewState {
    data: ExploreData | null;
    filterState: ExploreFilterState | null;
    activeTab: ExploreTab;
    persisted: ExplorePersistedState;
    ranking: RankingViewState;
    composer: ComposerTabCache;
    pivot: PivotTabCache;
    fullStats: Map<number, FullStatsSnapshot>;
    dataRevision?: string;
    /** Filtered sample memo; one filter change filters the sample once. */
    filteredSample?: FilteredSample;
}

interface FilteredSample {
    readonly source: readonly unknown[][];
    readonly key: string;
    readonly rows: unknown[][];
    overviews?: ReturnType<typeof computeColumnOverviews>;
}

/**
 * The scope line, quality banner and cards all need the filtered sample (up
 * to EXPLORE_SAMPLE_ROWS rows); compute it and its overviews once per filter
 * state instead of once per consumer. Filters are mutated in place, so the
 * memo is keyed by their serialized content.
 */
function getFilteredSample(view: ExploreViewState, data: ExploreData, filters: ExploreFilterModel): FilteredSample {
    const key = JSON.stringify(filters);
    const cached = view.filteredSample;
    if (cached && cached.source === data.sampleRows && cached.key === key) return cached;
    view.filteredSample = { source: data.sampleRows, key, rows: filterExploreRows(data.sampleRows, filters) };
    return view.filteredSample;
}

function getFilteredOverviews(view: ExploreViewState, data: ExploreData, filters: ExploreFilterModel): ReturnType<typeof computeColumnOverviews> {
    const sample = getFilteredSample(view, data, filters);
    sample.overviews ??= computeColumnOverviews(data.columnsMeta, sample.rows, sample.rows.length);
    return sample.overviews;
}

const viewStates = new Map<string, ExploreViewState>();
let activeViewKey: string | null = null;
let renderGeneration = 0;

function escapeHtml(value: unknown): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatNumber(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) {
        return '';
    }
    return value.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    });
}

function formatDateLabel(value: string | undefined): string {
    return value ?? '—';
}

function histogramSvg(histogram: { min: number; max: number; count: number }[] | undefined, width: number, height: number): string {
    if (!histogram || histogram.length === 0) {
        return '';
    }
    const maxCount = Math.max(...histogram.map(bin => bin.count), 1);
    const barWidth = width / histogram.length;
    return histogram.map((bin, index) => {
        const barHeight = Math.max(1, (bin.count / maxCount) * height);
        const x = index * barWidth;
        const y = height - barHeight;
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0.5, barWidth - 1).toFixed(1)}" height="${barHeight.toFixed(1)}"></rect>`;
    }).join('');
}

function buildEmptyState(message: string): HTMLDivElement {
    const empty = document.createElement('div');
    empty.className = 'explore-empty';
    empty.textContent = message;
    return empty;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadSampleRows(rsIndex: number): Promise<{ rows: unknown[][]; sampleMode: 'memory' | 'disk' }> {
    const resultSet = getResultSetAt(rsIndex);
    if (!resultSet) {
        return { rows: [], sampleMode: 'memory' };
    }
    if (resultSet.storageMode === 'sqlite') {
        const sourceUri = getActiveSourceUri();
        if (!sourceUri) {
            return { rows: [], sampleMode: 'disk' };
        }
        const rows = await fetchRowsFromHost(sourceUri, rsIndex, 0, EXPLORE_SAMPLE_ROWS, true);
        return { rows, sampleMode: 'disk' };
    }
    const data = Array.isArray(resultSet.data) ? resultSet.data : [];
    return { rows: data.slice(0, EXPLORE_SAMPLE_ROWS), sampleMode: 'memory' };
}

export async function computeExploreOverview(rsIndex: number): Promise<ExploreOverviewResult> {
    const resultSet = getResultSetAt(rsIndex);
    if (!resultSet || resultSet.isLog || resultSet.isError) {
        throw new Error('No tabular result set to explore.');
    }
    const { rows, sampleMode } = await loadSampleRows(rsIndex);
    const columnsMeta = columnsMetaForRows(resultSet.columns, rows, classifyColumnRole);
    const overviews = computeColumnOverviews(columnsMeta, rows, rows.length);
    for (const column of columnsMeta) {
        const overview = overviews[column.index];
        column.exploreTopValues = overview?.topValues?.map(top => top.value);
    }
    const totalRows = resultSet.totalRowCount ?? (sampleMode === 'memory' ? (Array.isArray(resultSet.data) ? resultSet.data.length : 0) : rows.length);
    return {
        columns: columnsMeta,
        overviews,
        totalRows,
        sampledRows: rows.length,
        truncated: totalRows > rows.length,
        sampleMode,
    };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface HostExploreStateHolder {
    _exploreStates?: Record<string, ExplorePersistedState>;
}

function loadPersistedState(key: string): ExplorePersistedState {
    const hostState = getHostState() as HostExploreStateHolder | null;
    const saved = hostState?._exploreStates?.[key];
    if (saved?.version === 2) {
        return saved;
    }
    return {
        filters: { dimensions: [], dates: [], measures: [] },
        pivotConfig: undefined,
        pivotValues: undefined,
        composerConfig: undefined,
    };
}

function savePersistedState(key: string, state: ExplorePersistedState): void {
    const hostState = (getHostState() as HostExploreStateHolder | null) || {};
    if (!hostState._exploreStates) {
        hostState._exploreStates = {};
    }
    state.version = 2;
    hostState._exploreStates[key] = state;
    for (const oldKey of Object.keys(hostState._exploreStates)) {
        if (Object.keys(hostState._exploreStates).length <= 50) break;
        if (oldKey !== key) delete hostState._exploreStates[oldKey];
    }
    setHostState(hostState);
}

// ---------------------------------------------------------------------------
// Cards view
// ---------------------------------------------------------------------------

function buildCard(
    overview: ExploreColumnOverview,
    filters: ExploreFilterModel,
    onToggleDimension: (columnIndex: number, value: string) => void,
    onRequestFullStats: (columnIndex: number, card: HTMLElement) => void,
): HTMLDivElement {
    const card = document.createElement('div');
    card.className = `explore-column-card explore-role-${overview.role}`;
    card.dataset.columnIndex = String(overview.index);

    const header = document.createElement('div');
    header.className = 'explore-card-header';
    const nameEl = document.createElement('span');
    nameEl.className = 'explore-card-name';
    nameEl.textContent = overview.name;
    nameEl.title = `${overview.name}${overview.type ? ` · ${overview.type}` : ''}`;
    const roleBadge = document.createElement('span');
    roleBadge.className = `explore-role-badge explore-role-${overview.role}`;
    roleBadge.textContent = ROLE_LABELS[overview.role];
    const typeEl = document.createElement('span');
    typeEl.className = 'explore-card-type';
    typeEl.textContent = overview.type ?? '';
    header.appendChild(nameEl);
    header.appendChild(roleBadge);
    header.appendChild(typeEl);
    card.appendChild(header);

    const stats = document.createElement('div');
    stats.className = 'explore-card-stats';
    const nullRate = overview.examinedRows > 0 ? Math.round((overview.nullCount / overview.examinedRows) * 100) : 0;
    if (overview.role === 'measure') {
        stats.innerHTML = `
            <div class="explore-stat"><span class="explore-stat-value">${formatNumber(overview.min)}</span><span class="explore-stat-label">min</span></div>
            <div class="explore-stat"><span class="explore-stat-value">${formatNumber(overview.avg)}</span><span class="explore-stat-label">avg</span></div>
            <div class="explore-stat"><span class="explore-stat-value">${formatNumber(overview.max)}</span><span class="explore-stat-label">max</span></div>
            <div class="explore-stat"><span class="explore-stat-value">${overview.nullCount.toLocaleString()}</span><span class="explore-stat-label">nulls</span></div>
        `;
    } else if (overview.role === 'date') {
        stats.innerHTML = `
            <div class="explore-stat"><span class="explore-stat-value explore-stat-wide">${escapeHtml(formatDateLabel(overview.minDate))}</span><span class="explore-stat-label">min</span></div>
            <div class="explore-stat"><span class="explore-stat-value explore-stat-wide">${escapeHtml(formatDateLabel(overview.maxDate))}</span><span class="explore-stat-label">max</span></div>
            <div class="explore-stat"><span class="explore-stat-value">${overview.distinctCount.toLocaleString()}</span><span class="explore-stat-label">distinct</span></div>
        `;
    } else {
        stats.innerHTML = `
            <div class="explore-stat"><span class="explore-stat-value">${overview.distinctCount.toLocaleString()}${overview.distinctTruncated ? '+' : ''}</span><span class="explore-stat-label">distinct</span></div>
            <div class="explore-stat"><span class="explore-stat-value">${formatNumber(overview.topValues?.[0]?.count)}</span><span class="explore-stat-label">top count</span></div>
            <div class="explore-stat"><span class="explore-stat-value">${overview.nullCount.toLocaleString()}</span><span class="explore-stat-label">nulls</span></div>
        `;
    }
    card.appendChild(stats);

    if (nullRate > 0) {
        const nullBar = document.createElement('div');
        nullBar.className = 'explore-null-bar';
        const fill = document.createElement('div');
        fill.className = 'explore-null-bar-fill';
        fill.style.width = `${Math.min(100, nullRate)}%`;
        fill.title = `${nullRate}% null`;
        nullBar.appendChild(fill);
        card.appendChild(nullBar);
    }

    if (overview.role === 'measure') {
        if (overview.histogram && overview.histogram.length > 0) {
            const spark = document.createElement('div');
            spark.className = 'explore-histogram';
            spark.innerHTML = `<svg viewBox="0 0 170 42" preserveAspectRatio="none">${histogramSvg(overview.histogram, 170, 42)}</svg>`;
            card.appendChild(spark);
        }
        const actions = document.createElement('div');
        actions.className = 'explore-card-actions';
        actions.appendChild(buildCardButton('Σ Full stats', () => onRequestFullStats(overview.index, card)));
        actions.appendChild(buildCardButton('Filter…', () => {
            card.dispatchEvent(new CustomEvent('exploreEditFilter', { bubbles: true }));
        }));
        card.appendChild(actions);
    } else if (overview.role === 'date') {
        const actions = document.createElement('div');
        actions.className = 'explore-card-actions';
        actions.appendChild(buildCardButton('Filter…', () => card.dispatchEvent(new CustomEvent('exploreEditFilter', { bubbles: true }))));
        card.appendChild(actions);
    } else {
        const top = overview.topValues ?? [];
        if (top.length > 0) {
            const maxCount = Math.max(...top.map(item => item.count), 1);
            const topList = document.createElement('div');
            topList.className = 'explore-top-list';
            const dimensionFilter = filters.dimensions.find(item => item.columnIndex === overview.index);
            const activeValues = new Set(dimensionFilter?.values ?? []);
            top.slice(0, EXPLORE_TOP_VALUES).forEach(item => {
                const row = document.createElement('div');
                row.className = 'explore-top-row' + (activeValues.has(item.value) ? ' is-active' : '');
                row.title = 'Explore this value';
                row.tabIndex = 0;
                row.setAttribute('role', 'button');
                row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggleDimension(overview.index, item.value); } });
                row.innerHTML = `
                    <span class="explore-top-value">${escapeHtml(item.value)}</span>
                    <span class="explore-top-bar"><span style="width:${Math.max(2, (item.count / maxCount) * 100).toFixed(1)}%"></span></span>
                    <span class="explore-top-count">${item.count.toLocaleString()}</span>
                `;
                row.addEventListener('click', () => onToggleDimension(overview.index, item.value));
                topList.appendChild(row);
            });
            card.appendChild(topList);
        }
        card.appendChild(buildCardButton('Filter…', () => card.dispatchEvent(new CustomEvent('exploreEditFilter', { bubbles: true }))));
    }

    return card;
}

function buildCardButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'explore-card-action';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
}

function editFilter(view: ExploreViewState, columnIndex?: number): void {
    const root = getElementById('exploreFilterEditor');
    if (!root || !view.data || !view.filterState) return;
    renderFilterEditor(root, view.data.columnsMeta, view.data.sampleRows, view.filterState.filters,
        filters => view.filterState?.replace(filters), columnIndex, view.data.databaseReason);
}

function selectRows(view: ExploreViewState, selection: ExploreSelection): void {
    const root = getElementById('exploreSelection');
    if (root && view.data && view.filterState) showSelectionActions(root, selection, view.data.columns, view.data.sampleRows,
        filters => view.filterState?.replace(filters), view.data.databaseReason);
}

function selectCategory(view: ExploreViewState, columnIndex: number, value: string): void {
    if (!view.filterState) return;
    const filters = view.filterState.filters;
    filters.dimensions = filters.dimensions.filter(item => item.columnIndex !== columnIndex);
    filters.dimensions.push({ columnIndex, values: [value] });
    selectRows(view, { label: value, filters, scope: 'sample' });
}

function updateScope(view: ExploreViewState): void {
    const root = getElementById('exploreSubtitle');
    const data = view.data;
    if (!root || !data || !view.filterState) return;
    const matched = getFilteredSample(view, data, view.filterState.filters).rows.length;
    root.textContent = `${data.truncated ? 'Sample' : 'All loaded rows'} · First ${data.sampledRows.toLocaleString()} of ${data.totalRows.toLocaleString()} loaded rows · ${matched.toLocaleString()} matching rows in the sample · First rows; not a random sample`;
    const result = getResultSetAt(Number(document.getElementById('exploreTabContent')?.dataset.resultIndex ?? '-1'));
    if (data.databaseReason) root.textContent += ` · ${data.databaseReason}`;
    if (result?.limitReached) root.textContent += ' · Row limit reached';
    if (result?.isCancelled) root.textContent += ' · Partial result';
    if (result && result.isStreamingComplete === false) root.textContent += ' · Streaming';
}

function renderCardsView(view: ExploreViewState): void {
    const content = getElementById('exploreTabContent');
    if (!content) {
        return;
    }
    const { data, filterState } = view;
    if (!data || !filterState) {
        return;
    }

    const filters = filterState.filters;
    const filteredOverviews = getFilteredOverviews(view, data, filters);

    content.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'explore-cards-grid';

    if (filteredOverviews.length === 0) {
        grid.appendChild(buildEmptyState('No columns to explore.'));
        content.appendChild(grid);
        return;
    }

    for (const overview of filteredOverviews) {
        const card = buildCard(
            overview,
            filters,
            (columnIndex, value) => selectCategory(view, columnIndex, value),
            (columnIndex, cardElement) => {
                renderFullStatsCard(cardElement, columnIndex, filters, view.fullStats, true);
            },
        );
        card.addEventListener('exploreEditFilter', () => editFilter(view, overview.index));
        if (overview.histogram) {
            const bins = overview.histogram;
            const choose = (index: number) => {
                const bin = bins[index];
                if (!bin) return;
                const selected = filterState.filters;
                selected.measures = selected.measures.filter(item => item.columnIndex !== overview.index);
                selected.measures.push({ columnIndex: overview.index, min: bin.min, max: bin.max, maxExclusive: index < bins.length - 1 });
                selectRows(view, { label: `${overview.name}: ${bin.min} – ${bin.max}`, filters: selected, scope: 'sample' });
            };
            card.querySelectorAll('svg rect').forEach((rect, index) => rect.addEventListener('click', () => choose(index)));
            const details = document.createElement('details');
            const summary = document.createElement('summary'); summary.textContent = 'Distribution ranges'; details.append(summary);
            bins.forEach((bin, index) => details.append(buildCardButton(`${formatNumber(bin.min)} – ${formatNumber(bin.max)} (${bin.count})`, () => choose(index))));
            card.append(details);
        }
        if (view.fullStats.has(overview.index)) renderFullStatsCard(card, overview.index, filters, view.fullStats);
        applyDatabaseAvailability(card, data.databaseReason);
        grid.appendChild(card);
    }

    content.appendChild(grid);
}

function renderQualityBanner(view: ExploreViewState): void {
    const banner = getElementById('exploreQualityBanner');
    if (!banner || !view.data) {
        return;
    }
    banner.innerHTML = '';
    const filters = view.filterState?.filters ?? { dimensions: [], dates: [], measures: [] };
    const rows = getFilteredSample(view, view.data, filters).rows;
    const overviews = getFilteredOverviews(view, view.data, filters);
    const alerts = computeQualityAlerts(view.data.columnsMeta, overviews);
    const correlations = computeMeasureCorrelations(view.data.columnsMeta, rows);

    const alertCount = alerts.length;
    if (alertCount === 0 && correlations.length === 0) {
        banner.style.display = 'none';
        return;
    }
    banner.style.display = '';

    for (const alert of alerts) {
        const chip = document.createElement('span');
        chip.className = `explore-quality-chip ${alert.severity}`;
        chip.textContent = `${alert.columnName}: ${alert.message}`;
        chip.title = `Data quality alert for ${alert.columnName}`;
        banner.appendChild(chip);
    }
    for (const correlation of correlations) {
        const chip = document.createElement('span');
        chip.className = 'explore-quality-chip correlation';
        chip.textContent = `${correlation.firstName} ↔ ${correlation.secondName} r=${correlation.r}`;
        chip.title = 'Measure correlation (Pearson r)';
        banner.appendChild(chip);
    }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function renderActiveTab(view: ExploreViewState): void {
    const content = getElementById('exploreTabContent');
    if (!content) {
        return;
    }
    disposeComposerChart();
    disposeRankingView();
    const { data, filterState, activeTab, persisted } = view;
    if (!data || !filterState) {
        content.innerHTML = '';
        return;
    }

    content.innerHTML = '';
    if (activeTab === 'cards') {
        renderCardsView(view);
        return;
    }

    if (activeTab === 'pivot') {
        const state: PivotTabState | undefined = persisted.pivotConfig
            ? { config: persisted.pivotConfig, pivotValues: persisted.pivotValues ?? [] }
            : undefined;
        renderPivotTab(content, {
            columns: data.columnsMeta,
            filters: filterState.filters,
            state,
            cache: view.pivot,
            getFilters: () => filterState.filters,
            onStateChange: next => {
                view.persisted.pivotConfig = next.config;
                view.persisted.pivotValues = next.pivotValues;
                savePersistedState(data.key, view.persisted);
            },
        });
        applyDatabaseAvailability(content, data.databaseReason);
        return;
    }

    if (activeTab === 'composer') {
        const mode = select([['time', 'Time series'], ['ranking', 'Category ranking']], persisted.chartMode ?? (persisted.composerConfig ? 'time' : 'ranking'));
        const chartRoot = document.createElement('div');
        content.append(field('Chart type', mode), chartRoot);
        const draw = () => {
            cancelExploreRequests();
            disposeComposerChart(); disposeRankingView();
            persisted.chartMode = mode.value as 'time' | 'ranking';
            savePersistedState(data.key, persisted);
            if (mode.value === 'ranking') {
                renderRankingTab(chartRoot, data.columnsMeta, () => filterState.filters, persisted.rankingConfig, view.ranking,
                    config => { persisted.rankingConfig = config; savePersistedState(data.key, persisted); }, selection => selectRows(view, selection));
                applyDatabaseAvailability(chartRoot, data.databaseReason);
                return;
            }
        renderComposerTab(chartRoot, {
            columns: data.columnsMeta,
            filters: filterState.filters,
            config: persisted.composerConfig,
            cache: view.composer,
            getFilters: () => filterState.filters,
            onSelect: selection => selectRows(view, selection),
            onConfigChange: config => {
                view.persisted.composerConfig = config;
                savePersistedState(data.key, view.persisted);
            },
        });
        applyDatabaseAvailability(chartRoot, data.databaseReason);
        };
        mode.addEventListener('change', draw);
        draw();
    }
}

function renderFilterBarView(view: ExploreViewState): void {
    const root = getElementById('exploreFilterBar');
    if (!root || !view.data || !view.filterState) {
        return;
    }
    renderFilterBar(root, view.filterState.filters, view.data.columnsMeta, view.filterState, {
        onUndo: () => {
            view.filterState?.undo();
        },
        onRedo: () => {
            view.filterState?.redo();
        },
        onClear: () => {
            view.filterState?.clear();
        },
        onRemoveChip: (kind, columnIndex, value, missing) => {
            if (!view.filterState) return;
            if (kind === 'dimension') {
                const current = view.filterState.filters.dimensions.find(item => item.columnIndex === columnIndex);
                if (current) {
                    const next = view.filterState.filters;
                    next.dimensions = next.dimensions.map(item => item.columnIndex !== columnIndex ? item : {
                        ...item, values: missing ? item.values : item.values.filter(entry => entry !== value),
                        includeNull: missing === 'null' ? false : item.includeNull,
                        includeEmpty: missing === 'empty' ? false : item.includeEmpty,
                    }).filter(item => item.values.length || item.includeNull || item.includeEmpty);
                    view.filterState.replace(next);
                }
            } else if (kind === 'date') {
                view.filterState.setDateFilter(columnIndex, 'day', undefined, undefined);
            } else {
                view.filterState.setMeasureRange(columnIndex, undefined, undefined);
            }
        },
        onEditChip: (_kind, index) => editFilter(view, index),
        onAddFilter: () => editFilter(view),
    });
    applyDatabaseAvailability(root, view.data.databaseReason);
}

function setExploreTab(view: ExploreViewState, tab: ExploreTab): void {
    cancelExploreRequests();
    view.activeTab = tab;
    view.persisted.activeTab = tab;
    if (view.data) savePersistedState(view.data.key, view.persisted);
    document.querySelectorAll('.explore-tab-btn').forEach(button => {
        const btn = asHtml(button);
        if (!btn) return;
        const isActive = btn.dataset.tab === tab;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    renderActiveTab(view);
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

/** Release live resources without discarding per-result configuration. */
export function disposeExploreView(): void {
    renderGeneration++;
    if (activeViewKey) { const view = viewStates.get(activeViewKey); if (view) view.data = null; }
    activeViewKey = null;
    cancelExploreRequests();
    disposeComposerChart();
    disposeRankingView();
}

export function renderExploreView(rsIndex: number): void {
    const container = getElementById('analysisContainer');
    if (!container) {
        return;
    }
    wireExplorePreviewGlobal();
    cancelExploreRequests();
    const generation = ++renderGeneration;
    disposeComposerChart();
    disposeRankingView();

    const sourceUri = getActiveSourceUri() || '';
    if (activeViewKey) { const previous = viewStates.get(activeViewKey); if (previous) previous.data = null; }
    const owner = getResultSetAt(rsIndex);
    const schemaKey = JSON.stringify(owner?.columns.map(column => [column.name, column.type]));
    const key = `${sourceUri}\u001f${owner?.resultSetId ?? `ts:${owner?.executionTimestamp ?? 0}:${rsIndex}`}`;
    activeViewKey = key;

    let view = viewStates.get(key);
    if (!view) {
        view = {
            data: null,
            filterState: null,
            activeTab: loadPersistedState(key).activeTab ?? 'cards',
            persisted: loadPersistedState(key),
            ranking: {}, composer: {}, pivot: {}, fullStats: new Map(),
        };
        viewStates.set(key, view);
    }

    if (view.persisted.schemaKey && view.persisted.schemaKey !== schemaKey) { view.persisted = { filters: { dimensions: [], dates: [], measures: [] } }; view.ranking = {}; view.composer = {}; view.pivot = {}; view.fullStats = new Map(); }
    const revision = `${owner?.executionTimestamp}:${owner?.sql}:${owner?.storageSessionId}:${owner?.storageMode}`;
    if (view.dataRevision && view.dataRevision !== revision) { view.ranking = {}; view.composer = {}; view.pivot = {}; view.fullStats = new Map(); view.data = null; }
    view.dataRevision = revision;
    view.persisted.schemaKey = schemaKey;
    while (viewStates.size > 50) { const oldest = viewStates.keys().next().value; if (!oldest || oldest === key) break; viewStates.delete(oldest); }
    container.innerHTML = `
        <div class="analysis-view explore-view">
            <div class="analysis-header">
                <div class="analysis-title">Explore</div>
                <div class="analysis-subtitle" id="exploreSubtitle">Analyzing columns…</div>
            </div>
            <div id="exploreQualityBanner" class="explore-quality-banner" style="display:none"></div>
            <div id="exploreFilterBar" class="explore-filter-bar-container"></div>
            <div id="exploreFilterEditor"></div>
            <div id="exploreSelection"></div>
            <div class="explore-tabs" role="tablist">
                <button class="explore-tab-btn active" data-tab="cards" role="tab" aria-pressed="true">Columns</button>
                <button class="explore-tab-btn" data-tab="pivot" role="tab" aria-pressed="false">Pivot</button>
                <button class="explore-tab-btn" data-tab="composer" role="tab" aria-pressed="false">Charts</button>
            </div>
            <div id="exploreTabContent" data-result-index="${rsIndex}"></div>
        </div>
    `;

    document.querySelectorAll('.explore-tab-btn').forEach(button => {
        button.addEventListener('click', () => {
            const btn = asHtml(button);
            const tab = btn?.dataset.tab as ExploreTab | undefined;
            if (tab && view && view.data) {
                setExploreTab(view, tab);
            }
        });
    });

    const subtitle = getElementById('exploreSubtitle');
    const showLoadingError = (message: string) => {
        if (subtitle) {
            subtitle.textContent = '';
        }
        const content = getElementById('exploreTabContent');
        if (content) {
            content.innerHTML = '';
            content.appendChild(buildEmptyState(message));
        }
    };

    loadSampleRows(rsIndex)
        .then(async ({ rows, sampleMode }) => {
            if (!view || activeViewKey !== key || generation !== renderGeneration) {
                return;
            }
            const sourceColumns = getResultSetAt(rsIndex)?.columns ?? [];
            const columnsMeta = columnsMetaForRows(sourceColumns, rows, classifyColumnRole);
            const overviews = computeColumnOverviews(columnsMeta, rows, rows.length);
            for (const column of columnsMeta) {
                const overview = overviews[column.index];
                column.exploreTopValues = overview?.topValues?.map(top => top.value);
            }
            const resultSet = getResultSetAt(rsIndex);
            const totalRows = resultSet?.totalRowCount ?? (Array.isArray(resultSet?.data) ? resultSet.data.length : rows.length);
            view.data = {
                key,
                columns: sourceColumns,
                columnsMeta,
                sampleRows: rows,
                overviews,
                totalRows,
                sampledRows: rows.length,
                truncated: totalRows > rows.length,
                sampleMode,
                databaseReason: !(resultSet?.sql || resultSet?.refreshSql) ? 'No reusable SQL; sample exploration is available.' : undefined,
            };
            const filters = view.persisted.filters ?? { dimensions: [], dates: [], measures: [] };
            view.filterState = new ExploreFilterState(filters, () => {
                if (!view || !view.data) {
                    return;
                }
                view.persisted.filters = view.filterState?.filters ?? view.persisted.filters;
                savePersistedState(view.data.key, view.persisted);
                renderFilterBarView(view);
                updateScope(view);
                renderQualityBanner(view);
                document.querySelectorAll('.explore-database-status').forEach(node => { node.textContent = 'Out of date · Press Run to apply current filters'; });
                getElementById('exploreTabContent')?.querySelectorAll('div').forEach(node => node.dispatchEvent(new Event('exploreFiltersChanged')));
                if (view.activeTab === 'cards') {
                    renderCardsView(view);
                }
            });
            renderFilterBarView(view);
            updateScope(view);
            renderQualityBanner(view);
            setExploreTab(view, view.activeTab);
        })
        .catch(error => {
            showLoadingError(error instanceof Error ? error.message : String(error));
        });
}
