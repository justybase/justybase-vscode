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
import { computeColumnStatistics } from './statistics.js';
import { ExploreFilterState } from './filterState.js';
import { renderFilterBar } from './filterBar.js';
import { renderPivotTab, type PivotTabState } from './pivotTab.js';
import { renderComposerTab, disposeComposerChart } from './composerTab.js';
import { requestExploreFullStats, openExploreSqlInEditor } from './hostBridge.js';
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
}

interface ExploreViewState {
    data: ExploreData | null;
    filterState: ExploreFilterState | null;
    activeTab: ExploreTab;
    persisted: ExplorePersistedState;
}

const viewStates = new Map<string, ExploreViewState>();
let activeViewKey: string | null = null;

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
        const rows = await fetchRowsFromHost(sourceUri, rsIndex, 0, EXPLORE_SAMPLE_ROWS);
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
    if (saved) {
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
    hostState._exploreStates[key] = state;
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
            toggleCardInlineForm(card, 'measure');
        }));
        card.appendChild(actions);
    } else if (overview.role === 'date') {
        const actions = document.createElement('div');
        actions.className = 'explore-card-actions';
        actions.appendChild(buildCardButton('Filter…', () => toggleCardInlineForm(card, 'date')));
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
                row.title = `Click to ${activeValues.has(item.value) ? 'remove from' : 'add to'} filter`;
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

function toggleCardInlineForm(card: HTMLElement, kind: 'date' | 'measure'): void {
    const existing = card.querySelector('.explore-card-inline-form');
    if (existing) {
        existing.remove();
        return;
    }
    const form = document.createElement('div');
    form.className = 'explore-card-inline-form';
    if (kind === 'date') {
        form.innerHTML = `
            <input type="text" class="explore-inline-input explore-inline-date-from" placeholder="From (YYYY-MM-DD)">
            <input type="text" class="explore-inline-input explore-inline-date-to" placeholder="To (YYYY-MM-DD)">
            <button class="explore-inline-apply">Apply</button>
            <button class="explore-inline-clear">Clear</button>
        `;
        const apply = form.querySelector('.explore-inline-apply');
        apply?.addEventListener('click', () => {
            const from = (form.querySelector('.explore-inline-date-from') as HTMLInputElement)?.value ?? '';
            const to = (form.querySelector('.explore-inline-date-to') as HTMLInputElement)?.value ?? '';
            const index = Number(card.dataset.columnIndex);
            const onApply = card.__exploreApplyDateFilter;
            if (onApply && !Number.isNaN(index)) {
                onApply(index, 'day', from, to);
            }
            form.remove();
        });
        const clear = form.querySelector('.explore-inline-clear');
        clear?.addEventListener('click', () => {
            const index = Number(card.dataset.columnIndex);
            const onClear = card.__exploreClearDateFilter;
            if (onClear && !Number.isNaN(index)) {
                onClear(index);
            }
            form.remove();
        });
    } else {
        form.innerHTML = `
            <input type="number" class="explore-inline-input explore-inline-measure-min" placeholder="min">
            <input type="number" class="explore-inline-input explore-inline-measure-max" placeholder="max">
            <button class="explore-inline-apply">Apply</button>
            <button class="explore-inline-clear">Clear</button>
        `;
        const apply = form.querySelector('.explore-inline-apply');
        apply?.addEventListener('click', () => {
            const minInput = form.querySelector('.explore-inline-measure-min') as HTMLInputElement;
            const maxInput = form.querySelector('.explore-inline-measure-max') as HTMLInputElement;
            const min = minInput?.value !== '' ? Number(minInput?.value) : undefined;
            const max = maxInput?.value !== '' ? Number(maxInput?.value) : undefined;
            const index = Number(card.dataset.columnIndex);
            const onApply = card.__exploreApplyMeasureFilter;
            if (onApply && !Number.isNaN(index)) {
                onApply(index, min, max);
            }
            form.remove();
        });
        const clear = form.querySelector('.explore-inline-clear');
        clear?.addEventListener('click', () => {
            const index = Number(card.dataset.columnIndex);
            const onApply = card.__exploreApplyMeasureFilter;
            if (onApply && !Number.isNaN(index)) {
                onApply(index, undefined, undefined);
            }
            form.remove();
        });
    }
    card.appendChild(form);
}

declare global {
    interface HTMLElement {
        __exploreApplyDateFilter?: (columnIndex: number, grain: string, from: string, to: string) => void;
        __exploreClearDateFilter?: (columnIndex: number) => void;
        __exploreApplyMeasureFilter?: (columnIndex: number, min: number | undefined, max: number | undefined) => void;
    }
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
    const filteredRows = filterExploreRows(data.sampleRows, filters);
    const filteredOverviews = computeColumnOverviews(data.columnsMeta, filteredRows, filteredRows.length);

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
            (columnIndex, value) => filterState.toggleDimensionValue(columnIndex, value),
            (columnIndex, cardElement) => {
                void loadFullStatsIntoCard(columnIndex, cardElement, filters);
            },
        );
        card.__exploreApplyDateFilter = (columnIndex, _grain, from, to) => filterState.setDateFilter(columnIndex, 'day', from, to);
        card.__exploreClearDateFilter = columnIndex => filterState.setDateFilter(columnIndex, 'day', undefined, undefined);
        card.__exploreApplyMeasureFilter = (columnIndex, min, max) => filterState.setMeasureRange(columnIndex, min, max);
        grid.appendChild(card);
    }

    content.appendChild(grid);
}

async function loadFullStatsIntoCard(
    columnIndex: number,
    card: HTMLElement,
    filters: ExploreFilterModel,
): Promise<void> {
    const existing = card.querySelector('.explore-full-stats');
    if (existing) {
        existing.remove();
        return;
    }
    const statsDiv = document.createElement('div');
    statsDiv.className = 'explore-full-stats';
    statsDiv.textContent = 'Computing full statistics…';
    card.appendChild(statsDiv);
    try {
        const result = await requestExploreFullStats(columnIndex, filters);
        const v = result.values;
        const cells = [
            ['Count', v.count],
            ['Distinct', v.distinct],
            ['Sum', v.sum],
            ['Avg', v.avg],
            ['Min', v.min],
            ['Max', v.max],
            ['StdDev', v.stddev],
            ['p25', v.p25],
            ['Median', v.p50],
            ['p75', v.p75],
        ] as const;
        const unavailable = result.percentilesUnavailable;
        const noStddev = result.stddevUnavailable;
        statsDiv.innerHTML = `
            <div class="explore-full-stats-grid">
                ${cells.filter(([label]) => !(unavailable && (label === 'p25' || label === 'Median' || label === 'p75')) && !(noStddev && label === 'StdDev')).map(([label, value]) => `
                    <div class="explore-full-stat"><span class="explore-full-stat-label">${label}</span><span class="explore-full-stat-value">${value === null || value === undefined ? '—' : formatNumber(Number(value))}</span></div>
                `).join('')}
            </div>
            <button class="explore-sql-link" id="exploreFullStatsSql">SQL</button>
        `;
        getElementById('exploreFullStatsSql')?.addEventListener('click', () => {
            openExploreSqlInEditor(result.sql, 'Full statistics query');
        });
    } catch {
        // Fall back to sample-based statistics when the host path is
        // unavailable (e.g. a result without refresh SQL).
        const view = activeViewKey ? viewStates.get(activeViewKey) : undefined;
        const rows = view?.data?.sampleRows ?? [];
        const stats = computeColumnStatistics(rows, columnIndex);
        statsDiv.innerHTML = `
            <div class="explore-full-stats-grid">
                <div class="explore-full-stat"><span class="explore-full-stat-label">Sample</span><span class="explore-full-stat-value">${rows.length.toLocaleString()} rows</span></div>
                <div class="explore-full-stat"><span class="explore-full-stat-label">Count</span><span class="explore-full-stat-value">${stats.count.toLocaleString()}</span></div>
                <div class="explore-full-stat"><span class="explore-full-stat-label">Distinct</span><span class="explore-full-stat-value">${stats.distinct.toLocaleString()}</span></div>
                <div class="explore-full-stat"><span class="explore-full-stat-label">Sum</span><span class="explore-full-stat-value">${formatNumber(stats.sum)}</span></div>
                <div class="explore-full-stat"><span class="explore-full-stat-label">Avg</span><span class="explore-full-stat-value">${formatNumber(stats.avg)}</span></div>
                <div class="explore-full-stat"><span class="explore-full-stat-label">Median</span><span class="explore-full-stat-value">${formatNumber(stats.median)}</span></div>
                <div class="explore-full-stat"><span class="explore-full-stat-label">StdDev</span><span class="explore-full-stat-value">${formatNumber(stats.stddev)}</span></div>
                <div class="explore-full-stat"><span class="explore-full-stat-label">p25</span><span class="explore-full-stat-value">${formatNumber(stats.p25)}</span></div>
                <div class="explore-full-stat"><span class="explore-full-stat-label">p75</span><span class="explore-full-stat-value">${formatNumber(stats.p75)}</span></div>
            </div>
        `;
    }
}

function renderQualityBanner(view: ExploreViewState): void {
    const banner = getElementById('exploreQualityBanner');
    if (!banner || !view.data) {
        return;
    }
    banner.innerHTML = '';
    const alerts = computeQualityAlerts(view.data.columnsMeta, view.data.overviews);
    const correlations = computeMeasureCorrelations(view.data.columnsMeta, view.data.sampleRows);

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
            onStateChange: next => {
                view.persisted.pivotConfig = next.config;
                view.persisted.pivotValues = next.pivotValues;
                savePersistedState(data.key, view.persisted);
            },
        });
        return;
    }

    if (activeTab === 'composer') {
        renderComposerTab(content, {
            columns: data.columnsMeta,
            filters: filterState.filters,
            config: persisted.composerConfig,
            onConfigChange: config => {
                view.persisted.composerConfig = config;
                savePersistedState(data.key, view.persisted);
            },
        });
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
        onRemoveChip: (kind, columnIndex, value) => {
            if (!view.filterState) return;
            if (kind === 'dimension') {
                const current = view.filterState.filters.dimensions.find(item => item.columnIndex === columnIndex);
                if (current) {
                    view.filterState.setDimensionValues(columnIndex, current.values.filter(item => item !== value));
                }
            } else if (kind === 'date') {
                view.filterState.setDateFilter(columnIndex, 'day', undefined, undefined);
            } else {
                view.filterState.setMeasureRange(columnIndex, undefined, undefined);
            }
        },
        onEditChip: () => {
            // Inline forms live on the cards; switching to Cards highlights them.
            setExploreTab(view, 'cards');
        },
    });
}

function setExploreTab(view: ExploreViewState, tab: ExploreTab): void {
    view.activeTab = tab;
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

export function renderExploreView(rsIndex: number): void {
    const container = getElementById('analysisContainer');
    if (!container) {
        return;
    }
    wireExplorePreviewGlobal();
    disposeComposerChart();

    const sourceUri = getActiveSourceUri() || '';
    const key = `${sourceUri}:${rsIndex}`;
    activeViewKey = key;

    let view = viewStates.get(key);
    if (!view) {
        view = {
            data: null,
            filterState: null,
            activeTab: 'cards',
            persisted: loadPersistedState(key),
        };
        viewStates.set(key, view);
    }

    container.innerHTML = `
        <div class="analysis-view explore-view">
            <div class="analysis-header">
                <div class="analysis-title">Explore</div>
                <div class="analysis-subtitle" id="exploreSubtitle">Analyzing columns…</div>
            </div>
            <div id="exploreQualityBanner" class="explore-quality-banner" style="display:none"></div>
            <div id="exploreFilterBar" class="explore-filter-bar-container"></div>
            <div class="explore-tabs" role="tablist">
                <button class="explore-tab-btn active" data-tab="cards" role="tab" aria-pressed="true">Columns</button>
                <button class="explore-tab-btn" data-tab="pivot" role="tab" aria-pressed="false">Pivot</button>
                <button class="explore-tab-btn" data-tab="composer" role="tab" aria-pressed="false">Composer</button>
            </div>
            <div id="exploreTabContent"></div>
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
            if (!view || activeViewKey !== key) {
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
            const totalRows = resultSet?.totalRowCount ?? (sampleMode === 'memory' ? rows.length : rows.length);
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
            };
            if (subtitle) {
                const sampleNote = view.data.truncated
                    ? `Based on ${rows.length.toLocaleString()} of ${totalRows.toLocaleString()} rows (${sampleMode === 'disk' ? 'disk-backed window' : 'loaded rows'}).`
                    : `Based on ${totalRows.toLocaleString()} rows.`;
                subtitle.textContent = sampleNote;
            }
            const filters = view.persisted.filters ?? { dimensions: [], dates: [], measures: [] };
            view.filterState = new ExploreFilterState(filters, () => {
                if (!view || !view.data) {
                    return;
                }
                view.persisted.filters = view.filterState?.filters ?? view.persisted.filters;
                savePersistedState(view.data.key, view.persisted);
                renderFilterBarView(view);
                if (view.activeTab === 'cards') {
                    renderCardsView(view);
                }
            });
            renderFilterBarView(view);
            renderQualityBanner(view);
            setExploreTab(view, view.activeTab);
        })
        .catch(error => {
            showLoadingError(error instanceof Error ? error.message : String(error));
        });
}
