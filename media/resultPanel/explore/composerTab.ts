import type { ExploreSelection } from './selectionActions.js';
import { button, element, valueLabel } from './ui.js';
// Explore composer tab: Plot <measure agg> by <dimension> over <time grain>
// [split by <dimension>] [vs previous period] rendered with ECharts.

import * as echarts from 'echarts/core';
import type { EChartsType } from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import {
    GridComponent,
    TooltipComponent,
    LegendComponent,
    DataZoomComponent,
    TitleComponent,
    BrushComponent,
    ToolboxComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { getElementById } from '../dom.js';
import { postHostMessage } from '../protocol.js';
import {
    requestExploreComposer,
    previewExploreComposer,
    openExploreSqlInEditor,
    cancelExploreRequests,
    type ExploreComposerResultPayload,
} from './hostBridge.js';
import { showSqlPreviewModal } from './previewModal.js';
import type {
    ExploreColumnMeta,
    ExploreComposerAggregate,
    ExploreComposerConfig,
    ExploreDateGrain,
    ExploreFilterModel,
} from './types.js';

echarts.use([
    BarChart,
    LineChart,
    GridComponent,
    TooltipComponent,
    LegendComponent,
    DataZoomComponent,
    TitleComponent,
    BrushComponent,
    ToolboxComponent,
    CanvasRenderer,
]);

const AGG_LABELS: Record<ExploreComposerAggregate, string> = {
    sum: 'Sum',
    avg: 'Avg',
    count: 'Count',
    min: 'Min',
    max: 'Max',
};

const GRAIN_LABELS: Record<ExploreDateGrain, string> = {
    day: 'Day',
    week: 'Week',
    month: 'Month',
    quarter: 'Quarter',
    year: 'Year',
};

export interface ComposerTabCache { result?: ExploreComposerResultPayload; config?: ExploreComposerConfig; computedAt?: number }

export interface ComposerTabOptions {
    cache?: ComposerTabCache;
    columns: readonly ExploreColumnMeta[];
    filters: ExploreFilterModel;
    config?: ExploreComposerConfig;
    getFilters?: () => ExploreFilterModel;
    onSelect?: (selection: ExploreSelection) => void;
    onConfigChange: (config: ExploreComposerConfig) => void;
}

function escapeHtml(value: unknown): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function renderComposerTab(
    root: HTMLElement,
    options: ComposerTabOptions,
): void {
    const { columns, filters, config, onConfigChange } = options;
    const dates = columns.filter(column => column.role === 'date');
    const measures = columns.filter(column => column.role === 'measure');
    const dimensions = columns.filter(column => column.role === 'dimension' || column.role === 'date');

    const current = config;
    const dateIndex = current?.dateColumnIndex ?? (dates[0]?.index ?? -1);
    const measureIndex = current?.measureColumnIndex ?? (measures[0]?.index ?? -1);
    const dimensionIndex = current?.dimensionColumnIndex;
    const splitIndex = current?.splitByColumnIndex;
    const grain: ExploreDateGrain = current?.grain ?? 'month';
    const aggFn: ExploreComposerAggregate = current?.aggFn ?? 'sum';
    const comparePrevious = current?.comparePrevious ?? true;

    root.innerHTML = `
        <div class="explore-tab-config explore-composer-config">
            <label class="explore-config-field">
                <span>Plot</span>
                <select id="exploreComposerAgg">
                    ${(Object.keys(AGG_LABELS) as ExploreComposerAggregate[]).map(key => `<option value="${key}" ${key === aggFn ? 'selected' : ''}>${AGG_LABELS[key]}</option>`).join('')}
                </select>
            </label>
            <label class="explore-config-field">
                <span>of</span>
                <select id="exploreComposerMeasure">
                    <option value="-1" ${measureIndex < 0 ? 'selected' : ''}>— none —</option>
                    ${measures.map(column => `<option value="${column.index}" ${column.index === measureIndex ? 'selected' : ''}>${escapeHtml(column.name)}</option>`).join('')}
                </select>
            </label>
            <label class="explore-config-field">
                <span>by</span>
                <select id="exploreComposerDimension">
                    <option value="-1" ${dimensionIndex === undefined ? 'selected' : ''}>— none —</option>
                    ${dimensions.map(column => `<option value="${column.index}" ${column.index === dimensionIndex ? 'selected' : ''}>${escapeHtml(column.name)}</option>`).join('')}
                </select>
            </label>
            <label class="explore-config-field">
                <span>over</span>
                <select id="exploreComposerDate">
                    <option value="-1" ${dateIndex < 0 ? 'selected' : ''}>— none —</option>
                    ${dates.map(column => `<option value="${column.index}" ${column.index === dateIndex ? 'selected' : ''}>${escapeHtml(column.name)}</option>`).join('')}
                </select>
            </label>
            <label class="explore-config-field">
                <span>grain</span>
                <select id="exploreComposerGrain">
                    ${(Object.keys(GRAIN_LABELS) as ExploreDateGrain[]).map(key => `<option value="${key}" ${key === grain ? 'selected' : ''}>${GRAIN_LABELS[key]}</option>`).join('')}
                </select>
            </label>
            <label class="explore-config-field">
                <span>split by</span>
                <select id="exploreComposerSplit">
                    <option value="-1" ${splitIndex === undefined ? 'selected' : ''}>— none —</option>
                    ${dimensions.map(column => `<option value="${column.index}" ${column.index === splitIndex ? 'selected' : ''}>${escapeHtml(column.name)}</option>`).join('')}
                </select>
            </label>
            <label class="explore-config-field explore-config-check">
                <input type="checkbox" id="exploreComposerCompare" ${comparePrevious ? 'checked' : ''}>
                <span>vs previous</span>
            </label>
            <div class="explore-config-actions">
                <button id="exploreComposerRun" class="explore-primary-btn">Run</button>
                <button id="exploreComposerPreview" class="explore-secondary-btn">SQL…</button>
            </div>
        </div>
        <div id="exploreComposerChart" class="explore-tab-results explore-chart-area">
            <div class="explore-empty">Select a date column, a measure and press Run.</div>
        </div>
    `;

    const readConfig = (): { config: ExploreComposerConfig; error?: string } => {
        const dateColumnIndex = Number(getElementById<HTMLSelectElement>('exploreComposerDate')?.value ?? -1);
        const measureColumnIndex = Number(getElementById<HTMLSelectElement>('exploreComposerMeasure')?.value ?? -1);
        if (dateColumnIndex < 0) {
            return { config: { dateColumnIndex, grain, measureColumnIndex, aggFn, comparePrevious }, error: 'Select a date column for the time axis.' };
        }
        if (measureColumnIndex < 0) {
            return { config: { dateColumnIndex, grain, measureColumnIndex, aggFn, comparePrevious }, error: 'Select a measure column.' };
        }
        const dimensionValue = Number(getElementById<HTMLSelectElement>('exploreComposerDimension')?.value ?? -1);
        const splitValue = Number(getElementById<HTMLSelectElement>('exploreComposerSplit')?.value ?? -1);
        const splitColumn = splitValue >= 0 ? columns[splitValue] : undefined;
        return {
            config: {
                dateColumnIndex,
                grain: (getElementById<HTMLSelectElement>('exploreComposerGrain')?.value as ExploreDateGrain) ?? 'month',
                dimensionColumnIndex: dimensionValue >= 0 ? dimensionValue : undefined,
                measureColumnIndex,
                aggFn: (getElementById<HTMLSelectElement>('exploreComposerAgg')?.value as ExploreComposerAggregate) ?? 'sum',
                splitByColumnIndex: splitValue >= 0 ? splitValue : undefined,
                splitValues: splitValue === current?.splitByColumnIndex ? current.splitValues ?? splitColumn?.exploreTopValues : splitColumn?.exploreTopValues,
                includeOther: true,
                comparePrevious: (getElementById<HTMLInputElement>('exploreComposerCompare')?.checked) ?? false,
                filters: options.getFilters?.() ?? filters,
            },
        };
    };

    const cache = options.cache ?? {};
    const drawPrevious = () => {
        const chart = getElementById('exploreComposerChart');
        if (chart && cache.result && cache.config) {
            renderComposerChart(chart, cache.result.rows, cache.result.columnIndexes, cache.config, cache.result.sql, options.onSelect);
            if (JSON.stringify(readConfig().config) !== JSON.stringify(cache.config)) chart.querySelectorAll('.explore-database-status').forEach(node => { node.textContent = 'Out of date · Press Run to apply current filters and settings'; });
        }
    };
    let running = false;
    const run = async () => {
        if (running) return;
        const { config, error } = readConfig();
        const chart = getElementById('exploreComposerChart');
        if (!chart) return;
        if (error) {
            chart.innerHTML = `<div class="explore-error">${escapeHtml(error)}</div>`;
            return;
        }
        running = true;
        const status = element('p', 'Running time series…'); chart.prepend(status);
        try {
            const result = await requestExploreComposer(config);
            if (!chart.isConnected) return;
            cache.result = result; cache.config = config; cache.computedAt = Date.now();
            onConfigChange(config);
            renderComposerChart(chart, result.rows, result.columnIndexes, config, result.sql, options.onSelect);
        } catch (err) {
            status.textContent = err instanceof Error ? err.message : String(err);
            status.append(button('Retry', () => void run()));
        } finally { running = false; }
    };

    const preview = async () => {
        const { config, error } = readConfig();
        if (error) {
            postHostMessage({ command: 'info', text: error });
            return;
        }
        try {
            const sql = await previewExploreComposer(config);
            showSqlPreviewModal({
                title: 'Time series SQL',
                sql,
                onOpenInEditor: sqlText => openExploreSqlInEditor(sqlText, 'Explore composer query'),
            });
        } catch (err) {
            postHostMessage({ command: 'error', text: err instanceof Error ? err.message : String(err) });
        }
    };

    root.querySelector('.explore-config-actions')?.append(button('Cancel', cancelExploreRequests));
    root.querySelector('.explore-tab-config')?.addEventListener('change', () => {
        const next = readConfig();
        if (!next.error) onConfigChange(next.config);
        root.querySelectorAll('.explore-database-status').forEach(node => { node.textContent = 'Out of date · Press Run to apply current filters and settings'; });
    });
    drawPrevious();
    getElementById('exploreComposerRun')?.addEventListener('click', () => void run());
    getElementById('exploreComposerPreview')?.addEventListener('click', () => void preview());
}

interface ComposerColumnIndexes {
    bucket: number;
    dimension: number | undefined;
    split: number | undefined;
    splitOther?: number;
    measure: number;
    previous: number | undefined;
}

let composerChartInstance: EChartsType | null = null;
let composerResizeObserver: ResizeObserver | undefined;

export function disposeComposerChart(): void {
    composerResizeObserver?.disconnect(); composerResizeObserver = undefined;
    if (composerChartInstance) {
        composerChartInstance.dispose();
        composerChartInstance = null;
    }
}

function formatAxisLabel(value: unknown): string {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value);
}

function parseCell(value: unknown): number | null {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    const parsed = Number(String(value));
    return Number.isFinite(parsed) ? parsed : null;
}

function renderComposerChart(
    root: HTMLElement,
    rows: unknown[][],
    indexes: ComposerColumnIndexes,
    config: ExploreComposerConfig,
    sql: string,
    onSelect?: (selection: ExploreSelection) => void,
): void {
    if (!rows || rows.length === 0) {
        root.innerHTML = '<div class="explore-empty">Time series returned no rows.</div>';
        return;
    }

    disposeComposerChart();
    root.innerHTML = '';

    const selectRow = (row: unknown[]) => {
        const filters = structuredClone(config.filters ?? { dimensions: [], dates: [], measures: [] });
        const start = String(row[indexes.bucket]).slice(0, 10);
        const end = new Date(`${start}T00:00:00Z`);
        if (!Number.isFinite(end.getTime())) return;
        if (config.grain === 'day' || config.grain === 'week') end.setUTCDate(end.getUTCDate() + (config.grain === 'day' ? 1 : 7));
        else if (config.grain === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1);
        else end.setUTCMonth(end.getUTCMonth() + (config.grain === 'quarter' ? 3 : 1));
        filters.dates.push({ columnIndex: config.dateColumnIndex, grain: config.grain, from: start, to: end.toISOString().slice(0, 10), toExclusive: true });
        if (indexes.dimension !== undefined && config.dimensionColumnIndex !== undefined) {
            const value = row[indexes.dimension];
            filters.dimensions.push({ columnIndex: config.dimensionColumnIndex, values: value == null ? [] : [String(value)], includeNull: value == null });
        }
        if (indexes.split !== undefined && config.splitByColumnIndex !== undefined) {
            const value = row[indexes.split];
            filters.dimensions.push(indexes.splitOther !== undefined && Number(row[indexes.splitOther]) === 1 && config.splitValues?.length
                ? { columnIndex: config.splitByColumnIndex, mode: 'exclude', values: config.splitValues }
                : { columnIndex: config.splitByColumnIndex, values: value == null ? [] : [String(value)], includeNull: value == null });
        }
        onSelect?.({ label: start, filters, scope: 'database' });
    };
    const summary = document.createElement('div');
    summary.className = 'explore-composer-summary';
    summary.innerHTML = `<span class="explore-database-status">Database · ${rows.length.toLocaleString()} buckets · ${new Date().toLocaleTimeString()} · Original SQL limits preserved</span>`;
    const sqlButton = document.createElement('button');
    sqlButton.className = 'explore-sql-link';
    sqlButton.textContent = 'SQL';
    sqlButton.title = 'Open composer SQL in the editor';
    sqlButton.addEventListener('click', () => openExploreSqlInEditor(sql, 'Explore composer query'));
    summary.appendChild(sqlButton);
    root.appendChild(summary);

    const chartDiv = document.createElement('div');
    chartDiv.className = 'explore-composer-chart';
    root.appendChild(chartDiv);

    const splitColumn = indexes.split !== undefined ? config.splitByColumnIndex : undefined;
    const seriesMap = new Map<string, Array<{ bucket: string; value: number | null; prev: number | null; row: unknown[] }>>();
    const buckets: string[] = [];

    for (const row of rows) {
        const bucket = formatAxisLabel(row[indexes.bucket]);
        const splitKey = [indexes.dimension !== undefined ? valueLabel(row[indexes.dimension]) : '', splitColumn !== undefined ? indexes.splitOther !== undefined && Number(row[indexes.splitOther]) === 1 ? 'Other (remaining categories)' : valueLabel(row[indexes.split ?? 0]) : ''].filter(Boolean).join(' / ') || '__all__';
        if (!buckets.includes(bucket)) {
            buckets.push(bucket);
        }
        if (!seriesMap.has(splitKey)) {
            seriesMap.set(splitKey, []);
        }
        const prevValue = indexes.previous !== undefined ? parseCell(row[indexes.previous]) : null;
        seriesMap.get(splitKey)?.push({
            bucket,
            value: parseCell(row[indexes.measure]),
            prev: prevValue,
            row,
        });
    }

    const chartTheme = getComputedStyle(document.body);
    const colors = [
        chartTheme.getPropertyValue('--vscode-charts-blue').trim() || '#519aba',
        chartTheme.getPropertyValue('--vscode-charts-green').trim() || '#89d185',
        chartTheme.getPropertyValue('--vscode-charts-purple').trim() || '#b180d7',
        chartTheme.getPropertyValue('--vscode-charts-red').trim() || '#e51400',
        chartTheme.getPropertyValue('--vscode-charts-yellow').trim() || '#ffcc00',
    ];

    const series: Array<Record<string, unknown>> = [];
    let seriesIndex = 0;
    const selectionRows: Array<Array<unknown[] | undefined>> = [];
    for (const [key, points] of seriesMap) {
        const isOther = key === 'Other';
        const data = buckets.map(bucket => {
            const point = points.find(item => item.bucket === bucket);
            return point?.value ?? null;
        });
        const label = key.length > 40 ? `${key.slice(0, 37)}…` : key;
        series.push({
            name: label,
            type: buckets.length > 24 ? 'line' : 'bar',
            data,
            smooth: true,
            itemStyle: isOther ? { opacity: 0.55 } : undefined,
            color: colors[seriesIndex % colors.length],
        });
        selectionRows.push(buckets.map(bucket => points.find(item => item.bucket === bucket)?.row));
        seriesIndex += 1;
        if (config.comparePrevious && indexes.previous !== undefined) {
            series.push({
                name: `${label} (prev)`,
                type: 'line',
                data: buckets.map(bucket => {
                    const point = points.find(item => item.bucket === bucket);
                    return point?.prev ?? null;
                }),
                smooth: true,
                lineStyle: { type: 'dashed', opacity: 0.6 },
                itemStyle: { opacity: 0.6 },
                color: colors[seriesIndex % colors.length],
            });
            selectionRows.push([]);
            seriesIndex += 1;
        }
    }

    composerChartInstance = echarts.init(chartDiv, undefined, { renderer: 'canvas' });
    if (typeof ResizeObserver !== 'undefined') {
        composerResizeObserver = new ResizeObserver(() => composerChartInstance?.resize());
        composerResizeObserver.observe(chartDiv);
    }
    composerChartInstance.on('click', event => {
        const row = selectionRows[event.seriesIndex ?? -1]?.[event.dataIndex];
        if (row) selectRow(row);
    });
    composerChartInstance.on('brushEnd', (payload: unknown) => {
        const event = payload as { areas?: Array<{ coordRange?: number[] }> };
        const range = event.areas?.[0]?.coordRange;
        if (!range || !onSelect) return;
        const first = rows.find(row => formatAxisLabel(row[indexes.bucket]) === buckets[Math.max(0, Math.ceil(range[0]))]);
        const last = rows.find(row => formatAxisLabel(row[indexes.bucket]) === buckets[Math.min(buckets.length - 1, Math.floor(range[1]))]);
        if (!first || !last) return;
        const filters = structuredClone(config.filters ?? { dimensions: [], dates: [], measures: [] });
        const from = String(first[indexes.bucket]).slice(0, 10);
        const date = new Date(`${String(last[indexes.bucket]).slice(0, 10)}T00:00:00Z`);
        if (!Number.isFinite(date.getTime())) return;
        if (config.grain === 'day' || config.grain === 'week') date.setUTCDate(date.getUTCDate() + (config.grain === 'day' ? 1 : 7));
        else if (config.grain === 'year') date.setUTCFullYear(date.getUTCFullYear() + 1);
        else date.setUTCMonth(date.getUTCMonth() + (config.grain === 'quarter' ? 3 : 1));
        filters.dates.push({ columnIndex: config.dateColumnIndex, grain: config.grain, from, to: date.toISOString().slice(0, 10), toExclusive: true });
        onSelect({ label: 'Filter to selected range', filters, scope: 'database' });
    });
    composerChartInstance.setOption({
        tooltip: { trigger: 'axis' },
        toolbox: { feature: { brush: { type: ['lineX', 'clear'], title: { lineX: 'Select time range', clear: 'Clear selection' } } } },
        brush: { xAxisIndex: 0, brushMode: 'single', brushType: 'lineX' },
        legend: { type: 'scroll', top: 0, textStyle: { color: chartTheme.getPropertyValue('--vscode-foreground').trim() || '#cccccc' } },
        grid: { left: 48, right: 16, top: 40, bottom: 40 },
        dataZoom: buckets.length > 24 ? [{ type: 'inside' }, { type: 'slider', height: 16 }] : [],
        xAxis: {
            type: 'category',
            data: buckets,
            axisLabel: { rotate: buckets.length > 12 ? 45 : 0, color: chartTheme.getPropertyValue('--vscode-descriptionForeground').trim() || '#888888' },
        },
        yAxis: { type: 'value', axisLabel: { color: chartTheme.getPropertyValue('--vscode-descriptionForeground').trim() || '#888888' } },
        series,
    });
    const details = element('details'); details.append(element('summary', 'Chart data'));
    const table = element('table', undefined, 'explore-table');
    const body = element('tbody');
    for (const row of rows) {
        const tr = element('tr');
        tr.append(element('td', valueLabel(row[indexes.bucket])), element('td', valueLabel(row[indexes.measure])));
        const td = element('td'); td.append(button('Explore selection', () => selectRow(row))); tr.append(td); body.append(tr);
    }
    table.append(body); details.append(table); root.append(details);

}
